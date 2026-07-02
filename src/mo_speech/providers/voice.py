from __future__ import annotations

import hashlib
import importlib
import gc
import json
import os
import re
import shutil
import subprocess
import sys
import inspect
import threading
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from time import perf_counter
from types import SimpleNamespace
from typing import TYPE_CHECKING, Protocol

from ..pipeline import PipelineProgress, ProgressCallback, TtsOutput

if TYPE_CHECKING:
    from ..audio_effects import AudioEffectInsertSettings


QWEN_HELPER_MODULE = "mo_speech.qwen_tts_synthesize"
CHATTERBOX_VC_HELPER_MODULE = "mo_speech.chatterbox_vc_convert"

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

DEFAULT_SEED_VC_DIFFUSION_STEPS = 30
DEFAULT_SEED_VC_LENGTH_ADJUST = 1.0
DEFAULT_SEED_VC_INFERENCE_CFG_RATE = 0.7
DEFAULT_SEED_VC_REFERENCE_MAX_SECONDS = 10.0
DEFAULT_SEED_VC_REFERENCE_AUTO_SELECT = False


class BasicTtsProvider(Protocol):
    name: str
    audio_mime_type: str

    def synthesize(self, text: str, target_language: str) -> bytes | TtsOutput:
        raise NotImplementedError


@dataclass(frozen=True)
class VoiceConversionBackendInfo:
    backend_id: str
    label: str
    provider: str
    available: bool
    reason: str = ""
    settings: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class SeedVcRuntimeSettings:
    diffusion_steps: int | None = None
    length_adjust: float | None = None
    inference_cfg_rate: float | None = None
    reference_max_seconds: float | None = None
    reference_auto_select: bool | None = None


@dataclass(frozen=True)
class _ReferenceAudioPreparation:
    reference_segment_select_ms: float | None = None


@dataclass(frozen=True)
class _ReferenceAudioSegment:
    start_seconds: float
    duration_seconds: float


@dataclass(frozen=True)
class VoiceConversionRequest:
    source_audio_path: Path
    reference_audio_path: Path
    backend_id: str
    seed_vc_settings: SeedVcRuntimeSettings = field(default_factory=SeedVcRuntimeSettings)
    audio_effect_path: Path | None = None
    audio_effect_settings: AudioEffectInsertSettings | None = None


@dataclass(frozen=True)
class VoiceConversionResult:
    output_audio_bytes: bytes
    output_audio_mime_type: str
    timings_ms: dict[str, float]
    providers: dict[str, str]
    warnings: list[str] = field(default_factory=list)


def prepare_seed_vc_reference_preview(
    input_path: Path,
    seed_vc_settings: SeedVcRuntimeSettings | None = None,
) -> TtsOutput:
    provider = SeedVcDirectVoiceConversionProvider()
    settings = _effective_seed_vc_settings(provider, seed_vc_settings)
    provider.work_dir.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=provider.work_dir) as temp_dir:
        output_path = Path(temp_dir) / "reference.wav"
        prepare_started = perf_counter()
        reference_preparation = _prepare_seed_reference_audio(
            input_path,
            output_path,
            max_seconds=settings.reference_max_seconds,
            sample_rate=provider.reference_sample_rate,
            timeout_seconds=provider.audio_prepare_timeout_seconds,
            auto_select=settings.reference_auto_select,
        )
        timings_ms = {"reference_audio_prepare": _elapsed_ms(prepare_started)}
        if reference_preparation.reference_segment_select_ms is not None:
            timings_ms["reference_segment_select"] = reference_preparation.reference_segment_select_ms
        audio_bytes = output_path.read_bytes()

    return TtsOutput(
        audio_bytes=audio_bytes,
        audio_mime_type="audio/wav",
        timings_ms=timings_ms,
    )


class DirectVoiceConversionProvider(Protocol):
    backend_id: str
    label: str
    name: str
    audio_mime_type: str

    def backend_info(self) -> VoiceConversionBackendInfo:
        raise NotImplementedError

    def convert(
        self,
        *,
        source_audio_path: Path,
        reference_audio_path: Path,
        seed_vc_settings: SeedVcRuntimeSettings | None = None,
        progress_callback: ProgressCallback | None = None,
    ) -> TtsOutput:
        raise NotImplementedError


@dataclass
class VoiceConversionService:
    providers: list[DirectVoiceConversionProvider]
    _backend_info_cache: list[VoiceConversionBackendInfo] | None = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        self._providers_by_id = {provider.backend_id: provider for provider in self.providers}

    def backend_infos(self) -> list[VoiceConversionBackendInfo]:
        if self._backend_info_cache is None:
            self._backend_info_cache = [provider.backend_info() for provider in self.providers]
        return list(self._backend_info_cache)

    def preload(self) -> None:
        for provider in self.providers:
            preload = getattr(provider, "preload", None)
            if callable(preload):
                preload()

    def release(self) -> None:
        for provider in self.providers:
            release = getattr(provider, "release", None)
            if callable(release):
                release()

    def convert(
        self,
        request: VoiceConversionRequest,
        progress_callback: ProgressCallback | None = None,
    ) -> VoiceConversionResult:
        if request.backend_id not in self._providers_by_id:
            raise ValueError(f"unsupported voice backend: {request.backend_id}")
        if not request.source_audio_path.exists():
            raise FileNotFoundError(f"source audio file does not exist: {request.source_audio_path}")
        if not request.reference_audio_path.exists():
            raise FileNotFoundError(f"reference audio file does not exist: {request.reference_audio_path}")

        provider = self._providers_by_id[request.backend_id]
        info = provider.backend_info()
        if not info.available:
            detail = f": {info.reason}" if info.reason else ""
            raise RuntimeError(f"voice backend is not available: {request.backend_id}{detail}")

        total_started = perf_counter()
        output = provider.convert(
            source_audio_path=request.source_audio_path,
            reference_audio_path=request.reference_audio_path,
            seed_vc_settings=request.seed_vc_settings,
            progress_callback=progress_callback,
        )
        timings_ms = dict(output.timings_ms)
        timings_ms["total"] = _elapsed_ms(total_started)
        return VoiceConversionResult(
            output_audio_bytes=output.audio_bytes,
            output_audio_mime_type=output.audio_mime_type or provider.audio_mime_type,
            timings_ms=timings_ms,
            providers={"voice_conversion": provider.name},
            warnings=output.warnings,
        )


@dataclass
class QwenVoiceCloneTtsProvider:
    python_executable: str = field(default_factory=lambda: os.getenv("QWEN_TTS_PYTHON", sys.executable))
    model_id: str = field(default_factory=lambda: os.getenv("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base"))
    helper_module: str = field(default_factory=lambda: os.getenv("QWEN_TTS_HELPER_MODULE", QWEN_HELPER_MODULE))
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
                    "-m",
                    self.helper_module,
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
    diffusion_steps: int = field(
        default_factory=lambda: int(os.getenv("SEED_VC_DIFFUSION_STEPS", str(DEFAULT_SEED_VC_DIFFUSION_STEPS)))
    )
    length_adjust: float = field(
        default_factory=lambda: float(os.getenv("SEED_VC_LENGTH_ADJUST", str(DEFAULT_SEED_VC_LENGTH_ADJUST)))
    )
    inference_cfg_rate: float = field(
        default_factory=lambda: float(os.getenv("SEED_VC_INFERENCE_CFG_RATE", str(DEFAULT_SEED_VC_INFERENCE_CFG_RATE)))
    )
    fp16: bool = field(default_factory=lambda: _str_to_bool(os.getenv("SEED_VC_FP16", "false")))
    checkpoint: str | None = field(default_factory=lambda: _empty_to_none(os.getenv("SEED_VC_CHECKPOINT")))
    config: str | None = field(default_factory=lambda: _empty_to_none(os.getenv("SEED_VC_CONFIG")))
    reference_max_seconds: float = field(
        default_factory=lambda: float(os.getenv("SEED_VC_REFERENCE_MAX_SECONDS", str(DEFAULT_SEED_VC_REFERENCE_MAX_SECONDS)))
    )
    reference_auto_select: bool = field(
        default_factory=lambda: _str_to_bool(
            os.getenv("SEED_VC_REFERENCE_AUTO_SELECT", "1" if DEFAULT_SEED_VC_REFERENCE_AUTO_SELECT else "0")
        )
    )
    reference_sample_rate: int = field(default_factory=lambda: int(os.getenv("SEED_VC_REFERENCE_SAMPLE_RATE", "24000")))
    reference_prepare_timeout_seconds: int = field(
        default_factory=lambda: int(os.getenv("SEED_VC_REFERENCE_PREPARE_TIMEOUT_SECONDS", "90"))
    )
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
        voice_settings: dict[str, object] | None = None,
        progress_callback: ProgressCallback | None = None,
    ) -> TtsOutput:
        if voice_mode != "convert":
            raise RuntimeError(f"voice_mode={voice_mode} is not supported by {self.name}")
        settings = _effective_seed_vc_settings(self, _seed_vc_settings_from_voice_settings(voice_settings))

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
        with TemporaryDirectory(dir=self.work_dir) as temp_dir:
            temp_path = Path(temp_dir)
            source_audio_path = temp_path / "source.wav"
            source_audio_path.write_bytes(base_output.audio_bytes)
            reference_audio_for_seed = temp_path / "reference.wav"
            reference_prepare_started = perf_counter()
            reference_preparation = _prepare_seed_reference_audio(
                reference_audio_path,
                reference_audio_for_seed,
                max_seconds=settings.reference_max_seconds,
                sample_rate=self.reference_sample_rate,
                timeout_seconds=self.reference_prepare_timeout_seconds,
                auto_select=settings.reference_auto_select,
            )
            reference_prepare_ms = _elapsed_ms(reference_prepare_started)
            output_dir = temp_path / "output"
            output_dir.mkdir()

            command = [
                _resolve_executable(self.python_executable),
                "-m",
                "seed_vc.inference",
                "--source",
                str(source_audio_path),
                "--target",
                str(reference_audio_for_seed),
                "--output",
                str(output_dir),
                "--diffusion-steps",
                str(settings.diffusion_steps),
                "--length-adjust",
                _format_float(settings.length_adjust),
                "--inference-cfg-rate",
                _format_float(settings.inference_cfg_rate),
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
            conversion_started = perf_counter()
            _run_command(command, timeout_seconds=self.timeout_seconds, cwd=self.work_dir)
            converted_audio_path = _find_single_wav(output_dir)
            audio_bytes = converted_audio_path.read_bytes()

        timings_ms = dict(base_output.timings_ms)
        timings_ms["tts"] = timings_ms.get("tts", tts_ms)
        timings_ms["voice_reference_prepare"] = reference_prepare_ms
        if reference_preparation.reference_segment_select_ms is not None:
            timings_ms["reference_segment_select"] = reference_preparation.reference_segment_select_ms
        timings_ms["voice_conversion"] = _elapsed_ms(conversion_started)
        return TtsOutput(
            audio_bytes=audio_bytes,
            audio_mime_type=self.audio_mime_type,
            timings_ms=timings_ms,
            warnings=base_output.warnings,
        )


@dataclass
class SeedVcDirectVoiceConversionProvider:
    python_executable: str = field(default_factory=lambda: os.getenv("SEED_VC_PYTHON", sys.executable))
    work_dir: Path = field(default_factory=lambda: Path(os.getenv("SEED_VC_WORK_DIR", "~/.cache/mo-speech/seed-vc")).expanduser())
    diffusion_steps: int = field(
        default_factory=lambda: int(os.getenv("SEED_VC_DIFFUSION_STEPS", str(DEFAULT_SEED_VC_DIFFUSION_STEPS)))
    )
    length_adjust: float = field(
        default_factory=lambda: float(os.getenv("SEED_VC_LENGTH_ADJUST", str(DEFAULT_SEED_VC_LENGTH_ADJUST)))
    )
    inference_cfg_rate: float = field(
        default_factory=lambda: float(os.getenv("SEED_VC_INFERENCE_CFG_RATE", str(DEFAULT_SEED_VC_INFERENCE_CFG_RATE)))
    )
    fp16: bool = field(default_factory=lambda: _str_to_bool(os.getenv("SEED_VC_FP16", "false")))
    checkpoint: str | None = field(default_factory=lambda: _empty_to_none(os.getenv("SEED_VC_CHECKPOINT")))
    config: str | None = field(default_factory=lambda: _empty_to_none(os.getenv("SEED_VC_CONFIG")))
    source_sample_rate: int = field(default_factory=lambda: int(os.getenv("VC_SOURCE_SAMPLE_RATE", "24000")))
    reference_max_seconds: float = field(
        default_factory=lambda: float(os.getenv("SEED_VC_REFERENCE_MAX_SECONDS", str(DEFAULT_SEED_VC_REFERENCE_MAX_SECONDS)))
    )
    reference_auto_select: bool = field(
        default_factory=lambda: _str_to_bool(
            os.getenv("SEED_VC_REFERENCE_AUTO_SELECT", "1" if DEFAULT_SEED_VC_REFERENCE_AUTO_SELECT else "0")
        )
    )
    reference_sample_rate: int = field(default_factory=lambda: int(os.getenv("SEED_VC_REFERENCE_SAMPLE_RATE", "24000")))
    audio_prepare_timeout_seconds: int = field(
        default_factory=lambda: int(os.getenv("VC_AUDIO_PREPARE_TIMEOUT_SECONDS", "90"))
    )
    timeout_seconds: int = field(default_factory=lambda: int(os.getenv("SEED_VC_TIMEOUT_SECONDS", "1200")))

    backend_id = "seed-vc"
    label = "Seed-VC"
    name = "Plachta/Seed-VC"
    audio_mime_type = "audio/wav"

    def backend_info(self) -> VoiceConversionBackendInfo:
        if shutil.which("ffmpeg") is None:
            return VoiceConversionBackendInfo(
                self.backend_id,
                self.label,
                self.name,
                False,
                "ffmpegが見つかりません。",
            )
        if not _python_has_module(self.python_executable, "seed_vc"):
            return VoiceConversionBackendInfo(
                self.backend_id,
                self.label,
                self.name,
                False,
                f"{self.python_executable} で seed_vc をimportできません。",
            )
        return VoiceConversionBackendInfo(
            self.backend_id,
            self.label,
            self.name,
            True,
            settings={
                "seed_vc": {
                    "diffusion_steps": self.diffusion_steps,
                    "length_adjust": self.length_adjust,
                    "inference_cfg_rate": self.inference_cfg_rate,
                    "reference_max_seconds": self.reference_max_seconds,
                    "reference_auto_select": self.reference_auto_select,
                }
            },
        )

    def convert(
        self,
        *,
        source_audio_path: Path,
        reference_audio_path: Path,
        seed_vc_settings: SeedVcRuntimeSettings | None = None,
        progress_callback: ProgressCallback | None = None,
    ) -> TtsOutput:
        settings = _effective_seed_vc_settings(self, seed_vc_settings)
        self.work_dir.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=self.work_dir) as temp_dir:
            temp_path = Path(temp_dir)
            source_wav = temp_path / "source.wav"
            reference_wav = temp_path / "reference.wav"

            _notify_progress(progress_callback, "source_audio_prepare", "変換元音声準備", "ffmpeg")
            source_prepare_started = perf_counter()
            _prepare_vc_audio(
                source_audio_path,
                source_wav,
                sample_rate=self.source_sample_rate,
                timeout_seconds=self.audio_prepare_timeout_seconds,
            )
            source_prepare_ms = _elapsed_ms(source_prepare_started)

            _notify_progress(progress_callback, "reference_audio_prepare", "参照音声準備", "ffmpeg")
            reference_prepare_started = perf_counter()
            reference_preparation = _prepare_seed_reference_audio(
                reference_audio_path,
                reference_wav,
                max_seconds=settings.reference_max_seconds,
                sample_rate=self.reference_sample_rate,
                timeout_seconds=self.audio_prepare_timeout_seconds,
                auto_select=settings.reference_auto_select,
            )
            reference_prepare_ms = _elapsed_ms(reference_prepare_started)

            output_dir = temp_path / "output"
            output_dir.mkdir()
            command = [
                _resolve_executable(self.python_executable),
                "-m",
                "seed_vc.inference",
                "--source",
                str(source_wav),
                "--target",
                str(reference_wav),
                "--output",
                str(output_dir),
                "--diffusion-steps",
                str(settings.diffusion_steps),
                "--length-adjust",
                _format_float(settings.length_adjust),
                "--inference-cfg-rate",
                _format_float(settings.inference_cfg_rate),
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
            conversion_started = perf_counter()
            _run_command(command, timeout_seconds=self.timeout_seconds, cwd=self.work_dir)
            converted_audio_path = _find_single_wav(output_dir)
            audio_bytes = converted_audio_path.read_bytes()

        timings_ms = {
            "source_audio_prepare": source_prepare_ms,
            "reference_audio_prepare": reference_prepare_ms,
            "voice_conversion": _elapsed_ms(conversion_started),
        }
        if reference_preparation.reference_segment_select_ms is not None:
            timings_ms["reference_segment_select"] = reference_preparation.reference_segment_select_ms

        return TtsOutput(
            audio_bytes=audio_bytes,
            audio_mime_type=self.audio_mime_type,
            timings_ms=timings_ms,
        )


@dataclass
class SeedVcResidentDirectVoiceConversionProvider(SeedVcDirectVoiceConversionProvider):
    name = "Plachta/Seed-VC resident"

    _seed_vc_api: object | None = field(default=None, init=False, repr=False)
    _stream_state: object | None = field(default=None, init=False, repr=False)
    _model_load_ms: float | None = field(default=None, init=False, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)

    def backend_info(self) -> VoiceConversionBackendInfo:
        if shutil.which("ffmpeg") is None:
            return VoiceConversionBackendInfo(
                self.backend_id,
                self.label,
                self.name,
                False,
                "ffmpegが見つかりません。",
            )
        try:
            self._load_seed_vc_api()
        except Exception as exc:
            return VoiceConversionBackendInfo(
                self.backend_id,
                self.label,
                self.name,
                False,
                f"このPythonプロセスで seed_vc.api をimportできません: {exc}",
            )
        return VoiceConversionBackendInfo(
            self.backend_id,
            self.label,
            self.name,
            True,
            settings={
                "seed_vc": {
                    "execution_mode": "resident",
                    "model_resident": self._stream_state is not None,
                    "model_load_ms": self._model_load_ms,
                    "diffusion_steps": self.diffusion_steps,
                    "length_adjust": self.length_adjust,
                    "inference_cfg_rate": self.inference_cfg_rate,
                    "reference_max_seconds": self.reference_max_seconds,
                    "reference_auto_select": self.reference_auto_select,
                }
            },
        )

    def preload(self) -> None:
        with self._lock:
            self._ensure_stream_state(self._load_seed_vc_api())

    def release(self) -> None:
        with self._lock:
            self._stream_state = None
            self._seed_vc_api = None
            self._model_load_ms = None
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    def convert(
        self,
        *,
        source_audio_path: Path,
        reference_audio_path: Path,
        seed_vc_settings: SeedVcRuntimeSettings | None = None,
        progress_callback: ProgressCallback | None = None,
    ) -> TtsOutput:
        settings = _effective_seed_vc_settings(self, seed_vc_settings)
        self.work_dir.mkdir(parents=True, exist_ok=True)
        seed_vc_api = self._load_seed_vc_api()
        with TemporaryDirectory(dir=self.work_dir) as temp_dir:
            temp_path = Path(temp_dir)
            source_wav = temp_path / "source.wav"
            reference_wav = temp_path / "reference.wav"

            _notify_progress(progress_callback, "source_audio_prepare", "変換元音声準備", "ffmpeg")
            source_prepare_started = perf_counter()
            _prepare_vc_audio(
                source_audio_path,
                source_wav,
                sample_rate=self.source_sample_rate,
                timeout_seconds=self.audio_prepare_timeout_seconds,
            )
            source_prepare_ms = _elapsed_ms(source_prepare_started)

            _notify_progress(progress_callback, "reference_audio_prepare", "参照音声準備", "ffmpeg")
            reference_prepare_started = perf_counter()
            reference_preparation = _prepare_seed_reference_audio(
                reference_audio_path,
                reference_wav,
                max_seconds=settings.reference_max_seconds,
                sample_rate=self.reference_sample_rate,
                timeout_seconds=self.audio_prepare_timeout_seconds,
                auto_select=settings.reference_auto_select,
            )
            reference_prepare_ms = _elapsed_ms(reference_prepare_started)

            source_audio = _read_seed_vc_audio_data_from_wav(source_wav)
            reference_audio = _read_seed_vc_audio_data_from_wav(reference_wav)
            target_name = _file_content_hash(reference_wav)
            output_wav = temp_path / "converted.wav"

            _notify_progress(progress_callback, "voice_conversion", "声質変換", self.name)
            with self._lock:
                self._ensure_stream_state(seed_vc_api)
                conversion_started = perf_counter()
                output_audio = seed_vc_api.inference(
                    source=source_audio,
                    target=reference_audio,
                    new_target_name=target_name,
                    diffusion_steps=settings.diffusion_steps,
                    length_adjust=settings.length_adjust,
                    inference_cfg_rate=settings.inference_cfg_rate,
                    f0_condition=False,
                    auto_f0_adjust=False,
                    semi_tone_shift=0,
                    checkpoint=self.checkpoint,
                    config=self.config,
                    fp16=self.fp16,
                    streaming=True,
                    stream_state=self._stream_state,
                    end_of_stream=True,
                    realtime=False,
                )
                conversion_ms = _elapsed_ms(conversion_started)
            _write_seed_vc_audio_data_to_wav(output_audio, output_wav)
            audio_bytes = output_wav.read_bytes()

        timings_ms = {
            "source_audio_prepare": source_prepare_ms,
            "reference_audio_prepare": reference_prepare_ms,
            "voice_conversion": conversion_ms,
        }
        if self._model_load_ms is not None:
            timings_ms["voice_conversion_model_load"] = self._model_load_ms
        if reference_preparation.reference_segment_select_ms is not None:
            timings_ms["reference_segment_select"] = reference_preparation.reference_segment_select_ms

        return TtsOutput(
            audio_bytes=audio_bytes,
            audio_mime_type=self.audio_mime_type,
            timings_ms=timings_ms,
        )

    def _load_seed_vc_api(self):
        if self._seed_vc_api is None:
            self._seed_vc_api = importlib.import_module("seed_vc.api")
        return self._seed_vc_api

    def _ensure_stream_state(self, seed_vc_api) -> None:
        if self._stream_state is not None:
            return
        load_started = perf_counter()
        args = SimpleNamespace(
            f0_condition=False,
            checkpoint=self.checkpoint,
            config=self.config,
            fp16=self.fp16,
        )
        self._stream_state = seed_vc_api._V1StreamState(args, target=None, new_target_name=None, realtime=False)
        self._model_load_ms = _elapsed_ms(load_started)


@dataclass
class ChatterboxDirectVoiceConversionProvider:
    python_executable: str = field(default_factory=lambda: os.getenv("CHATTERBOX_PYTHON", sys.executable))
    helper_module: str = field(default_factory=lambda: os.getenv("CHATTERBOX_VC_HELPER_MODULE", CHATTERBOX_VC_HELPER_MODULE))
    device: str = field(default_factory=lambda: os.getenv("CHATTERBOX_DEVICE", "auto"))
    model_dir: str | None = field(default_factory=lambda: _empty_to_none(os.getenv("CHATTERBOX_MODEL_DIR")))
    work_dir: Path = field(default_factory=lambda: Path(os.getenv("CHATTERBOX_WORK_DIR", "~/.cache/mo-speech/chatterbox")).expanduser())
    source_sample_rate: int = field(default_factory=lambda: int(os.getenv("VC_SOURCE_SAMPLE_RATE", "24000")))
    reference_max_seconds: float = field(default_factory=lambda: float(os.getenv("CHATTERBOX_REFERENCE_MAX_SECONDS", "10")))
    reference_sample_rate: int = field(default_factory=lambda: int(os.getenv("CHATTERBOX_REFERENCE_SAMPLE_RATE", "24000")))
    audio_prepare_timeout_seconds: int = field(
        default_factory=lambda: int(os.getenv("VC_AUDIO_PREPARE_TIMEOUT_SECONDS", "90"))
    )
    timeout_seconds: int = field(default_factory=lambda: int(os.getenv("CHATTERBOX_TIMEOUT_SECONDS", "1200")))

    backend_id = "chatterbox"
    label = "Chatterbox VC"
    name = "ResembleAI/chatterbox"
    audio_mime_type = "audio/wav"

    def backend_info(self) -> VoiceConversionBackendInfo:
        if shutil.which("ffmpeg") is None:
            return VoiceConversionBackendInfo(
                self.backend_id,
                self.label,
                self.name,
                False,
                "ffmpegが見つかりません。",
            )
        if not _python_has_module(self.python_executable, "chatterbox.vc"):
            return VoiceConversionBackendInfo(
                self.backend_id,
                self.label,
                self.name,
                False,
                f"{self.python_executable} で chatterbox.vc をimportできません。",
            )
        return VoiceConversionBackendInfo(self.backend_id, self.label, self.name, True)

    def convert(
        self,
        *,
        source_audio_path: Path,
        reference_audio_path: Path,
        seed_vc_settings: SeedVcRuntimeSettings | None = None,
        progress_callback: ProgressCallback | None = None,
    ) -> TtsOutput:
        self.work_dir.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=self.work_dir) as temp_dir:
            temp_path = Path(temp_dir)
            source_wav = temp_path / "source.wav"
            reference_wav = temp_path / "reference.wav"
            output_wav = temp_path / "converted.wav"

            _notify_progress(progress_callback, "source_audio_prepare", "変換元音声準備", "ffmpeg")
            source_prepare_started = perf_counter()
            _prepare_vc_audio(
                source_audio_path,
                source_wav,
                sample_rate=self.source_sample_rate,
                timeout_seconds=self.audio_prepare_timeout_seconds,
            )
            source_prepare_ms = _elapsed_ms(source_prepare_started)

            _notify_progress(progress_callback, "reference_audio_prepare", "参照音声準備", "ffmpeg")
            reference_prepare_started = perf_counter()
            _prepare_vc_audio(
                reference_audio_path,
                reference_wav,
                max_seconds=self.reference_max_seconds,
                sample_rate=self.reference_sample_rate,
                timeout_seconds=self.audio_prepare_timeout_seconds,
            )
            reference_prepare_ms = _elapsed_ms(reference_prepare_started)

            command = [
                _resolve_executable(self.python_executable),
                "-m",
                self.helper_module,
                "--source",
                str(source_wav),
                "--reference",
                str(reference_wav),
                "--output",
                str(output_wav),
                "--device",
                self.device,
            ]
            if self.model_dir is not None:
                command.extend(["--model-dir", self.model_dir])

            _notify_progress(progress_callback, "voice_conversion", "声質変換", self.name)
            conversion_started = perf_counter()
            _run_command(command, timeout_seconds=self.timeout_seconds)
            audio_bytes = output_wav.read_bytes()

        return TtsOutput(
            audio_bytes=audio_bytes,
            audio_mime_type=self.audio_mime_type,
            timings_ms={
                "source_audio_prepare": source_prepare_ms,
                "reference_audio_prepare": reference_prepare_ms,
                "voice_conversion": _elapsed_ms(conversion_started),
            },
        )


@dataclass
class OpenVoiceDirectVoiceConversionProvider:
    backend_id = "openvoice-v2"
    label = "OpenVoice V2"
    name = "myshell-ai/OpenVoiceV2"
    audio_mime_type = "audio/wav"

    def backend_info(self) -> VoiceConversionBackendInfo:
        return VoiceConversionBackendInfo(
            self.backend_id,
            self.label,
            self.name,
            False,
            "OpenVoiceV2は直接VCではなくTTS後段のtone color変換候補のため、このUIでは未実装です。",
        )

    def convert(
        self,
        *,
        source_audio_path: Path,
        reference_audio_path: Path,
        seed_vc_settings: SeedVcRuntimeSettings | None = None,
        progress_callback: ProgressCallback | None = None,
    ) -> TtsOutput:
        raise RuntimeError(self.backend_info().reason)


def create_voice_conversion_service_from_env() -> VoiceConversionService:
    backend_ids = _env_list("MO_VC_BACKENDS", "seed-vc,chatterbox,openvoice-v2")
    seed_vc_execution_mode = os.getenv("SEED_VC_EXECUTION_MODE", "subprocess").strip().lower()
    providers: list[DirectVoiceConversionProvider] = []
    for backend_id in backend_ids:
        if backend_id == "seed-vc":
            if seed_vc_execution_mode in {"resident", "in-process", "in_process"}:
                providers.append(SeedVcResidentDirectVoiceConversionProvider())
            else:
                providers.append(SeedVcDirectVoiceConversionProvider())
        elif backend_id in ("runpod-seed-vc", "runpod_serverless_seed_vc"):
            from .runpod_serverless import RunpodServerlessVoiceConversionProvider

            providers.append(RunpodServerlessVoiceConversionProvider())
        elif backend_id == "chatterbox":
            providers.append(ChatterboxDirectVoiceConversionProvider())
        elif backend_id in ("openvoice", "openvoice-v2"):
            providers.append(OpenVoiceDirectVoiceConversionProvider())
        else:
            providers.append(_UnsupportedDirectVoiceConversionProvider(backend_id))
    return VoiceConversionService(providers=providers)


@dataclass
class _UnsupportedDirectVoiceConversionProvider:
    backend_id: str
    label: str = "Unsupported"
    name: str = "unsupported"
    audio_mime_type: str = "audio/wav"

    def backend_info(self) -> VoiceConversionBackendInfo:
        return VoiceConversionBackendInfo(
            self.backend_id,
            self.label,
            self.name,
            False,
            f"unsupported voice backend: {self.backend_id}",
        )

    def convert(
        self,
        *,
        source_audio_path: Path,
        reference_audio_path: Path,
        seed_vc_settings: SeedVcRuntimeSettings | None = None,
        progress_callback: ProgressCallback | None = None,
    ) -> TtsOutput:
        raise RuntimeError(self.backend_info().reason)


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
        voice_settings: dict[str, object] | None = None,
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
                    voice_settings=voice_settings or {},
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
                    voice_settings=voice_settings or {},
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
    _run_command_capture(command, timeout_seconds=timeout_seconds, cwd=cwd)


def _run_command_capture(
    command: list[str],
    *,
    timeout_seconds: int,
    cwd: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
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


def _prepare_seed_reference_audio(
    input_path: Path,
    output_path: Path,
    *,
    max_seconds: float,
    sample_rate: int,
    timeout_seconds: int,
    auto_select: bool = False,
) -> _ReferenceAudioPreparation:
    segment_select_ms: float | None = None
    segment: _ReferenceAudioSegment | None = None
    if auto_select:
        selection_started = perf_counter()
        try:
            segment = _select_seed_reference_segment(
                input_path,
                max_seconds=max_seconds,
                timeout_seconds=timeout_seconds,
            )
        except RuntimeError:
            segment = None
        segment_select_ms = _elapsed_ms(selection_started)

    if segment is None:
        segment = _ReferenceAudioSegment(
            start_seconds=0.0,
            duration_seconds=max_seconds if max_seconds > 0 else 0.0,
        )

    command = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
    ]
    if segment.start_seconds > 0:
        command.extend(["-ss", _format_seconds(segment.start_seconds)])
    command.extend(
        [
            "-i",
            str(input_path.resolve()),
        ]
    )
    if segment.duration_seconds > 0:
        command.extend(["-t", _format_seconds(segment.duration_seconds)])
    command.extend(["-ac", "1", "-ar", str(sample_rate), str(output_path)])
    _run_command(command, timeout_seconds=timeout_seconds)
    return _ReferenceAudioPreparation(reference_segment_select_ms=segment_select_ms)


def _select_seed_reference_segment(
    input_path: Path,
    *,
    max_seconds: float,
    timeout_seconds: int,
) -> _ReferenceAudioSegment | None:
    if max_seconds <= 0:
        return None

    duration_seconds = _probe_audio_duration(input_path, timeout_seconds=timeout_seconds)
    if duration_seconds is None or duration_seconds <= 0:
        return None

    silence_ranges = _detect_silence_ranges(
        input_path,
        duration_seconds=duration_seconds,
        timeout_seconds=timeout_seconds,
    )
    speech_ranges = _speech_ranges_from_silence_ranges(duration_seconds, silence_ranges)
    if not speech_ranges:
        return None

    best_start, best_end = max(speech_ranges, key=lambda item: (item[1] - item[0], -item[0]))
    best_duration = best_end - best_start
    if best_duration < min(0.75, max_seconds):
        return None

    selected_duration = min(max_seconds, best_duration)
    selected_start = best_start
    if best_duration > selected_duration:
        selected_start = best_start + ((best_duration - selected_duration) / 2)
    selected_start = max(0.0, min(selected_start, max(0.0, duration_seconds - selected_duration)))

    return _ReferenceAudioSegment(
        start_seconds=selected_start,
        duration_seconds=selected_duration,
    )


def _probe_audio_duration(input_path: Path, *, timeout_seconds: int) -> float | None:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(input_path.resolve()),
    ]
    try:
        completed = _run_command_capture(command, timeout_seconds=timeout_seconds)
    except RuntimeError:
        return None
    try:
        return float((completed.stdout or "").strip())
    except ValueError:
        return None


def _detect_silence_ranges(
    input_path: Path,
    *,
    duration_seconds: float,
    timeout_seconds: int,
) -> list[tuple[float, float]]:
    command = [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-i",
        str(input_path.resolve()),
        "-af",
        "silencedetect=noise=-35dB:d=0.25",
        "-f",
        "null",
        "-",
    ]
    completed = _run_command_capture(command, timeout_seconds=timeout_seconds)
    return _parse_silence_ranges(completed.stderr or "", duration_seconds=duration_seconds)


def _parse_silence_ranges(log_text: str, *, duration_seconds: float) -> list[tuple[float, float]]:
    ranges: list[tuple[float, float]] = []
    current_start: float | None = None
    for line in log_text.splitlines():
        start_match = re.search(r"silence_start:\s*([0-9.]+)", line)
        if start_match is not None:
            current_start = float(start_match.group(1))
            continue

        end_match = re.search(r"silence_end:\s*([0-9.]+)", line)
        if end_match is not None and current_start is not None:
            end_seconds = float(end_match.group(1))
            if end_seconds > current_start:
                ranges.append((current_start, end_seconds))
            current_start = None

    if current_start is not None and duration_seconds > current_start:
        ranges.append((current_start, duration_seconds))
    return ranges


def _speech_ranges_from_silence_ranges(
    duration_seconds: float,
    silence_ranges: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    speech_ranges: list[tuple[float, float]] = []
    cursor = 0.0
    for silence_start, silence_end in sorted(silence_ranges):
        silence_start = max(0.0, min(silence_start, duration_seconds))
        silence_end = max(silence_start, min(silence_end, duration_seconds))
        if silence_start > cursor:
            speech_ranges.append((cursor, silence_start))
        cursor = max(cursor, silence_end)

    if cursor < duration_seconds:
        speech_ranges.append((cursor, duration_seconds))

    return [(start, end) for start, end in speech_ranges if end - start > 0.05]


def _prepare_vc_audio(
    input_path: Path,
    output_path: Path,
    *,
    sample_rate: int,
    timeout_seconds: int,
    max_seconds: float | None = None,
) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_path.resolve()),
    ]
    if max_seconds is not None and max_seconds > 0:
        command.extend(["-t", _format_seconds(max_seconds)])
    command.extend(["-ac", "1", "-ar", str(sample_rate), str(output_path)])
    _run_command(command, timeout_seconds=timeout_seconds)


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
    voice_settings: dict[str, object],
    progress_callback: ProgressCallback | None,
):
    kwargs = {
        "reference_audio_path": reference_audio_path,
        "reference_text": reference_text,
        "reference_language": reference_language,
        "voice_mode": voice_mode,
    }
    if "voice_settings" in inspect.signature(synthesize_with_voice).parameters:
        kwargs["voice_settings"] = voice_settings
    if "progress_callback" in inspect.signature(synthesize_with_voice).parameters:
        kwargs["progress_callback"] = progress_callback
    else:
        _notify_progress(progress_callback, "tts", "音声生成", provider_name)
    return synthesize_with_voice(text, target_language, **kwargs)


def _seed_vc_settings_from_voice_settings(voice_settings: dict[str, object] | None) -> SeedVcRuntimeSettings | None:
    if not voice_settings:
        return None
    seed_vc_settings = voice_settings.get("seed_vc")
    if isinstance(seed_vc_settings, SeedVcRuntimeSettings):
        return seed_vc_settings
    return None


def _effective_seed_vc_settings(
    provider: object,
    runtime_settings: SeedVcRuntimeSettings | None,
) -> SeedVcRuntimeSettings:
    runtime_settings = runtime_settings or SeedVcRuntimeSettings()
    return SeedVcRuntimeSettings(
        diffusion_steps=runtime_settings.diffusion_steps or provider.diffusion_steps,
        length_adjust=runtime_settings.length_adjust or provider.length_adjust,
        inference_cfg_rate=(
            provider.inference_cfg_rate
            if runtime_settings.inference_cfg_rate is None
            else runtime_settings.inference_cfg_rate
        ),
        reference_max_seconds=runtime_settings.reference_max_seconds or provider.reference_max_seconds,
        reference_auto_select=(
            provider.reference_auto_select
            if runtime_settings.reference_auto_select is None
            else runtime_settings.reference_auto_select
        ),
    )


def _seed_vc_model_name(provider: object) -> str:
    checkpoint = getattr(provider, "checkpoint", None)
    if checkpoint is not None:
        return str(checkpoint)
    return "Plachta/Seed-VC"


def _elapsed_ms(started: float) -> float:
    return (perf_counter() - started) * 1000


def _format_seconds(value: float) -> str:
    return f"{value:.3f}".rstrip("0").rstrip(".")


def _format_float(value: float | int | None) -> str:
    if value is None:
        raise ValueError("Seed-VC setting must not be None")
    return f"{float(value):.6f}".rstrip("0").rstrip(".")


def _empty_to_none(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    return value


def _str_to_bool(value: str) -> bool:
    return value.lower() in {"1", "true", "yes", "on"}


def _env_list(name: str, default: str) -> list[str]:
    value = os.getenv(name, default)
    return [item.strip() for item in value.split(",") if item.strip()]


def _resolve_executable(executable: str) -> str:
    path = Path(executable)
    if path.is_absolute() or len(path.parts) == 1:
        return executable
    return str(Path.cwd() / path)


def _python_has_module(python_executable: str, module_name: str) -> bool:
    try:
        completed = subprocess.run(
            [
                _resolve_executable(python_executable),
                "-c",
                (
                    "import importlib.util, sys; "
                    f"sys.exit(0 if importlib.util.find_spec({module_name!r}) else 1)"
                ),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0


def _read_seed_vc_audio_data_from_wav(path: Path):
    import numpy as np
    import soundfile as sf

    samples, sample_rate = sf.read(str(path), dtype="int16", always_2d=False)
    if getattr(samples, "ndim", 1) > 1:
        samples = samples.mean(axis=1).astype("int16")
    sample_count = int(len(samples))
    return _seed_vc_audio_data_class()(
        np.asarray(samples, dtype="int16"),
        None,
        sample_count / float(sample_rate) if sample_rate else 0.0,
        sample_count,
        int(sample_rate),
        {},
    )


def _write_seed_vc_audio_data_to_wav(audio_data, path: Path) -> None:
    import numpy as np
    import soundfile as sf

    samples = np.asarray(audio_data.samples)
    sf.write(str(path), samples, int(audio_data.sample_rate), subtype="PCM_16")


def _seed_vc_audio_data_class():
    module = importlib.import_module("seed_vc.Models.audio")
    return module.AudioData


def _file_content_hash(path: Path) -> str:
    digest = hashlib.sha1()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
