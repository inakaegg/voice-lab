from __future__ import annotations

import os
import re
import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Sequence

from .openai_api import AsrTranscription


DEFAULT_FUNASR_MODEL = "funasr/paraformer-zh"
DEFAULT_FUNASR_VAD_MODEL = "funasr/fsmn-vad"
DEFAULT_FUNASR_PUNC_MODEL = "funasr/ct-punc"
_SILENCE_START_PATTERN = re.compile(r"silence_start:\s*(-?\d+(?:\.\d+)?)")
_SILENCE_END_PATTERN = re.compile(r"silence_end:\s*(-?\d+(?:\.\d+)?)")
_BOUNDARY_PUNCTUATION = frozenset("，,、；;。！？!?：:")
_STRONG_BOUNDARY_PUNCTUATION = frozenset("；;。！？!?")
_MINIMUM_PHRASE_SILENCE_SECONDS = 0.12
_SILENCE_LENGTH_PREFERENCE_WEIGHT = 0.25
_MAXIMUM_SILENCE_LENGTH_PENALTY = 0.12
_MAXIMUM_RAW_SILENCE_LENGTH_PENALTY = 0.25
_RAW_BOUNDARY_EARLY_TOLERANCE_SECONDS = 0.65
_MAXIMUM_RAW_BOUNDARY_RELATIVE_ERROR = 0.12
_RAW_SPEECH_EDGE_SEARCH_SECONDS = 0.5
_RAW_DURATION_TOLERANCE_SECONDS = 0.25
_NEARBY_PUNCTUATION_BOUNDARY_TOKENS = 2


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
        if end_ms < 0 or end_ms < start_ms:
            continue
        start_ms = max(0.0, start_ms)
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


def detect_audio_silence_intervals(audio_path: Path) -> tuple[float, list[dict[str, float]]]:
    duration_completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(audio_path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if duration_completed.returncode != 0:
        raise RuntimeError(duration_completed.stderr.strip() or "ffprobe could not read audio")
    try:
        duration = float(duration_completed.stdout.strip())
    except ValueError as exc:
        raise RuntimeError("ffprobe returned an invalid audio duration") from exc
    if duration <= 0:
        raise RuntimeError("audio duration must be positive")

    silence_completed = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(audio_path),
            "-af",
            f"silencedetect=noise=-40dB:d={_MINIMUM_PHRASE_SILENCE_SECONDS}",
            "-f",
            "null",
            "-",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if silence_completed.returncode != 0:
        raise RuntimeError(silence_completed.stderr.strip() or "ffmpeg silence detection failed")

    intervals: list[dict[str, float]] = []
    pending_start: float | None = None
    for line in silence_completed.stderr.splitlines():
        start_match = _SILENCE_START_PATTERN.search(line)
        if start_match:
            pending_start = max(0.0, float(start_match.group(1)))
        end_match = _SILENCE_END_PATTERN.search(line)
        if not end_match or pending_start is None:
            continue
        end = min(duration, float(end_match.group(1)))
        if end > pending_start:
            intervals.append(
                {
                    "start": round(pending_start, 6),
                    "end": round(end, 6),
                }
            )
        pending_start = None
    return duration, intervals


def refine_funasr_word_timestamps(
    words: list[dict[str, object]],
    *,
    text: str,
    audio_duration_seconds: float,
    silence_intervals: list[dict[str, float]],
    boundary_indices: Sequence[int] | None = None,
    prefer_raw_timing: bool = False,
) -> list[dict[str, object]]:
    """Clamp coarse FunASR token times to independently observed silence boundaries.

    The lexical token order and text are never changed. A silence is accepted only
    when it maps monotonically to a plausible token boundary. The original values
    remain available as ``raw_start`` and ``raw_end`` for diagnostics.
    """

    duration = float(audio_duration_seconds)
    refined = [
        {
            **word,
            "raw_start": float(word["start"]),
            "raw_end": float(word["end"]),
        }
        for word in words
        if _valid_word_timestamp(word)
    ]
    if duration <= 0 or len(refined) < 2:
        return refined

    detected_silences = sorted(
        [
            {
                "start": max(0.0, float(interval["start"])),
                "end": min(duration, float(interval["end"])),
            }
            for interval in silence_intervals
            if float(interval.get("end", 0.0)) > float(interval.get("start", 0.0))
            and float(interval.get("end", 0.0)) - float(interval.get("start", 0.0))
            >= _MINIMUM_PHRASE_SILENCE_SECONDS
        ],
        key=lambda value: value["start"],
    )
    raw_timing_matches_audio = (
        float(refined[-1]["raw_end"]) <= duration + _RAW_DURATION_TOLERANCE_SECONDS
    )
    speech_start = (
        detected_silences[0]["end"]
        if detected_silences and detected_silences[0]["start"] <= 0.05
        else 0.0
    )
    if raw_timing_matches_audio:
        raw_speech_start = float(refined[0]["raw_start"])
        leading_candidates = [
            interval["end"]
            for interval in detected_silences
            if interval["start"] <= raw_speech_start
            and interval["end"] <= raw_speech_start
            and raw_speech_start - interval["end"]
            <= _RAW_SPEECH_EDGE_SEARCH_SECONDS
        ]
        if leading_candidates:
            speech_start = max(leading_candidates)
    speech_end = (
        detected_silences[-1]["start"]
        if detected_silences and detected_silences[-1]["end"] >= duration - 0.05
        else duration
    )
    if speech_end <= speech_start:
        return refined
    internal_silences = [
        {
            "start": interval["start"],
            "end": interval["end"],
        }
        for interval in detected_silences
        if interval["end"] > speech_start
        and interval["end"] < duration - 0.05
    ]
    if not internal_silences:
        if boundary_indices is not None and (
            speech_start > 0.0 or speech_end < duration
        ):
            _clamp_timestamp_group(
                refined,
                0,
                len(refined),
                lower=speech_start,
                upper=speech_end,
            )
        return refined

    preferred_boundaries = (
        set(boundary_indices)
        if boundary_indices is not None
        else _punctuation_token_boundaries(text, refined)
    )
    token_count = len(refined)
    ordered_silences = sorted(internal_silences, key=lambda value: value["start"])
    assignments = _punctuation_backed_assignments(
        preferred_boundaries,
        ordered_silences,
        words=refined,
        token_count=token_count,
        duration=duration,
        trust_raw_timing=prefer_raw_timing and raw_timing_matches_audio,
    )
    if not assignments and not preferred_boundaries and boundary_indices is None:
        assignments = _relative_silence_assignments(
            refined,
            ordered_silences,
            token_count=token_count,
            duration=duration,
        )

    if not assignments:
        if boundary_indices is not None and not preferred_boundaries and (
            speech_start > 0.0 or speech_end < duration
        ):
            _clamp_timestamp_group(
                refined,
                0,
                len(refined),
                lower=speech_start,
                upper=speech_end,
            )
        return refined

    group_start = speech_start
    token_start = 0
    for token_end, silence_start, silence_end in [
        *assignments,
        (token_count, speech_end, speech_end),
    ]:
        _clamp_timestamp_group(
            refined,
            token_start,
            token_end,
            lower=group_start,
            upper=silence_start,
        )
        token_start = token_end
        group_start = silence_end
    return refined


def _punctuation_backed_assignments(
    boundaries: set[int],
    silences: list[dict[str, float]],
    *,
    words: list[dict[str, object]],
    token_count: int,
    duration: float,
    trust_raw_timing: bool,
) -> list[tuple[int, float, float]]:
    legacy_assignments = _candidate_punctuation_backed_assignments(
        boundaries,
        silences,
        words=words,
        token_count=token_count,
        duration=duration,
        trust_raw_timing=False,
    )
    if not trust_raw_timing:
        return legacy_assignments

    raw_assignments = _candidate_punctuation_backed_assignments(
        boundaries,
        silences,
        words=words,
        token_count=token_count,
        duration=duration,
        trust_raw_timing=True,
    )
    if _assignments_have_consistent_raw_support(
        raw_assignments,
        words,
        duration=duration,
    ):
        return raw_assignments
    return legacy_assignments


def _candidate_punctuation_backed_assignments(
    boundaries: set[int],
    silences: list[dict[str, float]],
    *,
    words: list[dict[str, object]],
    token_count: int,
    duration: float,
    trust_raw_timing: bool,
) -> list[tuple[int, float, float]]:
    ordered_boundaries = sorted(boundary for boundary in boundaries if 0 < boundary < token_count)
    if not ordered_boundaries or not silences:
        return []
    if len(silences) < len(ordered_boundaries):
        assignments: list[tuple[int, float, float]] = []
        previous_boundary_index = -1
        for silence_index, silence in enumerate(silences):
            remaining = len(silences) - silence_index - 1
            candidates = range(
                previous_boundary_index + 1,
                len(ordered_boundaries) - remaining,
            )
            midpoint = (silence["start"] + silence["end"]) / 2
            scored: list[tuple[float, float, float | None, int]] = []
            for index in candidates:
                boundary = ordered_boundaries[index]
                if not _silence_not_before_raw_boundary(
                    words,
                    boundary,
                    silence,
                    trust_raw_timing=trust_raw_timing,
                ):
                    continue
                relative_error = abs(
                    (boundary / token_count)
                    - (midpoint / duration)
                )
                raw_error = _raw_boundary_relative_error(
                    words,
                    boundary,
                    midpoint,
                    duration=duration,
                    trust_raw_timing=trust_raw_timing,
                )
                scored.append(
                    (
                        relative_error + ((raw_error or 0.0) * 0.2),
                        relative_error,
                        raw_error,
                        index,
                    )
                )
            if not scored:
                return []
            _, relative_error, raw_error, boundary_index = min(scored)
            if (
                relative_error > max(0.2, 1.5 / token_count)
                and (
                    raw_error is None
                    or raw_error > _MAXIMUM_RAW_BOUNDARY_RELATIVE_ERROR
                )
            ):
                return []
            boundary = ordered_boundaries[boundary_index]
            assignments.append((boundary, silence["start"], silence["end"]))
            previous_boundary_index = boundary_index
        return assignments

    assignments: list[tuple[int, float, float]] = []
    previous_silence_index = -1
    longest_silence = max(
        silence["end"] - silence["start"]
        for silence in silences
    )
    for boundary_index, boundary in enumerate(ordered_boundaries):
        remaining = len(ordered_boundaries) - boundary_index - 1
        candidates = range(
            previous_silence_index + 1,
            len(silences) - remaining,
        )
        scored: list[tuple[float, float, float | None, int]] = []
        for index in candidates:
            silence = silences[index]
            if not _silence_not_before_raw_boundary(
                words,
                boundary,
                silence,
                trust_raw_timing=trust_raw_timing,
            ):
                continue
            midpoint = (silence["start"] + silence["end"]) / 2
            relative_error = abs(
                (boundary / token_count)
                - (midpoint / duration)
            )
            raw_error = _raw_boundary_relative_error(
                words,
                boundary,
                midpoint,
                duration=duration,
                trust_raw_timing=trust_raw_timing,
            )
            length_penalty = min(
                (
                    _MAXIMUM_RAW_SILENCE_LENGTH_PENALTY
                    if trust_raw_timing
                    else _MAXIMUM_SILENCE_LENGTH_PENALTY
                ),
                _SILENCE_LENGTH_PREFERENCE_WEIGHT
                * (
                    1.0
                    - (
                        (silence["end"] - silence["start"])
                        / longest_silence
                    )
                ),
            )
            scored.append(
                (
                    relative_error
                    + length_penalty
                    + ((raw_error or 0.0) * 0.2),
                    relative_error,
                    raw_error,
                    index,
                )
            )
        if not scored:
            return []
        _, relative_error, raw_error, silence_index = min(scored)
        if (
            relative_error > max(0.2, 1.5 / token_count)
            and (
                raw_error is None
                or raw_error > _MAXIMUM_RAW_BOUNDARY_RELATIVE_ERROR
            )
        ):
            return []
        silence = silences[silence_index]
        assignments.append((boundary, silence["start"], silence["end"]))
        previous_silence_index = silence_index
    return assignments


def _assignments_have_consistent_raw_support(
    assignments: list[tuple[int, float, float]],
    words: list[dict[str, object]],
    *,
    duration: float,
) -> bool:
    if not assignments:
        return False
    for boundary, silence_start, silence_end in assignments:
        raw_error = _raw_boundary_relative_error(
            words,
            boundary,
            (silence_start + silence_end) / 2,
            duration=duration,
            trust_raw_timing=True,
        )
        if (
            raw_error is None
            or raw_error > _MAXIMUM_RAW_BOUNDARY_RELATIVE_ERROR
        ):
            return False
    return True


def _silence_not_before_raw_boundary(
    words: list[dict[str, object]],
    boundary: int,
    silence: dict[str, float],
    *,
    trust_raw_timing: bool,
) -> bool:
    if not trust_raw_timing:
        return True
    raw_boundary = (
        float(words[boundary - 1]["raw_end"])
        + float(words[boundary]["raw_start"])
    ) / 2
    return silence["end"] >= raw_boundary - _RAW_BOUNDARY_EARLY_TOLERANCE_SECONDS


def _raw_boundary_relative_error(
    words: list[dict[str, object]],
    boundary: int,
    midpoint: float,
    *,
    duration: float,
    trust_raw_timing: bool,
) -> float | None:
    if not trust_raw_timing or duration <= 0:
        return None
    raw_boundary = (
        float(words[boundary - 1]["raw_end"])
        + float(words[boundary]["raw_start"])
    ) / 2
    return abs(raw_boundary - midpoint) / duration


def _relative_silence_assignments(
    words: list[dict[str, object]],
    silences: list[dict[str, float]],
    *,
    token_count: int,
    duration: float,
) -> list[tuple[int, float, float]]:
    assignments: list[tuple[int, float, float]] = []
    previous_boundary = 0
    for interval in silences:
        midpoint = (interval["start"] + interval["end"]) / 2
        scored: list[tuple[float, float, int]] = []
        for boundary in range(previous_boundary + 1, token_count):
            relative_error = abs((boundary / token_count) - (midpoint / duration))
            raw_boundary = (
                float(words[boundary - 1]["raw_end"])
                + float(words[boundary]["raw_start"])
            ) / 2
            raw_error = abs(raw_boundary - midpoint) / duration
            scored.append((relative_error + (raw_error * 0.2), relative_error, boundary))
        if not scored:
            continue
        _, relative_error, boundary = min(scored)
        if relative_error > max(0.12, 1.5 / token_count):
            continue
        assignments.append((boundary, interval["start"], interval["end"]))
        previous_boundary = boundary
    return assignments


def _valid_word_timestamp(word: dict[str, object]) -> bool:
    try:
        start = float(word["start"])
        end = float(word["end"])
    except (KeyError, TypeError, ValueError):
        return False
    return start >= 0 and end >= start


def _punctuation_token_boundaries(
    text: str,
    words: list[dict[str, object]],
) -> set[int]:
    return _token_boundaries_for_punctuation(
        text,
        words,
        punctuation=_BOUNDARY_PUNCTUATION,
    )


def _strong_punctuation_token_boundaries(
    text: str,
    words: list[dict[str, object]],
) -> set[int]:
    return _token_boundaries_for_punctuation(
        text,
        words,
        punctuation=_STRONG_BOUNDARY_PUNCTUATION,
    )


def _token_boundaries_for_punctuation(
    text: str,
    words: list[dict[str, object]],
    *,
    punctuation: frozenset[str],
) -> set[int]:
    boundaries: set[int] = set()
    cursor = 0
    for index, word in enumerate(words):
        token = str(word.get("text") or "")
        if not token:
            continue
        position = text.find(token, cursor)
        if position < 0:
            continue
        if index and any(character in punctuation for character in text[cursor:position]):
            boundaries.add(index)
        cursor = position + len(token)
    return boundaries


def _clamp_timestamp_group(
    words: list[dict[str, object]],
    start_index: int,
    end_index: int,
    *,
    lower: float,
    upper: float,
) -> None:
    group = words[start_index:end_index]
    if not group or upper <= lower:
        return
    raw_durations = [
        max(0.0, float(word["raw_end"]) - float(word["raw_start"]))
        for word in group
    ]
    positive_durations = [duration for duration in raw_durations if duration > 0]
    minimum_weight = (
        (sum(positive_durations) / len(positive_durations)) * 0.05
        if positive_durations
        else 1.0
    )
    weights = [max(duration, minimum_weight) for duration in raw_durations]
    weight_total = sum(weights)
    span = upper - lower
    cursor = lower
    for index, (word, weight) in enumerate(zip(group, weights)):
        end = (
            upper
            if index == len(group) - 1
            else cursor + (span * weight / weight_total)
        )
        word["start"] = round(cursor, 6)
        word["end"] = round(end, 6)
        cursor = end


@dataclass
class FunAsrPracticeProvider:
    model: str = field(default_factory=lambda: os.getenv("FUNASR_MODEL", DEFAULT_FUNASR_MODEL))
    vad_model: str = field(default_factory=lambda: os.getenv("FUNASR_VAD_MODEL", DEFAULT_FUNASR_VAD_MODEL))
    punc_model: str = field(default_factory=lambda: os.getenv("FUNASR_PUNC_MODEL", DEFAULT_FUNASR_PUNC_MODEL))
    hub: str = field(default_factory=lambda: os.getenv("FUNASR_HUB", "hf"))
    device: str = field(default_factory=lambda: os.getenv("FUNASR_DEVICE", "cuda"))
    batch_size_s: int = field(default_factory=lambda: int(os.getenv("FUNASR_BATCH_SIZE_S", "60")))
    auto_model_factory: Callable[..., Any] | None = field(default=None, repr=False)
    audio_boundary_detector: Callable[
        [Path],
        tuple[float, list[dict[str, float]]],
    ] = field(default=detect_audio_silence_intervals, repr=False)
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

    def refine_timestamps_for_target(
        self,
        transcription: AsrTranscription,
        audio_path: Path,
        *,
        target_text: str,
        target_language: str,
    ) -> AsrTranscription:
        """Refine token times only at boundaries supported by the target alignment.

        FunASR punctuation is generated text and is not reliable acoustic evidence.
        The target/recognized-text alignment supplies candidate token boundaries;
        independently detected pauses supply the timestamps. If either signal is
        unavailable or inconsistent, the raw FunASR transcription is preserved.
        """

        if target_language != "zh-CN" or not target_text.strip() or len(transcription.words) < 2:
            return transcription
        from ..practice import practice_comparison_alignment_canonical

        try:
            def align(words: list[dict[str, object]]) -> dict[str, object]:
                segments = (
                    [
                        {
                            "text": transcription.text,
                            "start": words[0]["start"],
                            "end": words[-1]["end"],
                        }
                    ]
                    if words
                    else []
                )
                return practice_comparison_alignment_canonical(
                    target_text=target_text,
                    recognized_text=transcription.text,
                    target_language=target_language,
                    asr_timestamps={
                        "available": bool(words or segments),
                        "words": words,
                        "segments": segments,
                        "raw_timestamp_word_count": len(words),
                        "raw_timestamp_segment_count": len(segments),
                    },
                )

            duration, silence_intervals = self.audio_boundary_detector(audio_path)
            alignment = align(transcription.words)
            lexical_alignment = align(
                [
                    {
                        **word,
                        "start": float(index),
                        "end": float(index + 1),
                    }
                    for index, word in enumerate(transcription.words)
                ]
            )
            raw_playable_count = int(alignment.get("playable_phrase_count") or 0)
            prefer_raw_timing = (
                raw_playable_count
                < int(alignment.get("target_phrase_count") or 0)
                and int(alignment.get("unassigned_non_filler_count") or 0) > 0
            )
            internal_silences = [
                interval
                for interval in silence_intervals
                if float(interval.get("end", 0.0))
                - float(interval.get("start", 0.0))
                >= _MINIMUM_PHRASE_SILENCE_SECONDS
                and float(interval.get("start", 0.0)) > 0.05
                and float(interval.get("end", 0.0)) < duration - 0.05
            ]
            if raw_playable_count < 2 and len(internal_silences) == 1:
                token_count = len(transcription.words)
                silence_midpoint = (
                    float(internal_silences[0]["start"])
                    + float(internal_silences[0]["end"])
                ) / 2
                maximum_relative_error = max(0.2, 1.5 / token_count)
                best_alignment = alignment
                best_rank = (
                    raw_playable_count,
                    -int(alignment.get("unassigned_non_filler_count") or 0),
                )
                for candidate_boundary in range(1, token_count):
                    if abs(
                        (candidate_boundary / token_count)
                        - (silence_midpoint / duration)
                    ) > maximum_relative_error:
                        continue
                    candidate_words = refine_funasr_word_timestamps(
                        transcription.words,
                        text=transcription.text,
                        audio_duration_seconds=duration,
                        silence_intervals=silence_intervals,
                        boundary_indices=[candidate_boundary],
                    )
                    candidate_alignment = align(candidate_words)
                    rank = (
                        int(candidate_alignment.get("playable_phrase_count") or 0),
                        -int(
                            candidate_alignment.get("unassigned_non_filler_count")
                            or 0
                        ),
                    )
                    if rank > best_rank:
                        best_alignment = candidate_alignment
                        best_rank = rank
                alignment = best_alignment
            phrases = alignment.get("phrases")
            if not isinstance(phrases, list):
                return transcription
            boundary_indices: set[int] = set()
            protected_lexical_boundaries: set[int] = set()
            target_phrase_count = int(alignment.get("target_phrase_count") or 0)
            found_aligned_phrase = False
            for candidate_alignment in (alignment, lexical_alignment):
                candidate_phrases = candidate_alignment.get("phrases")
                if not isinstance(candidate_phrases, list):
                    continue
                aligned_phrases = sorted(
                    (
                        phrase
                        for phrase in candidate_phrases
                        if isinstance(phrase, dict)
                        and phrase.get("available") is True
                        and isinstance(phrase.get("word_start_index"), int)
                        and isinstance(phrase.get("word_end_index"), int)
                    ),
                    key=lambda phrase: int(phrase["word_start_index"]),
                )
                if not aligned_phrases:
                    continue
                found_aligned_phrase = True
                first = aligned_phrases[0]
                first_start = int(first["word_start_index"])
                if int(first["index"]) > 0 and 0 < first_start < len(transcription.words):
                    boundary_indices.add(first_start)
                last = aligned_phrases[-1]
                last_end = int(last["word_end_index"])
                if (
                    int(last["index"]) < target_phrase_count - 1
                    and 0 < last_end < len(transcription.words)
                ):
                    boundary_indices.add(last_end)
                for left, right in zip(
                    aligned_phrases,
                    aligned_phrases[1:],
                ):
                    left_end = int(left["word_end_index"])
                    right_start = int(right["word_start_index"])
                    if 0 < left_end < len(transcription.words):
                        boundary_indices.add(left_end)
                    if left_end < right_start < len(transcription.words):
                        boundary_indices.add(right_start)
                    if (
                        candidate_alignment is lexical_alignment
                        and left_end == right_start
                        and right.get("content_matched") is True
                    ):
                        protected_lexical_boundaries.add(right_start)
            if not found_aligned_phrase:
                return transcription
            for punctuation_boundary in _strong_punctuation_token_boundaries(
                transcription.text,
                transcription.words,
            ):
                nearby_boundaries = {
                    boundary
                    for boundary in boundary_indices
                    if abs(boundary - punctuation_boundary)
                    <= _NEARBY_PUNCTUATION_BOUNDARY_TOKENS
                    and boundary not in protected_lexical_boundaries
                }
                if not nearby_boundaries:
                    continue
                if punctuation_boundary not in nearby_boundaries:
                    prefer_raw_timing = True
                boundary_indices.difference_update(nearby_boundaries)
                boundary_indices.add(punctuation_boundary)
            words = refine_funasr_word_timestamps(
                transcription.words,
                text=transcription.text,
                audio_duration_seconds=duration,
                silence_intervals=silence_intervals,
                boundary_indices=sorted(boundary_indices),
                prefer_raw_timing=prefer_raw_timing,
            )
        except (OSError, RuntimeError, subprocess.SubprocessError, ValueError):
            return transcription
        if not words:
            return transcription
        return AsrTranscription(
            text=transcription.text,
            model=transcription.model,
            words=words,
            segments=[
                {
                    "text": transcription.text,
                    "start": words[0]["start"],
                    "end": words[-1]["end"],
                }
            ],
            timestamp_granularities=transcription.timestamp_granularities,
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
