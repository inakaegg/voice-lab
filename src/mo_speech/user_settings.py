from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any


DEFAULT_USER_SETTINGS_PATH = "tmp/user-settings.json"
SUPPORTED_USER_TARGET_LANGUAGES = {"id-ID", "ja-JP", "zh-CN", "en-US"}
SUPPORTED_JOKE_POSITIONS = {"before", "after"}
SUPPORTED_JOKE_SELECTIONS = {"rotation", "random"}
SUPPORTED_EFFECT_SELECTIONS = {"rotation", "random"}
SUPPORTED_EFFECT_INSERT_MODES = {"silence_or_tail", "tail"}
SUPPORTED_USER_THEMES = {"blue", "pop", "mint"}
MAX_JOKE_TEXTS = 20
MAX_JOKE_VARIATION_COUNT = 5
MAX_JOKE_VARIANTS = MAX_JOKE_TEXTS * MAX_JOKE_VARIATION_COUNT
MAX_EFFECT_AUDIOS = 20
MAX_EFFECT_AUDIO_BASE64_CHARS = 2_000_000


@dataclass(frozen=True)
class UserEffectAudio:
    id: str
    name: str
    audio_mime_type: str
    audio_base64: str


@dataclass(frozen=True)
class UserExperienceSettings:
    target_language: str = "ja-JP"
    joke_text: str = ""
    joke_texts: tuple[str, ...] = ()
    joke_position: str = "after"
    joke_selection: str = "rotation"
    joke_variation_count: int = 0
    joke_variants: tuple[str, ...] = ()
    effect_audios: tuple[UserEffectAudio, ...] = ()
    effect_selection: str = "rotation"
    effect_insert_mode: str = "silence_or_tail"
    effect_max_insertions: int = 1
    effect_min_silence_ms: int = 300
    theme: str = "blue"


@dataclass
class UserSettingsStore:
    path: Path

    @classmethod
    def from_env(cls) -> "UserSettingsStore":
        return cls(path=Path(os.getenv("MO_USER_SETTINGS_PATH", DEFAULT_USER_SETTINGS_PATH)).expanduser())

    def read(self) -> UserExperienceSettings:
        if not self.path.is_file():
            return UserExperienceSettings()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return UserExperienceSettings()
        if not isinstance(payload, dict):
            return UserExperienceSettings()
        return _coerce_settings(payload)

    def write(self, payload: dict[str, object]) -> UserExperienceSettings:
        settings = _coerce_settings(payload)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(asdict(settings), ensure_ascii=False, indent=2), encoding="utf-8")
        return settings


def serialize_user_settings(settings: UserExperienceSettings) -> dict[str, object]:
    payload = asdict(settings)
    payload["joke_texts"] = list(settings.joke_texts)
    payload["joke_variants"] = list(settings.joke_variants)
    payload["joke_pool"] = list(joke_pool(settings))
    payload["effect_audios"] = [asdict(effect_audio) for effect_audio in settings.effect_audios]
    return payload


def prepare_user_settings_for_write(payload: dict[str, object]) -> dict[str, object]:
    settings = _coerce_settings(payload)
    if settings.joke_variation_count <= 0 or not settings.joke_texts:
        return asdict(replace(settings, joke_variants=()))
    variants = _generate_joke_variants_with_openai(settings.joke_texts, settings.joke_variation_count)
    return asdict(replace(settings, joke_variants=tuple(variants)))


def joke_pool(settings: UserExperienceSettings) -> tuple[str, ...]:
    return (*settings.joke_texts, *settings.joke_variants)


def _coerce_settings(payload: dict[str, object]) -> UserExperienceSettings:
    target_language = str(payload.get("target_language", "ja-JP"))
    if target_language not in SUPPORTED_USER_TARGET_LANGUAGES:
        raise ValueError(f"unsupported target_language: {target_language}")

    joke_position = str(payload.get("joke_position", "after"))
    if joke_position not in SUPPORTED_JOKE_POSITIONS:
        raise ValueError(f"unsupported joke_position: {joke_position}")

    joke_selection = str(payload.get("joke_selection", "rotation"))
    if joke_selection not in SUPPORTED_JOKE_SELECTIONS:
        raise ValueError(f"unsupported joke_selection: {joke_selection}")

    joke_texts = _coerce_joke_texts(payload.get("joke_texts"), payload.get("joke_text", ""))
    joke_variation_count = _coerce_joke_variation_count(payload.get("joke_variation_count", 0))
    joke_variants = _coerce_text_list(payload.get("joke_variants"), max_items=MAX_JOKE_VARIANTS) if joke_variation_count > 0 else ()

    effect_audios = _coerce_effect_audios(payload.get("effect_audios"))
    effect_selection = str(payload.get("effect_selection", "rotation"))
    if effect_selection not in SUPPORTED_EFFECT_SELECTIONS:
        raise ValueError(f"unsupported effect_selection: {effect_selection}")
    effect_insert_mode = str(payload.get("effect_insert_mode", "silence_or_tail"))
    if effect_insert_mode not in SUPPORTED_EFFECT_INSERT_MODES:
        raise ValueError(f"unsupported effect_insert_mode: {effect_insert_mode}")
    effect_max_insertions = _coerce_int_range(payload.get("effect_max_insertions", 1), 1, 5, "effect_max_insertions")
    effect_min_silence_ms = _coerce_int_range(
        payload.get("effect_min_silence_ms", 300),
        100,
        2000,
        "effect_min_silence_ms",
    )

    theme = str(payload.get("theme", "blue"))
    if theme not in SUPPORTED_USER_THEMES:
        raise ValueError(f"unsupported theme: {theme}")

    return UserExperienceSettings(
        target_language=target_language,
        joke_text="\n".join(joke_texts),
        joke_texts=joke_texts,
        joke_position=joke_position,
        joke_selection=joke_selection,
        joke_variation_count=joke_variation_count,
        joke_variants=joke_variants,
        effect_audios=effect_audios,
        effect_selection=effect_selection,
        effect_insert_mode=effect_insert_mode,
        effect_max_insertions=effect_max_insertions,
        effect_min_silence_ms=effect_min_silence_ms,
        theme=theme,
    )


def _coerce_joke_texts(value: object, legacy_value: object) -> tuple[str, ...]:
    if isinstance(value, list):
        return _coerce_text_list(value, max_items=MAX_JOKE_TEXTS)
    if isinstance(value, tuple):
        return _coerce_text_list(list(value), max_items=MAX_JOKE_TEXTS)
    return _split_joke_texts(str(legacy_value or ""))


def _coerce_text_list(value: object, *, max_items: int) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    texts: list[str] = []
    for item in value:
        text = str(item).strip()
        if text:
            texts.append(text)
        if len(texts) >= max_items:
            break
    return tuple(texts)


def _split_joke_texts(value: str) -> tuple[str, ...]:
    return tuple(line.strip() for line in value.splitlines() if line.strip())[:MAX_JOKE_TEXTS]


def _coerce_joke_variation_count(value: object) -> int:
    try:
        count = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"unsupported joke_variation_count: {value}") from None
    if count < 0 or count > MAX_JOKE_VARIATION_COUNT:
        raise ValueError(f"unsupported joke_variation_count: {count}")
    return count


def _coerce_int_range(value: object, minimum: int, maximum: int, field_name: str) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"unsupported {field_name}: {value}") from None
    if number < minimum or number > maximum:
        raise ValueError(f"unsupported {field_name}: {number}")
    return number


def _coerce_effect_audios(value: object) -> tuple[UserEffectAudio, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    effect_audios: list[UserEffectAudio] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            continue
        audio_base64 = str(item.get("audio_base64", "")).strip()
        if not audio_base64 or len(audio_base64) > MAX_EFFECT_AUDIO_BASE64_CHARS:
            continue
        name = str(item.get("name", "")).strip() or f"effect-{index + 1}.wav"
        audio_mime_type = str(item.get("audio_mime_type", "")).split(";", 1)[0].strip().lower() or "audio/wav"
        effect_audios.append(
            UserEffectAudio(
                id=str(item.get("id", "")).strip() or f"effect-{index + 1}",
                name=name[:120],
                audio_mime_type=audio_mime_type,
                audio_base64=audio_base64,
            )
        )
        if len(effect_audios) >= MAX_EFFECT_AUDIOS:
            break
    return tuple(effect_audios)


def _generate_joke_variants_with_openai(joke_texts: tuple[str, ...], variation_count: int) -> tuple[str, ...]:
    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required for joke variations.")
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError("openai package is required for joke variations.") from exc

    response = OpenAI().responses.create(
        model=os.getenv("OPENAI_JOKE_VARIATION_MODEL", os.getenv("OPENAI_TEXT_TRANSFORM_MODEL", "gpt-5.5")),
        instructions=(
            "You create short joke text variations for a speech conversion app. "
            "Keep each variation in the same language as its source joke. "
            "Return only strict JSON in this shape: "
            '{"variants":[["variant 1 for source 1","variant 2 for source 1"],'
            '["variant 1 for source 2","variant 2 for source 2"]]}. '
            "Each inner array must correspond to the source joke at the same index."
        ),
        input=json.dumps(
            {"jokes": list(joke_texts), "variants_per_joke": variation_count},
            ensure_ascii=False,
        ),
    )
    return _parse_joke_variants_response(_text_from_response(response), len(joke_texts), variation_count)


def _parse_joke_variants_response(raw_text: str, source_count: int, variation_count: int) -> tuple[str, ...]:
    raw_text = raw_text.strip()
    if raw_text.startswith("```"):
        raw_text = raw_text.strip("`")
        if raw_text.startswith("json"):
            raw_text = raw_text[4:].strip()
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise RuntimeError("joke variation response was not valid JSON") from exc
    variants = payload.get("variants") if isinstance(payload, dict) else payload
    if not isinstance(variants, list):
        raise RuntimeError("joke variation response did not include variants")

    matrix: list[list[str]] = []
    if all(isinstance(row, list) for row in variants):
        for row in variants[:source_count]:
            texts = [str(item).strip() for item in row if str(item).strip()]
            matrix.append(texts[:variation_count])
    else:
        flat = [str(item).strip() for item in variants if str(item).strip()]
        matrix = [
            flat[index * variation_count : (index + 1) * variation_count]
            for index in range(source_count)
        ]

    if len(matrix) < source_count or any(len(row) < variation_count for row in matrix):
        raise RuntimeError("joke variation response did not include enough variants")

    ordered: list[str] = []
    for variant_index in range(variation_count):
        for source_index in range(source_count):
            ordered.append(matrix[source_index][variant_index])
    return tuple(ordered)


def _text_from_response(response: Any) -> str:
    output_text = getattr(response, "output_text", None)
    if output_text is not None:
        return str(output_text).strip()
    text = getattr(response, "text", None)
    if text is not None:
        return str(text).strip()
    return str(response).strip()
