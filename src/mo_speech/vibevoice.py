from __future__ import annotations

import base64
from io import BytesIO
import logging
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


def _directed_script_for_lines(lines: Sequence[VibeVoiceDirectedLine], *, output_speaker: int = 1) -> str:
    if not lines:
        raise ValueError("script is required")
    separator = _directed_line_separator("\n".join(line.text for line in lines))
    joined = _join_directed_line_phrases([line.text for line in lines], separator=separator)
    return f"Speaker {output_speaker}: {joined}"


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
    return "、" if re.search(r"[ぁ-んァ-ン一-龯、。]", text) else ","


def _join_directed_line_phrases(phrases: Sequence[str], *, separator: str) -> str:
    non_empty = [phrase.strip() for phrase in phrases if phrase.strip()]
    if not non_empty:
        raise ValueError("script is required")
    parts: list[str] = []
    for index, phrase in enumerate(non_empty):
        parts.append(phrase)
        if index < len(non_empty) - 1 and not _ends_with_sentence_punctuation(phrase):
            parts.append(separator)
    return "".join(parts)


def _ends_with_sentence_punctuation(text: str) -> bool:
    return bool(re.search(r"[、。，，,.!?！？…]$", str(text or "").strip()))


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
        speaker_outputs: dict[int, Path] = {}
        ranges_by_line: dict[int, VibeVoiceAudioRange] = {}
        speaker_results: dict[int, VibeVoiceResult] = {}
        speaker_vibevoice_outputs: dict[int, Path] = {}
        asr_segments_by_speaker: dict[int, list[dict[str, object]]] = {}
        asr_words_by_speaker: dict[int, list[dict[str, object]]] = {}
        vc_results_by_speaker: dict[int, object] = {}
        artifacts: list[dict[str, object]] = []
        warnings: list[str] = []
        generation_total_ms = 0.0
        voice_conversion_total_ms = 0.0
        asr_total_ms = 0.0
        asr_name = ""
        voice_conversion_name = ""

        self._release_directed_asr_provider()
        self._release_directed_voice_conversion_service()
        _report_vibevoice_progress(progress_callback, "prepare", "指定台詞モード準備")
        with TemporaryDirectory(prefix="mo-vibevoice-directed-") as temp_dir_raw:
            temp_dir = Path(temp_dir_raw)
            for speaker_index, (speaker, speaker_lines) in enumerate(lines_by_speaker.items(), start=1):
                _raise_if_cancelled(cancel_event)
                speaker_script = _directed_script_for_lines(speaker_lines, output_speaker=1)
                speaker_options = replace(options, directed_line_mode=False, line_by_line=False)
                _report_vibevoice_progress(
                    progress_callback,
                    "generation",
                    f"指定台詞 話者{speaker}生成 {speaker_index}/{len(lines_by_speaker)}",
                )
                speaker_result = self._generate_single_pass(
                    script_text=speaker_script,
                    voice_samples=[VibeVoiceVoiceSample(slot=1, path=samples_by_slot[speaker].path)],
                    options=speaker_options,
                    progress_callback=progress_callback,
                    cancel_event=cancel_event,
                    allow_auto_line_by_line=False,
                )
                generation_total_ms += float(speaker_result.timings_ms.get("total", 0.0))
                speaker_results[speaker] = speaker_result
                speaker_output = temp_dir / f"speaker-{speaker}.wav"
                speaker_output.write_bytes(speaker_result.audio_bytes)
                speaker_vibevoice_outputs[speaker] = speaker_output
                speaker_outputs[speaker] = speaker_output

            if _directed_voice_conversion_enabled():
                vc_service = self._get_directed_voice_conversion_service()
                try:
                    for speaker_index, speaker in enumerate(lines_by_speaker, start=1):
                        _raise_if_cancelled(cancel_event)
                        _report_vibevoice_progress(
                            progress_callback,
                            "voice_conversion",
                            f"指定台詞 話者{speaker} VC {speaker_index}/{len(lines_by_speaker)}",
                        )
                        vc_started = perf_counter()
                        vc_result = _convert_directed_voice(
                            vc_service,
                            source_audio_path=speaker_vibevoice_outputs[speaker],
                            reference_audio_path=samples_by_slot[speaker].path,
                        )
                        voice_conversion_total_ms += _elapsed_ms(vc_started)
                        vc_results_by_speaker[speaker] = vc_result
                        voice_conversion_name = str(
                            getattr(vc_result, "providers", {}).get("voice_conversion", "")
                            or voice_conversion_name
                            or "voice_conversion"
                        )
                        vc_output = temp_dir / f"speaker-{speaker}-vc.wav"
                        vc_output.write_bytes(getattr(vc_result, "output_audio_bytes"))
                        speaker_outputs[speaker] = vc_output
                finally:
                    self._release_directed_voice_conversion_service()

            asr_provider = self._get_directed_asr_provider()
            asr_name = str(getattr(asr_provider, "name", asr_provider.__class__.__name__))
            try:
                for speaker_index, (speaker, speaker_lines) in enumerate(lines_by_speaker.items(), start=1):
                    _raise_if_cancelled(cancel_event)
                    _report_vibevoice_progress(
                        progress_callback,
                        "asr",
                        f"指定台詞 話者{speaker} ASR分割 {speaker_index}/{len(lines_by_speaker)}",
                    )
                    asr_started = perf_counter()
                    transcription = _transcribe_directed_audio(asr_provider, speaker_outputs[speaker])
                    asr_total_ms += _elapsed_ms(asr_started)
                    asr_segments_by_speaker[speaker] = _timestamp_rows(getattr(transcription, "segments", []))
                    asr_words_by_speaker[speaker] = _timestamp_rows(getattr(transcription, "words", []))
                    ranges, range_warnings = _audio_ranges_for_directed_lines(
                        speaker_lines,
                        transcription,
                        speaker_outputs[speaker],
                    )
                    warnings.extend(f"Speaker {speaker}: {warning}" for warning in range_warnings)
                    ranges_by_line.update({audio_range.line_index: audio_range for audio_range in ranges})
            finally:
                self._release_directed_asr_provider()

            _raise_if_cancelled(cancel_event)
            _report_vibevoice_progress(progress_callback, "reconstruct", "指定台詞 音声再配置")
            reconstruct_started = perf_counter()
            output_path = temp_dir / "directed-vibevoice-output.wav"
            _compose_directed_wav(
                lines,
                ranges_by_line=ranges_by_line,
                speaker_outputs=speaker_outputs,
                output_path=output_path,
                gap_seconds=options.line_gap,
            )
            audio_bytes = output_path.read_bytes()
            reconstruct_ms = _elapsed_ms(reconstruct_started)
            artifacts = _directed_audio_artifacts(
                lines=lines,
                speaker_vibevoice_outputs=speaker_vibevoice_outputs,
                speaker_outputs=speaker_outputs,
                ranges_by_line=ranges_by_line,
                include_voice_conversion=bool(vc_results_by_speaker),
            )

        total_ms = _elapsed_ms(directed_started)
        first_result = next(iter(speaker_results.values()))
        providers = dict(first_result.providers)
        providers["vibevoice_directed_asr"] = asr_name
        providers["vibevoice_directed_mode"] = "asr_reconstruct"
        if voice_conversion_name:
            providers["vibevoice_directed_vc"] = voice_conversion_name
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
                    "asr_provider": asr_name,
                    "voice_conversion_provider": voice_conversion_name,
                    "gap_seconds": options.line_gap,
                    "warnings": warnings,
                    "speaker_scripts": {
                        str(speaker): _directed_script_for_lines(speaker_lines, output_speaker=1)
                        for speaker, speaker_lines in lines_by_speaker.items()
                    },
                    "asr_segments": {str(speaker): rows for speaker, rows in asr_segments_by_speaker.items()},
                    "asr_words": {str(speaker): rows for speaker, rows in asr_words_by_speaker.items()},
                    "voice_conversion": {
                        str(speaker): {
                            "timings_ms": getattr(result, "timings_ms", {}),
                            "providers": getattr(result, "providers", {}),
                            "warnings": getattr(result, "warnings", []),
                        }
                        for speaker, result in sorted(vc_results_by_speaker.items())
                    },
                    "ranges": [
                        {
                            "line_index": audio_range.line_index,
                            "speaker": audio_range.speaker,
                            "text": audio_range.text,
                            "start": audio_range.start,
                            "end": audio_range.end,
                        }
                        for audio_range in sorted(ranges_by_line.values(), key=lambda item: item.line_index)
                    ],
                },
                "speaker_results": {
                    str(speaker): result.diagnostics for speaker, result in sorted(speaker_results.items())
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
        output = self.client.submit(
            {
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
        )
        _report_vibevoice_progress(progress_callback, "receive", "RunPod結果受信")
        return _vibevoice_result_from_output(
            output,
            normalized_script=normalized_script,
            fallback_elapsed_ms=_elapsed_ms(started),
        )


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


def _convert_directed_voice(voice_conversion_service, *, source_audio_path: Path, reference_audio_path: Path):
    from .providers.voice import SeedVcRuntimeSettings, VoiceConversionRequest

    return voice_conversion_service.convert(
        VoiceConversionRequest(
            source_audio_path=source_audio_path,
            reference_audio_path=reference_audio_path,
            backend_id=_directed_voice_conversion_backend(),
            seed_vc_settings=SeedVcRuntimeSettings(),
        )
    )


def _directed_asr_language() -> str:
    return os.getenv("MO_VIBEVOICE_DIRECTED_ASR_LANGUAGE", "auto").strip() or "auto"


def _directed_lines_by_speaker(lines: Sequence[VibeVoiceDirectedLine]) -> dict[int, list[VibeVoiceDirectedLine]]:
    grouped: dict[int, list[VibeVoiceDirectedLine]] = {}
    for line in lines:
        grouped.setdefault(line.speaker, []).append(line)
    return dict(sorted(grouped.items(), key=lambda item: min(line.index for line in item[1])))


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


def _audio_ranges_for_directed_lines(
    lines: Sequence[VibeVoiceDirectedLine],
    transcription,
    audio_path: Path,
) -> tuple[list[VibeVoiceAudioRange], list[str]]:
    duration = _wav_duration(audio_path)
    warnings: list[str] = []
    words = _timestamp_rows(getattr(transcription, "words", []))
    segments = _timestamp_rows(getattr(transcription, "segments", []))
    if words:
        ranges = _audio_ranges_from_words(lines, words, duration=duration)
        if len(words) < len(lines):
            warnings.append("ASR word数が台詞行数より少ないため、範囲推定が粗くなる可能性があります。")
        return ranges, warnings
    if segments:
        if len(segments) == len(lines):
            return [
                VibeVoiceAudioRange(
                    speaker=line.speaker,
                    line_index=line.index,
                    text=line.text,
                    start=max(0.0, min(float(segment["start"]), duration)),
                    end=max(0.0, min(float(segment["end"]), duration)),
                )
                for line, segment in zip(lines, segments, strict=True)
            ], warnings
        warnings.append("ASR segment数と台詞行数が一致しないため、文字数比で範囲を推定しました。")
        return _audio_ranges_by_target_text_ratio(lines, rows=segments, duration=duration), warnings
    raise ValueError("指定台詞モードのASR timestampが空でした。")


def _audio_ranges_from_words(
    lines: Sequence[VibeVoiceDirectedLine],
    words: Sequence[dict[str, object]],
    *,
    duration: float,
) -> list[VibeVoiceAudioRange]:
    if not words:
        return _audio_ranges_by_target_text_ratio(lines, rows=[], duration=duration)
    word_lengths = [max(1, len(_alignment_text(str(word.get("text", ""))))) for word in words]
    total_word_length = max(1, sum(word_lengths))
    target_lengths = [max(1, len(_alignment_text(line.text))) for line in lines]
    total_target_length = max(1, sum(target_lengths))
    ranges: list[VibeVoiceAudioRange] = []
    word_index = 0
    consumed_words = 0
    target_cumulative = 0
    for line, target_length in zip(lines, target_lengths, strict=True):
        start_index = min(word_index, len(words) - 1)
        target_cumulative += target_length
        target_word_cumulative = target_cumulative / total_target_length * total_word_length
        while word_index < len(words) - 1 and consumed_words + word_lengths[word_index] < target_word_cumulative:
            consumed_words += word_lengths[word_index]
            word_index += 1
        end_index = min(word_index, len(words) - 1)
        start = float(words[start_index]["start"])
        end = float(words[end_index]["end"])
        if end <= start:
            end = min(duration, start + 0.05)
        ranges.append(
            VibeVoiceAudioRange(
                speaker=line.speaker,
                line_index=line.index,
                text=line.text,
                start=max(0.0, min(start, duration)),
                end=max(0.0, min(end, duration)),
            )
        )
        if word_index < len(words) - 1:
            consumed_words += word_lengths[word_index]
            word_index += 1
    return ranges


def _audio_ranges_by_target_text_ratio(
    lines: Sequence[VibeVoiceDirectedLine],
    *,
    rows: Sequence[dict[str, object]],
    duration: float,
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
    speaker_outputs: dict[int, Path],
    output_path: Path,
    gap_seconds: float,
) -> None:
    if not lines:
        raise ValueError("script is required")
    params = _wav_params(speaker_outputs[lines[0].speaker])
    frames: list[bytes] = []
    for index, line in enumerate(lines):
        audio_range = ranges_by_line[line.index]
        source_path = speaker_outputs[line.speaker]
        if _wav_params(source_path) != params:
            raise VibeVoiceError("指定台詞モードの話者別WAV形式が一致しません。")
        frames.append(_read_wav_frames(source_path, start=audio_range.start, end=audio_range.end))
        if index < len(lines) - 1 and gap_seconds > 0:
            frames.append(_silence_frames(params=params, seconds=gap_seconds))
    with wave.open(str(output_path), "wb") as output:
        output.setnchannels(params["channels"])
        output.setsampwidth(params["sample_width"])
        output.setframerate(params["frame_rate"])
        output.writeframes(b"".join(frames))


def _directed_audio_artifacts(
    *,
    lines: Sequence[VibeVoiceDirectedLine],
    speaker_vibevoice_outputs: dict[int, Path],
    speaker_outputs: dict[int, Path],
    ranges_by_line: dict[int, VibeVoiceAudioRange],
    include_voice_conversion: bool,
) -> list[dict[str, object]]:
    artifacts: list[dict[str, object]] = []
    for speaker, path in sorted(speaker_vibevoice_outputs.items()):
        artifacts.append(
            _audio_artifact_from_bytes(
                path.read_bytes(),
                kind="speaker_vibevoice",
                label=f"Speaker {speaker} VibeVoice",
                speaker=speaker,
                duration_seconds=_wav_duration(path),
            )
        )
    if include_voice_conversion:
        for speaker, path in sorted(speaker_outputs.items()):
            artifacts.append(
                _audio_artifact_from_bytes(
                    path.read_bytes(),
                    kind="speaker_voice_conversion",
                    label=f"Speaker {speaker} Seed-VC",
                    speaker=speaker,
                    duration_seconds=_wav_duration(path),
                )
            )
    for line in lines:
        audio_range = ranges_by_line[line.index]
        segment_bytes = _wav_bytes_for_range(
            speaker_outputs[line.speaker],
            start=audio_range.start,
            end=audio_range.end,
        )
        artifacts.append(
            _audio_artifact_from_bytes(
                segment_bytes,
                kind="line_segment",
                label=f"Line {line.index} / Speaker {line.speaker}",
                speaker=line.speaker,
                line_index=line.index,
                text=line.text,
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
    buffer = BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(params["channels"])
        output.setsampwidth(params["sample_width"])
        output.setframerate(params["frame_rate"])
        output.writeframes(_read_wav_frames(path, start=start, end=end))
    return buffer.getvalue()


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
