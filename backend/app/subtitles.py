"""Platform caption selection and conversion to the existing transcript rows."""
from __future__ import annotations

import html
import json
import math
import re
import urllib.parse

FORMATS = ("vtt", "srt", "json3", "json")
EXCLUDED = {"danmaku", "live_chat", "comments", "chat"}
ROLLING_GAP = 0.05


def language(code: str) -> str:
    return re.sub(r"-orig$", "", re.sub(r"^ai-", "", code.lower())).replace("_", "-")


def matches_language(a: str, b: str) -> bool:
    a, b = language(a), language(b)
    if not a or not b:
        return False
    # Script distinctions matter for Chinese; regional English codes share audio.
    if a.startswith("zh") or b.startswith("zh"):
        aliases = {"zh-cn": "zh-hans", "zh-tw": "zh-hant"}
        return aliases.get(a, a) == aliases.get(b, b)
    return a.split("-")[0] == b.split("-")[0]


def original_language(info: dict) -> str:
    original = next((language(str(f.get("language") or ""))
                     for f in info.get("formats", [])
                     if f.get("language") and "original" in str(f.get("format_note", "")).lower()), "")
    original = original or language(str(info.get("language") or ""))
    if not original:
        orig = {language(c) for c in (info.get("automatic_captions") or {}) if c.endswith("-orig")}
        if len(orig) == 1:
            original = next(iter(orig))
    return original


def candidates(info: dict, track_id: str | None = None) -> list[dict]:
    """Enumerate readable tracks; keep translation source and target distinct."""
    original = original_language(info)
    tracks = []
    for field, kind in (("subtitles", "manual"), ("automatic_captions", "automatic")):
        for code, formats in (info.get(field) or {}).items():
            if code.lower() in EXCLUDED:
                continue
            lang = language(code)
            source = "automatic" if code.startswith("ai-") else kind
            for track in formats or []:
                ext = str(track.get("ext") or "").lower()
                if ext not in FORMATS or not (track.get("data") or track.get("url")):
                    continue
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(track.get("url") or "").query)
                translated = bool(query.get("tlang"))
                track_kind = "translated" if translated else source
                source_lang = language(query.get("lang", [lang])[0]) if translated else lang
                ident = f"{lang}:{track_kind}"
                tracks.append({"id": ident, "code": code, "language": lang, "kind": track_kind,
                               "source_language": source_lang, "name": track.get("name") or code,
                               "field": field, "ext": ext, "track": track})
    def rank(t):
        lang = t["language"]
        return (not matches_language(lang, original),
                {"manual": 0, "automatic": 1, "translated": 2}[t["kind"]],
                not matches_language(t["source_language"], original),
                t["source_language"], lang,
                not t["code"].endswith("-orig"), FORMATS.index(t["ext"]), t["code"])
    ranked = sorted(tracks, key=rank)
    # A machine translation into a language that already has a direct track only
    # adds a confusing duplicate, e.g. YouTube's Arabic-dub-to-English captions.
    direct = {t["language"] for t in ranked if t["kind"] != "translated"}
    ranked = [t for t in ranked if t["kind"] != "translated" or t["language"] not in direct]
    # One choice per target language and origin. A translation must never silently
    # switch from the video's original language to a dubbed-language caption.
    sources = {}
    seen = set()
    result = []
    for t in ranked:
        sources.setdefault(t["id"], t["source_language"])
        key = (t["id"], t["ext"], t["track"].get("url"), t["track"].get("data"))
        if sources[t["id"]] != t["source_language"] or key in seen:
            continue
        seen.add(key)
        if track_id is None or t["id"] == track_id:
            result.append(t)
    return result


def summary(info: dict) -> dict:
    tracks = candidates(info)
    original = original_language(info)
    choices = {}
    for t in tracks:
        choices.setdefault(t["id"], {k: t[k] for k in
                           ("id", "language", "kind", "name", "source_language")})
    options = sorted(choices.values(), key=lambda t: (
        not matches_language(t["language"], original), not t["language"].startswith("zh"),
        not t["language"].startswith("en"), t["language"],
        {"manual": 0, "automatic": 1, "translated": 2}[t["kind"]]))
    for t in options:
        t["is_original"] = matches_language(t["language"], original)
    chosen = next((t for t in options if t["is_original"]), None)
    if chosen is None and len(options) == 1:
        chosen = options[0]
    result = {"subtitle_tracks": options, "original_language": original or None,
              "default_subtitle_track_id": chosen["id"] if chosen else None,
              "subtitle_selection_required": bool(options and not chosen)}
    if tracks:
        return {**result, "subtitle_status": "available",
                "subtitle_language": chosen["language"] if chosen else None,
                "subtitle_kind": chosen["kind"] if chosen else None}
    return {**result, "subtitle_status": "unknown" if info.get("_subtitle_error") else "none",
            "subtitle_language": None, "subtitle_kind": None}


def clean(text: str) -> str:
    # Strip markup before unescaping: a spoken literal "&lt;...&gt;" is content.
    text = re.sub(r"<[^>]*>", "", text)
    text = re.sub(r"\{\\[^}]*\}", "", text)
    return " ".join(html.unescape(text).replace("\u200b", "").split())


def _seconds(value: str) -> float:
    parts = value.replace(",", ".").split(":")
    if len(parts) not in (2, 3):
        raise ValueError("Invalid caption time")
    values = [float(p) for p in parts]
    if any(v < 0 or not math.isfinite(v) for v in values):
        raise ValueError("Invalid caption time")
    return sum(v * 60 ** i for i, v in enumerate(reversed(values)))


def parse(data: str, ext: str) -> list[tuple]:
    cues = []
    if ext in ("json3", "json"):
        payload = json.loads(data)
        if ext == "json" and "body" in payload:
            cues = [(c.get("from"), c.get("to"), c.get("content", ""))
                    for c in payload["body"]]
        else:
            for event in payload.get("events", []):
                try:
                    start = float(event["tStartMs"]) / 1000
                    end = start + float(event["dDurationMs"]) / 1000
                    text = "".join(s.get("utf8", "") for s in event.get("segs", []))
                    cues.append((start, end, text))
                except (KeyError, TypeError, ValueError):
                    continue
    elif ext in ("vtt", "srt"):
        # A cue ends at the next timing line or an empty line. YouTube cue text
        # can begin with a whitespace-only line, which must stay in the cue.
        lines = data.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").split("\n")
        timings = [i for i, line in enumerate(lines) if "-->" in line]
        for n, i in enumerate(timings):
            stop = timings[n + 1] if n + 1 < len(timings) else len(lines)
            body = []
            for line in lines[i + 1:stop]:
                if line == "":
                    break
                body.append(line)
            try:
                a, b = lines[i].split("-->", 1)
                cues.append((_seconds(a.strip()), _seconds(b.strip().split()[0]), " ".join(body)))
            except (ValueError, IndexError):
                pass
    else:
        raise ValueError("Unsupported caption format")
    valid = []
    for a, b, text in cues:
        try:
            a, b, text = float(a), float(b), clean(text)
        except (ValueError, TypeError):
            continue
        if not text or not math.isfinite(a) or not math.isfinite(b) or a < 0 or b <= a:
            continue
        valid.append((a, b, text))
    rows = []
    previous = None
    for a, b, text in sorted(valid, key=lambda c: (c[0], c[1])):
        raw = text
        # Rolling captions repeat the previous line in the next cue. YouTube's
        # automatic VTT places those cues back to back instead of overlapping
        # them, so a cue that starts where the previous one ends is also rolling.
        if previous and a <= previous[1] + ROLLING_GAP:
            old = previous[2]
            if text == old:
                if rows:
                    last = rows[-1]
                    rows[-1] = (last[0], max(last[1], b), last[2], None)
                previous = (a, max(b, previous[1]), raw)
                continue
            # Remove only the repeated prefix; genuine repeated speech stays.
            for length in range(min(len(old), len(text)), 1, -1):
                if old[-length:] == text[:length]:
                    text = text[length:].strip()
                    break
            if not text and rows:
                last = rows[-1]
                rows[-1] = (last[0], max(last[1], b), last[2], None)
        if text:
            rows.append((a, b, text, None))
        previous = (a, b, raw)
    return rows
