from __future__ import annotations

import os
from dataclasses import dataclass, asdict
from typing import Any


@dataclass(frozen=True)
class UserDisplayText:
    kanji_text: str
    hiragana_text: str
    indonesian_text: str


def create_user_display_text(text: str, target_language: str) -> dict[str, str]:
    kanji_text = text.strip()
    if not kanji_text:
        return asdict(UserDisplayText(kanji_text=kanji_text, hiragana_text="", indonesian_text=""))
    if target_language == "id-ID":
        return asdict(UserDisplayText(kanji_text=kanji_text, hiragana_text="", indonesian_text=kanji_text))
    if target_language != "ja-JP":
        return asdict(UserDisplayText(kanji_text=kanji_text, hiragana_text="", indonesian_text=""))
    return asdict(
        UserDisplayText(
            kanji_text=kanji_text,
            hiragana_text=_hiragana_with_openai(kanji_text),
            indonesian_text="",
        )
    )


def _hiragana_with_openai(text: str) -> str:
    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required for Japanese hiragana display text.")
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError("openai package is required for Japanese hiragana display text.") from exc

    response = OpenAI().responses.create(
        model=os.getenv("OPENAI_TEXT_DISPLAY_MODEL", os.getenv("OPENAI_TEXT_TRANSFORM_MODEL", "gpt-5.6-terra")),
        instructions=(
            "Convert the Japanese sentence to hiragana only for display to language learners. "
            "Return only the hiragana text, with no notes. Keep punctuation and Arabic numerals readable."
        ),
        input=text,
    )
    return _text_from_response(response)


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
