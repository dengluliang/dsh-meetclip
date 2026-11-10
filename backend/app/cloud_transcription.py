"""Durable cloud chunks. Audio lives on disk; only one recognition chunk is held in RAM."""
import json
import os
import time
import uuid
import wave

import numpy as np

import asr_engines as engines
import speakers_cloud
import text_hygiene
from database import db, session_dir


def begin(sid, config, options=None, resume=True):
    meta = (db.get_session(sid) or {}).get("meta") or {}
    signature = {"engine": config, "language": (options or {}).get("language", "")}
    previous = meta.get("cloud_run") or {}
    if resume and previous.get("signature") == signature and previous.get("state") != "done":
        run = previous
    else:
        run = {"id": uuid.uuid4().hex, "signature": signature, "state": "running",
               "replace_existing": bool(db.get_transcripts(sid))}
    db.update_meta(sid, cloud_run=run, asr_failures=[])
    return run


def chunks(sid, run):
    return db.query("SELECT * FROM asr_chunks WHERE session_id=? AND run_id=? ORDER BY start_sample",
                    (sid, run["id"]))


def save_chunk(sid, run, start, audio):
    start_sample = round(start * engines.SAMPLE_RATE)
    end_sample = start_sample + len(audio)
    key = f"{run['id']}:{start_sample}:{end_sample}"
    existing = db.one("SELECT * FROM asr_chunks WHERE session_id=? AND chunk_id=?", (sid, key))
    if existing:
        return existing
    folder = session_dir(sid) / "asr_chunks" / run["id"]
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{start_sample}-{end_sample}.wav"
    temp = target.with_suffix(".tmp")
    temp.write_bytes(engines.encode_wav(audio))
    os.replace(temp, target)
    relative = str(target.relative_to(session_dir(sid)))
    db.execute("INSERT INTO asr_chunks(session_id,run_id,chunk_id,start_sample,end_sample,audio_path,state) "
               "VALUES(?,?,?,?,?,?,?)", (sid, run["id"], key, start_sample, end_sample, relative, "pending"))
    return db.one("SELECT * FROM asr_chunks WHERE session_id=? AND chunk_id=?", (sid, key))


def preview(sid, row, text, state, emit):
    # 预览和定稿用同一套清洗：空白片段的 `<chinese>` 标记不该滚到界面上。
    text = text_hygiene.clean(text or "")
    # Detail snapshots must not observe newer text with an older event cursor.
    with db.transaction():
        db.execute("UPDATE asr_chunks SET preview=?,state=? WHERE session_id=? AND chunk_id=?",
                   (text, state, sid, row["chunk_id"]))
        emit("transcript_partial", chunk_id=row["chunk_id"], start=row["start_sample"] / engines.SAMPLE_RATE,
             end=row["end_sample"] / engines.SAMPLE_RATE, text=text, state=state)


def recognize(sid, run, row, provider, cancel, emit, language=""):
    engines.check_cancel(cancel)
    if row["state"] == "done":
        return row["text"]
    path = session_dir(sid) / row["audio_path"]
    with wave.open(str(path), "rb") as wav:
        audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768
    last = [None]
    def partial(text):
        last[0] = text
        preview(sid, row, text, "streaming", emit)
    try:
        result = provider.recognize(audio, language=language, cancel=cancel, on_partial=partial)
        engines.check_cancel(cancel)
        start, end = row["start_sample"] / engines.SAMPLE_RATE, row["end_sample"] / engines.SAMPLE_RATE
        # 定稿若比流式草稿少了明显的词，用草稿：快语速下云端定稿会整句丢词，草稿只是偶尔拼错。
        text = text_hygiene.fuller(result.text or "", last[0] or "")
        with db.transaction():
            current = db.one("SELECT state, text FROM asr_chunks WHERE session_id=? AND chunk_id=?", (sid, row["chunk_id"]))
            if current["state"] == "done":
                return current["text"] or text
            db.execute("UPDATE asr_chunks SET state='done',text=?,preview='',error='',metrics=?,output_data=? "
                       "WHERE session_id=? AND chunk_id=?",
                       (text, json.dumps(result.metrics), json.dumps({"words": result.words, "speaker_segments": result.speaker_segments}), sid, row["chunk_id"]))
            if not run["replace_existing"] and text:
                db.add_transcript(sid, start, end, text)
            emit("transcript_chunk_done", chunk_id=row["chunk_id"], start=start, end=end, text=text,
                 staged=run["replace_existing"])
        return text
    except Exception as exc:
        state = "cancelled" if isinstance(exc, engines.Cancelled) else "error"
        # Preserve interrupted preview across reconnects and application restarts.
        text = last[0] if last[0] is not None else row.get("preview", "")
        preview(sid, row, text, state, emit)
        db.execute("UPDATE asr_chunks SET error=? WHERE session_id=? AND chunk_id=?",
                   ("已取消" if state == "cancelled" else str(exc), sid, row["chunk_id"]))
        raise


def failures(sid, run):
    return [{"chunk_id": r["chunk_id"], "start": r["start_sample"] / engines.SAMPLE_RATE,
             "end": r["end_sample"] / engines.SAMPLE_RATE, "error": r["error"] or "尚未完成"}
            for r in chunks(sid, run) if r["state"] != "done"]


def finish(sid, run, emit, rows=None, metadata=None):
    missing = failures(sid, run)
    if missing:
        db.update_meta(sid, asr_status="partial", asr_failures=missing)
        raise engines.ProviderError(f"有 {len(missing)} 个音频片段未完成转录，已保留媒体和已完成内容，可补转录")
    if rows is None:
        rows = [(r["start_sample"] / engines.SAMPLE_RATE, r["end_sample"] / engines.SAMPLE_RATE, r["text"], None)
                for r in chunks(sid, run) if r["text"]]
    with db.transaction():
        db.replace_transcripts(sid, rows)
        db.update_meta(sid, cloud_run=dict(run, state="done"), asr_failures=[], asr_status="done" if rows else "empty",
                       transcription_source="asr", **(metadata or {"aligned": False, "timing_precision": "chunk", "speakers": {}, "diarize_error": ""}))
        emit("transcript_reset")
    return rows


def pending_previews(sid):
    meta = (db.get_session(sid) or {}).get("meta") or {}
    run = meta.get("cloud_run")
    if not run or run["state"] == "done":
        return []
    return [{"chunk_id": r["chunk_id"], "start": r["start_sample"] / engines.SAMPLE_RATE,
             "end": r["end_sample"] / engines.SAMPLE_RATE,
             "text": r["text"] if r["state"] == "done" else r["preview"], "state": r["state"]}
            for r in chunks(sid, run) if r["state"] != "done" or run["replace_existing"]]


def _pause(seconds, cancel):
    deadline = time.monotonic() + max(0.0, float(seconds))
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        if cancel is not None and hasattr(cancel, "wait"):
            if cancel.wait(min(remaining, 0.5)):
                raise engines.Cancelled()
        else:
            time.sleep(min(remaining, 0.5))


def file_chunks(path, start_sample=0):
    # Same pause-aware 4–15 second policy as the live capture pipeline.
    from capture import CaptureTask
    with wave.open(str(path), "rb") as wav:
        wav.setpos(min(start_sample, wav.getnframes()))
        offset, frames, levels = start_sample, [], []
        frame_size = engines.SAMPLE_RATE // 10
        while True:
            raw = wav.readframes(frame_size)
            if not raw:
                break
            frame = np.frombuffer(raw, dtype="<i2")
            frames.append(frame)
            levels.append(float(np.sqrt(np.mean(frame.astype(np.float32) ** 2))))
            cut = CaptureTask._find_cut(levels)
            if cut:
                audio = np.concatenate(frames[:cut])
                yield offset / engines.SAMPLE_RATE, audio.astype(np.float32) / 32768
                offset += len(audio)
                frames, levels = frames[cut:], levels[cut:]
        if frames:
            yield offset / engines.SAMPLE_RATE, np.concatenate(frames).astype(np.float32) / 32768


def transcribe_file(task, wav, config):
    provider = engines.require_ready(config)
    task.aligned = False
    options = task.params
    run = begin(task.sid, config, options, resume=options.get("resume", True))
    task._cloud_run = run
    with wave.open(str(wav), "rb") as source:
        task._audio_total = source.getnframes() / engines.SAMPLE_RATE
    existing = chunks(task.sid, run)
    tail = max((r["end_sample"] for r in existing), default=0)
    def process(row):
        engines.check_cancel(task.cancel_flag)
        if row["state"] == "done":
            return
        try:
            recognize(task.sid, run, row, provider, task.cancel_flag, task.emit, options.get("language", ""))
        except engines.Cancelled:
            raise
        except engines.ProviderError as exc:
            task.warn_once("cloud", str(exc))
            if exc.fatal:
                raise
        task.asr_time = row["end_sample"] / engines.SAMPLE_RATE
        task._audio_progress({"event": "chunk_completed", "progress": task.asr_time / max(task._audio_total, .1),
                              "processed_audio_sec": task.asr_time})
    for row in existing:
        process(row)
    for start, audio in file_chunks(wav, tail):
        engines.check_cancel(task.cancel_flag)
        row = save_chunk(task.sid, run, start, audio)
        if np.max(np.abs(audio), initial=0) * 32768 < 300:
            db.execute("UPDATE asr_chunks SET state='done',text='' WHERE session_id=? AND chunk_id=?",
                       (task.sid, row["chunk_id"]))
        else:
            process(row)
    missing = failures(task.sid, run)
    # Transient gateway throttling should heal inside the same run instead of forcing
    # the user to click "补转录" and hope the quota window has moved. Two cooldown
    # passes cover a per-minute window; the request gate reduces the chance of a 429.
    for cooldown in (20, 45):
        if not missing:
            break
        engines.check_cancel(task.cancel_flag)
        task.warn_once("cloud-rate", "云端限流，正在冷却后自动补转录…")
        task._set_phase("transcribe", f"云端限流，{cooldown} 秒后补转录剩余 {len(missing)} 段…", None)
        _pause(cooldown, task.cancel_flag)
        for row in [r for r in chunks(task.sid, run) if r["state"] != "done"]:
            engines.check_cancel(task.cancel_flag)
            process(row)
        missing = failures(task.sid, run)
    if missing:
        db.update_meta(task.sid, asr_failures=missing, asr_status="partial")
        raise engines.ProviderError(f"有 {len(missing)} 个音频片段未完成转录，可补转录")
    rows = [(r["start_sample"] / engines.SAMPLE_RATE, r["end_sample"] / engines.SAMPLE_RATE, r["text"], None)
            for r in chunks(task.sid, run) if r["text"]]
    rows, speakers = speakers_cloud.maybe_label(rows, wav, options)
    engines.check_cancel(task.cancel_flag)
    finish(task.sid, run, task.emit, rows,
           {"aligned": False, "timing_precision": "chunk", "speakers": speakers, "diarize_error": ""})
    return rows


def recover_interrupted():
    """Interrupted network previews survive startup but cannot appear as actively streaming."""
    db.execute("UPDATE asr_chunks SET state='error',error='上次转录中断，可补转录' WHERE state='streaming'")
