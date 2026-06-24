from __future__ import annotations

import base64
import logging
import mimetypes
import os
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock, Thread
from typing import Annotated
from uuid import uuid4

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .audio_history import AudioHistoryEntry, AudioHistoryStore
from .factory import create_openai_pipeline, create_pipeline_from_env, create_realtime_translation_pipeline
from .pipeline import PipelineProgress, PipelineRequest, PipelineResult, SpeechTranslationPipeline, TtsOutput
from .providers.openai_api import (
    create_openai_realtime_translation_client_secret,
    openai_pipeline_status,
    openai_realtime_pipeline_status,
    openai_realtime_streaming_status,
)
from .providers.text_tts import create_text_tts_providers, text_tts_backend_statuses
from .providers.voice import (
    SeedVcRuntimeSettings,
    VoiceConversionRequest,
    VoiceConversionResult,
    VoiceConversionService,
    create_voice_conversion_service_from_env,
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
    ) -> dict[str, object]:
        audio_bytes = await audio.read()
        input_suffix = _upload_suffix(audio.filename)
        recording_entry = active_audio_history_store.save_recording(
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
    ) -> dict[str, object]:
        audio_bytes = await audio.read()
        input_suffix = _upload_suffix(audio.filename)
        recording_entry = active_audio_history_store.save_recording(
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
    ) -> dict[str, object]:
        source_audio_bytes = await source_audio.read()
        source_suffix = _upload_suffix(source_audio.filename)
        active_audio_history_store.save_recording(
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
            ),
        )
        return voice_conversion_job_store.start(request, [source_audio_path, reference_audio_path])

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
        saved = active_audio_history_store.save_output(
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

    return app


@dataclass
class TranslationJob:
    job_id: str
    status: str
    stages: list[dict[str, str]]
    current_stage: dict[str, str] | None = None
    partial_result: dict[str, str] = field(default_factory=dict)
    result: dict[str, object] | None = None
    error: str | None = None


@dataclass
class TranslationJobStore:
    pipelines: dict[str, SpeechTranslationPipeline]
    audio_history_store: AudioHistoryStore
    jobs: dict[str, TranslationJob] = field(default_factory=dict)
    lock: Lock = field(default_factory=Lock)

    def start(
        self,
        request: PipelineRequest,
        audio_path: Path,
        translation_backend: str,
        recording_entry: AudioHistoryEntry | None = None,
    ) -> dict[str, object]:
        pipeline = _select_translation_pipeline(self.pipelines, translation_backend)
        job = TranslationJob(
            job_id=uuid4().hex,
            status="queued",
            stages=_planned_stages(pipeline, request),
        )
        with self.lock:
            self.jobs[job.job_id] = job
        thread = Thread(
            target=self._run_job,
            args=(job.job_id, request, audio_path, translation_backend, recording_entry),
            daemon=True,
        )
        thread.start()
        return self.snapshot(job.job_id)

    def snapshot(self, job_id: str) -> dict[str, object]:
        with self.lock:
            job = self.jobs[job_id]
            return {
                "job_id": job.job_id,
                "status": job.status,
                "current_stage": job.current_stage,
                "stages": list(job.stages),
                "partial_result": dict(job.partial_result),
                "result": job.result,
                "error": job.error,
            }

    def _run_job(
        self,
        job_id: str,
        request: PipelineRequest,
        audio_path: Path,
        translation_backend: str,
        recording_entry: AudioHistoryEntry | None,
    ) -> None:
        try:
            with self.lock:
                self.jobs[job_id].status = "running"

            def report_progress(progress: PipelineProgress) -> None:
                self._update_progress(job_id, progress)

            result = _select_translation_pipeline(self.pipelines, translation_backend).run(
                request,
                progress_callback=report_progress,
            )
            self.audio_history_store.update_metadata(
                recording_entry,
                _history_text_metadata_from_recording_result(result),
            )
            self.audio_history_store.save_output(
                result.output_audio_bytes,
                suffix=_mime_suffix(result.output_audio_mime_type),
                metadata={
                    "endpoint": "translate-speech-jobs",
                    "job_id": job_id,
                    "translation_backend": translation_backend,
                    "source_language": request.source_language,
                    "target_language": request.target_language,
                    "voice_mode": request.voice_mode,
                    "audio_mime_type": result.output_audio_mime_type,
                    **_history_text_metadata_from_pipeline_result(result),
                },
            )
            with self.lock:
                job = self.jobs[job_id]
                job.status = "succeeded"
                job.result = _serialize_pipeline_result(result)
                job.partial_result = _partial_result_from_pipeline_result(result)
                job.current_stage = {"stage": "complete", "label": "完了", "provider": ""}
        except (FileNotFoundError, ValueError, RuntimeError, OSError) as exc:
            LOGGER.exception("translation job failed: backend=%s job_id=%s", translation_backend, job_id)
            with self.lock:
                job = self.jobs[job_id]
                job.status = "failed"
                job.error = str(exc)
        finally:
            audio_path.unlink(missing_ok=True)

    def _update_progress(self, job_id: str, progress: PipelineProgress) -> None:
        item = _serialize_progress(progress)
        partial_result = _serialize_partial_result(progress)
        with self.lock:
            job = self.jobs[job_id]
            job.current_stage = item
            job.partial_result.update(partial_result)
            for index, stage in enumerate(job.stages):
                if stage["stage"] == item["stage"]:
                    job.stages[index] = item
                    break
            else:
                job.stages.append(item)


@dataclass
class TextToSpeechJob:
    job_id: str
    status: str
    stages: list[dict[str, str]]
    current_stage: dict[str, str] | None = None
    result: dict[str, object] | None = None
    error: str | None = None


@dataclass
class TextToSpeechJobStore:
    providers: dict[str, object]
    audio_history_store: AudioHistoryStore
    jobs: dict[str, TextToSpeechJob] = field(default_factory=dict)
    lock: Lock = field(default_factory=Lock)

    def start(self, *, text: str, target_language: str, tts_backend: str) -> dict[str, object]:
        provider = self._provider(tts_backend)
        job = TextToSpeechJob(
            job_id=uuid4().hex,
            status="queued",
            stages=[{"stage": "tts", "label": "音声生成", "provider": provider.name}],
        )
        with self.lock:
            self.jobs[job.job_id] = job
        thread = Thread(target=self._run_job, args=(job.job_id, text, target_language, tts_backend), daemon=True)
        thread.start()
        return self.snapshot(job.job_id)

    def snapshot(self, job_id: str) -> dict[str, object]:
        with self.lock:
            job = self.jobs[job_id]
            return {
                "job_id": job.job_id,
                "status": job.status,
                "current_stage": job.current_stage,
                "stages": list(job.stages),
                "result": job.result,
                "error": job.error,
            }

    def _run_job(self, job_id: str, text: str, target_language: str, tts_backend: str) -> None:
        try:
            provider = self._provider(tts_backend)
            with self.lock:
                job = self.jobs[job_id]
                job.status = "running"
                job.current_stage = {"stage": "tts", "label": "音声生成", "provider": provider.name}
                job.stages = [job.current_stage]

            output = _normalize_tts_provider_output(provider.synthesize(text, target_language), provider.audio_mime_type)
            self.audio_history_store.save_output(
                output.audio_bytes,
                suffix=_mime_suffix(output.audio_mime_type),
                metadata={
                    "endpoint": "text-to-speech-jobs",
                    "job_id": job_id,
                    "tts_backend": tts_backend,
                    "target_language": target_language,
                    "audio_mime_type": output.audio_mime_type,
                    "text_preview": _text_preview(text),
                },
            )
            with self.lock:
                job = self.jobs[job_id]
                job.status = "succeeded"
                job.result = _serialize_tts_output(output, provider.name)
                job.current_stage = {"stage": "complete", "label": "完了", "provider": ""}
        except Exception as exc:
            LOGGER.exception("text-to-speech job failed: backend=%s job_id=%s", tts_backend, job_id)
            with self.lock:
                job = self.jobs[job_id]
                job.status = "failed"
                job.error = str(exc)

    def _provider(self, tts_backend: str):
        if tts_backend not in self.providers:
            raise ValueError(f"unsupported TTS backend: {tts_backend}")
        return self.providers[tts_backend]


@dataclass
class VoiceConversionJob:
    job_id: str
    status: str
    stages: list[dict[str, str]]
    current_stage: dict[str, str] | None = None
    result: dict[str, object] | None = None
    error: str | None = None


@dataclass
class VoiceConversionJobStore:
    service: VoiceConversionService
    audio_history_store: AudioHistoryStore
    jobs: dict[str, VoiceConversionJob] = field(default_factory=dict)
    lock: Lock = field(default_factory=Lock)

    def start(self, request: VoiceConversionRequest, audio_paths: list[Path]) -> dict[str, object]:
        job = VoiceConversionJob(
            job_id=uuid4().hex,
            status="queued",
            stages=_planned_voice_conversion_stages(self.service, request),
        )
        with self.lock:
            self.jobs[job.job_id] = job
        thread = Thread(target=self._run_job, args=(job.job_id, request, audio_paths), daemon=True)
        thread.start()
        return self.snapshot(job.job_id)

    def snapshot(self, job_id: str) -> dict[str, object]:
        with self.lock:
            job = self.jobs[job_id]
            return {
                "job_id": job.job_id,
                "status": job.status,
                "current_stage": job.current_stage,
                "stages": list(job.stages),
                "result": job.result,
                "error": job.error,
            }

    def _run_job(self, job_id: str, request: VoiceConversionRequest, audio_paths: list[Path]) -> None:
        try:
            with self.lock:
                self.jobs[job_id].status = "running"

            def report_progress(progress: PipelineProgress) -> None:
                self._update_progress(job_id, progress)

            result = self.service.convert(request, progress_callback=report_progress)
            self.audio_history_store.save_output(
                result.output_audio_bytes,
                suffix=_mime_suffix(result.output_audio_mime_type),
                metadata={
                    "endpoint": "voice-conversion-jobs",
                    "job_id": job_id,
                    "voice_backend": request.backend_id,
                    "audio_mime_type": result.output_audio_mime_type,
                },
            )
            with self.lock:
                job = self.jobs[job_id]
                job.status = "succeeded"
                job.result = _serialize_voice_conversion_result(result)
                job.current_stage = {"stage": "complete", "label": "完了", "provider": ""}
        except (FileNotFoundError, ValueError, RuntimeError, OSError) as exc:
            LOGGER.exception("voice conversion job failed: backend=%s job_id=%s", request.backend_id, job_id)
            with self.lock:
                job = self.jobs[job_id]
                job.status = "failed"
                job.error = str(exc)
        finally:
            for audio_path in audio_paths:
                audio_path.unlink(missing_ok=True)

    def _update_progress(self, job_id: str, progress: PipelineProgress) -> None:
        item = _serialize_progress(progress)
        with self.lock:
            job = self.jobs[job_id]
            job.current_stage = item
            for index, stage in enumerate(job.stages):
                if stage["stage"] == item["stage"]:
                    job.stages[index] = item
                    break
            else:
                job.stages.append(item)


app = create_app()


def _provider_names(pipeline: SpeechTranslationPipeline) -> dict[str, str]:
    return {
        "asr": pipeline.asr.name,
        "translation": pipeline.translator.name,
        "tts": pipeline.tts.name,
    }


def _translation_backends(
    qwen_pipeline: SpeechTranslationPipeline,
    openai_pipeline: SpeechTranslationPipeline,
    openai_realtime_pipeline,
) -> list[dict[str, object]]:
    return [
        openai_pipeline_status(openai_pipeline),
        openai_realtime_pipeline_status(openai_realtime_pipeline),
        openai_realtime_streaming_status(),
        {
            "id": "qwen",
            "label": "音声翻訳（Qwen/local）",
            "available": True,
            "reason": "",
            "providers": _provider_names(qwen_pipeline),
            "settings": {
                "supported_routes": [
                    {"source_language": "id-ID", "target_language": "ja-JP"},
                    {"source_language": "ja-JP", "target_language": "zh-CN"},
                ],
                "supported_voice_modes": _supported_voice_modes(qwen_pipeline),
                "source_language_mode": "specified",
                "text_transform": True,
            },
        },
    ]


def _select_translation_pipeline(
    pipelines: dict[str, object],
    translation_backend: str,
):
    if translation_backend not in pipelines:
        raise ValueError(f"unsupported translation backend: {translation_backend}")
    return pipelines[translation_backend]


def _supported_voice_modes(pipeline: SpeechTranslationPipeline) -> list[str]:
    provider_modes = getattr(pipeline.tts, "supported_voice_modes", ("default",))
    modes: list[str] = []
    for mode in provider_modes:
        mode_text = str(mode)
        if mode_text not in modes:
            modes.append(mode_text)
    return modes


def _voice_conversion_backends(service: VoiceConversionService) -> list[dict[str, object]]:
    return [
        {
            "id": info.backend_id,
            "label": info.label,
            "provider": info.provider,
            "available": info.available,
            "reason": info.reason,
            "settings": info.settings,
        }
        for info in service.backend_infos()
    ]


def _create_seed_vc_settings(
    *,
    diffusion_steps: int | None,
    length_adjust: float | None,
    inference_cfg_rate: float | None,
    reference_max_seconds: float | None,
) -> SeedVcRuntimeSettings:
    _validate_optional_number("seed_vc_diffusion_steps", diffusion_steps, minimum=1, maximum=80)
    _validate_optional_number("seed_vc_length_adjust", length_adjust, minimum=0.25, maximum=4.0)
    _validate_optional_number("seed_vc_inference_cfg_rate", inference_cfg_rate, minimum=0.0, maximum=2.0)
    _validate_optional_number("seed_vc_reference_max_seconds", reference_max_seconds, minimum=0.5, maximum=30.0)
    return SeedVcRuntimeSettings(
        diffusion_steps=diffusion_steps,
        length_adjust=length_adjust,
        inference_cfg_rate=inference_cfg_rate,
        reference_max_seconds=reference_max_seconds,
    )


def _validate_optional_number(name: str, value: float | int | None, *, minimum: float, maximum: float) -> None:
    if value is None:
        return
    if value < minimum or value > maximum:
        raise HTTPException(status_code=400, detail=f"{name} must be between {minimum} and {maximum}")


def _create_pipeline_request(
    audio_path: Path,
    source_language: str,
    target_language: str,
    voice_mode: str,
    text_transform: str | None,
    text_transform_suffix: str | None,
    text_transform_unit: str,
    seed_vc_diffusion_steps: int | None,
    seed_vc_length_adjust: float | None,
    seed_vc_inference_cfg_rate: float | None,
    seed_vc_reference_max_seconds: float | None,
) -> PipelineRequest:
    options: dict[str, str] = {}
    if text_transform_suffix is not None:
        options["suffix"] = text_transform_suffix
    if text_transform_unit:
        options["unit"] = text_transform_unit
    return PipelineRequest(
        audio_path=audio_path,
        source_language=source_language,
        target_language=target_language,
        voice_mode=voice_mode,
        text_transform=text_transform,
        text_transform_options=options,
        voice_settings={
            "seed_vc": _create_seed_vc_settings(
                diffusion_steps=seed_vc_diffusion_steps,
                length_adjust=seed_vc_length_adjust,
                inference_cfg_rate=seed_vc_inference_cfg_rate,
                reference_max_seconds=seed_vc_reference_max_seconds,
            )
        },
    )


def _serialize_pipeline_result(result: PipelineResult) -> dict[str, object]:
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


def _serialize_voice_conversion_result(result: VoiceConversionResult) -> dict[str, object]:
    return {
        "audio_mime_type": result.output_audio_mime_type,
        "audio_base64": base64.b64encode(result.output_audio_bytes).decode("ascii"),
        "timings_ms": result.timings_ms,
        "providers": result.providers,
        "warnings": result.warnings,
    }


def _normalize_tts_provider_output(output: bytes | TtsOutput, audio_mime_type: str) -> TtsOutput:
    if isinstance(output, TtsOutput):
        return TtsOutput(
            audio_bytes=output.audio_bytes,
            audio_mime_type=output.audio_mime_type or audio_mime_type,
            timings_ms=output.timings_ms,
            warnings=output.warnings,
        )
    return TtsOutput(audio_bytes=output, audio_mime_type=audio_mime_type)


def _serialize_tts_output(output: TtsOutput, provider_name: str) -> dict[str, object]:
    return {
        "audio_mime_type": output.audio_mime_type or "audio/wav",
        "audio_base64": base64.b64encode(output.audio_bytes).decode("ascii"),
        "timings_ms": output.timings_ms,
        "providers": {"tts": provider_name},
        "warnings": output.warnings,
    }


def _serialize_audio_history_settings(store: AudioHistoryStore) -> dict[str, object]:
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


def _serialize_audio_history_entry(kind: str, entry: AudioHistoryEntry) -> dict[str, object]:
    metadata = entry.metadata or {}
    text_preview = _metadata_text_preview(metadata)
    details = _audio_history_details(kind, metadata)
    return {
        "kind": kind,
        "filename": entry.audio_path.name,
        "url": f"/api/audio-history/{kind}/{entry.audio_path.name}",
        "label": _audio_history_label(kind, metadata, text_preview),
        "details": details,
        "text_preview": text_preview,
        "media_type": metadata.get("audio_mime_type") or metadata.get("content_type") or _audio_media_type(entry.audio_path),
        "playable_hint": _audio_history_playable_hint(entry, metadata),
        "metadata": metadata,
        "created_at": metadata.get("created_at", ""),
        "size_bytes": metadata.get("size_bytes", entry.audio_path.stat().st_size),
    }


def _history_text_metadata_from_pipeline_result(result: PipelineResult) -> dict[str, str]:
    transformed = _text_preview(result.transformed_text)
    translated = _text_preview(result.translated_text)
    transcript = _text_preview(result.transcript)
    return {
        "text_preview": transformed or translated or transcript,
        "transcript_preview": transcript,
        "translated_text_preview": translated,
        "transformed_text_preview": transformed,
    }


def _history_text_metadata_from_recording_result(result: PipelineResult) -> dict[str, str]:
    transcript = _text_preview(result.transcript)
    return {
        "text_preview": transcript,
        "transcript_preview": transcript,
    }


def _metadata_text_preview(metadata: dict[str, object]) -> str:
    for key in ("text_preview", "transformed_text_preview", "translated_text_preview", "transcript_preview"):
        value = str(metadata.get(key) or "").strip()
        if value:
            return value
    return ""


def _text_preview(text: str, limit: int = 80) -> str:
    preview = " ".join(text.split())
    if len(preview) <= limit:
        return preview
    return f"{preview[: limit - 1]}…"


def _audio_history_label(kind: str, metadata: dict[str, object], text_preview: str) -> str:
    if text_preview:
        return text_preview
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


def _audio_history_details(kind: str, metadata: dict[str, object]) -> list[str]:
    details = [str(metadata.get("endpoint") or kind)]
    route = _audio_history_route(metadata)
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


def _audio_history_route(metadata: dict[str, object]) -> str:
    source_language = str(metadata.get("source_language") or "")
    target_language = str(metadata.get("target_language") or "")
    if source_language and target_language:
        return f"{source_language} -> {target_language}"
    if target_language:
        return target_language
    return ""


def _audio_history_playable_hint(entry: AudioHistoryEntry, metadata: dict[str, object]) -> str:
    size_bytes = int(metadata.get("size_bytes") or entry.audio_path.stat().st_size)
    if size_bytes < 128:
        return "音声ファイルが小さすぎます。テスト用または失敗したダミー出力の可能性があります。"
    return ""


def _audio_media_type(audio_path: Path) -> str:
    guessed, _ = mimetypes.guess_type(str(audio_path))
    return guessed or "application/octet-stream"


def _partial_result_from_pipeline_result(result: PipelineResult) -> dict[str, str]:
    return {
        "transcript": result.transcript,
        "translated_text": result.translated_text,
        "transformed_text": result.transformed_text,
    }


def _planned_stages(pipeline: SpeechTranslationPipeline, request: PipelineRequest) -> list[dict[str, str]]:
    if pipeline.tts.name.startswith("openai-realtime-audio-"):
        return [
            {"stage": "asr", "label": "入力音声送信", "provider": pipeline.asr.name},
            {"stage": "translation", "label": "翻訳", "provider": pipeline.translator.name},
            {"stage": "tts", "label": "翻訳音声受信", "provider": pipeline.tts.name},
        ]
    stages = [
        {"stage": "asr", "label": "文字起こし", "provider": pipeline.asr.name},
        {"stage": "translation", "label": "翻訳", "provider": pipeline.translator.name},
        {"stage": "text_transform", "label": "テキスト加工", "provider": request.text_transform or "なし"},
    ]
    if request.voice_mode == "convert" and pipeline.tts.name in {"qwen3-tts-seed-vc"}:
        stages.extend(
            [
                {"stage": "tts", "label": "音声生成", "provider": "Qwen3-TTS"},
                {"stage": "voice_conversion", "label": "声質変換", "provider": "Seed-VC"},
            ]
        )
    elif request.voice_mode == "convert" and pipeline.tts.name.startswith("openai-tts-seed-vc-"):
        stages.extend(
            [
                {"stage": "tts", "label": "音声生成", "provider": "OpenAI TTS"},
                {"stage": "voice_conversion", "label": "声質変換", "provider": "Seed-VC"},
            ]
        )
    else:
        stages.append({"stage": "tts", "label": "音声生成", "provider": pipeline.tts.name})
    return stages


def _planned_voice_conversion_stages(
    service: VoiceConversionService,
    request: VoiceConversionRequest,
) -> list[dict[str, str]]:
    provider = request.backend_id
    for info in service.backend_infos():
        if info.backend_id == request.backend_id:
            provider = info.provider
            break
    return [
        {"stage": "source_audio_prepare", "label": "変換元音声準備", "provider": "ffmpeg"},
        {"stage": "reference_audio_prepare", "label": "参照音声準備", "provider": "ffmpeg"},
        {"stage": "voice_conversion", "label": "声質変換", "provider": provider},
    ]


def _serialize_progress(progress: PipelineProgress) -> dict[str, str]:
    return {
        "stage": progress.stage,
        "label": progress.label,
        "provider": progress.provider,
    }


def _serialize_partial_result(progress: PipelineProgress) -> dict[str, str]:
    partial_result: dict[str, str] = {}
    if progress.transcript is not None:
        partial_result["transcript"] = progress.transcript
    if progress.translated_text is not None:
        partial_result["translated_text"] = progress.translated_text
    if progress.transformed_text is not None:
        partial_result["transformed_text"] = progress.transformed_text
    return partial_result


def _upload_suffix(filename: str | None) -> str:
    if not filename:
        return ".audio"
    suffix = Path(filename).suffix.lower()
    if not suffix or len(suffix) > 12:
        return ".audio"
    return suffix


def _mime_suffix(audio_mime_type: str | None) -> str:
    if audio_mime_type == "audio/mp4":
        return ".m4a"
    if audio_mime_type == "audio/webm":
        return ".webm"
    if audio_mime_type == "audio/mpeg":
        return ".mp3"
    return ".wav"
