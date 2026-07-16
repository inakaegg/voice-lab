import json
from pathlib import Path

import pytest

from mo_speech.practice import practice_comparison_alignment


CASES = json.loads((Path(__file__).parent / "fixtures" / "practice_alignment_cases.json").read_text())
GOLDEN_CASES = [
    *json.loads((Path(__file__).parent / "fixtures" / "practice_alignment_golden_cases.json").read_text()),
    *json.loads((Path(__file__).parent / "fixtures" / "practice_alignment_boundary_cases.json").read_text()),
]
HOLDOUT_CASES = json.loads(
    (Path(__file__).parent / "fixtures" / "practice_alignment_holdout_cases.json").read_text()
)
VALIDATION_CASES = json.loads(
    (Path(__file__).parent / "fixtures" / "practice_alignment_validation_cases.json").read_text()
)
REGRESSION_CASES = json.loads(
    (Path(__file__).parent / "fixtures" / "practice_alignment_regression_cases.json").read_text()
)


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_practice_comparison_alignment_cases(case: dict[str, object]) -> None:
    result = practice_comparison_alignment(
        target_text=str(case["target_text"]),
        recognized_text=str(case["recognized_text"]),
        target_language=str(case["target_language"]),
        asr_timestamps=case["asr_timestamps"],
    )
    expected = case["expected"]
    ranges = result["ranges"]

    assert result["complete"] is expected["complete"]
    assert len(ranges) == expected["range_count"]

    if "available" in expected:
        assert result["available"] is expected["available"]
    if "first_start" in expected:
        assert ranges[0]["audio_start"] == pytest.approx(expected["first_start"])
    if "last_end" in expected:
        assert ranges[-1]["audio_end"] == pytest.approx(expected["last_end"])
    if "targets" in expected:
        assert [entry["target"] for entry in ranges] == expected["targets"]
    if "sources" in expected:
        assert {entry["source"] for entry in ranges if entry["available"]} == set(expected["sources"])
    if "unavailable_indexes" in expected:
        unavailable = [entry["index"] for entry in ranges if not entry["available"]]
        assert unavailable == expected["unavailable_indexes"]


def test_practice_comparison_alignment_excludes_filler_from_audio_range() -> None:
    result = practice_comparison_alignment(
        target_text="I bought a bike.",
        recognized_text="um I bought a bike",
        target_language="en-US",
        asr_timestamps={
            "available": True,
            "words": [
                {"text": "um", "start": 0.0, "end": 0.4},
                {"text": "I", "start": 0.6, "end": 0.7},
                {"text": "bought", "start": 0.7, "end": 1.1},
                {"text": "a", "start": 1.1, "end": 1.2},
                {"text": "bike", "start": 1.2, "end": 1.5},
            ],
        },
    )

    assert result["complete"] is True
    assert result["ranges"][0]["audio_start"] == pytest.approx(0.6)
    assert result["ranges"][0]["matched_text"] == "I bought a bike"


def test_practice_comparison_alignment_keeps_the_mistaken_end_of_a_phrase_on_a_similarity_tie() -> None:
    result = practice_comparison_alignment(
        target_text="你好吗？你今天去哪里？",
        recognized_text="你哈吗？你今天到那里？",
        target_language="zh-CN",
        asr_timestamps={
            "available": True,
            "words": [
                {"text": "你哈吗", "start": 0.1, "end": 0.8},
                {"text": "你今天", "start": 1.0, "end": 1.5},
                {"text": "到那里", "start": 1.5, "end": 2.3},
            ],
        },
    )

    second_phrase = result["ranges"][1]
    assert second_phrase["normalized_recognized"] == "你今天到那里"
    assert second_phrase["matched_text"] == "你今天到那里"
    assert second_phrase["audio_start"] == pytest.approx(1.0)
    assert second_phrase["audio_end"] == pytest.approx(2.3)


def test_long_eight_phrase_alignment_reuses_candidate_scores() -> None:
    target_text = (
        "你知道吗？北海道里面也有比较热的地方，也有比较冷、比较凉快的地方。"
        "不同地区的气候、气温其实差别还挺大的。毕竟北海道很大嘛，当然中国更大就是了。"
    )
    recognized_text = (
        "你知道吗北海道里面也有比较露的地方也有比较比较让比较让可爱的地方"
        "不懂及地主的气候资源其是差别还挺大的毕竟北海道很大嘛当然中国感大就是啊"
    )
    words = [
        {"text": character, "start": index * 0.3, "end": index * 0.3 + 0.24}
        for index, character in enumerate(recognized_text)
    ]

    result = practice_comparison_alignment(
        target_text=target_text,
        recognized_text=recognized_text,
        target_language="zh-CN",
        asr_timestamps={"available": True, "words": words},
    )

    assert result["target_phrase_count"] == 8
    assert result["diagnostics"]["candidate_count"] > 0
    assert result["diagnostics"]["score_computation_count"] < 20_000


@pytest.mark.parametrize("case", GOLDEN_CASES, ids=[case["name"] for case in GOLDEN_CASES])
def test_practice_comparison_alignment_golden_cases(case: dict[str, object]) -> None:
    _assert_practice_comparison_alignment_case(case)


@pytest.mark.parametrize("case", HOLDOUT_CASES, ids=[case["name"] for case in HOLDOUT_CASES])
def test_practice_comparison_alignment_holdout_cases(case: dict[str, object]) -> None:
    _assert_practice_comparison_alignment_case(case)


@pytest.mark.parametrize("case", VALIDATION_CASES, ids=[case["name"] for case in VALIDATION_CASES])
def test_practice_comparison_alignment_validation_cases(case: dict[str, object]) -> None:
    _assert_practice_comparison_alignment_case(case)


@pytest.mark.parametrize("case", REGRESSION_CASES, ids=[case["name"] for case in REGRESSION_CASES])
def test_practice_comparison_alignment_regression_cases(case: dict[str, object]) -> None:
    result = _assert_practice_comparison_alignment_case(case)
    ranges = result["ranges"]
    available_ranges = [entry for entry in ranges if entry["available"]]
    token_ranges = [
        (int(entry["token_start_index"]), int(entry["token_end_index"]))
        for entry in available_ranges
    ]
    assert token_ranges == sorted(token_ranges)
    assert all(left[1] <= right[0] for left, right in zip(token_ranges, token_ranges[1:]))
    audio_ranges = [(float(entry["audio_start"]), float(entry["audio_end"])) for entry in available_ranges]
    assert all(start < end for start, end in audio_ranges)
    assert all(left[1] <= right[0] for left, right in zip(audio_ranges, audio_ranges[1:]))
    if result["complete"]:
        unexplained = [
            token
            for token in result["diagnostics"]["unassigned_tokens"]
            if token["reason"] == "unexplained_internal_token"
        ]
        assert unexplained == []
    zero_text = "".join(str(token["text"]) for token in result["diagnostics"]["zero_duration_tokens"])
    if case["category"] == "zero_duration":
        expected_zero_text = "".join(
            str(token["text"])
            for token in case["asr_timestamps"]["words"]
            if token["start"] == token["end"]
        )
        assert zero_text == expected_zero_text


def _assert_practice_comparison_alignment_case(case: dict[str, object]) -> dict[str, object]:
    result = practice_comparison_alignment(
        target_text=str(case["target_text"]),
        recognized_text=str(case["recognized_text"]),
        target_language=str(case["target_language"]),
        asr_timestamps=case["asr_timestamps"],
    )
    expected = case["expected"]

    assert result["available"] is expected["available"]
    assert result["complete"] is expected["complete"]
    assert len(result["ranges"]) == len(expected["ranges"])
    for actual_range, expected_range in zip(result["ranges"], expected["ranges"], strict=True):
        assert actual_range["index"] == expected_range["index"]
        assert actual_range["source"] == expected_range["source"]
        assert actual_range["available"] is expected_range["available"]
        assert actual_range["matched_text"] == expected_range["matched_text"]
        if expected_range["audio_start"] is None:
            assert actual_range["audio_start"] is None
        else:
            assert actual_range["audio_start"] == pytest.approx(expected_range["audio_start"])
        if expected_range["audio_end"] is None:
            assert actual_range["audio_end"] is None
        else:
            assert actual_range["audio_end"] == pytest.approx(expected_range["audio_end"])
    return result
