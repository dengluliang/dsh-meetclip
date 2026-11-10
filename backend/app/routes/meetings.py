"""会议：导入录音/录屏、转写参数、发言人改名与合并。"""
import logging
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import asr
import asr_engines
import capture
import packs
import scheduler
from database import db
from routes.common import HINT_ASR, HINT_FFMPEG, require_session
from routes.sessions import (IMPORT_HINT, IMPORT_RE, check_import_batch_space,
                             check_import_size, is_running)

router = APIRouter()
logger = logging.getLogger(__name__)
MAX_IMPORT_FILES = 20


class MeetingImportReq(BaseModel):
    calendar_event_id: str | None = None
    asr_provider: str | None = None
    path: str
    title: str = ""
    language: str = ""
    hotwords: str = ""


class MeetingImportItem(BaseModel):
    path: str = ""
    title: str = ""


class MeetingBatchImportReq(BaseModel):
    calendar_event_id: str | None = None
    asr_provider: str | None = None
    items: list[MeetingImportItem] = []
    language: str = ""
    hotwords: str = ""
    pack_title: str = ""


def _import_engine(asr_provider):
    """会议导入共用的依赖与转写引擎检查。"""
    if not capture.DEPS["ffmpeg"]:
        raise HTTPException(400, HINT_FFMPEG)
    try:
        config = asr_engines.default_config(asr_provider)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if not asr_engines.ready(config):
        raise HTTPException(400, "所选转录引擎未就绪，请检查 设置 → 会摘 → 模型")
    return config


def _queue_import(path: Path, title: str, config, language: str, hotwords: str,
                  calendar_event_id: str | None = None):
    """创建会议记录并入队；返回 (session_id, queue_info)。"""
    sid = uuid.uuid4().hex[:12]
    params = {"language": language, "hotwords": str(hotwords or "").strip()}
    db.create_session(sid, str(title or "").strip() or path.stem, "", source_type="import",
                      platform="local", kind="meeting")
    if calendar_event_id:
        import calendar_service
        calendar_service.link(calendar_event_id, sid)
    db.update_meta(sid, asr_engine=config, language_hint=language, hotwords=params["hotwords"],
                   asr_status="queued")
    queued = scheduler.enqueue(sid, "meeting", import_file=str(path), params=params)
    return sid, queued


def _failed_result(name: str, raw_path: str, message: str):
    return {"ok": False, "name": name, "path": raw_path, "message": str(message)[:300]}


def _batch_target(raw_path: str):
    """批量导入的单条文件校验；不抛异常，返回 (Path|None, 错误文案)。"""
    p = Path(str(raw_path or "")).expanduser()
    if not p.is_file():
        return None, "文件不存在或无法访问"
    if not IMPORT_RE.search(p.name):
        return None, IMPORT_HINT
    try:
        check_import_size(p)
    except HTTPException as exc:
        return None, str(exc.detail)
    return p, ""


def _pack_for_imports(ids: list[str], title: str):
    """批量导入成功 2 条及以上时收进一个卡包；失败不影响已入队的记录。"""
    if len(ids) < 2:
        return None, ""
    clean_title = str(title or "").strip() or f"会议录音 · {time.strftime('%m-%d %H:%M')}"
    try:
        pack = packs.create_pack(
            "", clean_title, [{"type": "session", "id": sid} for sid in ids],
            allow_active_sessions=True)
        return pack, ""
    except packs.PackError as exc:
        return None, exc.message
    except Exception as exc:  # pragma: no cover - 兜底，不让成包失败吞掉已入队的导入
        logger.exception("批量导入创建卡包失败")
        return None, str(exc)[:300] or "卡包创建失败"


@router.post("/api/meetings/import")
def meeting_import(req: MeetingImportReq):
    if req.calendar_event_id:
        import calendar_service
        calendar_service.require_event(req.calendar_event_id)
    p = Path(req.path).expanduser()
    if not p.is_file():
        raise HTTPException(400, "文件不存在或无法访问")
    if not IMPORT_RE.search(p.name):
        raise HTTPException(400, IMPORT_HINT)
    check_import_size(p)
    config = _import_engine(req.asr_provider)
    sid, queued = _queue_import(p, req.title, config, req.language, req.hotwords,
                                req.calendar_event_id)
    return {"id": sid, **queued}


@router.post("/api/meetings/import-batch")
def meeting_import_batch(req: MeetingBatchImportReq):
    """批量导入本地音视频：逐条容错入队，成功 2 条及以上时自动收进一个卡包。"""
    if req.calendar_event_id:
        import calendar_service
        calendar_service.require_event(req.calendar_event_id)
    if not req.items:
        raise HTTPException(400, "至少选择 1 个音视频文件")
    if len(req.items) > MAX_IMPORT_FILES:
        raise HTTPException(400, f"单次最多导入 {MAX_IMPORT_FILES} 个文件")
    config = _import_engine(req.asr_provider)

    results = [None] * len(req.items)
    prepared = []
    seen = set()
    for index, item in enumerate(req.items):
        p, error = _batch_target(item.path)
        name = p.name if p else Path(str(item.path or "")).name
        if error:
            results[index] = _failed_result(name, item.path, error)
            continue
        resolved = str(p.resolve())
        if resolved in seen:
            results[index] = _failed_result(name, item.path, "重复文件，已跳过")
            continue
        seen.add(resolved)
        prepared.append((index, item, p))

    if not prepared:
        return JSONResponse(status_code=400, content={
            "ok": False,
            "detail": "没有可导入的文件",
            "results": results,
        })

    check_import_batch_space([p for _, _, p in prepared])

    created = []
    for index, item, p in prepared:
        title = item.title.strip() or p.stem
        try:
            sid, queued = _queue_import(p, title, config, req.language, req.hotwords,
                                        req.calendar_event_id)
        except Exception as exc:
            logger.warning("会议批量导入失败：%s", exc)
            results[index] = _failed_result(p.name, item.path, str(exc) or "导入失败")
            continue
        created.append(sid)
        results[index] = {
            "ok": True,
            "id": sid,
            "name": p.name,
            "path": str(p),
            "title": title,
            "queue_position": queued.get("queue_position"),
        }

    pack, pack_error = _pack_for_imports(created, req.pack_title)
    return {
        "ok": True,
        "results": results,
        "ids": created,
        "pack": pack,
        "pack_error": pack_error,
    }


class MeetingOptionsReq(BaseModel):
    asr_provider: str | None = None
    hotwords: str | None = None
    language: str | None = None


@router.patch("/api/sessions/{sid}/options")
def update_meeting_options(sid: str, req: MeetingOptionsReq):
    """修改会议或链接视频的转写参数（供「重新转写」沿用）。"""
    sess = require_session(sid)
    if sess.get("kind") not in ("meeting", "link_video"):
        raise HTTPException(409, "只有会议和链接视频支持转写参数编辑")
    if is_running(sid):
        raise HTTPException(409, "请等待当前转写完成后修改选项")
    try:
        config = asr_engines.default_config(req.asr_provider) if req.asr_provider else asr_engines.session_config(sess)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    changes = {"asr_engine": config}
    if req.hotwords is not None:
        changes["hotwords"] = req.hotwords.strip()
    if req.language is not None:
        changes["language_hint"] = req.language
    if changes:
        db.update_meta(sid, **changes)
    return {"ok": True}


class SpeakersReq(BaseModel):
    names: dict[str, str] = {}
    merge: dict[str, str] = {}


@router.patch("/api/sessions/{sid}/speakers")
def update_speakers(sid: str, req: SpeakersReq):
    """names: 原始标签 → 显示名；merge: 原始标签 → 并入的目标标签"""
    sess = require_session(sid)
    if sess.get("kind") not in ("meeting", "link_video"):
        raise HTTPException(409, "只有会议和链接视频支持发言人编辑")
    with db.transaction():
        speakers = dict((db.get_session(sid) or {}).get("meta", {}).get("speakers") or {})
        # 改之前留一份快照：页面上的"撤销"与猜名采纳后都能回滚。
        prior = (db.get_session(sid) or {}).get("meta") or {}
        db.update_meta(sid, speakers_undo={"speakers": prior.get("speakers") or {},
                                           "speaker_guesses": prior.get("speaker_guesses") or {}})
        for src, dst in req.merge.items():
            if src == dst or src not in speakers or dst not in speakers:
                continue
            db.execute("UPDATE transcripts SET speaker=? WHERE session_id=? AND speaker=?", (dst, sid, src))
            speakers.pop(src, None)
        for raw, name in req.names.items():
            name = name.strip()
            if raw in speakers and name:
                speakers[raw] = name
        db.update_meta(sid, speakers=speakers)
    return {"speakers": speakers}
