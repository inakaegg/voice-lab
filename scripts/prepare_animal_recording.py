#!/usr/bin/env python3
"""集めてきた実録音を、鳴き声セットと同じ形式（24kHz・モノラル・16bit）へ整える。

やることは3つ。

1. ffmpeg で 24kHz・モノラル・16bit PCM へ揃える。
2. 長い無音や複数の鳴き声が混ざった素材から、代表となる1区間を切り出す
   （CONCEPTS/ZOOVOICE/AUDIO.md のトリム加工仕様に従う）。切り出す位置を
   `--start` と `--end` で指定した場合は、その区間をそのまま使う。
3. 音量を測り、-19 LUFS へそろえる（小さい素材は持ち上げ、大きい素材は下げる）。
   true peak が -1.0 dBFS を超える場合は、超える分だけさらに下げる。
   合成した最終音声を -19 LUFS 以下に抑えるのは Go 側の役目であり、ここは素材の音量そろえである。

使い方:
    python3 scripts/prepare_animal_recording.py <入力音声> <出力WAV> [--start 秒] [--end 秒]

標準出力へ、切り出した位置と音量の測定結果を JSON で書く。
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

SAMPLE_RATE = 24_000
SILENCE_THRESHOLD_DB = -35.0
MIN_SILENCE_SECONDS = 0.3
MERGE_GAP_SECONDS = 1.0
PAD_SECONDS = 0.2
FADE_SECONDS = 1.5
MAX_SEGMENT_SECONDS = 5.0
TARGET_LUFS = -19.0
MAX_TRUE_PEAK_DBFS = -1.0

INTEGRATED_PATTERN = re.compile(r"I:\s*(-?(?:inf|[0-9]+(?:\.[0-9]+)?))\s*LUFS")
TRUE_PEAK_PATTERN = re.compile(r"Peak:\s*(-?(?:inf|[0-9]+(?:\.[0-9]+)?))\s*dBFS")


def decode(source: Path) -> np.ndarray:
    """任意の音声を 24kHz モノラルの float 配列にする。"""
    completed = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(source), "-map_metadata", "-1",
         "-ar", str(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "-"],
        check=True, capture_output=True,
    )
    return np.frombuffer(completed.stdout, dtype="<i2").astype(np.float32)


def write_wav(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as destination:
        destination.setnchannels(1)
        destination.setsampwidth(2)
        destination.setframerate(SAMPLE_RATE)
        destination.writeframes(np.clip(np.round(samples), -32768, 32767).astype("<i2").tobytes())


def loudness(path: Path) -> tuple[float, float]:
    """EBU R128 の integrated loudness と true peak を測る。"""
    completed = subprocess.run(
        ["ffmpeg", "-nostats", "-i", str(path), "-filter_complex", "ebur128=peak=true", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    summary = completed.stderr.split("Summary:")[-1]
    integrated = INTEGRATED_PATTERN.search(summary)
    peak = TRUE_PEAK_PATTERN.search(summary)
    to_float = lambda value: -math.inf if value == "-inf" else float(value)
    return (
        to_float(integrated.group(1)) if integrated else -math.inf,
        to_float(peak.group(1)) if peak else -math.inf,
    )


def loud_segments(samples: np.ndarray) -> list[tuple[int, int]]:
    """無音でない区間を、AUDIO.md のしきい値で拾って統合する。"""
    peak = float(np.abs(samples).max())
    if peak <= 0:
        return []
    window = max(1, int(SAMPLE_RATE * 0.02))
    usable = len(samples) - len(samples) % window
    frames = samples[:usable].reshape(-1, window)
    frame_peak = np.abs(frames).max(axis=1)
    threshold = peak * (10 ** (SILENCE_THRESHOLD_DB / 20))
    loud = frame_peak > threshold

    segments: list[list[int]] = []
    for index, is_loud in enumerate(loud):
        if not is_loud:
            continue
        start, end = index * window, (index + 1) * window
        if segments and start - segments[-1][1] < SAMPLE_RATE * MERGE_GAP_SECONDS:
            segments[-1][1] = end
        else:
            segments.append([start, end])
    minimum = int(SAMPLE_RATE * MIN_SILENCE_SECONDS)
    return [(start, end) for start, end in segments if end - start >= minimum // 3]


def choose_segment(samples: np.ndarray) -> tuple[int, int]:
    segments = loud_segments(samples)
    if not segments:
        return 0, min(len(samples), int(SAMPLE_RATE * MAX_SEGMENT_SECONDS))
    def rms(bounds: tuple[int, int]) -> float:
        chunk = samples[bounds[0] : bounds[1]]
        return float(np.sqrt(np.mean(np.square(chunk)))) if len(chunk) else 0.0
    start, end = max(segments, key=rms)
    pad = int(SAMPLE_RATE * PAD_SECONDS)
    start, end = max(0, start - pad), min(len(samples), end + pad)
    limit = int(SAMPLE_RATE * MAX_SEGMENT_SECONDS)
    if end - start > limit:
        chunk = samples[start:end]
        window = min(limit, len(chunk))
        # 累積和で窓ごとのエネルギーを求める。畳み込みだと長い素材で計算量が跳ね上がる。
        cumulative = np.concatenate(([0.0], np.cumsum(chunk.astype(np.float64) ** 2)))
        energy = cumulative[window:] - cumulative[:-window]
        offset = int(np.argmax(energy))
        start, end = start + offset, start + offset + window
    return start, end


def apply_fade(samples: np.ndarray) -> np.ndarray:
    length = int(min(SAMPLE_RATE * FADE_SECONDS, len(samples) / 3))
    if length <= 0:
        return samples
    ramp = np.linspace(0.0, 1.0, length, dtype=np.float32)
    faded = samples.copy()
    faded[:length] *= ramp
    faded[-length:] *= ramp[::-1]
    return faded


def run(source: Path, destination: Path, start_seconds: float | None, end_seconds: float | None) -> dict:
    samples = decode(source)
    if start_seconds is not None or end_seconds is not None:
        start = int(SAMPLE_RATE * (start_seconds or 0.0))
        end = int(SAMPLE_RATE * end_seconds) if end_seconds is not None else len(samples)
        start, end = max(0, start), min(len(samples), end)
    else:
        start, end = choose_segment(samples)
    clip = apply_fade(samples[start:end])
    destination.parent.mkdir(parents=True, exist_ok=True)
    write_wav(destination, clip)

    integrated, peak = loudness(destination)
    gain_db = 0.0
    if math.isfinite(integrated):
        gain_db = TARGET_LUFS - integrated
        if math.isfinite(peak) and peak + gain_db > MAX_TRUE_PEAK_DBFS:
            gain_db = MAX_TRUE_PEAK_DBFS - peak
        write_wav(destination, clip * (10 ** (gain_db / 20)))
    final_integrated, final_peak = loudness(destination)
    return {
        "source": str(source),
        "output": str(destination),
        "start_seconds": round(start / SAMPLE_RATE, 3),
        "end_seconds": round(end / SAMPLE_RATE, 3),
        "duration_seconds": round(len(clip) / SAMPLE_RATE, 3),
        "gain_db": round(gain_db, 2),
        "integrated_lufs": final_integrated,
        "true_peak_dbfs": final_peak,
        "settings": {
            "sample_rate": SAMPLE_RATE,
            "silence_threshold_db": SILENCE_THRESHOLD_DB,
            "min_silence_seconds": MIN_SILENCE_SECONDS,
            "merge_gap_seconds": MERGE_GAP_SECONDS,
            "pad_seconds": PAD_SECONDS,
            "fade_seconds": FADE_SECONDS,
            "max_segment_seconds": MAX_SEGMENT_SECONDS,
            "target_lufs": TARGET_LUFS,
            "max_true_peak_dbfs": MAX_TRUE_PEAK_DBFS,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--start", type=float, default=None)
    parser.add_argument("--end", type=float, default=None)
    arguments = parser.parse_args()
    result = run(arguments.source, arguments.destination, arguments.start, arguments.end)
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
