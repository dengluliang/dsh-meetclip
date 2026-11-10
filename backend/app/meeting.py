"""会议纪要任务：导入音视频 → 整段离线转写（句级时间戳）→ 合并为发言段落。

与直播采集（capture.CaptureTask）共用事件流与进度快照，处理槽位由 scheduler 统一调度；不做截图、不走实时 VAD。
"""
import re
import shutil
import subprocess
import threading
import time
import unicodedata
from pathlib import Path

import numpy as np

import asr
import asr_engines
import cloud_transcription
import minutes
import scheduler
import settings
from capture import DEPS, CaptureTask, probe_streams
from hints import HINT_ASR, HINT_FFMPEG
from database import db, session_dir
from transcript_segments import SENTENCE_END, merge_paragraphs

LANGUAGES = [
    ("", "自动识别"), ("Chinese", "中文"), ("English", "英文"), ("Cantonese", "粤语"),
    ("Japanese", "日语"), ("Korean", "韩语"), ("French", "法语"), ("German", "德语"),
    ("Spanish", "西班牙语"), ("Russian", "俄语"),
]
PHASES = ("extract", "transcribe", "done")


def transcription_params(sess: dict) -> dict:
    """会议与链接视频沿用同一组持久化转写选项。"""
    meta = sess.get("meta") or {}
    return {"language": meta.get("language_hint") or "", "hotwords": meta.get("hotwords") or ""}


class _Cancelled(Exception):
    pass


def split_hotwords(text: str):
    return [w.strip() for w in re.split(r"[,，、;；\n]+", text or "") if w.strip()]


def build_context(title: str, hotwords: str) -> str:
    words = split_hotwords(hotwords)
    parts = []
    if title:
        parts.append(f"会议主题：{title}")
    if words:
        parts.append("人名、产品名与术语：" + "、".join(words))
    return "。".join(parts)


# ---------- 剔除 ASR 对 context 的复读 ----------
# 音频里几乎没有人声（静音、低声、背景噪声）时，Qwen3-ASR 会把 system prompt 里的 context 当作识别结果输出，
# 表现为转写结尾混入“会议主题：… 人名、产品名与术语：…”或一串热词。context 对正常说话的段落仍有帮助，
# 所以保留它，改为在合并成段落之前把复读的内容剔除。
_SEP = r"[\s，,、；;]*"
_PUNCT_CHAR = r"[\s，,、。.；;：:！!？?…]"


def _flex(text: str) -> str:
    """把文本转成正则：标点位置允许任意标点/空白，便于匹配 ASR 改写过标点的复读。"""
    out = []
    for ch in text:
        out.append(_SEP if re.match(_PUNCT_CHAR, ch) else re.escape(ch))
    return "".join(out)


def _echo_patterns(title: str, hotwords: str):
    words = sorted(split_hotwords(hotwords), key=len, reverse=True)
    title = (title or "").strip()
    patterns = []
    if title:
        patterns.append(rf"会议主题\s*[：:]?\s*{_flex(title)}\s*[。.]?")
    patterns.append(r"会议主题\s*[：:]")
    if words:
        alt = "(?:" + "|".join(re.escape(w) for w in words) + ")"
        patterns.append(rf"人名\s*、?\s*产品名\s*与\s*术语\s*[：:]?\s*{alt}(?:{_SEP}{alt})*\s*[。.]?")
        run = min(3, len(words))
        if run >= 2:
            patterns.append(rf"{alt}(?:{_SEP}{alt}){{{run - 1},}}\s*[。.]?")
    patterns.append(r"人名\s*、?\s*产品名\s*与\s*术语\s*[：:]?")
    return [re.compile(p, re.S) for p in patterns]


def strip_context_echo(units: list, title: str, hotwords: str):
    """剔除 units 中被 ASR 复读的 context 内容。units 为 [{text,start,end,speaker}]，按时间顺序。
    在拼接后的整段文本上匹配，因此被拆到相邻两个词/段里的复读也能删干净；删空的单元整体丢弃。"""
    if not units or not (title or hotwords):
        return units
    full = "".join(u["text"] for u in units)
    removed = [False] * len(full)
    for pattern in _echo_patterns(title, hotwords):
        for m in pattern.finditer(full):
            for i in range(m.start(), m.end()):
                removed[i] = True
    if not any(removed):
        return units
    out, pos = [], 0
    for u in units:
        text = u["text"]
        flags = removed[pos:pos + len(text)]
        pos += len(text)
        if not any(flags):
            out.append(u)
            continue
        kept = "".join(ch for ch, gone in zip(text, flags) if not gone)
        if not re.search(r"[\w\u4e00-\u9fff]", kept):
            continue
        if flags[0]:
            kept = re.sub(r"^[\s，,、。.；;：:]+", "", kept)
        out.append(dict(u, text=kept))
    return out


# ---------- 文本 → 发言段落 ----------
def _split_sentences(text: str):
    out, cur = [], ""
    for ch in text:
        cur += ch
        if ch in SENTENCE_END or ch == "\n":
            out.append(cur)
            cur = ""
    if cur.strip():
        out.append(cur)
    return [s for s in out if s.strip()]


def word_units(text: str, words: list):
    """把词级时间戳（无标点）映射回带标点的原文：每个词的展示文本 = 到下一个词之前的原文。
    映射失败时返回 None，由调用方降级为拼接词。"""
    # The aligner removes punctuation within tokens: "Pro、iPhone" becomes
    # "ProiPhone", "USB-C" becomes "USBC". Match a normalized copy and keep
    # original offsets, rather than dropping punctuation from the whole video
    # when one such token cannot be found literally.
    def kept(ch):
        return ch == "'" or unicodedata.category(ch).startswith(("L", "N"))

    offsets = [i for i, ch in enumerate(text) if kept(ch)]
    normalized = "".join(text[i] for i in offsets)
    spans, cursor = [], 0
    for w in words:
        token = "".join(ch for ch in str(w.get("text", "")) if kept(ch))
        if not token:
            continue
        pos = normalized.find(token, cursor)
        if pos < 0:
            return None
        spans.append((offsets[pos], w))
        cursor = pos + len(token)
    if not spans:
        return None
    units = []
    for i, (pos, w) in enumerate(spans):
        begin = 0 if i == 0 else pos
        stop = spans[i + 1][0] if i + 1 < len(spans) else len(text)
        units.append({"text": text[begin:stop], "start": float(w["start"]), "end": float(w["end"]),
                      "speaker": w.get("speaker")})
    return units


def joined_units(words: list):
    units = []
    for w in words:
        t = str(w.get("text", ""))
        if units and re.match(r"[A-Za-z0-9']", t) and re.search(r"[A-Za-z0-9']$", units[-1]["text"]):
            t = " " + t
        units.append({"text": t, "start": float(w["start"]), "end": float(w["end"]),
                      "speaker": w.get("speaker")})
    return units


def sentence_units(chunks: list):
    """无词级时间戳时的降级：每个 30 秒块内按句拆分，时间按字数比例分配。"""
    units = []
    for c in chunks:
        sents = _split_sentences(str(c.get("text", "")))
        total = sum(len(s) for s in sents) or 1
        start, end = float(c["start"]), float(c["end"])
        cur = start
        for s in sents:
            dur = (end - start) * len(s) / total
            units.append({"text": s, "start": cur, "end": cur + dur, "speaker": None})
            cur += dur
    return units


# ---------- 任务 ----------
class MeetingTask(CaptureTask):
    def __init__(self, sid, import_file=None, params=None):
        super().__init__(sid, import_file=import_file, transcribe_only=True)
        self.params = params or {}
        self.aligned = False

    def stop(self):
        # Meeting processing is offline and has no live media to gracefully
        # finish. Treat stop/shutdown as cancellation so the ASR worker exits
        # through the same persisted `cancelled` state as the explicit API.
        self.cancel_flag.set()
        super().stop()

    def _audio_progress(self, ev):
        if self.cancel_flag.is_set():
            raise _Cancelled()
        kind = ev.get("event")
        prog = ev.get("progress")
        if kind in ("chunks_prepared", "chunk_started", "chunk_completed") and prog is not None:
            self.asr_time = float(ev.get("processed_audio_sec") or 0)
            text = "正在转写并对齐时间戳" if self.aligned else "正在转写"
            self._set_phase("transcribe", f"{text}（{int(prog * 100)}%）", min(0.99, float(prog)))

    def _extract_audio(self, media: Path, wav: Path):
        cmd = [DEPS["ffmpeg"], "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
               "-i", str(media), "-vn", "-ac", "1", "-ar", str(asr.SAMPLE_RATE), "-f", "wav", str(wav)]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                     start_new_session=True)
        err = self.proc.stderr.read().decode(errors="ignore")
        self.proc.wait()
        if self.cancel_flag.is_set():
            raise _Cancelled()
        if self.proc.returncode != 0 or not wav.exists() or wav.stat().st_size < 1000:
            raise RuntimeError(f"音频提取失败：{err.strip()[-200:] or '文件可能已损坏'}")

    def _run(self):
        sid = self.sid
        d = session_dir(sid)
        wav = d / "meeting_audio.wav"
        self.aligned = False
        # 转写马上会被整体替换：旧纪要对应旧内容，先清掉，成功后再按新内容生成。
        minutes.engine.clear(sid)
        try:
            if not DEPS["ffmpeg"]:
                raise RuntimeError(HINT_FFMPEG)
            if not asr_engines.ready(self.engine_config):
                raise RuntimeError("所选转录引擎未就绪，请检查 设置 → 会摘 → 模型")
            p = self.params
            sess = db.get_session(sid) or {}
            self._set_phase("extract", "正在读取音视频…", None)
            if self.import_file:
                src = Path(self.import_file)
                suffix = src.suffix.lower()
                media = d / f"media{suffix}"
                self.emit("status", text="正在复制文件")
                if src.resolve() != media.resolve():
                    shutil.copy2(src, media)
                has_v, has_a, dur = probe_streams(str(media))
                if not has_a:
                    media.unlink(missing_ok=True)
                    raise RuntimeError("文件中没有音轨，无法转写" if has_v else
                                       "文件中没有可识别的音视频流，可能已损坏或格式不受支持")
                media = self._make_playable(media, has_v)
                # 链接视频复用会议的离线转写管线，但记录来源仍保持 link，方便侧栏、导出和重试分流。
                source_type = "link" if sess.get("kind") == "link_video" else ("import" if has_v else "audio")
                db.update_session(sid, media_path=media.name, duration=dur,
                                  source_type=source_type, started_at=time.time())
                self._meta(has_video=has_v, has_audio=True)
            else:
                media = d / sess["media_path"]
            # 旧转写保留到新转写成功后再整体替换，取消或失败时不丢内容
            db.update_session(sid, status="processing", error=None)
            self._meta(asr_status="running")

            self._set_phase("extract", "正在提取音频…", None)
            self._extract_audio(media, wav)

            if self.engine_config["provider"] != "local":
                self._set_phase("transcribe", "正在云端转录…", 0.0)
                if p.get("hotwords"):
                    self.warn_once("cloud-hotwords", "云端识别当前暂无已确认的热词接口；热词保留供其他引擎使用")
                cloud_transcription.transcribe_file(self, wav, self.engine_config)
                self._meta(transcription_source="asr", subtitle_language=None, subtitle_kind=None)
                db.update_session(sid, status="done", ended_at=time.time(), error=None)
                self._set_phase("done", "转录完成", 1.0)
                self.emit("done", text="处理完成")
                if minutes.auto_mode() != "off":
                    minutes.finish(sid)
                return

            self.aligned = False
            self._meta(aligned=False)

            self._set_phase("transcribe", "正在转写…", 0.0)
            self._echo_title = sess.get("title") or ""
            self._echo_hotwords = p.get("hotwords") or ""
            context = build_context(self._echo_title, self._echo_hotwords)
            audio_np = _load_wav(wav)
            self._audio_total = len(audio_np) / asr.SAMPLE_RATE
            local_provider = asr_engines.resolve(self.engine_config)
            language = p.get("language") or None
            if not language and context:
                self._set_phase("transcribe", "正在检测语种…", 0.0)
                language = local_provider.detect_language(audio_np)
            result = local_provider.transcribe_long(
                audio_np, language=language, context=context,
                return_chunks=True, on_progress=self._audio_progress)
            if self.cancel_flag.is_set():
                raise _Cancelled()
            if getattr(result, "truncated", False):
                self.warn_once("trunc", "部分音频因长度限制可能未完整转写")

            self._set_phase("transcribe", "正在整理发言段落…", None)
            rows = self._build_rows(result, audio=audio_np)
            with db.transaction():
                db.replace_transcripts(sid, rows)
                self._meta(cloud_run=None, asr_failures=[], timing_precision=None,
                           asr_status="done" if rows else "empty", speakers={},
                           diarize_error="",
                           language=language or getattr(result, "language", "") or "",
                           **({"transcription_source": "asr", "subtitle_language": None,
                               "subtitle_kind": None} if sess.get("kind") == "link_video" else {}))
                db.update_session(sid, status="done", ended_at=time.time())
            self._set_phase("done", "转写完成", 1.0)
            self.emit("done", text="处理完成")
            if minutes.auto_mode() != "off":
                minutes.finish(sid)
        except (_Cancelled, asr_engines.Cancelled):
            db.update_session(sid, status="cancelled", error="已取消", ended_at=time.time())
            self._meta(asr_status="cancelled")
            self.emit("cancelled", text="已取消，已保留已完成内容")
        except Exception as e:
            if self.cancel_flag.is_set():
                db.update_session(sid, status="cancelled", error="已取消", ended_at=time.time())
                self._meta(asr_status="cancelled")
                self.emit("cancelled", text="已取消，已保留已完成内容")
            else:
                try:
                    db.update_session(sid, status="error", error=str(e), ended_at=time.time())
                    if self.engine_config["provider"] != "local":
                        self._meta(asr_status="partial")
                    else:
                        self._meta(asr_status="skipped")
                except Exception:
                    pass
                self.emit("error", text=str(e))
        finally:
            wav.unlink(missing_ok=True)
            self.finished.set()
            scheduler.release(sid, self)

    def _build_rows(self, result, *, audio=None):
        text = (result.text or "").strip()
        words = result.segments or []
        units = None
        if words:
            units = word_units(text, words) or joined_units(words)
        elif result.chunks:
            units = sentence_units(result.chunks)
        elif text:
            units = [{"text": text, "start": 0.0, "end": self._audio_total, "speaker": None}]
        if not units:
            return []
        units = strip_context_echo(units, getattr(self, "_echo_title", ""), getattr(self, "_echo_hotwords", ""))
        if not units:
            return []
        # Proportional chunk timings cannot locate real pauses. Only confirm
        # gaps against the waveform when the result contains aligned words.
        return merge_paragraphs(units, audio=audio if words else None, sample_rate=asr.SAMPLE_RATE)


def _load_wav(path: Path) -> np.ndarray:
    import wave
    with wave.open(str(path), "rb") as w:
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def start_meeting(sid, import_file=None, params=None) -> MeetingTask:
    """占用处理槽位并启动会议转写。sid 已预留槽位（链接视频内录）时直接在其上启动。"""
    task = scheduler.acquire(sid, lambda: MeetingTask(sid, import_file=import_file, params=params))
    if not isinstance(task, MeetingTask):
        raise scheduler.BusyError(sid)
    return task
