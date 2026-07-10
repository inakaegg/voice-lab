from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
from dataclasses import dataclass
from datetime import date
from importlib import metadata
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Callable
from urllib.parse import parse_qsl, urlparse


_TIME_WITH_UNITS_RE = re.compile(
    r"^(?:(?P<hours>\d+(?:\.\d+)?)h)?(?:(?P<minutes>\d+(?:\.\d+)?)m)?(?:(?P<seconds>\d+(?:\.\d+)?)s?)?$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ReferenceAudioClip:
    audio_bytes: bytes
    audio_mime_type: str
    filename: str
    source_url: str
    start_seconds: float
    detected_start_seconds: float | None
    duration_seconds: float


class MediaReferenceAudioExtractor:
    def __init__(
        self,
        *,
        runner: Callable[..., subprocess.CompletedProcess] = subprocess.run,
        yt_dlp_command: str = "yt-dlp",
        ffmpeg_command: str = "ffmpeg",
        javascript_runtime_command: str = "node",
        timeout_seconds: float = 180.0,
        max_duration_seconds: float = 30.0,
    ) -> None:
        self._runner = runner
        self._yt_dlp_command = yt_dlp_command
        self._ffmpeg_command = ffmpeg_command
        self._javascript_runtime_command = javascript_runtime_command
        self._timeout_seconds = timeout_seconds
        self._max_duration_seconds = max_duration_seconds

    def diagnostics(self) -> dict[str, object]:
        return {
            "yt_dlp": _yt_dlp_diagnostics(self._yt_dlp_command),
            "ffmpeg": {
                "command": self._ffmpeg_command,
                "path": shutil.which(self._ffmpeg_command),
            },
            "javascript_runtime": {
                "command": self._javascript_runtime_command,
                "path": shutil.which(self._javascript_runtime_command),
            },
        }

    def extract_from_url(
        self,
        url: str,
        *,
        start_seconds: float | None = None,
        duration_seconds: float = 5.0,
    ) -> ReferenceAudioClip:
        source_url = _validate_http_url(url)
        detected_start = parse_media_url_start_seconds(source_url)
        start = _coerce_non_negative_seconds(start_seconds if start_seconds is not None else detected_start or 0.0, "start_seconds")
        duration = _coerce_positive_duration(duration_seconds, maximum=self._max_duration_seconds)
        end = start + duration

        with TemporaryDirectory(prefix="mo-reference-url-") as temp_dir_raw:
            temp_dir = Path(temp_dir_raw)
            source_template = temp_dir / "source.%(ext)s"
            section = f"*{start:.3f}-{end:.3f}"
            self._run_command(
                _yt_dlp_download_command(
                    self._yt_dlp_command,
                    source_url,
                    output_template=source_template,
                    section=section,
                    javascript_runtime_command=self._javascript_runtime_command,
                ),
                "yt-dlp",
            )
            source_path = _find_downloaded_media(temp_dir)
            output_path = temp_dir / "reference.wav"
            ffmpeg_command = [
                self._ffmpeg_command,
                "-y",
            ]
            ffmpeg_command.extend(
                [
                    "-i",
                    str(source_path),
                    "-t",
                    f"{duration:.3f}",
                    "-ar",
                    "24000",
                    "-ac",
                    "1",
                    "-c:a",
                    "pcm_s16le",
                    "-f",
                    "wav",
                    str(output_path),
                ]
            )
            self._run_command(
                ffmpeg_command,
                "ffmpeg",
            )
            audio_bytes = output_path.read_bytes() if output_path.exists() else b""
            if not audio_bytes:
                raise RuntimeError("URLから参照音声を取得できませんでした。")
            return ReferenceAudioClip(
                audio_bytes=audio_bytes,
                audio_mime_type="audio/wav",
                filename=_reference_audio_filename(source_url, start, duration),
                source_url=source_url,
                start_seconds=start,
                detected_start_seconds=detected_start,
                duration_seconds=duration,
            )

    def _run_command(self, command: list[str], label: str) -> None:
        try:
            completed = self._runner(
                command,
                capture_output=True,
                text=True,
                timeout=self._timeout_seconds,
                check=False,
            )
        except FileNotFoundError as exc:
            raise RuntimeError(f"{label} が見つかりません。URL参照音声取得には {label} が必要です。") from exc
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"{label} によるURL参照音声取得がtimeoutしました。") from exc
        if getattr(completed, "returncode", 1) != 0:
            command_output = str(getattr(completed, "stderr", "") or getattr(completed, "stdout", "") or "").strip()
            detail, warnings = _split_command_failure_output(command_output)
            if _looks_like_youtube_unavailable(detail):
                detail = (
                    f"{detail}\n"
                    "ローカル環境のyt-dlpから対象動画を取得できません。動画の公開状態、地域制限、"
                    "ログイン要求を確認し、別の公開動画URLまたはローカル音声ファイルを使ってください。"
                )
            message = f"{label} によるURL参照音声取得失敗: {detail}"
            if warnings:
                message = f"{message}\n{label} 警告: {warnings}"
            raise RuntimeError(message)


def _split_command_failure_output(output: str) -> tuple[str, str]:
    detail_lines: list[str] = []
    warning_lines: list[str] = []
    current_target = detail_lines
    for line in str(output or "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("WARNING:"):
            current_target = warning_lines
        elif stripped.startswith("ERROR:"):
            current_target = detail_lines
        current_target.append(stripped)
    detail = " ".join(detail_lines)[-600:] if detail_lines else "no diagnostic"
    warnings = " ".join(warning_lines)[-600:]
    return detail, warnings


def _yt_dlp_diagnostics(command: str) -> dict[str, object]:
    try:
        version = metadata.version("yt-dlp")
    except metadata.PackageNotFoundError:
        version = None
    age_days = _dated_version_age_days(version)
    return {
        "command": command,
        "path": shutil.which(command),
        "version": version,
        "version_age_days": age_days,
        "older_than_90_days": age_days is not None and age_days > 90,
    }


def _dated_version_age_days(version: str | None) -> int | None:
    match = re.fullmatch(r"(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\D.*)?", str(version or ""))
    if not match:
        return None
    try:
        released = date(*(int(value) for value in match.groups()))
    except ValueError:
        return None
    return max(0, (date.today() - released).days)


def _yt_dlp_download_command(
    yt_dlp_command: str,
    source_url: str,
    *,
    output_template: Path,
    section: str,
    javascript_runtime_command: str,
) -> list[str]:
    return [
        yt_dlp_command,
        "--no-playlist",
        "--force-ipv4",
        "--js-runtimes",
        javascript_runtime_command,
        "--remote-components",
        "ejs:github",
        "--extractor-args",
        "youtube:player_client=web_safari,android_vr",
        "--download-sections",
        section,
        "--force-keyframes-at-cuts",
        "-f",
        "bestaudio/best",
        "-o",
        str(output_template),
        source_url,
    ]


def _looks_like_youtube_unavailable(detail: str) -> bool:
    text = str(detail or "").lower()
    return "[youtube]" in text and (
        "video unavailable" in text
        or "this video is not available" in text
        or "private video" in text
        or "sign in" in text
    )


def parse_media_url_start_seconds(url: str) -> float | None:
    parsed = urlparse(str(url or ""))
    for key, value in parse_qsl(parsed.query, keep_blank_values=False):
        if key in {"t", "start", "time_continue"}:
            parsed_value = parse_time_seconds(value)
            if parsed_value is not None:
                return parsed_value
    fragment = parsed.fragment or ""
    for key, value in parse_qsl(fragment, keep_blank_values=False):
        if key in {"t", "start", "time_continue"}:
            parsed_value = parse_time_seconds(value)
            if parsed_value is not None:
                return parsed_value
    if fragment and "=" not in fragment:
        return parse_time_seconds(fragment)
    return None


def parse_time_seconds(value: object) -> float | None:
    text = str(value or "").strip().lower()
    if not text:
        return None
    try:
        numeric = float(text)
    except ValueError:
        numeric = None
    if numeric is not None:
        return numeric if numeric >= 0 else None
    if ":" in text:
        parts = text.split(":")
        if len(parts) not in {2, 3}:
            return None
        try:
            values = [float(part) for part in parts]
        except ValueError:
            return None
        if any(part < 0 for part in values):
            return None
        if len(values) == 2:
            minutes, seconds = values
            return minutes * 60 + seconds
        hours, minutes, seconds = values
        return hours * 3600 + minutes * 60 + seconds
    match = _TIME_WITH_UNITS_RE.fullmatch(text)
    if not match:
        return None
    if not any(match.group(name) for name in ("hours", "minutes", "seconds")):
        return None
    hours = float(match.group("hours") or 0)
    minutes = float(match.group("minutes") or 0)
    seconds = float(match.group("seconds") or 0)
    return hours * 3600 + minutes * 60 + seconds


def _validate_http_url(url: str) -> str:
    normalized = str(url or "").strip()
    if not normalized:
        raise ValueError("URLを入力してください。")
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("参照音声URLはhttpまたはhttpsで指定してください。")
    return normalized


def _coerce_non_negative_seconds(value: object, name: str) -> float:
    try:
        seconds = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a number") from exc
    if seconds < 0:
        raise ValueError(f"{name} must be >= 0")
    return seconds


def _coerce_positive_duration(value: object, *, maximum: float) -> float:
    try:
        seconds = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("duration_seconds must be a number") from exc
    if seconds <= 0:
        raise ValueError("duration_seconds must be > 0")
    if seconds > maximum:
        raise ValueError(f"duration_seconds must be <= {maximum:g}")
    return seconds


def _find_downloaded_media(directory: Path) -> Path:
    candidates = [
        path
        for path in directory.iterdir()
        if path.is_file() and path.name.startswith("source.") and ".part" not in path.name and path.suffix.lower() != ".ytdl"
    ]
    if not candidates:
        raise RuntimeError("yt-dlpの出力ファイルが見つかりませんでした。")
    return max(candidates, key=lambda path: path.stat().st_mtime)


def _reference_audio_filename(url: str, start_seconds: float, duration_seconds: float) -> str:
    digest = hashlib.md5(url.encode("utf-8")).hexdigest()[:12]
    return f"reference_url_{digest}_s{_seconds_slug(start_seconds)}_d{_seconds_slug(duration_seconds)}.wav"


def _seconds_slug(value: float) -> str:
    text = f"{float(value):.3f}".rstrip("0").rstrip(".")
    return text.replace(".", "p") or "0"
