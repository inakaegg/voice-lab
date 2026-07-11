from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any


DEFAULT_PUBLIC_SAMPLE_AUDIO_PATH = "tmp/public-sample-audios.json"
PUBLIC_SAMPLE_FEATURES = ("fun", "voice_conversion", "speakloop", "skitvoice")
PUBLIC_SAMPLE_LANGUAGES = ("ja-JP", "zh-CN", "en-US")
PUBLIC_SAMPLE_AUDIO_MAX_BYTES = 1_800_000


def empty_public_sample_audios() -> dict[str, object]:
    return {
        "features": {
            "fun": None,
            "voice_conversion": None,
            "speakloop": None,
            "skitvoice": {"samples": {language: None for language in PUBLIC_SAMPLE_LANGUAGES}},
        }
    }


@dataclass
class PublicSampleAudioStore:
    path: Path

    @classmethod
    def from_env(cls) -> "PublicSampleAudioStore":
        return cls(Path(os.getenv("MO_PUBLIC_SAMPLE_AUDIO_PATH", DEFAULT_PUBLIC_SAMPLE_AUDIO_PATH)).expanduser())

    def read(self) -> dict[str, object]:
        if not self.path.is_file():
            return empty_public_sample_audios()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return empty_public_sample_audios()
        return normalize_public_sample_audios(payload)

    def write(self, payload: object) -> dict[str, object]:
        samples = normalize_public_sample_audios(payload)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile("w", encoding="utf-8", dir=self.path.parent, delete=False) as temporary:
            json.dump(samples, temporary, ensure_ascii=False, indent=2)
            temporary_path = Path(temporary.name)
        temporary_path.replace(self.path)
        return samples

    def delete(self, feature: str, language: str = "") -> dict[str, object]:
        if feature not in PUBLIC_SAMPLE_FEATURES:
            raise ValueError("sample audio feature is not found")
        if language and language not in PUBLIC_SAMPLE_LANGUAGES:
            raise ValueError(f"unsupported sample language: {language}")
        samples = self.read()
        features = samples["features"]
        if language:
            feature_value = features.get(feature)
            if not isinstance(feature_value, dict) or not isinstance(feature_value.get("samples"), dict):
                raise ValueError("sample audio feature does not support languages")
            feature_value["samples"][language] = None
        else:
            features[feature] = None
        return self.write(samples)


def normalize_public_sample_audios(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise ValueError("sample audio payload must be an object")
    raw_features = payload.get("features", payload)
    if not isinstance(raw_features, dict):
        raise ValueError("sample audio features must be an object")
    unknown_features = set(raw_features) - set(PUBLIC_SAMPLE_FEATURES)
    if unknown_features:
        raise ValueError(f"unsupported sample feature: {sorted(unknown_features)[0]}")

    normalized = empty_public_sample_audios()
    features = normalized["features"]
    for feature in PUBLIC_SAMPLE_FEATURES:
        raw = raw_features.get(feature)
        if isinstance(raw, dict) and "samples" in raw:
            raw_samples = raw.get("samples")
            if not isinstance(raw_samples, dict):
                raise ValueError(f"sample languages for {feature} must be an object")
            unknown_languages = set(raw_samples) - set(PUBLIC_SAMPLE_LANGUAGES)
            if unknown_languages:
                raise ValueError(f"unsupported sample language: {sorted(unknown_languages)[0]}")
            features[feature] = {
                "samples": {
                    language: _normalize_sample(raw_samples.get(language))
                    for language in PUBLIC_SAMPLE_LANGUAGES
                }
            }
        else:
            features[feature] = _normalize_sample(raw)
    return normalized


def _normalize_sample(raw: Any) -> dict[str, object] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("sample audio must be an object")
    audio_base64 = "".join(str(raw.get("audio_base64") or "").split())
    if not audio_base64:
        return None
    try:
        audio_bytes = base64.b64decode(audio_base64, validate=True)
    except ValueError as exc:
        raise ValueError("sample audio base64 is invalid") from exc
    if len(audio_bytes) > PUBLIC_SAMPLE_AUDIO_MAX_BYTES:
        raise ValueError("sample audio is too large: max 1800000 bytes")
    audio_mime_type = str(raw.get("audio_mime_type") or "audio/wav").strip()
    if not audio_mime_type.startswith("audio/"):
        raise ValueError("sample audio MIME type must start with audio/")
    return {
        "title": str(raw.get("title") or "")[:80],
        "description": str(raw.get("description") or "")[:300],
        "filename": Path(str(raw.get("filename") or "sample.wav")).name,
        "audio_mime_type": audio_mime_type,
        "audio_base64": audio_base64,
        "size_bytes": len(audio_bytes),
    }
