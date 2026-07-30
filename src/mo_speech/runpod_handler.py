from __future__ import annotations

import base64
import gc
import hashlib
import os
import sys
from pathlib import Path
from tempfile import NamedTemporaryFile
from time import perf_counter
from typing import Any

from .pipeline import OperationProgress, TtsOutput
from .providers.funasr import FunAsrPracticeProvider
from .providers.text_tts import create_text_tts_providers
from .providers.voice import (
    SeedVcRuntimeSettings,
    VoiceConversionRequest,
    VoiceConversionService,
    create_voice_conversion_service_from_env,
)

_WORKER_STARTED_AT = perf_counter()
_TEXT_TTS_PROVIDERS: dict[str, object] | None = None
_TEXT_TTS_PROVIDERS_LOAD_MS: float | None = None
_VOICE_CONVERSION_SERVICE: VoiceConversionService | None = None
_VOICE_CONVERSION_SERVICE_LOAD_MS: float | None = None
_FUNASR_PRACTICE_PROVIDER: FunAsrPracticeProvider | None = None
_FUNASR_PRACTICE_PROVIDER_LOAD_MS: float | None = None
PRACTICE_ASR_CONTRACT_VERSION = 3


def handler(event: dict[str, Any]) -> dict[str, object]:
    handler_started = perf_counter()
    payload = event.get("input", event)
    if not isinstance(payload, dict):
        raise ValueError("event input must be an object")

    operation_mode = str(payload.get("operation_mode", "")).strip()
    if operation_mode in {"text_tts", "text_to_speech"}:
        return _handle_text_tts(payload, handler_started)
    if operation_mode == "voice_conversion":
        return _handle_voice_conversion(payload, handler_started, event)
    if operation_mode in {"practice_asr", "practice-asr"}:
        return _handle_practice_asr(payload, handler_started, event)
    if operation_mode in {"diagnostics", "diag"}:
        return _handle_diagnostics(payload, handler_started)
    if operation_mode in {"warmup", "preload"}:
        return _handle_warmup(payload, handler_started)
    raise ValueError(f"unsupported operation_mode: {operation_mode}")


def _handle_warmup(payload: dict[str, object], handler_started: float) -> dict[str, object]:
    preload_voice_conversion = _optional_bool(payload.get("preload_voice_conversion"))
    preload_practice_asr = _optional_bool(payload.get("preload_practice_asr"))
    if preload_voice_conversion is None:
        preload_voice_conversion = False
    if preload_practice_asr is None:
        preload_practice_asr = False
    if preload_voice_conversion and preload_practice_asr:
        raise ValueError("preload_voice_conversion and preload_practice_asr cannot both be enabled")

    voice_conversion_service_load_ms: float | None = None
    funasr_provider_load_ms: float | None = None
    providers: dict[str, str] = {}
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
        "voice_conversion_service_load": voice_conversion_service_load_ms or 0.0,
        "funasr_provider_load": funasr_provider_load_ms or 0.0,
    }
    response["serverless"] = {
        "operation_mode": "warmup",
        "worker_cold": (
            voice_conversion_service_load_ms is not None
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

    def report_progress(progress: OperationProgress) -> None:
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
    align_timestamps = _optional_bool(payload.get("align_timestamps"))
    if align_timestamps is None:
        align_timestamps = model_audio_bytes is not None
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
    provider, provider_load_ms = _funasr_practice_provider(preload_alignment=align_timestamps)
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
            if align_timestamps:
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
        alignment_ms = 0.0
        if align_timestamps:
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


def _funasr_practice_provider(
    *,
    preload_alignment: bool = True,
) -> tuple[FunAsrPracticeProvider, float | None]:
    global _FUNASR_PRACTICE_PROVIDER, _FUNASR_PRACTICE_PROVIDER_LOAD_MS
    if _FUNASR_PRACTICE_PROVIDER is None:
        started = perf_counter()
        _FUNASR_PRACTICE_PROVIDER = FunAsrPracticeProvider()
        _FUNASR_PRACTICE_PROVIDER.preload(include_alignment=preload_alignment)
        _FUNASR_PRACTICE_PROVIDER_LOAD_MS = _elapsed_ms(started)
        return _FUNASR_PRACTICE_PROVIDER, _FUNASR_PRACTICE_PROVIDER_LOAD_MS
    return _FUNASR_PRACTICE_PROVIDER, None


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
    if os.getenv("MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START") == "1":
        _voice_conversion_service()
    if os.getenv("MO_RUNPOD_PRELOAD_FUNASR_ON_START") == "1":
        _release_voice_conversion_before_funasr()
        _funasr_practice_provider()


if __name__ == "__main__":
    import runpod

    _preload_for_serverless()
    runpod.serverless.start({"handler": handler})
