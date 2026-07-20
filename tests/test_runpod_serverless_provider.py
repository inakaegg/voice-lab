from __future__ import annotations

import base64
import io
import json
import urllib.error
from pathlib import Path

import pytest

from mo_speech.pipeline import PipelineRequest
from mo_speech.providers.runpod_serverless import (
    RunpodServerlessClient,
    RunpodServerlessPracticeAsrProvider,
    RunpodServerlessSpeechTranslationPipeline,
    RunpodServerlessVoiceConversionProvider,
    runpod_serverless_pipeline_status,
)
from mo_speech.providers.voice import SeedVcRuntimeSettings


@pytest.fixture(autouse=True)
def isolate_runpod_env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RUNPOD_ENV_FILE", str(tmp_path / "missing.runpod.env"))


def test_runpod_client_reads_connection_keys_from_runpod_env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runpod_env_file = tmp_path / ".runpod.env"
    runpod_env_file.write_text(
        "\n".join(
            [
                "RUNPOD_ENDPOINT_ID=endpoint-from-file",
                "RUNPOD_API_KEY=secret-from-file",
                "RUNPOD_SERVERLESS_REQUEST_MODE=sync",
                "MO_PROVIDER_MODE=local",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("RUNPOD_ENV_FILE", str(runpod_env_file))
    monkeypatch.delenv("RUNPOD_ENDPOINT_ID", raising=False)
    monkeypatch.delenv("RUNPOD_API_KEY", raising=False)
    monkeypatch.delenv("RUNPOD_SERVERLESS_REQUEST_MODE", raising=False)

    client = RunpodServerlessClient.from_env()

    assert client.endpoint_id == "endpoint-from-file"
    assert client.api_key == "secret-from-file"
    assert client.request_mode == "sync"


def test_runpod_serverless_pipeline_maps_request_and_response(tmp_path: Path) -> None:
    client = FakeRunpodClient(
        {
            "transcript": "Halo.",
            "translated_text": "こんにちは。",
            "transformed_text": "こんにちは。",
            "audio_mime_type": "audio/wav",
            "audio_base64": base64.b64encode(b"remote wav").decode("ascii"),
            "timings_ms": {"total": 100.0},
            "serverless_timings_ms": {"handler_total": 95.0},
            "providers": {"asr": "remote-asr", "translation": "remote-translation", "tts": "remote-tts"},
            "warnings": ["remote warning"],
            "target_language": "ja-JP",
        }
    )
    audio_path = tmp_path / "input.wav"
    audio_path.write_bytes(b"input wav")
    pipeline = RunpodServerlessSpeechTranslationPipeline(
        client=client,
        internal_translation_backend="qwen",
    )

    result = pipeline.run(
        PipelineRequest(
            audio_path=audio_path,
            source_language="auto",
            target_language="user-auto",
            voice_mode="default",
            text_transform="user_effects",
            text_transform_options={"variation": True},
        )
    )

    assert client.inputs[0]["operation_mode"] == "translation"
    assert client.inputs[0]["translation_backend"] == "qwen"
    assert client.inputs[0]["audio_base64"] == base64.b64encode(b"input wav").decode("ascii")
    assert client.inputs[0]["source_language"] == "auto"
    assert client.inputs[0]["target_language"] == "user-auto"
    assert client.inputs[0]["text_transform_options"] == {"variation": True}
    assert result.output_audio_bytes == b"remote wav"
    assert result.output_audio_mime_type == "audio/wav"
    assert result.providers == {"asr": "remote-asr", "translation": "remote-translation", "tts": "remote-tts"}
    assert result.timings_ms["total"] == 100.0
    assert result.timings_ms["runpod_handler_total"] == 95.0
    assert result.target_language == "ja-JP"


def test_runpod_serverless_pipeline_sends_seed_vc_runtime_settings(tmp_path: Path) -> None:
    client = FakeRunpodClient(
        {
            "transcript": "Halo.",
            "translated_text": "こんにちは。",
            "transformed_text": "こんにちは。",
            "audio_mime_type": "audio/wav",
            "audio_base64": base64.b64encode(b"remote wav").decode("ascii"),
            "timings_ms": {},
            "providers": {},
        }
    )
    audio_path = tmp_path / "input.webm"
    audio_path.write_bytes(b"input webm")
    pipeline = RunpodServerlessSpeechTranslationPipeline(client=client)

    pipeline.run(
        PipelineRequest(
            audio_path=audio_path,
            source_language="id-ID",
            target_language="ja-JP",
            voice_mode="convert",
            voice_settings={
                "seed_vc": SeedVcRuntimeSettings(
                    diffusion_steps=12,
                    reference_max_seconds=4.5,
                    reference_auto_select=True,
                )
            },
        )
    )

    assert client.inputs[0]["voice_mode"] == "convert"
    assert client.inputs[0]["seed_vc_diffusion_steps"] == 12
    assert client.inputs[0]["seed_vc_reference_max_seconds"] == 4.5
    assert client.inputs[0]["seed_vc_reference_auto_select"] is True


def test_runpod_practice_asr_provider_uses_sync_job_and_maps_timestamps(tmp_path: Path) -> None:
    client = FakeRunpodClient(
        {
            "text": "你好，你最近怎么样？",
            "model": "funasr/paraformer-zh",
            "timestamp_granularities": ["word"],
            "words": [
                {"text": "你", "start": 0.1, "end": 0.2},
                {"text": "好", "start": 0.2, "end": 0.35},
            ],
            "segments": [{"text": "你好，你最近怎么样？", "start": 0.1, "end": 1.6}],
        }
    )
    audio_path = tmp_path / "attempt.webm"
    audio_path.write_bytes(b"chinese attempt")
    provider = RunpodServerlessPracticeAsrProvider(client=client)

    transcription = provider.transcribe_detail(audio_path, "zh-CN", include_timestamps=True)

    assert client.sync_inputs == [
        {
            "operation_mode": "practice_asr",
            "source_language": "zh-CN",
            "audio_mime_type": "audio/webm",
            "audio_base64": base64.b64encode(b"chinese attempt").decode("ascii"),
        }
    ]
    assert transcription.text == "你好，你最近怎么样？"
    assert transcription.model == "funasr/paraformer-zh"
    assert transcription.words[0] == {"text": "你", "start": 0.1, "end": 0.2}
    assert provider.name == "runpod-funasr-paraformer-zh"


def test_runpod_practice_asr_provider_submits_dual_audio_async_job(tmp_path: Path) -> None:
    client = FakeRunpodClient({"id": "practice-job", "status": "IN_QUEUE"})
    attempt_path = tmp_path / "attempt.webm"
    model_path = tmp_path / "model.wav"
    attempt_path.write_bytes(b"attempt audio")
    model_path.write_bytes(b"model audio")
    provider = RunpodServerlessPracticeAsrProvider(client=client)

    snapshot = provider.submit_comparison_job(
        attempt_audio_path=attempt_path,
        model_audio_path=model_path,
        source_language="zh-CN",
        target_text="你好吗？",
    )

    assert snapshot == {"id": "practice-job", "status": "IN_QUEUE"}
    assert client.job_inputs == [
        {
            "operation_mode": "practice_asr",
            "source_language": "zh-CN",
            "target_text": "你好吗？",
            "audio_mime_type": "audio/webm",
            "audio_base64": base64.b64encode(b"attempt audio").decode("ascii"),
                "model_audio_mime_type": "audio/x-wav",
            "model_audio_base64": base64.b64encode(b"model audio").decode("ascii"),
        }
    ]


def test_runpod_practice_asr_provider_omits_model_audio_when_cached(tmp_path: Path) -> None:
    # お手本音声のASR結果が既にキャッシュ済みの場合、呼び出し側はmodel_audio_path=Noneを
    # 渡し、jobへお手本音声を含めない(RunPod側のFunASR推論をスキップしGPU時間を節約する)。
    client = FakeRunpodClient({"id": "practice-job-cache-hit", "status": "IN_QUEUE"})
    attempt_path = tmp_path / "attempt.webm"
    attempt_path.write_bytes(b"attempt audio")
    provider = RunpodServerlessPracticeAsrProvider(client=client)

    snapshot = provider.submit_comparison_job(
        attempt_audio_path=attempt_path,
        model_audio_path=None,
        source_language="zh-CN",
        target_text="你好吗？",
    )

    assert snapshot == {"id": "practice-job-cache-hit", "status": "IN_QUEUE"}
    assert client.job_inputs == [
        {
            "operation_mode": "practice_asr",
            "source_language": "zh-CN",
            "target_text": "你好吗？",
            "audio_mime_type": "audio/webm",
            "audio_base64": base64.b64encode(b"attempt audio").decode("ascii"),
        }
    ]


def test_runpod_client_submit_sync_always_uses_runsync() -> None:
    client = RunpodServerlessClient(endpoint_id="endpoint", api_key="secret", request_mode="async")
    calls: list[tuple[str, str, object | None]] = []

    def fake_request_json(path: str, *, method: str = "GET", payload: object | None = None, timeout_seconds: float | None = None):
        calls.append((method, path, payload))
        return {"status": "COMPLETED", "output": {"text": "你好"}}

    client._request_json = fake_request_json  # type: ignore[method-assign]

    assert client.submit_sync({"operation_mode": "practice_asr"}) == {"text": "你好"}
    assert calls == [
        (
            "POST",
            "/runsync",
            {"input": {"operation_mode": "practice_asr"}},
        ),
    ]


def test_runpod_client_exposes_async_submit_and_status_without_polling() -> None:
    client = RunpodServerlessClient(endpoint_id="endpoint", api_key="secret", request_mode="sync")
    calls: list[tuple[str, str, object | None]] = []

    def fake_request_json(path: str, *, method: str = "GET", payload: object | None = None, timeout_seconds: float | None = None):
        calls.append((method, path, payload))
        return {"id": "job-1", "status": "IN_QUEUE" if path == "/run" else "IN_PROGRESS"}

    client._request_json = fake_request_json  # type: ignore[method-assign]

    assert client.submit_job({"operation_mode": "practice_asr"})["status"] == "IN_QUEUE"
    assert client.job_status("job-1")["status"] == "IN_PROGRESS"
    assert calls == [
        (
            "POST",
            "/run",
            {"input": {"operation_mode": "practice_asr"}},
        ),
        ("GET", "/status/job-1", None),
    ]


def test_runpod_serverless_voice_conversion_provider_maps_request(tmp_path: Path) -> None:
    client = FakeRunpodClient(
        {
            "audio_mime_type": "audio/wav",
            "audio_base64": base64.b64encode(b"converted wav").decode("ascii"),
            "timings_ms": {"voice_conversion": 10.0},
            "serverless_timings_ms": {"handler_total": 12.0},
            "warnings": [],
        }
    )
    source_path = tmp_path / "source.wav"
    reference_path = tmp_path / "reference.wav"
    source_path.write_bytes(b"source wav")
    reference_path.write_bytes(b"reference wav")
    provider = RunpodServerlessVoiceConversionProvider(client=client)

    result = provider.convert(
        source_audio_path=source_path,
        reference_audio_path=reference_path,
        seed_vc_settings=SeedVcRuntimeSettings(diffusion_steps=8, reference_auto_select=True),
    )

    assert provider.backend_id == "seed-vc"
    assert client.inputs[0]["operation_mode"] == "voice_conversion"
    assert client.inputs[0]["source_audio_base64"] == base64.b64encode(b"source wav").decode("ascii")
    assert client.inputs[0]["reference_audio_base64"] == base64.b64encode(b"reference wav").decode("ascii")
    assert client.inputs[0]["voice_backend"] == "seed-vc"
    assert client.inputs[0]["seed_vc_diffusion_steps"] == 8
    assert client.inputs[0]["seed_vc_reference_auto_select"] is True
    assert result.audio_bytes == b"converted wav"
    assert result.timings_ms["runpod_handler_total"] == 12.0


def test_runpod_serverless_voice_conversion_provider_maps_remote_progress(tmp_path: Path) -> None:
    class ProgressRunpodClient:
        configured = True

        def submit(self, input_payload, *, progress_callback=None):
            assert input_payload["operation_mode"] == "voice_conversion"
            assert progress_callback is not None
            progress_callback({"id": "job-1", "status": "IN_QUEUE"})
            progress_callback({
                "id": "job-1",
                "status": "IN_PROGRESS",
                "output": {
                    "stage": "loading_seed_vc_model",
                    "label": "Seed-VCモデルを読み込んでいます",
                    "model": "Seed-VC",
                },
            })
            return {
                "audio_mime_type": "audio/wav",
                "audio_base64": base64.b64encode(b"converted wav").decode("ascii"),
            }

    source_path = tmp_path / "source.wav"
    reference_path = tmp_path / "reference.wav"
    source_path.write_bytes(b"source wav")
    reference_path.write_bytes(b"reference wav")
    progress = []

    RunpodServerlessVoiceConversionProvider(client=ProgressRunpodClient()).convert(
        source_audio_path=source_path,
        reference_audio_path=reference_path,
        progress_callback=progress.append,
    )

    assert [(item.stage, item.label, item.provider) for item in progress] == [
        ("gpu_wait", "利用可能なGPUを待っています", "RunPod Serverless"),
        ("loading_seed_vc_model", "Seed-VCモデルを読み込んでいます", "Seed-VC"),
    ]


def test_runpod_client_polls_async_job_until_completed() -> None:
    client = RunpodServerlessClient(endpoint_id="endpoint", api_key="secret", request_mode="async")
    calls: list[tuple[str, str, object | None]] = []
    progress: list[dict[str, object]] = []
    status_calls = 0

    def fake_request_json(path: str, *, method: str = "GET", payload: object | None = None, timeout_seconds: float | None = None):
        nonlocal status_calls
        calls.append((method, path, payload))
        if path == "/run":
            return {"id": "job-1", "status": "IN_QUEUE"}
        if path == "/status/job-1":
            status_calls += 1
            if status_calls == 1:
                return {
                    "id": "job-1",
                    "status": "IN_PROGRESS",
                    "output": {
                        "stage": "loading_vibevoice_model",
                        "label": "VibeVoice Largeモデルを読み込んでいます",
                        "model": "vibevoice-large-aoi-pinned",
                    },
                }
            return {"id": "job-1", "status": "COMPLETED", "output": {"ok": True}}
        raise AssertionError(path)

    client._request_json = fake_request_json  # type: ignore[method-assign]
    client.poll_interval_seconds = 0

    assert client.submit({"operation_mode": "warmup"}, progress_callback=progress.append) == {"ok": True}
    assert calls == [
        (
            "POST",
            "/run",
            {"input": {"operation_mode": "warmup"}},
        ),
        ("GET", "/status/job-1", None),
        ("GET", "/status/job-1", None),
    ]
    assert [item["status"] for item in progress] == ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]
    assert progress[1]["output"]["stage"] == "loading_vibevoice_model"


def test_runpod_client_failed_job_reports_job_id_and_structured_error() -> None:
    client = RunpodServerlessClient(endpoint_id="endpoint", api_key="secret", request_mode="async")

    def fake_request_json(
        path: str,
        *,
        method: str = "GET",
        payload: object | None = None,
        timeout_seconds: float | None = None,
    ):
        if path == "/run":
            return {"id": "job-1", "status": "IN_QUEUE"}
        if path == "/status/job-1":
            return {
                "id": "job-1",
                "status": "FAILED",
                "error": json.dumps(
                    {
                        "error_type": "<class 'OSError'>",
                        "error_message": "libcudart.so.13: cannot open shared object file",
                        "error_traceback": "secret traceback",
                    }
                ),
            }
        raise AssertionError((method, path, payload, timeout_seconds))

    client._request_json = fake_request_json  # type: ignore[method-assign]

    with pytest.raises(RuntimeError) as caught:
        client.submit({"operation_mode": "voice_conversion"})

    message = str(caught.value)
    assert "RunPod job failed with status FAILED" in message
    assert "job_id=job-1" in message
    assert "libcudart.so.13: cannot open shared object file" in message
    assert "secret traceback" not in message


def test_runpod_client_explains_completed_job_without_output() -> None:
    client = RunpodServerlessClient(endpoint_id="endpoint", api_key="secret", request_mode="async")

    with pytest.raises(RuntimeError, match="completed but did not return an output object"):
        client._completed_output(
            {
                "id": "job-1",
                "status": "COMPLETED",
                "workerId": "worker-1",
            }
        )


def test_runpod_client_submits_without_operation_policy() -> None:
    client = RunpodServerlessClient(endpoint_id="endpoint", api_key="secret")
    calls: list[tuple[str, str, object | None]] = []

    def fake_request_json(path: str, *, method: str = "GET", payload: object | None = None, timeout_seconds: float | None = None):
        calls.append((method, path, payload))
        return {"id": "job-1", "status": "IN_QUEUE"}

    client._request_json = fake_request_json  # type: ignore[method-assign]

    result = client.submit_job({"operation_mode": "voice_conversion", "reference_audio_base64": "secret"})

    assert result["status"] == "IN_QUEUE"
    assert calls == [
        (
            "POST",
            "/run",
            {"input": {"operation_mode": "voice_conversion", "reference_audio_base64": "secret"}},
        )
    ]


def test_runpod_client_does_not_echo_raw_payloads_from_http_or_completed_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    marker = "RAW_AUDIO_AND_SCRIPT_MUST_NOT_LEAK"
    client = RunpodServerlessClient(endpoint_id="endpoint", api_key="secret")

    def fail_urlopen(*_args, **_kwargs):
        raise urllib.error.HTTPError(
            "https://api.runpod.ai/v2/endpoint/run",
            502,
            "bad gateway",
            {},
            io.BytesIO(json.dumps({"error": marker, "audio_base64": marker, "script": marker}).encode()),
        )

    monkeypatch.setattr("mo_speech.providers.runpod_serverless.urllib.request.urlopen", fail_urlopen)
    with pytest.raises(RuntimeError) as http_error:
        client.submit_job({"operation_mode": "voice_conversion", "reference_audio_base64": marker})
    assert marker not in str(http_error.value)

    with pytest.raises(RuntimeError) as completed_error:
        client._completed_output({"status": "COMPLETED", "output": marker, "request": {"script": marker}})
    assert marker not in str(completed_error.value)


def test_runpod_runtime_status_reports_missing_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RUNPOD_ENDPOINT_ID", raising=False)
    monkeypatch.delenv("RUNPOD_API_KEY", raising=False)

    status = runpod_serverless_pipeline_status()

    assert status["id"] == "runpod_serverless"
    assert status["available"] is False
    assert "RUNPOD_ENDPOINT_ID" in status["reason"]


def test_runpod_runtime_status_summarizes_health(monkeypatch: pytest.MonkeyPatch) -> None:
    client = RunpodServerlessClient(endpoint_id="endpoint", api_key="secret")
    client.health = lambda: {"workers": [{"state": "IDLE"}, {"state": "RUNNING"}]}  # type: ignore[method-assign]

    status = runpod_serverless_pipeline_status(client=client)

    assert status["available"] is True
    assert status["settings"]["health"]["warm"] is True
    assert status["settings"]["health"]["worker_counts"] == {"IDLE": 1, "RUNNING": 1}


class FakeRunpodClient:
    def __init__(self, output):
        self.output = output
        self.inputs = []
        self.sync_inputs = []
        self.job_inputs = []

    def submit(self, input_payload, *, progress_callback=None):
        self.inputs.append(input_payload)
        return self.output

    def submit_sync(self, input_payload):
        self.sync_inputs.append(input_payload)
        return self.output

    def submit_job(self, input_payload):
        self.job_inputs.append(input_payload)
        return self.output

    def warmup(self, input_payload=None):
        self.inputs.append({"operation_mode": "warmup", **(input_payload or {})})
        return {"warm": True}
