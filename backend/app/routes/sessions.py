"""记录：列表与详情、重命名/复制/删除、采集控制、媒体文件、实时事件、标记、搜索与导出。"""
import asyncio
import json
import re
import shutil
import subprocess
import time
import urllib.parse
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

import asr
import asr_engines
import cloud_transcription
import auth
import capture
import cards
import link_video
import media_cover
import meeting
import packs
import scheduler
from database import DATA_DIR, db, session_dir
from export_md import export_markdown
from routes.common import HINT_ASR, require_session

router = APIRouter()

ACTIVE_LINK_STATES = {"queued", "waiting_for_slot", "preparing", "downloading", "transcribing", "finalizing", "fallback_recording"}
IMPORT_RE = re.compile(r"\.(mp4|mov|mkv|flv|webm|m4v|ts|mp3|m4a|wav|aac|flac|ogg|opus)$", re.I)
IMPORT_HINT = "仅支持 mp4/mov/mkv/flv/webm/m4v/ts 视频或 mp3/m4a/wav/aac/flac/ogg/opus 音频"
MAX_IMPORT_BYTES = 8 * 1024 * 1024 * 1024
RESERVE_BYTES = 512 * 1024 * 1024


def check_import_size(path: Path):
    try:
        size = path.stat().st_size
        free = shutil.disk_usage(DATA_DIR).free
    except OSError as exc:
        raise HTTPException(400, f"无法读取文件或磁盘空间：{exc}")
    if size > MAX_IMPORT_BYTES:
        raise HTTPException(413, "单个导入文件不能超过 8 GB")
    if free < size + RESERVE_BYTES:
        raise HTTPException(507, "磁盘空间不足，请至少预留 512 MB 可用空间")


def check_import_batch_space(paths):
    """批量导入按总和校验磁盘空间：单个文件都装得下，不代表一批都装得下。"""
    total = 0
    for path in paths:
        try:
            total += path.stat().st_size
        except OSError as exc:
            raise HTTPException(400, f"无法读取文件或磁盘空间：{exc}")
    try:
        free = shutil.disk_usage(DATA_DIR).free
    except OSError as exc:
        raise HTTPException(400, f"无法读取文件或磁盘空间：{exc}")
    if free < total + RESERVE_BYTES:
        need = max(0.0, (total + RESERVE_BYTES - free) / 1024 / 1024 / 1024)
        raise HTTPException(507, f"磁盘空间不足：本批文件还需要约 {need:.1f} GB，请清理后重试")


def is_running(sid: str) -> bool:
    """记录是否仍有任务在运行（采集、转写、链接下载或内录）。"""
    if scheduler.owner() == sid or scheduler.is_queued(sid) or link_video.manager.task(sid):
        return True
    job = db.get_link_job(sid)
    return bool(job and job.get("job_state") in ACTIVE_LINK_STATES)


# ---------------- 列表与详情 ----------------
class CreateReq(BaseModel):
    calendar_event_id: str | None = None
    asr_provider: str | None = None
    url: str = ""
    title: str = ""


@router.get("/api/sessions")
def list_sessions():
    rows = db.list_sessions()
    queued = {r["session_id"]: r for r in scheduler.snapshot()["jobs"]}
    for r in rows:
        item = queued.get(r["id"], {})
        r["queue_position"] = item.get("queue_position")
        r["queue_paused"] = item.get("paused", False)
        meta = r.get("meta") if isinstance(r.get("meta"), dict) else {}
        r["asr_status"] = str(meta.get("asr_status") or "")
        r["missing_chunks"] = len(meta.get("asr_failures") or [])
        r.pop("meta", None)
        if r.get("kind") != "link_video":
            r.pop("link_job", None)
    return rows


HOME_SNIPPET_CHARS = 180


def _plain_text(value, limit=HOME_SNIPPET_CHARS):
    # 笔记里可能带 AI 纪要段的 HTML 注释边界；摘要里不该出现这些技术标记。
    text = re.sub(r"<!--.*?-->", " ", str(value or ""), flags=re.S)
    text = re.sub(r"(?m)^\s*#{1,6}\s*", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def _home_cover(row):
    """封面优先级：平台缩略图 → 本地抽帧 → 首张截图。

    远程缩略图可能被墙/防盗链/过期，因此附上 cover.jpg 作为 fallback；
    客户端图片加载失败时自动换成本地封面。
    """
    meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
    source_meta = meta.get("source_meta") if isinstance(meta.get("source_meta"), dict) else {}
    remote = str(source_meta.get("thumbnail") or meta.get("thumbnail") or "").strip()
    sid = str(row.get("id") or "")
    local = media_cover.cover_file(sid) if sid else None
    local_cover = {"type": "file", "value": "cover.jpg"} if local else None
    remote_cover = {"type": "remote", "value": remote} if (remote.startswith("https://") or remote.startswith("http://")) else None
    # 非直播优先用本地抽帧：平台 CDN 在国内/桌面 WebView 经常超时或防盗链；
    # 本地封面立即可用，远程图只作为兜底。直播仍优先首张截图。
    if local_cover and row.get("kind") != "live":
        return {**local_cover, **({"fallback": remote_cover} if remote_cover else {})}
    if remote_cover:
        return {**remote_cover, **({"fallback": local_cover} if local_cover else {})}
    if local_cover:
        return local_cover
    path = str(row.get("cover_path") or "").strip().lstrip("/")
    if path and ".." not in path.split("/"):
        return {"type": "file", "value": path}
    return None


class StickyNoteReq(BaseModel):
    text: str = ""
    x: float = 0
    y: float = 0
    checked: list[bool] | None = None


def _sticky_kind(text):
    return "todo" if any(re.match(r"^\s*-\s+", line) for line in str(text).splitlines()) else "note"


def _clean_sticky(req: StickyNoteReq):
    text = str(req.text or "").strip()
    if not text:
        raise HTTPException(400, "便利签内容不能为空")
    if len(text) > 5000:
        raise HTTPException(400, "便利签内容过长")
    return text


@router.get("/api/sticky-notes")
def sticky_notes_list():
    return db.list_sticky_notes()


@router.post("/api/sticky-notes")
def sticky_notes_create(req: StickyNoteReq):
    text = _clean_sticky(req)
    kind = _sticky_kind(text)
    checked = list(req.checked or [])
    total = len([line for line in text.splitlines() if re.match(r"^\s*-\s+", line)])
    checked = (checked + [False] * total)[:total] if kind == "todo" else []
    note = db.create_sticky_note(text, kind, checked, max(0, min(10000, req.x)), max(0, min(10000, req.y)))
    note["checked"] = checked
    return note


@router.patch("/api/sticky-notes/{note_id}")
def sticky_notes_update(note_id: str, req: StickyNoteReq):
    existing = db.one("SELECT * FROM sticky_notes WHERE id=?", (note_id,))
    if not existing:
        raise HTTPException(404, "便利签不存在")
    fields = {}
    if req.text.strip():
        text = _clean_sticky(req)
        kind = _sticky_kind(text)
        fields["text"] = text
        fields["kind"] = kind
        total = len([line for line in text.splitlines() if re.match(r"^\s*-\s+", line)])
        fields["checked"] = (list(req.checked or []) + [False] * total)[:total] if kind == "todo" else []
    elif req.checked is not None:
        fields["checked"] = list(req.checked)
    note = db.update_sticky_note(note_id, fields)
    if note:
        try:
            note["checked"] = json.loads(note.get("checked") or "[]")
        except Exception:
            note["checked"] = []
    return note


@router.delete("/api/sticky-notes/{note_id}")
def sticky_notes_delete(note_id: str):
    db.delete_sticky_note(note_id)
    return {"ok": True}


BOARD_IMAGE_MAX = 25 * 1024 * 1024
BOARD_IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/heic-sequence": ".heic",
    "image/heif-sequence": ".heif",
}
BOARD_IMAGE_EXTS = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".hif": "image/heif",
}
HEIF_TYPES = {"image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"}
HEIF_EXTS = {".heic", ".heif", ".hif"}
HEIF_BRANDS = {b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1", b"heif"}
BOARD_IMAGE_HINT = "仅支持 PNG、JPEG、WebP、GIF、HEIC/HEIF 图片"


def board_image_kind(file: UploadFile):
    """按 MIME 或扩展名判断上传图片类型；浏览器拖动 HEIC 时 MIME 可能为空。"""
    declared = str(file.content_type or "").lower()
    suffix = Path(str(file.filename or "")).suffix.lower()
    if declared in BOARD_IMAGE_TYPES:
        return declared, BOARD_IMAGE_TYPES[declared]
    if suffix in BOARD_IMAGE_EXTS:
        return BOARD_IMAGE_EXTS[suffix], suffix
    return None, None


def looks_like_heif(head: bytes) -> bool:
    return len(head) >= 12 and head[4:8] == b"ftyp" and head[8:12] in HEIF_BRANDS


def heif_to_jpeg(source: Path, target: Path) -> bool:
    """把 HEIC/HEIF 转成浏览器可显示的 JPEG：优先 pillow-heif，macOS 回退 sips。"""
    try:
        from pillow_heif import register_heif_opener
        from PIL import Image, ImageOps

        register_heif_opener()
        with Image.open(source) as image:
            image = ImageOps.exif_transpose(image)
            if image.mode != "RGB":
                image = image.convert("RGB")
            image.save(target, "JPEG", quality=88, optimize=True)
        if target.is_file() and target.stat().st_size > 0:
            return True
    except Exception:
        pass
    try:
        target.unlink(missing_ok=True)
    except Exception:
        pass

    sips = shutil.which("sips")
    if not sips:
        return False
    try:
        result = subprocess.run(
            [sips, "-s", "format", "jpeg", "-s", "formatOptions", "88", str(source), "--out", str(target)],
            capture_output=True,
            timeout=120,
        )
    except Exception:
        result = None
    if result is not None and result.returncode == 0 and target.is_file() and target.stat().st_size > 0:
        return True
    try:
        target.unlink(missing_ok=True)
    except Exception:
        pass
    return False


def image_size(path: Path):
    try:
        from PIL import Image

        with Image.open(path) as image:
            return int(image.width), int(image.height)
    except Exception:
        return 0, 0


@router.get("/api/board/images")
def board_images_list():
    return db.list_board_images()


@router.post("/api/board/images")
async def board_images_create(file: UploadFile = File(...), x: float = Form(0), y: float = Form(0),
                               width: int = Form(0), height: int = Form(0)):
    image_type, ext = board_image_kind(file)
    if not (image_type or ext):
        raise HTTPException(400, BOARD_IMAGE_HINT)
    suffix = ext or BOARD_IMAGE_TYPES[image_type]
    image_id = uuid.uuid4().hex[:12]
    rel = f"board-images/{image_id}{suffix}"
    target = DATA_DIR / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    try:
        with target.open("wb") as handle:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > BOARD_IMAGE_MAX:
                    raise HTTPException(413, "单张图片不能超过 25 MB")
                handle.write(chunk)
    except Exception:
        try:
            target.unlink(missing_ok=True)
        except Exception:
            pass
        raise

    # 图片卡要在浏览器里显示，HEIC/HEIF 统一转成 JPEG 再存；原文件不保留。
    heif = image_type in HEIF_TYPES or suffix in HEIF_EXTS
    if not heif:
        try:
            with target.open("rb") as handle:
                heif = looks_like_heif(handle.read(64))
        except Exception:
            heif = False
    if heif:
        converted_rel = f"board-images/{image_id}.jpg"
        converted = DATA_DIR / converted_rel
        if not heif_to_jpeg(target, converted):
            try:
                target.unlink(missing_ok=True)
            except Exception:
                pass
            raise HTTPException(400, "HEIC/HEIF 图片转换失败，请改用 PNG 或 JPEG")
        try:
            target.unlink(missing_ok=True)
        except Exception:
            pass
        rel = converted_rel

    final_path = DATA_DIR / rel
    if width <= 0 or height <= 0:
        measured_width, measured_height = image_size(final_path)
        if width <= 0:
            width = measured_width
        if height <= 0:
            height = measured_height
    row = db.create_board_image(image_id, rel, width, height, max(0, x), max(0, y))
    return row


@router.get("/api/board/images/{image_id}/file")
def board_image_file(image_id: str):
    row = db.one("SELECT path FROM board_images WHERE id=?", (image_id,))
    if not row:
        raise HTTPException(404)
    p = (DATA_DIR / str(row.get("path") or "")).resolve()
    try:
        p.relative_to(DATA_DIR.resolve())
    except ValueError:
        raise HTTPException(403, "非法图片路径")
    if not p.is_file():
        raise HTTPException(404)
    return FileResponse(str(p), headers={"Cache-Control": "public, max-age=86400"})


@router.delete("/api/board/images/{image_id}")
def board_image_delete(image_id: str):
    row = db.delete_board_image(image_id)
    if not row:
        raise HTTPException(404, "图片不存在")
    try:
        p = (DATA_DIR / str(row.get("path") or "")).resolve()
        p.relative_to(DATA_DIR.resolve())
        if p.is_file():
            p.unlink()
    except Exception:
        pass
    return {"ok": True}


@router.get("/api/home")
def home_feed(limit: int = 60, offset: int = 0):
    if limit < 1 or limit > 200:
        raise HTTPException(400, "limit 需在 1–200 之间")
    if offset < 0:
        raise HTTPException(400, "offset 不能为负数")
    items = []
    for row in db.list_home_sessions(limit=limit, offset=offset):
        meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
        notes = str(row.get("notes") or "")
        snippet = _plain_text(row.get("snippet")) or _plain_text(notes)
        sid = str(row.get("id") or "")
        if sid and row.get("media_path") and not media_cover.cover_file(sid) and not row.get("cover_path"):
            media_cover.schedule_cover(sid)
        items.append({
            "id": row.get("id"),
            "title": row.get("title") or "未命名",
            "kind": row.get("kind") or "live",
            "status": row.get("status") or "pending",
            "source_url": row.get("source_url") or "",
            "platform": row.get("platform") or "",
            "source_type": row.get("source_type") or "",
            "created_at": row.get("created_at"),
            "started_at": row.get("started_at"),
            "duration": float(row.get("duration") or 0),
            "transcripts": int(row.get("transcripts") or 0),
            "marks": int(row.get("marks") or 0),
            "screenshots": int(row.get("screenshots") or 0),
            "asr_status": str(meta.get("asr_status") or ""),
            "missing_chunks": len(meta.get("asr_failures") or []),
            "notes_version": int(row.get("notes_version") or 0),
            "has_notes": bool(notes.strip()),
            "unreviewed": row.get("status") == "done" and int(row.get("marks") or 0) == 0 and not notes.strip(),
            "cover": _home_cover(row),
            "snippet": snippet,
        })
    highlights = []
    for mark in db.list_home_highlights(limit=12):
        highlights.append({
            "id": mark.get("id"),
            "session_id": mark.get("session_id"),
            "session_title": mark.get("session_title") or "",
            "kind": mark.get("kind") or "live",
            "ts": float(mark.get("ts") or 0),
            "note": _plain_text(mark.get("note"), 300),
            "created_at": mark.get("created_at"),
        })
    return {"stats": db.home_stats(), "items": items, "highlights": highlights,
            "batches": db.list_link_batches(50), "documents": cards.home_documents(12),
            "packs": packs.list_packs()}


@router.post("/api/sessions")
def create_session(req: CreateReq):
    if req.calendar_event_id:
        import calendar_service
        calendar_service.require_event(req.calendar_event_id)
    try:
        config = asr_engines.default_config(req.asr_provider)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    sid = uuid.uuid4().hex[:12]
    title = req.title.strip()
    if req.url:
        check = capture.check_bilibili_live(req.url)
        if not title:
            title = check.get("title") or "B站直播"
        if check.get("status") == "invalid":
            raise HTTPException(400, check.get("message", "链接无效"))
    else:
        title = title or f"未命名 {time.strftime('%m-%d %H:%M')}"
    db.create_session(sid, title, req.url)
    db.update_meta(sid, asr_engine=config)
    if req.calendar_event_id:
        calendar_service.link(req.calendar_event_id, sid)
    return {"id": sid, "title": title}


@router.get("/api/sessions/{sid}")
def get_session(sid: str):
    event_task = scheduler.task_for(sid) or link_video.manager.task(sid)
    # Read text and its event cursor under the same DB lock as cloud publication.
    # Resolve the task before taking that lock (the scheduler also acquires it).
    with db.transaction():
        sess = require_session(sid)
        sess.update(event_task.event_cursor() if event_task else {"event_stream_id": None, "event_id": None})
        sess["transcripts"] = db.get_transcripts(sid)
        sess["asr_engine"] = asr_engines.session_config(sess)
        sess["transcript_previews"] = cloud_transcription.pending_previews(sid)
        cloud_run = (sess.get("meta") or {}).get("cloud_run")
        sess["asr_failures"] = cloud_transcription.failures(sid, cloud_run) if cloud_run and cloud_run["state"] != "done" else []
        sess["timing_precision"] = (sess.get("meta") or {}).get("timing_precision")
        sess["screenshots"] = db.get_screenshots(sid)
        sess["marks"] = db.get_marks(sid)
    task = capture.get_task(sid)
    link_task = link_video.manager.task(sid)
    job = db.get_link_job(sid) if sess.get("kind") == "link_video" else None
    sess["link_job"] = job
    sess["recording"] = bool(task and task.capturing)
    sess.update(scheduler.info(sid))
    sess["processing"] = bool(sess["queued"] or (task and not task.capturing) or link_task or
                               (job and job.get("job_state") in ACTIVE_LINK_STATES))
    snapshot = task.snapshot() if task else (link_task.snapshot() if link_task else None)
    sess["live"] = snapshot
    sess["phase"] = "queued" if sess["queued"] else ((snapshot or {}).get("phase") or (job or {}).get("phase") or "")
    meta = sess.get("meta") or {}
    sess["kind"] = sess.get("kind") or "live"
    sess["speakers"] = meta.get("speakers") or {}
    sess["hotwords"] = meta.get("hotwords") or ""
    sess["aligned"] = meta.get("aligned")
    sess["diarize_error"] = meta.get("diarize_error") or ""
    sess["diarize"] = bool(meta.get("diarize"))
    sess["num_speakers"] = meta.get("num_speakers")
    sess["language"] = meta.get("language") or meta.get("language_hint") or ""
    sess["has_video"] = meta.get("has_video", sess.get("source_type") != "audio")
    sess["asr_status"] = meta.get("asr_status", "")
    # 纪要只需要状态与版本：详情每几秒轮询一次，正文等打开页签时再单独拉。
    try:
        import minutes as minutes_mod
        status = minutes_mod.engine.status(sid)
        status["scenario"] = minutes_mod.scenario_for(sess)
        sess["minutes"] = status
        sess["minutes_scenario"] = status["scenario"]
        sess["minutes_enabled"] = minutes_mod.auto_mode() != "off"
    except Exception:
        sess["minutes"] = None
        sess["minutes_scenario"] = "meeting"
        sess["minutes_enabled"] = False
    sess["minutes_notes_version"] = int(meta.get("minutes_notes_version") or 0)
    for field in ("transcription_mode", "transcription_source", "subtitle_language", "subtitle_kind",
                  "subtitle_track_id", "subtitle_source_language"):
        sess[field] = meta.get(field)
    sess["stream_quality"] = meta.get("stream_quality", "")
    d = session_dir(sid)
    capturing = bool(task and task.capturing)
    sess["live_hls_path"] = "live/index.m3u8" if capturing and (d / "live" / "index.m3u8").exists() else None
    sess["live_preview_path"] = "preview.jpg" if capturing and (d / "preview.jpg").exists() else None
    sess["max_shots"] = capture.MAX_SHOTS
    return sess


# ---------------- 删除：移到废纸篓（可恢复） ----------------
class TrashError(Exception):
    pass


def _trash_dir(sid: str, title: str, root: Path | None = None) -> Path:
    trash = root or (Path.home() / ".Trash")
    safe = re.sub(r'[\\/:*?"<>|]', "_", title or sid)[:60]
    dest = trash / f"MeetClip-{safe}-{sid}"
    if dest.exists():
        dest = trash / f"MeetClip-{safe}-{sid}-{int(time.time())}"
    return dest


def trash_session(sid: str):
    """优先移到系统废纸篓；桌面沙箱不允许时退到数据目录内的应用废纸篓。

    两步都失败才保留目录和数据库记录，避免半删除。
    """
    sess = require_session(sid)
    if is_running(sid):
        raise HTTPException(409, "该记录仍在采集或处理中，请先停止或取消后再删除")
    d = DATA_DIR / sid
    app_trash = None
    if d.exists():
        system_error = None
        dest = _trash_dir(sid, sess.get("title") or sid)
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(d), str(dest))
        except Exception as exc:
            system_error = exc
        if d.exists():
            # 桌面端 TCC/沙箱可能禁止写入 ~/.Trash；放到应用自己的数据目录内，
            # 仍可恢复，也不会让用户看到“删除失败”。
            app_trash = _trash_dir(sid, sess.get("title") or sid, DATA_DIR / ".trash")
            try:
                app_trash.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(d), str(app_trash))
            except Exception as fallback_error:
                raise HTTPException(
                    500,
                    f"无法移到废纸篓，记录与文件均已保留：{system_error or fallback_error}",
                )
    db.delete_session(sid)


@router.delete("/api/sessions/{sid}")
def delete_session(sid: str):
    trash_session(sid)
    return {"ok": True}


class BatchDeleteReq(BaseModel):
    ids: list[str]


@router.post("/api/sessions/batch_delete")
def batch_delete(req: BatchDeleteReq):
    """先取消仍在处理中的链接任务，再把整批记录移到废纸篓。"""
    cancelled = []
    for sid in req.ids:
        sess = db.get_session(sid)
        if sess and sess.get("kind") == "link_video" and is_running(sid):
            link_video.manager.cancel(sid)
            cancelled.append(sid)
    deadline = time.monotonic() + 12
    while cancelled and time.monotonic() < deadline and any(is_running(sid) for sid in cancelled):
        time.sleep(0.2)
    deleted, failed = [], []
    for sid in req.ids:
        try:
            trash_session(sid)
            deleted.append(sid)
        except HTTPException as exc:
            failed.append({"id": sid, "message": exc.detail})
    return {"ok": not failed, "count": len(deleted), "deleted": deleted, "failed": failed}


# ---------------- 编辑 ----------------
class RenameReq(BaseModel):
    title: str


@router.patch("/api/sessions/{sid}")
def rename_session(sid: str, req: RenameReq):
    title = req.title.strip()
    if not title:
        raise HTTPException(400, "标题不能为空")
    require_session(sid)
    db.update_session(sid, title=title)
    return {"ok": True, "title": title}


@router.post("/api/sessions/{sid}/duplicate")
def duplicate_session(sid: str):
    """复制一份已完成的记录（媒体、截图、转写、标记、笔记），用于另存/改编辑"""
    src = require_session(sid)
    if src.get("kind") == "link_video":
        raise HTTPException(409, "链接视频不能直接创建副本，请重新加入链接队列")
    if is_running(sid):
        raise HTTPException(409, "采集或处理中的记录不能复制，请先停止")
    nid = uuid.uuid4().hex[:12]
    if (DATA_DIR / sid).exists():
        shutil.copytree(DATA_DIR / sid, DATA_DIR / nid, ignore=shutil.ignore_patterns("export*", "live", "preview*", "asr_chunks"))
    title = f"{src['title']} 副本"
    with db.transaction():
        db.create_session(nid, title, src.get("source_url") or "",
                          source_type=src.get("source_type") or "live", platform=src.get("platform") or "bilibili",
                          kind=src.get("kind") or "live")
        db.update_session(nid, status=src["status"], started_at=src.get("started_at"), ended_at=src.get("ended_at"),
                          duration=src.get("duration") or 0, media_path=src.get("media_path"),
                          error=src.get("error"), meta={k: v for k, v in (src.get("meta") or {}).items() if k not in ("cloud_run", "asr_failures")}, notes=src.get("notes") or "")
        db.add_transcripts(nid, [(t["start"], t["end"], t["text"], t.get("speaker")) for t in db.get_transcripts(sid)])
        for s in db.get_screenshots(sid):
            db.add_screenshot(nid, s["ts"], s["path"])
        for mk in db.get_marks(sid):
            db.add_mark(nid, mk["ts"], mk.get("note") or "")
    return {"id": nid, "title": title}


class NotesReq(BaseModel):
    notes: str
    version: int | None = None


@router.patch("/api/sessions/{sid}/notes")
def update_notes(sid: str, req: NotesReq):
    """独立保存会议、直播和视频笔记，避免处理进度或发言人更新覆盖用户内容。"""
    require_session(sid)
    version = db.save_record_notes(sid, req.notes, req.version)
    return {"ok": True, "notes_version": version}


# ---------------- 采集控制 ----------------
@router.post("/api/sessions/{sid}/start")
def start(sid: str):
    sess = require_session(sid)
    if is_running(sid):
        return {"ok": True, **scheduler.info(sid)}
    if not sess.get("source_url"):
        raise HTTPException(400, "该记录没有来源链接")
    if sess.get("media_path"):
        raise HTTPException(400, "该记录已有采集内容；请新建采集，避免覆盖已保存的媒体")
    check = capture.check_bilibili_live(sess["source_url"])
    if not check.get("ok"):
        raise HTTPException(400, check.get("message", "直播当前不可采集"))
    return {"ok": True, **scheduler.enqueue(sid, "capture", url=sess["source_url"])}


class RetranscribeReq(BaseModel):
    asr_provider: str | None = None
    resume: bool = True


@router.post("/api/sessions/{sid}/retranscribe")
def retranscribe(sid: str, req: RetranscribeReq | None = None):
    sess = require_session(sid)
    if is_running(sid):
        raise HTTPException(409, "该记录仍在处理中")
    if not sess.get("media_path") or not (session_dir(sid) / sess["media_path"]).exists():
        raise HTTPException(400, "没有可转写的媒体文件")
    config = asr_engines.session_config(sess)
    if config.get("provider") == "local":
        # 本地识别已下线：旧记录重新转写改走云端。
        config = asr_engines.default_config("mimo")
    if req and req.asr_provider:
        try:
            config = asr_engines.default_config(req.asr_provider)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
    if not asr_engines.ready(config):
        raise HTTPException(400, "所选转录引擎未就绪，请检查 设置 → 会摘 → 模型")
    params = meeting.transcription_params(sess)
    db.update_meta(sid, asr_engine=config)
    if req and not req.resume:
        db.update_meta(sid, cloud_run=None)
    if sess.get("kind") == "meeting":
        queued = scheduler.enqueue(sid, "meeting", params=params)
    elif sess.get("kind") == "link_video":
        job = db.get_link_job(sid)
        if not job:
            raise HTTPException(404, "链接视频任务不存在")
        db.update_meta(sid, transcription_mode="asr")
        db.update_link_job(sid, job_state="queued", phase="queued", transcribed_until=0,
                           retry_count=int(job.get("retry_count") or 0) + 1,
                           error_code=None, error_message=None, finished_at=None)
        db.update_session(sid, status="pending", error=None, ended_at=None)
        link_video.manager.add(sid)
        queued = scheduler.info(sid)
    elif config["provider"] != "local":
        queued = scheduler.enqueue(sid, "meeting", params=params)
    else:
        queued = scheduler.enqueue(sid, "capture", transcribe_only=True)
    return {"ok": True, **queued}


@router.post("/api/sessions/{sid}/stop")
def stop(sid: str):
    require_session(sid)
    if scheduler.info(sid)["queued"]:
        scheduler.cancel(sid)
        return {"ok": True}
    capture.stop_capture(sid)
    return {"ok": True}


@router.post("/api/sessions/{sid}/cancel")
def cancel_session(sid: str):
    require_session(sid)
    if not scheduler.cancel(sid):
        raise HTTPException(409, "当前没有正在运行的任务")
    return {"ok": True}


# ---------------- 媒体文件访问 ----------------
@router.get("/api/files/{sid}/{path:path}")
def files(sid: str, path: str, request: Request):
    require_session(sid)
    root = (DATA_DIR / sid).resolve()
    p = (root / path).resolve()
    try:
        p.relative_to(root)
    except ValueError:
        raise HTTPException(403, "非法文件路径")
    if not p.is_file():
        raise HTTPException(404)
    # 桌面端页面跑在 dsh-app:// 自定义协议下，Electron 主进程转发流式响应时会把
    # Content-Length 去掉，Chromium 因此把整段媒体当成不可 seek 的流（seekable [0,0]）。
    # 点播媒体在桌面端改走一次 307：浏览器直接连本地后端的 http 地址，Range 与
    # Content-Length 都完整，时间轴/转写时间戳才能真的跳转。HLS 与图片不在此列。
    direct_suffixes = {".mp4", ".m4v", ".mov", ".webm", ".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus"}
    if request.query_params.get("direct") == "1" and p.suffix.lower() in direct_suffixes:
        base = str(request.base_url).rstrip("/")
        target = (f"{base}/api/files/{urllib.parse.quote(sid, safe='')}/"
                  f"{urllib.parse.quote(path, safe='/')}?token={urllib.parse.quote(auth.API_TOKEN, safe='')}")
        return RedirectResponse(target, status_code=307,
                                headers={"Cache-Control": "no-store"})
    if p.name == "preview.jpg":
        return FileResponse(str(p), media_type="image/jpeg", headers={"Cache-Control": "no-store"})
    if p.suffix == ".m3u8":
        # AVPlayer 无法给 HLS 子请求附加自定义请求头，把同一个本地凭证写进子播放列表/分片地址。
        token = auth.token_from_request(request)
        lines = []
        for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line and not line.startswith("#"):
                sep = "&" if "?" in line else "?"
                line = f"{line}{sep}token={urllib.parse.quote(token)}"
            lines.append(line)
        return StreamingResponse(iter(["\n".join(lines) + "\n"]), media_type="application/vnd.apple.mpegurl",
                                 headers={"Cache-Control": "no-cache, no-store"})
    if p.suffix == ".ts" and p.parent.name == "live":
        return FileResponse(str(p), media_type="video/mp2t", headers={"Cache-Control": "no-cache"})
    return FileResponse(str(p))


# ---------------- SSE 实时事件 ----------------
@router.get("/api/sessions/{sid}/events")
async def events(sid: str, request: Request, after: int = 0):
    async def gen():
        task = scheduler.task_for(sid) or link_video.manager.task(sid)
        if not task:
            yield "data: {\"kind\":\"noop\"}\n\n"
            return
        try:
            last = max(after, int(request.headers.get("last-event-id") or 0))
        except ValueError:
            last = after
        while True:
            if await request.is_disconnected():
                return
            pending = task.events_since(last)
            if pending:
                for ev in pending:
                    last = ev.get("event_id", last)
                    yield f"id: {last}\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"
                    if ev.get("kind") in ("done", "error", "cancelled"):
                        return
                continue
            if task.finished.is_set():
                yield "data: {\"kind\":\"closed\"}\n\n"
                return
            await asyncio.sleep(0.5)
            yield ": ping\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream")


# ---------------- 标记 ----------------
class MarkReq(BaseModel):
    ts: float
    note: str = ""


@router.post("/api/sessions/{sid}/marks")
def add_mark(sid: str, req: MarkReq):
    require_session(sid)
    if req.ts < 0:
        raise HTTPException(400, "时间点不能为负数")
    return {"id": db.add_mark(sid, req.ts, req.note)}


@router.patch("/api/marks/{mark_id}")
def update_mark(mark_id: int, req: MarkReq):
    if req.ts < 0:
        raise HTTPException(400, "时间点不能为负数")
    if not db.one("SELECT id FROM marks WHERE id=?", (mark_id,)):
        raise HTTPException(404, "标记不存在")
    db.update_mark(mark_id, req.note)
    return {"ok": True}


@router.delete("/api/marks/{mark_id}")
def del_mark(mark_id: int):
    if not db.one("SELECT id FROM marks WHERE id=?", (mark_id,)):
        raise HTTPException(404, "标记不存在")
    db.delete_mark(mark_id)
    return {"ok": True}


# ---------------- 搜索与导出 ----------------
@router.get("/api/sessions/{sid}/search")
def search(sid: str, q: str):
    require_session(sid)
    if not q.strip():
        return []
    return db.search(sid, q.strip())


@router.get("/api/sessions/{sid}/export")
def export(sid: str):
    require_session(sid)
    try:
        return export_markdown(sid)
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.get("/api/sessions/{sid}/export.zip")
def export_zip(sid: str):
    sess = require_session(sid)
    try:
        result = export_markdown(sid)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return FileResponse(result["zip"], filename=f"{sess.get('title') or sid}.zip")
