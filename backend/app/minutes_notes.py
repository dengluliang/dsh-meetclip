"""把结构化 AI 纪要写成笔记里的 Markdown 段落，并在纪要更新后同步。

模板来自 `minutes_scenarios`（会议 / 视频 / 直播），对应知了 Cicada 的 JSON 结构与展示顺序。
段落用 HTML 注释包住，重新整理时只替换这一段；用户写在段落外的笔记永远不动。
"""
from __future__ import annotations

import re
import time

import minutes_interactions
import minutes_scenarios as scenarios
from database import db
from minutes_prompt import clock

BEGIN = "<!-- meetclip:minutes:begin -->"
END = "<!-- meetclip:minutes:end -->"

# 只匹配独占一行的边界，避免误伤正文里提到的字符串。
BLOCK_RE = re.compile(
    r"(?ms)^[ \t]*" + re.escape(BEGIN) + r"[ \t]*\r?\n"
    r".*?"
    r"^[ \t]*" + re.escape(END) + r"[ \t]*(?:\r?\n)?"
)

# 段落在笔记里的固定位置：先写 AI 段落，再空一行接用户自己的笔记。
_SEPARATOR = "\n\n"


def has_block(notes: str | None) -> bool:
    return bool(BLOCK_RE.search(notes or ""))


def extract_block(notes: str | None) -> str:
    match = BLOCK_RE.search(notes or "")
    return match.group(0).strip("\n") if match else ""


def strip_block(notes: str | None) -> str:
    """去掉整段 AI 纪要（含内容与边界），保留用户笔记。"""
    return _tidy(BLOCK_RE.sub("", notes or ""))


def strip_markers(notes: str | None) -> str:
    """只去掉边界注释，保留段落内容（导出时没有结构化纪要行时使用）。"""
    text = (notes or "").replace(BEGIN, "").replace(END, "")
    return _tidy(text)


def _tidy(text: str) -> str:
    text = re.sub(r"[ \t]+\n", "\n", text or "")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip("\n") + "\n" if text.strip() else ""


def _clean(value) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ")
    text = re.sub(r"\s+", " ", text).strip()
    # 不让 AI 文案碰巧写出边界或 HTML 注释，破坏重新整理的定位。
    text = text.replace("<!--", "<! --").replace("-->", "-- >")
    return text


def _paragraph(value) -> str:
    text = _clean(value)
    if text and text[0] in "#>-*+|":
        text = "\\" + text
    return text


def _anchor(seconds, links: bool = True) -> str:
    if seconds is None:
        return ""
    try:
        value = int(max(0, float(seconds)))
    except (TypeError, ValueError):
        return ""
    label = clock(value)
    return f"[{label}](meetclip://seek/{value})" if links else f"[{label}]"


def _point_line(text: str, seconds, links: bool, prefix: str = "- ") -> str:
    anchor = _anchor(seconds, links)
    body = _clean(text)
    return f"{prefix}{anchor} {body}".rstrip() if anchor else f"{prefix}{body}"


def _topic_lines(topic: dict, labels: dict, links: bool, level: int = 3) -> list[str]:
    title = _clean(topic.get("title"))
    anchor = _anchor(topic.get("start"), links)
    marks = "#" * max(1, int(level or 3))
    heading = f"{marks} {anchor} {title}".strip() if title else (f"{marks} {anchor}" if anchor else "")
    out = [heading, ""] if heading else []
    summary = _paragraph(topic.get("summary"))
    if summary:
        out += [summary, ""]
    for point in topic.get("points") or []:
        text = _clean(point.get("text"))
        if text:
            out.append(_point_line(text, point.get("t"), links))
    if out and out[-1] != "":
        out.append("")
    fishbone = topic.get("fishbone") or {}
    branches = fishbone.get("branches") or []
    if branches:
        question = _clean(fishbone.get("question"))
        if question:
            out += [f"**{question}**", ""]
        for branch in branches:
            label = _clean(branch.get("label"))
            detail = _clean(branch.get("detail"))
            body = f"{label}：{detail}" if label else detail
            if body:
                out.append(_point_line(body, branch.get("t"), links))
        out.append("")
    return out


def _summary_lines(payload: dict, labels: dict, level: int = 2) -> list[str]:
    summary = _paragraph(payload.get("summary"))
    return [f"{'#' * level} {labels['summary']}", "", summary, ""] if summary else []


def _timeline_line(payload: dict) -> str:
    """纯文本时间轴：复制和导出没有图，用一行主题索引替代。"""
    topics = [t for t in payload.get("topics") or [] if isinstance(t, dict)]
    if len(topics) < 2:
        return ""
    heading = "Timeline" if scenarios.label_language(payload.get("lang") or "") == "en" else "时间轴"
    parts = []
    for topic in topics:
        try:
            start = max(0, int(float(topic.get("start") or 0)))
        except (TypeError, ValueError):
            start = 0
        title = _clean(topic.get("title"))
        parts.append(f"{clock(start)} {title}".strip())
    return f"**{heading}** " + " · ".join(part for part in parts if part)


def _topics_lines(payload: dict, labels: dict, links: bool, level: int = 2, timeline: bool = False) -> list[str]:
    topics = payload.get("topics") or []
    if not topics:
        return []
    out = [f"{'#' * level} {labels['topics']}", ""]
    if timeline:
        line = _timeline_line(payload)
        if line:
            out += [line, ""]
    for topic in topics:
        if isinstance(topic, dict):
            out += _topic_lines(topic, labels, links, level + 1)
    return out


def _conclusions_lines(payload: dict, labels: dict, links: bool, level: int = 2) -> list[str]:
    items = payload.get("conclusions") or []
    if not items:
        return []
    out = [f"{'#' * level} {labels['conclusions']}", ""]
    for item in items:
        text = _clean(item.get("text"))
        if not text:
            continue
        anchor = _anchor(item.get("t"), links)
        out.append(f"- {text}" + (f" {anchor}" if anchor else ""))
    out.append("")
    return out


def _done_keys(payload: dict) -> set[str]:
    try:
        return minutes_interactions.done_keys(payload.get("interactions"))
    except Exception:
        return set()


def _todo_checked(payload: dict, text: str) -> bool:
    try:
        return minutes_interactions.todo_key(text) in _done_keys(payload)
    except Exception:
        return False


def _todo_line(payload: dict, text: str, owner: str) -> str:
    box = "[x]" if _todo_checked(payload, text) else "[ ]"
    return f"- {box} {text}" + (f"（{owner}）" if owner else "")


def _highlights_lines(payload: dict, labels: dict, links: bool, level: int = 2) -> list[str]:
    """用户高亮：作为单独一节出现在笔记/复制/导出/卡片里，Agent 读 Markdown 时也能看到。

    高亮本身在结构化视图里是原文上的 mark；Markdown 没有等价语法，用带时间锚点的引用列出。
    """
    interactions = payload.get("interactions") or {}
    highlights = [item for item in interactions.get("highlights") or [] if isinstance(item, dict)]
    if not highlights:
        return []
    english = scenarios.label_language(payload.get("lang") or "") == "en"
    out = [f"{'#' * level} " + ("My highlights" if english else "我高亮的内容"), ""]
    for item in highlights:
        quote = _clean(item.get("quote")).replace("[", "\\[").replace("]", "\\]")
        if not quote:
            continue
        anchor = _anchor(item.get("t"), links)
        topic = _clean(item.get("topic"))
        context = (f" ({topic})" if english else f"（{topic}）") if topic else ""
        out.append("- " + (f"{anchor} " if anchor else "") + f"「{quote}」" + context)
    out.append("")
    return out


def _todos_lines(payload: dict, labels: dict, level: int = 2) -> list[str]:
    items = payload.get("todos") or []
    if not items:
        return []
    out = [f"{'#' * level} {labels['todos']}", ""]
    for item in items:
        text = _clean(item.get("text"))
        if not text:
            continue
        out.append(_todo_line(payload, text, _clean(item.get("owner"))))
    out.append("")
    return out


def _outcomes_lines(payload: dict, labels: dict, links: bool, level: int = 2) -> list[str]:
    """会议模板的「结论和待办」：跟 Cicada 的纪要文档一样放在最前。"""
    conclusions = payload.get("conclusions") or []
    todos = payload.get("todos") or []
    if not conclusions and not todos:
        return []
    if conclusions and todos:
        heading = labels["outcomes"]
    elif conclusions:
        heading = labels["conclusions"]
    else:
        heading = labels["todos"]
    out = [f"{'#' * level} {heading}", ""]
    for index, item in enumerate(conclusions, 1):
        text = _clean(item.get("text"))
        if not text:
            continue
        anchor = _anchor(item.get("t"), links)
        out.append(f"{index}. {text}" + (f" {anchor}" if anchor else ""))
    if conclusions and todos:
        out.append("")
    for item in todos:
        text = _clean(item.get("text"))
        if not text:
            continue
        out.append(_todo_line(payload, text, _clean(item.get("owner"))))
    out.append("")
    return out


def _terms_lines(payload: dict, labels: dict, level: int = 2) -> list[str]:
    terms = payload.get("terms") or []
    if not terms:
        return []
    out = [f"{'#' * level} {labels['terms']}", ""]
    for term in terms:
        name = _clean(term.get("name"))
        if not name:
            continue
        note = _clean(term.get("note"))
        heard = [_clean(item) for item in term.get("heard") or [] if _clean(item)]
        line = f"- **{name}**" + (f" {note}" if note else "")
        if heard:
            line += f"（{labels['heard']}：{'、'.join(heard)}）"
        out.append(line)
    out.append("")
    return out


def _section_lines(payload: dict, labels: dict, links: bool, level: int, timeline: bool = False) -> list[str]:
    """按场景顺序渲染各节；`level` 是节标题的层级，主题再低一级。"""
    scenario = payload.get("scenario") or "meeting"
    out: list[str] = []
    for section in scenarios.section_order(scenario):
        if section == "outcomes":
            out += _outcomes_lines(payload, labels, links, level)
        elif section == "summary":
            out += _summary_lines(payload, labels, level)
        elif section == "topics":
            out += _topics_lines(payload, labels, links, level, timeline)
        elif section == "conclusions":
            out += _conclusions_lines(payload, labels, links, level)
        elif section == "todos":
            out += _todos_lines(payload, labels, level)
        elif section == "terms":
            out += _terms_lines(payload, labels, level)
    out += _highlights_lines(payload, labels, links, level)
    return out


def build_body(payload: dict, *, links: bool = True, level: int = 2, tip: bool = True,
               timeline: bool = False) -> str:
    """纪要正文：标题 + 提示 + 各节，不含笔记边界（投影、复制与导出共用）。"""
    scenario = payload.get("scenario") or "meeting"
    language = payload.get("lang") or ""
    labels = scenarios.labels(scenario, language)
    title = _clean(payload.get("title"))
    heading = f"# {scenarios.name(scenario, language)}" + (f" · {title}" if title else "")
    lines = [heading]
    if tip:
        lines.append(f"> {scenarios.tip(scenario, language)}")
    lines.append("")
    lines += _section_lines(payload, labels, links, level, timeline)
    return _tidy("\n".join(lines))


def build_projection(payload: dict, *, links: bool = True) -> str:
    """按当前场景渲染成 Markdown（不带边界），供复制、分享与 Agent 取文本。

    不带「由 AI 生成…」提示行：复制出去的内容只留标题和正文。
    """
    return build_body(payload, links=links, tip=False, timeline=True)


def build_export(payload: dict, *, links: bool = False) -> list[str]:
    """导出文档里的「纪要」一节：接在 `## 纪要` 后面，所以节标题从三级开始。"""
    if not payload.get("summary") and not payload.get("topics"):
        return []
    labels = scenarios.labels(payload.get("scenario") or "meeting", payload.get("lang") or "")
    return ["## 纪要", ""] + _section_lines(payload, labels, links, 3, True)


def build_markdown(payload: dict, *, links: bool = True) -> str:
    """把 `engine.get()` 的纪要转成写进笔记的 Markdown 段落（含边界）。"""
    body = build_body(payload, links=links)
    if not body:
        return ""
    return f"{BEGIN}\n{body}{END}\n"


def apply_block(notes: str | None, block: str) -> str:
    """把新段落写进笔记：有边界原地替换，没有就放在用户内容之上。"""
    block = (block or "").strip("\n")
    text = _tidy(notes or "")
    if not block:
        return text
    matches = list(BLOCK_RE.finditer(text))
    if not matches:
        return _tidy(f"{block}\n\n{text}" if text.strip() else block)
    pieces = []
    cursor = 0
    for index, match in enumerate(matches):
        pieces.append(text[cursor:match.start()])
        if index == 0:
            pieces.append(f"{block}\n")
        cursor = match.end()
    pieces.append(text[cursor:])
    return _tidy("".join(pieces))


def sync(sid: str, payload: dict, *, force: bool = False) -> dict:
    """把纪要写进 `sessions.notes`；CAS 失败时重读重试，绝不吞掉用户刚存的内容。"""
    version = int(payload.get("version") or 0)
    scenario = payload.get("scenario") or "meeting"
    block = build_markdown(payload)
    if not block.strip():
        return {"ok": False, "synced": False, "reason": "empty", "minutes_version": version, "scenario": scenario}
    for _ in range(3):
        sess = db.get_session(sid)
        if not sess:
            return {"ok": False, "synced": False, "reason": "missing", "minutes_version": version, "scenario": scenario}
        notes = sess.get("notes") or ""
        meta = sess.get("meta") or {}
        applied = int(meta.get("minutes_notes_version") or 0)
        # 用户删掉了段落：没有新的纪要版本就不自动加回；「写入笔记」会带 force。
        if not force and version and applied >= version and not has_block(notes):
            return {"ok": True, "synced": False, "reason": "already_applied",
                    "notes_version": sess.get("notes_version") or 0,
                    "minutes_version": version, "scenario": scenario}
        updated = apply_block(notes, block)
        if updated.strip() == notes.strip():
            db.update_meta(sid, minutes_notes_version=version or applied,
                           minutes_notes_at=time.time(), minutes_notes_scenario=scenario)
            return {"ok": True, "synced": False, "reason": "unchanged",
                    "notes_version": sess.get("notes_version") or 0,
                    "minutes_version": version, "scenario": scenario}
        try:
            new_version = db.save_record_notes(sid, updated, sess.get("notes_version") or 0)
        except Exception as exc:  # HTTPException(409) 说明用户刚好也在保存，重读合并
            if getattr(exc, "status_code", None) == 409:
                continue
            return {"ok": False, "synced": False, "reason": "error", "message": str(exc),
                    "minutes_version": version, "scenario": scenario}
        db.update_meta(sid, minutes_notes_version=version or applied,
                       minutes_notes_at=time.time(), minutes_notes_scenario=scenario)
        return {"ok": True, "synced": True, "reason": "written",
                "notes_version": new_version, "minutes_version": version, "scenario": scenario}
    return {"ok": False, "synced": False, "reason": "conflict", "minutes_version": version, "scenario": scenario}
