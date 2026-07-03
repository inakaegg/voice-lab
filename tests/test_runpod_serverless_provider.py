from __future__ import annotations

import base64
from pathlib import Path

import pytest

from mo_speech.pipeline import PipelineRequest
from mo_speech.providers.runpod_serverless import (
    RunpodServerlessClient,
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


def test_runpod_client_polls_async_job_until_completed() -> None:
    client = RunpodServerlessClient(endpoint_id="endpoint", api_key="secret", request_mode="async")
    calls: list[tuple[str, str, object | None]] = []

    def fake_request_json(path: str, *, method: str = "GET", payload: object | None = None, timeout_seconds: float | None = None):
        calls.append((method, path, payload))
        if path == "/run":
            return {"id": "job-1", "status": "IN_QUEUE"}
        if path == "/status/job-1":
            return {"id": "job-1", "status": "COMPLETED", "output": {"ok": True}}
        raise AssertionError(path)

    client._request_json = fake_request_json  # type: ignore[method-assign]

    assert client.submit({"operation_mode": "warmup"}) == {"ok": True}
    assert calls == [
        ("POST", "/run", {"input": {"operation_mode": "warmup"}}),
        ("GET", "/status/job-1", None),
    ]


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

    def submit(self, input_payload):
        self.inputs.append(input_payload)
        return self.output

    def warmup(self, input_payload=None):
        self.inputs.append({"operation_mode": "warmup", **(input_payload or {})})
        return {"warm": True}
