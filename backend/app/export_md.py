"""Markdown 导出（F-40/F-41）：元信息 + 转写全文 + 截图 + 标记。"""
import shutil
import zipfile
from pathlib import Path

from database import db, session_dir


def _fmt_ts(sec):
    sec = max(0, int(sec or 0))
    return f"{sec//60:02d}:{sec%60:02d}"


def _clock(sec):
    sec = max(0, int(sec or 0))
    return f"{sec//3600:02d}:{sec%3600//60:02d}:{sec%60:02d}" if sec >= 3600 else f"{sec//60:02d}:{sec%60:02d}"


def _notes_text(sess, has_minutes_section):
    """笔记里可能已经包含 AI 纪要段落：导出时去重，避免同一份总结出现两次。"""
    notes = str(sess.get("notes") or "")
    try:
        import minutes_notes
        if minutes_notes.has_block(notes):
            return minutes_notes.strip_block(notes) if has_minutes_section else minutes_notes.strip_markers(notes)
    except Exception:
        pass
    return notes


def _minutes_section(sid, is_link=False):
    """AI 纪要写进 Markdown：与笔记段落、复制共用 minutes_notes 的渲染，只差标题层级。

    导出文档自己已经有 `## 纪要` 这一节，所以内部的节标题从三级开始，避免和
    「会议信息 / 参会人 / 标记」这些二级标题并列。
    """
    try:
        import minutes as minutes_mod
        import minutes_notes
        payload = minutes_mod.engine.get(sid)
    except Exception:
        return []
    return minutes_notes.build_export(payload, links=False)


def _write_media_formats(sid, out: Path):
    """顺带导出 SRT / VTT / Word：跟着 ZIP 一起带走，不用再点一次。"""
    try:
        import export_srt
        if not db.get_transcripts(sid):
            return
        (out / "transcript.srt").write_text(export_srt.build_srt(sid), encoding="utf-8")
        (out / "transcript.vtt").write_text(export_srt.build_vtt(sid), encoding="utf-8")
        (out / "transcript.docx").write_bytes(export_srt.build_docx(sid))
    except Exception:
        # 导出 Markdown/ZIP 是主路径；字幕/Word 失败不该让整次导出失败。
        pass


def _export_meeting(sess, out_dir=None):
    import time as _t
    sid = sess["id"]
    src = session_dir(sid)
    out = Path(out_dir) if out_dir else src / "export"
    out.mkdir(parents=True, exist_ok=True)
    trs = db.get_transcripts(sid)
    marks = db.get_marks(sid)
    meta = sess.get("meta") if isinstance(sess.get("meta"), dict) else {}
    names = meta.get("speakers") or {}

    def who(t):
        return names.get(t.get("speaker"), t.get("speaker") or "")

    def clock(sec):
        sec = max(0, int(sec or 0))
        return f"{sec//3600:02d}:{sec%3600//60:02d}:{sec%60:02d}" if sec >= 3600 else f"{sec//60:02d}:{sec%60:02d}"

    is_link = sess.get("kind") == "link_video"
    lines = [f"# {sess['title']}", "", "## 视频信息" if is_link else "## 会议信息", ""]
    if is_link:
        lines.append(f"- 来源：{sess.get('source_url') or '-'}")
        lines.append(f"- 平台：{sess.get('platform') or '-'}")
        if meta.get("transcription_source"):
            kind = {"automatic": "自动字幕", "translated": "自动翻译字幕"}.get(meta.get("subtitle_kind"), "人工字幕")
            lines.append(f"- 转写来源：{'平台' + kind if meta['transcription_source'] == 'subtitle' else 'MiMo 云端 ASR' if (meta.get('asr_engine') or {}).get('provider') == 'mimo' else '本地 ASR'}")
            if meta.get("subtitle_kind") == "translated" and meta.get("subtitle_source_language"):
                lines.append(f"- 字幕翻译来源语言：{meta['subtitle_source_language']}")
    if sess.get("started_at"):
        lines.append(f"- {'处理时间' if is_link else '导入时间'}：{_t.strftime('%Y-%m-%d %H:%M', _t.localtime(sess['started_at']))}")
    lines.append(f"- 时长：{clock(sess.get('duration'))}")
    if meta.get("language"):
        lines.append(f"- 语种：{meta['language']}")
    if meta.get("hotwords"):
        lines.append(f"- 热词：{meta['hotwords']}")
    lines.append(f"- 时间戳：{'字幕时间轴' if meta.get('transcription_source') == 'subtitle' else '词级对齐' if meta.get('aligned') else '片段级' if meta.get('timing_precision') == 'chunk' else '句级'}")
    if sess.get("status") == "error":
        lines.append(f"- 异常说明：{sess.get('error') or '未知'}")
    lines.append("")

    talk = {}
    for t in trs:
        k = t.get("speaker")
        if k:
            talk[k] = talk.get(k, 0) + max(0.0, t["end"] - t["start"])
    if talk:
        total = sum(talk.values()) or 1
        lines += ["## 说话人" if is_link else "## 参会人", ""]
        for k, v in sorted(talk.items(), key=lambda kv: -kv[1]):
            lines.append(f"- {names.get(k, k)}（发言约 {clock(v)}，{v / total:.0%}）")
        lines.append("")

    if marks:
        lines += ["## 标记", ""]
        for m in marks:
            note = f" — {m['note']}" if m.get("note") else ""
            lines.append(f"- [{clock(m['ts'])}]{note}")
        lines.append("")

    minutes_section = _minutes_section(sid, is_link)
    lines += minutes_section

    notes = _notes_text(sess, bool(minutes_section))
    if notes.strip():
        lines += ["## 笔记", "", notes.strip("\n"), ""]

    lines += ["## 转写全文" if is_link else "## 会议记录", ""]
    for t in trs:
        speaker = who(t)
        head = f"**{speaker}** [{clock(t['start'])}]" if speaker else f"[{clock(t['start'])}]"
        lines += [head, "", t["text"], ""]
    (out / "notes.md").write_text("\n".join(lines), encoding="utf-8")
    _write_media_formats(sid, out)
    zip_path = src / f"export_{sid}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in out.rglob("*"):
            if f.is_file():
                z.write(f, f.relative_to(out))
    return {"dir": str(out), "zip": str(zip_path),
            "markdown": (out / "notes.md").read_text(encoding="utf-8")}


def export_markdown(sid, out_dir=None):
    sess = db.get_session(sid)
    if not sess:
        raise ValueError("记录不存在")
    if sess.get("kind") in ("meeting", "link_video"):
        return _export_meeting(sess, out_dir)
    src = session_dir(sid)
    out = Path(out_dir) if out_dir else src / "export"
    out.mkdir(parents=True, exist_ok=True)
    shots_out = out / "shots"
    shots_out.mkdir(exist_ok=True)

    trs = db.get_transcripts(sid)
    shots = db.get_screenshots(sid)
    marks = db.get_marks(sid)

    lines = []
    lines.append(f"# {sess['title']}")
    lines.append("")
    lines.append("## 元信息")
    lines.append("")
    lines.append(f"- 来源：{sess.get('source_url') or '本地导入'}")
    lines.append(f"- 平台：{sess.get('platform', '-')}")
    lines.append(f"- 时长：{_fmt_ts(sess.get('duration'))}")
    import time as _t
    if sess.get("started_at"):
        lines.append(f"- 采集时间：{_t.strftime('%Y-%m-%d %H:%M', _t.localtime(sess['started_at']))}")
    lines.append(f"- 状态：{sess.get('status')}")
    if sess.get("status") == "error":
        lines.append(f"- 异常说明：{sess.get('error') or '未知'}（部分内容可能缺失）")
    lines.append("")

    if marks:
        lines.append("## 标记")
        lines.append("")
        for m in marks:
            note = f" — {m['note']}" if m.get("note") else ""
            lines.append(f"- [{_fmt_ts(m['ts'])}]{note}")
        lines.append("")

    minutes_section = _minutes_section(sid)
    notes = _notes_text(sess, bool(minutes_section))
    if notes.strip():
        lines += ["## 笔记", "", notes.strip("\n"), ""]

    lines += minutes_section

    lines.append("## 转写全文")
    lines.append("")
    shot_by_ts = {int(s["ts"]): s for s in shots}
    for t in trs:
        lines.append(f"[{_fmt_ts(t['start'])}] {t['text']}")
        # 在转写点附近插入截图
        for sts, s in list(shot_by_ts.items()):
            if abs(sts - t["start"]) <= 2:
                rel = f"shots/{Path(s['path']).name}"
                lines.append(f"\n![{_fmt_ts(s['ts'])} 截图]({rel})\n")
                del shot_by_ts[sts]
    lines.append("")

    # 未在转写附近出现的截图追加到末尾
    if shot_by_ts:
        lines.append("## 其他截图")
        lines.append("")
        for sts, s in sorted(shot_by_ts.items()):
            rel = f"shots/{Path(s['path']).name}"
            lines.append(f"![{_fmt_ts(s['ts'])} 截图]({rel})")
        lines.append("")

    (out / "notes.md").write_text("\n".join(lines), encoding="utf-8")

    # 拷贝截图（F-41 相对路径可用）
    for s in shots:
        p = src / s["path"]
        if p.exists():
            shutil.copy2(p, shots_out / Path(s["path"]).name)

    _write_media_formats(sid, out)

    # 打 zip 方便带走
    zip_path = src / f"export_{sid}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in out.rglob("*"):
            if f.is_file():
                z.write(f, f.relative_to(out))
    return {"dir": str(out), "zip": str(zip_path),
            "markdown": (out / "notes.md").read_text(encoding="utf-8")}
