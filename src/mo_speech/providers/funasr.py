from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .openai_api import AsrTranscription


DEFAULT_FUNASR_MODEL = "funasr/paraformer-zh"
DEFAULT_FUNASR_VAD_MODEL = "funasr/fsmn-vad"
DEFAULT_FUNASR_PUNC_MODEL = "funasr/ct-punc"


def transcription_from_funasr_result(result: object, *, model: str) -> AsrTranscription:
    payload = result if isinstance(result, dict) else {}
    text = str(payload.get("text") or "").strip()
    raw_text = str(payload.get("raw_text") or "").strip()
    tokens = raw_text.split() if raw_text else [character for character in text if not character.isspace()]
    if not text and tokens:
        text = "".join(tokens)
    timestamps = payload.get("timestamp")
    timestamp_rows = timestamps if isinstance(timestamps, list) else []

    words: list[dict[str, object]] = []
    for token, timestamp in zip(tokens, timestamp_rows):
        if not isinstance(timestamp, (list, tuple)) or len(timestamp) < 2:
            continue
        try:
            start_ms = float(timestamp[0])
            end_ms = float(timestamp[1])
        except (TypeError, ValueError):
            continue
        if start_ms < 0 or end_ms < start_ms:
            continue
        words.append(
            {
                "text": token,
                "start": round(start_ms / 1000, 6),
                "end": round(end_ms / 1000, 6),
            }
        )

    segments = []
    if words:
        segments.append(
            {
                "text": text,
                "start": words[0]["start"],
                "end": words[-1]["end"],
            }
        )
    return AsrTranscription(
        text=text,
        model=model,
        words=words,
        segments=segments,
        timestamp_granularities=["word"] if words else [],
    )


@dataclass
class FunAsrPracticeProvider:
    model: str = field(default_factory=lambda: os.getenv("FUNASR_MODEL", DEFAULT_FUNASR_MODEL))
    vad_model: str = field(default_factory=lambda: os.getenv("FUNASR_VAD_MODEL", DEFAULT_FUNASR_VAD_MODEL))
    punc_model: str = field(default_factory=lambda: os.getenv("FUNASR_PUNC_MODEL", DEFAULT_FUNASR_PUNC_MODEL))
    hub: str = field(default_factory=lambda: os.getenv("FUNASR_HUB", "hf"))
    device: str = field(default_factory=lambda: os.getenv("FUNASR_DEVICE", "cuda"))
    batch_size_s: int = field(default_factory=lambda: int(os.getenv("FUNASR_BATCH_SIZE_S", "60")))
    auto_model_factory: Callable[..., Any] | None = field(default=None, repr=False)
    _model_instance: Any | None = field(default=None, init=False, repr=False)
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False, repr=False)

    @property
    def name(self) -> str:
        return "funasr-paraformer-zh"

    @property
    def loaded(self) -> bool:
        return self._model_instance is not None

    def preload(self) -> None:
        with self._lock:
            self._load_model()

    def release(self) -> None:
        with self._lock:
            model = self._model_instance
            self._model_instance = None
            release = getattr(model, "release", None)
            if callable(release):
                release()

    def transcribe(self, audio_path: Path, source_language: str) -> str:
        return self.transcribe_detail(audio_path, source_language).text

    def transcribe_detail(
        self,
        audio_path: Path,
        source_language: str,
        *,
        include_timestamps: bool = False,
    ) -> AsrTranscription:
        if source_language != "zh-CN":
            raise ValueError("FunASR practice ASR only supports zh-CN")
        if not audio_path.is_file():
            raise FileNotFoundError(f"audio file does not exist: {audio_path}")
        with self._lock:
            result = self._load_model().generate(
                input=str(audio_path),
                batch_size_s=self.batch_size_s,
                pred_timestamp=True,
                return_raw_text=True,
            )
        payload = result[0] if isinstance(result, list) and result else result
        return transcription_from_funasr_result(payload, model=self.model)

    def _load_model(self):
        if self._model_instance is not None:
            return self._model_instance
        factory = self.auto_model_factory
        if factory is None:
            try:
                from funasr import AutoModel
            except ImportError as exc:
                raise RuntimeError(
                    "FunASR is not installed. Install the funasr optional dependency in the RunPod image."
                ) from exc
            factory = AutoModel
        self._model_instance = factory(
            model=self.model,
            vad_model=self.vad_model,
            punc_model=self.punc_model,
            hub=self.hub,
            device=self.device,
            disable_update=True,
            disable_pbar=True,
        )
        return self._model_instance
