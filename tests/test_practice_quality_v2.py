import json
from pathlib import Path

import pytest

from mo_speech.practice import (
    evaluate_practice_attempt,
    practice_comparison_alignment_canonical,
    practice_content_matches,
)


FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "practice_quality_v2_cases.json").read_text()
)


@pytest.mark.parametrize(
    "case",
    FIXTURE["alignment_cases"],
    ids=[case["name"] for case in FIXTURE["alignment_cases"]],
)
def test_real_audio_challenge_alignment_expectations(case: dict[str, object]) -> None:
    result = practice_comparison_alignment_canonical(
        target_text=str(case["target_text"]),
        recognized_text=str(case["recognized_text"]),
        target_language=str(case["target_language"]),
        asr_timestamps=case["asr_timestamps"],
    )
    expected = case["expected"]

    assert [
        phrase["index"] for phrase in result["phrases"] if phrase["available"]
    ] == expected["playable_phrase_indexes"]
    assert [phrase["matched_text"] for phrase in result["phrases"]] == expected["matched_text_by_phrase"]
    if "assignment_statuses" in expected:
        assert [phrase["assignment_status"] for phrase in result["phrases"]] == expected["assignment_statuses"]
    if "content_matched_by_phrase" in expected:
        assert [phrase["content_matched"] for phrase in result["phrases"]] == expected["content_matched_by_phrase"]
    if "audio_ranges" in expected:
        assert [
            [phrase["audio_start"], phrase["audio_end"]]
            for phrase in result["phrases"]
            if phrase["available"]
        ] == expected["audio_ranges"]
    if "unassigned_word_indexes" in expected:
        assert [
            token["source_index"]
            for token in result["diagnostics"]["unassigned_tokens"]
            if token["source"] == "words"
        ] == expected["unassigned_word_indexes"]
    if "diagnostic_flags" in expected:
        assert result["diagnostics"]["diagnostic_flags"] == expected["diagnostic_flags"]


@pytest.mark.parametrize(
    "case",
    FIXTURE["spoken_form_cases"],
    ids=[case["name"] for case in FIXTURE["spoken_form_cases"]],
)
def test_chinese_spoken_form_contract(case: dict[str, object]) -> None:
    assert practice_content_matches(
        str(case["target"]),
        str(case["recognized"]),
        "zh-CN",
    ) is case["expected"]


@pytest.mark.parametrize(
    "case",
    FIXTURE["score_cases"],
    ids=[case["name"] for case in FIXTURE["score_cases"]],
)
def test_score_uses_global_and_phrase_macro_without_hiding_text(case: dict[str, object]) -> None:
    result = evaluate_practice_attempt(
        str(case["target_text"]),
        str(case["recognized_text"]),
        str(case["target_language"]),
    )

    assert result["similarity"] == pytest.approx(
        min(result["global_similarity"], result["phrase_macro_similarity"])
    )
    assert result["similarity"] <= result["global_similarity"]
    assert result["similarity"] <= result["phrase_macro_similarity"]
    assert [entry["normalized_text"] for entry in result["unconsumed_recognized"]] == case[
        "expected_unconsumed"
    ]
    if case["name"] == "short_phrase_major_difference_affects_final_score":
        assert result["similarity"] < result["phrase_similarity"]
    if case["name"] == "exact_text_remains_perfect":
        assert result["similarity"] == 1.0
