from __future__ import annotations

import json
from pathlib import Path

import pytest

from mo_speech.practice import (
    PracticeAlignmentError,
    PracticeAlignmentInputError,
    practice_alignment_legacy_adapter,
    practice_comparison_alignment_canonical,
    practice_content_matches,
    split_practice_phrases,
)


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "practice_alignment_canonical"


def _cases(name: str) -> list[dict[str, object]]:
    payload = json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))
    assert payload["fixture_contract_version"] == 1
    assert payload["alignment_contract_version"] == 1
    return payload["cases"]


@pytest.mark.parametrize("case", _cases("splitter_contract.json"), ids=lambda case: case["name"])
def test_canonical_phrase_splitter(case: dict[str, object]) -> None:
    phrases = split_practice_phrases(str(case["text"]))
    assert phrases == case["expected_phrases"]
    assert list(range(len(phrases))) == [index for index, _ in enumerate(phrases)]


@pytest.mark.parametrize("case", _cases("content_contract.json"), ids=lambda case: case["name"])
def test_canonical_content_match(case: dict[str, object]) -> None:
    assert practice_content_matches(
        str(case["target_text"]),
        str(case["matched_text"]),
        str(case["target_language"]),
    ) is case["expected_content_matched"]


def test_invalid_timestamp_payload_is_not_misclassified_as_no_speech() -> None:
    with pytest.raises(PracticeAlignmentError) as caught:
        practice_comparison_alignment_canonical(
            target_text="Open it.",
            recognized_text="",
            target_language="en-US",
            asr_timestamps={
                "available": True,
                "words": [],
                "segments": [],
                "raw_timestamp_word_count": 1,
            },
        )

    assert caught.value.error_code == "practice_alignment_provider_contract_error"
    assert caught.value.reason == "invalid_timestamp_payload"
    assert caught.value.stage == "attempt_asr"
    assert caught.value.retryable is True


@pytest.mark.parametrize(
    ("target_text", "timestamps", "reason"),
    [
        ("...", {}, "empty_target"),
        (" ".join(f"phrase {index}." for index in range(17)), {}, "alignment_input_too_large"),
        ("Open it.", {"raw_timestamp_word_count": 257}, "alignment_input_too_large"),
        (
            " ".join(f"phrase {index}." for index in range(16)),
            {"raw_timestamp_word_count": 65},
            "alignment_input_too_large",
        ),
    ],
)
def test_canonical_input_limits_fail_before_alignment(
    target_text: str,
    timestamps: dict[str, object],
    reason: str,
) -> None:
    with pytest.raises(PracticeAlignmentInputError) as caught:
        practice_comparison_alignment_canonical(
            target_text=target_text,
            recognized_text="",
            target_language="en-US",
            asr_timestamps=timestamps,
        )

    assert caught.value.error_code == "practice_alignment_invalid_input"
    assert caught.value.reason == reason
    assert caught.value.stage == "input"
    assert caught.value.retryable is False


@pytest.mark.parametrize("raw_count", ["not-a-number", -1])
def test_invalid_raw_count_uses_sanitized_row_count(raw_count: object) -> None:
    result = practice_comparison_alignment_canonical(
        target_text="Open it.",
        recognized_text="Open",
        target_language="en-US",
        asr_timestamps={
            "available": True,
            "raw_timestamp_word_count": raw_count,
            "words": [{"text": "Open", "start": 0.0, "end": 0.2}],
        },
    )

    assert result["diagnostics"]["raw_timestamp_word_count"] == 1


@pytest.mark.parametrize(
    ("timestamp", "reason"),
    [
        ({"start": "not-a-number", "end": 0.2}, "non_numeric"),
        ({"start": 0.0, "end": float("inf")}, "non_finite"),
        ({"start": -0.1, "end": 0.2}, "negative_start"),
        ({"start": 0.2, "end": 0.1}, "end_before_start"),
    ],
)
def test_invalid_word_unit_is_excluded_with_typed_diagnostics(
    timestamp: dict[str, object],
    reason: str,
) -> None:
    result = practice_comparison_alignment_canonical(
        target_text="Open it.",
        recognized_text="Open it",
        target_language="en-US",
        asr_timestamps={
            "available": True,
            "words": [{"text": "Open it", **timestamp}],
        },
    )

    assert result["phrases"][0]["assignment_status"] == "text_only"
    assert result["phrases"][0]["available"] is False
    assert result["diagnostics"]["invalid_timestamp_units"] == [
        {
            "source": "words",
            "source_index": 0,
            "text": "Open it",
            "start": timestamp["start"] if isinstance(timestamp["start"], (int, float)) and timestamp["start"] != float("inf") else None,
            "end": timestamp["end"] if isinstance(timestamp["end"], (int, float)) and timestamp["end"] != float("inf") else None,
            "reason": reason,
        }
    ]


def test_invalid_word_source_falls_back_to_safe_exact_segment() -> None:
    result = practice_comparison_alignment_canonical(
        target_text="Open it.",
        recognized_text="Open it",
        target_language="en-US",
        asr_timestamps={
            "available": True,
            "words": [
                {"text": "it", "start": 0.3, "end": 0.5},
                {"text": "Open", "start": 0.0, "end": 0.2},
            ],
            "segments": [{"text": "Open it.", "start": 0.0, "end": 0.5}],
        },
    )

    assert result["phrases"][0]["timestamp_source"] == "segments"
    assert result["phrases"][0]["available"] is True
    assert result["diagnostics"]["diagnostic_flags"] == [
        "non_monotonic_timestamp_source",
        "overlapping_timestamp_units",
    ]
    assert result["diagnostics"]["raw_timestamp_word_count"] == 2
    assert [unit["source_index"] for unit in result["diagnostics"]["invalid_timestamp_units"]] == [0, 1]
    assert {unit["reason"] for unit in result["diagnostics"]["invalid_timestamp_units"]} == {
        "non_monotonic_timestamp_source"
    }


def test_safe_words_remain_primary_while_invalid_segments_are_diagnosed() -> None:
    result = practice_comparison_alignment_canonical(
        target_text="Open it.",
        recognized_text="Open it",
        target_language="en-US",
        asr_timestamps={
            "available": True,
            "words": [
                {"text": "Open", "start": 0.0, "end": 0.2},
                {"text": "it", "start": 0.2, "end": 0.4},
            ],
            "segments": [{"text": "Open it.", "start": 0.0, "end": float("inf")}],
        },
    )

    assert result["phrases"][0]["timestamp_source"] == "words"
    assert result["diagnostics"]["raw_timestamp_segment_count"] == 1
    assert result["diagnostics"]["valid_segment_count"] == 0
    assert result["diagnostics"]["invalid_timestamp_units"] == [
        {
            "source": "segments",
            "source_index": 0,
            "text": "Open it.",
            "start": 0.0,
            "end": None,
            "reason": "non_finite",
        }
    ]


def test_disjoint_word_and_segment_sources_keep_words_and_flag_conflict() -> None:
    result = practice_comparison_alignment_canonical(
        target_text="Open it.",
        recognized_text="Open it",
        target_language="en-US",
        asr_timestamps={
            "available": True,
            "words": [
                {"text": "Open", "start": 0.0, "end": 0.2},
                {"text": "it", "start": 0.2, "end": 0.4},
            ],
            "segments": [{"text": "Open it.", "start": 2.0, "end": 2.4}],
        },
    )

    assert result["phrases"][0]["timestamp_source"] == "words"
    assert result["diagnostics"]["diagnostic_flags"] == ["word_segment_boundary_conflict"]
    assert result["diagnostics"]["invalid_timestamp_units"] == [
        {
            "source": "segments",
            "source_index": 0,
            "text": "Open it.",
            "start": 2.0,
            "end": 2.4,
            "reason": "word_segment_boundary_conflict",
        }
    ]


def test_canonical_schema_keeps_partial_phrase_and_unassigned_diagnostics_separate() -> None:
    result = practice_comparison_alignment_canonical(
        target_text="Open it. Close it.",
        recognized_text="Open it unrelated",
        target_language="en-US",
        asr_timestamps={
            "available": True,
            "words": [
                {"text": "Open", "start": 0.0, "end": 0.2},
                {"text": "it", "start": 0.2, "end": 0.4},
                {"text": "unrelated", "start": 1.0, "end": 1.5},
            ],
        },
    )

    assert set(result) == {
        "alignment_contract_version",
        "outcome",
        "target_language",
        "available",
        "target_phrase_count",
        "playable_phrase_count",
        "all_phrases_playable",
        "unassigned_non_filler_count",
        "complete",
        "phrases",
        "diagnostics",
    }
    assert result["alignment_contract_version"] == 1
    assert result["playable_phrase_count"] == 1
    assert result["all_phrases_playable"] is False
    assert result["complete"] is False
    assert [phrase["assignment_status"] for phrase in result["phrases"]] == [
        "assigned",
        "unassigned",
    ]
    assert result["phrases"][1]["content_matched"] is None
    assert result["diagnostics"]["unassigned_tokens"] == [
        {
            "source": "words",
            "source_index": 2,
            "text": "unrelated",
            "start": 1.0,
            "end": 1.5,
            "reason": "unrelated_speech",
        }
    ]


def test_canonical_to_legacy_adapter_only_renames_lossless_fields() -> None:
    canonical = practice_comparison_alignment_canonical(
        target_text="Open it.",
        recognized_text="Open it",
        target_language="en-US",
        asr_timestamps={
            "available": True,
            "words": [
                {"text": "Open", "start": 0.0, "end": 0.2},
                {"text": "it", "start": 0.2, "end": 0.4},
            ],
        },
    )
    legacy = practice_alignment_legacy_adapter(canonical)

    assert legacy["ranges"] == [
        {
            "index": 0,
            "source_index": 0,
            "target": "Open it.",
            "available": True,
            "matched": True,
            "content_matched": True,
            "source": "words",
            "matched_text": "Open it",
            "audio_start": 0.0,
            "audio_end": 0.4,
            "token_start_index": 0,
            "token_end_index": 2,
        }
    ]
    assert "similarity" not in legacy["ranges"][0]
    assert "alignment_confidence" not in legacy["ranges"][0]
