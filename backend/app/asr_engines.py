"""Transcription providers. Provider capabilities describe evidence, not API compatibility."""
from dataclasses import dataclass, field
import base64
import io
import json
import os
import platform
import threading
import time
import urllib.parse
import wave

import numpy as np

import asr
import settings
import text_hygiene

SAMPLE_RATE = 16000
MAX_BASE64_BYTES = 10_000_000
DEFAULT_URL = "https://api.llm.mioffice.cn/v1"
DEFAULT_MODEL = "xiaomi/mimo-v2.5-asr"
ASR_CUSTOM_ACCOUNT = "asr_custom"
KEYCHAIN_SERVICE = "cn.meetclip.asr"


class Cancelled(Exception):
    pass


class _NoiseLoop(Exception):
    """没有人声的片段上，模型把语言标记重复到输出上限：按空结果处理，不再重试。"""


class ProviderError(RuntimeError):
    def __init__(self, message, *, retryable=False, fatal=False):
        super().__init__(message)
        self.retryable, self.fatal = retryable, fatal


# The cloud ASR account is shared and has a request-rate window. Chunk requests used
# to be sent as fast as the network allowed (~2-3/s), which reliably produced HTTP 429
# bands on long meetings. Keep one process-wide pace for every ASR request and pause
# the whole pipeline when the gateway asks us to back off.
ASR_MIN_INTERVAL = max(0.2, float(os.environ.get("MEETCLIP_ASR_MIN_INTERVAL", "1.2")))


def _sleep(seconds, cancel=None):
    deadline = time.monotonic() + max(0.0, float(seconds))
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        if cancel is not None and hasattr(cancel, "wait"):
            if cancel.wait(min(remaining, 0.2)):
                raise Cancelled()
        else:
            time.sleep(min(remaining, 0.2))


def _retry_after(response):
    raw = response.headers.get("retry-after")
    if not raw:
        return None
    try:
        return max(1.0, min(float(raw), 180.0))
    except (TypeError, ValueError):
        return None


class _RequestGate:
    """One shared pace for ASR, plus a global cooldown all callers respect."""

    def __init__(self, interval):
        self.interval = max(0.0, float(interval))
        self._lock = threading.Lock()
        self._next_at = 0.0
        self._cooldown_until = 0.0

    def wait(self, cancel=None):
        with self._lock:
            now = time.monotonic()
            target = max(now, self._next_at, self._cooldown_until)
            self._next_at = target + self.interval
        _sleep(target - now, cancel)

    def cool_down(self, seconds):
        with self._lock:
            self._cooldown_until = max(self._cooldown_until,
                                       time.monotonic() + max(0.0, float(seconds)))


ASR_GATE = _RequestGate(ASR_MIN_INTERVAL)


@dataclass(frozen=True)
class Capabilities:
    chunk_recognition: bool = True
    text_streaming: bool = False
    audio_streaming: bool = False
    timestamps: bool = False
    speakers: bool = False
    hotwords: bool = False
    languages: tuple = ("", "Chinese", "English")


@dataclass
class Recognition:
    text: str
    words: list = field(default_factory=list)
    speaker_segments: list = field(default_factory=list)
    metrics: dict = field(default_factory=dict)


def check_cancel(cancel):
    if cancel and cancel.is_set():
        raise Cancelled()


class CombinedCancel:
    """A pipeline failure aborts recognition without presenting it as user cancellation."""
    def __init__(self, *events):
        self.events = events

    def is_set(self):
        return any(event.is_set() for event in self.events)

    def wait(self, seconds):
        deadline = time.monotonic() + seconds
        while not self.is_set() and time.monotonic() < deadline:
            self.events[0].wait(min(.1, max(0, deadline - time.monotonic())))
        return self.is_set()


def keychain():
    if platform.system() != "Darwin":
        raise ProviderError("云端凭证需要 macOS 钥匙串；不会回退到明文存储")
    try:
        from keyring.backends.macOS import Keyring
        return Keyring()
    except Exception:
        raise ProviderError("缺少钥匙串组件，请更新后端依赖并重启应用") from None


def credential(account="mimo", value=None, delete=False):
    try:
        vault = keychain()
        if delete:
            if vault.get_password(KEYCHAIN_SERVICE, account):
                vault.delete_password(KEYCHAIN_SERVICE, account)
            return None
        if value is not None:
            vault.set_password(KEYCHAIN_SERVICE, account, value)
            return None
        return vault.get_password(KEYCHAIN_SERVICE, account)
    except ProviderError:
        raise
    except Exception:
        raise ProviderError("无法访问 macOS 钥匙串，请检查系统授权") from None


def validate_config(provider, base_url=DEFAULT_URL, model=DEFAULT_MODEL):
    if provider not in PROVIDERS:
        raise ValueError("不支持的转录引擎")
    url = urllib.parse.urlsplit(base_url.strip())
    try:
        port = url.port
    except ValueError:
        raise ValueError("网关端口无效") from None
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment or any(c.isspace() for c in base_url):
        raise ValueError("网关地址必须为 HTTPS，且不能包含凭证、查询参数或片段")
    if not model.strip() or len(model) > 200:
        raise ValueError("模型名称不能为空且最多 200 字符")
    return {"provider": provider, "base_url": base_url.strip().rstrip("/"), "model": model.strip()}


def custom_config(data=None):
    """语音转文字的自定义 API；base 与 model 都填了才算启用。"""
    data = data if data is not None else settings.get_all()
    base = (data.get("asr_custom_base") or "").strip()
    model = (data.get("asr_custom_model") or "").strip()
    if not base or not model:
        return None
    config = validate_config("mimo", base, model)
    config["key_account"] = ASR_CUSTOM_ACCOUNT
    return config


def default_config(provider=None):
    data = settings.get_all()
    provider = provider or data.get("asr_provider", "mimo")
    # 本地识别已下线，历史配置或旧客户端指定的 local 一律回落到云端。
    if provider == "local":
        provider = "mimo"
    if provider == "mimo":
        custom = custom_config(data)
        if custom:
            return custom
    return validate_config(provider, data.get("mimo_base_url", DEFAULT_URL), data.get("mimo_model", DEFAULT_MODEL))


def session_config(sess):
    # Old records always remain local, regardless of the current global default.
    return (sess.get("meta") or {}).get("asr_engine") or {"provider": "local", "base_url": DEFAULT_URL, "model": DEFAULT_MODEL}


def bind_session(sid, provider=None):
    from database import db
    config = default_config(provider)
    db.update_meta(sid, asr_engine=config)
    return config


def resolve(config=None):
    config = config or default_config()
    provider = config.get("provider")
    if provider not in PROVIDERS:
        raise ValueError("不支持的转录引擎")
    return PROVIDERS[provider](config)


def ready(config=None):
    try:
        return resolve(config).is_ready()
    except (ProviderError, ValueError):
        return False


def require_ready(config):
    provider = resolve(config)
    if not provider.is_ready():
        if config.get("key_account") == ASR_CUSTOM_ACCOUNT:
            raise ProviderError("请先为自定义 API 配置 Key")
        raise ProviderError("请先在 设置 → 会摘 → 模型 配置 Mify API Key" if config["provider"] == "mimo"
                            else "请先启用本地语音识别模型")
    return provider


def encode_wav(audio):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        pcm = np.clip(np.asarray(audio) * 32768.0, -32768, 32767).astype("<i2")
        wav.writeframes(pcm.tobytes())
    return output.getvalue()


def split_upload(audio):
    """Validate the actual Base64 payload before sending; split even nonstandard large chunks."""
    data = base64.b64encode(encode_wav(audio)).decode("ascii")
    if len(data) <= MAX_BASE64_BYTES:
        yield audio, data
    else:
        middle = len(audio) // 2
        if not middle:
            raise ProviderError("音频超出上传大小限制")
        yield from split_upload(audio[:middle])
        yield from split_upload(audio[middle:])


class LocalProvider:
    capabilities = Capabilities(timestamps=True, speakers=True, hotwords=True,
                                languages=("", "Chinese", "English", "Cantonese", "Japanese", "Korean",
                                           "French", "German", "Spanish", "Russian"))
    def __init__(self, config):
        self.config = config

    def is_ready(self):
        return asr.manager.is_ready()

    def transcribe_long(self, audio, **options):
        return asr.manager.transcribe_long(audio, **options)

    def detect_language(self, audio):
        return asr.manager.detect_language(audio)

    def recognize(self, audio, *, language="", cancel=None, on_partial=None):
        check_cancel(cancel)
        text = asr.manager.transcribe(audio)
        check_cancel(cancel)
        return Recognition(text)


class MiMoProvider:
    capabilities = Capabilities(text_streaming=True)

    def __init__(self, config):
        self.config = config

    def _account(self):
        return self.config.get("key_account") or "mimo"

    def _key(self):
        """测试连接可以带一把还没保存的 Key；正式识别仍走钥匙串。"""
        direct = (self.config.get("api_key") or "").strip()
        return direct or credential(self._account())

    def is_ready(self):
        return bool(self.config.get("api_key")) or bool(credential(self._account()))

    def recognize(self, audio, *, language="", cancel=None, on_partial=None):
        lang = {"": "auto", "auto": "auto", "Chinese": "zh", "zh": "zh", "English": "en", "en": "en"}.get(language)
        if lang is None:
            raise ProviderError("MiMo 当前仅支持自动、中文和英文语种选项", fatal=True)
        try:
            key = self._key()
        except ProviderError as exc:
            raise ProviderError(str(exc), fatal=True) from None
        if not key:
            raise ProviderError("请先为自定义 API 配置 Key" if self._account() == ASR_CUSTOM_ACCOUNT
                                else "请先配置 Mify API Key", fatal=True)
        text_parts, metrics = [], []
        for _, encoded in split_upload(audio):
            previous = "".join(text_parts)
            result = self._request(encoded, key, lang, cancel,
                                   lambda text: on_partial(previous + text) if on_partial else None)
            text_parts.append(result.text)
            metrics.append(result.metrics)
        return Recognition("".join(text_parts), metrics={"requests": metrics})

    def _request(self, encoded, key, language, cancel, on_partial):
        import httpx
        payload = {"model": self.config["model"], "messages": [{"role": "user", "content": [{
            "type": "input_audio", "input_audio": {"data": "data:audio/wav;base64," + encoded}}]}],
            "asr_options": {"language": language}, "stream": True}
        # Reject redirects so bearer credentials cannot be forwarded to another gateway.
        for attempt in range(5):
            check_cancel(cancel)
            ASR_GATE.wait(cancel)
            started = time.monotonic()
            text, first, finish_reason, terminal = "", None, None, False
            # 每积累 400 字检查一次：整段只有 `<chinese>` 之类的标记就立刻掐断，既是空片段，
            # 也省掉模型把标记刷到输出上限的那一整段请求。
            checked = 0
            try:
                with httpx.Client(timeout=httpx.Timeout(30, connect=8), follow_redirects=False) as client:
                    with client.stream("POST", self.config["base_url"] + "/chat/completions",
                                       headers={"Authorization": "Bearer " + key}, json=payload) as response:
                        if response.status_code != 200:
                            code = response.status_code
                            if code == 429:
                                # Prefer the gateway's own advice; otherwise back off long enough
                                # for a per-minute window to rotate.
                                ASR_GATE.cool_down(_retry_after(response) or min(60.0, 4.0 * (2 ** attempt)))
                            elif code >= 500:
                                ASR_GATE.cool_down(min(15.0, 2.0 * (attempt + 1)))
                            raise ProviderError("MiMo 凭证无效或无模型权限" if code in (401, 403) else
                                                f"MiMo 请求失败（HTTP {code}）",
                                                retryable=code == 429 or code >= 500, fatal=code in (401, 403))
                        deadline = started + 120
                        def consume(data):
                            nonlocal text, first, finish_reason, terminal, checked
                            if data == "[DONE]":
                                terminal = True
                                return
                            obj = json.loads(data)
                            if obj.get("error"):
                                raise ProviderError("MiMo 返回识别错误", retryable=True)
                            for choice in obj.get("choices", []):
                                content = (choice.get("delta") or choice.get("message") or {}).get("content")
                                if isinstance(content, str) and content:
                                    if first is None:
                                        first = time.monotonic() - started
                                    text += content
                                    if len(text) >= checked + 400:
                                        checked = len(text)
                                        if text_hygiene.noise(text):
                                            raise _NoiseLoop()
                                    on_partial(text)
                                if choice.get("finish_reason"):
                                    finish_reason = choice["finish_reason"]
                                    terminal = True
                        if "text/event-stream" in response.headers.get("content-type", ""):
                            event = []
                            for line in response.iter_lines():
                                check_cancel(cancel)
                                if time.monotonic() > deadline:
                                    raise ProviderError("MiMo 识别超时", retryable=True)
                                if not line:
                                    if event:
                                        consume("\n".join(event))
                                        event = []
                                    if terminal:
                                        break
                                elif line.startswith("data:"):
                                    event.append(line[5:].lstrip())
                            if event:
                                consume("\n".join(event))
                        else:
                            # Some gateways ignore stream=true and return one JSON completion.
                            response.read()
                            consume(response.text)
                        check_cancel(cancel)
                        if finish_reason in ("content_filter", "error"):
                            raise ProviderError("MiMo 未完成识别，片段结果未提交")
                        if finish_reason == "length":
                            # 一整段都是语言标记：这是空白片段，不是被截断的语音。
                            if text_hygiene.noise(text):
                                raise _NoiseLoop()
                            raise ProviderError("MiMo 输出被截断，请缩短音频片段")
                        if not terminal:
                            raise ProviderError("MiMo 响应中断，片段尚未完成", retryable=True)
                        return Recognition(text_hygiene.strip_tags(text).strip(),
                            metrics={"first_text_seconds": first,
                            "total_seconds": time.monotonic() - started, "attempts": attempt + 1,
                            "streamed": "text/event-stream" in response.headers.get("content-type", "")})
            except _NoiseLoop:
                # 空白片段：请求已作废，返回空结果让上层跳过这一段（不重试、不写转写）。
                return Recognition("", metrics={"noise_only": True, "first_text_seconds": first,
                    "total_seconds": time.monotonic() - started, "attempts": attempt + 1})
            except Cancelled:
                raise
            except (httpx.HTTPError, httpx.InvalidURL, ValueError):
                error = ProviderError("MiMo 网络连接或响应解析失败，请检查公司网络／VPN", retryable=True)
            except ProviderError as exc:
                error = exc
            if not error.retryable or attempt == 4:
                raise error from None
            # A retry replaces the same preview instead of appending to its interrupted text.
            on_partial("")
            # 429 already set a cooldown above; network/stream errors get a short one.
            ASR_GATE.cool_down(min(30.0, 2.0 * (attempt + 1)))
            check_cancel(cancel)


# New vendors register their own protocol implementation here.
PROVIDERS = {"local": LocalProvider, "mimo": MiMoProvider}


def status():
    config = default_config()
    account = config.get("key_account") or "mimo"
    try:
        has_key = bool(credential(account))
        mify_has_key = bool(credential("mimo"))
        custom_has_key = bool(credential(ASR_CUSTOM_ACCOUNT))
        key_error = ""
    except ProviderError as exc:
        has_key, mify_has_key, custom_has_key = False, False, False
        key_error = str(exc)
    data = settings.get_all()
    custom_base = (data.get("asr_custom_base") or "").strip()
    custom_model = (data.get("asr_custom_model") or "").strip()
    from dataclasses import asdict
    return {"default_provider": config["provider"], "base_url": config["base_url"], "model": config["model"],
            "mify_base_url": data.get("mimo_base_url", DEFAULT_URL), "mify_model": data.get("mimo_model", DEFAULT_MODEL),
            "has_api_key": has_key, "mify_has_key": mify_has_key, "credential_error": key_error, "ready": ready(config),
            "custom": {"base_url": custom_base, "model": custom_model,
                       "enabled": bool(custom_base and custom_model), "has_key": custom_has_key},
            "providers": [{"id": name, "capabilities": asdict(cls.capabilities)} for name, cls in PROVIDERS.items()]}
