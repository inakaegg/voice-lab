from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from mo_speech.audio_effects import AudioEffectInsertSettings, insert_audio_effect


pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg and ffprobe are required",
)


def test_insert_audio_effect_uses_detected_silence(tmp_path: Path) -> None:
    main_audio = tmp_path / "main.wav"
    effect_audio = tmp_path / "effect.wav"
    output_audio = tmp_path / "output.wav"
    _run(
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.35",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=24000:cl=mono:d=0.45",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=660:duration=0.35",
        "-filter_complex",
        "[0:a][1:a][2:a]concat=n=3:v=0:a=1",
        "-ar",
        "24000",
        "-ac",
        "1",
        str(main_audio),
    )
    _run(
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=180:duration=0.12",
        "-ar",
        "24000",
        "-ac",
        "1",
        str(effect_audio),
    )

    result = insert_audio_effect(
        main_audio,
        effect_audio,
        output_audio,
        settings=AudioEffectInsertSettings(min_silence_ms=250, max_insertions=1),
    )

    assert result.inserted_count == 1
    assert result.insertion_points
    assert output_audio.is_file()
    assert _duration(output_audio) > _duration(main_audio)


def _duration(path: Path) -> float:
    result = _run(
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    )
    return float(result.stdout.strip())


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=True, capture_output=True, text=True)
