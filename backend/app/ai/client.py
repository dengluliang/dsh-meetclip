"""一次可预期的文本对话：限速 → 塑形 → 发起 → 反劫持 → 指标。

三条从知了（Cicada）验证过的经验：
1. **思考必须显式关掉**，否则慢且计费（每家写法不同，见 providers.shape）；
2. **内容放 system message、user message 只放固定指令**：有的网关会把"像问题"的用户消息当成
   搜索请求，回一篇"根据检索…"的作文；命中这类开头就丢弃重试；
3. **重试要分档**：纪要可以等，429 时指数退避重试；实时类请求只试一次就交给上层降级。
"""
from __future__ import annotations

import json
import time

import httpx

from ai import gate as gate_mod
from ai import keys, metrics, providers

# 用途 → 优先级（数字小的先发）。实时类用途以后接字幕翻译时用 0/1。
PRIORITY = {"test": 0, "translate": 1, "notes": 2, "speakers": 2}

# 网关把请求当成搜索/闲聊时，回复会以这些开头；这类回复一律丢弃。
HIJACK_PREFIXES = ("根据检索", "根据现有检索", "根据以上检索", "暂未找到足够可靠",
                   "Here is the translation", "Here's the translation", "Sure, here")
ERRORS = {
    "no_key": "尚未配置 AI Key",
    "invalid_key": "AI Key 无效或无模型权限",
    "rate_limited": "AI 服务限流，请稍后再试",
    "timeout": "AI 服务响应超时",
    "network": "连不上 AI 服务，请检查网络或代理",
    "hijacked": "AI 回复像是检索/闲聊而不是结果",
    "empty": "AI 返回了空内容",
    "truncated": "AI 输出被截断（思考占满或内容过长）",
}


class Failure(Exception):
    def __init__(self, kind: str, message: str = "", status: int | None = None):
        super().__init__(message or ERRORS.get(kind, kind))
        self.kind = kind
        self.status = status

    @property
    def retryable(self) -> bool:
        return self.kind in ("rate_limited", "timeout", "network", "hijacked")


def has_key(provider: str | None = None) -> bool:
    config = providers.resolve()
    return bool(keys.get(provider or config.provider))


def usable() -> bool:
    return has_key()


def _content(root: dict) -> str:
    choices = root.get("choices") or []
    if not choices:
        raise Failure("parse", "AI 回复格式不认识（没有 choices）")
    choice = choices[0]
    message = choice.get("message") or {}
    text = message.get("content")
    if isinstance(text, list):  # 少数网关把内容拆成多段
        text = "".join(str(part.get("text", "")) for part in text if isinstance(part, dict))
    text = str(text or "")
    if not text.strip() and choice.get("finish_reason") == "length":
        # 思考模型把预算烧完时 content 是 null；这属于截断，不是真的"空内容"。
        raise Failure("truncated")
    return text


def _strip_reasoning(text: str) -> str:
    for marker in ("<｜end▁of▁thinking｜>", "</think>"):
        if marker in text:
            text = text.rsplit(marker, 1)[1]
    return text


def _strip_fence(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)
    return text.strip()


def defuse(text: str) -> str:
    """去掉思考泄露与代码围栏，并挡掉"这不是翻译/纪要"的闲聊回复。"""
    text = _strip_fence(_strip_reasoning(text))
    if not text:
        raise Failure("empty")
    if any(text.startswith(prefix) for prefix in HIJACK_PREFIXES):
        raise Failure("hijacked")
    return text


def _post_json(url: str, key: str, body: dict, timeout: float) -> dict:
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    try:
        with httpx.Client(timeout=httpx.Timeout(timeout, connect=min(8, timeout)),
                          follow_redirects=False) as client:
            response = client.post(url, headers=headers, json=body)
    except httpx.TimeoutException:
        raise Failure("timeout") from None
    except (httpx.HTTPError, httpx.InvalidURL):
        raise Failure("network") from None
    if response.status_code in (401, 403):
        # 把网关的原始原因带出来：常见的是“该模型未指定供应商”，比笼统的 Key 无效好排查。
        detail = (response.text or "").strip()[:200]
        raise Failure("invalid_key", detail, status=response.status_code)
    if response.status_code == 429:
        raise Failure("rate_limited", status=429)
    if response.status_code != 200:
        detail = (response.text or "")[:200]
        raise Failure("http", f"AI 服务返回 HTTP {response.status_code}：{detail}", status=response.status_code)
    try:
        return response.json()
    except ValueError:
        raise Failure("parse", "AI 回复不是 JSON") from None


def chat(content: str, instruction: str, *, priority: int | str = "notes", json_mode: bool = False,
         max_tokens: int = 2048, timeout: float = 120.0, role: str = "notes",
         session_id: str | None = None, model: str | None = None, attempts: int | None = None) -> str:
    """发一次对话，返回清洗过的正文。失败抛 Failure（带种类，供上层给准确文案）。"""
    priority = PRIORITY.get(priority, 2) if isinstance(priority, str) else int(priority)
    config = providers.resolve()
    key = keys.get(config.provider)
    if not key:
        raise Failure("no_key")
    body = providers.shape(config, {
        "model": providers.wire_model(config, model),
        # 内容进 system、指令进 user：防网关把内容当问题去做检索。
        "messages": [{"role": "system", "content": content},
                     {"role": "user", "content": instruction}],
    }, max_tokens)
    wants_json = bool(json_mode and config.json_mode)
    if wants_json:
        body["response_format"] = {"type": "json_object"}
    tried = attempts if attempts is not None else (4 if role == "notes" else 1)
    tried = max(1, tried)
    delay = 1.0

    def report(started: float, queued: float, outcome: str, usage: dict | None = None, note: str = ""):
        usage = usage or {}
        metrics.record(session_id, role=role, provider=config.provider, model=body.get("model"),
                       priority=priority, queue=round(queued, 3), outcome=outcome,
                       seconds=round(time.monotonic() - started, 3),
                       prompt_tokens=int(usage.get("prompt_tokens") or 0),
                       completion_tokens=int(usage.get("completion_tokens") or 0),
                       **({"note": note} if note else {}))

    last: Failure | None = None
    for attempt in range(1, tried + 1):
        waited = gate_mod.shared(config.spacing).acquire(priority, config.spacing)
        started = time.monotonic()
        try:
            root = _post_json(config.chat_url, key, body, timeout)
            text = defuse(_content(root))
            report(started, waited, "ok", root.get("usage") or {})
            return text
        except Failure as exc:
            last = exc
            report(started, waited, exc.kind)
            if exc.kind == "http" and exc.status == 400 and wants_json:
                # 这家网关不认 response_format：去掉再试一次，提示词本身已经要求只回 JSON。
                body.pop("response_format", None)
                wants_json = False
                continue
            if exc.kind == "truncated" and attempt < tried:
                # 内容被截断：放大一次预算再试，别把整条纪要判死。
                bigger = min(max(body.get("max_tokens", max_tokens) * 2, max_tokens * 2), 8000)
                body["max_tokens"] = bigger
                body["max_completion_tokens"] = bigger
                continue
            if exc.retryable and attempt < tried:
                time.sleep(delay + (0.5 * attempt))
                delay = min(delay * 2, 8.0)
                continue
            raise
    raise last or Failure("network")


def check_key(timeout: float = 20.0, *, config=None, key: str | None = None) -> dict:
    """用最省的请求验证 key 与模型是否可用；设置页「测试连接」可传入未保存的候选配置。"""
    config = config or providers.resolve()
    key = key if key is not None else keys.get(config.provider)
    if not key:
        return {"ok": False, "kind": "no_key", "message": ERRORS["no_key"]}
    started = time.monotonic()
    try:
        gate_mod.shared(config.spacing).acquire(0, config.spacing)
        body = providers.shape(config, {"model": providers.wire_model(config), "max_tokens": 8,
                                        "messages": [{"role": "user", "content": "回复一个字：好"}]}, 8)
        _post_json(config.chat_url, key, body, timeout)
        return {"ok": True, "seconds": round(time.monotonic() - started, 2),
                "provider": config.provider, "model": config.model}
    except Failure as exc:
        return {"ok": False, "kind": exc.kind, "message": str(exc),
                "provider": config.provider, "model": config.model}


def probe_models(timeout: float = 20.0) -> list[str]:
    """列出网关支持的模型（不支持 /models 的网关返回空表，不报错）。"""
    config = providers.resolve()
    key = keys.get(config.provider)
    if not key:
        return []
    headers = {"Authorization": "Bearer " + key}
    try:
        with httpx.Client(timeout=timeout, follow_redirects=False) as client:
            response = client.get(config.models_url, headers=headers)
        if response.status_code != 200:
            return []
        data = response.json()
    except (httpx.HTTPError, ValueError, httpx.InvalidURL):
        return []
    ids = []
    for item in data.get("data") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("id") or "")
        if not name or name.endswith(":batch"):
            continue
        lowered = name.lower()
        if any(token in lowered for token in ("embed", "whisper", "tts", "transcribe", "dall-e",
                                               "image", "moderation", "realtime", "sora", "asr")):
            continue
        ids.append(name)
    return ids


def status() -> dict:
    config = providers.resolve()
    key = keys.get(config.provider)
    return {"provider": config.provider, "provider_name": providers.PROVIDERS[config.provider]["name"],
            "base_url": config.base, "model": config.model, "has_key": bool(key),
            "key_masked": keys.masked(key), "own_key": bool(keys.own()), "credential_error": keys.credential_error(),
            "spacing": config.spacing, "json_mode": config.json_mode,
            "providers": [{"id": pid, "name": meta["name"], "models": list(meta["models"]),
                           "base": meta["base"]} for pid, meta in providers.PROVIDERS.items()]}
