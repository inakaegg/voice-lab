#!/usr/bin/env python3
"""Evaluate the shared practice-quality v2 matrix with the Python runtime."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from mo_speech.practice import (
    evaluate_practice_attempt,
    practice_comparison_alignment_canonical,
    practice_content_matches,
)


REPO_ROOT = Path(__file__).parents[1]
FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "practice_quality_v2_matrix_cases.json"


def load_fixture() -> dict[str, Any]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def alignment_inputs(case: dict[str, Any]) -> dict[str, Any]:
    language = str(case["target_language"])
    target_phrases = [str(phrase) for phrase in case["target_phrases"]]
    words = case.get("words")
    if words is None:
        words = [
            [text, round(index * 0.3, 3), round(index * 0.3 + 0.2, 3)]
            for index, text in enumerate(case.get("word_texts", []))
        ]
    word_units = [
        {"text": str(text), "start": start, "end": end}
        for text, start, end in words
    ]
    segment_units = [
        {"text": str(text), "start": start, "end": end}
        for text, start, end in case.get("segments", [])
    ]
    if "recognized_text" in case:
        recognized_text = str(case["recognized_text"])
    elif language == "zh-CN":
        recognized_text = "".join(unit["text"] for unit in word_units)
    else:
        recognized_text = " ".join(unit["text"] for unit in word_units)
    return {
        "target_text": "".join(target_phrases) if language == "zh-CN" else " ".join(target_phrases),
        "recognized_text": recognized_text,
        "target_language": language,
        "asr_timestamps": {
            "available": bool(case.get("available", True)),
            "words": word_units,
            "segments": segment_units,
        },
    }


def evaluate_fixture(fixture: dict[str, Any]) -> dict[str, Any]:
    return {
        "alignment": [
            practice_comparison_alignment_canonical(**alignment_inputs(case))
            for case in fixture["alignment_cases"]
        ],
        "spoken_forms": [
            practice_content_matches(case["target"], case["recognized"], "zh-CN")
            for case in fixture["spoken_form_cases"]
        ],
        "scores": [
            evaluate_practice_attempt(
                case["target_text"],
                case["recognized_text"],
                case["target_language"],
            )
            for case in fixture["score_cases"]
        ],
    }


def main() -> None:
    print(json.dumps(evaluate_fixture(load_fixture()), ensure_ascii=False))


if __name__ == "__main__":
    main()
