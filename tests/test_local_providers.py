from __future__ import annotations

import sys
import platform
from pathlib import Path
from types import SimpleNamespace

import pytest

from mo_speech.providers.local import (
    FasterWhisperAsrProvider,
    Qwen3TranslationProvider,
    create_local_asr_provider,
    create_local_translation_provider,
    create_local_tts_provider,
    resolve_hf_snapshot_path,
)
from mo_speech.providers.voice import QwenSeedVcTtsProvider, QwenVoiceCloneTtsProvider, SeedVcVoiceConversionTtsProvider


def test_create_local_tts_provider_requires_explicit_model_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MO_TTS_PROVIDER", raising=False)

    with pytest.raises(RuntimeError, match="MO_TTS_PROVIDER must be set"):
        create_local_tts_provider()


def test_create_local_tts_provider_rejects_command_tts_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MO_TTS_PROVIDER", "command")
    with pytest.raises(RuntimeError, match="unsupported local TTS provider"):
        create_local_tts_provider()


def test_create_local_tts_provider_can_create_qwen_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MO_TTS_PROVIDER", "qwen")

    provider = create_local_tts_provider()

    assert isinstance(provider, QwenVoiceCloneTtsProvider)
    assert provider.supported_voice_modes == ("clone",)


def test_create_local_tts_provider_can_create_seed_vc_wrapper(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MO_TTS_PROVIDER", "seed-vc")

    provider = create_local_tts_provider()

    assert isinstance(provider, SeedVcVoiceConversionTtsProvider)
    assert isinstance(provider.base_tts, QwenVoiceCloneTtsProvider)
    assert provider.supported_voice_modes == ("convert",)


def test_create_local_tts_provider_can_create_qwen_seed_vc_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MO_TTS_PROVIDER", "qwen-seed-vc")

    provider = create_local_tts_provider()

    assert isinstance(provider, QwenSeedVcTtsProvider)
    assert provider.supported_voice_modes == ("clone", "convert")


def test_create_local_asr_provider_defaults_to_faster_whisper(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MO_ASR_PROVIDER", raising=False)

    provider = create_local_asr_provider()

    assert isinstance(provider, FasterWhisperAsrProvider)
    assert provider.name == "faster-whisper-turbo"


def test_create_local_asr_provider_rejects_openai_whisper(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MO_ASR_PROVIDER", "openai-whisper")

    with pytest.raises(RuntimeError, match="unsupported local ASR provider"):
        create_local_asr_provider()


def test_create_local_translation_provider_defaults_to_qwen3(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MO_TRANSLATION_PROVIDER", raising=False)

    provider = create_local_translation_provider()

    assert isinstance(provider, Qwen3TranslationProvider)
    assert provider.name == "qwen3-translation-Qwen/Qwen3-4B"


def test_create_local_translation_provider_rejects_nllb(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MO_TRANSLATION_PROVIDER", "nllb")

    with pytest.raises(RuntimeError, match="unsupported local translation provider"):
        create_local_translation_provider()


def test_faster_whisper_transcribes_with_language_code(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    audio_path = tmp_path / "input.wav"
    audio_path.write_bytes(b"audio")
    captured: dict[str, object] = {}

    class FakeSegment:
        def __init__(self, text: str) -> None:
            self.text = text
            self.start = 0.0
            self.end = 1.0
            self.words = []

    class FakeWhisperModel:
        def __init__(
            self,
            model_name: str,
            *,
            device: str,
            compute_type: str,
            download_root: str,
            local_files_only: bool,
        ) -> None:
            captured["model_name"] = model_name
            captured["device"] = device
            captured["compute_type"] = compute_type
            captured["download_root"] = download_root
            captured["local_files_only"] = local_files_only

        def transcribe(
            self,
            path: str,
            *,
            language: str,
            beam_size: int,
            vad_filter: bool,
            word_timestamps: bool,
        ) -> tuple[list[FakeSegment], object]:
            captured["path"] = path
            captured["language"] = language
            captured["beam_size"] = beam_size
            captured["vad_filter"] = vad_filter
            captured["word_timestamps"] = word_timestamps
            return [FakeSegment(" Selamat "), FakeSegment("pagi. ")], object()

    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=FakeWhisperModel))

    provider = FasterWhisperAsrProvider(
        model_name="turbo",
        cache_dir=tmp_path,
        device="cpu",
        compute_type="int8",
        local_files_only=True,
    )

    assert provider.transcribe(audio_path, "id-ID") == "Selamat pagi."
    assert captured == {
        "model_name": "turbo",
        "device": "cpu",
        "compute_type": "int8",
        "download_root": str(tmp_path),
        "local_files_only": True,
        "path": str(audio_path),
        "language": "id",
        "beam_size": 5,
        "vad_filter": True,
        "word_timestamps": False,
    }


def test_faster_whisper_transcribe_detail_returns_segments_and_words(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    audio_path = tmp_path / "input.wav"
    audio_path.write_bytes(b"audio")
    captured: dict[str, object] = {}

    class FakeWord:
        word = "hello"
        start = 0.1
        end = 0.4

    class FakeSegment:
        text = " hello"
        start = 0.0
        end = 0.5
        words = [FakeWord()]

    class FakeWhisperModel:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def transcribe(self, path: str, **kwargs) -> tuple[list[FakeSegment], object]:
            captured.update(kwargs)
            captured["path"] = path
            return [FakeSegment()], object()

    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=FakeWhisperModel))
    provider = FasterWhisperAsrProvider(model_name="turbo", cache_dir=tmp_path)

    result = provider.transcribe_detail(audio_path, "auto", include_timestamps=True)

    assert result.text == "hello"
    assert result.segments == [{"text": " hello", "start": 0.0, "end": 0.5}]
    assert result.words == [{"text": "hello", "start": 0.1, "end": 0.4}]
    assert result.timestamp_granularities == ["word", "segment"]
    assert captured["word_timestamps"] is True
    assert "language" not in captured


def test_qwen3_translation_builds_prompt_and_decodes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    hub_cache = tmp_path / "hub"
    model_cache = hub_cache / "models--Qwen--Qwen3-4B"
    snapshot = model_cache / "snapshots" / "abc123"
    snapshot.mkdir(parents=True)
    refs = model_cache / "refs"
    refs.mkdir()
    (refs / "main").write_text("abc123", encoding="utf-8")
    captured: dict[str, object] = {}

    class FakeInputs(dict):
        @property
        def input_ids(self) -> list[list[int]]:
            return self["input_ids"]

        def to(self, device: str) -> "FakeInputs":
            captured["inputs_device"] = device
            return self

    class FakeTokenizer:
        @staticmethod
        def from_pretrained(model_path: Path, *, local_files_only: bool) -> "FakeTokenizer":
            captured["tokenizer_path"] = model_path
            captured["tokenizer_local_only"] = local_files_only
            return FakeTokenizer()

        def apply_chat_template(
            self,
            messages: list[dict[str, str]],
            *,
            tokenize: bool,
            add_generation_prompt: bool,
            enable_thinking: bool,
        ) -> str:
            captured["messages"] = messages
            captured["tokenize"] = tokenize
            captured["add_generation_prompt"] = add_generation_prompt
            captured["enable_thinking"] = enable_thinking
            return "CHAT_PROMPT"

        def __call__(self, texts: list[str], *, return_tensors: str) -> FakeInputs:
            captured["texts"] = texts
            captured["return_tensors"] = return_tensors
            return FakeInputs(input_ids=[[10, 11, 12]])

        def decode(self, token_ids: list[int], *, skip_special_tokens: bool) -> str:
            captured["decoded_ids"] = token_ids
            captured["skip_special_tokens"] = skip_special_tokens
            return "\nすみません、ちょっと失礼します。\n"

    class FakeModel:
        device = "cpu"

        def generate(self, **kwargs: object) -> list[list[int]]:
            captured["generate_kwargs"] = kwargs
            return [[10, 11, 12, 20, 21]]

        def eval(self) -> None:
            captured["eval"] = True

    class FakeAutoModel:
        @staticmethod
        def from_pretrained(
            model_path: Path,
            *,
            local_files_only: bool,
            torch_dtype: str,
            device_map: str,
        ) -> FakeModel:
            captured["model_path"] = model_path
            captured["model_local_only"] = local_files_only
            captured["torch_dtype"] = torch_dtype
            captured["device_map"] = device_map
            return FakeModel()

    monkeypatch.setitem(
        sys.modules,
        "transformers",
        SimpleNamespace(AutoModelForCausalLM=FakeAutoModel, AutoTokenizer=FakeTokenizer),
    )

    provider = Qwen3TranslationProvider(hub_cache=hub_cache, max_new_tokens=64)

    assert provider.translate("Maaf pak, saya permisi dulu", "id-ID", "ja-JP") == "すみません、ちょっと失礼します。"
    assert captured["tokenizer_path"] == snapshot
    assert captured["model_path"] == snapshot
    assert captured["model_local_only"] is True
    assert captured["torch_dtype"] == "auto"
    assert captured["device_map"] == ("cpu" if platform.system() == "Darwin" else "auto")
    assert captured["messages"] == [
        {
            "role": "system",
            "content": "You are a professional speech translation engine. Return only the translated text, with no notes.",
        },
        {
            "role": "user",
            "content": (
                "Translate the following Indonesian conversational transcript into natural Japanese.\n"
                "Preserve the intent, politeness, and spoken context.\n\n"
                "Maaf pak, saya permisi dulu"
            ),
        },
    ]
    assert captured["enable_thinking"] is False
    assert captured["texts"] == ["CHAT_PROMPT"]
    assert captured["generate_kwargs"] == {
        "input_ids": [[10, 11, 12]],
        "max_new_tokens": 64,
        "do_sample": False,
    }
    assert captured["decoded_ids"] == [20, 21]


def test_resolve_hf_snapshot_path_uses_ref(tmp_path: Path) -> None:
    hub_cache = tmp_path / "hub"
    model_cache = hub_cache / "models--Qwen--Qwen3-4B"
    snapshot = model_cache / "snapshots" / "abc123"
    snapshot.mkdir(parents=True)
    refs = model_cache / "refs"
    refs.mkdir()
    (refs / "main").write_text("abc123", encoding="utf-8")

    assert resolve_hf_snapshot_path("Qwen/Qwen3-4B", hub_cache=hub_cache) == snapshot
