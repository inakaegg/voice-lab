from __future__ import annotations

import os
from dataclasses import dataclass, field
from time import perf_counter
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ..pipeline import TtsOutput
from .openai_api import OPENAI_LANGUAGE_NAMES, OpenAiTtsProvider


GOOGLE_TTS_LANGUAGE_CODES = {
    "id-ID": "id",
    "ja-JP": "ja",
    "zh-CN": "zh-CN",
    "en-US": "en",
}


@dataclass
class GoogleTranslateTtsProvider:
    timeout_seconds: float = field(default_factory=lambda: float(os.getenv("GOOGLE_TTS_TIMEOUT_SECONDS", "30")))

    name = "google-translate-tts-endpoint"
    audio_mime_type = "audio/mpeg"

    def synthesize(self, text: str, target_language: str) -> TtsOutput:
        if target_language not in GOOGLE_TTS_LANGUAGE_CODES:
            raise ValueError(f"Google Translate TTS language is not configured for {target_language}")
        if not text.strip():
            raise ValueError("text is required")
        started = perf_counter()
        query = urlencode(
            {
                "ie": "UTF-8",
                "client": "tw-ob",
                "tl": GOOGLE_TTS_LANGUAGE_CODES[target_language],
                "q": text,
            }
        )
        request = Request(
            f"https://translate.google.com/translate_tts?{query}",
            headers={
                "User-Agent": "Mozilla/5.0",
            },
        )
        with urlopen(request, timeout=self.timeout_seconds) as response:
            audio_bytes = response.read()
        return TtsOutput(
            audio_bytes=audio_bytes,
            audio_mime_type=self.audio_mime_type,
            timings_ms={"tts": _elapsed_ms(started), "total": _elapsed_ms(started)},
        )


def create_text_tts_providers() -> dict[str, object]:
    return {
        "google_translate": GoogleTranslateTtsProvider(),
        "openai": OpenAiTtsProvider(),
    }


def text_tts_backend_statuses(providers: dict[str, object]) -> list[dict[str, object]]:
    statuses: list[dict[str, object]] = []
    google_provider = providers.get("google_translate")
    if google_provider is not None:
        statuses.append(
            {
                "id": "google_translate",
                "label": "Google Translate TTS endpoint",
                "available": True,
                "reason": "",
                "provider": google_provider.name,
                "settings": {
                    "supported_target_languages": list(GOOGLE_TTS_LANGUAGE_CODES.keys()),
                    "official_api": False,
                },
            }
        )
    openai_provider = providers.get("openai")
    if openai_provider is not None:
        statuses.append(
            {
                "id": "openai",
                "label": "OpenAI TTS API",
                "available": bool(os.getenv("OPENAI_API_KEY")),
                "reason": "" if os.getenv("OPENAI_API_KEY") else "OPENAI_API_KEY が設定されていません。",
                "provider": openai_provider.name,
                "settings": {
                    "supported_target_languages": [language for language in OPENAI_LANGUAGE_NAMES if language != "auto"],
                    "official_api": True,
                },
            }
        )
    return statuses


def _elapsed_ms(started: float) -> float:
    return (perf_counter() - started) * 1000
