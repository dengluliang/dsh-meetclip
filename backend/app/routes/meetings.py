"""会议：导入录音/录屏、转写参数、发言人改名与合并。"""
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import asr
import asr_engines
import capture
import scheduler
from database import db
from routes.common import HINT_ASR, HINT_FFMPEG, require_session
from routes.sessions import IMPORT_HINT, IMPORT_RE, check_import_size, is_running

router = APIRouter()


class MeetingImportReq(BaseModel):
    calendar_event_id: str | None = None
    asr_provider: str | None = None
    path: str
    title: str = ""
    language: str = ""
    hotwords: str = ""


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
    if not capture.DEPS["ffmpeg"]:
        raise HTTPException(400, HINT_FFMPEG)
    try:
        config = asr_engines.default_config(req.asr_provider)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if not asr_engines.ready(config):
        raise HTTPException(400, "所选转录引擎未就绪，请检查 设置 → 会摘 → 模型")
    sid = uuid.uuid4().hex[:12]
    params = {"language": req.language, "hotwords": req.hotwords.strip()}
    db.create_session(sid, req.title.strip() or p.stem, "", source_type="import", platform="local", kind="meeting")
    if req.calendar_event_id:
        calendar_service.link(req.calendar_event_id, sid)
    db.update_meta(sid, asr_engine=config, language_hint=req.language, hotwords=params["hotwords"],
                   asr_status="queued")
    queued = scheduler.enqueue(sid, "meeting", import_file=str(p), params=params)
    return {"id": sid, **queued}


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
