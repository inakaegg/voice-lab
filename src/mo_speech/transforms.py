from __future__ import annotations

import re


_SENTENCE_END_RE = re.compile(r"([^。！？!?]+)([。！？!?])")


def apply_text_transform(text: str, transform: str | None, options: dict[str, str]) -> str:
    if transform is None or transform == "":
        return text
    if transform != "append_suffix":
        raise ValueError(f"unsupported text transform: {transform}")

    suffix = options.get("suffix", "")
    if suffix == "":
        return text

    unit = options.get("unit", "text")
    if unit == "text":
        return f"{text}{suffix}"
    if unit == "sentence":
        return _append_suffix_to_sentences(text, suffix)
    raise ValueError(f"unsupported append_suffix unit: {unit}")


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
