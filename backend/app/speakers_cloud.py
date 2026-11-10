"""Optional cloud speaker labelling seam.

This ASR endpoint returns plain text only: it has no speaker or timestamp
fields and rejects text prompts, so no provider ships today. A future cloud
diarization service can register a callable here without touching the
transcription pipeline. Until then every helper is a no-op.
"""
PROVIDERS = {}  # name -> callable(audio_path, num_speakers) -> [{"start","end","speaker"}]


def register(name, provider):
    PROVIDERS[name] = provider


def unregister(name):
    PROVIDERS.pop(name, None)


def available():
    return bool(PROVIDERS)


def label_rows(rows, turns):
    """Attach one speaker to each (start, end, text, speaker) row by time overlap."""
    if not turns:
        return rows
    labeled = []
    for row in rows:
        start, end, text, speaker = row
        if speaker:
            labeled.append(row)
            continue
        overlaps = {}
        for turn in turns:
            shared = min(end, turn["end"]) - max(start, turn["start"])
            if shared > 0:
                overlaps[turn["speaker"]] = overlaps.get(turn["speaker"], 0.0) + shared
        if overlaps:
            speaker = max(overlaps, key=overlaps.get)
        elif end > start:
            midpoint = (start + end) / 2
            near = min(
                turns,
                key=lambda turn: 0.0
                if turn["start"] <= midpoint <= turn["end"]
                else min(abs(midpoint - turn["start"]), abs(midpoint - turn["end"])),
            )
            speaker = near["speaker"]
        labeled.append((start, end, text, speaker))
    return labeled


def maybe_label(rows, wav_path, options):
    """Run the first registered provider; unchanged rows when none is available."""
    if not rows or not PROVIDERS:
        return rows, {}
    for provider in PROVIDERS.values():
        turns = provider(wav_path, (options or {}).get("num_speakers")) or []
        labeled = label_rows(rows, turns)
        order = []
        for _, _, _, speaker in labeled:
            if speaker and speaker not in order:
                order.append(speaker)
        return labeled, {raw: f"发言人 {index + 1}" for index, raw in enumerate(order)}
    return rows, {}
