from __future__ import annotations

import base64
import logging
import os
import re
import shutil
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory, mkdtemp
from time import perf_counter
from typing import Annotated

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
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
from .audio_history import AudioHistoryStore
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
    evaluate_practice_attempt,
    supported_practice_target_language,
)
from .providers.openai_api import (
    AsrTranscription,
    OpenAiAsrProvider,
    create_openai_realtime_translation_client_secret,
    supported_openai_practice_asr_model,
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


def _practice_asr_provider(pipeline: SpeechTranslationPipeline, asr_model: str):
    if isinstance(pipeline.asr, OpenAiAsrProvider):
        return OpenAiAsrProvider(model=asr_model)
    return pipeline.asr


def _transcribe_practice_audio(asr_provider, audio_path: Path, source_language: str) -> AsrTranscription:
    transcribe_detail = getattr(asr_provider, "transcribe_detail", None)
    if callable(transcribe_detail):
        return transcribe_detail(audio_path, source_language, include_timestamps=True)
    return AsrTranscription(
        text=asr_provider.transcribe(audio_path, source_language),
        model=getattr(asr_provider, "name", "asr"),
    )


def _serialize_asr_timestamps(result: AsrTranscription) -> dict[str, object]:
    return {
        "available": result.has_timestamps,
        "model": result.model,
        "timestamp_granularities": result.timestamp_granularities,
        "words": result.words,
        "segments": result.segments,
    }


async def _read_vibevoice_script(script: str, script_file: UploadFile | None) -> str:
    if script_file is not None and script_file.filename:
        content = await script_file.read()
        if not content:
            raise ValueError("script file is empty")
        try:
            return content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("script file must be UTF-8") from exc
    return script


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


async def _save_vibevoice_voice_uploads(uploads: list[UploadFile | None], directory: Path) -> list[VibeVoiceVoiceSample]:
    voice_paths: list[VibeVoiceVoiceSample] = []
    for index, upload in enumerate(uploads, start=1):
        if upload is None or not upload.filename:
            continue
        voice_paths.append(
            VibeVoiceVoiceSample(
                slot=index,
                path=await _save_vibevoice_upload(upload, directory, f"voice-{index}"),
            )
        )
    if not voice_paths:
        raise ValueError("voice sample is required")
    return voice_paths


def _vibevoice_generation_options(
    *,
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
) -> VibeVoiceGenerationOptions:
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
        directed_line_mode=_bool_form_value(directed_line_mode, default=False),
        directed_retry_low_score=_bool_form_value(directed_retry_low_score, default=False),
        directed_retry_score_threshold=max(0.0, min(1.0, _float_form_value(directed_retry_score_threshold, 0.65))),
        directed_retry_max_lines=max(0, _int_form_value(directed_retry_max_lines, 3)),
    )


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


def _practice_pinyin_text_openai(text: str) -> str:
    if not os.getenv("OPENAI_API_KEY"):
        return ""
    try:
        from openai import OpenAI
    except ImportError:
        return ""

    try:
        response = OpenAI().responses.create(
            model=os.getenv("OPENAI_TEXT_DISPLAY_MODEL", os.getenv("OPENAI_TEXT_TRANSFORM_MODEL", "gpt-5.5")),
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
    text_tts_providers: dict[str, object] | None = None,
    voice_conversion_service: VoiceConversionService | None = None,
    vibevoice_service: VibeVoiceService | None = None,
    runpod_vibevoice_service: VibeVoiceGenerator | None = None,
    reference_audio_extractor: MediaReferenceAudioExtractor | None = None,
    audio_history_store: AudioHistoryStore | None = None,
    user_settings_store: UserSettingsStore | None = None,
) -> FastAPI:
    app = FastAPI(title="mo speech translation")
    active_pipeline = pipeline or create_pipeline_from_env()
    active_openai_pipeline = openai_pipeline or create_openai_pipeline()
    active_openai_realtime_pipeline = openai_realtime_pipeline or create_realtime_translation_pipeline()
    active_runpod_serverless_pipeline = runpod_serverless_pipeline or create_runpod_serverless_pipeline()
    translation_pipelines = {
        "openai": active_openai_pipeline,
        "openai_realtime": active_openai_realtime_pipeline,
        "qwen": active_pipeline,
        "runpod_serverless": active_runpod_serverless_pipeline,
    }
    active_text_tts_providers = text_tts_providers or create_text_tts_providers()
    active_voice_conversion_service = voice_conversion_service or create_voice_conversion_service_from_env()
    active_vibevoice_service = vibevoice_service or VibeVoiceService.from_env()
    active_runpod_vibevoice_service = runpod_vibevoice_service or RunpodServerlessVibeVoiceService.from_env()
    active_reference_audio_extractor = reference_audio_extractor or MediaReferenceAudioExtractor()
    active_audio_history_store = audio_history_store or AudioHistoryStore.from_env()
    active_user_settings_store = user_settings_store or UserSettingsStore.from_env()
    job_store = TranslationJobStore(translation_pipelines, active_audio_history_store)
    text_tts_job_store = TextToSpeechJobStore(active_text_tts_providers, active_audio_history_store)
    voice_conversion_job_store = VoiceConversionJobStore(active_voice_conversion_service, active_audio_history_store)
    vibevoice_job_store = VibeVoiceJobStore()
    if os.getenv("MO_PRELOAD_MODELS") == "1":
        active_pipeline.preload()
    if os.getenv("MO_PRELOAD_VOICE_CONVERSION") == "1" or os.getenv("MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START") == "1":
        active_voice_conversion_service.preload()
    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(WEB_DIR / "user.html")

    @app.get("/practice")
    def practice() -> FileResponse:
        return FileResponse(WEB_DIR / "practice.html")

    @app.get("/practice/admin")
    def practice_admin() -> FileResponse:
        return FileResponse(WEB_DIR / "practice_admin.html")

    @app.get("/vibevoice")
    def vibevoice() -> FileResponse:
        return FileResponse(WEB_DIR / "vibevoice.html")

    @app.get("/seed-vc")
    def seed_vc_direct() -> FileResponse:
        return FileResponse(WEB_DIR / "seed_vc.html")

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
    def vibevoice_status() -> dict[str, object]:
        local_status = active_vibevoice_service.status()
        return {
            **local_status,
            "backends": {
                "local": local_status,
                "runpod_serverless": active_runpod_vibevoice_service.status(),
            },
        }

    @app.post("/api/vibevoice/reference-audio-from-url")
    async def vibevoice_reference_audio_from_url(
        url: Annotated[str, Form()] = "",
        start_seconds: Annotated[str | None, Form()] = None,
        duration_seconds: Annotated[str, Form()] = "5",
    ) -> dict[str, object]:
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

    @app.post("/api/vibevoice/generate")
    async def vibevoice_generate(
        script: Annotated[str, Form()] = "",
        script_file: Annotated[UploadFile | None, File()] = None,
        voice_file_1: Annotated[UploadFile | None, File()] = None,
        voice_file_2: Annotated[UploadFile | None, File()] = None,
        voice_file_3: Annotated[UploadFile | None, File()] = None,
        voice_file_4: Annotated[UploadFile | None, File()] = None,
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
        directed_line_mode: Annotated[str, Form()] = "false",
        directed_retry_low_score: Annotated[str, Form()] = "false",
        directed_retry_score_threshold: Annotated[str, Form()] = "0.65",
        directed_retry_max_lines: Annotated[str, Form()] = "3",
        backend: Annotated[str, Form()] = "local",
        model_id: Annotated[str, Form()] = "vibevoice-1.5b-pinned",
    ) -> dict[str, object]:
        try:
            script_text = await _read_vibevoice_script(script, script_file)
            options = _vibevoice_generation_options(
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
            )
            with TemporaryDirectory(prefix="mo-vibevoice-api-") as temp_dir:
                voice_paths = await _save_vibevoice_voice_uploads(
                    [voice_file_1, voice_file_2, voice_file_3, voice_file_4],
                    Path(temp_dir),
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
        except VibeVoiceError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return {
            "audio_mime_type": vibevoice_result.audio_mime_type,
            "audio_base64": base64.b64encode(vibevoice_result.audio_bytes).decode("ascii"),
            "normalized_script": vibevoice_result.normalized_script,
            "providers": vibevoice_result.providers,
            "timings_ms": vibevoice_result.timings_ms,
            "diagnostics": vibevoice_result.diagnostics,
            "artifacts": list(getattr(vibevoice_result, "artifacts", [])),
        }

    @app.post("/api/vibevoice/jobs")
    async def create_vibevoice_job(
        script: Annotated[str, Form()] = "",
        script_file: Annotated[UploadFile | None, File()] = None,
        voice_file_1: Annotated[UploadFile | None, File()] = None,
        voice_file_2: Annotated[UploadFile | None, File()] = None,
        voice_file_3: Annotated[UploadFile | None, File()] = None,
        voice_file_4: Annotated[UploadFile | None, File()] = None,
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
        directed_line_mode: Annotated[str, Form()] = "false",
        directed_retry_low_score: Annotated[str, Form()] = "false",
        directed_retry_score_threshold: Annotated[str, Form()] = "0.65",
        directed_retry_max_lines: Annotated[str, Form()] = "3",
        backend: Annotated[str, Form()] = "local",
        model_id: Annotated[str, Form()] = "vibevoice-1.5b-pinned",
    ) -> dict[str, object]:
        temp_dir = Path(mkdtemp(prefix="mo-vibevoice-job-"))
        try:
            script_text = await _read_vibevoice_script(script, script_file)
            options = _vibevoice_generation_options(
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
            )
            voice_paths = await _save_vibevoice_voice_uploads(
                [voice_file_1, voice_file_2, voice_file_3, voice_file_4],
                temp_dir,
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
            )
        except (ValueError, FileNotFoundError) as exc:
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise HTTPException(status_code=400, detail=str(exc)) from exc

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

    @app.post("/api/practice/prompts")
    async def create_practice_prompt(
        audio: Annotated[UploadFile, File()],
        target_language: Annotated[str, Form()] = "ja-JP",
        include_pinyin: Annotated[bool, Form()] = False,
        asr_model: Annotated[str, Form()] = "gpt-4o-transcribe",
    ) -> dict[str, object]:
        try:
            practice_target_language = supported_practice_target_language(target_language)
            practice_asr_model = supported_openai_practice_asr_model(asr_model)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        audio_bytes = await audio.read()
        _save_audio_history_recording(
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
        return result

    @app.post("/api/practice/attempts")
    async def create_practice_attempt(
        audio: Annotated[UploadFile, File()],
        target_language: Annotated[str, Form()],
        target_text: Annotated[str, Form()],
        asr_model: Annotated[str, Form()] = "gpt-4o-transcribe",
    ) -> dict[str, object]:
        try:
            practice_target_language = supported_practice_target_language(target_language)
            practice_asr_model = supported_openai_practice_asr_model(asr_model)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not target_text.strip():
            raise HTTPException(status_code=400, detail="target_text is required")

        audio_bytes = await audio.read()
        _save_audio_history_recording(
            active_audio_history_store,
            audio_bytes,
            suffix=_upload_suffix(audio.filename),
            metadata={
                "endpoint": "practice-attempts",
                "target_language": practice_target_language,
                "asr_model": practice_asr_model,
                "filename": audio.filename or "",
                "content_type": audio.content_type or "",
            },
        )

        total_started = perf_counter()
        asr_provider = _practice_asr_provider(active_openai_pipeline, practice_asr_model)
        with NamedTemporaryFile(suffix=_upload_suffix(audio.filename)) as temp_audio:
            temp_audio.write(audio_bytes)
            temp_audio.flush()
            try:
                asr_started = perf_counter()
                asr_result = _transcribe_practice_audio(asr_provider, Path(temp_audio.name), practice_target_language)
                recognized_text = asr_result.text
                asr_ms = _elapsed_ms(asr_started)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except RuntimeError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc

        evaluation = evaluate_practice_attempt(target_text, recognized_text, practice_target_language)
        return {
            "target_language": practice_target_language,
            "target_text": target_text,
            "recognized_text": recognized_text,
            "asr_model": practice_asr_model,
            "asr_timestamps": _serialize_asr_timestamps(asr_result),
            **evaluation,
            "timings_ms": {
                "asr": asr_ms,
                "compare": max(0.0, _elapsed_ms(total_started) - asr_ms),
                "total": _elapsed_ms(total_started),
            },
            "providers": {
                "asr": asr_provider.name,
            },
        }

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
