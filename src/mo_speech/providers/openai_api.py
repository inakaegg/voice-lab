from __future__ import annotations

import json
import mimetypes
import os
from dataclasses import dataclass, field
from pathlib import Path
from secrets import token_hex
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from ..pipeline import SpeechProviderBundle, TtsOutput


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
    model: str = field(default_factory=lambda: os.getenv("OPENAI_TRANSLATION_MODEL", "gpt-5.6-terra"))
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



def create_openai_provider_bundle() -> SpeechProviderBundle:
    return SpeechProviderBundle(
        asr=OpenAiAsrProvider(),
        translator=OpenAiTranslationProvider(),
        tts=OpenAiTtsProvider(),
    )


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
