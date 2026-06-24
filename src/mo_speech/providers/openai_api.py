from __future__ import annotations

import importlib.util
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..pipeline import SpeechTranslationPipeline, TtsOutput
from .voice import SeedVcVoiceConversionTtsProvider


OPENAI_LANGUAGE_CODES = {
    "id-ID": "id",
    "ja-JP": "ja",
    "zh-CN": "zh",
}

OPENAI_LANGUAGE_NAMES = {
    "id-ID": "Indonesian",
    "ja-JP": "Japanese",
    "zh-CN": "Simplified Chinese",
}

OPENAI_TTS_MIME_TYPES = {
    "mp3": "audio/mpeg",
    "opus": "audio/ogg",
    "aac": "audio/aac",
    "flac": "audio/flac",
    "wav": "audio/wav",
    "pcm": "audio/wav",
}


@dataclass
class OpenAiAsrProvider:
    model: str = field(default_factory=lambda: os.getenv("OPENAI_ASR_MODEL", "gpt-4o-transcribe"))
    response_format: str = "text"
    _client: Any | None = field(default=None, init=False, repr=False)

    @property
    def name(self) -> str:
        return f"openai-asr-{self.model}"

    def transcribe(self, audio_path: Path, source_language: str) -> str:
        if source_language not in OPENAI_LANGUAGE_CODES:
            raise ValueError(f"OpenAI ASR language is not configured for {source_language}")
        client = self._load_client()
        with audio_path.open("rb") as audio_file:
            response = client.audio.transcriptions.create(
                model=self.model,
                file=audio_file,
                language=OPENAI_LANGUAGE_CODES[source_language],
                response_format=self.response_format,
            )
        return _text_from_response(response)

    def _load_client(self) -> Any:
        if self._client is None:
            self._client = _create_openai_client()
        return self._client


@dataclass
class OpenAiTranslationProvider:
    model: str = field(default_factory=lambda: os.getenv("OPENAI_TRANSLATION_MODEL", "gpt-5.5"))
    _client: Any | None = field(default=None, init=False, repr=False)

    @property
    def name(self) -> str:
        return f"openai-translation-{self.model}"

    def translate(self, text: str, source_language: str, target_language: str) -> str:
        if source_language not in OPENAI_LANGUAGE_NAMES:
            raise ValueError(f"OpenAI source language is not configured for {source_language}")
        if target_language not in OPENAI_LANGUAGE_NAMES:
            raise ValueError(f"OpenAI target language is not configured for {target_language}")
        if not text.strip():
            return ""

        response = self._load_client().responses.create(
            model=self.model,
            instructions=(
                "You are a professional speech translation engine. "
                "Return only the translated text, with no notes."
            ),
            input=(
                f"Translate the following {OPENAI_LANGUAGE_NAMES[source_language]} conversational transcript "
                f"into natural {OPENAI_LANGUAGE_NAMES[target_language]}.\n"
                "Preserve the intent, politeness, and spoken context.\n\n"
                f"{text}"
            ),
        )
        return _text_from_response(response)

    def _load_client(self) -> Any:
        if self._client is None:
            self._client = _create_openai_client()
        return self._client


@dataclass
class OpenAiTtsProvider:
    model: str = field(default_factory=lambda: os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"))
    voice: str = field(default_factory=lambda: os.getenv("OPENAI_TTS_VOICE", "coral"))
    response_format: str = field(default_factory=lambda: os.getenv("OPENAI_TTS_RESPONSE_FORMAT", "wav"))
    instructions: str = field(
        default_factory=lambda: os.getenv(
            "OPENAI_TTS_INSTRUCTIONS",
            "Speak naturally and clearly in the target language.",
        )
    )
    _client: Any | None = field(default=None, init=False, repr=False)

    supported_voice_modes = ("default",)

    @property
    def name(self) -> str:
        return f"openai-tts-{self.model}"

    @property
    def audio_mime_type(self) -> str:
        return OPENAI_TTS_MIME_TYPES.get(self.response_format, "audio/wav")

    def synthesize(self, text: str, target_language: str) -> TtsOutput:
        if target_language not in OPENAI_LANGUAGE_NAMES:
            raise ValueError(f"OpenAI TTS target language is not configured for {target_language}")
        response = self._load_client().audio.speech.create(
            model=self.model,
            voice=self.voice,
            input=text,
            instructions=self.instructions,
            response_format=self.response_format,
        )
        return TtsOutput(
            audio_bytes=_bytes_from_response(response),
            audio_mime_type=self.audio_mime_type,
        )

    def _load_client(self) -> Any:
        if self._client is None:
            self._client = _create_openai_client()
        return self._client


@dataclass
class OpenAiSeedVcTtsProvider:
    base_tts: OpenAiTtsProvider = field(default_factory=OpenAiTtsProvider)
    seed_vc_tts: SeedVcVoiceConversionTtsProvider | None = None

    supported_voice_modes = ("default", "convert")

    def __post_init__(self) -> None:
        if self.seed_vc_tts is None:
            self.seed_vc_tts = SeedVcVoiceConversionTtsProvider(base_tts=self.base_tts)

    @property
    def name(self) -> str:
        return f"openai-tts-seed-vc-{self.base_tts.model}"

    @property
    def audio_mime_type(self) -> str:
        return "audio/wav"

    def synthesize(self, text: str, target_language: str) -> TtsOutput:
        return self.base_tts.synthesize(text, target_language)

    def synthesize_with_voice(self, *args, **kwargs) -> TtsOutput:
        if kwargs.get("voice_mode") != "convert":
            return self.base_tts.synthesize(args[0], args[1])
        assert self.seed_vc_tts is not None
        return self.seed_vc_tts.synthesize_with_voice(*args, **kwargs)


def create_openai_pipeline() -> SpeechTranslationPipeline:
    return SpeechTranslationPipeline(
        asr=OpenAiAsrProvider(),
        translator=OpenAiTranslationProvider(),
        tts=OpenAiSeedVcTtsProvider(),
    )


def openai_pipeline_status(pipeline: SpeechTranslationPipeline) -> dict[str, object]:
    available = True
    reason = ""
    if not os.getenv("OPENAI_API_KEY"):
        available = False
        reason = "OPENAI_API_KEY が設定されていません。"
    elif not _openai_module_available():
        available = False
        reason = "openai packageがインストールされていません。"
    return {
        "id": "openai",
        "label": "音声翻訳（OpenAI API）",
        "available": available,
        "reason": reason,
        "providers": {
            "asr": pipeline.asr.name,
            "translation": pipeline.translator.name,
            "tts": pipeline.tts.name,
        },
    }


def _create_openai_client() -> Any:
    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required for OpenAI API backend.")
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError("openai package is required for OpenAI API backend.") from exc
    return OpenAI()


def _text_from_response(response: Any) -> str:
    if isinstance(response, str):
        return response.strip()
    output_text = getattr(response, "output_text", None)
    if output_text is not None:
        return str(output_text).strip()
    text = getattr(response, "text", None)
    if text is not None:
        return str(text).strip()
    return str(response).strip()


def _bytes_from_response(response: Any) -> bytes:
    content = getattr(response, "content", None)
    if isinstance(content, bytes):
        return content
    read = getattr(response, "read", None)
    if callable(read):
        data = read()
        if isinstance(data, bytes):
            return data
    if isinstance(response, bytes):
        return response
    return bytes(response)


def _openai_module_available() -> bool:
    if "openai" in sys.modules:
        return True
    return importlib.util.find_spec("openai") is not None
