from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock, Thread
from uuid import uuid4

from .api_audio_history import (
    history_text_metadata_from_pipeline_result,
    history_text_metadata_from_recording_result,
    mime_suffix,
)
from .api_runtime import select_translation_pipeline
from .api_serializers import (
    normalize_tts_provider_output,
    partial_result_from_pipeline_result,
    serialize_partial_result,
    serialize_pipeline_result,
    serialize_progress,
    serialize_tts_output,
    serialize_voice_conversion_result,
    text_preview,
)
from .audio_history import AudioHistoryEntry, AudioHistoryStore
from .pipeline import PipelineProgress, PipelineRequest, SpeechTranslationPipeline
from .providers.voice import VoiceConversionRequest, VoiceConversionResult, VoiceConversionService

LOGGER = logging.getLogger("mo_speech")


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
        pipeline = select_translation_pipeline(self.pipelines, translation_backend)
        job = TranslationJob(
            job_id=uuid4().hex,
            status="queued",
            stages=planned_stages(pipeline, request),
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

            result = select_translation_pipeline(self.pipelines, translation_backend).run(
                request,
                progress_callback=report_progress,
            )
            self.audio_history_store.update_metadata(
                recording_entry,
                history_text_metadata_from_recording_result(result),
            )
            self.audio_history_store.save_output(
                result.output_audio_bytes,
                suffix=mime_suffix(result.output_audio_mime_type),
                metadata={
                    "endpoint": "translate-speech-jobs",
                    "job_id": job_id,
                    "translation_backend": translation_backend,
                    "source_language": request.source_language,
                    "target_language": result.target_language or request.target_language,
                    "voice_mode": request.voice_mode,
                    "audio_mime_type": result.output_audio_mime_type,
                    **history_text_metadata_from_pipeline_result(result),
                },
            )
            with self.lock:
                job = self.jobs[job_id]
                job.status = "succeeded"
                job.result = serialize_pipeline_result(result)
                job.partial_result = partial_result_from_pipeline_result(result)
                job.current_stage = {"stage": "complete", "label": "完了", "provider": ""}
        except Exception as exc:
            LOGGER.exception("translation job failed: backend=%s job_id=%s", translation_backend, job_id)
            with self.lock:
                job = self.jobs[job_id]
                job.status = "failed"
                job.error = str(exc)
        finally:
            audio_path.unlink(missing_ok=True)

    def _update_progress(self, job_id: str, progress: PipelineProgress) -> None:
        item = serialize_progress(progress)
        partial_result = serialize_partial_result(progress)
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

            output = normalize_tts_provider_output(provider.synthesize(text, target_language), provider.audio_mime_type)
            self.audio_history_store.save_output(
                output.audio_bytes,
                suffix=mime_suffix(output.audio_mime_type),
                metadata={
                    "endpoint": "text-to-speech-jobs",
                    "job_id": job_id,
                    "tts_backend": tts_backend,
                    "target_language": target_language,
                    "audio_mime_type": output.audio_mime_type,
                    "text_preview": text_preview(text),
                    "tts_text": text,
                },
            )
            with self.lock:
                job = self.jobs[job_id]
                job.status = "succeeded"
                job.result = serialize_tts_output(output, provider.name)
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
            stages=planned_voice_conversion_stages(self.service, request),
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

            result: VoiceConversionResult = self.service.convert(request, progress_callback=report_progress)
            self.audio_history_store.save_output(
                result.output_audio_bytes,
                suffix=mime_suffix(result.output_audio_mime_type),
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
                job.result = serialize_voice_conversion_result(result)
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
        item = serialize_progress(progress)
        with self.lock:
            job = self.jobs[job_id]
            job.current_stage = item
            for index, stage in enumerate(job.stages):
                if stage["stage"] == item["stage"]:
                    job.stages[index] = item
                    break
            else:
                job.stages.append(item)


def planned_stages(pipeline: SpeechTranslationPipeline, request: PipelineRequest) -> list[dict[str, str]]:
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


def planned_voice_conversion_stages(
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
