from __future__ import annotations

import base64
import mimetypes
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter
from typing import Callable, Protocol, Sequence


LOCAL_SHARED_VIBEVOICE_ROOT = Path("/Volumes/KIOXIA_1T/pj/models/vibevoice")
LEGACY_COMFYUI_ROOT = Path("/Volumes/KIOXIA_1T/pj/ComfyUI")
DEFAULT_VIBEVOICE_HOME = LOCAL_SHARED_VIBEVOICE_ROOT / "huggingface" / "hub"
LEGACY_VIBEVOICE_HOME = LEGACY_COMFYUI_ROOT / "models" / "vibevoice"
DEFAULT_VIBEVOICE_CLI = Path(__file__).with_name("vibevoice_cli.py")
DEFAULT_COMFYUI_VIBEVOICE_PATH = LOCAL_SHARED_VIBEVOICE_ROOT / "ComfyUI-VibeVoice"
LEGACY_COMFYUI_VIBEVOICE_PATH = LEGACY_COMFYUI_ROOT / "custom_nodes" / "ComfyUI-VibeVoice"
DEFAULT_COMFYUI_PYTHON = Path("/Volumes/KIOXIA_1T/pj/ComfyUI/.venv/bin/python")
DEFAULT_VIBEVOICE_TIMEOUT_SECONDS = 900.0
VIBEVOICE_SAMPLE_RATE = 24_000


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


SubprocessRun = Callable[..., subprocess.CompletedProcess[str]]


class VibeVoiceGenerator(Protocol):
    def status(self) -> dict[str, object]: ...

    def generate(
        self,
        *,
        script_text: str,
        voice_paths: Sequence[Path],
        options: VibeVoiceGenerationOptions | None = None,
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
        if _has_speaker_tag(stripped):
            normalized_lines.append(stripped)
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
        model_cache = self._find_model_cache()
        tokenizer = self._find_tokenizer()
        cli_exists = self.cli_path.is_file()
        module_exists = self.comfyui_vibevoice_path.is_dir()
        available = cli_exists and module_exists and model_cache is not None and tokenizer is not None
        return {
            "available": available,
            "provider": self.name,
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
        voice_paths: Sequence[Path],
        options: VibeVoiceGenerationOptions | None = None,
    ) -> VibeVoiceResult:
        if not voice_paths:
            raise ValueError("voice sample is required")
        if not self.cli_path.is_file():
            raise VibeVoiceError(f"VibeVoice CLI was not found: {self.cli_path}")
        normalized_script = normalize_vibevoice_script(script_text)
        generation_options = options or VibeVoiceGenerationOptions()
        started = perf_counter()

        with TemporaryDirectory(prefix="mo-vibevoice-") as temp_dir:
            temp_root = Path(temp_dir)
            script_path = temp_root / "script.txt"
            script_path.write_text(normalized_script, encoding="utf-8")
            output_path = temp_root / "vibevoice-output.wav"
            metadata_path = temp_root / "vibevoice-metadata.json"
            voice_files = [
                self._prepare_voice_file(path, temp_root, index)
                for index, path in enumerate(voice_paths, start=1)
            ]
            command = self._build_command(
                script_path=script_path,
                output_path=output_path,
                metadata_path=metadata_path,
                voice_files=voice_files,
                options=generation_options,
            )
            completed = self._subprocess_run(
                command,
                env=self._build_env(),
                cwd=str(Path.cwd()),
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
            )
            if completed.returncode != 0:
                raise VibeVoiceError(
                    "VibeVoice generation failed: "
                    f"{_tail_text(completed.stderr) or _tail_text(completed.stdout) or completed.returncode}"
                )
            if not output_path.is_file() or output_path.stat().st_size == 0:
                raise VibeVoiceError("VibeVoice generation did not produce an audio file")
            audio_bytes = output_path.read_bytes()

        total_ms = _elapsed_ms(started)
        return VibeVoiceResult(
            audio_bytes=audio_bytes,
            audio_mime_type=self.audio_mime_type,
            normalized_script=normalized_script,
            providers={
                "vibevoice": self.name,
                "cli_path": str(self.cli_path),
                "vibevoice_home": str(self.vibevoice_home),
            },
            timings_ms={"vibevoice": total_ms, "total": total_ms},
            diagnostics={
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
        voice_files: Sequence[Path],
        options: VibeVoiceGenerationOptions,
    ) -> list[str]:
        command = [
            self.python,
            str(self.cli_path),
            "--text_file",
            str(script_path),
            "--output",
            str(output_path),
            "--voice",
            *[str(path) for path in voice_files],
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

    def _build_env(self) -> dict[str, str]:
        env = dict(os.environ)
        env["VIBEVOICE_HOME"] = str(self.vibevoice_home)
        env["COMFYUI_VIBEVOICE_PATH"] = str(self.comfyui_vibevoice_path)
        return env

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

    def _find_model_cache(self) -> Path | None:
        pattern_root = self.vibevoice_home / "models--microsoft--VibeVoice-1.5B"
        if not pattern_root.exists():
            return None
        matches = sorted(pattern_root.glob("**/model-*.safetensors"))
        return matches[0].parent if matches else None

    def _find_tokenizer(self) -> Path | None:
        pattern_root = self.vibevoice_home / "models--Qwen--Qwen2.5-1.5B"
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
        voice_paths: Sequence[Path],
        options: VibeVoiceGenerationOptions | None = None,
    ) -> VibeVoiceResult:
        if not voice_paths:
            raise ValueError("voice sample is required")
        normalized_script = normalize_vibevoice_script(script_text)
        generation_options = options or VibeVoiceGenerationOptions()
        started = perf_counter()
        output = self.client.submit(
            {
                "operation_mode": "vibevoice",
                "script": normalized_script,
                "voices": [
                    {
                        "filename": Path(path).name,
                        "audio_mime_type": _audio_mime_type(path),
                        "audio_base64": base64.b64encode(Path(path).read_bytes()).decode("ascii"),
                    }
                    for path in voice_paths
                ],
                "generation": _options_payload(generation_options),
            }
        )
        return _vibevoice_result_from_output(
            output,
            normalized_script=normalized_script,
            fallback_elapsed_ms=_elapsed_ms(started),
        )


def _format_number(value: float) -> str:
    return f"{float(value):g}"


def _default_vibevoice_python() -> str:
    if DEFAULT_COMFYUI_PYTHON.is_file():
        return str(DEFAULT_COMFYUI_PYTHON)
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
    candidates: list[Path] = []
    if model_cache_dir := os.getenv("MODEL_CACHE_DIR"):
        candidates.append(Path(model_cache_dir).expanduser() / "vibevoice" / "huggingface" / "hub")
    candidates.extend([DEFAULT_VIBEVOICE_HOME, LEGACY_VIBEVOICE_HOME])
    return candidates


def _default_comfyui_vibevoice_candidates() -> list[Path]:
    candidates: list[Path] = []
    if model_cache_dir := os.getenv("MODEL_CACHE_DIR"):
        candidates.append(Path(model_cache_dir).expanduser() / "vibevoice" / "ComfyUI-VibeVoice")
    candidates.extend([DEFAULT_COMFYUI_VIBEVOICE_PATH, LEGACY_COMFYUI_VIBEVOICE_PATH])
    return candidates


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
