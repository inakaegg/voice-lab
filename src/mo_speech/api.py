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

PACKAGE_DIR = Path(__file__).resolve().parent
WEB_DIR = PACKAGE_DIR / "web"


def create_app(pipeline: SpeechTranslationPipeline | None = None) -> FastAPI:
    app = FastAPI(title="mo speech translation")
    active_pipeline = pipeline or create_pipeline_from_env()
    job_store = TranslationJobStore(active_pipeline)
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
        )
        return job_store.start(request, audio_path)

    @app.get("/api/translate-speech-jobs/{job_id}")
    def get_translate_speech_job(job_id: str) -> dict[str, object]:
        try:
            return job_store.snapshot(job_id)
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


def _create_pipeline_request(
    audio_path: Path,
    source_language: str,
    target_language: str,
    voice_mode: str,
    text_transform: str | None,
    text_transform_suffix: str | None,
    text_transform_unit: str,
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
