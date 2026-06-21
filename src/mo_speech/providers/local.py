from __future__ import annotations

import os
import platform
from contextlib import nullcontext
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


WHISPER_LANGUAGE_CODES = {
    "id-ID": "id",
    "ja-JP": "ja",
}

LANGUAGE_DISPLAY_NAMES = {
    "id-ID": "Indonesian",
    "ja-JP": "Japanese",
    "zh-CN": "Simplified Chinese",
}


@dataclass
class FasterWhisperAsrProvider:
    model_name: str = field(default_factory=lambda: os.getenv("FASTER_WHISPER_MODEL", "turbo"))
    cache_dir: Path | None = None
    device: str = field(default_factory=lambda: os.getenv("FASTER_WHISPER_DEVICE", "cpu"))
    compute_type: str | None = field(default_factory=lambda: os.getenv("FASTER_WHISPER_COMPUTE_TYPE"))
    local_files_only: bool = field(default_factory=lambda: _env_bool("FASTER_WHISPER_LOCAL_FILES_ONLY", True))

    def __post_init__(self) -> None:
        if self.cache_dir is None:
            self.cache_dir = resolve_faster_whisper_cache_dir()
        if self.compute_type is None:
            self.compute_type = "float16" if self.device == "cuda" else "int8"
        self._model: Any | None = None

    @property
    def name(self) -> str:
        return f"faster-whisper-{self.model_name}"

    def transcribe(self, audio_path: Path, source_language: str) -> str:
        if source_language not in WHISPER_LANGUAGE_CODES:
            raise ValueError(f"Whisper language is not configured for {source_language}")

        model = self._load_model()
        segments, _info = model.transcribe(
            str(audio_path),
            language=WHISPER_LANGUAGE_CODES[source_language],
            beam_size=5,
            vad_filter=True,
        )
        return "".join(str(segment.text) for segment in segments).strip()

    def preload(self) -> None:
        self._load_model()

    def _load_model(self) -> Any:
        if self._model is not None:
            return self._model

        assert self.cache_dir is not None
        assert self.compute_type is not None

        from faster_whisper import WhisperModel

        self._model = WhisperModel(
            self.model_name,
            device=self.device,
            compute_type=self.compute_type,
            download_root=str(self.cache_dir),
            local_files_only=self.local_files_only,
        )
        return self._model


@dataclass
class Qwen3TranslationProvider:
    model_id: str = field(default_factory=lambda: os.getenv("QWEN_TRANSLATION_MODEL", "Qwen/Qwen3-4B"))
    hub_cache: Path | None = None
    device_map: str = field(default_factory=lambda: os.getenv("QWEN_TRANSLATION_DEVICE_MAP", _default_qwen_translation_device_map()))
    torch_dtype: str = field(default_factory=lambda: os.getenv("QWEN_TRANSLATION_DTYPE", "auto"))
    local_files_only: bool = field(default_factory=lambda: _env_bool("QWEN_TRANSLATION_LOCAL_FILES_ONLY", True))
    max_new_tokens: int = field(default_factory=lambda: _env_int("QWEN_TRANSLATION_MAX_NEW_TOKENS", 256))
    tokenizer: Any | None = None
    model: Any | None = None

    @property
    def name(self) -> str:
        return f"qwen3-translation-{self.model_id}"

    def translate(self, text: str, source_language: str, target_language: str) -> str:
        if source_language not in LANGUAGE_DISPLAY_NAMES:
            raise ValueError(f"Qwen3 source language is not configured for {source_language}")
        if target_language not in LANGUAGE_DISPLAY_NAMES:
            raise ValueError(f"Qwen3 target language is not configured for {target_language}")
        if not text.strip():
            return ""

        tokenizer, model = self._load_model()
        messages = _qwen_translation_messages(text, source_language, target_language)
        prompt = _apply_qwen_chat_template(tokenizer, messages)
        inputs = tokenizer([prompt], return_tensors="pt")
        model_device = _model_device(model)
        if model_device is not None and hasattr(inputs, "to"):
            inputs = inputs.to(model_device)

        input_ids = _input_ids_from_tokenizer_inputs(inputs)
        prompt_token_count = len(input_ids[0])
        generation_kwargs = dict(inputs)
        generation_kwargs.update(max_new_tokens=self.max_new_tokens, do_sample=False)

        context = _torch_no_grad_context()
        with context:
            generated_ids = model.generate(**generation_kwargs)

        output_ids = generated_ids[0][prompt_token_count:]
        if hasattr(output_ids, "tolist"):
            output_ids = output_ids.tolist()
        decoded = tokenizer.decode(output_ids, skip_special_tokens=True)
        return _clean_qwen_translation_output(str(decoded))

    def preload(self) -> None:
        self._load_model()

    def _load_model(self) -> tuple[Any, Any]:
        if self.tokenizer is not None and self.model is not None:
            if hasattr(self.model, "eval"):
                self.model.eval()
            return self.tokenizer, self.model

        from transformers import AutoModelForCausalLM, AutoTokenizer

        model_path: str | Path
        if self.local_files_only:
            model_path = resolve_hf_snapshot_path(self.model_id, hub_cache=self.hub_cache)
        else:
            model_path = self.model_id

        tokenizer_kwargs: dict[str, object] = {"local_files_only": self.local_files_only}
        model_kwargs: dict[str, object] = {
            "local_files_only": self.local_files_only,
            "torch_dtype": self.torch_dtype,
            "device_map": self.device_map,
        }
        if self.hub_cache is not None and not self.local_files_only:
            tokenizer_kwargs["cache_dir"] = str(self.hub_cache)
            model_kwargs["cache_dir"] = str(self.hub_cache)

        self.tokenizer = AutoTokenizer.from_pretrained(model_path, **tokenizer_kwargs)
        self.model = AutoModelForCausalLM.from_pretrained(model_path, **model_kwargs)
        if hasattr(self.model, "eval"):
            self.model.eval()
        return self.tokenizer, self.model


def create_local_asr_provider() -> object:
    provider = os.getenv("MO_ASR_PROVIDER", "faster-whisper")
    if provider in ("faster-whisper", "faster_whisper"):
        return FasterWhisperAsrProvider()
    raise RuntimeError(f"unsupported local ASR provider: {provider}")


def create_local_translation_provider() -> object:
    provider = os.getenv("MO_TRANSLATION_PROVIDER", "qwen3")
    if provider in ("qwen3", "qwen"):
        return Qwen3TranslationProvider()
    raise RuntimeError(f"unsupported local translation provider: {provider}")


def create_local_tts_provider() -> object:
    provider = os.getenv("MO_TTS_PROVIDER")
    if provider == "qwen":
        from .voice import QwenVoiceCloneTtsProvider

        return QwenVoiceCloneTtsProvider()
    if provider == "seed-vc":
        from .voice import SeedVcVoiceConversionTtsProvider

        return SeedVcVoiceConversionTtsProvider(base_tts=_create_qwen_source_tts_provider())
    if provider == "qwen-seed-vc":
        from .voice import QwenSeedVcTtsProvider

        return QwenSeedVcTtsProvider()
    if provider not in (None, ""):
        raise RuntimeError(f"unsupported local TTS provider: {provider}")

    raise RuntimeError("MO_TTS_PROVIDER must be set to qwen, seed-vc, or qwen-seed-vc for local mode.")


def _create_qwen_source_tts_provider() -> object:
    from .voice import QwenVoiceCloneTtsProvider

    return QwenVoiceCloneTtsProvider()


def resolve_faster_whisper_cache_dir() -> Path:
    if cache_dir := os.getenv("FASTER_WHISPER_CACHE_DIR"):
        return Path(cache_dir)
    if model_cache_dir := os.getenv("MODEL_CACHE_DIR"):
        return Path(model_cache_dir) / "faster-whisper"
    return Path.home() / ".cache" / "faster-whisper"


def resolve_hf_hub_cache_dir() -> Path:
    if cache_dir := os.getenv("HF_HUB_CACHE"):
        return Path(cache_dir)
    if model_cache_dir := os.getenv("MODEL_CACHE_DIR"):
        return Path(model_cache_dir) / "huggingface" / "hub"
    if hf_home := os.getenv("HF_HOME"):
        return Path(hf_home) / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def resolve_hf_snapshot_path(model_id: str, *, hub_cache: Path | None = None) -> Path:
    model_path = Path(model_id)
    if model_path.exists():
        return model_path

    cache = hub_cache or resolve_hf_hub_cache_dir()
    repo_cache = cache / f"models--{model_id.replace('/', '--')}"
    refs_main = repo_cache / "refs" / "main"
    if refs_main.exists():
        snapshot = repo_cache / "snapshots" / refs_main.read_text(encoding="utf-8").strip()
        if snapshot.exists():
            return snapshot

    snapshots_dir = repo_cache / "snapshots"
    if snapshots_dir.exists():
        snapshots = sorted((path for path in snapshots_dir.iterdir() if path.is_dir()), key=lambda path: path.name)
        if snapshots:
            return snapshots[-1]

    raise RuntimeError(f"Hugging Face model cache is missing: {model_id}")


def _torch_no_grad_context() -> Any:
    try:
        import torch
    except ImportError:
        return nullcontext()
    return torch.no_grad()


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    return int(value)


def _default_qwen_translation_device_map() -> str:
    if platform.system() == "Darwin":
        return "cpu"
    return "auto"


def _qwen_translation_messages(text: str, source_language: str, target_language: str) -> list[dict[str, str]]:
    source_name = LANGUAGE_DISPLAY_NAMES[source_language]
    target_name = LANGUAGE_DISPLAY_NAMES[target_language]
    return [
        {
            "role": "system",
            "content": "You are a professional speech translation engine. Return only the translated text, with no notes.",
        },
        {
            "role": "user",
            "content": (
                f"Translate the following {source_name} conversational transcript into natural {target_name}.\n"
                "Preserve the intent, politeness, and spoken context.\n\n"
                f"{text}"
            ),
        },
    ]


def _apply_qwen_chat_template(tokenizer: Any, messages: list[dict[str, str]]) -> str:
    try:
        return str(
            tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )
        )
    except TypeError:
        return str(tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True))


def _model_device(model: Any) -> Any | None:
    if hasattr(model, "device"):
        return model.device
    if hasattr(model, "parameters"):
        try:
            return next(model.parameters()).device
        except (StopIteration, TypeError):
            return None
    return None


def _input_ids_from_tokenizer_inputs(inputs: Any) -> Any:
    if hasattr(inputs, "input_ids"):
        return inputs.input_ids
    return inputs["input_ids"]


def _clean_qwen_translation_output(text: str) -> str:
    cleaned = text.strip()
    if "</think>" in cleaned:
        cleaned = cleaned.rsplit("</think>", 1)[1].strip()
    return cleaned.strip('"').strip("“”").strip()
