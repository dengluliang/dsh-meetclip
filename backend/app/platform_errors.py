"""把平台返回的英文/错误码翻译成用户能照做的中文建议。

这里只做纯文本分类，不访问网络、不读取设置，供 link_video.py 与 capture.py
共用。原始错误放在 detail，界面默认折叠，主文案永远是可执行的动作。
"""
from __future__ import annotations

import re

PLATFORM_LABELS = {
    "bilibili": "B站",
    "douyin": "抖音",
    "youtube": "YouTube",
    "x": "X",
    "weibo": "微博",
}

LOGIN_ACTIONS = {
    "bilibili": {
        "id": "bilibili_login",
        "label": "扫码登录 B站",
        "platform": "bilibili",
    },
    "douyin": {
        "id": "douyin_login",
        "label": "登录抖音",
        "platform": "douyin",
    },
}

GENERIC_BROWSER_ACTION = {
    "id": "browser_cookies",
    "label": "使用浏览器登录状态",
    "platform": "",
}

# 顺序有讲究：登录类要排在无效/网络之前，B 站的 412 和会员提示都属于登录。
_LOGIN_WORDS = (
    "login", "log in", "sign in", "sign-in", "cookie", "private", "members",
    "premium", "subscription", "age-restricted", "authentication", "authenticated",
    "403", "401", "412", "登录", "会员", "充电", "权限", "授权", "凭证",
)
_INVALID_WORDS = (
    "keyerror('bvid')", "keyerror(\"bvid\")", "not found", "not exist", "does not exist",
    "deleted", "removed", "unavailable", "404", "不存在", "已删除", "已失效", "无效",
    "invalid url", "unsupported url", "no video", "没有视频",
)
_NETWORK_WORDS = (
    "timed out", "timeout", "connection", "connect", "network", "ssl", "dns",
    "name or service", "temporary failure", "http error 5", "502", "503", "504",
    "服务不可用", "连接失败", "网络",
)
_BROWSER_WORDS = (
    "cookies database", "failed to decrypt", "keychain", "keyring", "could not copy",
    "permission denied", "unable to extract browser cookies", "operation not permitted",
)

_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_REPORT = re.compile(r";?\s*please report this issue.*$", re.I | re.S)


def clean_detail(value: str, limit: int = 500) -> str:
    """原始错误只留一小段给「技术详情」，去掉升级提示与 ANSI。"""
    text = _ANSI.sub("", str(value or ""))
    text = _REPORT.sub("", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def needs_login(message: str) -> bool:
    text = str(message or "").lower()
    return any(word in text for word in _LOGIN_WORDS)


def _login_message(platform: str) -> str:
    label = PLATFORM_LABELS.get(platform, "该平台")
    if platform == "bilibili":
        return ("这条 B站视频需要登录后才能读取（可能是会员、充电、地区限制或平台风控）。"
                "请扫码登录 B站，登录后点「重试」。")
    if platform == "douyin":
        return ("抖音要求登录后才能下载这条视频。请打开抖音登录页，扫码后读取登录状态，"
                "再点「重试」。")
    if platform == "x":
        return ("这条 X 内容需要登录后才能查看。请允许会摘使用浏览器登录状态，"
                "选择已登录的浏览器后重试。")
    if platform == "youtube":
        return ("这条 YouTube 视频需要登录或会员权限。请允许会摘使用浏览器登录状态后重试。")
    return f"{label}要求登录后才能访问这条内容。请登录后重试。"


def login_action(platform: str) -> dict | None:
    if platform in LOGIN_ACTIONS:
        return dict(LOGIN_ACTIONS[platform])
    if platform:
        return {**GENERIC_BROWSER_ACTION, "platform": platform}
    return None


def _no_video_message(platform: str) -> str:
    if platform == "x":
        return "这条 X 内容里没有可采集的视频。请换一条带视频的帖子。"
    return "这条链接里没有可采集的视频。请换一条链接。"


def classify_failure(platform: str | None, raw: str, context: str = "video") -> dict:
    """返回 {status,code,message,action,detail}，主文案不含原始错误码。"""
    text = str(raw or "")
    lower = text.lower()
    detail = clean_detail(text)
    platform = platform or ""

    if any(word in lower for word in _BROWSER_WORDS):
        return {
            "status": "login_required",
            "code": "browser_cookies_unavailable",
            "message": ("读不到浏览器的登录信息。请允许会摘读取浏览器 Cookie，并选择"
                        "已登录的浏览器；如果刚在系统设置里授权，请重启本地引擎后再试。"),
            "action": login_action(platform) or dict(GENERIC_BROWSER_ACTION),
            "detail": detail,
        }

    if needs_login(text):
        return {
            "status": "login_required",
            "code": "login_required",
            "message": _login_message(platform),
            "action": login_action(platform),
            "detail": detail,
        }

    if "没有可采集的视频" in text or "no video could be found" in lower or "no video" in lower:
        return {
            "status": "error",
            "code": "no_video",
            "message": _no_video_message(platform),
            "action": None,
            "detail": detail,
        }

    if "预览图" in text or "没有音轨" in text:
        return {
            "status": "error",
            "code": "preview_only",
            "message": ("这次只下到了平台的预览图（没有音轨），没法转写。点「重试」会重新下载；"
                        "如果反复出现，把设置 → 链接视频里的「最高清晰度」改成「不限」。"),
            "action": None,
            "detail": detail,
        }

    if any(word in lower for word in _NETWORK_WORDS):
        return {
            "status": "unreachable",
            "code": "network",
            "message": "连不上平台（网络异常或平台风控）。请稍后重试。",
            "action": None,
            "detail": detail,
        }

    if any(word in lower for word in _INVALID_WORDS):
        return {
            "status": "invalid",
            "code": "invalid_link",
            "message": "这个链接无效，或内容已被删除、设为私密。请检查链接是否完整。",
            "action": None,
            "detail": detail,
        }

    return {
        "status": "error",
        "code": "extractor_error",
        "message": "这条链接暂时无法读取。请稍后重试；如果一直失败，展开技术详情反馈。",
        "action": None,
        "detail": detail,
    }


def classify_live_api_failure(code, message: str = "") -> dict:
    """B站直播预检接口非 0 时的用户文案。"""
    try:
        numeric = int(code)
    except (TypeError, ValueError):
        numeric = 0
    detail = clean_detail(f"code={code} {message}".strip())
    if numeric in (-352, -412, -403, 403, -401, 401):
        return {
            "status": "unreachable",
            "code": "bilibili_live_blocked",
            "message": ("B站接口暂时拒绝了这次查询（风控/频率限制）。请稍后重试；"
                        "登录 B站可降低触发概率。"),
            "action": dict(LOGIN_ACTIONS["bilibili"]),
            "detail": detail,
        }
    return {
        "status": "invalid",
        "code": "bilibili_live_error",
        "message": "B站没有返回这个直播间的信息，请确认房间号是否正确。",
        "action": dict(LOGIN_ACTIONS["bilibili"]),
        "detail": detail,
    }
