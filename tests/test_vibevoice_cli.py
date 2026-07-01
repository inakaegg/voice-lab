from __future__ import annotations

from types import SimpleNamespace

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


def test_vibevoice_cli_passes_parsed_scripts_to_processor(tmp_path: Path) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    tokenizer_path = tmp_path / "tokenizer.json"
    tokenizer_path.write_text("{}", encoding="utf-8")
    service = vibevoice_cli.VibeVoice(
        model_path=str(model_path),
        tokenizer_path=str(tokenizer_path),
    )
    processor_calls = []

    class FakeProcessor:
        tokenizer = object()

        def __call__(self, **kwargs):
            processor_calls.append(kwargs)
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
    assert "text" not in processor_calls[0]
    assert processor_calls[0]["parsed_scripts"] == [[(1, " こんにちは。")]]
    assert processor_calls[0]["speaker_ids_for_prompt"] == [[1, 2]]
