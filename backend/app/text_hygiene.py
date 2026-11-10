"""转写文本卫生：清洗识别噪声、定稿不如草稿时留住草稿、把被停顿切开的句子接回去。

来自知了（Cicada）的 `HeardText.swift`。半小时的代码，但每天都能少看几处「in..........」
「, , that」「。 ，」这类噪声——它们还会被翻译和纪要放大成更坏的东西。
"""
from __future__ import annotations

import re

_ELLIPSIS = "…"
# 行首残留：上一句断开时掉到下一行开头的标点。
_LEAD = ".,;:!?…、，。；：！？-–— \t\n"
_END_STOP = "?!？！"

# 没有人声的片段（静音、掌声、音乐、换气）上，识别器会把控制标记当正文吐出来：
# `<chinese>`、`<|zh|>`、`<|NEUTRAL|>`、`<|Speech|>`。它们不是内容；长一点的空白片段
# 还会把同一个标记重复到输出上限。清洗时一律丢掉，只剩标记的片段按空处理。
_TAG_ANGLE = re.compile(r"<\s*\|[^<>|]{1,24}\|\s*>|<\s*[A-Za-z][A-Za-z_\- ]{1,23}\s*>")
_TAG_BRACKET = re.compile(
    r"\[\s*(?:chinese|english|cantonese|japanese|korean|mandarin|zh|en|ja|ko|yue|"
    r"music|applause|laughter|noise|silence|speech)\s*\]", re.I)


def strip_tags(text: str) -> str:
    """去掉识别器漏出来的控制标记（语言标签、情绪/事件标记）。"""
    s = _TAG_BRACKET.sub("", text or "")
    return _TAG_ANGLE.sub("", s)


def _has_content(text: str) -> bool:
    return any(ch.isalnum() for ch in text)


def noise(text: str) -> bool:
    """整段只有标记和标点（没有人声）：这种片段不该出现在转写里。"""
    return not _has_content(strip_tags(text))


def clean(text: str) -> str:
    """去掉控制标记、呼吸/犹豫留下的重复标点、标点前的空格，以及行首的残余标点。"""
    s = strip_tags(text or "")
    # 两个以上的点（中间可夹空格或逗号）合成一个省略号。
    s = re.sub(r"\s*[.。]{2,}|\s*…+", _ELLIPSIS, s)
    s = re.sub(r"…(?:[\s,，]*…)+", _ELLIPSIS, s)
    # ", ," 与 ",," 都只是一个逗号；逗号贴着省略号时省略号就够了。
    s = re.sub(r"([,，])(?:\s*[,，])+", r"\1", s)
    s = re.sub(r"[,，]\s*…|…\s*[,，]", _ELLIPSIS, s)
    # "UALE ," → "UALE,"
    s = re.sub(r"\s+([,，.。…?？!！;；:：])", r"\1", s)
    s = re.sub(r"\s{2,}", " ", s)
    s = s.lstrip(_LEAD).strip()
    # 只剩标点/标记的片段（静音、纯掌声）返回空串，调用方据此跳过这一段。
    return s if _has_content(s) else ""


def _has_cjk(text: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in text)


def size(text: str) -> int:
    """中文按字算，其他语言按词算（大致一比二的体量关系）。"""
    if _has_cjk(text):
        return sum(1 for ch in text if ch.isalnum())
    return len([w for w in text.split() if any(ch.isalnum() for ch in w)])


def fuller(final: str, draft: str) -> str:
    """定稿比草稿明显短时用草稿。

    快速说话、没有停顿时，识别器的定稿会整句丢词（"needs the budget. / for next year by the end.
    of this month. / in."），而草稿只是偶尔拼错一个词——丢五个词比错一个词糟得多。
    """
    if not draft:
        return final
    final, draft = clean(final), clean(draft)
    cjk = _has_cjk(final + draft)
    f, d = size(final), size(draft)
    if d >= f + (6 if cjk else 3) and d >= f * 1.15:
        return draft
    return final


JOIN_GAP = 1.5      # 停顿不超过这个秒数，仍可能是同一句话被切开
JOIN_WORDS = 40     # 一行已经这么长就不再往里加：太长既难读，翻译也慢


def continues(previous: str, following: str, gap: float, cut: bool = True) -> bool:
    """`following` 是接着 `previous` 说的同一句，而不是新的一句？"""
    if not previous or not following:
        return False
    if not (-0.5 <= gap <= JOIN_GAP):
        return False
    cjk = _has_cjk(previous)
    length = len(previous) / 2 if cjk else size(previous)
    if length >= JOIN_WORDS:
        return False
    last = previous.rstrip()[-1:]
    first = following.lstrip()[:1]
    if last in _END_STOP:
        return False
    if last in ".。":
        # 句号若是我们自己按停顿"猜"出来的（cut），下一句小写则忽略它。
        return bool(cut and first.islower())
    return True


def join(previous: str, following: str) -> str:
    """把两句接成一句：去掉切断时猜出来的句号；中文直接拼，其他语言补一个空格。"""
    head = previous.rstrip()
    if head.endswith(".") and not head.endswith("…"):
        head = head[:-1]
    if head.endswith("。"):
        head = head[:-1]
    if _has_cjk(head + following):
        return head + following.lstrip()
    return head + " " + following.lstrip()


def merge(rows: list[dict]) -> list[dict]:
    """把被停顿切碎的相邻行合并（说话人相同、间隔够短、句子没说完）。

    rows: [{start, end, text, speaker}]，返回同样结构的行（时间取首尾）。
    """
    out: list[dict] = []
    for row in rows:
        text = clean(row.get("text") or "")
        if not text:
            continue
        item = {"start": float(row.get("start") or 0), "end": float(row.get("end") or 0),
                "text": text, "speaker": row.get("speaker")}
        if out:
            previous = out[-1]
            same = (previous.get("speaker") or "") == (item.get("speaker") or "")
            gap = item["start"] - previous["end"]
            if same and continues(previous["text"], text, gap):
                previous["text"] = join(previous["text"], text)
                previous["end"] = item["end"]
                continue
        out.append(item)
    return out
