"""会摘备份与迁移：把选中的卡片导出成一个 zip，导入到当前资料空间。

设计要点：
- 备份是**内容快照**，不是数据库文件：只收录用户选中的卡片及其依赖（卡包成员、
  标记所属记录、批次成员），不复制账号 Cookie、模型 Key、settings.json 与本机路径。
- 导入一律分配新 id（记录 12 位 hex、便利签/图片/卡包同理），mark 是自增 id 需要
  建立旧→新映射；卡包成员、批次、标记引用都跟着改。文档卡按 `doc_type:token`
  稳定键登记，已存在时不覆盖（别人的正文快照可能更新）。
- 去重靠 `backup_import_items`：同一备份文件再次导入默认跳过已导入的卡片，
  需要另一份时显式传 skip_existing=false。
- 文件只在 zip 里按**我们自己构造**的条目名读写（记录 id/文件名都先校验），
  绝不把 zip 里的条目路径直接拼到磁盘上，避免 zip-slip。
- 任务在后台线程里跑，前端轮询 `/api/backup/job`；同一时刻只允许一个导出/导入。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any

import cards
import packs
from database import DATA_DIR, db

FORMAT_NAME = "meetclip-backup"
FORMAT_VERSION = 1
BACKUP_DIR_NAME = "备份"
ARCHIVE_PREFIX = "MeetClip备份-"
README_NAME = "README.txt"
IMPORT_MARKER = ".backup-import"
CHUNK = 1024 * 1024

MAX_ARCHIVE_BYTES = 64 * 1024 ** 3
MAX_ENTRIES = 50_000
MAX_ENTRY_BYTES = 20 * 1024 ** 3
MAX_TOTAL_BYTES = 100 * 1024 ** 3
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_RECORD_JSON_BYTES = 512 * 1024 * 1024
MIN_FREE_MARGIN = 512 * 1024 * 1024
SIZE_GUARD_RATIO = 1000
SIZE_GUARD_MIN = 1024 ** 3
JOB_KEEP_SECONDS = 600

SESSION_ID_RE = re.compile(r"^[0-9a-f]{12}$")
DOC_KEY_RE = re.compile(r"^[0-9a-f]{12}$")
PACK_ID_RE = re.compile(r"^[a-z0-9-]{8,40}$")
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")

ACTIVE_STATUSES = {"pending", "queued", "recording", "processing"}
TERMINAL_STATUSES = {"done", "error", "cancelled"}
MEMBER_TYPES = ("session", "batch", "highlight", "note", "image", "doc")
MAX_TITLE = 300


class BackupError(Exception):
    """带 HTTP 状态码的业务错误，由 routes 转成 JSON。"""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class _Cancelled(Exception):
    """用户取消任务；只在后台线程里使用。"""


# --------------------------------------------------------------------------- 基础工具


def _num(value, default=0.0) -> float:
    if isinstance(value, bool) or value is None:
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number or number in (float("inf"), float("-inf")):
        return default
    return number


def _int(value, default=0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _text(value, limit=0) -> str:
    text = CONTROL_RE.sub("", str(value or "")).strip()
    return text[:limit] if limit > 0 else text


def _json_size(value) -> int:
    try:
        return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    except (TypeError, ValueError):
        return 0


def _warn(bucket: list[str], message: str) -> None:
    text = _text(message, 300)
    if text and text not in bucket:
        bucket.append(text)


def _safe_rel(value) -> str | None:
    """数据库里的相对路径 → 规范化的 posix 相对路径；非法返回 None。"""
    text = str(value or "").replace("\\", "/").strip()
    if not text or text.startswith("/") or CONTROL_RE.search(text):
        return None
    parts = [part for part in text.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." or ":" in part for part in parts):
        return None
    if len("/".join(parts)) > 240:
        return None
    return "/".join(parts)


def _file_below(base: Path, rel: str) -> Path | None:
    """在 base 之下取一个已存在的普通文件，越界或不存在返回 None。"""
    safe = _safe_rel(rel)
    if not safe:
        return None
    try:
        root = base.resolve()
        target = (base / safe).resolve()
        target.relative_to(root)
        return target if target.is_file() else None
    except (OSError, ValueError):
        return None


def _file_size(path: Path | None) -> int:
    try:
        return path.stat().st_size if path and path.is_file() else 0
    except OSError:
        return 0


def _library_name() -> str:
    try:
        data = json.loads((DATA_DIR / ".meetclip-library.json").read_text(encoding="utf-8"))
        if isinstance(data, dict):
            name = _text(data.get("name"), 80)
            if name:
                return name
    except (OSError, ValueError):
        pass
    return "默认资料空间"


def app_version() -> str:
    """插件版本：发布包与源码目录里 package.json 都在 backend/ 的上两级。"""
    try:
        manifest = json.loads((Path(__file__).resolve().parents[2] / "package.json").read_text(encoding="utf-8"))
        return _text(manifest.get("version"), 40)
    except (OSError, ValueError):
        return ""


def default_dest() -> Path:
    return DATA_DIR / BACKUP_DIR_NAME


def _free_bytes(path: Path) -> int | None:
    try:
        usage = shutil.disk_usage(path)
        return int(usage.free)
    except OSError:
        return None


def _unique_session_id(used: set[str]) -> str:
    for _ in range(64):
        candidate = uuid.uuid4().hex[:12]
        if candidate not in used:
            used.add(candidate)
            return candidate
    raise BackupError(500, "无法分配新的记录标识，请稍后重试")


# --------------------------------------------------------------------------- 任务


class _Job:
    def __init__(self, action: str, phase: str = "准备"):
        self.id = f"backup-{uuid.uuid4().hex[:10]}"
        self.action = action
        self.state = "running"
        self.phase = phase
        self.message = ""
        self.done = 0
        self.total = 0
        self.bytes_done = 0
        self.bytes_total = 0
        self.error = ""
        self.result: dict | None = None
        self.started_at = time.time()
        self.finished_at: float | None = None
        self._cancel = threading.Event()
        self._lock = threading.RLock()

    def percent(self) -> float:
        if self.bytes_total > 0:
            ratio = self.bytes_done / self.bytes_total
        elif self.total > 0:
            ratio = self.done / self.total
        else:
            ratio = 0.0
        return round(max(0.0, min(1.0, ratio)) * 100, 1)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "id": self.id,
                "action": self.action,
                "state": self.state,
                "phase": self.phase,
                "message": self.message,
                "done": self.done,
                "total": self.total,
                "bytes_done": self.bytes_done,
                "bytes_total": self.bytes_total,
                "percent": self.percent() if self.state == "running" else (100.0 if self.state == "done" else self.percent()),
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "error": self.error,
                "result": self.result,
            }

    def check(self) -> None:
        if self._cancel.is_set():
            raise _Cancelled()

    def cancel(self) -> None:
        self._cancel.set()

    def update(self, *, phase: str | None = None, message: str | None = None,
               done: int | None = None, total: int | None = None,
               bytes_done: int | None = None, bytes_total: int | None = None) -> None:
        with self._lock:
            if phase is not None:
                self.phase = phase
            if message is not None:
                self.message = message
            if done is not None:
                self.done = done
            if total is not None:
                self.total = total
            if bytes_done is not None:
                self.bytes_done = bytes_done
            if bytes_total is not None:
                self.bytes_total = bytes_total

    def add_bytes(self, count: int) -> None:
        if count > 0:
            with self._lock:
                self.bytes_done += int(count)

    def finish(self, state: str, result: dict | None = None, error: str = "") -> None:
        with self._lock:
            self.state = state
            self.result = result
            self.error = _text(error, 600)
            self.finished_at = time.time()
            if state == "done":
                self.phase = "完成"
                self.done = self.total
                if self.bytes_total > 0:
                    self.bytes_done = self.bytes_total


_JOB_LOCK = threading.RLock()
_JOB: _Job | None = None


def _active_job() -> _Job | None:
    with _JOB_LOCK:
        if _JOB and _JOB.state == "running":
            return _JOB
        return None


def _start(action: str, target) -> dict:
    global _JOB
    with _JOB_LOCK:
        if _JOB and _JOB.state == "running":
            raise BackupError(409, "正在导出或导入备份，请等当前任务结束")
        job = _Job(action)
        _JOB = job
    thread = threading.Thread(target=target, args=(job,), name=f"meetclip-{action}", daemon=True)
    thread.start()
    return job.snapshot()


def job_snapshot() -> dict | None:
    with _JOB_LOCK:
        job = _JOB
    if not job:
        return None
    snapshot = job.snapshot()
    if snapshot["state"] != "running" and job.finished_at and time.time() - job.finished_at > JOB_KEEP_SECONDS:
        return None
    return snapshot


def cancel_job() -> dict | None:
    with _JOB_LOCK:
        job = _JOB
    if not job:
        return None
    job.cancel()
    return job.snapshot()


def shutdown() -> None:
    with _JOB_LOCK:
        job = _JOB
    if job and job.state == "running":
        job.cancel()
        deadline = time.time() + 2.0
        while job.state == "running" and time.time() < deadline:
            time.sleep(0.05)


# --------------------------------------------------------------------------- 目录（catalog）


def _record_bytes(row: dict) -> tuple[int, int]:
    """(基础内容字节, 媒体字节)。基础内容 = 笔记 + 转写 + 截图 + 封面。"""
    sid = str(row.get("id") or "")
    base = len(str(row.get("notes") or "").encode("utf-8"))
    try:
        stat = db.one(
            "SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(text)),0) AS chars "
            "FROM transcripts WHERE session_id=?", (sid,)
        ) or {}
        base += int(stat.get("chars") or 0) * 3  # 中文 UTF-8 约 3 字节，取上限
    except Exception:
        pass
    media = 0
    for rel in (row.get("media_path"), row.get("audio_path")):
        safe = _safe_rel(rel)
        if safe:
            media += _file_size(_file_below(DATA_DIR / sid, safe))
    base += _file_size(_file_below(DATA_DIR / sid, "cover.jpg"))
    try:
        shots = db.get_screenshots(sid)
    except Exception:
        shots = []
    for shot in shots:
        safe = _safe_rel(shot.get("path"))
        if safe:
            base += _file_size(_file_below(DATA_DIR / sid, safe))
    return base, media


def catalog() -> dict:
    """首页备份页的选择清单；只读，不建目录。"""
    sessions = []
    for row in db.list_sessions():
        sid = str(row.get("id") or "")
        base, media = _record_bytes(row)
        sessions.append({
            "id": sid,
            "title": _text(row.get("title"), 200) or "未命名记录",
            "kind": row.get("kind") or "live",
            "status": row.get("status") or "pending",
            "created_at": _num(row.get("started_at") or row.get("created_at")),
            "duration": _num(row.get("duration")),
            "transcripts": _int(row.get("transcripts")),
            "marks": _int(row.get("marks")),
            "screenshots": _int(row.get("screenshots")),
            "has_notes": bool(str(row.get("notes") or "").strip()),
            "has_minutes": bool(db.one("SELECT 1 AS ok FROM session_minutes WHERE session_id=?", (sid,))),
            "has_media": bool(row.get("media_path") or row.get("audio_path")),
            "active": str(row.get("status") or "") in ACTIVE_STATUSES,
            "base_bytes": base,
            "media_bytes": media,
        })
    sessions.sort(key=lambda item: item["created_at"] or 0, reverse=True)

    notes = []
    for row in db.list_sticky_notes():
        notes.append({
            "id": str(row.get("id") or ""),
            "title": _text(row.get("text"), 200) or ("待办清单" if row.get("kind") == "todo" else "便利签"),
            "kind": row.get("kind") or "note",
            "created_at": _num(row.get("created_at")),
            "base_bytes": len(str(row.get("text") or "").encode("utf-8")) + 200,
        })

    images = []
    for row in db.list_board_images():
        rel = _safe_rel(row.get("path"))
        size = _file_size(DATA_DIR / rel) if rel else 0
        images.append({
            "id": str(row.get("id") or ""),
            "title": "图片卡",
            "width": _int(row.get("width")),
            "height": _int(row.get("height")),
            "created_at": _num(row.get("created_at")),
            "base_bytes": size,
        })

    docs = []
    for row in db.list_doc_cards():
        content = str(row.get("content") or "")
        docs.append({
            "key": str(row.get("key") or ""),
            "title": _text(row.get("title"), 200) or "链接卡片",
            "url": str(row.get("url") or ""),
            "doc_type": str(row.get("doc_type") or "docx"),
            "has_content": bool(content.strip()),
            "created_at": _num(row.get("updated_at") or row.get("created_at")),
            "base_bytes": len(content.encode("utf-8")) + 400,
        })

    batches = []
    for batch in db.list_link_batches(1000):
        batches.append({
            "id": str(batch.get("id") or ""),
            "title": _text(batch.get("title"), 200) or "批量视频",
            "created_at": _num(batch.get("created_at")),
            "count": len(batch.get("members") or []),
            "member_ids": [str(member.get("id") or "") for member in batch.get("members") or []],
        })

    highlights = []
    for row in db.query(
        "SELECT m.id,m.session_id,m.ts,m.note,m.created_at,s.title AS session_title,s.kind "
        "FROM marks m JOIN sessions s ON s.id=m.session_id "
        "WHERE trim(COALESCE(m.note,'')) <> '' ORDER BY m.created_at DESC"
    ):
        highlights.append({
            "id": _int(row.get("id")),
            "session_id": str(row.get("session_id") or ""),
            "session_title": _text(row.get("session_title"), 120),
            "kind": row.get("kind") or "live",
            "ts": _num(row.get("ts")),
            "note": _text(row.get("note"), 200),
            "created_at": _num(row.get("created_at")),
        })

    pack_rows = []
    for pack in packs.list_packs():
        pack_rows.append({
            "id": str(pack.get("id") or ""),
            "title": _text(pack.get("title"), 120) or "卡包",
            "created_at": _num(pack.get("created_at")),
            "updated_at": _num(pack.get("updated_at")),
            "count": _int(pack.get("count")),
            "members": [
                {
                    "type": member.get("type"),
                    "id": str(member.get("id") or ""),
                    "title": _text(member.get("title"), 160),
                    "kind": member.get("kind") or "",
                }
                for member in pack.get("members") or []
                if member.get("type") in MEMBER_TYPES
            ],
        })

    totals = {
        "records": len(sessions),
        "packs": len(pack_rows),
        "notes": len(notes),
        "images": len(images),
        "docs": len(docs),
        "batches": len(batches),
        "highlights": len(highlights),
        "media_bytes": sum(item["media_bytes"] for item in sessions),
        "base_bytes": (
            sum(item["base_bytes"] for item in sessions)
            + sum(item["base_bytes"] for item in notes)
            + sum(item["base_bytes"] for item in images)
            + sum(item["base_bytes"] for item in docs)
        ),
    }
    return {
        "library": {"name": _library_name()},
        "default_dest": str(default_dest()),
        "format_version": FORMAT_VERSION,
        "app_version": app_version(),
        "items": {
            "records": sessions,
            "packs": pack_rows,
            "notes": notes,
            "images": images,
            "docs": docs,
            "batches": batches,
            "highlights": highlights,
        },
        "totals": totals,
    }


# --------------------------------------------------------------------------- 选择解析


def _resolve_selection(items) -> dict:
    if not isinstance(items, list) or not items:
        raise BackupError(400, "先选择要备份的卡片")
    sessions: set[str] = set()
    notes: set[str] = set()
    images: set[str] = set()
    docs: set[str] = set()
    pack_ids: list[str] = []
    batch_ids: set[str] = set()
    highlight_ids: set[int] = set()
    requested: list[dict] = []
    requested_keys: set[tuple[str, str]] = set()

    def add_requested(kind: str, ident: str, extra: dict | None = None):
        key = (kind, ident)
        if key in requested_keys:
            return
        requested_keys.add(key)
        entry = {"type": kind, "id": ident}
        if extra:
            entry.update(extra)
        requested.append(entry)

    for raw in items:
        if not isinstance(raw, dict):
            raise BackupError(400, "卡片选择格式无效")
        kind = str(raw.get("type") or "").strip().lower()
        ident = _text(raw.get("id"), 120)
        if kind == "session":
            if not SESSION_ID_RE.match(ident) or not db.get_session(ident):
                raise BackupError(400, "所选记录已不存在，请刷新后重试")
            sessions.add(ident)
            add_requested("session", ident)
        elif kind == "pack":
            if not PACK_ID_RE.match(ident) or not db.get_card_pack(ident):
                raise BackupError(400, "所选卡包已不存在，请刷新后重试")
            if ident not in pack_ids:
                pack_ids.append(ident)
            add_requested("pack", ident)
        elif kind == "batch":
            batch = db.get_link_batch(ident)
            if not batch:
                raise BackupError(400, "所选批次已不存在，请刷新后重试")
            batch_ids.add(ident)
            add_requested("batch", ident)
        elif kind == "highlight":
            mark = db.one(
                "SELECT m.id,m.session_id FROM marks m JOIN sessions s ON s.id=m.session_id WHERE m.id=?",
                (_int(ident),),
            )
            if not mark:
                raise BackupError(400, "所选标记已不存在，请刷新后重试")
            sessions.add(str(mark["session_id"]))
            highlight_ids.add(_int(mark.get("id")))
            add_requested("highlight", str(_int(mark.get("id"))))
        elif kind == "note":
            if not SESSION_ID_RE.match(ident) or not db.one("SELECT 1 AS ok FROM sticky_notes WHERE id=?", (ident,)):
                raise BackupError(400, "所选便利签已不存在，请刷新后重试")
            notes.add(ident)
            add_requested("note", ident)
        elif kind == "image":
            if not SESSION_ID_RE.match(ident) or not db.one("SELECT 1 AS ok FROM board_images WHERE id=?", (ident,)):
                raise BackupError(400, "所选图片已不存在，请刷新后重试")
            images.add(ident)
            add_requested("image", ident)
        elif kind == "doc":
            key = ident[4:] if ident.startswith("doc:") else ident
            if not DOC_KEY_RE.match(key) or not db.get_doc_card(key):
                raise BackupError(400, "所选文档卡片已不存在，请刷新后重试")
            docs.add(key)
            add_requested("doc", key)
        else:
            raise BackupError(400, "不支持的卡片类型")

    for pack_id in pack_ids:
        for member in db.list_card_pack_members(pack_id):
            member_type = str(member.get("member_type") or "")
            member_id = str(member.get("member_id") or "")
            if member_type == "session":
                sessions.add(member_id)
            elif member_type == "batch":
                batch_ids.add(member_id)
            elif member_type == "highlight":
                mark = db.one("SELECT session_id FROM marks WHERE id=?", (_int(member_id),))
                if mark:
                    sessions.add(str(mark["session_id"]))
                    highlight_ids.add(_int(member_id))
            elif member_type == "note":
                notes.add(member_id)
            elif member_type == "image":
                images.add(member_id)
            elif member_type == "doc":
                docs.add(member_id[4:] if member_id.startswith("doc:") else member_id)

    for batch_id in batch_ids:
        batch = db.get_link_batch(batch_id)
        for member in (batch or {}).get("members") or []:
            sessions.add(str(member.get("id") or ""))

    sessions.discard("")
    notes.discard("")
    images.discard("")
    docs.discard("")
    return {
        "sessions": sessions,
        "notes": notes,
        "images": images,
        "docs": docs,
        "packs": pack_ids,
        "batches": batch_ids,
        "highlights": highlight_ids,
        "requested": requested,
    }


# --------------------------------------------------------------------------- 导出


def _planned_shot_paths(shots: list[dict], sid: str, warnings: list[str]) -> list[dict]:
    """把截图行整理成可复制的相对路径；文件缺失的行丢弃。"""
    out: list[dict] = []
    used: set[str] = set()
    for index, shot in enumerate(shots):
        safe = _safe_rel(shot.get("path"))
        source = _file_below(DATA_DIR / sid, safe) if safe else None
        if not source:
            _warn(warnings, f"有一条记录的截图文件缺失，已跳过（{sid[:6]}…）")
            continue
        name = Path(safe).name
        if name.casefold() in used:
            name = f"{index}-{name}"
        used.add(name.casefold())
        out.append({
            "path": f"shots/{name}",
            "source": source,
            "ts": _num(shot.get("ts")),
            "ocr_text": str(shot.get("ocr_text") or "")[:4000],
            "created_at": _num(shot.get("created_at")),
        })
    return out


def _session_payload(sid: str, include_media: bool, batch_members: dict[str, set[str]],
                     included_sessions: set[str], warnings: list[str]) -> tuple[dict, list[tuple[str, Path]]]:
    row = db.get_session(sid) or {}
    trs = db.get_transcripts(sid)
    shots = _planned_shot_paths(db.get_screenshots(sid), sid, warnings)
    marks = db.get_marks(sid)
    minutes = db.get_minutes(sid)
    interactions = db.get_minutes_interactions(sid)

    status = str(row.get("status") or "pending")
    active = status in ACTIVE_STATUSES
    media_rel = _safe_rel(row.get("media_path")) or _safe_rel(row.get("audio_path"))
    media_source = _file_below(DATA_DIR / sid, media_rel) if media_rel else None
    keep_media = bool(include_media and media_source and not active)
    if include_media and active and media_source:
        _warn(warnings, "有记录正在采集，备份未包含它的视频/音频")
    if include_media and not active and not media_source and (row.get("media_path") or row.get("audio_path")):
        _warn(warnings, "有记录的音视频文件不在资料库里，备份未包含媒体")

    files: list[tuple[str, Path]] = []
    for shot in shots:
        files.append((f"records/{sid}/{shot['path']}", shot["source"]))
    media_name = Path(media_rel).name if keep_media and media_rel else ""
    if keep_media and media_name:
        files.append((f"records/{sid}/media/{media_name}", media_source))
    cover = _file_below(DATA_DIR / sid, "cover.jpg")
    if cover:
        files.append((f"records/{sid}/cover.jpg", cover))

    meta = dict(row.get("meta") or {}) if isinstance(row.get("meta"), dict) else {}
    batch = meta.get("batch") if isinstance(meta.get("batch"), dict) else None
    if batch and batch.get("id"):
        origin = str(batch.get("id"))
        members = batch_members.get(origin) or set()
        if members and not members.issubset(included_sessions):
            meta.pop("batch", None)
            _warn(warnings, "有批次只选了一部分成员，导入后会按单条记录显示")

    session = {
        "id": sid,
        "title": _text(row.get("title"), MAX_TITLE) or "未命名记录",
        "source_url": str(row.get("source_url") or ""),
        "platform": str(row.get("platform") or ""),
        "status": status,
        "source_type": str(row.get("source_type") or ""),
        "created_at": _num(row.get("created_at")),
        "started_at": _num(row.get("started_at")) if row.get("started_at") else None,
        "ended_at": _num(row.get("ended_at")) if row.get("ended_at") else None,
        "duration": _num(row.get("duration")),
        "media_path": media_name or None,
        "audio_path": None,
        "error": str(row.get("error") or "")[:1000],
        "kind": row.get("kind") or "live",
        "notes": str(row.get("notes") or ""),
        "notes_version": _int(row.get("notes_version")),
        "normalized_url": str(row.get("normalized_url") or ""),
        "download_mode": row.get("download_mode"),
        "calendar_date": row.get("calendar_date"),
        "meta": meta,
        "media_included": bool(keep_media),
    }
    payload = {
        "schema": 1,
        "session": session,
        "transcripts": [
            {
                "start": _num(item.get("start")),
                "end": _num(item.get("end")),
                "text": str(item.get("text") or ""),
                "speaker": item.get("speaker"),
                "created_at": _num(item.get("created_at")),
            }
            for item in trs
        ],
        "screenshots": [
            {"path": shot["path"], "ts": shot["ts"], "ocr_text": shot["ocr_text"],
             "created_at": shot["created_at"]}
            for shot in shots
        ],
        "marks": [
            {"id": _int(item.get("id")), "ts": _num(item.get("ts")),
             "note": str(item.get("note") or ""), "created_at": _num(item.get("created_at"))}
            for item in marks
        ],
        "minutes": (
            {
                "data": minutes.get("data") or {},
                "covered": _num(minutes.get("covered")),
                "kind": minutes.get("kind") or "live",
                "lang": str(minutes.get("lang") or ""),
                "state": str(minutes.get("state") or "idle"),
                "error": str(minutes.get("error") or "")[:500],
                "updated_at": _num(minutes.get("updated_at")),
                "version": max(1, _int(minutes.get("version"), 1)),
            }
            if minutes else None
        ),
        "interactions": (
            {
                "data": interactions.get("data") or {},
                "updated_at": _num(interactions.get("updated_at")),
                "version": max(1, _int(interactions.get("version"), 1)),
            }
            if interactions else None
        ),
    }
    return payload, files


def _zip_json(zf: zipfile.ZipFile, name: str, value) -> int:
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    zf.writestr(name, data)
    return len(data)


def _zip_file(zf: zipfile.ZipFile, name: str, source: Path, job: _Job, stored: bool = False) -> None:
    """流式写入一个文件；媒体/截图/图片已经是压缩格式，用 ZIP_STORED 避免白烧 CPU。"""
    previous = zf.compression
    if stored:
        zf.compression = zipfile.ZIP_STORED
    try:
        with source.open("rb") as src, zf.open(name, "w", force_zip64=True) as dst:
            while True:
                job.check()
                chunk = src.read(CHUNK)
                if not chunk:
                    break
                dst.write(chunk)
                job.add_bytes(len(chunk))
    finally:
        zf.compression = previous


def _archive_name(dest: Path) -> Path:
    stamp = time.strftime("%Y%m%d-%H%M", time.localtime())
    for index in range(1, 100):
        suffix = "" if index == 1 else f"-{index}"
        candidate = dest / f"{ARCHIVE_PREFIX}{stamp}{suffix}.zip"
        if not candidate.exists():
            return candidate
    return dest / f"{ARCHIVE_PREFIX}{stamp}-{uuid.uuid4().hex[:4]}.zip"


def _pick_manifest(source: dict, include_media: bool, counts: dict, warnings: list[str]) -> dict:
    packed: dict[tuple[str, str], int] = {}
    for pack in source["packs"]:
        row = db.get_card_pack(pack)
        if row:
            member_rows = db.list_card_pack_members(pack)
            packed[("pack", pack)] = len(member_rows)
    items = []
    for entry in source["requested"]:
        kind, ident = entry["type"], entry["id"]
        row = None
        if kind == "session":
            row = db.get_session(ident)
        elif kind == "pack":
            row = db.get_card_pack(ident)
        elif kind == "batch":
            row = db.get_link_batch(ident)
        elif kind == "highlight":
            row = db.one("SELECT id, note FROM marks WHERE id=?", (_int(ident),))
        elif kind == "note":
            row = db.one("SELECT id, text, kind FROM sticky_notes WHERE id=?", (ident,))
        elif kind == "image":
            row = db.one("SELECT id FROM board_images WHERE id=?", (ident,))
        elif kind == "doc":
            row = db.get_doc_card(ident)
        if not row:
            continue
        item = {"type": kind, "id": ident}
        if kind == "session":
            item["title"] = _text(row.get("title"), 120)
            item["kind"] = row.get("kind") or "live"
        elif kind == "pack":
            item["title"] = _text(row.get("title"), 120) or "卡包"
            item["member_count"] = packed.get(("pack", ident), 0)
        elif kind == "batch":
            item["title"] = _text(row.get("title"), 120) or "批量视频"
            item["member_count"] = len(row.get("members") or [])
        elif kind == "highlight":
            mark = db.one(
                "SELECT m.note,s.title AS session_title,s.id AS session_id FROM marks m "
                "JOIN sessions s ON s.id=m.session_id WHERE m.id=?", (_int(ident),)
            ) or {}
            item["title"] = _text(mark.get("note"), 120) or "标记"
            item["session_id"] = mark.get("session_id")
            item["session_title"] = _text(mark.get("session_title"), 120)
        elif kind == "note":
            item["title"] = _text(row.get("text"), 120) or "便利签"
        elif kind == "image":
            item["title"] = "图片卡"
        elif kind == "doc":
            item["title"] = _text(row.get("title"), 120) or "飞书文档"
        items.append(item)
    return {
        "format": FORMAT_NAME,
        "format_version": FORMAT_VERSION,
        "archive_id": uuid.uuid4().hex,
        "created_at": time.time(),
        "app_version": app_version(),
        "source": {"library": _library_name()},
        "options": {"include_media": bool(include_media)},
        "items": items,
        "counts": counts,
        "warnings": warnings,
    }


def _included_batches(records: list[dict]) -> int:
    ids = set()
    for item in records:
        meta = item["payload"]["session"].get("meta")
        if isinstance(meta, dict) and isinstance(meta.get("batch"), dict):
            ident = str(meta["batch"].get("id") or "")
            if ident:
                ids.add(ident)
    return len(ids)


def _run_export(job: _Job, dest: Path, source: dict, include_media: bool) -> None:
    warnings: list[str] = []
    temp: Path | None = None
    try:
        job.update(phase="收集内容", message="正在读取卡片内容")
        batch_members: dict[str, set[str]] = {
            str(batch.get("id")): {str(m.get("id")) for m in batch.get("members") or []}
            for batch in db.list_link_batches(10_000)
        }
        included = set(source["sessions"])
        records = []
        plan_bytes = 0
        for sid in sorted(included):
            job.check()
            payload, files = _session_payload(sid, include_media, batch_members, included, warnings)
            size = _json_size(payload) + sum(_file_size(path) for _, path in files)
            plan_bytes += size
            records.append({"id": sid, "payload": payload, "files": files, "size": size})
            job.update(done=len(records), total=max(len(included), 1))

        notes = []
        for nid in source["notes"]:
            row = db.one("SELECT * FROM sticky_notes WHERE id=?", (nid,)) or {}
            try:
                checked = json.loads(row.get("checked") or "[]")
            except (TypeError, ValueError):
                checked = []
            notes.append({
                "id": nid,
                "text": str(row.get("text") or ""),
                "kind": row.get("kind") or "note",
                "checked": checked if isinstance(checked, list) else [],
                "x": _num(row.get("x")),
                "y": _num(row.get("y")),
                "created_at": _num(row.get("created_at")),
                "updated_at": _num(row.get("updated_at")),
            })

        images = []
        for iid in source["images"]:
            row = db.one("SELECT * FROM board_images WHERE id=?", (iid,)) or {}
            rel = _safe_rel(row.get("path"))
            path = _file_below(DATA_DIR, rel) if rel else None
            if not path:
                _warn(warnings, "有图片卡的文件缺失，已跳过")
                continue
            images.append({
                "id": iid,
                "path": rel,
                "source": path,
                "width": _int(row.get("width")),
                "height": _int(row.get("height")),
                "x": _num(row.get("x")),
                "y": _num(row.get("y")),
                "created_at": _num(row.get("created_at")),
            })

        docs = []
        for key in source["docs"]:
            row = db.get_doc_card(key) or {}
            docs.append({
                "key": key,
                "url": str(row.get("url") or ""),
                "doc_type": str(row.get("doc_type") or "docx"),
                "token": str(row.get("token") or ""),
                "document_id": str(row.get("document_id") or ""),
                "title": _text(row.get("title"), MAX_TITLE) or "飞书文档",
                "content": str(row.get("content") or ""),
                "revision": str(row.get("revision") or ""),
                "meta": str(row.get("meta") or "{}"),
                "created_at": _num(row.get("created_at")),
                "updated_at": _num(row.get("updated_at")),
            })

        pack_payloads = []
        for pack_id in source["packs"]:
            row = db.get_card_pack(pack_id) or {}
            members = []
            for member in db.list_card_pack_members(pack_id):
                member_type = str(member.get("member_type") or "")
                member_id = str(member.get("member_id") or "")
                if member_type == "doc" and member_id.startswith("doc:"):
                    member_id = member_id[4:]
                members.append({"type": member_type, "id": member_id})
            pack_payloads.append({
                "id": pack_id,
                "title": _text(row.get("title"), 120) or "卡包",
                "created_at": _num(row.get("created_at")),
                "updated_at": _num(row.get("updated_at")),
                "members": members,
            })

        counts = {
            "records": len(records),
            "transcripts": sum(len(item["payload"]["transcripts"]) for item in records),
            "screenshots": sum(len(item["payload"]["screenshots"]) for item in records),
            "marks": sum(len(item["payload"]["marks"]) for item in records),
            "minutes": sum(1 for item in records if item["payload"]["minutes"]),
            "notes": len(notes),
            "images": len(images),
            "docs": len(docs),
            "packs": len(pack_payloads),
            "batches": _included_batches(records),
            "highlights": len(source["highlights"]),
        }

        manifest = _pick_manifest(source, include_media, counts, warnings)
        plan_bytes += sum(_json_size(item) for item in notes)
        plan_bytes += sum(_json_size(item) for item in docs)
        plan_bytes += sum(_json_size(item) for item in pack_payloads)
        plan_bytes += sum(_file_size(item["source"]) for item in images)
        plan_bytes += _json_size(manifest) + 2048

        free = _free_bytes(dest)
        if free is not None and free < plan_bytes * 1.05 + 32 * 1024 * 1024:
            raise BackupError(507, "目标文件夹所在磁盘空间不足，请换一个位置或取消勾选视频/音频")

        job.update(phase="写入备份", total=max(len(records) + len(notes) + len(images) + len(docs) + len(pack_payloads) + 1, 1),
                   bytes_total=max(plan_bytes, 1))
        temp = dest / f".{ARCHIVE_PREFIX}{uuid.uuid4().hex[:8]}.zip.part"
        done = 0
        with zipfile.ZipFile(temp, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            readme = (
                "这是会摘（MeetClip）的备份文件。\n\n"
                "恢复方式：打开会摘 → 设置 → 备份 → 导入备份，选择本文件。\n"
                "备份只包含选中的卡片内容，不含账号 Cookie、模型 Key 与本机设置。\n"
            )
            zf.writestr(README_NAME, readme.encode("utf-8"))
            done += 1
            job.update(done=done)
            job.add_bytes(len(readme))
            for item in records:
                job.check()
                _zip_json(zf, f"records/{item['id']}/record.json", item["payload"])
                for arc_name, path in item["files"]:
                    job.check()
                    _zip_file(zf, arc_name, path, job, stored=True)
                done += 1
                job.update(done=done)
            for note in notes:
                job.check()
                job.add_bytes(_zip_json(zf, f"notes/{note['id']}.json", note))
                done += 1
                job.update(done=done)
            for image in images:
                job.check()
                meta = {key: value for key, value in image.items() if key != "source"}
                job.add_bytes(_zip_json(zf, f"images/{image['id']}.json", meta))
                writer_name = f"images/files/{Path(image['path']).name}"
                _zip_file(zf, writer_name, image["source"], job, stored=True)
                done += 1
                job.update(done=done)
            for doc in docs:
                job.check()
                job.add_bytes(_zip_json(zf, f"docs/{doc['key']}.json", doc))
                done += 1
                job.update(done=done)
            for pack in pack_payloads:
                job.check()
                job.add_bytes(_zip_json(zf, f"packs/{pack['id']}.json", pack))
                done += 1
                job.update(done=done)
            job.update(phase="写入清单", message="正在写入 manifest.json")
            job.add_bytes(_zip_json(zf, "manifest.json", manifest))

        job.check()
        final = _archive_name(dest)
        os.replace(temp, final)
        temp = None
        job.update(phase="校验", message="正在计算校验值")
        digest = hashlib.sha256()
        with final.open("rb") as handle:
            while True:
                chunk = handle.read(CHUNK * 4)
                if not chunk:
                    break
                digest.update(chunk)
        size = _file_size(final)
        result = {
            "path": str(final),
            "bytes": size,
            "sha256": digest.hexdigest(),
            "counts": counts,
            "warnings": warnings,
            "include_media": bool(include_media),
            "format_version": FORMAT_VERSION,
        }
        job.finish("done", result=result)
    except _Cancelled:
        if temp and temp.exists():
            try:
                temp.unlink()
            except OSError:
                pass
        job.finish("cancelled", error="已取消导出")
    except BackupError as exc:
        if temp and temp.exists():
            try:
                temp.unlink()
            except OSError:
                pass
        job.finish("error", error=exc.message)
    except Exception as exc:  # noqa: BLE001 - 任务线程必须把错误交给前端
        if temp and temp.exists():
            try:
                temp.unlink()
            except OSError:
                pass
        job.finish("error", error=f"导出失败：{_text(exc, 400) or exc.__class__.__name__}")


def start_export(payload: dict) -> dict:
    source = _resolve_selection(payload.get("items"))
    include_media = bool(payload.get("include_media"))
    raw_dest = _text(payload.get("dest"), 1000)
    dest = Path(os.path.expanduser(raw_dest)) if raw_dest else default_dest()
    if not dest.is_absolute():
        raise BackupError(400, "导出位置必须是绝对路径")
    try:
        dest.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise BackupError(400, f"无法创建导出文件夹：{_text(exc, 200)}") from exc
    if not dest.is_dir():
        raise BackupError(400, "导出位置不是一个文件夹")
    if not os.access(dest, os.W_OK):
        raise BackupError(400, "导出位置不可写，请换一个文件夹")
    return _start("export", lambda job: _run_export(job, dest, source, include_media))


# --------------------------------------------------------------------------- 读取备份


class _Archive:
    def __init__(self, path: Path, zf: zipfile.ZipFile, names: set[str], total: int):
        self.path = path
        self.zf = zf
        self.names = names
        self.total = total
        self.media_bytes = 0

    def close(self) -> None:
        try:
            self.zf.close()
        except OSError:
            pass

    def size(self, name: str) -> int:
        try:
            return int(self.zf.getinfo(name).file_size)
        except KeyError:
            return 0

    def read_bytes(self, name: str, limit: int = MAX_RECORD_JSON_BYTES) -> bytes:
        info = self.zf.getinfo(name)
        if info.file_size > limit:
            raise BackupError(400, "备份里有异常大的数据块，已拒绝导入")
        return self.zf.read(info)

    def read_json(self, name: str, limit: int = MAX_RECORD_JSON_BYTES) -> Any:
        try:
            return json.loads(self.read_bytes(name, limit).decode("utf-8"))
        except KeyError as exc:
            raise BackupError(400, "备份文件不完整，缺少必要内容") from exc
        except (UnicodeDecodeError, ValueError) as exc:
            raise BackupError(400, "备份里的数据格式损坏，无法读取") from exc

    def copy_to(self, name: str, target: Path, job: _Job) -> bool:
        try:
            info = self.zf.getinfo(name)
        except KeyError:
            return False
        target.parent.mkdir(parents=True, exist_ok=True)
        with self.zf.open(info) as src, target.open("wb") as dst:
            while True:
                job.check()
                chunk = src.read(CHUNK)
                if not chunk:
                    break
                dst.write(chunk)
                job.add_bytes(len(chunk))
        return True


def _resolve_archive_path(raw) -> Path:
    text = _text(raw, 2000)
    if not text:
        raise BackupError(400, "请选择备份文件")
    path = Path(os.path.expanduser(text))
    if not path.is_absolute():
        raise BackupError(400, "备份文件路径必须是绝对路径")
    if not path.is_file():
        raise BackupError(400, "备份文件不存在，请重新选择")
    if _file_size(path) > MAX_ARCHIVE_BYTES:
        raise BackupError(413, "备份文件超过 64 GB，暂不支持导入")
    return path


def _open_archive(raw) -> _Archive:
    path = _resolve_archive_path(raw)
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise BackupError(400, "这个文件不是有效的会摘备份（zip 解压失败）") from exc
    infos = zf.infolist()
    if len(infos) > MAX_ENTRIES:
        zf.close()
        raise BackupError(400, "备份里的文件数量异常，已拒绝导入")
    names: set[str] = set()
    total = 0
    media_bytes = 0
    for info in infos:
        if info.is_dir():
            continue
        safe = _safe_rel(info.filename)
        if not safe or safe != info.filename:
            zf.close()
            raise BackupError(400, "备份里有非法文件路径，已拒绝导入")
        if info.file_size > MAX_ENTRY_BYTES:
            zf.close()
            raise BackupError(400, "备份里有异常大的文件，已拒绝导入")
        total += int(info.file_size)
        if total > MAX_TOTAL_BYTES:
            zf.close()
            raise BackupError(413, "备份解压后超过 100 GB，暂不支持导入")
        compressed = max(int(info.compress_size), 1)
        if info.file_size > SIZE_GUARD_MIN and info.file_size / compressed > SIZE_GUARD_RATIO:
            zf.close()
            raise BackupError(400, "备份压缩比异常，已拒绝导入")
        if safe.startswith("records/") and "/media/" in safe:
            media_bytes += int(info.file_size)
        names.add(safe)
    archive = _Archive(path, zf, names, total)
    archive.media_bytes = media_bytes
    return archive


def _read_manifest(archive: _Archive) -> dict:
    if "manifest.json" not in archive.names:
        raise BackupError(400, "这不是会摘备份：缺少 manifest.json")
    if archive.size("manifest.json") > MAX_MANIFEST_BYTES:
        raise BackupError(400, "备份清单异常大，已拒绝导入")
    manifest = archive.read_json("manifest.json", MAX_MANIFEST_BYTES)
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT_NAME:
        raise BackupError(400, "这不是会摘备份文件")
    version = _int(manifest.get("format_version"))
    if version < 1:
        raise BackupError(400, "备份格式版本无效")
    if version > FORMAT_VERSION:
        raise BackupError(400, f"备份来自更新版本的会摘（格式 v{version}），请先升级插件再导入")
    if not _text(manifest.get("archive_id"), 80):
        raise BackupError(400, "备份缺少标识，无法导入")
    return manifest


def _marker_rows(archive_id: str) -> dict[tuple[str, str], str]:
    try:
        rows = db.query(
            "SELECT item_type,item_id,target_id FROM backup_import_items WHERE archive_id=?",
            (archive_id,),
        )
    except Exception:
        return {}
    return {(str(row.get("item_type")), str(row.get("item_id"))): str(row.get("target_id")) for row in rows}


def _archive_entries(archive: _Archive) -> dict:
    record_entries = sorted(
        name for name in archive.names if name.startswith("records/") and name.endswith("/record.json")
    )
    note_entries = sorted(name for name in archive.names if re.match(r"^notes/[0-9a-f]{12}\.json$", name))
    image_entries = sorted(name for name in archive.names if re.match(r"^images/[0-9a-f]{12}\.json$", name))
    doc_entries = sorted(name for name in archive.names if re.match(r"^docs/[0-9a-f]{12}\.json$", name))
    pack_entries = sorted(name for name in archive.names if re.match(r"^packs/[a-z0-9-]{8,40}\.json$", name))
    return {
        "records": record_entries,
        "notes": note_entries,
        "images": image_entries,
        "docs": doc_entries,
        "packs": pack_entries,
    }


def inspect_archive(raw) -> dict:
    archive = _open_archive(raw)
    try:
        manifest = _read_manifest(archive)
        entries = _archive_entries(archive)
        counts = manifest.get("counts") if isinstance(manifest.get("counts"), dict) else {}
        archive_id = _text(manifest.get("archive_id"), 80)
        markers = _marker_rows(archive_id)
        already = {"records": 0, "packs": 0, "notes": 0, "images": 0, "docs": 0}
        for name in entries["records"]:
            origin = name.split("/")[1]
            if ("session", origin) in markers:
                already["records"] += 1
        for kind in ("packs", "notes", "images", "docs"):
            for name in entries[kind]:
                ident = Path(name).stem
                item_type = {"packs": "pack", "notes": "note", "images": "image", "docs": "doc"}[kind]
                if (item_type, ident) in markers:
                    already[kind] += 1
        items = [
            {
                "type": _text(entry.get("type"), 20),
                "title": _text(entry.get("title"), 140),
                "count": _int(entry.get("member_count")),
            }
            for entry in manifest.get("items") or []
            if isinstance(entry, dict)
        ][:200]
        return {
            "path": str(archive.path),
            "archive_bytes": _file_size(archive.path),
            "created_at": _num(manifest.get("created_at")),
            "app_version": _text(manifest.get("app_version"), 40),
            "source": manifest.get("source") if isinstance(manifest.get("source"), dict) else {},
            "options": manifest.get("options") if isinstance(manifest.get("options"), dict) else {},
            "format_version": _int(manifest.get("format_version"), 1),
            "counts": {key: _int(value) for key, value in counts.items()},
            "media_bytes": archive.media_bytes,
            "media_included": bool(archive.media_bytes),
            "items": items,
            "already_imported": already,
            "warnings": [str(item)[:300] for item in manifest.get("warnings") or []][:20],
            "compatible": True,
        }
    finally:
        archive.close()


# --------------------------------------------------------------------------- 导入


def _import_status(status: str, has_transcripts: bool) -> tuple[str, str]:
    status = str(status or "pending")
    if status in TERMINAL_STATUSES:
        return status, ""
    if has_transcripts:
        return "done", ""
    return "cancelled", "从备份导入时这条记录还没有完成"


def _record_dir(sid: str) -> Path:
    return DATA_DIR / sid


def _copy_record_files(archive: _Archive, origin: str, session: dict, screenshots: list,
                       include_media: bool, new_sid: str, job: _Job,
                       warnings: list[str]) -> tuple[list[dict], bool]:
    """把一条记录的截图/媒体/封面落到新目录；返回（可入库的截图行, 是否包含媒体）。"""
    base = _record_dir(new_sid)
    base.mkdir(parents=True, exist_ok=True)
    (base / IMPORT_MARKER).write_text(archive.path.name, encoding="utf-8")
    shots = []
    for shot in screenshots:
        if not isinstance(shot, dict):
            continue
        safe = _safe_rel(shot.get("path"))
        if not safe or not safe.startswith("shots/"):
            _warn(warnings, "备份里有截图路径异常，已跳过")
            continue
        member = f"records/{origin}/{safe}"
        if member not in archive.names:
            _warn(warnings, "备份里缺少截图文件，已跳过")
            continue
        job.check()
        if archive.copy_to(member, base / safe, job):
            shots.append({
                "ts": _num(shot.get("ts")),
                "path": safe,
                "ocr_text": str(shot.get("ocr_text") or "")[:4000],
                "created_at": _num(shot.get("created_at")),
            })
    media_ok = False
    media_rel = _safe_rel(session.get("media_path"))
    media_name = Path(media_rel).name if media_rel else ""
    if include_media and media_name:
        member = f"records/{origin}/media/{media_name}"
        if member in archive.names:
            job.check()
            if archive.copy_to(member, base / media_name, job):
                media_ok = True
    if include_media and media_name and not media_ok:
        _warn(warnings, "备份里缺少这条记录的视频/音频，导入后无法播放")
    cover = f"records/{origin}/cover.jpg"
    if cover in archive.names:
        job.check()
        archive.copy_to(cover, base / "cover.jpg", job)
    return shots, media_ok


def _run_import(job: _Job, raw_path: str, include_media: bool, skip_existing: bool) -> None:
    archive = _open_archive(raw_path)
    created_dirs: list[Path] = []
    created_images: list[Path] = []
    committed = False
    try:
        manifest = _read_manifest(archive)
        entries = _archive_entries(archive)
        if not entries["records"] and not entries["notes"] and not entries["images"] \
                and not entries["docs"] and not entries["packs"]:
            raise BackupError(400, "这个备份里没有可导入的卡片")
        archive_id = _text(manifest.get("archive_id"), 80)
        markers = _marker_rows(archive_id)
        warnings: list[str] = []

        if include_media:
            free = _free_bytes(DATA_DIR)
            if free is not None and free < archive.media_bytes + MIN_FREE_MARGIN:
                raise BackupError(507, "磁盘空间不足，无法导入这个备份的视频/音频；可取消勾选媒体后重试")

        job.update(phase="读取备份", message="正在读取备份内容")
        job.update(bytes_total=max(archive.total, 1))
        used_ids: set[str] = set()
        session_map: dict[str, str] = {}
        batch_map: dict[str, str] = {}
        mark_map: dict[int, int] = {}
        note_map: dict[str, str] = {}
        image_map: dict[str, str] = {}
        docs: list[dict] = []
        packs_to_create: list[dict] = []
        skipped = {"records": 0, "notes": 0, "images": 0, "docs": 0, "packs": 0}
        pending_records: list[dict] = []
        pending_notes: list[dict] = []
        pending_images: list[dict] = []
        markers_to_write: list[tuple[str, str, str, str]] = []

        for name in entries["records"]:
            job.check()
            origin = name.split("/")[1]
            if not SESSION_ID_RE.match(origin):
                continue
            marker = markers.get(("session", origin))
            if skip_existing and marker:
                session_map[origin] = marker
                skipped["records"] += 1
                job.add_bytes(archive.size(name))
                continue
            payload = archive.read_json(name)
            if not isinstance(payload, dict) or not isinstance(payload.get("session"), dict):
                _warn(warnings, "备份里有一条记录格式损坏，已跳过")
                continue
            session = payload["session"]
            new_sid = _unique_session_id(used_ids)
            session_map[origin] = new_sid
            created_dirs.append(_record_dir(new_sid))
            shots, media_ok = _copy_record_files(
                archive, origin, session, payload.get("screenshots") or [],
                include_media, new_sid, job, warnings,
            )
            status, status_error = _import_status(
                str(session.get("status") or ""), bool(payload.get("transcripts"))
            )
            meta = dict(session.get("meta") or {}) if isinstance(session.get("meta"), dict) else {}
            batch = meta.get("batch") if isinstance(meta.get("batch"), dict) else None
            if batch and batch.get("id"):
                origin_batch = str(batch.get("id"))
                if origin_batch not in batch_map:
                    batch_map[origin_batch] = uuid.uuid4().hex[:12]
                    markers_to_write.append(("batch", origin_batch, "batch", batch_map[origin_batch]))
                batch = {**batch, "id": batch_map[origin_batch]}
                meta["batch"] = batch
            meta.pop("imported_from", None)
            meta["imported_from"] = {"archive_id": archive_id, "origin_id": origin, "at": time.time()}
            if not media_ok:
                # 没有媒体就补不齐中断的转写：清掉失败清单，避免界面给出无法完成的「补齐」。
                meta.pop("asr_failures", None)
                meta["asr_status"] = "done"
            pending_records.append({
                "session": session,
                "origin": origin,
                "new_sid": new_sid,
                "status": status,
                "status_error": status_error,
                "meta": meta,
                "media_path": (_safe_rel(session.get("media_path")) if media_ok else None),
                "transcripts": payload.get("transcripts") or [],
                "screenshots": shots,
                "marks": payload.get("marks") or [],
                "minutes": payload.get("minutes"),
                "interactions": payload.get("interactions"),
            })
            job.add_bytes(archive.size(name))

        for name in entries["notes"]:
            job.check()
            ident = Path(name).stem
            marker = markers.get(("note", ident))
            if skip_existing and marker:
                note_map[ident] = marker
                skipped["notes"] += 1
                job.add_bytes(archive.size(name))
                continue
            data = archive.read_json(name)
            if not isinstance(data, dict):
                continue
            new_id = _unique_session_id(used_ids)
            note_map[ident] = new_id
            pending_notes.append({"id": new_id, "origin": ident, "data": data})
            job.add_bytes(archive.size(name))

        for name in entries["images"]:
            job.check()
            ident = Path(name).stem
            marker = markers.get(("image", ident))
            if skip_existing and marker:
                image_map[ident] = marker
                skipped["images"] += 1
                job.add_bytes(archive.size(name))
                continue
            data = archive.read_json(name)
            if not isinstance(data, dict):
                continue
            rel = _safe_rel(data.get("path")) or ""
            member = f"images/files/{Path(rel).name}" if rel else ""
            if not member or member not in archive.names:
                _warn(warnings, "备份里缺少图片文件，已跳过")
                continue
            new_id = _unique_session_id(used_ids)
            suffix = Path(member).suffix.lower()
            if not re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
                suffix = ".png"
            target = DATA_DIR / "board-images" / f"{new_id}{suffix}"
            job.check()
            archive.copy_to(member, target, job)
            created_images.append(target)
            image_map[ident] = new_id
            pending_images.append({
                "id": new_id,
                "origin": ident,
                "path": f"board-images/{new_id}{suffix}",
                "width": _int(data.get("width")),
                "height": _int(data.get("height")),
                "x": _num(data.get("x")),
                "y": _num(data.get("y")),
                "created_at": _num(data.get("created_at")),
            })
            job.add_bytes(archive.size(name))

        for name in entries["docs"]:
            job.check()
            key = Path(name).stem
            data = archive.read_json(name)
            if not isinstance(data, dict):
                continue
            existing = db.get_doc_card(key)
            if skip_existing and (existing or ("doc", key) in markers):
                skipped["docs"] += 1
                job.add_bytes(archive.size(name))
                continue
            docs.append({"key": key, "origin": key, "data": data})
            job.add_bytes(archive.size(name))

        for name in entries["packs"]:
            job.check()
            ident = Path(name).stem
            marker = markers.get(("pack", ident))
            if skip_existing and marker:
                skipped["packs"] += 1
                job.add_bytes(archive.size(name))
                continue
            data = archive.read_json(name)
            if not isinstance(data, dict):
                continue
            packs_to_create.append({"origin": ident, "data": data})
            job.add_bytes(archive.size(name))

        # ---- 单事务写库：记录、转写、截图、标记、纪要、互动、便利签、图片 ----
        job.update(phase="写入资料库", message="正在写入卡片内容")
        with db.transaction():
            for item in pending_records:
                session = item["session"]
                has_tr = bool(item["transcripts"])
                status, status_error = item["status"], item["status_error"]
                db.execute(
                    "INSERT INTO sessions(id,title,source_url,platform,status,source_type,created_at,"
                    "started_at,ended_at,duration,media_path,audio_path,error,meta,kind,notes,"
                    "normalized_url,download_mode,calendar_date,notes_version) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        item["new_sid"],
                        _text(session.get("title"), MAX_TITLE) or "未命名记录",
                        str(session.get("source_url") or ""),
                        str(session.get("platform") or ""),
                        status,
                        str(session.get("source_type") or ""),
                        _num(session.get("created_at"), time.time()),
                        _num(session.get("started_at")) or None,
                        _num(session.get("ended_at")) or None,
                        _num(session.get("duration")),
                        item["media_path"],
                        None,
                        status_error or _text(session.get("error"), 1000),
                        json.dumps(item["meta"], ensure_ascii=False),
                        str(session.get("kind") or "live"),
                        str(session.get("notes") or ""),
                        str(session.get("normalized_url") or ""),
                        session.get("download_mode"),
                        session.get("calendar_date"),
                        _int(session.get("notes_version")),
                    ),
                )
                rows = [
                    (
                        item["new_sid"],
                        _num(entry.get("start")),
                        _num(entry.get("end")),
                        str(entry.get("text") or ""),
                        _num(entry.get("created_at"), time.time()),
                        entry.get("speaker"),
                    )
                    for entry in item["transcripts"] if isinstance(entry, dict)
                ]
                if rows:
                    with db._lock:
                        db._conn.executemany(
                            "INSERT INTO transcripts(session_id,start,end,text,created_at,speaker) "
                            "VALUES(?,?,?,?,?,?)", rows,
                        )
                for shot in item["screenshots"]:
                    db.execute(
                        "INSERT INTO screenshots(session_id,ts,path,ocr_text,created_at) VALUES(?,?,?,?,?)",
                        (item["new_sid"], shot["ts"], shot["path"], shot["ocr_text"], shot["created_at"]),
                    )
                for mark in item["marks"]:
                    if not isinstance(mark, dict):
                        continue
                    cur = db.execute(
                        "INSERT INTO marks(session_id,ts,note,created_at) VALUES(?,?,?,?)",
                        (item["new_sid"], _num(mark.get("ts")), str(mark.get("note") or "")[:4000],
                         _num(mark.get("created_at"), time.time())),
                    )
                    origin_mark = _int(mark.get("id"))
                    if origin_mark and cur.lastrowid:
                        mark_map[origin_mark] = int(cur.lastrowid)
                        markers_to_write.append(("mark", str(origin_mark), "mark", str(cur.lastrowid)))
                minutes = item["minutes"]
                if isinstance(minutes, dict):
                    state = str(minutes.get("state") or "idle")
                    if state in ("updating", "failed", "no_key", "invalid_key", "rate_limited"):
                        state = "idle"
                    db.execute(
                        "INSERT INTO session_minutes(session_id,data,covered,kind,lang,state,error,updated_at,version) "
                        "VALUES(?,?,?,?,?,?,?,?,?)",
                        (item["new_sid"],
                         json.dumps(minutes.get("data") or {}, ensure_ascii=False),
                         _num(minutes.get("covered")),
                         str(minutes.get("kind") or "live"),
                         str(minutes.get("lang") or ""),
                         state,
                         str(minutes.get("error") or "")[:500],
                         _num(minutes.get("updated_at"), time.time()),
                         max(1, _int(minutes.get("version"), 1))),
                    )
                interactions = item["interactions"]
                if isinstance(interactions, dict):
                    db.execute(
                        "INSERT INTO session_minutes_interactions(session_id,data,updated_at,version) "
                        "VALUES(?,?,?,?)",
                        (item["new_sid"],
                         json.dumps(interactions.get("data") or {}, ensure_ascii=False),
                         _num(interactions.get("updated_at"), time.time()),
                         max(1, _int(interactions.get("version"), 1))),
                    )
                markers_to_write.append(("session", item["origin"], "session", item["new_sid"]))

            for note in pending_notes:
                data = note["data"]
                checked = data.get("checked")
                if not isinstance(checked, list):
                    checked = []
                db.execute(
                    "INSERT INTO sticky_notes(id,text,kind,checked,x,y,created_at,updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (note["id"], str(data.get("text") or ""), str(data.get("kind") or "note"),
                     json.dumps(checked, ensure_ascii=False), _num(data.get("x")), _num(data.get("y")),
                     _num(data.get("created_at"), time.time()), _num(data.get("updated_at"), time.time())),
                )
                markers_to_write.append(("note", note["origin"], "note", note["id"]))

            for image in pending_images:
                db.execute(
                    "INSERT INTO board_images(id,path,width,height,x,y,created_at) VALUES(?,?,?,?,?,?,?)",
                    (image["id"], image["path"], image["width"], image["height"],
                     image["x"], image["y"], image["created_at"] or time.time()),
                )
                markers_to_write.append(("image", image["origin"], "image", image["id"]))

            for item in markers_to_write:
                db.execute(
                    "INSERT OR IGNORE INTO backup_import_items"
                    "(archive_id,item_type,item_id,target_type,target_id,imported_at) VALUES(?,?,?,?,?,?)",
                    (archive_id, item[0], item[1], item[2], item[3], time.time()),
                )
        committed = True
        for item in pending_records:
            marker = _record_dir(item["new_sid"]) / IMPORT_MARKER
            try:
                marker.unlink()
            except OSError:
                pass

        # ---- 文档卡：已存在的不覆盖 ----
        job.update(phase="登记链接卡片", message="正在登记文档与链接卡片")
        for doc in docs:
            job.check()
            data = doc["data"]
            try:
                result = cards.upsert_doc_card(
                    str(data.get("url") or ""),
                    title=str(data.get("title") or ""),
                    content=str(data.get("content") or ""),
                    document_id=str(data.get("document_id") or ""),
                    revision=str(data.get("revision") or ""),
                    meta=data.get("meta"),
                )
                key = str((result.get("card") or {}).get("key") or doc["key"])
                db.execute(
                    "INSERT OR IGNORE INTO backup_import_items"
                    "(archive_id,item_type,item_id,target_type,target_id,imported_at) VALUES(?,?,?,?,?,?)",
                    (archive_id, "doc", doc["origin"], "doc", key, time.time()),
                )
            except (ValueError, OSError) as exc:
                _warn(warnings, f"有链接卡片登记失败：{_text(exc, 120)}")

        # ---- 卡包：成员重映射后建新卡包 ----
        job.update(phase="恢复卡包", message="正在恢复卡包与成员")
        packs_created = 0
        for pack in packs_to_create:
            job.check()
            data = pack["data"]
            members: list[tuple[str, str]] = []
            missing = 0
            for member in data.get("members") or []:
                if not isinstance(member, dict):
                    continue
                member_type = str(member.get("type") or "")
                origin_id = str(member.get("id") or "")
                target_id = ""
                if member_type == "session":
                    target_id = session_map.get(origin_id, "")
                elif member_type == "batch":
                    target_id = batch_map.get(origin_id) or markers.get(("batch", origin_id), "")
                elif member_type == "highlight":
                    mapped = mark_map.get(_int(origin_id))
                    target_id = str(mapped) if mapped else markers.get(("mark", origin_id), "")
                elif member_type == "note":
                    target_id = note_map.get(origin_id) or markers.get(("note", origin_id), "")
                elif member_type == "image":
                    target_id = image_map.get(origin_id) or markers.get(("image", origin_id), "")
                elif member_type == "doc":
                    key = origin_id[4:] if origin_id.startswith("doc:") else origin_id
                    target_id = f"doc:{key}" if db.get_doc_card(key) else ""
                if not target_id:
                    missing += 1
                    continue
                if db.card_pack_for_member(member_type, target_id):
                    missing += 1
                    continue
                members.append((member_type, target_id))
            if missing:
                _warn(warnings, f"有 {missing} 张卡片没进新卡包（已在其他卡包或未导入）")
            if not members:
                _warn(warnings, "有一个卡包的成员都没有导入成功，已跳过这个卡包")
                continue
            try:
                created = packs.create_pack("", str(data.get("title") or "") or "卡包", members)
                packs_created += 1
                db.execute(
                    "INSERT OR IGNORE INTO backup_import_items"
                    "(archive_id,item_type,item_id,target_type,target_id,imported_at) VALUES(?,?,?,?,?,?)",
                    (archive_id, "pack", pack["origin"], "pack", str(created.get("id") or ""), time.time()),
                )
            except packs.PackError as exc:
                _warn(warnings, f"有卡包恢复失败：{_text(exc.message, 120)}")

        # ---- 卡片文件：与首页/@ 菜单保持一致 ----
        job.update(phase="生成卡片", message="正在生成会摘卡片")
        try:
            cards.sync_cards()
        except Exception as exc:  # noqa: BLE001 - 卡片是派生数据，失败不影响导入结果
            _warn(warnings, f"卡片文件生成失败，稍后会自动重试：{_text(exc, 120)}")

        counts = {
            "records": len(pending_records),
            "notes": len(pending_notes),
            "images": len(pending_images),
            "docs": len(docs),
            "packs": packs_created,
            "transcripts": sum(len(item["transcripts"]) for item in pending_records),
            "marks": sum(len(item["marks"]) for item in pending_records),
            "screenshots": sum(len(item["screenshots"]) for item in pending_records),
        }
        job.finish("done", result={
            "archive": {
                "path": str(archive.path),
                "archive_id": archive_id,
                "source": manifest.get("source") or {},
                "created_at": _num(manifest.get("created_at")),
                "format_version": _int(manifest.get("format_version"), 1),
            },
            "counts": counts,
            "skipped": skipped,
            "warnings": warnings,
            "include_media": bool(include_media),
        })
    except _Cancelled:
        created_dirs_failed = created_dirs
        if not committed:
            for directory in created_dirs_failed:
                shutil.rmtree(directory, ignore_errors=True)
            for image in created_images:
                try:
                    image.unlink()
                except OSError:
                    pass
        job.finish("cancelled", error="已取消导入")
    except BackupError as exc:
        if not committed:
            for directory in created_dirs:
                shutil.rmtree(directory, ignore_errors=True)
            for image in created_images:
                try:
                    image.unlink()
                except OSError:
                    pass
        job.finish("error", error=exc.message)
    except Exception as exc:  # noqa: BLE001
        if not committed:
            for directory in created_dirs:
                shutil.rmtree(directory, ignore_errors=True)
            for image in created_images:
                try:
                    image.unlink()
                except OSError:
                    pass
        job.finish("error", error=f"导入失败：{_text(exc, 400) or exc.__class__.__name__}")
    finally:
        archive.close()


def start_import(payload: dict) -> dict:
    raw_path = _text(payload.get("path"), 2000)
    archive = _open_archive(raw_path)
    try:
        manifest = _read_manifest(archive)
        archive_id = _text(manifest.get("archive_id"), 80)
        if not archive_id:
            raise BackupError(400, "备份缺少标识，无法导入")
    finally:
        archive.close()
    include_media = payload.get("include_media")
    include_media = True if include_media is None else bool(include_media)
    skip_existing = payload.get("skip_existing")
    skip_existing = True if skip_existing is None else bool(skip_existing)
    return _start("import", lambda job: _run_import(job, raw_path, include_media, skip_existing))


# --------------------------------------------------------------------------- 恢复


def recover_stale() -> dict:
    """清掉上次被强行中断留下的导入目录（只删自己带标记、且数据库里没有记录的目录）。"""
    removed = 0
    try:
        entries = [entry for entry in DATA_DIR.iterdir() if entry.is_dir()]
    except OSError:
        return {"removed": 0}
    for entry in entries:
        if not SESSION_ID_RE.match(entry.name):
            continue
        marker = entry / IMPORT_MARKER
        if not marker.is_file():
            continue
        try:
            if db.one("SELECT 1 AS ok FROM sessions WHERE id=?", (entry.name,)):
                marker.unlink(missing_ok=True)
                continue
            shutil.rmtree(entry, ignore_errors=True)
            removed += 1
        except OSError:
            continue
    return {"removed": removed}
