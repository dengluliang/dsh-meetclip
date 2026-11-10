"""应用级本地设置（截图灵敏度等），保存在 data/settings.json。"""
import json
import os
import threading

from shared_paths import SHARED_DIR

# 账号与通用设置全库共用：多资料空间下指向共享目录，单库时仍是数据目录。
PATH = SHARED_DIR / "settings.json"
COOKIE_BROWSERS = ("chrome", "safari", "firefox", "edge", "brave", "chromium")
DEFAULTS = {
    "asr_provider": "mimo",
    "mimo_base_url": "https://api.llm.mioffice.cn/v1",
    "mimo_model": "xiaomi/mimo-v2.5-asr",
    # 语音转文字的自定义 API（留空表示使用 Mify 默认）
    "asr_custom_base": "",
    "asr_custom_model": "",
    "shot_sensitivity": 0.6,
    # 链接视频默认只访问公开内容；用户在设置中明确开启后才读取浏览器 Cookie。
    "link_browser_cookies": False,
    "link_cookie_browser": "chrome",
    "link_max_height": 0,
    # ---- AI 纪要（文本模型与 ASR 是两回事，可以指向不同服务） ----
    "ai_provider": "mimo",
    "ai_base_url": "",          # 空 = 用供应商默认地址（Mify 网关照旧）
    "ai_text_model": "",        # 空 = 用供应商推荐模型
    "minutes_auto": "final",    # off 不开 | final 结束时生成一次 | live 边录边更新
    "minutes_interval": 120,    # live 模式下的最小更新间隔（秒）
    "minutes_language": "简体中文",
    # ---- 没人说话时自动结束采集 ----
    "auto_end_silence": "prompt",  # off | prompt（先问一句）| end（直接停）
    "auto_end_after": 600,         # 连续多少秒没有识别出词
}
_lock = threading.Lock()
_cache = None


def _load():
    data = dict(DEFAULTS)
    try:
        stored = json.loads(PATH.read_text(encoding="utf-8"))
        if isinstance(stored, dict):
            data.update(stored)
    except Exception:
        pass
    if data.get("link_cookie_browser") not in COOKIE_BROWSERS:
        data["link_cookie_browser"] = "chrome"
    return data


def _write(data):
    """先写临时文件再原子替换，避免写到一半时崩溃留下损坏的设置文件。"""
    PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = PATH.with_name(PATH.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, PATH)


def get_all():
    global _cache
    with _lock:
        if _cache is None:
            _cache = _load()
        return dict(_cache)


def get(key):
    return get_all().get(key, DEFAULTS.get(key))


def update(**kw):
    global _cache
    with _lock:
        data = dict(_cache if _cache is not None else _load())
        data.update(kw)
        _write(data)
        _cache = data
        return dict(data)


def remove(*keys):
    """从本地设置中删除字段（例如已废弃的 hf_token）"""
    global _cache
    with _lock:
        data = dict(_cache if _cache is not None else _load())
        if not any(k in data for k in keys):
            return
        for k in keys:
            data.pop(k, None)
        _write(data)
        _cache = data
