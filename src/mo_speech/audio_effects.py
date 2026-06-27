from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter


@dataclass(frozen=True)
class AudioEffectInsertSettings:
    insert_mode: str = "silence_or_tail"
    min_silence_ms: int = 300
    max_insertions: int = 1
    silence_threshold_db: int = -35
    sample_rate: int = 24000


@dataclass(frozen=True)
class AudioEffectInsertResult:
    audio_bytes: bytes
    audio_mime_type: str
    timings_ms: dict[str, float] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    inserted_count: int = 0
    insertion_points: list[float] = field(default_factory=list)


_SILENCE_START_RE = re.compile(r"silence_start:\s*([0-9.]+)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*([0-9.]+)")


def insert_audio_effect(
    main_audio_path: Path,
    effect_audio_path: Path,
    output_path: Path,
    *,
    settings: AudioEffectInsertSettings | None = None,
) -> AudioEffectInsertResult:
    effective_settings = settings or AudioEffectInsertSettings()
    started = perf_counter()
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        return AudioEffectInsertResult(
            audio_bytes=main_audio_path.read_bytes(),
            audio_mime_type="audio/wav",
            timings_ms={"audio_effect_insert": _elapsed_ms(started)},
            warnings=["ffmpeg or ffprobe is not available; audio effect was not inserted"],
            inserted_count=0,
            insertion_points=[],
        )

    with TemporaryDirectory() as temp_dir_raw:
        temp_dir = Path(temp_dir_raw)
        main_wav = temp_dir / "main.wav"
        effect_wav = temp_dir / "effect.wav"
        _normalize_wav(ffmpeg, main_audio_path, main_wav, sample_rate=effective_settings.sample_rate)
        _normalize_wav(ffmpeg, effect_audio_path, effect_wav, sample_rate=effective_settings.sample_rate)
        duration = _probe_duration(ffprobe, main_wav)
        insertion_points = _select_insertion_points(
            ffmpeg,
            main_wav,
            duration=duration,
            settings=effective_settings,
        )
        if not insertion_points:
            insertion_points = [duration]
        insertion_points = insertion_points[: max(1, effective_settings.max_insertions)]
        _concat_with_effects(
            ffmpeg,
            main_wav,
            effect_wav,
            output_path,
            insertion_points=insertion_points,
            duration=duration,
            sample_rate=effective_settings.sample_rate,
            temp_dir=temp_dir,
        )
    return AudioEffectInsertResult(
        audio_bytes=output_path.read_bytes(),
        audio_mime_type="audio/wav",
        timings_ms={"audio_effect_insert": _elapsed_ms(started)},
        inserted_count=len(insertion_points),
        insertion_points=insertion_points,
    )


def _select_insertion_points(
    ffmpeg: str,
    main_wav: Path,
    *,
    duration: float,
    settings: AudioEffectInsertSettings,
) -> list[float]:
    if settings.insert_mode == "tail":
        return [duration]
    if settings.insert_mode != "silence_or_tail":
        raise ValueError(f"unsupported audio effect insert mode: {settings.insert_mode}")
    min_silence_seconds = max(settings.min_silence_ms, 1) / 1000.0
    silence_ranges = _detect_silence_ranges(
        ffmpeg,
        main_wav,
        min_silence_seconds=min_silence_seconds,
        silence_threshold_db=settings.silence_threshold_db,
    )
    return [
        (start + end) / 2.0
        for start, end in silence_ranges
        if end > start and end - start >= min_silence_seconds
    ]


def _detect_silence_ranges(
    ffmpeg: str,
    main_wav: Path,
    *,
    min_silence_seconds: float,
    silence_threshold_db: int,
) -> list[tuple[float, float]]:
    result = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-nostats",
            "-i",
            str(main_wav),
            "-af",
            f"silencedetect=n={silence_threshold_db}dB:d={min_silence_seconds:.3f}",
            "-f",
            "null",
            "-",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    ranges: list[tuple[float, float]] = []
    current_start: float | None = None
    for line in result.stderr.splitlines():
        start_match = _SILENCE_START_RE.search(line)
        if start_match:
            current_start = float(start_match.group(1))
        end_match = _SILENCE_END_RE.search(line)
        if end_match and current_start is not None:
            ranges.append((current_start, float(end_match.group(1))))
            current_start = None
    return ranges


def _concat_with_effects(
    ffmpeg: str,
    main_wav: Path,
    effect_wav: Path,
    output_path: Path,
    *,
    insertion_points: list[float],
    duration: float,
    sample_rate: int,
    temp_dir: Path,
) -> None:
    concat_paths: list[Path] = []
    cursor = 0.0
    for index, point in enumerate(_normalized_points(insertion_points, duration)):
        if point > cursor + 0.005:
            segment_path = temp_dir / f"segment-{index}.wav"
            _extract_segment(ffmpeg, main_wav, segment_path, start=cursor, end=point, sample_rate=sample_rate)
            concat_paths.append(segment_path)
        concat_paths.append(effect_wav)
        cursor = point
    if cursor < duration - 0.005:
        segment_path = temp_dir / "segment-tail.wav"
        _extract_segment(ffmpeg, main_wav, segment_path, start=cursor, end=duration, sample_rate=sample_rate)
        concat_paths.append(segment_path)

    concat_list = temp_dir / "concat.txt"
    concat_list.write_text(
        "\n".join(_concat_file_line(path) for path in concat_paths),
        encoding="utf-8",
    )
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def _normalized_points(points: list[float], duration: float) -> list[float]:
    normalized: list[float] = []
    for point in sorted(points):
        clamped = min(max(point, 0.0), duration)
        if not normalized or abs(clamped - normalized[-1]) > 0.01:
            normalized.append(clamped)
    return normalized


def _concat_file_line(path: Path) -> str:
    escaped = str(path).replace("'", "'\\''")
    return f"file '{escaped}'"


def _normalize_wav(ffmpeg: str, input_path: Path, output_path: Path, *, sample_rate: int) -> None:
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(input_path),
            "-ar",
            str(sample_rate),
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def _extract_segment(
    ffmpeg: str,
    input_path: Path,
    output_path: Path,
    *,
    start: float,
    end: float,
    sample_rate: int,
) -> None:
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(input_path),
            "-ss",
            f"{start:.6f}",
            "-t",
            f"{max(end - start, 0.0):.6f}",
            "-ar",
            str(sample_rate),
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def _probe_duration(ffprobe: str, input_path: Path) -> float:
    result = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(input_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return max(float(result.stdout.strip()), 0.0)


def _elapsed_ms(started: float) -> float:
    return (perf_counter() - started) * 1000
