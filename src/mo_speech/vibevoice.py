from __future__ import annotations

from array import array
import base64
from difflib import SequenceMatcher
from io import BytesIO
import logging
import math
import mimetypes
import os
from queue import Empty, Queue
import re
import subprocess
import sys
import wave
from dataclasses import dataclass, field, replace
from pathlib import Path
from threading import Event, Thread
from tempfile import TemporaryDirectory
from time import perf_counter, sleep
from typing import Callable, Protocol, Sequence


DEFAULT_VIBEVOICE_ROOT = Path.home() / ".cache" / "mo-speech" / "models" / "vibevoice"
DEFAULT_VIBEVOICE_HOME = DEFAULT_VIBEVOICE_ROOT / "huggingface" / "hub"
DEFAULT_VIBEVOICE_CLI = Path(__file__).with_name("vibevoice_cli.py")
DEFAULT_COMFYUI_VIBEVOICE_PATH = DEFAULT_VIBEVOICE_ROOT / "ComfyUI-VibeVoice"
DEFAULT_VIBEVOICE_TIMEOUT_SECONDS = 900.0
VIBEVOICE_SAMPLE_RATE = 24_000
DEFAULT_VIBEVOICE_MODEL_ID = "vibevoice-1.5b-pinned"
SHORT_SPEAKER_TAG_MIN = 1
SHORT_SPEAKER_TAG_MAX = 4
AUTO_LINE_BY_LINE_MIN_LINES = 4
AUTO_LINE_BY_LINE_MIN_CHARS = 180
DIRECTED_TAIL_GUARD_MAX_CHARS = 120
DIRECTED_TARGET_MIN_CHARS = 80
DIRECTED_TARGET_MAX_CHARS = 120
DIRECTED_LINE_MAX_CHARS = 180
DIRECTED_FULL_MAX_CHARS = 220
DIRECTED_OUTPUT_TARGET_RMS = 0.10
DIRECTED_OUTPUT_PEAK_LIMIT = 0.92
DIRECTED_OUTPUT_MAX_GAIN = 2.5
DIRECTED_OUTPUT_MIN_RMS = 0.0001
DIRECTED_RETRY_SCORE_THRESHOLD = 0.65
DIRECTED_RETRY_MAX_LINES = 6
DIRECTED_RETRY_MAX_MULTIPLIER = 1.0
DIRECTED_RETRY_CHUNK_INDEX_OFFSET = 10_000
_SHORT_SPEAKER_TAG_RE = re.compile(r"^([0-9]+|[A-Za-z]):? (.+)$")
_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_VIBEVOICE_TQDM_RE = re.compile(
    r"Generating(?:\s+\(active:\s*(?P<active>\d+/\d+)\))?:\s*"
    r"(?P<percent>\d+)%.*\|\s*(?P<current>\d+)/(?P<total>\d+)\s*"
    r"\[(?P<elapsed>[^<,\]]+)(?:<(?P<remaining>[^,\]]+))?"
)
_VIBEVOICE_TOKEN_LIMIT_RE = re.compile(r"VibeVoice生成token上限:\s*(?P<tokens>\d+)")
_VIBEVOICE_LINE_MODE_START_RE = re.compile(r"行単位モードで音声を生成します。対象行数:\s*(?P<total>\d+)")
_VIBEVOICE_LINE_START_RE = re.compile(r"行(?P<line>\d+):\s*(?P<action>新規に音声を生成します|キャッシュを使用します)")
_VIBEVOICE_LINE_COMPLETE_RE = re.compile(r"行単位モード:\s*(?P<total>\d+)件の音声を(?:結合|アーカイブ)")
LOGGER = logging.getLogger("mo_speech")


@dataclass
class _VibeVoiceCliProgressState:
    line_mode: bool = False
    line_total: int = 0
    current_line: int = 0


@dataclass(frozen=True)
class VibeVoiceModelPreset:
    model_id: str
    label: str
    model_repo: str
    model_revision: str | None
    tokenizer_repo: str
    tokenizer_revision: str | None
    torch_dtype: str | None = None
    generation_config_mode: str | None = None
    min_audio_tokens: int = 0
    auto_line_by_line: bool = True
    supported_backends: tuple[str, ...] = ("local", "runpod_serverless")
    notes: str = ""

    @property
    def model_cache_dir_name(self) -> str:
        return _repo_cache_dir_name(self.model_repo)

    @property
    def tokenizer_cache_dir_name(self) -> str:
        return _repo_cache_dir_name(self.tokenizer_repo)


VIBEVOICE_MODEL_PRESETS: dict[str, VibeVoiceModelPreset] = {
    "vibevoice-1.5b-pinned": VibeVoiceModelPreset(
        model_id="vibevoice-1.5b-pinned",
        label="VibeVoice 1.5B 固定版",
        model_repo="microsoft/VibeVoice-1.5B",
        model_revision="1904eae38036e9c780d28e27990c27748984eafe",
        tokenizer_repo="Qwen/Qwen2.5-1.5B",
        tokenizer_revision="8faed761d45a263340a0528343f099c05c9a4323",
        notes="ローカルで動作確認したrevisionを固定する再現性優先の既定値。",
    ),
    "vibevoice-1.5b-latest": VibeVoiceModelPreset(
        model_id="vibevoice-1.5b-latest",
        label="VibeVoice 1.5B 最新",
        model_repo="microsoft/VibeVoice-1.5B",
        model_revision=None,
        tokenizer_repo="Qwen/Qwen2.5-1.5B",
        tokenizer_revision=None,
        notes="Hugging Face mainを取得する比較用。将来の更新で挙動が変わる可能性がある。",
    ),
    "vibevoice-large-aoi-pinned": VibeVoiceModelPreset(
        model_id="vibevoice-large-aoi-pinned",
        label="VibeVoice Large (RunPod)",
        model_repo="aoi-ot/VibeVoice-Large",
        model_revision="1b81fecc784a076dcd935678db551871f4598ebf",
        tokenizer_repo="Qwen/Qwen2.5-7B",
        tokenizer_revision="d149729398750b98c0af14eb82c78cfe92750796",
        torch_dtype="bfloat16",
        generation_config_mode="explicit",
        min_audio_tokens=1,
        auto_line_by_line=False,
        supported_backends=("runpod_serverless",),
        notes="Large候補。ローカルmacOSでは扱わず、RunPod/CUDA上でのみ実験対象にする。",
    ),
}


@dataclass(frozen=True)
class VibeVoiceGenerationOptions:
    cfg_scale: float = 1.3
    inference_steps: int = 10
    seed: int = 42
    do_sample: bool = True
    temperature: float = 0.95
    top_p: float = 0.95
    top_k: int = 0
    max_voice_seconds: float = 5.0
    line_by_line: bool = False
    line_gap: float = 1.0
    directed_line_mode: bool = False
    directed_retry_low_score: bool = False
    directed_retry_score_threshold: float = DIRECTED_RETRY_SCORE_THRESHOLD
    directed_retry_max_lines: int = DIRECTED_RETRY_MAX_LINES
    model_id: str = DEFAULT_VIBEVOICE_MODEL_ID


@dataclass(frozen=True)
class VibeVoiceVoiceSample:
    slot: int
    path: Path


@dataclass(frozen=True)
class VibeVoiceDirectedLine:
    index: int
    speaker: int
    text: str


@dataclass(frozen=True)
class VibeVoiceAudioRange:
    speaker: int
    line_index: int
    text: str
    start: float
    end: float
    matched_text: str = ""
    chunk_index: int = 1
    candidate_role: str = "target"
    candidate_score: float = 0.0
    candidate_reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class _DirectedSpeakerScript:
    full_text: str
    target_text: str
    tail_guard_text: str


@dataclass(frozen=True)
class _DirectedLineChunk:
    speaker: int
    chunk_index: int
    lines: tuple[VibeVoiceDirectedLine, ...]


@dataclass(frozen=True)
class VibeVoiceResult:
    audio_bytes: bytes
    audio_mime_type: str
    normalized_script: str
    providers: dict[str, object]
    timings_ms: dict[str, float]
    diagnostics: dict[str, object] = field(default_factory=dict)
    artifacts: list[dict[str, object]] = field(default_factory=list)


class VibeVoiceError(RuntimeError):
    pass


def resolve_vibevoice_model_preset(model_id: str | None) -> VibeVoiceModelPreset:
    normalized = str(model_id or DEFAULT_VIBEVOICE_MODEL_ID).strip() or DEFAULT_VIBEVOICE_MODEL_ID
    try:
        return VIBEVOICE_MODEL_PRESETS[normalized]
    except KeyError as exc:
        raise ValueError(f"unsupported VibeVoice model: {normalized}") from exc


def normalize_vibevoice_backend(backend: str | None) -> str:
    normalized = str(backend or "local").strip() or "local"
    if normalized == "runpod":
        normalized = "runpod_serverless"
    if normalized not in {"local", "runpod_serverless"}:
        raise ValueError(f"unsupported VibeVoice backend: {normalized}")
    return normalized


def is_vibevoice_model_supported_by_backend(model_id: str | None, backend: str | None) -> bool:
    preset = resolve_vibevoice_model_preset(model_id)
    return normalize_vibevoice_backend(backend) in preset.supported_backends


def validate_vibevoice_model_backend(model_id: str | None, backend: str | None) -> VibeVoiceModelPreset:
    preset = resolve_vibevoice_model_preset(model_id)
    backend_id = normalize_vibevoice_backend(backend)
    if backend_id not in preset.supported_backends:
        allowed = ", ".join(preset.supported_backends)
        raise ValueError(f"{preset.model_id} は {allowed} backendでのみ利用できます。選択中: {backend_id}")
    return preset


def serialize_vibevoice_model_presets() -> list[dict[str, object]]:
    return [
        {
            "model_id": preset.model_id,
            "label": preset.label,
            "model_repo": preset.model_repo,
            "model_revision": preset.model_revision or "",
            "tokenizer_repo": preset.tokenizer_repo,
            "tokenizer_revision": preset.tokenizer_revision or "",
            "torch_dtype": preset.torch_dtype or "",
            "auto_line_by_line": preset.auto_line_by_line,
            "supported_backends": list(preset.supported_backends),
            "notes": preset.notes,
        }
        for preset in VIBEVOICE_MODEL_PRESETS.values()
    ]


SubprocessRun = Callable[..., subprocess.CompletedProcess[str]]


class VibeVoiceGenerator(Protocol):
    def status(self) -> dict[str, object]: ...

    def generate(
        self,
        *,
        script_text: str,
        voice_paths: Sequence[Path | VibeVoiceVoiceSample],
        options: VibeVoiceGenerationOptions | None = None,
        progress_callback: Callable[[str, str], None] | None = None,
        cancel_event: Event | None = None,
    ) -> VibeVoiceResult: ...


def normalize_vibevoice_script(text: str, *, max_bytes: int = 200_000) -> str:
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        raise ValueError("script is required")
    if len(raw.encode("utf-8")) > max_bytes:
        raise ValueError(f"script is too large: max {max_bytes} bytes")

    normalized_lines: list[str] = []
    for line in raw.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        normalized = _normalize_speaker_line(stripped)
        if normalized is not None:
            normalized_lines.append(normalized)
        else:
            normalized_lines.append(f"Speaker 1: {stripped}")
    if not normalized_lines:
        raise ValueError("script is required")
    return "\n".join(normalized_lines)


def normalize_vibevoice_directed_line_script(text: str, *, max_bytes: int = 200_000) -> str:
    speaker_lines = parse_vibevoice_directed_script_lines(text, max_bytes=max_bytes)
    speaker_slots = {line.speaker for line in speaker_lines}
    if len(speaker_slots) > 1:
        raise ValueError("単一話者の1行化には1話者の台本だけ指定できます。複数話者はASR再配置モードで処理します。")

    return _directed_script_for_lines(speaker_lines, output_speaker=next(iter(speaker_slots)))


def parse_vibevoice_directed_script_lines(text: str, *, max_bytes: int = 200_000) -> list[VibeVoiceDirectedLine]:
    normalized = normalize_vibevoice_script(text, max_bytes=max_bytes)
    speaker_lines: list[VibeVoiceDirectedLine] = []
    for index, line in enumerate(normalized.splitlines(), start=1):
        slot = _speaker_slot_from_normalized_line(line) or 1
        text_part = _collapse_directed_line_spacing(_speaker_text_from_normalized_line(line))
        if text_part:
            speaker_lines.append(VibeVoiceDirectedLine(index=index, speaker=slot, text=text_part))
    if not speaker_lines:
        raise ValueError("script is required")
    return speaker_lines


def directed_retry_max_lines_for_script(text: str, *, multiplier: float = DIRECTED_RETRY_MAX_MULTIPLIER) -> int:
    lines = parse_vibevoice_directed_script_lines(text)
    retry_multiplier = max(0.0, float(multiplier))
    if retry_multiplier == 0:
        return 0
    base_lines = max(1, math.ceil(len(lines) / 2))
    return max(0, math.ceil(base_lines * retry_multiplier))


def _directed_script_for_lines(lines: Sequence[VibeVoiceDirectedLine], *, output_speaker: int = 1) -> str:
    script = _directed_speaker_script_for_lines(lines, include_tail_guard=False)
    return f"Speaker {output_speaker}: {script.full_text}"


def _directed_speaker_script_for_lines(
    lines: Sequence[VibeVoiceDirectedLine],
    *,
    include_tail_guard: bool,
) -> _DirectedSpeakerScript:
    if not lines:
        raise ValueError("script is required")
    separator = _directed_line_separator("\n".join(line.text for line in lines))
    target_text = _join_directed_line_phrases([line.text for line in lines], separator=separator)
    tail_guard_text = (
        _directed_tail_guard_text(
            target_text,
            target_min_chars=DIRECTED_TARGET_MIN_CHARS,
            target_max_chars=DIRECTED_TARGET_MAX_CHARS,
            full_max_chars=DIRECTED_FULL_MAX_CHARS,
        )
        if include_tail_guard
        else ""
    )
    return _DirectedSpeakerScript(
        full_text=f"{target_text}{tail_guard_text}",
        target_text=target_text,
        tail_guard_text=tail_guard_text,
    )


def _directed_speaker_script_for_chunk(
    chunk: _DirectedLineChunk,
    chunks_for_speaker: Sequence[_DirectedLineChunk],
) -> _DirectedSpeakerScript:
    target_script = _directed_speaker_script_for_lines(chunk.lines, include_tail_guard=False)
    guard_lines = _directed_guard_lines_for_chunk(chunk, chunks_for_speaker) or list(chunk.lines)
    guard_script = _directed_speaker_script_for_lines(guard_lines, include_tail_guard=False)
    tail_guard_text = _directed_rotated_guard_text(
        target_script.target_text,
        guard_script.target_text,
        target_min_chars=DIRECTED_TARGET_MIN_CHARS,
        full_max_chars=DIRECTED_FULL_MAX_CHARS,
    )
    return _DirectedSpeakerScript(
        full_text=f"{target_script.target_text}{tail_guard_text}",
        target_text=target_script.target_text,
        tail_guard_text=tail_guard_text,
    )


def _directed_rotated_guard_text(
    target_text: str,
    guard_text: str,
    *,
    target_min_chars: int,
    full_max_chars: int,
) -> str:
    target = str(target_text or "").strip()
    guard = str(guard_text or "").strip()
    if not target or not guard:
        return ""
    repeated_guard = guard
    while target_min_chars > 0 and len(target) + len(repeated_guard) < target_min_chars:
        repeated_guard += guard
    if full_max_chars > 0 and len(target) + len(repeated_guard) > full_max_chars:
        repeated_guard = _trim_directed_tail_guard(
            repeated_guard,
            max_chars=max(0, full_max_chars - len(target)),
            separator="。" if _directed_line_separator(f"{target}{guard}") == "。" else ".",
        )
    return repeated_guard


def _has_speaker_tag(line: str) -> bool:
    prefix, sep, _rest = line.partition(":")
    if not sep:
        return False
    normalized_prefix = " ".join(prefix.strip().lower().split())
    if not normalized_prefix.startswith("speaker "):
        return False
    try:
        return int(normalized_prefix.removeprefix("speaker ").strip()) >= 1
    except ValueError:
        return False


def _normalize_speaker_line(line: str) -> str | None:
    if _has_speaker_tag(line):
        return line
    match = _SHORT_SPEAKER_TAG_RE.match(line)
    if match is None:
        return None
    speaker_number = _speaker_number_from_short_tag(match.group(1))
    if speaker_number is None:
        return None
    return f"Speaker {speaker_number}: {match.group(2).strip()}"


def _speaker_number_from_short_tag(tag: str) -> int | None:
    normalized = tag.strip()
    if normalized.isdigit():
        number = int(normalized)
    elif len(normalized) == 1 and normalized.isalpha():
        number = ord(normalized.upper()) - ord("A") + 1
    else:
        return None
    return number if SHORT_SPEAKER_TAG_MIN <= number <= SHORT_SPEAKER_TAG_MAX else None


def _speaker_slot_from_normalized_line(line: str) -> int | None:
    match = re.match(r"^Speaker\s+([1-4])\s*:", str(line or "").strip(), flags=re.IGNORECASE)
    return int(match.group(1)) if match else None


def _collapse_directed_line_spacing(text: str) -> str:
    collapsed = re.sub(r"\s+", " ", str(text or "").strip())
    collapsed = re.sub(r"\s+([、。，，,.!?！？])", r"\1", collapsed)
    collapsed = re.sub(r"([、。，，,.!?！？])\s+", r"\1", collapsed)
    return collapsed


def _directed_line_separator(text: str) -> str:
    return "。" if re.search(r"[ぁ-んァ-ン一-龯、。]", text) else "."


def _join_directed_line_phrases(phrases: Sequence[str], *, separator: str) -> str:
    non_empty = [_normalize_directed_vv_phrase(phrase, separator=separator) for phrase in phrases if phrase.strip()]
    non_empty = [phrase for phrase in non_empty if phrase]
    if not non_empty:
        raise ValueError("script is required")
    parts: list[str] = []
    for index, phrase in enumerate(non_empty):
        parts.append(phrase)
        if index < len(non_empty) - 1 and not _ends_with_sentence_punctuation(phrase):
            parts.append(separator)
    return _ensure_sentence_end("".join(parts), separator=separator)


def _normalize_directed_vv_phrase(text: str, *, separator: str) -> str:
    normalized = _collapse_directed_line_spacing(text)
    if separator == "。":
        normalized = re.sub(r"[、。，，,.]+", "。", normalized)
        normalized = re.sub(r"。+", "。", normalized)
    return normalized.strip()


def _ensure_sentence_end(text: str, *, separator: str) -> str:
    value = str(text or "").strip()
    if value and not _ends_with_sentence_punctuation(value):
        value += separator
    return value


def _directed_tail_guard_text(
    target_text: str,
    *,
    target_min_chars: int = 0,
    target_max_chars: int = 0,
    full_max_chars: int = 0,
) -> str:
    value = str(target_text or "").strip()
    if not value:
        return ""
    if target_max_chars > 0 and len(value) > target_max_chars:
        return ""
    if len(value) <= DIRECTED_TAIL_GUARD_MAX_CHARS:
        guard = value
    else:
        prefix = value[:DIRECTED_TAIL_GUARD_MAX_CHARS]
        boundary = max(prefix.rfind(mark) for mark in ("。", ".", "？", "?", "！", "!", "…"))
        if boundary >= max(12, DIRECTED_TAIL_GUARD_MAX_CHARS // 3):
            guard = prefix[: boundary + 1]
        else:
            guard = _ensure_sentence_end(prefix, separator="。" if _directed_line_separator(value) == "。" else ".")
    if not guard or target_min_chars <= 0:
        return guard
    repeated_guard = guard
    while len(value) + len(repeated_guard) < target_min_chars:
        repeated_guard += guard
    if full_max_chars > 0 and len(value) + len(repeated_guard) > full_max_chars:
        repeated_guard = _trim_directed_tail_guard(
            repeated_guard,
            max_chars=max(0, full_max_chars - len(value)),
            separator="。" if _directed_line_separator(value) == "。" else ".",
        )
    return repeated_guard


def _trim_directed_tail_guard(text: str, *, max_chars: int, separator: str) -> str:
    if max_chars <= 0:
        return ""
    value = str(text or "").strip()
    if len(value) <= max_chars:
        return value
    trimmed = value[:max_chars].strip()
    boundary = max(trimmed.rfind(mark) for mark in ("。", ".", "？", "?", "！", "!", "…"))
    if boundary >= max(12, max_chars // 3):
        return trimmed[: boundary + 1]
    if _ends_with_sentence_punctuation(trimmed):
        return trimmed
    if max_chars <= len(separator):
        return separator[:max_chars]
    return f"{trimmed[: max_chars - len(separator)].rstrip()}{separator}"


def _directed_speaker_script_length_diagnostics(script: _DirectedSpeakerScript) -> dict[str, object]:
    target_chars = len(script.target_text)
    tail_guard_chars = len(script.tail_guard_text)
    return {
        "target_chars": target_chars,
        "tail_guard_chars": tail_guard_chars,
        "full_chars": len(script.full_text),
        "below_target_min": target_chars < DIRECTED_TARGET_MIN_CHARS,
        "above_target_max": target_chars > DIRECTED_TARGET_MAX_CHARS,
        "above_full_max": len(script.full_text) > DIRECTED_FULL_MAX_CHARS,
    }


def _ends_with_sentence_punctuation(text: str) -> bool:
    return bool(re.search(r"[。.!?！？…]$", str(text or "").strip()))


class VibeVoiceService:
    name = "local-vibevoice-cli"
    audio_mime_type = "audio/wav"

    def __init__(
        self,
        *,
        python: str | None = None,
        cli_path: str | Path | None = None,
        vibevoice_home: str | Path | None = None,
        comfyui_vibevoice_path: str | Path | None = None,
        timeout_seconds: float | None = None,
        subprocess_run: SubprocessRun = subprocess.run,
        directed_asr_provider: object | None = None,
        directed_voice_conversion_service: object | None = None,
    ) -> None:
        self.python = python or os.getenv("MO_VIBEVOICE_PYTHON") or _default_vibevoice_python()
        self.cli_path = Path(cli_path or os.getenv("MO_VIBEVOICE_CLI") or DEFAULT_VIBEVOICE_CLI).expanduser()
        self.vibevoice_home = _resolve_path_setting(
            explicit=vibevoice_home,
            env_names=("MO_VIBEVOICE_HOME", "VIBEVOICE_HOME"),
            candidates=_default_vibevoice_home_candidates(),
        )
        self.comfyui_vibevoice_path = _resolve_path_setting(
            explicit=comfyui_vibevoice_path,
            env_names=("MO_COMFYUI_VIBEVOICE_PATH", "COMFYUI_VIBEVOICE_PATH"),
            candidates=_default_comfyui_vibevoice_candidates(),
        )
        self.timeout_seconds = float(
            timeout_seconds
            if timeout_seconds is not None
            else os.getenv("MO_VIBEVOICE_TIMEOUT_SECONDS", str(DEFAULT_VIBEVOICE_TIMEOUT_SECONDS))
        )
        self._subprocess_run = subprocess_run
        self._directed_asr_provider_instance = directed_asr_provider
        self._owns_directed_asr_provider = directed_asr_provider is None
        self._directed_voice_conversion_service_instance = directed_voice_conversion_service
        self._owns_directed_voice_conversion_service = directed_voice_conversion_service is None

    @classmethod
    def from_env(cls) -> "VibeVoiceService":
        return cls()

    def status(self) -> dict[str, object]:
        try:
            default_model = resolve_vibevoice_model_preset(os.getenv("VIBEVOICE_DEFAULT_MODEL_ID"))
        except ValueError:
            default_model = resolve_vibevoice_model_preset(DEFAULT_VIBEVOICE_MODEL_ID)
        model_cache = self._find_model_cache(default_model)
        tokenizer = self._find_tokenizer(default_model)
        cli_exists = self.cli_path.is_file()
        module_exists = self.comfyui_vibevoice_path.is_dir()
        available = cli_exists and module_exists and model_cache is not None and tokenizer is not None
        return {
            "available": available,
            "provider": self.name,
            "default_model_id": default_model.model_id,
            "model_presets": serialize_vibevoice_model_presets(),
            "model_repo": default_model.model_repo,
            "model_revision": default_model.model_revision or "",
            "tokenizer_repo": default_model.tokenizer_repo,
            "tokenizer_revision": default_model.tokenizer_revision or "",
            "python": self.python,
            "cli_path": str(self.cli_path),
            "cli_exists": cli_exists,
            "comfyui_vibevoice_path": str(self.comfyui_vibevoice_path),
            "comfyui_vibevoice_exists": module_exists,
            "vibevoice_home": str(self.vibevoice_home),
            "model_cache_found": model_cache is not None,
            "model_cache_path": str(model_cache) if model_cache else "",
            "tokenizer_found": tokenizer is not None,
            "tokenizer_path": str(tokenizer) if tokenizer else "",
            "timeout_seconds": self.timeout_seconds,
        }

    def generate(
        self,
        *,
        script_text: str,
        voice_paths: Sequence[Path | VibeVoiceVoiceSample],
        options: VibeVoiceGenerationOptions | None = None,
        progress_callback: Callable[[str, str], None] | None = None,
        cancel_event: Event | None = None,
    ) -> VibeVoiceResult:
        voice_samples = _coerce_voice_samples(voice_paths)
        if not voice_samples:
            raise ValueError("voice sample is required")
        base_options = options or VibeVoiceGenerationOptions()
        if base_options.directed_line_mode:
            return self._generate_directed_line_mode(
                script_text=script_text,
                voice_samples=voice_samples,
                options=base_options,
                progress_callback=progress_callback,
                cancel_event=cancel_event,
            )
        return self._generate_single_pass(
            script_text=script_text,
            voice_samples=voice_samples,
            options=base_options,
            progress_callback=progress_callback,
            cancel_event=cancel_event,
        )

    def _generate_single_pass(
        self,
        *,
        script_text: str,
        voice_samples: Sequence[VibeVoiceVoiceSample],
        options: VibeVoiceGenerationOptions,
        progress_callback: Callable[[str, str], None] | None = None,
        cancel_event: Event | None = None,
        allow_auto_line_by_line: bool = True,
    ) -> VibeVoiceResult:
        if not self.cli_path.is_file():
            raise VibeVoiceError(f"VibeVoice CLI was not found: {self.cli_path}")
        normalized_script = _normalize_vibevoice_script_for_options(script_text, options)
        generation_options = _options_with_auto_line_by_line(normalized_script, options) if allow_auto_line_by_line else options
        model_preset = resolve_vibevoice_model_preset(generation_options.model_id)
        started = perf_counter()
        _report_vibevoice_progress(progress_callback, "prepare", "入力準備")

        with TemporaryDirectory(prefix="mo-vibevoice-") as temp_dir:
            temp_root = Path(temp_dir)
            script_path = temp_root / "script.txt"
            script_path.write_text(normalized_script, encoding="utf-8")
            output_path = temp_root / "vibevoice-output.wav"
            metadata_path = temp_root / "vibevoice-metadata.json"
            voice_files = [
                VibeVoiceVoiceSample(
                    slot=sample.slot,
                    path=self._prepare_voice_file(sample.path, temp_root, sample.slot),
                )
                for sample in voice_samples
            ]
            command = self._build_command(
                script_path=script_path,
                output_path=output_path,
                metadata_path=metadata_path,
                voice_files=voice_files,
                options=generation_options,
            )
            _report_vibevoice_progress(progress_callback, "generation", "VibeVoice生成")
            completed = self._run_generation_command(
                command,
                env=self._build_env(model_preset),
                cwd=str(Path.cwd()),
                cancel_event=cancel_event,
                progress_callback=progress_callback,
            )
            if completed.returncode != 0:
                raise VibeVoiceError(
                    "VibeVoice generation failed: "
                    f"{_tail_text(completed.stderr) or _tail_text(completed.stdout) or completed.returncode}"
                )
            if not output_path.is_file() or output_path.stat().st_size == 0:
                raise VibeVoiceError("VibeVoice generation did not produce an audio file")
            _report_vibevoice_progress(progress_callback, "read_output", "生成音声読み込み")
            audio_bytes = output_path.read_bytes()

        total_ms = _elapsed_ms(started)
        return VibeVoiceResult(
            audio_bytes=audio_bytes,
            audio_mime_type=self.audio_mime_type,
            normalized_script=normalized_script,
            providers={
                "vibevoice": self.name,
                "vibevoice_model_id": model_preset.model_id,
                "vibevoice_model_repo": model_preset.model_repo,
                "vibevoice_model_revision": model_preset.model_revision or "main",
                "vibevoice_tokenizer_repo": model_preset.tokenizer_repo,
                "vibevoice_tokenizer_revision": model_preset.tokenizer_revision or "main",
                "cli_path": str(self.cli_path),
                "vibevoice_home": str(self.vibevoice_home),
            },
            timings_ms={"vibevoice": total_ms, "total": total_ms},
            diagnostics={
                "used_voice_samples": _voice_sample_diagnostics(voice_files),
                "stdout_tail": _tail_text(completed.stdout),
                "stderr_tail": _tail_text(completed.stderr),
                "command": _redacted_command(command),
            },
        )

    def _generate_directed_line_mode(
        self,
        *,
        script_text: str,
        voice_samples: Sequence[VibeVoiceVoiceSample],
        options: VibeVoiceGenerationOptions,
        progress_callback: Callable[[str, str], None] | None = None,
        cancel_event: Event | None = None,
    ) -> VibeVoiceResult:
        directed_started = perf_counter()
        lines = parse_vibevoice_directed_script_lines(script_text)
        samples_by_slot = {sample.slot: sample for sample in voice_samples}
        missing_slots = sorted({line.speaker for line in lines if line.speaker not in samples_by_slot})
        if missing_slots:
            raise ValueError(f"Speaker {', '.join(str(slot) for slot in missing_slots)} の参照音声を指定してください。")

        lines_by_speaker = _directed_lines_by_speaker(lines)
        chunks_by_speaker = {
            speaker: _directed_line_chunks_for_speaker(speaker_lines)
            for speaker, speaker_lines in lines_by_speaker.items()
        }
        chunks = [chunk for speaker in lines_by_speaker for chunk in chunks_by_speaker[speaker]]
        chunk_outputs: dict[tuple[int, int], Path] = {}
        ranges_by_line: dict[int, VibeVoiceAudioRange] = {}
        range_candidates_by_line: dict[int, list[VibeVoiceAudioRange]] = {}
        chunk_results: dict[str, VibeVoiceResult] = {}
        chunk_vibevoice_outputs: dict[tuple[int, int], Path] = {}
        chunk_scripts: dict[str, str] = {}
        chunk_target_scripts: dict[str, str] = {}
        chunk_tail_guards: dict[str, str] = {}
        chunk_script_lengths: dict[str, dict[str, object]] = {}
        retry_scripts: dict[str, str] = {}
        retry_target_scripts: dict[str, str] = {}
        retry_tail_guards: dict[str, str] = {}
        retry_script_lengths: dict[str, dict[str, object]] = {}
        retry_seeds: dict[str, int] = {}
        asr_segments_by_chunk: dict[str, list[dict[str, object]]] = {}
        asr_words_by_chunk: dict[str, list[dict[str, object]]] = {}
        asr_texts_by_chunk: dict[str, dict[str, object]] = {}
        vc_results_by_chunk: dict[str, object] = {}
        voice_conversion_durations: dict[str, dict[str, float]] = {}
        retry_results: dict[str, VibeVoiceResult] = {}
        artifacts: list[dict[str, object]] = []
        warnings: list[str] = []
        generation_total_ms = 0.0
        voice_conversion_total_ms = 0.0
        asr_total_ms = 0.0
        asr_name = ""
        voice_conversion_name = ""
        voice_conversion_settings: dict[str, object] = {}
        retry_score_threshold = max(0.0, min(1.0, float(options.directed_retry_score_threshold)))
        retry_max_lines = max(0, int(options.directed_retry_max_lines))
        low_score_retry_diagnostics: dict[str, object] = {
            "enabled": options.directed_retry_low_score,
            "score_threshold": retry_score_threshold,
            "max_lines": retry_max_lines,
            "initial_low_score_line_indices": [],
            "attempted_line_indices": [],
            "skipped_line_indices": [],
            "selected_line_indices": [],
        }

        self._release_directed_asr_provider()
        self._release_directed_voice_conversion_service()
        _report_vibevoice_progress(progress_callback, "prepare", "指定台詞モード準備")
        with TemporaryDirectory(prefix="mo-vibevoice-directed-") as temp_dir_raw:
            temp_dir = Path(temp_dir_raw)
            for chunk_index, chunk in enumerate(chunks, start=1):
                _raise_if_cancelled(cancel_event)
                chunk_key = _directed_chunk_key(chunk, chunks_by_speaker)
                chunk_label = _directed_chunk_label(chunk, chunks_by_speaker)
                chunk_audio_stem = _directed_chunk_audio_stem(chunk, chunks_by_speaker)
                speaker_script_parts = _directed_speaker_script_for_chunk(chunk, chunks_by_speaker[chunk.speaker])
                speaker_script = f"Speaker 1: {speaker_script_parts.full_text}"
                chunk_scripts[chunk_key] = speaker_script
                chunk_target_scripts[chunk_key] = f"Speaker 1: {speaker_script_parts.target_text}"
                chunk_tail_guards[chunk_key] = speaker_script_parts.tail_guard_text
                chunk_script_lengths[chunk_key] = _directed_speaker_script_length_diagnostics(speaker_script_parts)
                if chunk_script_lengths[chunk_key]["below_target_min"]:
                    warnings.append(
                        f"{chunk_label}: VV投入テキストが短いため末尾ガードを増やしました "
                        f"({chunk_script_lengths[chunk_key]['target_chars']} chars)"
                    )
                if chunk_script_lengths[chunk_key]["above_target_max"]:
                    warnings.append(
                        f"{chunk_label}: VV投入テキストが長いため末尾ガードを追加しませんでした "
                        f"({chunk_script_lengths[chunk_key]['target_chars']} chars)"
                    )
                speaker_options = replace(options, directed_line_mode=False, line_by_line=False)
                _report_vibevoice_progress(
                    progress_callback,
                    "generation",
                    f"指定台詞 {chunk_label} 生成 {chunk_index}/{len(chunks)}",
                )
                speaker_result = self._generate_single_pass(
                    script_text=speaker_script,
                    voice_samples=[VibeVoiceVoiceSample(slot=1, path=samples_by_slot[chunk.speaker].path)],
                    options=speaker_options,
                    progress_callback=progress_callback,
                    cancel_event=cancel_event,
                    allow_auto_line_by_line=False,
                )
                generation_total_ms += float(speaker_result.timings_ms.get("total", 0.0))
                chunk_results[chunk_key] = speaker_result
                speaker_output = temp_dir / f"{chunk_audio_stem}.wav"
                speaker_output.write_bytes(speaker_result.audio_bytes)
                chunk_vibevoice_outputs[(chunk.speaker, chunk.chunk_index)] = speaker_output
                chunk_outputs[(chunk.speaker, chunk.chunk_index)] = speaker_output

            asr_provider = self._get_directed_asr_provider()
            asr_name = str(getattr(asr_provider, "name", asr_provider.__class__.__name__))
            try:
                for chunk_index, chunk in enumerate(chunks, start=1):
                    _raise_if_cancelled(cancel_event)
                    chunk_key = _directed_chunk_key(chunk, chunks_by_speaker)
                    chunk_label = _directed_chunk_label(chunk, chunks_by_speaker)
                    _report_vibevoice_progress(
                        progress_callback,
                        "asr",
                        f"指定台詞 {chunk_label} ASR分割 {chunk_index}/{len(chunks)}",
                    )
                    asr_started = perf_counter()
                    transcription = _transcribe_directed_audio(asr_provider, chunk_outputs[(chunk.speaker, chunk.chunk_index)])
                    asr_total_ms += _elapsed_ms(asr_started)
                    asr_segments_by_chunk[chunk_key] = _timestamp_rows(getattr(transcription, "segments", []))
                    asr_words_by_chunk[chunk_key] = _timestamp_rows(getattr(transcription, "words", []))
                    guard_lines = _directed_guard_lines_for_chunk(chunk, chunks_by_speaker[chunk.speaker])
                    ranges, range_warnings, asr_text_diagnostics = _audio_range_candidates_for_directed_chunk(
                        target_lines=chunk.lines,
                        guard_lines=guard_lines,
                        transcription=transcription,
                        audio_path=chunk_outputs[(chunk.speaker, chunk.chunk_index)],
                        chunk_index=chunk.chunk_index,
                    )
                    asr_texts_by_chunk[chunk_key] = asr_text_diagnostics
                    warnings.extend(f"{chunk_label}: {warning}" for warning in range_warnings)
                    for audio_range in ranges:
                        range_candidates_by_line.setdefault(audio_range.line_index, []).append(audio_range)
            finally:
                self._release_directed_asr_provider()

            ranges_by_line, candidate_warnings = _select_best_directed_range_candidates(lines, range_candidates_by_line)
            if options.directed_retry_low_score and retry_max_lines > 0:
                all_low_score_line_indices = [
                    line.index
                    for line in lines
                    if ranges_by_line[line.index].candidate_score < retry_score_threshold
                ]
                retry_lines = _directed_low_score_retry_lines(
                    lines,
                    ranges_by_line,
                    score_threshold=retry_score_threshold,
                    max_lines=retry_max_lines,
                )
                attempted_indices = [line.index for line in retry_lines]
                attempted_index_set = set(attempted_indices)
                low_score_retry_diagnostics["initial_low_score_line_indices"] = all_low_score_line_indices
                low_score_retry_diagnostics["attempted_line_indices"] = attempted_indices
                low_score_retry_diagnostics["skipped_line_indices"] = [
                    line_index
                    for line_index in all_low_score_line_indices
                    if line_index not in attempted_index_set
                ]
                if retry_lines:
                    asr_provider = self._get_directed_asr_provider()
                    asr_name = str(getattr(asr_provider, "name", asr_provider.__class__.__name__))
                    try:
                        for retry_number, line in enumerate(retry_lines, start=1):
                            _raise_if_cancelled(cancel_event)
                            retry_key = f"{line.speaker}-retry-{line.index}"
                            retry_chunk_index = _directed_retry_chunk_index(line)
                            retry_audio_stem = f"speaker-{line.speaker}-retry-line-{line.index}"
                            retry_script_parts = _directed_retry_script_for_line(line, lines_by_speaker[line.speaker])
                            retry_script = f"Speaker 1: {retry_script_parts.full_text}"
                            retry_scripts[retry_key] = retry_script
                            retry_target_scripts[retry_key] = f"Speaker 1: {retry_script_parts.target_text}"
                            retry_tail_guards[retry_key] = retry_script_parts.tail_guard_text
                            retry_script_lengths[retry_key] = _directed_speaker_script_length_diagnostics(retry_script_parts)
                            retry_options = replace(
                                options,
                                directed_line_mode=False,
                                directed_retry_low_score=False,
                                line_by_line=False,
                                seed=int(options.seed) + 1000 + retry_number,
                            )
                            retry_seeds[retry_key] = retry_options.seed
                            _report_vibevoice_progress(
                                progress_callback,
                                "generation",
                                f"指定台詞 Line {line.index} 低スコア再生成 {retry_number}/{len(retry_lines)}",
                            )
                            retry_result = self._generate_single_pass(
                                script_text=retry_script,
                                voice_samples=[VibeVoiceVoiceSample(slot=1, path=samples_by_slot[line.speaker].path)],
                                options=retry_options,
                                progress_callback=progress_callback,
                                cancel_event=cancel_event,
                                allow_auto_line_by_line=False,
                            )
                            generation_total_ms += float(retry_result.timings_ms.get("total", 0.0))
                            retry_results[retry_key] = retry_result
                            retry_vibevoice_output = temp_dir / f"{retry_audio_stem}.wav"
                            retry_vibevoice_output.write_bytes(retry_result.audio_bytes)
                            retry_output = retry_vibevoice_output
                            chunk_outputs[(line.speaker, retry_chunk_index)] = retry_output
                            _report_vibevoice_progress(
                                progress_callback,
                                "asr",
                                f"指定台詞 Line {line.index} 低スコア再生成ASR {retry_number}/{len(retry_lines)}",
                            )
                            asr_started = perf_counter()
                            transcription = _transcribe_directed_audio(asr_provider, retry_output)
                            asr_total_ms += _elapsed_ms(asr_started)
                            asr_segments_by_chunk[retry_key] = _timestamp_rows(getattr(transcription, "segments", []))
                            asr_words_by_chunk[retry_key] = _timestamp_rows(getattr(transcription, "words", []))
                            ranges, range_warnings, asr_text_diagnostics = _audio_range_candidates_for_directed_chunk(
                                target_lines=[line],
                                guard_lines=[],
                                transcription=transcription,
                                audio_path=retry_output,
                                chunk_index=retry_chunk_index,
                                target_role="retry_target",
                            )
                            asr_texts_by_chunk[retry_key] = asr_text_diagnostics
                            warnings.extend(f"Line {line.index} 低スコア再生成: {warning}" for warning in range_warnings)
                            for audio_range in ranges:
                                range_candidates_by_line.setdefault(audio_range.line_index, []).append(audio_range)
                    finally:
                        self._release_directed_asr_provider()
                    ranges_by_line, candidate_warnings = _select_best_directed_range_candidates(lines, range_candidates_by_line)
            low_score_retry_diagnostics["selected_line_indices"] = [
                line.index
                for line in lines
                if ranges_by_line[line.index].candidate_role == "retry_target"
            ]
            warnings.extend(candidate_warnings)
            composition_outputs: dict[object, Path] = dict(chunk_outputs)
            composition_ranges_by_line = ranges_by_line
            if _directed_voice_conversion_enabled():
                vc_service = self._get_directed_voice_conversion_service()
                voice_conversion_settings = _directed_voice_conversion_settings_diagnostics(vc_service)
                composition_outputs = {}
                composition_ranges_by_line = {}
                try:
                    for line_index, line in enumerate(lines, start=1):
                        _raise_if_cancelled(cancel_event)
                        selected_range = ranges_by_line[line.index]
                        source_path = _directed_output_path_for_range(chunk_outputs, selected_range)
                        clip_input = temp_dir / f"line-{line.index}-speaker-{line.speaker}-vv-clip.wav"
                        _write_wav_range(
                            source_path,
                            start=selected_range.start,
                            end=selected_range.end,
                            output_path=clip_input,
                            normalize=False,
                        )
                        _report_vibevoice_progress(
                            progress_callback,
                            "voice_conversion",
                            f"指定台詞 Line {line.index} VC {line_index}/{len(lines)}",
                        )
                        vc_started = perf_counter()
                        vc_result = _convert_directed_voice(
                            vc_service,
                            source_audio_path=clip_input,
                            reference_audio_path=samples_by_slot[line.speaker].path,
                            progress_callback=progress_callback,
                        )
                        voice_conversion_total_ms += _elapsed_ms(vc_started)
                        vc_key = f"line-{line.index}"
                        vc_results_by_chunk[vc_key] = vc_result
                        voice_conversion_name = str(
                            getattr(vc_result, "providers", {}).get("voice_conversion", "")
                            or voice_conversion_name
                            or "voice_conversion"
                        )
                        vc_output = temp_dir / f"line-{line.index}-speaker-{line.speaker}-vc.wav"
                        vc_output.write_bytes(getattr(vc_result, "output_audio_bytes"))
                        vv_duration = _wav_duration(clip_input)
                        vc_duration = _wav_duration(vc_output)
                        voice_conversion_durations[vc_key] = {
                            "vv_clip_duration": vv_duration,
                            "vc_clip_duration": vc_duration,
                            "duration_delta": vc_duration - vv_duration,
                        }
                        composition_outputs[line.index] = vc_output
                        composition_ranges_by_line[line.index] = replace(
                            selected_range,
                            start=0.0,
                            end=vc_duration,
                        )
                finally:
                    self._release_directed_voice_conversion_service()
            _raise_if_cancelled(cancel_event)
            _report_vibevoice_progress(progress_callback, "reconstruct", "指定台詞 音声再配置")
            reconstruct_started = perf_counter()
            output_path = temp_dir / "directed-vibevoice-output.wav"
            _compose_directed_wav(
                lines,
                ranges_by_line=composition_ranges_by_line,
                speaker_outputs=composition_outputs,
                output_path=output_path,
                gap_seconds=options.line_gap,
            )
            audio_bytes = output_path.read_bytes()
            reconstruct_ms = _elapsed_ms(reconstruct_started)
            artifacts = _directed_audio_artifacts(
                lines=lines,
                chunks=chunks,
                chunks_by_speaker=chunks_by_speaker,
                speaker_vibevoice_outputs=chunk_vibevoice_outputs,
                speaker_outputs=composition_outputs,
                speaker_scripts=chunk_scripts,
                ranges_by_line=composition_ranges_by_line,
                include_voice_conversion=False,
            )

        total_ms = _elapsed_ms(directed_started)
        first_result = next(iter(chunk_results.values()))
        providers = dict(first_result.providers)
        providers["vibevoice_directed_asr"] = asr_name
        providers["vibevoice_directed_mode"] = "asr_reconstruct"
        if voice_conversion_name:
            providers["vibevoice_directed_vc"] = voice_conversion_name
        chunks_diagnostics = [
            {
                "key": _directed_chunk_key(chunk, chunks_by_speaker),
                "speaker": chunk.speaker,
                "chunk_index": chunk.chunk_index,
                "line_indices": [line.index for line in chunk.lines],
                "guard_line_indices": [
                    line.index
                    for line in (_directed_guard_lines_for_chunk(chunk, chunks_by_speaker[chunk.speaker]) or list(chunk.lines))
                ],
                **chunk_script_lengths[_directed_chunk_key(chunk, chunks_by_speaker)],
            }
            for chunk in chunks
        ]
        return VibeVoiceResult(
            audio_bytes=audio_bytes,
            audio_mime_type=self.audio_mime_type,
            normalized_script=normalize_vibevoice_script(script_text),
            providers=providers,
            timings_ms={
                "vibevoice": generation_total_ms,
                "vibevoice_directed_vc": voice_conversion_total_ms,
                "vibevoice_directed_asr": asr_total_ms,
                "vibevoice_directed_reconstruct": reconstruct_ms,
                "total": total_ms,
            },
            diagnostics={
                "directed_line_mode": {
                    "speakers": sorted(lines_by_speaker),
                    "line_count": len(lines),
                    "chunk_count": len(chunks),
                    "chunks": chunks_diagnostics,
                    "asr_provider": asr_name,
                    "voice_conversion_provider": voice_conversion_name,
                    "voice_conversion_settings": voice_conversion_settings,
                    "gap_seconds": options.line_gap,
                    "output_normalization": {
                        "target_rms": DIRECTED_OUTPUT_TARGET_RMS,
                        "peak_limit": DIRECTED_OUTPUT_PEAK_LIMIT,
                        "max_gain": DIRECTED_OUTPUT_MAX_GAIN,
                    },
                    "script_char_limits": {
                        "target_min": DIRECTED_TARGET_MIN_CHARS,
                        "target_max": DIRECTED_TARGET_MAX_CHARS,
                        "line_max": DIRECTED_LINE_MAX_CHARS,
                        "full_max": DIRECTED_FULL_MAX_CHARS,
                    },
                    "low_score_retry": low_score_retry_diagnostics,
                    "warnings": warnings,
                    "speaker_scripts": chunk_scripts,
                    "speaker_target_scripts": chunk_target_scripts,
                    "speaker_tail_guards": chunk_tail_guards,
                    "speaker_script_lengths": chunk_script_lengths,
                    "retry_scripts": retry_scripts,
                    "retry_target_scripts": retry_target_scripts,
                    "retry_tail_guards": retry_tail_guards,
                    "retry_script_lengths": retry_script_lengths,
                    "retry_seeds": retry_seeds,
                    "asr_texts": asr_texts_by_chunk,
                    "asr_segments": asr_segments_by_chunk,
                    "asr_words": asr_words_by_chunk,
                    "voice_conversion": {
                        key: {
                            "timings_ms": getattr(result, "timings_ms", {}),
                            "providers": getattr(result, "providers", {}),
                            "warnings": getattr(result, "warnings", []),
                        }
                        for key, result in sorted(vc_results_by_chunk.items())
                    },
                    "voice_conversion_granularity": "selected_line_segments" if vc_results_by_chunk else "",
                    "voice_conversion_durations": voice_conversion_durations,
                    "ranges": [
                        {
                            "line_index": audio_range.line_index,
                            "speaker": audio_range.speaker,
                            "chunk_index": audio_range.chunk_index,
                            "text": audio_range.text,
                            "matched_text": audio_range.matched_text,
                            "candidate_role": audio_range.candidate_role,
                            "candidate_score": audio_range.candidate_score,
                            "candidate_reasons": list(audio_range.candidate_reasons),
                            "start": audio_range.start,
                            "end": audio_range.end,
                        }
                        for audio_range in sorted(ranges_by_line.values(), key=lambda item: item.line_index)
                    ],
                    "range_candidates": _directed_range_candidate_diagnostics(
                        range_candidates_by_line,
                        selected_by_line=ranges_by_line,
                    ),
                },
                "speaker_results": {
                    key: result.diagnostics for key, result in sorted(chunk_results.items())
                },
                "retry_results": {
                    key: result.diagnostics for key, result in sorted(retry_results.items())
                },
            },
            artifacts=artifacts,
        )

    def _get_directed_asr_provider(self):
        if self._directed_asr_provider_instance is None:
            self._directed_asr_provider_instance = _create_directed_asr_provider()
        return self._directed_asr_provider_instance

    def _release_directed_asr_provider(self) -> None:
        if not self._owns_directed_asr_provider or self._directed_asr_provider_instance is None:
            return
        release = getattr(self._directed_asr_provider_instance, "release", None)
        if callable(release):
            release()
        self._directed_asr_provider_instance = None

    def _get_directed_voice_conversion_service(self):
        if self._directed_voice_conversion_service_instance is None:
            self._directed_voice_conversion_service_instance = _create_directed_voice_conversion_service()
        return self._directed_voice_conversion_service_instance

    def _release_directed_voice_conversion_service(self) -> None:
        if not self._owns_directed_voice_conversion_service or self._directed_voice_conversion_service_instance is None:
            return
        release = getattr(self._directed_voice_conversion_service_instance, "release", None)
        if callable(release):
            release()
        self._directed_voice_conversion_service_instance = None

    def _build_command(
        self,
        *,
        script_path: Path,
        output_path: Path,
        metadata_path: Path,
        voice_files: Sequence[VibeVoiceVoiceSample],
        options: VibeVoiceGenerationOptions,
    ) -> list[str]:
        command = [
            self.python,
            str(self.cli_path),
            "--text_file",
            str(script_path),
            "--output",
            str(output_path),
            "--cfg_scale",
            _format_number(options.cfg_scale),
            "--inference_steps",
            str(max(1, int(options.inference_steps))),
            "--seed",
            str(int(options.seed)),
            "--temperature",
            _format_number(options.temperature),
            "--top_p",
            _format_number(options.top_p),
            "--top_k",
            str(max(0, int(options.top_k))),
            "--max_voice_seconds",
            _format_number(options.max_voice_seconds),
        ]
        for sample in sorted(voice_files, key=lambda item: item.slot):
            command.extend([f"--voice{sample.slot}_file", str(sample.path)])
        if not options.do_sample:
            command.append("--no_sample")
        if options.line_by_line:
            command.extend(
                [
                    "--line_by_line",
                    "concat",
                    "--line_gap",
                    _format_number(options.line_gap),
                    "--line_metadata",
                    str(metadata_path),
                ]
            )
        return command

    def _build_env(self, model_preset: VibeVoiceModelPreset) -> dict[str, str]:
        env = dict(os.environ)
        env["VIBEVOICE_HOME"] = str(self.vibevoice_home)
        env["COMFYUI_VIBEVOICE_PATH"] = str(self.comfyui_vibevoice_path)
        env["VIBEVOICE_MODEL_REPO"] = model_preset.model_repo
        env["VIBEVOICE_MODEL_REVISION"] = model_preset.model_revision or ""
        env["VIBEVOICE_TOKENIZER_REPO"] = model_preset.tokenizer_repo
        env["VIBEVOICE_TOKENIZER_REVISION"] = model_preset.tokenizer_revision or ""
        if model_preset.torch_dtype:
            env["VIBEVOICE_TORCH_DTYPE"] = model_preset.torch_dtype
        if model_preset.generation_config_mode:
            env["VIBEVOICE_GENERATION_CONFIG_MODE"] = model_preset.generation_config_mode
        else:
            env.pop("VIBEVOICE_GENERATION_CONFIG_MODE", None)
        if model_preset.min_audio_tokens > 0:
            env["VIBEVOICE_MIN_AUDIO_TOKENS"] = str(model_preset.min_audio_tokens)
        else:
            env.pop("VIBEVOICE_MIN_AUDIO_TOKENS", None)
        return env

    def _run_generation_command(
        self,
        command: Sequence[str],
        *,
        env: dict[str, str],
        cwd: str,
        cancel_event: Event | None,
        progress_callback: Callable[[str, str], None] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        if cancel_event is not None:
            timeout = None
        else:
            timeout = self.timeout_seconds if self.timeout_seconds > 0 else None
        if self._subprocess_run is not subprocess.run:
            try:
                return self._subprocess_run(
                    list(command),
                    env=env,
                    cwd=cwd,
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise VibeVoiceError(f"VibeVoice generation timed out after {_format_number(self.timeout_seconds)}s") from exc

        events: Queue[tuple[str, str | None]] = Queue()
        stdout_chars: list[str] = []
        stderr_chars: list[str] = []
        buffers: dict[str, list[str]] = {"stdout": [], "stderr": []}
        last_label = ""
        progress_state = _VibeVoiceCliProgressState()

        process = subprocess.Popen(
            list(command),
            env=env,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        def read_pipe(name: str, pipe) -> None:
            try:
                while True:
                    char = pipe.read(1)
                    if char == "":
                        break
                    events.put((name, char))
            finally:
                events.put((name, None))

        def emit_progress_line(line: str) -> None:
            nonlocal last_label
            label = _progress_label_from_vibevoice_cli_line(line, state=progress_state)
            if not label or label == last_label:
                return
            last_label = label
            LOGGER.info("VibeVoice CLI progress: %s", label)
            _report_vibevoice_progress(progress_callback, "generation", label)

        def handle_char(name: str, char: str) -> None:
            if name == "stdout":
                stdout_chars.append(char)
            else:
                stderr_chars.append(char)
            if char in {"\n", "\r"}:
                line = "".join(buffers[name]).strip()
                buffers[name].clear()
                if line:
                    emit_progress_line(line)
                return
            buffers[name].append(char)

        reader_threads = []
        if process.stdout is not None:
            reader_threads.append(Thread(target=read_pipe, args=("stdout", process.stdout), daemon=True))
        if process.stderr is not None:
            reader_threads.append(Thread(target=read_pipe, args=("stderr", process.stderr), daemon=True))
        for thread in reader_threads:
            thread.start()

        deadline = perf_counter() + timeout if timeout is not None else None
        open_readers = len(reader_threads)
        try:
            while process.poll() is None or open_readers > 0:
                if cancel_event is not None and cancel_event.is_set():
                    _terminate_process(process)
                    _join_reader_threads(reader_threads)
                    stdout = "".join(stdout_chars)
                    stderr = "".join(stderr_chars)
                    raise VibeVoiceError(
                        "VibeVoice generation was cancelled by the user. "
                        f"{_tail_text(stderr) or _tail_text(stdout)}"
                    )
                if deadline is not None and perf_counter() >= deadline:
                    _terminate_process(process)
                    _join_reader_threads(reader_threads)
                    raise VibeVoiceError(
                        "VibeVoice generation timed out after "
                        f"{_format_number(self.timeout_seconds)}s: {_tail_text(''.join(stderr_chars)) or _tail_text(''.join(stdout_chars))}"
                    )
                try:
                    name, char = events.get(timeout=0.1)
                except Empty:
                    continue
                if char is None:
                    open_readers -= 1
                    continue
                handle_char(name, char)
            _flush_vibevoice_stream_buffers(buffers, emit_progress_line)
            _join_reader_threads(reader_threads)
            stdout = "".join(stdout_chars)
            stderr = "".join(stderr_chars)
            return subprocess.CompletedProcess(list(command), process.returncode or 0, stdout=stdout, stderr=stderr)
        except Exception:
            if process.poll() is None:
                _terminate_process(process)
            raise

    def _prepare_voice_file(self, source_path: Path, temp_root: Path, index: int) -> Path:
        source = Path(source_path)
        if not source.is_file():
            raise FileNotFoundError(f"voice sample was not found: {source}")
        if source.suffix.lower() == ".wav":
            return source
        output = temp_root / f"voice-{index}.wav"
        command = [
            "ffmpeg",
            "-y",
            "-i",
            str(source),
            "-ar",
            str(VIBEVOICE_SAMPLE_RATE),
            "-ac",
            "1",
            "-f",
            "wav",
            str(output),
        ]
        try:
            completed = self._subprocess_run(
                command,
                env=dict(os.environ),
                cwd=str(Path.cwd()),
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
        except FileNotFoundError:
            return source
        if completed.returncode == 0 and output.is_file() and output.stat().st_size > 0:
            return output
        return source

    def _find_model_cache(self, model_preset: VibeVoiceModelPreset) -> Path | None:
        pattern_root = self.vibevoice_home / model_preset.model_cache_dir_name
        if not pattern_root.exists():
            return None
        matches = sorted(path for path in pattern_root.glob("**/*.safetensors") if _is_usable_model_weight(path))
        return matches[0].parent if matches else None

    def _find_tokenizer(self, model_preset: VibeVoiceModelPreset) -> Path | None:
        pattern_root = self.vibevoice_home / model_preset.tokenizer_cache_dir_name
        if not pattern_root.exists():
            return None
        matches = sorted(pattern_root.glob("**/tokenizer.json"))
        return matches[0] if matches else None


class RunpodServerlessVibeVoiceService:
    name = "runpod-serverless-vibevoice"

    def __init__(self, *, client=None) -> None:
        if client is None:
            from .providers.runpod_serverless import RunpodServerlessClient

            client = RunpodServerlessClient.from_env()
        self.client = client

    @classmethod
    def from_env(cls) -> "RunpodServerlessVibeVoiceService":
        return cls()

    def status(self) -> dict[str, object]:
        configured = bool(getattr(self.client, "configured", False))
        return {
            "available": configured,
            "provider": self.name,
            "configured": configured,
            "endpoint_id": getattr(self.client, "endpoint_id", ""),
            "request_mode": getattr(self.client, "request_mode", ""),
            "default_model_id": DEFAULT_VIBEVOICE_MODEL_ID,
            "model_presets": serialize_vibevoice_model_presets(),
            "reason": "" if configured else "RUNPOD_ENDPOINT_ID または RUNPOD_API_KEY が設定されていません。",
        }

    def generate(
        self,
        *,
        script_text: str,
        voice_paths: Sequence[Path | VibeVoiceVoiceSample],
        options: VibeVoiceGenerationOptions | None = None,
        progress_callback: Callable[[str, str], None] | None = None,
        cancel_event: Event | None = None,
    ) -> VibeVoiceResult:
        if cancel_event is not None and cancel_event.is_set():
            raise VibeVoiceError("VibeVoice generation was cancelled before submission.")
        voice_samples = _coerce_voice_samples(voice_paths)
        if not voice_samples:
            raise ValueError("voice sample is required")
        base_options = options or VibeVoiceGenerationOptions()
        normalized_script = normalize_vibevoice_script(script_text)
        generation_options = _options_with_auto_line_by_line(
            normalized_script,
            base_options,
        )
        started = perf_counter()
        _report_vibevoice_progress(progress_callback, "submit", "RunPod送信")
        payload = {
            "operation_mode": "vibevoice",
            "script": normalized_script,
            "voices": [
                {
                    "speaker": sample.slot,
                    "filename": sample.path.name,
                    "audio_mime_type": _audio_mime_type(sample.path),
                    "audio_base64": base64.b64encode(sample.path.read_bytes()).decode("ascii"),
                }
                for sample in voice_samples
            ],
            "generation": _options_payload(generation_options),
        }
        if progress_callback is None:
            output = self.client.submit(payload)
        else:
            output = self.client.submit(
                payload,
                progress_callback=lambda body: _report_runpod_vibevoice_status(progress_callback, body),
            )
        _report_vibevoice_progress(progress_callback, "receive", "RunPod結果受信")
        return _vibevoice_result_from_output(
            output,
            normalized_script=normalized_script,
            fallback_elapsed_ms=_elapsed_ms(started),
        )


def _report_runpod_vibevoice_status(
    progress_callback: Callable[[str, str], None],
    body: dict[str, object],
) -> None:
    status = str(body.get("status") or "").upper()
    progress = body.get("output")
    if status in {"IN_PROGRESS", "RUNNING"} and isinstance(progress, dict):
        stage = str(progress.get("stage") or "processing")
        label = str(progress.get("label") or "RunPodでSkitVoiceを処理しています")
        model = str(progress.get("model") or "").strip()
        model_label = _vibevoice_progress_model_label(model)
        detail = str(progress.get("detail") or "").strip()
        suffix = " · ".join(value for value in (model_label, detail) if value and value not in label)
        _report_vibevoice_progress(progress_callback, stage, f"{label} · {suffix}" if suffix else label)
        return
    if status in {"", "IN_QUEUE", "QUEUED"}:
        _report_vibevoice_progress(progress_callback, "gpu_wait", "利用可能なGPUを待っています")
        return
    if status in {"IN_PROGRESS", "RUNNING"}:
        _report_vibevoice_progress(progress_callback, "initializing", "RunPodワーカーを初期化しています")


def _vibevoice_progress_model_label(model: str) -> str:
    normalized = str(model or "").strip().lower()
    if "vibevoice" in normalized and "large" in normalized:
        return "VibeVoice Large"
    if "vibevoice" in normalized and "1.5b" in normalized:
        return "VibeVoice 1.5B"
    if normalized == "seed-vc" or "plachta/seed-vc" in normalized:
        return "Seed-VC"
    return str(model or "").strip()


def _format_number(value: float) -> str:
    return f"{float(value):g}"


def _repo_cache_dir_name(repo_id: str) -> str:
    return "models--" + str(repo_id).replace("/", "--")


def _is_usable_model_weight(path: Path) -> bool:
    if ".no_exist" in path.parts:
        return False
    try:
        return path.stat().st_size > 0
    except OSError:
        return False


def _terminate_process(process: subprocess.Popen[str]) -> None:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _join_reader_threads(threads: Sequence[Thread]) -> None:
    for thread in threads:
        thread.join(timeout=1)


def _flush_vibevoice_stream_buffers(
    buffers: dict[str, list[str]],
    emit_progress_line: Callable[[str], None],
) -> None:
    for buffer in buffers.values():
        line = "".join(buffer).strip()
        buffer.clear()
        if line:
            emit_progress_line(line)


def _progress_label_from_vibevoice_cli_line(line: str, *, state: _VibeVoiceCliProgressState | None = None) -> str | None:
    normalized = _ANSI_ESCAPE_RE.sub("", line).strip()
    if not normalized:
        return None
    message = _strip_log_prefix(normalized)
    token_limit_match = _VIBEVOICE_TOKEN_LIMIT_RE.search(normalized)
    if token_limit_match:
        return f"生成準備: 上限 {token_limit_match.group('tokens')} token"
    line_mode_match = _VIBEVOICE_LINE_MODE_START_RE.search(message)
    if line_mode_match and state is not None:
        state.line_mode = True
        state.line_total = max(1, int(line_mode_match.group("total")))
        state.current_line = 0
        return _line_by_line_progress_label(state, 0, "")
    line_start_match = _VIBEVOICE_LINE_START_RE.search(message)
    if line_start_match and state is not None:
        state.current_line = max(1, int(line_start_match.group("line")))
        action = line_start_match.group("action")
        if state.line_mode and state.line_total > 0:
            if action == "キャッシュを使用します":
                overall_percent = state.current_line / state.line_total * 100
                return _line_by_line_progress_label(state, overall_percent, "キャッシュ使用")
            overall_percent = (state.current_line - 1) / state.line_total * 100
            return _line_by_line_progress_label(state, overall_percent, "行内準備")
    tqdm_match = _VIBEVOICE_TQDM_RE.search(normalized)
    if tqdm_match:
        current = tqdm_match.group("current")
        total = tqdm_match.group("total")
        percent = tqdm_match.group("percent")
        remaining = (tqdm_match.group("remaining") or "").strip()
        suffix = f", 残り約{remaining}" if remaining else ""
        if state is not None and state.line_mode and state.line_total > 0 and state.current_line > 0:
            line_percent = float(percent)
            overall_percent = ((state.current_line - 1) + (line_percent / 100)) / state.line_total * 100
            return _line_by_line_progress_label(state, overall_percent, f"行内 {current}/{total} {percent}%{suffix}")
        return f"生成中 {current}/{total} ({percent}%{suffix})"
    line_complete_match = _VIBEVOICE_LINE_COMPLETE_RE.search(message)
    if line_complete_match and state is not None:
        state.line_mode = True
        state.line_total = max(1, int(line_complete_match.group("total")))
        state.current_line = state.line_total
        return _line_by_line_progress_label(state, 100, "")
    if "VibeVoiceモデルを読み込み中" in normalized:
        return "モデル読み込み中"
    if "モデルの読み込みが完了" in normalized:
        return "モデル読み込み完了"
    if "スクリプトをパースしました" in normalized:
        return "台本解析完了"
    if "音声サンプルを処理中" in normalized:
        return _strip_log_prefix(normalized)
    if "音声を生成中" in normalized:
        return "VibeVoice生成開始"
    if "行単位モードで音声を生成します" in normalized:
        return "行単位生成開始"
    if re.search(r"行\d+:\s*(新規に音声を生成します|キャッシュを使用します)", normalized):
        return _strip_log_prefix(normalized)
    if "音声を保存しました" in normalized:
        return "音声保存完了"
    return None


def _line_by_line_progress_label(state: _VibeVoiceCliProgressState, overall_percent: float, detail: str) -> str:
    total = max(1, state.line_total)
    current_line = min(max(0, state.current_line), total)
    percent = _format_number(max(0.0, min(100.0, overall_percent)))
    suffix = f", {detail}" if detail else ""
    return f"行単位生成 {current_line}/{total} ({percent}%{suffix})"


def _strip_log_prefix(line: str) -> str:
    return re.sub(r"^\d{4}-\d{2}-\d{2} [^ ]+ - [A-Z]+ - ", "", line)


def _report_vibevoice_progress(
    progress_callback: Callable[[str, str], None] | None,
    stage: str,
    label: str,
) -> None:
    if progress_callback is not None:
        progress_callback(stage, label)


def _raise_if_cancelled(cancel_event: Event | None) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise VibeVoiceError("VibeVoice generation was cancelled by the user.")


def _create_directed_asr_provider():
    provider = os.getenv("MO_VIBEVOICE_DIRECTED_ASR_PROVIDER", "openai").strip().lower() or "openai"
    if provider in {"faster-whisper", "faster_whisper"}:
        from .providers.local import FasterWhisperAsrProvider

        return FasterWhisperAsrProvider()
    if provider == "openai":
        from .providers.openai_api import OpenAiAsrProvider

        return OpenAiAsrProvider(model=os.getenv("MO_VIBEVOICE_DIRECTED_OPENAI_ASR_MODEL", "whisper-1"))
    raise ValueError(f"unsupported VibeVoice directed ASR provider: {provider}")


def _directed_voice_conversion_enabled() -> bool:
    return os.getenv("MO_VIBEVOICE_DIRECTED_VC_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}


def _directed_voice_conversion_backend() -> str:
    return os.getenv("MO_VIBEVOICE_DIRECTED_VC_BACKEND", "seed-vc").strip() or "seed-vc"


def _create_directed_voice_conversion_service():
    from .providers.voice import create_voice_conversion_service_from_env

    return create_voice_conversion_service_from_env()


def _convert_directed_voice(
    voice_conversion_service,
    *,
    source_audio_path: Path,
    reference_audio_path: Path,
    progress_callback: Callable[[str, str], None] | None = None,
):
    from .pipeline import PipelineProgress
    from .providers.voice import SeedVcRuntimeSettings, VoiceConversionRequest

    def report_voice_conversion(progress: PipelineProgress) -> None:
        if progress_callback is None:
            return
        if progress.stage == "loading_model":
            progress_callback("loading_model", "Seed-VCモデルを読み込んでいます")
            return
        progress_callback(progress.stage, progress.label)

    return voice_conversion_service.convert(
        VoiceConversionRequest(
            source_audio_path=source_audio_path,
            reference_audio_path=reference_audio_path,
            backend_id=_directed_voice_conversion_backend(),
            seed_vc_settings=SeedVcRuntimeSettings(),
        ),
        progress_callback=report_voice_conversion if progress_callback is not None else None,
    )


def _directed_voice_conversion_settings_diagnostics(voice_conversion_service) -> dict[str, object]:
    settings: dict[str, object] = {"backend_id": _directed_voice_conversion_backend()}
    for name in (
        "diffusion_steps",
        "length_adjust",
        "inference_cfg_rate",
        "reference_max_seconds",
        "reference_auto_select",
    ):
        value = getattr(voice_conversion_service, name, None)
        if value is not None:
            settings[name] = value
    return settings


def _directed_asr_language() -> str:
    return os.getenv("MO_VIBEVOICE_DIRECTED_ASR_LANGUAGE", "auto").strip() or "auto"


def _directed_lines_by_speaker(lines: Sequence[VibeVoiceDirectedLine]) -> dict[int, list[VibeVoiceDirectedLine]]:
    grouped: dict[int, list[VibeVoiceDirectedLine]] = {}
    for line in lines:
        grouped.setdefault(line.speaker, []).append(line)
    return dict(sorted(grouped.items(), key=lambda item: min(line.index for line in item[1])))


def _directed_line_chunks_for_speaker(
    lines: Sequence[VibeVoiceDirectedLine],
    *,
    target_max_chars: int = DIRECTED_TARGET_MAX_CHARS,
    line_max_chars: int = DIRECTED_LINE_MAX_CHARS,
) -> list[_DirectedLineChunk]:
    if not lines:
        return []
    speaker = lines[0].speaker
    for line in lines:
        line_script = _directed_speaker_script_for_lines([line], include_tail_guard=False)
        if len(line_script.target_text) > line_max_chars:
            raise ValueError(
                f"Speaker {line.speaker} Line {line.index} の台詞が長すぎます "
                f"({len(line_script.target_text)} chars)。{line_max_chars}文字以内に分けてください。"
            )
    total_chars = _directed_target_chars(lines)
    chunk_count = max(1, math.ceil(total_chars / target_max_chars))
    chunk_count = min(chunk_count, len(lines))
    while chunk_count < len(lines):
        partition = _best_directed_line_partition(lines, chunk_count)
        if max(_directed_target_chars(part) for part in partition) <= target_max_chars:
            break
        chunk_count += 1
    partition = _best_directed_line_partition(lines, chunk_count)
    return [
        _DirectedLineChunk(
            speaker=speaker,
            chunk_index=index,
            lines=tuple(part),
        )
        for index, part in enumerate(partition, start=1)
    ]


def _best_directed_line_partition(
    lines: Sequence[VibeVoiceDirectedLine],
    chunk_count: int,
) -> list[list[VibeVoiceDirectedLine]]:
    if chunk_count <= 1 or len(lines) <= 1:
        return [list(lines)]
    count = min(chunk_count, len(lines))
    average = _directed_target_chars(lines) / count
    length_cache: dict[tuple[int, int], int] = {}
    memo: dict[tuple[int, int], tuple[float, float, list[tuple[int, int]]]] = {}

    def part_length(start: int, end: int) -> int:
        key = (start, end)
        if key not in length_cache:
            length_cache[key] = _directed_target_chars(lines[start:end])
        return length_cache[key]

    def best(start: int, remaining: int) -> tuple[float, float, list[tuple[int, int]]]:
        key = (start, remaining)
        if key in memo:
            return memo[key]
        if remaining == 1:
            length = part_length(start, len(lines))
            result = (float(length), abs(length - average), [(start, len(lines))])
            memo[key] = result
            return result
        best_result: tuple[float, float, list[tuple[int, int]]] | None = None
        last_end = len(lines) - remaining + 1
        for end in range(start + 1, last_end + 1):
            length = part_length(start, end)
            rest_max, rest_imbalance, rest_parts = best(end, remaining - 1)
            result = (
                max(float(length), rest_max),
                abs(length - average) + rest_imbalance,
                [(start, end), *rest_parts],
            )
            if best_result is None or result[:2] < best_result[:2]:
                best_result = result
        if best_result is None:
            best_result = best(start, 1)
        memo[key] = best_result
        return best_result

    return [list(lines[start:end]) for start, end in best(0, count)[2]]


def _directed_target_chars(lines: Sequence[VibeVoiceDirectedLine]) -> int:
    if not lines:
        return 0
    return len(_directed_speaker_script_for_lines(lines, include_tail_guard=False).target_text)


def _directed_guard_lines_for_chunk(
    chunk: _DirectedLineChunk,
    chunks_for_speaker: Sequence[_DirectedLineChunk],
) -> list[VibeVoiceDirectedLine]:
    following = [candidate for candidate in chunks_for_speaker if candidate.chunk_index > chunk.chunk_index]
    leading = [candidate for candidate in chunks_for_speaker if candidate.chunk_index < chunk.chunk_index]
    return [
        line
        for candidate in [*following, *leading]
        for line in candidate.lines
    ]


def _directed_retry_script_for_line(
    line: VibeVoiceDirectedLine,
    speaker_lines: Sequence[VibeVoiceDirectedLine],
) -> _DirectedSpeakerScript:
    target_script = _directed_speaker_script_for_lines([line], include_tail_guard=False)
    following = [candidate for candidate in speaker_lines if candidate.index > line.index]
    leading = [candidate for candidate in speaker_lines if candidate.index < line.index]
    guard_lines = [*following, *leading] or [line]
    guard_script = _directed_speaker_script_for_lines(guard_lines, include_tail_guard=False)
    tail_guard_text = _directed_rotated_guard_text(
        target_script.target_text,
        guard_script.target_text,
        target_min_chars=DIRECTED_TARGET_MIN_CHARS,
        full_max_chars=DIRECTED_FULL_MAX_CHARS,
    )
    return _DirectedSpeakerScript(
        full_text=f"{target_script.target_text}{tail_guard_text}",
        target_text=target_script.target_text,
        tail_guard_text=tail_guard_text,
    )


def _directed_low_score_retry_lines(
    lines: Sequence[VibeVoiceDirectedLine],
    ranges_by_line: dict[int, VibeVoiceAudioRange],
    *,
    score_threshold: float,
    max_lines: int,
) -> list[VibeVoiceDirectedLine]:
    if max_lines <= 0:
        return []
    low_score_lines = [
        line
        for line in lines
        if ranges_by_line[line.index].candidate_score < score_threshold
    ]
    low_score_lines.sort(key=lambda line: (ranges_by_line[line.index].candidate_score, line.index))
    return low_score_lines[:max_lines]


def _directed_retry_chunk_index(line: VibeVoiceDirectedLine) -> int:
    return DIRECTED_RETRY_CHUNK_INDEX_OFFSET + line.index


def _directed_chunk_key(chunk: _DirectedLineChunk, chunks_by_speaker: dict[int, list[_DirectedLineChunk]]) -> str:
    return str(chunk.speaker) if len(chunks_by_speaker.get(chunk.speaker, [])) == 1 else f"{chunk.speaker}-{chunk.chunk_index}"


def _directed_chunk_label(chunk: _DirectedLineChunk, chunks_by_speaker: dict[int, list[_DirectedLineChunk]]) -> str:
    if len(chunks_by_speaker.get(chunk.speaker, [])) == 1:
        return f"Speaker {chunk.speaker}"
    return f"Speaker {chunk.speaker} chunk {chunk.chunk_index}"


def _directed_chunk_audio_stem(chunk: _DirectedLineChunk, chunks_by_speaker: dict[int, list[_DirectedLineChunk]]) -> str:
    if len(chunks_by_speaker.get(chunk.speaker, [])) == 1:
        return f"speaker-{chunk.speaker}"
    return f"speaker-{chunk.speaker}-chunk-{chunk.chunk_index}"


def _transcribe_directed_audio(asr_provider, audio_path: Path):
    transcribe_detail = getattr(asr_provider, "transcribe_detail", None)
    if transcribe_detail is None:
        raise ValueError("指定台詞モードにはtimestamp対応ASRが必要です。")
    result = transcribe_detail(audio_path, _directed_asr_language(), include_timestamps=True)
    if not getattr(result, "has_timestamps", False):
        raise ValueError("指定台詞モードのASRがtimestampを返しませんでした。")
    return result


def _timestamp_rows(rows: object) -> list[dict[str, object]]:
    normalized: list[dict[str, object]] = []
    for row in rows or []:
        if isinstance(row, dict):
            text = row.get("text") or row.get("word") or ""
            start = row.get("start")
            end = row.get("end")
        else:
            text = getattr(row, "text", None) or getattr(row, "word", "") or ""
            start = getattr(row, "start", None)
            end = getattr(row, "end", None)
        try:
            start_f = float(start)
            end_f = float(end)
        except (TypeError, ValueError):
            continue
        if end_f <= start_f:
            continue
        normalized.append({"text": str(text or ""), "start": max(0.0, start_f), "end": max(0.0, end_f)})
    return normalized


def _timestamp_text(rows: Sequence[dict[str, object]]) -> str:
    return "".join(str(row.get("text", "")) for row in rows)


def _directed_target_prefix_words(
    lines: Sequence[VibeVoiceDirectedLine],
    words: Sequence[dict[str, object]],
) -> list[dict[str, object]]:
    if not words:
        return []
    normalized_target = "".join(_alignment_text(line.text) for line in lines)
    if not normalized_target:
        return list(words)

    normalized_word_items: list[tuple[int, str]] = []
    for index, word in enumerate(words):
        normalized = _alignment_text(str(word.get("text", "")))
        if normalized:
            normalized_word_items.append((index, normalized))
    if not normalized_word_items:
        return list(words)

    target_length = len(normalized_target)
    prefix_text = ""
    best_end_index = normalized_word_items[-1][0] + 1
    best_score: tuple[int, int, int, int] | None = None
    for source_index, normalized_word in normalized_word_items:
        prefix_text += normalized_word
        matcher = SequenceMatcher(None, normalized_target, prefix_text, autojunk=False)
        matched_length = sum(block.size for block in matcher.get_matching_blocks())
        if matched_length <= 0:
            continue
        missing_target_chars = max(0, target_length - matched_length)
        extra_asr_chars = max(0, len(prefix_text) - matched_length)
        # The generated chunk is target-first and guard-later. Prefer missing a
        # tail fragment over swallowing unrelated guard words into the target.
        score = (missing_target_chars + extra_asr_chars * 2, extra_asr_chars, missing_target_chars, source_index)
        if best_score is None or score < best_score:
            best_score = score
            best_end_index = source_index + 1
    return list(words[:best_end_index])


def _directed_asr_text_diagnostics(
    lines: Sequence[VibeVoiceDirectedLine],
    *,
    words: Sequence[dict[str, object]],
    segments: Sequence[dict[str, object]],
) -> dict[str, object]:
    target_text = _directed_speaker_script_for_lines(lines, include_tail_guard=False).target_text
    if words:
        target_words = _directed_target_prefix_words(lines, words)
        ignored_tail_words = list(words[len(target_words) :])
        return {
            "target_text": target_text,
            "full_text": _timestamp_text(words),
            "target_prefix_text": _timestamp_text(target_words),
            "ignored_tail_text": _timestamp_text(ignored_tail_words),
            "word_count": len(words),
            "target_prefix_word_count": len(target_words),
            "ignored_tail_word_count": len(ignored_tail_words),
            "source": "words",
        }
    return {
        "target_text": target_text,
        "full_text": _timestamp_text(segments),
        "target_prefix_text": _timestamp_text(segments),
        "ignored_tail_text": "",
        "word_count": 0,
        "target_prefix_word_count": 0,
        "ignored_tail_word_count": 0,
        "source": "segments",
    }


def _audio_range_candidates_for_directed_chunk(
    *,
    target_lines: Sequence[VibeVoiceDirectedLine],
    guard_lines: Sequence[VibeVoiceDirectedLine],
    transcription,
    audio_path: Path,
    chunk_index: int = 1,
    target_role: str = "target",
    guard_role: str = "guard",
) -> tuple[list[VibeVoiceAudioRange], list[str], dict[str, object]]:
    lines = [*target_lines, *guard_lines]
    roles = [target_role for _ in target_lines] + [guard_role for _ in guard_lines]
    if not lines:
        return [], [], {}

    duration = _wav_duration(audio_path)
    warnings: list[str] = []
    words = _timestamp_rows(getattr(transcription, "words", []))
    segments = _timestamp_rows(getattr(transcription, "segments", []))
    asr_text_diagnostics = _directed_asr_text_diagnostics(target_lines, words=words, segments=segments)
    if words:
        ranges = _audio_ranges_from_words(lines, words, duration=duration, chunk_index=chunk_index)
        scored_ranges = [
            _score_directed_candidate_range(
                audio_range,
                role=role,
                role_position=position,
                audio_path=audio_path,
            )
            for position, (audio_range, role) in enumerate(zip(ranges, roles, strict=True))
        ]
        if len(words) < len(target_lines):
            warnings.append("ASR word数が台詞行数より少ないため、範囲推定が粗くなる可能性があります。")
        ignored_tail_word_count = int(asr_text_diagnostics.get("ignored_tail_word_count", 0) or 0)
        if ignored_tail_word_count > 0:
            warnings.append(
                f"ASR word末尾 {ignored_tail_word_count} 件をtarget外候補として扱いました。"
            )
        return scored_ranges, warnings, asr_text_diagnostics
    if segments:
        target_ranges, range_warnings, asr_text_diagnostics = _audio_ranges_for_directed_lines(
            target_lines,
            transcription,
            audio_path,
            chunk_index=chunk_index,
        )
        return [
            _score_directed_candidate_range(
                audio_range,
                role=target_role,
                role_position=position,
                audio_path=audio_path,
            )
            for position, audio_range in enumerate(target_ranges)
        ], range_warnings, asr_text_diagnostics
    raise ValueError("指定台詞モードのASR timestampが空でした。")


def _score_directed_candidate_range(
    audio_range: VibeVoiceAudioRange,
    *,
    role: str,
    role_position: int,
    audio_path: Path,
) -> VibeVoiceAudioRange:
    target_text = _alignment_text(audio_range.text)
    matched_text = _alignment_text(audio_range.matched_text)
    if target_text and matched_text:
        matcher = SequenceMatcher(None, target_text, matched_text, autojunk=False)
        matching_chars = sum(block.size for block in matcher.get_matching_blocks())
        coverage = matching_chars / len(target_text)
        extra_ratio = max(0, len(matched_text) - matching_chars) / len(target_text)
        missing_ratio = max(0, len(target_text) - matching_chars) / len(target_text)
        text_score = coverage - extra_ratio * 0.5 - missing_ratio * 0.7
    else:
        coverage = 0.0
        extra_ratio = 1.0
        missing_ratio = 1.0
        text_score = -1.0

    metrics = _directed_audio_range_metrics(audio_path, start=audio_range.start, end=audio_range.end)
    audio_penalty = 0.0
    reasons = [
        f"coverage={coverage:.3f}",
        f"extra={extra_ratio:.3f}",
        f"missing={missing_ratio:.3f}",
    ]
    duration = max(0.0, audio_range.end - audio_range.start)
    if duration < 0.05:
        audio_penalty += 0.2
        reasons.append("too_short")
    expected_min_duration = _directed_min_duration_for_text(target_text)
    if expected_min_duration > 0 and duration < expected_min_duration:
        short_ratio = (expected_min_duration - duration) / expected_min_duration
        audio_penalty += min(0.3, short_ratio * 0.3)
        reasons.append(f"duration_short_for_text={duration:.2f}/{expected_min_duration:.2f}")
    rms = float(metrics.get("rms", 0.0) or 0.0)
    peak = float(metrics.get("peak", 0.0) or 0.0)
    clip_ratio = float(metrics.get("clip_ratio", 0.0) or 0.0)
    if rms < 0.003:
        audio_penalty += 0.15
        reasons.append("low_rms")
    if peak > 0.98 or clip_ratio > 0.01:
        audio_penalty += 0.12
        reasons.append("peak_clip")
    role_penalty = {
        "target": 0.0,
        "retry_target": 0.0,
        "guard": 0.03,
        "retry_guard": 0.03,
    }.get(role, 0.03)
    position_penalty = max(0, role_position) * 0.002
    score = text_score - audio_penalty - role_penalty - position_penalty
    reasons.append(f"rms={rms:.4f}")
    reasons.append(f"peak={peak:.4f}")
    reasons.append(f"role={role}")
    return replace(
        audio_range,
        candidate_role=role,
        candidate_score=round(score, 6),
        candidate_reasons=tuple(reasons),
    )


def _directed_min_duration_for_text(normalized_text: str) -> float:
    char_count = len(str(normalized_text or ""))
    if char_count < 6:
        return 0.0
    return min(4.0, max(0.5, char_count * 0.06))


def _directed_audio_range_metrics(audio_path: Path, *, start: float, end: float) -> dict[str, float]:
    try:
        params = _wav_params(audio_path)
        if params["sample_width"] != 2:
            return {}
        frames = _read_wav_frames(audio_path, start=start, end=end)
    except Exception:
        return {}
    if not frames:
        return {"rms": 0.0, "peak": 0.0, "clip_ratio": 0.0}
    samples = array("h")
    samples.frombytes(frames)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        return {"rms": 0.0, "peak": 0.0, "clip_ratio": 0.0}
    squared = 0.0
    peak = 0
    clipped = 0
    for sample in samples:
        absolute = abs(int(sample))
        peak = max(peak, absolute)
        squared += absolute * absolute
        if absolute >= 32760:
            clipped += 1
    count = len(samples)
    return {
        "rms": math.sqrt(squared / count) / 32768.0,
        "peak": peak / 32768.0,
        "clip_ratio": clipped / count,
    }


def _select_best_directed_range_candidates(
    lines: Sequence[VibeVoiceDirectedLine],
    candidates_by_line: dict[int, list[VibeVoiceAudioRange]],
) -> tuple[dict[int, VibeVoiceAudioRange], list[str]]:
    selected: dict[int, VibeVoiceAudioRange] = {}
    warnings: list[str] = []
    for line in lines:
        candidates = candidates_by_line.get(line.index, [])
        if not candidates:
            raise ValueError(f"Line {line.index} のASR候補が見つかりませんでした。")
        best = max(
            candidates,
            key=lambda item: (
                item.candidate_score,
                _directed_candidate_role_priority(item.candidate_role),
                -item.chunk_index,
                -(item.end - item.start),
            ),
        )
        selected[line.index] = best
        if best.candidate_role == "guard":
            warnings.append(
                f"Line {line.index}: target候補よりguard候補のASRスコアが高いため、"
                f"Speaker {best.speaker} chunk {best.chunk_index} のguard区間を採用しました。"
            )
        elif best.candidate_role == "retry_target":
            warnings.append(
                f"Line {line.index}: 初回候補のASRスコアが低いため、"
                f"低スコア再生成候補を採用しました。"
            )
        elif best.candidate_role != "target":
            warnings.append(
                f"Line {line.index}: target候補ではなく {best.candidate_role} 候補を採用しました。"
            )
    return selected, warnings


def _directed_candidate_role_priority(role: str) -> int:
    return {
        "target": 3,
        "retry_target": 2,
        "guard": 1,
        "retry_guard": 0,
    }.get(role, 0)


def _directed_range_candidate_diagnostics(
    candidates_by_line: dict[int, list[VibeVoiceAudioRange]],
    *,
    selected_by_line: dict[int, VibeVoiceAudioRange],
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for line_index, candidates in sorted(candidates_by_line.items()):
        selected = selected_by_line.get(line_index)
        for candidate in sorted(candidates, key=lambda item: (item.chunk_index, item.candidate_role, item.start)):
            rows.append(
                {
                    "line_index": candidate.line_index,
                    "speaker": candidate.speaker,
                    "chunk_index": candidate.chunk_index,
                    "candidate_role": candidate.candidate_role,
                    "candidate_score": candidate.candidate_score,
                    "candidate_reasons": list(candidate.candidate_reasons),
                    "selected": candidate == selected,
                    "text": candidate.text,
                    "matched_text": candidate.matched_text,
                    "start": candidate.start,
                    "end": candidate.end,
                }
            )
    return rows


def _audio_ranges_for_directed_lines(
    lines: Sequence[VibeVoiceDirectedLine],
    transcription,
    audio_path: Path,
    *,
    chunk_index: int = 1,
) -> tuple[list[VibeVoiceAudioRange], list[str], dict[str, object]]:
    duration = _wav_duration(audio_path)
    warnings: list[str] = []
    words = _timestamp_rows(getattr(transcription, "words", []))
    segments = _timestamp_rows(getattr(transcription, "segments", []))
    asr_text_diagnostics = _directed_asr_text_diagnostics(lines, words=words, segments=segments)
    if words:
        target_words = _directed_target_prefix_words(lines, words)
        ranges = _audio_ranges_from_words(lines, target_words, duration=duration, chunk_index=chunk_index)
        if len(words) < len(lines):
            warnings.append("ASR word数が台詞行数より少ないため、範囲推定が粗くなる可能性があります。")
        ignored_tail_word_count = int(asr_text_diagnostics.get("ignored_tail_word_count", 0) or 0)
        if ignored_tail_word_count > 0:
            warnings.append(
                f"ASR word末尾 {ignored_tail_word_count} 件をガード部分として最終再構成から除外しました。"
            )
        return ranges, warnings, asr_text_diagnostics
    if segments:
        if len(segments) == len(lines):
            return [
                VibeVoiceAudioRange(
                    speaker=line.speaker,
                    line_index=line.index,
                    text=line.text,
                    start=max(0.0, min(float(segment["start"]), duration)),
                    end=max(0.0, min(float(segment["end"]), duration)),
                    chunk_index=chunk_index,
                )
                for line, segment in zip(lines, segments, strict=True)
            ], warnings, asr_text_diagnostics
        warnings.append("ASR segment数と台詞行数が一致しないため、文字数比で範囲を推定しました。")
        return (
            _audio_ranges_by_target_text_ratio(lines, rows=segments, duration=duration, chunk_index=chunk_index),
            warnings,
            asr_text_diagnostics,
        )
    raise ValueError("指定台詞モードのASR timestampが空でした。")


def _audio_ranges_from_words(
    lines: Sequence[VibeVoiceDirectedLine],
    words: Sequence[dict[str, object]],
    *,
    duration: float,
    chunk_index: int = 1,
) -> list[VibeVoiceAudioRange]:
    if not words:
        return _audio_ranges_by_target_text_ratio(lines, rows=[], duration=duration, chunk_index=chunk_index)
    words = _directed_target_prefix_words(lines, words)
    normalized_words: list[str] = []
    source_word_indices: list[int] = []
    for index, word in enumerate(words):
        normalized = _alignment_text(str(word.get("text", "")))
        if not normalized:
            continue
        normalized_words.append(normalized)
        source_word_indices.append(index)
    target_texts = [_alignment_text(line.text) for line in lines]
    target_joined = "".join(target_texts)
    asr_joined = "".join(normalized_words)
    if not target_joined or not asr_joined:
        return _audio_ranges_by_target_text_ratio(lines, rows=words, duration=duration, chunk_index=chunk_index)

    asr_spans = _word_text_spans(normalized_words)
    target_boundaries = _target_text_boundaries(target_texts)
    asr_boundaries = [
        _map_target_offset_to_asr_offset(target_joined, asr_joined, boundary)
        for boundary in target_boundaries
    ]
    asr_boundaries = _monotonic_offsets(asr_boundaries, maximum=len(asr_joined))

    ranges: list[VibeVoiceAudioRange] = []
    for index, line in enumerate(lines):
        start_offset = asr_boundaries[index]
        end_offset = asr_boundaries[index + 1]
        start_word_index = _word_index_for_range_start(asr_spans, start_offset)
        end_word_index = max(start_word_index, _word_index_for_range_end(asr_spans, end_offset))
        source_start_index = source_word_indices[start_word_index]
        source_end_index = source_word_indices[end_word_index]
        start = float(words[source_start_index]["start"])
        end = float(words[source_end_index]["end"])
        if end <= start:
            end = min(duration, start + 0.05)
        ranges.append(
            VibeVoiceAudioRange(
                speaker=line.speaker,
                line_index=line.index,
                text=line.text,
                start=max(0.0, min(start, duration)),
                end=max(0.0, min(end, duration)),
                matched_text="".join(str(word.get("text", "")) for word in words[source_start_index : source_end_index + 1]),
                chunk_index=chunk_index,
            )
        )
    return ranges


def _target_text_boundaries(texts: Sequence[str]) -> list[int]:
    boundaries = [0]
    cursor = 0
    for text in texts:
        cursor += len(text)
        boundaries.append(cursor)
    return boundaries


def _word_text_spans(texts: Sequence[str]) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    cursor = 0
    for text in texts:
        start = cursor
        cursor += len(text)
        spans.append((start, cursor))
    return spans


def _map_target_offset_to_asr_offset(target_text: str, asr_text: str, target_offset: int) -> int:
    if target_offset <= 0:
        return 0
    if target_offset > len(target_text):
        return len(asr_text)
    matcher = SequenceMatcher(None, target_text, asr_text, autojunk=False)
    previous_asr_end = 0
    for _tag, target_start, target_end, asr_start, asr_end in matcher.get_opcodes():
        if target_offset < target_start:
            return previous_asr_end
        if target_start <= target_offset <= target_end:
            if target_end <= target_start:
                return asr_end
            ratio = (target_offset - target_start) / (target_end - target_start)
            return int(round(asr_start + ratio * (asr_end - asr_start)))
        previous_asr_end = asr_end
    return len(asr_text)


def _monotonic_offsets(offsets: Sequence[int], *, maximum: int) -> list[int]:
    monotonic: list[int] = []
    previous = 0
    for index, offset in enumerate(offsets):
        if index == 0:
            value = 0
        else:
            value = max(previous, min(int(offset), maximum))
        monotonic.append(value)
        previous = value
    return monotonic


def _word_index_for_range_start(spans: Sequence[tuple[int, int]], offset: int) -> int:
    for index, (_start, end) in enumerate(spans):
        if end > offset:
            return index
    return max(0, len(spans) - 1)


def _word_index_for_range_end(spans: Sequence[tuple[int, int]], offset: int) -> int:
    if offset <= 0:
        return 0
    for index, (_start, end) in enumerate(spans):
        if offset <= end:
            return index
    return max(0, len(spans) - 1)


def _audio_ranges_by_target_text_ratio(
    lines: Sequence[VibeVoiceDirectedLine],
    *,
    rows: Sequence[dict[str, object]],
    duration: float,
    chunk_index: int = 1,
) -> list[VibeVoiceAudioRange]:
    if rows:
        start_time = max(0.0, min(float(rows[0]["start"]), duration))
        end_time = max(start_time, min(float(rows[-1]["end"]), duration))
    else:
        start_time = 0.0
        end_time = duration
    target_lengths = [max(1, len(_alignment_text(line.text))) for line in lines]
    total = max(1, sum(target_lengths))
    cursor = start_time
    consumed = 0
    ranges: list[VibeVoiceAudioRange] = []
    for index, (line, length) in enumerate(zip(lines, target_lengths, strict=True)):
        consumed += length
        end = end_time if index == len(lines) - 1 else start_time + (end_time - start_time) * (consumed / total)
        ranges.append(
            VibeVoiceAudioRange(
                speaker=line.speaker,
                line_index=line.index,
                text=line.text,
                start=max(0.0, min(cursor, duration)),
                end=max(0.0, min(end, duration)),
                chunk_index=chunk_index,
            )
        )
        cursor = end
    return ranges


def _alignment_text(text: str) -> str:
    return re.sub(r"[\s、。，，,.!?！？…~〜:：;；\"'“”‘’（）()\[\]【】《》<>-]+", "", str(text or "").lower())


def _compose_directed_wav(
    lines: Sequence[VibeVoiceDirectedLine],
    *,
    ranges_by_line: dict[int, VibeVoiceAudioRange],
    speaker_outputs: dict[object, Path],
    output_path: Path,
    gap_seconds: float,
) -> None:
    if not lines:
        raise ValueError("script is required")
    first_range = ranges_by_line[lines[0].index]
    params = _wav_params(_directed_output_path_for_range(speaker_outputs, first_range))
    frames: list[bytes] = []
    for index, line in enumerate(lines):
        audio_range = ranges_by_line[line.index]
        source_path = _directed_output_path_for_range(speaker_outputs, audio_range)
        if _wav_params(source_path) != params:
            raise VibeVoiceError("指定台詞モードの話者別WAV形式が一致しません。")
        segment_frames = _read_wav_frames(source_path, start=audio_range.start, end=audio_range.end)
        frames.append(_normalize_directed_wav_frames(segment_frames, params=params))
        if index < len(lines) - 1 and gap_seconds > 0:
            frames.append(_silence_frames(params=params, seconds=gap_seconds))
    with wave.open(str(output_path), "wb") as output:
        output.setnchannels(params["channels"])
        output.setsampwidth(params["sample_width"])
        output.setframerate(params["frame_rate"])
        output.writeframes(b"".join(frames))


def _directed_output_path_for_range(speaker_outputs: dict[object, Path], audio_range: VibeVoiceAudioRange) -> Path:
    if audio_range.line_index in speaker_outputs:
        return speaker_outputs[audio_range.line_index]
    chunk_key = (audio_range.speaker, audio_range.chunk_index)
    if chunk_key in speaker_outputs:
        return speaker_outputs[chunk_key]
    return speaker_outputs[audio_range.speaker]


def _directed_audio_artifacts(
    *,
    lines: Sequence[VibeVoiceDirectedLine],
    chunks: Sequence[_DirectedLineChunk],
    chunks_by_speaker: dict[int, list[_DirectedLineChunk]],
    speaker_vibevoice_outputs: dict[tuple[int, int], Path],
    speaker_outputs: dict[tuple[int, int], Path],
    speaker_scripts: dict[str, str],
    ranges_by_line: dict[int, VibeVoiceAudioRange],
    include_voice_conversion: bool,
) -> list[dict[str, object]]:
    artifacts: list[dict[str, object]] = []
    for chunk in chunks:
        key = (chunk.speaker, chunk.chunk_index)
        path = speaker_vibevoice_outputs[key]
        chunk_key = _directed_chunk_key(chunk, chunks_by_speaker)
        chunk_label = _directed_chunk_label(chunk, chunks_by_speaker)
        artifacts.append(
            _audio_artifact_from_bytes(
                path.read_bytes(),
                kind="speaker_vibevoice",
                label=f"{chunk_label} VibeVoice",
                speaker=chunk.speaker,
                chunk_index=chunk.chunk_index,
                text=speaker_scripts.get(chunk_key, ""),
                line_indices=[line.index for line in chunk.lines],
                duration_seconds=_wav_duration(path),
            )
        )
    if include_voice_conversion:
        for chunk in chunks:
            key = (chunk.speaker, chunk.chunk_index)
            path = speaker_outputs[key]
            chunk_key = _directed_chunk_key(chunk, chunks_by_speaker)
            chunk_label = _directed_chunk_label(chunk, chunks_by_speaker)
            artifacts.append(
                _audio_artifact_from_bytes(
                    path.read_bytes(),
                    kind="speaker_voice_conversion",
                    label=f"{chunk_label} Seed-VC",
                    speaker=chunk.speaker,
                    chunk_index=chunk.chunk_index,
                    text=speaker_scripts.get(chunk_key, ""),
                    line_indices=[line.index for line in chunk.lines],
                    duration_seconds=_wav_duration(path),
                )
            )
    for line in lines:
        audio_range = ranges_by_line[line.index]
        segment_bytes = _wav_bytes_for_range(
            _directed_output_path_for_range(speaker_outputs, audio_range),
            start=audio_range.start,
            end=audio_range.end,
        )
        artifacts.append(
            _audio_artifact_from_bytes(
                segment_bytes,
                kind="line_segment",
                label=f"Line {line.index} / Speaker {line.speaker}",
                speaker=line.speaker,
                chunk_index=audio_range.chunk_index,
                line_index=line.index,
                text=line.text,
                matched_text=audio_range.matched_text,
                start=audio_range.start,
                end=audio_range.end,
                duration_seconds=max(0.0, audio_range.end - audio_range.start),
            )
        )
    return artifacts


def _audio_artifact_from_bytes(audio_bytes: bytes, **metadata: object) -> dict[str, object]:
    return {
        **metadata,
        "audio_mime_type": "audio/wav",
        "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
        "size_bytes": len(audio_bytes),
    }


def _wav_bytes_for_range(path: Path, *, start: float, end: float) -> bytes:
    params = _wav_params(path)
    frames = _read_wav_frames(path, start=start, end=end)
    frames = _normalize_directed_wav_frames(frames, params=params)
    buffer = BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(params["channels"])
        output.setsampwidth(params["sample_width"])
        output.setframerate(params["frame_rate"])
        output.writeframes(frames)
    return buffer.getvalue()


def _write_wav_range(
    path: Path,
    *,
    start: float,
    end: float,
    output_path: Path,
    normalize: bool,
) -> None:
    params = _wav_params(path)
    frames = _read_wav_frames(path, start=start, end=end)
    if normalize:
        frames = _normalize_directed_wav_frames(frames, params=params)
    with wave.open(str(output_path), "wb") as output:
        output.setnchannels(params["channels"])
        output.setsampwidth(params["sample_width"])
        output.setframerate(params["frame_rate"])
        output.writeframes(frames)


def _wav_params(path: Path) -> dict[str, int]:
    with wave.open(str(path), "rb") as wav:
        return {
            "channels": wav.getnchannels(),
            "sample_width": wav.getsampwidth(),
            "frame_rate": wav.getframerate(),
        }


def _read_wav_frames(path: Path, *, start: float, end: float) -> bytes:
    with wave.open(str(path), "rb") as wav:
        frame_rate = wav.getframerate()
        frame_width = wav.getnchannels() * wav.getsampwidth()
        start_frame = max(0, min(wav.getnframes(), int(start * frame_rate)))
        end_frame = max(start_frame, min(wav.getnframes(), int(end * frame_rate)))
        wav.setpos(start_frame)
        data = wav.readframes(end_frame - start_frame)
        if data:
            return data
        return b"\x00" * frame_width


def _normalize_directed_wav_frames(frames: bytes, *, params: dict[str, int]) -> bytes:
    if not frames or params.get("sample_width") != 2:
        return frames
    if len(frames) % 2 != 0:
        return frames
    samples = array("h")
    samples.frombytes(frames)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        return frames

    mean = sum(samples) / len(samples)
    squared_sum = 0.0
    peak = 0.0
    for sample in samples:
        centered = float(sample) - mean
        squared_sum += centered * centered
        peak = max(peak, abs(centered))
    rms = math.sqrt(squared_sum / len(samples)) / 32768.0
    if rms < DIRECTED_OUTPUT_MIN_RMS or peak <= 0.0:
        return frames

    peak_ratio = peak / 32768.0
    gain = min(
        DIRECTED_OUTPUT_TARGET_RMS / rms,
        DIRECTED_OUTPUT_PEAK_LIMIT / peak_ratio,
        DIRECTED_OUTPUT_MAX_GAIN,
    )
    normalized = array("h")
    for sample in samples:
        value = int(round((float(sample) - mean) * gain))
        normalized.append(max(-32768, min(32767, value)))
    if sys.byteorder != "little":
        normalized.byteswap()
    return normalized.tobytes()


def _silence_frames(*, params: dict[str, int], seconds: float) -> bytes:
    frame_count = max(0, int(seconds * params["frame_rate"]))
    frame_width = params["channels"] * params["sample_width"]
    return b"\x00" * frame_count * frame_width


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wav:
        frame_rate = wav.getframerate()
        if frame_rate <= 0:
            return 0.0
        return wav.getnframes() / frame_rate


def _voice_sample_diagnostics(voice_samples: Sequence[VibeVoiceVoiceSample]) -> list[dict[str, object]]:
    items: list[dict[str, object]] = []
    for sample in voice_samples:
        try:
            size = sample.path.stat().st_size
        except OSError:
            size = 0
        items.append(
            {
                "slot": sample.slot,
                "filename": sample.path.name,
                "path": str(sample.path),
                "size": size,
            }
        )
    return items


def _coerce_voice_samples(voice_paths: Sequence[Path | VibeVoiceVoiceSample]) -> list[VibeVoiceVoiceSample]:
    samples: list[VibeVoiceVoiceSample] = []
    seen_slots: set[int] = set()
    for index, item in enumerate(voice_paths, start=1):
        if isinstance(item, VibeVoiceVoiceSample):
            sample = item
        else:
            sample = VibeVoiceVoiceSample(slot=index, path=Path(item))
        if sample.slot < SHORT_SPEAKER_TAG_MIN or sample.slot > SHORT_SPEAKER_TAG_MAX:
            raise ValueError(f"voice speaker slot must be between 1 and 4: {sample.slot}")
        if sample.slot in seen_slots:
            raise ValueError(f"voice speaker slot is duplicated: {sample.slot}")
        seen_slots.add(sample.slot)
        samples.append(VibeVoiceVoiceSample(slot=sample.slot, path=Path(sample.path)))
    return samples


def _options_with_auto_line_by_line(script: str, options: VibeVoiceGenerationOptions) -> VibeVoiceGenerationOptions:
    model_preset = resolve_vibevoice_model_preset(options.model_id)
    if (
        options.directed_line_mode
        or options.line_by_line
        or not model_preset.auto_line_by_line
        or not _should_auto_line_by_line(script)
    ):
        return options
    return replace(options, line_by_line=True)


def _normalize_vibevoice_script_for_options(script: str, options: VibeVoiceGenerationOptions) -> str:
    if options.directed_line_mode:
        return normalize_vibevoice_script(script)
    return normalize_vibevoice_script(script)


def _should_auto_line_by_line(script: str) -> bool:
    lines = [line.strip() for line in str(script or "").splitlines() if line.strip()]
    if len(lines) >= AUTO_LINE_BY_LINE_MIN_LINES:
        return True
    text_chars = sum(len(_speaker_text_from_normalized_line(line)) for line in lines)
    return text_chars >= AUTO_LINE_BY_LINE_MIN_CHARS


def _speaker_text_from_normalized_line(line: str) -> str:
    _prefix, sep, text = line.partition(":")
    return text.strip() if sep else line.strip()


def _default_vibevoice_python() -> str:
    return sys.executable


def _resolve_path_setting(
    *,
    explicit: str | Path | None,
    env_names: Sequence[str],
    candidates: Sequence[Path],
) -> Path:
    if explicit is not None:
        return Path(explicit).expanduser()
    for env_name in env_names:
        env_value = os.getenv(env_name)
        if env_value:
            return Path(env_value).expanduser()
    for candidate in candidates:
        if candidate.exists():
            return candidate.expanduser()
    return candidates[0].expanduser()


def _default_vibevoice_home_candidates() -> list[Path]:
    if model_cache_dir := os.getenv("MODEL_CACHE_DIR"):
        return [Path(model_cache_dir).expanduser() / "vibevoice" / "huggingface" / "hub"]
    return [DEFAULT_VIBEVOICE_HOME]


def _default_comfyui_vibevoice_candidates() -> list[Path]:
    if model_cache_dir := os.getenv("MODEL_CACHE_DIR"):
        return [Path(model_cache_dir).expanduser() / "vibevoice" / "ComfyUI-VibeVoice"]
    return [DEFAULT_COMFYUI_VIBEVOICE_PATH]


def _elapsed_ms(started: float) -> float:
    return (perf_counter() - started) * 1000


def _tail_text(text: str | None, *, max_chars: int = 4000) -> str:
    value = str(text or "").strip()
    if len(value) <= max_chars:
        return value
    return value[-max_chars:]


def _redacted_command(command: Sequence[str]) -> list[str]:
    return [str(item) for item in command]


def _options_payload(options: VibeVoiceGenerationOptions) -> dict[str, object]:
    return {
        "model_id": options.model_id,
        "cfg_scale": options.cfg_scale,
        "inference_steps": options.inference_steps,
        "seed": options.seed,
        "do_sample": options.do_sample,
        "temperature": options.temperature,
        "top_p": options.top_p,
        "top_k": options.top_k,
        "max_voice_seconds": options.max_voice_seconds,
        "line_by_line": options.line_by_line,
        "line_gap": options.line_gap,
        "directed_line_mode": options.directed_line_mode,
        "directed_retry_low_score": options.directed_retry_low_score,
        "directed_retry_score_threshold": options.directed_retry_score_threshold,
        "directed_retry_max_lines": options.directed_retry_max_lines,
    }


def _vibevoice_result_from_output(
    output: dict[str, object],
    *,
    normalized_script: str,
    fallback_elapsed_ms: float,
) -> VibeVoiceResult:
    audio_base64 = output.get("audio_base64")
    if not isinstance(audio_base64, str) or not audio_base64:
        raise VibeVoiceError("VibeVoice output did not include audio_base64")
    timings_ms = _float_dict(output.get("timings_ms"))
    for key, value in _float_dict(output.get("serverless_timings_ms")).items():
        timings_ms[f"runpod_{key}"] = value
    timings_ms.setdefault("total", fallback_elapsed_ms)
    return VibeVoiceResult(
        audio_bytes=base64.b64decode(audio_base64),
        audio_mime_type=str(output.get("audio_mime_type", "audio/wav")),
        normalized_script=str(output.get("normalized_script") or normalized_script),
        providers=_dict_or_empty(output.get("providers")),
        timings_ms=timings_ms,
        diagnostics=_dict_or_empty(output.get("diagnostics")),
        artifacts=_list_of_dicts(output.get("artifacts")),
    )


def _audio_mime_type(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or "audio/wav"


def _dict_or_empty(value: object) -> dict[str, object]:
    return dict(value) if isinstance(value, dict) else {}


def _list_of_dicts(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    return [dict(item) for item in value if isinstance(item, dict)]


def _float_dict(value: object) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, float] = {}
    for key, item in value.items():
        try:
            result[str(key)] = float(item)
        except (TypeError, ValueError):
            continue
    return result
