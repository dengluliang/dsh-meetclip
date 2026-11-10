#!/usr/bin/env python3
"""把 plan.json + frames/manifest.json 装配进文档模板，并按飞书限制自动分批。

实测得到的两个硬约束（2026-11-09 跑通验证）：
1. 本地图片必须写成 file://// + 绝对路径（四个斜杠）。飞书 MCP 会剥掉 "file:///"，
   写三个斜杠会被当成相对路径，报 ENOENT。
2. 单次 doc_create / doc_append 建议 5–12 张图片。40 张一次性提交会出现
   "Image patch failed ... 400"，图片块变成空块（无法回填，只能重建文档）。

输出：outdir/chunk_00.md, chunk_01.md ... 第一个 chunk 用 doc_create，其余用 doc_append。
"""
from __future__ import annotations
import argparse, json, os, re

MAX_IMG_PER_CHUNK = 12  # 实测 5–12 张稳定；单个 ### 块内部不再拆
MAX_IMG_PER_ROW = 3    # 飞书 <grid> 一行最多 3 张，与历史文档一致


def mmss(t: float) -> str:
    t = int(t)
    return f"{t // 60:02d}:{t % 60:02d}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--template", required=True)
    ap.add_argument("--outdir", default=".")
    ap.add_argument("--max-img", type=int, default=MAX_IMG_PER_CHUNK)
    args = ap.parse_args()

    plan = json.load(open(args.plan, encoding="utf-8"))
    man = json.load(open(args.manifest, encoding="utf-8"))
    tpl = open(args.template, encoding="utf-8").read()
    os.makedirs(args.outdir, exist_ok=True)

    # 图片占位 → 分列 grid（每行最多 3 张，与历史文档的 <grid> 排布一致）
    for sec in plan["sections"]:
        items = man.get(sec["id"], [])
        if not items:
            tpl = tpl.replace("{{GRID:%s}}" % sec["id"], "> 本小节未取到画面素材")
            tpl = tpl.replace("{{IMG:%s}}" % sec["id"], "")
            continue
        tags = [f'<image url="file:///{it["file"]}" caption="{sec["h3"]} @{mmss(it["ts"])}"/>'
                for it in items]
        rows = [tags[i:i + MAX_IMG_PER_ROW] for i in range(0, len(tags), MAX_IMG_PER_ROW)]
        block = []
        for row in rows:
            if len(row) == 1:
                block.append(row[0])
                continue
            block.append(f'<grid cols="{len(row)}">')
            for cell in row:
                block.append("<column>\n\n" + cell + "\n\n</column>")
            block.append("</grid>")
        grid_md = "\n".join(block)
        tpl = tpl.replace("{{GRID:%s}}" % sec["id"], grid_md)
        tpl = tpl.replace("{{IMG:%s}}" % sec["id"], grid_md)

    # 回看索引：小节 + 时间区间 + 可点击的时间戳跳转
    src = plan.get("source_url", "")
    join = "&" if "?" in src else "?"
    rows = ["| 小节 | 时间区间 | 回看 |", "|-|-|-|"]
    for sec in plan["sections"]:
        start = int(float(sec["start"]))
        link = f"[{mmss(start)}]({src}{join}t={start})" if src else mmss(start)
        rows.append(f"| {sec['h2']} · {sec['h3']} | {mmss(sec['start'])}–{mmss(sec['end'])} | {link} |")
    tpl = tpl.replace("{{INDEX}}", "\n".join(rows))

    # 源视频嵌入（B 站用原生播放器，其它站点退化为链接）
    if "{{VIDEO}}" in tpl:
        if plan.get("source_kind") == "bilibili" and src:
            video_md = f'<iframe url="{src}" type="1"/>'
        elif src:
            video_md = f"源视频：[{src}]({src})"
        else:
            video_md = ""
        tpl = tpl.replace("{{VIDEO}}", video_md)
    if "{{" in tpl:
        raise SystemExit("模板里还有未替换的占位符")

    # 按"### "三级块切分（图片按 <image 计数，grid 内也计入），并保证每批图片不超过上限
    parts = re.split(r"(?m)^(?=### |## 发布会详情)", tpl)
    chunks, cur, cur_img = [], [], 0
    for part in parts:
        n = part.count("<image ")
        if cur and cur_img + n > args.max_img:
            chunks.append("".join(cur))
            cur, cur_img = [], 0
        cur.append(part)
        cur_img += n
    if cur:
        chunks.append("".join(cur))

    for i, chunk in enumerate(chunks):
        path = os.path.join(args.outdir, f"chunk_{i:02d}.md")
        open(path, "w", encoding="utf-8").write(chunk)
        print(f"chunk_{i:02d}.md  {len(chunk):>6} 字符  图 {chunk.count('<image '):>2} 张")
    print(f"\n共 {len(chunks)} 批：chunk_00 用 doc_create，其余用 doc_append 顺序追加")


if __name__ == "__main__":
    main()
