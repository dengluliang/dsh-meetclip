"""转写语种：用户选择的默认值与记录里的语种提示。

历史记录把「自动识别」存成空字符串（甚至 None），新记录统一用 "auto" 明确
表示自动；空值/缺省表示「跟随设置里的默认语种」。默认语种默认是中文，
避免云端 ASR 在几十秒的片头里把中文直播/视频判成阿拉伯语之类的语种。
"""
import settings

AUTO = "auto"
DEFAULT = "Chinese"
LANGUAGES = [
    (AUTO, "自动识别"), ("Chinese", "中文"), ("English", "英文"), ("Cantonese", "粤语"),
    ("Japanese", "日语"), ("Korean", "韩语"), ("French", "法语"), ("German", "德语"),
    ("Spanish", "西班牙语"), ("Russian", "俄语"),
]
CHOICES = tuple(key for key, _ in LANGUAGES)
# 云端识别与 Agent 调用常用短代码；保存前先归一，换引擎时也不会因为 "en" 落回默认中文。
ALIASES = {
    "zh": "Chinese", "zh-cn": "Chinese", "zh-hans": "Chinese", "cmn": "Chinese",
    "en": "English", "en-us": "English", "en-gb": "English",
    "yue": "Cantonese", "ja": "Japanese", "ko": "Korean",
    "fr": "French", "de": "German", "es": "Spanish", "ru": "Russian",
}
# 字幕轨用 BCP-47 前缀匹配「中文 / 英文 / 日语…」，与 ASR 的中文名分开。
CODES = {
    "Chinese": ("zh",), "English": ("en",), "Cantonese": ("yue",), "Japanese": ("ja",),
    "Korean": ("ko",), "French": ("fr",), "German": ("de",), "Spanish": ("es",),
    "Russian": ("ru",),
}


def normalize(value):
    text = str(value or "").strip()
    if not text:
        return ""
    return ALIASES.get(text.lower(), text)


def default():
    """没有单独指定语种时使用的语种；设置里的值不合法就回到中文。"""
    value = normalize(settings.get("asr_language"))
    return value if value in CHOICES else DEFAULT


def resolve(hint):
    """记录 / 请求里的语种提示 → 实际转写语种。

    None、空字符串和无法识别的旧值都按「没有指定」处理，跟随默认语种；
    "auto" 与具体语种原样保留。
    """
    value = normalize(hint)
    if not value or value not in CHOICES:
        return default()
    return value


def is_auto(value):
    return normalize(value) == AUTO


def code_prefixes(language):
    """具体语种对应的字幕轨代码前缀；自动识别返回空元组。"""
    return CODES.get(normalize(language), ())
