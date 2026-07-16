from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from mo_speech.practice import split_practice_phrases


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "tests" / "fixtures"
CANONICAL_DIR = FIXTURE_DIR / "practice_alignment_canonical"

MANUAL_SOURCE = FIXTURE_DIR / "practice_alignment_manual_evaluation_cases.json"
ASSIGNMENT_SOURCE = FIXTURE_DIR / "practice_alignment_assignment_cases.json"

# These cases were labeled under the superseded rule that treated comma clauses
# as target phrases. The lists map old range indexes to each phrase produced by
# the adopted splitter contract. They are human-review metadata; no alignment
# implementation output is consulted by this generator.
CANONICAL_RANGE_GROUPS: dict[str, list[list[int]]] = {
    "manual_eval_zh_040_asr_punctuation_shifted": [[0, 1], [2, 3]],
    "manual_eval_en_015_leading_fillers_excluded_return": [[0, 1]],
    "manual_eval_en_039_similar_boundary_right_right": [[0], [1, 2]],
    "manual_eval_en_040_asr_punctuation_shifted": [[0, 1], [2, 3]],
    "manual_eval_zh_059_leading_clause_omitted_package": [[0, 1]],
    "manual_eval_zh_074_first_phrase_starts_halfway": [[0, 1], [2]],
    "manual_eval_en_059_leading_clause_omitted_refund": [[0, 1]],
    "manual_eval_en_074_first_phrase_starts_halfway_conference": [[0, 1], [2]],
    "manual_eval_en_082_no_punctuation_dialogue": [[0], [1, 2], [3]],
    "assignment_zh_094_comma_heavy_single_sentence_phrases": [[0, 1, 2, 3]],
    "assignment_en_094_comma_separated_four_units": [[0, 1, 2, 3]],
}

# The raw input does not uniquely decide which target owns a return/repetition
# or a complete inserted sentence. The examples remain useful, but cannot
# fairly rank either runtime.
AMBIGUOUS_EXCLUDED_CASES = {
    "manual_eval_zh_023_return_to_previous_phrase",
    "manual_eval_en_023_return_to_previous_phrase",
    "manual_eval_zh_028_extra_sentence_between_phrases",
    "manual_eval_en_028_extra_sentence_between_phrases",
    "manual_eval_zh_100_first_phrase_partial_second_exact",
    "manual_eval_en_100_first_phrase_partial_second_exact",
}

# When equally strong exact anchors conflict with target order, contract v1
# prefers the lower target index. These spans apply that deterministic rule to
# legacy labels that previously preferred the earlier spoken anchor.
FORCED_PHRASE_WORD_SPANS: dict[str, dict[int, tuple[int, int]]] = {
    "manual_eval_zh_029_phrase_order_a_c_b": {1: (4, 6)},
    "manual_eval_en_029_phrase_order_a_c_b": {1: (6, 9)},
    "manual_eval_zh_097_reordered_same_prefix": {0: (2, 4)},
    "manual_eval_en_097_reordered_same_prefix": {0: (5, 10)},
    "assignment_en_008_reordered_same_suffix_keeps_order_constraint": {0: (7, 14)},
    "assignment_zh_082_zero_duration_long_pause_and_homophone": {1: (3, 6)},
}

# A generic sequence marker alone does not own unrelated trailing speech under
# ownership.conservative.
FORCED_UNASSIGNED_PHRASES: dict[str, set[int]] = {
    "assignment_zh_037_shared_connector_only_low_confidence": {1},
    "assignment_en_037_only_sequence_marker_matches": {1},
    "assignment_zh_059_only_exact_anchor_is_zero_duration": {1},
    "assignment_en_059_unique_matching_anchor_has_zero_duration": {1},
    "manual_eval_zh_029_phrase_order_a_c_b": {2},
    "manual_eval_en_029_phrase_order_a_c_b": {2},
    "manual_eval_zh_097_reordered_same_prefix": {1},
    "manual_eval_en_097_reordered_same_prefix": {1},
    "assignment_en_008_reordered_same_suffix_keeps_order_constraint": {1},
}

FORCED_UNASSIGNED_DEFAULT_REASONS = {
    "assignment_en_008_reordered_same_suffix_keeps_order_constraint": "out_of_order_speech",
    "assignment_zh_059_only_exact_anchor_is_zero_duration": "unrelated_speech",
    "assignment_en_059_unique_matching_anchor_has_zero_duration": "unrelated_speech",
}

FORCED_UNASSIGNED_WORD_REASONS: dict[str, dict[int, str]] = {
    "assignment_zh_082_zero_duration_long_pause_and_homophone": {
        6: "unrelated_speech",
    },
    "assignment_zh_039_same_topic_but_no_structural_anchor": {
        0: "unrelated_speech",
        1: "unrelated_speech",
        2: "unrelated_speech",
        3: "unrelated_speech",
    },
    "assignment_en_039_same_domain_without_phrase_evidence": {
        0: "unrelated_speech",
        1: "unrelated_speech",
        2: "unrelated_speech",
        3: "unrelated_speech",
        4: "unrelated_speech",
        5: "unrelated_speech",
        6: "unrelated_speech",
        7: "unrelated_speech",
    },
    "assignment_zh_037_shared_connector_only_low_confidence": {
        4: "unrelated_speech",
        5: "unrelated_speech",
        6: "unrelated_speech",
    },
    "assignment_en_037_only_sequence_marker_matches": {
        5: "unrelated_speech",
        6: "unrelated_speech",
        7: "unrelated_speech",
        8: "unrelated_speech",
    },
    "assignment_zh_100_generic_connector_without_enough_structure": {
        3: "unrelated_speech",
        4: "unrelated_speech",
    },
    "assignment_en_100_generic_then_without_closing_anchor": {
        9: "unrelated_speech",
        10: "unrelated_speech",
        11: "unrelated_speech",
        12: "unrelated_speech",
        13: "unrelated_speech",
        14: "unrelated_speech",
        15: "unrelated_speech",
    },
}

BOUNDARY_FILLER_REASONS = {
    "explicit_boundary_filler",
    "explicit_boundary_filler_part",
    "explicit_leading_filler",
    "explicit_trailing_filler",
    "trailing_discourse_filler",
    "boundary_filler_after_reordered_phrase",
    "filler_after_reordered_phrase",
}

UNRELATED_REASONS = {
    "fully_unrelated_speech",
    "new_addressee_after_long_pause",
    "discrete_unrelated_middle_message",
    "unrelated_intro_separated_by_long_pause",
    "unrelated_trailing_comment_after_target_completion",
    "discrete_unrelated_middle_sentence",
    "unrelated_new_topic_after_long_pause",
}

AMBIGUOUS_REASONS = {
    "different_content_without_closing_anchor",
    "same_domain_without_phrase_evidence",
    "same_topic_without_phrase_anchor",
    "generic_connector_without_sufficient_phrase_evidence",
}


def _source_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _separator(case: dict[str, Any]) -> str:
    return "" if case["target_language"] in {"ja-JP", "zh-CN"} else " "


def _word_range_for_legacy_range(
    case: dict[str, Any],
    legacy_range: dict[str, Any],
) -> tuple[int, int]:
    words = list(case["asr_timestamps"].get("words") or [])
    if legacy_range.get("token_start_index") is not None:
        start = int(legacy_range["token_start_index"])
        end = int(legacy_range["token_end_index"]) + 1
        candidates = [(start, end)]
    else:
        candidates = []
        separator = _separator(case)
        for start in range(len(words)):
            for end in range(start + 1, len(words) + 1):
                owned = words[start:end]
                positive = [word for word in owned if float(word["end"]) > float(word["start"])]
                if not positive:
                    continue
                if separator.join(str(word["text"]) for word in owned) != legacy_range["matched_text"]:
                    continue
                if abs(min(float(word["start"]) for word in positive) - float(legacy_range["audio_start"])) >= 1e-6:
                    continue
                if abs(max(float(word["end"]) for word in positive) - float(legacy_range["audio_end"])) >= 1e-6:
                    continue
                candidates.append((start, end))
    if len(candidates) != 1:
        raise ValueError(
            f"{case['name']} range {legacy_range['index']} does not map to one word span: {candidates}"
        )
    start, end = candidates[0]
    owned = words[start:end]
    if _separator(case).join(str(word["text"]) for word in owned) != legacy_range["matched_text"]:
        raise ValueError(f"{case['name']} legacy matched_text does not match its word indexes")
    return start, end


def _target_phrases(case: dict[str, Any]) -> list[str]:
    phrases = split_practice_phrases(case["target_text"])
    if "".join(phrase.replace(" ", "") for phrase in phrases) != str(case["target_text"]).replace(" ", ""):
        raise ValueError(f"{case['name']} target phrases do not reconstruct target_text")
    return phrases


def _range_groups(case: dict[str, Any], phrase_count: int) -> list[list[int]]:
    legacy_count = len(case["expected"]["ranges"])
    groups = CANONICAL_RANGE_GROUPS.get(case["name"])
    if groups is None:
        if legacy_count != phrase_count:
            raise ValueError(
                f"{case['name']} requires an explicit old-to-canonical phrase mapping: "
                f"legacy={legacy_count}, canonical={phrase_count}"
            )
        groups = [[index] for index in range(phrase_count)]
    if len(groups) != phrase_count:
        raise ValueError(f"{case['name']} range mapping does not match canonical phrase count")
    if sorted(index for group in groups for index in group) != list(range(legacy_count)):
        raise ValueError(f"{case['name']} range mapping is not a complete partition")
    return groups


def _canonical_assignment_reason(reason: str) -> str:
    if reason in BOUNDARY_FILLER_REASONS:
        return "boundary_filler"
    if reason == "target_order_conflict":
        return "out_of_order_speech"
    if reason == "zero_duration_without_safe_playback_span" or reason == "isolated_zero_duration_boundary_filler":
        return "no_positive_duration"
    if reason in UNRELATED_REASONS:
        return "unrelated_speech"
    if reason in AMBIGUOUS_REASONS:
        return "ambiguous_assignment"
    raise ValueError(f"unmapped assignment reason: {reason}")


def _manual_unassigned_reason(case: dict[str, Any], word_index: int) -> str:
    category = case["category"]
    if category == "filler":
        return "boundary_filler"
    if category == "phrase_order":
        return "out_of_order_speech"
    if category == "partial_match":
        return "unrelated_speech"
    if category == "partial_recording":
        return "ambiguous_assignment"
    if category == "unavailable":
        if "only_fillers" in case["name"] or "edge_fillers" in case["name"]:
            return "boundary_filler"
        return "unrelated_speech"
    raise ValueError(f"{case['name']} word {word_index} needs an unassigned reason")


def _text_only_zero_word_for_phrase(
    case: dict[str, Any],
    phrase_index: int,
) -> list[int]:
    matches = [
        int(token["word_index"])
        for token in case.get("expected_unassigned_tokens") or []
        if token.get("reason") == "zero_duration_without_safe_playback_span"
        and token.get("structural_phrase_index") == phrase_index
    ]
    if not matches:
        return []
    if matches != list(range(matches[0], matches[-1] + 1)):
        raise ValueError(f"{case['name']} phrase {phrase_index} text-only words are not contiguous")
    for word_index in matches:
        word = case["asr_timestamps"]["words"][word_index]
        if float(word["start"]) != float(word["end"]):
            raise ValueError(f"{case['name']} expected text-only word has positive duration")
    return matches


def _unassigned_phrase(index: int, target_text: str) -> dict[str, Any]:
    return {
        "index": index,
        "source_index": index,
        "target_text": target_text,
        "assignment_status": "unassigned",
        "available": False,
        "matched_text": "",
        "text_source": "none",
        "timestamp_source": "none",
        "word_start_index": None,
        "word_end_index": None,
        "audio_start": None,
        "audio_end": None,
    }


def _phrase_from_group(
    case: dict[str, Any],
    phrase_index: int,
    target_text: str,
    legacy_indexes: list[int],
) -> dict[str, Any]:
    legacy_ranges = [case["expected"]["ranges"][index] for index in legacy_indexes]
    available = [legacy_range for legacy_range in legacy_ranges if legacy_range["available"]]
    if not available:
        zero_indexes = _text_only_zero_word_for_phrase(case, phrase_index)
        if not zero_indexes:
            return _unassigned_phrase(phrase_index, target_text)
        words = case["asr_timestamps"]["words"]
        start = zero_indexes[0]
        end = zero_indexes[-1] + 1
        return {
            "index": phrase_index,
            "source_index": phrase_index,
            "target_text": target_text,
            "assignment_status": "text_only",
            "available": False,
            "matched_text": _separator(case).join(str(words[index]["text"]) for index in zero_indexes),
            "text_source": "words",
            "timestamp_source": "none",
            "word_start_index": start,
            "word_end_index": end,
            "audio_start": None,
            "audio_end": None,
        }

    sources = {legacy_range["source"] for legacy_range in available}
    if len(sources) != 1:
        raise ValueError(f"{case['name']} phrase {phrase_index} mixes timestamp sources")
    source = sources.pop()
    if source == "segments":
        if len(available) != 1:
            raise ValueError(f"{case['name']} phrase {phrase_index} merges segment ranges")
        legacy_range = available[0]
        return {
            "index": phrase_index,
            "source_index": phrase_index,
            "target_text": target_text,
            "assignment_status": "assigned",
            "available": True,
            "matched_text": legacy_range["matched_text"],
            "text_source": "segments",
            "timestamp_source": "segments",
            "word_start_index": None,
            "word_end_index": None,
            "audio_start": legacy_range["audio_start"],
            "audio_end": legacy_range["audio_end"],
        }
    if source != "words":
        raise ValueError(f"{case['name']} phrase {phrase_index} has unsupported source {source}")

    spans = [_word_range_for_legacy_range(case, legacy_range) for legacy_range in available]
    start = min(span[0] for span in spans)
    end = max(span[1] for span in spans)
    words = case["asr_timestamps"]["words"][start:end]
    positive = [word for word in words if float(word["end"]) > float(word["start"])]
    if not positive:
        assignment_status = "text_only"
        is_available = False
        timestamp_source = "none"
        audio_start = None
        audio_end = None
    else:
        assignment_status = "assigned"
        is_available = True
        timestamp_source = "words"
        audio_start = min(float(word["start"]) for word in positive)
        audio_end = max(float(word["end"]) for word in positive)
    return {
        "index": phrase_index,
        "source_index": phrase_index,
        "target_text": target_text,
        "assignment_status": assignment_status,
        "available": is_available,
        "matched_text": _separator(case).join(str(word["text"]) for word in words),
        "text_source": "words",
        "timestamp_source": timestamp_source,
        "word_start_index": start,
        "word_end_index": end,
        "audio_start": audio_start,
        "audio_end": audio_end,
    }


def _phrase_from_word_span(
    case: dict[str, Any],
    phrase_index: int,
    target_text: str,
    span: tuple[int, int],
) -> dict[str, Any]:
    start, end = span
    words = list(case["asr_timestamps"].get("words") or [])
    if not 0 <= start < end <= len(words):
        raise ValueError(f"{case['name']} forced phrase span is outside its word list")
    owned = words[start:end]
    positive = [word for word in owned if float(word["end"]) > float(word["start"])]
    return {
        "index": phrase_index,
        "source_index": phrase_index,
        "target_text": target_text,
        "assignment_status": "assigned" if positive else "text_only",
        "available": bool(positive),
        "matched_text": _separator(case).join(str(word["text"]) for word in owned),
        "text_source": "words",
        "timestamp_source": "words" if positive else "none",
        "word_start_index": start,
        "word_end_index": end,
        "audio_start": min(float(word["start"]) for word in positive) if positive else None,
        "audio_end": max(float(word["end"]) for word in positive) if positive else None,
    }


def _no_timestamp_expected(case: dict[str, Any], phrases: list[str]) -> dict[str, Any]:
    recognized = str(case.get("recognized_text") or "").strip()
    if not recognized:
        return {
            "outcome": "no_speech",
            "target_phrase_count": len(phrases),
            "playable_phrase_count": 0,
            "all_phrases_playable": False,
            "unassigned_non_filler_count": 0,
            "complete": False,
            "phrases": [],
            "unassigned_tokens": [],
            "zero_duration_owners": [],
        }
    if len(phrases) == 1:
        expected_phrases = [{
            "index": 0,
            "source_index": 0,
            "target_text": phrases[0],
            "assignment_status": "text_only",
            "available": False,
            "matched_text": recognized,
            "text_source": "transcription",
            "timestamp_source": "none",
            "word_start_index": None,
            "word_end_index": None,
            "audio_start": None,
            "audio_end": None,
        }]
    else:
        expected_phrases = [_unassigned_phrase(index, phrase) for index, phrase in enumerate(phrases)]
    return {
        "outcome": "evaluated",
        "target_phrase_count": len(phrases),
        "playable_phrase_count": 0,
        "all_phrases_playable": False,
        "unassigned_non_filler_count": 0,
        "complete": False,
        "phrases": expected_phrases,
        "unassigned_tokens": [],
        "zero_duration_owners": [],
    }


def _expected_case(case: dict[str, Any], *, assignment: bool) -> dict[str, Any]:
    target_phrases = _target_phrases(case)
    timestamp_payload = case["asr_timestamps"]
    words = list(timestamp_payload.get("words") or [])
    segments = list(timestamp_payload.get("segments") or [])
    if timestamp_payload.get("available") is False and not words and not segments:
        return _no_timestamp_expected(case, target_phrases)

    groups = _range_groups(case, len(target_phrases))
    phrases = [
        _phrase_from_group(case, index, target_text, groups[index])
        for index, target_text in enumerate(target_phrases)
    ]
    for phrase_index, span in FORCED_PHRASE_WORD_SPANS.get(case["name"], {}).items():
        phrases[phrase_index] = _phrase_from_word_span(
            case,
            phrase_index,
            target_phrases[phrase_index],
            span,
        )
    for phrase_index in FORCED_UNASSIGNED_PHRASES.get(case["name"], set()):
        phrases[phrase_index] = _unassigned_phrase(phrase_index, target_phrases[phrase_index])
    assigned_words = {
        word_index
        for phrase in phrases
        if phrase["word_start_index"] is not None
        for word_index in range(phrase["word_start_index"], phrase["word_end_index"])
    }
    expected_assignment_reasons = {
        int(token["word_index"]): str(token["reason"])
        for token in case.get("expected_unassigned_tokens") or []
    }
    unassigned_tokens: list[dict[str, Any]] = []
    for word_index, word in enumerate(words):
        if word_index in assigned_words:
            continue
        if assignment:
            forced_word_reason = FORCED_UNASSIGNED_WORD_REASONS.get(
                case["name"], {}
            ).get(word_index)
            if forced_word_reason is not None:
                reason = forced_word_reason
            elif word_index not in expected_assignment_reasons:
                if case["name"] in FORCED_UNASSIGNED_PHRASES:
                    reason = (
                        "no_positive_duration"
                        if float(word["start"]) == float(word["end"])
                        else FORCED_UNASSIGNED_DEFAULT_REASONS.get(
                            case["name"],
                            "ambiguous_assignment",
                        )
                    )
                else:
                    raise ValueError(f"{case['name']} word {word_index} lacks an expected unassigned reason")
            else:
                reason = _canonical_assignment_reason(expected_assignment_reasons[word_index])
        else:
            reason = _manual_unassigned_reason(case, word_index)
        unassigned_tokens.append({
            "source": "words",
            "source_index": word_index,
            "text": str(word["text"]),
            "start": word["start"],
            "end": word["end"],
            "reason": reason,
        })

    # Words are the ownership source when present. Segments remain boundary
    # diagnostics and must not double-count the same speech as unassigned.
    if not words:
        assigned_segments = {
            segment_index
            for phrase in phrases
            if phrase["text_source"] == "segments"
            for segment_index, segment in enumerate(segments)
            if segment["text"] == phrase["matched_text"]
            and float(segment["start"]) == float(phrase["audio_start"])
            and float(segment["end"]) == float(phrase["audio_end"])
        }
        for segment_index, segment in enumerate(segments):
            if segment_index in assigned_segments:
                continue
            unassigned_tokens.append({
                "source": "segments",
                "source_index": segment_index,
                "text": str(segment["text"]),
                "start": segment["start"],
                "end": segment["end"],
                "reason": "ambiguous_assignment",
            })

    zero_duration_owners = [
        {"word_index": word_index, "phrase_index": phrase["index"]}
        for phrase in phrases
        if phrase["word_start_index"] is not None
        for word_index in range(phrase["word_start_index"], phrase["word_end_index"])
        if float(words[word_index]["start"]) == float(words[word_index]["end"])
    ]
    playable_count = sum(bool(phrase["available"]) for phrase in phrases)
    non_filler_count = sum(token["reason"] != "boundary_filler" for token in unassigned_tokens)
    all_playable = bool(phrases) and playable_count == len(phrases)
    return {
        "outcome": "evaluated",
        "target_phrase_count": len(phrases),
        "playable_phrase_count": playable_count,
        "all_phrases_playable": all_playable,
        "unassigned_non_filler_count": non_filler_count,
        "complete": all_playable and non_filler_count == 0,
        "phrases": phrases,
        "unassigned_tokens": unassigned_tokens,
        "zero_duration_owners": zero_duration_owners,
    }


def _build_overlay(source_path: Path, *, assignment: bool) -> dict[str, Any]:
    source_cases = json.loads(source_path.read_text(encoding="utf-8"))
    cases = []
    for case in source_cases:
        if case["name"] in AMBIGUOUS_EXCLUDED_CASES:
            cases.append({
                "name": case["name"],
                "expectation_status": "ambiguous_excluded",
                "excluded_from_score": True,
                "reason": (
                    "raw text and timestamps do not uniquely determine ownership "
                    "of the repeated or inserted utterance"
                ),
            })
            continue
        cases.append({
            "name": case["name"],
            "expectation_status": "fixed",
            "excluded_from_score": False,
            "expected": _expected_case(case, assignment=assignment),
        })
    return {
        "fixture_contract_version": 2,
        "alignment_contract_version": 1,
        "evaluation_role": "challenge",
        "source_fixture": f"../{source_path.name}",
        "source_sha256": _source_sha256(source_path),
        "ownership_profile": "ownership.conservative",
        "content_profile": "content.literal_normalized",
        "expectation_basis": "legacy_human_labels_plus_canonical_contract",
        "cases": cases,
    }


def main() -> None:
    outputs = [
        (
            CANONICAL_DIR / "manual_evaluation_expectations.json",
            _build_overlay(MANUAL_SOURCE, assignment=False),
        ),
        (
            CANONICAL_DIR / "assignment_expectations.json",
            _build_overlay(ASSIGNMENT_SOURCE, assignment=True),
        ),
    ]
    for path, payload in outputs:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {path.relative_to(ROOT)} ({len(payload['cases'])} cases)")


if __name__ == "__main__":
    main()
