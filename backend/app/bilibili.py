"""B站登录态（复用 Chrome 已登录账号）与原画直播流获取。"""
import http.cookiejar
import json
import subprocess
import threading
import time
import urllib.parse
import urllib.request

from shared_paths import SHARED_DIR

COOKIE_FILE = SHARED_DIR / "bili_cookies.txt"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
REFERER = "https://live.bilibili.com/"
QN_LABEL = {30000: "杜比", 20000: "4K", 15000: "2K", 10000: "原画", 400: "蓝光",
            250: "超清", 150: "高清", 80: "流畅"}

_lock = threading.Lock()
_state = {"logged_in": False, "uname": "", "checked_at": 0.0, "error": "", "source": ""}


def _load_jar():
    jar = http.cookiejar.MozillaCookieJar()
    if COOKIE_FILE.exists():
        try:
            jar.load(str(COOKIE_FILE), ignore_discard=True, ignore_expires=True)
        except Exception:
            pass
    return jar


def cookie_header():
    parts = []
    for c in _load_jar():
        if c.domain.endswith("bilibili.com"):
            parts.append(f"{c.name}={c.value}")
    return "; ".join(dict.fromkeys(parts))


def _get_json(url, timeout=10):
    headers = {"User-Agent": UA, "Referer": REFERER}
    ck = cookie_header()
    if ck:
        headers["Cookie"] = ck
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _check_nav():
    try:
        d = _get_json("https://api.bilibili.com/x/web-interface/nav")
        data = d.get("data") or {}
        return bool(data.get("isLogin")), data.get("uname") or ""
    except Exception:
        return False, ""


def import_from_chrome(yt_dlp, timeout=60):
    """用 yt-dlp 从 Chrome 导出 cookie（首次可能弹出钥匙串授权）。"""
    if not yt_dlp:
        return False, "缺少 yt-dlp，无法读取浏览器登录"
    tmp = COOKIE_FILE.with_suffix(".tmp")
    try:
        r = subprocess.run(
            [yt_dlp, "--cookies-from-browser", "chrome", "--cookies", str(tmp),
             "--skip-download", "--no-warnings", "-q", "--playlist-items", "0",
             "https://www.bilibili.com/"],
            capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, "读取 Chrome 登录超时（可能在等待钥匙串授权）"
    if not tmp.exists() or tmp.stat().st_size == 0:
        msg = (r.stderr or "").strip().splitlines()[-1:] or ["未找到 Chrome 登录信息"]
        return False, msg[0][:200]
    lines = [ln for ln in tmp.read_text(errors="ignore").splitlines()
             if ln.startswith("#") or "bilibili" in ln.split("\t")[0]]
    COOKIE_FILE.write_text("\n".join(lines) + "\n")
    COOKIE_FILE.chmod(0o600)
    tmp.unlink(missing_ok=True)
    return True, ""


def status(refresh=False):
    with _lock:
        if not refresh and time.time() - _state["checked_at"] < 600:
            return dict(_state)
    ok, uname = _check_nav()
    with _lock:
        _state.update(logged_in=ok, uname=uname, checked_at=time.time(),
                      source="cookie" if COOKIE_FILE.exists() else "")
        if ok:
            _state["error"] = ""
        return dict(_state)


def ensure_login(yt_dlp, force_import=False):
    """有效则直接返回；无效（或强制）时从 Chrome 重新导出一次。"""
    st = status(refresh=True)
    if st["logged_in"] and not force_import:
        return st
    # 扫码登录得到的 cookie 已失效时也尝试 Chrome；读不到 Chrome（打包版受系统隐私保护）不覆盖现有 cookie
    backup = COOKIE_FILE.read_bytes() if COOKIE_FILE.exists() else None
    ok, err = import_from_chrome(yt_dlp)
    st = status(refresh=True)
    if not st["logged_in"] and backup is not None and not ok:
        COOKIE_FILE.write_bytes(backup)
    if not st["logged_in"]:
        with _lock:
            _state["error"] = err or "Chrome 中未登录 B站"
            st = dict(_state)
    return st


def get_stream(room_id):
    """返回 {url, qn, quality, codec, format} 或 None。优先 FLV+AVC 原画。"""
    q = urllib.parse.urlencode({
        "room_id": room_id, "protocol": "0,1", "format": "0,1,2", "codec": "0,1",
        "qn": 10000, "platform": "web", "ptype": 8, "dolby": 5, "panorama": 1})
    d = _get_json(f"https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?{q}")
    if d.get("code") != 0:
        return None
    pu = ((d.get("data") or {}).get("playurl_info") or {}).get("playurl") or {}
    cands = []
    for s in pu.get("stream", []):
        for f in s.get("format", []):
            for c in f.get("codec", []):
                if not c.get("url_info"):
                    continue
                ui = c["url_info"][0]
                url = ui["host"] + c["base_url"] + ui.get("extra", "")
                pri = (c.get("current_qn", 0),
                       1 if c.get("codec_name") == "avc" else 0,
                       2 if f.get("format_name") == "flv" else (1 if f.get("format_name") == "ts" else 0))
                cands.append((pri, {"url": url, "qn": c.get("current_qn", 0),
                                    "codec": c.get("codec_name"), "format": f.get("format_name")}))
    if not cands:
        return None
    cands.sort(key=lambda x: x[0], reverse=True)
    best = cands[0][1]
    best["quality"] = QN_LABEL.get(best["qn"], str(best["qn"]))
    return best


# ---------- 扫码登录（不依赖浏览器，打包版主路径） ----------
_qr = {"key": "", "url": "", "created": 0.0}


def qr_start():
    req = urllib.request.Request(
        "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
        headers={"User-Agent": UA, "Referer": "https://www.bilibili.com/"})
    with urllib.request.urlopen(req, timeout=10) as r:
        d = json.loads(r.read().decode())
    if d.get("code") != 0:
        raise RuntimeError(d.get("message") or "生成二维码失败")
    data = d["data"]
    with _lock:
        _qr.update(key=data["qrcode_key"], url=data["url"], created=time.time())
    return {"url": data["url"], "key": data["qrcode_key"]}


def qr_poll(key):
    """返回 {state: waiting|scanned|expired|ok|error, message}"""
    jar = http.cookiejar.MozillaCookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    url = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll?" + urllib.parse.urlencode({"qrcode_key": key})
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://www.bilibili.com/"})
    with opener.open(req, timeout=10) as r:
        d = json.loads(r.read().decode())
    data = d.get("data") or {}
    code = data.get("code")
    if code == 86101:
        return {"state": "waiting", "message": "请用 B站 App 扫码"}
    if code == 86090:
        return {"state": "scanned", "message": "已扫码，请在手机上确认登录"}
    if code == 86038:
        return {"state": "expired", "message": "二维码已过期，请刷新"}
    if code != 0:
        return {"state": "error", "message": data.get("message") or d.get("message") or "登录失败"}
    # 成功：cookie 在响应 Set-Cookie 中；部分版本只在跳转 url 的 query 里
    cookies = {c.name: c for c in jar if c.domain.endswith("bilibili.com")}
    if "SESSDATA" not in cookies and data.get("url"):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(data["url"]).query)
        for name in ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5"):
            if q.get(name):
                jar.set_cookie(http.cookiejar.Cookie(
                    0, name, q[name][0], None, False, ".bilibili.com", True, True, "/", True,
                    True, int(time.time()) + 180 * 86400, False, None, None, {}))
    COOKIE_FILE.parent.mkdir(parents=True, exist_ok=True)
    jar.save(str(COOKIE_FILE), ignore_discard=True, ignore_expires=True)
    COOKIE_FILE.chmod(0o600)
    st = status(refresh=True)
    if not st["logged_in"]:
        return {"state": "error", "message": "登录信息未生效，请重试"}
    return {"state": "ok", "message": f"已登录：{st['uname']}", "uname": st["uname"]}


def logout():
    if COOKIE_FILE.exists():
        COOKIE_FILE.unlink()
    with _lock:
        _state.update(logged_in=False, uname="", checked_at=0.0, error="", source="")
    return status(refresh=True)
