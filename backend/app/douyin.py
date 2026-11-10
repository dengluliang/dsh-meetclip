"""抖音登录态：浏览器扫码登录后导入 Cookie，供链接视频管线使用。

抖音没有 B站那样的开放扫码接口（passport 接口对非 App 请求返回 4031/非法应用），
所以这里不做 App 内二维码：用户在浏览器里扫码登录，再把该浏览器的 douyin Cookie
导出成本地文件。文件只含 douyin.com / iesdouyin.com 域，权限 0600。
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import webbrowser

import settings
from database import db
from shared_paths import SHARED_DIR

COOKIE_FILE = SHARED_DIR / "douyin_cookies.txt"
LOGIN_URL = "https://www.douyin.com/"
MOBILE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
             "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
PERMISSION_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
PERMISSION_HINT = (
    "读不到浏览器 Cookie 数据库。macOS 可能没有给 DeepSeek Harness 完全磁盘访问权限："
    "请到「系统设置 → 隐私与安全性 → 完全磁盘访问权限」勾选 DeepSeek Harness，"
    "然后重启本地引擎再试。"
)
BROWSER_APPS = {
    "chrome": "Google Chrome",
    "safari": "Safari",
    "firefox": "Firefox",
    "edge": "Microsoft Edge",
    "brave": "Brave Browser",
    "chromium": "Chromium",
}


class _QuietLogger:
    def debug(self, message):
        pass

    def info(self, message):
        pass

    def warning(self, message):
        pass

    def error(self, message):
        pass


def _is_douyin(cookie) -> bool:
    host = str(getattr(cookie, "domain", "") or "").lstrip(".").lower()
    return host in ("douyin.com", "iesdouyin.com") or host.endswith(".douyin.com") \
        or host.endswith(".iesdouyin.com")


def _load_jar() -> http.cookiejar.MozillaCookieJar:
    jar = http.cookiejar.MozillaCookieJar(str(COOKIE_FILE))
    if COOKIE_FILE.exists():
        try:
            jar.load(ignore_discard=True, ignore_expires=True)
        except Exception:
            pass
    return jar


def _load_cookie_count() -> int:
    return sum(1 for cookie in _load_jar() if _is_douyin(cookie))


def cookie_header() -> str:
    return "; ".join(
        f"{cookie.name}={cookie.value}" for cookie in _load_jar() if _is_douyin(cookie)
    )


def _http_get(url: str, referer: str = "https://www.douyin.com/") -> str:
    headers = {
        "User-Agent": MOBILE_UA,
        "Referer": referer,
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    cookies = cookie_header()
    if cookies:
        headers["Cookie"] = cookies
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=25) as response:
        return response.read().decode("utf-8", "replace")


def resolve_video_id(url: str) -> str:
    """短链跟随跳转，返回 douyin 视频 ID。"""
    value = str(url or "").strip()
    match = re.search(r"/(?:share/)?video/(\d+)", urllib.parse.urlsplit(value).path)
    if match:
        return match.group(1)
    host = urllib.parse.urlsplit(value).netloc.lower()
    if host == "v.douyin.com":
        headers = {"User-Agent": MOBILE_UA, "Referer": "https://www.douyin.com/"}
        cookies = cookie_header()
        if cookies:
            headers["Cookie"] = cookies
        request = urllib.request.Request(value, headers=headers)
        with urllib.request.urlopen(request, timeout=20) as response:
            match = re.search(r"/video/(\d+)", response.geturl())
        if match:
            return match.group(1)
    raise RuntimeError("无法解析抖音视频 ID")


def share_info(url: str) -> dict:
    """用分享页的 _ROUTER_DATA 取标题/时长/封面/直链；需要浏览器 Cookie。"""
    video_id = resolve_video_id(url)
    html = _http_get(f"https://www.iesdouyin.com/share/video/{video_id}/")
    match = re.search(r"window\._ROUTER_DATA\s*=\s*(\{.*?\})</script>", html, re.S)
    if not match:
        raise RuntimeError("抖音页面没有返回视频数据；请先在设置里读取浏览器 Cookie")
    try:
        data = json.loads(match.group(1))
    except ValueError as exc:
        raise RuntimeError("抖音页面数据无法解析") from exc
    page = None
    for value in (data.get("loaderData") or {}).values():
        if isinstance(value, dict) and isinstance(value.get("videoInfoRes"), dict):
            page = value
            break
    items = (((page or {}).get("videoInfoRes") or {}).get("item_list") or [])
    item = items[0] if items and isinstance(items[0], dict) else None
    if not item:
        raise RuntimeError("抖音页面没有视频信息；请确认已登录并重新读取浏览器 Cookie")
    video = item.get("video") if isinstance(item.get("video"), dict) else {}
    play = video.get("play_addr") if isinstance(video.get("play_addr"), dict) else {}
    play_list = play.get("url_list") or []
    play_id = str(play.get("uri") or "")
    if not play_id and not play_list:
        raise RuntimeError("这个抖音链接不是视频（可能是图文帖子）")
    primary = (f"https://www.douyin.com/aweme/v1/play/?video_id={play_id}&ratio=720p&line=0"
               if play_id else play_list[0])
    fallback = play_list[0] if play_list and play_list[0] != primary else ""
    cover = ((video.get("cover") or {}).get("url_list") or [])
    author = item.get("author") if isinstance(item.get("author"), dict) else {}
    duration = float(video.get("duration") or 0) / 1000.0
    return {
        "aweme_id": str(item.get("aweme_id") or video_id),
        "title": str(item.get("desc") or "抖音视频").strip(),
        "uploader": str(author.get("nickname") or "").strip(),
        "duration": duration,
        "thumbnail": cover[0] if cover else "",
        "play_url": primary,
        "play_fallback": fallback,
        "page_url": f"https://www.douyin.com/video/{video_id}",
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
    }


def download_media(url: str, dest, fallback: str = "", max_bytes: int = 8 * 1024**3) -> int:
    """下载分享页给出的直链；playwm 链接作为兜底。"""
    dest.parent.mkdir(parents=True, exist_ok=True)

    def once(target: str) -> int:
        headers = {
            "User-Agent": MOBILE_UA,
            "Referer": "https://www.douyin.com/",
            "Accept": "*/*",
        }
        cookies = cookie_header()
        if cookies:
            headers["Cookie"] = cookies
        request = urllib.request.Request(target, headers=headers)
        total = 0
        with urllib.request.urlopen(request, timeout=60) as response, open(dest, "wb") as handle:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise RuntimeError("抖音视频超过 8 GB 上限")
                handle.write(chunk)
        if total <= 0:
            raise RuntimeError("抖音视频返回了空文件")
        return total

    try:
        return once(url)
    except Exception as exc:
        dest.unlink(missing_ok=True)
        if fallback and fallback != url:
            try:
                return once(fallback)
            except Exception as second:
                dest.unlink(missing_ok=True)
                raise RuntimeError(f"抖音视频下载失败：{second}") from second
        raise RuntimeError(f"抖音视频下载失败：{exc}") from exc


def last_url() -> str:
    """最近一次提交的抖音链接，用来做「测试连接」。"""
    try:
        row = db.one(
            "SELECT source_url FROM sessions WHERE platform='douyin' AND COALESCE(source_url,'')<>'' "
            "ORDER BY created_at DESC LIMIT 1"
        )
    except Exception:
        return ""
    return str((row or {}).get("source_url") or "")


def status() -> dict:
    browser = settings.get_all().get("link_cookie_browser") or "chrome"
    updated = 0.0
    if COOKIE_FILE.exists():
        try:
            updated = COOKIE_FILE.stat().st_mtime
        except OSError:
            updated = 0.0
    return {
        "saved": COOKIE_FILE.exists(),
        "count": _load_cookie_count(),
        "updated_at": updated,
        "browser": browser,
        "last_url": last_url(),
    }


def import_cookies(browser: str = "chrome") -> dict:
    browser = browser if browser in settings.COOKIE_BROWSERS else "chrome"
    try:
        from yt_dlp.cookies import extract_cookies_from_browser
    except ImportError as exc:
        raise RuntimeError("当前运行环境没有内置 yt-dlp，无法读取浏览器 Cookie") from exc
    try:
        source = extract_cookies_from_browser(browser, logger=_QuietLogger())
    except Exception as exc:
        text = str(exc)
        lowered = text.lower()
        if any(word in lowered for word in (
                "could not find", "operation not permitted", "permission denied",
                "not authorized", "access denied", "权限")):
            raise RuntimeError(PERMISSION_HINT) from exc
        raise RuntimeError(f"读取 {browser} Cookie 失败：{text}") from exc
    target = http.cookiejar.MozillaCookieJar(str(COOKIE_FILE))
    count = 0
    for cookie in source:
        if not _is_douyin(cookie):
            continue
        target.set_cookie(cookie)
        count += 1
    if not count:
        raise RuntimeError("浏览器里没有抖音 Cookie：请确认扫码登录的是当前选择的浏览器，再读取一次")
    COOKIE_FILE.parent.mkdir(parents=True, exist_ok=True)
    target.save(ignore_discard=True, ignore_expires=True)
    try:
        os.chmod(COOKIE_FILE, 0o600)
    except OSError:
        pass
    return {"ok": True, "count": count, "updated_at": time.time(), "browser": browser}


def clear() -> dict:
    try:
        COOKIE_FILE.unlink(missing_ok=True)
    except OSError:
        pass
    return {"ok": True, "saved": False, "count": 0}


def open_permission() -> dict:
    try:
        subprocess.Popen(["open", PERMISSION_URL],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as exc:
        raise RuntimeError(f"无法打开系统设置：{exc}") from exc
    return {"ok": True, "url": PERMISSION_URL}


def open_login(browser: str = "") -> dict:
    browser = (browser or settings.get_all().get("link_cookie_browser") or "chrome").lower()
    app = BROWSER_APPS.get(browser)
    try:
        if sys.platform == "darwin" and app:
            subprocess.Popen(["open", "-a", app, LOGIN_URL],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", LOGIN_URL],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            webbrowser.open(LOGIN_URL)
    except Exception as exc:
        raise RuntimeError(f"无法打开浏览器：{exc}") from exc
    return {"ok": True, "browser": browser, "url": LOGIN_URL}
