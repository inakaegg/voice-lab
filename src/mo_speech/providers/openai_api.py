from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import wave
from base64 import b64decode, b64encode
from io import BytesIO
from dataclasses import dataclass, field
from pathlib import Path
from time import perf_counter
from typing import Any

from ..pipeline import PipelineProgress, PipelineRequest, PipelineResult, SpeechTranslationPipeline, TtsOutput
from .voice import SeedVcVoiceConversionTtsProvider


OPENAI_LANGUAGE_CODES = {
    "auto": "",
    "id-ID": "id",
    "ja-JP": "ja",
    "zh-CN": "zh",
    "en-US": "en",
}

OPENAI_LANGUAGE_NAMES = {
    "auto": "Auto-detected language",
    "id-ID": "Indonesian",
    "ja-JP": "Japanese",
    "zh-CN": "Simplified Chinese",
    "en-US": "English",
}

OPENAI_REALTIME_OUTPUT_LANGUAGE_CODES = {
    "id-ID": "id",
    "ja-JP": "ja",
    "zh-CN": "zh",
    "en-US": "en",
}

OPENAI_SPEECH_TRANSLATION_SOURCE_LANGUAGES = ("auto", "id-ID", "ja-JP", "zh-CN", "en-US")
OPENAI_SPEECH_TRANSLATION_TARGET_LANGUAGES = ("id-ID", "ja-JP", "zh-CN", "en-US")
OPENAI_SPEECH_TRANSLATION_ROUTES = {
    (source_language, target_language)
    for source_language in OPENAI_SPEECH_TRANSLATION_SOURCE_LANGUAGES
    for target_language in OPENAI_SPEECH_TRANSLATION_TARGET_LANGUAGES
    if source_language == "auto" or source_language != target_language
}

OPENAI_TTS_MIME_TYPES = {
    "mp3": "audio/mpeg",
    "opus": "audio/ogg",
    "aac": "audio/aac",
    "flac": "audio/flac",
    "wav": "audio/wav",
    "pcm": "audio/wav",
}


@dataclass
class OpenAiAsrProvider:
    model: str = field(default_factory=lambda: os.getenv("OPENAI_ASR_MODEL", "gpt-4o-transcribe"))
    response_format: str = "text"
    _client: Any | None = field(default=None, init=False, repr=False)

    @property
    def name(self) -> str:
        return f"openai-asr-{self.model}"

    def transcribe(self, audio_path: Path, source_language: str) -> str:
        if source_language not in OPENAI_LANGUAGE_CODES:
            raise ValueError(f"OpenAI ASR language is not configured for {source_language}")
        client = self._load_client()
        kwargs = {
            "model": self.model,
            "file": None,
            "response_format": self.response_format,
        }
        if OPENAI_LANGUAGE_CODES[source_language]:
            kwargs["language"] = OPENAI_LANGUAGE_CODES[source_language]
        with audio_path.open("rb") as audio_file:
            kwargs["file"] = audio_file
            response = client.audio.transcriptions.create(**kwargs)
        return _text_from_response(response)

    def _load_client(self) -> Any:
        if self._client is None:
            self._client = _create_openai_client()
        return self._client


@dataclass
class OpenAiTranslationProvider:
    model: str = field(default_factory=lambda: os.getenv("OPENAI_TRANSLATION_MODEL", "gpt-5.5"))
    _client: Any | None = field(default=None, init=False, repr=False)

    @property
    def name(self) -> str:
        return f"openai-translation-{self.model}"

    def translate(self, text: str, source_language: str, target_language: str) -> str:
        if source_language not in OPENAI_LANGUAGE_NAMES:
            raise ValueError(f"OpenAI source language is not configured for {source_language}")
        if target_language not in OPENAI_LANGUAGE_NAMES:
            raise ValueError(f"OpenAI target language is not configured for {target_language}")
        if not text.strip():
            return ""

        response = self._load_client().responses.create(
            model=self.model,
            instructions=(
                "You are a professional speech translation engine. "
                "Return only the translated text, with no notes."
            ),
            input=(
                f"Translate the following {OPENAI_LANGUAGE_NAMES[source_language]} conversational transcript "
                f"into natural {OPENAI_LANGUAGE_NAMES[target_language]}.\n"
                "Preserve the intent, politeness, and spoken context.\n\n"
                f"{text}"
            ),
        )
        return _text_from_response(response)

    def _load_client(self) -> Any:
        if self._client is None:
            self._client = _create_openai_client()
        return self._client


@dataclass
class OpenAiTtsProvider:
    model: str = field(default_factory=lambda: os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"))
    voice: str = field(default_factory=lambda: os.getenv("OPENAI_TTS_VOICE", "coral"))
    response_format: str = field(default_factory=lambda: os.getenv("OPENAI_TTS_RESPONSE_FORMAT", "wav"))
    instructions: str = field(
        default_factory=lambda: os.getenv(
            "OPENAI_TTS_INSTRUCTIONS",
            "Speak naturally and clearly in the target language.",
        )
    )
    _client: Any | None = field(default=None, init=False, repr=False)

    supported_voice_modes = ("default",)

    @property
    def name(self) -> str:
        return f"openai-tts-{self.model}"

    @property
    def audio_mime_type(self) -> str:
        return OPENAI_TTS_MIME_TYPES.get(self.response_format, "audio/wav")

    def synthesize(self, text: str, target_language: str) -> TtsOutput:
        if target_language not in OPENAI_LANGUAGE_NAMES:
            raise ValueError(f"OpenAI TTS target language is not configured for {target_language}")
        response = self._load_client().audio.speech.create(
            model=self.model,
            voice=self.voice,
            input=text,
            instructions=self.instructions,
            response_format=self.response_format,
        )
        return TtsOutput(
            audio_bytes=_bytes_from_response(response),
            audio_mime_type=self.audio_mime_type,
        )

    def _load_client(self) -> Any:
        if self._client is None:
            self._client = _create_openai_client()
        return self._client


@dataclass
class OpenAiSeedVcTtsProvider:
    base_tts: OpenAiTtsProvider = field(default_factory=OpenAiTtsProvider)
    seed_vc_tts: SeedVcVoiceConversionTtsProvider | None = None

    supported_voice_modes = ("default", "convert")

    def __post_init__(self) -> None:
        if self.seed_vc_tts is None:
            self.seed_vc_tts = SeedVcVoiceConversionTtsProvider(base_tts=self.base_tts)

    @property
    def name(self) -> str:
        return f"openai-tts-seed-vc-{self.base_tts.model}"

    @property
    def audio_mime_type(self) -> str:
        return "audio/wav"

    def synthesize(self, text: str, target_language: str) -> TtsOutput:
        return self.base_tts.synthesize(text, target_language)

    def synthesize_with_voice(self, *args, **kwargs) -> TtsOutput:
        if kwargs.get("voice_mode") != "convert":
            return self.base_tts.synthesize(args[0], args[1])
        assert self.seed_vc_tts is not None
        return self.seed_vc_tts.synthesize_with_voice(*args, **kwargs)


def create_openai_pipeline() -> SpeechTranslationPipeline:
    pipeline = SpeechTranslationPipeline(
        asr=OpenAiAsrProvider(),
        translator=OpenAiTranslationProvider(),
        tts=OpenAiSeedVcTtsProvider(),
    )
    pipeline.supported_routes = OPENAI_SPEECH_TRANSLATION_ROUTES
    return pipeline


@dataclass(frozen=True)
class _NamedProvider:
    name: str


@dataclass
class OpenAiRealtimeTranslationPipeline:
    model: str = field(default_factory=lambda: os.getenv("OPENAI_REALTIME_TRANSLATION_MODEL", "gpt-realtime-translate"))
    sample_rate: int = field(default_factory=lambda: int(os.getenv("OPENAI_REALTIME_TRANSLATION_SAMPLE_RATE", "24000")))
    timeout_seconds: float = field(default_factory=lambda: float(os.getenv("OPENAI_REALTIME_TRANSLATION_TIMEOUT_SECONDS", "90")))

    supported_voice_modes = ("default",)

    def __post_init__(self) -> None:
        self.asr = _NamedProvider(f"openai-realtime-input-transcript-{self.model}")
        self.translator = _NamedProvider(f"openai-realtime-output-transcript-{self.model}")
        self.tts = _NamedProvider(f"openai-realtime-audio-{self.model}")

    def preload(self) -> None:
        return

    def run(self, request: PipelineRequest, progress_callback=None) -> PipelineResult:
        if request.target_language not in OPENAI_REALTIME_OUTPUT_LANGUAGE_CODES:
            raise ValueError(f"OpenAI Realtime output language is not configured for {request.target_language}")
        if request.voice_mode != "default":
            raise RuntimeError(f"voice_mode={request.voice_mode} is not supported by {self.tts.name}")
        if not request.audio_path.exists():
            raise FileNotFoundError(f"audio file does not exist: {request.audio_path}")
        if not os.getenv("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is required for OpenAI Realtime translation backend.")
        if not _websocket_module_available():
            raise RuntimeError("websocket-client package is required for OpenAI Realtime translation backend.")

        total_started = perf_counter()
        timings_ms: dict[str, float] = {}

        _notify(progress_callback, "asr", "入力音声送信", self.asr.name)
        convert_started = perf_counter()
        pcm16 = _audio_file_to_pcm16(request.audio_path, sample_rate=self.sample_rate, timeout_seconds=self.timeout_seconds)
        timings_ms["audio_prepare"] = _elapsed_ms(convert_started)

        realtime_started = perf_counter()
        input_transcript, output_transcript, output_pcm16 = self._run_realtime_translation(
            pcm16,
            target_language=request.target_language,
        )
        timings_ms["realtime_translation"] = _elapsed_ms(realtime_started)
        timings_ms["asr"] = timings_ms["realtime_translation"]
        timings_ms["translation"] = 0.0
        timings_ms["text_transform"] = 0.0
        timings_ms["tts"] = 0.0
        timings_ms["total"] = _elapsed_ms(total_started)

        _notify(progress_callback, "translation", "翻訳", self.translator.name, transcript=input_transcript)
        _notify(
            progress_callback,
            "tts",
            "翻訳音声受信",
            self.tts.name,
            transcript=input_transcript,
            translated_text=output_transcript,
            transformed_text=output_transcript,
        )
        return PipelineResult(
            transcript=input_transcript,
            translated_text=output_transcript,
            transformed_text=output_transcript,
            output_audio_bytes=_pcm16_to_wav(output_pcm16, sample_rate=self.sample_rate),
            output_audio_mime_type="audio/wav",
            timings_ms=timings_ms,
            providers={
                "asr": self.asr.name,
                "translation": self.translator.name,
                "tts": self.tts.name,
            },
            warnings=[],
        )

    def _run_realtime_translation(self, pcm16: bytes, *, target_language: str) -> tuple[str, str, bytes]:
        import websocket

        ws = websocket.WebSocket()
        ws.connect(
            f"wss://api.openai.com/v1/realtime/translations?model={self.model}",
            header=[
                f"Authorization: Bearer {os.environ['OPENAI_API_KEY']}",
                "OpenAI-Safety-Identifier: local-dev-user",
            ],
            timeout=self.timeout_seconds,
        )
        ws.settimeout(self.timeout_seconds)
        try:
            _send_json(
                ws,
                {
                    "type": "session.update",
                    "session": {
                        "audio": {
                            "output": {
                                "language": OPENAI_REALTIME_OUTPUT_LANGUAGE_CODES[target_language],
                            }
                        }
                    },
                },
            )
            for offset in range(0, len(pcm16), 64_000):
                _send_json(
                    ws,
                    {
                        "type": "session.input_audio_buffer.append",
                        "audio": b64encode(pcm16[offset : offset + 64_000]).decode("ascii"),
                    },
                )
            _send_json(ws, {"type": "session.close"})

            input_transcript_parts: list[str] = []
            output_transcript_parts: list[str] = []
            output_audio_parts: list[bytes] = []
            while True:
                event = _recv_json(ws)
                event_type = str(event.get("type", ""))
                if event_type == "session.output_audio.delta":
                    output_audio_parts.append(b64decode(str(event.get("delta", ""))))
                elif event_type == "session.output_transcript.delta":
                    output_transcript_parts.append(str(event.get("delta", "")))
                elif event_type == "session.input_transcript.delta":
                    input_transcript_parts.append(str(event.get("delta", "")))
                elif event_type == "error":
                    raise RuntimeError(str(event.get("error", event)))
                elif event_type == "session.closed":
                    break
            return (
                "".join(input_transcript_parts).strip(),
                "".join(output_transcript_parts).strip(),
                b"".join(output_audio_parts),
            )
        finally:
            ws.close()


def create_openai_realtime_translation_pipeline() -> OpenAiRealtimeTranslationPipeline:
    return OpenAiRealtimeTranslationPipeline()


def openai_pipeline_status(pipeline: SpeechTranslationPipeline) -> dict[str, object]:
    available = True
    reason = ""
    if not os.getenv("OPENAI_API_KEY"):
        available = False
        reason = "OPENAI_API_KEY が設定されていません。"
    elif not _openai_module_available():
        available = False
        reason = "openai packageがインストールされていません。"
    return {
        "id": "openai",
        "label": "音声翻訳（OpenAI API）",
        "available": available,
        "reason": reason,
        "providers": {
            "asr": pipeline.asr.name,
            "translation": pipeline.translator.name,
            "tts": pipeline.tts.name,
        },
        "settings": {
            "supported_source_languages": list(OPENAI_SPEECH_TRANSLATION_SOURCE_LANGUAGES),
            "supported_target_languages": list(OPENAI_SPEECH_TRANSLATION_TARGET_LANGUAGES),
            "supported_voice_modes": list(getattr(pipeline.tts, "supported_voice_modes", ("default",))),
            "source_language_mode": "specified_or_auto",
            "text_transform": True,
        },
    }


def openai_realtime_pipeline_status(pipeline: OpenAiRealtimeTranslationPipeline) -> dict[str, object]:
    available = True
    reason = ""
    if not os.getenv("OPENAI_API_KEY"):
        available = False
        reason = "OPENAI_API_KEY が設定されていません。"
    elif not _websocket_module_available():
        available = False
        reason = "websocket-client packageがインストールされていません。"
    return {
        "id": "openai_realtime",
        "label": "音声翻訳（OpenAI Realtime）",
        "available": available,
        "reason": reason,
        "providers": {
            "asr": pipeline.asr.name,
            "translation": pipeline.translator.name,
            "tts": pipeline.tts.name,
        },
        "settings": {
            "source_language_mode": "auto",
            "supported_target_languages": list(OPENAI_REALTIME_OUTPUT_LANGUAGE_CODES.keys()),
            "supported_voice_modes": list(pipeline.supported_voice_modes),
            "text_transform": False,
        },
    }


def _create_openai_client() -> Any:
    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required for OpenAI API backend.")
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError("openai package is required for OpenAI API backend.") from exc
    return OpenAI()


def _text_from_response(response: Any) -> str:
    if isinstance(response, str):
        return response.strip()
    output_text = getattr(response, "output_text", None)
    if output_text is not None:
        return str(output_text).strip()
    text = getattr(response, "text", None)
    if text is not None:
        return str(text).strip()
    return str(response).strip()


def _bytes_from_response(response: Any) -> bytes:
    content = getattr(response, "content", None)
    if isinstance(content, bytes):
        return content
    read = getattr(response, "read", None)
    if callable(read):
        data = read()
        if isinstance(data, bytes):
            return data
    if isinstance(response, bytes):
        return response
    return bytes(response)


def _openai_module_available() -> bool:
    if "openai" in sys.modules:
        return True
    return importlib.util.find_spec("openai") is not None


def _websocket_module_available() -> bool:
    if "websocket" in sys.modules:
        return True
    return importlib.util.find_spec("websocket") is not None


def _audio_file_to_pcm16(audio_path: Path, *, sample_rate: int, timeout_seconds: float) -> bytes:
    try:
        completed = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(audio_path),
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-ac",
                "1",
                "-ar",
                str(sample_rate),
                "pipe:1",
            ],
            check=True,
            capture_output=True,
            timeout=timeout_seconds,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("ffmpeg is required for OpenAI Realtime translation backend.") from exc
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"ffmpeg failed to prepare audio: {stderr}") from exc
    return completed.stdout


def _pcm16_to_wav(pcm16: bytes, *, sample_rate: int) -> bytes:
    buffer = BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm16)
    return buffer.getvalue()


def _send_json(ws: Any, payload: dict[str, object]) -> None:
    import json

    ws.send(json.dumps(payload))


def _recv_json(ws: Any) -> dict[str, object]:
    import json

    return json.loads(ws.recv())


def _elapsed_ms(started: float) -> float:
    return (perf_counter() - started) * 1000


def _notify(
    progress_callback,
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
