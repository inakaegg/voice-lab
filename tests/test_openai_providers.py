from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

from mo_speech.providers.openai_api import (
    OpenAiAsrProvider,
    OpenAiTranslationProvider,
    OpenAiTtsProvider,
    create_openai_pipeline,
    openai_pipeline_status,
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
    assert captured["response_format"] == "text"


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

    provider = OpenAiTranslationProvider(model="gpt-5.5")

    assert provider.translate("Selamat pagi.", "id-ID", "ja-JP") == "おはようございます。"
    assert captured["model"] == "gpt-5.5"
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


def test_create_openai_pipeline_supports_default_and_seed_vc() -> None:
    pipeline = create_openai_pipeline()

    assert pipeline.asr.name == "openai-asr-gpt-4o-transcribe"
    assert pipeline.translator.name == "openai-translation-gpt-5.5"
    assert pipeline.tts.supported_voice_modes == ("default", "convert")


def test_openai_pipeline_status_requires_api_key(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    status = openai_pipeline_status(create_openai_pipeline())

    assert status["available"] is False
    assert status["reason"] == "OPENAI_API_KEY が設定されていません。"
