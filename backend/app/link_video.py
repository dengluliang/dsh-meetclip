"""Link-video metadata, download and serial queue support."""
from __future__ import annotations

import json
import os
import queue
import re
import signal
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
from collections import deque
from pathlib import Path

import asr_engines
import capture
import douyin
import meeting
import minutes
import scheduler
import settings
import subtitles
from database import DATA_DIR, db, session_dir
from hints import HINT_YTDLP

MAX_QUEUE = 50
MAX_DURATION = 6 * 60 * 60
MAX_BYTES = 8 * 1024 * 1024 * 1024
PLATFORMS = {
    "bilibili": ("bilibili.com", "b23.tv"),
    "weibo": ("weibo.com", "weibo.cn"),
    "douyin": ("douyin.com", "iesdouyin.com"),
    "youtube": ("youtube.com", "youtu.be", "youtube-nocookie.com"),
    "x": ("x.com", "twitter.com"),
}
UNSUPPORTED_LINK_MESSAGE = "暂不支持该链接。支持 B站、微博、抖音、YouTube 和 X（Twitter）视频"


def normalize_url(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    parsed = urllib.parse.urlsplit(value if "://" in value else "https://" + value)
    host = parsed.netloc.lower().removeprefix("www.")
    path = re.sub(r"/{2,}", "/", parsed.path or "/").rstrip("/") or "/"
    # X 的新旧域名、移动端和用户名链接都以帖子 ID 为准，复用预读与重复检查。
    if host in {f"{prefix}{domain}" for domain in PLATFORMS["x"]
                for prefix in ("", "m.", "mobile.")}:
        host = "x.com"
        post = re.fullmatch(r"/(?:(?:i/web|[^/]+)/status|statuses)/(\d+)(?:/(video|photo)/(\d+))?", path)
        if post:
            path = f"/i/web/status/{post[1]}"
            if post[2]:
                path += f"/{post[2]}/{int(post[3])}"
    # X 分享链接里的 t 是追踪令牌，其他平台的 t 才可能是播放时间。
    allowed = set() if host == "x.com" else {"v", "p", "part", "t", "time_continue", "vd_source"}
    query = urllib.parse.urlencode([(k, v) for k, v in urllib.parse.parse_qsl(parsed.query)
                                    if k.lower() in allowed])
    return urllib.parse.urlunsplit(("https", host, path, query, ""))


def detect_platform(url: str) -> str | None:
    host = urllib.parse.urlsplit(normalize_url(url)).netloc.lower()
    for platform, domains in PLATFORMS.items():
        if any(host == d or host.endswith("." + d) for d in domains):
            return platform
    return None


def _single_video_args(url: str) -> list[str]:
    # Twitter 的普通帖子在 --no-playlist 下仍可能返回多个视频；每条任务只取首段。
    # 显式 /video/N 链接由提取器按 --no-playlist 选择指定视频。
    return ["--playlist-items", "1"] if detect_platform(url) == "x" else []


def _x_syndication_fallback(url: str, cookie_args: list[str], message: str) -> bool:
    # 公开帖的 API 在部分网络下不可达；只对匿名请求使用 yt-dlp 自带的嵌入接口。
    # 登录与无视频错误沿用原有处理，避免用不完整的公开接口覆盖授权结果。
    return (detect_platform(url) == "x"
            and bool(re.fullmatch(r"/i/web/status/\d+(?:/(?:video|photo)/\d+)?",
                                  urllib.parse.urlsplit(normalize_url(url)).path))
            and "--cookies-from-browser" not in cookie_args
            and any(word in message.lower() for word in (
                "unable to download json metadata", "timed out", "connection reset",
                "could not retrieve guest token", "http error 429", "http error 502", "http error 503",
            )))


def _extractor_args(info: dict, cookie_args: list[str]) -> list[str]:
    if info.get("_x_api") == "syndication" and "--cookies-from-browser" not in cookie_args:
        return ["--extractor-args", "twitter:api=syndication"]
    return []


def _has_module() -> bool:
    import importlib.util
    return importlib.util.find_spec("yt_dlp") is not None


def _command() -> list[str]:
    """yt-dlp 子进程命令。优先用内置 Python 里的模块：单文件版每次启动要解压约 6 秒。"""
    if _has_module():
        return [sys.executable, "-m", "yt_dlp"]
    if not capture.DEPS.get("yt_dlp"):
        raise RuntimeError(HINT_YTDLP)
    return [capture.DEPS["yt_dlp"]]


def _binary() -> str:
    # 兼容旧调用与测试：返回命令的第一段。
    return _command()[0]


class LinkAccessError(RuntimeError):
    """平台访问或登录失败，可根据授权尝试浏览器登录态。"""


class SubtitleChoiceError(RuntimeError):
    """所选字幕无法读取或无法确定语言；视频照常下载并保留。"""


def _access_attempts(url: str = "") -> list[list[str]]:
    # 即使允许读取登录态，公开视频也优先匿名访问；外部 yt-dlp 配置不能改变此策略。
    options = settings.get_all()
    attempts = []
    # 抖音：设置里扫码登录后的专用 Cookie 文件优先；其余平台仍先匿名。
    if url and detect_platform(url) == "douyin" and douyin.COOKIE_FILE.exists():
        attempts.append(["--cookies", str(douyin.COOKIE_FILE)])
    attempts.append(["--no-cookies", "--no-cookies-from-browser"])
    if options.get("link_browser_cookies"):
        attempts.append(["--no-cookies", "--cookies-from-browser",
                         options.get("link_cookie_browser") or "chrome"])
    return attempts


def _needs_login(message: str) -> bool:
    return any(word in message.lower() for word in (
        "login", "log in", "sign in", "cookie", "private", "members", "premium",
        "age-restricted", "authentication", "protected tweet", "403", "401", "412", "登录", "会员",
    ))


DOUYIN_LOGIN_HINT = ("请在「设置 → 采集 → 视频」点「扫码登录」，用抖音 App 登录后"
                     "点「读取 Cookie」。")


def _friendly_message(platform: str | None, message: str) -> str:
    text = str(message or "")
    if platform == "douyin" and _needs_login(text):
        return f"抖音需要登录 Cookie（Fresh cookies）：{DOUYIN_LOGIN_HINT}"
    if platform == "douyin" and "下载失败" not in text and (
            "抖音页面" in text or "抖音视频" in text or "Douyin" in text):
        return "抖音页面没有返回可下载的视频：请确认链接有效、已登录，并重新读取 Cookie。"
    return text


def _access_error(errors: list[str]) -> LinkAccessError:
    latest = errors[-1]
    if len(errors) > 1 and any(word in latest.lower() for word in (
        "cookies database", "failed to decrypt", "keychain", "keyring",
        "could not copy", "permission denied", "unable to extract browser cookies",
    )):
        return LinkAccessError(
            f"{errors[0][:180]}；无法读取所选浏览器的登录信息。"
            "请在「设置 → 视频」选择已登录的浏览器后重试。"
        )
    return LinkAccessError(latest[:300])


class _Logger:
    """收集 yt-dlp 的警告与错误文本，沿用命令行版的错误判断。"""

    def __init__(self):
        self.lines: list[str] = []

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        self.lines.append(f"WARNING: {msg}")

    def error(self, msg):
        self.lines.append(str(msg))


def _extract(url: str, cookie_args: list[str], subtitles_wanted: bool) -> subprocess.CompletedProcess:
    """在当前进程读取视频信息；返回值与命令行调用相同，便于共用后续判断。"""
    import yt_dlp

    args = ["--ignore-config", "--no-playlist", "--skip-download", "--simulate", "--socket-timeout", "15",
            *_single_video_args(url),
            *(["--write-subs", "--write-auto-subs"] if subtitles_wanted else []), *cookie_args, url]
    opts = yt_dlp.parse_options(args).ydl_opts
    logger = _Logger()
    opts.update(quiet=True, no_warnings=False, noprogress=True, logger=logger)
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            raw = ydl.extract_info(url, download=False, process=True)
            info = ydl.sanitize_info(raw) if raw else None
        if not isinstance(info, dict):
            return subprocess.CompletedProcess(args, 1, None, "\n".join(logger.lines) or "ERROR: 无法读取视频信息")
        return subprocess.CompletedProcess(args, 0, info, "\n".join(logger.lines))
    except Exception as exc:  # yt-dlp 的 DownloadError 等都带用户可读的信息
        lines = logger.lines or [f"ERROR: {exc}"]
        return subprocess.CompletedProcess(args, 1, None, "\n".join(lines))


def _run_info_once(cmd_tail: list[str], cookie_args: list[str], url: str, subtitles_wanted: bool):
    if _has_module():
        return _extract(url, cookie_args, subtitles_wanted)
    base = [_binary(), *cmd_tail]
    cmd = [*base, *_single_video_args(url),
           *(["--write-subs", "--write-auto-subs"] if subtitles_wanted else []), *cookie_args, url]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 1, "", "字幕检测超时")
    if p.returncode:
        return p
    try:
        return subprocess.CompletedProcess(cmd, 0, json.loads(p.stdout), p.stderr)
    except json.JSONDecodeError as exc:
        raise RuntimeError("平台返回了无法识别的元数据") from exc


def _run_info(cmd_tail: list[str], cookie_args: list[str], url: str, subtitles_wanted: bool):
    result = _run_info_once(cmd_tail, cookie_args, url, subtitles_wanted)
    if result.returncode and _x_syndication_fallback(url, cookie_args, result.stderr or ""):
        result = _run_info_once(cmd_tail, [*cookie_args, "--extractor-args", "twitter:api=syndication"],
                                url, subtitles_wanted)
        if not result.returncode:
            result.stdout["_x_api"] = "syndication"
    return result


def _info_ytdlp(url: str) -> dict:
    errors = []
    fallback = None
    url = normalize_url(url)
    tail = ["--ignore-config", "--dump-single-json", "--no-playlist", "--skip-download", "--simulate"]
    for cookie_args in _access_attempts(url):
        p = _run_info(tail, cookie_args, url, True)
        subtitle_error = bool(re.search(r"subtitle|caption|字幕", p.stderr or "", re.I))
        if p.returncode and subtitle_error:
            # A caption extractor error must not hide otherwise accessible video metadata.
            p = _run_info(tail, cookie_args, url, False)
        if not p.returncode:
            info = p.stdout
            if detect_platform(url) == "x" and info.get("_type") in ("playlist", "multi_video"):
                entries = info.get("entries") or []
                if not entries or not isinstance(entries[0], dict):
                    raise RuntimeError("该 X 帖子中没有可采集的视频")
                info = dict(entries[0], **({"_x_api": info["_x_api"]} if info.get("_x_api") else {}))
            info.setdefault("subtitles", {})
            info.setdefault("automatic_captions", {})
            info["_subtitle_probe"] = True
            if subtitle_error and not subtitles.candidates(info):
                info["_subtitle_error"] = "字幕检测暂不可用"
            if subtitle_error and _needs_login(p.stderr or "") and not subtitles.candidates(info):
                fallback = info
                continue
            return info
        msg = (p.stderr or p.stdout or "无法读取视频信息").strip().splitlines()[-1]
        errors.append(msg)
        if not _needs_login(msg):
            break
    if fallback is not None:
        return fallback
    raise _access_error(errors)


def _douyin_info(url: str) -> dict:
    """yt-dlp 的 Douyin 提取器被平台 403 拦截时，用分享页的 _ROUTER_DATA 兜底。"""
    data = douyin.share_info(url)
    play_url = data.get("play_url") or ""
    if not play_url:
        raise RuntimeError("没有找到抖音视频直链")
    return {
        "id": data.get("aweme_id") or "",
        "title": data.get("title") or "抖音视频",
        "description": data.get("title") or "",
        "uploader": data.get("uploader") or "",
        "channel": data.get("uploader") or "",
        "duration": float(data.get("duration") or 0),
        "thumbnail": data.get("thumbnail") or "",
        "webpage_url": data.get("page_url") or url,
        "original_url": url,
        "extractor": "DouyinShare",
        "extractor_key": "DouyinShare",
        "formats": [{
            "url": play_url,
            "ext": "mp4",
            "format_id": "douyin-share",
            "protocol": "https",
            "width": data.get("width") or None,
            "height": data.get("height") or None,
        }],
        "subtitles": {},
        "automatic_captions": {},
        "_subtitle_probe": True,
        "_douyin_play_url": play_url,
        "_douyin_play_fallback": data.get("play_fallback") or "",
        "_douyin_share": True,
    }


def _info(url: str) -> dict:
    normalized = normalize_url(url)
    try:
        return _info_ytdlp(normalized)
    except Exception as exc:
        if detect_platform(normalized) != "douyin":
            raise
        try:
            return _douyin_info(normalized)
        except Exception as fallback:
            raise LinkAccessError(f"{exc}；抖音页面解析失败：{fallback}") from fallback


# 预读结果缓存：入队与后台处理直接复用，同一链接 15 分钟内不再访问平台。
PREVIEW_TTL = 15 * 60
_preview_cache: dict[str, tuple[float, dict]] = {}
_preview_lock = threading.Lock()


def cached_info(url: str) -> dict | None:
    key = normalize_url(url)
    with _preview_lock:
        hit = _preview_cache.get(key)
        if hit and time.monotonic() - hit[0] < PREVIEW_TTL:
            return hit[1]
        _preview_cache.pop(key, None)
    return None


def _remember(url: str, info: dict):
    with _preview_lock:
        now = time.monotonic()
        for key in [k for k, (at, _) in _preview_cache.items() if now - at >= PREVIEW_TTL]:
            _preview_cache.pop(key, None)
        _preview_cache[normalize_url(url)] = (now, info)


def _info_cached(url: str) -> dict:
    info = cached_info(url)
    if info is None:
        info = _info(url)
        _remember(url, info)
    return info


def preview(url: str) -> dict:
    original = (url or "").strip()
    normalized = normalize_url(original)
    if not normalized:
        return {"ok": False, "status": "invalid", "message": "请输入视频链接"}
    platform = detect_platform(normalized)
    if not platform:
        return {"ok": False, "status": "unsupported", "url": original,
                "message": UNSUPPORTED_LINK_MESSAGE}
    try:
        info = _info_cached(normalized)
        duration = float(info.get("duration") or 0)
        if duration > MAX_DURATION:
            return {"ok": False, "status": "too_long", "platform": platform,
                    "duration": duration, "message": "单条链接最长支持 6 小时"}
        extractor = info.get("extractor_key") or info.get("extractor") or ""
        title = (info.get("title") or info.get("fulltitle") or "未命名视频").strip()
        thumbnail = info.get("thumbnail") or ""
        uploader = info.get("uploader") or info.get("channel") or ""
        live_status = None
        started_at = None
        category = ""
        # yt-dlp 会给直播标题附加抓取时间；预览使用发布会入口的原始房间标题与封面。
        room_url = normalized
        if urllib.parse.urlsplit(normalized).hostname != "live.bilibili.com":
            room_url = info.get("webpage_url") or normalized
        if platform == "bilibili" and urllib.parse.urlsplit(room_url).hostname == "live.bilibili.com":
            room = capture.preview_bilibili_live(room_url)
            if room.get("title"):
                title = room["title"]
                thumbnail = room.get("thumbnail") or ""
                uploader = room.get("uploader") or ""
                live_status = room.get("status")
                started_at = room.get("started_at")
                category = room.get("category") or ""
        size = max((int(f.get("filesize") or f.get("filesize_approx") or 0)
                    for f in (info.get("formats") or [])), default=0)
        return {
            "ok": True, "status": "ready", "url": original, "normalized_url": normalized,
            "platform": platform, "extractor": extractor,
            "title": title, "thumbnail": thumbnail, "uploader": uploader, "live_status": live_status,
            "started_at": started_at, "category": category,
            "duration": duration, "estimated_bytes": size,
            **subtitles.summary(info),
            "message": "可以加入转写队列",
        }
    except Exception as exc:
        text = str(exc)
        status = "login_required" if _needs_login(text) else "error"
        return {"ok": False, "status": status, "url": original, "normalized_url": normalized,
                "platform": platform, "message": _friendly_message(platform, text)[:400]}


def _disk_ok() -> bool:
    try:
        usage = shutil.disk_usage(DATA_DIR)
        return usage.free > max(10 * 1024**3, int(usage.total * 0.10))
    except OSError:
        return True


def _mark_cancelled(sid: str):
    db.update_link_job(sid, job_state="cancelled", phase="cancelled", finished_at=time.time())
    db.update_session(sid, status="cancelled", error="已取消", ended_at=time.time())


def complete_fallback(sid: str, path: str):
    """内录文件写完后：校验路径，交给会议离线转写管线，完成后回写队列状态。

    调用前槽位已由 fallback/start 预留给 sid；转写任务结束时会释放槽位。
    """
    d = session_dir(sid).resolve()
    media = Path(path).expanduser().resolve()
    try:
        media.relative_to(d)
    except ValueError:
        raise PermissionError("内录文件必须位于当前记录目录")
    if not media.is_file() or media.stat().st_size < 1024:
        raise ValueError("没有找到有效的内录文件")
    rel = str(media.relative_to(d))
    db.update_session(sid, media_path=rel, source_type="link", download_mode="screen_capture",
                      status="processing", error=None)
    db.update_link_job(sid, job_state="transcribing", phase="transcribing", partial_cache_path=rel)
    task = meeting.start_meeting(sid, import_file=str(media), params=meeting.transcription_params(db.get_session(sid) or {}))

    def finish():
        task.finished.wait()
        latest = db.get_session(sid) or {}
        if latest.get("status") == "cancelled":
            db.update_link_job(sid, job_state="cancelled", phase="cancelled", finished_at=time.time())
        elif latest.get("status") == "error":
            db.update_link_job(sid, job_state="error", phase="error", error_code="fallback_transcribe",
                               error_message=latest.get("error") or "内录转写失败", finished_at=time.time())
        else:
            db.update_link_job(sid, job_state="done", phase="done", finished_at=time.time())
        scheduler.release(sid)
        manager.add(sid)

    threading.Thread(target=finish, daemon=True).start()


PLAN_MARK = "MEETCLIP_PLAN "
SINGLE_MARK = "MEETCLIP_SINGLE "
PROGRESS_MARK = "MEETCLIP_PROGRESS "


def _number(value: str) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


class DownloadProgress:
    """按本次实际选中的分轨累计字节，避免把单个分轨完成误判为整体完成。"""

    def __init__(self):
        self.order: list[str] = []
        self.totals: dict[str, int] = {}
        self.downloaded_by_format: dict[str, int] = {}
        self.finished: set[str] = set()
        self.speed = 0.0
        self.stream_finished = False

    def _add(self, format_id: str, size=None):
        if not format_id:
            return
        if format_id not in self.order:
            self.order.append(format_id)
        size = _number(size)
        if size:
            self.totals[format_id] = int(size)

    def feed(self, line: str) -> bool:
        self.stream_finished = False
        if line.startswith(PLAN_MARK):
            try:
                formats = json.loads(line[len(PLAN_MARK):])
            except json.JSONDecodeError:
                formats = None
            if isinstance(formats, list):
                self.order, self.totals = [], {}
                for item in formats:
                    if isinstance(item, dict):
                        self._add(str(item.get("format_id") or ""), item.get("filesize") or item.get("filesize_approx"))
            return False
        if line.startswith(SINGLE_MARK):
            format_id, _, size = line[len(SINGLE_MARK):].partition("\t")
            if not self.order:
                self._add(format_id, size)
            return False
        done = re.search(r"\.f([^.\s]+)\.[^.\s]+ has already been downloaded", line)
        if done and done.group(1) in self.order:
            self._finish(done.group(1))
            return True
        if not line.startswith(PROGRESS_MARK):
            return False
        parts = line[len(PROGRESS_MARK):].split("\t")
        if len(parts) < 5:
            return False
        format_id, downloaded, total, speed, status = parts[:5]
        if format_id not in self.order:
            self._add(format_id)
        index = self.order.index(format_id)
        for earlier in self.order[:index]:
            self._finish(earlier)
        total_value = _number(total)
        if total_value:
            self.totals[format_id] = int(total_value)
        downloaded_value = _number(downloaded)
        if downloaded_value is not None:
            self.downloaded_by_format[format_id] = int(downloaded_value)
        self.speed = _number(speed) or 0.0
        if status == "finished":
            self._finish(format_id)
        return True

    def _finish(self, format_id: str):
        if format_id in self.finished:
            return
        self.finished.add(format_id)
        self.stream_finished = True
        if format_id in self.totals:
            self.downloaded_by_format[format_id] = self.totals[format_id]
        elif format_id in self.downloaded_by_format:
            self.totals[format_id] = self.downloaded_by_format[format_id]

    @property
    def downloaded(self) -> int:
        return sum(self.downloaded_by_format.get(item, 0) for item in self.order)

    @property
    def total(self) -> int | None:
        if not self.order or any(item not in self.totals for item in self.order):
            return None
        return sum(max(self.totals[item], self.downloaded_by_format.get(item, 0)) for item in self.order)

    @property
    def fraction(self) -> float | None:
        total = self.total
        if not total:
            return None
        if len(self.finished) >= len(self.order):
            return 1.0
        return min(0.99, self.downloaded / total)

    @property
    def eta(self) -> float | None:
        total = self.total
        if not total or self.speed <= 0:
            return None
        return max(0.0, (total - self.downloaded) / self.speed)


class LinkTask:
    def __init__(self, sid: str):
        self.sid = sid
        self.events: queue.Queue = queue.Queue(maxsize=256)
        self._event_lock = threading.RLock()
        self._event_stream_id = uuid.uuid4().hex
        self._event_seq = 0
        self._event_log = []
        self._event_warnings = []
        self._event_status = ""
        self.finished = threading.Event()
        self.cancel_flag = threading.Event()
        self.process: subprocess.Popen | None = None
        self.transcription_task: LinkMeetingTask | None = None

    def emit(self, kind: str, **payload):
        event = {"kind": kind, "time": time.time(), **payload}
        with self._event_lock:
            self._event_seq += 1
            event["event_id"] = self._event_seq
            event["event_stream_id"] = self._event_stream_id
            if kind == "warn" and event.get("text") and event["text"] not in self._event_warnings:
                self._event_warnings.append(event["text"])
            if kind == "status":
                self._event_status = event.get("text", "")
            elif kind in ("done", "error", "cancelled"):
                self._event_status = ""
            self._event_log.append(event.copy())
            if len(self._event_log) > 2048:
                del self._event_log[:-2048]
        try:
            self.events.put_nowait(event)
        except queue.Full:
            try:
                self.events.get_nowait()
                self.events.put_nowait(event)
            except queue.Empty:
                pass

    def events_since(self, event_id=0):
        with self._event_lock:
            return [e.copy() for e in self._event_log if e.get("event_id", 0) > event_id]

    def event_cursor(self):
        with self._event_lock:
            return {"event_stream_id": self._event_stream_id, "event_id": self._event_seq,
                    "event_warnings": self._event_warnings.copy(), "event_status": self._event_status}

    def snapshot(self):
        return self.transcription_task.snapshot() if self.transcription_task else None

    def start(self):
        threading.Thread(target=self.run, name=f"link-video-{self.sid}", daemon=True).start()

    def cancel(self):
        self.cancel_flag.set()
        if self.transcription_task:
            self.transcription_task.cancel()
        proc = self.process
        if proc and proc.poll() is None:
            try:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except Exception:
                    proc.terminate()
            except Exception:
                pass

    def run(self):
        sid = self.sid
        root = session_dir(sid)
        source = root / "source"
        source.mkdir(parents=True, exist_ok=True)
        sess = db.get_session(sid) or {}
        job = db.get_link_job(sid) or {}
        auto = (sess.get("meta") or {}).get("transcription_mode", "asr") == "auto"
        try:
            self._update("preparing", "preparing")
            self.emit("phase", phase="preparing", text="正在准备下载")
            if not _disk_ok():
                raise RuntimeError("磁盘空间不足，请清理空间后重试")
            metadata_path = source / "metadata.json"
            try:
                info = json.loads(metadata_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                cached = root / "media.mp4"
                info = cached_info(sess["source_url"])
                if info is not None:
                    pass
                elif cached.exists() and cached.stat().st_size > 0:
                    info = dict((sess.get("meta") or {}).get("source_meta") or {})
                    info.setdefault("duration", sess.get("duration") or 0)
                    info.setdefault("title", sess.get("title") or "")
                else:
                    info = _info_cached(sess["source_url"])
            if auto and not info.get("_subtitle_probe"):
                try:
                    info = _info_cached(sess["source_url"])
                except Exception:
                    info["_subtitle_error"] = "字幕检测暂不可用"
            metadata_path.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
            duration = float(info.get("duration") or 0)
            if duration > MAX_DURATION:
                raise RuntimeError("单条链接最长支持 6 小时")
            title = (info.get("title") or info.get("fulltitle") or "").strip()
            if title and (sess.get("title") or "") in ("", sess.get("source_url"), "链接视频"):
                db.update_session(sid, title=title)
                sess["title"] = title
            db.update_meta(sid, source_meta={
                "title": info.get("title") or sess.get("title"),
                "thumbnail": info.get("thumbnail") or "", "uploader": info.get("uploader") or info.get("channel") or "",
                "duration": duration, "extractor": info.get("extractor_key") or info.get("extractor") or "",
                "retrieved_at": time.time(),
            }, has_video=True, has_audio=True, asr_status="running" if asr_engines.ready(asr_engines.session_config(db.get_session(sid) or {})) else "waiting")
            db.update_session(sid, status="processing", duration=duration or sess.get("duration") or 0,
                              started_at=sess.get("started_at") or time.time())
            # 字幕只需几秒：先读字幕让转写内容立刻可见，再下载视频。
            caption_error = None
            try:
                imported = auto and self._import_subtitles(info, source)
            except SubtitleChoiceError as exc:
                # 视频仍照常下载保留，结束时再报告字幕问题，重试沿用同一字幕语言。
                imported, caption_error = False, exc
            if self.cancel_flag.is_set():
                return
            self._update("downloading", "downloading")
            self.emit("phase", phase="downloading", text="正在下载视频")
            final = root / "media.mp4"
            if not final.exists() or final.stat().st_size <= 0:
                downloaded, src = self._download(sess["source_url"], source, info)
                if downloaded > MAX_BYTES:
                    raise RuntimeError("单条缓存超过 8 GB，已停止下载")
                self._make_playable(src, final)
                src.unlink(missing_ok=True)
            if not final.exists() or final.stat().st_size <= 0:
                raise RuntimeError("下载完成但没有得到可回放的视频文件")
            db.update_session(sid, media_path="media.mp4", status="processing")
            self._update("transcribing", "transcribing", downloaded_bytes=final.stat().st_size,
                         total_bytes=final.stat().st_size, download_progress=1.0, speed=0, eta=None,
                         available_duration=duration)
            self.emit("media_available", path="media.mp4", downloaded_bytes=final.stat().st_size)
            if caption_error is not None:
                raise caption_error
            if not imported and not self.cancel_flag.is_set():
                self.emit("phase", phase="transcribing", text="正在转录")
                if asr_engines.ready(asr_engines.session_config(db.get_session(sid) or {})):
                    self._transcribe(final, job)
                else:
                    db.update_meta(sid, asr_status="skipped")
                    self.emit("warn", text="视频已保存；没有可用的字幕且语音识别模型未启用，可稍后重新转写"
                              if auto else "视频已保存；语音识别模型未启用，可稍后重新转写")
            if self.cancel_flag.is_set():
                return
            self._update("done", "done", finished_at=time.time(), downloaded_bytes=final.stat().st_size,
                         total_bytes=final.stat().st_size)
            db.update_session(sid, status="done", ended_at=time.time())
            self.emit("done", text="处理完成")
            # 字幕路径不走会议管线，需要在这里补一次终稿纪要；ASR/内录路径由 MeetingTask 负责。
            if imported and minutes.auto_mode() != "off":
                minutes.finish(sid)
        except Exception as exc:
            if not self.cancel_flag.is_set():
                msg = _friendly_message((db.get_session(sid) or {}).get("platform"), str(exc))
                self._update("error", "error", error_code="link_video", error_message=msg, finished_at=time.time())
                db.update_session(sid, status="error", error=msg, ended_at=time.time())
                self.emit("error", text=msg)
        finally:
            if self.cancel_flag.is_set():
                _mark_cancelled(sid)
                self.emit("cancelled", text="已取消，已保留已下载内容")
            scheduler.release(sid)
            self.finished.set()
            manager.task_done(sid)

    def _update(self, state: str, phase: str, **fields):
        db.update_link_job(self.sid, job_state=state, phase=phase, **fields)

    def _fetch_subtitle(self, info: dict, candidate: dict, directory: Path, index: int,
                        url: str = "") -> str:
        track = candidate["track"]
        if track.get("data"):
            return track["data"]
        # Reuse yt-dlp's networking and authorized cookie handling without
        # re-extracting the video or letting caption files become media candidates.
        selected = dict(info, subtitles={}, automatic_captions={})
        selected[candidate["field"]] = {candidate["code"]: [track]}
        selected.pop("requested_subtitles", None)
        selected.pop("_subtitle_error", None)
        metadata = directory / "request.json"
        metadata.write_text(json.dumps(selected, ensure_ascii=False), encoding="utf-8")
        prefix = f"candidate-{index}"
        errors = []
        for cookie_args in _access_attempts(url):
            if self.cancel_flag.is_set():
                raise RuntimeError("已取消")
            # A partial file from a failed anonymous attempt must not be reused.
            for old in directory.glob(prefix + ".*"):
                old.unlink(missing_ok=True)
            cmd = [*_command(), "--ignore-config", "--no-playlist", "--skip-download", "--no-simulate",
                   "--write-subs", "--write-auto-subs", "--sub-langs", re.escape(candidate["code"]),
                   "--sub-format", candidate["ext"], "--retries", "1", "--socket-timeout", "15",
                   "--load-info-json", str(metadata), "-o", str(directory / (prefix + ".%(ext)s")),
                   *cookie_args]
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, start_new_session=True)
            self.process = proc
            try:
                output, _ = proc.communicate(timeout=45)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
                raise RuntimeError("字幕下载超时")
            finally:
                self.process = None
            if self.cancel_flag.is_set():
                raise RuntimeError("已取消")
            if proc.returncode == 0:
                files = list(directory.glob(prefix + ".*." + candidate["ext"]))
                if files:
                    return files[0].read_text(encoding="utf-8-sig")
            message = (output or "字幕下载失败")[-600:]
            errors.append(message)
            if not _needs_login(message):
                break
        raise _access_error(errors)

    def _import_subtitles(self, info: dict, source: Path) -> bool:
        self._update("transcribing", "subtitles", phase_text="正在读取字幕")
        self.emit("phase", phase="transcribing", text="正在读取字幕")
        directory = source / "subtitles"
        directory.mkdir(exist_ok=True)
        manifest = directory / "selected.json"
        meta = (db.get_session(self.sid) or {}).get("meta") or {}
        selection = meta.get("subtitle_track_id")
        if not selection:
            detected = subtitles.summary(info)
            if detected["subtitle_selection_required"]:
                raise SubtitleChoiceError("无法确定字幕语言，视频已保留；请重新添加链接并选择字幕语言")
            selection = detected["default_subtitle_track_id"]
            if selection:
                db.update_meta(self.sid, subtitle_track_id=selection)
        rows, chosen, data = [], None, None
        try:
            cached = json.loads(manifest.read_text(encoding="utf-8"))
            if cached.get("ext") in subtitles.FORMATS and cached.get("id") == selection:
                data = (directory / ("caption." + cached["ext"])).read_text(encoding="utf-8")
                rows = subtitles.parse(data, cached["ext"])
                chosen = cached if rows else None
        except (OSError, ValueError, TypeError, KeyError):
            pass
        failed = bool(info.get("_subtitle_error") or selection)
        if not rows:
            for attempt in range(2):
                for index, candidate in enumerate(subtitles.candidates(info, selection)):
                    if self.cancel_flag.is_set():
                        return False
                    try:
                        source_url = info.get("webpage_url") or (db.get_session(self.sid) or {}).get("source_url") or ""
                        data = self._fetch_subtitle(info, candidate, directory, index, source_url)
                        rows = subtitles.parse(data, candidate["ext"])
                    except (OSError, ValueError, TypeError, RuntimeError, subprocess.SubprocessError):
                        rows = []
                    if rows:
                        chosen = candidate
                        break
                    failed = True
                if rows or self.cancel_flag.is_set() or not failed or attempt == 1:
                    break
                try:
                    info = _info((db.get_session(self.sid) or {})["source_url"])
                    (source / "metadata.json").write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
                except Exception:
                    break
        if self.cancel_flag.is_set():
            return False
        if not rows:
            if selection:
                db.update_meta(self.sid, asr_status="error")
                raise SubtitleChoiceError("所选字幕加载失败，视频已保留；点击重试将继续加载同一字幕语言")
            if failed:
                self.emit("warn", text="平台字幕暂不可用，已回退本地转录")
            return False
        saved = {k: chosen[k] for k in ("id", "language", "kind", "ext", "source_language")}
        (directory / ("caption." + saved["ext"])).write_text(data, encoding="utf-8")
        manifest.write_text(json.dumps(saved, ensure_ascii=False), encoding="utf-8")
        # No partial replacement: caption text, provenance and speaker options
        # become visible together only after every operation succeeds.
        with db.transaction():
            if self.cancel_flag.is_set():
                return False
            db.replace_transcripts(self.sid, rows)
            db.update_meta(self.sid, transcription_source="subtitle", subtitle_language=saved["language"],
                           subtitle_source_language=saved["source_language"],
                           subtitle_kind=saved["kind"], language=saved["language"], asr_status="done",
                           aligned=False, speakers={}, diarize_error="")
            duration = float((db.get_session(self.sid) or {}).get("duration") or 0)
            db.update_link_job(self.sid, transcribed_until=max(r[1] for r in rows), available_duration=duration)
        self.emit("status", text="字幕已读取")
        return True

    def _download(self, url: str, source: Path, info: dict) -> tuple[int, Path]:
        if detect_platform(url) == "douyin" and info.get("_douyin_play_url"):
            source.mkdir(parents=True, exist_ok=True)
            dest = source / "douyin.mp4"
            self._update("downloading", "downloading", downloaded_bytes=0, total_bytes=None,
                         download_progress=None, speed=0, eta=None)
            downloaded = douyin.download_media(
                info["_douyin_play_url"], dest,
                fallback=info.get("_douyin_play_fallback") or "",
                max_bytes=MAX_BYTES,
            )
            self._update("downloading", "downloading", downloaded_bytes=downloaded,
                         total_bytes=downloaded, download_progress=1.0, speed=0, eta=None)
            self.emit("download_progress", downloaded_bytes=downloaded,
                      total_bytes=downloaded, progress=1.0)
            return downloaded, dest
        errors = []
        for cookie_args in _access_attempts(url):
            if self.cancel_flag.is_set():
                raise RuntimeError("已取消")
            try:
                return self._download_attempt(normalize_url(url), source, info, cookie_args)
            except LinkAccessError as exc:
                errors.append(str(exc))
                if info.get("_x_api") != "syndication" and _x_syndication_fallback(url, cookie_args, str(exc)):
                    try:
                        return self._download_attempt(normalize_url(url), source,
                                                      dict(info, _x_api="syndication"), cookie_args)
                    except LinkAccessError as fallback_exc:
                        errors.append(str(fallback_exc))
                if not _needs_login(errors[-1]):
                    break
        raise _access_error(errors)

    def _download_attempt(self, url: str, source: Path, info: dict,
                          cookie_args: list[str]) -> tuple[int, Path]:
        template = str(source / "media.%(ext)s")
        fmt = "bv*+ba/b"
        limit = settings.get("link_max_height")
        if limit:
            fmt = f"bv*[height<={int(limit)}]+ba/b[height<={int(limit)}]"
        cmd = [*_command(), "--ignore-config", "--no-playlist", "--newline", "--no-quiet", "--no-simulate",
               *_single_video_args(url), *_extractor_args(info, cookie_args),
               "--continue", "--part", "--retries", "3",
               "--fragment-retries", "3", "--concurrent-fragments", "1", "-f", fmt,
               "-O", f"before_dl:{PLAN_MARK}%(requested_formats.:.{{format_id,filesize,filesize_approx}})j",
               "-O", f"before_dl:{SINGLE_MARK}%(format_id)s\t%(filesize,filesize_approx)s",
               "--progress-template", f"download:{PROGRESS_MARK}%(info.format_id)s\t%(progress.downloaded_bytes)s\t"
               "%(progress.total_bytes,progress.total_bytes_estimate)s\t%(progress.speed)s\t%(progress.status)s",
               "--merge-output-format", "mp4", "-o", template, *cookie_args, url]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                 bufsize=1, start_new_session=True)
        self.process = proc
        progress = DownloadProgress()
        self._update("downloading", "downloading", downloaded_bytes=0, total_bytes=None,
                     download_progress=None, speed=0, eta=None)
        output_tail = deque(maxlen=12)
        last_write = 0.0
        for line in proc.stdout or ():
            line = line.strip()
            if line and not line.startswith((PLAN_MARK, SINGLE_MARK, PROGRESS_MARK)):
                output_tail.append(line)
            if self.cancel_flag.is_set():
                proc.terminate()
                break
            if not progress.feed(line):
                continue
            if progress.downloaded > MAX_BYTES or (progress.total or 0) > MAX_BYTES:
                proc.terminate()
                raise RuntimeError("单条缓存超过 8 GB，已停止下载")
            now = time.monotonic()
            if now - last_write < 0.5 and not progress.stream_finished:
                continue
            last_write = now
            fraction = progress.fraction
            self._update("downloading", "downloading", downloaded_bytes=progress.downloaded,
                         total_bytes=progress.total, download_progress=fraction,
                         speed=progress.speed, eta=progress.eta)
            self.emit("download_progress", downloaded_bytes=progress.downloaded, total_bytes=progress.total,
                      progress=fraction)
        code = proc.wait()
        self.process = None
        if self.cancel_flag.is_set():
            raise RuntimeError("已取消")
        if code != 0:
            errors = [line for line in output_tail if line.startswith("ERROR:")]
            msg = errors[-1] if errors else (output_tail[-1] if output_tail else "视频下载失败，请检查链接权限或稍后重试")
            raise LinkAccessError(msg)
        candidates = [p for p in source.glob("media.*") if p.is_file() and p.suffix not in {".json", ".part"}]
        if not candidates:
            raise RuntimeError("下载完成但找不到媒体文件")
        chosen = max(candidates, key=lambda p: p.stat().st_size)
        return chosen.stat().st_size, chosen

    def _make_playable(self, source: Path, final: Path):
        if source.suffix.lower() == ".mp4":
            source.replace(final)
            return
        ffmpeg = capture.DEPS.get("ffmpeg")
        if not ffmpeg:
            raise RuntimeError("缺少 ffmpeg，无法生成可回放文件")
        tmp = final.with_suffix(".tmp.mp4")
        p = subprocess.run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(source),
                            "-c", "copy", "-movflags", "+faststart", str(tmp)], capture_output=True, text=True, timeout=3600)
        if p.returncode or not tmp.exists() or tmp.stat().st_size <= 0:
            raise RuntimeError("视频已下载，但无法转换为可回放格式")
        tmp.replace(final)

    def _transcribe(self, media: Path, job: dict):
        # 同一段音频只在会议管线中构建、转写与命名；原转写保留到整段成功替换。
        params = meeting.transcription_params(db.get_session(self.sid) or {})
        task = LinkMeetingTask(self, params)
        self.transcription_task = task
        task._run()
        latest = db.get_session(self.sid) or {}
        if latest.get("status") == "error":
            raise RuntimeError(latest.get("error") or "视频转写失败")
        if latest.get("status") == "cancelled":
            self.cancel_flag.set()
            return
        duration = float(latest.get("duration") or 0)
        db.update_link_job(self.sid, transcribed_until=duration, available_duration=duration)


class LinkMeetingTask(meeting.MeetingTask):
    """在链接队列已持有的槽位中同步运行会议管线，事件与进度仍属于链接任务。"""
    def __init__(self, parent: LinkTask, params: dict):
        super().__init__(parent.sid, params=params)
        self.parent = parent
        self.cancel_flag = parent.cancel_flag

    def emit(self, kind, **payload):
        if kind not in ("done", "error", "cancelled"):
            self.parent.emit(kind, **payload)

    def _set_phase(self, phase, text, progress=None):
        super()._set_phase(phase, text, progress)
        if phase != "done":
            self.parent._update("transcribing", phase, phase_text=text)

    def _audio_progress(self, event):
        super()._audio_progress(event)
        db.update_link_job(self.sid, transcribed_until=self.asr_time)


class LinkQueueManager:
    """链接的暂停、恢复与状态管理；执行顺序统一交给 scheduler。"""
    def __init__(self):
        self._lock = threading.RLock()
        self._paused = False
        self._tasks: dict[str, LinkTask] = {}
        self._stopping = False

    @property
    def stopping(self):
        with self._lock:
            return self._stopping

    def start(self):
        self._stopping = False
        for row in db.list_link_jobs(["preparing", "downloading", "transcribing", "finalizing"]):
            db.update_link_job(row["session_id"], job_state="queued", phase="queued")
        for row in db.list_link_jobs(["fallback_recording"]):
            db.update_link_job(row["session_id"], job_state="error", phase="error",
                               error_code="fallback_interrupted", error_message="应用退出时内录被中断，已保留已有文件",
                               finished_at=time.time())
            db.update_session(row["session_id"], status="error", error="应用退出时内录被中断，已保留已有文件")
        self.add("")

    def add(self, sid: str):
        if self.stopping:
            return
        # 一次登记所有尚未迁入统一队列的链接，兼容旧版持久化队列。
        for row in db.list_link_jobs(["queued", "waiting_for_slot", "paused"]):
            scheduler.enqueue(row["session_id"], "link_video")
        scheduler.changed.set()

    def launch(self, sid: str):
        task = LinkTask(sid)
        with self._lock:
            self._tasks[sid] = task
        scheduler.attach(sid, task)
        try:
            task.start()
        except Exception:
            self.task_done(sid)
            raise

    def task(self, sid: str):
        with self._lock:
            return self._tasks.get(sid)

    def task_done(self, sid: str):
        with self._lock:
            self._tasks.pop(sid, None)
        scheduler.changed.set()

    @property
    def paused(self) -> bool:
        with self._lock:
            return self._paused

    def pause(self):
        with self._lock:
            self._paused = True
        scheduler.changed.set()

    def resume(self):
        with self._lock:
            self._paused = False
        scheduler.changed.set()

    def cancel(self, sid: str):
        if not scheduler.cancel(sid):
            _mark_cancelled(sid)
            scheduler.release(sid)
        scheduler.changed.set()

    def shutdown(self, timeout=8):
        with self._lock:
            self._stopping = True
            tasks = list(self._tasks.values())
        scheduler.shutdown()
        for task in tasks:
            task.cancel()
        deadline = time.time() + timeout
        for task in tasks:
            task.finished.wait(max(0.1, deadline - time.time()))


manager = LinkQueueManager()


def start():
    manager.start()


def shutdown(timeout=8):
    manager.shutdown(timeout)
