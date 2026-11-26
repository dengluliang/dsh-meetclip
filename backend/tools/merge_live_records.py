#!/usr/bin/env python3
"""把同一场直播被断流切开的碎片记录合并成一条完整记录。

场景：直播中途断流，历史版本只能手动停止再重录，一场发布会因此变成 6～10 条记录。
这个脚本按时间顺序把它们的媒体无损拼接、把转写/截图/标记的时间轴按各段真实容器
时长顺延，写出一条新记录，原始碎片一条都不删。

用法（在 dsh-meetclip/ 下）：
  # 先看方案，不动数据
  ~/.dsh/meetclip/venv/bin/python backend/tools/merge_live_records.py \
      --room 3373007 --dry-run

  # 真正执行（先自动备份 zhibo.db）
  ~/.dsh/meetclip/venv/bin/python backend/tools/merge_live_records.py \
      --room 3373007 --apply --title "小鹏科技日 2026 AI DAY（完整版）"

  # 只合并指定记录（按给定顺序）
  ... --ids df6876be4ba0,6e343a4ecec7 --apply

注意：正在录制/处理的记录会被跳过；等采集结束再合并。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

SKIP_STATES = ("recording", "pending", "processing", "queued")
VIDEO_KEYS = ("codec_name", "width", "height", "r_frame_rate")
AUDIO_KEYS = ("codec_name", "sample_rate", "channels")


def which(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise SystemExit(f"缺少 {name}，请先安装 ffmpeg")
    return found


FFMPEG = which("ffmpeg")
FFPROBE = which("ffprobe")


def probe(path: Path) -> dict:
    result = {"duration": 0.0, "video": {}, "audio": {}}
    if not path.exists() or path.stat().st_size == 0:
        return result
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries",
                        "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
                        "-of", "json", str(path)], capture_output=True, text=True, timeout=120)
    try:
        data = json.loads(r.stdout or "{}")
    except ValueError:
        return result
    try:
        result["duration"] = float((data.get("format") or {}).get("duration") or 0)
    except (TypeError, ValueError):
        result["duration"] = 0.0
    for stream in data.get("streams") or []:
        if stream.get("codec_type") == "video" and not result["video"]:
            result["video"] = {k: stream.get(k) for k in VIDEO_KEYS}
        elif stream.get("codec_type") == "audio" and not result["audio"]:
            result["audio"] = {k: stream.get(k) for k in AUDIO_KEYS}
    return result


def run(cmd, timeout=7200) -> bool:
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if r.returncode != 0:
        tail = (r.stderr or b"").decode(errors="ignore").strip().splitlines()[-3:]
        print("  ! ffmpeg 失败：", " / ".join(tail)[:400])
        return False
    return True


def human(seconds: float) -> str:
    seconds = int(round(seconds or 0))
    return f"{seconds // 3600}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def clock(ts: float) -> str:
    if not ts:
        return "-"
    return time.strftime("%H:%M:%S", time.localtime(ts))


class MergeError(Exception):
    pass


class MergePlan:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.db_path = data_dir / "zhibo.db"
        if not self.db_path.exists():
            raise MergeError(f"找不到数据库：{self.db_path}")
        self.conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True, timeout=30)
        self.conn.row_factory = sqlite3.Row

    def rows(self, room: str | None, ids: list[str]) -> list[dict]:
        if ids:
            marks = ",".join("?" * len(ids))
            rows = self.conn.execute(
                f"SELECT * FROM sessions WHERE id IN ({marks})", ids).fetchall()
            by_id = {r["id"]: dict(r) for r in rows}
            ordered = [by_id[i] for i in ids if i in by_id]
            missing = [i for i in ids if i not in by_id]
            if missing:
                raise MergeError("找不到这些记录：" + ", ".join(missing))
            return ordered
        if not room:
            raise MergeError("需要 --room 或 --ids")
        rows = self.conn.execute(
            "SELECT * FROM sessions WHERE source_url LIKE ? ORDER BY created_at",
            (f"%{room}%",)).fetchall()
        picked = []
        for row in rows:
            try:
                meta = json.loads(row["meta"] or "{}")
            except ValueError:
                meta = {}
            if meta.get("merged_from"):
                print(f"跳过（这是上一次合并的产物）：{row['id']}")
                continue
            picked.append(dict(row))
        return picked

    def build(self, rows: list[dict], include_active: bool = False) -> list[dict]:
        segments = []
        offset = 0.0
        for row in rows:
            if row.get("kind") == "link_video":
                continue
            if not include_active and row.get("status") in SKIP_STATES:
                print(f"跳过（仍在处理）：{row['id']} {row['status']}")
                continue
            media_name = row.get("media_path")
            media = self.data_dir / row["id"] / media_name if media_name else None
            if not media or not media.exists():
                print(f"跳过（没有媒体）：{row['id']} {row.get('status')}")
                continue
            info = probe(media)
            if info["duration"] <= 0.05:
                print(f"跳过（媒体不可解析）：{row['id']} {media.name}")
                continue
            transcripts = self.conn.execute(
                "SELECT start, end, text, speaker FROM transcripts WHERE session_id=? ORDER BY start",
                (row["id"],)).fetchall()
            shots = self.conn.execute(
                "SELECT ts, path, ocr_text FROM screenshots WHERE session_id=? ORDER BY ts",
                (row["id"],)).fetchall()
            marks = self.conn.execute(
                "SELECT ts, note FROM marks WHERE session_id=? ORDER BY ts", (row["id"],)).fetchall()
            segments.append({
                "row": row, "media": media, "offset": offset, "duration": info["duration"],
                "info": info, "transcripts": [dict(t) for t in transcripts],
                "shots": [dict(s) for s in shots], "marks": [dict(m) for m in marks],
            })
            offset += info["duration"]
        return segments


def gap_report(segments: list[dict]) -> list[dict]:
    gaps = []
    for prev, nxt in zip(segments, segments[1:]):
        end = prev["row"].get("ended_at") or 0
        start = nxt["row"].get("started_at") or nxt["row"].get("created_at") or 0
        if end and start and start > end:
            gaps.append({"from": end, "to": start, "seconds": start - end,
                         "after": prev["row"]["id"], "before": nxt["row"]["id"]})
    return gaps


def describe(segments: list[dict], gaps: list[dict]) -> str:
    lines = ["合并方案：", ""]
    total = 0.0
    for index, seg in enumerate(segments, 1):
        row = seg["row"]
        total += seg["duration"]
        print(f"  {index:>2}. {row['id']}  {clock(row.get('started_at'))}–{clock(row.get('ended_at'))}  "
              f"{human(seg['duration'])}  tr={len(seg['transcripts'])} shots={len(seg['shots'])}  "
              f"offset={human(seg['offset'])}  {row['title'][:32]}")
        lines.append(f"| {index} | {row['id']} | {clock(row.get('started_at'))}–{clock(row.get('ended_at'))} "
                     f"| {human(seg['duration'])} | {len(seg['transcripts'])} | {len(seg['shots'])} |")
    print(f"\n  合计媒体 {human(total)}，{sum(len(s['transcripts']) for s in segments)} 条转写，"
          f"{sum(len(s['shots']) for s in segments)} 张截图")
    if gaps:
        print("  断档：")
        for gap in gaps:
            print(f"    {clock(gap['from'])} → {clock(gap['to'])}  约 {int(gap['seconds'])} 秒"
                  f"（{gap['after']} → {gap['before']}）")
    return "\n".join(lines)


def merge_specs(segments: list[dict]) -> dict:
    first = segments[0]["info"]
    target = {"video": dict(first["video"]), "audio": dict(first["audio"])}
    mismatched = []
    for index, seg in enumerate(segments[1:], 2):
        if seg["info"]["video"] != target["video"] or seg["info"]["audio"] != target["audio"]:
            mismatched.append(index)
    return {"target": target, "mismatched": mismatched}


def transcode(src: Path, dst: Path, target: dict) -> bool:
    video = target.get("video") or {}
    audio = target.get("audio") or {}
    w, h = video.get("width"), video.get("height")
    cmd = [FFMPEG, "-y", "-loglevel", "error", "-i", str(src)]
    if w and h:
        cmd += ["-vf", f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"]
    cmd += ["-r", str(video.get("r_frame_rate") or 30),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac", "-b:a", "160k",
            "-ar", str(audio.get("sample_rate") or 48000),
            "-ac", str(audio.get("channels") or 2),
            "-movflags", "+faststart", str(dst)]
    return run(cmd)


def concat_copy(files: list[Path], work: Path, out: Path) -> bool:
    listing = work / "concat.txt"
    listing.write_text("".join(f"file '{f.resolve()}'\n" for f in files), encoding="utf-8")
    cmd = [FFMPEG, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
           "-i", str(listing), "-map", "0:v?", "-map", "0:a?", "-c", "copy",
           "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", str(out)]
    return run(cmd)


def backup_db(db_path: Path) -> Path:
    target = db_path.parent / "backups"
    target.mkdir(exist_ok=True)
    dest = target / f"zhibo-before-merge-{time.strftime('%Y%m%d-%H%M%S')}.db"
    src = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=30)
    dst = sqlite3.connect(str(dest))
    with dst:
        src.backup(dst)
    dst.close()
    src.close()
    return dest


def register_pack(base: str, token: str, title: str, member_ids: list[str]) -> None:
    """把原始碎片收进一个卡包（合并版单独留在墙上）；失败只提示，不影响合并结果。"""
    members = [{"type": "session", "id": sid} for sid in member_ids]
    body = json.dumps({"title": title, "members": members}, ensure_ascii=False).encode()
    req = urllib.request.Request(f"{base.rstrip('/')}/api/packs", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "x-meetclip-token": token})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read().decode() or "{}")
        pack_id = (payload.get("pack") or {}).get("id")
        if pack_id:
            print(f"  已创建卡包：{title}（{pack_id}）")
    except Exception as exc:
        print(f"  ! 创建卡包失败（不影响合并）：{exc}")


def apply_merge(plan: MergePlan, segments: list[dict], gaps: list[dict], title: str,
                pack_title: str | None, keep_pack: bool) -> str:
    data_dir = plan.data_dir
    new_id = uuid.uuid4().hex[:12]
    dest = data_dir / new_id
    dest.mkdir(parents=True, exist_ok=False)
    work = Path(tempfile.mkdtemp(prefix=f"merge-{new_id}-", dir=str(data_dir)))
    started = segments[0]["row"].get("started_at") or segments[0]["row"].get("created_at")
    ended = segments[-1]["row"].get("ended_at") or time.time()
    print(f"\n合并到新记录 {new_id} · {title}")
    try:
        files = []
        spec = merge_specs(segments)
        target = spec["target"]
        for index, seg in enumerate(segments, 1):
            source = seg["media"]
            if index > 1 and (seg["info"]["video"] != target["video"] or seg["info"]["audio"] != target["audio"]):
                print(f"  分段 {index} 画质/编码不一致，转码对齐…")
                normalized = work / f"norm_{index}.mp4"
                if not transcode(source, normalized, target):
                    raise MergeError(f"分段 {index} 转码失败（{source.name}）")
                files.append(normalized)
            else:
                files.append(source)
        merged_media = dest / "media.mp4"
        print("  拼接媒体（-c copy）…")
        if not concat_copy(files, work, merged_media):
            raise MergeError("媒体拼接失败；没有写入任何记录")
        info = probe(merged_media)
        expected = sum(seg["duration"] for seg in segments)
        if info["duration"] <= 0.05:
            raise MergeError("拼接后的媒体无法解析")
        if abs(info["duration"] - expected) > max(15.0, expected * 0.05):
            print(f"  ! 拼接时长 {human(info['duration'])} 与各段之和 {human(expected)} 差得较多，请抽查")

        shots_dir = dest / "shots"
        shots_dir.mkdir(exist_ok=True)
        transcripts, shots = [], []
        overflow_note = 0
        for seg in segments:
            offset, duration = seg["offset"], seg["duration"]
            for row in seg["transcripts"]:
                start = min(float(row["start"] or 0), max(0.0, duration - 0.2))
                end = min(float(row["end"] or 0), max(start + 0.2, duration))
                text = row["text"] or ""
                if float(row["start"] or 0) >= duration - 0.2:
                    overflow_note += 1
                    text = text + "（本段音频超出媒体时长，时间点不精确）"
                transcripts.append((offset + start, offset + end, text, row.get("speaker")))
            for row in seg["shots"]:
                ts = offset + min(float(row["ts"] or 0), duration)
                name = f"shot_{int(round(ts * 1000)):09d}.jpg"
                target_file = shots_dir / name
                suffix = 1
                while target_file.exists():
                    suffix += 1
                    target_file = shots_dir / f"shot_{int(round(ts * 1000)):09d}_{suffix}.jpg"
                source_file = data_dir / seg["row"]["id"] / (row["path"] or "")
                if source_file.exists():
                    shutil.copy2(source_file, target_file)
                    shots.append((ts, f"shots/{target_file.name}", row.get("ocr_text") or ""))
        marks = []
        for seg in segments:
            for row in seg["marks"]:
                marks.append((seg["offset"] + min(float(row["ts"] or 0), seg["duration"]), row.get("note") or ""))
        cover = data_dir / segments[0]["row"]["id"] / "cover.jpg"
        if cover.exists():
            shutil.copy2(cover, dest / "cover.jpg")

        total = info["duration"]
        meta = {
            "stream_quality": segments[0]["row"].get("stream_quality")
            or json.loads(segments[0]["row"].get("meta") or "{}").get("stream_quality") or "",
            "has_video": True, "has_audio": True, "asr_status": "done",
            "transcription_source": "asr", "merged_at": round(time.time(), 1),
            "merged_from": [seg["row"]["id"] for seg in segments],
            "merged_parts": len(segments),
            "merged_gaps": [{"from": gap["from"], "to": gap["to"], "seconds": round(gap["seconds"], 1)}
                            for gap in gaps],
            "merged_overflow_rows": overflow_note,
        }
        rows = []
        for index, seg in enumerate(segments, 1):
            row = seg["row"]
            rows.append(f"| {index} | {row['id']} | {clock(row.get('started_at'))}–{clock(row.get('ended_at'))} "
                        f"| {human(seg['duration'])} | {len(seg['transcripts'])} | {len(seg['shots'])} |")
        notes = [
            f"# {title}",
            "",
            f"> 由 {len(segments)} 条断流碎片合并（{human(total)}，{len(transcripts)} 条转写，{len(shots)} 张截图）。"
            "原始碎片都保留在卡包里；本记录时间轴按各段媒体容器时长顺延。",
            "",
            "## 来源分段",
            "",
            "| # | 记录 | 时间窗 | 时长 | 转写 | 截图 |",
            "| --- | --- | --- | --- | --- | --- |",
            *rows,
            "",
        ]
        if gaps:
            notes += ["## 断档（直播流中断、没有录到的部分）", ""]
            for gap in gaps:
                notes.append(f"- {clock(gap['from'])} → {clock(gap['to'])}，约 {int(gap['seconds'])} 秒")
            notes += ["", f"合计约 {int(sum(g['seconds'] for g in gaps))} 秒。", ""]
        if overflow_note:
            notes += ["## 已知偏差", "",
                      f"有一段媒体的容器时长比音频内容短，{overflow_note} 条转写被夹到该段末尾并标注「时间点不精确」。", ""]
        notes += ["## 纪要", "",
                  "这条记录没有自动纪要。在详情页点「生成纪要」即可按合并后的转写重新生成一次。", ""]
        note_text = "\n".join(notes)

        with sqlite3.connect(str(plan.db_path), timeout=30) as conn:
            with conn:
                conn.execute(
                    "INSERT INTO sessions(id,title,source_url,platform,status,source_type,created_at,started_at,"
                    "ended_at,duration,media_path,error,meta,kind,notes,notes_version,normalized_url) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (new_id, title, segments[0]["row"].get("source_url"), "bilibili", "done", "live",
                     time.time(), started, ended, total, "media.mp4", None,
                     json.dumps(meta, ensure_ascii=False), "live", note_text, 1,
                     segments[0]["row"].get("normalized_url")))
                conn.executemany(
                    "INSERT INTO transcripts(session_id,start,end,text,created_at,speaker) VALUES(?,?,?,?,?,?)",
                    [(new_id, s, e, t, time.time(), speaker) for s, e, t, speaker in transcripts])
                conn.executemany(
                    "INSERT INTO screenshots(session_id,ts,path,ocr_text,created_at) VALUES(?,?,?,?,?)",
                    [(new_id, ts, path, ocr or "", time.time()) for ts, path, ocr in shots])
                conn.executemany(
                    "INSERT INTO marks(session_id,ts,note,created_at) VALUES(?,?,?,?)",
                    [(new_id, ts, note, time.time()) for ts, note in marks])
        print(f"  写入完成：{len(transcripts)} 条转写，{len(shots)} 张截图，{len(marks)} 条标记")
        print(f"  媒体：{dest / 'media.mp4'}（{human(total)}）")
        return new_id
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="合并同一场直播的断流碎片记录")
    parser.add_argument("--data-dir", default=os.environ.get("ZHIBO_DATA_DIR") or "",
                        help="资料库目录（默认取 ZHIBO_DATA_DIR）")
    parser.add_argument("--room", default="", help="直播房间号：合并该房间的全部碎片")
    parser.add_argument("--ids", default="", help="逗号分隔的记录 id（按给定顺序合并）")
    parser.add_argument("--title", default="", help="合并后记录标题")
    parser.add_argument("--pack-title", default="", help="原始碎片的卡包名（默认自动）")
    parser.add_argument("--apply", action="store_true", help="真正写库（默认只 dry-run）")
    parser.add_argument("--dry-run", action="store_true", help="只打印方案")
    parser.add_argument("--include-active", action="store_true", help="连正在录制/处理的记录也合并（不建议）")
    parser.add_argument("--api", default="http://127.0.0.1:8321", help="本地后端地址（用于建卡包）")
    parser.add_argument("--no-pack", action="store_true", help="不创建原始碎片卡包")
    args = parser.parse_args()

    data_dir = Path(args.data_dir).expanduser() if args.data_dir else Path(__file__).resolve().parents[1] / "data"
    if not data_dir.exists():
        print(f"资料库目录不存在：{data_dir}", file=sys.stderr)
        return 2
    plan = MergePlan(data_dir)
    ids = [x.strip() for x in args.ids.split(",") if x.strip()]
    rows = plan.rows(args.room or None, ids)
    segments = plan.build(rows, include_active=args.include_active)
    if not segments:
        print("没有可合并的碎片（都需要有媒体、且不在录制/处理中）")
        return 1
    gaps = gap_report(segments)
    describe(segments, gaps)
    spec = merge_specs(segments)
    if spec["mismatched"]:
        print(f"  注意：第 {spec['mismatched']} 段画质/编码不一致，合并时会转码对齐（比较慢）")
    if not args.apply:
        print("\n这是 dry-run；加 --apply 才会真正写库（会先备份 zhibo.db）。")
        return 0
    title = args.title or f"{segments[0]['row']['title']}（完整版）"
    backup = backup_db(plan.db_path)
    print(f"  已备份数据库：{backup}")
    new_id = apply_merge(plan, segments, gaps, title, args.pack_title, True)
    token_path = data_dir / ".api-token"
    if token_path.exists() and not args.no_pack:
        pack_title = args.pack_title or f"{title} · 原始碎片"
        try:
            register_pack(args.api, token_path.read_text(encoding="utf-8").strip(), pack_title,
                          [seg["row"]["id"] for seg in segments])
        except Exception:
            pass
    print(f"\n完成：{new_id} {title}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
