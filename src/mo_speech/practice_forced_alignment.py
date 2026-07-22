from __future__ import annotations

import math
import re
import subprocess
from pathlib import Path
from typing import Callable


_SILENCE_START_RE = re.compile(r"silence_start:\s*(-?[0-9.]+)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*([0-9.]+)")


def replace_word_timestamps(
    words: list[dict[str, object]],
    aligned_words: list[dict[str, object]],
) -> list[dict[str, object]]:
    """word indexと既存metadataを保ち、fa-zhの時刻だけを移す。"""
    if len(words) != len(aligned_words):
        raise ValueError("forced alignment word count does not match ASR words")

    replaced: list[dict[str, object]] = []
    previous_start = 0.0
    for index, (word, aligned) in enumerate(zip(words, aligned_words)):
        token = str(word.get("text") or "")
        aligned_token = str(aligned.get("text") or "")
        if not token or token != aligned_token:
            raise ValueError("forced alignment tokens do not match ASR words")
        start = _finite_time(aligned.get("start"), "forced alignment start")
        end = _finite_time(aligned.get("end"), "forced alignment end")
        if start < 0 or end < start or (index > 0 and start < previous_start):
            raise ValueError("forced alignment timestamps are invalid")
        replaced.append({**word, "start": round(start, 6), "end": round(end, 6)})
        previous_start = start
    return replaced


def speech_islands_from_silencedetect(
    log_text: str,
    duration_seconds: float,
) -> list[tuple[float, float]]:
    """ffmpeg silencedetectの無音区間を反転して発話島を返す。"""
    duration = _finite_time(duration_seconds, "audio duration")
    if duration <= 0:
        raise ValueError("audio duration must be positive")

    silences: list[tuple[float, float]] = []
    silence_start: float | None = None
    for line in str(log_text or "").splitlines():
        start_match = _SILENCE_START_RE.search(line)
        if start_match:
            silence_start = max(0.0, min(float(start_match.group(1)), duration))
        end_match = _SILENCE_END_RE.search(line)
        if end_match:
            start = 0.0 if silence_start is None else silence_start
            end = max(start, min(float(end_match.group(1)), duration))
            silences.append((start, end))
            silence_start = None
    if silence_start is not None:
        silences.append((silence_start, duration))

    islands: list[tuple[float, float]] = []
    cursor = 0.0
    for start, end in sorted(silences):
        start = max(cursor, start)
        if start > cursor:
            islands.append((round(cursor, 6), round(start, 6)))
        cursor = max(cursor, end)
    if cursor < duration:
        islands.append((round(cursor, 6), round(duration, 6)))
    return [(start, end) for start, end in islands if end > start]


def detect_speech_islands(
    audio_path: Path,
    *,
    runner: Callable[..., object] = subprocess.run,
    silence_threshold_db: int = -35,
    minimum_silence_seconds: float = 0.2,
) -> list[tuple[float, float]]:
    """ffprobeとffmpegを呼び、forced alignment後のVADスナップ用発話島を得る。"""
    try:
        duration_result = runner(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(audio_path),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
        duration = float(str(getattr(duration_result, "stdout", "")).strip())
        silence_result = runner(
            [
                "ffmpeg",
                "-hide_banner",
                "-i",
                str(audio_path),
                "-af",
                (
                    f"silencedetect=noise={int(silence_threshold_db)}dB:"
                    f"d={float(minimum_silence_seconds):.3f}"
                ),
                "-f",
                "null",
                "-",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.SubprocessError, TypeError, ValueError) as exc:
        raise RuntimeError("speech island detection failed") from exc
    return speech_islands_from_silencedetect(
        str(getattr(silence_result, "stderr", "")),
        duration,
    )


def snap_word_timestamps_to_speech_islands(
    words: list[dict[str, object]],
    islands: list[tuple[float, float]],
    *,
    max_distance_seconds: float = 0.35,
) -> list[dict[str, object]]:
    """各発話島で最初と最後に重なるwordだけを島端へスナップする。"""
    window = _finite_time(max_distance_seconds, "VAD snap window")
    if window < 0:
        raise ValueError("VAD snap window must not be negative")
    snapped = [dict(word) for word in words]
    normalized_islands = [
        (float(start), float(end))
        for start, end in islands
        if math.isfinite(float(start)) and math.isfinite(float(end)) and 0 <= start < end
    ]

    assignments: dict[int, list[int]] = {}
    for word_index, word in enumerate(snapped):
        start = _finite_time(word.get("start"), "word start")
        end = _finite_time(word.get("end"), "word end")
        if start < 0 or end < start:
            raise ValueError("word timestamps are invalid")
        overlaps = [
            (max(0.0, min(end, island_end) - max(start, island_start)), island_index)
            for island_index, (island_start, island_end) in enumerate(normalized_islands)
        ]
        overlap, island_index = max(overlaps, default=(0.0, -1))
        if overlap > 0:
            assignments.setdefault(island_index, []).append(word_index)

    for island_index, word_indices in assignments.items():
        island_start, island_end = normalized_islands[island_index]
        first = snapped[word_indices[0]]
        last = snapped[word_indices[-1]]
        first_start = float(first["start"])
        last_end = float(last["end"])
        if abs(first_start - island_start) <= window and island_start < float(first["end"]):
            first["start"] = round(island_start, 6)
        if abs(last_end - island_end) <= window and island_end > float(last["start"]):
            last["end"] = round(island_end, 6)
    return snapped


def _finite_time(value: object, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} is invalid") from exc
    if not math.isfinite(number):
        raise ValueError(f"{label} is invalid")
    return number
