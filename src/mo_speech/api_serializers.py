from __future__ import annotations

import base64

from .pipeline import OperationProgress, TtsOutput
from .providers.voice import VoiceConversionResult


def serialize_voice_conversion_result(result: VoiceConversionResult) -> dict[str, object]:
    return {
        "audio_mime_type": result.output_audio_mime_type,
        "audio_base64": base64.b64encode(result.output_audio_bytes).decode("ascii"),
        "timings_ms": result.timings_ms,
        "providers": result.providers,
        "warnings": result.warnings,
    }


def normalize_tts_provider_output(output: bytes | TtsOutput, audio_mime_type: str) -> TtsOutput:
    if isinstance(output, TtsOutput):
        return TtsOutput(
            audio_bytes=output.audio_bytes,
            audio_mime_type=output.audio_mime_type or audio_mime_type,
            timings_ms=output.timings_ms,
            warnings=output.warnings,
        )
    return TtsOutput(audio_bytes=output, audio_mime_type=audio_mime_type)


def serialize_tts_output(output: TtsOutput, provider_name: str) -> dict[str, object]:
    return {
        "audio_mime_type": output.audio_mime_type or "audio/wav",
        "audio_base64": base64.b64encode(output.audio_bytes).decode("ascii"),
        "timings_ms": output.timings_ms,
        "providers": {"tts": provider_name},
        "warnings": output.warnings,
    }


def serialize_progress(progress: OperationProgress) -> dict[str, str]:
    return {
        "stage": progress.stage,
        "label": progress.label,
        "provider": progress.provider,
    }
def text_preview(text: str, limit: int = 80) -> str:
    preview = " ".join(text.split())
    if len(preview) <= limit:
        return preview
    return f"{preview[: limit - 1]}…"
