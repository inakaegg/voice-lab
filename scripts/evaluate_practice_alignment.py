from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from mo_speech.practice import practice_comparison_alignment


def _same_timestamp(actual: object, expected: object) -> bool:
    if actual is None or expected is None:
        return actual is None and expected is None
    return abs(float(actual) - float(expected)) < 1e-6


def _compare_case(case: dict[str, Any]) -> dict[str, Any]:
    actual = practice_comparison_alignment(
        target_text=str(case["target_text"]),
        recognized_text=str(case["recognized_text"]),
        target_language=str(case["target_language"]),
        asr_timestamps=case["asr_timestamps"],
    )
    expected = case["expected"]
    mismatches: list[dict[str, object]] = []
    for key in ("available", "complete"):
        if actual.get(key) != expected.get(key):
            mismatches.append({"field": key, "expected": expected.get(key), "actual": actual.get(key)})
    actual_ranges = list(actual.get("ranges") or [])
    expected_ranges = list(expected.get("ranges") or [])
    if len(actual_ranges) != len(expected_ranges):
        mismatches.append({"field": "range_count", "expected": len(expected_ranges), "actual": len(actual_ranges)})
    for index, (actual_range, expected_range) in enumerate(zip(actual_ranges, expected_ranges)):
        for key in ("index", "source", "available", "matched_text"):
            if actual_range.get(key) != expected_range.get(key):
                mismatches.append(
                    {
                        "field": f"ranges[{index}].{key}",
                        "expected": expected_range.get(key),
                        "actual": actual_range.get(key),
                    }
                )
        for key in ("audio_start", "audio_end"):
            if not _same_timestamp(actual_range.get(key), expected_range.get(key)):
                mismatches.append(
                    {
                        "field": f"ranges[{index}].{key}",
                        "expected": expected_range.get(key),
                        "actual": actual_range.get(key),
                    }
                )
    return {
        "name": case["name"],
        "target_language": case["target_language"],
        "category": case.get("category", ""),
        "passed": not mismatches,
        "mismatches": mismatches,
        "actual": actual,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate SpeakLoop alignment fixtures with the Python runtime.")
    parser.add_argument("fixtures", nargs="+", type=Path)
    parser.add_argument("--exclude", action="append", default=[], help="case name to report but exclude from pass/fail totals")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--summary-only", action="store_true")
    args = parser.parse_args()

    cases: list[dict[str, Any]] = []
    fixture_hashes: dict[str, str] = {}
    for fixture in args.fixtures:
        payload = fixture.read_bytes()
        fixture_hashes[str(fixture)] = hashlib.sha256(payload).hexdigest()
        loaded = json.loads(payload)
        if not isinstance(loaded, list):
            raise ValueError(f"fixture must contain a JSON array: {fixture}")
        cases.extend(loaded)

    excluded_names = set(args.exclude)
    results = [_compare_case(case) for case in cases]
    evaluated = [result for result in results if result["name"] not in excluded_names]
    payload = {
        "runtime": "python",
        "fixtures": fixture_hashes,
        "total": len(results),
        "evaluated": len(evaluated),
        "excluded": [result["name"] for result in results if result["name"] in excluded_names],
        "passed": sum(bool(result["passed"]) for result in evaluated),
        "failed": sum(not bool(result["passed"]) for result in evaluated),
        "results": results,
    }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary = {key: payload[key] for key in ("runtime", "total", "evaluated", "passed", "failed", "excluded")}
    print(json.dumps(summary if args.summary_only else payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
