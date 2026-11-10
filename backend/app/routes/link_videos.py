"""链接视频：预检、批量入队、重试/取消与内录兜底。"""
import time
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import capture
import link_video
import asr_engines
import scheduler
from database import db, session_dir
from routes.common import require_session
from routes.sessions import is_running

router = APIRouter()
NOT_FOUND = "链接视频不存在"


class PrecheckReq(BaseModel):
    url: str


class LinkBatchItem(BaseModel):
    asr_provider: str | None = None
    url: str
    title: str = Field(default="", max_length=500)
    thumbnail: str = Field(default="", max_length=2000)
    allow_duplicate: bool = False
    transcription_mode: Literal["auto", "asr"] = "auto"
    subtitle_track_id: str | None = Field(default=None, max_length=160)


class LinkBatchReq(BaseModel):
    calendar_event_id: str | None = None
    # 带上已有批次 id 时，新链接续排到该批次，而不是另开一张批次卡。
    batch_id: str | None = Field(default=None, max_length=64)
    items: list[LinkBatchItem]


class LinkFallbackCompleteReq(BaseModel):
    path: str
    token: str = ""


@router.post("/api/precheck")
def precheck(req: PrecheckReq):
    return capture.preview_bilibili_live(req.url)


@router.post("/api/link-videos/preview")
def link_preview(req: PrecheckReq):
    return link_video.preview(req.url)


@router.post("/api/link-videos/batch")
def link_batch(req: LinkBatchReq):
    if req.calendar_event_id:
        import calendar_service
        calendar_service.require_event(req.calendar_event_id)
    """立即入队：只做平台、重复和队列容量检查；链接有效性、时长和字幕语言放到任务的准备阶段。"""
    if not req.items:
        raise HTTPException(400, "至少添加一条链接")
    if len(req.items) > link_video.MAX_QUEUE:
        raise HTTPException(400, f"单次最多添加 {link_video.MAX_QUEUE} 条链接")
    existing_batch = None
    if req.batch_id:
        existing_batch = db.get_link_batch(req.batch_id)
        if not existing_batch:
            raise HTTPException(404, "批次不存在或已删除，请刷新后重试")
    results = []
    prepared = []
    for index, item in enumerate(req.items):
        try:
            config = asr_engines.default_config(item.asr_provider)
        except ValueError as exc:
            results.append((index, {"ok": False, "url": item.url, "message": str(exc)}))
            continue
        normalized = link_video.normalize_url(item.url)
        platform = link_video.detect_platform(normalized) if normalized else None
        if not platform:
            results.append((index, {"ok": False, "url": item.url,
                                    "message": link_video.UNSUPPORTED_LINK_MESSAGE}))
            continue
        # 已预读过时，用缓存校验字幕语言；未预读完的链接由后台按默认规则选择。
        info = link_video.cached_info(normalized)
        summary = link_video.subtitles.summary(info) if info else {}
        if item.transcription_mode == "auto" and info:
            options = summary.get("subtitle_tracks") or []
            selected = item.subtitle_track_id or summary.get("default_subtitle_track_id")
            if (item.subtitle_track_id and not any(t["id"] == selected for t in options)) or (
                    summary.get("subtitle_selection_required") and not selected):
                results.append((index, {"ok": False, "url": item.url,
                                        "message": "请选择可用的字幕语言后再加入队列"}))
                continue
        prepared.append((index, item, normalized, platform, info, summary))
    created = []
    with db.transaction():
        remaining = link_video.MAX_QUEUE - db.count_active_link_jobs()
        if len(prepared) > remaining:
            raise HTTPException(409, f"队列还可添加 {remaining} 条链接")
        for index, item, normalized, platform, info, summary in prepared:
            duplicate = db.one(
                "SELECT id,title,status FROM sessions WHERE kind='link_video' AND normalized_url=? "
                "ORDER BY created_at DESC LIMIT 1", (normalized,)
            )
            if duplicate and not item.allow_duplicate:
                results.append((index, {"ok": False, "duplicate": True, "url": item.url,
                                        "existing": duplicate,
                                        "message": "已有相同链接，可确认后再次添加"}))
                continue
            sid = uuid.uuid4().hex[:12]
            info = info or {}
            title = item.title.strip() or (info.get("title") or "").strip() or item.url.strip()
            db.create_session(sid, title, item.url.strip(), source_type="link", platform=platform, kind="link_video")
            if req.calendar_event_id:
                calendar_service.link(req.calendar_event_id, sid)
            db.update_session(sid, normalized_url=normalized, download_mode="yt_dlp")
            db.update_meta(sid, asr_engine=config, source_meta={
                "title": title, "thumbnail": item.thumbnail or info.get("thumbnail") or "",
                "uploader": info.get("uploader") or info.get("channel") or "",
                "duration": info.get("duration") or 0,
                "extractor": info.get("extractor_key") or info.get("extractor") or "", "retrieved_at": time.time(),
            }, has_video=True, has_audio=True, asr_status="queued",
                transcription_mode=item.transcription_mode,
                subtitle_track_id=(item.subtitle_track_id or summary.get("default_subtitle_track_id"))
                    if item.transcription_mode == "auto" else None,
                subtitle_status=summary.get("subtitle_status", "unknown"))
            db.create_link_job(sid, db.next_link_queue_order())
            created.append(sid)
            results.append((index, {"ok": True, "id": sid, "title": title, "url": item.url}))
    results = [result for _, result in sorted(results, key=lambda pair: pair[0])]
    batch = None
    # 多条链接一次提交时聚合成批次卡；单条保持原来的单卡行为。
    # 指定 batch_id 时始终续排到已有批次（单条也续排），并延续原来的批次标题与创建时间。
    if created and (existing_batch or len(req.items) > 1):
        now = time.time()
        if existing_batch:
            batch = {
                "id": existing_batch["id"],
                "title": existing_batch.get("title") or "批量视频",
                "created_at": float(existing_batch.get("created_at") or now),
                "updated_at": now,
                "total": int(existing_batch.get("total") or 0) + len(created),
            }
            start_index = int(existing_batch.get("last_index") or 0) + 1
        else:
            batch = {
                "id": uuid.uuid4().hex[:12],
                "title": f"批量视频 · {time.strftime('%m-%d %H:%M', time.localtime(now))}",
                "created_at": now,
                "updated_at": now,
                "total": len(created),
            }
            start_index = 0
        for offset, sid in enumerate(created):
            db.update_meta(sid, batch={**batch, "index": start_index + offset})
    for sid in created:
        link_video.manager.add(sid)
    if not any(x.get("ok") for x in results):
        return JSONResponse(status_code=400, content={"ok": False, "results": results})
    payload = {"ok": True, "results": results}
    if existing_batch:
        payload["appended"] = True
    if batch:
        payload["batch"] = batch
    return payload


@router.post("/api/link-videos/{sid}/retry")
def link_retry(sid: str):
    require_session(sid, "link_video", NOT_FOUND)
    job = db.get_link_job(sid)
    if not job:
        raise HTTPException(404, NOT_FOUND)
    if is_running(sid):
        raise HTTPException(409, "该链接仍在处理中")
    db.update_link_job(sid, job_state="queued", phase="queued", retry_count=int(job.get("retry_count") or 0) + 1,
                       error_code=None, error_message=None, finished_at=None)
    db.update_session(sid, status="pending", error=None, ended_at=None)
    link_video.manager.add(sid)
    return {"ok": True, **scheduler.info(sid)}


@router.post("/api/link-videos/{sid}/cancel")
def link_cancel(sid: str):
    require_session(sid, "link_video", NOT_FOUND)
    link_video.manager.cancel(sid)
    return {"ok": True}


@router.post("/api/link-videos/{sid}/fallback/start")
def link_fallback_start(sid: str):
    require_session(sid, "link_video", NOT_FOUND)
    job = db.get_link_job(sid)
    if not job or job.get("job_state") != "error":
        raise HTTPException(409, "只有下载失败的链接视频可以开启内录")
    d = session_dir(sid)
    target = d / "source" / "screen_capture.mp4"
    if not scheduler.try_reserve(sid):
        raise HTTPException(409, "当前有其他采集或转写任务，请稍后再试")
    token = uuid.uuid4().hex
    db.update_link_job(sid, job_state="fallback_recording", phase="fallback_recording",
                       partial_cache_path=str(target.relative_to(d)), fallback_token=token)
    db.update_session(sid, status="processing", download_mode="screen_capture", error=None)
    return {"ok": True, "path": str(target), "token": token,
            "message": "请在 macOS 原生应用中选择浏览器窗口或屏幕"}


@router.post("/api/link-videos/{sid}/fallback/stop")
def link_fallback_stop(sid: str):
    require_session(sid, "link_video", NOT_FOUND)
    job = db.get_link_job(sid)
    if not job or job.get("job_state") != "fallback_recording":
        raise HTTPException(409, "当前没有正在进行的内录任务")
    db.update_link_job(sid, job_state="cancelled", phase="cancelled", error_code="fallback_cancelled",
                       error_message="内录已取消", finished_at=time.time())
    db.update_session(sid, status="cancelled", error="内录已取消", ended_at=time.time())
    scheduler.release(sid)
    return {"ok": True}


@router.post("/api/link-videos/{sid}/fallback/complete")
def link_fallback_complete(sid: str, req: LinkFallbackCompleteReq):
    require_session(sid, "link_video", NOT_FOUND)
    job = db.get_link_job(sid)
    if not job:
        raise HTTPException(404, NOT_FOUND)
    if job.get("job_state") != "fallback_recording":
        raise HTTPException(409, "当前没有正在进行的内录任务")
    if not job.get("fallback_token") or req.token != job.get("fallback_token"):
        raise HTTPException(403, "内录任务凭证无效")
    try:
        link_video.complete_fallback(sid, req.path)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}
