from pathlib import Path
from threading import Event
from time import sleep
from types import SimpleNamespace

from fastapi.testclient import TestClient

from mo_speech.api import create_app
from mo_speech.pipeline import PipelineProgress, PipelineResult, TtsOutput
from mo_speech.providers.voice import (
    SeedVcRuntimeSettings,
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
    assert "translation_backend" in response.text
    assert "text_tts" in response.text
    assert "tts_text" in response.text
    assert "tts_backend" in response.text
    assert "voice_processing" in response.text
    assert "voice_backend" in response.text
    assert "reference_audio" in response.text
    assert "seed-vc-settings" in response.text
    assert "seed_vc_preset" in response.text
    assert "品質優先" in response.text
    assert "最高品質検証" in response.text
    assert "seed_vc_diffusion_steps" in response.text
    assert "seed_vc_reference_max_seconds" in response.text
    assert "seed_vc_length_adjust" in response.text
    assert "seed_vc_inference_cfg_rate" in response.text
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
    assert "音声翻訳（Qwen/local）" in response.text
    assert "音声翻訳（OpenAI API）" in response.text
    assert "音声翻訳（OpenAI Realtime）" in response.text
    assert "音声翻訳（OpenAI Realtime streaming）" in response.text
    assert "realtime-streaming-panel" in response.text
    assert "接続開始後に話す" in response.text
    assert "Google Translate TTS endpoint" in response.text
    assert "OpenAI TTS API" in response.text
    assert "history-recordings" in response.text
    assert "history-outputs" in response.text
    assert "Seed-VCで入力音声に寄せる" in response.text
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
    assert "translationBackendSelect" in js_response.text
    assert "submitTextToSpeech" in js_response.text
    assert "loadAudioHistory" in js_response.text
    assert "isRealtimeTranslationBackend" in js_response.text
    assert "isRealtimeStreamingTranslationBackend" in js_response.text
    assert "startRealtimeStreaming" in js_response.text
    assert "stopRealtimeStreaming" in js_response.text
    assert "saveRealtimeStreamingOutput" in js_response.text
    assert "startRealtimeOutputRecording" in js_response.text
    assert "openai-realtime-translation-session" in js_response.text
    assert "syncTtsBackendAvailability" in js_response.text
    assert "voiceProcessingSelect" in js_response.text
    assert "submitCurrentOperation" in js_response.text
    assert "submitVoiceConversion" in js_response.text
    assert "pollVoiceConversionJob" in js_response.text
    assert "syncOperationMode" in js_response.text
    assert "syncVoiceBackendAvailability" in js_response.text
    assert "syncSeedVcSettingsVisibility" in js_response.text
    assert "appendSeedVcSettings" in js_response.text
    assert "seedVcPresets" in js_response.text
    assert "applySeedVcPreset" in js_response.text
    assert "syncSeedVcPresetSelection" in js_response.text
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
    assert "syncTranslationBackendAvailability" in js_response.text
    assert "syncVoiceProcessingAvailability" in js_response.text
    assert "pollTranslationJob" in js_response.text
    assert "renderProcessingJob" in js_response.text
    assert "renderPartialResult" in js_response.text
    assert "syncTargetOptions" in js_response.text
    assert "renderError" in js_response.text
    assert css_response.status_code == 200
    assert ".status" in css_response.text
    assert ".runtime-panel" in css_response.text
    assert ".processing-panel" in css_response.text
    assert ".history-panel" in css_response.text
    assert ".error-message" in css_response.text


def test_runtime_api_returns_active_mode_and_provider_names(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    client = TestClient(create_app(voice_conversion_service=_fake_voice_conversion_service()))

    response = client.get("/api/runtime")

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider_mode"] == "fake"
    assert payload["providers"] == {"asr": "fake-asr", "translation": "fake-translation", "tts": "fake-tts"}
    assert payload["supported_voice_modes"] == ["default"]
    assert [backend["id"] for backend in payload["translation_backends"]] == [
        "qwen",
        "openai",
        "openai_realtime",
        "openai_realtime_stream",
    ]
    assert payload["translation_backends"][0]["settings"]["supported_routes"] == [
        {"source_language": "id-ID", "target_language": "ja-JP"},
        {"source_language": "ja-JP", "target_language": "zh-CN"},
    ]
    assert payload["translation_backends"][1]["available"] is False
    assert payload["translation_backends"][2]["available"] is False
    assert payload["translation_backends"][3]["available"] is False
    assert [backend["id"] for backend in payload["text_tts_backends"]] == ["google_translate", "openai"]
    assert payload["voice_conversion_backends"] == [
        {
            "id": "fake-vc",
            "label": "Fake VC",
            "provider": "fake-vc-provider",
            "available": True,
            "reason": "",
            "settings": {},
        }
    ]


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
            "settings": {},
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
            "translation_backend": "qwen",
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


def test_translate_speech_api_saves_local_audio_history(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MO_AUDIO_HISTORY_ENABLED", "1")
    monkeypatch.setenv("MO_AUDIO_HISTORY_DIR", str(tmp_path / "history"))
    monkeypatch.setenv("MO_AUDIO_HISTORY_LIMIT", "10")
    client = TestClient(create_app())

    response = client.post(
        "/api/translate-speech",
        data={"source_language": "ja-JP", "target_language": "zh-CN", "voice_mode": "default"},
        files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
    )

    assert response.status_code == 200
    assert len(list((tmp_path / "history" / "recordings").glob("*.webm"))) == 1
    assert len(list((tmp_path / "history" / "outputs").glob("*.wav"))) == 1


def test_translate_speech_api_accepts_seed_vc_settings_for_convert_mode() -> None:
    captured_request = None

    class CapturingPipeline:
        def run(self, request, progress_callback=None) -> PipelineResult:
            nonlocal captured_request
            captured_request = request
            return PipelineResult(
                transcript="こんにちは。",
                translated_text="你好。",
                transformed_text="你好。",
                output_audio_bytes=b"wav",
                output_audio_mime_type="audio/wav",
                timings_ms={"total": 1.0},
                providers={"asr": "capture-asr", "translation": "capture-translation", "tts": "capture-tts"},
            )

    client = TestClient(create_app(pipeline=CapturingPipeline()))  # type: ignore[arg-type]

    response = client.post(
        "/api/translate-speech",
        data={
            "source_language": "ja-JP",
            "target_language": "zh-CN",
            "voice_mode": "convert",
            "seed_vc_diffusion_steps": "6",
            "seed_vc_length_adjust": "0.95",
            "seed_vc_inference_cfg_rate": "0.6",
            "seed_vc_reference_max_seconds": "5",
        },
        files={"audio": ("sample.wav", b"fake audio", "audio/wav")},
    )

    assert response.status_code == 200
    assert captured_request is not None
    settings = captured_request.voice_settings["seed_vc"]
    assert settings.diffusion_steps == 6
    assert settings.length_adjust == 0.95
    assert settings.inference_cfg_rate == 0.6
    assert settings.reference_max_seconds == 5.0


def test_translate_speech_job_api_reports_progress_and_result() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/api/translate-speech-jobs",
        data={
            "translation_backend": "qwen",
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


def test_translate_speech_job_api_runs_openai_backend() -> None:
    class FakeOpenAiPipeline:
        asr = SimpleNamespace(name="fake-openai-asr")
        translator = SimpleNamespace(name="fake-openai-translation")
        tts = SimpleNamespace(name="fake-openai-tts", supported_voice_modes=("default", "convert"))

        def run(self, request, progress_callback=None) -> PipelineResult:
            if progress_callback is not None:
                progress_callback(PipelineProgress("asr", "文字起こし", self.asr.name))
            return PipelineResult(
                transcript="こんにちは。",
                translated_text="Halo.",
                transformed_text="Halo.",
                output_audio_bytes=b"openai-wav",
                output_audio_mime_type="audio/wav",
                timings_ms={"total": 1.0},
                providers={
                    "asr": "fake-openai-asr",
                    "translation": "fake-openai-translation",
                    "tts": "fake-openai-tts",
                },
            )

    client = TestClient(
        create_app(openai_pipeline=FakeOpenAiPipeline(), voice_conversion_service=_fake_voice_conversion_service())
    )  # type: ignore[arg-type]

    response = client.post(
        "/api/translate-speech-jobs",
        data={"translation_backend": "openai", "source_language": "ja-JP", "target_language": "zh-CN"},
        files={"audio": ("sample.wav", b"fake audio", "audio/wav")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["stages"] == [
        {"stage": "asr", "label": "文字起こし", "provider": "fake-openai-asr"},
        {"stage": "translation", "label": "翻訳", "provider": "fake-openai-translation"},
        {"stage": "text_transform", "label": "テキスト加工", "provider": "なし"},
        {"stage": "tts", "label": "音声生成", "provider": "fake-openai-tts"},
    ]

    for _ in range(20):
        status_payload = client.get(f"/api/translate-speech-jobs/{payload['job_id']}").json()
        if status_payload["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("openai translation job did not finish")

    assert status_payload["result"]["translated_text"] == "Halo."


def test_translate_speech_api_rejects_unknown_translation_backend() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/api/translate-speech",
        data={
            "translation_backend": "unknown",
            "source_language": "id-ID",
            "target_language": "ja-JP",
        },
        files={"audio": ("sample.wav", b"fake audio", "audio/wav")},
    )

    assert response.status_code == 400
    assert "unsupported translation backend" in response.json()["detail"]


def test_text_to_speech_job_api_generates_audio_and_history(tmp_path) -> None:
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

    from mo_speech.audio_history import AudioHistoryStore

    history_store = AudioHistoryStore(root=tmp_path / "history", limit=10, enabled=True)
    client = TestClient(
        create_app(
            text_tts_providers={"fake": FakeTextTtsProvider()},
            voice_conversion_service=_fake_voice_conversion_service(),
            audio_history_store=history_store,
        )
    )

    response = client.post(
        "/api/text-to-speech-jobs",
        data={"text": "こんにちは", "target_language": "ja-JP", "tts_backend": "fake"},
    )

    assert response.status_code == 200
    payload = response.json()
    for _ in range(20):
        status_payload = client.get(f"/api/text-to-speech-jobs/{payload['job_id']}").json()
        if status_payload["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("text-to-speech job did not finish")

    assert status_payload["result"]["providers"] == {"tts": "fake-text-tts"}
    history = client.get("/api/audio-history").json()
    assert len(history["outputs"]) == 1
    audio_response = client.get(history["outputs"][0]["url"])
    assert audio_response.status_code == 200
    assert audio_response.content == "TTS:ja-JP:こんにちは".encode()


def test_openai_realtime_translation_session_api_uses_target_language(monkeypatch) -> None:
    captured = {}

    def fake_client_secret(target_language):
        captured["target_language"] = target_language
        return {"value": "ephemeral-test-key"}

    monkeypatch.setattr("mo_speech.api.create_openai_realtime_translation_client_secret", fake_client_secret)
    client = TestClient(create_app(voice_conversion_service=_fake_voice_conversion_service()))

    response = client.post("/api/openai-realtime-translation-session", json={"target_language": "ja-JP"})

    assert response.status_code == 200
    assert response.json() == {"value": "ephemeral-test-key"}
    assert captured == {"target_language": "ja-JP"}


def test_audio_history_output_api_saves_uploaded_audio(tmp_path) -> None:
    from mo_speech.audio_history import AudioHistoryStore

    history_store = AudioHistoryStore(root=tmp_path / "history", limit=10, enabled=True)
    client = TestClient(
        create_app(
            voice_conversion_service=_fake_voice_conversion_service(),
            audio_history_store=history_store,
        )
    )

    response = client.post(
        "/api/audio-history/outputs",
        data={
            "endpoint": "openai-realtime-streaming",
            "translation_backend": "openai_realtime_stream",
            "target_language": "ja-JP",
        },
        files={"audio": ("streaming.webm", b"streaming output", "audio/webm")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["saved"] is True
    assert payload["entry"]["metadata"]["endpoint"] == "openai-realtime-streaming"
    audio_response = client.get(payload["entry"]["url"])
    assert audio_response.status_code == 200
    assert audio_response.content == b"streaming output"


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


def test_voice_conversion_job_api_accepts_seed_vc_settings() -> None:
    provider = FakeVoiceConversionProvider()
    client = TestClient(create_app(voice_conversion_service=VoiceConversionService(providers=[provider])))

    response = client.post(
        "/api/voice-conversion-jobs",
        data={
            "voice_backend": "fake-vc",
            "seed_vc_diffusion_steps": "5",
            "seed_vc_length_adjust": "1.2",
            "seed_vc_inference_cfg_rate": "0.55",
            "seed_vc_reference_max_seconds": "4.5",
        },
        files={
            "source_audio": ("source.wav", b"source audio", "audio/wav"),
            "reference_audio": ("reference.wav", b"reference audio", "audio/wav"),
        },
    )

    assert response.status_code == 200
    for _ in range(20):
        status_payload = client.get(f"/api/voice-conversion-jobs/{response.json()['job_id']}").json()
        if status_payload["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("voice conversion job did not finish")

    assert provider.last_seed_vc_settings is not None
    assert provider.last_seed_vc_settings.diffusion_steps == 5
    assert provider.last_seed_vc_settings.length_adjust == 1.2
    assert provider.last_seed_vc_settings.inference_cfg_rate == 0.55
    assert provider.last_seed_vc_settings.reference_max_seconds == 4.5


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
        self.last_seed_vc_settings: SeedVcRuntimeSettings | None = None

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
        seed_vc_settings: SeedVcRuntimeSettings | None = None,
        progress_callback=None,
    ):
        self.last_seed_vc_settings = seed_vc_settings
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
