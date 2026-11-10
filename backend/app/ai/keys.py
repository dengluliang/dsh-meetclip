"""文本模型的密钥：只进 macOS 钥匙串，不回退到明文文件，也不写进日志与导出。

服务和 ASR 共用同一个钥匙串服务名，但用不同 account：
- `mimo` 是云识别用的那把（设置 → 模型）；
- `ai` 是纪要/说话人猜名用的那把，未单独设置时沿用 `mimo`（同一个网关同一把 key）。
"""
import os

import asr_engines

ACCOUNT = "ai"
FALLBACK_ACCOUNT = "mimo"


def _env_override() -> str | None:
    """测试与本地调试用：设置了 MEETCLIP_AI_KEY 时直接用它，不碰钥匙串。"""
    value = (os.environ.get("MEETCLIP_AI_KEY") or "").strip()
    return value or None


def own() -> str | None:
    """只返回用户为纪要单独保存的 Key，不沿用云识别那把。"""
    try:
        return asr_engines.credential(ACCOUNT) or None
    except asr_engines.ProviderError:
        return None


def get(provider: str = "mimo") -> str | None:
    override = _env_override()
    if override:
        return override
    try:
        key = asr_engines.credential(ACCOUNT)
        if not key and provider == "mimo":
            key = asr_engines.credential(FALLBACK_ACCOUNT)
        return key or None
    except asr_engines.ProviderError:
        return None


def credential_error() -> str:
    if _env_override():
        return ""
    try:
        asr_engines.credential(ACCOUNT)
        return ""
    except asr_engines.ProviderError as exc:
        return str(exc)


def save(value: str, provider: str = "mimo") -> None:
    value = (value or "").strip()
    if not value:
        raise ValueError("API Key 不能为空")
    asr_engines.credential(ACCOUNT, value=value)


def remove() -> None:
    asr_engines.credential(ACCOUNT, delete=True)


def masked(key: str | None) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "sk-…"
    return key[:3] + "•" * 12 + key[-4:]
