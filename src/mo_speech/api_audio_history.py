from __future__ import annotations

import logging
import mimetypes
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

from .api_serializers import text_preview
from .audio_history import AudioHistoryEntry, AudioHistoryStore
from .pipeline import PipelineResult

LOGGER = logging.getLogger("mo_speech")
AUDIO_HISTORY_WAV_SAMPLE_RATE = 24000
AUDIO_HISTORY_WAV_TIMEOUT_SECONDS = 30


def serialize_audio_history_settings(store: AudioHistoryStore) -> dict[str, object]:
    root = store.root.expanduser()
    resolved_root = root.resolve()
    return {
        "enabled": store.enabled,
        "root": str(store.root),
        "resolved_root": str(resolved_root),
        "recordings_dir": str(resolved_root / "recordings"),
        "outputs_dir": str(resolved_root / "outputs"),
        "limit": store.limit,
        "env_var": "MO_AUDIO_HISTORY_DIR",
    }


def serialize_audio_history_entry(kind: str, entry: AudioHistoryEntry) -> dict[str, object]:
    metadata = entry.metadata or {}
    preview = metadata_text_preview(metadata)
    details = audio_history_details(kind, metadata)
    return {
        "kind": kind,
        "filename": entry.audio_path.name,
        "url": f"/api/audio-history/{kind}/{entry.audio_path.name}",
        "label": audio_history_label(kind, metadata, preview),
        "details": details,
        "text_preview": preview,
        "tts_text": str(metadata.get("tts_text") or ""),
        "media_type": metadata.get("audio_mime_type") or metadata.get("content_type") or audio_media_type(entry.audio_path),
        "playable_hint": audio_history_playable_hint(entry, metadata),
        "metadata": metadata,
        "created_at": metadata.get("created_at", ""),
        "size_bytes": metadata.get("size_bytes", entry.audio_path.stat().st_size),
    }


def is_reused_history_input(
    store: AudioHistoryStore,
    input_history_kind: str | None,
    input_history_filename: str | None,
) -> bool:
    if not input_history_kind or not input_history_filename:
        return False
    try:
        store.resolve_audio_path(input_history_kind, input_history_filename)
    except (FileNotFoundError, ValueError):
        return False
    return True


def save_audio_history_recording(
    store: AudioHistoryStore,
    audio_bytes: bytes,
    *,
    suffix: str,
    metadata: dict[str, object],
) -> AudioHistoryEntry | None:
    if not store.enabled or store.limit <= 0 or len(audio_bytes) == 0:
        return None
    prepared = prepare_audio_history_wav(audio_bytes, suffix)
    if prepared is None:
        return None
    prepared_bytes, prepared_suffix, prepared_metadata = prepared
    return store.save_recording(
        prepared_bytes,
        suffix=prepared_suffix,
        metadata=audio_history_normalized_metadata(metadata, prepared_metadata),
    )


def save_audio_history_uploaded_output(
    store: AudioHistoryStore,
    audio_bytes: bytes,
    *,
    suffix: str,
    metadata: dict[str, object],
) -> AudioHistoryEntry | None:
    if not store.enabled or store.limit <= 0 or len(audio_bytes) == 0:
        return None
    prepared = prepare_audio_history_wav(audio_bytes, suffix)
    if prepared is None:
        return None
    prepared_bytes, prepared_suffix, prepared_metadata = prepared
    return store.save_output(
        prepared_bytes,
        suffix=prepared_suffix,
        metadata=audio_history_normalized_metadata(metadata, prepared_metadata),
    )


def audio_history_normalized_metadata(
    metadata: dict[str, object],
    prepared_metadata: dict[str, object],
) -> dict[str, object]:
    normalized_metadata = dict(metadata)
    filename = str(metadata.get("filename") or "")
    content_type = str(metadata.get("content_type") or "")
    if filename:
        normalized_metadata.setdefault("original_filename", filename)
    if content_type:
        normalized_metadata.setdefault("original_content_type", content_type)
    normalized_metadata.update(prepared_metadata)
    return normalized_metadata


def prepare_audio_history_wav(
    audio_bytes: bytes,
    suffix: str,
) -> tuple[bytes, str, dict[str, object]] | None:
    if len(audio_bytes) == 0:
        return None
    input_suffix = suffix if suffix.startswith(".") else f".{suffix}"
    try:
        with TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            input_path = temp_path / f"input{input_suffix}"
            output_path = temp_path / "history.wav"
            input_path.write_bytes(audio_bytes)
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(input_path),
                    "-acodec",
                    "pcm_s16le",
                    "-ac",
                    "1",
                    "-ar",
                    str(AUDIO_HISTORY_WAV_SAMPLE_RATE),
                    str(output_path),
                ],
                check=True,
                capture_output=True,
                timeout=AUDIO_HISTORY_WAV_TIMEOUT_SECONDS,
            )
            prepared_bytes = output_path.read_bytes()
    except FileNotFoundError:
        LOGGER.warning("ffmpeg is not available; audio history was not saved as wav")
        return None
    except subprocess.TimeoutExpired:
        LOGGER.warning("audio history wav normalization timed out")
        return None
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode("utf-8", errors="replace").strip()
        LOGGER.warning("audio history wav normalization failed: %s", stderr)
        return None
    if len(prepared_bytes) == 0:
        LOGGER.warning("audio history wav normalization produced empty output")
        return None
    return (
        prepared_bytes,
        ".wav",
        {
            "audio_mime_type": "audio/wav",
            "history_audio_format": f"wav_{AUDIO_HISTORY_WAV_SAMPLE_RATE}_mono_pcm16",
            "original_audio_suffix": input_suffix,
        },
    )


def history_text_metadata_from_pipeline_result(result: PipelineResult) -> dict[str, str]:
    transformed = text_preview(result.transformed_text)
    translated = text_preview(result.translated_text)
    transcript = text_preview(result.transcript)
    tts_text = result.transformed_text or result.translated_text
    return {
        "text_preview": transformed or translated or transcript,
        "tts_text": tts_text,
        "transcript_preview": transcript,
        "translated_text_preview": translated,
        "transformed_text_preview": transformed,
    }


def history_text_metadata_from_recording_result(result: PipelineResult) -> dict[str, str]:
    transcript = text_preview(result.transcript)
    return {
        "text_preview": transcript,
        "transcript_preview": transcript,
    }


def metadata_text_preview(metadata: dict[str, object]) -> str:
    for key in ("text_preview", "transformed_text_preview", "translated_text_preview", "transcript_preview"):
        value = str(metadata.get(key) or "").strip()
        if value:
            return value
    return ""


def audio_history_label(kind: str, metadata: dict[str, object], preview: str) -> str:
    if preview:
        return preview
    endpoint = str(metadata.get("endpoint") or "")
    filename = str(metadata.get("filename") or metadata.get("audio_file") or "")
    if endpoint == "voice-conversion-jobs":
        return "VC出力" if kind == "outputs" else filename or "VC入力音声"
    if endpoint == "text-to-speech-jobs":
        return "読み上げ音声"
    if endpoint == "openai-realtime-streaming":
        return "Realtime streaming出力"
    if endpoint.startswith("translate-speech"):
        return "翻訳音声" if kind == "outputs" else filename or "入力音声"
    return filename or ("出力音声" if kind == "outputs" else "入力音声")


def audio_history_details(kind: str, metadata: dict[str, object]) -> list[str]:
    details = [str(metadata.get("endpoint") or kind)]
    route = audio_history_route(metadata)
    if route:
        details.append(route)
    for key in ("translation_backend", "tts_backend", "voice_backend"):
        value = str(metadata.get(key) or "")
        if value:
            details.append(value)
    filename = str(metadata.get("filename") or "")
    if filename:
        details.append(filename)
    return details


def audio_history_route(metadata: dict[str, object]) -> str:
    source_language = str(metadata.get("source_language") or "")
    target_language = str(metadata.get("target_language") or "")
    if source_language and target_language:
        return f"{source_language} -> {target_language}"
    if target_language:
        return target_language
    return ""


def audio_history_playable_hint(entry: AudioHistoryEntry, metadata: dict[str, object]) -> str:
    size_bytes = int(metadata.get("size_bytes") or entry.audio_path.stat().st_size)
    if size_bytes < 128:
        return "音声ファイルが小さすぎます。テスト用または失敗したダミー出力の可能性があります。"
    return ""


def audio_media_type(audio_path: Path) -> str:
    guessed, _ = mimetypes.guess_type(str(audio_path))
    return guessed or "application/octet-stream"


def upload_suffix(filename: str | None) -> str:
    if not filename:
        return ".audio"
    suffix = Path(filename).suffix.lower()
    if not suffix or len(suffix) > 12:
        return ".audio"
    return suffix


def mime_suffix(audio_mime_type: str | None) -> str:
    if audio_mime_type == "audio/mp4":
        return ".m4a"
    if audio_mime_type == "audio/webm":
        return ".webm"
    if audio_mime_type == "audio/mpeg":
        return ".mp3"
    return ".wav"
