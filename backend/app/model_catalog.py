"""只读拉取网关的模型目录：用于设置页与首次引导的模型选择。

不写盘、不缓存、不记日志；失败一律转成可展示的中文原因。

OpenAI 兼容网关的 `/models` 会给每个模型一个 `owned_by`（供应商）。多数网关要求
调用时写成 `供应商/模型名`，而列表里的 `id` 往往不带供应商；同一个 `id` 还可能
由不同供应商提供（例如 `deepseek-v4-flash` 同时挂在 deepseek 与 volcengine_maas
下）。因此这里统一按 `owned_by` 补出可直接调用的模型名，避免用户在引导里选中
一个“看起来对、实际调不通”的裸 id。
"""
from __future__ import annotations

import re
import time
from concurrent.futures import ThreadPoolExecutor

import httpx

TIMEOUT = 20.0


class CatalogError(Exception):
    """目录获取失败，消息可直接展示给用户。"""


def qualify(name: str, vendor: str = "") -> str:
    """把目录里的裸 id 补成可调用模型名；已经带供应商的保持原样。"""
    model = (name or "").strip()
    owner = (vendor or "").strip()
    if not model or "/" in model or not owner:
        return model
    return owner + "/" + model


def fetch_entries(base_url: str, api_key: str, timeout: float = TIMEOUT) -> list[dict]:
    """返回 `[{id, vendor, wire}]`：`id` 是网关原始名，`wire` 是可直接调用名。"""
    base = (base_url or "").strip().rstrip("/")
    key = (api_key or "").strip()
    if not base.startswith("https://"):
        raise CatalogError("网关地址必须为 HTTPS")
    if not key:
        raise CatalogError("尚未配置 API Key")
    try:
        with httpx.Client(timeout=timeout, follow_redirects=False) as client:
            response = client.get(base + "/models", headers={"Authorization": "Bearer " + key})
    except httpx.TimeoutException:
        raise CatalogError("连接网关超时，请稍后重试") from None
    except (httpx.HTTPError, httpx.InvalidURL):
        raise CatalogError("连不上网关，请检查网络或代理") from None
    if response.status_code in (401, 403):
        raise CatalogError("API Key 无效或没有模型权限")
    if response.status_code != 200:
        raise CatalogError(f"网关返回 HTTP {response.status_code}")
    try:
        data = response.json()
    except ValueError:
        raise CatalogError("网关没有返回模型列表") from None

    seen: set[str] = set()
    entries: list[dict] = []
    for item in data.get("data") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("id") or "").strip()
        if not name or name.endswith(":batch"):
            continue
        vendor = str(item.get("owned_by") or "").strip()
        wire = qualify(name, vendor)
        if not wire or wire in seen:
            continue
        seen.add(wire)
        entries.append({"id": name, "vendor": vendor, "wire": wire,
                        "kind": str(item.get("model_type") or "").strip()})
    return entries


SPEECH = re.compile(r"asr|transcribe|whisper", re.I)
SPEECH_DROP = re.compile(r"tts|voiceclone|voicedesign", re.I)
NON_TEXT = ("embed", "rerank", "ocr", "tts", "voiceclone", "voicedesign",
            "image", "moderation", "realtime", "sora", "dall-e", "whisper")
CHAT_TIMEOUT = 12.0
SPEECH_CONCURRENCY = 2


def kind_of(entry: dict) -> str:
    """目录条目大致的用途：`speech` / `text` / `other`。

    优先用网关给的 `model_type`；没有时退回按名字猜，与界面里的分类保持一致。
    """
    name = str(entry.get("id") or "")
    # 先看名字：网关会把 `mimo-v2.5-asr`、`mimo-v2.5-tts` 这类也标成 llm，
    # 只信 model_type 会把它们放进文字下拉，选中必然 400。
    if SPEECH_DROP.search(name):
        return "other"
    if SPEECH.search(name):
        return "speech"
    lowered = name.lower()
    if any(token in lowered for token in NON_TEXT):
        return "other"
    kind = str(entry.get("kind") or "").lower()
    if kind == "speech2text":
        return "speech"
    if kind in ("text-embedding", "image_generation", "video_generation", "rerank", "tts"):
        return "other"
    return "text"


def _chat_probe(base_url: str, api_key: str, model: str, timeout: float) -> tuple[bool, int, str]:
    """用 1 token 的对话请求判断模型对这个 Key 是否可用。

    权限不足的模型会被网关立刻拒绝（通常 401/403），几乎不花钱；
    可用的模型才会真正跑一次极短推理。
    """
    body = {"model": model, "messages": [{"role": "user", "content": "好"}],
            "max_tokens": 1, "stream": False}
    try:
        with httpx.Client(timeout=httpx.Timeout(timeout, connect=min(8, timeout)),
                          follow_redirects=False) as client:
            response = client.post(base_url.rstrip("/") + "/chat/completions",
                                   headers={"Authorization": "Bearer " + api_key}, json=body)
    except httpx.TimeoutException:
        return False, 0, "探测超时"
    except (httpx.HTTPError, httpx.InvalidURL):
        return False, 0, "连不上网关"
    if response.status_code == 200:
        return True, 200, ""
    try:
        payload = response.json()
        error = payload.get("error") if isinstance(payload, dict) else None
        reason = str((error or {}).get("message") or payload.get("detail") or "").strip()
    except ValueError:
        reason = (response.text or "").strip()[:120]
    return False, response.status_code, (reason or f"HTTP {response.status_code}")[:160]


def _verdict(status: int, reason: str) -> str:
    """把一次探测的失败分成三类，只有「明确不可用」的才从列表里删掉。

    - denied：权限/供应商问题，换什么参数都调不通；
    - broken：网关自己 5xx 或返回了 HTML，模型基本没部署好；
    - unknown：请求被拒但原因可能与探测用的小请求有关（例如 400 参数），
      这类保留在列表里，交给正式调用再报错，避免误删能用的模型。
    """
    text = reason or ""
    if status in (401, 403) or any(token in text for token in
                                   ("不在 Key 的可用模型范围", "未指定供应商", "invalid api key")):
        return "denied"
    missing = ("not supported model", "model not found", "does not exist",
               "invalid_model", "unsupported model", "不支持")
    if (status == 404 or status >= 500 or "<html" in text.lower()
            or "bad gateway" in text.lower()
            or any(token in text.lower() for token in missing)):
        return "broken"
    return "unknown"


def _probe_one(entry: dict, base_url: str, api_key: str, timeout: float) -> tuple[str, str, str]:
    wire = entry["wire"]
    if kind_of(entry) == "speech":
        # 语音模型只有几个候选，且 1 秒静音探测与正式请求差异大，这里不做筛选。
        return wire, "usable", ""
    ok, status, reason = _chat_probe(base_url, api_key, wire, timeout)
    return wire, ("usable" if ok else _verdict(status, reason)), reason


def probe_usable(entries: list[dict], base_url: str, api_key: str, *,
                 concurrency: int = 8, timeout: float = CHAT_TIMEOUT) -> dict:
    """并发探测目录里的文本模型，返回可用的与被明确拒绝的。

    embedding / 生图 / 重排 / TTS 本功能用不上，语音模型另走 1 秒静音验证，
    都不在这里探测。
    """
    started = time.monotonic()
    candidates = [entry for entry in entries if kind_of(entry) == "text"]
    usable: list[str] = []
    hidden: list[dict] = []
    unknown: list[dict] = []
    if candidates:
        with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
            results = list(pool.map(lambda entry: _probe_one(entry, base_url, api_key, timeout), candidates))
        for wire, verdict, reason in results:
            if verdict == "usable":
                usable.append(wire)
            elif verdict in ("denied", "broken"):
                hidden.append({"model": wire, "reason": reason, "kind": verdict})
            else:
                unknown.append({"model": wire, "reason": reason})
    return {
        "usable": usable,
        "hidden": hidden[:60],
        "unknown": unknown[:40],
        "checked": len(candidates),
        "elapsed": round(time.monotonic() - started, 2),
    }


def fetch_models(base_url: str, api_key: str, timeout: float = TIMEOUT) -> list[str]:
    """只取可直接调用的模型名（带供应商前缀），供选择与保存。"""
    return [entry["wire"] for entry in fetch_entries(base_url, api_key, timeout)]
