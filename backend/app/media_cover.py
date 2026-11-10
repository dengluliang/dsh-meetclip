"""本地视频封面：缓存远程缩略图之外的兜底封面。

链接视频的 source_meta.thumbnail 是平台 CDN 地址，可能被墙、防盗链或过期。
首页优先显示远程图，失败时回退到 session_dir/cover.jpg。本模块从已下载的
media.mp4 抽一帧生成本地封面，按需在后台执行，不阻塞首页请求。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import threading
from pathlib import Path

from database import db, session_dir

_running: set[str] = set()
_lock = threading.Lock()
_slots = threading.Semaphore(2)
FFMPEG_CANDIDATES = ("ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg")


def cover_file(sid: str) -> Path | None:
    try:
        path = session_dir(sid) / "cover.jpg"
    except Exception:
        return None
    return path if path.is_file() and path.stat().st_size > 0 else None


def _ffmpeg() -> str | None:
    for candidate in FFMPEG_CANDIDATES:
        path = shutil.which(candidate) if os.path.basename(candidate) == candidate else candidate
        if path and Path(path).is_file():
            return path
    return None


def _safe_media(sid: str, media_path: str) -> Path | None:
    try:
        base = session_dir(sid).resolve()
        media = (base / media_path).resolve()
        if base not in media.parents or not media.is_file():
            return None
        return media
    except Exception:
        return None


def generate_cover(sid: str) -> Path | None:
    existing = cover_file(sid)
    if existing:
        return existing
    session = db.get_session(sid)
    if not session or not session.get("media_path"):
        return None
    media = _safe_media(sid, str(session["media_path"]))
    ffmpeg = _ffmpeg()
    if not media or not ffmpeg:
        return None
    try:
        duration = float(session.get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0
    seek = min(max(1.0, duration * 0.01), 30.0)
    target = session_dir(sid) / "cover.jpg"
    temp = session_dir(sid) / f".cover-{os.getpid()}-{threading.get_ident()}.jpg"
    command = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-ss", f"{seek:.2f}", "-i", str(media),
        "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3", str(temp),
    ]
    try:
        subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False)
        if temp.is_file() and temp.stat().st_size > 0:
            os.replace(temp, target)
            return target
    except Exception:
        pass
    finally:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass
    return cover_file(sid)


def schedule_cover(sid: str) -> None:
    """首页按需触发；同一记录只跑一个任务，最多两个 ffmpeg 并发。"""
    if not sid:
        return
    with _lock:
        if sid in _running:
            return
        _running.add(sid)

    def worker():
        try:
            with _slots:
                generate_cover(sid)
        finally:
            with _lock:
                _running.discard(sid)

    threading.Thread(target=worker, daemon=True, name=f"meetclip-cover-{sid[:6]}").start()
