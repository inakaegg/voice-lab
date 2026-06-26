from __future__ import annotations

import base64
import logging
import os
from pathlib import Path
from tempfile import NamedTemporaryFile
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
from .api_jobs import TextToSpeechJobStore, TranslationJobStore, VoiceConversionJobStore
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
from .api_serializers import serialize_pipeline_result as _serialize_pipeline_result
from .audio_history import AudioHistoryStore
from .factory import create_openai_pipeline, create_pipeline_from_env, create_realtime_translation_pipeline
from .pipeline import SpeechTranslationPipeline
from .providers.openai_api import (
    create_openai_realtime_translation_client_secret,
)
from .providers.text_tts import create_text_tts_providers, text_tts_backend_statuses
from .providers.voice import (
    VoiceConversionRequest,
    VoiceConversionService,
    create_voice_conversion_service_from_env,
    prepare_seed_vc_reference_preview as _prepare_seed_vc_reference_preview,
)

PACKAGE_DIR = Path(__file__).resolve().parent
WEB_DIR = PACKAGE_DIR / "web"
LOGGER = logging.getLogger("mo_speech")


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


def create_app(
    pipeline: SpeechTranslationPipeline | None = None,
    openai_pipeline: SpeechTranslationPipeline | None = None,
    openai_realtime_pipeline=None,
    text_tts_providers: dict[str, object] | None = None,
    voice_conversion_service: VoiceConversionService | None = None,
    audio_history_store: AudioHistoryStore | None = None,
) -> FastAPI:
    app = FastAPI(title="mo speech translation")
    active_pipeline = pipeline or create_pipeline_from_env()
    active_openai_pipeline = openai_pipeline or create_openai_pipeline()
    active_openai_realtime_pipeline = openai_realtime_pipeline or create_realtime_translation_pipeline()
    translation_pipelines = {
        "openai": active_openai_pipeline,
        "openai_realtime": active_openai_realtime_pipeline,
        "qwen": active_pipeline,
    }
    active_text_tts_providers = text_tts_providers or create_text_tts_providers()
    active_voice_conversion_service = voice_conversion_service or create_voice_conversion_service_from_env()
    active_audio_history_store = audio_history_store or AudioHistoryStore.from_env()
    job_store = TranslationJobStore(translation_pipelines, active_audio_history_store)
    text_tts_job_store = TextToSpeechJobStore(active_text_tts_providers, active_audio_history_store)
    voice_conversion_job_store = VoiceConversionJobStore(active_voice_conversion_service, active_audio_history_store)
    if os.getenv("MO_PRELOAD_MODELS") == "1":
        active_pipeline.preload()
    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")

    @app.get("/")
    def index() -> FileResponse:
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
            ),
            "text_tts_backends": text_tts_backend_statuses(active_text_tts_providers),
            "voice_conversion_backends": _voice_conversion_backends(active_voice_conversion_service),
        }

    @app.post("/api/translate-speech")
    async def translate_speech(
        audio: Annotated[UploadFile, File()],
        source_language: Annotated[str, Form()],
        target_language: Annotated[str, Form()],
        translation_backend: Annotated[str, Form()] = "openai",
        voice_mode: Annotated[str, Form()] = "default",
        text_transform: Annotated[str | None, Form()] = None,
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
                "target_language": target_language,
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
        voice_backend: Annotated[str, Form()] = "seed-vc",
        seed_vc_diffusion_steps: Annotated[int | None, Form()] = None,
        seed_vc_length_adjust: Annotated[float | None, Form()] = None,
        seed_vc_inference_cfg_rate: Annotated[float | None, Form()] = None,
        seed_vc_reference_max_seconds: Annotated[float | None, Form()] = None,
        seed_vc_reference_auto_select: Annotated[bool | None, Form()] = None,
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
        )
        return voice_conversion_job_store.start(request, [source_audio_path, reference_audio_path])

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
            "recordings": [
                _serialize_audio_history_entry("recordings", entry)
                for entry in active_audio_history_store.list_entries("recordings")
            ],
            "outputs": [
                _serialize_audio_history_entry("outputs", entry)
                for entry in active_audio_history_store.list_entries("outputs")
            ],
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
