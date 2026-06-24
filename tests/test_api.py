from pathlib import Path
from threading import Event
from time import sleep
from types import SimpleNamespace

from fastapi.testclient import TestClient

from mo_speech.api import create_app
from mo_speech.pipeline import PipelineProgress, PipelineResult
from mo_speech.providers.voice import (
    VoiceConversionBackendInfo,
    VoiceConversionService,
)


def test_root_serves_browser_ui() -> None:
    client = TestClient(create_app())

    response = client.get("/")

    assert response.status_code == 200
    assert "音声翻訳" in response.text
    assert "source_language" in response.text
    assert "operation_mode" in response.text
    assert "voice_mode" in response.text
    assert "voice_backend" in response.text
    assert "reference_audio" in response.text
    assert "translation-only" in response.text
    assert "audio-label" in response.text
    assert "source-audio-hint" in response.text
    assert "text-result-section" in response.text
    assert "output-audio-heading" in response.text
    assert "route-hint" in response.text
    assert "runtime-mode" in response.text
    assert "runtime-note" in response.text
    assert "input-audio" in response.text
    assert "audio_device" in response.text
    assert "audio-device-refresh" in response.text
    assert "input-level" in response.text
    assert "recording-details" in response.text
    assert "voice-mode-hint" in response.text
    assert "Qwen生成後にSeed-VC変換" in response.text
    assert "Qwenで直接声寄せ" in response.text
    assert "既定音声" not in response.text
    assert "processing-panel" in response.text
    assert "processing-steps" in response.text
    assert "error-message" in response.text
    assert "末尾付加" in response.text
    assert "VC比較" in response.text
    assert "/static/app.js" in response.text


def test_static_assets_are_served() -> None:
    client = TestClient(create_app())

    js_response = client.get("/static/app.js")
    css_response = client.get("/static/styles.css")

    assert js_response.status_code == 200
    assert "submitTranslation" in js_response.text
    assert "append_suffix" in js_response.text
    assert "loadRuntime" in js_response.text
    assert "submitCurrentOperation" in js_response.text
    assert "submitVoiceConversion" in js_response.text
    assert "pollVoiceConversionJob" in js_response.text
    assert "syncOperationMode" in js_response.text
    assert "syncVoiceBackendAvailability" in js_response.text
    assert "selectedVoiceBackend" in js_response.text
    assert "translationOnlyElements" in js_response.text
    assert "textResultSection" in js_response.text
    assert "変換元音声ファイル" in js_response.text
    assert "VC出力音声" in js_response.text
    assert "renderInputAudioPreview" in js_response.text
    assert "loadAudioDevices" in js_response.text
    assert "selectedAudioConstraint" in js_response.text
    assert "chooseRecorderOptions" in js_response.text
    assert "startInputLevelMeter" in js_response.text
    assert "syncVoiceModeAvailability" in js_response.text
    assert "syncVoiceModeHint" in js_response.text
    assert "preferredVoiceMode" in js_response.text
    assert "pollTranslationJob" in js_response.text
    assert "renderProcessingJob" in js_response.text
    assert "renderPartialResult" in js_response.text
    assert "syncTargetOptions" in js_response.text
    assert "renderError" in js_response.text
    assert css_response.status_code == 200
    assert ".status" in css_response.text
    assert ".runtime-panel" in css_response.text
    assert ".processing-panel" in css_response.text
    assert ".error-message" in css_response.text


def test_runtime_api_returns_active_mode_and_provider_names() -> None:
    client = TestClient(create_app(voice_conversion_service=_fake_voice_conversion_service()))

    response = client.get("/api/runtime")

    assert response.status_code == 200
    assert response.json() == {
        "provider_mode": "fake",
        "providers": {"asr": "fake-asr", "translation": "fake-translation", "tts": "fake-tts"},
        "supported_voice_modes": ["default"],
        "voice_conversion_backends": [
            {
                "id": "fake-vc",
                "label": "Fake VC",
                "provider": "fake-vc-provider",
                "available": True,
                "reason": "",
            }
        ],
    }


def test_runtime_api_returns_supported_voice_modes_from_tts_provider() -> None:
    class CustomPipeline:
        asr = SimpleNamespace(name="custom-asr")
        translator = SimpleNamespace(name="custom-translation")
        tts = SimpleNamespace(name="custom-tts", supported_voice_modes=("convert", "clone", "convert"))

    client = TestClient(
        create_app(pipeline=CustomPipeline(), voice_conversion_service=_fake_voice_conversion_service())
    )  # type: ignore[arg-type]

    response = client.get("/api/runtime")

    assert response.status_code == 200
    assert response.json()["supported_voice_modes"] == ["convert", "clone"]


def test_runtime_api_marks_unavailable_voice_conversion_backend() -> None:
    client = TestClient(create_app(voice_conversion_service=_fake_voice_conversion_service(available=False)))

    response = client.get("/api/runtime")

    assert response.status_code == 200
    assert response.json()["voice_conversion_backends"] == [
        {
            "id": "fake-vc",
            "label": "Fake VC",
            "provider": "fake-vc-provider",
            "available": False,
            "reason": "not installed",
        }
    ]


def test_create_app_preloads_pipeline_when_enabled(monkeypatch) -> None:
    class PreloadPipeline:
        preloaded = False

        def preload(self) -> None:
            self.preloaded = True

    pipeline = PreloadPipeline()
    monkeypatch.setenv("MO_PRELOAD_MODELS", "1")

    create_app(pipeline=pipeline)  # type: ignore[arg-type]

    assert pipeline.preloaded is True


def test_translate_speech_api_accepts_audio_upload() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/api/translate-speech",
        data={
            "source_language": "id-ID",
            "target_language": "ja-JP",
            "text_transform": "append_suffix",
            "text_transform_suffix": "モー",
            "text_transform_unit": "sentence",
        },
        files={"audio": ("sample.wav", b"fake audio", "audio/wav")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["transcript"] == "Selamat pagi. Terima kasih."
    assert payload["translated_text"] == "おはようございます。ありがとうございます。"
    assert payload["transformed_text"] == "おはようございますモー。ありがとうございますモー。"
    assert payload["providers"] == {"asr": "fake-asr", "translation": "fake-translation", "tts": "fake-tts"}
    assert payload["audio_mime_type"] == "audio/wav"
    assert payload["audio_base64"] != ""


def test_translate_speech_job_api_reports_progress_and_result() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/api/translate-speech-jobs",
        data={
            "source_language": "id-ID",
            "target_language": "ja-JP",
            "text_transform": "append_suffix",
            "text_transform_suffix": "モー",
            "text_transform_unit": "sentence",
        },
        files={"audio": ("sample.wav", b"fake audio", "audio/wav")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] in {"queued", "running", "succeeded"}
    assert payload["stages"] == [
        {"stage": "asr", "label": "文字起こし", "provider": "fake-asr"},
        {"stage": "translation", "label": "翻訳", "provider": "fake-translation"},
        {"stage": "text_transform", "label": "テキスト加工", "provider": "append_suffix"},
        {"stage": "tts", "label": "音声生成", "provider": "fake-tts"},
    ]

    job_id = payload["job_id"]
    for _ in range(20):
        status_response = client.get(f"/api/translate-speech-jobs/{job_id}")
        assert status_response.status_code == 200
        status_payload = status_response.json()
        if status_payload["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("translation job did not finish")

    assert status_payload["result"]["transcript"] == "Selamat pagi. Terima kasih."
    assert status_payload["result"]["transformed_text"] == "おはようございますモー。ありがとうございますモー。"
    assert status_payload["result"]["audio_base64"] != ""
    assert status_payload["partial_result"] == {
        "transcript": "Selamat pagi. Terima kasih.",
        "translated_text": "おはようございます。ありがとうございます。",
        "transformed_text": "おはようございますモー。ありがとうございますモー。",
    }


def test_translate_speech_job_api_reports_partial_result_while_running() -> None:
    progress_reported = Event()
    finish_job = Event()

    class SlowPipeline:
        asr = SimpleNamespace(name="slow-asr")
        translator = SimpleNamespace(name="slow-translation")
        tts = SimpleNamespace(name="slow-tts")

        def run(self, request, progress_callback=None) -> PipelineResult:
            if progress_callback is not None:
                progress_callback(
                    PipelineProgress(
                        stage="translation",
                        label="翻訳",
                        provider="slow-translation",
                        transcript="Selamat pagi.",
                    )
                )
            progress_reported.set()
            assert finish_job.wait(timeout=2)
            return PipelineResult(
                transcript="Selamat pagi.",
                translated_text="おはようございます。",
                transformed_text="おはようございます。",
                output_audio_bytes=b"wav",
                output_audio_mime_type="audio/wav",
                timings_ms={"total": 0.0},
                providers={"asr": "slow-asr", "translation": "slow-translation", "tts": "slow-tts"},
            )

    client = TestClient(create_app(pipeline=SlowPipeline()))  # type: ignore[arg-type]

    response = client.post(
        "/api/translate-speech-jobs",
        data={"source_language": "id-ID", "target_language": "ja-JP"},
        files={"audio": ("sample.wav", b"fake audio", "audio/wav")},
    )
    assert response.status_code == 200
    job_id = response.json()["job_id"]

    assert progress_reported.wait(timeout=2)
    status_response = client.get(f"/api/translate-speech-jobs/{job_id}")
    assert status_response.status_code == 200
    status_payload = status_response.json()
    assert status_payload["status"] == "running"
    assert status_payload["current_stage"] == {
        "stage": "translation",
        "label": "翻訳",
        "provider": "slow-translation",
    }
    assert status_payload["partial_result"] == {"transcript": "Selamat pagi."}

    finish_job.set()
    for _ in range(20):
        status_payload = client.get(f"/api/translate-speech-jobs/{job_id}").json()
        if status_payload["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("translation job did not finish")


def test_voice_conversion_job_api_runs_selected_backend() -> None:
    client = TestClient(create_app(voice_conversion_service=_fake_voice_conversion_service()))

    response = client.post(
        "/api/voice-conversion-jobs",
        data={"voice_backend": "fake-vc"},
        files={
            "source_audio": ("source.wav", b"source audio", "audio/wav"),
            "reference_audio": ("reference.wav", b"reference audio", "audio/wav"),
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] in {"queued", "running", "succeeded"}
    assert payload["stages"] == [
        {"stage": "source_audio_prepare", "label": "変換元音声準備", "provider": "ffmpeg"},
        {"stage": "reference_audio_prepare", "label": "参照音声準備", "provider": "ffmpeg"},
        {"stage": "voice_conversion", "label": "声質変換", "provider": "fake-vc-provider"},
    ]

    job_id = payload["job_id"]
    for _ in range(20):
        status_payload = client.get(f"/api/voice-conversion-jobs/{job_id}").json()
        if status_payload["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("voice conversion job did not finish")

    assert status_payload["result"]["audio_base64"] != ""
    assert status_payload["result"]["audio_mime_type"] == "audio/wav"
    assert status_payload["result"]["providers"] == {"voice_conversion": "fake-vc-provider"}
    assert status_payload["result"]["timings_ms"]["voice_conversion"] == 1.0


def test_translate_speech_api_rejects_unsupported_route() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/api/translate-speech",
        data={"source_language": "en-US", "target_language": "ja-JP"},
        files={"audio": ("sample.wav", b"fake audio", "audio/wav")},
    )

    assert response.status_code == 400
    assert "unsupported route" in response.json()["detail"]


def test_translate_speech_api_preserves_uploaded_audio_suffix() -> None:
    captured: dict[str, Path] = {}

    class CapturePipeline:
        asr = SimpleNamespace(name="capture-asr")
        translator = SimpleNamespace(name="capture-translation")
        tts = SimpleNamespace(name="capture-tts")

        def run(self, request) -> PipelineResult:
            captured["audio_path"] = request.audio_path
            return PipelineResult(
                transcript="Selamat pagi.",
                translated_text="おはようございます。",
                transformed_text="おはようございます。",
                output_audio_bytes=b"wav",
                output_audio_mime_type="audio/wav",
                timings_ms={"total": 0.0},
                providers={"asr": "capture-asr", "translation": "capture-translation", "tts": "capture-tts"},
            )

    client = TestClient(create_app(pipeline=CapturePipeline()))  # type: ignore[arg-type]

    response = client.post(
        "/api/translate-speech",
        data={"source_language": "id-ID", "target_language": "ja-JP"},
        files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
    )

    assert response.status_code == 200
    assert captured["audio_path"].suffix == ".webm"


class FakeVoiceConversionProvider:
    backend_id = "fake-vc"
    label = "Fake VC"
    name = "fake-vc-provider"
    audio_mime_type = "audio/wav"

    def __init__(self, *, available: bool = True) -> None:
        self.available = available

    def backend_info(self) -> VoiceConversionBackendInfo:
        return VoiceConversionBackendInfo(
            self.backend_id,
            self.label,
            self.name,
            self.available,
            "" if self.available else "not installed",
        )

    def convert(
        self,
        *,
        source_audio_path: Path,
        reference_audio_path: Path,
        progress_callback=None,
    ):
        if progress_callback is not None:
            progress_callback(PipelineProgress("voice_conversion", "声質変換", self.name))
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


def _fake_voice_conversion_service(*, available: bool = True) -> VoiceConversionService:
    return VoiceConversionService(providers=[FakeVoiceConversionProvider(available=available)])
