from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path


DEFAULT_USER_SETTINGS_PATH = "tmp/user-settings.json"
SUPPORTED_USER_TARGET_LANGUAGES = {"id-ID", "ja-JP", "zh-CN", "en-US"}
SUPPORTED_JOKE_POSITIONS = {"before", "after"}


@dataclass(frozen=True)
class UserExperienceSettings:
    target_language: str = "ja-JP"
    joke_text: str = ""
    joke_position: str = "after"


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


def serialize_user_settings(settings: UserExperienceSettings) -> dict[str, str]:
    return asdict(settings)


def _coerce_settings(payload: dict[str, object]) -> UserExperienceSettings:
    target_language = str(payload.get("target_language", "ja-JP"))
    if target_language not in SUPPORTED_USER_TARGET_LANGUAGES:
        raise ValueError(f"unsupported target_language: {target_language}")

    joke_position = str(payload.get("joke_position", "after"))
    if joke_position not in SUPPORTED_JOKE_POSITIONS:
        raise ValueError(f"unsupported joke_position: {joke_position}")

    return UserExperienceSettings(
        target_language=target_language,
        joke_text=str(payload.get("joke_text", "")).strip(),
        joke_position=joke_position,
    )
