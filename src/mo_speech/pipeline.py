from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from pathlib import Path
from time import perf_counter
from typing import Callable, Protocol

from .transforms import apply_text_transform


SUPPORTED_ROUTES = {
    ("id-ID", "ja-JP"),
    ("ja-JP", "zh-CN"),
}

SUPPORTED_VOICE_MODES = {
    "default",
    "clone",
    "convert",
}


class AsrProvider(Protocol):
    name: str

    def transcribe(self, audio_path: Path, source_language: str) -> str:
        raise NotImplementedError


class TranslationProvider(Protocol):
    name: str

    def translate(self, text: str, source_language: str, target_language: str) -> str:
        raise NotImplementedError


class TtsProvider(Protocol):
    name: str
    audio_mime_type: str

    def synthesize(self, text: str, target_language: str) -> bytes | "TtsOutput":
        raise NotImplementedError


@dataclass(frozen=True)
class PipelineProgress:
    stage: str
    label: str
    provider: str
    transcript: str | None = None
    translated_text: str | None = None
    transformed_text: str | None = None


ProgressCallback = Callable[[PipelineProgress], None]


@dataclass(frozen=True)
class TtsOutput:
    audio_bytes: bytes
    audio_mime_type: str | None = None
    timings_ms: dict[str, float] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class PipelineRequest:
    audio_path: Path
    source_language: str
    target_language: str
    voice_mode: str = "default"
    text_transform: str | None = None
    text_transform_options: dict[str, str] = field(default_factory=dict)
    voice_settings: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class PipelineResult:
    transcript: str
    translated_text: str
    transformed_text: str
    output_audio_bytes: bytes
    output_audio_mime_type: str
    timings_ms: dict[str, float]
    providers: dict[str, str]
    warnings: list[str] = field(default_factory=list)


class SpeechTranslationPipeline:
    def __init__(self, *, asr: AsrProvider, translator: TranslationProvider, tts: TtsProvider) -> None:
        self.asr = asr
        self.translator = translator
        self.tts = tts

    def preload(self) -> None:
        for provider in (self.asr, self.translator, self.tts):
            preload = getattr(provider, "preload", None)
            if preload is not None:
                preload()

    def run(self, request: PipelineRequest, progress_callback: ProgressCallback | None = None) -> PipelineResult:
        total_started = perf_counter()
        route = (request.source_language, request.target_language)
        supported_routes = getattr(self, "supported_routes", SUPPORTED_ROUTES)
        if route not in supported_routes:
            raise ValueError(f"unsupported route: {request.source_language} -> {request.target_language}")
        if request.voice_mode not in SUPPORTED_VOICE_MODES:
            raise ValueError(f"unsupported voice mode: {request.voice_mode}")
        if request.voice_mode not in _provider_supported_voice_modes(self.tts):
            raise RuntimeError(f"voice_mode={request.voice_mode} is not supported by {self.tts.name}")
        if not request.audio_path.exists():
            raise FileNotFoundError(f"audio file does not exist: {request.audio_path}")

        timings_ms: dict[str, float] = {}

        started = perf_counter()
        _notify_progress(progress_callback, "asr", "文字起こし", self.asr.name)
        transcript = self.asr.transcribe(request.audio_path, request.source_language)
        timings_ms["asr"] = _elapsed_ms(started)

        started = perf_counter()
        _notify_progress(
            progress_callback,
            "translation",
            "翻訳",
            self.translator.name,
            transcript=transcript,
        )
        translated_text = self.translator.translate(
            transcript,
            request.source_language,
            request.target_language,
        )
        timings_ms["translation"] = _elapsed_ms(started)

        started = perf_counter()
        _notify_progress(
            progress_callback,
            "text_transform",
            "テキスト加工",
            request.text_transform or "なし",
            transcript=transcript,
            translated_text=translated_text,
        )
        transformed_text = apply_text_transform(
            translated_text,
            request.text_transform,
            request.text_transform_options,
        )
        timings_ms["text_transform"] = _elapsed_ms(started)

        warnings: list[str] = []

        started = perf_counter()
        _notify_progress(
            progress_callback,
            "tts",
            "音声生成",
            self.tts.name,
            transcript=transcript,
            translated_text=translated_text,
            transformed_text=transformed_text,
        )
        if request.voice_mode == "default":
            tts_output = _normalize_tts_output(self.tts.synthesize(transformed_text, request.target_language))
        else:
            synthesize_with_voice = getattr(self.tts, "synthesize_with_voice", None)
            if synthesize_with_voice is None:
                raise RuntimeError(f"voice_mode={request.voice_mode} is not supported by {self.tts.name}")
            tts_output = _normalize_tts_output(
                _call_synthesize_with_voice(
                    synthesize_with_voice,
                    self.tts.name,
                    transformed_text,
                    request.target_language,
                    reference_audio_path=request.audio_path,
                    reference_text=transcript,
                    reference_language=request.source_language,
                    voice_mode=request.voice_mode,
                    voice_settings=request.voice_settings,
                    progress_callback=progress_callback,
                )
            )
        tts_elapsed = _elapsed_ms(started)
        timings_ms.update(tts_output.timings_ms)
        timings_ms.setdefault("tts", tts_elapsed)
        timings_ms["total"] = _elapsed_ms(total_started)
        warnings.extend(tts_output.warnings)

        return PipelineResult(
            transcript=transcript,
            translated_text=translated_text,
            transformed_text=transformed_text,
            output_audio_bytes=tts_output.audio_bytes,
            output_audio_mime_type=tts_output.audio_mime_type or self.tts.audio_mime_type,
            timings_ms=timings_ms,
            providers={
                "asr": self.asr.name,
                "translation": self.translator.name,
                "tts": self.tts.name,
            },
            warnings=warnings,
        )


def _elapsed_ms(started: float) -> float:
    return (perf_counter() - started) * 1000


def _notify_progress(
    progress_callback: ProgressCallback | None,
    stage: str,
    label: str,
    provider: str,
    *,
    transcript: str | None = None,
    translated_text: str | None = None,
    transformed_text: str | None = None,
) -> None:
    if progress_callback is not None:
        progress_callback(
            PipelineProgress(
                stage=stage,
                label=label,
                provider=provider,
                transcript=transcript,
                translated_text=translated_text,
                transformed_text=transformed_text,
            )
        )


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


def _provider_supported_voice_modes(tts: TtsProvider) -> tuple[str, ...]:
    return tuple(getattr(tts, "supported_voice_modes", ("default",)))


def _normalize_tts_output(output: bytes | TtsOutput) -> TtsOutput:
    if isinstance(output, TtsOutput):
        return output
    return TtsOutput(audio_bytes=output)
