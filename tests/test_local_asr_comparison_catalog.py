from __future__ import annotations

from pathlib import Path

from mo_speech.local_asr_comparison import load_comparison_manifest
from mo_speech.local_asr_comparison_catalog import (
    STAGE_SIZES,
    build_staged_comparison_manifest,
    load_json_object,
)


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"


def _build_manifest() -> dict[str, object]:
    return build_staged_comparison_manifest(
        load_json_object(FIXTURES / "asr_comparison_pair_pilot.json"),
        [
            load_json_object(FIXTURES / "asr_learning_samples_manifest.json"),
            load_json_object(FIXTURES / "asr_learning_samples_manifest_pilot_2.json"),
        ],
    )


def test_staged_comparison_catalog_is_fixed_before_asr_and_reaches_hundreds() -> None:
    manifest = _build_manifest()
    cases = manifest["cases"]

    assert isinstance(cases, list)
    assert len(cases) == 384
    assert manifest["stage_sizes"] == STAGE_SIZES
    assert [case["id"] for case in cases[:3]] == [
        "pair-zh-middle-tone-substitution",
        "pair-zh-asr-corrects-n-to-l",
        "pair-zh-middle-phrase-omission",
    ]
    assert all(case["language"] == "zh-CN" for case in cases)


def test_staged_comparison_catalog_has_learner_and_recording_variety() -> None:
    cases = _build_manifest()["cases"]
    assert isinstance(cases, list)

    categories = {str(case["category"]) for case in cases}
    profiles = {str(case.get("acoustic_profile") or "") for case in cases}
    voices = {str(case["attempt"]["voice"]) for case in cases}
    phrase_counts = {len(case["target_phrases"]) for case in cases}

    assert len(categories) >= 12
    assert len(profiles - {""}) >= 10
    assert len(voices) >= 8
    assert phrase_counts == {2, 3, 4}
    assert any(case["expected"]["playback_mode"] == "partial_phrase" for case in cases)


def test_checked_in_staged_comparison_fixture_matches_the_deterministic_builder() -> None:
    checked_in = load_json_object(FIXTURES / "asr_comparison_pair_corpus.json")

    assert checked_in == _build_manifest()
    assert len(load_comparison_manifest(FIXTURES / "asr_comparison_pair_corpus.json")["cases"]) == 384
