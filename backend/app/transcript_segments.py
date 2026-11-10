"""Readable transcript paragraphs, independent of the ASR inference chunks.

Prefer sentence ends and audible pauses; bound unpunctuated speech without
splitting dictionary words or product names. Timing stays attached to the
original aligned units. Without alignment it remains a chunk-based estimate.
"""
import re

import numpy as np

from speaker_attribution import attach_zero_duration


SENTENCE_END = "。！？!?…；;.?"
MIN_SECONDS = 8.0
TARGET_SECONDS = 25.0
MAX_SECONDS = 45.0
MIN_CHARS = 30
TARGET_CHARS = 120
MAX_CHARS = 240
_CLOSING = '\"\'”’」』）》】)]}'
_PRODUCT = re.compile(
    r"[A-Za-z][A-Za-z0-9_-]*\s*\d[A-Za-z0-9_.-]*(?:\s+(?:Pro|Max|Plus|Ultra|Mini|Air|Duo))*(?![A-Za-z0-9_])",
    re.IGNORECASE,
)
_TITLED_NAME = re.compile(r"\b[A-Z][A-Za-z0-9]*\s+(?:[A-Z][A-Za-z0-9]*\s*)+")
_CONTINUATIONS = {"那", "那么", "所以", "但是", "然后", "不过", "比如", "其实", "因为", "以及", "还有"}
_UNFINISHED = re.compile(r"(?:的|把|被|将|对于|关于|以及|比如|例如|包括|通过|为了|因为|所以|但是|然后)[。；;.]$")
_ACKNOWLEDGEMENTS = {
    "嗯", "嗯嗯", "嗯哼", "啊", "哦", "对", "对对", "对啊", "对的", "好", "好的", "好啊", "好呀",
    "是", "是的", "是啊", "不是", "不", "行", "可以", "有", "没有", "没", "能", "不能", "会", "不会",
    "要", "不要", "知道", "不知道", "了解", "不了解", "明白", "谢谢", "没错", "没事",
}


def _unfinished(text):
    tail = text.rstrip().rstrip(_CLOSING)
    return bool(_UNFINISHED.search(tail)) and not re.search(r"(?:是的|好的|对的)[。；;.]$", tail)


def _stabilize_speakers(units, positions, ends):
    """Suppress brief word-internal flips, while preserving spoken replies."""
    units = attach_zero_duration(units)
    begin = 0
    while begin < len(units):
        stop = begin + 1
        while stop < len(units) and units[stop]["speaker"] == units[begin]["speaker"]:
            stop += 1
        if begin and stop < len(units):
            left, right = units[begin - 1], units[stop]
            text = "".join(u["text"] for u in units[begin:stop]).strip()
            word_internal = positions[begin] not in ends or positions[stop] not in ends
            duration = max(u["end"] for u in units[begin:stop]) - units[begin]["start"]
            if (left["speaker"] is not None and left["speaker"] == right["speaker"]
                    and len(text) <= 3 and duration <= 0.4 and word_internal
                    and text not in _ACKNOWLEDGEMENTS
                    and not re.search(r"[\s，,。.!！？?；;：:]", text)
                    and 0 <= units[begin]["start"] - left["end"] <= 0.12
                    and 0 <= right["start"] - units[stop - 1]["end"] <= 0.12):
                for unit in units[begin:stop]:
                    unit["speaker"] = left["speaker"]
        begin = stop
    return units


def _word_boundaries(text):
    """Chinese alignment units are characters, so find real word ends first."""
    if re.search(r"[\u4e00-\u9fff]", text):
        # Lazy import: old installed runtimes can still run until dependencies
        # are updated, using punctuation/word gaps as a conservative fallback.
        try:
            import jieba
        except ImportError:
            ends = set(range(1, len(text) + 1))
        else:
            ends = {end for _, _, end in jieba.tokenize(text, HMM=False)}
    else:
        ends = {m.end() for m in re.finditer(r"\w+\W*", text)}
    for pattern in (_PRODUCT, _TITLED_NAME):
        for match in pattern.finditer(text):
            ends.difference_update(range(match.start() + 1, match.end()))
    return ends


class _Pauses:
    """Confirm alignment gaps against a relative audio energy envelope.

    This is lightweight energy detection, not semantic sentence detection. A
    sustained quiet interval is required; a single weak consonant is not a cut.
    """
    def __init__(self, audio, sample_rate):
        self.rms = None
        if audio is not None:
            hop = max(1, int(sample_rate * 0.02))
            count = len(audio) // hop
            if count:
                frames = np.asarray(audio[:count * hop]).reshape(count, hop)
                self.rms = np.sqrt(np.mean(frames ** 2, axis=1))
        self.cache = {}

    def gap(self, left, right):
        start, end = float(left["end"]), float(right["start"])
        duration = max(0.0, end - start)
        if self.rms is None or duration < 0.24:
            return duration if self.rms is None else 0.0
        key = (start, end)
        if key in self.cache:
            return self.cache[key]
        a, b = max(0, int(start / 0.02)), min(len(self.rms), int(end / 0.02))
        context = np.concatenate((self.rms[max(0, a - 25):a], self.rms[b:min(len(self.rms), b + 25)]))
        level = float(np.percentile(context, 90)) if len(context) else 0.0
        quiet = self.rms[a:b] <= max(1e-5, level * 0.3)
        longest = run = 0
        for value in quiet:
            run = run + 1 if value else 0
            longest = max(longest, run)
        confirmed = duration if longest * 0.02 >= 0.24 else 0.0
        self.cache[key] = confirmed
        return confirmed


def merge_paragraphs(units, *, audio=None, sample_rate=16000):
    """Return (start, end, text, speaker) rows, keeping original text and times."""
    units = [u for u in units if u.get("text", "").strip()]
    if not units:
        return []
    full = "".join(u["text"] for u in units)
    ends = _word_boundaries(full)
    positions, chars = [0], [0]
    for u in units:
        positions.append(positions[-1] + len(u["text"]))
        chars.append(chars[-1] + len(re.sub(r"\s", "", u["text"])))
    units = _stabilize_speakers(units, positions, ends)
    pauses = _Pauses(audio, sample_rate)
    rows = []
    row_bounds = []

    def ended(i):
        tail = full[max(0, positions[i] - 12):positions[i]]
        return tail.rstrip().rstrip(_CLOSING)[-1:] in SENTENCE_END and not _unfinished(tail)

    def can_cut(i):
        left, right = units[i - 1], units[i]
        # Zero-duration tokens are alignment artifacts; attach them to speech.
        if left["end"] <= left["start"] or right["end"] <= right["start"]:
            return False
        if _unfinished(full[max(0, positions[i] - 12):positions[i]]):
            return False
        if left["text"].strip() in _CONTINUATIONS:
            return False
        if ended(i):
            # A decimal point inside a number is not a sentence end.
            if re.search(r"\d\.$", left["text"]) and re.match(r"\d", right["text"]):
                return False
            return True
        return positions[i] in ends

    def substantial_right(i):
        # Do not create a standalone filler before the next long silence.
        j = i + 1
        while j < len(units) and chars[j] - chars[i] < 6:
            if units[j]["speaker"] != units[i]["speaker"]:
                break
            if units[j]["start"] - units[j - 1]["end"] >= 2.5:
                break
            j += 1
        return chars[j] - chars[i] >= 6

    def score(i):
        if not can_cut(i) or not substantial_right(i):
            return 0.0
        pause = pauses.gap(units[i - 1], units[i])
        if ended(i):
            return 10.0 + min(pause, 2.0)
        if pause >= 0.24:
            return 4.0 + min(pause, 2.0)
        if units[i - 1]["text"].rstrip()[-1:] in "，,、：:":
            return 3.0
        # With continuous speech, a dictionary word boundary is the fallback.
        return 1.0

    def flush(a, b):
        if a < b:
            part = units[a:b]
            rows.append((float(part[0]["start"]), max(float(u["end"]) for u in part),
                         "".join(u["text"] for u in part).strip(), part[0]["speaker"]))
            row_bounds.append((a, b))

    begin, i = 0, 1
    while i < len(units):
        if units[i]["speaker"] != units[i - 1]["speaker"]:
            flush(begin, i)
            begin, i = i, i + 1
            continue
        duration = units[i - 1]["end"] - units[begin]["start"]
        size = chars[i] - chars[begin]
        large = duration >= TARGET_SECONDS or size >= TARGET_CHARS
        enough = duration >= MIN_SECONDS and size >= MIN_CHARS
        pause = pauses.gap(units[i - 1], units[i]) if enough else 0.0
        timing_gap = units[i]["start"] - units[i - 1]["end"]
        sentence_pause = ended(i) and timing_gap >= 1.0 and duration >= 2.0 and size >= 10
        # Sentence endings remain useful when music masks a vocal pause.
        natural = ended(i) and (large or timing_gap >= 1.0) or pause >= (0.6 if large else 1.2)
        if (enough or sentence_pause) and natural and score(i):
            flush(begin, i)
            begin = i
        elif duration >= MAX_SECONDS or size >= MAX_CHARS:
            candidates = []
            for cut in range(begin + 1, i + 1):
                elapsed = units[cut - 1]["end"] - units[begin]["start"]
                count = chars[cut] - chars[begin]
                if elapsed < MIN_SECONDS or count < MIN_CHARS:
                    continue
                quality = score(cut)
                if quality:
                    distance = min(abs(elapsed - TARGET_SECONDS) / TARGET_SECONDS,
                                   abs(count - TARGET_CHARS) / TARGET_CHARS)
                    candidates.append((quality - distance, cut))
            if candidates:
                _, cut = max(candidates)
                flush(begin, cut)
                begin = cut
                # Revisit the carried tail; no unit is lost or emitted twice.
                continue
        i += 1
    flush(begin, len(units))
    if len(rows) > 1:
        prev, tail = rows[-2:]
        if tail[3] == prev[3] and (len(tail[2]) < 6 or tail[1] - tail[0] < 0.2):
            a, b = row_bounds[-2][0], row_bounds[-1][1]
            text = "".join(u["text"] for u in units[a:b]).strip()
            rows[-2:] = [(prev[0], max(prev[1], tail[1]), text, prev[3])]
    return rows
