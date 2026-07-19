from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

from mo_speech.providers.openai_api import (
    OpenAiAsrProvider,
    OpenAiTranslationProvider,
    OpenAiTtsProvider,
    create_openai_pipeline,
    create_openai_realtime_translation_pipeline,
    openai_pipeline_status,
    openai_realtime_pipeline_status,
    openai_realtime_streaming_status,
    supported_openai_practice_asr_model,
)


def test_openai_asr_uses_transcription_api(tmp_path: Path, monkeypatch) -> None:
    audio_path = tmp_path / "speech.webm"
    audio_path.write_bytes(b"audio")
    captured: dict[str, object] = {}

    class Transcriptions:
        @staticmethod
        def create(**kwargs):
            captured.update(kwargs)
            return "Selamat pagi."

    client = SimpleNamespace(audio=SimpleNamespace(transcriptions=Transcriptions()))
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=lambda: client))

    provider = OpenAiAsrProvider(model="gpt-4o-transcribe")

    assert provider.transcribe(audio_path, "id-ID") == "Selamat pagi."
    assert captured["model"] == "gpt-4o-transcribe"
    assert captured["language"] == "id"
    assert captured["response_format"] == "json"


def test_openai_asr_omits_language_for_auto_detection(tmp_path: Path, monkeypatch) -> None:
    audio_path = tmp_path / "speech.webm"
    audio_path.write_bytes(b"audio")
    captured: dict[str, object] = {}

    class Transcriptions:
        @staticmethod
        def create(**kwargs):
            captured.update(kwargs)
            return "こんにちは。"

    client = SimpleNamespace(audio=SimpleNamespace(transcriptions=Transcriptions()))
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=lambda: client))

    provider = OpenAiAsrProvider(model="gpt-4o-transcribe")

    assert provider.transcribe(audio_path, "auto") == "こんにちは。"
    assert "language" not in captured


def test_openai_asr_detail_requests_whisper_timestamps(tmp_path: Path, monkeypatch) -> None:
    audio_path = tmp_path / "speech.webm"
    audio_path.write_bytes(b"audio")
    captured: dict[str, object] = {}

    class Transcriptions:
        @staticmethod
        def create(**kwargs):
            captured.update(kwargs)
            return {
                "text": "I want coffee.",
                "words": [{"word": "I", "start": 0.1, "end": 0.2}, {"word": "coffee", "start": 0.6, "end": 1.1}],
                "segments": [{"text": "I want coffee.", "start": 0.1, "end": 1.1}],
            }

    client = SimpleNamespace(audio=SimpleNamespace(transcriptions=Transcriptions()))
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=lambda: client))

    provider = OpenAiAsrProvider(model="whisper-1")
    result = provider.transcribe_detail(audio_path, "en-US", include_timestamps=True)

    assert result.text == "I want coffee."
    assert result.words[0]["text"] == "I"
    assert result.words[0]["start"] == 0.1
    assert result.segments[0]["text"] == "I want coffee."
    assert captured["model"] == "whisper-1"
    assert captured["response_format"] == "verbose_json"
    assert captured["timestamp_granularities"] == ["word", "segment"]
    assert captured["language"] == "en"


def test_supported_practice_asr_model_defaults_to_whisper() -> None:
    assert supported_openai_practice_asr_model(None) == "whisper-1"
    assert supported_openai_practice_asr_model("") == "whisper-1"


def test_openai_asr_detail_does_not_request_timestamps_for_gpt4o(tmp_path: Path, monkeypatch) -> None:
    audio_path = tmp_path / "speech.webm"
    audio_path.write_bytes(b"audio")
    captured: dict[str, object] = {}

    class Transcriptions:
        @staticmethod
        def create(**kwargs):
            captured.update(kwargs)
            return {"text": "I want coffee."}

    client = SimpleNamespace(audio=SimpleNamespace(transcriptions=Transcriptions()))
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=lambda: client))

    provider = OpenAiAsrProvider(model="gpt-4o-transcribe")
    result = provider.transcribe_detail(audio_path, "en-US", include_timestamps=True)

    assert result.text == "I want coffee."
    assert result.words == []
    assert result.segments == []
    assert captured["model"] == "gpt-4o-transcribe"
    assert captured["response_format"] == "json"
    assert "timestamp_granularities" not in captured


def test_openai_asr_retries_unsupported_format_with_http(tmp_path: Path, monkeypatch) -> None:
    audio_path = tmp_path / "speech.m4a"
    audio_path.write_bytes(b"audio")
    captured: dict[str, object] = {}

    class Transcriptions:
        @staticmethod
        def create(**kwargs):
            captured["sdk_kwargs"] = kwargs
            raise RuntimeError("unsupported_format")

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        @staticmethod
        def read():
            return b'{"text":"Selamat pagi."}'

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["headers"] = dict(request.header_items())
        captured["data"] = request.data
        captured["timeout"] = timeout
        return Response()

    client = SimpleNamespace(audio=SimpleNamespace(transcriptions=Transcriptions()))
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=lambda: client))
    monkeypatch.setattr("mo_speech.providers.openai_api.urlopen", fake_urlopen)

    provider = OpenAiAsrProvider(model="gpt-4o-transcribe")

    assert provider.transcribe(audio_path, "id-ID") == "Selamat pagi."
    assert captured["url"] == "https://api.openai.com/v1/audio/transcriptions"
    assert captured["headers"]["Authorization"] == "Bearer test-key"
    assert captured["timeout"] == 90.0
    assert b'name="model"\r\n\r\ngpt-4o-transcribe' in captured["data"]
    assert b'name="response_format"\r\n\r\njson' in captured["data"]
    assert b'name="language"\r\n\r\nid' in captured["data"]
    assert b'filename="speech.m4a"' in captured["data"]


def test_openai_translation_uses_responses_api(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class Responses:
        @staticmethod
        def create(**kwargs):
            captured.update(kwargs)
            return SimpleNamespace(output_text="おはようございます。")

    client = SimpleNamespace(responses=Responses())
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=lambda: client))

    provider = OpenAiTranslationProvider(model="test-translation-model")

    assert provider.translate("Selamat pagi.", "id-ID", "ja-JP") == "おはようございます。"
    assert captured["model"] == "test-translation-model"
    assert "professional speech translation engine" in captured["instructions"]
    assert "Indonesian" in captured["input"]
    assert "Japanese" in captured["input"]


def test_openai_tts_uses_speech_api(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class Speech:
        @staticmethod
        def create(**kwargs):
            captured.update(kwargs)
            return SimpleNamespace(content=b"wav")

    client = SimpleNamespace(audio=SimpleNamespace(speech=Speech()))
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=lambda: client))

    provider = OpenAiTtsProvider(model="gpt-4o-mini-tts", voice="coral", response_format="wav")

    output = provider.synthesize("こんにちは。", "ja-JP")

    assert output.audio_bytes == b"wav"
    assert output.audio_mime_type == "audio/wav"
    assert captured["model"] == "gpt-4o-mini-tts"
    assert captured["voice"] == "coral"
    assert captured["response_format"] == "wav"
    assert captured["input"] == "こんにちは。"


def test_create_openai_pipeline_supports_default_and_seed_vc(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_TRANSLATION_MODEL", raising=False)
    pipeline = create_openai_pipeline()

    assert pipeline.asr.name == "openai-asr-gpt-4o-transcribe"
    assert pipeline.translator.name == "openai-translation-gpt-5.6-terra"
    assert pipeline.tts.supported_voice_modes == ("default", "convert")


def test_openai_pipeline_status_requires_api_key(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    status = openai_pipeline_status(create_openai_pipeline())

    assert status["available"] is False
    assert status["reason"] == "OPENAI_API_KEY が設定されていません。"


def test_openai_realtime_pipeline_status_reports_backend(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "websocket", SimpleNamespace(WebSocket=object))

    status = openai_realtime_pipeline_status(create_openai_realtime_translation_pipeline())

    assert status["id"] == "openai_realtime"
    assert status["available"] is True
    assert status["settings"]["source_language_mode"] == "auto"
    assert "ja-JP" in status["settings"]["supported_target_languages"]


def test_openai_realtime_streaming_status_reports_backend(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    status = openai_realtime_streaming_status()

    assert status["id"] == "openai_realtime_stream"
    assert status["available"] is True
    assert status["settings"]["streaming"] is True
    assert status["settings"]["source_language_mode"] == "auto"
