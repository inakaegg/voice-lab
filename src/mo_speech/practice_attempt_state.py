from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import RLock


DEFAULT_PRACTICE_ATTEMPT_STATE_DIR = "tmp/practice-attempt-state"
DEFAULT_PRACTICE_ATTEMPT_STATE_TTL_SECONDS = 60 * 60


@dataclass
class PracticeAttemptStateStore:
    root: Path
    ttl_seconds: int = DEFAULT_PRACTICE_ATTEMPT_STATE_TTL_SECONDS
    _lock: RLock = field(default_factory=RLock, init=False, repr=False)

    @classmethod
    def from_env(cls) -> "PracticeAttemptStateStore":
        return cls(
            root=Path(
                os.getenv(
                    "MO_PRACTICE_ATTEMPT_STATE_DIR",
                    DEFAULT_PRACTICE_ATTEMPT_STATE_DIR,
                )
            ).expanduser(),
            ttl_seconds=max(
                1,
                int(
                    os.getenv(
                        "MO_PRACTICE_ATTEMPT_STATE_TTL_SECONDS",
                        str(DEFAULT_PRACTICE_ATTEMPT_STATE_TTL_SECONDS),
                    )
                ),
            ),
        )

    def save_options(self, job_id: str, options: dict[str, object]) -> None:
        self._update(job_id, {"options": options})

    def load_options(self, job_id: str) -> dict[str, object] | None:
        state = self._read(job_id)
        options = state.get("options") if state is not None else None
        return dict(options) if isinstance(options, dict) else None

    def save_terminal_snapshot(
        self,
        job_id: str,
        snapshot: dict[str, object],
    ) -> None:
        if str(snapshot.get("status") or "") not in {"succeeded", "failed"}:
            return
        self._update(job_id, {"terminal_snapshot": snapshot})

    def load_terminal_snapshot(self, job_id: str) -> dict[str, object] | None:
        state = self._read(job_id)
        snapshot = state.get("terminal_snapshot") if state is not None else None
        if not isinstance(snapshot, dict):
            return None
        if str(snapshot.get("status") or "") not in {"succeeded", "failed"}:
            return None
        return dict(snapshot)

    def _update(self, job_id: str, values: dict[str, object]) -> None:
        normalized_job_id = str(job_id or "").strip()
        if not normalized_job_id:
            return
        with self._lock:
            current = self._read_unlocked(normalized_job_id) or {}
            payload = {
                **current,
                **values,
                "job_id": normalized_job_id,
                "updated_at_epoch": time.time(),
            }
            self.root.mkdir(parents=True, exist_ok=True)
            path = self._path(normalized_job_id)
            with NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=self.root,
                delete=False,
            ) as temporary:
                json.dump(payload, temporary, ensure_ascii=False, indent=2)
                temporary_path = Path(temporary.name)
            temporary_path.replace(path)
            self._delete_expired_unlocked()

    def _read(self, job_id: str) -> dict[str, object] | None:
        normalized_job_id = str(job_id or "").strip()
        if not normalized_job_id:
            return None
        with self._lock:
            return self._read_unlocked(normalized_job_id)

    def _read_unlocked(self, job_id: str) -> dict[str, object] | None:
        path = self._path(job_id)
        if not path.is_file():
            return None
        try:
            if time.time() - path.stat().st_mtime > self.ttl_seconds:
                path.unlink(missing_ok=True)
                return None
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        if not isinstance(payload, dict) or str(payload.get("job_id") or "") != job_id:
            return None
        return payload

    def _delete_expired_unlocked(self) -> None:
        cutoff = time.time() - self.ttl_seconds
        for path in self.root.glob("*.json"):
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink(missing_ok=True)
            except OSError:
                continue

    def _path(self, job_id: str) -> Path:
        digest = hashlib.sha256(job_id.encode("utf-8")).hexdigest()
        return self.root / f"{digest}.json"
