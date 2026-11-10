"""采集引擎：B站直播下载、本地导入、截图检测、ASR 转写管线。

设计原则（来自 PRD）：保存优先 > 实时完美。任何异常先落盘已采集内容。
"""
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import threading
import time
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

import asr
import asr_engines
import cloud_transcription
import bilibili
import minutes
import scheduler
import settings
import text_hygiene
from database import db, session_dir
from hints import HINT_FFMPEG, HINT_YTDLP
from meeting_end import MeetingEndWatch

# ---------- 外部依赖检测 ----------
def _which(name):
    return shutil.which(name)


def _vendored(name):
    """项目内 bin/ 目录的独立二进制，优先于系统 PATH"""
    base = os.environ.get("ZHIBO_BIN_DIR") or (Path(__file__).resolve().parent.parent / "bin")
    p = Path(base) / name
    return str(p) if p.exists() else None


def _resolve(name):
    return _vendored(name) or _which(name)


# 内置 ffmpeg（OpenSSL 构建）不会自动读取 macOS 根证书
if not os.environ.get("SSL_CERT_FILE") and os.path.exists("/etc/ssl/cert.pem"):
    os.environ["SSL_CERT_FILE"] = "/etc/ssl/cert.pem"

DEPS = {
    "yt_dlp": _resolve("yt-dlp"),
    "ffmpeg": _resolve("ffmpeg"),
    "ffprobe": _resolve("ffprobe"),
}

def refresh_deps():
    """安装采集组件后重新探测路径（Homebrew 默认目录作为兜底）。"""
    for key, name in (("yt_dlp", "yt-dlp"), ("ffmpeg", "ffmpeg"), ("ffprobe", "ffprobe")):
        found = _resolve(name)
        if not found:
            for prefix in ("/opt/homebrew/bin", "/usr/local/bin"):
                if Path(prefix, name).exists():
                    found = str(Path(prefix, name))
                    break
        DEPS[key] = found


def deps_status():
    return {
        "yt_dlp": bool(DEPS["yt_dlp"]),
        "ffmpeg": bool(DEPS["ffmpeg"]),
        "asr": asr_engines.ready(),
        "asr_runtime": asr.runtime_status()[0],
        "ready": bool(DEPS["yt_dlp"] and DEPS["ffmpeg"]),
    }


# ---------- B站直播预检 (F-01) ----------
BILI_RE = re.compile(r"live\.bilibili\.com/(?:blanc/|h5/)?(\d+)")


def _resolve_short(url: str) -> str:
    """b23.tv 分享短链 → 跟随跳转得到真实直播间地址"""
    m = re.search(r"https?://(?:www\.)?b23\.tv/[A-Za-z0-9]+", url)
    if not m:
        return url
    try:
        req = urllib.request.Request(m.group(0), headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.geturl()
    except Exception:
        return url


def parse_bilibili_room(url: str):
    url = (url or "").strip()
    url = _resolve_short(url)
    m = BILI_RE.search(url)
    if m:
        return int(m.group(1))
    # 纯数字房间号
    if url.strip().isdigit():
        return int(url.strip())
    return None


def _live_started_at(value):
    """B站的 live_time 是北京时间，不能用执行环境的时区解释。"""
    if not value or value == "0000-00-00 00:00:00":
        return None
    try:
        started = datetime.strptime(str(value), "%Y-%m-%d %H:%M:%S")
        return started.replace(tzinfo=ZoneInfo("Asia/Shanghai")).timestamp()
    except (ValueError, TypeError):
        return None


def check_bilibili_live(url: str):
    """直播状态与原始房间元数据，供发布会和视频预览共用。"""
    room_id = parse_bilibili_room(url)
    if not room_id:
        return {"ok": False, "status": "invalid", "message": "无法解析的链接，请输入 B站直播链接（live.bilibili.com/房间号）"}
    try:
        api = f"https://api.live.bilibili.com/room/v1/Room/get_info?room_id={room_id}"
        req = urllib.request.Request(api, headers={"User-Agent": "Mozilla/5.0", "Referer": bilibili.REFERER})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        if data.get("code") != 0:
            return {"ok": False, "status": "invalid", "room_id": room_id, "message": f"房间查询失败：{data.get('message')}"}
        info = data["data"]
        live_status = info.get("live_status")  # 0 未开播 1 直播中 2 轮播
        title = (info.get("title") or f"直播间 {room_id}").strip()
        thumbnail = info.get("user_cover") or info.get("keyframe") or ""
        if thumbnail.startswith("//"):
            thumbnail = "https:" + thumbnail
        # 直播封面有时返回 http 地址，原生 App 的网络策略要求 HTTPS。
        if thumbnail.startswith("http://"):
            thumbnail = "https://" + thumbnail[len("http://"):]
        started_at = _live_started_at(info.get("live_time")) if live_status in (1, 2) else None
        metadata = {"room_id": info.get("room_id") or room_id, "title": title, "thumbnail": thumbnail,
                    "started_at": started_at, "category": info.get("area_name") or ""}
        if live_status == 1:
            return {"ok": True, "status": "live", **metadata,
                    "message": "直播进行中，可以开始采集"}
        if live_status == 2:
            return {"ok": False, "status": "replay", **metadata,
                    "message": "当前为轮播/回放，非直播。可等待开播或导入本地视频"}
        start_time = info.get("live_time") or ""
        return {"ok": False, "status": "not_started", **metadata,
                "message": f"尚未开播（{start_time}）。可稍后再试"}
    except Exception as e:
        return {"ok": False, "status": "unreachable", "room_id": room_id,
                "message": f"暂时无法连接 B站接口：{e}"}


def preview_bilibili_live(url: str):
    """完整的直播卡片预读；附加信息失败不会阻止有效直播入队。"""
    result = check_bilibili_live(url)
    room_id = result.get("room_id")
    if not room_id or result.get("status") not in ("live", "replay", "not_started"):
        return result
    try:
        endpoint = f"https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid={room_id}"
        request = urllib.request.Request(endpoint, headers={"User-Agent": "Mozilla/5.0", "Referer": bilibili.REFERER})
        with urllib.request.urlopen(request, timeout=3) as response:
            payload = json.loads(response.read().decode())
        if payload.get("code") == 0:
            info = (payload.get("data") or {}).get("info") or {}
            result["uploader"] = (info.get("uname") or "").strip()
    except Exception:
        pass
    return result


# ---------- 采集任务 ----------
FRAME_W, FRAME_H = 1280, 720   # 检测画布（横屏 16:9；竖屏/方屏内容按比例缩放后居中）
FRAME_FPS = 2.0
SR = asr.SAMPLE_RATE
MAX_SHOTS = 5000          # 约 90KB/张 → 上限约 450MB；按平均 1.5 秒一张可覆盖 2 小时以上
SHOT_WARN_AT = 4500
PREVIEW_EVERY = 1.0       # 实时检测缩略图刷新间隔（秒）
SILENCE_RMS = 300
SILENCE_WARN_SEC = 60
PLAYABLE = {".mp4", ".mov", ".m4v", ".mp3", ".m4a", ".wav", ".aac"}
AUDIO_EXT = {".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".opus"}


def sensitivity_threshold(s: float) -> float:
    """灵敏度 0..1 → 画面变化阈值（指数映射，越灵敏阈值越低）"""
    s = min(1.0, max(0.0, float(s)))
    return 30.0 * (1.0 / 30.0) ** s


def _gray_small(rgb: np.ndarray) -> np.ndarray:
    g = rgb.astype(np.float32).mean(axis=2)
    return g.reshape(36, FRAME_H // 36, 64, FRAME_W // 64).mean(axis=(1, 3))


def change_score(a: np.ndarray, b: np.ndarray) -> float:
    d = np.abs(a - b)
    blocks = d.reshape(9, 4, 16, 4).mean(axis=(1, 3))
    return float(0.5 * d.mean() + 0.5 * np.percentile(blocks, 90))


def probe_streams(path: str):
    r = subprocess.run([DEPS["ffmpeg"], "-hide_banner", "-i", path],
                       capture_output=True, text=True, timeout=30)
    err = r.stderr
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0
    has_v = bool(re.search(r"Stream #\S+.*: Video:", err)) and "attached pic" not in err
    has_a = bool(re.search(r"Stream #\S+.*: Audio:", err))
    return has_v, has_a, dur


class CaptureTask:
    """一次采集/导入/重新转写任务。

    单个 ffmpeg 进程同时完成：原始媒体落盘、低帧率画面流（变化检测截图）、16k 音频流（实时转写）。
    所有时间均为来源相对时间（媒体时间轴），转写/截图/标记共用。
    """

    def __init__(self, sid, url=None, import_file=None, transcribe_only=False):
        self.sid = sid
        self.url = url
        self.import_file = import_file
        self.transcribe_only = transcribe_only
        self.proc = None
        self.stop_flag = threading.Event()   # 停止采集（保存已有内容，后处理继续）
        self.cancel_flag = threading.Event() # 彻底取消（保留已有内容，不再继续处理）
        self.finished = threading.Event()
        self.events = queue.Queue(maxsize=256)
        self._event_lock = threading.RLock()
        self._event_stream_id = uuid.uuid4().hex
        self._event_seq = 0
        self._event_log = []
        self._event_warnings = []
        self._event_status = ""
        self.thread = None
        self.capturing = not transcribe_only
        self.media_time = 0.0
        self.audio_time = 0.0
        self.asr_time = 0.0
        self.motion = 0.0
        self.shot_count = 0
        self._warned = set()
        self._asr_q = queue.Queue()
        self._ref = None
        self._prev = None
        self._cand_since = None
        self._last_shot_t = -1e9
        self._last_motion_emit = 0.0
        self._last_preview = 0.0
        self._last_progress_emit = 0.0
        self._silent_sec = 0.0
        self.phase = ""
        self.phase_text = ""
        self.phase_progress = None
        self._asr_total = 0.0
        self._src_size = None
        self._frame_idx = -1
        self._full_frames = {}
        self._full_lock = threading.Lock()
        self._full_cv = threading.Condition()
        self._staged = None
        self.engine_config = asr_engines.session_config(db.get_session(sid) or {})
        self._cloud_run = None
        self._asr_error = None
        self._cloud_abort = threading.Event()
        # 没人说话的兜底收尾：按"识别出词"计时，不按声音（背景音乐不续命）。
        self._eos_watch = None
        self._eos_thread = None
        self._said_any = False
        self._speech_at = 0.0          # 最近一次识别出词的媒体时间
        self.end_trim = None           # 自动结束时按这个秒数裁掉尾部空白

    # ----- 事件 -----
    def emit(self, kind, **payload):
        payload["kind"] = kind
        payload["time"] = time.time()
        with self._event_lock:
            self._event_seq += 1
            payload["event_id"] = self._event_seq
            payload["event_stream_id"] = self._event_stream_id
            if kind == "warn" and payload.get("text") and payload["text"] not in self._event_warnings:
                self._event_warnings.append(payload["text"])
            if kind == "status":
                self._event_status = payload.get("text", "")
            elif kind in ("done", "error", "cancelled"):
                self._event_status = ""
            self._event_log.append(payload.copy())
            if len(self._event_log) > 2048:
                del self._event_log[:-2048]
        try:
            self.events.put_nowait(payload)
        except queue.Full:
            try:
                self.events.get_nowait()
                self.events.put_nowait(payload)
            except queue.Empty:
                pass

    def events_since(self, event_id=0):
        with self._event_lock:
            return [e.copy() for e in self._event_log if e.get("event_id", 0) > event_id]

    def event_cursor(self):
        with self._event_lock:
            return {"event_stream_id": self._event_stream_id, "event_id": self._event_seq,
                    "event_warnings": self._event_warnings.copy(), "event_status": self._event_status}

    def warn_once(self, key, text):
        if key not in self._warned:
            self._warned.add(key)
            self.emit("warn", text=text)

    def snapshot(self):
        return {
            "recording": self.capturing,
            "processing": not self.capturing,
            "live_media_time": self.media_time,
            "asr_time": self.asr_time,
            "audio_time": self.audio_time,
            "motion": self.motion,
            "motion_threshold": sensitivity_threshold(settings.get("shot_sensitivity")),
            "shot_count": self.shot_count,
            "phase": self.phase,
            "phase_text": self.phase_text,
            "phase_progress": self.phase_progress,
            "max_shots": MAX_SHOTS,
        }

    # ----- 生命周期 -----
    def start(self):
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def stop(self):
        if not self.stop_flag.is_set() and self.capturing:
            self._set_phase("stopping", "正在结束直播流…")
        self.stop_flag.set()
        self._terminate()

    def _set_phase(self, phase, text, progress=None):
        """停止后的收尾阶段：stopping → remux → transcribe → done，供前端展示等待进度"""
        self.phase = phase
        self.phase_text = text
        self.phase_progress = progress
        self.emit("phase", phase=phase, text=text, progress=progress)

    def cancel(self):
        self.cancel_flag.set()
        self.stop()

    def _terminate(self):
        p = self.proc
        if not p or p.poll() is not None:
            return
        try:
            # 先发 SIGINT：ffmpeg 会写完当前分片并正常收尾；网络读阻塞时 1.5 秒后强制结束
            try:
                os.killpg(p.pid, signal.SIGINT)
            except OSError:
                p.send_signal(signal.SIGINT)
        except Exception:
            return

        def _force():
            try:
                p.wait(timeout=1.5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except OSError:
                    p.kill()
            except Exception:
                pass
        threading.Thread(target=_force, daemon=True).start()

    def _meta(self, **kw):
        db.update_meta(self.sid, **kw)

    # ----- 没人说话时自动收尾 -----
    def _mark_speech(self, media_seconds: float):
        """识别出了词：静音倒计时归零，并记下最后说话的位置（结束时用来裁尾部空白）。"""
        self._said_any = True
        self._speech_at = max(self._speech_at, float(media_seconds or 0.0))
        if self._eos_watch is not None:
            self._eos_watch.heard(time.time())

    def start_end_watch(self):
        """只有直播采集需要：直播流可能一直开着，但没人说话。"""
        mode = settings.get("auto_end_silence") or "prompt"
        if not self.capturing or mode == "off" or self.transcribe_only or self.import_file:
            return
        try:
            after = float(settings.get("auto_end_after") or 600)
        except (TypeError, ValueError):
            after = 600.0
        self._eos_watch = MeetingEndWatch(mode=mode, silence_after=after, start=time.time())
        self._eos_thread = threading.Thread(target=self._eos_loop, name=f"eos-{self.sid}", daemon=True)
        self._eos_thread.start()

    def _eos_loop(self):
        while not self.stop_flag.is_set() and not self.cancel_flag.is_set():
            if not self.capturing:
                return
            if self.stop_flag.wait(5.0):
                return
            reason = self._eos_watch.tick(time.time(), said=self._said_any)
            if reason == "prompt":
                deadline = self._eos_watch.deadline() or 0
                left = max(0, int(deadline - time.time()))
                self.emit("end_prompt",
                          text=f"已经有一段时间没听到说话，{left} 秒后自动结束采集（可以继续记录）",
                          seconds_to_end=left)
            elif reason in ("end", "nobody_spoke"):
                self.end_trim = self._speech_at or None
                label = "一直没有人说话" if reason == "nobody_spoke" else "已有一段时间没人说话"
                self._set_phase("stopping", f"{label}，正在结束采集…")
                self.emit("status", text=f"{label}，自动结束采集")
                self.stop()
                return

    def keep_going(self):
        """用户在界面上点"继续记录"：忘掉这次询问，重新开始计静音。"""
        if self._eos_watch is not None:
            self._eos_watch.keep_going(time.time())
            self.emit("status", text="已继续记录")

    def _trimmed_duration(self) -> float:
        if self.end_trim and self.media_time and self.end_trim < self.media_time - 5:
            return min(self.media_time, self.end_trim + 2)
        return self.media_time

    def _run(self):
        sid = self.sid
        d = session_dir(sid)
        asr_thread = threading.Thread(target=self._asr_worker, daemon=True)
        try:
            if not DEPS["ffmpeg"]:
                raise RuntimeError(HINT_FFMPEG)
            if self.transcribe_only:
                sess = db.get_session(sid)
                src = str(d / sess["media_path"])
                # 重新转写先写入暂存列表，成功后整体替换；取消或失败时旧转写保持不变
                self._staged = []
                # 旧纪要对应的是旧转写：先清掉，成功后再按新内容生成。
                minutes.engine.clear(sid)
                db.update_session(sid, status="processing", error=None)
                self._meta(asr_status="running")
                asr_thread.start()
                self._pipeline(src, out_path=None, has_v=False, has_a=True, realtime=False)
            elif self.import_file:
                src = Path(self.import_file)
                suffix = src.suffix.lower()
                media = d / f"media{suffix}"
                if src.parent.resolve() == d.resolve():
                    src.rename(media)
                else:
                    self.emit("status", text="正在复制文件")
                    shutil.copy2(src, media)
                has_v, has_a, dur = probe_streams(str(media))
                if not has_v and not has_a:
                    raise RuntimeError("文件中没有可识别的音视频流，可能已损坏或格式不受支持")
                media = self._make_playable(media, has_v)
                db.update_session(sid, status="recording", started_at=time.time(),
                                  media_path=media.name, duration=dur,
                                  source_type="import" if has_v else "audio")
                self._meta(has_video=has_v, has_audio=has_a, asr_status="running" if has_a else "none")
                self.emit("status", text="文件已导入，开始处理")
                asr_thread.start()
                self._pipeline(str(media), out_path=None, has_v=has_v, has_a=has_a, realtime=False)
            else:
                if not DEPS["yt_dlp"]:
                    raise RuntimeError(HINT_YTDLP)
                db.update_session(sid, status="recording", started_at=time.time(), error=None)
                self._meta(has_video=True, has_audio=True, asr_status="running")
                self.emit("status", text="解析直播流地址")
                stream_url, quality = self._resolve_stream()
                self._quality_label = quality
                self._meta(stream_quality=quality)
                self.emit("status", text=f"开始采集直播流 · {quality}")
                asr_thread.start()
                # 直播流可能一直开着却没人说话：起一个兜底的收尾看门狗。
                self.start_end_watch()
                self._pipeline(stream_url, out_path=d / "media.ts", has_v=True, has_a=True,
                               realtime=True, hls_dir=d / "live")
                ts = d / "media.ts"
                if ts.exists() and ts.stat().st_size > 0:
                    db.update_session(sid, media_path="media.ts", duration=self._trimmed_duration())
                    mp4 = self._remux(ts)
                    if mp4:
                        db.update_session(sid, media_path=mp4.name, duration=self._trimmed_duration())
                        shutil.rmtree(d / "live", ignore_errors=True)
                    (d / "preview.jpg").unlink(missing_ok=True)
                else:
                    raise RuntimeError("未采集到任何媒体数据（直播流中断或无法访问）")

            # 采集阶段结束：进入后处理（转写追赶）
            self.capturing = False
            if not self.transcribe_only:
                db.update_session(sid, status="processing",
                                  duration=max(self.media_time, self.audio_time,
                                               (db.get_session(sid) or {}).get("duration") or 0))
            self.emit("status", text="采集已保存，正在完成转写")
            self._asr_q.put(None)
            if not self.transcribe_only:
                self._asr_total = max(self.audio_time, self.asr_time, 0.1)
                while asr_thread.is_alive():
                    lag = max(0.0, self._asr_total - self.asr_time)
                    frac = min(0.99, self.asr_time / self._asr_total) if self._asr_total else 0.99
                    text = "正在完成剩余转写…" if lag > 1 else "正在整理转写…"
                    if lag > 1:
                        text += f"（还剩约 {int(lag)} 秒音频）"
                    self._set_phase("transcribe", text, frac)
                    asr_thread.join(timeout=0.5)
            if asr_thread.is_alive():
                asr_thread.join()
            if self.cancel_flag.is_set():
                db.update_session(sid, status="cancelled", error="已取消", ended_at=time.time())
                self.emit("cancelled", text="已取消，已保留已有内容")
                return
            if self._asr_error:
                raise self._asr_error
            if self._staged is not None and self.engine_config["provider"] == "local":
                db.replace_transcripts(sid, [(a, b, t, None) for a, b, t in self._staged])
            if self.cancel_flag.is_set():
                db.update_session(sid, status="cancelled", ended_at=time.time())
                return
            if self.engine_config["provider"] == "local":
                self._meta(cloud_run=None, asr_failures=[], timing_precision=None)
            fields = {"status": "done", "ended_at": time.time()}
            db.update_session(sid, **fields)
            if not self.transcribe_only and self.url:
                self._set_phase("done", "已保存", 1.0)
            self.emit("done", text="处理完成")
            # 转写落库后再生成纪要：一次终稿，不抢转写的时间。
            if minutes.auto_mode() != "off":
                minutes.finish(sid)
        except Exception as e:
            self.capturing = False
            if self.engine_config["provider"] != "local" and asr_thread.is_alive():
                self._cloud_abort.set()
            self._asr_q.put(None)
            if asr_thread.is_alive():
                asr_thread.join(timeout=35 if self.engine_config["provider"] != "local" else 5)
            if self.cancel_flag.is_set():
                db.update_session(sid, status="cancelled", error="已取消", ended_at=time.time())
                self.emit("cancelled", text="已取消，已保留已有内容")
            else:
                try:
                    sess = db.get_session(sid) or {}
                    saved = f"已保存到 {self.media_time:.0f} 秒" if self.media_time else "未保存到媒体"
                    db.update_session(sid, status="error", error=f"{e}（{saved}）",
                                      ended_at=time.time(),
                                      duration=max(self.media_time, sess.get("duration") or 0))
                except Exception:
                    pass
                self.emit("error", text=str(e))
        finally:
            self.capturing = False
            try:
                (session_dir(sid) / "preview.jpg").unlink(missing_ok=True)
            except Exception:
                pass
            self.finished.set()
            _unregister(self)

    def _resolve_stream(self):
        """优先：Chrome 登录态 + B站原画 FLV/AVC；失败回退 yt-dlp（匿名最高 720P）。"""
        warn = ""
        room = parse_bilibili_room(self.url)
        if room:
            try:
                st = bilibili.ensure_login(DEPS["yt_dlp"])
                if not st["logged_in"]:
                    warn = "未登录 B站，画质最高 720P。可在 设置 → B站登录 扫码登录以获取 1080P 原画"
                info = bilibili.get_stream(room)
                if info:
                    self.headers = {"cookie": bilibili.cookie_header()}
                    q = info["quality"]
                    if info["qn"] < 10000:
                        warn = warn or f"当前账号/直播间未提供原画，已使用 {q}"
                        q += "（降级）"
                    if warn:
                        self.warn_once("quality", warn)
                    return info["url"], q
            except Exception as e:
                warn = f"获取原画流失败（{e}），改用兼容方式"
        r = subprocess.run([DEPS["yt_dlp"], "-g", self.url],
                           capture_output=True, text=True, timeout=30)
        url = r.stdout.strip().split("\n")[0] if r.stdout.strip() else None
        if not url:
            raise RuntimeError(f"无法解析直播流地址：{(r.stderr or '')[:200]}")
        self.warn_once("quality", warn or "使用兼容方式取流，画质可能低于 1080P")
        return url, "兼容模式（降级）"

    # ----- 媒体处理 -----
    def _make_playable(self, media: Path, has_v: bool) -> Path:
        if media.suffix.lower() in PLAYABLE:
            return media
        out = media.with_name("media.mp4" if has_v else "media.m4a")
        cmd = [DEPS["ffmpeg"], "-y", "-loglevel", "error", "-i", str(media)]
        cmd += ["-c", "copy"] if has_v else ["-vn", "-c:a", "aac", "-b:a", "160k"]
        cmd += ["-movflags", "+faststart", str(out)]
        r = subprocess.run(cmd, capture_output=True, timeout=1800)
        if r.returncode == 0 and out.exists() and out.stat().st_size > 0:
            media.unlink(missing_ok=True)
            return out
        out.unlink(missing_ok=True)
        self.warn_once("noplay", "该格式无法转为可回放文件，回看播放可能不可用；转写与截图不受影响")
        return media

    def _remux(self, ts: Path):
        """直播 MPEG-TS → MP4（AVPlayer 可回放）。失败时保留 TS，不丢原始数据。

        自动结束时按"最后一个人说话"的位置裁掉尾部空白：`-c copy` + `-t`，不重新编码。
        """
        out = ts.with_name("media.mp4")
        total = max(self.media_time, self.audio_time, 1.0)
        self._set_phase("remux", "正在生成回放文件…", 0.0)
        cmd = [DEPS["ffmpeg"], "-y", "-loglevel", "error", "-nostats",
               "-progress", "pipe:1", "-i", str(ts)]
        trim = self._trimmed_duration()
        trimmed = trim < self.media_time - 5
        if trimmed:
            cmd += ["-t", f"{trim:.1f}"]
        cmd += ["-c", "copy", "-movflags", "+faststart", str(out)]
        if trimmed:
            self.warn_once("trim", f"已按最后一次说话的位置裁掉末尾 {int(self.media_time - trim)} 秒空白")
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        last = 0.0
        for line in p.stdout:
            if line.startswith("out_time_us="):
                try:
                    sec = int(line.split("=", 1)[1]) / 1e6
                except ValueError:
                    continue
                frac = min(0.99, max(0.0, sec / total))
                if frac - last >= 0.02:
                    last = frac
                    self._set_phase("remux", "正在生成回放文件…", frac)
        try:
            p.wait(timeout=3600)
        except subprocess.TimeoutExpired:
            p.kill()
        r = p
        if r.returncode == 0 and out.exists() and out.stat().st_size > 0:
            ts.unlink(missing_ok=True)
            return out
        out.unlink(missing_ok=True)
        self.warn_once("remux", "直播文件转换为 MP4 失败，原始 TS 已保留")
        return None

    def _pipeline(self, src, out_path, has_v, has_a, realtime, hls_dir=None):
        cmd = [DEPS["ffmpeg"], "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
        if realtime:
            hdr = "Referer: https://live.bilibili.com/\r\n"
            ck = (getattr(self, "headers", None) or {}).get("cookie")
            if ck:
                hdr += f"Cookie: {ck}\r\n"
            cmd += ["-user_agent", bilibili.UA, "-headers", hdr,
                    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10"]
        cmd += ["-fflags", "+genpts", "-i", src]
        if out_path:
            cmd += ["-map", "0:v?", "-map", "0:a?", "-c", "copy",
                    "-avoid_negative_ts", "make_zero", "-f", "mpegts", str(out_path)]
        if hls_dir:
            shutil.rmtree(hls_dir, ignore_errors=True)
            hls_dir.mkdir(parents=True, exist_ok=True)
            cmd += ["-map", "0:v?", "-map", "0:a?", "-c", "copy",
                    "-avoid_negative_ts", "make_zero",
                    "-f", "hls", "-hls_time", "2", "-hls_list_size", "0",
                    "-hls_playlist_type", "event", "-hls_flags", "independent_segments+temp_file",
                    "-hls_segment_filename", str(hls_dir / "seg_%05d.ts"),
                    str(hls_dir / "index.m3u8")]
        full_r = full_w = None
        if has_v:
            self._content_box = self._probe_content_box(src, realtime)
            if realtime and self._src_size:
                w, h = self._src_size
                q = (getattr(self, "_quality_label", "") or "").replace("（降级）", "")
                label = f"{q} · {w}×{h}" if q else f"{w}×{h}"
                if max(w, h) < 1920:
                    label += "（降级）"
                    self.warn_once("res", f"直播源实际分辨率为 {w}×{h}，低于 1080P（主播推流或平台限制）")
                self._meta(stream_quality=label)
            # 检测用画布固定 1280x720（只用于判断画面变化）；竖屏流会被左右补边，截图时裁掉
            vf = (f"fps={FRAME_FPS},scale={FRAME_W}:{FRAME_H}:force_original_aspect_ratio=decrease,"
                  f"pad={FRAME_W}:{FRAME_H}:(ow-iw)/2:(oh-ih)/2,format=rgb24")
            cmd += ["-map", "0:v:0", "-vf", vf, "-f", "rawvideo", "pipe:1"]
            # 原分辨率截图帧：同一时间点、同样 2fps，编码为 MJPEG 流（1080P 约 150KB/帧）
            if self._src_size:
                full_r, full_w = os.pipe()
                cmd += ["-map", "0:v:0", "-vf", f"fps={FRAME_FPS},format=yuvj420p",
                        "-c:v", "mjpeg", "-q:v", "2", "-f", "mjpeg", f"pipe:{full_w}"]
        r_fd = w_fd = None
        if has_a:
            r_fd, w_fd = os.pipe()
            cmd += ["-map", "0:a:0", "-ac", "1", "-ar", str(SR), "-f", "s16le", f"pipe:{w_fd}"]
        if self.stop_flag.is_set():
            return
        fds = tuple(f for f in (w_fd, full_w) if f is not None)
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE if has_v else subprocess.DEVNULL,
                                     stderr=subprocess.PIPE, pass_fds=fds, start_new_session=True)
        for f in fds:
            os.close(f)
        readers = []
        if has_v:
            readers.append(threading.Thread(target=self._video_reader, daemon=True))
        if full_r is not None:
            readers.append(threading.Thread(target=self._full_reader, args=(full_r,), daemon=True))
        if has_a:
            readers.append(threading.Thread(target=self._audio_reader, args=(r_fd,), daemon=True))
        err_buf = []
        errt = threading.Thread(target=lambda: err_buf.append(self.proc.stderr.read().decode(errors="ignore")),
                                daemon=True)
        errt.start()
        for t in readers:
            t.start()
        last_size, stall = 0, 0
        while self.proc.poll() is None:
            time.sleep(1)
            if realtime and out_path:
                self._check_disk(out_path)
                size = out_path.stat().st_size if out_path.exists() else 0
                stall = stall + 1 if size == last_size else 0
                last_size = size
                if stall == 20:
                    self.warn_once("stall", "已 20 秒未收到新的直播数据，正在尝试重连；已采集内容已保存")
                elif stall == 0 and "stall" in self._warned:
                    self._warned.discard("stall")
                    self.emit("status", text="直播数据已恢复")
            self._emit_progress()
        for t in readers:
            t.join(timeout=30)
        errt.join(timeout=5)
        code = self.proc.returncode
        if code not in (0, None) and not self.stop_flag.is_set():
            msg = (err_buf[0] if err_buf else "").strip().splitlines()[-1:] or [""]
            if realtime and self.media_time > 0:
                self.warn_once("ended", f"直播流已结束或中断：{msg[0][:160]}")
            elif not realtime:
                raise RuntimeError(f"媒体处理失败：{msg[0][:200]}")
            else:
                raise RuntimeError(f"无法连接直播流：{msg[0][:200]}")
        self._emit_progress(force=True)

    def _check_disk(self, path):
        try:
            free = shutil.disk_usage(path.parent).free
        except Exception:
            return
        if free < 500 * 1024 * 1024:
            self.emit("warn", text="磁盘剩余空间不足 500MB，已停止采集并保存已写入内容")
            self.stop()

    def _emit_progress(self, force=False):
        now = time.time()
        if force or now - self._last_progress_emit >= 1.0:
            self._last_progress_emit = now
            self.emit("progress", media_time=max(self.media_time, self.audio_time),
                      asr_time=self.asr_time, shots=self.shot_count)

    # ----- 原分辨率帧（用于保存截图） -----
    def _full_reader(self, fd):
        """解析 MJPEG 字节流（SOI FFD8 … EOI FFD9），按帧序号保存最近 8 帧的 JPEG 字节"""
        buf = b""
        idx = 0
        with os.fdopen(fd, "rb", buffering=0) as f:
            while True:
                chunk = f.read(1 << 18)
                if not chunk:
                    break
                buf += chunk
                while True:
                    s = buf.find(b"\xff\xd8")
                    if s < 0:
                        buf = b""
                        break
                    e = buf.find(b"\xff\xd9", s + 2)
                    if e < 0:
                        buf = buf[s:]
                        break
                    jpg = buf[s:e + 2]
                    buf = buf[e + 2:]
                    # 不能阻塞读取：ffmpeg 多路输出共用一个进程，阻塞任一路会让另一路也停住（死锁）。
                    # 只淘汰检测已经处理过的旧帧；导入时原图流可能领先很多，最多缓存 240 帧（约 2 分钟）
                    with self._full_lock:
                        self._full_frames[idx] = jpg
                        floor = getattr(self, "_frame_idx", -1) - 8
                        old = [k for k in self._full_frames if k < floor]
                        if len(self._full_frames) - len(old) > 240:
                            old += sorted(k for k in self._full_frames if k >= floor)[:len(self._full_frames) - len(old) - 240]
                        for k in old:
                            del self._full_frames[k]
                    idx += 1
                    self._full_cv_set()
                    self._fill_pending()

    def _fill_pending(self):
        """检测帧先到、原图帧后到时，用原图重写那张临时降级的截图"""
        with self._full_lock:
            pend = getattr(self, "_pending_full", None)
            self._pending_full = []
        if not pend:
            return
        keep = []
        for idx, rgb in pend:
            with self._full_lock:
                ready = idx in self._full_frames
                newest = max(self._full_frames) if self._full_frames else -1
            if not ready:
                if newest < idx:
                    keep.append((idx, rgb))
                continue
            path = getattr(self, "_shot_paths", {}).get(idx)
            if path:
                try:
                    self._crop_full(rgb, idx=idx, wait=0).save(path, "JPEG", quality=90)
                except Exception:
                    pass
        if keep:
            with self._full_lock:
                self._pending_full = keep + getattr(self, "_pending_full", [])

    def _full_cv_set(self):
        with self._full_cv:
            self._full_cv.notify_all()

    def _full_frame(self, idx, wait=0.6):
        """取第 idx 帧的原分辨率 JPEG；两路输出有微小时差，最多等 wait 秒"""
        deadline = time.time() + wait
        with self._full_cv:
            while idx not in self._full_frames and time.time() < deadline:
                with self._full_lock:
                    oldest = min(self._full_frames) if self._full_frames else -1
                if oldest > idx:
                    break
                self._full_cv.wait(0.1)
        with self._full_lock:
            return self._full_frames.get(idx)

    # ----- 画面变化检测截图 -----
    def _video_reader(self):
        size = FRAME_W * FRAME_H * 3
        idx = 0
        out = self.proc.stdout
        while True:
            buf = out.read(size)
            if not buf or len(buf) < size:
                break
            ts = idx / FRAME_FPS
            self._frame_idx = idx
            idx += 1
            self.media_time = ts
            try:
                self._on_frame(np.frombuffer(buf, dtype=np.uint8).reshape(FRAME_H, FRAME_W, 3), ts)
            except Exception as e:
                self.warn_once("frame", f"截图处理异常：{e}")

    def _on_frame(self, rgb, ts):
        self._track_bars(rgb)
        small = _gray_small(rgb)
        prev = self._prev
        self._prev = small
        if small.mean() < 8 and small.std() < 3:
            return  # 黑屏
        s = settings.get("shot_sensitivity")
        thr = sensitivity_threshold(s)
        if self._ref is None:
            self._save_shot(rgb, ts, small, 0.0)
            return
        score = change_score(small, self._ref)
        self.motion = score
        now = time.time()
        if self.capturing and now - self._last_preview >= PREVIEW_EVERY:
            self._last_preview = now
            self._write_preview(rgb)
        if now - self._last_motion_emit >= 0.5:
            self._last_motion_emit = now
            self.emit("motion", score=score, threshold=thr)
        if score < thr:
            self._cand_since = None
            return
        if self._cand_since is None:
            self._cand_since = ts
        stable = prev is not None and change_score(small, prev) < max(thr * 0.5, 0.8)
        min_gap = 1.0 + 3.0 * (1.0 - s)
        if ts - self._last_shot_t < min_gap:
            return
        if stable or ts - self._cand_since >= 3.0:
            self._save_shot(rgb, ts, small, score)

    def _save_shot(self, rgb, ts, small, score):
        if self.shot_count >= MAX_SHOTS:
            self.warn_once("maxshots", f"截图已达上限 {MAX_SHOTS} 张，后续不再自动截图（录制与转写继续）")
            return
        if self.shot_count == SHOT_WARN_AT:
            self.warn_once("nearmax", f"截图已达 {SHOT_WARN_AT} 张，接近上限 {MAX_SHOTS}；可调低截图灵敏度")
        from PIL import Image
        self._ref = small
        self._cand_since = None
        self._last_shot_t = ts
        name = f"shot_{int(ts * 1000):09d}.jpg"
        path = session_dir(self.sid) / "shots" / name
        self._shot_paths = getattr(self, "_shot_paths", {})
        self._shot_paths[self._frame_idx] = path
        self._crop_full(rgb).save(path, "JPEG", quality=90)
        if self._stable_bars(rgb.shape[:2] if not getattr(self, "_content_box", None) else
                             (self._content_box[3] - self._content_box[1],
                              self._content_box[2] - self._content_box[0])) is None:
            self._early_shots = getattr(self, "_early_shots", []) + [path]
        self.shot_count += 1
        sid_ = db.add_screenshot(self.sid, ts, f"shots/{name}")
        self.emit("screenshot", id=sid_, ts=ts, path=f"shots/{name}", score=score)

    def _probe_content_box(self, src, realtime):
        """按源视频宽高比算出画面在检测画布中的区域（竖屏流 1080x1920 → 中间 405x720）"""
        try:
            cmd = [DEPS["ffmpeg"], "-hide_banner", "-nostdin"]
            if realtime:
                hdr = "Referer: https://live.bilibili.com/\r\n"
                ck = (getattr(self, "headers", None) or {}).get("cookie")
                if ck:
                    hdr += f"Cookie: {ck}\r\n"
                cmd += ["-user_agent", bilibili.UA, "-headers", hdr, "-t", "0.1"]
            cmd += ["-i", src]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
            m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", r.stderr)
            if not m:
                return None
            w, h = int(m.group(1)), int(m.group(2))
            self._src_size = (w, h)
            sar = re.search(r"SAR (\d+):(\d+)", r.stderr)
            if sar and int(sar.group(2)):
                w = w * int(sar.group(1)) / int(sar.group(2))
            if re.search(r"rotate\s*:\s*-?(90|270)", r.stderr) or re.search(r"rotation of -?(90|270)", r.stderr):
                w, h = h, w
            scale = min(FRAME_W / w, FRAME_H / h)
            cw, ch = int(round(w * scale)), int(round(h * scale))
            if cw >= FRAME_W - 4 and ch >= FRAME_H - 4:
                return None
            x0, y0 = (FRAME_W - cw) // 2, (FRAME_H - ch) // 2
            return (x0, y0, x0 + cw, y0 + ch)
        except Exception:
            return None

    def _crop_full(self, rgb, idx=None, wait=0.6):
        """截图用：取同一帧的原分辨率图像，按检测画布上算出的有效区域等比例裁剪。
        原图帧还没到时先用检测帧保存，原图到达后由 _fill_pending 覆盖。"""
        from PIL import Image
        import io
        fill_later = idx is None
        if idx is None:
            idx = getattr(self, "_frame_idx", -1)
        jpg = self._full_frame(idx, wait) if self._src_size else None
        if not jpg:
            if fill_later and self._src_size:
                with self._full_lock:
                    self._pending_full = getattr(self, "_pending_full", []) + [(idx, rgb.copy())]
            return self._crop(rgb)
        try:
            im = Image.open(io.BytesIO(jpg))
            im.load()
        except Exception:
            return self._crop(rgb)
        W, H = im.size
        box = getattr(self, "_content_box", None) or (0, 0, FRAME_W, FRAME_H)
        bx0, by0, bx1, by1 = box
        cw, ch = bx1 - bx0, by1 - by0
        inner = self._stable_bars((ch, cw)) or (0, 0, cw, ch)
        sx, sy = W / cw, H / ch
        x0, y0, x1, y1 = inner
        crop = (int(round(x0 * sx)), int(round(y0 * sy)), int(round(x1 * sx)), int(round(y1 * sy)))
        if crop != (0, 0, W, H):
            im = im.crop(crop)
        return im.convert("RGB")

    def _crop(self, rgb):
        """截图/预览只保存实际画面区域，去掉竖屏补出的黑边"""
        from PIL import Image
        box = getattr(self, "_content_box", None)
        if box:
            x0, y0, x1, y1 = box
            rgb = rgb[y0:y1, x0:x1]
        # 再裁掉源流自带的固定黑边（部分竖屏直播右侧/底部有一条黑带）
        inner = self._stable_bars(rgb.shape[:2])
        if inner:
            x0, y0, x1, y1 = inner
            rgb = rgb[y0:y1, x0:x1]
        return Image.fromarray(np.ascontiguousarray(rgb))

    def _track_bars(self, rgb):
        """逐帧累积：某列/行只要有一帧不是黑边就永久排除。固定黑边才会一直保留。"""
        box = getattr(self, "_content_box", None)
        if box:
            x0, y0, x1, y1 = box
            rgb = rgb[y0:y1, x0:x1]
        col, row = self._bar_masks(rgb)
        if getattr(self, "_bar_cols", None) is None or self._bar_cols.shape != col.shape \
                or self._bar_rows.shape != row.shape:
            self._bar_cols, self._bar_rows, self._bar_frames = col, row, 0
        else:
            self._bar_cols &= col
            self._bar_rows &= row
        self._bar_frames += 1
        if self._bar_frames == 10:
            self._recrop_early()

    def _recrop_early(self):
        """黑边判定稳定前（前 5 秒）截下的图，稳定后按同样的边界补裁一次"""
        early = getattr(self, "_early_shots", None)
        if not early:
            return
        from PIL import Image
        self._early_shots = []
        for p in early:
            try:
                im = Image.open(p)
                cb = getattr(self, "_content_box", None) or (0, 0, FRAME_W, FRAME_H)
                cw, ch = cb[2] - cb[0], cb[3] - cb[1]
                box = self._stable_bars((ch, cw))
                if box:
                    sx, sy = im.width / cw, im.height / ch
                    im.crop((int(box[0] * sx), int(box[1] * sy), int(box[2] * sx), int(box[3] * sy))) \
                        .save(p, "JPEG", quality=90)
            except Exception:
                pass

    def _stable_bars(self, shape):
        """至少观察 10 帧（5 秒）后才裁，避免黑底 PPT 等深色画面被误当黑边"""
        if getattr(self, "_bar_frames", 0) < 10:
            return None
        h, w = shape
        if self._bar_cols.shape[0] != w or self._bar_rows.shape[0] != h:
            return None

        def edge(arr, limit):
            n = 0
            while n < limit and arr[n]:
                n += 1
            return n

        left, right = edge(self._bar_cols, w // 8), edge(self._bar_cols[::-1], w // 8)
        top, bottom = edge(self._bar_rows, h // 8), edge(self._bar_rows[::-1], h // 8)
        if left + right + top + bottom == 0:
            return None
        # 黑边与画面交界处有缩放产生的过渡像素，向内多裁 3px
        pad = 3
        left = left + pad if left else 0
        right = right + pad if right else 0
        top = top + pad if top else 0
        bottom = bottom + pad if bottom else 0
        return (left, top, w - right, h - bottom)

    @staticmethod
    def _bar_masks(rgb):
        g = rgb.max(axis=2)
        dark_px = g < 20
        col = (dark_px.mean(axis=0) >= 0.8) & (g.mean(axis=0) < 40)
        row = (dark_px.mean(axis=1) >= 0.8) & (g.mean(axis=1) < 40)
        return col, row

    def _write_preview(self, rgb):
        """实时检测帧缩略图（侧栏「实时画面检测」用），原子替换避免读到半张"""
        from PIL import Image
        try:
            d = session_dir(self.sid)
            tmp = d / "preview.tmp.jpg"
            img = self._crop(rgb)
            img.thumbnail((480, 480))
            img.save(tmp, "JPEG", quality=70)
            os.replace(tmp, d / "preview.jpg")
        except Exception:
            pass

    # ----- 音频分段（能量 VAD） -----
    def _audio_reader(self, fd):
        frame = SR // 10  # 100ms
        pending = b""
        buf = []          # int16 frames
        rms_list = []
        offset = 0        # 已切出样本数
        with os.fdopen(fd, "rb", buffering=0) as f:
            while True:
                data = f.read(frame * 2 * 10)
                if not data:
                    break
                pending += data
                while len(pending) >= frame * 2:
                    fr = np.frombuffer(pending[:frame * 2], dtype=np.int16)
                    pending = pending[frame * 2:]
                    buf.append(fr)
                    rms_list.append(float(np.sqrt(np.mean(fr.astype(np.float32) ** 2))))
                    self.audio_time = (offset + len(buf) * frame) / SR
                    cut = self._find_cut(rms_list)
                    if cut:
                        self._push_chunk(buf[:cut], rms_list[:cut], offset)
                        offset += cut * frame
                        buf, rms_list = buf[cut:], rms_list[cut:]
        if pending:
            buf.append(np.frombuffer(pending[: len(pending) // 2 * 2], dtype=np.int16))
            rms_list.append(0.0)
        if buf:
            self._push_chunk(buf, rms_list, offset)

    @staticmethod
    def _find_cut(rms):
        n = len(rms)
        if n >= 40 and all(r < SILENCE_RMS for r in rms[-5:]):
            return n
        if n >= 150:
            window = rms[80:150]
            return 80 + int(np.argmin(window)) + 1
        return 0

    def _push_chunk(self, frames, rms, offset):
        audio = np.concatenate(frames)
        start = offset / SR
        end = start + len(audio) / SR
        if not rms or max(rms) < SILENCE_RMS:
            self._silent_sec += end - start
            if self.capturing and not self.import_file and self._silent_sec >= SILENCE_WARN_SEC:
                self.warn_once("silence", f"已持续 {int(self._silent_sec)} 秒未检测到声音，请确认直播是否有声音（录制仍在继续）")
            if not self._asr_q.qsize():
                self.asr_time = max(self.asr_time, end)
            return
        if self._silent_sec >= SILENCE_WARN_SEC:
            self.emit("status", text="已重新检测到声音")
        self._silent_sec = 0.0
        self._warned.discard("silence")
        if self.engine_config["provider"] != "local":
            if self._cloud_run is None:
                self._cloud_run = cloud_transcription.begin(self.sid, self.engine_config)
            row = cloud_transcription.save_chunk(self.sid, self._cloud_run, start, audio.astype(np.float32) / 32768)
            self._asr_q.put(row["chunk_id"])
        else:
            self._asr_q.put((start, end, audio))

    def _cloud_asr_worker(self):
        provider = asr_engines.resolve(self.engine_config)
        cloud_cancel = asr_engines.CombinedCancel(self.cancel_flag, self._cloud_abort)
        fatal = False
        try:
            while True:
                item = self._asr_q.get()
                if item is None:
                    break
                if self.cancel_flag.is_set() or self._cloud_abort.is_set():
                    return
                row = db.one("SELECT * FROM asr_chunks WHERE session_id=? AND chunk_id=?", (self.sid, item))
                if fatal:
                    continue
                try:
                    text = cloud_transcription.recognize(self.sid, self._cloud_run, row, provider,
                                                         cloud_cancel, self.emit)
                except asr_engines.Cancelled:
                    return
                except asr_engines.ProviderError as exc:
                    fatal = exc.fatal
                    self.warn_once("cloud", str(exc))
                    text = ""
                if (text or "").strip():
                    self._mark_speech(row["end_sample"] / SR)
                self.asr_time = row["end_sample"] / SR
            if self._cloud_run:
                if self.cancel_flag.is_set() or self._cloud_abort.is_set():
                    return
                cloud_transcription.finish(self.sid, self._cloud_run, self.emit)
            else:
                self._meta(asr_status="empty")
        except Exception as exc:
            self._asr_error = exc
            if self._cloud_run:
                self._meta(asr_status="partial", asr_failures=cloud_transcription.failures(self.sid, self._cloud_run))

    # ----- ASR 转写线程（Qwen3-ASR-1.7B） -----
    def _asr_worker(self):
        if self.engine_config["provider"] != "local":
            return self._cloud_asr_worker()
        mgr = asr.manager
        provider = asr_engines.resolve(self.engine_config)
        done_any = False
        skipped = False
        ended = False
        while True:
            item = self._asr_q.get()
            if item is None:
                ended = True
                if self._asr_q.empty():
                    break
                self._asr_q.put(None)
                continue
            if skipped:
                continue
            while not mgr.is_ready():
                if self.cancel_flag.is_set():
                    return
                if (ended or not self.capturing) and not mgr.is_pending():
                    skipped = True
                    break
                self.warn_once("asr", "Qwen3-ASR 模型尚未启用：媒体照常保存，模型下载完成后会自动补上转写")
                time.sleep(1)
            if skipped:
                continue
            if self.cancel_flag.is_set():
                return
            start, end, audio = item
            try:
                text = provider.recognize(audio.astype(np.float32) / 32768.0, cancel=self.cancel_flag).text
            except Exception as e:
                self.warn_once("asrerr", f"部分音频转写失败：{e}")
                continue
            self.asr_time = end
            text = text_hygiene.clean(text or "")
            if text:
                done_any = True
                self._mark_speech(end)
                if self._staged is not None:
                    self._staged.append((start, end, text))
                else:
                    db.add_transcript(self.sid, start, end, text)
                self.emit("transcript", start=start, end=end, text=text)
        if self.cancel_flag.is_set():
            return
        if skipped:
            self._meta(asr_status="skipped")
            self.emit("warn", text="未完成转写：ASR 模型不可用。模型启用后可在详情页点击「重新转写」")
        else:
            self._meta(asr_status="done" if done_any or self.asr_time > 0 else "empty")


# ---------- 任务注册表（统一由 scheduler 管理处理槽位） ----------
BusyError = scheduler.BusyError


def _unregister(task):
    scheduler.release(task.sid, task)


def start_capture(sid, url=None, import_file=None, transcribe_only=False) -> CaptureTask:
    task = scheduler.acquire(sid, lambda: CaptureTask(sid, url=url, import_file=import_file,
                                                      transcribe_only=transcribe_only))
    if not isinstance(task, CaptureTask):
        raise BusyError(sid)
    return task


def stop_capture(sid):
    t = get_task(sid)
    if t:
        t.stop()


def cancel_capture(sid, wait=10):
    t = get_task(sid)
    if t:
        t.cancel()
        t.finished.wait(wait)


def get_task(sid):
    t = scheduler.task_for(sid)
    return t if isinstance(t, CaptureTask) else None


def shutdown_all(timeout=8):
    _, t = scheduler.current()
    if isinstance(t, CaptureTask):
        t.stop()
        t.finished.wait(timeout)


def recover_interrupted():
    """F-C09：启动时检查上次未正常结束的任务，保存可恢复的部分并如实标记。"""
    for s in db.list_sessions():
        if s.get("kind") == "link_video":
            continue
        if s["status"] not in ("recording", "processing"):
            continue
        d = session_dir(s["id"])
        ts = d / "media.ts"
        note = "上次应用异常退出，任务未正常结束"
        if ts.exists() and ts.stat().st_size > 0 and DEPS["ffmpeg"]:
            out = d / "media.mp4"
            r = subprocess.run([DEPS["ffmpeg"], "-y", "-loglevel", "error", "-i", str(ts),
                                "-c", "copy", "-movflags", "+faststart", str(out)],
                               capture_output=True, timeout=3600)
            if r.returncode == 0 and out.exists() and out.stat().st_size > 0:
                ts.unlink(missing_ok=True)
                db.update_session(s["id"], media_path="media.mp4")
            else:
                db.update_session(s["id"], media_path="media.ts")
            note += "；已保存的媒体可回看，未完成的转写可「重新转写」"
        shutil.rmtree(d / "live", ignore_errors=True)
        db.update_session(s["id"], status="error", error=note)
