"""@ 会摘卡片：把记录整理成可在 DSH 工作区直接 @ 的 Markdown 摘要。

卡片是派生数据：数据库里的 sessions / transcripts / marks / session_minutes 变化后，
下一次同步会把对应文件重写成最新内容。Host 与客户端只读取这里生成的清单和文件。

设计约束：
- 一份记录一张卡片，标题即文件名（重名追加序号）；文件放在数据目录的 `会摘卡片/`。
- 卡片是摘要，不是完整导出：完整转写仍由 `meetclip_*` 工具按页读取。
- 同步要幂等：内容签名不变时不重写文件，避免 DSH 文件树和 @ 索引抖动。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import unicodedata
from pathlib import Path
from urllib.parse import urlparse

import minutes
import minutes_notes
import packs
from database import DATA_DIR, db

CARD_DIR_NAME = "会摘卡片"
GENERATOR = "cards-v1"
DOC_GENERATOR = "doc-cards-v1"
PACK_GENERATOR = "pack-cards-v1"
PACK_DIR_NAME = "卡包"
NOTE_DIR_NAME = "便利签"
MARK_DIR_NAME = "标记"
IMAGE_DIR_NAME = "图片"
BATCH_DIR_NAME = "批次"
AUX_DIRS = {
    "note": NOTE_DIR_NAME,
    "highlight": MARK_DIR_NAME,
    "image": IMAGE_DIR_NAME,
    "batch": BATCH_DIR_NAME,
    "pack": PACK_DIR_NAME,
}
MEMBER_TYPE_LABELS = {
    "session": "记录",
    "batch": "批次",
    "highlight": "标记",
    "note": "便利签",
    "image": "图片",
    "doc": "文档",
    "pack": "卡包",
}

MAX_MINUTES_CHARS = 12_000
MAX_NOTES_CHARS = 6_000
MAX_MARK_ROWS = 50
MAX_PREVIEW_ROWS = 12
MAX_PREVIEW_CHARS = 2_000
MAX_SEARCH_CHARS = 2_000
MAX_FILE_CHARS = 80
MAX_FILE_BYTES = 180
MAX_DOC_CONTENT_CHARS = 12_000
MAX_DOC_SEARCH_CHARS = 2_000
MAX_DOC_TITLE_CHARS = 300
MAX_DOC_URL_CHARS = 1_000

KIND_LABELS = {"meeting": "会议", "link_video": "视频", "live": "直播"}
DOC_TYPE_LABELS = {
    "docx": "飞书文档",
    "wiki": "飞书知识库",
    "sheet": "飞书表格",
    "base": "飞书多维表格",
    "docs": "飞书文档",
}
DOC_URL_TYPES = {
    "docx": "docx",
    "wiki": "wiki",
    "sheets": "sheet",
    "base": "base",
    "docs": "docs",
}
DOC_ALLOWED_HOSTS = ("feishu.cn", "larksuite.com")
DOC_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{6,120}$")

STATUS_LABELS = {
    "pending": "待开始", "queued": "排队中", "recording": "采集中",
    "processing": "处理中", "done": "已完成", "error": "出错", "cancelled": "已取消",
}
ACTIVE_STATUSES = {"pending", "queued", "recording", "processing"}
WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

_LOCK = threading.RLock()
_LAST: dict = {"at": 0.0, "result": None}


def clock(seconds) -> str:
    total = max(0, int(float(seconds or 0)))
    if total >= 3600:
        return f"{total // 3600:02d}:{total % 3600 // 60:02d}:{total % 60:02d}"
    return f"{total // 60:02d}:{total % 60:02d}"


def _clean(value) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _meta(row) -> dict:
    raw = row.get("meta")
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def safe_filename(title, sid: str) -> str:
    """标题 → 文件名主体（不含 .md）。保留可读标题，替换文件系统非法字符。"""
    base = unicodedata.normalize("NFC", _clean(title))
    base = re.sub(r'[/\\:*?"<>|\x00-\x1f\x7f]', "-", base)
    base = re.sub(r"\s+", " ", base).strip(" .")
    if not base:
        base = f"未命名-{sid}"
    if base.split(".")[0].upper() in WINDOWS_RESERVED:
        base = f"_{base}"
    while len(base) > MAX_FILE_CHARS or len(base.encode("utf-8")) > MAX_FILE_BYTES:
        base = base[:-1]
    base = base.rstrip(" .")
    return base or f"未命名-{sid}"


def parse_doc_url(value) -> tuple[str, str] | None:
    """飞书文档 URL → (doc_type, token)；只接受文档链接，不联网。"""
    try:
        parsed = urlparse(_clean(value))
    except Exception:
        return None
    if parsed.scheme != "https":
        return None
    host = (parsed.hostname or "").lower()
    if not any(host == allowed or host.endswith(f".{allowed}") for allowed in DOC_ALLOWED_HOSTS):
        return None
    match = re.match(r"^/(docx|wiki|sheets|base|docs)/([A-Za-z0-9_-]+)(?:/|$)", parsed.path or "")
    if not match:
        return None
    token = match.group(2)
    if not DOC_TOKEN_RE.match(token):
        return None
    doc_type = DOC_URL_TYPES[match.group(1)]
    return doc_type, token


def doc_key(doc_type: str, token: str) -> str:
    blob = f"{DOC_GENERATOR}:{doc_type}:{token}".encode("utf-8")
    return hashlib.sha1(blob).hexdigest()[:12]


def _unique_file(base: str, used: set[str]) -> str:
    """在 used（casefold 的文件名）里找一个可用的 `<base>.md`。"""
    name = base
    index = 2
    while f"{name}.md".casefold() in used:
        name = f"{base} ({index})"
        index += 1
    return f"{name}.md"



def _remove_card_file(file) -> None:
    """只删除卡片目录下、由 card_exports 记录的单层文件。"""
    if not file:
        return
    base = (DATA_DIR / CARD_DIR_NAME).resolve()
    target = (base / Path(str(file)).name).resolve()
    if target.parent != base:
        return
    try:
        target.unlink()
    except FileNotFoundError:
        pass


def _signature(row: dict) -> str:
    meta = _meta(row)
    fields = [
        GENERATOR,
        row.get("title") or "",
        row.get("kind") or "",
        row.get("status") or "",
        row.get("source_url") or "",
        row.get("platform") or "",
        float(row.get("duration") or 0),
        row.get("notes_version") or 0,
        row.get("error") or "",
        meta.get("language") or "",
        meta.get("speakers") or {},
        row.get("minutes_version") or 0,
        row.get("minutes_updated_at") or 0,
        row.get("interactions_updated_at") or 0,
        row.get("interactions_version") or 0,
        row.get("minutes_state") or "",
        row.get("transcript_count") or 0,
        row.get("transcript_max") or 0,
        row.get("mark_count") or 0,
        row.get("mark_max") or 0,
        row.get("started_at") or 0,
        row.get("created_at") or 0,
    ]
    blob = json.dumps(fields, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()


def _session_rows() -> list[dict]:
    return db.query(
        "SELECT s.id, s.title, s.kind, s.status, s.source_url, s.platform, s.created_at, "
        "       s.started_at, s.duration, s.notes, s.notes_version, s.error, s.meta, "
        "       COALESCE(m.version, 0) AS minutes_version, "
        "       COALESCE(m.updated_at, 0) AS minutes_updated_at, "
        "       COALESCE(m.state, '') AS minutes_state, "
        "       COALESCE(i.updated_at, 0) AS interactions_updated_at, "
        "       COALESCE(i.version, 0) AS interactions_version, "
        "       (SELECT COUNT(*) FROM transcripts t WHERE t.session_id=s.id) AS transcript_count, "
        "       (SELECT COALESCE(MAX(t.id), 0) FROM transcripts t WHERE t.session_id=s.id) AS transcript_max, "
        "       (SELECT COUNT(*) FROM marks k WHERE k.session_id=s.id) AS mark_count, "
        "       (SELECT COALESCE(MAX(k.id), 0) FROM marks k WHERE k.session_id=s.id) AS mark_max "
        "FROM sessions s LEFT JOIN session_minutes m ON m.session_id=s.id "
        "             LEFT JOIN session_minutes_interactions i ON i.session_id=s.id "
        "ORDER BY s.created_at ASC, s.id ASC"
    )


def _assign_files(rows: list[dict], reserved=()) -> dict[str, str]:
    """按记录创建顺序分配稳定文件名；同标题追加序号。

    reserved 是已被文档卡片占用的文件名（casefold 比较），避免记录卡
    覆盖同名飞书文档卡。
    """
    used: set[str] = {str(item).casefold() for item in reserved if item}
    assigned: dict[str, str] = {}
    for row in rows:
        sid = str(row.get("id") or "")
        base = safe_filename(row.get("title"), sid)
        name = _unique_file(base, used)
        used.add(name.casefold())
        assigned[sid] = name
    return assigned


def _minutes_payload(sid: str) -> dict | None:
    try:
        payload = minutes.engine.get(sid)
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    if not any(payload.get(key) for key in ("summary", "topics", "conclusions", "todos", "terms")):
        return None
    return payload


def _minutes_markdown(payload: dict) -> str:
    try:
        body = minutes_notes.build_projection(payload, links=False)
    except Exception:
        return ""
    lines = body.splitlines()
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines and lines[0].startswith("# "):
        lines.pop(0)
    # 卡片里「## AI 纪要」是父节，把纪要自己的标题降一级。
    demoted = [f"#{line}" if line.startswith("#") else line for line in lines]
    text = "\n".join(demoted).strip()
    if len(text) > MAX_MINUTES_CHARS:
        text = text[:MAX_MINUTES_CHARS].rstrip() + "\n\n_（纪要较长，已截断；完整内容请调用 meetclip_minutes。）_"
    return text


def _notes_text(row: dict) -> str:
    notes = str(row.get("notes") or "")
    try:
        if minutes_notes.has_block(notes):
            notes = minutes_notes.strip_block(notes)
        else:
            notes = minutes_notes.strip_markers(notes)
    except Exception:
        pass
    text = notes.strip()
    if len(text) > MAX_NOTES_CHARS:
        text = text[:MAX_NOTES_CHARS].rstrip() + "\n\n_（笔记较长，已截断；完整内容请调用 meetclip_notes。）_"
    return text


def _mark_lines(sid: str, total: int) -> list[str]:
    rows = db.get_marks(sid)[:MAX_MARK_ROWS]
    lines = []
    for mark in rows:
        note = _clean(mark.get("note"))
        lines.append(f"- [{clock(mark.get('ts'))}]" + (f" — {note}" if note else ""))
    if total > len(rows):
        lines.append(f"- …… 共 {total} 条标记，这里只列前 {len(rows)} 条。")
    return lines


def _transcript_preview(row: dict) -> list[str]:
    sid = str(row.get("id") or "")
    names = _meta(row).get("speakers") or {}
    rows = db.query(
        "SELECT start, text, speaker FROM transcripts WHERE session_id=? ORDER BY start LIMIT ?",
        (sid, MAX_PREVIEW_ROWS),
    )
    lines = []
    size = 0
    for item in rows:
        text = _clean(item.get("text"))
        if not text:
            continue
        raw = item.get("speaker") or ""
        speaker = _clean(names.get(raw) or raw) if raw else ""
        line = f"[{clock(item.get('start'))}] " + (f"{speaker}：" if speaker else "") + text
        if size + len(line) > MAX_PREVIEW_CHARS:
            break
        lines.append(line)
        size += len(line) + 1
    total = int(row.get("transcript_count") or 0)
    shown = len(lines)
    if total > shown and shown > 0:
        lines.append(f"…… 共 {total} 段转写，这里只列前 {shown} 段；完整转写请调用 meetclip_records（action=transcript）。")
    return lines


def _search_text(row: dict, title: str, minutes_payload: dict | None, notes: str) -> str:
    parts = [title, KIND_LABELS.get(row.get("kind"), ""), STATUS_LABELS.get(row.get("status"), "")]
    if minutes_payload:
        parts.append(_clean(minutes_payload.get("summary")))
        for topic in minutes_payload.get("topics") or []:
            if isinstance(topic, dict):
                parts.append(_clean(topic.get("title")))
                for point in topic.get("points") or []:
                    if isinstance(point, dict):
                        parts.append(_clean(point.get("text")))
        for item in minutes_payload.get("conclusions") or []:
            if isinstance(item, dict):
                parts.append(_clean(item.get("text")))
        for item in minutes_payload.get("todos") or []:
            if isinstance(item, dict):
                parts.append(_clean(item.get("text")))
        for term in minutes_payload.get("terms") or []:
            if isinstance(term, dict):
                parts.append(_clean(term.get("name")))
        interactions = minutes_payload.get("interactions") or {}
        for item in (interactions.get("todos") or {}).values():
            if isinstance(item, dict) and item.get("done"):
                parts.append(_clean(item.get("text")))
        for item in interactions.get("highlights") or []:
            if isinstance(item, dict):
                parts.append(_clean(item.get("quote"))[:200])
    parts.append(notes[:500])
    return _clean(" ".join(part for part in parts if part))[:MAX_SEARCH_CHARS]


def build_card(row: dict) -> tuple[str, str]:
    """生成一张卡片的 Markdown 与搜索文本。"""
    sid = str(row.get("id") or "")
    meta = _meta(row)
    title = _clean(row.get("title")) or f"未命名-{sid}"
    kind = KIND_LABELS.get(row.get("kind"), "记录")
    status = STATUS_LABELS.get(row.get("status"), str(row.get("status") or "未知"))
    stamp = row.get("started_at") or row.get("created_at")
    try:
        date = time.strftime("%Y-%m-%d %H:%M", time.localtime(float(stamp)))
    except Exception:
        date = ""
    notes = _notes_text(row)
    minutes_payload = _minutes_payload(sid)
    minutes_body = _minutes_markdown(minutes_payload) if minutes_payload else ""
    search = _search_text(row, title, minutes_payload, notes)

    lines = [f"# {title}", ""]
    bits = [kind, status]
    if date:
        bits.append(date)
    bits.append(clock(row.get("duration")))
    if meta.get("language"):
        bits.append(str(meta["language"]))
    lines.append("> 会摘卡片 · " + " · ".join(bit for bit in bits if bit))
    if row.get("source_url"):
        lines.append(f"> 来源：{_clean(row['source_url'])[:300]}")
    lines.append(f"> 记录 ID：`{sid}` · 类型：`{row.get('kind') or 'live'}` · 状态：`{row.get('status') or ''}`")
    if row.get("status") in ACTIVE_STATUSES:
        lines.append("> 这条记录仍在采集或处理中，下面的内容可能继续更新。")
    if row.get("status") == "error" and row.get("error"):
        lines.append(f"> 异常说明：{_clean(row['error'])[:300]}")
    lines += [
        "",
        "## 怎么用",
        "这是用户在会摘里 @ 选中的记录卡片。回答前先读本文件；"
        f"需要完整转写、原始截图或重新生成纪要时，使用 `meetclip_records` / `meetclip_minutes` 工具，"
        f"`session_id = \"{sid}\"`。可以同时 @ 多条卡片再一起比较。",
        "",
    ]

    if minutes_body:
        lines += ["## AI 纪要", "", minutes_body, ""]

    if notes:
        lines += ["## 我的笔记", "", notes, ""]

    marks = _mark_lines(sid, int(row.get("mark_count") or 0))
    if marks:
        lines += ["## 标记", "", *marks, ""]

    preview = _transcript_preview(row)
    if preview:
        lines += ["## 转写预览", "", *preview, ""]

    if not minutes_body and not notes and not marks and not preview:
        lines += ["## 内容", "", "这条记录还没有可用的转写或纪要。完整状态可以用 meetclip_records 查看。", ""]

    lines += ["---", "", "> 本文件由会摘自动生成，记录更新后会刷新；请勿手工编辑。"]
    markdown = "\n".join(lines).strip() + "\n"
    return markdown, search


def _doc_content(title: str, content: str) -> str:
    text = str(content or "").strip()
    if not text:
        return ""
    # 飞书 doc_read 的正文通常以标题开头；卡片标题已经单独写过，去掉重复首行。
    lines = text.splitlines()
    if lines and _clean(lines[0]) == _clean(title):
        lines = lines[1:]
        while lines and not lines[0].strip():
            lines.pop(0)
    text = "\n".join(lines).strip()
    if len(text) > MAX_DOC_CONTENT_CHARS:
        text = text[:MAX_DOC_CONTENT_CHARS].rstrip() + (
            "\n\n_（正文较长，已截断；完整内容请用 mcp__feishu__doc_read 读取。）_"
        )
    return text


def _doc_search(title: str, doc_type: str, url: str, content: str) -> str:
    type_label = DOC_TYPE_LABELS.get(doc_type, "飞书文档")
    parts = [title, type_label, url, str(content or "")[:MAX_DOC_SEARCH_CHARS]]
    return _clean(" ".join(part for part in parts if part))[:MAX_DOC_SEARCH_CHARS]


def build_doc_card(row: dict) -> tuple[str, str]:
    """生成一张飞书文档卡片的 Markdown 与搜索文本。"""
    title = _clean(row.get("title")) or f"未命名-{row.get('key')}"
    doc_type = str(row.get("doc_type") or "docx")
    type_label = DOC_TYPE_LABELS.get(doc_type, "飞书文档")
    url = _clean(row.get("url"))[:MAX_DOC_URL_CHARS]
    document_id = _clean(row.get("document_id")) or _clean(row.get("token"))
    revision = _clean(row.get("revision"))
    content = str(row.get("content") or "")
    try:
        stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(float(row.get("updated_at") or 0)))
    except Exception:
        stamp = ""
    search = _doc_search(title, doc_type, url, content)

    lines = [f"# {title}", ""]
    bits = [type_label]
    if stamp:
        bits.append(f"更新 {stamp}")
    lines.append("> 会摘卡片 · " + " · ".join(bits))
    if url:
        lines.append(f"> 链接：{url}")
    meta = f"> 文档 ID：`{document_id}` · 类型：`{doc_type}`"
    if revision:
        meta += f" · 修订：`{revision}`"
    lines.append(meta)
    lines += [
        "",
        "## 怎么用",
        "这是用户在会摘里登记的飞书文档卡片。回答前先读本文件；下面是登记时读取的正文快照。",
        "需要最新全文、块结构或图片时，使用 `mcp__feishu__doc_read` / `mcp__feishu__doc_fetch`，"
        f"`document_id = \"{document_id}\"`；wiki 链接先用 `mcp__feishu__wiki_get_node` 取 `obj_token`。",
        "这张卡片不对应会摘记录，没有 `session_id`；不要用 `meetclip_records` 查它。",
        "",
    ]

    if content:
        lines += ["## 正文", "", content, ""]
    else:
        lines += [
            "## 正文",
            "",
            "这条文档还没有读取正文。打开上面的链接查看，或在设置 → 飞书登录后重新添加。",
            "",
        ]

    lines += ["---", "", "> 本文件由会摘生成；再次添加同一文档会刷新正文快照，请勿手工编辑。"]
    return "\n".join(lines).strip() + "\n", search



def _stamp_text(value) -> str:
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(float(value)))
    except Exception:
        return ""


def _note_title(row) -> str:
    text = str(row.get("text") or "").strip()
    for line in text.splitlines():
        line = re.sub(r"^\s*-\s+(?:\[[ xX]\]\s*)?", "", line).strip()
        if line:
            return _clean(line)[:80]
    return "便利签"


def _mark_title(row) -> str:
    return _clean(row.get("note"))[:80] or "标记"


def _image_title(row) -> str:
    stamp = _stamp_text(row.get("created_at"))
    return f"图片卡{f' · {stamp}' if stamp else ''}"


def _aux_title(kind: str, row: dict) -> str:
    if kind == "note":
        return _note_title(row)
    if kind == "highlight":
        return _mark_title(row)
    if kind == "image":
        return _image_title(row)
    if kind == "batch":
        return _clean(row.get("title"))[:160] or "批量视频"
    return _clean(row.get("title"))[:160] or "卡包"


def _aux_file_names(kind: str, rows: list[dict]) -> dict[str, str]:
    """按标题分配文件名；同名追加序号，排序按创建时间固定，避免每轮抖动。"""
    ordered = sorted(rows, key=lambda row: (
        float(row.get("created_at") or row.get("started_at") or 0),
        str(row.get("id") or ""),
    ))
    used: set[str] = set()
    names: dict[str, str] = {}
    for row in ordered:
        identifier = str(row.get("id") or "").strip()
        if not identifier:
            continue
        title = _aux_title(kind, row)
        base = safe_filename(title, f"{kind}-{identifier}")
        name = _unique_file(base, used)
        used.add(name.casefold())
        names[identifier] = name
    return names


def _aux_common_head(title: str, kind: str, identifier: str, stamp: str, extra: str = "") -> list[str]:
    lines = [f"# {title}", ""]
    bits = [f"{MEMBER_TYPE_LABELS.get(kind, '卡片')}"]
    if stamp:
        bits.append(stamp)
    lines.append("> 会摘卡片 · " + " · ".join(bits))
    lines.append(f"> 卡片 ID：`{kind}:{identifier}`")
    if extra:
        lines.append(extra)
    lines += [
        "",
        "## 怎么用",
        "这是用户在会摘首页 @ 选中的卡片。回答前先读本文件；"
        "如果这是便利签、标记、图片或批次，本文件就是它的上下文。",
        "",
    ]
    return lines


def build_note_card(row: dict) -> tuple[str, str]:
    identifier = str(row.get("id") or "")
    title = _note_title(row)
    text = str(row.get("text") or "").strip()
    kind = str(row.get("kind") or "note")
    stamp = _stamp_text(row.get("created_at"))
    lines = _aux_common_head(title, "note", identifier, stamp)
    lines.append(f"> 类型：`{kind}`")
    lines += ["## 内容", "", text or "（空白便利签）", ""]
    if kind == "todo":
        checked = row.get("checked") if isinstance(row.get("checked"), list) else []
        todos = [re.sub(r"^\s*-\s+(?:\[[ xX]\]\s*)?", "", line).strip()
                 for line in text.splitlines() if re.match(r"^\s*-\s+", line)]
        if todos:
            lines += ["## 待办状态", ""]
            for index, item in enumerate(todos):
                lines.append(f"- [{'x' if index < len(checked) and checked[index] else ' '}] {item}")
            lines.append("")
    lines += ["---", "", "> 本文件由会摘自动生成；请勿手工编辑。"]
    search = _clean(" ".join([title, text, kind]))[:MAX_SEARCH_CHARS]
    return "\n".join(lines).strip() + "\n", search


def build_highlight_card(row: dict) -> tuple[str, str]:
    identifier = str(row.get("id") or "")
    title = _mark_title(row)
    session_title = _clean(row.get("session_title"))[:160] or "未命名记录"
    stamp = _stamp_text(row.get("created_at"))
    lines = _aux_common_head(title, "highlight", identifier, stamp)
    lines += [
        f"> 来源记录：{session_title}",
        f"> session_id：`{row.get('session_id')}` · 时间点：`{clock(row.get('ts'))}`",
        "",
        "## 标记原文",
        "",
        f"> {_clean(row.get('note'))}",
        "",
        "需要完整上下文时，用 `meetclip_records` 读取来源记录，或按时间点打开记录。",
        "",
        "---",
        "",
        "> 本文件由会摘自动生成；请勿手工编辑。",
    ]
    search = _clean(" ".join([title, session_title, str(row.get("note") or "")]))[:MAX_SEARCH_CHARS]
    return "\n".join(lines).strip() + "\n", search


def build_image_card(row: dict) -> tuple[str, str]:
    identifier = str(row.get("id") or "")
    title = _image_title(row)
    width = int(row.get("width") or 0)
    height = int(row.get("height") or 0)
    file = _clean(row.get("path"))[:500]
    stamp = _stamp_text(row.get("created_at"))
    lines = _aux_common_head(title, "image", identifier, stamp)
    if width and height:
        lines.append(f"> 尺寸：{width}×{height}")
    if file:
        lines.append(f"> 图片文件：`{file}`")
    lines += [
        "",
        "## 图片",
        "",
        f"这张图片卡对应会摘画板里的 `{file or identifier}`。"
        "如果需要分析画面内容，请让用户把图片作为附件发送，或在会摘画板中打开原图。",
        "",
        "---",
        "",
        "> 本文件由会摘自动生成；请勿手工编辑。",
    ]
    search = _clean(" ".join([title, file, f"{width}x{height}"]))[:MAX_SEARCH_CHARS]
    return "\n".join(lines).strip() + "\n", search


def build_batch_card(row: dict) -> tuple[str, str]:
    identifier = str(row.get("id") or "")
    title = _clean(row.get("title"))[:160] or "批量视频"
    stamp = _stamp_text(row.get("updated_at") or row.get("created_at"))
    members = row.get("members") if isinstance(row.get("members"), list) else []
    counts = row.get("counts") if isinstance(row.get("counts"), dict) else {}
    lines = _aux_common_head(title, "batch", identifier, stamp)
    lines.append(f"> 共 {len(members)} 条 · 进行中 {int(row.get('active') or 0)} 条")
    lines += ["", "## 批次成员", ""]
    for member in members:
        status = STATUS_LABELS.get(str(member.get("status") or ""), str(member.get("status") or ""))
        lines.append(f"- {_clean(member.get('title'))[:120] or '未命名'} · `{member.get('id')}` · {status}")
    if not members:
        lines.append("（批次暂时没有成员）")
    lines += [
        "",
        "需要单条记录详情时，用 `meetclip_records` 按上面的 session_id 读取。",
        "",
        "---",
        "",
        "> 本文件由会摘自动生成；请勿手工编辑。",
    ]
    search = _clean(" ".join([title, *[str(item.get("title") or "") for item in members]]))[:MAX_SEARCH_CHARS]
    return "\n".join(lines).strip() + "\n", search


def build_pack_card(pack: dict) -> tuple[str, str]:
    identifier = str(pack.get("id") or "")
    title = _clean(pack.get("title"))[:160] or "卡包"
    members = pack.get("members") if isinstance(pack.get("members"), list) else []
    stamp = _stamp_text(pack.get("updated_at") or pack.get("created_at"))
    lines = _aux_common_head(title, "pack", identifier, stamp)
    lines.append(f"> 卡包 · {len(members)} 张卡片 · 进行中 {int(pack.get('active_count') or 0)} 张")
    lines += [
        "",
        "## 这个卡包里有什么",
        "",
        "这是一个卡包，不是单条记录。下面是用户收进来的卡片，按首页展开顺序排列。",
        "",
    ]
    for index, member in enumerate(members, start=1):
        member_type = str(member.get("type") or "")
        label = MEMBER_TYPE_LABELS.get(member_type, "卡片")
        member_id = str(member.get("id") or "")
        member_title = _clean(member.get("title"))[:160] or "未命名"
        if member_type == "session":
            detail = f"session_id=`{member_id}` · {member.get('kind') or ''} · {STATUS_LABELS.get(str(member.get('status') or ''), str(member.get('status') or ''))}"
            if member.get("duration"):
                detail += f" · {clock(member.get('duration'))}"
        elif member_type == "doc":
            detail = f"`{member_id}`"
            if member.get("url"):
                detail += f" · {member.get('url')}"
        elif member_type == "highlight":
            detail = f"`{member_id}` · 来源 `{member.get('session_id') or ''}` · {clock(member.get('ts'))}"
        elif member_type == "note":
            detail = f"`{member_id}` · {member.get('kind') or 'note'}"
        elif member_type == "image":
            detail = f"`{member_id}`"
        elif member_type == "batch":
            detail = f"`{member_id}` · {member.get('count') or 0} 条"
        else:
            detail = f"`{member_id}`"
        lines.append(f"{index}. **{member_title}** · {label} · {detail}")
    if not members:
        lines.append("（空卡包）")
    lines += [
        "",
        "需要某张记录的完整内容时，用 `meetclip_records` / `meetclip_minutes` / `meetclip_notes` 按上面的 id 读取；"
        "也可以让用户单独 @ 那张卡片。",
        "",
        "---",
        "",
        "> 本文件由会摘自动生成；卡包内容变化后会刷新，请勿手工编辑。",
    ]
    search = _clean(" ".join([title, *[str(item.get("title") or "") for item in members]]))[:MAX_SEARCH_CHARS]
    return "\n".join(lines).strip() + "\n", search


def _existing_doc_files(exclude_key: str = "") -> set[str]:
    """现存文档卡片文件名（casefold）；文件被手工删掉的不占位。"""
    files: set[str] = set()
    try:
        rows = db.list_doc_cards()
    except Exception:
        return files
    for row in rows:
        if exclude_key and str(row.get("key") or "") == exclude_key:
            continue
        name = Path(str(row.get("file") or "")).name
        if name and (DATA_DIR / CARD_DIR_NAME / name).is_file():
            files.add(name.casefold())
    return files


def _remove_doc_file(old_file, keep: set[str]) -> None:
    """删除改名前的文档卡片文件；记录卡片正在使用的文件名绝不删。"""
    name = Path(str(old_file or "")).name
    if not name or name.casefold() in keep:
        return
    _remove_card_file(name)


def upsert_doc_card(url, title="", content="", document_id="", revision=""):
    """登记/刷新一张飞书文档卡片；同一 doc_type:token 只保留一张。"""
    parsed = parse_doc_url(url)
    if not parsed:
        raise ValueError("只支持飞书文档链接（/docx、/wiki、/sheets、/base）")
    doc_type, token = parsed
    type_label = DOC_TYPE_LABELS.get(doc_type, "飞书文档")
    clean_title = _clean(title)[:MAX_DOC_TITLE_CHARS]
    if not clean_title:
        clean_title = f"{type_label} {token[:8]}"
    clean_url = _clean(url)[:MAX_DOC_URL_CHARS]
    clean_content = _doc_content(clean_title, content)
    clean_document_id = _clean(document_id)[:120] or (token if doc_type == "docx" else "")
    clean_revision = _clean(revision)[:120]
    key = doc_key(doc_type, token)

    with _LOCK:
        card_dir = DATA_DIR / CARD_DIR_NAME
        existing = db.get_doc_card(key)
        # 记录卡片当前实际占用的文件名 + 其他文档卡片的文件名；两者都不能被覆盖。
        session_files = {
            Path(str(row.get("file") or "")).name.casefold()
            for row in db.list_card_exports() if row.get("file")
        }
        other_doc_files = _existing_doc_files(exclude_key=key)
        used = session_files | other_doc_files
        base = safe_filename(clean_title, key)

        desired = ""
        if existing:
            name = Path(str(existing.get("file") or "")).name
            if (
                name
                and (card_dir / name).is_file()
                and Path(name).stem == base
                and name.casefold() not in used
            ):
                desired = name
        if not desired:
            desired = _unique_file(base, used)

        signature = _doc_signature(clean_url, doc_type, token, clean_document_id,
                                   clean_title, desired, clean_content, clean_revision)
        path = card_dir / desired
        changed = not (
            existing
            and str(existing.get("signature") or "") == signature
            and str(existing.get("file") or "") == desired
            and path.is_file()
        )
        if changed:
            row = {
                "key": key,
                "title": clean_title,
                "doc_type": doc_type,
                "url": clean_url,
                "document_id": clean_document_id,
                "revision": clean_revision,
                "content": clean_content,
                "updated_at": time.time(),
            }
            markdown, _search = build_doc_card(row)
            _write_card(path, markdown)
            old_file = str(existing.get("file") or "") if existing else ""
            if old_file and Path(old_file).name != desired:
                _remove_doc_file(old_file, used)

        now = time.time()
        created_at = float(existing.get("created_at") or now) if existing else now
        search = _doc_search(clean_title, doc_type, clean_url, clean_content)
        db.upsert_doc_card(key, clean_url, doc_type, token, clean_document_id,
                           clean_title, desired, signature, search, clean_content,
                           clean_revision, created_at, now)
        return {
            "created": existing is None,
            "changed": changed,
            "card": {
                "key": key,
                "title": clean_title,
                "path": f"{CARD_DIR_NAME}/{desired}",
                "url": clean_url,
                "doc_type": doc_type,
                "document_id": clean_document_id,
                "has_content": bool(clean_content),
                "updated_at": now,
            },
        }


def _doc_signature(url, doc_type, token, document_id, title, file, content, revision) -> str:
    fields = [DOC_GENERATOR, url, doc_type, token, document_id, title, file, content, revision]
    blob = json.dumps(fields, ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()


def _write_card(path: Path, markdown: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp-{os.getpid()}-{time.time_ns()}")
    try:
        temp.write_text(markdown, encoding="utf-8")
        os.replace(temp, path)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass



def _aux_rows() -> list[tuple[str, str, list[dict], callable]]:
    """非记录卡片的数据源；每类一张 Markdown，放在各自的子目录里避免与记录卡重名。"""
    rows: list[tuple[str, str, list[dict], callable]] = []
    try:
        rows.append(("note", "便利签", db.list_sticky_notes(), build_note_card))
    except Exception:
        pass
    try:
        marks = db.query(
            "SELECT m.id,m.session_id,m.ts,m.note,m.created_at,s.title AS session_title,s.kind "
            "FROM marks m JOIN sessions s ON s.id=m.session_id ORDER BY m.created_at ASC"
        )
        rows.append(("highlight", "标记", marks, build_highlight_card))
    except Exception:
        pass
    try:
        rows.append(("image", "图片", db.list_board_images(), build_image_card))
    except Exception:
        pass
    try:
        rows.append(("batch", "批次", db.list_link_batches(1000), build_batch_card))
    except Exception:
        pass
    try:
        rows.append(("pack", "卡包", packs.list_packs(), build_pack_card))
    except Exception:
        pass
    return rows


def _is_generated_aux_file(path: Path) -> bool:
    try:
        return "本文件由会摘自动生成" in path.read_text(encoding="utf-8")[:1000]
    except Exception:
        return False


def _sync_aux_cards(force: bool = False) -> dict:
    """把便利签/标记/图片/批次/卡包同步成 @ 卡片；内容不变不重写。"""
    card_dir = DATA_DIR / CARD_DIR_NAME
    result = {"ok": True, "total": 0, "created": 0, "updated": 0, "skipped": 0, "removed": 0, "errors": []}
    for kind, directory, rows, builder in _aux_rows():
        folder = card_dir / directory
        expected: set[str] = set()
        names = _aux_file_names(kind, rows)
        for row in rows:
            identifier = str(row.get("id") or "").strip()
            if not identifier:
                continue
            result["total"] += 1
            file = names.get(identifier)
            if not file:
                continue
            expected.add(file.casefold())
            path = folder / file
            try:
                markdown, _search = builder(row)
                changed = not path.is_file()
                if path.is_file() and path.read_text(encoding="utf-8") != markdown:
                    changed = True
                if force or changed:
                    existed = path.is_file()
                    _write_card(path, markdown)
                    if existed:
                        result["updated"] += 1
                    else:
                        result["created"] += 1
                else:
                    result["skipped"] += 1
            except Exception as exc:
                result["ok"] = False
                result["errors"].append({"kind": kind, "id": identifier, "message": str(exc)[:300]})
        if folder.is_dir():
            for stale in folder.glob("*.md"):
                if stale.name.casefold() in expected:
                    continue
                try:
                    if _is_generated_aux_file(stale):
                        stale.unlink()
                        result["removed"] += 1
                except Exception as exc:
                    result["ok"] = False
                    result["errors"].append({"kind": kind, "file": stale.name, "message": str(exc)[:300]})
            try:
                if not any(folder.iterdir()):
                    folder.rmdir()
            except OSError:
                pass
    return result


def sync_cards(force: bool = False) -> dict:
    """把记录同步成卡片文件；只重建内容或文件名变化的卡片。"""
    with _LOCK:
        started = time.time()
        rows = _session_rows()
        exports = {str(item.get("session_id")): item for item in db.list_card_exports()}
        doc_files = _existing_doc_files()
        assigned = _assign_files(rows, reserved=doc_files)
        expected_ids = set(assigned)
        expected_files = {file.casefold() for file in assigned.values()}
        card_dir = DATA_DIR / CARD_DIR_NAME
        created = updated = removed = skipped = 0
        errors: list[dict] = []

        for row in rows:
            sid = str(row.get("id") or "")
            file = assigned.get(sid)
            if not file:
                continue
            path = card_dir / file
            signature = _signature(row)
            export = exports.get(sid)
            if (
                not force
                and export
                and export.get("signature") == signature
                and export.get("file") == file
                and path.is_file()
            ):
                skipped += 1
                continue
            try:
                markdown, search = build_card(row)
                _write_card(path, markdown)
                old_file = str(export.get("file") or "") if export else ""
                if old_file and old_file != file and old_file.casefold() not in expected_files:
                    _remove_card_file(old_file)
                db.upsert_card_export(sid, file, signature, _clean(row.get("title")) or sid, search, time.time())
                if export:
                    updated += 1
                else:
                    created += 1
            except Exception as exc:
                errors.append({"session_id": sid, "message": str(exc)[:300]})

        for sid, export in exports.items():
            if sid in expected_ids:
                continue
            try:
                old_file = str(export.get("file") or "")
                if old_file and old_file.casefold() not in expected_files:
                    _remove_card_file(old_file)
                db.delete_card_export(sid)
                removed += 1
            except Exception as exc:
                errors.append({"session_id": sid, "message": str(exc)[:300]})

        aux = _sync_aux_cards(force=force)
        if aux.get("errors"):
            errors.extend({"session_id": f"aux:{item.get('kind') or 'card'}", "message": item.get("message") or ""}
                          for item in aux["errors"])

        # 没有卡片时不留空目录；用户自己放进去的文件不碰。
        try:
            if card_dir.is_dir() and not any(card_dir.iterdir()):
                card_dir.rmdir()
        except OSError:
            pass

        result = {
            "ok": not errors and bool(aux.get("ok", True)),
            "dir": CARD_DIR_NAME,
            "total": len(rows),
            "created": created,
            "updated": updated,
            "removed": removed,
            "skipped": skipped,
            "errors": errors,
            "aux": aux,
            "updated_at": started,
        }
        _LAST["at"] = time.monotonic()
        _LAST["result"] = result
        return result


def sync_if_stale(max_age: float = 2.0) -> dict:
    """给 @ 菜单用：短时间内的重复查询复用上一次结果，避免每敲一个字全量扫描。"""
    now = time.monotonic()
    with _LOCK:
        last_at = float(_LAST.get("at") or 0)
        last = _LAST.get("result")
        if last is not None and now - last_at < max_age:
            return last
    return sync_cards()


def home_documents(limit: int = 12) -> list[dict]:
    """首页「飞书文档」条：只返回文件仍存在的已登记文档卡。"""
    limit = max(1, min(int(limit or 12), 50))
    out: list[dict] = []
    for row in db.list_doc_cards():
        file = Path(str(row.get("file") or "")).name
        if not file:
            continue
        path = DATA_DIR / CARD_DIR_NAME / file
        if not path.is_file():
            continue
        out.append({
            "id": f"doc:{row.get('key') or ''}",
            "key": str(row.get("key") or ""),
            "title": _clean(row.get("title")) or file,
            "url": str(row.get("url") or ""),
            "doc_type": str(row.get("doc_type") or "docx"),
            "has_content": bool(str(row.get("content") or "").strip()),
            "updated_at": row.get("updated_at"),
            "path": f"{CARD_DIR_NAME}/{file}",
        })
        if len(out) >= limit:
            break
    return out



def _aux_list_cards() -> list[dict]:
    """读出已生成的便利签/标记/图片/批次/卡包卡片，供 @ 菜单和精确取卡使用。"""
    out: list[dict] = []
    for kind, directory, rows, builder in _aux_rows():
        names = _aux_file_names(kind, rows)
        for row in rows:
            identifier = str(row.get("id") or "").strip()
            if not identifier:
                continue
            file = names.get(identifier)
            if not file:
                continue
            path = DATA_DIR / CARD_DIR_NAME / directory / file
            if not path.is_file():
                continue
            try:
                _markdown, search = builder(row)
            except Exception:
                search = ""
            if kind == "note":
                title = _note_title(row)
                stamp = row.get("created_at")
                item = {"source": "note", "kind": "note", "title": title,
                        "status": "done", "created_at": stamp, "updated_at": row.get("updated_at") or stamp,
                        "text": str(row.get("text") or "")[:400]}
            elif kind == "highlight":
                title = _mark_title(row)
                item = {"source": "mark", "kind": "highlight", "title": title,
                        "status": "done", "created_at": row.get("created_at"),
                        "session_title": _clean(row.get("session_title"))[:160],
                        "session_id": row.get("session_id"), "ts": row.get("ts")}
                stamp = row.get("created_at")
            elif kind == "image":
                title = _image_title(row)
                stamp = row.get("created_at")
                item = {"source": "image", "kind": "image", "title": title,
                        "status": "done", "created_at": stamp, "width": row.get("width"), "height": row.get("height")}
            elif kind == "batch":
                title = _clean(row.get("title"))[:160] or "批量视频"
                stamp = row.get("updated_at") or row.get("created_at")
                item = {"source": "batch", "kind": "batch", "title": title,
                        "status": "done", "created_at": row.get("created_at"), "updated_at": stamp,
                        "count": row.get("total"), "active": row.get("active")}
            else:
                title = _clean(row.get("title"))[:160] or "卡包"
                stamp = row.get("updated_at") or row.get("created_at")
                item = {"source": "pack", "kind": "pack", "title": title,
                        "status": "done", "created_at": row.get("created_at"), "updated_at": stamp,
                        "count": len(row.get("members") or []), "active_count": row.get("active_count") or 0}
            item.update({
                "id": f"{kind}:{identifier}",
                "path": f"{CARD_DIR_NAME}/{directory}/{file}",
                "_search": search,
                "_stamp": float(stamp or 0),
                "_active": False,
            })
            out.append(item)
    return out


def list_cards(query: str = "", limit: int = 20, card_id: str = "") -> dict:
    """列出当前可 @ 的卡片；查询同时匹配标题和卡片摘要关键词。"""
    limit = max(1, min(int(limit or 20), 50))
    sync_error = ""
    try:
        sync_if_stale()
    except Exception as exc:
        sync_error = str(exc)[:300]

    rows = db.query(
        "SELECT s.id, s.title, s.kind, s.status, s.created_at, s.started_at, s.duration, "
        "       c.file, c.search "
        "FROM sessions s JOIN card_exports c ON c.session_id=s.id "
        "ORDER BY CASE WHEN s.status IN ('recording','processing','queued','pending') THEN 0 ELSE 1 END, "
        "         COALESCE(s.started_at, s.created_at) DESC, s.id DESC"
    )
    cards = []
    for row in rows:
        file = Path(str(row.get("file") or "")).name
        if not file:
            continue
        path = DATA_DIR / CARD_DIR_NAME / file
        if not path.is_file():
            continue
        cards.append({
            "id": row.get("id"),
            "title": _clean(row.get("title")) or str(row.get("id") or ""),
            "kind": row.get("kind") or "live",
            "status": row.get("status") or "",
            "created_at": row.get("created_at"),
            "started_at": row.get("started_at"),
            "duration": float(row.get("duration") or 0),
            "path": f"{CARD_DIR_NAME}/{file}",
            "_search": str(row.get("search") or ""),
            "_active": row.get("status") in ACTIVE_STATUSES,
            "_stamp": float(row.get("started_at") or row.get("created_at") or 0),
        })

    # 飞书文档卡片与记录卡片共用同一个 @ 分组；它们不参与记录卡同步。
    for row in db.list_doc_cards():
        file = Path(str(row.get("file") or "")).name
        if not file:
            continue
        path = DATA_DIR / CARD_DIR_NAME / file
        if not path.is_file():
            continue
        stamp = float(row.get("updated_at") or row.get("created_at") or 0)
        cards.append({
            "id": f"doc:{row.get('key') or ''}",
            "title": _clean(row.get("title")) or file,
            "kind": "doc",
            "status": "done",
            "source": "feishu",
            "url": str(row.get("url") or ""),
            "doc_type": str(row.get("doc_type") or "docx"),
            "has_content": bool(str(row.get("content") or "").strip()),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
            "started_at": None,
            "duration": 0,
            "path": f"{CARD_DIR_NAME}/{file}",
            "_search": str(row.get("search") or ""),
            "_active": False,
            "_stamp": stamp,
        })

    cards.extend(_aux_list_cards())
    wanted_id = str(card_id or '').strip()
    if wanted_id:
        cards = [card for card in cards if str(card.get('id') or '') == wanted_id]

    needle = _clean(query).casefold()
    if needle:
        def score(card):
            title = str(card["title"]).casefold()
            if title == needle:
                return 0
            if title.startswith(needle):
                return 1
            if needle in title:
                return 2
            if needle in str(card["_search"]).casefold():
                return 3
            return 99

        cards = [card for card in cards if score(card) < 99]
        cards.sort(key=lambda card: (score(card), 0 if card["_active"] else 1, -card["_stamp"]))
    else:
        cards.sort(key=lambda card: (0 if card["_active"] else 1, -card["_stamp"]))

    total = len(cards)
    cards = cards[:limit]
    for card in cards:
        card.pop("_search", None)
        card.pop("_active", None)
        card.pop("_stamp", None)

    last = _LAST.get("result") or {}
    return {
        "ok": True,
        "cards": cards,
        "total": total,
        "returned": len(cards),
        "query": query or "",
        "synced_at": last.get("updated_at"),
        **({"sync_error": sync_error} if sync_error else {}),
    }
