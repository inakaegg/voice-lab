from __future__ import annotations

from collections import Counter

import pytest

from scripts.evaluate_practice_quality_v2_matrix import (
    alignment_inputs,
    evaluate_fixture,
    load_fixture,
)


FIXTURE = load_fixture()
EVALUATION = evaluate_fixture(FIXTURE)


def test_matrix_has_the_predeclared_independent_shape() -> None:
    alignment = FIXTURE["alignment_cases"]
    spoken = FIXTURE["spoken_form_cases"]
    scores = FIXTURE["score_cases"]
    all_cases = [*alignment, *spoken, *scores]

    assert FIXTURE["fixture_contract_version"] == 1
    assert len(alignment) == 60
    assert Counter(case["axis"] for case in alignment) == {"gap": 25, "timestamp": 35}
    assert len(spoken) == 32
    assert len(scores) == 30
    assert len(all_cases) == 122
    assert Counter(case["split"] for case in all_cases) == {"challenge": 85, "validation": 37}
    assert len({case["name"] for case in all_cases}) == 122
    assert "before runtime evaluation" in FIXTURE["expectation_policy"]


@pytest.mark.parametrize(
    ("case", "result"),
    zip(FIXTURE["alignment_cases"], EVALUATION["alignment"], strict=True),
    ids=[case["name"] for case in FIXTURE["alignment_cases"]],
)
def test_alignment_matrix_expectations(case: dict[str, object], result: dict[str, object]) -> None:
    phrases = result["phrases"]
    assert [phrase["index"] for phrase in phrases if phrase["available"]] == case[
        "expected_playable_phrase_indexes"
    ]

    if "expected_text_only_phrase_indexes" in case:
        assert [
            phrase["index"] for phrase in phrases if phrase["assignment_status"] == "text_only"
        ] == case["expected_text_only_phrase_indexes"]

    if "expected_word_owners" in case:
        raw_word_count = len(alignment_inputs(case)["asr_timestamps"]["words"])
        actual_owners: list[int | None] = [None] * raw_word_count
        for phrase in phrases:
            start = phrase["word_start_index"]
            end = phrase["word_end_index"]
            if start is None or end is None:
                continue
            for word_index in range(start, end):
                assert actual_owners[word_index] is None
                actual_owners[word_index] = phrase["index"]
        assert actual_owners == case["expected_word_owners"]

    for phrase_index, expected_range in case.get("expected_audio_ranges", {}).items():
        phrase = phrases[int(phrase_index)]
        assert [phrase["audio_start"], phrase["audio_end"]] == pytest.approx(expected_range)

    for phrase_index, expected_source in case.get("expected_timestamp_sources", {}).items():
        assert phrases[int(phrase_index)]["timestamp_source"] == expected_source

    flags = result["diagnostics"]["diagnostic_flags"]
    assert set(case.get("expected_flags_contains", [])).issubset(flags)

    invalid_units = result["diagnostics"]["invalid_timestamp_units"]
    if "expected_invalid_word_indexes" in case:
        assert [
            unit["source_index"] for unit in invalid_units if unit["source"] == "words"
        ] == case["expected_invalid_word_indexes"]
    if "expected_invalid_segment_indexes" in case:
        assert [
            unit["source_index"] for unit in invalid_units if unit["source"] == "segments"
        ] == case["expected_invalid_segment_indexes"]


@pytest.mark.parametrize(
    ("case", "actual"),
    zip(FIXTURE["spoken_form_cases"], EVALUATION["spoken_forms"], strict=True),
    ids=[case["name"] for case in FIXTURE["spoken_form_cases"]],
)
def test_spoken_form_matrix(case: dict[str, object], actual: bool) -> None:
    assert actual is case["expected"]


@pytest.mark.parametrize(
    ("case", "result"),
    zip(FIXTURE["score_cases"], EVALUATION["scores"], strict=True),
    ids=[case["name"] for case in FIXTURE["score_cases"]],
)
def test_score_matrix(case: dict[str, object], result: dict[str, object]) -> None:
    assert result["similarity"] == pytest.approx(
        min(result["global_similarity"], result["phrase_macro_similarity"])
    )
    if "expected_unconsumed" in case:
        assert [entry["normalized_text"] for entry in result["unconsumed_recognized"]] == case[
            "expected_unconsumed"
        ]
    if "expected_similarity" in case:
        assert result["similarity"] == pytest.approx(case["expected_similarity"])
    if "expected_phrase_recognized" in case:
        assert [match["normalized_recognized"] for match in result["phrase_matches"]] == case[
            "expected_phrase_recognized"
        ]
    for phrase_index, expected_text in case.get("expected_phrase_recognized_by_index", {}).items():
        assert result["phrase_matches"][int(phrase_index)]["normalized_recognized"] == expected_text
    if case.get("expect_below_one"):
        assert result["similarity"] < 1.0
    if case.get("expect_below_weighted_phrase"):
        assert result["similarity"] < result["phrase_similarity"]
