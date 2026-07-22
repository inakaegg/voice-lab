from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Callable

from ..practice_forced_alignment import (
    detect_speech_islands,
    replace_word_timestamps,
    snap_word_timestamps_to_speech_islands,
)
from .openai_api import AsrTranscription


DEFAULT_FUNASR_MODEL = "funasr/paraformer-zh"
DEFAULT_FUNASR_VAD_MODEL = "funasr/fsmn-vad"
DEFAULT_FUNASR_PUNC_MODEL = "funasr/ct-punc"
DEFAULT_FUNASR_ALIGNMENT_MODEL = "funasr/fa-zh"


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
    alignment_model: str = field(
        default_factory=lambda: os.getenv("FUNASR_FA_MODEL", DEFAULT_FUNASR_ALIGNMENT_MODEL)
    )
    hub: str = field(default_factory=lambda: os.getenv("FUNASR_HUB", "hf"))
    device: str = field(default_factory=lambda: os.getenv("FUNASR_DEVICE", "cuda"))
    batch_size_s: int = field(default_factory=lambda: int(os.getenv("FUNASR_BATCH_SIZE_S", "60")))
    auto_model_factory: Callable[..., Any] | None = field(default=None, repr=False)
    alignment_model_factory: Callable[..., Any] | None = field(default=None, repr=False)
    _model_instance: Any | None = field(default=None, init=False, repr=False)
    _alignment_model_instance: Any | None = field(default=None, init=False, repr=False)
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False, repr=False)

    @property
    def name(self) -> str:
        return "funasr-paraformer-zh"

    @property
    def loaded(self) -> bool:
        return self._model_instance is not None

    def preload(self, *, include_alignment: bool = True) -> None:
        with self._lock:
            self._load_model()
            if include_alignment:
                self._load_alignment_model()

    def release(self) -> None:
        with self._lock:
            model = self._model_instance
            alignment_model = self._alignment_model_instance
            self._model_instance = None
            self._alignment_model_instance = None
            release = getattr(model, "release", None)
            if callable(release):
                release()
            alignment_release = getattr(alignment_model, "release", None)
            if callable(alignment_release):
                alignment_release()

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

    def force_align_detail(
        self,
        audio_path: Path,
        transcription: AsrTranscription,
        *,
        speech_islands: list[tuple[float, float]] | None = None,
    ) -> AsrTranscription:
        if not transcription.words:
            return transcription
        text = "".join(str(word.get("text") or "") for word in transcription.words)
        if not text:
            raise ValueError("ASR words are empty")
        with NamedTemporaryFile("w", suffix=".txt", encoding="utf-8") as text_file:
            text_file.write(text)
            text_file.flush()
            with self._lock:
                result = self._load_alignment_model().generate(
                    input=(str(audio_path), text_file.name),
                    data_type=("sound", "text"),
                )
        payload = result[0] if isinstance(result, list) and result else result
        value = payload if isinstance(payload, dict) else {}
        tokens = str(value.get("text") or "").split()
        timestamps = value.get("timestamp") if isinstance(value.get("timestamp"), list) else []
        aligned_words = []
        for token, timestamp in zip(tokens, timestamps):
            if not isinstance(timestamp, (list, tuple)) or len(timestamp) < 2:
                raise ValueError("forced alignment timestamp is invalid")
            aligned_words.append(
                {
                    "text": token,
                    "start": round(float(timestamp[0]) / 1000, 6),
                    "end": round(float(timestamp[1]) / 1000, 6),
                }
            )
        replaced = replace_word_timestamps(transcription.words, aligned_words)
        islands = detect_speech_islands(audio_path) if speech_islands is None else speech_islands
        if not islands:
            raise ValueError("VAD did not detect speech for forced alignment")
        words = snap_word_timestamps_to_speech_islands(replaced, islands)
        segments = [
            {
                "text": transcription.text,
                "start": words[0]["start"],
                "end": words[-1]["end"],
            }
        ]
        return AsrTranscription(
            text=transcription.text,
            model=transcription.model,
            words=words,
            segments=segments,
            timestamp_granularities=["word"],
        )

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

    def _load_alignment_model(self):
        if self._alignment_model_instance is not None:
            return self._alignment_model_instance
        factory = self.alignment_model_factory or self.auto_model_factory
        if factory is None:
            try:
                from funasr import AutoModel
            except ImportError as exc:
                raise RuntimeError(
                    "FunASR is not installed. Install the funasr optional dependency in the RunPod image."
                ) from exc
            factory = AutoModel
        self._alignment_model_instance = factory(
            model=self.alignment_model,
            hub=self.hub,
            device=self.device,
            disable_update=True,
            disable_pbar=True,
        )
        return self._alignment_model_instance
