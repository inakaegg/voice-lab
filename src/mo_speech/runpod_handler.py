from __future__ import annotations

import base64
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from .api import create_pipeline_from_env
from .pipeline import PipelineRequest, SpeechTranslationPipeline

_PIPELINE: SpeechTranslationPipeline | None = None


def handler(event: dict[str, Any]) -> dict[str, object]:
    payload = event.get("input", event)
    if not isinstance(payload, dict):
        raise ValueError("event input must be an object")

    audio_base64 = payload.get("audio_base64")
    if not isinstance(audio_base64, str) or audio_base64 == "":
        raise ValueError("audio_base64 is required")

    audio_bytes = base64.b64decode(audio_base64)
    suffix = payload.get("text_transform_suffix")
    text_transform_unit = str(payload.get("text_transform_unit", "text"))
    text_transform_options: dict[str, str] = {}
    if suffix is not None:
        text_transform_options["suffix"] = str(suffix)
    if text_transform_unit:
        text_transform_options["unit"] = text_transform_unit

    with NamedTemporaryFile(suffix=_audio_suffix(payload.get("audio_mime_type"))) as temp_audio:
        temp_audio.write(audio_bytes)
        temp_audio.flush()
        request = PipelineRequest(
            audio_path=Path(temp_audio.name),
            source_language=str(payload.get("source_language", "ja-JP")),
            target_language=str(payload.get("target_language", "zh-CN")),
            voice_mode=str(payload.get("voice_mode", "default")),
            text_transform=_optional_str(payload.get("text_transform")),
            text_transform_options=text_transform_options,
        )
        result = _pipeline().run(request)

    return {
        "transcript": result.transcript,
        "translated_text": result.translated_text,
        "transformed_text": result.transformed_text,
        "audio_mime_type": result.output_audio_mime_type,
        "audio_base64": base64.b64encode(result.output_audio_bytes).decode("ascii"),
        "timings_ms": result.timings_ms,
        "providers": result.providers,
        "warnings": result.warnings,
    }


def _pipeline() -> SpeechTranslationPipeline:
    global _PIPELINE
    if _PIPELINE is None:
        _PIPELINE = create_pipeline_from_env()
        _PIPELINE.preload()
    return _PIPELINE


def _optional_str(value: object) -> str | None:
    if value is None or value == "":
        return None
    return str(value)


def _audio_suffix(audio_mime_type: object) -> str:
    if audio_mime_type == "audio/mp4":
        return ".m4a"
    if audio_mime_type == "audio/webm":
        return ".webm"
    return ".wav"


if __name__ == "__main__":
    import runpod

    runpod.serverless.start({"handler": handler})
