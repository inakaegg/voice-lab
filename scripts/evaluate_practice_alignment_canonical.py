from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from mo_speech.practice import practice_comparison_alignment_canonical


def _same_timestamp(actual: object, expected: object) -> bool:
    if actual is None or expected is None:
        return actual is None and expected is None
    return abs(float(actual) - float(expected)) < 1e-6


def _compare_case(source_case: dict[str, Any], overlay_case: dict[str, Any]) -> dict[str, Any]:
    try:
        actual = practice_comparison_alignment_canonical(
            target_text=str(source_case["target_text"]),
            recognized_text=str(source_case["recognized_text"]),
            target_language=str(source_case["target_language"]),
            asr_timestamps=source_case["asr_timestamps"],
        )
    except Exception as exc:  # pragma: no cover - exercised when the runtime adopts the error contract
        actual_error = {
            "error_code": getattr(exc, "error_code", None),
            "reason": getattr(exc, "reason", None),
            "retryable": getattr(exc, "retryable", None),
            "exception_type": type(exc).__name__,
        }
        if "expected_error" in overlay_case:
            expected_error = overlay_case["expected_error"]
            mismatches = [
                {"field": key, "expected": value, "actual": actual_error.get(key)}
                for key, value in expected_error.items()
                if actual_error.get(key) != value
            ]
            return {
                "name": overlay_case["name"],
                "passed": not mismatches,
                "mismatches": mismatches,
            }
        return {
            "name": overlay_case["name"],
            "passed": False,
            "mismatches": [
                {"field": "unexpected_error", "expected": None, "actual": actual_error}
            ],
        }

    if "expected_error" in overlay_case:
        return {
            "name": overlay_case["name"],
            "passed": False,
            "mismatches": [
                {
                    "field": "expected_error",
                    "expected": overlay_case["expected_error"],
                    "actual": None,
                }
            ],
        }
    expected = overlay_case["expected"]
    mismatches: list[dict[str, object]] = []

    if actual["outcome"] != expected["outcome"]:
        mismatches.append(
            {"field": "outcome", "expected": expected["outcome"], "actual": actual["outcome"]}
        )

    top_level = {
        "target_phrase_count": actual["target_phrase_count"],
        "playable_phrase_count": actual["playable_phrase_count"],
        "all_phrases_playable": actual["all_phrases_playable"],
        "unassigned_non_filler_count": actual["unassigned_non_filler_count"],
        "complete": actual["complete"],
    }
    for key, value in top_level.items():
        if value != expected[key]:
            mismatches.append({"field": key, "expected": expected[key], "actual": value})

    if len(actual["phrases"]) != len(expected["phrases"]):
        mismatches.append(
            {
                "field": "phrase_count",
                "expected": len(expected["phrases"]),
                "actual": len(actual["phrases"]),
            }
        )
    for index, (actual_phrase, expected_phrase) in enumerate(
        zip(actual["phrases"], expected["phrases"], strict=False)
    ):
        fields = {
            "index": actual_phrase["index"],
            "source_index": actual_phrase["source_index"],
            "target_text": actual_phrase["target_text"],
            "assignment_status": actual_phrase["assignment_status"],
            "available": actual_phrase["available"],
            "matched_text": actual_phrase["matched_text"],
            "text_source": actual_phrase["text_source"],
            "timestamp_source": actual_phrase["timestamp_source"],
            "word_start_index": actual_phrase["word_start_index"],
            "word_end_index": actual_phrase["word_end_index"],
        }
        for key, value in fields.items():
            if value != expected_phrase[key]:
                mismatches.append(
                    {
                        "field": f"phrases[{index}].{key}",
                        "expected": expected_phrase[key],
                        "actual": value,
                    }
                )
        for key in ("audio_start", "audio_end"):
            if not _same_timestamp(actual_phrase[key], expected_phrase[key]):
                mismatches.append(
                    {
                        "field": f"phrases[{index}].{key}",
                        "expected": expected_phrase[key],
                        "actual": actual_phrase[key],
                    }
                )

    actual_zero_duration_owners = [
        {
            "word_index": token["source_index"],
            "phrase_index": token["owner_phrase_index"],
        }
        for token in actual["diagnostics"]["zero_duration_tokens"]
        if token["source"] == "words"
    ]
    if actual_zero_duration_owners != expected["zero_duration_owners"]:
        mismatches.append(
            {
                "field": "zero_duration_owners",
                "expected": expected["zero_duration_owners"],
                "actual": actual_zero_duration_owners,
            }
        )

    if "unassigned_tokens" in expected:
        actual_unassigned_tokens = [
            {
                "source": token["source"],
                "source_index": token["source_index"],
                "text": token["text"],
                "start": token["start"],
                "end": token["end"],
                "reason": token["reason"],
            }
            for token in actual["diagnostics"]["unassigned_tokens"]
        ]
        if actual_unassigned_tokens != expected["unassigned_tokens"]:
            mismatches.append(
                {
                    "field": "unassigned_tokens",
                    "expected": expected["unassigned_tokens"],
                    "actual": actual_unassigned_tokens,
                }
            )

    return {
        "name": overlay_case["name"],
        "passed": not mismatches,
        "mismatches": mismatches,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate a canonical practice-alignment overlay with Python.")
    parser.add_argument("overlay", type=Path)
    parser.add_argument("--summary-only", action="store_true")
    args = parser.parse_args()

    overlay = json.loads(args.overlay.read_text(encoding="utf-8"))
    source_path = (args.overlay.parent / overlay["source_fixture"]).resolve()
    source_bytes = source_path.read_bytes()
    source_sha256 = hashlib.sha256(source_bytes).hexdigest()
    if source_sha256 != overlay["source_sha256"]:
        raise ValueError(f"source fixture SHA mismatch: {source_path}")
    source_by_name = {case["name"]: case for case in json.loads(source_bytes)}
    fixed_cases = [case for case in overlay["cases"] if case["expectation_status"] == "fixed"]
    results = [_compare_case(source_by_name[case["name"]], case) for case in fixed_cases]
    payload = {
        "runtime": "python",
        "overlay": str(args.overlay),
        "source_sha256": source_sha256,
        "total": len(overlay["cases"]),
        "evaluated": len(results),
        "excluded": len(overlay["cases"]) - len(results),
        "passed": sum(bool(result["passed"]) for result in results),
        "failed": sum(not bool(result["passed"]) for result in results),
        "results": results,
    }
    if args.summary_only:
        payload = {key: payload[key] for key in ("runtime", "total", "evaluated", "excluded", "passed", "failed")}
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
