from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import shutil
import unicodedata
from collections import OrderedDict
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory, mkdtemp
from threading import Lock
from time import perf_counter
from typing import Annotated

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .api_audio_history import (
    audio_media_type as _audio_media_type,
    history_text_metadata_from_pipeline_result as _history_text_metadata_from_pipeline_result,
    history_text_metadata_from_recording_result as _history_text_metadata_from_recording_result,
    is_reused_history_input as _is_reused_history_input,
    mime_suffix as _mime_suffix,
    save_audio_history_recording as _save_audio_history_recording,
    save_audio_history_uploaded_output as _save_audio_history_uploaded_output,
    serialize_audio_history_entry as _serialize_audio_history_entry,
    serialize_audio_history_settings as _serialize_audio_history_settings,
    upload_suffix as _upload_suffix,
)
from .api_jobs import TextToSpeechJobStore, TranslationJobStore, VibeVoiceJobStore, VoiceConversionJobStore
from .api_requests import (
    create_pipeline_request as _create_pipeline_request,
    create_seed_vc_settings as _create_seed_vc_settings,
)
from .api_runtime import (
    provider_names as _provider_names,
    select_translation_pipeline as _select_translation_pipeline,
    supported_voice_modes as _supported_voice_modes,
    translation_backends as _translation_backends,
    voice_conversion_backends as _voice_conversion_backends,
)
from .api_serializers import normalize_tts_provider_output as _normalize_tts_provider_output
from .api_serializers import serialize_pipeline_result as _serialize_pipeline_result
from .audio_effects import AudioEffectInsertSettings
from .audio_history import AudioHistoryEntry, AudioHistoryStore
from .factory import (
    create_openai_pipeline,
    create_pipeline_from_env,
    create_realtime_translation_pipeline,
    create_runpod_serverless_pipeline,
)
from .media_reference import MediaReferenceAudioExtractor
from .pipeline import SpeechTranslationPipeline
from .pipeline import PipelineResult
from .practice import (
    PRACTICE_TARGET_LANGUAGES,
    PracticeAlignmentError,
    PracticeAlignmentInputError,
    simplify_chinese_text,
    supported_practice_target_language,
    validate_practice_alignment_target,
)
from .practice_llm import (
    PRACTICE_COMPARISON_ERROR_MESSAGE,
    PracticeLlmError,
    PracticeLlmService,
    audio_duration_from_asr_words,
    build_practice_llm_input,
    comparison_alignments_from_llm_result,
    probe_audio_duration_seconds,
    supported_practice_comparison_model,
    validate_playback_padding_seconds,
)
from .practice_jobs import PracticeJobFailure, PracticeJobStore
from .public_sample_audio import PublicSampleAudioStore
from .providers.openai_api import (
    OPENAI_TIMESTAMP_ASR_MODELS,
    AsrTranscription,
    OpenAiAsrProvider,
    create_openai_realtime_translation_client_secret,
    supported_openai_practice_asr_model,
)
from .providers.runpod_serverless import (
    RunpodServerlessPracticeAsrProvider,
    RunpodServerlessVoiceConversionProvider,
)
from .providers.text_tts import create_text_tts_providers, text_tts_backend_statuses
from .providers.voice import (
    VoiceConversionRequest,
    VoiceConversionService,
    create_voice_conversion_service_from_env,
    prepare_seed_vc_reference_preview as _prepare_seed_vc_reference_preview,
)
from .text_display import create_user_display_text
from .transforms import apply_text_transform
from .user_settings import (
    UserSettingsStore,
    prepare_user_settings_for_write,
    serialize_user_settings,
)
from .vibevoice import (
    RunpodServerlessVibeVoiceService,
    VibeVoiceError,
    VibeVoiceGenerator,
    VibeVoiceGenerationOptions,
    VibeVoiceService,
    VibeVoiceVoiceSample,
    directed_retry_max_lines_for_script,
    normalize_vibevoice_backend,
    validate_vibevoice_model_backend,
)

PACKAGE_DIR = Path(__file__).resolve().parent
WEB_DIR = PACKAGE_DIR / "web"
LOGGER = logging.getLogger("mo_speech")
_HAN_CODEPOINT_RANGES = (
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0x20000, 0x2A6DF),
    (0x2A700, 0x2B73F),
    (0x2B740, 0x2B81F),
    (0x2B820, 0x2CEAF),
)
_PINYIN_OMITTED_PUNCTUATION = "，。！？；：、,.!?;:\"'“”‘’（）()[]【】《》<>"
_PINYIN_WHITESPACE_RE = re.compile(r"\s+")
_VIBEVOICE_OUTPUT_LANGUAGES = {
    "en-US": {"label": "英語", "openai_name": "English"},
    "zh-CN": {"label": "中国語", "openai_name": "Chinese"},
    "ja-JP": {"label": "日本語（低品質）", "openai_name": "Japanese"},
}


def _configure_logging() -> None:
    if LOGGER.handlers:
        return
    LOGGER.setLevel(logging.INFO)
    log_dir = Path(os.getenv("MO_LOG_DIR", "tmp/logs")).expanduser()
    log_dir.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(log_dir / "mo-speech.log", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    LOGGER.addHandler(handler)


_configure_logging()


def _elapsed_ms(started: float) -> float:
    return (perf_counter() - started) * 1000


def _practice_alignment_error_envelope(
    error: PracticeAlignmentError | PracticeAlignmentInputError,
) -> dict[str, object]:
    message = (
        "入力内容を確認して、もう一度お試しください。"
        if isinstance(error, PracticeAlignmentInputError)
        else "音声の解析結果を確認できませんでした。もう一度お試しください。"
    )
    return {
        "error": {
            "code": error.error_code,
            "reason": error.reason,
            "stage": error.stage,
            "retryable": error.retryable,
            "message": message,
            "diagnostic_flags": [error.reason],
        }
    }


def _practice_llm_error_envelope(error: PracticeLlmError) -> dict[str, object]:
    return {
        "error": {
            "code": "practice_llm_failed",
            "stage": error.stage,
            "message": PRACTICE_COMPARISON_ERROR_MESSAGE,
            "retryable": True,
            "fallback_to_legacy": False,
        }
    }


def _practice_asr_provider(pipeline: SpeechTranslationPipeline, asr_model: str):
    if isinstance(pipeline.asr, OpenAiAsrProvider):
        return OpenAiAsrProvider(model=asr_model)
    return pipeline.asr


def _practice_stage_identity(provider: object, *, fallback_model: str = "") -> tuple[str, str]:
    name = str(getattr(provider, "name", "") or "")
    provider_name = "OpenAI" if name.startswith("openai-") else name
    model = str(getattr(provider, "model", "") or "")
    if not model:
        model = str(getattr(getattr(provider, "base_tts", None), "model", "") or "")
    return provider_name, model or fallback_model


def _transcribe_practice_audio(asr_provider, audio_path: Path, source_language: str) -> AsrTranscription:
    transcribe_detail = getattr(asr_provider, "transcribe_detail", None)
    if callable(transcribe_detail):
        return transcribe_detail(audio_path, source_language, include_timestamps=True)
    return AsrTranscription(
        text=asr_provider.transcribe(audio_path, source_language),
        model=getattr(asr_provider, "name", "asr"),
    )


_PRACTICE_MODEL_ASR_CACHE_MAX_ENTRIES = 64
_practice_model_asr_cache: "OrderedDict[str, AsrTranscription]" = OrderedDict()
_practice_model_asr_cache_lock = Lock()


def _practice_model_asr_cache_key(audio_bytes: bytes, source_language: str, asr_provider: object) -> str:
    provider_name = str(getattr(asr_provider, "name", "") or asr_provider.__class__.__name__)
    digest = hashlib.sha256(audio_bytes).hexdigest()
    return f"{provider_name}:{source_language}:{digest}"


def _transcribe_practice_model_audio(
    asr_provider,
    audio_path: Path,
    source_language: str,
    audio_bytes: bytes,
) -> AsrTranscription:
    """お手本音声は同じ目標文への再挑戦のたびに同じ内容で送られてくる。
    同一音声・言語・providerの組で結果は変わらないため、復唱のたびに
    ASRを再実行せずプロセス内キャッシュを再利用する。復唱(attempt)音声は
    毎回新しい録音なのでキャッシュしない。"""
    key = _practice_model_asr_cache_key(audio_bytes, source_language, asr_provider)
    with _practice_model_asr_cache_lock:
        cached = _practice_model_asr_cache.get(key)
        if cached is not None:
            _practice_model_asr_cache.move_to_end(key)
            return cached
    transcription = _transcribe_practice_audio(asr_provider, audio_path, source_language)
    with _practice_model_asr_cache_lock:
        _practice_model_asr_cache[key] = transcription
        _practice_model_asr_cache.move_to_end(key)
        while len(_practice_model_asr_cache) > _PRACTICE_MODEL_ASR_CACHE_MAX_ENTRIES:
            _practice_model_asr_cache.popitem(last=False)
    return transcription


def _serialize_asr_timestamps(result: AsrTranscription) -> dict[str, object]:
    raw_words = result.words if isinstance(result.words, list) else []
    raw_segments = result.segments if isinstance(result.segments, list) else []

    def safe_rows(rows: list[dict[str, object]]) -> list[dict[str, object]]:
        safe: list[dict[str, object]] = []
        for row in rows:
            try:
                start = float(row.get("start"))
                end = float(row.get("end"))
            except (TypeError, ValueError):
                continue
            if start < 0 or end < start:
                continue
            safe.append({**row, "start": start, "end": end})
        return safe

    return {
        "available": result.has_timestamps,
        "model": result.model,
        "timestamp_granularities": result.timestamp_granularities,
        "words": safe_rows(raw_words),
        "segments": safe_rows(raw_segments),
        "raw_timestamp_word_count": len(raw_words),
        "raw_timestamp_segment_count": len(raw_segments),
    }


def _asr_transcription_from_runpod_output(
    value: object,
    *,
    fallback_model: str = "funasr/paraformer-zh",
) -> AsrTranscription:
    payload = value if isinstance(value, dict) else {}
    return AsrTranscription(
        text=str(payload.get("text") or "").strip(),
        model=str(payload.get("model") or fallback_model),
        words=[dict(item) for item in payload.get("words", []) if isinstance(item, dict)],
        segments=[dict(item) for item in payload.get("segments", []) if isinstance(item, dict)],
        timestamp_granularities=[
            str(item) for item in payload.get("timestamp_granularities", []) if str(item)
        ],
    )


def _practice_attempt_llm_options_metadata(
    options: dict[str, object],
) -> dict[str, object]:
    payload = {
        key: options.get(key)
        for key in (
            "comparison_model",
            "playback_padding_seconds",
            "reference_audio_duration",
            "attempt_audio_duration",
            "progress_mode",
            "model_audio_cache_key",
        )
    }
    cached_model_transcription = options.get("cached_model_transcription")
    if isinstance(cached_model_transcription, AsrTranscription):
        payload["cached_model_transcription"] = {
            "text": cached_model_transcription.text,
            **_serialize_asr_timestamps(cached_model_transcription),
        }
    return payload


def _practice_attempt_llm_options_from_history(
    entry: AudioHistoryEntry | None,
) -> dict[str, object] | None:
    metadata = entry.metadata if entry is not None and isinstance(entry.metadata, dict) else {}
    payload = metadata.get("practice_attempt_llm_options")
    if not isinstance(payload, dict):
        return None
    options = dict(payload)
    cached_model_transcription = options.get("cached_model_transcription")
    if isinstance(cached_model_transcription, dict):
        options["cached_model_transcription"] = _asr_transcription_from_runpod_output(
            cached_model_transcription
        )
    return options


def _runpod_practice_metrics(body: dict[str, object]) -> dict[str, float]:
    metrics: dict[str, float] = {}
    for source_key, target_key in (
        ("delayTime", "delay_time_ms"),
        ("executionTime", "execution_time_ms"),
    ):
        try:
            value = float(body.get(source_key))
        except (TypeError, ValueError):
            continue
        metrics[target_key] = value
    return metrics


def _runpod_worker_counts(health: object) -> dict[str, int]:
    payload = health if isinstance(health, dict) else {}
    workers = payload.get("workers")
    if isinstance(workers, dict):
        counts: dict[str, int] = {}
        for key, value in workers.items():
            try:
                counts[str(key).lower()] = int(value)
            except (TypeError, ValueError):
                continue
        return counts
    if isinstance(workers, list):
        counts = {}
        for worker in workers:
            if not isinstance(worker, dict):
                continue
            state = str(worker.get("state") or "unknown").lower()
            counts[state] = counts.get(state, 0) + 1
        return counts
    return {}


def _runpod_practice_error_message(body: object) -> str:
    payload = body if isinstance(body, dict) else {}
    detail = str(payload.get("error") or payload.get("message") or "RunPod practice ASR failed").strip()
    if re.search(r"insufficient.*(?:balance|fund|credit)|(?:balance|fund|credit).*insufficient|payment required", detail, re.I):
        return f"RunPodの残高不足でGPU処理を開始できません。RunPodのBillingを確認してください。詳細: {detail}"
    return detail


def _runpod_practice_stage(
    body: dict[str, object],
    health: object | None = None,
) -> dict[str, object]:
    model = "funasr/paraformer-zh"
    status = str(body.get("status") or "").upper()
    progress = body.get("output")
    if status in {"IN_PROGRESS", "RUNNING"} and isinstance(progress, dict):
        return {
            "stage": str(progress.get("stage") or "processing"),
            "label": str(progress.get("label") or "RunPodで処理しています"),
            "provider": str(progress.get("provider") or "RunPod Serverless"),
            "model": str(progress.get("model") or model),
            "detail": str(progress.get("detail") or ""),
        }
    if status in {"IN_QUEUE", "QUEUED", ""}:
        counts = _runpod_worker_counts(health)
        if counts.get("initializing", 0) > 0:
            return {
                "stage": "initializing",
                "label": "GPUワーカーを初期化しています",
                "provider": "RunPod Serverless",
                "model": model,
                "detail": "worker起動後にFunASRモデルを読み込みます。",
            }
        return {
            "stage": "gpu_wait",
            "label": "利用可能なGPUを待っています",
            "provider": "RunPod Serverless",
            "model": model,
            "detail": "RunPodのqueueでworkerの割り当てを待っています。",
        }
    return {
        "stage": "processing",
        "label": "RunPodで処理しています",
        "provider": "RunPod Serverless",
        "model": model,
        "detail": "",
    }


def _compact_asr_timestamps_for_metadata(timestamps: dict[str, object]) -> dict[str, object]:
    words = timestamps.get("words") if isinstance(timestamps.get("words"), list) else []
    segments = timestamps.get("segments") if isinstance(timestamps.get("segments"), list) else []
    return {
        "available": bool(timestamps.get("available")),
        "model": str(timestamps.get("model") or ""),
        "timestamp_granularities": timestamps.get("timestamp_granularities") or [],
        "word_count": len(words),
        "segment_count": len(segments),
        "words": words[:120],
        "segments": segments[:40],
        "truncated": len(words) > 120 or len(segments) > 40,
    }


def _practice_history_diagnostics_metadata(result: dict[str, object]) -> dict[str, object]:
    asr_timestamps = result.get("asr_timestamps") if isinstance(result.get("asr_timestamps"), dict) else {}
    model_asr_timestamps = (
        result.get("model_asr_timestamps") if isinstance(result.get("model_asr_timestamps"), dict) else {}
    )
    diagnostics = {
        "recording_kind": result.get("recording_kind") or "",
        "outcome": result.get("outcome") or "",
        "message": result.get("message") or "",
        "target_language": result.get("target_language") or "",
        "target_text": result.get("target_text") or "",
        "recognized_text": result.get("recognized_text") or "",
        "model_recognized_text": result.get("model_recognized_text") or "",
        "transcript": result.get("transcript") or "",
        "asr_model": result.get("asr_model") or "",
        "global_similarity": result.get("global_similarity"),
        "phrase_similarity": result.get("phrase_similarity"),
        "similarity": result.get("similarity"),
        "grade": result.get("grade"),
        "overall_score": result.get("overall_score"),
        "overall_comment": result.get("overall_comment") or "",
        "llm_comparison": result.get("llm_comparison") or {},
        "comparison_model": result.get("comparison_model") or "",
        "playback_padding_seconds": result.get("playback_padding_seconds"),
        "llm_usage": result.get("llm_usage") or {},
        "llm_estimated_cost_usd": result.get("llm_estimated_cost_usd"),
        "phrase_matches": result.get("phrase_matches") or [],
        "comparison_alignment": result.get("comparison_alignment") or {},
        "model_comparison_alignment": result.get("model_comparison_alignment") or {},
        "asr_timestamps": _compact_asr_timestamps_for_metadata(asr_timestamps),
        "model_asr_timestamps": _compact_asr_timestamps_for_metadata(model_asr_timestamps),
        "timings_ms": result.get("timings_ms") or {},
        "providers": result.get("providers") or {},
    }
    return {
        "asr_model": result.get("asr_model") or "",
        "text_preview": str(result.get("target_text") or result.get("recognized_text") or result.get("transcript") or "")[:80],
        "recognized_text_preview": str(result.get("recognized_text") or result.get("transcript") or "")[:80],
        "practice_diagnostics": diagnostics,
    }


def _practice_attempt_history_entry(store: AudioHistoryStore, job_id: str) -> AudioHistoryEntry | None:
    normalized_job_id = str(job_id or "").strip()
    if not normalized_job_id:
        return None
    for entry in store.list_entries("recordings"):
        metadata = entry.metadata or {}
        if metadata.get("endpoint") != "practice-attempt-jobs":
            continue
        if str(metadata.get("practice_job_id") or "") == normalized_job_id:
            return entry
    return None


def _update_practice_attempt_history(
    store: AudioHistoryStore,
    entry: AudioHistoryEntry | None,
    snapshot: dict[str, object],
) -> None:
    if entry is None:
        return
    result = snapshot.get("result") if isinstance(snapshot.get("result"), dict) else None
    metadata = {
        "practice_job_id": str(snapshot.get("job_id") or ""),
        "practice_job_status": str(snapshot.get("status") or ""),
        "practice_job_metrics": snapshot.get("metrics") or {},
        "practice_job_error": str(snapshot.get("error") or ""),
    }
    if result is not None:
        metadata.update(_practice_history_diagnostics_metadata(result))
        diagnostics = metadata["practice_diagnostics"]
        LOGGER.info(
            "SpeakLoop comparison alignment job_id=%s target_language=%s attempt=%s model=%s",
            metadata["practice_job_id"] or "sync",
            diagnostics.get("target_language") or "",
            json.dumps(diagnostics.get("comparison_alignment") or {}, ensure_ascii=False, separators=(",", ":")),
            json.dumps(diagnostics.get("model_comparison_alignment") or {}, ensure_ascii=False, separators=(",", ":")),
        )
    store.update_metadata(entry, metadata)


async def _read_vibevoice_script(script: str, script_file: UploadFile | None) -> str:
    if script_file is not None and script_file.filename:
        content = await script_file.read()
        if not content:
            raise ValueError("script file is empty")
        try:
            return _normalize_vibevoice_script_line_endings(content.decode("utf-8"))
        except UnicodeDecodeError as exc:
            raise ValueError("script file must be UTF-8") from exc
    return _normalize_vibevoice_script_line_endings(script)


def _normalize_vibevoice_script_line_endings(text: str) -> str:
    return str(text or "").replace("\r\n", "\n").replace("\r", "\n")


async def _save_vibevoice_upload(upload: UploadFile, directory: Path, fallback_name: str) -> Path:
    audio_bytes = await upload.read()
    if not audio_bytes:
        raise ValueError(f"{fallback_name} is empty")
    limit = int(os.getenv("MO_VIBEVOICE_MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
    if len(audio_bytes) > limit:
        raise ValueError(f"{fallback_name} is too large: max {limit} bytes")
    suffix = _upload_suffix(upload.filename) or ".wav"
    output = directory / f"{fallback_name}{suffix}"
    output.write_bytes(audio_bytes)
    return output


def _vibevoice_url_reference_specs(
    *,
    voice_url_1: str,
    voice_url_start_1: str | None,
    voice_url_duration_1: str,
    voice_url_2: str,
    voice_url_start_2: str | None,
    voice_url_duration_2: str,
    voice_url_3: str,
    voice_url_start_3: str | None,
    voice_url_duration_3: str,
    voice_url_4: str,
    voice_url_start_4: str | None,
    voice_url_duration_4: str,
) -> dict[int, dict[str, object]]:
    raw_values = {
        1: (voice_url_1, voice_url_start_1, voice_url_duration_1),
        2: (voice_url_2, voice_url_start_2, voice_url_duration_2),
        3: (voice_url_3, voice_url_start_3, voice_url_duration_3),
        4: (voice_url_4, voice_url_start_4, voice_url_duration_4),
    }
    specs: dict[int, dict[str, object]] = {}
    for slot, (url_value, start_value, duration_value) in raw_values.items():
        url = str(url_value or "").strip()
        if not url:
            continue
        specs[slot] = {
            "url": url,
            "start_seconds": _optional_float_form_value(start_value),
            "duration_seconds": _required_float_form_value(duration_value, f"voice_url_duration_{slot}"),
        }
    return specs


def _url_reference_audio_enabled(request: Request) -> bool:
    configured = str(os.getenv("MO_VIBEVOICE_URL_REFERENCE_ENABLED", "")).strip().lower()
    if configured in {"1", "true", "yes", "on"}:
        return True
    if configured in {"0", "false", "no", "off"}:
        return False
    return (request.url.hostname or "").lower() in {"localhost", "127.0.0.1", "::1"}


def _require_url_reference_audio(request: Request, url_references: dict[int, dict[str, object]]) -> None:
    if url_references and not _url_reference_audio_enabled(request):
        raise HTTPException(
            status_code=403,
            detail="URL参照音声取得はローカルFastAPIへのloopback接続でのみ利用できます。",
        )


def _reference_audio_tool_diagnostics(extractor: object) -> dict[str, object]:
    diagnostics = getattr(extractor, "diagnostics", None)
    if not callable(diagnostics):
        return {}
    try:
        value = diagnostics()
    except Exception as exc:
        return {"diagnostics_error": str(exc)}
    return value if isinstance(value, dict) else {}


async def _save_vibevoice_voice_uploads(
    uploads: list[UploadFile | None],
    directory: Path,
    *,
    url_references: dict[int, dict[str, object]] | None = None,
    reference_audio_extractor: MediaReferenceAudioExtractor | None = None,
) -> tuple[list[VibeVoiceVoiceSample], dict[str, object]]:
    voice_paths: list[VibeVoiceVoiceSample] = []
    url_reference_audio: list[dict[str, object]] = []
    for index, upload in enumerate(uploads, start=1):
        if upload is not None and upload.filename:
            voice_paths.append(
                VibeVoiceVoiceSample(
                    slot=index,
                    path=await _save_vibevoice_upload(upload, directory, f"voice-{index}"),
                )
            )
            continue
        url_reference = (url_references or {}).get(index)
        if url_reference is None:
            continue
        extractor = reference_audio_extractor or MediaReferenceAudioExtractor()
        clip = extractor.extract_from_url(
            str(url_reference["url"]),
            start_seconds=url_reference.get("start_seconds"),
            duration_seconds=float(url_reference["duration_seconds"]),
        )
        suffix = Path(clip.filename).suffix or ".wav"
        path = directory / f"voice-{index}{suffix}"
        path.write_bytes(clip.audio_bytes)
        voice_paths.append(VibeVoiceVoiceSample(slot=index, path=path))
        url_reference_audio.append(
            {
                "slot": index,
                "filename": clip.filename,
                "source_url": clip.source_url,
                "start_seconds": clip.start_seconds,
                "detected_start_seconds": clip.detected_start_seconds,
                "duration_seconds": clip.duration_seconds,
                "size_bytes": len(clip.audio_bytes),
            }
        )
    if not voice_paths:
        raise ValueError("voice sample is required")
    diagnostics: dict[str, object] = {}
    if url_reference_audio:
        diagnostics["url_reference_audio"] = url_reference_audio
    return voice_paths, diagnostics


def _vibevoice_generation_options(
    *,
    script_text: str,
    model_id: str,
    cfg_scale: str,
    inference_steps: str,
    seed: str,
    do_sample: str,
    temperature: str,
    top_p: str,
    top_k: str,
    max_voice_seconds: str,
    line_by_line: str,
    line_gap: str,
    directed_line_mode: str,
    directed_retry_low_score: str,
    directed_retry_score_threshold: str,
    directed_retry_max_lines: str,
    directed_retry_max_multiplier: str,
) -> VibeVoiceGenerationOptions:
    retry_max_lines = _directed_retry_max_lines_form_value(
        script_text=script_text,
        directed_retry_max_lines=directed_retry_max_lines,
        directed_retry_max_multiplier=directed_retry_max_multiplier,
    )
    return VibeVoiceGenerationOptions(
        model_id=model_id,
        cfg_scale=_float_form_value(cfg_scale, 1.3),
        inference_steps=max(1, _int_form_value(inference_steps, 10)),
        seed=_int_form_value(seed, 42),
        do_sample=_bool_form_value(do_sample, default=True),
        temperature=_float_form_value(temperature, 0.95),
        top_p=_float_form_value(top_p, 0.95),
        top_k=max(0, _int_form_value(top_k, 0)),
        max_voice_seconds=max(0.0, _float_form_value(max_voice_seconds, 5.0)),
        line_by_line=_bool_form_value(line_by_line, default=False),
        line_gap=max(0.0, _float_form_value(line_gap, 1.0)),
        directed_line_mode=_bool_form_value(directed_line_mode, default=True),
        directed_retry_low_score=_bool_form_value(directed_retry_low_score, default=True),
        directed_retry_score_threshold=max(0.0, min(1.0, _float_form_value(directed_retry_score_threshold, 0.65))),
        directed_retry_max_lines=retry_max_lines,
    )


def _directed_retry_max_lines_form_value(
    *,
    script_text: str,
    directed_retry_max_lines: str | None,
    directed_retry_max_multiplier: str | None,
) -> int:
    value = str(directed_retry_max_lines or "").strip()
    if value and value.lower() != "auto":
        return max(0, _int_form_value(value, 0))
    multiplier = _float_form_value(directed_retry_max_multiplier, 1.0)
    return directed_retry_max_lines_for_script(script_text, multiplier=multiplier)


def _select_vibevoice_generator(
    *,
    backend: str,
    options: VibeVoiceGenerationOptions,
    local_service: VibeVoiceGenerator,
    runpod_service: VibeVoiceGenerator,
) -> VibeVoiceGenerator:
    backend_id = normalize_vibevoice_backend(backend)
    validate_vibevoice_model_backend(options.model_id, backend_id)
    return runpod_service if backend_id == "runpod_serverless" else local_service


def _float_form_value(value: str | None, default: float) -> float:
    if value is None or str(value).strip() == "":
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _optional_float_form_value(value: str | None) -> float | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        return float(value)
    except ValueError as exc:
        raise ValueError("start_seconds must be a number") from exc


def _required_float_form_value(value: str | None, name: str) -> float:
    if value is None or str(value).strip() == "":
        raise ValueError(f"{name} is required")
    try:
        return float(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc


def _int_form_value(value: str | None, default: int) -> int:
    if value is None or str(value).strip() == "":
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _bool_form_value(value: str | None, *, default: bool) -> bool:
    if value is None or str(value).strip() == "":
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _practice_display_text(text: str, target_language: str, *, include_pinyin: bool = False) -> dict[str, str]:
    if target_language == "zh-CN":
        pinyin_text = _practice_pinyin_text(text) if include_pinyin else ""
        return {
            "mode": "plain",
            "primary_text": text,
            "secondary_text": "",
            "kanji_text": text,
            "hiragana_text": "",
            "pinyin_text": pinyin_text,
            "pinyin_status": "ready" if pinyin_text else ("unavailable" if include_pinyin else "disabled"),
        }
    if target_language != "ja-JP":
        return {
            "mode": "plain",
            "primary_text": text,
            "secondary_text": "",
            "kanji_text": text,
            "hiragana_text": "",
            "pinyin_text": "",
            "pinyin_status": "disabled",
        }
    try:
        display = create_user_display_text(text, target_language)
    except RuntimeError:
        display = {"kanji_text": text, "hiragana_text": ""}
    hiragana_text = str(display.get("hiragana_text") or "").strip()
    kanji_text = str(display.get("kanji_text") or text).strip()
    return {
        "mode": "hiragana" if hiragana_text else "plain",
        "primary_text": hiragana_text or kanji_text,
        "secondary_text": kanji_text if hiragana_text and hiragana_text != kanji_text else "",
        "kanji_text": kanji_text,
        "hiragana_text": hiragana_text,
        "pinyin_text": "",
        "pinyin_status": "disabled",
    }


def _practice_pinyin_text(text: str) -> str:
    local_text = _practice_pinyin_text_local(text)
    if local_text:
        return local_text
    return _practice_pinyin_text_openai(text)


def _practice_pinyin_text_local(text: str) -> str:
    if not _contains_han_text(text):
        return ""
    try:
        from pypinyin import Style, lazy_pinyin
    except ImportError:
        return ""

    tokens = lazy_pinyin(
        text,
        style=Style.TONE,
        neutral_tone_with_five=False,
        errors="ignore",
    )
    return _normalize_practice_pinyin_tokens(tokens)


def _contains_han_text(text: str) -> bool:
    return any(
        start <= ord(char) <= end
        for char in text
        for start, end in _HAN_CODEPOINT_RANGES
    )


def _normalize_practice_pinyin_tokens(tokens: list[str]) -> str:
    normalized_tokens: list[str] = []
    for token in tokens:
        normalized = _PINYIN_WHITESPACE_RE.sub(" ", str(token)).strip()
        normalized = normalized.strip(_PINYIN_OMITTED_PUNCTUATION)
        if not normalized:
            continue
        normalized_tokens.extend(part for part in normalized.split(" ") if part)
    return " ".join(normalized_tokens).strip()


def _practice_diff_comparable_text(text: str) -> str:
    """「聞こえた言葉」の文字単位diffが使う正規化と同じ結果を返す。

    フロント側 practiceDisplayComparableText (practice_playback.js) と同じ規則
    (NFKC正規化、Punctuation/Symbolカテゴリの除去、空白の圧縮)にする。ここで返す
    文字列のArray.from()した添字が、_practice_diff_pinyin_charsの返り値の添字と
    一致する前提でクライアント側が読む。
    """
    normalized = unicodedata.normalize("NFKC", str(text or ""))
    stripped = "".join(
        char for char in normalized if not unicodedata.category(char).startswith(("P", "S"))
    )
    return re.sub(r"\s+", " ", stripped).strip()


def _practice_diff_pinyin_chars(text: str) -> list[str]:
    """diff比較用の文字ごとの声調つきピンイン配列(非漢字は空文字列)を返す。

    連続する漢字は文脈付きでまとめて変換する。非漢字位置を空文字列として残し、
    Array.from(comparable text)と同じ長さ・同じ添字を保証する。
    """
    comparable = _practice_diff_comparable_text(text)
    if not comparable:
        return []
    try:
        from pypinyin import Style, lazy_pinyin
    except ImportError:
        return ["" for _ in comparable]
    result = ["" for _ in comparable]
    index = 0
    while index < len(comparable):
        if not _contains_han_text(comparable[index]):
            index += 1
            continue
        end = index + 1
        while end < len(comparable) and _contains_han_text(comparable[end]):
            end += 1
        tokens = lazy_pinyin(
            comparable[index:end],
            style=Style.TONE3,
            neutral_tone_with_five=True,
            errors="ignore",
        )
        if len(tokens) == end - index:
            result[index:end] = tokens
        index = end
    return result


def _supported_vibevoice_output_language(value: str | None) -> str:
    language = str(value or "zh-CN").strip()
    if language not in _VIBEVOICE_OUTPUT_LANGUAGES:
        raise ValueError(f"unsupported VibeVoice output language: {language}")
    return language


def _vibevoice_script_translation_model() -> str:
    return os.getenv(
        "OPENAI_VIBEVOICE_SCRIPT_TRANSLATION_MODEL",
        os.getenv("OPENAI_TRANSLATION_MODEL", "gpt-5.6-terra"),
    )


def _prepare_vibevoice_script_for_generation(
    *,
    script_text: str,
    output_language: str | None,
    translate_script: str | None,
) -> tuple[str, dict[str, object]]:
    language = _supported_vibevoice_output_language(output_language)
    auto = str(translate_script or "").strip().lower() == "auto"
    requested = auto or _bool_form_value(translate_script, default=False)
    diagnostics: dict[str, object] = {
        "script_translation": {
            "requested": requested,
            "enabled": False,
            "source_language": "auto" if auto else "ja-JP",
            "output_language": language,
            "output_language_label": _VIBEVOICE_OUTPUT_LANGUAGES[language]["label"],
            "source_script": script_text,
            "translated_script": script_text,
            "model": "",
            "provider": "",
        }
    }
    if not requested:
        return script_text, diagnostics

    model = _vibevoice_script_translation_model()
    translation_result = _openai_vibevoice_translate_script(script_text, language, model)
    source_language, translated_text = _parse_vibevoice_translation_result(translation_result)
    translated_script = _normalize_vibevoice_translated_script(translated_text)
    _validate_vibevoice_translated_script(script_text, translated_script)
    diagnostics["script_translation"].update(
        {
            "enabled": translated_script != script_text,
            "source_language": source_language,
            "translated_script": translated_script,
            "model": model,
            "provider": "openai-responses",
        }
    )
    return translated_script, diagnostics


def _openai_vibevoice_translate_script(script_text: str, output_language: str, model: str) -> str:
    if not os.getenv("OPENAI_API_KEY"):
        raise ValueError("OPENAI_API_KEY is required for VibeVoice script translation")
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise ValueError("openai package is required for VibeVoice script translation") from exc

    language_name = _VIBEVOICE_OUTPUT_LANGUAGES[output_language]["openai_name"]
    response = OpenAI().responses.create(
        model=model,
        instructions=(
            "Detect the dialogue language of this skit script. "
            f"If it is not {language_name}, translate only dialogue text into natural spoken {language_name}; "
            "if it is already the target language, return it unchanged. "
            "Preserve speaker tags exactly, preserve the number of non-empty lines, "
            "preserve line order, and return strict JSON with keys source_language and script. "
            "source_language must be a BCP 47 language code and script must contain the final script."
        ),
        input=script_text,
    )
    output_text = getattr(response, "output_text", None)
    if output_text is not None:
        return str(output_text)
    if hasattr(response, "model_dump"):
        try:
            dumped = response.model_dump()
            return _openai_response_text_from_dict(dumped)
        except Exception:
            pass
    return str(response)


def _parse_vibevoice_translation_result(value: object) -> tuple[str, str]:
    if isinstance(value, tuple) and len(value) == 2:
        return str(value[0]), str(value[1])
    text = _normalize_vibevoice_translated_script(str(value))
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return "auto", text
    if not isinstance(payload, dict) or not str(payload.get("script") or "").strip():
        raise ValueError("VibeVoice script translation returned invalid JSON")
    return str(payload.get("source_language") or "auto"), str(payload["script"])


def _openai_vibevoice_generate_script(seed_script: str) -> str:
    if not os.getenv("OPENAI_API_KEY"):
        raise ValueError("OPENAI_API_KEY is required for VibeVoice script generation")
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise ValueError("openai package is required for VibeVoice script generation") from exc
    response = OpenAI().responses.create(
        model=_vibevoice_script_translation_model(),
        instructions=(
            "Write a natural, friendly Japanese everyday conversation for speech synthesis. "
            "Return exactly five non-empty lines, alternating speakers 1, 2, 1, 2, 1. "
            "Every line must start with the speaker number and one space. Use only the script, with no title or notes."
        ),
        input=(
            "次の台本を着想元として、話題や状況を自然に連想・発展させて再構成してください。\n\n"
            + seed_script.strip()
            if seed_script.strip()
            else "短い日常会話を新規に作ってください。"
        ),
    )
    text = str(getattr(response, "output_text", "") or "")
    script = _normalize_vibevoice_translated_script(text)
    lines = [line for line in script.splitlines() if line.strip()]
    if len(lines) != 5 or [line.split(maxsplit=1)[0] for line in lines] != ["1", "2", "1", "2", "1"]:
        raise ValueError("AI script generation must return exactly five alternating speaker lines")
    return "\n".join(lines)


def _openai_response_text_from_dict(body: dict[str, object]) -> str:
    if isinstance(body.get("output_text"), str):
        return str(body["output_text"])
    chunks: list[str] = []
    output = body.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if not isinstance(content, list):
                continue
            for part in content:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    chunks.append(str(part["text"]))
    return "".join(chunks)


def _normalize_vibevoice_translated_script(text: str) -> str:
    translated = str(text or "").strip()
    if translated.startswith("```"):
        translated = re.sub(r"^```(?:text|txt)?", "", translated, flags=re.IGNORECASE).strip()
        translated = re.sub(r"```$", "", translated).strip()
    return "\n".join(line.rstrip() for line in translated.splitlines()).strip()


def _validate_vibevoice_translated_script(source_script: str, translated_script: str) -> None:
    if not translated_script.strip():
        raise ValueError("VibeVoice script translation returned empty text")
    source_lines = [line for line in source_script.splitlines() if line.strip()]
    translated_lines = [line for line in translated_script.splitlines() if line.strip()]
    if source_lines and len(source_lines) != len(translated_lines):
        raise ValueError(
            "VibeVoice script translation must preserve the number of non-empty lines: "
            f"source={len(source_lines)} translated={len(translated_lines)}"
        )


def _practice_pinyin_text_openai(text: str) -> str:
    if not os.getenv("OPENAI_API_KEY"):
        return ""
    try:
        from openai import OpenAI
    except ImportError:
        return ""

    try:
        response = OpenAI().responses.create(
            model=os.getenv("OPENAI_TEXT_DISPLAY_MODEL", os.getenv("OPENAI_TEXT_TRANSFORM_MODEL", "gpt-5.6-terra")),
            instructions=(
                "Convert this Simplified Chinese sentence to Hanyu Pinyin with tone marks. "
                "Return one pinyin syllable per Chinese character, separated by spaces. "
                "Omit punctuation, Latin letters, numbers, and notes."
            ),
            input=text,
        )
    except Exception as exc:
        LOGGER.warning("practice pinyin generation failed: %s", exc)
        return ""
    output_text = getattr(response, "output_text", None)
    return str(output_text if output_text is not None else response).strip()


def _is_practice_history_entry(entry: object) -> bool:
    metadata = getattr(entry, "metadata", None) or {}
    return str(metadata.get("endpoint") or "").startswith("practice-")


def _serialized_audio_history_entries(
    store: AudioHistoryStore,
    kind: str,
    *,
    practice: bool,
) -> list[dict[str, object]]:
    return [
        _serialize_audio_history_entry(kind, entry)
        for entry in store.list_entries(kind)
        if _is_practice_history_entry(entry) is practice
    ]


def create_app(
    pipeline: SpeechTranslationPipeline | None = None,
    openai_pipeline: SpeechTranslationPipeline | None = None,
    openai_realtime_pipeline=None,
    runpod_serverless_pipeline: SpeechTranslationPipeline | None = None,
    runpod_practice_asr_provider: RunpodServerlessPracticeAsrProvider | None = None,
    text_tts_providers: dict[str, object] | None = None,
    voice_conversion_service: VoiceConversionService | None = None,
    vibevoice_service: VibeVoiceService | None = None,
    runpod_vibevoice_service: VibeVoiceGenerator | None = None,
    reference_audio_extractor: MediaReferenceAudioExtractor | None = None,
    audio_history_store: AudioHistoryStore | None = None,
    user_settings_store: UserSettingsStore | None = None,
    public_sample_audio_store: PublicSampleAudioStore | None = None,
    practice_llm_service: PracticeLlmService | None = None,
) -> FastAPI:
    app = FastAPI(title="Voice Lab")

    @app.exception_handler(PracticeAlignmentError)
    async def practice_alignment_error_handler(
        _request: Request,
        error: PracticeAlignmentError,
    ) -> JSONResponse:
        return JSONResponse(status_code=502, content=_practice_alignment_error_envelope(error))

    @app.exception_handler(PracticeAlignmentInputError)
    async def practice_alignment_input_error_handler(
        _request: Request,
        error: PracticeAlignmentInputError,
    ) -> JSONResponse:
        return JSONResponse(status_code=400, content=_practice_alignment_error_envelope(error))

    @app.exception_handler(PracticeLlmError)
    async def practice_llm_error_handler(
        _request: Request,
        error: PracticeLlmError,
    ) -> JSONResponse:
        return JSONResponse(status_code=502, content=_practice_llm_error_envelope(error))

    active_pipeline = pipeline or create_pipeline_from_env()
    active_openai_pipeline = openai_pipeline or create_openai_pipeline()
    active_openai_realtime_pipeline = openai_realtime_pipeline or create_realtime_translation_pipeline()
    active_runpod_serverless_pipeline = runpod_serverless_pipeline or create_runpod_serverless_pipeline()
    active_runpod_practice_asr_provider = runpod_practice_asr_provider or RunpodServerlessPracticeAsrProvider()
    translation_pipelines = {
        "openai": active_openai_pipeline,
        "openai_realtime": active_openai_realtime_pipeline,
        "qwen": active_pipeline,
        "runpod_serverless": active_runpod_serverless_pipeline,
    }
    active_text_tts_providers = text_tts_providers or create_text_tts_providers()
    active_voice_conversion_service = voice_conversion_service or create_voice_conversion_service_from_env()
    active_practice_voice_conversion_service = voice_conversion_service or VoiceConversionService(
        providers=[RunpodServerlessVoiceConversionProvider()]
    )
    active_vibevoice_service = vibevoice_service or VibeVoiceService.from_env()
    active_runpod_vibevoice_service = runpod_vibevoice_service or RunpodServerlessVibeVoiceService.from_env()
    active_reference_audio_extractor = reference_audio_extractor or MediaReferenceAudioExtractor()
    active_audio_history_store = audio_history_store or AudioHistoryStore.from_env()
    active_user_settings_store = user_settings_store or UserSettingsStore.from_env()
    active_public_sample_audio_store = public_sample_audio_store or PublicSampleAudioStore.from_env()
    active_practice_llm_service = practice_llm_service or PracticeLlmService()
    practice_prompt_job_store = PracticeJobStore()
    practice_attempt_job_store = PracticeJobStore()
    practice_attempt_llm_options: dict[str, dict[str, object]] = {}
    practice_attempt_result_cache: dict[str, dict[str, object]] = {}
    practice_attempt_finalization_jobs: dict[str, dict[str, object]] = {}
    practice_attempt_finalization_lock = Lock()
    job_store = TranslationJobStore(translation_pipelines, active_audio_history_store)
    text_tts_job_store = TextToSpeechJobStore(active_text_tts_providers, active_audio_history_store)
    voice_conversion_job_store = VoiceConversionJobStore(active_voice_conversion_service, active_audio_history_store)
    practice_voice_conversion_job_store = VoiceConversionJobStore(
        active_practice_voice_conversion_service,
        active_audio_history_store,
    )
    vibevoice_job_store = VibeVoiceJobStore()
    if os.getenv("MO_PRELOAD_MODELS") == "1":
        active_pipeline.preload()
    if os.getenv("MO_PRELOAD_VOICE_CONVERSION") == "1" or os.getenv("MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START") == "1":
        active_voice_conversion_service.preload()
    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
    app.mount("/react", StaticFiles(directory=WEB_DIR / "react"), name="react")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(WEB_DIR / "react" / "portal.html")

    @app.get("/fun")
    @app.get("/fun/")
    def fun() -> FileResponse:
        return FileResponse(WEB_DIR / "user.html")

    @app.get("/speakloop")
    @app.get("/speakloop/")
    def practice() -> FileResponse:
        return FileResponse(WEB_DIR / "react" / "speakloop.html")

    @app.get("/privacy")
    @app.get("/privacy/")
    def privacy() -> FileResponse:
        return FileResponse(WEB_DIR / "react" / "privacy.html")

    @app.get("/speakloop/admin")
    @app.get("/speakloop/admin/")
    def practice_admin() -> FileResponse:
        return FileResponse(WEB_DIR / "practice_admin.html")

    @app.get("/skitvoice")
    @app.get("/skitvoice/")
    def skitvoice() -> FileResponse:
        return FileResponse(WEB_DIR / "react" / "skitvoice.html")

    @app.get("/skitvoice/admin")
    @app.get("/skitvoice/admin/")
    def vibevoice_admin() -> FileResponse:
        return FileResponse(WEB_DIR / "vibevoice.html")

    @app.get("/admin")
    def admin() -> FileResponse:
        return FileResponse(WEB_DIR / "index.html")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/runtime")
    def runtime() -> dict[str, object]:
        return {
            "provider_mode": os.getenv("MO_PROVIDER_MODE", "fake") or "fake",
            "providers": _provider_names(active_pipeline),
            "supported_voice_modes": _supported_voice_modes(active_pipeline),
            "translation_backends": _translation_backends(
                active_pipeline,
                active_openai_pipeline,
                active_openai_realtime_pipeline,
                active_runpod_serverless_pipeline,
            ),
            "text_tts_backends": text_tts_backend_statuses(active_text_tts_providers),
            "voice_conversion_backends": _voice_conversion_backends(active_voice_conversion_service),
        }

    @app.get("/api/vibevoice/status")
    def vibevoice_status(request: Request) -> dict[str, object]:
        local_status = active_vibevoice_service.status()
        return {
            **local_status,
            "url_reference_audio": {
                "enabled": _url_reference_audio_enabled(request),
                "scope": "loopback_or_explicit_override",
                "tools": _reference_audio_tool_diagnostics(active_reference_audio_extractor),
            },
            "backends": {
                "local": local_status,
                "runpod_serverless": active_runpod_vibevoice_service.status(),
            },
        }

    @app.post("/api/vibevoice/reference-audio-from-url")
    async def vibevoice_reference_audio_from_url(
        request: Request,
        url: Annotated[str, Form()] = "",
        start_seconds: Annotated[str | None, Form()] = None,
        duration_seconds: Annotated[str, Form()] = "5",
    ) -> dict[str, object]:
        _require_url_reference_audio(request, {1: {"url": url}} if str(url or "").strip() else {})
        try:
            clip = active_reference_audio_extractor.extract_from_url(
                url,
                start_seconds=_optional_float_form_value(start_seconds),
                duration_seconds=_required_float_form_value(duration_seconds, "duration_seconds"),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {
            "audio_mime_type": clip.audio_mime_type,
            "audio_base64": base64.b64encode(clip.audio_bytes).decode("ascii"),
            "filename": clip.filename,
            "source_url": clip.source_url,
            "start_seconds": clip.start_seconds,
            "detected_start_seconds": clip.detected_start_seconds,
            "duration_seconds": clip.duration_seconds,
        }

    @app.get("/api/user-settings")
    def user_settings() -> dict[str, object]:
        try:
            return serialize_user_settings(active_user_settings_store.read())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.put("/api/user-settings")
    def update_user_settings(payload: dict[str, object] = Body(...)) -> dict[str, object]:
        try:
            prepared_payload = prepare_user_settings_for_write(payload)
            return serialize_user_settings(active_user_settings_store.write(prepared_payload))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.get("/api/public-sample-audios")
    def public_sample_audios() -> dict[str, object]:
        return active_public_sample_audio_store.read()

    @app.put("/api/public-sample-audios")
    def update_public_sample_audios(payload: dict[str, object] = Body(...)) -> dict[str, object]:
        try:
            return active_public_sample_audio_store.write(payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(status_code=503, detail="サンプル音声を保存できませんでした") from exc

    @app.delete("/api/public-sample-audios/{feature}")
    def delete_public_sample_audio(feature: str, language: str = "") -> dict[str, object]:
        try:
            return active_public_sample_audio_store.delete(feature, language)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(status_code=503, detail="サンプル音声を削除できませんでした") from exc

    @app.post("/api/user-display-text")
    def user_display_text(payload: dict[str, str] = Body(...)) -> dict[str, str]:
        try:
            return create_user_display_text(
                str(payload.get("text", "")),
                str(payload.get("target_language", "ja-JP")),
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.post("/api/user-text-output")
    def user_text_output(payload: dict[str, object] = Body(...)) -> dict[str, object]:
        translated_text = str(payload.get("translated_text", "")).strip()
        target_language = str(payload.get("target_language", "ja-JP"))
        if translated_text == "":
            raise HTTPException(status_code=400, detail="translated_text is required")

        text_transform_options = payload.get("text_transform_options") or {}
        if not isinstance(text_transform_options, dict):
            raise HTTPException(status_code=400, detail="text_transform_options must be an object")

        try:
            transformed_text = apply_text_transform(
                translated_text,
                "user_effects" if text_transform_options else None,
                {**text_transform_options, "target_language": target_language},
            )
            tts_output = _normalize_tts_provider_output(
                active_openai_pipeline.tts.synthesize(transformed_text, target_language),
                active_openai_pipeline.tts.audio_mime_type,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

        result = PipelineResult(
            transcript=str(payload.get("transcript", "")),
            translated_text=translated_text,
            transformed_text=transformed_text,
            output_audio_bytes=tts_output.audio_bytes,
            output_audio_mime_type=tts_output.audio_mime_type or active_openai_pipeline.tts.audio_mime_type,
            timings_ms=tts_output.timings_ms,
            providers={
                "asr": "cached",
                "translation": "cached",
                "tts": active_openai_pipeline.tts.name,
            },
            warnings=tts_output.warnings,
            target_language=target_language,
        )
        active_audio_history_store.save_output(
            result.output_audio_bytes,
            suffix=_mime_suffix(result.output_audio_mime_type),
            metadata={
                "endpoint": "user-text-output",
                "translation_backend": "openai",
                "target_language": target_language,
                "voice_mode": "default",
                "audio_mime_type": result.output_audio_mime_type,
                **_history_text_metadata_from_pipeline_result(result),
            },
        )
        return _serialize_pipeline_result(result)

    @app.post("/api/user-joke-output")
    def user_joke_output(payload: dict[str, object] = Body(...)) -> dict[str, object]:
        text = str(payload.get("text", "")).strip()
        target_language = str(payload.get("target_language", "id-ID"))
        if text == "":
            raise HTTPException(status_code=400, detail="text is required")

        try:
            translated_text = active_openai_pipeline.translator.translate(text, "auto", target_language)
            tts_output = _normalize_tts_provider_output(
                active_openai_pipeline.tts.synthesize(translated_text, target_language),
                active_openai_pipeline.tts.audio_mime_type,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

        result = PipelineResult(
            transcript=text,
            translated_text=translated_text,
            transformed_text=translated_text,
            output_audio_bytes=tts_output.audio_bytes,
            output_audio_mime_type=tts_output.audio_mime_type or active_openai_pipeline.tts.audio_mime_type,
            timings_ms=tts_output.timings_ms,
            providers={
                "asr": "none",
                "translation": active_openai_pipeline.translator.name,
                "tts": active_openai_pipeline.tts.name,
            },
            warnings=tts_output.warnings,
            target_language=target_language,
        )
        active_audio_history_store.save_output(
            result.output_audio_bytes,
            suffix=_mime_suffix(result.output_audio_mime_type),
            metadata={
                "endpoint": "user-joke-output",
                "translation_backend": "openai",
                "target_language": target_language,
                "voice_mode": "default",
                "audio_mime_type": result.output_audio_mime_type,
                **_history_text_metadata_from_pipeline_result(result),
            },
        )
        return _serialize_pipeline_result(result)

    @app.post("/api/vibevoice/scripts")
    async def generate_vibevoice_script(request: Request) -> dict[str, str]:
        try:
            try:
                payload = await request.json()
            except Exception:
                payload = {}
            seed_script = str(payload.get("seed_script") or "") if isinstance(payload, dict) else ""
            if len(seed_script) > 5_000:
                raise ValueError("seed_script must be 5000 characters or fewer")
            return {"script": _openai_vibevoice_generate_script(seed_script)}
        except ValueError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.post("/api/vibevoice/generate")
    async def vibevoice_generate(
        request: Request,
        script: Annotated[str, Form()] = "",
        script_file: Annotated[UploadFile | None, File()] = None,
        voice_file_1: Annotated[UploadFile | None, File()] = None,
        voice_file_2: Annotated[UploadFile | None, File()] = None,
        voice_file_3: Annotated[UploadFile | None, File()] = None,
        voice_file_4: Annotated[UploadFile | None, File()] = None,
        voice_url_1: Annotated[str, Form()] = "",
        voice_url_start_1: Annotated[str | None, Form()] = None,
        voice_url_duration_1: Annotated[str, Form()] = "5",
        voice_url_2: Annotated[str, Form()] = "",
        voice_url_start_2: Annotated[str | None, Form()] = None,
        voice_url_duration_2: Annotated[str, Form()] = "5",
        voice_url_3: Annotated[str, Form()] = "",
        voice_url_start_3: Annotated[str | None, Form()] = None,
        voice_url_duration_3: Annotated[str, Form()] = "5",
        voice_url_4: Annotated[str, Form()] = "",
        voice_url_start_4: Annotated[str | None, Form()] = None,
        voice_url_duration_4: Annotated[str, Form()] = "5",
        cfg_scale: Annotated[str, Form()] = "1.3",
        inference_steps: Annotated[str, Form()] = "10",
        seed: Annotated[str, Form()] = "42",
        do_sample: Annotated[str, Form()] = "true",
        temperature: Annotated[str, Form()] = "0.95",
        top_p: Annotated[str, Form()] = "0.95",
        top_k: Annotated[str, Form()] = "0",
        max_voice_seconds: Annotated[str, Form()] = "5",
        line_by_line: Annotated[str, Form()] = "false",
        line_gap: Annotated[str, Form()] = "1",
        directed_line_mode: Annotated[str, Form()] = "true",
        directed_retry_low_score: Annotated[str, Form()] = "true",
        directed_retry_score_threshold: Annotated[str, Form()] = "0.65",
        directed_retry_max_lines: Annotated[str, Form()] = "auto",
        directed_retry_max_multiplier: Annotated[str, Form()] = "1",
        output_language: Annotated[str, Form()] = "zh-CN",
        translate_script: Annotated[str, Form()] = "false",
        backend: Annotated[str, Form()] = "local",
        model_id: Annotated[str, Form()] = "vibevoice-1.5b-pinned",
    ) -> dict[str, object]:
        try:
            script_text = await _read_vibevoice_script(script, script_file)
            script_text, script_diagnostics = _prepare_vibevoice_script_for_generation(
                script_text=script_text,
                output_language=output_language,
                translate_script=translate_script,
            )
            options = _vibevoice_generation_options(
                script_text=script_text,
                model_id=model_id,
                cfg_scale=cfg_scale,
                inference_steps=inference_steps,
                seed=seed,
                do_sample=do_sample,
                temperature=temperature,
                top_p=top_p,
                top_k=top_k,
                max_voice_seconds=max_voice_seconds,
                line_by_line=line_by_line,
                line_gap=line_gap,
                directed_line_mode=directed_line_mode,
                directed_retry_low_score=directed_retry_low_score,
                directed_retry_score_threshold=directed_retry_score_threshold,
                directed_retry_max_lines=directed_retry_max_lines,
                directed_retry_max_multiplier=directed_retry_max_multiplier,
            )
            url_references = _vibevoice_url_reference_specs(
                voice_url_1=voice_url_1,
                voice_url_start_1=voice_url_start_1,
                voice_url_duration_1=voice_url_duration_1,
                voice_url_2=voice_url_2,
                voice_url_start_2=voice_url_start_2,
                voice_url_duration_2=voice_url_duration_2,
                voice_url_3=voice_url_3,
                voice_url_start_3=voice_url_start_3,
                voice_url_duration_3=voice_url_duration_3,
                voice_url_4=voice_url_4,
                voice_url_start_4=voice_url_start_4,
                voice_url_duration_4=voice_url_duration_4,
            )
            _require_url_reference_audio(request, url_references)
            with TemporaryDirectory(prefix="mo-vibevoice-api-") as temp_dir:
                voice_paths, voice_diagnostics = await _save_vibevoice_voice_uploads(
                    [voice_file_1, voice_file_2, voice_file_3, voice_file_4],
                    Path(temp_dir),
                    url_references=url_references,
                    reference_audio_extractor=active_reference_audio_extractor,
                )
                generator = _select_vibevoice_generator(
                    backend=backend,
                    options=options,
                    local_service=active_vibevoice_service,
                    runpod_service=active_runpod_vibevoice_service,
                )
                vibevoice_result = generator.generate(
                    script_text=script_text,
                    voice_paths=voice_paths,
                    options=options,
                )
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except VibeVoiceError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        diagnostics = dict(vibevoice_result.diagnostics)
        diagnostics.update(script_diagnostics)
        diagnostics.update(voice_diagnostics)
        return {
            "audio_mime_type": vibevoice_result.audio_mime_type,
            "audio_base64": base64.b64encode(vibevoice_result.audio_bytes).decode("ascii"),
            "normalized_script": vibevoice_result.normalized_script,
            "providers": vibevoice_result.providers,
            "timings_ms": vibevoice_result.timings_ms,
            "diagnostics": diagnostics,
            "artifacts": list(getattr(vibevoice_result, "artifacts", [])),
        }

    @app.post("/api/vibevoice/jobs")
    async def create_vibevoice_job(
        request: Request,
        script: Annotated[str, Form()] = "",
        script_file: Annotated[UploadFile | None, File()] = None,
        voice_file_1: Annotated[UploadFile | None, File()] = None,
        voice_file_2: Annotated[UploadFile | None, File()] = None,
        voice_file_3: Annotated[UploadFile | None, File()] = None,
        voice_file_4: Annotated[UploadFile | None, File()] = None,
        voice_url_1: Annotated[str, Form()] = "",
        voice_url_start_1: Annotated[str | None, Form()] = None,
        voice_url_duration_1: Annotated[str, Form()] = "5",
        voice_url_2: Annotated[str, Form()] = "",
        voice_url_start_2: Annotated[str | None, Form()] = None,
        voice_url_duration_2: Annotated[str, Form()] = "5",
        voice_url_3: Annotated[str, Form()] = "",
        voice_url_start_3: Annotated[str | None, Form()] = None,
        voice_url_duration_3: Annotated[str, Form()] = "5",
        voice_url_4: Annotated[str, Form()] = "",
        voice_url_start_4: Annotated[str | None, Form()] = None,
        voice_url_duration_4: Annotated[str, Form()] = "5",
        cfg_scale: Annotated[str, Form()] = "1.3",
        inference_steps: Annotated[str, Form()] = "10",
        seed: Annotated[str, Form()] = "42",
        do_sample: Annotated[str, Form()] = "true",
        temperature: Annotated[str, Form()] = "0.95",
        top_p: Annotated[str, Form()] = "0.95",
        top_k: Annotated[str, Form()] = "0",
        max_voice_seconds: Annotated[str, Form()] = "5",
        line_by_line: Annotated[str, Form()] = "false",
        line_gap: Annotated[str, Form()] = "1",
        directed_line_mode: Annotated[str, Form()] = "true",
        directed_retry_low_score: Annotated[str, Form()] = "true",
        directed_retry_score_threshold: Annotated[str, Form()] = "0.65",
        directed_retry_max_lines: Annotated[str, Form()] = "auto",
        directed_retry_max_multiplier: Annotated[str, Form()] = "1",
        output_language: Annotated[str, Form()] = "zh-CN",
        translate_script: Annotated[str, Form()] = "false",
        backend: Annotated[str, Form()] = "local",
        model_id: Annotated[str, Form()] = "vibevoice-1.5b-pinned",
    ) -> dict[str, object]:
        temp_dir = Path(mkdtemp(prefix="mo-vibevoice-job-"))
        try:
            script_text = await _read_vibevoice_script(script, script_file)
            script_text, script_diagnostics = _prepare_vibevoice_script_for_generation(
                script_text=script_text,
                output_language=output_language,
                translate_script=translate_script,
            )
            options = _vibevoice_generation_options(
                script_text=script_text,
                model_id=model_id,
                cfg_scale=cfg_scale,
                inference_steps=inference_steps,
                seed=seed,
                do_sample=do_sample,
                temperature=temperature,
                top_p=top_p,
                top_k=top_k,
                max_voice_seconds=max_voice_seconds,
                line_by_line=line_by_line,
                line_gap=line_gap,
                directed_line_mode=directed_line_mode,
                directed_retry_low_score=directed_retry_low_score,
                directed_retry_score_threshold=directed_retry_score_threshold,
                directed_retry_max_lines=directed_retry_max_lines,
                directed_retry_max_multiplier=directed_retry_max_multiplier,
            )
            url_references = _vibevoice_url_reference_specs(
                voice_url_1=voice_url_1,
                voice_url_start_1=voice_url_start_1,
                voice_url_duration_1=voice_url_duration_1,
                voice_url_2=voice_url_2,
                voice_url_start_2=voice_url_start_2,
                voice_url_duration_2=voice_url_duration_2,
                voice_url_3=voice_url_3,
                voice_url_start_3=voice_url_start_3,
                voice_url_duration_3=voice_url_duration_3,
                voice_url_4=voice_url_4,
                voice_url_start_4=voice_url_start_4,
                voice_url_duration_4=voice_url_duration_4,
            )
            _require_url_reference_audio(request, url_references)
            voice_paths, voice_diagnostics = await _save_vibevoice_voice_uploads(
                [voice_file_1, voice_file_2, voice_file_3, voice_file_4],
                temp_dir,
                url_references=url_references,
                reference_audio_extractor=active_reference_audio_extractor,
            )
            generator = _select_vibevoice_generator(
                backend=backend,
                options=options,
                local_service=active_vibevoice_service,
                runpod_service=active_runpod_vibevoice_service,
            )
            return vibevoice_job_store.start(
                generator=generator,
                script_text=script_text,
                voice_paths=voice_paths,
                options=options,
                temp_dir=temp_dir,
                result_diagnostics={**script_diagnostics, **voice_diagnostics},
            )
        except (ValueError, FileNotFoundError) as exc:
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.get("/api/vibevoice/jobs/{job_id}")
    def get_vibevoice_job(job_id: str) -> dict[str, object]:
        try:
            return vibevoice_job_store.snapshot(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="job not found") from exc

    @app.post("/api/vibevoice/jobs/{job_id}/cancel")
    def cancel_vibevoice_job(job_id: str) -> dict[str, object]:
        try:
            return vibevoice_job_store.cancel(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="job not found") from exc

    def _create_practice_prompt_result(
        *,
        audio_bytes: bytes,
        filename: str,
        practice_target_language: str,
        include_pinyin: bool,
        practice_asr_model: str,
        precomputed_asr_result: AsrTranscription | None = None,
        precomputed_asr_ms: float | None = None,
        progress_callback=None,
    ) -> dict[str, object]:
        timings_ms: dict[str, float] = {}
        total_started = perf_counter()
        used_precomputed_asr = precomputed_asr_result is not None
        asr_provider = _practice_asr_provider(active_openai_pipeline, practice_asr_model)
        asr_provider_name, asr_model_name = _practice_stage_identity(
            asr_provider,
            fallback_model=practice_asr_model,
        )
        translation_provider_name, translation_model_name = _practice_stage_identity(
            active_openai_pipeline.translator
        )
        tts_provider_name, tts_model_name = _practice_stage_identity(active_openai_pipeline.tts)
        with NamedTemporaryFile(suffix=_upload_suffix(filename)) as temp_audio:
            temp_audio.write(audio_bytes)
            temp_audio.flush()
            try:
                if precomputed_asr_result is None:
                    if progress_callback is not None:
                        progress_callback(
                            stage="transcribing_prompt",
                            label="録音を文字にしています",
                            provider=asr_provider_name,
                            model=asr_model_name,
                        )
                    started = perf_counter()
                    asr_result = _transcribe_practice_audio(asr_provider, Path(temp_audio.name), "auto")
                    timings_ms["asr"] = _elapsed_ms(started)
                else:
                    asr_result = precomputed_asr_result
                    timings_ms["asr"] = float(precomputed_asr_ms or 0.0)
                transcript = asr_result.text

                if progress_callback is not None:
                    progress_callback(
                        stage="translating_prompt",
                        label="学習言語へ翻訳しています",
                        provider=translation_provider_name,
                        model=translation_model_name,
                    )
                started = perf_counter()
                target_text = active_openai_pipeline.translator.translate(
                    transcript,
                    "auto",
                    practice_target_language,
                )
                if practice_target_language == "zh-CN":
                    target_text = simplify_chinese_text(target_text)
                timings_ms["translation"] = _elapsed_ms(started)

                if progress_callback is not None:
                    progress_callback(
                        stage="synthesizing_prompt",
                        label="お手本音声を作っています",
                        provider=tts_provider_name,
                        model=tts_model_name,
                    )
                started = perf_counter()
                tts_output = _normalize_tts_provider_output(
                    active_openai_pipeline.tts.synthesize(target_text, practice_target_language),
                    active_openai_pipeline.tts.audio_mime_type,
                )
                timings_ms.update(tts_output.timings_ms)
                timings_ms.setdefault("tts", _elapsed_ms(started))
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except RuntimeError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc

        timings_ms["total"] = _elapsed_ms(total_started) + (
            timings_ms["asr"] if used_precomputed_asr else 0.0
        )
        asr_timestamps = _serialize_asr_timestamps(asr_result)
        result = {
            "transcript": transcript,
            "target_text": target_text,
            "translated_text": target_text,
            "transformed_text": target_text,
            "target_language": practice_target_language,
            "target_language_label": PRACTICE_TARGET_LANGUAGES[practice_target_language]["label"],
            "display_text": _practice_display_text(
                target_text,
                practice_target_language,
                include_pinyin=include_pinyin,
            ),
            "audio_mime_type": tts_output.audio_mime_type or active_openai_pipeline.tts.audio_mime_type,
            "audio_base64": base64.b64encode(tts_output.audio_bytes).decode(),
            "timings_ms": timings_ms,
            "asr_model": practice_asr_model,
            "asr_timestamps": asr_timestamps,
            "providers": {
                "asr": asr_provider.name,
                "translation": active_openai_pipeline.translator.name,
                "tts": active_openai_pipeline.tts.name,
            },
        }
        active_audio_history_store.save_output(
            tts_output.audio_bytes,
            suffix=_mime_suffix(result["audio_mime_type"]),
            metadata={
                "endpoint": "practice-prompts",
                "translation_backend": "openai",
                "target_language": practice_target_language,
                "asr_model": practice_asr_model,
                "audio_mime_type": result["audio_mime_type"],
                "transcript_preview": transcript[:80],
                "translated_text_preview": target_text[:80],
                "tts_text": target_text,
                "text_preview": target_text[:80],
            },
        )
        return result

    def _start_practice_voice_conversion_job(
        *,
        source_audio_bytes: bytes,
        source_audio_mime_type: str,
        reference_audio_bytes: bytes,
        reference_audio_filename: str,
    ) -> dict[str, object]:
        audio_paths: list[Path] = []
        try:
            with NamedTemporaryFile(suffix=_mime_suffix(source_audio_mime_type), delete=False) as temp_source:
                temp_source.write(source_audio_bytes)
                temp_source.flush()
                source_audio_path = Path(temp_source.name)
            audio_paths.append(source_audio_path)
            with NamedTemporaryFile(suffix=_upload_suffix(reference_audio_filename), delete=False) as temp_reference:
                temp_reference.write(reference_audio_bytes)
                temp_reference.flush()
                reference_audio_path = Path(temp_reference.name)
            audio_paths.append(reference_audio_path)
            request = VoiceConversionRequest(
                source_audio_path=source_audio_path,
                reference_audio_path=reference_audio_path,
                backend_id="seed-vc",
                seed_vc_settings=_create_seed_vc_settings(
                    diffusion_steps=None,
                    length_adjust=1.0,
                    inference_cfg_rate=0.7,
                    reference_max_seconds=10.0,
                    reference_auto_select=True,
                ),
            )
            return practice_voice_conversion_job_store.start(request, audio_paths)
        except Exception:
            for audio_path in audio_paths:
                audio_path.unlink(missing_ok=True)
            raise

    def _create_practice_attempt_result_from_transcriptions(
        *,
        practice_target_language: str,
        target_text: str,
        attempt_transcription: AsrTranscription,
        attempt_provider_name: str,
        attempt_asr_ms: float,
        model_transcription: AsrTranscription | None = None,
        model_provider_name: str = "",
        model_asr_ms: float = 0.0,
        comparison_model: str = "",
        playback_padding_seconds: float = 0.1,
        reference_audio_duration: float = 0.0,
        attempt_audio_duration: float = 0.0,
    ) -> dict[str, object]:
        if practice_target_language == "zh-CN":
            target_text = simplify_chinese_text(target_text)
        recognized_text = attempt_transcription.text
        model_recognized_text = model_transcription.text if model_transcription is not None else ""
        if practice_target_language == "zh-CN":
            recognized_text = simplify_chinese_text(recognized_text)
            model_recognized_text = simplify_chinese_text(model_recognized_text)

        asr_timestamps = _serialize_asr_timestamps(attempt_transcription)
        model_asr_timestamps = (
            _serialize_asr_timestamps(model_transcription)
            if model_transcription is not None
            else {"available": False, "model": "", "timestamp_granularities": [], "words": [], "segments": []}
        )
        compare_started = perf_counter()
        if model_transcription is None:
            raise PracticeLlmError("reference ASR is missing", stage="prepare_input")
        reference_no_speech = (
            not model_recognized_text.strip()
            and not model_asr_timestamps.get("words")
            and not model_asr_timestamps.get("segments")
        )
        if reference_no_speech:
            raise PracticeAlignmentError("empty_reference_asr", stage="reference_asr")
        no_speech = (
            not recognized_text.strip()
            and not asr_timestamps.get("words")
            and not asr_timestamps.get("segments")
        )
        if no_speech:
            compare_ms = _elapsed_ms(compare_started)
            return {
                "recording_kind": "attempt",
                "target_language": practice_target_language,
                "target_text": target_text,
                "recognized_text": recognized_text,
                "model_recognized_text": model_recognized_text,
                "asr_model": attempt_transcription.model,
                "asr_timestamps": asr_timestamps,
                "model_asr_timestamps": model_asr_timestamps,
                "outcome": "no_speech",
                "message": "音声を検出できませんでした。もう一度録音してください。",
                "comparison_alignment": None,
                "model_comparison_alignment": None,
                "comparison_model": comparison_model,
                "playback_padding_seconds": playback_padding_seconds,
                "timings_ms": {
                    "asr": attempt_asr_ms,
                    "model_asr": model_asr_ms,
                    "compare": compare_ms,
                    "total": attempt_asr_ms + model_asr_ms + compare_ms,
                },
                "providers": {
                    "asr": attempt_provider_name,
                    "model_asr": model_provider_name or attempt_provider_name,
                    "comparison": "openai-responses",
                },
            }
        llm_input = build_practice_llm_input(
            target_language=practice_target_language,
            target_text=target_text,
            padding_seconds=playback_padding_seconds,
            reference_audio_duration=reference_audio_duration,
            attempt_audio_duration=attempt_audio_duration,
            reference_asr={
                "recognized_text": model_recognized_text,
                "model": model_transcription.model,
                "words": model_asr_timestamps["words"],
            },
            attempt_asr={
                "recognized_text": recognized_text,
                "model": attempt_transcription.model,
                "words": asr_timestamps["words"],
            },
        )
        evaluated = active_practice_llm_service.evaluate(
            model=comparison_model,
            input_payload=llm_input,
        )
        comparison_alignment, model_comparison_alignment = (
            comparison_alignments_from_llm_result(evaluated.result)
        )
        compare_ms = _elapsed_ms(compare_started)
        comparison_target_pinyin = (
            _practice_diff_pinyin_chars(target_text) if practice_target_language == "zh-CN" else []
        )
        comparison_recognized_pinyin = (
            _practice_diff_pinyin_chars(recognized_text) if practice_target_language == "zh-CN" else []
        )
        return {
            "recording_kind": "attempt",
            "target_language": practice_target_language,
            "target_text": target_text,
            "recognized_text": recognized_text,
            "model_recognized_text": model_recognized_text,
            "asr_model": attempt_transcription.model,
            "asr_timestamps": asr_timestamps,
            "model_asr_timestamps": model_asr_timestamps,
            "outcome": "evaluated",
            "overall_score": evaluated.result["overall_score"],
            "overall_comment": evaluated.result["overall_comment"],
            "llm_comparison": evaluated.result,
            "comparison_alignment": comparison_alignment,
            "model_comparison_alignment": model_comparison_alignment,
            "comparison_target_pinyin": comparison_target_pinyin,
            "comparison_recognized_pinyin": comparison_recognized_pinyin,
            "comparison_model": comparison_model,
            "playback_padding_seconds": playback_padding_seconds,
            "llm_usage": evaluated.usage,
            "llm_estimated_cost_usd": evaluated.estimated_cost_usd,
            "timings_ms": {
                "asr": attempt_asr_ms,
                "model_asr": model_asr_ms,
                "compare": compare_ms,
                "total": attempt_asr_ms + model_asr_ms + compare_ms,
            },
            "providers": {
                "asr": attempt_provider_name,
                "model_asr": model_provider_name or attempt_provider_name,
                "comparison": "openai-responses",
            },
        }

    def _practice_attempt_job_snapshot(
        body: dict[str, object],
        *,
        health: object | None = None,
        llm_options: dict[str, object] | None = None,
    ) -> dict[str, object]:
        job_id = str(body.get("id") or body.get("job_id") or "")
        status = str(body.get("status") or "").upper()
        metrics = _runpod_practice_metrics(body)
        stages = [
            {"stage": "gpu_wait", "label": "GPU待機", "provider": "RunPod Serverless", "model": "funasr/paraformer-zh"},
            {"stage": "loading_model", "label": "モデル読込", "provider": "RunPod Serverless", "model": "funasr/paraformer-zh"},
            {"stage": "transcribing_model", "label": "お手本解析", "provider": "RunPod Serverless", "model": "funasr/paraformer-zh"},
            {"stage": "transcribing_attempt", "label": "録音解析", "provider": "RunPod Serverless", "model": "funasr/paraformer-zh"},
            {"stage": "finalizing", "label": "比較準備", "provider": "Voice Lab", "model": "funasr/paraformer-zh"},
        ]
        if status == "COMPLETED":
            # このjob_idが既に確定済みなら、再ポーリングのたびにLLM比較を再実行して
            # 二重課金・スコアの揺れが起きないよう、確定済みsnapshotをそのまま返す。
            cached_snapshot = practice_attempt_result_cache.get(job_id)
            if cached_snapshot is not None:
                return cached_snapshot
            output = body.get("output")
            if not isinstance(output, dict):
                return {
                    "job_id": job_id,
                    "status": "failed",
                    "current_stage": {"stage": "failed", "label": "処理に失敗しました", "provider": "RunPod Serverless", "model": "funasr/paraformer-zh"},
                    "stages": stages,
                    "metrics": metrics,
                    "result": None,
                    "error": "RunPod job completed without an output object",
                }
            try:
                contract_version = int(output.get("practice_asr_contract_version") or 0)
            except (TypeError, ValueError):
                contract_version = 0
            if contract_version < 2:
                error = (
                    "RunPod imageがpractice ASR contract v2に対応していません。"
                    "現在のRunPod imageを再デプロイしてください。"
                )
                return {
                    "job_id": job_id,
                    "status": "failed",
                    "current_stage": {"stage": "failed", "label": "RunPod imageの更新が必要です", "provider": "RunPod Serverless", "model": "funasr/paraformer-zh", "detail": error},
                    "stages": stages,
                    "metrics": metrics,
                    "result": None,
                    "error": error,
                }
            model_payload = output.get("model_transcription")
            cached_model_transcription = (llm_options or {}).get("cached_model_transcription")
            if isinstance(model_payload, dict):
                model_transcription = _asr_transcription_from_runpod_output(model_payload)
                model_audio_cache_key = (llm_options or {}).get("model_audio_cache_key")
                if isinstance(model_audio_cache_key, str) and model_audio_cache_key:
                    with _practice_model_asr_cache_lock:
                        _practice_model_asr_cache[model_audio_cache_key] = model_transcription
                        _practice_model_asr_cache.move_to_end(model_audio_cache_key)
                        while len(_practice_model_asr_cache) > _PRACTICE_MODEL_ASR_CACHE_MAX_ENTRIES:
                            _practice_model_asr_cache.popitem(last=False)
            elif isinstance(cached_model_transcription, AsrTranscription):
                # このjobはお手本音声のASRキャッシュがあったため、submit_comparison_job呼び出し時に
                # model_audio_base64を送らずRunPod側のFunASR推論を省略した(_transcribe_practice_model_audio
                # と同じ意図のキャッシュ)。RunPod出力にmodel_transcriptionが無いのは想定どおりであり、
                # 送信前に確定していたキャッシュ済みの結果をそのまま使う。
                model_transcription = cached_model_transcription
            else:
                return {
                    "job_id": job_id,
                    "status": "failed",
                    "current_stage": {"stage": "failed", "label": "お手本音声の解析結果がありません", "provider": "RunPod Serverless", "model": "funasr/paraformer-zh"},
                    "stages": stages,
                    "metrics": metrics,
                    "result": None,
                    "error": "RunPod practice job did not return model_transcription",
                }
            attempt_transcription = _asr_transcription_from_runpod_output(output)
            providers = output.get("providers") if isinstance(output.get("providers"), dict) else {}
            provider_name = str(providers.get("asr") or active_runpod_practice_asr_provider.name)
            timings = output.get("timings_ms") if isinstance(output.get("timings_ms"), dict) else {}
            # 提出時点(RunPodがまだ結果を返す前)のffprobe計測がffprobe不在等で失敗すると
            # audio_durationは0.0のまま保存される。0.0のままLLM検証(playback_end =
            # min(duration, end+padding))へ渡すと、有効な単語範囲でもplayback_endが0に
            # なり誤って失敗扱いになるため、その場合はRunPodが返した単語の最終end時刻を
            # 音声長の代わりに使う。
            reference_audio_duration = float((llm_options or {}).get("reference_audio_duration") or 0.0)
            if reference_audio_duration <= 0:
                reference_audio_duration = audio_duration_from_asr_words(model_transcription.words)
            attempt_audio_duration = float((llm_options or {}).get("attempt_audio_duration") or 0.0)
            if attempt_audio_duration <= 0:
                attempt_audio_duration = audio_duration_from_asr_words(attempt_transcription.words)
            try:
                result = _create_practice_attempt_result_from_transcriptions(
                    practice_target_language="zh-CN",
                    target_text=str(output.get("target_text") or ""),
                    attempt_transcription=attempt_transcription,
                    attempt_provider_name=provider_name,
                    attempt_asr_ms=float(timings.get("asr") or 0.0),
                    model_transcription=model_transcription,
                    model_provider_name=provider_name,
                    model_asr_ms=float(timings.get("model_asr") or 0.0),
                    comparison_model=str((llm_options or {}).get("comparison_model") or ""),
                    playback_padding_seconds=float(
                        (llm_options or {}).get("playback_padding_seconds") or 0.1
                    ),
                    reference_audio_duration=reference_audio_duration,
                    attempt_audio_duration=attempt_audio_duration,
                )
            except (PracticeAlignmentError, PracticeLlmError) as error:
                if isinstance(error, PracticeLlmError):
                    snapshot = {
                        "job_id": job_id,
                        "status": "failed",
                        "current_stage": {
                            "stage": "failed",
                            "label": PRACTICE_COMPARISON_ERROR_MESSAGE,
                            "provider": "OpenAI",
                            "model": str((llm_options or {}).get("comparison_model") or ""),
                        },
                        "stages": stages,
                        "metrics": metrics,
                        "result": None,
                        **_practice_llm_error_envelope(error),
                    }
                else:
                    snapshot = {
                        "job_id": job_id,
                        "status": "failed",
                        "current_stage": {
                            "stage": "failed",
                            "label": "音声の解析結果を確認できませんでした",
                            "provider": "Voice Lab",
                            "model": attempt_transcription.model,
                            "detail": "もう一度お試しください。",
                        },
                        "stages": stages,
                        "metrics": metrics,
                        "result": None,
                        **_practice_alignment_error_envelope(error),
                    }
                if job_id:
                    practice_attempt_result_cache[job_id] = snapshot
                return snapshot
            snapshot = {
                "job_id": job_id,
                "status": "succeeded",
                "current_stage": {"stage": "complete", "label": "比較準備が完了しました", "provider": "Voice Lab", "model": attempt_transcription.model},
                "stages": [*stages, {"stage": "complete", "label": "完了", "provider": "Voice Lab", "model": attempt_transcription.model}],
                "metrics": metrics,
                "result": result,
                "error": None,
            }
            if job_id:
                practice_attempt_result_cache[job_id] = snapshot
            return snapshot
        if status in {"FAILED", "CANCELLED", "TIMED_OUT"}:
            error = _runpod_practice_error_message(body)
            return {
                "job_id": job_id,
                "status": "failed",
                "current_stage": {"stage": "failed", "label": "処理に失敗しました", "provider": "RunPod Serverless", "model": "funasr/paraformer-zh", "detail": error},
                "stages": stages,
                "metrics": metrics,
                "result": None,
                "error": error,
            }
        queued = status in {"", "IN_QUEUE", "QUEUED"}
        return {
            "job_id": job_id,
            "status": "queued" if queued else "running",
            "current_stage": _runpod_practice_stage(body, health),
            "stages": stages,
            "metrics": metrics,
            "result": None,
            "error": None,
        }

    @app.post("/api/practice/attempt-jobs")
    async def create_practice_attempt_job(
        response: Response,
        audio: Annotated[UploadFile, File()],
        model_audio: Annotated[UploadFile, File()],
        target_language: Annotated[str, Form()] = "en-US",
        target_text: Annotated[str, Form()] = "",
        asr_model: Annotated[str, Form()] = "whisper-1",
        comparison_model: Annotated[str, Form()] = "",
        playback_padding_seconds: Annotated[str, Form()] = "",
        progress_mode: Annotated[str, Form()] = "",
    ) -> dict[str, object]:
        try:
            practice_target_language = supported_practice_target_language(target_language)
        except ValueError as exc:
            raise PracticeAlignmentInputError("unsupported_target_language") from exc
        try:
            practice_asr_model = supported_openai_practice_asr_model(asr_model)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        normalized_target_text = str(target_text or "").strip()
        validate_practice_alignment_target(normalized_target_text, practice_target_language)
        if practice_target_language != "zh-CN" and practice_asr_model not in OPENAI_TIMESTAMP_ASR_MODELS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"asr_model '{practice_asr_model}' does not return word timestamps, "
                    "which the LLM comparison requires; use whisper-1 for comparison_model requests"
                ),
            )
        try:
            selected_comparison_model = supported_practice_comparison_model(comparison_model)
            selected_playback_padding = validate_playback_padding_seconds(playback_padding_seconds)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        attempt_audio_bytes = await audio.read()
        model_audio_bytes = await model_audio.read()
        if not attempt_audio_bytes:
            raise HTTPException(status_code=400, detail="audio is empty")
        if not model_audio_bytes:
            raise HTTPException(status_code=400, detail="model_audio is empty")
        recording_entry = _save_audio_history_recording(
            active_audio_history_store,
            attempt_audio_bytes,
            suffix=_upload_suffix(audio.filename),
            metadata={
                "endpoint": "practice-attempt-jobs",
                "recording_intent": "attempt",
                "target_language": practice_target_language,
                "asr_model": practice_asr_model,
                "current_target_text_preview": normalized_target_text[:80],
                "filename": audio.filename or "",
                "content_type": audio.content_type or "",
            },
        )

        if practice_target_language == "zh-CN":
            try:
                with NamedTemporaryFile(suffix=_upload_suffix(audio.filename)) as attempt_temp_audio, NamedTemporaryFile(
                    suffix=_upload_suffix(model_audio.filename)
                ) as model_temp_audio:
                    attempt_temp_audio.write(attempt_audio_bytes)
                    attempt_temp_audio.flush()
                    model_temp_audio.write(model_audio_bytes)
                    model_temp_audio.flush()
                    attempt_audio_duration = probe_audio_duration_seconds(
                        Path(attempt_temp_audio.name),
                        fallback_words=[],
                    )
                    reference_audio_duration = probe_audio_duration_seconds(
                        Path(model_temp_audio.name),
                        fallback_words=[],
                    )
                    model_audio_cache_key = _practice_model_asr_cache_key(
                        model_audio_bytes,
                        practice_target_language,
                        active_runpod_practice_asr_provider,
                    )
                    with _practice_model_asr_cache_lock:
                        cached_model_transcription = _practice_model_asr_cache.get(model_audio_cache_key)
                        if cached_model_transcription is not None:
                            _practice_model_asr_cache.move_to_end(model_audio_cache_key)
                    reuse_cached_model_transcription = (
                        cached_model_transcription is not None and recording_entry is not None
                    )
                    body = active_runpod_practice_asr_provider.submit_comparison_job(
                        attempt_audio_path=Path(attempt_temp_audio.name),
                        model_audio_path=(
                            None if reuse_cached_model_transcription else Path(model_temp_audio.name)
                        ),
                        source_language=practice_target_language,
                        target_text=simplify_chinese_text(normalized_target_text),
                    )
                try:
                    health = active_runpod_practice_asr_provider.health()
                except RuntimeError:
                    health = None
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except RuntimeError as exc:
                raise HTTPException(status_code=503, detail=_runpod_practice_error_message({"error": str(exc)})) from exc
            job_id = str(body.get("id") or body.get("job_id") or "")
            llm_options = {
                "comparison_model": selected_comparison_model,
                "playback_padding_seconds": selected_playback_padding,
                "reference_audio_duration": reference_audio_duration,
                "attempt_audio_duration": attempt_audio_duration,
                "progress_mode": progress_mode,
                "model_audio_cache_key": model_audio_cache_key,
                "cached_model_transcription": (
                    cached_model_transcription if reuse_cached_model_transcription else None
                ),
            }
            if job_id:
                practice_attempt_llm_options[job_id] = llm_options
            snapshot = _practice_attempt_job_snapshot(
                body,
                health=health,
                llm_options=llm_options,
            )
            _update_practice_attempt_history(active_audio_history_store, recording_entry, snapshot)
            if job_id:
                active_audio_history_store.update_metadata(
                    recording_entry,
                    {
                        "practice_attempt_llm_options": (
                            _practice_attempt_llm_options_metadata(llm_options)
                        ),
                    },
                )
            if snapshot["status"] in {"queued", "running"}:
                response.status_code = 202
            return snapshot

        asr_provider = _practice_asr_provider(active_openai_pipeline, practice_asr_model)
        asr_provider_name, asr_model_name = _practice_stage_identity(
            asr_provider,
            fallback_model=practice_asr_model,
        )

        def run_local_attempt(report=None):
            with NamedTemporaryFile(suffix=_upload_suffix(model_audio.filename)) as model_temp_audio, NamedTemporaryFile(
                suffix=_upload_suffix(audio.filename)
            ) as attempt_temp_audio:
                model_temp_audio.write(model_audio_bytes)
                model_temp_audio.flush()
                attempt_temp_audio.write(attempt_audio_bytes)
                attempt_temp_audio.flush()
                if report is not None:
                    report(
                        stage="transcribing_model",
                        label="お手本音声を確認しています",
                        provider=asr_provider_name,
                        model=asr_model_name,
                    )
                model_started = perf_counter()
                model_transcription = _transcribe_practice_model_audio(
                    asr_provider,
                    Path(model_temp_audio.name),
                    practice_target_language,
                    model_audio_bytes,
                )
                model_asr_ms = _elapsed_ms(model_started)
                if report is not None:
                    report(
                        stage="transcribing_attempt",
                        label="録音を確認しています",
                        provider=asr_provider_name,
                        model=asr_model_name,
                    )
                attempt_started = perf_counter()
                attempt_transcription = _transcribe_practice_audio(
                    asr_provider,
                    Path(attempt_temp_audio.name),
                    practice_target_language,
                )
                attempt_asr_ms = _elapsed_ms(attempt_started)
                reference_audio_duration = probe_audio_duration_seconds(
                    Path(model_temp_audio.name),
                    fallback_words=model_transcription.words,
                )
                attempt_audio_duration = probe_audio_duration_seconds(
                    Path(attempt_temp_audio.name),
                    fallback_words=attempt_transcription.words,
                )
            if report is not None and selected_comparison_model:
                report(
                    stage="evaluating_comparison",
                    label="比較結果を作っています",
                    provider="OpenAI",
                    model=selected_comparison_model,
                )
            return _create_practice_attempt_result_from_transcriptions(
                practice_target_language=practice_target_language,
                target_text=normalized_target_text,
                attempt_transcription=attempt_transcription,
                attempt_provider_name=str(getattr(asr_provider, "name", "") or ""),
                attempt_asr_ms=attempt_asr_ms,
                model_transcription=model_transcription,
                model_provider_name=str(getattr(asr_provider, "name", "") or ""),
                model_asr_ms=model_asr_ms,
                comparison_model=selected_comparison_model,
                playback_padding_seconds=selected_playback_padding,
                reference_audio_duration=reference_audio_duration,
                attempt_audio_duration=attempt_audio_duration,
            )

        if progress_mode == "job":
            def run_local_attempt_job(report):
                try:
                    result = run_local_attempt(report)
                    snapshot = {
                        "job_id": "",
                        "status": "succeeded",
                        "result": result,
                    }
                    _update_practice_attempt_history(
                        active_audio_history_store,
                        recording_entry,
                        snapshot,
                    )
                    return result
                except PracticeLlmError as error:
                    raise PracticeJobFailure(
                        current_stage={
                            "stage": "failed",
                            "label": "処理に失敗しました",
                            "provider": "OpenAI",
                            "model": selected_comparison_model,
                        },
                        error=_practice_llm_error_envelope(error)["error"],
                    ) from error
                except PracticeAlignmentError as error:
                    raise PracticeJobFailure(
                        current_stage={
                            "stage": "failed",
                            "label": "音声の解析結果を確認できませんでした",
                            "provider": "Voice Lab",
                            "model": "",
                        },
                        error=_practice_alignment_error_envelope(error)["error"],
                    ) from error

            planned_stages = [
                {
                    "stage": "transcribing_model",
                    "label": "お手本音声を確認しています",
                    "provider": asr_provider_name,
                    "model": asr_model_name,
                },
                {
                    "stage": "transcribing_attempt",
                    "label": "録音を確認しています",
                    "provider": asr_provider_name,
                    "model": asr_model_name,
                },
            ]
            if selected_comparison_model:
                planned_stages.append(
                    {
                        "stage": "evaluating_comparison",
                        "label": "比較結果を作っています",
                        "provider": "OpenAI",
                        "model": selected_comparison_model,
                    }
                )
            response.status_code = 202
            return practice_attempt_job_store.start(
                run_local_attempt_job,
                planned_stages=planned_stages,
            )

        try:
            result = run_local_attempt()
        except (PracticeAlignmentError, PracticeLlmError):
            raise
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        result_providers = (
            result.get("providers")
            if isinstance(result.get("providers"), dict)
            else {}
        )
        result_provider_name = str(
            result_providers.get("asr") or getattr(asr_provider, "name", "") or ""
        )
        result_asr_model = str(result.get("asr_model") or practice_asr_model)
        snapshot = {
            "job_id": "",
            "status": "succeeded",
            "current_stage": {
                "stage": "complete",
                "label": "比較準備が完了しました",
                "provider": result_provider_name,
                "model": result_asr_model,
            },
            "stages": [
                {
                    "stage": "complete",
                    "label": "完了",
                    "provider": result_provider_name,
                    "model": result_asr_model,
                }
            ],
            "metrics": {},
            "result": result,
            "error": None,
        }
        _update_practice_attempt_history(active_audio_history_store, recording_entry, snapshot)
        return snapshot

    @app.get("/api/practice/attempt-jobs/{job_id}")
    def get_practice_attempt_job(job_id: str) -> dict[str, object]:
        if practice_attempt_job_store.has(job_id):
            return practice_attempt_job_store.snapshot(job_id)
        with practice_attempt_finalization_lock:
            finalization = practice_attempt_finalization_jobs.get(job_id)
        if finalization is not None:
            snapshot = practice_attempt_job_store.snapshot(
                str(finalization["local_job_id"])
            )
            snapshot["job_id"] = job_id
            snapshot["metrics"] = finalization.get("metrics") or {}
            recording_entry = _practice_attempt_history_entry(
                active_audio_history_store,
                job_id,
            )
            _update_practice_attempt_history(
                active_audio_history_store,
                recording_entry,
                snapshot,
            )
            return snapshot
        try:
            body = active_runpod_practice_asr_provider.job_status(job_id)
            health = (
                active_runpod_practice_asr_provider.health()
                if str(body.get("status") or "").upper() in {"", "IN_QUEUE", "QUEUED"}
                else None
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=_runpod_practice_error_message({"error": str(exc)})) from exc
        recording_entry = _practice_attempt_history_entry(
            active_audio_history_store,
            job_id,
        )
        llm_options = practice_attempt_llm_options.get(job_id)
        if llm_options is None:
            llm_options = _practice_attempt_llm_options_from_history(recording_entry)
            if llm_options is not None:
                practice_attempt_llm_options[job_id] = llm_options
        if (
            str(body.get("status") or "").upper() == "COMPLETED"
            and llm_options is not None
            and llm_options.get("progress_mode") == "job"
        ):
            comparison_model = str(llm_options.get("comparison_model") or "")

            def finalize_runpod_attempt(report):
                report(
                    stage="evaluating_comparison",
                    label="比較結果を作っています",
                    provider="OpenAI",
                    model=comparison_model,
                )
                completed_snapshot = _practice_attempt_job_snapshot(
                    body,
                    llm_options=llm_options,
                )
                if completed_snapshot["status"] == "failed":
                    raise PracticeJobFailure(
                        current_stage=completed_snapshot["current_stage"],
                        error=completed_snapshot.get("error"),
                    )
                return completed_snapshot["result"]

            with practice_attempt_finalization_lock:
                finalization = practice_attempt_finalization_jobs.get(job_id)
                if finalization is None:
                    local_snapshot = practice_attempt_job_store.start(
                        finalize_runpod_attempt,
                        planned_stages=[
                            {
                                "stage": "evaluating_comparison",
                                "label": "比較結果を作っています",
                                "provider": "OpenAI",
                                "model": comparison_model,
                            }
                        ],
                    )
                    finalization = {
                        "local_job_id": local_snapshot["job_id"],
                        "metrics": _runpod_practice_metrics(body),
                    }
                    practice_attempt_finalization_jobs[job_id] = finalization
            snapshot = practice_attempt_job_store.snapshot(
                str(finalization["local_job_id"])
            )
            snapshot["job_id"] = job_id
            snapshot["metrics"] = finalization.get("metrics") or {}
            _update_practice_attempt_history(
                active_audio_history_store,
                recording_entry,
                snapshot,
            )
            return snapshot
        snapshot = _practice_attempt_job_snapshot(
            body,
            health=health,
            llm_options=llm_options,
        )
        _update_practice_attempt_history(active_audio_history_store, recording_entry, snapshot)
        return snapshot

    @app.post("/api/practice/recordings")
    async def create_practice_recording(
        response: Response,
        audio: Annotated[UploadFile, File()],
        recording_intent: Annotated[str, Form()],
        target_language: Annotated[str, Form()] = "ja-JP",
        current_target_text: Annotated[str, Form()] = "",
        include_pinyin: Annotated[bool, Form()] = False,
        use_own_voice: Annotated[bool, Form()] = False,
        asr_model: Annotated[str, Form()] = "whisper-1",
        progress_mode: Annotated[str, Form()] = "",
    ) -> dict[str, object]:
        try:
            practice_target_language = supported_practice_target_language(target_language)
        except ValueError as exc:
            raise PracticeAlignmentInputError("unsupported_target_language") from exc
        try:
            practice_asr_model = supported_openai_practice_asr_model(asr_model)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if recording_intent != "prompt":
            raise HTTPException(status_code=400, detail="recording_intent must be prompt")

        audio_bytes = await audio.read()
        recording_entry = _save_audio_history_recording(
            active_audio_history_store,
            audio_bytes,
            suffix=_upload_suffix(audio.filename),
            metadata={
                "endpoint": "practice-recordings",
                "recording_intent": recording_intent,
                "target_language": practice_target_language,
                "asr_model": practice_asr_model,
                "current_target_text_preview": current_target_text[:80],
                "filename": audio.filename or "",
                "content_type": audio.content_type or "",
            },
        )

        if progress_mode == "job":
            filename = audio.filename or "practice.webm"
            asr_provider = _practice_asr_provider(active_openai_pipeline, practice_asr_model)
            asr_provider_name, asr_model_name = _practice_stage_identity(
                asr_provider,
                fallback_model=practice_asr_model,
            )
            translation_provider_name, translation_model_name = _practice_stage_identity(
                active_openai_pipeline.translator
            )
            tts_provider_name, tts_model_name = _practice_stage_identity(
                active_openai_pipeline.tts
            )

            def run_prompt_job(report):
                result = _create_practice_prompt_result(
                    audio_bytes=audio_bytes,
                    filename=filename,
                    practice_target_language=practice_target_language,
                    include_pinyin=include_pinyin,
                    practice_asr_model=practice_asr_model,
                    progress_callback=report,
                )
                result["recording_kind"] = "prompt"
                if use_own_voice:
                    result["voice_conversion_job"] = _start_practice_voice_conversion_job(
                        source_audio_bytes=base64.b64decode(str(result["audio_base64"])),
                        source_audio_mime_type=str(result["audio_mime_type"]),
                        reference_audio_bytes=audio_bytes,
                        reference_audio_filename=filename,
                    )
                active_audio_history_store.update_metadata(
                    recording_entry,
                    _practice_history_diagnostics_metadata(result),
                )
                return result

            response.status_code = 202
            return practice_prompt_job_store.start(
                run_prompt_job,
                planned_stages=[
                    {
                        "stage": "transcribing_prompt",
                        "label": "録音を文字にしています",
                        "provider": asr_provider_name,
                        "model": asr_model_name,
                    },
                    {
                        "stage": "translating_prompt",
                        "label": "学習言語へ翻訳しています",
                        "provider": translation_provider_name,
                        "model": translation_model_name,
                    },
                    {
                        "stage": "synthesizing_prompt",
                        "label": "お手本音声を作っています",
                        "provider": tts_provider_name,
                        "model": tts_model_name,
                    },
                ],
            )

        result = _create_practice_prompt_result(
            audio_bytes=audio_bytes,
            filename=audio.filename or "",
            practice_target_language=practice_target_language,
            include_pinyin=include_pinyin,
            practice_asr_model=practice_asr_model,
        )
        result["recording_kind"] = "prompt"
        if use_own_voice:
            result["voice_conversion_job"] = _start_practice_voice_conversion_job(
                source_audio_bytes=base64.b64decode(str(result["audio_base64"])),
                source_audio_mime_type=str(result["audio_mime_type"]),
                reference_audio_bytes=audio_bytes,
                reference_audio_filename=audio.filename or "practice-reference.webm",
            )
        active_audio_history_store.update_metadata(
            recording_entry,
            _practice_history_diagnostics_metadata(result),
        )
        return result

    @app.get("/api/practice/prompt-jobs/{job_id}")
    def get_practice_prompt_job(job_id: str) -> dict[str, object]:
        try:
            return practice_prompt_job_store.snapshot(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="job not found") from exc

    @app.get("/api/practice/voice-jobs/{job_id}")
    def get_practice_voice_job(job_id: str) -> dict[str, object]:
        try:
            return practice_voice_conversion_job_store.snapshot(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="job not found") from exc

    @app.post("/api/practice/prompts")
    async def create_practice_prompt(
        audio: Annotated[UploadFile, File()],
        target_language: Annotated[str, Form()] = "ja-JP",
        include_pinyin: Annotated[bool, Form()] = False,
        asr_model: Annotated[str, Form()] = "whisper-1",
    ) -> dict[str, object]:
        try:
            practice_target_language = supported_practice_target_language(target_language)
        except ValueError as exc:
            raise PracticeAlignmentInputError("unsupported_target_language") from exc
        try:
            practice_asr_model = supported_openai_practice_asr_model(asr_model)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        audio_bytes = await audio.read()
        recording_entry = _save_audio_history_recording(
            active_audio_history_store,
            audio_bytes,
            suffix=_upload_suffix(audio.filename),
            metadata={
                "endpoint": "practice-prompts",
                "target_language": practice_target_language,
                "asr_model": practice_asr_model,
                "filename": audio.filename or "",
                "content_type": audio.content_type or "",
            },
        )

        timings_ms: dict[str, float] = {}
        total_started = perf_counter()
        asr_provider = _practice_asr_provider(active_openai_pipeline, practice_asr_model)
        with NamedTemporaryFile(suffix=_upload_suffix(audio.filename)) as temp_audio:
            temp_audio.write(audio_bytes)
            temp_audio.flush()
            try:
                started = perf_counter()
                asr_result = _transcribe_practice_audio(asr_provider, Path(temp_audio.name), "auto")
                transcript = asr_result.text
                timings_ms["asr"] = _elapsed_ms(started)

                started = perf_counter()
                target_text = active_openai_pipeline.translator.translate(
                    transcript,
                    "auto",
                    practice_target_language,
                )
                if practice_target_language == "zh-CN":
                    target_text = simplify_chinese_text(target_text)
                timings_ms["translation"] = _elapsed_ms(started)

                started = perf_counter()
                tts_output = _normalize_tts_provider_output(
                    active_openai_pipeline.tts.synthesize(target_text, practice_target_language),
                    active_openai_pipeline.tts.audio_mime_type,
                )
                timings_ms.update(tts_output.timings_ms)
                timings_ms.setdefault("tts", _elapsed_ms(started))
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except RuntimeError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc

        timings_ms["total"] = _elapsed_ms(total_started)
        result = {
            "transcript": transcript,
            "target_text": target_text,
            "translated_text": target_text,
            "transformed_text": target_text,
            "target_language": practice_target_language,
            "target_language_label": PRACTICE_TARGET_LANGUAGES[practice_target_language]["label"],
            "display_text": _practice_display_text(
                target_text,
                practice_target_language,
                include_pinyin=practice_target_language == "zh-CN" and include_pinyin,
            ),
            "audio_mime_type": tts_output.audio_mime_type or active_openai_pipeline.tts.audio_mime_type,
            "audio_base64": base64.b64encode(tts_output.audio_bytes).decode("ascii"),
            "timings_ms": timings_ms,
            "asr_model": practice_asr_model,
            "asr_timestamps": _serialize_asr_timestamps(asr_result),
            "providers": {
                "asr": asr_provider.name,
                "translation": active_openai_pipeline.translator.name,
                "tts": active_openai_pipeline.tts.name,
            },
        }
        active_audio_history_store.save_output(
            tts_output.audio_bytes,
            suffix=_mime_suffix(result["audio_mime_type"]),
            metadata={
                "endpoint": "practice-prompts",
                "translation_backend": "openai",
                "target_language": practice_target_language,
                "asr_model": practice_asr_model,
                "audio_mime_type": result["audio_mime_type"],
                "transcript_preview": transcript[:80],
                "translated_text_preview": target_text[:80],
                "tts_text": target_text,
                "text_preview": target_text[:80],
            },
        )
        active_audio_history_store.update_metadata(
            recording_entry,
            _practice_history_diagnostics_metadata(result),
        )
        return result

    @app.post("/api/translate-speech")
    async def translate_speech(
        audio: Annotated[UploadFile, File()],
        source_language: Annotated[str, Form()],
        target_language: Annotated[str, Form()],
        translation_backend: Annotated[str, Form()] = "openai",
        voice_mode: Annotated[str, Form()] = "default",
        text_transform: Annotated[str | None, Form()] = None,
        text_transform_options: Annotated[str | None, Form()] = None,
        text_transform_suffix: Annotated[str | None, Form()] = None,
        text_transform_unit: Annotated[str, Form()] = "text",
        seed_vc_diffusion_steps: Annotated[int | None, Form()] = None,
        seed_vc_length_adjust: Annotated[float | None, Form()] = None,
        seed_vc_inference_cfg_rate: Annotated[float | None, Form()] = None,
        seed_vc_reference_max_seconds: Annotated[float | None, Form()] = None,
        seed_vc_reference_auto_select: Annotated[bool | None, Form()] = None,
        input_history_kind: Annotated[str | None, Form()] = None,
        input_history_filename: Annotated[str | None, Form()] = None,
    ) -> dict[str, object]:
        audio_bytes = await audio.read()
        input_suffix = _upload_suffix(audio.filename)
        recording_entry = None
        if not _is_reused_history_input(active_audio_history_store, input_history_kind, input_history_filename):
            recording_entry = _save_audio_history_recording(
                active_audio_history_store,
                audio_bytes,
                suffix=input_suffix,
                metadata={
                    "endpoint": "translate-speech",
                    "translation_backend": translation_backend,
                    "source_language": source_language,
                    "target_language": target_language,
                    "voice_mode": voice_mode,
                    "filename": audio.filename or "",
                    "content_type": audio.content_type or "",
                },
            )
        with NamedTemporaryFile(suffix=_upload_suffix(audio.filename)) as temp_audio:
            temp_audio.write(audio_bytes)
            temp_audio.flush()

            request = _create_pipeline_request(
                Path(temp_audio.name),
                source_language,
                target_language,
                voice_mode,
                text_transform,
                text_transform_options,
                text_transform_suffix,
                text_transform_unit,
                seed_vc_diffusion_steps,
                seed_vc_length_adjust,
                seed_vc_inference_cfg_rate,
                seed_vc_reference_max_seconds,
                seed_vc_reference_auto_select,
            )
            try:
                result = _select_translation_pipeline(translation_pipelines, translation_backend).run(request)
            except (FileNotFoundError, ValueError) as exc:
                LOGGER.exception("translate_speech failed: backend=%s", translation_backend)
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except RuntimeError as exc:
                LOGGER.exception("translate_speech failed: backend=%s", translation_backend)
                raise HTTPException(status_code=503, detail=str(exc)) from exc

        active_audio_history_store.update_metadata(recording_entry, _history_text_metadata_from_recording_result(result))
        active_audio_history_store.save_output(
            result.output_audio_bytes,
            suffix=_mime_suffix(result.output_audio_mime_type),
            metadata={
                "endpoint": "translate-speech",
                "translation_backend": translation_backend,
                "source_language": source_language,
                "target_language": result.target_language or target_language,
                "voice_mode": voice_mode,
                "audio_mime_type": result.output_audio_mime_type,
                **_history_text_metadata_from_pipeline_result(result),
            },
        )
        return _serialize_pipeline_result(result)

    @app.post("/api/translate-speech-jobs")
    async def create_translate_speech_job(
        audio: Annotated[UploadFile, File()],
        source_language: Annotated[str, Form()],
        target_language: Annotated[str, Form()],
        translation_backend: Annotated[str, Form()] = "openai",
        voice_mode: Annotated[str, Form()] = "default",
        text_transform: Annotated[str | None, Form()] = None,
        text_transform_options: Annotated[str | None, Form()] = None,
        text_transform_suffix: Annotated[str | None, Form()] = None,
        text_transform_unit: Annotated[str, Form()] = "text",
        seed_vc_diffusion_steps: Annotated[int | None, Form()] = None,
        seed_vc_length_adjust: Annotated[float | None, Form()] = None,
        seed_vc_inference_cfg_rate: Annotated[float | None, Form()] = None,
        seed_vc_reference_max_seconds: Annotated[float | None, Form()] = None,
        seed_vc_reference_auto_select: Annotated[bool | None, Form()] = None,
        input_history_kind: Annotated[str | None, Form()] = None,
        input_history_filename: Annotated[str | None, Form()] = None,
    ) -> dict[str, object]:
        audio_bytes = await audio.read()
        input_suffix = _upload_suffix(audio.filename)
        recording_entry = None
        if not _is_reused_history_input(active_audio_history_store, input_history_kind, input_history_filename):
            recording_entry = _save_audio_history_recording(
                active_audio_history_store,
                audio_bytes,
                suffix=input_suffix,
                metadata={
                    "endpoint": "translate-speech-jobs",
                    "translation_backend": translation_backend,
                    "source_language": source_language,
                    "target_language": target_language,
                    "voice_mode": voice_mode,
                    "filename": audio.filename or "",
                    "content_type": audio.content_type or "",
                },
            )
        with NamedTemporaryFile(suffix=_upload_suffix(audio.filename), delete=False) as temp_audio:
            temp_audio.write(audio_bytes)
            temp_audio.flush()
            audio_path = Path(temp_audio.name)

        request = _create_pipeline_request(
            audio_path,
            source_language,
            target_language,
            voice_mode,
            text_transform,
            text_transform_options,
            text_transform_suffix,
            text_transform_unit,
            seed_vc_diffusion_steps,
            seed_vc_length_adjust,
            seed_vc_inference_cfg_rate,
            seed_vc_reference_max_seconds,
            seed_vc_reference_auto_select,
        )
        try:
            return job_store.start(request, audio_path, translation_backend, recording_entry=recording_entry)
        except ValueError as exc:
            LOGGER.exception("create_translate_speech_job failed: backend=%s", translation_backend)
            audio_path.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/translate-speech-jobs/{job_id}")
    def get_translate_speech_job(job_id: str) -> dict[str, object]:
        try:
            return job_store.snapshot(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="job not found") from exc

    @app.post("/api/text-to-speech-jobs")
    async def create_text_to_speech_job(
        text: Annotated[str, Form()],
        target_language: Annotated[str, Form()],
        tts_backend: Annotated[str, Form()] = "google_translate",
    ) -> dict[str, object]:
        try:
            return text_tts_job_store.start(text=text, target_language=target_language, tts_backend=tts_backend)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/text-to-speech-jobs/{job_id}")
    def get_text_to_speech_job(job_id: str) -> dict[str, object]:
        try:
            return text_tts_job_store.snapshot(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="job not found") from exc

    @app.post("/api/openai-realtime-translation-session")
    def create_openai_realtime_translation_session(
        payload: dict[str, str] = Body(...),
    ) -> dict[str, object]:
        try:
            return create_openai_realtime_translation_client_secret(payload.get("target_language", "ja-JP"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.post("/api/voice-conversion-jobs")
    async def create_voice_conversion_job(
        source_audio: Annotated[UploadFile, File()],
        reference_audio: Annotated[UploadFile, File()],
        audio_effect_audio: Annotated[UploadFile | None, File()] = None,
        voice_backend: Annotated[str, Form()] = "seed-vc",
        seed_vc_diffusion_steps: Annotated[int | None, Form()] = None,
        seed_vc_length_adjust: Annotated[float | None, Form()] = None,
        seed_vc_inference_cfg_rate: Annotated[float | None, Form()] = None,
        seed_vc_reference_max_seconds: Annotated[float | None, Form()] = None,
        seed_vc_reference_auto_select: Annotated[bool | None, Form()] = None,
        audio_effect_enabled: Annotated[bool, Form()] = False,
        audio_effect_insert_mode: Annotated[str, Form()] = "silence_or_tail",
        audio_effect_max_insertions: Annotated[int, Form()] = 1,
        audio_effect_min_silence_ms: Annotated[int, Form()] = 300,
    ) -> dict[str, object]:
        source_audio_bytes = await source_audio.read()
        source_suffix = _upload_suffix(source_audio.filename)
        _save_audio_history_recording(
            active_audio_history_store,
            source_audio_bytes,
            suffix=source_suffix,
            metadata={
                "endpoint": "voice-conversion-jobs",
                "voice_backend": voice_backend,
                "filename": source_audio.filename or "",
                "content_type": source_audio.content_type or "",
            },
        )
        with NamedTemporaryFile(suffix=_upload_suffix(source_audio.filename), delete=False) as temp_source:
            temp_source.write(source_audio_bytes)
            temp_source.flush()
            source_audio_path = Path(temp_source.name)

        reference_audio_bytes = await reference_audio.read()
        with NamedTemporaryFile(suffix=_upload_suffix(reference_audio.filename), delete=False) as temp_reference:
            temp_reference.write(reference_audio_bytes)
            temp_reference.flush()
            reference_audio_path = Path(temp_reference.name)
        audio_paths = [source_audio_path, reference_audio_path]

        audio_effect_path: Path | None = None
        audio_effect_settings: AudioEffectInsertSettings | None = None
        if audio_effect_enabled and audio_effect_audio is not None:
            audio_effect_bytes = await audio_effect_audio.read()
            if audio_effect_bytes:
                with NamedTemporaryFile(suffix=_upload_suffix(audio_effect_audio.filename), delete=False) as temp_effect:
                    temp_effect.write(audio_effect_bytes)
                    temp_effect.flush()
                    audio_effect_path = Path(temp_effect.name)
                audio_paths.append(audio_effect_path)
                audio_effect_settings = AudioEffectInsertSettings(
                    insert_mode=audio_effect_insert_mode,
                    max_insertions=max(1, min(audio_effect_max_insertions, 5)),
                    min_silence_ms=max(100, min(audio_effect_min_silence_ms, 2000)),
                )

        request = VoiceConversionRequest(
            source_audio_path=source_audio_path,
            reference_audio_path=reference_audio_path,
            backend_id=voice_backend,
            seed_vc_settings=_create_seed_vc_settings(
                diffusion_steps=seed_vc_diffusion_steps,
                length_adjust=seed_vc_length_adjust,
                inference_cfg_rate=seed_vc_inference_cfg_rate,
                reference_max_seconds=seed_vc_reference_max_seconds,
                reference_auto_select=seed_vc_reference_auto_select,
            ),
            audio_effect_path=audio_effect_path,
            audio_effect_settings=audio_effect_settings,
        )
        return voice_conversion_job_store.start(request, audio_paths)

    @app.post("/api/seed-vc/reference-preview")
    async def preview_seed_vc_reference(
        reference_audio: Annotated[UploadFile, File()],
        seed_vc_reference_max_seconds: Annotated[float | None, Form()] = None,
        seed_vc_reference_auto_select: Annotated[bool | None, Form()] = None,
    ) -> dict[str, object]:
        reference_audio_bytes = await reference_audio.read()
        if not reference_audio_bytes:
            raise HTTPException(status_code=400, detail="reference_audio is empty")

        with NamedTemporaryFile(suffix=_upload_suffix(reference_audio.filename)) as temp_reference:
            temp_reference.write(reference_audio_bytes)
            temp_reference.flush()
            try:
                output = _prepare_seed_vc_reference_preview(
                    Path(temp_reference.name),
                    seed_vc_settings=_create_seed_vc_settings(
                        diffusion_steps=None,
                        length_adjust=None,
                        inference_cfg_rate=None,
                        reference_max_seconds=seed_vc_reference_max_seconds,
                        reference_auto_select=seed_vc_reference_auto_select,
                    ),
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except RuntimeError as exc:
                LOGGER.exception("preview_seed_vc_reference failed")
                raise HTTPException(status_code=503, detail=str(exc)) from exc

        return {
            "audio_mime_type": output.audio_mime_type or "audio/wav",
            "audio_base64": base64.b64encode(output.audio_bytes).decode("ascii"),
            "timings_ms": output.timings_ms,
            "providers": {"reference_audio_prepare": "ffmpeg"},
            "warnings": output.warnings,
        }

    @app.get("/api/voice-conversion-jobs/{job_id}")
    def get_voice_conversion_job(job_id: str) -> dict[str, object]:
        try:
            return voice_conversion_job_store.snapshot(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="job not found") from exc

    @app.get("/api/audio-history")
    def get_audio_history() -> dict[str, object]:
        return {
            "settings": _serialize_audio_history_settings(active_audio_history_store),
            "recordings": _serialized_audio_history_entries(active_audio_history_store, "recordings", practice=False),
            "outputs": _serialized_audio_history_entries(active_audio_history_store, "outputs", practice=False),
        }

    @app.get("/api/practice-history")
    def get_practice_history() -> dict[str, object]:
        return {
            "settings": _serialize_audio_history_settings(active_audio_history_store),
            "recordings": _serialized_audio_history_entries(active_audio_history_store, "recordings", practice=True),
            "outputs": _serialized_audio_history_entries(active_audio_history_store, "outputs", practice=True),
        }

    @app.post("/api/audio-history/outputs")
    async def save_audio_history_output(
        audio: Annotated[UploadFile, File()],
        endpoint: Annotated[str, Form()] = "manual",
        translation_backend: Annotated[str | None, Form()] = None,
        target_language: Annotated[str | None, Form()] = None,
    ) -> dict[str, object]:
        audio_bytes = await audio.read()
        if len(audio_bytes) == 0:
            raise HTTPException(status_code=400, detail="audio is empty")
        saved = _save_audio_history_uploaded_output(
            active_audio_history_store,
            audio_bytes,
            suffix=_upload_suffix(audio.filename),
            metadata={
                "endpoint": endpoint,
                "translation_backend": translation_backend or "",
                "target_language": target_language or "",
                "filename": audio.filename or "",
                "content_type": audio.content_type or "",
            },
        )
        return {
            "saved": saved is not None,
            "entry": _serialize_audio_history_entry("outputs", saved) if saved else None,
        }

    @app.get("/api/audio-history/{kind}/{filename}")
    def get_audio_history_file(kind: str, filename: str) -> FileResponse:
        try:
            audio_path = active_audio_history_store.resolve_audio_path(kind, filename)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="audio history file not found") from exc
        return FileResponse(audio_path, media_type=_audio_media_type(audio_path))

    @app.delete("/api/audio-history/{kind}/{filename}")
    def delete_audio_history_file(kind: str, filename: str) -> dict[str, bool]:
        try:
            return {"deleted": active_audio_history_store.delete_entry(kind, filename)}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="audio history file not found") from exc

    return app


app = create_app()
