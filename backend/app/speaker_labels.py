"""说话人呈现规则与"从对话里猜名字"。

移植自知了（Cicada）的 `SpeakerID.swift`，但只搬**产品规则**，不搬声纹算法——MeetClip 后端的
pyannote 已经给出了说话人分段，缺的是"怎么显示、怎么命名、怎么可撤销"：

1. 一个声音攒够 5 句"有内容"的话才显示编号；而且至少两个声音都够格才编号，
   否则一对一通话里会出现"发言人 1 说了整场"这种噪音；
2. 编号一旦显示就不再变（按首次达标时间排序），新声音只能往后加；
3. 用户命名的 > 模型猜的 > "发言人 N"；用户明确选择"就叫发言人 N"要能压住模型的猜测；
4. 模型猜名字必须给证据行，且证据行 ±2 行的邻域里确实有这个人在说话，
   否则判定为片头广告里的自我介绍，直接驳回（连之前的同名猜测一起撤掉）；
5. 同一名字给了两个人时，给话多的那个；
6. 名字改了要回填进纪要文本（"发言人 6" → "张三"）。

注意：这里的编号只是**提示层**，不改写已存的 `meta["speakers"]`，避免影响原有导出与测试。
"""
from __future__ import annotations

import json
import re

SHOWN_AFTER = 5
EVIDENCE_REACH = 2


def substantive(text: str) -> bool:
    """一句足够长、能用来认人的话：三个词，或四个汉字/假名。"""
    text = text or ""
    words = [w for w in text.split() if any(ch.isalpha() for ch in w)]
    if len(words) >= 3:
        return True
    return sum(1 for ch in text if _is_cjk(ch)) >= 4


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return 0x3040 <= code <= 0x30FF or 0x3400 <= code <= 0x9FFF or 0xAC00 <= code <= 0xD7A3


def first_seen(rows: list[dict]) -> dict[str, int]:
    """每个说话人第一次出现的位置。"""
    order: dict[str, int] = {}
    for index, row in enumerate(rows):
        raw = row.get("speaker")
        if raw and raw not in order:
            order[raw] = index
    return order


def qualifying_numbers(rows: list[dict]) -> dict[str, int]:
    """raw 说话人 → 1 起的编号：只有"够格"且至少两人才编号，编号按达标先后固定。"""
    counts: dict[str, int] = {}
    reached: dict[str, int] = {}
    for index, row in enumerate(rows):
        raw = row.get("speaker")
        if not raw or not substantive(row.get("text") or ""):
            continue
        counts[raw] = counts.get(raw, 0) + 1
        if counts[raw] == SHOWN_AFTER and raw not in reached:
            reached[raw] = index
    if len(reached) < 2:
        return {}
    ordered = sorted(reached, key=lambda raw: reached[raw])
    return {raw: position + 1 for position, raw in enumerate(ordered)}


def display_names(rows: list[dict], speakers: dict[str, str] | None) -> dict[str, str]:
    """给提示词用的说话人名：用户命名优先，其次够格的"发言人 N"，其余留空（未识别）。"""
    speakers = speakers or {}
    numbers = qualifying_numbers(rows)
    out = {}
    for raw in {row.get("speaker") for row in rows if row.get("speaker")}:
        named = (speakers.get(raw) or "").strip()
        if named and named != f"发言人 {numbers.get(raw, '')}":
            out[raw] = named
        elif raw in numbers:
            out[raw] = f"发言人 {numbers[raw]}"
        else:
            out[raw] = ""
    return out


def named(notes: dict, names: dict[int, str]) -> dict:
    """纪要里模型可能写"发言人 6 提出…"，改名后显示层替换成姓名（长的先换，防"发言人 1"吃掉"发言人 12"）。"""
    if not names:
        return notes

    def swap(text: str) -> str:
        if "发言人" not in text and "Speaker" not in text:
            return text
        out = text
        for number, name in sorted(names.items(), key=lambda kv: -kv[0]):
            for form in (f"发言人 {number}", f"发言人{number}", f"Speaker {number}"):
                out = out.replace(form, name)
        return out

    result = dict(notes)
    result["summary"] = swap(notes.get("summary") or "")
    result["topics"] = [dict(topic, title=swap(topic.get("title") or ""),
                             summary=swap(topic.get("summary") or ""),
                             points=[dict(point, text=swap(point.get("text") or ""))
                                     for point in topic.get("points") or []])
                        for topic in notes.get("topics") or []]
    for key in ("conclusions", "todos"):
        items = []
        for item in notes.get(key) or []:
            updated = dict(item, text=swap(item.get("text") or ""))
            if item.get("owner"):
                updated["owner"] = swap(item["owner"])
            items.append(updated)
        result[key] = items
    return result


# ---------------- 从对话里猜名字 ----------------

INSTRUCTION = """谁是被标成「发言人 N」的人？只有当转写里说得很清楚时才给名字：
- 这个人在标着他自己编号的行里自我介绍；或
- 有人在他说话的前后一两句里叫出他的名字（"谢谢乔治"紧跟发言人 1 的回答 → 发言人 1 是乔治）；或
- 别人说话时点到了他。
出现在「未识别」行里的名字、离任何「发言人 N」的行都很远的名字（广告、片头、别的节目里的自我介绍），都不是他的。
语音识别是按音写名字的，常写错：如果从名字和内容能看出是公众人物（官员、高管、主持人），按新闻里的正确拼写写；
否则照转写写。不确定的人就不要写。只返回 JSON：{"speakers": [{"speaker": 2, "name": "乔治", "evidence": "L12"}]}，
evidence 是出现名字的那一行编号；没有就返回空列表。回复前再检查一遍每个名字的拼写。"""


def guess_content(rows: list[dict], limit: int = 400) -> str | None:
    """给模型看的转写：只发文字，编号连续，够格的显示编号。"""
    numbers = qualifying_numbers(rows)
    if not numbers:
        return None
    window = rows[-limit:]
    offset = len(rows) - len(window)
    lines = ["会议转写。说话人：未识别 = 对方某人，暂时分辨不出；发言人N = 按声音分出的某个人。\n"]
    for index, row in enumerate(window):
        raw = row.get("speaker")
        who = f"发言人{numbers[raw]}" if raw in numbers else "未识别"
        lines.append(f"[L{offset + index + 1} {_clock(row.get('start') or 0)} {who}] {row.get('text') or ''}\n")
    return "".join(lines)


def _clock(seconds: float) -> str:
    total = max(0, int(seconds or 0))
    return f"{total // 60:02d}:{total % 60:02d}"


def _evidence_line(value) -> int | None:
    match = re.search(r"\d+", str(value or ""))
    return int(match.group()) - 1 if match else None


def read_guess(reply: str, rows: list[dict]) -> tuple[dict[str, dict], dict[str, str]]:
    """解析猜名结果：(采纳, 驳回)。驳回指证据行附近没有这个人在说话。"""
    text = reply.strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {}, {}
    try:
        root = json.loads(text[start:end + 1])
    except ValueError:
        return {}, {}
    numbers = qualifying_numbers(rows)
    number_of = {number: raw for raw, number in numbers.items()}
    counts: dict[str, int] = {}
    for row in rows:
        raw = row.get("speaker")
        if raw:
            counts[raw] = counts.get(raw, 0) + 1
    found: dict[str, dict] = {}
    refuted: dict[str, str] = {}
    for item in root.get("speakers") or []:
        if not isinstance(item, dict):
            continue
        try:
            number = int(str(item.get("speaker")).strip())
        except (TypeError, ValueError):
            continue
        raw = number_of.get(number)
        name = str(item.get("name") or "").strip()
        if not raw or not name or len(name) > 40:
            continue
        index = _evidence_line(item.get("evidence"))
        if index is None or not (0 <= index < len(rows)):
            refuted[raw] = name
            continue
        window = rows[max(0, index - EVIDENCE_REACH):min(len(rows), index + EVIDENCE_REACH + 1)]
        if not any(row.get("speaker") == raw for row in window):
            # "I'm Christina" 出现在广告里，却被算到主持人头上：驳回，连旧猜测一起撤。
            refuted[raw] = name
            continue
        if name in {entry["name"] for entry in found.values()}:
            other = next(raw2 for raw2, entry in found.items() if entry["name"] == name)
            if counts.get(other, 0) >= counts.get(raw, 0):
                continue
            found.pop(other, None)
        row = rows[index]
        quote = row.get("text") or ""
        found[raw] = {"name": name,
                      "evidence": f"{_clock(row.get('start') or 0)} “{quote[:60]}{'…' if len(quote) > 60 else ''}”"}
    return found, refuted


def holds(guess: dict, raw: str, rows: list[dict]) -> bool:
    """存下来的猜测是否仍站得住：按证据里的时间+引文找回那一行，那里的主人还是它。"""
    evidence = str(guess.get("evidence") or "")
    if "“" not in evidence:
        return True
    clock, _, quote = evidence.partition("“")
    clock = clock.strip()
    quote = quote.rstrip("”").split("…")[0]
    for index, row in enumerate(rows):
        if _clock(row.get("start") or 0) == clock and str(row.get("text") or "").startswith(quote):
            window = rows[max(0, index - EVIDENCE_REACH):min(len(rows), index + EVIDENCE_REACH + 1)]
            return any(item.get("speaker") == raw for item in window)
    return True


def merge_guesses(previous: dict | None, found: dict[str, dict], refuted: dict[str, str],
                  rows: list[dict]) -> dict[str, dict]:
    """把这次的结果并进旧猜测：没再提到的人保留，被驳回或被用户否掉的人撤掉。"""
    merged = dict(previous or {})
    for raw, name in refuted.items():
        if raw in merged and merged[raw].get("name") == name:
            merged.pop(raw, None)
    for raw, entry in found.items():
        merged[raw] = entry
    for raw in list(merged):
        if not holds(merged[raw], raw, rows):
            merged.pop(raw, None)
    return merged
