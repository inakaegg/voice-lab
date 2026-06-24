from __future__ import annotations

import os
import shlex
from pathlib import Path


def load_project_env(*, env_file: str | Path | None = None) -> None:
    """Load git-ignored local env files without overriding existing env vars."""

    for path in _candidate_env_files(env_file):
        if path.is_file():
            _load_env_file(path)


def _candidate_env_files(env_file: str | Path | None) -> list[Path]:
    if env_file is not None:
        return [Path(env_file)]
    if configured := os.getenv("MO_ENV_FILE"):
        return [Path(configured)]
    repo_root = Path(__file__).resolve().parents[2]
    return [repo_root / ".env"]


def _load_env_file(path: Path) -> None:
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        parsed = _parse_env_line(raw_line)
        if parsed is None:
            continue
        key, value = parsed
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
