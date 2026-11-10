"""用户对 AI 纪要的互动：勾选完成的待办、选中文字加的高亮。

这些是**用户行为**，不是模型输出：
- 不写进 `session_minutes.data`，重新整理纪要不会把它们冲掉；
- 单独落在 `session_minutes_interactions` 表里，按记录一份；
- 投影、导出、会摘卡片与 `meetclip_minutes` 工具都会带上它们，
  这样 Agent 能知道"这一项用户已经手动完成"或"这段文字被用户高亮过"。

高亮不存 DOM 位置：存选中的原文片段和它前后各一小段上下文。
纪要重写后片段还在就继续高亮，找不到就只保留在互动记录里（不报错）。
"""
from __future__ import annotations

import re
import time
import unicodedata
import uuid

from database import db

MAX_TODOS = 200
MAX_HIGHLIGHTS = 200
MAX_FRAGMENTS = 20
MAX_QUOTE_CHARS = 500
MAX_CONTEXT_CHARS = 48
MAX_SECTION_CHARS = 40
MAX_TOPIC_CHARS = 120

# 句末标点不算内容：模型偶尔在重写时换掉标点，勾选状态仍应保留。
_EDGE_PUNCT = "。．.!！?？,，;；:：、·-—_~～…\"'“”‘’()（）[]【】<>《》"


def _clean(value, limit: int = 0) -> str:
    """原样保留文字，只折叠空白。

    不能用 NFKC 规范化：它会把中文全角标点（，：！？＋）折成半角，
    而界面渲染的是原文；存下来后就再也匹配不回 DOM 里的那句话了。
    """
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if limit > 0:
        text = text[:limit]
    return text


def todo_key(text) -> str:
    """待办的稳定键：去掉空白和句末标点后的原文。

    不用行号：重新整理纪要后条目顺序会变，但用户勾过的同一句话应该仍然是勾上的。
    """
    value = unicodedata.normalize("NFKC", str(text or ""))
    value = re.sub(r"\s+", "", value).lower()
    value = value.strip(_EDGE_PUNCT)
    return value[:120]


def _num(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def _fragment(raw) -> dict | None:
    if isinstance(raw, str):
        text = _clean(raw)
        return {"text": text, "before": "", "after": ""} if text else None
    if not isinstance(raw, dict):
        return None
    text = _clean(raw.get("text"))
    if not text:
        return None
    return {
        "text": text[:300],
        "before": _clean(raw.get("before"))[-MAX_CONTEXT_CHARS:],
        "after": _clean(raw.get("after"))[:MAX_CONTEXT_CHARS],
    }


def _todos(raw) -> dict:
    """接受 dict / list 两种写法：dict 兼容 `{text: true}`，list 兼容 `[{text, done}]`。"""
    items = []
    if isinstance(raw, dict):
        for key, value in raw.items():
            if isinstance(value, dict):
                items.append((value.get("text") or key, value.get("done", True), value.get("at")))
            else:
                items.append((key, value, None))
    elif isinstance(raw, list):
        for value in raw:
            if not isinstance(value, dict):
                continue
            items.append((value.get("text"), value.get("done", True), value.get("at")))
    out: dict = {}
    now = time.time()
    for text, done, at in items:
        key = todo_key(text)
        if not key or not done:
            continue
        out[key] = {"done": True, "text": _clean(text, 300), "at": _num(at) or now}
        if len(out) >= MAX_TODOS:
            break
    return out


def _highlights(raw) -> list[dict]:
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    seen: set[str] = set()
    now = time.time()
    for index, value in enumerate(raw):
        if not isinstance(value, dict):
            continue
        fragments = [frag for frag in (_fragment(item) for item in value.get("fragments") or []) if frag]
        fragments = fragments[:MAX_FRAGMENTS]
        quote = _clean(value.get("quote"), MAX_QUOTE_CHARS)
        if not quote:
            quote = _clean(" ".join(frag["text"] for frag in fragments), MAX_QUOTE_CHARS)
        if not quote:
            continue
        hid = _clean(value.get("id"))[:60] or f"h-{uuid.uuid4().hex[:10]}"
        if hid in seen:
            continue
        seen.add(hid)
        out.append({
            "id": hid,
            "quote": quote,
            "fragments": fragments or [{"text": quote, "before": "", "after": ""}],
            "section": _clean(value.get("section"), MAX_SECTION_CHARS),
            "topic": _clean(value.get("topic"), MAX_TOPIC_CHARS),
            "t": _num(value.get("t")),
            "at": _num(value.get("at")) or now,
        })
        if len(out) >= MAX_HIGHLIGHTS:
            break
    out.sort(key=lambda item: item.get("at") or 0)
    return out


def normalize(raw) -> dict:
    value = raw if isinstance(raw, dict) else {}
    return {"todos": _todos(value.get("todos")), "highlights": _highlights(value.get("highlights"))}


def empty() -> dict:
    return {"todos": {}, "highlights": [], "updated_at": 0.0, "version": 0}


def get(sid: str) -> dict:
    """读互动记录；没有时返回空结构（前端不必区分 null）。"""
    try:
        row = db.get_minutes_interactions(sid)
    except Exception:
        return empty()
    if not row:
        return empty()
    doc = normalize(row.get("data") or {})
    doc["updated_at"] = row.get("updated_at") or 0.0
    doc["version"] = int(row.get("version") or 0)
    return doc


def has_content(doc) -> bool:
    return bool(doc and (doc.get("todos") or doc.get("highlights")))


def save(sid: str, raw) -> dict:
    doc = normalize(raw)
    saved = db.save_minutes_interactions(sid, doc)
    doc["updated_at"] = (saved or {}).get("updated_at") or time.time()
    doc["version"] = int((saved or {}).get("version") or 1)
    return doc


def clear(sid: str) -> None:
    db.delete_minutes_interactions(sid)


def done_keys(doc) -> set[str]:
    todos = (doc or {}).get("todos") or {}
    return {str(key) for key, value in todos.items() if isinstance(value, dict) and value.get("done")}


def summary(doc) -> dict:
    """给工具与投影用的可读摘要（已去重、有限长）。"""
    value = doc or {}
    todos = []
    for key, item in (value.get("todos") or {}).items():
        if isinstance(item, dict) and item.get("done"):
            todos.append({"text": item.get("text") or key, "at": item.get("at")})
    highlights = [{
        "id": item.get("id"),
        "quote": item.get("quote"),
        "section": item.get("section") or "",
        "topic": item.get("topic") or "",
        "t": item.get("t"),
        "at": item.get("at"),
    } for item in value.get("highlights") or [] if isinstance(item, dict) and item.get("quote")]
    todos.sort(key=lambda item: item.get("at") or 0)
    highlights.sort(key=lambda item: item.get("at") or 0)
    return {"done_todos": todos, "highlights": highlights,
            "counts": {"todos": len(todos), "highlights": len(highlights)}}
