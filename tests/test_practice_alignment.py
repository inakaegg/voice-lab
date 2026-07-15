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


@pytest.mark.parametrize("case", GOLDEN_CASES, ids=[case["name"] for case in GOLDEN_CASES])
def test_practice_comparison_alignment_golden_cases(case: dict[str, object]) -> None:
    _assert_practice_comparison_alignment_case(case)


@pytest.mark.parametrize("case", HOLDOUT_CASES, ids=[case["name"] for case in HOLDOUT_CASES])
def test_practice_comparison_alignment_holdout_cases(case: dict[str, object]) -> None:
    _assert_practice_comparison_alignment_case(case)


@pytest.mark.parametrize("case", VALIDATION_CASES, ids=[case["name"] for case in VALIDATION_CASES])
def test_practice_comparison_alignment_validation_cases(case: dict[str, object]) -> None:
    _assert_practice_comparison_alignment_case(case)


def _assert_practice_comparison_alignment_case(case: dict[str, object]) -> None:
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
