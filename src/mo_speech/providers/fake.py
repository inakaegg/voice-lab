from __future__ import annotations

from pathlib import Path


class FakeAsrProvider:
    name = "fake-asr"

    def __init__(self, transcripts_by_language: dict[str, str]) -> None:
        self.transcripts_by_language = transcripts_by_language

    def transcribe(self, audio_path: Path, source_language: str) -> str:
        if source_language not in self.transcripts_by_language:
            raise ValueError(f"fake transcript is not configured for {source_language}")
        if audio_path.read_bytes() == b"":
            raise ValueError("fake audio must not be empty")
        return self.transcripts_by_language[source_language]


class FakeTranslationProvider:
    name = "fake-translation"

    def __init__(self, translations: dict[tuple[str, str, str], str]) -> None:
        self.translations = translations

    def translate(self, text: str, source_language: str, target_language: str) -> str:
        key = (source_language, target_language, text)
        if key not in self.translations:
            raise ValueError(f"fake translation is not configured for {source_language} -> {target_language}")
        return self.translations[key]


class FakeTtsProvider:
    name = "fake-tts"
    audio_mime_type = "audio/wav"

    def synthesize(self, text: str, target_language: str) -> bytes:
        return f"FAKE-WAV:{target_language}:{text}".encode("utf-8")
