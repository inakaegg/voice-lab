from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

import pytest


FIXTURE_PATH = (
    Path(__file__).parent
    / "fixtures"
    / "practice_alignment_canonical"
    / "pilot_expectations.json"
)
SEGMENT_POLICY_FIXTURE_PATH = (
    Path(__file__).parent
    / "fixtures"
    / "practice_alignment_canonical"
    / "segment_policy_pilot_expectations.json"
)
ROUND2_CHALLENGE_FIXTURE_PATH = (
    Path(__file__).parent
    / "fixtures"
    / "practice_alignment_canonical"
    / "round2_challenge_expectations.json"
)
ATTEMPT_INTENT_FIXTURE_PATH = (
    Path(__file__).parent
    / "fixtures"
    / "practice_alignment_canonical"
    / "partial_overlap_attempt_intent.json"
)
ALLOWED_EXPECTATION_STATUSES = {
    "fixed",
    "evaluation_required",
    "adjudication_required",
    "ambiguous_excluded",
}


def _load_fixture(
    fixture_path: Path = FIXTURE_PATH,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    overlay = json.loads(fixture_path.read_text(encoding="utf-8"))
    source_path = (fixture_path.parent / overlay["source_fixture"]).resolve()
    source_bytes = source_path.read_bytes()
    assert hashlib.sha256(source_bytes).hexdigest() == overlay["source_sha256"]
    source_cases = json.loads(source_bytes)
    return overlay, source_cases


def _validate_phrase(
    phrase: dict[str, Any],
    *,
    source_case: dict[str, Any],
    phrase_count: int,
) -> None:
    assert set(phrase) == {
        "index",
        "source_index",
        "target_text",
        "assignment_status",
        "available",
        "matched_text",
        "text_source",
        "timestamp_source",
        "word_start_index",
        "word_end_index",
        "audio_start",
        "audio_end",
    }
    assert 0 <= phrase["index"] < phrase_count
    assert phrase["source_index"] >= 0
    assert phrase["assignment_status"] in {"assigned", "text_only", "unassigned"}
    assert phrase["text_source"] in {"words", "segments", "transcription", "none"}
    assert phrase["timestamp_source"] in {"words", "segments", "none"}

    if phrase["assignment_status"] == "assigned":
        assert phrase["available"] is True
        assert phrase["matched_text"]
        assert phrase["audio_start"] is not None
        assert phrase["audio_end"] > phrase["audio_start"]
    elif phrase["assignment_status"] == "text_only":
        assert phrase["available"] is False
        assert phrase["matched_text"]
        assert phrase["audio_start"] is None
        assert phrase["audio_end"] is None
        assert phrase["timestamp_source"] == "none"
    else:
        assert phrase["available"] is False
        assert phrase["matched_text"] == ""
        assert phrase["text_source"] == "none"
        assert phrase["timestamp_source"] == "none"
        assert phrase["word_start_index"] is None
        assert phrase["word_end_index"] is None
        assert phrase["audio_start"] is None
        assert phrase["audio_end"] is None

    if phrase["text_source"] != "words":
        if phrase["text_source"] == "segments" and phrase["available"]:
            assert any(
                segment["text"] == phrase["matched_text"]
                and segment["start"] == pytest.approx(phrase["audio_start"])
                and segment["end"] == pytest.approx(phrase["audio_end"])
                for segment in source_case["asr_timestamps"].get("segments") or []
            )
        return

    words = source_case["asr_timestamps"].get("words") or []
    start = phrase["word_start_index"]
    end = phrase["word_end_index"]
    assert isinstance(start, int)
    assert isinstance(end, int)
    assert 0 <= start < end <= len(words)
    owned_words = words[start:end]
    separator = "" if source_case["target_language"] in {"ja-JP", "zh-CN"} else " "
    assert phrase["matched_text"] == separator.join(str(word["text"]) for word in owned_words)
    positive_words = [word for word in owned_words if word["end"] > word["start"]]
    if phrase["available"]:
        assert positive_words
        assert phrase["audio_start"] == pytest.approx(min(word["start"] for word in positive_words))
        assert phrase["audio_end"] == pytest.approx(max(word["end"] for word in positive_words))


def _validate_fixed_case(case: dict[str, Any], source_case: dict[str, Any]) -> None:
    expected = case["expected"]
    assert set(expected) == {
        "outcome",
        "target_phrase_count",
        "playable_phrase_count",
        "all_phrases_playable",
        "unassigned_non_filler_count",
        "complete",
        "phrases",
        "zero_duration_owners",
    }
    assert expected["outcome"] in {"evaluated", "no_speech"}
    assert expected["target_phrase_count"] == len(expected["phrases"])
    assert [phrase["index"] for phrase in expected["phrases"]] == list(
        range(expected["target_phrase_count"])
    )
    joined_target = "".join(phrase["target_text"] for phrase in expected["phrases"])
    assert re.sub(r"\s+", "", joined_target) == re.sub(r"\s+", "", source_case["target_text"])

    for phrase in expected["phrases"]:
        _validate_phrase(
            phrase,
            source_case=source_case,
            phrase_count=expected["target_phrase_count"],
        )

    playable_count = sum(bool(phrase["available"]) for phrase in expected["phrases"])
    assert expected["playable_phrase_count"] == playable_count
    assert expected["all_phrases_playable"] is (
        expected["target_phrase_count"] > 0
        and playable_count == expected["target_phrase_count"]
    )
    assert expected["complete"] is (
        expected["all_phrases_playable"]
        and expected["unassigned_non_filler_count"] == 0
    )

    word_ranges = [
        (phrase["word_start_index"], phrase["word_end_index"])
        for phrase in expected["phrases"]
        if phrase["word_start_index"] is not None
    ]
    assert word_ranges == sorted(word_ranges)
    assert all(left[1] <= right[0] for left, right in zip(word_ranges, word_ranges[1:]))

    words = source_case["asr_timestamps"].get("words") or []
    actual_zero_indexes = {
        index for index, word in enumerate(words) if word["start"] == word["end"]
    }
    expected_zero_indexes = {owner["word_index"] for owner in expected["zero_duration_owners"]}
    assert expected_zero_indexes == actual_zero_indexes
    for owner in expected["zero_duration_owners"]:
        phrase = expected["phrases"][owner["phrase_index"]]
        assert phrase["word_start_index"] <= owner["word_index"] < phrase["word_end_index"]

    words = source_case["asr_timestamps"].get("words") or []
    segments = source_case["asr_timestamps"].get("segments") or []
    if words:
        assigned_units = {
            word_index
            for phrase in expected["phrases"]
            if phrase["word_start_index"] is not None
            for word_index in range(phrase["word_start_index"], phrase["word_end_index"])
        }
        assert expected["unassigned_non_filler_count"] == len(words) - len(assigned_units)
    elif segments:
        assigned_segments = {
            segment_index
            for phrase in expected["phrases"]
            if phrase["text_source"] == "segments"
            for segment_index, segment in enumerate(segments)
            if segment["text"] == phrase["matched_text"]
            and (
                phrase["assignment_status"] == "text_only"
                or (
                    segment["start"] == pytest.approx(phrase["audio_start"])
                    and segment["end"] == pytest.approx(phrase["audio_end"])
                )
            )
        }
        assert expected["unassigned_non_filler_count"] == len(segments) - len(
            assigned_segments
        )
    else:
        assert expected["unassigned_non_filler_count"] == 0


def _validate_fixed_error(case: dict[str, Any], source_case: dict[str, Any]) -> None:
    expected_error = case["expected_error"]
    assert set(expected_error) == {"error_code", "reason", "retryable"}
    assert expected_error == {
        "error_code": "practice_alignment_provider_contract_error",
        "reason": "contradictory_timestamp_payload",
        "retryable": True,
    }
    timestamps = source_case["asr_timestamps"]
    assert timestamps["available"] is False
    assert timestamps.get("words") or timestamps.get("segments")


@pytest.mark.parametrize(
    ("fixture_path", "expected_count", "expected_role"),
    [
        (FIXTURE_PATH, 20, "pilot"),
        (SEGMENT_POLICY_FIXTURE_PATH, 12, "pilot"),
        (ROUND2_CHALLENGE_FIXTURE_PATH, 80, "challenge"),
    ],
    ids=("ownership-pilot", "segment-policy-pilot", "round2-challenge"),
)
def test_canonical_overlay_schema_and_source_are_fixed(
    fixture_path: Path,
    expected_count: int,
    expected_role: str,
) -> None:
    overlay, source_cases = _load_fixture(fixture_path)
    assert overlay["fixture_contract_version"] == 1
    assert overlay["alignment_contract_version"] == 1
    assert overlay["evaluation_role"] == expected_role
    assert overlay["ownership_profile"] == "ownership.conservative"
    assert overlay["content_profile"] == "content.literal_normalized"

    source_by_name = {case["name"]: case for case in source_cases}
    assert len(source_by_name) == len(source_cases)
    assert len(overlay["cases"]) == len(source_cases) == expected_count
    assert {case["name"] for case in overlay["cases"]} == set(source_by_name)

    if "adjudication_fixture" in overlay:
        adjudication_path = fixture_path.parent / overlay["adjudication_fixture"]
        assert hashlib.sha256(adjudication_path.read_bytes()).hexdigest() == overlay[
            "adjudication_sha256"
        ]

    for case in overlay["cases"]:
        assert case["expectation_status"] in ALLOWED_EXPECTATION_STATUSES
        if case["expectation_status"] == "fixed":
            assert case["excluded_from_score"] is False
            assert ("expected" in case) is not ("expected_error" in case)
            if "expected" in case:
                _validate_fixed_case(case, source_by_name[case["name"]])
            else:
                _validate_fixed_error(case, source_by_name[case["name"]])
        else:
            assert case["excluded_from_score"] is True
            assert "expected" not in case
            assert "expected_error" not in case
            assert case["reason"]


def test_partial_overlap_attempt_intent_adjudication_is_complete_and_independent() -> None:
    adjudication = json.loads(ATTEMPT_INTENT_FIXTURE_PATH.read_text(encoding="utf-8"))
    assert adjudication["adjudication_contract_version"] == 1
    assert adjudication["adjudication_method"] == "independent_anonymized_review"
    assert adjudication["implementation_outputs_observed"] is False

    source_cases: list[dict[str, Any]] = []
    for source in adjudication["source_fixtures"]:
        source_path = (ATTEMPT_INTENT_FIXTURE_PATH.parent / source["path"]).resolve()
        source_bytes = source_path.read_bytes()
        assert hashlib.sha256(source_bytes).hexdigest() == source["sha256"]
        source_cases.extend(json.loads(source_bytes))

    expected_names = {
        case["name"]
        for case in source_cases
        if case["category"] == "partial_overlap_negative"
    }
    cases = adjudication["cases"]
    assert len(cases) == len(expected_names) == 12
    assert {case["source_case_name"] for case in cases} == expected_names
    assert [case["adjudication_id"] for case in cases] == [
        f"case_{index:02d}" for index in range(1, 13)
    ]

    actual_counts = {
        intent: sum(case["attempt_intent"] == intent for case in cases)
        for intent in {"relevant_attempt", "unrelated_speech", "ambiguous"}
    }
    assert actual_counts == adjudication["counts"] == {
        "relevant_attempt": 5,
        "unrelated_speech": 3,
        "ambiguous": 4,
    }
    for case in cases:
        assert case["confidence"] in {"high", "medium", "low"}
        assert case["reason"]
        if case["attempt_intent"] == "ambiguous":
            assert case["missing_evidence"]
        else:
            assert case["missing_evidence"] == []
