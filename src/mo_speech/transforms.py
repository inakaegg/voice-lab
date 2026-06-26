from __future__ import annotations

import os
import re
from typing import Any


_SENTENCE_END_RE = re.compile(r"([^。！？!?]+)([。！？!?])")


def apply_text_transform(text: str, transform: str | None, options: dict[str, object]) -> str:
    if transform is None or transform == "":
        return text
    if transform == "append_suffix":
        return _apply_append_suffix(text, options)
    if transform == "user_effects":
        return _apply_user_effects(text, options)
    raise ValueError(f"unsupported text transform: {transform}")


def _apply_append_suffix(text: str, options: dict[str, object]) -> str:
    suffix = str(options.get("suffix", ""))
    if suffix == "":
        return text

    unit = str(options.get("unit", "text"))
    if unit == "text":
        return f"{text}{suffix}"
    if unit == "sentence":
        return _append_suffix_to_sentences(text, suffix)
    raise ValueError(f"unsupported append_suffix unit: {unit}")


def _apply_user_effects(text: str, options: dict[str, object]) -> str:
    output = text
    if _option_enabled(options.get("osaka_dialect")) or _option_enabled(options.get("variation")):
        output = _rewrite_user_effects_with_openai(
            output,
            osaka_dialect=_option_enabled(options.get("osaka_dialect")),
            variation=_option_enabled(options.get("variation")),
        )

    joke_text = str(options.get("joke_text", "")).strip()
    if joke_text:
        joke_position = str(options.get("joke_position", "after"))
        if joke_position == "before":
            output = f"{joke_text} {output}".strip()
        elif joke_position == "after":
            output = f"{output} {joke_text}".strip()
        else:
            raise ValueError(f"unsupported joke_position: {joke_position}")
    return output


def _append_suffix_to_sentences(text: str, suffix: str) -> str:
    output_parts: list[str] = []
    cursor = 0

    for match in _SENTENCE_END_RE.finditer(text):
        output_parts.append(text[cursor : match.start()])
        output_parts.append(match.group(1))
        output_parts.append(suffix)
        output_parts.append(match.group(2))
        cursor = match.end()

    if cursor < len(text):
        output_parts.append(text[cursor:])

    return "".join(output_parts)


def _rewrite_user_effects_with_openai(text: str, *, osaka_dialect: bool, variation: bool) -> str:
    if not text.strip():
        return ""
    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required for LLM user effects.")
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError("openai package is required for LLM user effects.") from exc

    instructions = [
        "You rewrite short Japanese spoken output for a playful speech conversion app.",
        "Return only the rewritten Japanese text, with no notes.",
        "Keep it concise and suitable for text-to-speech.",
    ]
    if osaka_dialect:
        instructions.append("Use natural Osaka dialect while preserving the speaker's intent.")
    if variation:
        instructions.append(
            "Create a small playful variation of the request by changing a concrete number, condition, or target "
            "when that is natural; do not make it offensive or confusing."
        )

    response = OpenAI().responses.create(
        model=os.getenv("OPENAI_TEXT_TRANSFORM_MODEL", os.getenv("OPENAI_TRANSLATION_MODEL", "gpt-5.5")),
        instructions=" ".join(instructions),
        input=text,
    )
    return _text_from_response(response) or text


def _option_enabled(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).lower() in {"1", "true", "yes", "on"}


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
