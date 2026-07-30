from __future__ import annotations

import base64
import sys
from types import SimpleNamespace

import pytest

from mo_speech import runpod_handler
from mo_speech.pipeline import OperationProgress, TtsOutput
from mo_speech.providers.openai_api import AsrTranscription
from mo_speech.providers.voice import VoiceConversionBackendInfo, VoiceConversionService


def test_runpod_progress_failure_does_not_abort_processing(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_progress_update(*_args: object) -> None:
        raise RuntimeError("progress channel unavailable")

    fake_runpod = SimpleNamespace(
        serverless=SimpleNamespace(progress_update=fail_progress_update),
    )
    monkeypatch.setitem(sys.modules, "runpod", fake_runpod)

    runpod_handler._report_runpod_progress(
        {"id": "job-1"},
        {"stage": "loading_model", "label": "FunASRモデルを読み込んでいます"},
    )


def test_runpod_handler_transcribes_chinese_practice_with_funasr(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeFunAsrProvider:
        name = "funasr-paraformer-zh"
        model = "funasr/paraformer-zh"

        def transcribe_detail(self, audio_path, source_language, *, include_timestamps):
            assert audio_path.read_bytes() == b"chinese attempt"
            assert source_language == "zh-CN"
            assert include_timestamps is True
            return AsrTranscription(
                text="在中国的AI服务方面。",
                model=self.model,
                words=[
                    {"text": "在", "start": 0.1, "end": 0.2},
                    {"text": "中国", "start": 0.2, "end": 0.5},
                ],
                segments=[{"text": "在中国的AI服务方面。", "start": 0.1, "end": 1.4}],
                timestamp_granularities=["word"],
            )

        def force_align_detail(self, _audio_path, _transcription):
            raise AssertionError("single-audio practice_asr must not run forced alignment")

    monkeypatch.setattr(runpod_handler, "_FUNASR_PRACTICE_PROVIDER", FakeFunAsrProvider())

    payload = runpod_handler.handler(
        {
            "input": {
                "operation_mode": "practice_asr",
                "audio_base64": base64.b64encode(b"chinese attempt").decode("ascii"),
                "audio_mime_type": "audio/webm;codecs=opus",
                "source_language": "zh-CN",
            }
        }
    )

    assert payload["text"] == "在中国的AI服务方面。"
    assert payload["model"] == "funasr/paraformer-zh"
    assert payload["words"][0] == {"text": "在", "start": 0.1, "end": 0.2}
    assert payload["timestamp_granularities"] == ["word"]
    assert payload["providers"] == {"asr": "funasr-paraformer-zh"}
    assert payload["serverless"]["operation_mode"] == "practice_asr"


def test_runpod_handler_transcribes_model_and_attempt_with_progress(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, bytes, str]] = []
    progress: list[dict[str, object]] = []

    class FakeFunAsrProvider:
        name = "funasr-paraformer-zh"
        model = "funasr/paraformer-zh"

        def transcribe_detail(self, audio_path, source_language, *, include_timestamps):
            assert source_language == "zh-CN"
            assert include_timestamps is True
            audio = audio_path.read_bytes()
            text = "你好吗？" if audio == b"model audio" else "你哈吗？"
            calls.append(("asr", audio, text))
            return AsrTranscription(
                text=text,
                model=self.model,
                words=[{"text": text.rstrip("？"), "start": 0.1, "end": 0.9}],
                timestamp_granularities=["word"],
            )

        def force_align_detail(self, audio_path, transcription):
            audio = audio_path.read_bytes()
            calls.append(("align", audio, transcription.text))
            return AsrTranscription(
                text=transcription.text,
                model=transcription.model,
                words=[{"text": transcription.words[0]["text"], "start": 0.0, "end": 0.8}],
                segments=[{"text": transcription.text, "start": 0.0, "end": 0.8}],
                timestamp_granularities=["word"],
            )

    monkeypatch.setattr(runpod_handler, "_FUNASR_PRACTICE_PROVIDER", FakeFunAsrProvider())
    monkeypatch.setattr(runpod_handler, "_report_runpod_progress", lambda _event, value: progress.append(value))

    payload = runpod_handler.handler(
        {
            "id": "job-1",
            "input": {
                "operation_mode": "practice_asr",
                "audio_base64": base64.b64encode(b"attempt audio").decode("ascii"),
                "model_audio_base64": base64.b64encode(b"model audio").decode("ascii"),
                "audio_mime_type": "audio/webm",
                "model_audio_mime_type": "audio/wav",
                "source_language": "zh-CN",
                "target_text": "你好吗？",
            },
        }
    )

    assert calls == [
        ("asr", b"model audio", "你好吗？"),
        ("align", b"model audio", "你好吗？"),
        ("asr", b"attempt audio", "你哈吗？"),
        ("align", b"attempt audio", "你哈吗？"),
    ]
    assert payload["text"] == "你哈吗？"
    assert payload["target_text"] == "你好吗？"
    assert payload["model_transcription"]["text"] == "你好吗？"
    assert payload["practice_asr_contract_version"] == 3
    assert [entry["stage"] for entry in progress] == [
        "initializing",
        "transcribing_model",
        "transcribing_attempt",
        "finalizing",
    ]
    assert all(entry["model"] == "funasr/paraformer-zh" for entry in progress)


def test_runpod_handler_aligns_cached_comparison_attempt_without_model_audio(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    class FakeFunAsrProvider:
        name = "funasr-paraformer-zh"
        model = "funasr/paraformer-zh"

        def transcribe_detail(self, _audio_path, _source_language, *, include_timestamps):
            assert include_timestamps is True
            calls.append("asr")
            return AsrTranscription(
                text="你好吗？",
                model=self.model,
                words=[{"text": "你好吗", "start": 0.1, "end": 0.9}],
                timestamp_granularities=["word"],
            )

        def force_align_detail(self, _audio_path, transcription):
            calls.append("align")
            return AsrTranscription(
                text=transcription.text,
                model=transcription.model,
                words=[{"text": "你好吗", "start": 0.0, "end": 0.8}],
                timestamp_granularities=["word"],
            )

    monkeypatch.setattr(runpod_handler, "_FUNASR_PRACTICE_PROVIDER", FakeFunAsrProvider())

    payload = runpod_handler.handler(
        {
            "input": {
                "operation_mode": "practice_asr",
                "audio_base64": base64.b64encode(b"attempt audio").decode("ascii"),
                "source_language": "zh-CN",
                "target_text": "你好吗？",
                "align_timestamps": True,
            }
        }
    )

    assert calls == ["asr", "align"]
    assert payload["words"] == [{"text": "你好吗", "start": 0.0, "end": 0.8}]
    assert "model_transcription" not in payload


def test_runpod_handler_releases_voice_conversion_before_funasr(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    class FakeVoiceConversionService:
        def release(self):
            calls.append("release-vc")

    class FakeFunAsrProvider:
        name = "funasr-paraformer-zh"

        def transcribe_detail(self, _audio_path, _source_language, *, include_timestamps):
            assert include_timestamps is True
            calls.append("transcribe-funasr")
            return AsrTranscription(text="你好", model="funasr/paraformer-zh")

        def force_align_detail(self, _audio_path, transcription):
            calls.append("align-funasr")
            return transcription

    monkeypatch.setattr(runpod_handler, "_VOICE_CONVERSION_SERVICE", FakeVoiceConversionService())
    monkeypatch.setattr(runpod_handler, "_VOICE_CONVERSION_SERVICE_LOAD_MS", 1.0)
    monkeypatch.setattr(runpod_handler, "_FUNASR_PRACTICE_PROVIDER", FakeFunAsrProvider())

    runpod_handler.handler(
        {
            "input": {
                "operation_mode": "practice_asr",
                "audio_base64": base64.b64encode(b"attempt").decode("ascii"),
                "source_language": "zh-CN",
            }
        }
    )

    assert calls == ["release-vc", "transcribe-funasr"]
    assert runpod_handler._VOICE_CONVERSION_SERVICE is None
    assert runpod_handler._VOICE_CONVERSION_SERVICE_LOAD_MS is None


def test_runpod_handler_converts_voice_base64_audio(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = FakeVcProvider()
    monkeypatch.setattr(runpod_handler, "_VOICE_CONVERSION_SERVICE", VoiceConversionService([provider]))
    event = {
        "input": {
            "operation_mode": "voice_conversion",
            "source_audio_base64": base64.b64encode(b"source audio").decode("ascii"),
            "reference_audio_base64": base64.b64encode(b"reference audio").decode("ascii"),
            "source_audio_mime_type": "audio/wav",
            "reference_audio_mime_type": "audio/wav",
            "voice_backend": "seed-vc",
            "seed_vc_diffusion_steps": 10,
            "seed_vc_reference_max_seconds": 5,
            "seed_vc_reference_auto_select": True,
        }
    }

    payload = runpod_handler.handler(event)

    assert payload["audio_mime_type"] == "audio/wav"
    assert payload["audio_base64"] != ""
    assert payload["providers"]["voice_conversion"] == "fake-vc-provider"
    assert payload["serverless"]["operation_mode"] == "voice_conversion"
    assert payload["serverless_timings_ms"]["handler_total"] >= 0
    assert provider.last_seed_vc_settings is not None
    assert provider.last_seed_vc_settings.reference_auto_select is True


def test_runpod_handler_reports_seed_vc_model_progress(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = FakeVcProvider()
    progress = []
    monkeypatch.setattr(runpod_handler, "_VOICE_CONVERSION_SERVICE", VoiceConversionService([provider]))
    monkeypatch.setattr(runpod_handler, "_report_runpod_progress", lambda _event, item: progress.append(item))

    runpod_handler.handler(
        {
            "id": "voice-job-1",
            "input": {
                "operation_mode": "voice_conversion",
                "source_audio_base64": base64.b64encode(b"source audio").decode("ascii"),
                "reference_audio_base64": base64.b64encode(b"reference audio").decode("ascii"),
                "source_audio_mime_type": "audio/wav",
                "reference_audio_mime_type": "audio/wav",
                "voice_backend": "seed-vc",
            },
        }
    )

    assert progress[0]["stage"] == "initializing"
    assert progress[1]["stage"] == "loading_seed_vc_model"
    assert progress[-1]["stage"] == "voice_conversion"
    assert all(item["model"] for item in progress)


def test_runpod_handler_audio_suffix_ignores_mime_parameters() -> None:
    assert runpod_handler._audio_suffix("audio/webm;codecs=opus") == ".webm"
    assert runpod_handler._audio_suffix("video/webm; codecs=opus") == ".webm"
    assert runpod_handler._audio_suffix("audio/mp4; codecs=mp4a.40.2") == ".m4a"
    assert runpod_handler._audio_suffix("audio/mpeg; charset=binary") == ".mp3"


def test_runpod_handler_generates_text_tts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runpod_handler, "_TEXT_TTS_PROVIDERS", {"fake": FakeTextTtsProvider()})
    event = {
        "input": {
            "operation_mode": "text_tts",
            "text": "こんにちは",
            "target_language": "ja-JP",
            "tts_backend": "fake",
        }
    }

    payload = runpod_handler.handler(event)

    assert payload["audio_mime_type"] == "audio/wav"
    assert base64.b64decode(payload["audio_base64"]) == "TTS:ja-JP:こんにちは".encode()
    assert payload["providers"] == {"tts": "fake-text-tts"}
    assert payload["serverless"]["operation_mode"] == "text_tts"
    assert payload["serverless_timings_ms"]["text_tts_provider_load"] >= 0


def test_runpod_handler_rejects_reference_audio_from_url_operation() -> None:
    with pytest.raises(ValueError, match="unsupported operation_mode: reference_audio_from_url"):
        runpod_handler.handler(
            {
                "input": {
                    "operation_mode": "reference_audio_from_url",
                    "url": "https://youtu.be/zDZvAmCJJaY?t=2129",
                    "duration_seconds": 5,
                }
            }
        )


def test_runpod_handler_reports_worker_diagnostics(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MO_IMAGE_REVISION", "abc123")
    monkeypatch.setenv("MO_IMAGE_TAG", "docker.io/example/mo-speech:test")

    payload = runpod_handler.handler({"input": {"operation_mode": "diagnostics"}})

    assert payload["image"]["revision"] == "abc123"
    assert payload["image"]["tag"] == "docker.io/example/mo-speech:test"
    assert payload["serverless"]["operation_mode"] == "diagnostics"


def test_runpod_handler_warms_voice_conversion(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def fake_voice_conversion_service():
        calls.append(("voice_conversion", "seed-vc"))
        return object(), 34.0

    monkeypatch.setattr(runpod_handler, "_voice_conversion_service", fake_voice_conversion_service)

    payload = runpod_handler.handler(
        {
            "input": {
                "operation_mode": "warmup",
                "preload_voice_conversion": True,
            }
        }
    )

    assert calls == [("voice_conversion", "seed-vc")]
    assert payload["warm"] is True
    assert payload["providers"] == {"voice_conversion": "seed-vc"}
    assert payload["serverless"]["operation_mode"] == "warmup"
    assert payload["serverless"]["worker_cold"] is True
    assert payload["serverless_timings_ms"]["voice_conversion_service_load"] == 34.0


def test_runpod_handler_warms_practice_asr(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def fake_funasr_practice_provider():
        calls.append(("practice_asr", "funasr"))
        return SimpleNamespace(name="funasr-paraformer-zh"), 12.0

    monkeypatch.setattr(runpod_handler, "_funasr_practice_provider", fake_funasr_practice_provider)

    payload = runpod_handler.handler(
        {
            "input": {
                "operation_mode": "warmup",
                "preload_practice_asr": True,
            }
        }
    )

    assert calls == [("practice_asr", "funasr")]
    assert payload["providers"] == {"practice_asr": "funasr-paraformer-zh"}
    assert payload["serverless_timings_ms"]["funasr_provider_load"] == 12.0


def test_runpod_preload_loads_explicit_voice_conversion_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def fake_voice_conversion_service():
        calls.append(("voice_conversion", "seed-vc"))
        return object(), 34.0

    monkeypatch.setattr(runpod_handler, "_voice_conversion_service", fake_voice_conversion_service)
    monkeypatch.setenv("MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START", "1")
    monkeypatch.delenv("MO_RUNPOD_PRELOAD_FUNASR_ON_START", raising=False)

    runpod_handler._preload_for_serverless()

    assert calls == [("voice_conversion", "seed-vc")]


def test_runpod_preload_skips_all_providers_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def fake_voice_conversion_service():
        calls.append(("voice_conversion", "seed-vc"))
        return object(), 34.0

    monkeypatch.setattr(runpod_handler, "_voice_conversion_service", fake_voice_conversion_service)
    monkeypatch.delenv("MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START", raising=False)
    monkeypatch.delenv("MO_RUNPOD_PRELOAD_FUNASR_ON_START", raising=False)

    runpod_handler._preload_for_serverless()

    assert calls == []


def test_runpod_voice_conversion_service_preloads_provider_on_first_load(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    class FakeService:
        def preload(self):
            calls.append("preload")

    service = FakeService()
    monkeypatch.setattr(runpod_handler, "_VOICE_CONVERSION_SERVICE", None)
    monkeypatch.setattr(runpod_handler, "_VOICE_CONVERSION_SERVICE_LOAD_MS", None)
    monkeypatch.setattr(runpod_handler, "create_voice_conversion_service_from_env", lambda: service)

    loaded, first_load_ms = runpod_handler._voice_conversion_service()
    loaded_again, second_load_ms = runpod_handler._voice_conversion_service()

    assert loaded is service
    assert loaded_again is service
    assert first_load_ms is not None
    assert second_load_ms is None
    assert calls == ["preload"]


def test_runpod_funasr_provider_can_skip_alignment_preload(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[bool] = []

    class FakeProvider:
        def preload(self, *, include_alignment):
            calls.append(include_alignment)

    provider = FakeProvider()
    monkeypatch.setattr(runpod_handler, "_FUNASR_PRACTICE_PROVIDER", None)
    monkeypatch.setattr(runpod_handler, "_FUNASR_PRACTICE_PROVIDER_LOAD_MS", None)
    monkeypatch.setattr(runpod_handler, "FunAsrPracticeProvider", lambda: provider)

    loaded, load_ms = runpod_handler._funasr_practice_provider(preload_alignment=False)

    assert loaded is provider
    assert load_ms is not None
    assert calls == [False]


@pytest.mark.parametrize("operation_mode", ["", "translation", "translate"])
def test_runpod_handler_rejects_retired_translation_operations(operation_mode: str) -> None:
    with pytest.raises(ValueError, match=f"unsupported operation_mode: {operation_mode}"):
        runpod_handler.handler({"input": {"operation_mode": operation_mode}})


@pytest.mark.parametrize(
    ("mime_type", "suffix"),
    [
        ("audio/mp4", ".m4a"),
        ("audio/mp4a-latm", ".m4a"),
        ("audio/x-m4a", ".m4a"),
        ("audio/webm", ".webm"),
        ("video/webm", ".webm"),
        ("audio/mpeg", ".mp3"),
        ("audio/x-wav", ".wav"),
    ],
)
def test_runpod_handler_audio_suffix_keeps_container_type(mime_type: str, suffix: str) -> None:
    assert runpod_handler._audio_suffix(mime_type) == suffix


class FakeVcProvider:
    backend_id = "seed-vc"
    label = "Seed-VC"
    name = "fake-vc-provider"
    audio_mime_type = "audio/wav"

    def __init__(self):
        self.last_seed_vc_settings = None

    def backend_info(self) -> VoiceConversionBackendInfo:
        return VoiceConversionBackendInfo(self.backend_id, self.label, self.name, True)

    def convert(self, *, source_audio_path, reference_audio_path, seed_vc_settings=None, progress_callback=None):
        self.last_seed_vc_settings = seed_vc_settings
        if progress_callback is not None:
            progress_callback(OperationProgress("voice_conversion", "声質変換", self.name))
        return type(
            "FakeTtsOutput",
            (),
            {
                "audio_bytes": b"fake converted wav",
                "audio_mime_type": "audio/wav",
                "timings_ms": {"voice_conversion": 1.0},
                "warnings": [],
            },
        )()


class FakeTextTtsProvider:
    name = "fake-text-tts"
    audio_mime_type = "audio/wav"

    def synthesize(self, text, target_language):
        return TtsOutput(
            audio_bytes=f"TTS:{target_language}:{text}".encode(),
            audio_mime_type="audio/wav",
            timings_ms={"tts": 1.0, "total": 1.0},
            warnings=[],
        )
