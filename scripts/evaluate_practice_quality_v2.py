#!/usr/bin/env python3
"""Emit the Python practice-quality contract for the shared parity fixture."""

from __future__ import annotations

import json
from pathlib import Path

from mo_speech.practice import (
    evaluate_practice_attempt,
    practice_comparison_alignment_canonical,
    practice_content_matches,
)


def main() -> None:
    fixture_path = Path(__file__).parents[1] / "tests" / "fixtures" / "practice_quality_v2_cases.json"
    fixture = json.loads(fixture_path.read_text())
    payload = {
        "alignment": [
            practice_comparison_alignment_canonical(
                target_text=case["target_text"],
                recognized_text=case["recognized_text"],
                target_language=case["target_language"],
                asr_timestamps=case["asr_timestamps"],
            )
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
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
