from __future__ import annotations

import base64
import gc
import hashlib
import inspect
import json
import os
import subprocess
import sys
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from time import perf_counter
from typing import Any

from .audio_effects import AudioEffectInsertResult, AudioEffectInsertSettings, insert_audio_effect
from .factory import create_openai_pipeline, create_pipeline_from_env, create_realtime_translation_pipeline
from .pipeline import PipelineProgress, PipelineRequest, SpeechTranslationPipeline, TtsOutput
from .providers.funasr import FunAsrPracticeProvider
from .providers.text_tts import create_text_tts_providers
from .providers.voice import (
    SeedVcRuntimeSettings,
    VoiceConversionRequest,
    VoiceConversionService,
    create_voice_conversion_service_from_env,
)
from .vibevoice import (
    VibeVoiceGenerationOptions,
    VibeVoiceService,
    VibeVoiceVoiceSample,
    directed_retry_max_lines_for_script,
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
_VIBEVOICE_SERVICE: VibeVoiceService | None = None
_VIBEVOICE_SERVICE_LOAD_MS: float | None = None
_FUNASR_PRACTICE_PROVIDER: FunAsrPracticeProvider | None = None
_FUNASR_PRACTICE_PROVIDER_LOAD_MS: float | None = None
_DEFAULT_RUNPOD_VIBEVOICE_RESPONSE_AUDIO_FORMAT = "mp3"
_DEFAULT_RUNPOD_VIBEVOICE_RESPONSE_AUDIO_BITRATE = "96k"
_DEFAULT_RUNPOD_VIBEVOICE_RESPONSE_AUDIO_TIMEOUT_SECONDS = 60.0
_DEFAULT_RUNPOD_VIBEVOICE_ARTIFACT_AUDIO_FORMAT = "mp3"
_DEFAULT_RUNPOD_VIBEVOICE_MAX_ARTIFACTS = 64
_DEFAULT_RUNPOD_VIBEVOICE_MAX_ARTIFACT_BASE64_CHARS = 2_000_000
_DEFAULT_RUNPOD_VIBEVOICE_EXCLUDE_ARTIFACT_KINDS = ("speaker_vibevoice",)
PRACTICE_ASR_CONTRACT_VERSION = 3


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
        return _handle_voice_conversion(payload, handler_started, event)
    if operation_mode in {"practice_asr", "practice-asr"}:
        return _handle_practice_asr(payload, handler_started, event)
    if operation_mode in {"vibevoice", "vibe_voice"}:
        return _handle_vibevoice(payload, handler_started, event)
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
    preload_practice_asr = _optional_bool(payload.get("preload_practice_asr"))
    if preload_translation is None:
        preload_translation = True
    if preload_voice_conversion is None:
        preload_voice_conversion = False
    if preload_practice_asr is None:
        preload_practice_asr = False
    if preload_voice_conversion and preload_practice_asr:
        raise ValueError("preload_voice_conversion and preload_practice_asr cannot both be enabled")

    pipeline_load_ms: float | None = None
    voice_conversion_service_load_ms: float | None = None
    funasr_provider_load_ms: float | None = None
    providers: dict[str, str] = {}
    if preload_translation:
        _, pipeline_load_ms = _translation_pipeline(translation_backend)
        providers["translation_backend"] = translation_backend
    if preload_voice_conversion:
        _release_funasr_before_voice_conversion()
        _, voice_conversion_service_load_ms = _voice_conversion_service()
        providers["voice_conversion"] = "seed-vc"
    if preload_practice_asr:
        _release_voice_conversion_before_funasr()
        provider, funasr_provider_load_ms = _funasr_practice_provider()
        providers["practice_asr"] = provider.name

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
        "funasr_provider_load": funasr_provider_load_ms or 0.0,
    }
    response["serverless"] = {
        "operation_mode": "warmup",
        "worker_cold": (
            pipeline_load_ms is not None
            or voice_conversion_service_load_ms is not None
            or funasr_provider_load_ms is not None
        ),
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


def _handle_voice_conversion(
    payload: dict[str, object],
    handler_started: float,
    event: dict[str, Any],
) -> dict[str, object]:
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

    _report_runpod_progress(
        event,
        _practice_asr_progress("initializing", "Seed-VC処理を準備しています", "Seed-VC"),
    )
    _release_funasr_before_voice_conversion()
    _report_runpod_progress(
        event,
        _practice_asr_progress("loading_seed_vc_model", "Seed-VCモデルを読み込んでいます", "Seed-VC"),
    )
    service, service_load_ms = _voice_conversion_service()

    def report_progress(progress: PipelineProgress) -> None:
        stage = "loading_seed_vc_model" if progress.stage == "loading_model" else progress.stage
        _report_runpod_progress(
            event,
            _practice_asr_progress(stage, progress.label, progress.provider or "Seed-VC"),
        )

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
                ),
                progress_callback=report_progress,
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


def _handle_practice_asr(
    payload: dict[str, object],
    handler_started: float,
    event: dict[str, Any],
) -> dict[str, object]:
    audio_base64 = payload.get("audio_base64")
    if not isinstance(audio_base64, str) or audio_base64 == "":
        raise ValueError("audio_base64 is required")
    source_language = str(payload.get("source_language", ""))
    if source_language != "zh-CN":
        raise ValueError("practice_asr only supports zh-CN")

    model_name = str(os.getenv("MO_RUNPOD_FUNASR_MODEL", "funasr/paraformer-zh"))
    _report_runpod_progress(
        event,
        _practice_asr_progress(
            "initializing",
            "FunASR処理を初期化しています",
            model_name,
        ),
    )

    decode_started = perf_counter()
    audio_bytes = base64.b64decode(audio_base64)
    model_audio_base64 = payload.get("model_audio_base64")
    model_audio_bytes = (
        base64.b64decode(model_audio_base64)
        if isinstance(model_audio_base64, str) and model_audio_base64
        else None
    )
    audio_decode_ms = _elapsed_ms(decode_started)
    _release_voice_conversion_before_funasr()
    if _FUNASR_PRACTICE_PROVIDER is None:
        _report_runpod_progress(
            event,
            _practice_asr_progress(
                "loading_model",
                "FunASRモデルを読み込んでいます",
                model_name,
            ),
        )
    provider, provider_load_ms = _funasr_practice_provider()
    model_name = str(getattr(provider, "model", model_name) or model_name)

    temp_write_ms = 0.0
    model_transcription = None
    model_asr_ms = 0.0
    model_alignment_ms = 0.0
    model_temp_write_ms = 0.0
    if model_audio_bytes is not None:
        _report_runpod_progress(
            event,
            _practice_asr_progress(
                "transcribing_model",
                "お手本音声をFunASRで解析しています",
                model_name,
            ),
        )
        with NamedTemporaryFile(suffix=_audio_suffix(payload.get("model_audio_mime_type"))) as model_temp_audio:
            model_temp_write_started = perf_counter()
            model_temp_audio.write(model_audio_bytes)
            model_temp_audio.flush()
            model_temp_write_ms = _elapsed_ms(model_temp_write_started)
            model_asr_started = perf_counter()
            model_transcription = provider.transcribe_detail(
                Path(model_temp_audio.name),
                source_language,
                include_timestamps=True,
            )
            model_asr_ms = _elapsed_ms(model_asr_started)
            model_alignment_started = perf_counter()
            model_transcription = provider.force_align_detail(
                Path(model_temp_audio.name),
                model_transcription,
            )
            model_alignment_ms = _elapsed_ms(model_alignment_started)

    _report_runpod_progress(
        event,
        _practice_asr_progress(
            "transcribing_attempt",
            "録音をFunASRで解析しています",
            model_name,
        ),
    )
    with NamedTemporaryFile(suffix=_audio_suffix(payload.get("audio_mime_type"))) as temp_audio:
        temp_write_started = perf_counter()
        temp_audio.write(audio_bytes)
        temp_audio.flush()
        temp_write_ms = _elapsed_ms(temp_write_started)
        asr_started = perf_counter()
        transcription = provider.transcribe_detail(
            Path(temp_audio.name),
            source_language,
            include_timestamps=True,
        )
        asr_ms = _elapsed_ms(asr_started)
        alignment_started = perf_counter()
        transcription = provider.force_align_detail(Path(temp_audio.name), transcription)
        alignment_ms = _elapsed_ms(alignment_started)

    _report_runpod_progress(
        event,
        _practice_asr_progress(
            "finalizing",
            "比較用timestampを整理しています",
            model_name,
        ),
    )

    response: dict[str, object] = {
        "practice_asr_contract_version": PRACTICE_ASR_CONTRACT_VERSION,
        "text": transcription.text,
        "model": transcription.model,
        "timestamp_granularities": transcription.timestamp_granularities,
        "words": transcription.words,
        "segments": transcription.segments,
        "timings_ms": {
            "asr": asr_ms,
            "model_asr": model_asr_ms,
            "alignment": alignment_ms,
            "model_alignment": model_alignment_ms,
            "total": asr_ms + model_asr_ms + alignment_ms + model_alignment_ms,
        },
        "providers": {"asr": provider.name},
        "warnings": [],
    }
    target_text = str(payload.get("target_text") or "")
    if target_text:
        response["target_text"] = target_text
    if model_transcription is not None:
        response["model_transcription"] = _practice_asr_transcription_payload(model_transcription)
    _attach_serverless_metrics(
        response,
        operation_mode="practice_asr",
        handler_started=handler_started,
        worker_cold=provider_load_ms is not None,
        audio_decode_ms=audio_decode_ms,
        temp_write_ms=temp_write_ms + model_temp_write_ms,
        load_metric_name="funasr_provider_load",
        load_ms=provider_load_ms,
    )
    return response


def _practice_asr_transcription_payload(transcription: object) -> dict[str, object]:
    return {
        "text": str(getattr(transcription, "text", "") or ""),
        "model": str(getattr(transcription, "model", "") or ""),
        "timestamp_granularities": list(getattr(transcription, "timestamp_granularities", []) or []),
        "words": list(getattr(transcription, "words", []) or []),
        "segments": list(getattr(transcription, "segments", []) or []),
    }


def _practice_asr_progress(stage: str, label: str, model: str) -> dict[str, object]:
    return {
        "stage": stage,
        "label": label,
        "provider": "RunPod Serverless",
        "model": model,
    }


def _report_runpod_progress(event: dict[str, Any], progress: dict[str, object]) -> None:
    if not str(event.get("id") or "").strip():
        return
    try:
        import runpod

        runpod.serverless.progress_update(event, progress)
    except Exception:
        # Progress is best-effort telemetry. A missing local channel or a
        # transient reporting failure must not abort the actual inference.
        return


def _vibevoice_service_progress(stage: str, label: str, model_id: str) -> dict[str, object]:
    normalized_stage = str(stage or "processing")
    normalized_label = str(label or "SkitVoiceを処理しています")
    lowered = normalized_label.lower()
    if "seed-vc" in lowered and "読み込" in normalized_label:
        return _vibevoice_runpod_progress("loading_seed_vc_model", normalized_label, "Seed-VC")
    if normalized_stage == "loading_model":
        return _vibevoice_runpod_progress("loading_seed_vc_model", normalized_label, "Seed-VC")
    if normalized_stage == "asr":
        return _vibevoice_runpod_progress("directed_asr", normalized_label, _vibevoice_directed_asr_model())
    if normalized_stage == "voice_conversion":
        return _vibevoice_runpod_progress("voice_conversion", normalized_label, "Seed-VC")
    if normalized_stage == "generation" and "モデル読み込み" in normalized_label:
        return _vibevoice_runpod_progress("loading_vibevoice_model", normalized_label, model_id)
    if normalized_stage in {"generation", "prepare", "input"}:
        return _vibevoice_runpod_progress("vibevoice_generation", normalized_label, model_id)
    if normalized_stage == "reconstruct":
        return _vibevoice_runpod_progress("reconstruct", normalized_label, model_id)
    return _vibevoice_runpod_progress(normalized_stage, normalized_label, model_id)


def _vibevoice_runpod_progress(
    stage: str,
    label: str,
    model: str,
    *,
    detail: str = "",
) -> dict[str, object]:
    return {
        "stage": stage,
        "label": label,
        "provider": "RunPod Serverless",
        "model": model,
        "detail": detail,
    }


def _vibevoice_model_label(model_id: str) -> str:
    normalized = str(model_id or "").lower()
    if "large" in normalized:
        return "VibeVoice Large"
    if "1.5b" in normalized:
        return "VibeVoice 1.5B"
    return "VibeVoice"


def _vibevoice_directed_asr_model() -> str:
    provider = os.getenv("MO_VIBEVOICE_DIRECTED_ASR_PROVIDER", "openai").strip().lower() or "openai"
    if provider in {"faster-whisper", "faster_whisper"}:
        return os.getenv("FASTER_WHISPER_MODEL", "large-v3")
    return os.getenv("MO_VIBEVOICE_DIRECTED_OPENAI_ASR_MODEL", "whisper-1")


def _handle_vibevoice(
    payload: dict[str, object],
    handler_started: float,
    event: dict[str, Any],
) -> dict[str, object]:
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
        speaker = _optional_int(item.get("speaker"))
        if speaker is None:
            speaker = index
        audio_base64 = item.get("audio_base64")
        if isinstance(audio_base64, str) and audio_base64:
            decoded_voices.append(
                (
                    speaker,
                    str(item.get("filename") or f"voice-{index}.wav"),
                    str(item.get("audio_mime_type") or "audio/wav"),
                    base64.b64decode(audio_base64),
                )
            )
            continue
        raise ValueError(f"voice {index} audio_base64 is required")
    audio_decode_ms = _elapsed_ms(decode_started)

    options = _vibevoice_options_from_payload(payload.get("generation"), script_text=script)
    _report_runpod_progress(
        event,
        _vibevoice_runpod_progress(
            "initializing",
            "SkitVoice処理を初期化しています",
            options.model_id,
        ),
    )
    _release_funasr_before_vibevoice()
    _release_voice_conversion_before_vibevoice()
    service, service_load_ms = _vibevoice_service()
    _report_runpod_progress(
        event,
        _vibevoice_runpod_progress(
            "loading_vibevoice_model",
            f"{_vibevoice_model_label(options.model_id)}モデルを読み込んでいます",
            options.model_id,
            detail="初回起動時は数分かかる場合があります。",
        ),
    )
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
        generate_kwargs: dict[str, object] = {
            "script_text": script,
            "voice_paths": voice_paths,
            "options": options,
        }
        if "progress_callback" in inspect.signature(service.generate).parameters:
            generate_kwargs["progress_callback"] = lambda stage, label: _report_runpod_progress(
                event,
                _vibevoice_service_progress(stage, label, options.model_id),
            )
        result = service.generate(**generate_kwargs)

    _report_runpod_progress(
        event,
        _vibevoice_runpod_progress(
            "finalizing",
            "生成音声を出力用に仕上げています",
            options.model_id,
        ),
    )
    response_artifacts, artifact_summary = _vibevoice_artifacts_for_runpod_response(
        payload,
        getattr(result, "artifacts", []),
    )
    diagnostics = dict(result.diagnostics)
    script_translation = payload.get("script_translation")
    if isinstance(script_translation, dict):
        diagnostics["script_translation"] = script_translation
    if artifact_summary["available"] or artifact_summary["include_requested"]:
        diagnostics["runpod_artifacts"] = artifact_summary
    response_audio_bytes, response_audio_mime_type, response_audio_diagnostics, response_audio_warnings = (
        _vibevoice_response_audio_for_runpod(payload, result.audio_bytes, result.audio_mime_type)
    )
    diagnostics["runpod_audio_response"] = response_audio_diagnostics

    response: dict[str, object] = {
        "audio_mime_type": response_audio_mime_type,
        "audio_base64": base64.b64encode(response_audio_bytes).decode("ascii"),
        "normalized_script": result.normalized_script,
        "timings_ms": result.timings_ms,
        "providers": result.providers,
        "diagnostics": diagnostics,
        "artifacts": response_artifacts,
        "warnings": response_audio_warnings,
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
            "funasr_practice_loaded": _FUNASR_PRACTICE_PROVIDER is not None,
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


def _funasr_practice_provider() -> tuple[FunAsrPracticeProvider, float | None]:
    global _FUNASR_PRACTICE_PROVIDER, _FUNASR_PRACTICE_PROVIDER_LOAD_MS
    if _FUNASR_PRACTICE_PROVIDER is None:
        started = perf_counter()
        _FUNASR_PRACTICE_PROVIDER = FunAsrPracticeProvider()
        _FUNASR_PRACTICE_PROVIDER.preload()
        _FUNASR_PRACTICE_PROVIDER_LOAD_MS = _elapsed_ms(started)
        return _FUNASR_PRACTICE_PROVIDER, _FUNASR_PRACTICE_PROVIDER_LOAD_MS
    return _FUNASR_PRACTICE_PROVIDER, None


def _vibevoice_service() -> tuple[VibeVoiceService, float | None]:
    global _VIBEVOICE_SERVICE, _VIBEVOICE_SERVICE_LOAD_MS
    if _VIBEVOICE_SERVICE is None:
        started = perf_counter()
        _VIBEVOICE_SERVICE = VibeVoiceService.from_env()
        _VIBEVOICE_SERVICE_LOAD_MS = _elapsed_ms(started)
        return _VIBEVOICE_SERVICE, _VIBEVOICE_SERVICE_LOAD_MS
    return _VIBEVOICE_SERVICE, None


def _release_voice_conversion_before_vibevoice() -> bool:
    global _VOICE_CONVERSION_SERVICE, _VOICE_CONVERSION_SERVICE_LOAD_MS
    if os.getenv("MO_RUNPOD_RELEASE_VOICE_CONVERSION_BEFORE_VIBEVOICE", "1") == "0":
        return False
    if _VOICE_CONVERSION_SERVICE is None:
        return False
    release = getattr(_VOICE_CONVERSION_SERVICE, "release", None)
    if callable(release):
        release()
    _VOICE_CONVERSION_SERVICE = None
    _VOICE_CONVERSION_SERVICE_LOAD_MS = None
    _release_accelerator_memory()
    return True


def _release_voice_conversion_before_funasr() -> bool:
    global _VOICE_CONVERSION_SERVICE, _VOICE_CONVERSION_SERVICE_LOAD_MS
    if os.getenv("MO_RUNPOD_RELEASE_VOICE_CONVERSION_BEFORE_FUNASR", "1") == "0":
        return False
    if _VOICE_CONVERSION_SERVICE is None:
        return False
    release = getattr(_VOICE_CONVERSION_SERVICE, "release", None)
    if callable(release):
        release()
    _VOICE_CONVERSION_SERVICE = None
    _VOICE_CONVERSION_SERVICE_LOAD_MS = None
    _release_accelerator_memory()
    return True


def _release_funasr_before_voice_conversion() -> bool:
    return _release_funasr("MO_RUNPOD_RELEASE_FUNASR_BEFORE_VOICE_CONVERSION")


def _release_funasr_before_vibevoice() -> bool:
    return _release_funasr("MO_RUNPOD_RELEASE_FUNASR_BEFORE_VIBEVOICE")


def _release_funasr(env_name: str) -> bool:
    global _FUNASR_PRACTICE_PROVIDER, _FUNASR_PRACTICE_PROVIDER_LOAD_MS
    if os.getenv(env_name, "1") == "0":
        return False
    if _FUNASR_PRACTICE_PROVIDER is None:
        return False
    release = getattr(_FUNASR_PRACTICE_PROVIDER, "release", None)
    if callable(release):
        release()
    _FUNASR_PRACTICE_PROVIDER = None
    _FUNASR_PRACTICE_PROVIDER_LOAD_MS = None
    _release_accelerator_memory()
    return True


def _release_accelerator_memory() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


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


def _vibevoice_artifacts_for_runpod_response(
    payload: dict[str, object],
    artifacts_value: object,
) -> tuple[list[dict[str, object]], dict[str, object]]:
    all_artifacts = (
        [dict(item) for item in artifacts_value if isinstance(item, dict)]
        if isinstance(artifacts_value, list)
        else []
    )
    excluded_kinds = _runpod_artifact_excluded_kinds(payload)
    artifacts = [
        artifact
        for artifact in all_artifacts
        if str(artifact.get("kind") or "").strip() not in excluded_kinds
    ]
    total_base64_chars = sum(_artifact_audio_base64_chars(artifact) for artifact in all_artifacts)
    total_size_bytes = sum(_artifact_size_bytes(artifact) for artifact in all_artifacts)
    available_base64_chars = sum(_artifact_audio_base64_chars(artifact) for artifact in artifacts)
    available_size_bytes = sum(_artifact_size_bytes(artifact) for artifact in artifacts)
    include_artifacts = _optional_bool(payload.get("return_artifacts"))
    if include_artifacts is None:
        env_include_artifacts = _optional_bool(os.getenv("MO_RUNPOD_VIBEVOICE_RETURN_ARTIFACTS"))
        include_artifacts = env_include_artifacts if env_include_artifacts is not None else True
    summary: dict[str, object] = {
        "total_available": len(all_artifacts),
        "total_audio_base64_chars": total_base64_chars,
        "total_size_bytes": total_size_bytes,
        "available": len(artifacts),
        "returned": 0,
        "omitted": len(artifacts),
        "include_requested": include_artifacts,
        "available_audio_base64_chars": available_base64_chars,
        "available_size_bytes": available_size_bytes,
        "filtered_out": len(all_artifacts) - len(artifacts),
        "excluded_kinds": sorted(excluded_kinds),
    }
    if not all_artifacts:
        summary["omitted_reason"] = ""
        return [], summary
    if not artifacts:
        summary["omitted_reason"] = "filtered"
        return [], summary
    if not include_artifacts:
        summary["omitted_reason"] = "disabled"
        return [], summary

    max_items = _bounded_int(
        _payload_value_or_env(payload, "artifact_response_max_items", "MO_RUNPOD_VIBEVOICE_MAX_ARTIFACTS"),
        0,
        1000,
        _DEFAULT_RUNPOD_VIBEVOICE_MAX_ARTIFACTS,
    )
    max_base64_chars = _bounded_int(
        _payload_value_or_env(
            payload,
            "artifact_response_max_base64_chars",
            "MO_RUNPOD_VIBEVOICE_MAX_ARTIFACT_BASE64_CHARS",
        ),
        0,
        100_000_000,
        _DEFAULT_RUNPOD_VIBEVOICE_MAX_ARTIFACT_BASE64_CHARS,
    )
    artifact_audio_format = _runpod_artifact_response_audio_format(payload)
    returned: list[dict[str, object]] = []
    returned_base64_chars = 0
    encode_failures = 0
    for artifact in artifacts:
        if max_items == 0 or len(returned) >= max_items:
            break
        response_artifact, encoded, encode_error = _runpod_response_artifact(
            artifact,
            output_format=artifact_audio_format,
            bitrate=str(
                _payload_value_or_env(
                    payload,
                    "artifact_response_audio_bitrate",
                    "MO_RUNPOD_VIBEVOICE_ARTIFACT_AUDIO_BITRATE",
                )
                or _DEFAULT_RUNPOD_VIBEVOICE_RESPONSE_AUDIO_BITRATE
            ).strip()
            or _DEFAULT_RUNPOD_VIBEVOICE_RESPONSE_AUDIO_BITRATE,
            timeout_seconds=_bounded_float(
                _payload_value_or_env(
                    payload,
                    "artifact_response_audio_timeout_seconds",
                    "MO_RUNPOD_VIBEVOICE_ARTIFACT_AUDIO_TIMEOUT_SECONDS",
                ),
                1.0,
                300.0,
                _DEFAULT_RUNPOD_VIBEVOICE_RESPONSE_AUDIO_TIMEOUT_SECONDS,
            ),
        )
        if encode_error:
            encode_failures += 1
        audio_base64_chars = _artifact_audio_base64_chars(response_artifact)
        if max_base64_chars > 0 and returned_base64_chars + audio_base64_chars > max_base64_chars:
            continue
        response_artifact["response_audio_encoded"] = encoded
        returned.append(response_artifact)
        returned_base64_chars += audio_base64_chars
    summary.update(
        {
            "returned": len(returned),
            "omitted": len(artifacts) - len(returned),
            "omitted_reason": "limit" if len(returned) < len(artifacts) else "",
            "returned_audio_base64_chars": returned_base64_chars,
            "max_items": max_items,
            "max_audio_base64_chars": max_base64_chars,
            "response_audio_format": artifact_audio_format,
            "audio_encode_failures": encode_failures,
        }
    )
    return returned, summary


def _runpod_artifact_excluded_kinds(payload: dict[str, object]) -> set[str]:
    raw_value = _payload_value_or_env(
        payload,
        "artifact_response_exclude_kinds",
        "MO_RUNPOD_VIBEVOICE_EXCLUDE_ARTIFACT_KINDS",
    )
    if raw_value is None:
        return set(_DEFAULT_RUNPOD_VIBEVOICE_EXCLUDE_ARTIFACT_KINDS)
    if isinstance(raw_value, (list, tuple, set)):
        return {str(item).strip() for item in raw_value if str(item).strip()}
    raw_text = str(raw_value).strip()
    if raw_text == "":
        return set()
    if raw_text.lower() in {"none", "false", "0"}:
        return set()
    return {part.strip() for part in raw_text.split(",") if part.strip()}


def _runpod_artifact_response_audio_format(payload: dict[str, object]) -> str:
    raw_value = _payload_value_or_env(
        payload,
        "artifact_response_audio_format",
        "MO_RUNPOD_VIBEVOICE_ARTIFACT_AUDIO_FORMAT",
    )
    return _normalize_runpod_audio_format(raw_value, default=_DEFAULT_RUNPOD_VIBEVOICE_ARTIFACT_AUDIO_FORMAT)


def _runpod_response_artifact(
    artifact: dict[str, object],
    *,
    output_format: str,
    bitrate: str,
    timeout_seconds: float,
) -> tuple[dict[str, object], bool, str]:
    response_artifact = dict(artifact)
    audio_base64 = response_artifact.get("audio_base64")
    if not isinstance(audio_base64, str) or audio_base64 == "" or output_format == "wav":
        return response_artifact, False, ""
    source_mime_type = str(response_artifact.get("audio_mime_type") or "audio/wav")
    try:
        source_audio_bytes = base64.b64decode(audio_base64)
        encoded_bytes, encoded_mime_type = _encode_runpod_response_audio_with_ffmpeg(
            source_audio_bytes,
            source_mime_type=source_mime_type,
            output_format=output_format,
            bitrate=bitrate,
            timeout_seconds=timeout_seconds,
        )
    except Exception as exc:
        response_artifact["response_audio_error"] = str(exc)
        return response_artifact, False, str(exc)
    response_artifact["source_audio_mime_type"] = source_mime_type
    response_artifact["source_size_bytes"] = response_artifact.get("size_bytes", len(source_audio_bytes))
    response_artifact["audio_mime_type"] = encoded_mime_type
    response_artifact["audio_base64"] = base64.b64encode(encoded_bytes).decode("ascii")
    response_artifact["size_bytes"] = len(encoded_bytes)
    return response_artifact, True, ""


def _vibevoice_response_audio_for_runpod(
    payload: dict[str, object],
    audio_bytes: bytes,
    source_mime_type: str,
) -> tuple[bytes, str, dict[str, object], list[str]]:
    requested_format = _runpod_response_audio_format(payload)
    bitrate = str(
        _payload_value_or_env(
            payload,
            "response_audio_bitrate",
            "MO_RUNPOD_VIBEVOICE_RESPONSE_AUDIO_BITRATE",
        )
        or _DEFAULT_RUNPOD_VIBEVOICE_RESPONSE_AUDIO_BITRATE
    ).strip() or _DEFAULT_RUNPOD_VIBEVOICE_RESPONSE_AUDIO_BITRATE
    timeout_seconds = _bounded_float(
        _payload_value_or_env(
            payload,
            "response_audio_timeout_seconds",
            "MO_RUNPOD_VIBEVOICE_RESPONSE_AUDIO_TIMEOUT_SECONDS",
        ),
        1.0,
        300.0,
        _DEFAULT_RUNPOD_VIBEVOICE_RESPONSE_AUDIO_TIMEOUT_SECONDS,
    )
    diagnostics: dict[str, object] = {
        "requested_format": requested_format,
        "source_audio_mime_type": source_mime_type,
        "source_size_bytes": len(audio_bytes),
        "bitrate": bitrate,
        "encoded": False,
    }
    if requested_format == "wav":
        diagnostics.update(
            {
                "audio_mime_type": source_mime_type or "audio/wav",
                "size_bytes": len(audio_bytes),
            }
        )
        return audio_bytes, source_mime_type or "audio/wav", diagnostics, []

    try:
        encoded_bytes, encoded_mime_type = _encode_runpod_response_audio_with_ffmpeg(
            audio_bytes,
            source_mime_type=source_mime_type,
            output_format=requested_format,
            bitrate=bitrate,
            timeout_seconds=timeout_seconds,
        )
    except Exception as exc:
        diagnostics.update(
            {
                "audio_mime_type": source_mime_type or "audio/wav",
                "size_bytes": len(audio_bytes),
                "error": str(exc),
            }
        )
        return audio_bytes, source_mime_type or "audio/wav", diagnostics, [
            f"RunPod返却音声の圧縮に失敗したためWAVで返しました: {exc}"
        ]

    diagnostics.update(
        {
            "audio_mime_type": encoded_mime_type,
            "size_bytes": len(encoded_bytes),
            "encoded": True,
            "compression_ratio": round(len(encoded_bytes) / max(1, len(audio_bytes)), 6),
        }
    )
    return encoded_bytes, encoded_mime_type, diagnostics, []


def _runpod_response_audio_format(payload: dict[str, object]) -> str:
    raw_value = _payload_value_or_env(
        payload,
        "response_audio_format",
        "MO_RUNPOD_VIBEVOICE_RESPONSE_AUDIO_FORMAT",
    )
    return _normalize_runpod_audio_format(raw_value, default=_DEFAULT_RUNPOD_VIBEVOICE_RESPONSE_AUDIO_FORMAT)


def _normalize_runpod_audio_format(value: object, *, default: str) -> str:
    normalized = str(value or default).strip().lower()
    if normalized in {"", "mp3", "mpeg", "audio/mpeg"}:
        return "mp3"
    if normalized in {"m4a", "mp4", "aac", "audio/mp4", "audio/aac"}:
        return "m4a"
    if normalized in {"wav", "wave", "audio/wav"}:
        return "wav"
    return default


def _encode_runpod_response_audio_with_ffmpeg(
    audio_bytes: bytes,
    *,
    source_mime_type: str,
    output_format: str,
    bitrate: str,
    timeout_seconds: float,
) -> tuple[bytes, str]:
    if output_format not in {"mp3", "m4a"}:
        raise ValueError(f"unsupported response audio format: {output_format}")
    with TemporaryDirectory() as temp_dir_raw:
        temp_dir = Path(temp_dir_raw)
        input_path = temp_dir / f"input{_audio_suffix(source_mime_type)}"
        output_path = temp_dir / f"output.{output_format}"
        input_path.write_bytes(audio_bytes)
        command = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(input_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "24000",
            "-b:a",
            bitrate,
        ]
        if output_format == "mp3":
            command.extend(["-codec:a", "libmp3lame", str(output_path)])
            mime_type = "audio/mpeg"
        else:
            command.extend(["-codec:a", "aac", "-movflags", "+faststart", str(output_path)])
            mime_type = "audio/mp4"
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(_tail_text(completed.stderr) or f"ffmpeg exited with {completed.returncode}")
        if not output_path.is_file() or output_path.stat().st_size == 0:
            raise RuntimeError("ffmpeg did not produce response audio")
        return output_path.read_bytes(), mime_type


def _payload_value_or_env(payload: dict[str, object], payload_key: str, env_key: str) -> object:
    if payload_key in payload:
        return payload[payload_key]
    return os.getenv(env_key)


def _artifact_audio_base64_chars(artifact: dict[str, object]) -> int:
    audio_base64 = artifact.get("audio_base64")
    return len(audio_base64) if isinstance(audio_base64, str) else 0


def _artifact_size_bytes(artifact: dict[str, object]) -> int:
    value = artifact.get("size_bytes")
    try:
        return int(value) if value is not None else 0
    except (TypeError, ValueError):
        return 0


def _seed_vc_settings_from_payload(payload: dict[str, object]) -> SeedVcRuntimeSettings:
    return SeedVcRuntimeSettings(
        diffusion_steps=_optional_int(payload.get("seed_vc_diffusion_steps")),
        length_adjust=_optional_float(payload.get("seed_vc_length_adjust")),
        inference_cfg_rate=_optional_float(payload.get("seed_vc_inference_cfg_rate")),
        reference_max_seconds=_optional_float(payload.get("seed_vc_reference_max_seconds")),
        reference_auto_select=_optional_bool(payload.get("seed_vc_reference_auto_select")),
    )


def _vibevoice_options_from_payload(value: object, *, script_text: str = "") -> VibeVoiceGenerationOptions:
    generation = value if isinstance(value, dict) else {}
    retry_max_lines = _directed_retry_max_lines_from_generation(generation, script_text=script_text)
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
        directed_line_mode=_optional_bool(generation.get("directed_line_mode")) is not False,
        directed_retry_low_score=_optional_bool(generation.get("directed_retry_low_score")) is not False,
        directed_retry_score_threshold=max(
            0.0,
            min(1.0, float(generation.get("directed_retry_score_threshold", 0.65))),
        ),
        directed_retry_max_lines=retry_max_lines,
    )


def _directed_retry_max_lines_from_generation(generation: dict[str, object], *, script_text: str) -> int:
    raw_max_lines = generation.get("directed_retry_max_lines")
    if raw_max_lines not in (None, "", "auto"):
        return max(0, int(raw_max_lines))
    multiplier = float(generation.get("directed_retry_max_multiplier", 1.0))
    return directed_retry_max_lines_for_script(script_text, multiplier=multiplier)


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


def _bounded_float(value: object, minimum: float, maximum: float, fallback: float) -> float:
    if value is None or value == "":
        return fallback
    try:
        number = float(value)
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


def _tail_text(text: str | None, *, max_chars: int = 4000) -> str:
    value = str(text or "").strip()
    if len(value) <= max_chars:
        return value
    return value[-max_chars:]


def _elapsed_ms(started: float) -> float:
    return (perf_counter() - started) * 1000


def _preload_for_serverless() -> None:
    if os.getenv("MO_RUNPOD_PRELOAD_ON_START") == "1":
        _translation_pipeline(os.getenv("RUNPOD_SERVERLESS_TRANSLATION_BACKEND", "openai"))
    if os.getenv("MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START") == "1":
        _voice_conversion_service()
    if os.getenv("MO_RUNPOD_PRELOAD_FUNASR_ON_START") == "1":
        _release_voice_conversion_before_funasr()
        _funasr_practice_provider()


if __name__ == "__main__":
    import runpod

    _preload_for_serverless()
    runpod.serverless.start({"handler": handler})
