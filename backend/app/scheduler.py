"""发布会、会议和链接视频共用的持久化 FIFO 队列与单一处理槽位。"""
from __future__ import annotations

import json
import logging
import threading
import time

from database import db


class BusyError(Exception):
    """该记录或处理槽位已有任务。"""


_lock = threading.RLock()
_owner: str | None = None
_task = None
_worker: threading.Thread | None = None
_stopping = True
changed = threading.Event()


def _eligible(row):
    if row["task_type"] == "link_video":
        import link_video
        return not link_video.manager.paused and not link_video.manager.stopping
    return True


def _next():
    row = next((r for r in db.query("SELECT * FROM task_queue WHERE state='queued' ORDER BY id")
                if _eligible(r)), None)
    if row:
        import asr
        payload = json.loads(row["payload"])
        needs_model = row["task_type"] in ("meeting", "link_video") or payload.get("transcribe_only")
        meta = (db.get_session(row["session_id"]) or {}).get("meta") or {}
        if row["task_type"] == "link_video" and meta.get("transcription_mode") == "auto":
            needs_model = False
        if needs_model and (meta.get("asr_engine") or {}).get("provider", "local") == "local":
            if asr.manager.is_loading():
                return None
    return row


def acquire(sid: str, factory=None):
    """底层管线占用槽位；用户提交任务应调用 enqueue。创建/启动失败时归还槽位。"""
    global _owner, _task
    with _lock:
        if _owner is not None and _owner != sid:
            raise BusyError(_owner)
        if _owner == sid and _task is not None:
            return _task
        if _owner is None:
            pending = _next()
            if pending:
                raise BusyError(pending["session_id"])
        _owner = sid
        try:
            _task = factory() if factory else None
            if _task is not None:
                _task.start()
            return _task
        except Exception:
            _owner = None
            _task = None
            changed.set()
            raise


def try_reserve(sid: str) -> bool:
    try:
        acquire(sid)
        return True
    except BusyError:
        return False


def attach(sid: str, task) -> None:
    global _task
    with _lock:
        if _owner == sid:
            _task = task


def release(sid: str, task=None) -> None:
    global _owner, _task
    with _lock:
        if _owner != sid or (task is not None and _task is not None and _task is not task):
            return
        db.execute("DELETE FROM task_queue WHERE session_id=? AND state='running'", (sid,))
        _owner = None
        _task = None
        changed.set()


def owner() -> str | None:
    with _lock:
        return _owner


def task_for(sid: str):
    with _lock:
        return _task if _owner == sid else None


def current():
    with _lock:
        return _owner, _task


def is_busy() -> bool:
    return owner() is not None


def is_queued(sid: str) -> bool:
    with _lock:
        return bool(db.one("SELECT id FROM task_queue WHERE session_id=?", (sid,)))


def enqueue(sid: str, task_type: str, **payload):
    """提交时原子保存任务与参数，重复提交同一记录不创建第二个任务。"""
    if task_type not in ("capture", "meeting", "link_video"):
        raise ValueError(f"未知任务类型：{task_type}")
    with _lock:
        if _owner != sid and not is_queued(sid):
            with db.transaction():
                if not db.get_session(sid):
                    raise ValueError("记录不存在")
                if task_type == "link_video":
                    job = db.get_link_job(sid)
                    if not job or job["job_state"] not in ("queued", "waiting_for_slot", "paused"):
                        return info(sid)
                db.execute("INSERT INTO task_queue(session_id,task_type,payload,created_at) VALUES(?,?,?,?)",
                           (sid, task_type, json.dumps(payload, ensure_ascii=False), time.time()))
                db.update_session(sid, status="queued", error=None, ended_at=None)
                db.update_meta(sid, asr_status="queued")
        result = info(sid)
        start()
        changed.set()
        return result


def snapshot():
    with _lock:
        rows = db.query("SELECT q.id AS queue_order,q.session_id,q.task_type,q.state,s.title,s.kind "
                        "FROM task_queue q JOIN sessions s ON s.id=q.session_id "
                        "ORDER BY CASE q.state WHEN 'running' THEN 0 ELSE 1 END,q.id")
        position = 0
        for row in rows:
            if row["state"] == "queued":
                position += 1
            row["queue_position"] = position if row["state"] == "queued" else None
            row["paused"] = not _eligible(row)
        return {"running_id": _owner, "waiting_count": position, "jobs": rows}


def info(sid: str):
    row = next((r for r in snapshot()["jobs"] if r["session_id"] == sid), {})
    return {"queued": row.get("state") == "queued", "queue_position": row.get("queue_position"),
            "queue_paused": row.get("paused", False)}


def cancel(sid: str) -> bool:
    """与出队启动共用锁：取消成功后，尚未开始的任务不可能再次启动。"""
    with _lock:
        task = task_for(sid)
        queued = is_queued(sid)
        if task:
            task.cancel()
            return True
        if not queued:
            return False
        with db.transaction():
            db.execute("DELETE FROM task_queue WHERE session_id=?", (sid,))
            db.update_session(sid, status="cancelled", error="已取消排队", ended_at=time.time())
            db.update_meta(sid, asr_status="cancelled")
            if db.get_link_job(sid):
                db.update_link_job(sid, job_state="cancelled", phase="cancelled", finished_at=time.time())
        changed.set()
        return True


def recover():
    """保留待处理参数与顺序；离线链接可重试，已中断的采集/会议由各管线标记。"""
    with _lock, db.transaction():
        db.execute("DELETE FROM task_queue WHERE state='running' AND task_type!='link_video'")
        db.execute("UPDATE task_queue SET state='queued' WHERE state='running'")
        for row in db.query("SELECT session_id FROM task_queue WHERE state='queued'"):
            db.update_session(row["session_id"], status="queued", error=None, ended_at=None)
            db.update_meta(row["session_id"], asr_status="queued")


def start():
    global _worker, _stopping
    with _lock:
        if _worker and _worker.is_alive():
            return
        _stopping = False
        _worker = threading.Thread(target=_run, name="task-queue", daemon=True)
        _worker.start()


def shutdown(timeout=2):
    """停止出队，保留所有未开始任务；正在运行的任务由管线保存/取消。"""
    global _stopping
    with _lock:
        _stopping = True
        changed.set()
        worker = _worker
    if worker and worker is not threading.current_thread():
        worker.join(timeout)


def _launch(row):
    sid = row["session_id"]
    payload = json.loads(row["payload"])
    if row["task_type"] == "meeting":
        import meeting
        meeting.start_meeting(sid, **payload)
    elif row["task_type"] == "capture":
        import capture
        capture.start_capture(sid, **payload)
    else:
        import link_video
        db.update_link_job(sid, job_state="preparing", phase="preparing")
        link_video.manager.launch(sid)


def _run():
    global _owner
    while True:
        with _lock:
            if _stopping:
                return
            changed.clear()
            row = _next() if _owner is None else None
            if row:
                sid = row["session_id"]
                _owner = sid
                try:
                    with db.transaction():
                        db.execute("UPDATE task_queue SET state='running' WHERE session_id=?", (sid,))
                        db.update_session(sid, status="processing")
                    _launch(row)
                except Exception as exc:
                    logging.exception("无法启动排队任务 %s", sid)
                    db.update_session(sid, status="error", error=str(exc), ended_at=time.time())
                    if row["task_type"] == "link_video":
                        db.update_link_job(sid, job_state="error", phase="error", error_code="queue_start",
                                           error_message=str(exc), finished_at=time.time())
                    # acquire 的异常清理可能已归还槽位，仍要移除这次失败的队列记录。
                    db.execute("DELETE FROM task_queue WHERE session_id=?", (sid,))
                    release(sid)
                continue
        changed.wait(1)
