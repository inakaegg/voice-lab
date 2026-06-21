from __future__ import annotations

import json
import os
import subprocess
import sys
import inspect
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from time import perf_counter
from typing import Protocol

from ..pipeline import PipelineProgress, ProgressCallback, TtsOutput


PACKAGE_ROOT = Path(__file__).resolve().parents[3]
QWEN_HELPER_SCRIPT = PACKAGE_ROOT / "scripts" / "qwen_tts_synthesize.py"

QWEN_LANGUAGE_NAMES = {
    "ja-JP": "Japanese",
    "zh-CN": "Chinese",
}

QWEN_REFERENCE_LANGUAGE_NAMES = {
    "ja-JP": "Japanese",
    "zh-CN": "Chinese",
    "en-US": "English",
    "ko-KR": "Korean",
    "de-DE": "German",
    "fr-FR": "French",
    "ru-RU": "Russian",
    "pt-PT": "Portuguese",
    "es-ES": "Spanish",
    "it-IT": "Italian",
}


class BasicTtsProvider(Protocol):
    name: str
    audio_mime_type: str

    def synthesize(self, text: str, target_language: str) -> bytes | TtsOutput:
        raise NotImplementedError


@dataclass
class QwenVoiceCloneTtsProvider:
    python_executable: str = field(default_factory=lambda: os.getenv("QWEN_TTS_PYTHON", sys.executable))
    model_id: str = field(default_factory=lambda: os.getenv("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base"))
    script_path: Path = QWEN_HELPER_SCRIPT
    device_map: str = field(default_factory=lambda: os.getenv("QWEN_TTS_DEVICE_MAP", "cpu"))
    dtype: str = field(default_factory=lambda: os.getenv("QWEN_TTS_DTYPE", "float32"))
    attn_implementation: str | None = field(default_factory=lambda: _empty_to_none(os.getenv("QWEN_TTS_ATTN")))
    timeout_seconds: int = field(default_factory=lambda: int(os.getenv("QWEN_TTS_TIMEOUT_SECONDS", "900")))

    name = "qwen3-tts-voice-clone"
    audio_mime_type = "audio/wav"
    supported_voice_modes = ("clone",)

    def synthesize(self, text: str, target_language: str) -> bytes | TtsOutput:
        raise RuntimeError(f"voice_mode=default is not supported by {self.name}")

    def synthesize_with_voice(
        self,
        text: str,
        target_language: str,
        *,
        reference_audio_path: Path,
        reference_text: str,
        reference_language: str,
        voice_mode: str,
        progress_callback: ProgressCallback | None = None,
    ) -> TtsOutput:
        if voice_mode != "clone":
            raise RuntimeError(f"voice_mode={voice_mode} is not supported by {self.name}")
        if target_language not in QWEN_LANGUAGE_NAMES:
            raise ValueError(f"Qwen3-TTS target language is not configured for {target_language}")

        x_vector_only_mode = _qwen_x_vector_only_mode(reference_language)
        payload = {
            "model": self.model_id,
            "text": text,
            "language": QWEN_LANGUAGE_NAMES[target_language],
            "reference_audio": str(reference_audio_path.resolve()),
            "reference_text": "" if x_vector_only_mode else reference_text,
            "x_vector_only_mode": x_vector_only_mode,
            "device_map": self.device_map,
            "dtype": self.dtype,
            "attn_implementation": self.attn_implementation,
        }

        started = perf_counter()
        _notify_progress(progress_callback, "tts", "音声生成", self.model_id)
        with NamedTemporaryFile("w", suffix=".json", encoding="utf-8") as input_json:
            with NamedTemporaryFile(suffix=".wav") as output_audio:
                json.dump(payload, input_json, ensure_ascii=False)
                input_json.flush()
                command = [
                    _resolve_executable(self.python_executable),
                    str(self.script_path),
                    "--input-json",
                    input_json.name,
                    "--output",
                    output_audio.name,
                ]
                _run_command(command, timeout_seconds=self.timeout_seconds)
                output_audio.seek(0)
                audio_bytes = output_audio.read()

        return TtsOutput(
            audio_bytes=audio_bytes,
            audio_mime_type=self.audio_mime_type,
            timings_ms={"tts": _elapsed_ms(started)},
        )


@dataclass
class SeedVcVoiceConversionTtsProvider:
    base_tts: BasicTtsProvider
    python_executable: str = field(default_factory=lambda: os.getenv("SEED_VC_PYTHON", sys.executable))
    work_dir: Path = field(default_factory=lambda: Path(os.getenv("SEED_VC_WORK_DIR", "~/.cache/mo-speech/seed-vc")).expanduser())
    diffusion_steps: int = field(default_factory=lambda: int(os.getenv("SEED_VC_DIFFUSION_STEPS", "8")))
    length_adjust: float = field(default_factory=lambda: float(os.getenv("SEED_VC_LENGTH_ADJUST", "1.0")))
    inference_cfg_rate: float = field(default_factory=lambda: float(os.getenv("SEED_VC_INFERENCE_CFG_RATE", "0.7")))
    fp16: bool = field(default_factory=lambda: _str_to_bool(os.getenv("SEED_VC_FP16", "false")))
    checkpoint: str | None = field(default_factory=lambda: _empty_to_none(os.getenv("SEED_VC_CHECKPOINT")))
    config: str | None = field(default_factory=lambda: _empty_to_none(os.getenv("SEED_VC_CONFIG")))
    timeout_seconds: int = field(default_factory=lambda: int(os.getenv("SEED_VC_TIMEOUT_SECONDS", "1200")))

    name = "seed-vc-conversion"
    audio_mime_type = "audio/wav"
    supported_voice_modes = ("convert",)

    def synthesize(self, text: str, target_language: str) -> bytes | TtsOutput:
        raise RuntimeError(f"voice_mode=default is not supported by {self.name}")

    def synthesize_with_voice(
        self,
        text: str,
        target_language: str,
        *,
        reference_audio_path: Path,
        reference_text: str,
        reference_language: str,
        voice_mode: str,
        progress_callback: ProgressCallback | None = None,
    ) -> TtsOutput:
        if voice_mode != "convert":
            raise RuntimeError(f"voice_mode={voice_mode} is not supported by {self.name}")

        tts_started = perf_counter()
        base_output = _synthesize_seed_source_audio(
            self.base_tts,
            text,
            target_language,
            reference_audio_path=reference_audio_path,
            reference_text=reference_text,
            reference_language=reference_language,
            progress_callback=progress_callback,
        )
        tts_ms = _elapsed_ms(tts_started)

        self.work_dir.mkdir(parents=True, exist_ok=True)
        conversion_started = perf_counter()
        with TemporaryDirectory(dir=self.work_dir) as temp_dir:
            temp_path = Path(temp_dir)
            source_audio_path = temp_path / "source.wav"
            source_audio_path.write_bytes(base_output.audio_bytes)
            output_dir = temp_path / "output"
            output_dir.mkdir()

            command = [
                _resolve_executable(self.python_executable),
                "-m",
                "seed_vc.inference",
                "--source",
                str(source_audio_path),
                "--target",
                str(reference_audio_path.resolve()),
                "--output",
                str(output_dir),
                "--diffusion-steps",
                str(self.diffusion_steps),
                "--length-adjust",
                str(self.length_adjust),
                "--inference-cfg-rate",
                str(self.inference_cfg_rate),
                "--f0-condition",
                "False",
                "--auto-f0-adjust",
                "False",
                "--semi-tone-shift",
                "0",
                "--fp16",
                "True" if self.fp16 else "False",
            ]
            if self.checkpoint is not None:
                command.extend(["--checkpoint", self.checkpoint])
            if self.config is not None:
                command.extend(["--config", self.config])

            _notify_progress(progress_callback, "voice_conversion", "声質変換", _seed_vc_model_name(self))
            _run_command(command, timeout_seconds=self.timeout_seconds, cwd=self.work_dir)
            converted_audio_path = _find_single_wav(output_dir)
            audio_bytes = converted_audio_path.read_bytes()

        timings_ms = dict(base_output.timings_ms)
        timings_ms["tts"] = timings_ms.get("tts", tts_ms)
        timings_ms["voice_conversion"] = _elapsed_ms(conversion_started)
        return TtsOutput(
            audio_bytes=audio_bytes,
            audio_mime_type=self.audio_mime_type,
            timings_ms=timings_ms,
            warnings=base_output.warnings,
        )


@dataclass
class QwenSeedVcTtsProvider:
    clone_tts: object = field(default_factory=QwenVoiceCloneTtsProvider)
    conversion_tts: object | None = None

    name = "qwen3-tts-seed-vc"
    audio_mime_type = "audio/wav"
    supported_voice_modes = ("clone", "convert")

    def __post_init__(self) -> None:
        if self.conversion_tts is None:
            self.conversion_tts = SeedVcVoiceConversionTtsProvider(base_tts=self.clone_tts)  # type: ignore[arg-type]

    def synthesize(self, text: str, target_language: str) -> bytes | TtsOutput:
        raise RuntimeError(f"voice_mode=default is not supported by {self.name}")

    def synthesize_with_voice(
        self,
        text: str,
        target_language: str,
        *,
        reference_audio_path: Path,
        reference_text: str,
        reference_language: str,
        voice_mode: str,
        progress_callback: ProgressCallback | None = None,
    ) -> TtsOutput:
        if voice_mode == "clone":
            synthesize_with_voice = getattr(self.clone_tts, "synthesize_with_voice")
            return _normalize_tts_output(
                _call_synthesize_with_voice(
                    synthesize_with_voice,
                    getattr(self.clone_tts, "name", self.name),
                    text,
                    target_language,
                    reference_audio_path=reference_audio_path,
                    reference_text=reference_text,
                    reference_language=reference_language,
                    voice_mode=voice_mode,
                    progress_callback=progress_callback,
                )
            )

        if voice_mode == "convert":
            assert self.conversion_tts is not None
            synthesize_with_voice = getattr(self.conversion_tts, "synthesize_with_voice")
            return _normalize_tts_output(
                _call_synthesize_with_voice(
                    synthesize_with_voice,
                    getattr(self.conversion_tts, "name", self.name),
                    text,
                    target_language,
                    reference_audio_path=reference_audio_path,
                    reference_text=reference_text,
                    reference_language=reference_language,
                    voice_mode=voice_mode,
                    progress_callback=progress_callback,
                )
            )

        raise RuntimeError(f"voice_mode={voice_mode} is not supported by {self.name}")


def _run_command(
    command: list[str],
    *,
    timeout_seconds: int,
    cwd: Path | None = None,
) -> None:
    try:
        subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            cwd=str(cwd) if cwd is not None else None,
        )
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        stdout = (exc.stdout or "").strip()
        detail = stderr or stdout or str(exc)
        raise RuntimeError(f"voice provider command failed: {detail}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"voice provider command timed out after {timeout_seconds}s") from exc


def _find_single_wav(output_dir: Path) -> Path:
    outputs = sorted(output_dir.glob("*.wav"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not outputs:
        raise RuntimeError(f"Seed-VC did not produce a wav file in {output_dir}")
    return outputs[0]


def _synthesize_seed_source_audio(
    base_tts: BasicTtsProvider,
    text: str,
    target_language: str,
    *,
    reference_audio_path: Path,
    reference_text: str,
    reference_language: str,
    progress_callback: ProgressCallback | None = None,
) -> TtsOutput:
    supported_modes = tuple(getattr(base_tts, "supported_voice_modes", ("default",)))
    if "default" in supported_modes:
        _notify_progress(progress_callback, "tts", "音声生成", base_tts.name)
        return _normalize_tts_output(base_tts.synthesize(text, target_language))

    synthesize_with_voice = getattr(base_tts, "synthesize_with_voice", None)
    if "clone" in supported_modes and synthesize_with_voice is not None:
        kwargs = {
            "reference_audio_path": reference_audio_path,
            "reference_text": reference_text,
            "reference_language": reference_language,
            "voice_mode": "clone",
        }
        if "progress_callback" in inspect.signature(synthesize_with_voice).parameters:
            kwargs["progress_callback"] = progress_callback
        else:
            _notify_progress(progress_callback, "tts", "音声生成", base_tts.name)
        return _normalize_tts_output(
            synthesize_with_voice(
                text,
                target_language,
                **kwargs,
            )
        )

    raise RuntimeError(f"Seed-VC source TTS is not configured: {base_tts.name}")


def _qwen_x_vector_only_mode(reference_language: str) -> bool:
    configured = os.getenv("QWEN_TTS_X_VECTOR_ONLY")
    if configured is not None:
        return _str_to_bool(configured)
    return reference_language not in QWEN_REFERENCE_LANGUAGE_NAMES


def _normalize_tts_output(output: bytes | TtsOutput) -> TtsOutput:
    if isinstance(output, TtsOutput):
        return output
    return TtsOutput(audio_bytes=output)


def _notify_progress(
    progress_callback: ProgressCallback | None,
    stage: str,
    label: str,
    provider: str,
) -> None:
    if progress_callback is not None:
        progress_callback(PipelineProgress(stage=stage, label=label, provider=provider))


def _call_synthesize_with_voice(
    synthesize_with_voice,
    provider_name: str,
    text: str,
    target_language: str,
    *,
    reference_audio_path: Path,
    reference_text: str,
    reference_language: str,
    voice_mode: str,
    progress_callback: ProgressCallback | None,
):
    kwargs = {
        "reference_audio_path": reference_audio_path,
        "reference_text": reference_text,
        "reference_language": reference_language,
        "voice_mode": voice_mode,
    }
    if "progress_callback" in inspect.signature(synthesize_with_voice).parameters:
        kwargs["progress_callback"] = progress_callback
    else:
        _notify_progress(progress_callback, "tts", "音声生成", provider_name)
    return synthesize_with_voice(text, target_language, **kwargs)


def _seed_vc_model_name(provider: SeedVcVoiceConversionTtsProvider) -> str:
    if provider.checkpoint is not None:
        return provider.checkpoint
    return "Plachta/Seed-VC"


def _elapsed_ms(started: float) -> float:
    return (perf_counter() - started) * 1000


def _empty_to_none(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    return value


def _str_to_bool(value: str) -> bool:
    return value.lower() in {"1", "true", "yes", "on"}


def _resolve_executable(executable: str) -> str:
    path = Path(executable)
    if path.is_absolute() or len(path.parts) == 1:
        return executable
    return str(Path.cwd() / path)
