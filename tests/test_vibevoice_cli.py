from __future__ import annotations

import sys
from types import SimpleNamespace

import numpy as np
import pytest

vibevoice_cli = pytest.importorskip("mo_speech.vibevoice_cli")
torch = pytest.importorskip("torch")


class _FakeTokenizer:
    def __init__(self, *args, **kwargs):
        pass


class _FakeProcessor:
    def __init__(self, *args, **kwargs):
        pass


class _FakeModel:
    calls: list[dict[str, object]] = []

    def __init__(self) -> None:
        self.config = SimpleNamespace()
        self.to_devices: list[object] = []
        self.eval_called = False

    @classmethod
    def from_pretrained(cls, model_path: str, **kwargs):
        model = cls()
        cls.calls.append({"model_path": model_path, "kwargs": dict(kwargs), "model": model})
        return model

    def to(self, device):
        self.to_devices.append(device)
        return self

    def eval(self):
        self.eval_called = True
        return self


def test_vibevoice_cli_patches_legacy_tied_weights_mapping() -> None:
    class ModelClass:
        _tied_weights_keys = ["lm_head.weight"]

    vibevoice_cli._patch_transformers5_tied_weights_mapping(ModelClass)

    assert ModelClass._tied_weights_keys == {
        "lm_head.weight": "model.language_model.embed_tokens.weight"
    }


def test_vibevoice_cli_patches_tie_weights_signature() -> None:
    class ModelClass:
        def __init__(self) -> None:
            self.called = False

        def tie_weights(self):
            self.called = True

    vibevoice_cli._patch_transformers5_tie_weights_signature(ModelClass)
    model = ModelClass()

    model.tie_weights(recompute_mapping=False)

    assert model.called is True


def test_vibevoice_cli_ties_decoder_embeddings_when_config_only_has_decoder_flag() -> None:
    class ModelClass:
        def __init__(self) -> None:
            self.config = SimpleNamespace(decoder_config=SimpleNamespace(tie_word_embeddings=True))
            self.lm_head = SimpleNamespace(weight=object())
            self.model = SimpleNamespace(
                language_model=SimpleNamespace(embed_tokens=SimpleNamespace(weight=object()))
            )

        def tie_weights(self):
            if not getattr(self.config, "tie_word_embeddings", False):
                return
            self.lm_head.weight = self.model.language_model.embed_tokens.weight

    vibevoice_cli._patch_transformers5_tie_weights_signature(ModelClass)
    model = ModelClass()

    model.tie_weights(recompute_mapping=False)

    assert model.config.tie_word_embeddings is True
    assert model.lm_head.weight is model.model.language_model.embed_tokens.weight


def test_vibevoice_cli_patches_prepare_generation_config_signature() -> None:
    class ModelClass:
        def _prepare_generation_config(self, generation_config, **kwargs):
            return generation_config, kwargs

    vibevoice_cli._patch_transformers5_prepare_generation_config(ModelClass)
    model = ModelClass()

    config, kwargs = model._prepare_generation_config("config", {"temperature": 0.1}, max_length=2)

    assert config == "config"
    assert kwargs == {"temperature": 0.1, "max_length": 2}


def test_vibevoice_cli_patches_update_model_kwargs_restores_past_key_values() -> None:
    class ModelClass:
        def _update_model_kwargs_for_generation(self, outputs, model_kwargs, **kwargs):
            model_kwargs["attention_mask"] = "updated"
            return model_kwargs

    vibevoice_cli._patch_transformers5_update_model_kwargs(ModelClass)
    model = ModelClass()
    outputs = SimpleNamespace(past_key_values="cache")

    updated = model._update_model_kwargs_for_generation(outputs, {})

    assert updated == {"attention_mask": "updated", "past_key_values": "cache"}


def test_vibevoice_cli_patches_prepare_cache_for_generation_legacy_args() -> None:
    class ModelClass:
        def _prepare_cache_for_generation(
            self, generation_config, model_kwargs, generation_mode, batch_size, max_cache_length
        ):
            model_kwargs["generation_mode"] = generation_mode.name
            model_kwargs["batch_size"] = batch_size
            model_kwargs["max_cache_length"] = max_cache_length

    vibevoice_cli._patch_transformers5_prepare_cache_for_generation(ModelClass)
    model = ModelClass()
    model_kwargs: dict[str, object] = {}

    model._prepare_cache_for_generation(SimpleNamespace(do_sample=False), model_kwargs, None, 2, 10, torch.device("cpu"))

    assert model_kwargs == {
        "generation_mode": "GREEDY_SEARCH",
        "batch_size": 2,
        "max_cache_length": 10,
    }


def test_vibevoice_cli_patches_build_generate_config_model_kwargs_adds_lazy_cache() -> None:
    cache_utils = pytest.importorskip("transformers.cache_utils")
    DynamicCache = cache_utils.DynamicCache

    class ModelClass:
        def _build_generate_config_model_kwargs(self):
            return "config", {"use_cache": True}, "input_ids"

    vibevoice_cli._patch_transformers5_build_generate_config_model_kwargs(ModelClass)
    model = ModelClass()

    _config, model_kwargs, _input_ids = model._build_generate_config_model_kwargs()

    assert isinstance(model_kwargs["past_key_values"], DynamicCache)
    assert len(model_kwargs["past_key_values"]) == 0


def test_vibevoice_cli_patches_dynamic_cache_tuple_indexing() -> None:
    cache_utils = pytest.importorskip("transformers.cache_utils")
    DynamicCache = cache_utils.DynamicCache
    key_cache = torch.zeros(1, 2, 3, 4)
    value_cache = torch.ones(1, 2, 3, 4)
    cache = DynamicCache(ddp_cache_data=[(key_cache, value_cache)])

    vibevoice_cli._patch_transformers5_dynamic_cache_tuple_indexing()

    cached_key, cached_value = cache[0]
    assert torch.equal(cached_key, key_cache)
    assert torch.equal(cached_value, value_cache)
    cached_key[0, 0, 0, 0] = 2
    assert cache[0][0][0, 0, 0, 0].item() == 2


def test_vibevoice_cli_defaults_to_cpu_when_cuda_is_unavailable(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer_path.write_text("{}", encoding="utf-8")
    monkeypatch.delenv("VIBEVOICE_DEVICE", raising=False)
    monkeypatch.setattr(vibevoice_cli.torch.cuda, "is_available", lambda: False)

    service = vibevoice_cli.VibeVoice(model_path=str(model_path), tokenizer_path=str(tokenizer_path))

    assert service.device == torch.device("cpu")


def test_vibevoice_cli_respects_configured_device(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer_path.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("VIBEVOICE_DEVICE", "mps")

    service = vibevoice_cli.VibeVoice(model_path=str(model_path), tokenizer_path=str(tokenizer_path))

    assert service.device == torch.device("mps")


def test_vibevoice_cli_load_model_does_not_use_device_map_for_mps(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer_path.write_text("{}", encoding="utf-8")
    service = vibevoice_cli.VibeVoice(model_path=str(model_path), tokenizer_path=str(tokenizer_path))
    service.device = torch.device("mps")
    _FakeModel.calls = []
    monkeypatch.setattr(
        vibevoice_cli,
        "_import_vibevoice_components",
        lambda: (_FakeModel, _FakeProcessor, _FakeProcessor, _FakeTokenizer),
    )
    monkeypatch.setattr(service, "_resolve_model_path", lambda value: "model")
    monkeypatch.setattr(service, "_resolve_tokenizer_path", lambda value: "tokenizer.json")

    service.load_model()

    call = _FakeModel.calls[0]
    assert "device_map" not in call["kwargs"]
    assert call["kwargs"]["low_cpu_mem_usage"] is False
    model = call["model"]
    assert model.to_devices == [torch.device("mps")]
    assert model.eval_called is True


def test_vibevoice_cli_load_model_uses_device_map_for_cuda(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer_path.write_text("{}", encoding="utf-8")
    service = vibevoice_cli.VibeVoice(model_path=str(model_path), tokenizer_path=str(tokenizer_path))
    service.device = torch.device("cuda")
    _FakeModel.calls = []
    monkeypatch.setattr(
        vibevoice_cli,
        "_import_vibevoice_components",
        lambda: (_FakeModel, _FakeProcessor, _FakeProcessor, _FakeTokenizer),
    )
    monkeypatch.setattr(service, "_resolve_model_path", lambda value: "model")
    monkeypatch.setattr(service, "_resolve_tokenizer_path", lambda value: "tokenizer.json")

    service.load_model()

    call = _FakeModel.calls[0]
    assert call["kwargs"]["device_map"] == torch.device("cuda")
    model = call["model"]
    assert model.to_devices == []
    assert model.eval_called is True


def test_vibevoice_cli_load_model_respects_torch_dtype_override(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer_path.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("VIBEVOICE_TORCH_DTYPE", "bfloat16")
    service = vibevoice_cli.VibeVoice(model_path=str(model_path), tokenizer_path=str(tokenizer_path))
    service.device = torch.device("cuda")
    _FakeModel.calls = []
    monkeypatch.setattr(
        vibevoice_cli,
        "_import_vibevoice_components",
        lambda: (_FakeModel, _FakeProcessor, _FakeProcessor, _FakeTokenizer),
    )
    monkeypatch.setattr(service, "_resolve_model_path", lambda value: "model")
    monkeypatch.setattr(service, "_resolve_tokenizer_path", lambda value: "tokenizer.json")

    service.load_model()

    call = _FakeModel.calls[0]
    dtype_arg = "dtype" if vibevoice_cli._DTYPE_ARG_SUPPORTED else "torch_dtype"
    assert call["kwargs"][dtype_arg] == torch.bfloat16


def test_vibevoice_cli_load_model_uses_float32_for_cpu(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer_path.write_text("{}", encoding="utf-8")
    service = vibevoice_cli.VibeVoice(model_path=str(model_path), tokenizer_path=str(tokenizer_path))
    service.device = torch.device("cpu")
    _FakeModel.calls = []
    monkeypatch.setattr(
        vibevoice_cli,
        "_import_vibevoice_components",
        lambda: (_FakeModel, _FakeProcessor, _FakeProcessor, _FakeTokenizer),
    )
    monkeypatch.setattr(service, "_resolve_model_path", lambda value: "model")
    monkeypatch.setattr(service, "_resolve_tokenizer_path", lambda value: "tokenizer.json")

    service.load_model()

    call = _FakeModel.calls[0]
    dtype_arg = "dtype" if vibevoice_cli._DTYPE_ARG_SUPPORTED else "torch_dtype"
    assert call["kwargs"][dtype_arg] == torch.float32


def test_vibevoice_cli_tensor_creation_patch_uses_cpu_under_meta_default_device() -> None:
    if not hasattr(torch, "set_default_device") or not hasattr(torch, "get_default_device"):
        pytest.skip("torch default device API is not available")

    original_device = torch.get_default_device()
    try:
        torch.set_default_device("meta")
        with vibevoice_cli._torch_creation_cpu_when_default_device_is_meta():
            values = torch.linspace(0, 1, 2)
            tensor = torch.tensor([1.0])
            assert values.device.type == "cpu"
            assert tensor.device.type == "cpu"
            assert [value.item() for value in values] == [0.0, 1.0]
            assert tensor.item() == 1.0
    finally:
        torch.set_default_device(original_device)


def test_vibevoice_cli_installs_vibevoice_modules_utils_alias(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delitem(sys.modules, "vibevoice.modules.utils", raising=False)
    monkeypatch.delitem(sys.modules, "vibevoice.modules", raising=False)

    vibevoice_cli._install_vibevoice_modules_utils_alias()

    utils_module = sys.modules["vibevoice.modules.utils"]
    parsed_lines, speaker_ids = utils_module.parse_script_1_based("Speaker 2: こんにちは。")
    assert parsed_lines == [(1, " こんにちは。")]
    assert speaker_ids == [2]


def test_vibevoice_cli_rejects_missing_speech_output(tmp_path: Path) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer_path.write_text("{}", encoding="utf-8")
    service = vibevoice_cli.VibeVoice(
        model_path=str(model_path),
        tokenizer_path=str(tokenizer_path),
    )

    class FakeProcessor:
        tokenizer = object()

        def __call__(self, **kwargs):
            return {}

    class FakeModel:
        def set_ddpm_inference_steps(self, num_steps):
            self.num_steps = num_steps

        def generate(self, **kwargs):
            return SimpleNamespace(speech_outputs=[None])

    service.processor = FakeProcessor()
    service.model = FakeModel()

    with pytest.raises(RuntimeError, match="音声波形を返しませんでした"):
        service._synthesize_script(
            script_text="Speaker 1: こんにちは。",
            voice_samples_np=[],
            cfg_scale=1.3,
            inference_steps=2,
            do_sample=True,
            temperature=0.95,
            top_p=0.95,
            top_k=0,
        )


def test_vibevoice_cli_uses_parsed_script_processor_path_when_supported(tmp_path: Path) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer_path.write_text("{}", encoding="utf-8")
    service = vibevoice_cli.VibeVoice(
        model_path=str(model_path),
        tokenizer_path=str(tokenizer_path),
    )
    processor_calls = []
    generate_calls = []

    class FakeProcessor:
        tokenizer = object()

        def __call__(
            self,
            *,
            parsed_scripts=None,
            voice_samples=None,
            speaker_ids_for_prompt=None,
            padding=True,
            return_tensors=None,
            return_attention_mask=True,
        ):
            kwargs = {
                "parsed_scripts": parsed_scripts,
                "voice_samples": voice_samples,
                "speaker_ids_for_prompt": speaker_ids_for_prompt,
                "padding": padding,
                "return_tensors": return_tensors,
                "return_attention_mask": return_attention_mask,
            }
            processor_calls.append(kwargs)
            return {}

    class FakeModel:
        def set_ddpm_inference_steps(self, num_steps):
            self.num_steps = num_steps

        def generate(self, **kwargs):
            generate_calls.append(kwargs)
            return SimpleNamespace(speech_outputs=[None])

    service.processor = FakeProcessor()
    service.model = FakeModel()

    with pytest.raises(RuntimeError, match="音声波形を返しませんでした"):
        service._synthesize_script(
            script_text="Speaker 2: こんにちは。",
            voice_samples_np=[],
            speaker_ids_for_prompt=[1, 2],
            cfg_scale=1.3,
            inference_steps=2,
            do_sample=True,
            temperature=0.95,
            top_p=0.95,
            top_k=0,
        )

    assert processor_calls
    assert processor_calls[0]["parsed_scripts"] == [[(1, " こんにちは。")]]
    assert processor_calls[0]["speaker_ids_for_prompt"] == [[1, 2]]
    assert "text" not in processor_calls[0]
    assert generate_calls[0]["max_new_tokens"] < 150


def test_vibevoice_cli_falls_back_to_raw_text_processor_path(tmp_path: Path) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer_path.write_text("{}", encoding="utf-8")
    service = vibevoice_cli.VibeVoice(
        model_path=str(model_path),
        tokenizer_path=str(tokenizer_path),
    )
    processor_calls = []
    generate_calls = []

    class FakeProcessor:
        tokenizer = object()

        def __call__(self, **kwargs):
            processor_calls.append(kwargs)
            return {}

    class FakeModel:
        def set_ddpm_inference_steps(self, num_steps):
            self.num_steps = num_steps

        def generate(self, **kwargs):
            generate_calls.append(kwargs)
            return SimpleNamespace(speech_outputs=[None])

    service.processor = FakeProcessor()
    service.model = FakeModel()

    with pytest.raises(RuntimeError, match="音声波形を返しませんでした"):
        service._synthesize_script(
            script_text="Speaker 2: こんにちは。",
            voice_samples_np=[],
            speaker_ids_for_prompt=[1, 2],
            cfg_scale=1.3,
            inference_steps=2,
            do_sample=True,
            temperature=0.95,
            top_p=0.95,
            top_k=0,
        )

    assert processor_calls
    assert processor_calls[0]["text"] == ["Speaker 2: こんにちは。"]
    assert "parsed_scripts" not in processor_calls[0]
    assert "speaker_ids_for_prompt" not in processor_calls[0]
    assert generate_calls[0]["max_new_tokens"] < 150


def test_vibevoice_cli_can_use_model_default_generation_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer_path.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("VIBEVOICE_GENERATION_CONFIG_MODE", "model_default")
    service = vibevoice_cli.VibeVoice(
        model_path=str(model_path),
        tokenizer_path=str(tokenizer_path),
    )
    generate_calls = []

    class FakeProcessor:
        tokenizer = object()

        def __call__(self, **kwargs):
            return {}

    class FakeModel:
        def set_ddpm_inference_steps(self, num_steps):
            self.num_steps = num_steps

        def generate(self, **kwargs):
            generate_calls.append(kwargs)
            return SimpleNamespace(speech_outputs=[torch.zeros(10, dtype=torch.float32)])

    service.processor = FakeProcessor()
    service.model = FakeModel()

    waveform = service._synthesize_script(
        script_text="Speaker 1: こんにちは。",
        voice_samples_np=[],
        cfg_scale=1.3,
        inference_steps=2,
        do_sample=True,
        temperature=0.95,
        top_p=0.95,
        top_k=0,
    )

    assert waveform.shape == (10,)
    assert "generation_config" not in generate_calls[0]


def test_vibevoice_cli_adds_large_stability_logits_processors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer_path.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("VIBEVOICE_GENERATION_CONFIG_MODE", "explicit")
    monkeypatch.setenv("VIBEVOICE_MIN_AUDIO_TOKENS", "1")
    service = vibevoice_cli.VibeVoice(
        model_path=str(model_path),
        tokenizer_path=str(tokenizer_path),
    )
    generate_calls = []

    class FakeTokenizer:
        eos_token_id = 1
        speech_start_id = 2
        speech_end_id = 3
        speech_diffusion_id = 4

    class FakeProcessor:
        tokenizer = FakeTokenizer()

        def __call__(self, **kwargs):
            return {"input_ids": torch.tensor([[10, 11]])}

    class FakeModel:
        def set_ddpm_inference_steps(self, num_steps):
            self.num_steps = num_steps

        def generate(self, **kwargs):
            generate_calls.append(kwargs)
            return SimpleNamespace(speech_outputs=[torch.zeros(10, dtype=torch.float32)])

    service.processor = FakeProcessor()
    service.model = FakeModel()

    service._synthesize_script(
        script_text="Speaker 1: こんにちは。",
        voice_samples_np=[],
        cfg_scale=1.3,
        inference_steps=2,
        do_sample=True,
        temperature=0.95,
        top_p=0.95,
        top_k=0,
    )

    call = generate_calls[0]
    assert call["generation_config"]["do_sample"] is True
    assert "logits_processor" in call
    assert any(isinstance(item, vibevoice_cli._FiniteLogitsProcessor) for item in call["logits_processor"])
    assert any(isinstance(item, vibevoice_cli._MinAudioTokensProcessor) for item in call["logits_processor"])


def test_vibevoice_cli_min_audio_tokens_processor_masks_early_stop_tokens() -> None:
    processor = vibevoice_cli._MinAudioTokensProcessor(
        prompt_length=2,
        speech_diffusion_id=4,
        blocked_token_ids=[1, 2, 3],
        min_audio_tokens=1,
    )
    scores = torch.zeros((1, 6), dtype=torch.float32)

    masked = processor(torch.tensor([[10, 11]]), scores.clone())
    assert torch.isneginf(masked[0, 1])
    assert torch.isneginf(masked[0, 2])
    assert torch.isneginf(masked[0, 3])
    assert masked[0, 4] == 0

    unmasked = processor(torch.tensor([[10, 11, 4]]), scores.clone())
    assert unmasked[0, 1] == 0
    assert unmasked[0, 2] == 0
    assert unmasked[0, 3] == 0


def test_vibevoice_cli_finite_logits_processor_removes_nan_and_inf() -> None:
    processor = vibevoice_cli._FiniteLogitsProcessor()
    scores = torch.tensor([[float("nan"), float("inf"), float("-inf"), 0.5]], dtype=torch.float32)

    cleaned = processor(torch.tensor([[1]]), scores)

    assert torch.isfinite(cleaned[0, 0])
    assert torch.isfinite(cleaned[0, 1])
    assert torch.isfinite(cleaned[0, 2])
    assert cleaned[0, 0] < cleaned[0, 3]
    assert cleaned[0, 2] < cleaned[0, 3]
    assert cleaned[0, 1] > cleaned[0, 3]


def test_vibevoice_cli_patches_internal_token_constraint_for_safe_sampling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VIBEVOICE_MIN_AUDIO_TOKENS", "1")

    class FakeTokenConstraintProcessor:
        def __init__(self, valid_token_ids, device=None):
            self.valid_token_ids = torch.tensor(valid_token_ids, dtype=torch.long, device=device)

        def __call__(self, input_ids, scores):
            mask = torch.full_like(scores, float("-inf"))
            mask[:, self.valid_token_ids] = 0
            return scores + mask

    vibevoice_cli._patch_vibevoice_token_constraint_processor_for_safe_sampling(FakeTokenConstraintProcessor)
    processor = FakeTokenConstraintProcessor([2, 3, 4, 1, 0])
    scores = torch.full((1, 6), float("-inf"), dtype=torch.float32)
    scores[0, 5] = 999.0
    scores[0, 4] = float("nan")

    fixed = processor(torch.tensor([[10, 11]]), scores)

    assert torch.isfinite(fixed[0, 4])
    assert torch.isneginf(fixed[0, 0])
    assert torch.isneginf(fixed[0, 1])
    assert torch.isneginf(fixed[0, 2])
    assert torch.isneginf(fixed[0, 3])
    assert torch.isneginf(fixed[0, 5])
    assert torch.isfinite(torch.nn.functional.softmax(fixed, dim=-1)).all()


def test_vibevoice_cli_estimates_generation_tokens_from_script_text() -> None:
    short_tokens = vibevoice_cli._estimate_vibevoice_max_new_tokens("Speaker 1: こんにちは。")
    long_tokens = vibevoice_cli._estimate_vibevoice_max_new_tokens(
        "\n".join(
            [
                "Speaker 1: こんにちは。今日は北海道の暮らしについて話します。",
                "Speaker 2: 自然が多く、温泉も近くにあって、とても快適です。",
                "Speaker 1: 仕事は牧場で、牛の世話や搾乳をしています。",
            ]
        )
    )

    assert short_tokens < 150
    assert long_tokens > short_tokens


def test_vibevoice_cli_line_by_line_normalizes_each_segment_to_matching_voice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer_path.write_text("{}", encoding="utf-8")
    script_path = tmp_path / "script.txt"
    script_path.write_text("Speaker 1: こんにちは。\nSpeaker 2: はい。\n", encoding="utf-8")
    voice1 = tmp_path / "voice1.wav"
    voice2 = tmp_path / "voice2.wav"
    voice1.write_bytes(b"voice1")
    voice2.write_bytes(b"voice2")
    service = vibevoice_cli.VibeVoice(
        model_path=str(model_path),
        tokenizer_path=str(tokenizer_path),
    )
    service.model = object()
    service.processor = object()
    monkeypatch.setattr(vibevoice_cli, "LINE_CACHE_ROOT", tmp_path / "cache")
    speaker1_voice = np.array([1.0], dtype=np.float32)
    speaker2_voice = np.array([2.0], dtype=np.float32)
    monkeypatch.setattr(service, "_build_voice_samples", lambda _voice_files, _speaker_ids: [speaker1_voice, speaker2_voice])
    synthesize_calls = []

    def fake_synthesize_script(script_text, voice_samples_np, **kwargs):
        synthesize_calls.append((script_text, voice_samples_np))
        return np.zeros(vibevoice_cli.SAMPLE_RATE // 100, dtype=np.float32)

    monkeypatch.setattr(service, "_synthesize_script", fake_synthesize_script)

    service.generate_audio_line_by_line(
        text_file=str(script_path),
        voice_files={1: str(voice1), 2: str(voice2)},
        output_path=str(tmp_path / "out.wav"),
        line_output_dir=str(tmp_path / "segments"),
        metadata_path=str(tmp_path / "out.wav.json"),
        force=True,
    )

    assert synthesize_calls[0][0] == "Speaker 1: こんにちは。"
    assert synthesize_calls[0][1] == [speaker1_voice]
    assert synthesize_calls[1][0] == "Speaker 1: はい。"
    assert synthesize_calls[1][1] == [speaker2_voice]
