#!/usr/bin/env python3

"""
VibeVoice ダイレクト実装
ComfyUIを経由せずに直接VibeVoiceを使用して音声生成を行います

使用方法:
    python vibevoice.py --text_file <ファイル> --voice1_file <ファイル> [オプション]
    python vibevoice.py -t script.txt -a voice1.mp3 --output /path/to/output/dir/
    python vibevoice.py -t script.txt -a voice1.mp3 -b voice2.mp3 --output result.wav
"""

import os
import sys
import re
import argparse
import logging
import glob
import math
import random
import json
import hashlib
import shutil
import types
import zipfile
import inspect
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Dict, Any, Tuple

import torch
import numpy as np
import librosa
import soundfile as sf
import transformers
from packaging import version
from transformers.generation import LogitsProcessor, LogitsProcessorList

from huggingface_hub import hf_hub_download, snapshot_download


# Configure logging early so helper utilities can emit messages
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Transformers version compatibility check (same as ComfyUI)
_transformers_version = version.parse(transformers.__version__)
_DTYPE_ARG_SUPPORTED = _transformers_version >= version.parse("4.56.0")


def _resolve_vibevoice_home() -> Path:
    """Resolve storage root for Hugging Face caches used by VibeVoice."""
    env_value = os.getenv("VIBEVOICE_HOME")
    if env_value:
        path = Path(env_value).expanduser()
    else:
        default_base = Path(os.getenv("HF_HOME", Path.home() / ".cache" / "huggingface"))
        path = (default_base / "hub").expanduser()
        os.environ["VIBEVOICE_HOME"] = str(path)
        logger.info(f"VIBEVOICE_HOME環境変数が設定されていなかったため、{path} を使用します")
    path.mkdir(parents=True, exist_ok=True)
    return path


def _resolve_comfyui_vibevoice_path(search_dirs: Optional[List[Path]] = None) -> Optional[Path]:
    env_value = os.getenv("COMFYUI_VIBEVOICE_PATH")
    if env_value:
        env_path = Path(env_value).expanduser()
        if env_path.is_dir():
            return env_path
        raise FileNotFoundError(f"COMFYUI_VIBEVOICE_PATHで指定されたディレクトリが存在しません: {env_path}")

    if search_dirs is None:
        script_dir = Path(__file__).resolve().parent
        repo_root = script_dir.parents[2]
        search_dirs = [
            script_dir / "ComfyUI-VibeVoice-1.4.1",
            repo_root / "ComfyUI-VibeVoice-1.4.1",
        ]

    for candidate in search_dirs:
        candidate_path = candidate.expanduser()
        if candidate_path.is_dir():
            return candidate_path
    return None


_VIBEVOICE_COMPONENTS: Optional[Tuple[Any, Any, Any, Any]] = None
VIBEVOICE_MIN_NEW_TOKENS = 32
VIBEVOICE_MAX_NEW_TOKENS = 768
VIBEVOICE_TEXT_CHAR_TOKEN_RATIO = 1.6
VIBEVOICE_LINE_TOKEN_OVERHEAD = 6
VIBEVOICE_MIN_AUDIO_TEXT_CHAR_TOKEN_RATIO = 1.0
VIBEVOICE_MIN_AUDIO_LINE_TOKEN_OVERHEAD = 4
VIBEVOICE_STOP_TOKEN_MARGIN = 4
VIBEVOICE_REFERENCE_PREPROCESS_VERSION = "reference-normalization-v1"
VIBEVOICE_REFERENCE_TRIM_TOP_DB = 35.0
VIBEVOICE_REFERENCE_TARGET_RMS = 10 ** (-20.0 / 20.0)
VIBEVOICE_REFERENCE_PEAK_LIMIT = 0.95
VIBEVOICE_REFERENCE_MIN_RMS = 1e-5
VIBEVOICE_REFERENCE_MAX_GAIN = 12.0
GENERATION_CONFIG_MODE_EXPLICIT = "explicit"
GENERATION_CONFIG_MODE_MODEL_DEFAULT = "model_default"
_MIN_AUDIO_TOKENS_OVERRIDE: ContextVar[int | None] = ContextVar(
    "_MIN_AUDIO_TOKENS_OVERRIDE",
    default=None,
)


def _install_transformers_qwen2_fast_alias() -> None:
    """Provide the legacy qwen2 fast tokenizer module path for newer Transformers."""

    module_name = "transformers.models.qwen2.tokenization_qwen2_fast"
    if module_name in sys.modules:
        return
    try:
        __import__(module_name)
        return
    except ModuleNotFoundError as exc:
        if exc.name != module_name:
            return
    try:
        from transformers import Qwen2TokenizerFast
    except ImportError:
        return
    module = types.ModuleType(module_name)
    module.Qwen2TokenizerFast = Qwen2TokenizerFast
    sys.modules[module_name] = module


def _parse_script_1_based(script: str) -> Tuple[List[Tuple[int, str]], List[int]]:
    """Parse a 1-based speaker script into model-internal 0-based speaker ids."""

    parsed_lines: List[Tuple[int, str]] = []
    speaker_ids_in_script: List[int] = []

    for line in script.strip().split("\n"):
        if not (line := line.strip()):
            continue

        match = re.match(r"^Speaker\s+(\d+)\s*:\s*(.*)$", line, re.IGNORECASE)
        if match:
            speaker_id = int(match.group(1))
            if speaker_id < 1:
                logger.warning(f"Speaker IDは1以上である必要があります。スキップします: '{line}'")
                continue

            text = " " + match.group(2).strip()
            parsed_lines.append((speaker_id - 1, text))

            if speaker_id not in speaker_ids_in_script:
                speaker_ids_in_script.append(speaker_id)
        else:
            logger.warning(f"行をパースできませんでした。スキップします: '{line}'")

    return parsed_lines, sorted(list(set(speaker_ids_in_script)))


def _estimate_vibevoice_max_new_tokens(script: str) -> int:
    """Estimate a speech-token upper bound from script text, not prompt length."""

    parsed_lines, _speaker_ids = _parse_script_1_based(script)
    if not parsed_lines:
        return VIBEVOICE_MIN_NEW_TOKENS

    text_char_count = sum(len(text.strip()) for _speaker_id, text in parsed_lines)
    estimated_tokens = math.ceil(
        text_char_count * VIBEVOICE_TEXT_CHAR_TOKEN_RATIO
        + len(parsed_lines) * VIBEVOICE_LINE_TOKEN_OVERHEAD
    )
    return max(VIBEVOICE_MIN_NEW_TOKENS, min(VIBEVOICE_MAX_NEW_TOKENS, estimated_tokens))


def _reference_preprocess_cache_key() -> str:
    return (
        f"{VIBEVOICE_REFERENCE_PREPROCESS_VERSION}:"
        f"sr={SAMPLE_RATE}:"
        f"trim_db={VIBEVOICE_REFERENCE_TRIM_TOP_DB:g}:"
        f"target_rms={VIBEVOICE_REFERENCE_TARGET_RMS:.6f}:"
        f"peak={VIBEVOICE_REFERENCE_PEAK_LIMIT:g}:"
        f"max_gain={VIBEVOICE_REFERENCE_MAX_GAIN:g}"
    )


def _trim_reference_silence(waveform: np.ndarray, sample_rate: int, audio_path: str) -> np.ndarray:
    if waveform.size == 0 or np.all(waveform == 0):
        return waveform
    try:
        trimmed, trim_index = librosa.effects.trim(waveform, top_db=VIBEVOICE_REFERENCE_TRIM_TOP_DB)
    except Exception as exc:
        logger.warning("参照音声の無音トリムに失敗したため元波形を使います: %s (%s)", audio_path, exc)
        return waveform
    if trimmed.size == 0:
        logger.warning("参照音声の無音トリム後に空になったため元波形を使います: %s", audio_path)
        return waveform

    removed_before = int(trim_index[0])
    removed_after = int(waveform.shape[0] - trim_index[1])
    if removed_before > 0 or removed_after > 0:
        logger.info(
            "参照音声の前後無音をトリムしました: %s (start=%.2fs, end=%.2fs)",
            audio_path,
            removed_before / sample_rate,
            removed_after / sample_rate,
        )
    return np.asarray(trimmed, dtype=np.float32)


def _normalize_reference_loudness(waveform: np.ndarray, audio_path: str) -> np.ndarray:
    if waveform.size == 0:
        return waveform.astype(np.float32)

    normalized = np.asarray(waveform, dtype=np.float32)
    if np.any(np.isnan(normalized)) or np.any(np.isinf(normalized)):
        logger.error("参照音声にNaNまたはInf値が含まれています。ゼロで置き換えます: %s", audio_path)
        normalized = np.nan_to_num(normalized, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)

    peak = float(np.max(np.abs(normalized))) if normalized.size else 0.0
    if peak <= 0.0:
        logger.warning("参照音声が完全に無音です: %s", audio_path)
        return normalized.astype(np.float32)

    normalized = normalized - float(np.mean(normalized))
    peak = float(np.max(np.abs(normalized))) if normalized.size else 0.0
    rms = float(np.sqrt(np.mean(np.square(normalized), dtype=np.float64))) if normalized.size else 0.0
    if peak <= 0.0 or rms <= VIBEVOICE_REFERENCE_MIN_RMS:
        logger.warning("参照音声の有効音量が小さすぎるため音量正規化をスキップします: %s", audio_path)
        return normalized.astype(np.float32)

    target_gain = VIBEVOICE_REFERENCE_TARGET_RMS / rms
    peak_limited_gain = VIBEVOICE_REFERENCE_PEAK_LIMIT / peak
    gain = min(target_gain, peak_limited_gain, VIBEVOICE_REFERENCE_MAX_GAIN)
    if not math.isfinite(gain) or gain <= 0:
        logger.warning("参照音声の音量正規化gainが不正なためスキップします: %s", audio_path)
        return normalized.astype(np.float32)

    normalized = normalized * gain
    normalized = np.clip(normalized, -VIBEVOICE_REFERENCE_PEAK_LIMIT, VIBEVOICE_REFERENCE_PEAK_LIMIT)
    logger.info(
        "参照音声を音量正規化しました: %s (rms %.4f -> %.4f, peak %.4f -> %.4f, gain %.3f)",
        audio_path,
        rms,
        float(np.sqrt(np.mean(np.square(normalized), dtype=np.float64))),
        peak,
        float(np.max(np.abs(normalized))) if normalized.size else 0.0,
        gain,
    )
    return normalized.astype(np.float32)


def _resolve_generation_config_mode() -> str:
    raw_value = os.getenv("VIBEVOICE_GENERATION_CONFIG_MODE", GENERATION_CONFIG_MODE_EXPLICIT)
    normalized = str(raw_value or "").strip().lower().replace("-", "_")
    if not normalized:
        return GENERATION_CONFIG_MODE_EXPLICIT
    if normalized in {GENERATION_CONFIG_MODE_EXPLICIT, "manual"}:
        return GENERATION_CONFIG_MODE_EXPLICIT
    if normalized in {GENERATION_CONFIG_MODE_MODEL_DEFAULT, "default", "model"}:
        return GENERATION_CONFIG_MODE_MODEL_DEFAULT
    raise ValueError(f"unsupported VIBEVOICE_GENERATION_CONFIG_MODE: {raw_value}")


def _callable_has_explicit_parameter(callable_obj: Any, parameter_name: str) -> bool:
    try:
        signature = inspect.signature(callable_obj)
    except (TypeError, ValueError):
        return False
    return parameter_name in signature.parameters


def _processor_supports_parsed_scripts(processor: Any) -> bool:
    call_method = getattr(processor, "__call__", None)
    if call_method is None:
        return False
    return _callable_has_explicit_parameter(
        call_method, "parsed_scripts"
    ) and _callable_has_explicit_parameter(call_method, "speaker_ids_for_prompt")


def _resolve_min_audio_tokens() -> int:
    override = _MIN_AUDIO_TOKENS_OVERRIDE.get()
    if override is not None:
        return max(0, int(override))
    return _resolve_configured_min_audio_tokens()


def _resolve_configured_min_audio_tokens() -> int:
    raw_value = os.getenv("VIBEVOICE_MIN_AUDIO_TOKENS", "0")
    try:
        return max(0, int(str(raw_value or "0").strip()))
    except ValueError as exc:
        raise ValueError(f"unsupported VIBEVOICE_MIN_AUDIO_TOKENS: {raw_value}") from exc


def _estimate_vibevoice_min_audio_tokens(
    script: str,
    *,
    configured_min_audio_tokens: int,
    max_new_tokens: int,
) -> int:
    configured_min = max(0, int(configured_min_audio_tokens))
    if configured_min == 0:
        return 0

    parsed_lines, _speaker_ids = _parse_script_1_based(script)
    if not parsed_lines:
        return configured_min

    text_char_count = sum(len(text.strip()) for _speaker_id, text in parsed_lines)
    estimated = math.ceil(
        text_char_count * VIBEVOICE_MIN_AUDIO_TEXT_CHAR_TOKEN_RATIO
        + len(parsed_lines) * VIBEVOICE_MIN_AUDIO_LINE_TOKEN_OVERHEAD
    )
    upper_bound = max(configured_min, max(0, int(max_new_tokens) - VIBEVOICE_STOP_TOKEN_MARGIN))
    return max(configured_min, min(upper_bound, estimated))


def _patch_vibevoice_token_constraint_processor_for_safe_sampling(processor_cls: Any) -> None:
    """Make ComfyUI-VibeVoice's internal token mask safe for sampling.

    wildminder/ComfyUI-VibeVoice builds its own LogitsProcessorList inside
    generate(), so processors passed through model.generate() are overwritten.
    Patch the internal final constraint processor instead.
    """

    if processor_cls is None or getattr(processor_cls, "_mo_safe_sampling_patch", False):
        return
    original_init = getattr(processor_cls, "__init__", None)
    original_call = getattr(processor_cls, "__call__", None)
    if not callable(original_init) or not callable(original_call):
        return

    def patched_init(self, valid_token_ids, device=None, *args, **kwargs):
        self._mo_valid_token_ids_order = [int(token_id) for token_id in valid_token_ids]
        return original_init(self, valid_token_ids, device=device, *args, **kwargs)

    def patched_call(self, input_ids: torch.LongTensor, scores: torch.FloatTensor) -> torch.FloatTensor:
        constrained = original_call(self, input_ids, scores)
        if not isinstance(constrained, torch.Tensor) or not constrained.is_floating_point():
            return constrained
        valid_ids = getattr(self, "valid_token_ids", None)
        if not isinstance(valid_ids, torch.Tensor):
            return constrained

        valid_ids = valid_ids.to(device=constrained.device, dtype=torch.long).flatten()
        if valid_ids.numel() == 0:
            return constrained
        vocab_size = constrained.shape[-1]
        valid_ids = valid_ids[(valid_ids >= 0) & (valid_ids < vocab_size)]
        if valid_ids.numel() == 0:
            return constrained

        fixed = constrained.clone()
        limit = min(float(torch.finfo(fixed.dtype).max / 4), 1.0e4)
        valid_scores = fixed.index_select(-1, valid_ids)
        valid_scores = torch.nan_to_num(valid_scores, nan=-limit, posinf=limit, neginf=-limit)
        fixed[:, valid_ids] = valid_scores

        token_order = list(getattr(self, "_mo_valid_token_ids_order", []))
        min_audio_tokens = _resolve_min_audio_tokens()
        fallback_token_id = int(valid_ids[0].item())
        if len(token_order) >= 3:
            fallback_token_id = int(token_order[2])
        prompt_length = getattr(self, "_mo_prompt_length", None)
        if prompt_length is None:
            prompt_length = int(input_ids.shape[-1])
            self._mo_prompt_length = prompt_length
        if not getattr(self, "_mo_safe_sampling_logged", False):
            input_tail = input_ids[0, -8:].detach().cpu().tolist() if input_ids.numel() else []
            logger.info(
                "VibeVoice token制約patch初回: valid_token_ids=%s min_audio_tokens=%d fallback_token_id=%d prompt_length=%d input_tail=%s",
                token_order,
                min_audio_tokens,
                fallback_token_id,
                prompt_length,
                input_tail,
            )
            self._mo_safe_sampling_logged = True
        if min_audio_tokens > 0 and len(token_order) >= 3:
            speech_diffusion_id = int(token_order[2])
            generated_input_ids = input_ids[:, int(prompt_length) :]
            audio_token_counts = (generated_input_ids == speech_diffusion_id).sum(dim=1)
            needs_audio = audio_token_counts < min_audio_tokens
            blocked_token_ids = []
            for index in (0, 1, 3, 4):
                if index < len(token_order):
                    token_id = int(token_order[index])
                    if 0 <= token_id < vocab_size and token_id != speech_diffusion_id:
                        blocked_token_ids.append(token_id)
            if needs_audio.any() and blocked_token_ids:
                rows = torch.nonzero(needs_audio, as_tuple=False).squeeze(1)
                blocked = torch.tensor(sorted(set(blocked_token_ids)), dtype=torch.long, device=fixed.device)
                fixed[rows[:, None], blocked[None, :]] = float("-inf")

        finite_valid = torch.isfinite(fixed.index_select(-1, valid_ids)).any(dim=1)
        empty_rows = ~finite_valid
        if empty_rows.any() and 0 <= fallback_token_id < vocab_size:
            rows = torch.nonzero(empty_rows, as_tuple=False).squeeze(1)
            fixed[rows, fallback_token_id] = 0.0
        return fixed

    processor_cls.__init__ = patched_init
    processor_cls.__call__ = patched_call
    processor_cls._mo_safe_sampling_patch = True
    processor_cls._mo_original_init = original_init
    processor_cls._mo_original_call = original_call
    logger.info("VibeVoice token制約patchを有効化しました: %s", processor_cls)


class _FiniteLogitsProcessor(LogitsProcessor):
    def __call__(self, input_ids: torch.LongTensor, scores: torch.FloatTensor) -> torch.FloatTensor:
        if scores.is_floating_point():
            limit = torch.finfo(scores.dtype).max / 2
        else:
            limit = 1e4
        return torch.nan_to_num(scores, nan=-limit, posinf=limit, neginf=-limit)


class _MinAudioTokensProcessor(LogitsProcessor):
    def __init__(
        self,
        *,
        prompt_length: int,
        speech_diffusion_id: int,
        blocked_token_ids: list[int],
        min_audio_tokens: int,
    ) -> None:
        self.prompt_length = max(0, int(prompt_length))
        self.speech_diffusion_id = int(speech_diffusion_id)
        self.blocked_token_ids = sorted({int(token_id) for token_id in blocked_token_ids if token_id is not None})
        self.min_audio_tokens = max(0, int(min_audio_tokens))

    def __call__(self, input_ids: torch.LongTensor, scores: torch.FloatTensor) -> torch.FloatTensor:
        if self.min_audio_tokens <= 0 or not self.blocked_token_ids:
            return scores
        generated = input_ids[:, self.prompt_length :]
        if generated.numel() == 0:
            audio_token_counts = torch.zeros(input_ids.shape[0], dtype=torch.long, device=input_ids.device)
        else:
            audio_token_counts = (generated == self.speech_diffusion_id).sum(dim=1)
        needs_audio = audio_token_counts < self.min_audio_tokens
        if needs_audio.any():
            scores = scores.clone()
            blocked = torch.tensor(self.blocked_token_ids, dtype=torch.long, device=scores.device)
            rows = torch.nonzero(needs_audio, as_tuple=False).squeeze(1)
            scores[rows[:, None], blocked[None, :]] = float("-inf")
        return scores


def _install_vibevoice_modules_utils_alias() -> None:
    """Expose the parser at the legacy relative import path used by VibeVoice."""

    package_name = "vibevoice.modules"
    module_name = "vibevoice.modules.utils"
    existing_module = sys.modules.get(module_name)
    if existing_module is not None and hasattr(existing_module, "parse_script_1_based"):
        return

    package = sys.modules.get(package_name)
    if package is None:
        package = types.ModuleType(package_name)
        package.__path__ = []
        sys.modules[package_name] = package

    utils_module = existing_module or types.ModuleType(module_name)
    utils_module.parse_script_1_based = _parse_script_1_based
    sys.modules[module_name] = utils_module
    setattr(package, "utils", utils_module)


def _patch_transformers5_tied_weights_mapping(model_class: Any) -> None:
    tied_weights = getattr(model_class, "_tied_weights_keys", None)
    if isinstance(tied_weights, list):
        if tied_weights == ["lm_head.weight"]:
            model_class._tied_weights_keys = {"lm_head.weight": "model.language_model.embed_tokens.weight"}


def _patch_transformers5_tie_weights_signature(model_class: Any) -> None:
    tie_weights = getattr(model_class, "tie_weights", None)
    if tie_weights is None or getattr(tie_weights, "_mo_accepts_transformers5_kwargs", False):
        return

    def wrapped_tie_weights(self, *args, **kwargs):
        config = getattr(self, "config", None)
        decoder_config = getattr(config, "decoder_config", None)
        if (
            config is not None
            and decoder_config is not None
            and not getattr(config, "tie_word_embeddings", False)
            and getattr(decoder_config, "tie_word_embeddings", False)
        ):
            setattr(config, "tie_word_embeddings", True)
        result = tie_weights(self)
        _tie_vibevoice_lm_head_to_decoder_embeddings(self)
        return result

    wrapped_tie_weights._mo_accepts_transformers5_kwargs = True
    model_class.tie_weights = wrapped_tie_weights


def _tie_vibevoice_lm_head_to_decoder_embeddings(model: Any) -> None:
    """Keep VibeVoice tied embeddings intact with newer Transformers loaders."""

    lm_head = getattr(model, "lm_head", None)
    base_model = getattr(model, "model", None)
    language_model = getattr(base_model, "language_model", None)
    embed_tokens = getattr(language_model, "embed_tokens", None)
    if lm_head is None or embed_tokens is None:
        return
    embed_weight = getattr(embed_tokens, "weight", None)
    if embed_weight is None:
        return
    lm_head.weight = embed_weight


def _patch_transformers5_prepare_generation_config(model_class: Any) -> None:
    prepare_generation_config = getattr(model_class, "_prepare_generation_config", None)
    if prepare_generation_config is None or getattr(
        prepare_generation_config, "_mo_accepts_legacy_kwargs_dict", False
    ):
        return

    def wrapped_prepare_generation_config(self, generation_config, kwargs=None, **extra_kwargs):
        if isinstance(kwargs, dict):
            extra_kwargs.update(kwargs)
        elif kwargs is not None:
            extra_kwargs["_legacy_kwargs"] = kwargs
        return prepare_generation_config(self, generation_config, **extra_kwargs)

    wrapped_prepare_generation_config._mo_accepts_legacy_kwargs_dict = True
    model_class._prepare_generation_config = wrapped_prepare_generation_config


def _patch_transformers5_update_model_kwargs(model_class: Any) -> None:
    update_model_kwargs = getattr(model_class, "_update_model_kwargs_for_generation", None)
    if update_model_kwargs is None or getattr(update_model_kwargs, "_mo_restores_past_key_values", False):
        return

    def wrapped_update_model_kwargs(self, outputs, model_kwargs, *args, **kwargs):
        updated_kwargs = update_model_kwargs(self, outputs, model_kwargs, *args, **kwargs)
        if "past_key_values" not in updated_kwargs:
            past_key_values = getattr(outputs, "past_key_values", None)
            if past_key_values is not None:
                updated_kwargs["past_key_values"] = past_key_values
        return updated_kwargs

    wrapped_update_model_kwargs._mo_restores_past_key_values = True
    model_class._update_model_kwargs_for_generation = wrapped_update_model_kwargs


def _patch_transformers5_prepare_cache_for_generation(model_class: Any) -> None:
    prepare_cache = getattr(model_class, "_prepare_cache_for_generation", None)
    if prepare_cache is None or getattr(prepare_cache, "_mo_accepts_comfyui_legacy_args", False):
        return

    def _generation_mode_for_config(generation_config):
        from transformers.generation.configuration_utils import GenerationMode

        return GenerationMode.SAMPLE if getattr(generation_config, "do_sample", False) else GenerationMode.GREEDY_SEARCH

    def wrapped_prepare_cache_for_generation(self, generation_config, model_kwargs, *args, **kwargs):
        if len(args) == 3:
            batch_size, max_cache_length, _device = args
            if isinstance(batch_size, int):
                return prepare_cache(
                    self,
                    generation_config,
                    model_kwargs,
                    _generation_mode_for_config(generation_config),
                    batch_size,
                    max_cache_length,
                    **kwargs,
                )
        if len(args) == 4:
            _legacy_model_input_name, batch_size, max_cache_length, _device = args
            if isinstance(batch_size, int):
                return prepare_cache(
                    self,
                    generation_config,
                    model_kwargs,
                    _generation_mode_for_config(generation_config),
                    batch_size,
                    max_cache_length,
                    **kwargs,
                )
        return prepare_cache(self, generation_config, model_kwargs, *args, **kwargs)

    wrapped_prepare_cache_for_generation._mo_accepts_comfyui_legacy_args = True
    model_class._prepare_cache_for_generation = wrapped_prepare_cache_for_generation


def _patch_transformers5_build_generate_config_model_kwargs(model_class: Any) -> None:
    build_model_kwargs = getattr(model_class, "_build_generate_config_model_kwargs", None)
    if build_model_kwargs is None or getattr(build_model_kwargs, "_mo_ensures_dynamic_cache", False):
        return

    def wrapped_build_generate_config_model_kwargs(self, *args, **kwargs):
        result = build_model_kwargs(self, *args, **kwargs)
        if isinstance(result, tuple) and len(result) >= 2 and isinstance(result[1], dict):
            model_kwargs = result[1]
            if model_kwargs.get("use_cache", True) and "past_key_values" not in model_kwargs:
                from transformers.cache_utils import DynamicCache

                # Keep it lazy/empty. ComfyUI-VibeVoice indexes this cache before
                # the negative pass has filled it; an empty cache makes that first
                # adjustment a no-op and lets the model populate layers on forward.
                model_kwargs["past_key_values"] = DynamicCache()
        return result

    wrapped_build_generate_config_model_kwargs._mo_ensures_dynamic_cache = True
    model_class._build_generate_config_model_kwargs = wrapped_build_generate_config_model_kwargs


def _patch_transformers5_dynamic_cache_tuple_indexing() -> None:
    try:
        from transformers.cache_utils import DynamicCache
    except Exception:
        return

    if getattr(DynamicCache, "_mo_supports_tuple_indexing", False):
        return

    def tuple_indexing_getitem(self, layer_idx):
        layer = self.layers[layer_idx]
        return layer.keys, layer.values

    DynamicCache.__getitem__ = tuple_indexing_getitem
    DynamicCache._mo_supports_tuple_indexing = True


@contextmanager
def _torch_creation_cpu_when_default_device_is_meta():
    original_linspace = torch.linspace
    original_tensor = torch.tensor

    def _should_force_cpu(kwargs: dict[str, Any]) -> bool:
        if "device" not in kwargs and hasattr(torch, "get_default_device"):
            try:
                return torch.get_default_device().type == "meta"
            except Exception:
                return False
        return False

    def patched_linspace(*args, **kwargs):
        if _should_force_cpu(kwargs):
            kwargs["device"] = "cpu"
        return original_linspace(*args, **kwargs)

    def patched_tensor(*args, **kwargs):
        if _should_force_cpu(kwargs):
            kwargs["device"] = "cpu"
        return original_tensor(*args, **kwargs)

    torch.linspace = patched_linspace
    torch.tensor = patched_tensor
    try:
        yield
    finally:
        torch.linspace = original_linspace
        torch.tensor = original_tensor


def _import_vibevoice_components():
    global _VIBEVOICE_COMPONENTS
    if _VIBEVOICE_COMPONENTS is not None:
        return _VIBEVOICE_COMPONENTS

    _install_transformers_qwen2_fast_alias()
    resolved_path = _resolve_comfyui_vibevoice_path()
    if resolved_path:
        resolved_str = resolved_path.as_posix()
        if resolved_str not in sys.path:
            sys.path.insert(0, resolved_str)
    _install_vibevoice_modules_utils_alias()

    try:
        import vibevoice.modular.modeling_vibevoice_inference as vibevoice_inference_module
        from vibevoice.modular.modeling_vibevoice import VibeVoiceForConditionalGeneration
        from vibevoice.processor.vibevoice_processor import VibeVoiceProcessor
        from vibevoice.processor.vibevoice_tokenizer_processor import VibeVoiceTokenizerProcessor
        from vibevoice.modular.modular_vibevoice_text_tokenizer import VibeVoiceTextTokenizerFast
    except ImportError as exc:
        raise ImportError(
            "VibeVoice拡張モジュールを読み込めません。pip install ComfyUI-VibeVoice でインストールするか、"
            "COMFYUI_VIBEVOICE_PATH でComfyUI-VibeVoiceのディレクトリを指定してください。"
            f" 原因: {type(exc).__name__}: {exc}"
        ) from exc

    VibeVoiceForConditionalGenerationInference = (
        vibevoice_inference_module.VibeVoiceForConditionalGenerationInference
    )
    _patch_vibevoice_token_constraint_processor_for_safe_sampling(
        getattr(vibevoice_inference_module, "VibeVoiceTokenConstraintProcessor", None)
    )
    _patch_transformers5_tied_weights_mapping(VibeVoiceForConditionalGenerationInference)
    _patch_transformers5_tied_weights_mapping(VibeVoiceForConditionalGeneration)
    _patch_transformers5_tie_weights_signature(VibeVoiceForConditionalGenerationInference)
    _patch_transformers5_tie_weights_signature(VibeVoiceForConditionalGeneration)
    _patch_transformers5_prepare_generation_config(VibeVoiceForConditionalGenerationInference)
    _patch_transformers5_update_model_kwargs(VibeVoiceForConditionalGenerationInference)
    _patch_transformers5_prepare_cache_for_generation(VibeVoiceForConditionalGenerationInference)
    _patch_transformers5_build_generate_config_model_kwargs(VibeVoiceForConditionalGenerationInference)
    _patch_transformers5_dynamic_cache_tuple_indexing()
    _VIBEVOICE_COMPONENTS = (
        VibeVoiceForConditionalGenerationInference,
        VibeVoiceProcessor,
        VibeVoiceTokenizerProcessor,
        VibeVoiceTextTokenizerFast,
    )
    return _VIBEVOICE_COMPONENTS


def _first_match(pattern: str) -> Optional[Path]:
    matches = sorted(glob.glob(pattern, recursive=True))
    if matches:
        return Path(matches[0])
    return None


def _cached_snapshot_dir(repo_id: str, revision: Optional[str], *, file_pattern: str) -> Optional[Path]:
    repo_root = VIBEVOICE_HOME / _repo_cache_dir_name(repo_id)
    snapshot_id = revision
    if not snapshot_id:
        ref_path = repo_root / "refs" / "main"
        if ref_path.is_file():
            snapshot_id = ref_path.read_text(encoding="utf-8").strip()
    if not snapshot_id:
        return None
    snapshot_dir = repo_root / "snapshots" / snapshot_id
    if snapshot_dir.is_dir() and list(snapshot_dir.glob(file_pattern)):
        return snapshot_dir
    return None


def _propagate_decoder_config_fields(config: Any):
    decoder_config = getattr(config, "decoder_config", None)
    if not decoder_config:
        return
    for attr in (
        "num_hidden_layers",
        "hidden_size",
        "intermediate_size",
        "num_attention_heads",
        "num_key_value_heads",
        "vocab_size",
    ):
        if not hasattr(config, attr) and hasattr(decoder_config, attr):
            setattr(config, attr, getattr(decoder_config, attr))


VIBEVOICE_HOME = _resolve_vibevoice_home()
MODEL_REPO_ID = os.getenv("VIBEVOICE_MODEL_REPO", "microsoft/VibeVoice-1.5B")
MODEL_REVISION = os.getenv("VIBEVOICE_MODEL_REVISION")
TOKENIZER_REPO_ID = os.getenv("VIBEVOICE_TOKENIZER_REPO", "Qwen/Qwen2.5-1.5B")
TOKENIZER_REVISION = os.getenv("VIBEVOICE_TOKENIZER_REVISION")
TOKENIZER_FILENAME = os.getenv("VIBEVOICE_TOKENIZER_FILENAME", "tokenizer.json")


def _repo_cache_dir_name(repo_id: str) -> str:
    return "models--" + repo_id.replace("/", "--")


MODEL_GLOB_PATTERN = (VIBEVOICE_HOME / _repo_cache_dir_name(MODEL_REPO_ID) / "**" / "*.safetensors").as_posix()
TOKENIZER_GLOB_PATTERN = (
    VIBEVOICE_HOME / _repo_cache_dir_name(TOKENIZER_REPO_ID) / "**" / TOKENIZER_FILENAME
).as_posix()

AUDIO_EXTENSIONS = (".wav", ".mp3", ".m4a")


def _resolve_torch_dtype_for_device(device: torch.device):
    dtype_name_raw = os.getenv("VIBEVOICE_TORCH_DTYPE")
    dtype_name = str(dtype_name_raw or "").strip().lower()
    if dtype_name:
        dtype_map = {
            "float32": torch.float32,
            "fp32": torch.float32,
            "float16": torch.float16,
            "fp16": torch.float16,
            "bfloat16": torch.bfloat16,
            "bf16": torch.bfloat16,
        }
        try:
            return dtype_map[dtype_name]
        except KeyError as exc:
            raise ValueError(f"unsupported VIBEVOICE_TORCH_DTYPE: {dtype_name_raw}") from exc
    return torch.float16 if device.type in {"cuda", "mps"} else torch.float32


SAMPLE_RATE = 24000
LINE_CACHE_ROOT = Path(os.getenv("VIBEVOICE_LINE_CACHE_DIR", Path.cwd() / ".cache" / "vibevoice" / "line_segments")).expanduser()


def _ensure_module(module_name: str, friendly_name: str):
    try:
        __import__(module_name)
    except ImportError as exc:
        raise ImportError(f"{friendly_name}を使用するには {module_name} が必要です。pip install {module_name} を実行してください。") from exc


def _build_public_url(base_url: Optional[str], default: str, object_name: str) -> str:
    if base_url:
        return f"{base_url.rstrip('/')}/{object_name}"
    return default


def _upload_file_to_target(
    file_path: str,
    *,
    target: str,
    bucket: str,
    object_name: Optional[str] = None,
    base_url: Optional[str] = None,
    endpoint_url: Optional[str] = None,
) -> Dict[str, str]:
    file_path_obj = Path(file_path).expanduser()
    if not file_path_obj.is_file():
        raise FileNotFoundError(f"アップロード対象ファイルが見つかりません: {file_path}")
    object_name = object_name or file_path_obj.name

    if target in {"s3", "runpod"}:
        _ensure_module("boto3", "S3/RunPodアップロード")
        import boto3  # type: ignore

        client_kwargs: Dict[str, Any] = {}
        if endpoint_url:
            client_kwargs["endpoint_url"] = endpoint_url
        region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
        if region and target == "s3":
            client_kwargs["region_name"] = region
        s3_client = boto3.client("s3", **client_kwargs)
        s3_client.upload_file(file_path_obj.as_posix(), bucket, object_name)
        default_url = (
            f"https://{bucket}.s3{'' if not region or region == 'us-east-1' else f'-{region}'}.amazonaws.com/{object_name}" if target == "s3" else f"s3://{bucket}/{object_name}"
        )
        url = _build_public_url(base_url, default_url, object_name)
        return {"url": url, "bucket": bucket, "object": object_name}

    if target == "gcs":
        _ensure_module("google.cloud.storage", "GCSアップロード")
        from google.cloud import storage  # type: ignore

        storage_client = storage.Client()
        bucket_obj = storage_client.bucket(bucket)
        blob = bucket_obj.blob(object_name)
        blob.upload_from_filename(file_path_obj.as_posix())
        default_url = f"https://storage.googleapis.com/{bucket}/{object_name}"
        url = _build_public_url(base_url, default_url, object_name)
        return {"url": url, "bucket": bucket, "object": object_name}

    raise ValueError(f"未対応のuploadターゲットです: {target}")


def _raise_upload_error(target: str, exc: Exception):
    message = str(exc).lower()
    if target == "gcs" and "default credentials" in message:
        raise RuntimeError(
            "GCSアップロードに必要なGoogle Application Default Credentialsが見つかりません。"
            "GOOGLE_APPLICATION_CREDENTIALSを設定するか、--upload_targetの指定を外して実行してください。"
        ) from exc
    raise exc


class VibeVoice:
    """Direct VibeVoice implementation without ComfyUI dependency"""

    def __init__(self, model_path: Optional[str] = None, tokenizer_path: Optional[str] = None, max_voice_seconds: float = 5.0):
        self.model_path = self._resolve_model_path(model_path)
        self.tokenizer_path = self._resolve_tokenizer_path(tokenizer_path)
        self.model = None
        self.processor = None
        self.max_voice_seconds = max_voice_seconds
        configured_device = os.getenv("VIBEVOICE_DEVICE", "").strip().lower()
        if configured_device:
            self.device = torch.device(configured_device)
        elif torch.cuda.is_available():
            self.device = torch.device("cuda")
        else:
            # MPS currently crashes inside VibeVoice generation on local macOS
            # for some multi-speaker inputs, so use CPU unless explicitly opted in.
            self.device = torch.device("cpu")

    def _resolve_model_path(self, explicit_path: Optional[str] = None) -> str:
        """Resolve model directory, downloading from Hugging Face if necessary."""
        path_hint = explicit_path or os.getenv("VIBEVOICE_MODEL_PATH")
        if path_hint:
            resolved = Path(path_hint).expanduser()
            if resolved.exists():
                return resolved.as_posix()
            raise FileNotFoundError(f"指定されたモデルパスが存在しません: {resolved}")

        if MODEL_REVISION:
            cached_snapshot = _cached_snapshot_dir(MODEL_REPO_ID, MODEL_REVISION, file_pattern="*.safetensors")
            if cached_snapshot:
                return cached_snapshot.as_posix()

        if snapshot_download is None:
            raise ImportError("huggingface_hub がインストールされていません。`pip install huggingface_hub` を実行してモデルを取得してください。")

        download_kwargs: Dict[str, Any] = {
            "repo_id": MODEL_REPO_ID,
            "cache_dir": VIBEVOICE_HOME,
            "local_dir_use_symlinks": False,
        }
        if MODEL_REVISION:
            download_kwargs["revision"] = MODEL_REVISION

        local_dir = os.getenv("VIBEVOICE_MODEL_LOCAL_DIR")
        if local_dir:
            local_dir_path = Path(local_dir).expanduser()
            local_dir_path.mkdir(parents=True, exist_ok=True)
            download_kwargs["local_dir"] = local_dir_path.as_posix()

        logger.info("モデルディレクトリが見つかりません。Hugging Faceから取得します: %s", MODEL_REPO_ID)
        try:
            resolved_path = snapshot_download(**download_kwargs)
        except Exception as exc:
            match = _first_match(MODEL_GLOB_PATTERN)
            if match:
                logger.warning("Hugging Faceから取得できないため、既存cacheを使います: %s", match.parent)
                return match.parent.as_posix()
            raise RuntimeError(f"VibeVoiceモデルのダウンロードに失敗しました: {exc}") from exc

        logger.info("モデルをダウンロードしました: %s", resolved_path)
        return resolved_path

    def _resolve_tokenizer_path(self, explicit_path: Optional[str] = None) -> str:
        """Resolve tokenizer.json path, downloading when necessary."""
        path_hint = explicit_path or os.getenv("VIBEVOICE_TOKENIZER_PATH")
        if path_hint:
            resolved = Path(path_hint).expanduser()
            if resolved.is_file():
                return resolved.as_posix()
            raise FileNotFoundError(f"指定されたtokenizerパスが存在しません: {resolved}")

        if TOKENIZER_REVISION:
            cached_snapshot = _cached_snapshot_dir(
                TOKENIZER_REPO_ID,
                TOKENIZER_REVISION,
                file_pattern=TOKENIZER_FILENAME,
            )
            if cached_snapshot:
                match = _first_match((cached_snapshot / "**" / TOKENIZER_FILENAME).as_posix())
                if match:
                    return match.as_posix()

        if hf_hub_download is None:
            raise ImportError("huggingface_hub がインストールされていません。`pip install huggingface_hub` を実行してtokenizerを取得してください。")

        download_kwargs: Dict[str, Any] = {
            "repo_id": TOKENIZER_REPO_ID,
            "filename": TOKENIZER_FILENAME,
            "cache_dir": VIBEVOICE_HOME,
            "local_dir_use_symlinks": False,
        }
        if TOKENIZER_REVISION:
            download_kwargs["revision"] = TOKENIZER_REVISION

        local_dir = os.getenv("VIBEVOICE_TOKENIZER_LOCAL_DIR")
        if local_dir:
            local_dir_path = Path(local_dir).expanduser()
            local_dir_path.mkdir(parents=True, exist_ok=True)
            download_kwargs["local_dir"] = local_dir_path.as_posix()

        logger.info("Tokenizerが見つかりません。Hugging Faceから取得します: %s", TOKENIZER_REPO_ID)
        try:
            resolved_path = hf_hub_download(**download_kwargs)
        except Exception as exc:
            match = _first_match(TOKENIZER_GLOB_PATTERN)
            if match:
                logger.warning("Hugging Faceから取得できないため、既存tokenizer cacheを使います: %s", match)
                return match.as_posix()
            raise RuntimeError(f"Tokenizerのダウンロードに失敗しました: {exc}") from exc

        logger.info("Tokenizerをダウンロードしました: %s", resolved_path)
        return resolved_path

    def load_model(self, attention_mode: str = "sdpa", use_llm_4bit: bool = False):
        """Load VibeVoice model and processor"""
        (
            VibeVoiceForConditionalGenerationInference,
            VibeVoiceProcessor,
            VibeVoiceTokenizerProcessor,
            VibeVoiceTextTokenizerFast,
        ) = _import_vibevoice_components()
        self.model_path = self._resolve_model_path(self.model_path)
        self.tokenizer_path = self._resolve_tokenizer_path(self.tokenizer_path)
        logger.info(f"VibeVoiceモデルを読み込み中: {self.model_path}")
        logger.info(f"使用デバイス: {self.device}")
        logger.info(f"アテンションモード: {attention_mode}")

        # Load tokenizer - using ComfyUI's Hugging Face Cache path
        tokenizer_file_path = self.tokenizer_path

        vibevoice_tokenizer = VibeVoiceTextTokenizerFast(tokenizer_file=tokenizer_file_path)
        audio_processor = VibeVoiceTokenizerProcessor()
        self.processor = VibeVoiceProcessor(tokenizer=vibevoice_tokenizer, audio_processor=audio_processor)

        # Reduce GPU memory footprint by using half-precision during GPU/MPS
        # inference. CPU float16 can produce poor compatibility and quality, so
        # keep CPU execution in float32 unless explicitly overridden.
        final_load_dtype = _resolve_torch_dtype_for_device(self.device)
        logger.info("モデル読み込みdtype: %s", final_load_dtype)

        # Load model
        try:
            should_load_directly_to_device = self.device.type == "cuda"
            from_pretrained_kwargs = {
                "attn_implementation": attention_mode,
            }
            if should_load_directly_to_device:
                from_pretrained_kwargs["device_map"] = self.device
            else:
                # The ComfyUI-VibeVoice acoustic tokenizer calls Tensor.item()
                # during __init__, which is incompatible with Transformers'
                # meta-tensor low-memory construction path.
                from_pretrained_kwargs["low_cpu_mem_usage"] = False

            # Use the correct dtype argument based on the transformers version (same as ComfyUI)
            if _DTYPE_ARG_SUPPORTED:
                from_pretrained_kwargs["dtype"] = final_load_dtype
            else:
                from_pretrained_kwargs["torch_dtype"] = final_load_dtype

            with _torch_creation_cpu_when_default_device_is_meta():
                self.model = VibeVoiceForConditionalGenerationInference.from_pretrained(self.model_path, **from_pretrained_kwargs)
            _tie_vibevoice_lm_head_to_decoder_embeddings(self.model)
            if not should_load_directly_to_device:
                self.model.to(self.device)
            self.model.eval()
            _propagate_decoder_config_fields(self.model.config)
            logger.info("モデルの読み込みが完了しました")

        except Exception as e:
            logger.error(f"モデルの読み込みに失敗しました: {e}")
            logger.error(f"モデルパス: {self.model_path}")
            logger.error(f"エラーの詳細: {type(e).__name__}: {str(e)}")
            import traceback

            logger.error(f"スタックトレース: {traceback.format_exc()}")
            raise

    def parse_script_1_based(self, script: str) -> Tuple[List[Tuple[int, str]], List[int]]:
        """Parse a 1-based speaker script into (speaker_id, text) tuples"""
        return _parse_script_1_based(script)

    def preprocess_audio(self, audio_path: str, target_sr: int = 24000) -> np.ndarray:
        """Preprocess audio file for VibeVoice"""
        if not os.path.exists(audio_path):
            raise FileNotFoundError(f"音声ファイルが見つかりません: {audio_path}")

        # Load audio
        waveform, original_sr = librosa.load(audio_path, sr=None, mono=True)
        if waveform.size == 0:
            raise ValueError(f"参照音声が空です: {audio_path}")

        # Check for invalid values
        if np.any(np.isnan(waveform)) or np.any(np.isinf(waveform)):
            logger.error("音声データにNaNまたはInf値が含まれています。ゼロで置き換えます")
            waveform = np.nan_to_num(waveform, nan=0.0, posinf=0.0, neginf=0.0)

        # Check for silence
        if np.all(waveform == 0):
            logger.warning("音声波形が完全に無音です")

        # Normalize extreme values
        max_val = np.abs(waveform).max()
        if max_val > 10.0:
            logger.warning(f"音声値が非常に大きいです (最大値: {max_val})。正規化します")
            waveform = waveform / max_val

        # Resample if necessary
        if original_sr != target_sr:
            logger.info(f"音声をリサンプル中: {original_sr}Hzから{target_sr}Hzへ")
            waveform = librosa.resample(y=waveform, orig_sr=original_sr, target_sr=target_sr)

        # Final check after resampling
        if np.any(np.isnan(waveform)) or np.any(np.isinf(waveform)):
            logger.error("リサンプル後に音声データにNaNまたはInf値が含まれています。ゼロで置き換えます")
            waveform = np.nan_to_num(waveform, nan=0.0, posinf=0.0, neginf=0.0)

        waveform = _trim_reference_silence(np.asarray(waveform, dtype=np.float32), target_sr, audio_path)

        # Trim excessively long samples after removing leading silence so the
        # reference prompt starts from the actual voice section.
        if self.max_voice_seconds > 0:
            max_len = int(target_sr * self.max_voice_seconds)
            if waveform.shape[0] > max_len:
                logger.info("参照音声が長いため有声区間の先頭%.1f秒に切り詰めます: %s", self.max_voice_seconds, audio_path)
                waveform = waveform[:max_len]

        waveform = _normalize_reference_loudness(waveform, audio_path)
        return waveform.astype(np.float32)

    def set_vibevoice_seed(self, seed: int):
        """Set seed for reproducibility"""
        if seed == 0:
            seed = random.randint(1, 0xFFFFFFFFFFFFFFFF)

        MAX_NUMPY_SEED = 2**32 - 1
        numpy_seed = seed % MAX_NUMPY_SEED

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
        np.random.seed(numpy_seed)
        random.seed(seed)

    def _build_voice_samples(self, voice_files: Dict[int, str], speaker_ids: List[int]) -> List[np.ndarray]:
        """Preprocess and collect voice samples for the required speakers."""
        voice_samples_np: List[np.ndarray] = []
        for speaker_id in speaker_ids:
            if speaker_id not in voice_files:
                raise ValueError(f"Speaker {speaker_id}の音声ファイルが指定されていません")
            voice_path = voice_files[speaker_id]
            logger.info(f"Speaker {speaker_id}の音声サンプルを処理中: {voice_path}")
            voice_sample = self.preprocess_audio(voice_path)
            voice_samples_np.append(voice_sample)
        return voice_samples_np

    def _synthesize_script(
        self,
        script_text: str,
        voice_samples_np: List[np.ndarray],
        *,
        speaker_ids_for_prompt: Optional[List[int]] = None,
        cfg_scale: float,
        inference_steps: int,
        do_sample: bool,
        temperature: float,
        top_p: float,
        top_k: int,
    ) -> np.ndarray:
        """Run the VibeVoice model and return waveform as numpy array."""
        parsed_lines_0_based, _speaker_ids_1_based = self.parse_script_1_based(script_text)
        if not parsed_lines_0_based:
            raise ValueError("スクリプトが空または無効です。'Speaker 1:', 'Speaker 2:' などの形式を使用してください")
        max_new_tokens = _estimate_vibevoice_max_new_tokens(script_text)
        logger.info("VibeVoice生成token上限: %d", max_new_tokens)
        configured_min_audio_tokens = _resolve_configured_min_audio_tokens()
        min_audio_tokens = _estimate_vibevoice_min_audio_tokens(
            script_text,
            configured_min_audio_tokens=configured_min_audio_tokens,
            max_new_tokens=max_new_tokens,
        )
        if min_audio_tokens > 0:
            logger.info(
                "VibeVoice初期音声token下限: %d (設定値=%d)",
                min_audio_tokens,
                configured_min_audio_tokens,
            )
        if _processor_supports_parsed_scripts(self.processor):
            prompt_speaker_ids = speaker_ids_for_prompt or _speaker_ids_1_based
            logger.info("VibeVoice processor入力: parsed_scripts経路を使用します")
            inputs = self.processor(
                parsed_scripts=[parsed_lines_0_based],
                voice_samples=[voice_samples_np],
                speaker_ids_for_prompt=[prompt_speaker_ids],
                padding=True,
                return_tensors="pt",
                return_attention_mask=True,
            )
        else:
            logger.info("VibeVoice processor入力: raw text経路を使用します")
            inputs = self.processor(
                text=[script_text],
                voice_samples=[voice_samples_np],
                padding=True,
                return_tensors="pt",
                return_attention_mask=True,
            )

        for key, value in inputs.items():
            if isinstance(value, torch.Tensor):
                if torch.any(torch.isnan(value)) or torch.any(torch.isinf(value)):
                    logger.error(f"入力テンソル '{key}' にNaNまたはInf値が含まれています")
                    raise ValueError(f"入力テンソルに無効な値が含まれています: {key}")

        inputs = {k: v.to(self.device) if isinstance(v, torch.Tensor) else v for k, v in inputs.items()}
        self.model.set_ddpm_inference_steps(num_steps=inference_steps)

        generate_kwargs = {
            "max_new_tokens": max_new_tokens,
            "cfg_scale": cfg_scale,
            "tokenizer": self.processor.tokenizer,
            "verbose": False,
        }
        logits_processors = LogitsProcessorList([_FiniteLogitsProcessor()])
        if min_audio_tokens > 0:
            tokenizer = self.processor.tokenizer
            blocked_token_ids = [
                getattr(tokenizer, "eos_token_id", None),
                getattr(tokenizer, "speech_end_id", None),
                getattr(tokenizer, "speech_start_id", None),
            ]
            logits_processors.append(
                _MinAudioTokensProcessor(
                    prompt_length=int(inputs["input_ids"].shape[-1]),
                    speech_diffusion_id=int(getattr(tokenizer, "speech_diffusion_id")),
                    blocked_token_ids=[token_id for token_id in blocked_token_ids if token_id is not None],
                    min_audio_tokens=min_audio_tokens,
                )
            )
            logger.info("VibeVoice初期音声token制約: diffusion tokenを%d個以上要求します", min_audio_tokens)
        generate_kwargs["logits_processor"] = logits_processors
        generation_config_mode = _resolve_generation_config_mode()
        if generation_config_mode == GENERATION_CONFIG_MODE_MODEL_DEFAULT:
            logger.info("VibeVoice生成設定: モデル既定generation_configを使用します")
        else:
            generation_config = {"do_sample": do_sample}
            if do_sample:
                generation_config["temperature"] = temperature
                generation_config["top_p"] = top_p
                if top_k > 0:
                    generation_config["top_k"] = top_k
            generate_kwargs["generation_config"] = generation_config

        min_audio_token = _MIN_AUDIO_TOKENS_OVERRIDE.set(min_audio_tokens)
        try:
            with torch.no_grad():
                outputs = self.model.generate(
                    **inputs,
                    **generate_kwargs,
                )
        finally:
            _MIN_AUDIO_TOKENS_OVERRIDE.reset(min_audio_token)

        speech_outputs = getattr(outputs, "speech_outputs", None)
        if not speech_outputs or speech_outputs[0] is None:
            sequences = getattr(outputs, "sequences", None)
            if isinstance(sequences, torch.Tensor) and sequences.numel():
                logger.error("VibeVoice生成sequence末尾: %s", sequences[0, -16:].detach().cpu().tolist())
            tokenizer = getattr(self.processor, "tokenizer", None)
            if tokenizer is not None:
                logger.error(
                    "VibeVoice special token ids: bos=%s eos=%s speech_start=%s speech_end=%s speech_diffusion=%s",
                    getattr(tokenizer, "bos_token_id", None),
                    getattr(tokenizer, "eos_token_id", None),
                    getattr(tokenizer, "speech_start_id", None),
                    getattr(tokenizer, "speech_end_id", None),
                    getattr(tokenizer, "speech_diffusion_id", None),
                )
            raise RuntimeError("VibeVoiceモデルが音声波形を返しませんでした。モデルとCLIの互換性を確認してください。")

        output_waveform = speech_outputs[0]
        if output_waveform.ndim == 1:
            output_waveform = output_waveform.unsqueeze(0)
        if output_waveform.ndim == 2:
            output_waveform = output_waveform.unsqueeze(0)
        if output_waveform.dtype != torch.float32:
            output_waveform = output_waveform.float()

        waveform_np = output_waveform.detach().cpu().numpy().squeeze()
        if waveform_np.dtype != np.float32:
            waveform_np = waveform_np.astype(np.float32)
        return waveform_np

    def generate_audio(
        self,
        text_file: str,
        voice_files: Dict[int, str],
        cfg_scale: float = 1.3,
        inference_steps: int = 10,
        seed: int = 42,
        do_sample: bool = True,
        temperature: float = 0.95,
        top_p: float = 0.95,
        top_k: int = 0,
        output_path: str = "output.wav",
    ) -> str:
        """Generate audio from script and voice samples"""

        if self.model is None or self.processor is None:
            raise RuntimeError("モデルが読み込まれていません。最初にload_model()を呼び出してください")

        # Read text file
        with open(text_file, "r", encoding="utf-8") as f:
            script_text = f.read()

        # Parse script
        parsed_lines_0_based, speaker_ids_1_based = self.parse_script_1_based(script_text)
        if not parsed_lines_0_based:
            raise ValueError("スクリプトが空または無効です。'Speaker 1:', 'Speaker 2:' などの形式を使用してください")

        full_script = "\n".join([f"Speaker {spk+1}: {txt}" for spk, txt in parsed_lines_0_based])
        logger.info(f"スクリプトをパースしました。スピーカー数: {len(speaker_ids_1_based)}")

        voice_samples_np = self._build_voice_samples(voice_files, speaker_ids_1_based)

        # Set seed
        self.set_vibevoice_seed(seed)

        # Process inputs
        try:
            logger.info("音声を生成中...")
            waveform_np = self._synthesize_script(
                script_text=full_script,
                voice_samples_np=voice_samples_np,
                speaker_ids_for_prompt=speaker_ids_1_based,
                cfg_scale=cfg_scale,
                inference_steps=inference_steps,
                do_sample=do_sample,
                temperature=temperature,
                top_p=top_p,
                top_k=top_k,
            )

            output_path_obj = Path(output_path).expanduser()
            output_dir = output_path_obj.parent
            if output_dir and not output_dir.exists():
                output_dir.mkdir(parents=True, exist_ok=True)

            sf.write(output_path_obj.as_posix(), waveform_np, SAMPLE_RATE)
            logger.info(f"音声を保存しました: {output_path_obj}")

            return output_path_obj.as_posix()

        except Exception as e:
            logger.error(f"音声生成中にエラーが発生しました: {e}")
            import traceback

            logger.error(f"スタックトレース: {traceback.format_exc()}")
            raise

    def generate_audio_line_by_line(
        self,
        text_file: str,
        voice_files: Dict[int, str],
        cfg_scale: float = 1.3,
        inference_steps: int = 10,
        seed: int = 42,
        do_sample: bool = True,
        temperature: float = 0.95,
        top_p: float = 0.95,
        top_k: int = 0,
        output_path: str = "output.wav",
        line_gap_seconds: float = 1.0,
        combine_mode: str = "concat",
        line_output_dir: Optional[str] = None,
        metadata_path: Optional[str] = None,
        force: bool = False,
    ) -> Dict[str, Any]:
        """Generate audio per line, cache results, and produce metadata."""

        if self.model is None or self.processor is None:
            raise RuntimeError("モデルが読み込まれていません。最初にload_model()を呼び出してください")

        with open(text_file, "r", encoding="utf-8") as f:
            script_text = f.read()

        parsed_lines_0_based, speaker_ids_1_based = self.parse_script_1_based(script_text)
        if not parsed_lines_0_based:
            raise ValueError("スクリプトが空または無効です。'Speaker 1:', 'Speaker 2:' などの形式を使用してください")

        combine_mode = (combine_mode or "concat").lower()
        if combine_mode not in {"concat", "archive"}:
            raise ValueError("combine_modeは'concat'または'archive'を指定してください")

        logger.info("行単位モードで音声を生成します。対象行数: %d (mode=%s)", len(parsed_lines_0_based), combine_mode)
        voice_samples_np = self._build_voice_samples(voice_files, speaker_ids_1_based)
        voice_samples_by_speaker = dict(zip(speaker_ids_1_based, voice_samples_np))

        output_path_obj = Path(output_path).expanduser()
        output_dir = output_path_obj.parent if output_path_obj.parent != Path("") else Path.cwd()
        if not output_dir.exists():
            output_dir.mkdir(parents=True, exist_ok=True)

        segment_output_dir = Path(line_output_dir).expanduser() if line_output_dir else output_dir
        if not segment_output_dir.exists():
            segment_output_dir.mkdir(parents=True, exist_ok=True)

        cache_dir = LINE_CACHE_ROOT
        if not cache_dir.is_absolute():
            cache_dir = (Path.cwd() / cache_dir).resolve()
        cache_dir.mkdir(parents=True, exist_ok=True)

        metadata_path_obj = Path(metadata_path).expanduser() if metadata_path else Path(str(output_path_obj) + ".json")
        metadata_parent = metadata_path_obj.parent if metadata_path_obj.parent != Path("") else output_dir
        if not metadata_parent.exists():
            metadata_parent.mkdir(parents=True, exist_ok=True)

        if combine_mode == "concat":
            gap_seconds = max(0.0, line_gap_seconds)
            gap_samples = int(round(gap_seconds * SAMPLE_RATE))
            gap_chunk = np.zeros(gap_samples, dtype=np.float32) if gap_samples > 0 else None
        else:
            gap_seconds = 0.0
            gap_samples = 0
            gap_chunk = None

        voice_digest_cache: Dict[str, str] = {}

        def voice_digest(path: Path) -> str:
            resolved = path.expanduser()
            if not resolved.is_absolute():
                resolved = resolved.resolve()
            cache_key = resolved.as_posix()
            if cache_key in voice_digest_cache:
                return voice_digest_cache[cache_key]
            hasher = hashlib.sha256()
            with open(resolved, "rb") as fh:
                for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                    if not chunk:
                        break
                    hasher.update(chunk)
            digest = hasher.hexdigest()
            voice_digest_cache[cache_key] = digest
            return digest

        segment_waveforms: List[np.ndarray] = []
        segments_metadata: List[Dict[str, Any]] = []
        current_sample_index = 0

        for line_index, (speaker_internal_id, text) in enumerate(parsed_lines_0_based):
            speaker_id = speaker_internal_id + 1
            if speaker_id not in voice_files:
                raise ValueError(f"Speaker {speaker_id}の音声ファイルが指定されていません")
            speaker_text = text.strip()
            script_line = f"Speaker {speaker_id}:{text}"
            generation_script_line = f"Speaker 1:{text}"
            generation_voice_samples = [voice_samples_by_speaker[speaker_id]]

            voice_path = Path(voice_files[speaker_id]).expanduser()
            payload = {
                "script": script_line,
                "generation_script": generation_script_line,
                "speaker_prompt_mode": "single-line-normalized-v1",
                "cfg_scale": cfg_scale,
                "inference_steps": inference_steps,
                "seed": seed,
                "do_sample": do_sample,
                "temperature": temperature,
                "top_p": top_p,
                "top_k": top_k,
                "generation_config_mode": _resolve_generation_config_mode(),
                "voice_digest": voice_digest(voice_path),
                "voice_path": voice_path.as_posix(),
                "voice_preprocess": _reference_preprocess_cache_key(),
                "model_path": self.model_path,
                "tokenizer_path": self.tokenizer_path,
            }
            cache_key = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
            cache_path = cache_dir / f"{cache_key}.wav"

            if cache_path.exists() and not force:
                logger.info("行%03d: キャッシュを使用します -> %s", line_index + 1, cache_path)
                waveform_np, sr = sf.read(cache_path.as_posix(), dtype="float32")
                if waveform_np.ndim > 1:
                    waveform_np = waveform_np.squeeze()
                if sr != SAMPLE_RATE:
                    waveform_np = librosa.resample(y=waveform_np, orig_sr=sr, target_sr=SAMPLE_RATE)
                waveform_np = np.array(waveform_np, dtype=np.float32)
            else:
                logger.info("行%03d: 新規に音声を生成します", line_index + 1)
                self.set_vibevoice_seed(seed)
                waveform_np = self._synthesize_script(
                    script_text=generation_script_line,
                    voice_samples_np=generation_voice_samples,
                    cfg_scale=cfg_scale,
                    inference_steps=inference_steps,
                    do_sample=do_sample,
                    temperature=temperature,
                    top_p=top_p,
                    top_k=top_k,
                )
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                sf.write(cache_path.as_posix(), waveform_np, SAMPLE_RATE)

            waveform_np = np.array(waveform_np, dtype=np.float32).squeeze()
            if waveform_np.ndim != 1:
                waveform_np = waveform_np.reshape(-1)

            segment_filename = f"{output_path_obj.stem}_L{line_index + 1:03d}_spk{speaker_id}.wav"
            segment_path = (segment_output_dir / segment_filename).expanduser()
            if segment_path.exists():
                segment_path.unlink()
            if cache_path.resolve() != segment_path.resolve():
                shutil.copyfile(cache_path.as_posix(), segment_path.as_posix())
            else:
                logger.debug("行%03d: キャッシュファイルと出力先が同一のためコピーをスキップします", line_index + 1)

            samples = int(waveform_np.shape[0])
            start_sample = current_sample_index
            end_sample = start_sample + samples

            segments_metadata.append(
                {
                    "index": line_index,
                    "speaker_id": speaker_id,
                    "speaker_label": f"Speaker {speaker_id}",
                    "text": speaker_text,
                    "audio_path": segment_path.as_posix(),
                    "cache_path": cache_path.as_posix(),
                    "duration_sec": samples / SAMPLE_RATE,
                    "start_sec": start_sample / SAMPLE_RATE,
                    "end_sec": end_sample / SAMPLE_RATE,
                    "samples": samples,
                }
            )

            current_sample_index = end_sample
            if combine_mode == "concat":
                segment_waveforms.append(waveform_np)
                if gap_chunk is not None and line_index < len(parsed_lines_0_based) - 1:
                    current_sample_index += gap_samples

        if not segments_metadata:
            raise ValueError("有効な台詞が見つかりませんでした")

        if combine_mode == "concat" and not segment_waveforms:
            raise ValueError("有効な台詞が見つかりませんでした")

        total_samples = sum(entry["samples"] for entry in segments_metadata)
        if combine_mode == "concat":
            combined_chunks: List[np.ndarray] = []
            for idx, waveform in enumerate(segment_waveforms):
                combined_chunks.append(waveform)
                if gap_chunk is not None and idx < len(segment_waveforms) - 1:
                    combined_chunks.append(gap_chunk)

            combined_waveform = np.concatenate(combined_chunks).astype(np.float32)
            sf.write(output_path_obj.as_posix(), combined_waveform, SAMPLE_RATE)
            total_samples = combined_waveform.shape[0]
            total_duration_sec = combined_waveform.shape[0] / SAMPLE_RATE
        else:
            if output_path_obj.suffix.lower() != ".zip":
                logger.warning("アーカイブモードでは出力ファイルの拡張子に.zipを推奨します: %s", output_path_obj)
            with zipfile.ZipFile(output_path_obj.as_posix(), "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
                for entry in segments_metadata:
                    zf.write(entry["audio_path"], arcname=Path(entry["audio_path"]).name)
            total_duration_sec = sum(entry["duration_sec"] for entry in segments_metadata)

        metadata = {
            "mode": "line_by_line",
            "output_mode": combine_mode,
            "sample_rate": SAMPLE_RATE,
            "voice_preprocess": _reference_preprocess_cache_key(),
            "gap_seconds": gap_seconds,
            "segments": segments_metadata,
            "output_path": output_path_obj.as_posix(),
            "segment_output_dir": segment_output_dir.as_posix(),
            "cache_dir": cache_dir.as_posix(),
            "total_duration_sec": total_duration_sec,
            "total_samples": int(total_samples),
        }

        with open(metadata_path_obj.as_posix(), "w", encoding="utf-8") as meta_file:
            json.dump(metadata, meta_file, ensure_ascii=False, indent=2)

        if combine_mode == "archive":
            with zipfile.ZipFile(output_path_obj.as_posix(), "a", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
                if metadata_path_obj.exists():
                    zf.write(metadata_path_obj.as_posix(), arcname=metadata_path_obj.name)
            logger.info("行単位モード: %d件の音声をアーカイブしました", len(segments_metadata))
        else:
            logger.info("行単位モード: %d件の音声を結合しました (gap=%.2fs)", len(segment_waveforms), gap_seconds)

        logger.info("行単位メタデータを書き出しました: %s", metadata_path_obj)

        return {
            "output_path": output_path_obj.as_posix(),
            "metadata_path": metadata_path_obj.as_posix(),
            "segments": segments_metadata,
        }


def generate_unique_filename(output_dir: str, base_name: str = "vibevoice", extension: str = ".wav") -> str:
    """一意なファイル名を生成する"""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    counter = 1

    while True:
        filename = f"{base_name}_{timestamp}_{counter:03d}{extension}"
        full_path = os.path.join(output_dir, filename)
        if not os.path.exists(full_path):
            return full_path
        counter += 1
        if counter > 999:  # Safety check
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            counter = 1


def select_voices_from_option(voice_args: list) -> list:
    """--voiceオプションから音声ファイルを選択"""
    voice_files = []

    for arg in voice_args:
        if os.path.isdir(arg):
            # ディレクトリの場合：その中の音声ファイルを収集
            dir_files = []
            for ext in AUDIO_EXTENSIONS:
                dir_files.extend(glob.glob(os.path.join(arg, f"*{ext}")))

            # ランダムに選択して残り枠分まで追加
            remaining_slots = 4 - len(voice_files)
            if dir_files:
                random.shuffle(dir_files)  # ランダムにシャッフル
                selected_files = dir_files[:remaining_slots]
                voice_files.extend(selected_files)
                logger.info(f"ディレクトリ {arg} から {len(selected_files)}個の音声ファイルをランダム選択")

        elif os.path.isfile(arg):
            # ファイルの場合：拡張子チェックして追加
            _, ext = os.path.splitext(arg.lower())
            if ext in AUDIO_EXTENSIONS:
                voice_files.append(arg)
            else:
                logger.warning(f"サポートされていない音声ファイル形式です: {arg}")
        else:
            raise FileNotFoundError(f"指定された音声ファイル/ディレクトリが見つかりません: {arg}")

        # 最大4つまで
        if len(voice_files) >= 4:
            break

    return voice_files[:4]


def resolve_output_path(output_arg: str) -> str:
    """出力パスを解決する（ディレクトリ指定時は一意ファイル名を生成）"""
    if os.path.isdir(output_arg):
        # ディレクトリが指定された場合、一意なファイル名を生成
        return generate_unique_filename(output_arg)
    elif os.path.dirname(output_arg) and not os.path.exists(os.path.dirname(output_arg)):
        # ディレクトリパスが含まれているが存在しない場合は作成
        os.makedirs(os.path.dirname(output_arg), exist_ok=True)
        return output_arg
    else:
        # ファイル名が指定された場合はそのまま使用
        return output_arg


def _resolve_upload_config(args) -> Optional[Dict[str, Any]]:
    target = args.upload_target
    if not target:
        return None
    bucket = args.upload_bucket or os.getenv("VIBEVOICE_UPLOAD_BUCKET")
    if not bucket:
        raise ValueError("--upload_bucket もしくは VIBEVOICE_UPLOAD_BUCKET を指定してください")
    return {
        "target": target,
        "bucket": bucket,
        "base_url": args.upload_base_url or os.getenv("VIBEVOICE_UPLOAD_BASE_URL"),
        "endpoint_url": args.upload_endpoint or os.getenv("VIBEVOICE_UPLOAD_ENDPOINT"),
        "object_name": args.upload_object,
        "metadata_object": args.upload_metadata_object,
        "upload_metadata": args.upload_metadata,
    }


def main():
    parser = argparse.ArgumentParser(
        description="VibeVoice 音声生成ツール - スクリプトから音声を直接生成します",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用例:
  # 新しい使い方（skit.pyライク）
  %(prog)s -t "Speaker 1: こんにちは" -v voice1.mp3 voice2.mp3
  %(prog)s -t script.txt -v /path/to/voice_dir/ --output ./output/ -O

  # 従来の使い方（互換性維持）
  %(prog)s --text_file script.txt -a voice1.mp3 -b voice2.mp3 --output result.wav
  %(prog)s --text_file script.txt -a voice1.mp3 --seed 123 --cfg_scale 1.5 -O

スクリプトファイルの形式:
  Speaker 1: こんにちは
  Speaker 2: はじめまして
        """,
    )

    parser.add_argument("-t", "--text", type=str, help="入力テキスト（ファイルパスまたは直接文字列）")
    parser.add_argument("--text_file", help="入力テキストファイル（スクリプト）[互換性のため保持]")
    parser.add_argument("-a", "--voice1_file", help="Speaker 1の音声ファイル")
    parser.add_argument("-b", "--voice2_file", help="Speaker 2の音声ファイル")
    parser.add_argument("-c", "--voice3_file", help="Speaker 3の音声ファイル")
    parser.add_argument("-d", "--voice4_file", help="Speaker 4の音声ファイル")
    parser.add_argument("-v", "--voice", type=str, nargs="+", help="音声ファイル、ディレクトリ、またはURLを指定（複数指定可能）")
    parser.add_argument("--model_path", default=None, help="VibeVoiceモデルのパス（省略時は自動検出）")
    parser.add_argument("--output", default="output.wav", help="出力先（ファイル名またはディレクトリ。ディレクトリの場合は一意なファイル名を自動生成）")
    parser.add_argument("--cfg_scale", type=float, default=1.3, help="CFGスケール値（1.0-2.0、デフォルト: 1.3）")
    parser.add_argument("--inference_steps", type=int, default=10, help="推論ステップ数（デフォルト: 10）")
    parser.add_argument("--seed", type=int, default=42, help="ランダムシード値（デフォルト: 42）")
    parser.add_argument("--attention_mode", default="sdpa", choices=["eager", "sdpa", "flash_attention_2"], help="アテンション実装方式（デフォルト: sdpa）")
    parser.add_argument("--temperature", type=float, default=0.95, help="サンプリング温度（デフォルト: 0.95）")
    parser.add_argument("--top_p", type=float, default=0.95, help="Top-pサンプリング値（デフォルト: 0.95）")
    parser.add_argument("--top_k", type=int, default=0, help="Top-kサンプリング値（0で無効、デフォルト: 0）")
    parser.add_argument("--no_sample", action="store_true", help="サンプリングを無効化（greedyデコーディング）")
    parser.add_argument("--max_voice_seconds", type=float, default=5.0, help="各音声サンプルの最大全長（秒）。0以下で無制限")
    parser.add_argument(
        "-L",
        "--line_by_line",
        nargs="?",
        const="concat",
        choices=["concat", "archive"],
        metavar="MODE",
        help="台本を1行ずつ生成（MODE=concat/ archive）。指定なしはconcat。",
    )
    parser.add_argument("--line_gap", type=float, default=1.0, help="行ごとの音声を結合する際に挿入する無音秒数（concatモードのみ）")
    parser.add_argument("--line_output_dir", default=None, help="line-by-lineモードで行別音声を書き出すディレクトリ")
    parser.add_argument("--line_metadata", default=None, help="line-by-lineモードのメタデータ(JSON)を書き出すパス")
    parser.add_argument("--force", action="store_true", help="キャッシュを無視して再生成")
    parser.add_argument("--upload_target", choices=["s3", "gcs", "runpod"], help="生成結果をクラウドストレージへアップロード")
    parser.add_argument("--upload_bucket", help="アップロード先のバケット名（S3/GCS共通）")
    parser.add_argument("--upload_object", help="アップロード時のリモートファイル名（未指定時は出力ファイル名）")
    parser.add_argument("--upload_metadata", action="store_true", help="line-by-lineのメタデータJSONもアップロードする")
    parser.add_argument("--upload_metadata_object", help="メタデータ用のリモートファイル名（未指定時はoutput名+.json）")
    parser.add_argument("--upload_base_url", help="公開URLを生成するためのベースURL（CDN経由など任意）")
    parser.add_argument("--upload_endpoint", help="S3互換のエンドポイントURL（RunPod Storage等）")
    parser.add_argument("-O", "--open", action="store_true", help="処理終了後、生成された音声ファイルを自動で開きます。")

    args = parser.parse_args()

    # 入力テキストの処理（新旧オプション対応）
    text_input = None
    if args.text:
        text_input = args.text
    elif args.text_file:
        text_input = args.text_file
    else:
        logger.error("-t/--text または --text_file のいずれかを指定してください")
        return 1

    # テキスト入力の検証と処理
    if os.path.isfile(text_input):
        # ファイルの場合
        if not os.path.exists(text_input):
            logger.error(f"テキストファイルが見つかりません: {text_input}")
            return 1
        text_file_path = text_input
    else:
        # 直接文字列の場合、一時ファイルに保存
        import tempfile

        temp_dir = tempfile.gettempdir()
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        text_file_path = os.path.join(temp_dir, f"vibevoice_temp_script_{timestamp}.txt")

        # 話者タグがなければ付与
        if not re.search(r"^Speaker \d+:", text_input, re.MULTILINE):
            lines = [line.strip() for line in text_input.split("\n") if line.strip()]
            text_input = "\n".join([f"Speaker 1: {line}" for line in lines])

        with open(text_file_path, "w", encoding="utf-8") as f:
            f.write(text_input)
        logger.info(f"一時テキストファイルを作成しました: {text_file_path}")

    # 音声ファイルの収集（新旧オプション対応）
    voice_files = {}

    if args.voice:
        # 新しい-v/--voiceオプション使用
        try:
            selected_voice_files = select_voices_from_option(args.voice)
            for i, voice_file in enumerate(selected_voice_files, 1):
                voice_files[i] = voice_file
            logger.info(f"--voiceオプションから {len(selected_voice_files)}個の音声ファイルを選択")
        except Exception as e:
            logger.error(f"音声ファイルの選択に失敗しました: {e}")
            return 1
    else:
        # 従来の-a,-b,-c,-dオプション使用
        for i, voice_file in enumerate([args.voice1_file, args.voice2_file, args.voice3_file, args.voice4_file], 1):
            if voice_file:
                if not os.path.exists(voice_file):
                    logger.error(f"音声ファイルが見つかりません: {voice_file}")
                    return 1
                voice_files[i] = voice_file

    if not voice_files:
        logger.error("少なくとも1つの音声ファイルを指定してください")
        return 1

    # 出力パスを解決
    resolved_output_path = resolve_output_path(args.output)

    try:
        upload_config = _resolve_upload_config(args)

        # Initialize VibeVoice
        vibevoice = VibeVoice(model_path=args.model_path, max_voice_seconds=args.max_voice_seconds)
        vibevoice.load_model(attention_mode=args.attention_mode)

        metadata_path = None
        upload_result = None
        metadata_upload_result = None
        default_remote_name = Path(resolved_output_path).name
        if args.line_by_line:
            line_mode = args.line_by_line or "concat"
            result = vibevoice.generate_audio_line_by_line(
                text_file=text_file_path,
                voice_files=voice_files,
                cfg_scale=args.cfg_scale,
                inference_steps=args.inference_steps,
                seed=args.seed,
                do_sample=not args.no_sample,
                temperature=args.temperature,
                top_p=args.top_p,
                top_k=args.top_k,
                output_path=resolved_output_path,
                line_gap_seconds=args.line_gap,
                combine_mode=line_mode,
                line_output_dir=args.line_output_dir,
                metadata_path=args.line_metadata,
                force=args.force,
            )
            output_path = result["output_path"]
            metadata_path = result.get("metadata_path")
            logger.info("行単位モードの生成が完了しました（mode=%s, 総行数: %d）", line_mode, len(result.get("segments", [])))
        else:
            output_path = vibevoice.generate_audio(
                text_file=text_file_path,
                voice_files=voice_files,
                cfg_scale=args.cfg_scale,
                inference_steps=args.inference_steps,
                seed=args.seed,
                do_sample=not args.no_sample,
                temperature=args.temperature,
                top_p=args.top_p,
                top_k=args.top_k,
                output_path=resolved_output_path,
            )

        logger.info(f"音声生成が完了しました: {output_path}")
        if metadata_path:
            logger.info(f"メタデータ: {metadata_path}")

        if upload_config:
            upload_object = upload_config.get("object_name") or default_remote_name
            try:
                upload_result = _upload_file_to_target(
                    output_path,
                    target=upload_config["target"],
                    bucket=upload_config["bucket"],
                    object_name=upload_object,
                    base_url=upload_config.get("base_url"),
                    endpoint_url=upload_config.get("endpoint_url"),
                )
            except Exception as exc:
                _raise_upload_error(upload_config["target"], exc)
            logger.info("クラウドにアップロードしました: %s", upload_result["url"])
            if metadata_path and upload_config.get("upload_metadata"):
                metadata_object = upload_config.get("metadata_object") or f"{upload_object}.json"
                try:
                    metadata_upload_result = _upload_file_to_target(
                        metadata_path,
                        target=upload_config["target"],
                        bucket=upload_config["bucket"],
                        object_name=metadata_object,
                        base_url=upload_config.get("base_url"),
                        endpoint_url=upload_config.get("endpoint_url"),
                    )
                except Exception as exc:
                    _raise_upload_error(upload_config["target"], exc)
                logger.info("メタデータをアップロードしました: %s", metadata_upload_result["url"])
            if args.line_by_line:
                uploaded_map = {}
                if upload_result:
                    uploaded_map["audio"] = upload_result["url"]
                if metadata_upload_result:
                    uploaded_map["metadata"] = metadata_upload_result["url"]
                if uploaded_map:
                    result["uploaded"] = uploaded_map

        # 音声ファイルを自動で開くオプション
        if args.open:
            logger.info(f"音声ファイルを開いています: {output_path}")
            try:
                import subprocess

                subprocess.run(["open", output_path], check=True)
            except (subprocess.CalledProcessError, FileNotFoundError) as e:
                logger.warning(f"音声ファイルを開けませんでした: {e}")

        # 一時ファイルのクリーンアップ
        if not os.path.isfile(text_input) and os.path.exists(text_file_path):
            os.remove(text_file_path)
            logger.info(f"一時テキストファイルを削除しました: {text_file_path}")

        return 0

    except Exception as e:
        logger.error(f"音声生成に失敗しました: {e}")

        # エラー時でも一時ファイルをクリーンアップ
        if "text_file_path" in locals() and not os.path.isfile(text_input) and os.path.exists(text_file_path):
            os.remove(text_file_path)
            logger.info(f"一時テキストファイルを削除しました: {text_file_path}")

        return 1


if __name__ == "__main__":
    sys.exit(main())
