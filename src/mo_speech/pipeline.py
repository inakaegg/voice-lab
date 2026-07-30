from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol


class AsrProvider(Protocol):
    name: str

    def transcribe(self, audio_path: Path, source_language: str) -> str:
        raise NotImplementedError


class TranslationProvider(Protocol):
    name: str

    def translate(self, text: str, source_language: str, target_language: str) -> str:
        raise NotImplementedError


class TtsProvider(Protocol):
    name: str
    audio_mime_type: str

    def synthesize(self, text: str, target_language: str) -> bytes | "TtsOutput":
        raise NotImplementedError


@dataclass(frozen=True)
class OperationProgress:
    stage: str
    label: str
    provider: str


ProgressCallback = Callable[[OperationProgress], None]


@dataclass(frozen=True)
class TtsOutput:
    audio_bytes: bytes
    audio_mime_type: str | None = None
    timings_ms: dict[str, float] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


class SpeechProviderBundle:
    """SpeakLoopで共有するASR・翻訳・TTS providerの束。"""

    def __init__(self, *, asr: AsrProvider, translator: TranslationProvider, tts: TtsProvider) -> None:
        self.asr = asr
        self.translator = translator
        self.tts = tts

    def preload(self) -> None:
        for provider in (self.asr, self.translator, self.tts):
            preload = getattr(provider, "preload", None)
            if preload is not None:
                preload()
