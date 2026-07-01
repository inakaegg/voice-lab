from __future__ import annotations

import base64
import logging
import mimetypes
import os
from queue import Empty, Queue
import re
import subprocess
import sys
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
    model_id: str = DEFAULT_VIBEVOICE_MODEL_ID


@dataclass(frozen=True)
class VibeVoiceVoiceSample:
    slot: int
    path: Path


@dataclass(frozen=True)
class VibeVoiceResult:
    audio_bytes: bytes
    audio_mime_type: str
    normalized_script: str
    providers: dict[str, object]
    timings_ms: dict[str, float]
    diagnostics: dict[str, object] = field(default_factory=dict)


class VibeVoiceError(RuntimeError):
    pass


def resolve_vibevoice_model_preset(model_id: str | None) -> VibeVoiceModelPreset:
    normalized = str(model_id or DEFAULT_VIBEVOICE_MODEL_ID).strip() or DEFAULT_VIBEVOICE_MODEL_ID
    try:
        return VIBEVOICE_MODEL_PRESETS[normalized]
    except KeyError as exc:
        raise ValueError(f"unsupported VibeVoice model: {normalized}") from exc


def serialize_vibevoice_model_presets() -> list[dict[str, object]]:
    return [
        {
            "model_id": preset.model_id,
            "label": preset.label,
            "model_repo": preset.model_repo,
            "model_revision": preset.model_revision or "",
            "tokenizer_repo": preset.tokenizer_repo,
            "tokenizer_revision": preset.tokenizer_revision or "",
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
        return number if SHORT_SPEAKER_TAG_MIN <= number <= SHORT_SPEAKER_TAG_MAX else None
    if len(normalized) == 1 and normalized.isalpha() and normalized.isascii():
        number = ord(normalized.upper()) - ord("A") + 1
        return number if SHORT_SPEAKER_TAG_MIN <= number <= SHORT_SPEAKER_TAG_MAX else None
    return None


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
        if not self.cli_path.is_file():
            raise VibeVoiceError(f"VibeVoice CLI was not found: {self.cli_path}")
        normalized_script = normalize_vibevoice_script(script_text)
        generation_options = _options_with_auto_line_by_line(
            normalized_script,
            options or VibeVoiceGenerationOptions(),
        )
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
        normalized_script = normalize_vibevoice_script(script_text)
        generation_options = _options_with_auto_line_by_line(
            normalized_script,
            options or VibeVoiceGenerationOptions(),
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
    if options.line_by_line or not _should_auto_line_by_line(script):
        return options
    return replace(options, line_by_line=True)


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
    )


def _audio_mime_type(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or "audio/wav"


def _dict_or_empty(value: object) -> dict[str, object]:
    return dict(value) if isinstance(value, dict) else {}


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
