"""Attribute aligned text to acoustic turns, including zero-duration tokens."""
from bisect import bisect_left


def assign_speakers(units, turns):
    """Return copies; prefer containment, then overlap or distance to an edge."""
    turns = sorted((t for t in turns if t["end"] > t["start"]),
                   key=lambda t: (t["start"], t["end"]))
    if not turns:
        return [dict(u) for u in units]
    ends = [float(t["end"]) for t in turns]
    non_overlapping = all(a["end"] <= b["start"] for a, b in zip(turns, turns[1:]))
    out = []
    for unit in units:
        start, end = float(unit["start"]), float(unit["end"])
        candidates = turns
        if non_overlapping:
            first = max(0, bisect_left(ends, start) - 1)
            last = first + 1
            while last < len(turns) and turns[last]["start"] <= end:
                last += 1
            candidates = turns[first:min(len(turns), last + 1)]
        overlaps = {}
        for turn in candidates:
            shared = max(0.0, min(end, turn["end"]) - max(start, turn["start"]))
            if shared:
                speaker = turn["speaker"]
                overlaps[speaker] = overlaps.get(speaker, 0.0) + shared
        if overlaps:
            speaker = max(overlaps, key=overlaps.get)
            supported = True
        else:
            mid = (start + end) / 2
            containing = [t for t in candidates if t["start"] <= mid < t["end"]]
            if containing:
                speaker = containing[0]["speaker"]
                supported = len(containing) == 1
            else:
                nearest = min(candidates, key=lambda t: min(abs(mid - t["start"]), abs(mid - t["end"])))
                speaker = nearest["speaker"]
                supported = False
        out.append(dict(unit, speaker=speaker, _speaker_supported=supported))
    return out


def attach_zero_duration(units, max_gap=0.25):
    """Use nearby timed speech as anchors; retain labels across real switches."""
    out = [dict(u) for u in units]
    i = 0
    while i < len(out):
        if out[i]["end"] > out[i]["start"]:
            i += 1
            continue
        begin = i
        while i < len(out) and out[i]["end"] <= out[i]["start"]:
            i += 1
        left = out[begin - 1] if begin else None
        right = out[i] if i < len(out) else None
        for unit in out[begin:i]:
            if unit.get("_speaker_supported"):
                continue
            nearby = []
            if left and abs(unit["start"] - left["end"]) <= max_gap:
                nearby.append(left)
            if right and abs(right["start"] - unit["end"]) <= max_gap:
                nearby.append(right)
            labels = {u["speaker"] for u in nearby}
            if len(labels) == 1:
                unit["speaker"] = nearby[0]["speaker"]
            elif nearby and unit["speaker"] not in labels:
                anchor = min(nearby, key=lambda u: min(abs(unit["start"] - u["start"]),
                                                       abs(unit["start"] - u["end"])))
                unit["speaker"] = anchor["speaker"]
    return out
