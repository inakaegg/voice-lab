from __future__ import annotations

import os
import shlex
from collections.abc import Sequence
from pathlib import Path


EnvFile = str | Path

RUNPOD_GATEWAY_ENV_KEYS = frozenset(
    {
        "RUNPOD_ENDPOINT_ID",
        "RUNPOD_API_KEY",
        "RUNPOD_API_BASE_URL",
        "RUNPOD_SERVERLESS_REQUEST_MODE",
        "RUNPOD_SERVERLESS_TIMEOUT_SECONDS",
        "RUNPOD_SERVERLESS_POLL_INTERVAL_SECONDS",
        "RUNPOD_SERVERLESS_HEALTH_TIMEOUT_SECONDS",
        "RUNPOD_SERVERLESS_HEALTH_CHECK",
        "RUNPOD_SERVERLESS_TRANSLATION_BACKEND",
    }
)


def load_project_env(*, env_file: EnvFile | Sequence[EnvFile] | None = None) -> None:
    """Load git-ignored local env files without overriding existing env vars."""

    for path in _candidate_env_files(env_file):
        if path.is_file():
            _load_env_file(path)


def load_runpod_gateway_env(*, env_file: EnvFile | None = None) -> None:
    """Load RunPod gateway connection keys from .runpod.env without app-mode side effects."""

    path = Path(env_file) if env_file is not None else _default_runpod_env_file()
    if path.is_file():
        _load_env_file(path, allowed_keys=RUNPOD_GATEWAY_ENV_KEYS)


def _candidate_env_files(env_file: EnvFile | Sequence[EnvFile] | None) -> list[Path]:
    if env_file is not None:
        return _coerce_env_files(env_file)
    if configured := os.getenv("MO_ENV_FILE"):
        return [Path(item) for item in configured.split(os.pathsep) if item]
    repo_root = Path(__file__).resolve().parents[2]
    return [repo_root / ".env"]


def _default_runpod_env_file() -> Path:
    if configured := os.getenv("RUNPOD_ENV_FILE"):
        return Path(configured)
    repo_root = Path(__file__).resolve().parents[2]
    return repo_root / ".runpod.env"


def _coerce_env_files(env_file: EnvFile | Sequence[EnvFile]) -> list[Path]:
    if isinstance(env_file, str | Path):
        return [Path(env_file)]
    return [Path(item) for item in env_file]


def _load_env_file(path: Path, *, allowed_keys: frozenset[str] | None = None) -> None:
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        parsed = _parse_env_line(raw_line)
        if parsed is None:
            continue
        key, value = parsed
        if allowed_keys is not None and key not in allowed_keys:
            continue
        os.environ.setdefault(key, value)


def _parse_env_line(raw_line: str) -> tuple[str, str] | None:
    line = raw_line.strip()
    if not line or line.startswith("#"):
        return None
    if line.startswith("export "):
        line = line.removeprefix("export ").strip()
    if "=" not in line:
        return None

    key, value = line.split("=", 1)
    key = key.strip()
    if not key or not key.replace("_", "").isalnum() or key[0].isdigit():
        return None
    return key, _parse_env_value(value)


def _parse_env_value(raw_value: str) -> str:
    value = raw_value.strip()
    if not value:
        return ""
    try:
        parts = shlex.split(value, comments=True, posix=True)
    except ValueError:
        return value.strip("\"'")
    if not parts:
        return ""
    return parts[0]
