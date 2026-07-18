from __future__ import annotations

import json
from pathlib import Path

import pytest

from mo_speech.local_asr_corpus import (
    _cached_huggingface_revision,
    build_synthesis_plan,
    evaluate_transcription,
    load_corpus_manifest,
    render_markdown_report,
    summarize_results,
    transcribe_corpus,
)

ROOT = Path(__file__).resolve().parents[1]


def _write_manifest(path: Path, cases: list[dict[str, object]]) -> Path:
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "created_at": "2026-07-17",
                "purpose": "test",
                "cases": cases,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return path


def _case(**overrides: object) -> dict[str, object]:
    case: dict[str, object] = {
        "id": "zh-native-greeting",
        "language": "zh-CN",
        "category": "native_ceiling",
        "source_kind": "apple_tts_native",
        "target_text": "你好。",
        "expected_spoken_text": "你好。",
        "synthesis": {
            "voice": "Tingting",
            "rate_wpm": 180,
            "segments": [{"text": "你好。"}],
        },
        "tags": ["canonical"],
        "fidelity": "native_synthetic",
    }
    case.update(overrides)
    return case


def test_load_corpus_manifest_validates_and_preserves_cases(tmp_path: Path) -> None:
    manifest_path = _write_manifest(tmp_path / "manifest.json", [_case()])

    manifest = load_corpus_manifest(manifest_path)

    assert manifest["schema_version"] == 1
    assert manifest["cases"][0]["id"] == "zh-native-greeting"


def test_load_corpus_manifest_rejects_duplicate_ids(tmp_path: Path) -> None:
    manifest_path = _write_manifest(tmp_path / "manifest.json", [_case(), _case()])

    with pytest.raises(ValueError, match="duplicate case id"):
        load_corpus_manifest(manifest_path)


def test_load_corpus_manifest_rejects_punctuation_only_tts_segment(tmp_path: Path) -> None:
    case = _case()
    case["synthesis"] = {
        "voice": "Tingting",
        "segments": [{"text": "你好"}, {"text": "。"}],
    }
    manifest_path = _write_manifest(tmp_path / "manifest.json", [case])

    with pytest.raises(ValueError, match="punctuation-only"):
        load_corpus_manifest(manifest_path)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("language", "ja-JP", "unsupported language"),
        ("source_kind", "unknown", "unsupported source_kind"),
        ("fidelity", "perfect_learner", "unsupported fidelity"),
    ],
)
def test_load_corpus_manifest_rejects_unsupported_values(
    tmp_path: Path,
    field: str,
    value: str,
    message: str,
) -> None:
    manifest_path = _write_manifest(tmp_path / "manifest.json", [_case(**{field: value})])

    with pytest.raises(ValueError, match=message):
        load_corpus_manifest(manifest_path)


def test_build_synthesis_plan_keeps_segment_level_tone_and_pause_controls() -> None:
    case = _case(
        id="zh-tone-flat",
        category="tone_contour",
        source_kind="apple_tts_pitch_manipulated",
        synthesis={
            "voice": "Tingting",
            "rate_wpm": 165,
            "tempo": 0.88,
            "noise_amplitude": 0.01,
            "segments": [
                {"text": "我想"},
                {"text": "买", "pitch_contour": "flat", "pause_after_ms": 450},
                {"text": "一杯咖啡。"},
            ],
        },
        fidelity="controlled_acoustic_proxy",
    )

    plan = build_synthesis_plan(case)

    assert plan.voice == "Tingting"
    assert plan.rate_wpm == 165
    assert plan.tempo == 0.88
    assert plan.noise_amplitude == 0.01
    assert plan.segments[1].pitch_contour == "flat"
    assert plan.segments[1].pause_after_ms == 450


def test_build_synthesis_plan_keeps_microphone_channel_controls() -> None:
    case = _case(
        id="zh-telephone-channel",
        category="acoustic_channel",
        source_kind="apple_tts_acoustic_variant",
        synthesis={
            "voice": "Tingting",
            "rate_wpm": 155,
            "volume_db": -12,
            "lowpass_hz": 3400,
            "echo_delay_ms": 90,
            "echo_decay": 0.18,
            "segments": [{"text": "请问地铁站在哪里？"}],
        },
        fidelity="controlled_acoustic_proxy",
    )

    plan = build_synthesis_plan(case)

    assert plan.volume_db == -12
    assert plan.lowpass_hz == 3400
    assert plan.echo_delay_ms == 90
    assert plan.echo_decay == 0.18


def test_evaluate_transcription_separates_asr_accuracy_from_practice_target() -> None:
    case = _case(
        id="zh-tone-mai",
        category="tone_substitution",
        source_kind="apple_tts_text_substitution",
        target_text="我想买一杯咖啡。",
        expected_spoken_text="我想卖一杯咖啡。",
        fidelity="controlled_pronunciation_proxy",
    )

    metrics = evaluate_transcription(case, "我想卖一杯咖啡")

    assert metrics["reference_similarity"] == 1.0
    assert metrics["target_similarity"] < 1.0
    assert metrics["error_was_observable"] is True


def test_evaluate_transcription_does_not_claim_error_detection_for_native_case() -> None:
    metrics = evaluate_transcription(_case(), "你好")

    assert metrics["reference_similarity"] == 1.0
    assert metrics["target_similarity"] == 1.0
    assert metrics["error_was_observable"] is None


def test_transcribe_corpus_rejects_generation_for_another_manifest(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manifest_path = _write_manifest(tmp_path / "manifest.json", [_case()])
    output_dir = tmp_path / "generated"
    output_dir.mkdir()
    (output_dir / "generation.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "manifest_sha256": "stale-manifest-hash",
                "cases": [{"id": "zh-native-greeting"}],
            }
        ),
        encoding="utf-8",
    )

    def fail_if_model_setup_starts(_: Path) -> dict[str, Path]:
        raise AssertionError("stale generation must be rejected before model setup")

    monkeypatch.setattr(
        "mo_speech.local_asr_corpus._model_cache_paths",
        fail_if_model_setup_starts,
    )

    with pytest.raises(
        ValueError,
        match="generation manifest hash does not match current manifest",
    ):
        transcribe_corpus(
            manifest_path,
            output_dir,
            model_cache_dir=tmp_path / "models",
        )


def test_summarize_results_keeps_provider_case_counts_separate() -> None:
    rows = [
        {
            "providers": {
                "faster_whisper": {
                    "metrics": {
                        "reference_similarity": 1.0,
                        "error_was_observable": None,
                    }
                },
                "funasr": {
                    "metrics": {
                        "reference_similarity": 0.8,
                        "error_was_observable": True,
                    }
                },
            }
        },
        {
            "providers": {
                "faster_whisper": {
                    "metrics": {
                        "reference_similarity": 0.5,
                        "error_was_observable": False,
                    }
                }
            }
        },
    ]

    summary = summarize_results(rows)

    assert summary["faster_whisper"] == {
        "case_count": 2,
        "mean_reference_similarity": 0.75,
        "textual_error_case_count": 1,
        "observable_textual_error_count": 0,
    }
    assert summary["funasr"]["case_count"] == 1


def test_cached_huggingface_revision_supports_new_tree_cache_layout(tmp_path: Path) -> None:
    repository = tmp_path / "models--example--model"
    (repository / "refs").mkdir(parents=True)
    (repository / "refs" / "main").write_text("abc123\n", encoding="utf-8")

    assert _cached_huggingface_revision(repository) == "abc123"


def test_checked_in_pilot_manifest_keeps_small_stage_and_chinese_priority() -> None:
    manifest = load_corpus_manifest(
        ROOT / "tests" / "fixtures" / "asr_learning_samples_manifest.json"
    )
    languages = [case["language"] for case in manifest["cases"]]
    source_kinds = {case["source_kind"] for case in manifest["cases"]}

    assert len(languages) == 20
    assert languages.count("zh-CN") == 16
    assert source_kinds == {
        "apple_tts_native",
        "apple_tts_text_substitution",
        "apple_tts_pitch_manipulated",
        "apple_tts_cross_language_phonetic",
        "apple_tts_acoustic_variant",
    }


def test_checked_in_second_pilot_adds_twenty_distinct_cases() -> None:
    first = load_corpus_manifest(
        ROOT / "tests" / "fixtures" / "asr_learning_samples_manifest.json"
    )
    second = load_corpus_manifest(
        ROOT / "tests" / "fixtures" / "asr_learning_samples_manifest_pilot_2.json"
    )
    first_ids = {case["id"] for case in first["cases"]}
    second_ids = {case["id"] for case in second["cases"]}
    second_languages = [case["language"] for case in second["cases"]]

    assert len(second_ids) == 20
    assert first_ids.isdisjoint(second_ids)
    assert second_languages.count("zh-CN") == 18


def test_render_markdown_report_shows_reference_and_target_as_separate_columns() -> None:
    report = render_markdown_report(
        {
            "summary": {
                "funasr": {
                    "case_count": 1,
                    "mean_reference_similarity": 0.9,
                    "textual_error_case_count": 1,
                    "observable_textual_error_count": 1,
                }
            },
            "cases": [
                {
                    "id": "zh-tone-mai",
                    "category": "tone_substitution",
                    "target_text": "我想买咖啡",
                    "expected_spoken_text": "我想卖咖啡",
                    "providers": {
                        "funasr": {
                            "text": "我想卖咖啡",
                            "metrics": {
                                "reference_similarity": 1.0,
                                "target_similarity": 0.8,
                                "error_was_observable": True,
                            },
                        }
                    },
                }
            ],
        }
    )

    assert "expected spoken" in report
    assert "target similarity" in report
    assert "我想卖咖啡" in report
    assert "yes" in report
