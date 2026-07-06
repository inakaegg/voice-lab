import json
from pathlib import Path

import pytest

from mo_speech.practice import practice_comparison_alignment


CASES = json.loads((Path(__file__).parent / "fixtures" / "practice_alignment_cases.json").read_text())


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
