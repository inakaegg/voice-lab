from __future__ import annotations

import base64
import json
import mimetypes
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from time import perf_counter
from typing import Any, Callable

from ..env import load_runpod_gateway_env
from ..pipeline import (
    PipelineProgress,
    PipelineRequest,
    PipelineResult,
    ProgressCallback,
    SpeechTranslationPipeline,
    TtsOutput,
)
from .openai_api import (
    OPENAI_SPEECH_TRANSLATION_SOURCE_LANGUAGES,
    OPENAI_SPEECH_TRANSLATION_TARGET_LANGUAGES,
    AsrTranscription,
)
from .voice import SeedVcRuntimeSettings, VoiceConversionBackendInfo


RUNPOD_API_BASE_URL = "https://api.runpod.ai/v2"
RUNPOD_TERMINAL_FAILURE_STATES = {"FAILED", "CANCELLED", "TIMED_OUT"}
RUNPOD_IN_PROGRESS_STATES = {"IN_QUEUE", "IN_PROGRESS", "RUNNING"}


def _runpod_env(name: str, default: str = "") -> str:
    load_runpod_gateway_env()
    return os.getenv(name, default)


@dataclass
class RunpodServerlessClient:
    endpoint_id: str = field(default_factory=lambda: _runpod_env("RUNPOD_ENDPOINT_ID", ""))
    api_key: str = field(default_factory=lambda: _runpod_env("RUNPOD_API_KEY", ""))
    request_mode: str = field(default_factory=lambda: _runpod_env("RUNPOD_SERVERLESS_REQUEST_MODE", "async"))
    timeout_seconds: float = field(
        default_factory=lambda: float(_runpod_env("RUNPOD_SERVERLESS_TIMEOUT_SECONDS", "1800"))
    )
    poll_interval_seconds: float = field(
        default_factory=lambda: float(_runpod_env("RUNPOD_SERVERLESS_POLL_INTERVAL_SECONDS", "1.0"))
    )
    base_url: str = field(default_factory=lambda: _runpod_env("RUNPOD_API_BASE_URL", RUNPOD_API_BASE_URL))

    @classmethod
    def from_env(cls) -> "RunpodServerlessClient":
        return cls()

    @property
    def configured(self) -> bool:
        return bool(self.endpoint_id and self.api_key)

    def submit(
        self,
        input_payload: dict[str, object],
        *,
        progress_callback: Callable[[dict[str, object]], None] | None = None,
    ) -> dict[str, object]:
        if not self.configured:
            raise RuntimeError("RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY are required for RunPod Serverless backend.")
        if self.request_mode == "sync":
            body = self._request_json(
                    "/runsync",
                    method="POST",
                    payload=self._request_payload(input_payload),
                    timeout_seconds=self.timeout_seconds,
                )
            _notify_runpod_status(progress_callback, body)
            return self._completed_output(body)
        body = self._request_json(
            "/run",
            method="POST",
            payload=self._request_payload(input_payload),
            timeout_seconds=self.timeout_seconds,
        )
        _notify_runpod_status(progress_callback, body)
        return self._poll_output(body, progress_callback=progress_callback)

    def submit_sync(self, input_payload: dict[str, object]) -> dict[str, object]:
        if not self.configured:
            raise RuntimeError("RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY are required for RunPod Serverless backend.")
        return self._completed_output(
            self._request_json(
                "/runsync",
                method="POST",
                payload=self._request_payload(input_payload),
                timeout_seconds=self.timeout_seconds,
            )
        )

    def submit_job(self, input_payload: dict[str, object]) -> dict[str, object]:
        """Submit a RunPod job without polling it in this process."""
        if not self.configured:
            raise RuntimeError("RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY are required for RunPod Serverless backend.")
        return self._request_json(
            "/run",
            method="POST",
            payload=self._request_payload(input_payload),
            timeout_seconds=self.timeout_seconds,
        )

    def job_status(self, job_id: str) -> dict[str, object]:
        if not self.configured:
            raise RuntimeError("RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY are required for RunPod Serverless backend.")
        normalized_job_id = str(job_id or "").strip()
        if not normalized_job_id:
            raise ValueError("job_id is required")
        return self._request_json(
            f"/status/{urllib.parse.quote(normalized_job_id, safe='')}",
            timeout_seconds=self.timeout_seconds,
        )

    def warmup(self, input_payload: dict[str, object] | None = None) -> dict[str, object]:
        return self.submit({"operation_mode": "warmup", **(input_payload or {})})

    def health(self) -> dict[str, object]:
        if not self.configured:
            raise RuntimeError("RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY are required for RunPod Serverless health.")
        return self._request_json(
            "/health",
            timeout_seconds=float(os.getenv("RUNPOD_SERVERLESS_HEALTH_TIMEOUT_SECONDS", "3")),
        )

    def _request_payload(self, input_payload: dict[str, object]) -> dict[str, object]:
        return {"input": input_payload}

    def _poll_output(
        self,
        body: dict[str, object],
        *,
        progress_callback: Callable[[dict[str, object]], None] | None = None,
    ) -> dict[str, object]:
        job_id = str(body.get("id") or body.get("job_id") or "")
        if not job_id:
            return self._completed_output(body)
        deadline = perf_counter() + self.timeout_seconds
        first_poll = True
        while True:
            if not first_poll:
                time.sleep(self.poll_interval_seconds)
            first_poll = False
            status_body = self._request_json(f"/status/{job_id}", timeout_seconds=self.timeout_seconds)
            _notify_runpod_status(progress_callback, status_body)
            status = str(status_body.get("status", "")).upper()
            if status == "COMPLETED":
                return self._completed_output(status_body)
            if status in RUNPOD_TERMINAL_FAILURE_STATES:
                raise RuntimeError(_runpod_error_message(status_body, job_id=job_id))
            if status and status not in RUNPOD_IN_PROGRESS_STATES:
                raise RuntimeError(f"unexpected RunPod job status: {status}")
            if perf_counter() >= deadline:
                raise RuntimeError(f"RunPod job timed out after {self.timeout_seconds}s: {job_id}")

    def _completed_output(self, body: dict[str, object]) -> dict[str, object]:
        status = str(body.get("status", "")).upper()
        if status in RUNPOD_TERMINAL_FAILURE_STATES:
            raise RuntimeError(_runpod_error_message(body))
        output = body.get("output")
        if output is None and _looks_like_handler_output(body):
            output = body
        if not isinstance(output, dict):
            if status == "COMPLETED":
                raise RuntimeError(
                    "RunPod job completed but did not return an output object. "
                    "The worker may have failed to return job results, often because the response payload was too large. "
                    "Check worker logs for 'Failed to return job results'."
                )
            raise RuntimeError("RunPod response did not include an object output")
        return output

    def _request_json(
        self,
        path: str,
        *,
        method: str = "GET",
        payload: object | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, object]:
        url = f"{self.base_url.rstrip('/')}/{self.endpoint_id}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            url,
            data=data,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds or self.timeout_seconds) as response:
                body = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            exc.read()
            raise RuntimeError(f"RunPod request failed with HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError("RunPod request failed before receiving a response") from exc
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError as exc:
            raise RuntimeError("RunPod response was not valid JSON") from exc
        if not isinstance(parsed, dict):
            raise RuntimeError("RunPod response was not a JSON object")
        return parsed


class RunpodServerlessSpeechTranslationPipeline(SpeechTranslationPipeline):
    def __init__(
        self,
        *,
        client: RunpodServerlessClient | None = None,
        internal_translation_backend: str | None = None,
    ) -> None:
        self.client = client or RunpodServerlessClient.from_env()
        load_runpod_gateway_env()
        self.internal_translation_backend = internal_translation_backend or os.getenv(
            "RUNPOD_SERVERLESS_TRANSLATION_BACKEND",
            "openai",
        )
        super().__init__(
            asr=_RunpodProvider("runpod-serverless-asr"),
            translator=_RunpodProvider("runpod-serverless-translation"),
            tts=_RunpodTtsProvider(),
        )

    def preload(self) -> None:
        self.client.warmup({"translation_backend": self.internal_translation_backend})

    def run(self, request: PipelineRequest, progress_callback: ProgressCallback | None = None) -> PipelineResult:
        if not request.audio_path.exists():
            raise FileNotFoundError(f"audio file does not exist: {request.audio_path}")
        _notify(progress_callback, "asr", "RunPod送信", self.asr.name)
        started = perf_counter()
        output = self.client.submit(_translation_input_payload(request, self.internal_translation_backend))
        result = _pipeline_result_from_output(output)
        timings_ms = dict(result.timings_ms)
        timings_ms.setdefault("runpod_roundtrip", _elapsed_ms(started))
        _notify(
            progress_callback,
            "tts",
            "RunPod推論",
            self.tts.name,
            transcript=result.transcript,
            translated_text=result.translated_text,
            transformed_text=result.transformed_text,
        )
        return PipelineResult(
            transcript=result.transcript,
            translated_text=result.translated_text,
            transformed_text=result.transformed_text,
            output_audio_bytes=result.output_audio_bytes,
            output_audio_mime_type=result.output_audio_mime_type,
            timings_ms=timings_ms,
            providers=result.providers,
            warnings=result.warnings,
            target_language=result.target_language,
        )


@dataclass
class RunpodServerlessVoiceConversionProvider:
    client: RunpodServerlessClient = field(default_factory=RunpodServerlessClient.from_env)

    backend_id = "seed-vc"
    label = "Seed-VC (RunPod Serverless)"
    name = "runpod-serverless-seed-vc"
    audio_mime_type = "audio/wav"

    def backend_info(self) -> VoiceConversionBackendInfo:
        if not self.client.configured:
            return VoiceConversionBackendInfo(
                self.backend_id,
                self.label,
                self.name,
                False,
                "RUNPOD_ENDPOINT_ID または RUNPOD_API_KEY が設定されていません。",
                settings={"serverless": True},
            )
        return VoiceConversionBackendInfo(
            self.backend_id,
            self.label,
            self.name,
            True,
            settings={"serverless": True},
        )

    def convert(
        self,
        *,
        source_audio_path: Path,
        reference_audio_path: Path,
        seed_vc_settings: SeedVcRuntimeSettings | None = None,
        progress_callback: ProgressCallback | None = None,
    ) -> TtsOutput:
        def report_runpod_progress(body: dict[str, object]) -> None:
            progress = _runpod_voice_conversion_progress(body)
            if progress_callback is not None and progress is not None:
                progress_callback(progress)

        output = self.client.submit(
            {
                "operation_mode": "voice_conversion",
                "source_audio_base64": base64.b64encode(source_audio_path.read_bytes()).decode("ascii"),
                "source_audio_mime_type": _audio_mime_type(source_audio_path),
                "reference_audio_base64": base64.b64encode(reference_audio_path.read_bytes()).decode("ascii"),
                "reference_audio_mime_type": _audio_mime_type(reference_audio_path),
                "voice_backend": "seed-vc",
                **_seed_vc_payload(seed_vc_settings),
            },
            progress_callback=report_runpod_progress,
        )
        return _tts_output_from_output(output)


@dataclass
class RunpodServerlessPracticeAsrProvider:
    client: RunpodServerlessClient = field(default_factory=RunpodServerlessClient.from_env)

    name = "runpod-funasr-paraformer-zh"

    def transcribe(self, audio_path: Path, source_language: str) -> str:
        return self.transcribe_detail(audio_path, source_language).text

    def transcribe_detail(
        self,
        audio_path: Path,
        source_language: str,
        *,
        include_timestamps: bool = False,
    ) -> AsrTranscription:
        if source_language != "zh-CN":
            raise ValueError("RunPod FunASR practice ASR only supports zh-CN")
        output = self.client.submit_sync(
            {
                "operation_mode": "practice_asr",
                "source_language": source_language,
                "audio_mime_type": _audio_mime_type(audio_path),
                "audio_base64": base64.b64encode(audio_path.read_bytes()).decode("ascii"),
            }
        )
        return AsrTranscription(
            text=str(output.get("text") or "").strip(),
            model=str(output.get("model") or "funasr/paraformer-zh"),
            words=_asr_timing_rows(output.get("words")),
            segments=_asr_timing_rows(output.get("segments")),
            timestamp_granularities=_string_list(output.get("timestamp_granularities")),
        )

    def submit_comparison_job(
        self,
        *,
        attempt_audio_path: Path,
        model_audio_path: Path | None,
        source_language: str,
        target_text: str,
    ) -> dict[str, object]:
        """model_audio_pathがNoneの場合、お手本音声をjobへ含めない。呼び出し側が
        お手本音声のASR結果を既にキャッシュ済みと判断した場合に使う。RunPod側の
        handler(_handle_practice_asr)はmodel_audio_base64が無ければお手本側の
        FunASR推論をスキップし、応答にmodel_transcriptionを含めない。"""
        if source_language != "zh-CN":
            raise ValueError("RunPod FunASR practice ASR only supports zh-CN")
        payload: dict[str, object] = {
            "operation_mode": "practice_asr",
            "source_language": source_language,
            "target_text": str(target_text or ""),
            "audio_mime_type": _audio_mime_type(attempt_audio_path),
            "audio_base64": base64.b64encode(attempt_audio_path.read_bytes()).decode("ascii"),
        }
        if model_audio_path is not None:
            payload["model_audio_mime_type"] = _audio_mime_type(model_audio_path)
            payload["model_audio_base64"] = base64.b64encode(model_audio_path.read_bytes()).decode("ascii")
        return self.client.submit_job(payload)

    def job_status(self, job_id: str) -> dict[str, object]:
        return self.client.job_status(job_id)

    def health(self) -> dict[str, object]:
        return self.client.health()


def create_runpod_serverless_pipeline() -> RunpodServerlessSpeechTranslationPipeline:
    return RunpodServerlessSpeechTranslationPipeline()


def runpod_serverless_pipeline_status(
    pipeline: RunpodServerlessSpeechTranslationPipeline | None = None,
    *,
    client: RunpodServerlessClient | None = None,
) -> dict[str, object]:
    if client is not None:
        active_client = client
    elif pipeline is not None:
        active_client = pipeline.client
    else:
        active_client = RunpodServerlessClient.from_env()
    available = active_client.configured
    reason = "" if available else "RUNPOD_ENDPOINT_ID または RUNPOD_API_KEY が設定されていません。"
    settings = {
        "source_language_mode": "specified_or_auto",
        "supported_source_languages": list(OPENAI_SPEECH_TRANSLATION_SOURCE_LANGUAGES),
        "supported_target_languages": list(OPENAI_SPEECH_TRANSLATION_TARGET_LANGUAGES),
        "supported_voice_modes": ["default", "convert"],
        "text_transform": True,
        "serverless": True,
        "request_mode": active_client.request_mode,
        "internal_translation_backend": (
            pipeline.internal_translation_backend if pipeline is not None else os.getenv("RUNPOD_SERVERLESS_TRANSLATION_BACKEND", "openai")
        ),
        "health": {"checked": False, "warm": False, "worker_counts": {}},
    }
    if available and os.getenv("RUNPOD_SERVERLESS_HEALTH_CHECK", "1") != "0":
        try:
            settings["health"] = _health_summary(active_client.health())
        except RuntimeError as exc:
            settings["health"] = {
                "checked": True,
                "warm": False,
                "worker_counts": {},
                "error": str(exc),
            }
    return {
        "id": "runpod_serverless",
        "label": "音声翻訳（RunPod Serverless）",
        "available": available,
        "reason": reason,
        "providers": {
            "asr": "runpod-serverless-asr",
            "translation": "runpod-serverless-translation",
            "tts": "runpod-serverless-tts",
        },
        "settings": settings,
    }


def _translation_input_payload(request: PipelineRequest, internal_translation_backend: str) -> dict[str, object]:
    return {
        "operation_mode": "translation",
        "audio_base64": base64.b64encode(request.audio_path.read_bytes()).decode("ascii"),
        "audio_mime_type": _audio_mime_type(request.audio_path),
        "translation_backend": internal_translation_backend,
        "source_language": request.source_language,
        "target_language": request.target_language,
        "voice_mode": request.voice_mode,
        "text_transform": request.text_transform,
        "text_transform_options": dict(request.text_transform_options),
        **_seed_vc_payload(request.voice_settings.get("seed_vc")),
    }


def _pipeline_result_from_output(output: dict[str, object]) -> PipelineResult:
    audio_base64 = output.get("audio_base64")
    if not isinstance(audio_base64, str) or not audio_base64:
        raise RuntimeError("RunPod output did not include audio_base64")
    timings_ms = _timings_from_output(output)
    return PipelineResult(
        transcript=str(output.get("transcript", "")),
        translated_text=str(output.get("translated_text", "")),
        transformed_text=str(output.get("transformed_text", output.get("translated_text", ""))),
        output_audio_bytes=base64.b64decode(audio_base64),
        output_audio_mime_type=str(output.get("audio_mime_type", "audio/wav")),
        timings_ms=timings_ms,
        providers=_string_dict(output.get("providers")),
        warnings=_string_list(output.get("warnings")),
        target_language=str(output.get("target_language", "")),
    )


def _tts_output_from_output(output: dict[str, object]) -> TtsOutput:
    audio_base64 = output.get("audio_base64")
    if not isinstance(audio_base64, str) or not audio_base64:
        raise RuntimeError("RunPod output did not include audio_base64")
    return TtsOutput(
        audio_bytes=base64.b64decode(audio_base64),
        audio_mime_type=str(output.get("audio_mime_type", "audio/wav")),
        timings_ms=_timings_from_output(output),
        warnings=_string_list(output.get("warnings")),
    )


def _timings_from_output(output: dict[str, object]) -> dict[str, float]:
    timings_ms = _float_dict(output.get("timings_ms"))
    for key, value in _float_dict(output.get("serverless_timings_ms")).items():
        timings_ms[f"runpod_{key}"] = value
    return timings_ms


def _seed_vc_payload(settings: object) -> dict[str, object]:
    if settings is None:
        return {}
    return {
        key: value
        for key, value in {
            "seed_vc_diffusion_steps": getattr(settings, "diffusion_steps", None),
            "seed_vc_length_adjust": getattr(settings, "length_adjust", None),
            "seed_vc_inference_cfg_rate": getattr(settings, "inference_cfg_rate", None),
            "seed_vc_reference_max_seconds": getattr(settings, "reference_max_seconds", None),
            "seed_vc_reference_auto_select": getattr(settings, "reference_auto_select", None),
        }.items()
        if value is not None
    }


def _health_summary(body: dict[str, object]) -> dict[str, object]:
    worker_counts = _worker_counts(body.get("workers"))
    warm = any(worker_counts.get(state, 0) > 0 for state in ("IDLE", "RUNNING", "READY", "INITIALIZED"))
    return {
        "checked": True,
        "warm": warm,
        "worker_counts": worker_counts,
    }


def _worker_counts(workers: object) -> dict[str, int]:
    counts: dict[str, int] = {}
    if isinstance(workers, dict):
        for key, value in workers.items():
            if isinstance(value, int | float):
                counts[str(key).upper()] = int(value)
        return counts
    if isinstance(workers, list):
        for worker in workers:
            if not isinstance(worker, dict):
                continue
            state = str(worker.get("state") or worker.get("status") or "UNKNOWN").upper()
            counts[state] = counts.get(state, 0) + 1
    return counts


def _audio_mime_type(path: Path) -> str:
    if path.suffix.lower() == ".webm":
        return "audio/webm"
    return mimetypes.guess_type(path.name)[0] or "audio/wav"


def _looks_like_handler_output(body: dict[str, object]) -> bool:
    return any(key in body for key in ("audio_base64", "transcript", "translated_text", "warm"))


def _string_dict(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(key): str(item) for key, item in value.items()}


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value]


def _float_dict(value: object) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, float] = {}
    for key, item in value.items():
        try:
            result[str(key)] = float(item)
        except (TypeError, ValueError):
            continue
    return result


def _asr_timing_rows(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    rows: list[dict[str, object]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        try:
            start = float(item.get("start"))
            end = float(item.get("end"))
        except (TypeError, ValueError):
            continue
        if start < 0 or end < start:
            continue
        rows.append(
            {
                "text": str(item.get("text") or item.get("word") or ""),
                "start": start,
                "end": end,
            }
        )
    return rows


def _runpod_error_message(body: dict[str, object], *, job_id: str = "") -> str:
    status = str(body.get("status") or "").upper()
    message = f"RunPod job failed with status {status}" if status else "RunPod job failed"
    resolved_job_id = str(job_id or body.get("id") or body.get("job_id") or "").strip()
    if resolved_job_id:
        message = f"{message}: job_id={resolved_job_id}"
    detail = _runpod_error_detail(body)
    return f"{message}: {detail}" if detail else message


def _runpod_error_detail(body: dict[str, object]) -> str:
    candidates = [body.get("error")]
    output = body.get("output")
    if isinstance(output, dict):
        candidates.extend((output.get("error"), output.get("detail"), output.get("message")))
    for candidate in candidates:
        detail = _runpod_error_candidate(candidate)
        if detail:
            return detail[:800]
    return ""


def _runpod_error_candidate(value: object) -> str:
    if isinstance(value, dict):
        for key in ("error_message", "message", "detail", "error"):
            detail = _runpod_error_candidate(value.get(key))
            if detail:
                return detail
        return ""
    if not isinstance(value, str):
        return ""
    normalized = " ".join(value.split())
    if not normalized:
        return ""
    try:
        decoded = json.loads(normalized)
    except json.JSONDecodeError:
        return normalized
    return _runpod_error_candidate(decoded)


def _runpod_voice_conversion_progress(body: dict[str, object]) -> PipelineProgress | None:
    status = str(body.get("status") or "").upper()
    if status in {"", "IN_QUEUE", "QUEUED"}:
        return PipelineProgress("gpu_wait", "利用可能なGPUを待っています", "RunPod Serverless")
    output = body.get("output")
    if status in {"IN_PROGRESS", "RUNNING"} and isinstance(output, dict):
        stage = str(output.get("stage") or "voice_conversion")
        label = str(output.get("label") or "自分の声に変換しています")
        provider = str(output.get("model") or output.get("provider") or "Seed-VC")
        return PipelineProgress(stage, label, provider)
    if status in {"IN_PROGRESS", "RUNNING"}:
        return PipelineProgress("initializing", "RunPod workerを初期化しています", "RunPod Serverless")
    return None


def _notify_runpod_status(
    progress_callback: Callable[[dict[str, object]], None] | None,
    body: dict[str, object],
) -> None:
    if progress_callback is not None:
        progress_callback(dict(body))


def _notify(
    progress_callback: ProgressCallback | None,
    stage: str,
    label: str,
    provider: str,
    *,
    transcript: str | None = None,
    translated_text: str | None = None,
    transformed_text: str | None = None,
) -> None:
    if progress_callback is not None:
        progress_callback(
            PipelineProgress(
                stage=stage,
                label=label,
                provider=provider,
                transcript=transcript,
                translated_text=translated_text,
                transformed_text=transformed_text,
            )
        )


def _elapsed_ms(started: float) -> float:
    return (perf_counter() - started) * 1000


@dataclass(frozen=True)
class _RunpodProvider:
    name: str


@dataclass(frozen=True)
class _RunpodTtsProvider:
    name: str = "runpod-serverless-tts"
    audio_mime_type: str = "audio/wav"
    supported_voice_modes: tuple[str, ...] = ("default", "convert")
