from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


DEFAULT_AUDIO_HISTORY_DIR = "tmp/audio-history"
DEFAULT_AUDIO_HISTORY_LIMIT = 10


@dataclass(frozen=True)
class AudioHistoryEntry:
    audio_path: Path
    metadata_path: Path
    metadata: dict[str, object] | None = None


@dataclass
class AudioHistoryStore:
    root: Path
    limit: int = DEFAULT_AUDIO_HISTORY_LIMIT
    enabled: bool = True

    @classmethod
    def from_env(cls) -> "AudioHistoryStore":
        enabled = _str_to_bool(os.getenv("MO_AUDIO_HISTORY_ENABLED", "1"))
        root = Path(os.getenv("MO_AUDIO_HISTORY_DIR", DEFAULT_AUDIO_HISTORY_DIR)).expanduser()
        limit = int(os.getenv("MO_AUDIO_HISTORY_LIMIT", str(DEFAULT_AUDIO_HISTORY_LIMIT)))
        return cls(root=root, limit=limit, enabled=enabled)

    def save_recording(
        self,
        audio_bytes: bytes,
        *,
        suffix: str,
        metadata: dict[str, object],
    ) -> AudioHistoryEntry | None:
        return self._save("recordings", audio_bytes, suffix=suffix, metadata=metadata)

    def save_output(
        self,
        audio_bytes: bytes,
        *,
        suffix: str,
        metadata: dict[str, object],
    ) -> AudioHistoryEntry | None:
        return self._save("outputs", audio_bytes, suffix=suffix, metadata=metadata)

    def list_entries(self, kind: str) -> list[AudioHistoryEntry]:
        if kind not in {"recordings", "outputs"}:
            raise ValueError(f"unsupported audio history kind: {kind}")
        target_dir = self.root / kind
        if not self.enabled or not target_dir.exists():
            return []
        audio_paths = sorted(
            [path for path in target_dir.iterdir() if path.is_file() and not path.name.endswith(".json")],
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )[: self.limit]
        return [
            AudioHistoryEntry(
                audio_path=audio_path,
                metadata_path=audio_path.with_suffix(audio_path.suffix + ".json"),
                metadata=_read_metadata(audio_path.with_suffix(audio_path.suffix + ".json")),
            )
            for audio_path in audio_paths
        ]

    def resolve_audio_path(self, kind: str, filename: str) -> Path:
        if kind not in {"recordings", "outputs"}:
            raise ValueError(f"unsupported audio history kind: {kind}")
        if Path(filename).name != filename:
            raise ValueError("invalid audio history filename")
        audio_path = self.root / kind / filename
        if not audio_path.is_file() or audio_path.name.endswith(".json"):
            raise FileNotFoundError(filename)
        return audio_path

    def _save(
        self,
        kind: str,
        audio_bytes: bytes,
        *,
        suffix: str,
        metadata: dict[str, object],
    ) -> AudioHistoryEntry | None:
        if not self.enabled or self.limit <= 0 or len(audio_bytes) == 0:
            return None

        target_dir = self.root / kind
        target_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        filename = f"{timestamp}-{uuid4().hex[:8]}{_safe_suffix(suffix)}"
        audio_path = target_dir / filename
        metadata_path = audio_path.with_suffix(audio_path.suffix + ".json")

        audio_path.write_bytes(audio_bytes)
        metadata_payload = {
            **metadata,
            "kind": kind,
            "audio_file": audio_path.name,
            "size_bytes": len(audio_bytes),
            "created_at": timestamp,
        }
        metadata_path.write_text(json.dumps(metadata_payload, ensure_ascii=False, indent=2), encoding="utf-8")
        self._prune(target_dir)
        return AudioHistoryEntry(audio_path=audio_path, metadata_path=metadata_path, metadata=metadata_payload)

    def _prune(self, target_dir: Path) -> None:
        audio_paths = sorted(
            [path for path in target_dir.iterdir() if path.is_file() and not path.name.endswith(".json")],
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        for audio_path in audio_paths[self.limit :]:
            audio_path.unlink(missing_ok=True)
            audio_path.with_suffix(audio_path.suffix + ".json").unlink(missing_ok=True)


def _safe_suffix(suffix: str) -> str:
    candidate = suffix if suffix.startswith(".") else f".{suffix}"
    candidate = candidate.lower()
    if not re.fullmatch(r"\.[a-z0-9][a-z0-9._-]{0,15}", candidate):
        return ".audio"
    return candidate


def _str_to_bool(value: str) -> bool:
    return value.lower() in {"1", "true", "yes", "on"}


def _read_metadata(metadata_path: Path) -> dict[str, object]:
    if not metadata_path.is_file():
        return {}
    try:
        return json.loads(metadata_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
