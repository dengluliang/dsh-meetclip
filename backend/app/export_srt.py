"""字幕与文档导出：SRT / VTT / DOCX，只用标准库。

时间轴的算法来自知了（Cicada）：**用下一行的开始时间推本行的结束时间**，夹在 [t+1, t+8] 秒之间；
最后一行没有下一行，就给 4 秒。比"每行固定 3 秒"在真实语速下准确得多。
"""
from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

from database import db, session_dir


def _row_end(rows: list[dict], index: int) -> float:
    row = rows[index]
    start = float(row.get("start") or 0)
    if index + 1 < len(rows):
        following = float(rows[index + 1].get("start") or start)
        return max(start + 1.0, min(following, start + 8.0))
    return start + 4.0


def _srt_time(seconds: float) -> str:
    ms = int(round(max(0.0, seconds) * 1000))
    return f"{ms // 3_600_000:02d}:{ms // 60_000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def _vtt_time(seconds: float) -> str:
    return _srt_time(seconds).replace(",", ".")


def _display(rows: list[dict], speakers: dict[str, str]) -> list[dict]:
    out = []
    for row in rows:
        text = (row.get("text") or "").strip()
        if not text:
            continue
        raw = row.get("speaker")
        out.append({"start": float(row.get("start") or 0), "end": float(row.get("end") or 0),
                    "text": text, "speaker": (speakers.get(raw) or "").strip() if raw else ""})
    return out


def build_srt(sid: str) -> str:
    sess = db.get_session(sid) or {}
    rows = _display(db.get_transcripts(sid), (sess.get("meta") or {}).get("speakers") or {})
    blocks = []
    for index, row in enumerate(rows):
        blocks.append(f"{index + 1}\n{_srt_time(row['start'])} --> {_srt_time(_row_end(rows, index))}\n"
                      f"{row['text']}\n")
    return "\n".join(blocks)


def build_vtt(sid: str) -> str:
    """VTT 顺带带上说话人（`<v 张三>`），播放器会显示成"张三：…"。"""
    sess = db.get_session(sid) or {}
    rows = _display(db.get_transcripts(sid), (sess.get("meta") or {}).get("speakers") or {})
    lines = ["WEBVTT", ""]
    for index, row in enumerate(rows):
        text = row["text"]
        if row["speaker"]:
            text = f"<v {row['speaker']}>{text}"
        lines.append(f"{_vtt_time(row['start'])} --> {_vtt_time(_row_end(rows, index))}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


# ---------------- DOCX（标准库生成，不引入依赖） ----------------
_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

_DOC_HEAD = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>')


def _para(text: str = "", *, bold: bool = False, size: int | None = None, color: str | None = None,
          after: int = 4) -> str:
    props = [f'<w:spacing w:after="{after}"/>']
    if size:
        props.append(f'<w:sz w:val="{size}"/>')
    if color:
        props.append(f'<w:color w:val="{color}"/>')
    run_props = []
    if bold:
        run_props.append("<w:b/>")
    if size:
        run_props.append(f'<w:sz w:val="{size}"/>')
    if color:
        run_props.append(f'<w:color w:val="{color}"/>')
    run = (f'<w:r><w:rPr>{"".join(run_props)}</w:rPr><w:t xml:space="preserve">{escape(text)}</w:t></w:r>'
           if text else "")
    return f'<w:p><w:pPr>{"".join(props)}</w:pPr>{run}</w:p>'


def _clock(seconds: float) -> str:
    total = max(0, int(seconds or 0))
    if total >= 3600:
        return f"{total // 3600}:{total % 3600 // 60:02d}:{total % 60:02d}"
    return f"{total // 60:02d}:{total % 60:02d}"


def build_docx(sid: str) -> bytes:
    """标题 + 元信息 + 纪要（若已生成）+ 逐行转写。"""
    import minutes as minutes_mod

    sess = db.get_session(sid) or {}
    meta = sess.get("meta") or {}
    speakers = meta.get("speakers") or {}
    body = [_para(sess.get("title") or "记录", bold=True, size=36, after=6)]
    info = []
    if sess.get("started_at"):
        import time as _time
        info.append(_time.strftime("%Y-%m-%d %H:%M", _time.localtime(sess["started_at"])))
    if sess.get("duration"):
        info.append(f"时长 {_clock(sess['duration'])}")
    if meta.get("language"):
        info.append(str(meta["language"]))
    if info:
        body.append(_para(" · ".join(info), size=18, color="666666", after=12))

    notes = minutes_mod.engine.get(sid)
    if notes.get("topics") or notes.get("summary"):
        body.append(_para("纪要", bold=True, size=24, after=6))
        if notes.get("summary"):
            body.append(_para(notes["summary"], size=21, after=8))
        for topic in notes.get("topics") or []:
            body.append(_para(f"{_clock(topic.get('start') or 0)}  {topic.get('title') or ''}",
                              bold=True, size=22, after=2))
            if topic.get("summary"):
                body.append(_para(topic["summary"], size=20, color="666666", after=2))
            for point in topic.get("points") or []:
                body.append(_para(f"• {point.get('text')}", size=20, after=1))
            fishbone = topic.get("fishbone")
            if fishbone:
                body.append(_para(f"【{fishbone.get('question')}】", size=20, bold=True, after=1))
                for branch in fishbone.get("branches") or []:
                    body.append(_para(f"    – {branch.get('label')}：{branch.get('detail')}", size=19, after=1))
        for key, title in (("conclusions", "结论"), ("todos", "待办")):
            items = notes.get(key) or []
            if not items:
                continue
            body.append(_para(title, bold=True, size=22, after=2))
            for item in items:
                owner = f"（{item['owner']}）" if item.get("owner") else ""
                prefix = "☐ " if key == "todos" else "• "
                body.append(_para(f"{prefix}{item.get('text')}{owner}", size=20, after=1))
        if notes.get("terms"):
            body.append(_para("人名和术语", bold=True, size=22, after=2))
            for term in notes["terms"]:
                heard = f"（听作 {'、'.join(term['heard'])}）" if term.get("heard") else ""
                body.append(_para(f"• {term.get('name')}　{term.get('note')}{heard}", size=20, after=1))
        body.append(_para("文字记录", bold=True, size=24, after=4))

    for row in _display(db.get_transcripts(sid), speakers):
        head = f"[{_clock(row['start'])}]" + (f" {row['speaker']}" if row["speaker"] else "")
        body.append(_para(head, size=16, bold=True, color="999999", after=0))
        body.append(_para(row["text"], size=21, after=6))

    xml = _DOC_HEAD + "".join(body) + "<w:sectPr/></w:body></w:document>"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", _TYPES)
        archive.writestr("_rels/.rels", _RELS)
        archive.writestr("word/document.xml", xml)
    return buffer.getvalue()


def _filename(sess: dict, suffix: str) -> str:
    safe = re.sub(r'[\\/:*?"<>|]+', "_", (sess.get("title") or sess.get("id") or "record"))[:80]
    return f"{safe}.{suffix}"


def write_files(sid: str) -> dict:
    """把三种格式落到记录目录，返回路径（导出弹层的下载链接用）。"""
    sess = db.get_session(sid)
    if not sess:
        raise ValueError("记录不存在")
    out = session_dir(sid) / "export"
    out.mkdir(parents=True, exist_ok=True)
    paths = {"srt": out / _filename(sess, "srt"), "vtt": out / _filename(sess, "vtt"),
             "docx": out / _filename(sess, "docx")}
    paths["srt"].write_text(build_srt(sid), encoding="utf-8")
    paths["vtt"].write_text(build_vtt(sid), encoding="utf-8")
    paths["docx"].write_bytes(build_docx(sid))
    return {key: str(path) for key, path in paths.items()}
