from __future__ import annotations

import os

from .openai_api import OPENAI_LANGUAGE_NAMES, OpenAiTtsProvider


def create_text_tts_providers() -> dict[str, object]:
    return {
        "openai": OpenAiTtsProvider(),
    }


def text_tts_backend_statuses(providers: dict[str, object]) -> list[dict[str, object]]:
    statuses: list[dict[str, object]] = []
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
                    "supported_target_languages": list(OPENAI_LANGUAGE_NAMES.keys()),
                    "official_api": True,
                },
            }
        )
    return statuses
