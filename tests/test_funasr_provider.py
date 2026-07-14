from __future__ import annotations

from pathlib import Path

from mo_speech.providers.funasr import FunAsrPracticeProvider, transcription_from_funasr_result


def test_funasr_result_maps_character_timestamps_from_milliseconds_to_seconds() -> None:
    transcription = transcription_from_funasr_result(
        {
            "text": "在中国的 AI 服务。",
            "raw_text": "在 中 国 的 AI 服 务",
            "timestamp": [
                [100, 220],
                [220, 340],
                [340, 460],
                [460, 580],
                [580, 820],
                [820, 940],
                [940, 1080],
            ],
        },
        model="funasr/paraformer-zh",
    )

    assert transcription.text == "在中国的 AI 服务。"
    assert transcription.model == "funasr/paraformer-zh"
    assert transcription.timestamp_granularities == ["word"]
    assert [row["text"] for row in transcription.words] == ["在", "中", "国", "的", "AI", "服", "务"]
    assert transcription.words[0] == {"text": "在", "start": 0.1, "end": 0.22}
    assert transcription.words[-1] == {"text": "务", "start": 0.94, "end": 1.08}
    assert transcription.segments == [{"text": "在中国的 AI 服务。", "start": 0.1, "end": 1.08}]


def test_funasr_result_drops_invalid_or_unpaired_timestamps() -> None:
    transcription = transcription_from_funasr_result(
        {
            "text": "你好",
            "raw_text": "你 好 多",
            "timestamp": [[100, 200], [300, 250]],
        },
        model="funasr/paraformer-zh",
    )

    assert transcription.words == [{"text": "你", "start": 0.1, "end": 0.2}]
    assert transcription.segments == [{"text": "你好", "start": 0.1, "end": 0.2}]


def test_funasr_provider_loads_once_and_releases_model(tmp_path: Path) -> None:
    factory_calls: list[dict[str, object]] = []
    generate_calls: list[tuple[str, dict[str, object]]] = []

    class FakeAutoModel:
        def generate(self, *, input: str, **kwargs):
            generate_calls.append((input, kwargs))
            return [{"text": "你好。", "raw_text": "你 好", "timestamp": [[0, 120], [120, 260]]}]

    def fake_factory(**kwargs):
        factory_calls.append(kwargs)
        return FakeAutoModel()

    audio_path = tmp_path / "attempt.webm"
    audio_path.write_bytes(b"fake audio")
    provider = FunAsrPracticeProvider(auto_model_factory=fake_factory)

    first = provider.transcribe_detail(audio_path, "zh-CN", include_timestamps=True)
    second = provider.transcribe_detail(audio_path, "zh-CN", include_timestamps=True)

    assert first.text == "你好。"
    assert second.words[-1]["end"] == 0.26
    assert len(factory_calls) == 1
    assert factory_calls[0]["model"] == "funasr/paraformer-zh"
    assert factory_calls[0]["vad_model"] == "funasr/fsmn-vad"
    assert factory_calls[0]["punc_model"] == "funasr/ct-punc"
    assert factory_calls[0]["device"] == "cuda"
    assert generate_calls[0][0] == str(audio_path)
    assert generate_calls[0][1]["pred_timestamp"] is True
    assert generate_calls[0][1]["return_raw_text"] is True
    assert provider.loaded is True

    provider.release()

    assert provider.loaded is False


def test_funasr_provider_rejects_non_chinese_input(tmp_path: Path) -> None:
    audio_path = tmp_path / "attempt.wav"
    audio_path.write_bytes(b"fake audio")
    provider = FunAsrPracticeProvider(auto_model_factory=lambda **_kwargs: object())

    try:
        provider.transcribe_detail(audio_path, "en-US", include_timestamps=True)
    except ValueError as exc:
        assert str(exc) == "FunASR practice ASR only supports zh-CN"
    else:
        raise AssertionError("expected ValueError")
