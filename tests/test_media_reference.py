from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from mo_speech.media_reference import (
    MediaReferenceAudioExtractor,
    parse_media_url_start_seconds,
    parse_time_seconds,
)


def test_parse_time_seconds_accepts_youtube_style_values() -> None:
    assert parse_time_seconds("75") == 75.0
    assert parse_time_seconds("75s") == 75.0
    assert parse_time_seconds("1m15s") == 75.0
    assert parse_time_seconds("1h2m3s") == 3723.0
    assert parse_time_seconds("01:02") == 62.0
    assert parse_time_seconds("01:02:03") == 3723.0


def test_parse_media_url_start_seconds_reads_query_and_fragment() -> None:
    assert parse_media_url_start_seconds("https://youtu.be/example?t=1m15s") == 75.0
    assert parse_media_url_start_seconds("https://www.youtube.com/watch?v=x&start=42") == 42.0
    assert parse_media_url_start_seconds("https://www.youtube.com/watch?v=x#t=01:02") == 62.0
    assert parse_media_url_start_seconds("https://example.com/audio.wav") is None


def test_media_reference_extractor_uses_url_start_and_duration(tmp_path: Path) -> None:
    calls: list[list[str]] = []

    def fake_run(command, *, capture_output, text, timeout, check):
        calls.append(list(command))
        if command[0] == "yt-dlp":
            template = command[command.index("-o") + 1]
            Path(template.replace("%(ext)s", "webm")).write_bytes(b"downloaded media")
        elif command[0] == "ffmpeg":
            Path(command[-1]).write_bytes(b"RIFFurlwav")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    extractor = MediaReferenceAudioExtractor(runner=fake_run)
    result = extractor.extract_from_url("https://youtu.be/example?t=1m15s", duration_seconds=5)

    assert result.audio_bytes == b"RIFFurlwav"
    assert result.audio_mime_type == "audio/wav"
    assert result.start_seconds == 75.0
    assert result.detected_start_seconds == 75.0
    assert result.duration_seconds == 5.0
    assert result.filename.endswith("_s75_d5.wav")
    assert calls[0][:2] == ["yt-dlp", "--no-playlist"]
    assert "--force-ipv4" in calls[0]
    assert "--remote-components" in calls[0]
    assert "ejs:github" in calls[0]
    assert "--extractor-args" in calls[0]
    assert "youtube:player_client=web_safari,android_vr" in calls[0]
    assert "--download-sections" in calls[0]
    assert "*75.000-80.000" in calls[0]
    assert calls[1][:2] == ["ffmpeg", "-y"]
    assert "-ar" in calls[1]
    assert "24000" in calls[1]


def test_media_reference_extractor_explicit_start_overrides_url_start(tmp_path: Path) -> None:
    calls: list[list[str]] = []

    def fake_run(command, *, capture_output, text, timeout, check):
        calls.append(list(command))
        if command[0] == "yt-dlp":
            template = command[command.index("-o") + 1]
            Path(template.replace("%(ext)s", "m4a")).write_bytes(b"downloaded media")
        elif command[0] == "ffmpeg":
            Path(command[-1]).write_bytes(b"RIFFurlwav")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    extractor = MediaReferenceAudioExtractor(runner=fake_run)
    result = extractor.extract_from_url("https://youtu.be/example?t=1m15s", start_seconds=12.5, duration_seconds=8)

    assert result.start_seconds == 12.5
    assert result.detected_start_seconds == 75.0
    assert result.duration_seconds == 8.0
    assert "*12.500-20.500" in calls[0]


def test_media_reference_extractor_does_not_full_download_when_section_download_fails() -> None:
    calls: list[list[str]] = []

    def fake_run(command, *, capture_output, text, timeout, check):
        calls.append(list(command))
        if command[0] == "yt-dlp":
            return subprocess.CompletedProcess(command, 1, stdout="", stderr="ERROR: ffmpeg exited with code 8: 403 Forbidden")
        raise AssertionError("ffmpeg should not run when yt-dlp section download fails")

    extractor = MediaReferenceAudioExtractor(runner=fake_run)
    with pytest.raises(RuntimeError, match="403 Forbidden"):
        extractor.extract_from_url("https://youtu.be/example?t=1m15s", duration_seconds=5)

    assert len(calls) == 1
    assert "--download-sections" in calls[0]
    assert "*75.000-80.000" in calls[0]


def test_media_reference_extractor_adds_actionable_youtube_unavailable_hint() -> None:
    def fake_run(command, *, capture_output, text, timeout, check):
        return subprocess.CompletedProcess(
            command,
            1,
            stdout="",
            stderr="ERROR: [youtube] uQ9BlVeip_U: Video unavailable. This video is not available",
        )

    extractor = MediaReferenceAudioExtractor(runner=fake_run)
    with pytest.raises(RuntimeError) as exc_info:
        extractor.extract_from_url("https://youtu.be/uQ9BlVeip_U?t=10", duration_seconds=5)

    message = str(exc_info.value)
    assert "Video unavailable" in message
    assert "RunPodから対象動画を視聴できません" in message


def test_media_reference_extractor_accepts_section_downloaded_combined_media() -> None:
    calls: list[list[str]] = []

    def fake_run(command, *, capture_output, text, timeout, check):
        calls.append(list(command))
        if command[0] == "yt-dlp":
            template = command[command.index("-o") + 1]
            Path(template.replace("%(ext)s", "mp4")).write_bytes(b"downloaded section media")
        elif command[0] == "ffmpeg":
            Path(command[-1]).write_bytes(b"RIFFurlwav")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    extractor = MediaReferenceAudioExtractor(runner=fake_run)
    result = extractor.extract_from_url("https://youtu.be/example?t=1m15s", duration_seconds=5)

    assert result.audio_bytes == b"RIFFurlwav"
    assert "--download-sections" in calls[0]
    assert calls[1][:2] == ["ffmpeg", "-y"]
    assert "-ss" not in calls[1]


def test_media_reference_extractor_rejects_non_http_url() -> None:
    extractor = MediaReferenceAudioExtractor(runner=lambda *args, **kwargs: None)

    with pytest.raises(ValueError, match="http"):
        extractor.extract_from_url("file:///tmp/audio.wav", duration_seconds=5)
