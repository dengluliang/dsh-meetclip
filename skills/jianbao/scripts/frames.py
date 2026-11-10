#!/usr/bin/env python3
"""按小节区间为发布会记录配图。

设计原则（对应 SKILL.md 第 4 步）：
- A 源优先：<dataDir>/<session>/shots/ 里会摘直播录制时自动截的屏（文件名含毫秒时间戳）
- B 源兜底：<dataDir>/<session>/media.mp4 做 scene 变化检测，只留画面明显变化的帧（PPT 翻页）
- 只按时间归属，不读取画面内容（不做视觉理解，图注由组稿阶段写）
- 去重 + 每小节上限 + 全篇上限

用法：
  python3 frames.py --session-id dfb8229ad18f --plan plan.json --out frames/
  python3 frames.py --session-id xxx --plan plan.json --out frames/ --source scene --scene-th 0.25
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)

MEDIA_NAMES = ("media.mp4", "media.mkv", "media.webm", "media.m4v")
DATA_DIR_CANDIDATES = [
    os.environ.get("MEETCLIP_DATA_DIR", ""),
    os.path.expanduser("~/.dsh/meetclip/data"),
    os.path.expanduser("~/Documents/直播摘录/data"),
]


def log(msg: str) -> None:
    print(msg, flush=True)


def find_session_dir(session_id: str, explicit: str | None) -> str:
    cands = ([explicit] if explicit else []) + DATA_DIR_CANDIDATES
    for base in cands:
        if not base:
            continue
        path = os.path.join(os.path.expanduser(base), session_id)
        if os.path.isdir(path):
            return path
    sys.exit(f"找不到记录目录：{session_id}（可用 --data-dir 指定）")


def find_media(session_dir: str) -> str | None:
    for name in MEDIA_NAMES:
        p = os.path.join(session_dir, name)
        if os.path.exists(p):
            return p
    hits = [p for p in glob.glob(os.path.join(session_dir, "media.*")) if os.path.getsize(p) > 1_000_000]
    return hits[0] if hits else None


def count_shots(session_dir: str) -> int:
    return len(glob.glob(os.path.join(session_dir, "shots", "*.jpg")))


# ---------------------------------------------------------------- A 源：现成截图
def shots_pool(session_dir: str) -> list[tuple[float, str]]:
    pool = []
    for path in glob.glob(os.path.join(session_dir, "shots", "*.jpg")):
        m = re.search(r"shot_(\d+)", os.path.basename(path))
        if m:
            pool.append((int(m.group(1)) / 1000.0, path))
    pool.sort()
    return pool


# ---------------------------------------------------------------- B 源：scene 检测
def scene_pool(media: str, threshold: float) -> list[tuple[float, float]]:
    """返回全片的 [(ts, score)]，按时间升序。一次解码全片，约视频时长的 1/30。"""
    with tempfile.NamedTemporaryFile("r+", suffix=".txt", delete=False) as tmp:
        meta_path = tmp.name
    cmd = [
        "ffmpeg", "-hide_banner", "-nostats", "-loglevel", "error", "-i", media,
        "-an", "-vf", f"select='gt(scene,{threshold})',metadata=print:file={meta_path}",
        "-f", "null", "-",
    ]
    log(f"[scene] 正在检测画面变化（阈值 {threshold}）… 全片约需 {max(1, os.path.getsize(media)//15_000_000)} 秒量级")
    subprocess.run(cmd, check=False)
    pool, pending = [], None
    try:
        with open(meta_path, "r", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                m = re.search(r"pts_time:([\d.]+)", line)
                if m:
                    pending = float(m.group(1))
                    continue
                s = re.search(r"scene_score=([\d.]+)", line)
                if s and pending is not None:
                    pool.append((pending, float(s.group(1))))
                    pending = None
    finally:
        os.unlink(meta_path)
    pool.sort()
    return pool


# ---------------------------------------------------------------- 去重
def dhash(path: str) -> int | None:
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        with Image.open(path) as im:
            im = im.convert("L").resize((9, 8))
            px = list(im.tobytes())
        bits = 0
        for row in range(8):
            for col in range(8):
                left = px[row * 9 + col]
                right = px[row * 9 + col + 1]
                bits = (bits << 1) | (1 if left > right else 0)
        return bits
    except Exception:
        return None


def is_dup(h: int | None, seen: list[int], max_hamming: int = 6) -> bool:
    if h is None:
        return False
    for prev in seen:
        if bin(prev ^ h).count("1") <= max_hamming:
            return True
    return False


# ---------------------------------------------------------------- 抽帧
def grab(media: str, ts: float, out_path: str, width: int) -> bool:
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{ts:.2f}", "-i", media,
        "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "3", "-y", out_path,
    ]
    return subprocess.run(cmd, check=False).returncode == 0 and os.path.exists(out_path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session-id", required=True)
    ap.add_argument("--plan", required=True, help="plan.json（含 sections[{id,start,end,h3}]）")
    ap.add_argument("--out", default="frames")
    ap.add_argument("--data-dir", default=None)
    ap.add_argument("--source", default="auto", choices=["auto", "shots", "scene"])
    ap.add_argument("--scene-th", type=float, default=0.20)
    ap.add_argument("--max-per-section", type=int, default=0, help="0 = 用 plan 里的值或 4")
    ap.add_argument("--total-cap", type=int, default=80)
    ap.add_argument("--width", type=int, default=1600)
    args = ap.parse_args()

    plan = json.load(open(args.plan, encoding="utf-8"))
    sections = plan.get("sections") or []
    if not sections:
        sys.exit("plan.json 里没有 sections")
    cap = args.max_per_section or int(plan.get("max_per_section") or 4)

    session_dir = find_session_dir(args.session_id, args.data_dir)
    media = find_media(session_dir)
    n_shots = count_shots(session_dir)
    source = args.source
    if source == "auto":
        source = "shots" if n_shots else ("scene" if media else "none")

    os.makedirs(args.out, exist_ok=True)
    manifest: dict[str, list[dict]] = {s["id"]: [] for s in sections}
    log(f"记录目录：{session_dir}")
    log(f"素材：现成截图 {n_shots} 张｜视频 {'有' if media else '无'}｜采用 {source} 源")

    if source == "none":
        json.dump(manifest, open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=2)
        log("无画面素材，manifest 为空。组稿时按 SKILL.md 降级处理。")
        return

    # 候选池
    if source == "shots":
        pool = [{"ts": ts, "src": p, "score": 1.0} for ts, p in shots_pool(session_dir)]
        log(f"[shots] 候选 {len(pool)} 张，按小节区间筛选")
    else:
        if not media:
            sys.exit("选择了 scene 源但没有找到 media.mp4")
        pool = [{"ts": ts, "src": media, "score": sc} for ts, sc in scene_pool(media, args.scene_th)]
        log(f"[scene] 检出画面变化帧 {len(pool)} 个")
        if not pool:
            log("警告：scene 阈值过高，一个变化帧都没检出；将退化为按时长均匀取样。")

    # 逐小节选帧
    seq = 0
    seen_hashes: list[int] = []
    for idx, sec in enumerate(sections):
        start, end = float(sec["start"]), float(sec["end"])
        cands = [c for c in pool if start <= c["ts"] < end]
        if not cands:
            # 兜底：小节内均匀取点
            span = max(end - start, 1.0)
            n = min(3, max(1, int(span // 60)))
            cands = [{"ts": start + span * (i + 0.5) / n, "src": media, "score": 0.0} for i in range(n)]
        # 先按 score 取 top，再按时间排序
        cands.sort(key=lambda c: -c["score"])
        picked = []
        for c in cands:
            if len(picked) >= cap:
                break
            if picked and abs(c["ts"] - picked[-1]["ts"]) < 1.0:
                continue
            picked.append(c)
        picked.sort(key=lambda c: c["ts"])

        for c in picked:
            if seq >= args.total_cap:
                break
            seq += 1
            mm, ss = divmod(int(c["ts"]), 60)
            out_path = os.path.join(args.out, f"{seq:03d}_{mm:02d}{ss:02d}.jpg")
            if source == "shots":
                shutil.copyfile(c["src"], out_path)
            else:
                if not grab(media, c["ts"], out_path, args.width):
                    os.path.exists(out_path) and os.unlink(out_path)
                    seq -= 1
                    continue
            h = dhash(out_path)
            if is_dup(h, seen_hashes):
                os.unlink(out_path)
                seq -= 1
                continue
            if h is not None:
                seen_hashes.append(h)
            manifest[sec["id"]].append({"file": os.path.abspath(out_path), "ts": round(c["ts"], 2),
                                        "score": round(c["score"], 3)})
        log(f"  [{idx+1}/{len(sections)}] {str(sec.get('h3') or sec['id'])[:28]:<30} "
            f"{start/60:6.1f}–{end/60:6.1f}min → {len(manifest[sec['id']])} 张")

    manifest_path = os.path.join(args.out, "manifest.json")
    json.dump(manifest, open(manifest_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    total = sum(len(v) for v in manifest.values())
    empty = [k for k, v in manifest.items() if not v]
    log(f"完成：共 {total} 张 → {os.path.abspath(args.out)}")
    if empty:
        log(f"注意：{len(empty)} 个小节没有取到图（{', '.join(empty[:6])}）")
    log(f"manifest: {os.path.abspath(manifest_path)}")


if __name__ == "__main__":
    main()
