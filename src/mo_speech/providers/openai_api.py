from __future__ import annotations

import importlib.util
import json
import mimetypes
import os
import subprocess
import sys
import wave
from base64 import b64decode, b64encode
from io import BytesIO
from dataclasses import dataclass, field
from pathlib import Path
from secrets import token_hex
from time import perf_counter
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from ..pipeline import PipelineProgress, PipelineRequest, PipelineResult, ProgressCallback, SpeechTranslationPipeline, TtsOutput
from .voice import SeedVcVoiceConversionTtsProvider


OPENAI_SUPPORTED_LANGUAGES = (
    ("id-ID", "id", "Indonesian"),
    ("ja-JP", "ja", "Japanese"),
    ("zh-CN", "zh", "Chinese"),
    ("en-US", "en", "English"),
    ("af", "af", "Afrikaans"),
    ("ar", "ar", "Arabic"),
    ("hy", "hy", "Armenian"),
    ("az", "az", "Azerbaijani"),
    ("be", "be", "Belarusian"),
    ("bs", "bs", "Bosnian"),
    ("bg", "bg", "Bulgarian"),
    ("ca", "ca", "Catalan"),
    ("hr", "hr", "Croatian"),
    ("cs", "cs", "Czech"),
    ("da", "da", "Danish"),
    ("nl", "nl", "Dutch"),
    ("et", "et", "Estonian"),
    ("fi", "fi", "Finnish"),
    ("fr", "fr", "French"),
    ("gl", "gl", "Galician"),
    ("de", "de", "German"),
    ("el", "el", "Greek"),
    ("he", "he", "Hebrew"),
    ("hi", "hi", "Hindi"),
    ("hu", "hu", "Hungarian"),
    ("is", "is", "Icelandic"),
    ("it", "it", "Italian"),
    ("kn", "kn", "Kannada"),
    ("kk", "kk", "Kazakh"),
    ("ko", "ko", "Korean"),
    ("lv", "lv", "Latvian"),
    ("lt", "lt", "Lithuanian"),
    ("mk", "mk", "Macedonian"),
    ("ms", "ms", "Malay"),
    ("mr", "mr", "Marathi"),
    ("mi", "mi", "Maori"),
    ("ne", "ne", "Nepali"),
    ("no", "no", "Norwegian"),
    ("fa", "fa", "Persian"),
    ("pl", "pl", "Polish"),
    ("pt", "pt", "Portuguese"),
    ("ro", "ro", "Romanian"),
    ("ru", "ru", "Russian"),
    ("sr", "sr", "Serbian"),
    ("sk", "sk", "Slovak"),
    ("sl", "sl", "Slovenian"),
    ("es", "es", "Spanish"),
    ("sw", "sw", "Swahili"),
    ("sv", "sv", "Swedish"),
    ("tl", "tl", "Tagalog"),
    ("ta", "ta", "Tamil"),
    ("th", "th", "Thai"),
    ("tr", "tr", "Turkish"),
    ("uk", "uk", "Ukrainian"),
    ("ur", "ur", "Urdu"),
    ("vi", "vi", "Vietnamese"),
    ("cy", "cy", "Welsh"),
)

OPENAI_LANGUAGE_CODES = {
    "auto": "",
    **{app_code: api_code for app_code, api_code, _ in OPENAI_SUPPORTED_LANGUAGES},
}

OPENAI_LANGUAGE_NAMES = {
    "auto": "Auto-detected language",
    **{app_code: name for app_code, _, name in OPENAI_SUPPORTED_LANGUAGES},
}

OPENAI_REALTIME_OUTPUT_LANGUAGE_CODES = {
    app_code: api_code for app_code, api_code, _ in OPENAI_SUPPORTED_LANGUAGES
}

OPENAI_SPEECH_TRANSLATION_SOURCE_LANGUAGES = ("auto",) + tuple(
    app_code for app_code, _, _ in OPENAI_SUPPORTED_LANGUAGES
)
OPENAI_SPEECH_TRANSLATION_TARGET_LANGUAGES = tuple(app_code for app_code, _, _ in OPENAI_SUPPORTED_LANGUAGES)
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

OPENAI_PRACTICE_ASR_MODELS = ("gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1")
OPENAI_DEFAULT_PRACTICE_ASR_MODEL = "whisper-1"
OPENAI_TIMESTAMP_ASR_MODELS = {"whisper-1"}
OPENAI_JSON_ONLY_ASR_MODELS = {"gpt-4o-transcribe", "gpt-4o-mini-transcribe"}


@dataclass(frozen=True)
class AsrTranscription:
    text: str
    model: str
    words: list[dict[str, object]] = field(default_factory=list)
    segments: list[dict[str, object]] = field(default_factory=list)
    timestamp_granularities: list[str] = field(default_factory=list)

    @property
    def has_timestamps(self) -> bool:
        return bool(self.words or self.segments)


def supported_openai_practice_asr_model(value: str | None) -> str:
    model = str(value or OPENAI_DEFAULT_PRACTICE_ASR_MODEL).strip() or OPENAI_DEFAULT_PRACTICE_ASR_MODEL
    if model not in OPENAI_PRACTICE_ASR_MODELS:
        raise ValueError(f"unsupported practice ASR model: {model}")
    return model


def _openai_asr_response_format(model: str, requested: str) -> str:
    if model in OPENAI_JSON_ONLY_ASR_MODELS:
        return "json"
    return requested


@dataclass
class OpenAiAsrProvider:
    model: str = field(default_factory=lambda: os.getenv("OPENAI_ASR_MODEL", "gpt-4o-transcribe"))
    response_format: str = "text"
    _client: Any | None = field(default=None, init=False, repr=False)

    @property
    def name(self) -> str:
        return f"openai-asr-{self.model}"

    def transcribe(self, audio_path: Path, source_language: str) -> str:
        return self._transcribe(
            audio_path,
            source_language,
            response_format=_openai_asr_response_format(self.model, self.response_format),
        ).text

    def transcribe_detail(self, audio_path: Path, source_language: str, *, include_timestamps: bool = False) -> AsrTranscription:
        use_timestamps = include_timestamps and self.model in OPENAI_TIMESTAMP_ASR_MODELS
        response_format = "verbose_json" if use_timestamps else _openai_asr_response_format(self.model, self.response_format)
        granularities = ["word", "segment"] if use_timestamps else []
        return self._transcribe(
            audio_path,
            source_language,
            response_format=response_format,
            timestamp_granularities=granularities,
        )

    def _transcribe(
        self,
        audio_path: Path,
        source_language: str,
        *,
        response_format: str,
        timestamp_granularities: list[str] | None = None,
    ) -> AsrTranscription:
        if source_language not in OPENAI_LANGUAGE_CODES:
            raise ValueError(f"OpenAI ASR language is not configured for {source_language}")
        client = self._load_client()
        kwargs = {
            "model": self.model,
            "file": None,
            "response_format": response_format,
        }
        if timestamp_granularities:
            kwargs["timestamp_granularities"] = timestamp_granularities
        if OPENAI_LANGUAGE_CODES[source_language]:
            kwargs["language"] = OPENAI_LANGUAGE_CODES[source_language]
        with audio_path.open("rb") as audio_file:
            kwargs["file"] = audio_file
            try:
                response = client.audio.transcriptions.create(**kwargs)
            except Exception as exc:
                if not _should_retry_asr_with_http(exc):
                    raise
                response = _transcribe_audio_with_http(
                    audio_path,
                    model=self.model,
                    response_format=response_format,
                    language=OPENAI_LANGUAGE_CODES[source_language],
                    timestamp_granularities=timestamp_granularities or [],
                )
        return _asr_transcription_from_response(
            response,
            model=self.model,
            timestamp_granularities=timestamp_granularities or [],
        )

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
            return self.base_tts.synthesize(text, target_language)
        assert self.seed_vc_tts is not None
        return self.seed_vc_tts.synthesize_with_voice(
            text,
            target_language,
            reference_audio_path=reference_audio_path,
            reference_text=reference_text,
            reference_language=reference_language,
            voice_mode=voice_mode,
            voice_settings=voice_settings,
            progress_callback=progress_callback,
        )


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


def openai_realtime_streaming_status() -> dict[str, object]:
    available = True
    reason = ""
    if not os.getenv("OPENAI_API_KEY"):
        available = False
        reason = "OPENAI_API_KEY が設定されていません。"
    model = os.getenv("OPENAI_REALTIME_TRANSLATION_MODEL", "gpt-realtime-translate")
    return {
        "id": "openai_realtime_stream",
        "label": "音声翻訳（OpenAI Realtime streaming）",
        "available": available,
        "reason": reason,
        "providers": {
            "asr": f"openai-realtime-webrtc-input-{model}",
            "translation": f"openai-realtime-webrtc-transcript-{model}",
            "tts": f"openai-realtime-webrtc-audio-{model}",
        },
        "settings": {
            "source_language_mode": "auto",
            "supported_target_languages": list(OPENAI_REALTIME_OUTPUT_LANGUAGE_CODES.keys()),
            "supported_voice_modes": ["default"],
            "streaming": True,
            "text_transform": False,
        },
    }


def create_openai_realtime_translation_client_secret(target_language: str) -> dict[str, object]:
    if target_language not in OPENAI_REALTIME_OUTPUT_LANGUAGE_CODES:
        raise ValueError(f"OpenAI Realtime output language is not configured for {target_language}")
    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required for OpenAI Realtime translation streaming.")
    model = os.getenv("OPENAI_REALTIME_TRANSLATION_MODEL", "gpt-realtime-translate")
    payload = {
        "session": {
            "model": model,
            "audio": {
                "output": {
                    "language": OPENAI_REALTIME_OUTPUT_LANGUAGE_CODES[target_language],
                }
            },
        }
    }
    request = Request(
        "https://api.openai.com/v1/realtime/translations/client_secrets",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}",
            "Content-Type": "application/json",
            "OpenAI-Safety-Identifier": os.getenv("OPENAI_SAFETY_IDENTIFIER", "local-dev-user"),
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=float(os.getenv("OPENAI_REALTIME_TRANSLATION_TIMEOUT_SECONDS", "90"))) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI Realtime client secret request failed: {body}") from exc
    except URLError as exc:
        raise RuntimeError(f"OpenAI Realtime client secret request failed: {exc}") from exc


def _create_openai_client() -> Any:
    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required for OpenAI API backend.")
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError("openai package is required for OpenAI API backend.") from exc
    return OpenAI()


def _should_retry_asr_with_http(exc: Exception) -> bool:
    return "unsupported_format" in str(exc)


def _transcribe_audio_with_http(
    audio_path: Path,
    *,
    model: str,
    response_format: str,
    language: str,
    timestamp_granularities: list[str] | None = None,
) -> Any:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for OpenAI ASR backend.")

    fields = {
        "model": model,
        "response_format": response_format,
    }
    if language:
        fields["language"] = language
    if timestamp_granularities:
        fields["timestamp_granularities[]"] = timestamp_granularities

    body, content_type = _multipart_form_body(fields, audio_path)
    request = Request(
        "https://api.openai.com/v1/audio/transcriptions",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": content_type,
        },
        method="POST",
    )
    timeout = float(os.getenv("OPENAI_API_TIMEOUT_SECONDS", "90"))
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI ASR HTTP request failed: {detail}") from exc
    if response_format == "text":
        return raw.decode("utf-8").strip()
    return json.loads(raw.decode("utf-8"))


def _multipart_form_body(fields: dict[str, str | list[str]], audio_path: Path) -> tuple[bytes, str]:
    boundary = f"mo-speech-{token_hex(16)}"
    content_type = f"multipart/form-data; boundary={boundary}"
    chunks: list[bytes] = []

    def add(value: str) -> None:
        chunks.append(value.encode("utf-8"))

    for name, value in fields.items():
        values = value if isinstance(value, list) else [value]
        for item in values:
            add(f"--{boundary}\r\n")
            add(f'Content-Disposition: form-data; name="{name}"\r\n\r\n')
            add(f"{item}\r\n")

    mime_type = mimetypes.guess_type(audio_path.name)[0] or "application/octet-stream"
    add(f"--{boundary}\r\n")
    add(f'Content-Disposition: form-data; name="file"; filename="{audio_path.name}"\r\n')
    add(f"Content-Type: {mime_type}\r\n\r\n")
    chunks.append(audio_path.read_bytes())
    add("\r\n")
    add(f"--{boundary}--\r\n")
    return b"".join(chunks), content_type


def _asr_transcription_from_response(
    response: Any,
    *,
    model: str,
    timestamp_granularities: list[str],
) -> AsrTranscription:
    return AsrTranscription(
        text=_text_from_response(response),
        model=model,
        words=_normalized_asr_timing_rows(_response_field(response, "words"), text_key="word"),
        segments=_normalized_asr_timing_rows(_response_field(response, "segments"), text_key="text"),
        timestamp_granularities=list(timestamp_granularities),
    )


def _response_field(response: Any, name: str) -> Any:
    if isinstance(response, dict):
        return response.get(name)
    return getattr(response, name, None)


def _normalized_asr_timing_rows(rows: Any, *, text_key: str) -> list[dict[str, object]]:
    normalized: list[dict[str, object]] = []
    for row in rows or []:
        text = _row_field(row, text_key)
        if text is None and text_key == "word":
            text = _row_field(row, "text")
        start = _row_field(row, "start")
        end = _row_field(row, "end")
        try:
            start_f = float(start)
            end_f = float(end)
        except (TypeError, ValueError):
            continue
        if end_f < start_f:
            continue
        normalized.append({"text": str(text or ""), "start": start_f, "end": end_f})
    return normalized


def _row_field(row: Any, name: str) -> Any:
    if isinstance(row, dict):
        return row.get(name)
    return getattr(row, name, None)


def _text_from_response(response: Any) -> str:
    if isinstance(response, str):
        return response.strip()
    if isinstance(response, dict) and response.get("text") is not None:
        return str(response["text"]).strip()
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
