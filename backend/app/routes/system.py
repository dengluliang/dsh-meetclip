"""采集组件、B站登录态与应用设置。"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import bilibili
import capture
import deps
import douyin
import settings

router = APIRouter()


@router.get("/api/deps")
def deps_status():
    return capture.deps_status()


@router.get("/api/deps/install/status")
def install_status():
    return deps.status()


@router.post("/api/deps/install")
def install_deps():
    return deps.start()


# ---------------- B站登录态（复用 Chrome） ----------------
@router.get("/api/bilibili/status")
def bili_status():
    return bilibili.status()


@router.post("/api/bilibili/refresh")
def bili_refresh():
    return bilibili.ensure_login(capture.DEPS["yt_dlp"], force_import=True)


@router.post("/api/bilibili/qr")
def bili_qr():
    try:
        return bilibili.qr_start()
    except Exception as e:
        raise HTTPException(502, f"无法连接 B站：{e}")


@router.get("/api/bilibili/qr/{key}")
def bili_qr_poll(key: str):
    try:
        return bilibili.qr_poll(key)
    except Exception as e:
        return {"state": "error", "message": f"网络异常：{e}"}


@router.post("/api/bilibili/logout")
def bili_logout():
    return bilibili.logout()


# ---------------- 抖音登录态（浏览器扫码 + Cookie 导入） ----------------
class DouyinImportReq(BaseModel):
    browser: str | None = None


class DouyinTestReq(BaseModel):
    url: str = ""


@router.get("/api/douyin/status")
def douyin_status():
    return douyin.status()


@router.post("/api/douyin/open")
def douyin_open():
    try:
        return douyin.open_login()
    except Exception as e:
        raise HTTPException(502, str(e))


@router.post("/api/douyin/permission")
def douyin_permission():
    try:
        return douyin.open_permission()
    except Exception as e:
        raise HTTPException(502, str(e))


@router.post("/api/douyin/import")
def douyin_import(req: DouyinImportReq):
    browser = (req.browser or settings.get_all().get("link_cookie_browser") or "chrome").lower()
    if browser not in settings.COOKIE_BROWSERS:
        raise HTTPException(400, "不支持的浏览器，可选：" + "、".join(settings.COOKIE_BROWSERS))
    try:
        return douyin.import_cookies(browser)
    except Exception as e:
        raise HTTPException(502, str(e))


@router.post("/api/douyin/logout")
def douyin_logout():
    return douyin.clear()


@router.post("/api/douyin/test")
def douyin_test(req: DouyinTestReq):
    import link_video
    url = (req.url or "").strip() or douyin.last_url()
    if not url:
        raise HTTPException(400, "请先在首页添加一个抖音链接，再测试连接")
    return link_video.preview(url)


# ---------------- 应用设置（截图灵敏度） ----------------
class SettingsReq(BaseModel):
    shot_sensitivity: float | None = None
    link_browser_cookies: bool | None = None
    link_cookie_browser: str | None = None
    link_max_height: int | None = None


@router.get("/api/settings")
def settings_get():
    data = settings.get_all()
    data["shot_threshold"] = capture.sensitivity_threshold(data["shot_sensitivity"])
    return data


@router.post("/api/settings")
def settings_set(req: SettingsReq):
    changes = {}
    if req.shot_sensitivity is not None:
        changes["shot_sensitivity"] = min(1.0, max(0.0, req.shot_sensitivity))
    if req.link_browser_cookies is not None:
        changes["link_browser_cookies"] = bool(req.link_browser_cookies)
    if req.link_cookie_browser is not None:
        browser = req.link_cookie_browser.strip().lower() or "chrome"
        if browser not in settings.COOKIE_BROWSERS:
            raise HTTPException(400, "不支持的浏览器，可选：" + "、".join(settings.COOKIE_BROWSERS))
        changes["link_cookie_browser"] = browser
    if req.link_max_height is not None:
        changes["link_max_height"] = max(0, min(2160, int(req.link_max_height)))
    data = settings.update(**changes) if changes else settings.get_all()
    data["shot_threshold"] = capture.sensitivity_threshold(data["shot_sensitivity"])
    return data

