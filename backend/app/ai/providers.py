"""AI 文本服务的供应商表。

同一份提示词在不同网关上有各自的怪癖：思考开关字段不同、有的网关会把"像问题"的用户消息当成
搜索请求、有的不支持 response_format。把这些差异集中在这里，调用方只关心优先级与提示词。

``mimo`` 这一档不预置地址与模型：地址与模型由用户在设置 →模型里填写自己的 OpenAI 兼容服务，
开源版本因此不带任何组织内部网关信息。
"""
from dataclasses import dataclass
import os

import settings

DEFAULT_BASE = ""
DEFAULT_MODEL = ""

# 设置里的语言名 → 提示词里的英文名。纪要必须用同一套写法，否则语言校验会误判。
LANGUAGE_NAMES = {
    "": "Simplified Chinese", "auto": "Simplified Chinese",
    "中文": "Simplified Chinese", "简体中文": "Simplified Chinese", "zh": "Simplified Chinese",
    "Chinese": "Simplified Chinese", "Simplified Chinese": "Simplified Chinese",
    "English": "English", "英文": "English", "en": "English",
    "日本語": "Japanese", "Japanese": "Japanese", "日语": "Japanese", "ja": "Japanese",
    "한국어": "Korean", "Korean": "Korean", "韩语": "Korean", "ko": "Korean",
    "繁體中文": "Traditional Chinese", "Traditional Chinese": "Traditional Chinese",
}
LANGUAGE_CHOICES = ("Simplified Chinese", "Traditional Chinese", "English", "Japanese", "Korean")

CJK_LANGUAGES = ("Chinese", "Japanese", "Korean")


@dataclass(frozen=True)
class Config:
    provider: str
    base: str
    model: str
    spacing: float
    json_mode: bool
    # 思考开关的写法：ling / reasoning / effort / none
    thinking: str = "reasoning"

    @property
    def chat_url(self) -> str:
        return self.base.rstrip("/") + "/chat/completions"

    @property
    def models_url(self) -> str:
        return self.base.rstrip("/") + "/models"

    @property
    def model_prefix(self) -> str:
        """兜底前缀：网关没有 `owned_by` 时，用它把裸模型名补成「供应商/模型名」。"""
        return os.environ.get("MEETCLIP_AI_MODEL_PREFIX", "").strip().strip("/")


def qualify_model(model: str, vendor: str = "") -> str:
    """按供应商补全模型名：`mimo-v2.6-flash` + `xiaomi` → `xiaomi/mimo-v2.6-flash`。

    已经带供应商的模型名（含 `/`）保持原样，避免重复拼接。
    """
    value = (model or "").strip()
    owner = (vendor or "").strip()
    if not value or "/" in value or not owner:
        return value
    return owner + "/" + value


PROVIDERS = {
    "mimo": dict(name="默认网关（OpenAI 兼容）", base=DEFAULT_BASE, models=(), spacing=0.6,
                 json_mode=True, thinking="reasoning"),
    "openai": dict(name="OpenAI", base="https://api.openai.com/v1",
                   models=("gpt-4o-mini", "gpt-4.1-mini"), spacing=0.1, json_mode=True, thinking="effort"),
    "custom": dict(name="自定义（OpenAI 兼容）", base="", models=(), spacing=0.1, json_mode=False,
                   thinking="reasoning"),
}


def provider_ids():
    return tuple(PROVIDERS)


def _clean_base(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    if "://" not in value:
        value = ("http://" if value.startswith(("localhost", "127.0.0.1")) else "https://") + value
    return value.rstrip("/")


def resolve(data: dict | None = None) -> Config:
    """从设置里解析出本次调用该用哪个服务；缺项留给调用方提示用户填写。"""
    data = dict(data if data is not None else settings.get_all())
    provider = (data.get("ai_provider") or "mimo").strip()
    if provider not in PROVIDERS:
        provider = "mimo"
    meta = PROVIDERS[provider]
    # 设置页优先；其次环境变量（便于 CI / 无界面部署），最后才用元数据里的默认值。
    base = _clean_base(data.get("ai_base_url") or meta["base"] or data.get("mimo_base_url")
                       or os.environ.get("MEETCLIP_AI_BASE_URL", "") or DEFAULT_BASE)
    # 没填就留空，由调用方给出「请先填写服务地址 / 模型」的提示，而不是偷用内置地址。
    model = ((data.get("ai_text_model") or "").strip()
             or (os.environ.get("MEETCLIP_AI_MODEL", "") or "").strip()
             or (meta["models"][0] if meta["models"] else DEFAULT_MODEL))
    # 测试可以调小限速间隔（默认按账号配额）。
    spacing = float(os.environ.get("MEETCLIP_AI_SPACING") or meta["spacing"])
    return Config(provider=provider, base=base, model=model, spacing=spacing,
                  json_mode=bool(meta["json_mode"]), thinking=meta["thinking"])


def wire_model(config: Config, model: str | None = None) -> str:
    """得到真正发出去的模型名。

    正常路径下设置里存的就是目录补好的 `供应商/模型名`，这里原样透传；只有老配置
    或手工填的裸名才用 `MEETCLIP_AI_MODEL_PREFIX` 兜底补前缀。OpenAI/自定义服务
    不会因此被改写。
    """
    value = (model or config.model or "").strip()
    prefix = config.model_prefix
    if prefix and value and "/" not in value:
        return qualify_model(value, prefix)
    return value


# 有些网关对特定模型固定了 temperature（例如 moonshot/kimi-k3.1-pro 只允许 0.6），
# 统一发 0.2 会被 400 拒绝。被拒绝过一次就记住这个「地址 + 模型」，之后不再发，
# 让网关用它自己的默认值；换模型或换网关时按新的键重新判断。
TEMPERATURE_BLOCKED: set[tuple[str, str]] = set()


def _temperature_key(config: Config, model) -> tuple[str, str]:
    return (str(config.base or "").rstrip("/"), str(model or "").strip())


def temperature_blocked(config: Config, model) -> bool:
    return _temperature_key(config, model) in TEMPERATURE_BLOCKED


def block_temperature(config: Config, model) -> None:
    TEMPERATURE_BLOCKED.add(_temperature_key(config, model))


def reset_temperature_blocks() -> None:
    """测试与切换配置时清空记忆。"""
    TEMPERATURE_BLOCKED.clear()


def shape(config: Config, body: dict, max_tokens: int) -> dict:
    """按供应商把请求体塑形：关掉思考，用各自接受的 token 字段。"""
    if config.thinking == "effort":
        body["max_completion_tokens"] = max_tokens
        body["reasoning_effort"] = "none"
    else:
        body["max_tokens"] = max_tokens
        if not temperature_blocked(config, body.get("model")):
            body["temperature"] = 0.2
        if config.thinking == "reasoning":
            # 部分网关只认 reasoning_effort=none 才真的关思考；只发 reasoning.enabled=false
            # 时思考仍会跑满 max_tokens，正文被挤成空字符串（实测 3000 token 全被思考吃掉）。
            body["reasoning"] = {"enabled": False}
            body["reasoning_effort"] = "none"
    body["stream"] = False
    return body


def language_name(value: str) -> str:
    """设置里的语言写法 → 提示词用的英文名。"""
    value = (value or "").strip()
    return LANGUAGE_NAMES.get(value, value or "Simplified Chinese")


def wants_cjk(language: str) -> bool:
    """中文（含简繁）、日文、韩文都要求纪要里 CJK 占相当比例。"""
    return any(name in (language or "") for name in CJK_LANGUAGES)


def english_language(code: str) -> str:
    """语种代码/名称 → 提示词里的英文名（"zh" → "Simplified Chinese"）。"""
    code = (code or "").strip()
    simple = {"zh": "Simplified Chinese", "zh-CN": "Simplified Chinese", "en": "English",
              "ja": "Japanese", "ko": "Korean", "yue": "Cantonese", "fr": "French",
              "de": "German", "es": "Spanish", "ru": "Russian"}
    if code in simple:
        return simple[code]
    return LANGUAGE_NAMES.get(code, code or "Simplified Chinese")
