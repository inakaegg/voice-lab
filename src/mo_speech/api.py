from __future__ import annotations

import base64
import os
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock, Thread
from typing import Annotated
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .pipeline import PipelineProgress, PipelineRequest, PipelineResult, SpeechTranslationPipeline
from .providers.fake import FakeAsrProvider, FakeTranslationProvider, FakeTtsProvider
from .providers.voice import (
    SeedVcRuntimeSettings,
    VoiceConversionRequest,
    VoiceConversionResult,
    VoiceConversionService,
    create_voice_conversion_service_from_env,
)

PACKAGE_DIR = Path(__file__).resolve().parent
WEB_DIR = PACKAGE_DIR / "web"


def create_app(
    pipeline: SpeechTranslationPipeline | None = None,
    voice_conversion_service: VoiceConversionService | None = None,
) -> FastAPI:
    app = FastAPI(title="mo speech translation")
    active_pipeline = pipeline or create_pipeline_from_env()
    active_voice_conversion_service = voice_conversion_service or create_voice_conversion_service_from_env()
    job_store = TranslationJobStore(active_pipeline)
    voice_conversion_job_store = VoiceConversionJobStore(active_voice_conversion_service)
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
            "voice_conversion_backends": _voice_conversion_backends(active_voice_conversion_service),
        }

    @app.post("/api/translate-speech")
    async def translate_speech(
        audio: Annotated[UploadFile, File()],
        source_language: Annotated[str, Form()],
        target_language: Annotated[str, Form()],
        voice_mode: Annotated[str, Form()] = "default",
        text_transform: Annotated[str | None, Form()] = None,
        text_transform_suffix: Annotated[str | None, Form()] = None,
        text_transform_unit: Annotated[str, Form()] = "text",
        seed_vc_diffusion_steps: Annotated[int | None, Form()] = None,
        seed_vc_length_adjust: Annotated[float | None, Form()] = None,
        seed_vc_inference_cfg_rate: Annotated[float | None, Form()] = None,
        seed_vc_reference_max_seconds: Annotated[float | None, Form()] = None,
    ) -> dict[str, object]:
        with NamedTemporaryFile(suffix=_upload_suffix(audio.filename)) as temp_audio:
            temp_audio.write(await audio.read())
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
                result = active_pipeline.run(request)
            except (FileNotFoundError, ValueError) as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except RuntimeError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc

        return _serialize_pipeline_result(result)

    @app.post("/api/translate-speech-jobs")
    async def create_translate_speech_job(
        audio: Annotated[UploadFile, File()],
        source_language: Annotated[str, Form()],
        target_language: Annotated[str, Form()],
        voice_mode: Annotated[str, Form()] = "default",
        text_transform: Annotated[str | None, Form()] = None,
        text_transform_suffix: Annotated[str | None, Form()] = None,
        text_transform_unit: Annotated[str, Form()] = "text",
        seed_vc_diffusion_steps: Annotated[int | None, Form()] = None,
        seed_vc_length_adjust: Annotated[float | None, Form()] = None,
        seed_vc_inference_cfg_rate: Annotated[float | None, Form()] = None,
        seed_vc_reference_max_seconds: Annotated[float | None, Form()] = None,
    ) -> dict[str, object]:
        with NamedTemporaryFile(suffix=_upload_suffix(audio.filename), delete=False) as temp_audio:
            temp_audio.write(await audio.read())
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
        return job_store.start(request, audio_path)

    @app.get("/api/translate-speech-jobs/{job_id}")
    def get_translate_speech_job(job_id: str) -> dict[str, object]:
        try:
            return job_store.snapshot(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="job not found") from exc

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
        with NamedTemporaryFile(suffix=_upload_suffix(source_audio.filename), delete=False) as temp_source:
            temp_source.write(await source_audio.read())
            temp_source.flush()
            source_audio_path = Path(temp_source.name)

        with NamedTemporaryFile(suffix=_upload_suffix(reference_audio.filename), delete=False) as temp_reference:
            temp_reference.write(await reference_audio.read())
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
    pipeline: SpeechTranslationPipeline
    jobs: dict[str, TranslationJob] = field(default_factory=dict)
    lock: Lock = field(default_factory=Lock)

    def start(self, request: PipelineRequest, audio_path: Path) -> dict[str, object]:
        job = TranslationJob(
            job_id=uuid4().hex,
            status="queued",
            stages=_planned_stages(self.pipeline, request),
        )
        with self.lock:
            self.jobs[job.job_id] = job
        thread = Thread(target=self._run_job, args=(job.job_id, request, audio_path), daemon=True)
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

    def _run_job(self, job_id: str, request: PipelineRequest, audio_path: Path) -> None:
        try:
            with self.lock:
                self.jobs[job_id].status = "running"

            def report_progress(progress: PipelineProgress) -> None:
                self._update_progress(job_id, progress)

            result = self.pipeline.run(request, progress_callback=report_progress)
            with self.lock:
                job = self.jobs[job_id]
                job.status = "succeeded"
                job.result = _serialize_pipeline_result(result)
                job.partial_result = _partial_result_from_pipeline_result(result)
                job.current_stage = {"stage": "complete", "label": "完了", "provider": ""}
        except (FileNotFoundError, ValueError, RuntimeError) as exc:
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
            with self.lock:
                job = self.jobs[job_id]
                job.status = "succeeded"
                job.result = _serialize_voice_conversion_result(result)
                job.current_stage = {"stage": "complete", "label": "完了", "provider": ""}
        except (FileNotFoundError, ValueError, RuntimeError) as exc:
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


def create_pipeline_from_env() -> SpeechTranslationPipeline:
    if os.getenv("MO_PROVIDER_MODE") == "local":
        return create_local_pipeline()
    return create_demo_pipeline()


def create_demo_pipeline() -> SpeechTranslationPipeline:
    return SpeechTranslationPipeline(
        asr=FakeAsrProvider(
            {
                "id-ID": "Selamat pagi. Terima kasih.",
                "ja-JP": "ありがとう。",
            }
        ),
        translator=FakeTranslationProvider(
            {
                ("id-ID", "ja-JP", "Selamat pagi. Terima kasih."): "おはようございます。ありがとうございます。",
                ("ja-JP", "zh-CN", "ありがとう。"): "谢谢。",
            }
        ),
        tts=FakeTtsProvider(),
    )


def create_local_pipeline() -> SpeechTranslationPipeline:
    from .providers.local import create_local_asr_provider, create_local_translation_provider, create_local_tts_provider

    return SpeechTranslationPipeline(
        asr=create_local_asr_provider(),
        translator=create_local_translation_provider(),
        tts=create_local_tts_provider(),
    )


app = create_app()


def _provider_names(pipeline: SpeechTranslationPipeline) -> dict[str, str]:
    return {
        "asr": pipeline.asr.name,
        "translation": pipeline.translator.name,
        "tts": pipeline.tts.name,
    }


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


def _partial_result_from_pipeline_result(result: PipelineResult) -> dict[str, str]:
    return {
        "transcript": result.transcript,
        "translated_text": result.translated_text,
        "transformed_text": result.transformed_text,
    }


def _planned_stages(pipeline: SpeechTranslationPipeline, request: PipelineRequest) -> list[dict[str, str]]:
    stages = [
        {"stage": "asr", "label": "文字起こし", "provider": pipeline.asr.name},
        {"stage": "translation", "label": "翻訳", "provider": pipeline.translator.name},
        {"stage": "text_transform", "label": "テキスト加工", "provider": request.text_transform or "なし"},
    ]
    if request.voice_mode == "convert" and pipeline.tts.name == "qwen3-tts-seed-vc":
        stages.extend(
            [
                {"stage": "tts", "label": "音声生成", "provider": "Qwen3-TTS"},
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
