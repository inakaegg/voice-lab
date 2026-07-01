from __future__ import annotations

import base64
import inspect
import logging
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from threading import Event, Lock, Thread
from tempfile import TemporaryDirectory
from time import perf_counter
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
from .audio_effects import insert_audio_effect
from .audio_history import AudioHistoryEntry, AudioHistoryStore
from .pipeline import PipelineProgress, PipelineRequest, SpeechTranslationPipeline
from .providers.voice import VoiceConversionRequest, VoiceConversionResult, VoiceConversionService
from .vibevoice import VibeVoiceGenerationOptions, VibeVoiceGenerator, VibeVoiceResult, VibeVoiceVoiceSample

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
            if request.audio_effect_path is not None:
                self._update_progress(
                    job_id,
                    PipelineProgress("audio_effect_insert", "効果音挿入", "ffmpeg"),
                )
                result = _insert_audio_effect_for_voice_result(result, request)
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


@dataclass
class VibeVoiceJob:
    job_id: str
    status: str
    stages: list[dict[str, str]]
    temp_dir: Path
    cancel_event: Event
    current_stage: dict[str, str] | None = None
    result: dict[str, object] | None = None
    error: str | None = None
    cancel_requested: bool = False
    started_at: float | None = None
    finished_at: float | None = None
    progress_log: list[dict[str, str]] = field(default_factory=list)


@dataclass
class VibeVoiceJobStore:
    jobs: dict[str, VibeVoiceJob] = field(default_factory=dict)
    lock: Lock = field(default_factory=Lock)

    def start(
        self,
        *,
        generator: VibeVoiceGenerator,
        script_text: str,
        voice_paths: list[VibeVoiceVoiceSample],
        options: VibeVoiceGenerationOptions,
        temp_dir: Path,
    ) -> dict[str, object]:
        job = VibeVoiceJob(
            job_id=uuid4().hex,
            status="queued",
            stages=[{"stage": "generation", "label": "VibeVoice生成", "provider": ""}],
            temp_dir=temp_dir,
            cancel_event=Event(),
        )
        with self.lock:
            self.jobs[job.job_id] = job
        thread = Thread(
            target=self._run_job,
            args=(job.job_id, generator, script_text, voice_paths, options),
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
                "result": job.result,
                "error": job.error,
                "cancel_requested": job.cancel_requested,
                "elapsed_ms": _elapsed_vibevoice_job_ms(job),
                "progress_log": list(job.progress_log),
            }

    def cancel(self, job_id: str) -> dict[str, object]:
        with self.lock:
            job = self.jobs[job_id]
            job.cancel_requested = True
            job.cancel_event.set()
            if job.status in {"queued", "running"}:
                job.status = "cancelling"
                job.current_stage = {"stage": "cancel", "label": "キャンセル中", "provider": ""}
                job.progress_log.append(job.current_stage)
        return self.snapshot(job_id)

    def _run_job(
        self,
        job_id: str,
        generator: VibeVoiceGenerator,
        script_text: str,
        voice_paths: list[VibeVoiceVoiceSample],
        options: VibeVoiceGenerationOptions,
    ) -> None:
        try:
            with self.lock:
                job = self.jobs[job_id]
                if job.cancel_event.is_set():
                    job.status = "cancelled"
                    job.finished_at = perf_counter()
                    return
                job.status = "running"
                job.started_at = perf_counter()
                job.current_stage = {"stage": "generation", "label": "VibeVoice生成", "provider": ""}
                job.progress_log.append(job.current_stage)

            def report_progress(stage: str, label: str, provider: str = "") -> None:
                self._update_progress(job_id, stage, label, provider)

            result = _generate_vibevoice_with_optional_hooks(
                generator,
                script_text=script_text,
                voice_paths=voice_paths,
                options=options,
                progress_callback=report_progress,
                cancel_event=self.jobs[job_id].cancel_event,
            )
            with self.lock:
                job = self.jobs[job_id]
                job.status = "cancelled" if job.cancel_event.is_set() else "succeeded"
                job.result = None if job.status == "cancelled" else _serialize_vibevoice_result(result)
                job.current_stage = {"stage": "complete", "label": "完了", "provider": ""}
                job.progress_log.append(job.current_stage)
                job.finished_at = perf_counter()
        except Exception as exc:
            LOGGER.exception("VibeVoice job failed: job_id=%s", job_id)
            with self.lock:
                job = self.jobs[job_id]
                job.status = "cancelled" if job.cancel_event.is_set() else "failed"
                job.error = str(exc)
                if job.status == "failed":
                    job.current_stage = {"stage": "failed", "label": "失敗", "provider": ""}
                    job.progress_log.append(job.current_stage)
                job.finished_at = perf_counter()
        finally:
            with self.lock:
                temp_dir = self.jobs[job_id].temp_dir
            shutil.rmtree(temp_dir, ignore_errors=True)

    def _update_progress(self, job_id: str, stage: str, label: str, provider: str = "") -> None:
        item = {"stage": stage, "label": label, "provider": provider}
        with self.lock:
            job = self.jobs[job_id]
            job.current_stage = item
            if not job.progress_log or job.progress_log[-1] != item:
                job.progress_log.append(item)
                del job.progress_log[:-80]
            for index, existing in enumerate(job.stages):
                if existing["stage"] == stage:
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
    elif request.voice_mode == "convert" and pipeline.tts.name == "runpod-serverless-tts":
        stages.extend(
            [
                {"stage": "tts", "label": "音声生成", "provider": "RunPod Serverless"},
                {"stage": "voice_conversion", "label": "声質変換", "provider": "RunPod Serverless"},
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
        *(
            [{"stage": "audio_effect_insert", "label": "効果音挿入", "provider": "ffmpeg"}]
            if request.audio_effect_path is not None
            else []
        ),
    ]


def _insert_audio_effect_for_voice_result(
    result: VoiceConversionResult,
    request: VoiceConversionRequest,
) -> VoiceConversionResult:
    if request.audio_effect_path is None:
        return result
    with TemporaryDirectory() as temp_dir_raw:
        temp_dir = Path(temp_dir_raw)
        main_audio_path = temp_dir / f"voice-output{mime_suffix(result.output_audio_mime_type)}"
        output_path = temp_dir / "voice-output-with-effect.wav"
        main_audio_path.write_bytes(result.output_audio_bytes)
        effect_result = insert_audio_effect(
            main_audio_path,
            request.audio_effect_path,
            output_path,
            settings=request.audio_effect_settings,
        )
    return VoiceConversionResult(
        output_audio_bytes=effect_result.audio_bytes,
        output_audio_mime_type=effect_result.audio_mime_type,
        timings_ms={
            **result.timings_ms,
            **effect_result.timings_ms,
        },
        providers={
            **result.providers,
            "audio_effect_insert": "ffmpeg",
        },
        warnings=[
            *result.warnings,
            *effect_result.warnings,
        ],
    )


def _generate_vibevoice_with_optional_hooks(
    generator: VibeVoiceGenerator,
    *,
    script_text: str,
    voice_paths: list[VibeVoiceVoiceSample],
    options: VibeVoiceGenerationOptions,
    progress_callback,
    cancel_event: Event,
) -> VibeVoiceResult:
    kwargs = {
        "script_text": script_text,
        "voice_paths": voice_paths,
        "options": options,
    }
    parameters = inspect.signature(generator.generate).parameters
    if "progress_callback" in parameters:
        kwargs["progress_callback"] = progress_callback
    if "cancel_event" in parameters:
        kwargs["cancel_event"] = cancel_event
    return generator.generate(**kwargs)


def _serialize_vibevoice_result(result: VibeVoiceResult) -> dict[str, object]:
    return {
        "audio_mime_type": result.audio_mime_type,
        "audio_base64": base64.b64encode(result.audio_bytes).decode("ascii"),
        "normalized_script": result.normalized_script,
        "providers": result.providers,
        "timings_ms": result.timings_ms,
        "diagnostics": result.diagnostics,
    }


def _elapsed_vibevoice_job_ms(job: VibeVoiceJob) -> float:
    if job.started_at is None:
        return 0.0
    ended = job.finished_at if job.finished_at is not None else perf_counter()
    return max(0.0, (ended - job.started_at) * 1000)
