from __future__ import annotations

from pathlib import Path

from mo_speech.providers.funasr import (
    FunAsrPracticeProvider,
    refine_funasr_word_timestamps,
    transcription_from_funasr_result,
)
from mo_speech.practice import practice_comparison_alignment_canonical


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


def test_funasr_result_clamps_small_negative_leading_timestamp() -> None:
    transcription = transcription_from_funasr_result(
        {
            "text": "你好",
            "raw_text": "你 好",
            "timestamp": [[-90, 30], [30, 120]],
        },
        model="funasr/paraformer-zh",
    )

    assert transcription.words == [
        {"text": "你", "start": 0.0, "end": 0.03},
        {"text": "好", "start": 0.03, "end": 0.12},
    ]


def test_refine_funasr_word_timestamps_uses_punctuation_backed_silence_boundaries() -> None:
    words = [
        {"text": character, "start": index * 0.3, "end": (index + 1) * 0.3}
        for index, character in enumerate("你好很高兴认识你我想买咖啡")
    ]

    refined = refine_funasr_word_timestamps(
        words,
        text="你好，很高兴认识你。我想买咖啡。",
        audio_duration_seconds=4.6,
        silence_intervals=[
            {"start": 0.52, "end": 0.84},
            {"start": 2.12, "end": 2.42},
        ],
    )

    assert refined[1]["end"] == 0.52
    assert refined[2]["start"] == 0.84
    assert refined[7]["end"] == 2.12
    assert refined[8]["start"] == 2.42
    assert refined[7]["raw_end"] == 2.4
    assert refined[8]["raw_start"] == 2.4


def test_refine_funasr_word_timestamps_maps_unpunctuated_learner_pause_by_order() -> None:
    words = [
        {"text": character, "start": index * 0.33, "end": (index + 1) * 0.33}
        for index, character in enumerate("我先去银行最后回家")
    ]

    refined = refine_funasr_word_timestamps(
        words,
        text="我先去银行最后回家。",
        audio_duration_seconds=3.3,
        silence_intervals=[{"start": 1.45, "end": 2.15}],
    )

    assert max(float(word["end"]) for word in refined[:5]) == 1.45
    assert min(float(word["start"]) for word in refined[5:]) == 2.15


def test_refine_funasr_word_timestamps_ignores_short_internal_gap_before_phrase_pause() -> None:
    words = [
        {"text": character, "start": index * 0.3, "end": (index + 1) * 0.3}
        for index, character in enumerate("我身体不太舒服昨天晚上没有睡好")
    ]

    refined = refine_funasr_word_timestamps(
        words,
        text="我身体不太舒服，昨天晚上没有睡好。",
        audio_duration_seconds=5.0,
        silence_intervals=[
            {"start": 1.22, "end": 1.308},
            {"start": 1.38, "end": 2.34},
        ],
    )

    assert refined[6]["end"] == 1.38
    assert refined[7]["start"] == 2.34


def test_refine_funasr_word_timestamps_reserves_later_punctuation_boundaries() -> None:
    text = "我明天去北京，北京不是上海，一直往前走，在第二个路口左转。"
    tokens = list("我明天去北京北京不是上海一直往前走在第二个路口左转")
    words = [
        {"text": token, "start": index * 0.3, "end": (index + 1) * 0.3}
        for index, token in enumerate(tokens)
    ]

    refined = refine_funasr_word_timestamps(
        words,
        text=text,
        audio_duration_seconds=7.6,
        silence_intervals=[
            {"start": 1.48, "end": 1.8},
            {"start": 2.31, "end": 2.63},
            {"start": 2.85, "end": 3.14},
            {"start": 3.97, "end": 4.28},
            {"start": 5.51, "end": 5.83},
        ],
    )

    assert refined[5]["end"] == 1.48
    assert refined[6]["start"] == 1.8
    assert refined[11]["end"] == 3.97
    assert refined[12]["start"] == 4.28
    assert refined[16]["end"] == 5.51
    assert refined[17]["start"] == 5.83


def test_refine_funasr_word_timestamps_selects_phrase_pause_from_extra_punctuation() -> None:
    tokens = list("周末你有什么计划请给我一杯咖啡")
    words = [
        {"text": token, "start": index * 0.22, "end": (index + 1) * 0.22}
        for index, token in enumerate(tokens)
    ]

    refined = refine_funasr_word_timestamps(
        words,
        text="周末，你有什么计划？请给我一杯咖啡。",
        audio_duration_seconds=3.5,
        silence_intervals=[{"start": 1.56, "end": 1.86}],
    )

    assert refined[7]["end"] == 1.56
    assert refined[8]["start"] == 1.86


def test_refine_funasr_word_timestamps_selects_one_boundary_when_candidates_outnumber_pauses() -> None:
    tokens = list("今天的天气很好就赚多少钱")
    words = [
        {"text": token, "start": 0.21 + (index * 0.3), "end": 0.21 + ((index + 1) * 0.3)}
        for index, token in enumerate(tokens)
    ]

    refined = refine_funasr_word_timestamps(
        words,
        text="今天的天气很好，就赚多少钱。",
        audio_duration_seconds=3.74,
        silence_intervals=[{"start": 1.562, "end": 2.311}],
        boundary_indices=[7, 9],
    )

    assert refined[6]["end"] == 1.562
    assert refined[7]["start"] == 2.311


def test_refine_funasr_word_timestamps_rescales_coarse_groups_without_zero_duration() -> None:
    tokens = list("今天我要去上课妈妈骂马吗")
    words = [
        {
            "text": token,
            "start": 0.21 + (index * 0.42),
            "end": 0.21 + ((index + 1) * 0.42),
        }
        for index, token in enumerate(tokens)
    ]

    refined = refine_funasr_word_timestamps(
        words,
        text="今天我要去上课妈妈骂马吗",
        audio_duration_seconds=3.5,
        silence_intervals=[{"start": 1.44, "end": 2.24}],
        boundary_indices=[7],
    )

    assert refined[0]["start"] == 0.0
    assert refined[6]["end"] == 1.44
    assert refined[7]["start"] == 2.24
    assert refined[-1]["end"] == 3.5
    assert all(float(word["end"]) > float(word["start"]) for word in refined)


def test_refine_funasr_word_timestamps_excludes_leading_and_trailing_silence() -> None:
    words = [
        {"text": token, "start": index * 0.4, "end": (index + 1) * 0.4}
        for index, token in enumerate("你好谢谢")
    ]

    refined = refine_funasr_word_timestamps(
        words,
        text="你好。谢谢。",
        audio_duration_seconds=3.0,
        silence_intervals=[
            {"start": 0.0, "end": 0.2},
            {"start": 1.1, "end": 1.5},
            {"start": 2.4, "end": 3.0},
        ],
        boundary_indices=[2],
    )

    assert refined[0]["start"] == 0.2
    assert refined[1]["end"] == 1.1
    assert refined[2]["start"] == 1.5
    assert refined[-1]["end"] == 2.4


def test_refine_funasr_word_timestamps_applies_outer_bounds_without_phrase_boundary() -> None:
    words = [
        {"text": token, "start": index * 0.4, "end": (index + 1) * 0.4}
        for index, token in enumerate("我回家")
    ]

    refined = refine_funasr_word_timestamps(
        words,
        text="我回家。",
        audio_duration_seconds=2.0,
        silence_intervals=[
            {"start": 0.0, "end": 0.2},
            {"start": 1.4, "end": 2.0},
        ],
        boundary_indices=[],
    )

    assert refined[0]["start"] == 0.2
    assert refined[-1]["end"] == 1.4
    assert all(float(word["end"]) > float(word["start"]) for word in refined)


def test_refine_funasr_word_timestamps_prefers_long_phrase_pause_over_short_internal_pause() -> None:
    words = [
        {"text": str(index), "start": index * 0.2, "end": (index + 1) * 0.2}
        for index in range(29)
    ]

    refined = refine_funasr_word_timestamps(
        words,
        text="".join(str(index) for index in range(29)),
        audio_duration_seconds=5.9,
        silence_intervals=[
            {"start": 0.91, "end": 1.35},
            {"start": 2.28, "end": 2.74},
            {"start": 3.06, "end": 3.26},
            {"start": 4.22, "end": 4.67},
            {"start": 5.56, "end": 5.9},
        ],
        boundary_indices=[7, 14, 23],
    )

    assert refined[13]["end"] == 2.28
    assert refined[14]["start"] == 2.74


def test_funasr_provider_refines_with_target_phrase_boundaries_when_punctuation_is_missing(
    tmp_path: Path,
) -> None:
    tokens = list("周末你有什么计划请给我一杯咖啡")
    transcription = transcription_from_funasr_result(
        {
            "text": "周末，你有什么计划请给我一杯咖啡。",
            "raw_text": " ".join(tokens),
            "timestamp": [
                [index * 220, (index + 1) * 220]
                for index in range(len(tokens))
            ],
        },
        model="funasr/paraformer-zh",
    )
    provider = FunAsrPracticeProvider(
        audio_boundary_detector=lambda _path: (
            3.5,
            [{"start": 1.56, "end": 1.86}],
        )
    )

    refined = provider.refine_timestamps_for_target(
        transcription,
        tmp_path / "attempt.wav",
        target_text="周末你有什么计划？请给我一杯热咖啡。",
        target_language="zh-CN",
    )

    assert refined.words[7]["end"] == 1.56
    assert refined.words[8]["start"] == 1.86


def test_funasr_provider_bootstraps_low_content_phrase_from_acoustic_pause(
    tmp_path: Path,
) -> None:
    tokens = list("哇哇哇妈哇下午我想去庄园")
    transcription = transcription_from_funasr_result(
        {
            "text": "哇哇哇，妈哇，下午我想去庄园。",
            "raw_text": " ".join(tokens),
            "timestamp": [
                [index * 300, (index + 1) * 300]
                for index in range(len(tokens))
            ],
        },
        model="funasr/paraformer-zh",
    )
    provider = FunAsrPracticeProvider(
        audio_boundary_detector=lambda _path: (
            4.9,
            [
                {"start": 1.0, "end": 2.2},
                {"start": 4.2, "end": 4.9},
            ],
        )
    )

    refined = provider.refine_timestamps_for_target(
        transcription,
        tmp_path / "attempt.wav",
        target_text="早上好，我们开始吧。妈妈骂马吗？下午我想去公园。",
        target_language="zh-CN",
    )
    alignment = practice_comparison_alignment_canonical(
        target_text="早上好，我们开始吧。妈妈骂马吗？下午我想去公园。",
        recognized_text=refined.text,
        target_language="zh-CN",
        asr_timestamps={
            "available": True,
            "words": refined.words,
            "segments": refined.segments,
            "raw_timestamp_word_count": len(refined.words),
            "raw_timestamp_segment_count": len(refined.segments),
        },
    )

    assert [phrase["available"] for phrase in alignment["phrases"]] == [
        False,
        True,
        True,
    ]
    assert refined.words[4]["end"] == 1.0
    assert refined.words[5]["start"] == 2.2


def test_funasr_provider_keeps_unassigned_fillers_between_phrase_boundaries(
    tmp_path: Path,
) -> None:
    tokens = list("请告诉我怎么走等那个我想去火车站在第二个路口左转")
    transcription = transcription_from_funasr_result(
        {
            "text": "请告诉我怎么走，等那个我想去火车站在第二个路口左转。",
            "raw_text": " ".join(tokens),
            "timestamp": [
                [index * 200, (index + 1) * 200]
                for index in range(len(tokens))
            ],
        },
        model="funasr/paraformer-zh",
    )
    provider = FunAsrPracticeProvider(
        audio_boundary_detector=lambda _path: (
            4.9,
            [
                {"start": 0.9, "end": 1.36},
                {"start": 1.53, "end": 1.74},
                {"start": 1.97, "end": 2.17},
                {"start": 3.03, "end": 3.51},
                {"start": 4.56, "end": 4.9},
            ],
        )
    )

    refined = provider.refine_timestamps_for_target(
        transcription,
        tmp_path / "attempt.wav",
        target_text="请告诉我怎么走。我想去火车站。在第二个路口左转。",
        target_language="zh-CN",
    )
    alignment = practice_comparison_alignment_canonical(
        target_text="请告诉我怎么走。我想去火车站。在第二个路口左转。",
        recognized_text=refined.text,
        target_language="zh-CN",
        asr_timestamps={
            "available": True,
            "words": refined.words,
            "segments": refined.segments,
            "raw_timestamp_word_count": len(refined.words),
            "raw_timestamp_segment_count": len(refined.segments),
        },
    )

    assert alignment["phrases"][0]["audio_end"] == 0.9
    assert alignment["phrases"][1]["audio_start"] == 2.17
    assert [
        (token["source_index"], token["text"], token["reason"])
        for token in alignment["diagnostics"]["unassigned_tokens"]
    ] == [
        (8, "那", "boundary_filler"),
        (9, "个", "boundary_filler"),
    ]
    assert alignment["diagnostics"]["unassigned_tokens"][0]["start"] == 1.36
    assert alignment["diagnostics"]["unassigned_tokens"][-1]["end"] == 1.97


def test_funasr_provider_uses_lexical_boundary_when_raw_pause_splits_second_phrase(
    tmp_path: Path,
) -> None:
    tokens = list("周末你有审美计划今天是星期三")
    timestamps = []
    for index in range(len(tokens)):
        if index < 11:
            timestamps.append([index * 120, (index + 1) * 120])
        else:
            timestamps.append([2400 + ((index - 11) * 120), 2400 + ((index - 10) * 120)])
    transcription = transcription_from_funasr_result(
        {
            "text": "周末你有审美计划，今天是星期三。",
            "raw_text": " ".join(tokens),
            "timestamp": timestamps,
        },
        model="funasr/paraformer-zh",
    )
    provider = FunAsrPracticeProvider(
        audio_boundary_detector=lambda _path: (
            3.9,
            [
                {"start": 1.29, "end": 2.11},
                {"start": 2.88, "end": 3.01},
                {"start": 3.35, "end": 3.9},
            ],
        )
    )

    refined = provider.refine_timestamps_for_target(
        transcription,
        tmp_path / "attempt.wav",
        target_text="周末你有什么计划？今天是星期三。",
        target_language="zh-CN",
    )

    assert refined.words[7]["end"] == 1.29
    assert refined.words[8]["start"] == 2.11


def test_refine_funasr_word_timestamps_keeps_raw_ranges_without_reliable_silence() -> None:
    words = [
        {"text": "你", "start": 0.1, "end": 0.3},
        {"text": "好", "start": 0.3, "end": 0.6},
    ]

    refined = refine_funasr_word_timestamps(
        words,
        text="你好。",
        audio_duration_seconds=0.8,
        silence_intervals=[],
    )

    assert [(word["start"], word["end"]) for word in refined] == [(0.1, 0.3), (0.3, 0.6)]
    assert [(word["raw_start"], word["raw_end"]) for word in refined] == [(0.1, 0.3), (0.3, 0.6)]


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
    provider = FunAsrPracticeProvider(
        auto_model_factory=fake_factory,
        audio_boundary_detector=lambda _path: (0.3, []),
    )

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
