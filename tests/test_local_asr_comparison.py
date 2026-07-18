from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from mo_speech.local_asr_comparison import (
    COMPARISON_GENERATION_REVISION,
    _generation_run_metadata,
    _target_phrase_speech_bounds,
    comparison_provider_name,
    compute_phrase_ranges,
    evaluate_comparison_pairs,
    load_comparison_manifest,
    run_playback_plan,
    score_comparison_result,
    select_comparison_cases,
)


ROOT = Path(__file__).resolve().parents[1]


def test_generation_run_metadata_preserves_provenance_for_exact_audio_reuse() -> None:
    existing = {
        "generated_at": "2026-07-18T00:00:00+00:00",
        "generator": {
            "platform": "existing-platform",
            "python": "3.11.9",
        },
    }

    metadata = _generation_run_metadata(
        existing,
        preserve_existing=True,
        say_path="/usr/bin/say",
        ffmpeg_path="/opt/homebrew/bin/ffmpeg",
    )

    assert metadata == {
        "generated_at": "2026-07-18T00:00:00+00:00",
        "generator": {
            "platform": "existing-platform",
            "python": "3.11.9",
        },
    }


def test_checked_in_paired_pilot_fixes_three_multi_phrase_cases() -> None:
    manifest = load_comparison_manifest(
        ROOT / "tests" / "fixtures" / "asr_comparison_pair_pilot.json"
    )

    assert len(manifest["cases"]) == 3
    assert all(len(case["target_phrases"]) == 3 for case in manifest["cases"])
    assert [case["expected"]["playback_mode"] for case in manifest["cases"]] == [
        "phrase",
        "phrase",
        "partial_phrase",
    ]


def test_comparison_provider_routing_matches_the_product_contract() -> None:
    assert comparison_provider_name("zh-CN") == "funasr"
    assert comparison_provider_name("en-US") == "faster_whisper"


def test_select_comparison_cases_applies_a_cumulative_stage_limit() -> None:
    manifest = {"cases": [{"id": f"case-{index}"} for index in range(12)]}

    assert [case["id"] for case in select_comparison_cases(manifest, 6)] == [
        "case-0",
        "case-1",
        "case-2",
        "case-3",
        "case-4",
        "case-5",
    ]
    assert len(select_comparison_cases(manifest, None)) == 12


def test_evaluate_comparison_pairs_rejects_stale_generation_revision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manifest_path = ROOT / "tests" / "fixtures" / "asr_comparison_pair_pilot.json"
    manifest = load_comparison_manifest(manifest_path)
    output_dir = tmp_path / "comparison"
    output_dir.mkdir()
    (output_dir / "generation.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "generation_revision": COMPARISON_GENERATION_REVISION - 1,
                "manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
                "cases": [{"id": manifest["cases"][0]["id"]}],
            }
        ),
        encoding="utf-8",
    )

    def fail_if_model_setup_starts(_: Path) -> dict[str, Path]:
        raise AssertionError("stale generation must be rejected before model setup")

    monkeypatch.setattr(
        "mo_speech.local_asr_comparison._model_cache_paths",
        fail_if_model_setup_starts,
    )

    with pytest.raises(
        ValueError,
        match="generation revision does not match current generator",
    ):
        evaluate_comparison_pairs(
            manifest_path,
            output_dir,
            model_cache_dir=tmp_path / "models",
            case_limit=1,
        )


def test_compute_phrase_ranges_excludes_inter_phrase_pause() -> None:
    ranges = compute_phrase_ranges(
        [
            {"phrase_index": 0, "pause_after_ms": 250},
            {"phrase_index": 1, "pause_after_ms": 0},
        ],
        [1.2, 0.8],
    )

    assert ranges == [
        {"index": 0, "audio_start": 0.0, "audio_end": 1.2},
        {"index": 1, "audio_start": 1.45, "audio_end": 2.25},
    ]


def test_compute_phrase_ranges_uses_speech_bounds_and_tempo_transform() -> None:
    ranges = compute_phrase_ranges(
        [
            {"phrase_index": 0, "pause_after_ms": 300},
            {"phrase_index": 1, "pause_after_ms": 0},
        ],
        [2.0, 1.5],
        segment_speech_bounds=[(0.1, 1.4), (0.2, 1.2)],
        tempo=0.8,
    )

    assert ranges == [
        {"index": 0, "audio_start": 0.125, "audio_end": 1.75},
        {"index": 1, "audio_start": 3.125, "audio_end": 4.375},
    ]


def test_target_phrase_speech_bounds_exclude_leading_filler_from_teacher_range() -> None:
    bounds = _target_phrase_speech_bounds(
        segment_text="嗯，那个，我想去火车站。",
        target_text="我想去火车站。",
        target_language="zh-CN",
        duration=2.254563,
        silence_intervals=[
            {"start": 0.162562, "end": 0.426312},
            {"start": 0.643813, "end": 0.905438},
            {"start": 1.818812, "end": 2.254563},
        ],
        outer_bounds=(0.0, 1.818812),
    )

    assert bounds == (0.905438, 1.818812)


def test_score_comparison_result_accepts_correct_paired_ranges() -> None:
    case = {
        "expected": {
            "model_available_phrase_indices": [0, 1],
            "attempt_available_phrase_indices": [0, 1],
            "paired_phrase_indices": [0, 1],
            "playback_mode": "phrase",
        }
    }
    generated = {
        "model": {
            "phrase_ranges": [
                {"index": 0, "audio_start": 0.0, "audio_end": 1.0},
                {"index": 1, "audio_start": 1.2, "audio_end": 2.2},
            ]
        },
        "attempt": {
            "phrase_ranges": [
                {"index": 0, "audio_start": 0.0, "audio_end": 1.1},
                {"index": 1, "audio_start": 1.3, "audio_end": 2.3},
            ]
        },
    }
    model_alignment = {
        "phrases": [
            {"index": 0, "available": True, "audio_start": 0.05, "audio_end": 0.95},
            {"index": 1, "available": True, "audio_start": 1.25, "audio_end": 2.15},
        ]
    }
    attempt_alignment = {
        "phrases": [
            {"index": 0, "available": True, "audio_start": 0.05, "audio_end": 1.0},
            {"index": 1, "available": True, "audio_start": 1.35, "audio_end": 2.2},
        ]
    }
    playback_plan = {
        "mode": "phrase",
        "ranges": [{"index": 0}, {"index": 1}],
    }

    score = score_comparison_result(
        case,
        generated,
        model_alignment,
        attempt_alignment,
        playback_plan,
        minimum_range_iou=0.65,
    )

    assert score["passed"] is True
    assert score["paired_phrase_indices_exact"] is True
    assert score["minimum_model_range_iou"] >= 0.65
    assert score["minimum_attempt_range_iou"] >= 0.65


def test_score_comparison_result_accepts_predeclared_filler_range_alternative() -> None:
    case = {
        "expected": {
            "model_available_phrase_indices": [0],
            "attempt_available_phrase_indices": [0],
            "paired_phrase_indices": [0],
            "playback_mode": "phrase",
        }
    }
    phrase_ranges = [
        {
            "index": 0,
            "audio_start": 2.0,
            "audio_end": 3.0,
            "acceptable_audio_ranges": [
                {"audio_start": 1.0, "audio_end": 3.0},
            ],
        }
    ]
    generated = {
        "model": {"phrase_ranges": phrase_ranges},
        "attempt": {"phrase_ranges": phrase_ranges},
    }
    alignment = {
        "phrases": [
            {
                "index": 0,
                "available": True,
                "audio_start": 1.0,
                "audio_end": 3.0,
            }
        ]
    }

    score = score_comparison_result(
        case,
        generated,
        alignment,
        alignment,
        {"mode": "phrase", "ranges": [{"index": 0}]},
        minimum_range_iou=0.65,
    )

    assert score["minimum_model_range_iou"] == 1.0
    assert score["minimum_attempt_range_iou"] == 1.0
    assert score["passed"] is True


def test_score_comparison_result_rejects_range_for_omitted_phrase() -> None:
    case = {
        "expected": {
            "model_available_phrase_indices": [0, 1, 2],
            "attempt_available_phrase_indices": [0, 2],
            "paired_phrase_indices": [0, 2],
            "playback_mode": "partial_phrase",
        }
    }
    generated = {
        "model": {
            "phrase_ranges": [
                {"index": 0, "audio_start": 0.0, "audio_end": 1.0},
                {"index": 1, "audio_start": 1.2, "audio_end": 2.2},
                {"index": 2, "audio_start": 2.4, "audio_end": 3.4},
            ]
        },
        "attempt": {
            "phrase_ranges": [
                {"index": 0, "audio_start": 0.0, "audio_end": 1.0},
                {"index": 2, "audio_start": 1.6, "audio_end": 2.6},
            ]
        },
    }
    model_alignment = {
        "phrases": [
            {"index": 0, "available": True, "audio_start": 0.0, "audio_end": 1.0},
            {"index": 1, "available": True, "audio_start": 1.2, "audio_end": 2.2},
            {"index": 2, "available": True, "audio_start": 2.4, "audio_end": 3.4},
        ]
    }
    attempt_alignment = {
        "phrases": [
            {"index": 0, "available": True, "audio_start": 0.0, "audio_end": 1.0},
            {"index": 1, "available": True, "audio_start": 1.0, "audio_end": 1.5},
            {"index": 2, "available": True, "audio_start": 1.6, "audio_end": 2.6},
        ]
    }
    playback_plan = {
        "mode": "phrase",
        "ranges": [{"index": 0}, {"index": 1}, {"index": 2}],
    }

    score = score_comparison_result(
        case,
        generated,
        model_alignment,
        attempt_alignment,
        playback_plan,
        minimum_range_iou=0.65,
    )

    assert score["passed"] is False
    assert score["attempt_available_phrase_indices_exact"] is False
    assert score["playback_mode_exact"] is False


def test_score_comparison_result_rejects_adjacent_phrase_speech_even_when_iou_passes() -> None:
    case = {
        "expected": {
            "model_available_phrase_indices": [0, 1],
            "attempt_available_phrase_indices": [0, 1],
            "paired_phrase_indices": [0, 1],
            "playback_mode": "phrase",
        }
    }
    generated = {
        "model": {
            "phrase_ranges": [
                {"index": 0, "audio_start": 0.0, "audio_end": 1.0},
                {"index": 1, "audio_start": 1.2, "audio_end": 2.2},
            ]
        },
        "attempt": {
            "phrase_ranges": [
                {"index": 0, "audio_start": 0.0, "audio_end": 1.0},
                {"index": 1, "audio_start": 1.2, "audio_end": 2.2},
            ]
        },
    }
    unsafe_model_alignment = {
        "phrases": [
            {"index": 0, "available": True, "audio_start": 0.0, "audio_end": 1.3},
            {"index": 1, "available": True, "audio_start": 1.2, "audio_end": 2.2},
        ]
    }
    safe_attempt_alignment = {
        "phrases": [
            {"index": 0, "available": True, "audio_start": 0.0, "audio_end": 1.0},
            {"index": 1, "available": True, "audio_start": 1.2, "audio_end": 2.2},
        ]
    }

    score = score_comparison_result(
        case,
        generated,
        unsafe_model_alignment,
        safe_attempt_alignment,
        {"mode": "phrase", "ranges": [{"index": 0}, {"index": 1}]},
        minimum_range_iou=0.65,
    )

    assert score["minimum_model_range_iou"] >= 0.65
    assert score["model_ranges_exclude_other_phrase_speech"] is False
    assert score["attempt_ranges_exclude_other_phrase_speech"] is True
    assert score["passed"] is False


def test_run_playback_plan_uses_actual_web_contract() -> None:
    alignment = {
        "available": True,
        "complete": True,
        "all_phrases_playable": True,
        "target_phrase_count": 2,
        "phrases": [
            {"index": 0, "available": True, "audio_start": 0.0, "audio_end": 1.0},
            {"index": 1, "available": True, "audio_start": 1.2, "audio_end": 2.2},
        ],
    }

    plan = run_playback_plan(
        {
            "modelReady": True,
            "repeatReady": True,
            "resultVisible": True,
            "outcome": "evaluated",
            "recognizedLanguageMatches": True,
            "attemptAlignment": alignment,
            "modelAlignment": alignment,
            "modelDuration": 2.3,
            "repeatDuration": 2.3,
        },
        project_root=ROOT,
    )

    assert plan["mode"] == "phrase"
    assert [row["index"] for row in plan["ranges"]] == [0, 1]
