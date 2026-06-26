from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile
from time import perf_counter
from typing import Any

from .factory import create_openai_pipeline, create_pipeline_from_env, create_realtime_translation_pipeline
from .pipeline import PipelineRequest, SpeechTranslationPipeline, TtsOutput
from .providers.text_tts import create_text_tts_providers
from .providers.voice import (
    SeedVcRuntimeSettings,
    VoiceConversionRequest,
    VoiceConversionService,
    create_voice_conversion_service_from_env,
)

_WORKER_STARTED_AT = perf_counter()
_PIPELINE: SpeechTranslationPipeline | None = None
_PIPELINE_LOAD_MS: float | None = None
_OPENAI_PIPELINE: SpeechTranslationPipeline | None = None
_OPENAI_PIPELINE_LOAD_MS: float | None = None
_OPENAI_REALTIME_PIPELINE = None
_OPENAI_REALTIME_PIPELINE_LOAD_MS: float | None = None
_TEXT_TTS_PROVIDERS: dict[str, object] | None = None
_TEXT_TTS_PROVIDERS_LOAD_MS: float | None = None
_VOICE_CONVERSION_SERVICE: VoiceConversionService | None = None
_VOICE_CONVERSION_SERVICE_LOAD_MS: float | None = None


def handler(event: dict[str, Any]) -> dict[str, object]:
    handler_started = perf_counter()
    payload = event.get("input", event)
    if not isinstance(payload, dict):
        raise ValueError("event input must be an object")

    operation_mode = str(payload.get("operation_mode", "translation"))
    if operation_mode in {"translation", "translate"}:
        return _handle_translation(payload, handler_started)
    if operation_mode in {"text_tts", "text_to_speech"}:
        return _handle_text_tts(payload, handler_started)
    if operation_mode == "voice_conversion":
        return _handle_voice_conversion(payload, handler_started)
    if operation_mode in {"warmup", "preload"}:
        return _handle_warmup(payload, handler_started)
    raise ValueError(f"unsupported operation_mode: {operation_mode}")


def _handle_translation(payload: dict[str, object], handler_started: float) -> dict[str, object]:
    audio_base64 = payload.get("audio_base64")
    if not isinstance(audio_base64, str) or audio_base64 == "":
        raise ValueError("audio_base64 is required")

    decode_started = perf_counter()
    audio_bytes = base64.b64decode(audio_base64)
    audio_decode_ms = _elapsed_ms(decode_started)
    suffix = payload.get("text_transform_suffix")
    text_transform_unit = str(payload.get("text_transform_unit", "text"))
    text_transform_options = _text_transform_options_from_payload(payload)
    if suffix is not None:
        text_transform_options["suffix"] = str(suffix)
    if text_transform_unit:
        text_transform_options["unit"] = text_transform_unit

    translation_backend = str(payload.get("translation_backend", "openai"))
    pipeline, pipeline_load_ms = _translation_pipeline(translation_backend)
    temp_write_ms = 0.0
    with NamedTemporaryFile(suffix=_audio_suffix(payload.get("audio_mime_type"))) as temp_audio:
        temp_write_started = perf_counter()
        temp_audio.write(audio_bytes)
        temp_audio.flush()
        temp_write_ms = _elapsed_ms(temp_write_started)
        request = PipelineRequest(
            audio_path=Path(temp_audio.name),
            source_language=str(payload.get("source_language", "ja-JP")),
            target_language=str(payload.get("target_language", "zh-CN")),
            voice_mode=str(payload.get("voice_mode", "default")),
            text_transform=_optional_str(payload.get("text_transform")),
            text_transform_options=text_transform_options,
            voice_settings={"seed_vc": _seed_vc_settings_from_payload(payload)},
        )
        result = pipeline.run(request)

    response: dict[str, object] = {
        "transcript": result.transcript,
        "translated_text": result.translated_text,
        "transformed_text": result.transformed_text,
        "audio_mime_type": result.output_audio_mime_type,
        "audio_base64": base64.b64encode(result.output_audio_bytes).decode("ascii"),
        "timings_ms": result.timings_ms,
        "providers": result.providers,
        "warnings": result.warnings,
        "target_language": result.target_language,
    }
    _attach_serverless_metrics(
        response,
        operation_mode="translation",
        handler_started=handler_started,
        worker_cold=pipeline_load_ms is not None,
        audio_decode_ms=audio_decode_ms,
        temp_write_ms=temp_write_ms,
        load_metric_name="pipeline_load",
        load_ms=pipeline_load_ms,
    )
    return response


def _handle_warmup(payload: dict[str, object], handler_started: float) -> dict[str, object]:
    translation_backend = str(payload.get("translation_backend", "openai"))
    preload_translation = _optional_bool(payload.get("preload_translation"))
    preload_voice_conversion = _optional_bool(payload.get("preload_voice_conversion"))
    if preload_translation is None:
        preload_translation = True
    if preload_voice_conversion is None:
        preload_voice_conversion = False

    pipeline_load_ms: float | None = None
    voice_conversion_service_load_ms: float | None = None
    providers: dict[str, str] = {}
    if preload_translation:
        _, pipeline_load_ms = _translation_pipeline(translation_backend)
        providers["translation_backend"] = translation_backend
    if preload_voice_conversion:
        _, voice_conversion_service_load_ms = _voice_conversion_service()
        providers["voice_conversion"] = "seed-vc"

    response: dict[str, object] = {
        "warm": True,
        "providers": providers,
        "warnings": [],
    }
    response["serverless_timings_ms"] = {
        "handler_total": _elapsed_ms(handler_started),
        "worker_uptime_at_start": (handler_started - _WORKER_STARTED_AT) * 1000,
        "audio_decode": 0.0,
        "temp_audio_write": 0.0,
        "pipeline_load": pipeline_load_ms or 0.0,
        "voice_conversion_service_load": voice_conversion_service_load_ms or 0.0,
    }
    response["serverless"] = {
        "operation_mode": "warmup",
        "worker_cold": pipeline_load_ms is not None or voice_conversion_service_load_ms is not None,
    }
    return response


def _handle_text_tts(payload: dict[str, object], handler_started: float) -> dict[str, object]:
    text = str(payload.get("text", ""))
    if text.strip() == "":
        raise ValueError("text is required")
    target_language = str(payload.get("target_language", "ja-JP"))
    tts_backend = str(payload.get("tts_backend", "google_translate"))

    provider, providers_load_ms = _text_tts_provider(tts_backend)
    started = perf_counter()
    output = _normalize_tts_output(provider.synthesize(text, target_language), provider.audio_mime_type)
    response: dict[str, object] = {
        "audio_mime_type": output.audio_mime_type,
        "audio_base64": base64.b64encode(output.audio_bytes).decode("ascii"),
        "timings_ms": output.timings_ms or {"tts": _elapsed_ms(started), "total": _elapsed_ms(started)},
        "providers": {"tts": provider.name},
        "warnings": output.warnings,
    }
    _attach_serverless_metrics(
        response,
        operation_mode="text_tts",
        handler_started=handler_started,
        worker_cold=providers_load_ms is not None,
        audio_decode_ms=0.0,
        temp_write_ms=0.0,
        load_metric_name="text_tts_provider_load",
        load_ms=providers_load_ms,
    )
    return response


def _handle_voice_conversion(payload: dict[str, object], handler_started: float) -> dict[str, object]:
    source_audio_base64 = payload.get("source_audio_base64")
    if not isinstance(source_audio_base64, str) or source_audio_base64 == "":
        raise ValueError("source_audio_base64 is required")
    reference_audio_base64 = payload.get("reference_audio_base64")
    if not isinstance(reference_audio_base64, str) or reference_audio_base64 == "":
        raise ValueError("reference_audio_base64 is required")

    decode_started = perf_counter()
    source_audio_bytes = base64.b64decode(source_audio_base64)
    reference_audio_bytes = base64.b64decode(reference_audio_base64)
    audio_decode_ms = _elapsed_ms(decode_started)

    service, service_load_ms = _voice_conversion_service()
    temp_write_ms = 0.0
    with NamedTemporaryFile(suffix=_audio_suffix(payload.get("source_audio_mime_type"))) as source_audio:
        with NamedTemporaryFile(suffix=_audio_suffix(payload.get("reference_audio_mime_type"))) as reference_audio:
            temp_write_started = perf_counter()
            source_audio.write(source_audio_bytes)
            source_audio.flush()
            reference_audio.write(reference_audio_bytes)
            reference_audio.flush()
            temp_write_ms = _elapsed_ms(temp_write_started)
            result = service.convert(
                VoiceConversionRequest(
                    source_audio_path=Path(source_audio.name),
                    reference_audio_path=Path(reference_audio.name),
                    backend_id=str(payload.get("voice_backend", "seed-vc")),
                    seed_vc_settings=_seed_vc_settings_from_payload(payload),
                )
            )

    response: dict[str, object] = {
        "audio_mime_type": result.output_audio_mime_type,
        "audio_base64": base64.b64encode(result.output_audio_bytes).decode("ascii"),
        "timings_ms": result.timings_ms,
        "providers": result.providers,
        "warnings": result.warnings,
    }
    _attach_serverless_metrics(
        response,
        operation_mode="voice_conversion",
        handler_started=handler_started,
        worker_cold=service_load_ms is not None,
        audio_decode_ms=audio_decode_ms,
        temp_write_ms=temp_write_ms,
        load_metric_name="voice_conversion_service_load",
        load_ms=service_load_ms,
    )
    return response


def _pipeline() -> tuple[SpeechTranslationPipeline, float | None]:
    global _PIPELINE, _PIPELINE_LOAD_MS
    if _PIPELINE is None:
        started = perf_counter()
        _PIPELINE = create_pipeline_from_env()
        _PIPELINE.preload()
        _PIPELINE_LOAD_MS = _elapsed_ms(started)
        return _PIPELINE, _PIPELINE_LOAD_MS
    return _PIPELINE, None


def _openai_pipeline() -> tuple[SpeechTranslationPipeline, float | None]:
    global _OPENAI_PIPELINE, _OPENAI_PIPELINE_LOAD_MS
    if _OPENAI_PIPELINE is None:
        started = perf_counter()
        _OPENAI_PIPELINE = create_openai_pipeline()
        _OPENAI_PIPELINE.preload()
        _OPENAI_PIPELINE_LOAD_MS = _elapsed_ms(started)
        return _OPENAI_PIPELINE, _OPENAI_PIPELINE_LOAD_MS
    return _OPENAI_PIPELINE, None


def _openai_realtime_pipeline():
    global _OPENAI_REALTIME_PIPELINE, _OPENAI_REALTIME_PIPELINE_LOAD_MS
    if _OPENAI_REALTIME_PIPELINE is None:
        started = perf_counter()
        _OPENAI_REALTIME_PIPELINE = create_realtime_translation_pipeline()
        _OPENAI_REALTIME_PIPELINE.preload()
        _OPENAI_REALTIME_PIPELINE_LOAD_MS = _elapsed_ms(started)
        return _OPENAI_REALTIME_PIPELINE, _OPENAI_REALTIME_PIPELINE_LOAD_MS
    return _OPENAI_REALTIME_PIPELINE, None


def _translation_pipeline(translation_backend: str) -> tuple[SpeechTranslationPipeline, float | None]:
    if translation_backend == "qwen":
        return _pipeline()
    if translation_backend == "openai":
        return _openai_pipeline()
    if translation_backend == "openai_realtime":
        return _openai_realtime_pipeline()
    raise ValueError(f"unsupported translation backend: {translation_backend}")


def _text_tts_provider(tts_backend: str):
    providers, providers_load_ms = _text_tts_providers()
    if tts_backend not in providers:
        raise ValueError(f"unsupported TTS backend: {tts_backend}")
    return providers[tts_backend], providers_load_ms


def _text_tts_providers() -> tuple[dict[str, object], float | None]:
    global _TEXT_TTS_PROVIDERS, _TEXT_TTS_PROVIDERS_LOAD_MS
    if _TEXT_TTS_PROVIDERS is None:
        started = perf_counter()
        _TEXT_TTS_PROVIDERS = create_text_tts_providers()
        _TEXT_TTS_PROVIDERS_LOAD_MS = _elapsed_ms(started)
        return _TEXT_TTS_PROVIDERS, _TEXT_TTS_PROVIDERS_LOAD_MS
    return _TEXT_TTS_PROVIDERS, None


def _voice_conversion_service() -> tuple[VoiceConversionService, float | None]:
    global _VOICE_CONVERSION_SERVICE, _VOICE_CONVERSION_SERVICE_LOAD_MS
    if _VOICE_CONVERSION_SERVICE is None:
        started = perf_counter()
        _VOICE_CONVERSION_SERVICE = create_voice_conversion_service_from_env()
        _VOICE_CONVERSION_SERVICE_LOAD_MS = _elapsed_ms(started)
        return _VOICE_CONVERSION_SERVICE, _VOICE_CONVERSION_SERVICE_LOAD_MS
    return _VOICE_CONVERSION_SERVICE, None


def _attach_serverless_metrics(
    response: dict[str, object],
    *,
    operation_mode: str,
    handler_started: float,
    worker_cold: bool,
    audio_decode_ms: float,
    temp_write_ms: float,
    load_metric_name: str,
    load_ms: float | None,
) -> None:
    response["serverless_timings_ms"] = {
        "handler_total": _elapsed_ms(handler_started),
        "worker_uptime_at_start": (handler_started - _WORKER_STARTED_AT) * 1000,
        "audio_decode": audio_decode_ms,
        "temp_audio_write": temp_write_ms,
        load_metric_name: load_ms or 0.0,
    }
    response["serverless"] = {
        "operation_mode": operation_mode,
        "worker_cold": worker_cold,
    }


def _seed_vc_settings_from_payload(payload: dict[str, object]) -> SeedVcRuntimeSettings:
    return SeedVcRuntimeSettings(
        diffusion_steps=_optional_int(payload.get("seed_vc_diffusion_steps")),
        length_adjust=_optional_float(payload.get("seed_vc_length_adjust")),
        inference_cfg_rate=_optional_float(payload.get("seed_vc_inference_cfg_rate")),
        reference_max_seconds=_optional_float(payload.get("seed_vc_reference_max_seconds")),
        reference_auto_select=_optional_bool(payload.get("seed_vc_reference_auto_select")),
    )


def _optional_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    return int(value)


def _optional_float(value: object) -> float | None:
    if value is None or value == "":
        return None
    return float(value)


def _optional_bool(value: object) -> bool | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    return str(value).lower() in {"1", "true", "yes", "on"}


def _optional_str(value: object) -> str | None:
    if value is None or value == "":
        return None
    return str(value)


def _text_transform_options_from_payload(payload: dict[str, object]) -> dict[str, object]:
    raw_options = payload.get("text_transform_options")
    if raw_options is None:
        return {}
    if isinstance(raw_options, dict):
        return dict(raw_options)
    if isinstance(raw_options, str) and raw_options.strip():
        parsed = json.loads(raw_options)
        if not isinstance(parsed, dict):
            raise ValueError("text_transform_options must be an object")
        return parsed
    return {}


def _normalize_tts_output(output: bytes | TtsOutput, audio_mime_type: str) -> TtsOutput:
    if isinstance(output, TtsOutput):
        return TtsOutput(
            audio_bytes=output.audio_bytes,
            audio_mime_type=output.audio_mime_type or audio_mime_type,
            timings_ms=output.timings_ms,
            warnings=output.warnings,
        )
    return TtsOutput(audio_bytes=output, audio_mime_type=audio_mime_type)


def _audio_suffix(audio_mime_type: object) -> str:
    if audio_mime_type == "audio/mp4":
        return ".m4a"
    if audio_mime_type == "audio/webm":
        return ".webm"
    if audio_mime_type == "audio/mpeg":
        return ".mp3"
    return ".wav"


def _elapsed_ms(started: float) -> float:
    return (perf_counter() - started) * 1000


def _preload_for_serverless() -> None:
    if os.getenv("MO_RUNPOD_PRELOAD_ON_START") == "1":
        _translation_pipeline(os.getenv("RUNPOD_SERVERLESS_TRANSLATION_BACKEND", "openai"))
    if os.getenv("MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START") == "1":
        _voice_conversion_service()


if __name__ == "__main__":
    import runpod

    _preload_for_serverless()
    runpod.serverless.start({"handler": handler})
