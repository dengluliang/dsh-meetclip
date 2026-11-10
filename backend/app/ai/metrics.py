"""每场一份 metrics.jsonl：只记数字与枚举（耗时、排队、结果、token），不记任何文本。

知了（Cicada）的经验：把 p50/p95 三个数列出来，就足以判断"是网络慢还是模型慢"；
而"复制诊断信息"只要只含数字，就可以放心让用户贴给别人。
"""
import json
import time

from database import session_dir

MAX_ROWS = 4000


def record(session_id: str | None, kind: str = "call", **fields):
    if not session_id:
        return
    row = {"type": kind, "at": round(time.time(), 3), **fields}
    try:
        path = session_dir(session_id) / "metrics.jsonl"
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    except OSError:
        pass


def read(session_id: str, limit: int = MAX_ROWS) -> list[dict]:
    path = session_dir(session_id) / "metrics.jsonl"
    if not path.exists():
        return []
    rows = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    except OSError:
        return []
    return rows[-limit:]


def stat(values: list[float]) -> dict | None:
    xs = sorted(float(v) for v in values if v is not None)
    if not xs:
        return None

    def pick(q: float) -> float:
        return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))]

    return {"p50": round(pick(0.5), 3), "p95": round(pick(0.95), 3), "n": len(xs)}


def summary(session_id: str) -> dict:
    """按 用途/服务/模型 分组：次数、失败数、耗时、token；外加一口总体数。"""
    rows = [r for r in read(session_id) if r.get("type") == "call"]
    groups: dict[str, dict] = {}
    for row in rows:
        key = "|".join(str(row.get(k, "")) for k in ("role", "provider", "model"))
        g = groups.setdefault(key, {"role": row.get("role"), "provider": row.get("provider"),
                                    "model": row.get("model"), "calls": 0, "failed": 0,
                                    "seconds": [], "tokens": 0, "reasons": {}})
        g["calls"] += 1
        outcome = str(row.get("outcome") or "")
        if outcome and outcome != "ok":
            g["failed"] += 1
            g["reasons"][outcome] = g["reasons"].get(outcome, 0) + 1
        if outcome == "ok":
            g["seconds"].append(row.get("seconds") or 0)
        g["tokens"] += int(row.get("prompt_tokens") or 0) + int(row.get("completion_tokens") or 0)
    uses = []
    for g in groups.values():
        uses.append({"role": g["role"], "provider": g["provider"], "model": g["model"],
                     "calls": g["calls"], "failed": g["failed"], "tokens": g["tokens"],
                     "latency": stat(g["seconds"]),
                     "reasons": sorted(g["reasons"].items(), key=lambda kv: -kv[1])})
    uses.sort(key=lambda u: (-u["calls"], str(u["role"])))
    return {"calls": len(rows),
            "failed": sum(1 for r in rows if r.get("outcome") not in (None, "ok")),
            "latency": stat([r.get("seconds") for r in rows if r.get("outcome") == "ok"]),
            "queue": stat([r.get("queue") for r in rows]),
            "tokens": sum(int(r.get("prompt_tokens") or 0) + int(r.get("completion_tokens") or 0) for r in rows),
            "uses": uses}


def report_lines(session_id: str, title: str = "") -> list[str]:
    """给"复制诊断信息"用的纯数字文本。"""
    data = summary(session_id)
    def fmt(s):
        return f"p50 {s['p50']:.2f}s p95 {s['p95']:.2f}s n={s['n']}" if s else "-"
    lines = [f"MeetClip 纪要诊断  {time.strftime('%Y-%m-%d %H:%M')}" + (f"  {title}" if title else "")]
    lines.append(f"AI 请求 {data['calls']} 次 · 失败 {data['failed']} · 耗时 {fmt(data['latency'])} · 排队 {fmt(data['queue'])} · token {data['tokens']}")
    for use in data["uses"]:
        line = f"{use['role']} {use['provider']} {use['model']} {fmt(use['latency'])} calls={use['calls']} failed={use['failed']}"
        if use["reasons"]:
            line += " (" + ", ".join(f"{k} {v}" for k, v in use["reasons"]) + ")"
        if use["tokens"]:
            line += f" tokens={use['tokens']}"
        lines.append(line)
    return lines
