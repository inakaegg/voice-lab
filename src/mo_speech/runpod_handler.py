from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from time import perf_counter
from typing import Any

from .audio_effects import AudioEffectInsertResult, AudioEffectInsertSettings, insert_audio_effect
from .factory import create_openai_pipeline, create_pipeline_from_env, create_realtime_translation_pipeline
from .pipeline import PipelineRequest, SpeechTranslationPipeline, TtsOutput
from .providers.text_tts import create_text_tts_providers
from .providers.voice import (
    SeedVcRuntimeSettings,
    VoiceConversionRequest,
    VoiceConversionService,
    create_voice_conversion_service_from_env,
)
from .vibevoice import VibeVoiceGenerationOptions, VibeVoiceService, VibeVoiceVoiceSample

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
_VIBEVOICE_SERVICE: VibeVoiceService | None = None
_VIBEVOICE_SERVICE_LOAD_MS: float | None = None


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
    if operation_mode in {"vibevoice", "vibe_voice"}:
        return _handle_vibevoice(payload, handler_started)
    if operation_mode in {"diagnostics", "diag"}:
        return _handle_diagnostics(payload, handler_started)
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

    effect_result = _insert_audio_effect_from_payload(
        payload,
        result.output_audio_bytes,
        result.output_audio_mime_type,
    )
    output_audio_bytes = effect_result.audio_bytes if effect_result is not None else result.output_audio_bytes
    output_audio_mime_type = effect_result.audio_mime_type if effect_result is not None else result.output_audio_mime_type
    timings_ms = dict(result.timings_ms)
    providers = dict(result.providers)
    warnings = list(result.warnings)
    if effect_result is not None:
        timings_ms.update(effect_result.timings_ms)
        providers["audio_effect_insert"] = "ffmpeg"
        warnings.extend(effect_result.warnings)

    response: dict[str, object] = {
        "audio_mime_type": output_audio_mime_type,
        "audio_base64": base64.b64encode(output_audio_bytes).decode("ascii"),
        "timings_ms": timings_ms,
        "providers": providers,
        "warnings": warnings,
    }
    if effect_result is not None:
        response["audio_effect_inserted_count"] = effect_result.inserted_count
        response["audio_effect_insertion_points"] = effect_result.insertion_points
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


def _handle_vibevoice(payload: dict[str, object], handler_started: float) -> dict[str, object]:
    script = str(payload.get("script", ""))
    voices = payload.get("voices")
    if script.strip() == "":
        raise ValueError("script is required")
    if not isinstance(voices, list) or not voices:
        raise ValueError("voices are required")

    decode_started = perf_counter()
    decoded_voices: list[tuple[int, str, str, bytes]] = []
    for index, item in enumerate(voices, start=1):
        if not isinstance(item, dict):
            raise ValueError("each voice must be an object")
        audio_base64 = item.get("audio_base64")
        if not isinstance(audio_base64, str) or audio_base64 == "":
            raise ValueError(f"voice {index} audio_base64 is required")
        speaker = _optional_int(item.get("speaker"))
        if speaker is None:
            speaker = index
        decoded_voices.append(
            (
                speaker,
                str(item.get("filename") or f"voice-{index}.wav"),
                str(item.get("audio_mime_type") or "audio/wav"),
                base64.b64decode(audio_base64),
            )
        )
    audio_decode_ms = _elapsed_ms(decode_started)

    service, service_load_ms = _vibevoice_service()
    temp_write_ms = 0.0
    with TemporaryDirectory() as temp_dir_raw:
        temp_dir = Path(temp_dir_raw)
        voice_paths: list[VibeVoiceVoiceSample] = []
        temp_write_started = perf_counter()
        for index, (speaker, filename, mime_type, audio_bytes) in enumerate(decoded_voices, start=1):
            path = temp_dir / f"voice-{speaker or index}{Path(filename).suffix or _audio_suffix(mime_type)}"
            path.write_bytes(audio_bytes)
            voice_paths.append(VibeVoiceVoiceSample(slot=speaker, path=path))
        temp_write_ms = _elapsed_ms(temp_write_started)
        result = service.generate(
            script_text=script,
            voice_paths=voice_paths,
            options=_vibevoice_options_from_payload(payload.get("generation")),
        )

    response: dict[str, object] = {
        "audio_mime_type": result.audio_mime_type,
        "audio_base64": base64.b64encode(result.audio_bytes).decode("ascii"),
        "normalized_script": result.normalized_script,
        "timings_ms": result.timings_ms,
        "providers": result.providers,
        "diagnostics": result.diagnostics,
    }
    _attach_serverless_metrics(
        response,
        operation_mode="vibevoice",
        handler_started=handler_started,
        worker_cold=service_load_ms is not None,
        audio_decode_ms=audio_decode_ms,
        temp_write_ms=temp_write_ms,
        load_metric_name="vibevoice_service_load",
        load_ms=service_load_ms,
    )
    return response


def _handle_diagnostics(payload: dict[str, object], handler_started: float) -> dict[str, object]:
    response: dict[str, object] = {
        "diagnostics": True,
        "image": {
            "revision": os.getenv("MO_IMAGE_REVISION", ""),
            "tag": os.getenv("MO_IMAGE_TAG", ""),
        },
        "runtime": {
            "python": sys.version.split()[0],
            "handler_file": __file__,
        },
        "paths": {
            "comfyui_vibevoice_path": os.getenv("COMFYUI_VIBEVOICE_PATH", ""),
            "mo_vibevoice_home": os.getenv("MO_VIBEVOICE_HOME", ""),
        },
        "vibevoice_cli": _source_file_diagnostics(
            Path(os.getenv("MO_VIBEVOICE_CLI") or Path(__file__).with_name("vibevoice_cli.py")).expanduser()
        ),
    }
    _attach_serverless_metrics(
        response,
        operation_mode="diagnostics",
        handler_started=handler_started,
        worker_cold=False,
        audio_decode_ms=0.0,
        temp_write_ms=0.0,
        load_metric_name="diagnostics_load",
        load_ms=0.0,
    )
    return response


def _source_file_diagnostics(path: Path) -> dict[str, object]:
    info: dict[str, object] = {
        "path": str(path),
        "exists": path.is_file(),
        "size_bytes": 0,
        "sha256": "",
        "uses_parsed_scripts": False,
        "uses_raw_text_processor_call": False,
        "installs_vibevoice_modules_utils_alias": False,
    }
    if not path.is_file():
        return info
    data = path.read_bytes()
    text = data.decode("utf-8", errors="replace")
    info.update(
        {
            "size_bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "uses_parsed_scripts": "parsed_scripts=" in text and "speaker_ids_for_prompt" in text,
            "uses_raw_text_processor_call": "text=[script_text]" in text and "voice_samples=[voice_samples_np]" in text,
            "installs_vibevoice_modules_utils_alias": "_install_vibevoice_modules_utils_alias" in text,
        }
    )
    return info


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
        _VOICE_CONVERSION_SERVICE.preload()
        _VOICE_CONVERSION_SERVICE_LOAD_MS = _elapsed_ms(started)
        return _VOICE_CONVERSION_SERVICE, _VOICE_CONVERSION_SERVICE_LOAD_MS
    return _VOICE_CONVERSION_SERVICE, None


def _vibevoice_service() -> tuple[VibeVoiceService, float | None]:
    global _VIBEVOICE_SERVICE, _VIBEVOICE_SERVICE_LOAD_MS
    if _VIBEVOICE_SERVICE is None:
        started = perf_counter()
        _VIBEVOICE_SERVICE = VibeVoiceService.from_env()
        _VIBEVOICE_SERVICE_LOAD_MS = _elapsed_ms(started)
        return _VIBEVOICE_SERVICE, _VIBEVOICE_SERVICE_LOAD_MS
    return _VIBEVOICE_SERVICE, None


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


def _vibevoice_options_from_payload(value: object) -> VibeVoiceGenerationOptions:
    generation = value if isinstance(value, dict) else {}
    return VibeVoiceGenerationOptions(
        model_id=str(generation.get("model_id") or "vibevoice-1.5b-pinned"),
        cfg_scale=float(generation.get("cfg_scale", 1.3)),
        inference_steps=max(1, int(generation.get("inference_steps", 10))),
        seed=int(generation.get("seed", 42)),
        do_sample=_optional_bool(generation.get("do_sample")) is not False,
        temperature=float(generation.get("temperature", 0.95)),
        top_p=float(generation.get("top_p", 0.95)),
        top_k=max(0, int(generation.get("top_k", 0))),
        max_voice_seconds=max(0.0, float(generation.get("max_voice_seconds", 5.0))),
        line_by_line=_optional_bool(generation.get("line_by_line")) is True,
        line_gap=max(0.0, float(generation.get("line_gap", 1.0))),
    )


def _optional_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    return int(value)


def _bounded_int(value: object, minimum: int, maximum: int, fallback: int) -> int:
    if value is None or value == "":
        return fallback
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, number))


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


def _insert_audio_effect_from_payload(
    payload: dict[str, object],
    output_audio_bytes: bytes,
    output_audio_mime_type: str,
) -> AudioEffectInsertResult | None:
    audio_effect_base64 = payload.get("audio_effect_audio_base64")
    if not isinstance(audio_effect_base64, str) or audio_effect_base64 == "":
        return None
    audio_effect_enabled = _optional_bool(payload.get("audio_effect_enabled"))
    if audio_effect_enabled is False:
        return None

    effect_audio_bytes = base64.b64decode(audio_effect_base64)
    with TemporaryDirectory() as temp_dir_raw:
        temp_dir = Path(temp_dir_raw)
        main_audio_path = temp_dir / f"voice-output{_audio_suffix(output_audio_mime_type)}"
        effect_audio_path = temp_dir / f"audio-effect{_audio_suffix(payload.get('audio_effect_audio_mime_type'))}"
        output_path = temp_dir / "voice-output-with-effect.wav"
        main_audio_path.write_bytes(output_audio_bytes)
        effect_audio_path.write_bytes(effect_audio_bytes)
        return insert_audio_effect(
            main_audio_path,
            effect_audio_path,
            output_path,
            settings=AudioEffectInsertSettings(
                insert_mode=str(payload.get("audio_effect_insert_mode", "silence_or_tail")),
                max_insertions=_bounded_int(payload.get("audio_effect_max_insertions"), 1, 5, 1),
                min_silence_ms=_bounded_int(payload.get("audio_effect_min_silence_ms"), 100, 2000, 300),
            ),
        )


def _audio_suffix(audio_mime_type: object) -> str:
    normalized_mime_type = str(audio_mime_type or "").split(";", 1)[0].strip().lower()
    if normalized_mime_type in {"audio/mp4", "audio/mp4a-latm", "audio/m4a", "audio/x-m4a", "audio/aac"}:
        return ".m4a"
    if normalized_mime_type in {"audio/webm", "video/webm"}:
        return ".webm"
    if normalized_mime_type == "audio/mpeg":
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
