import json
import subprocess
import sys
from pathlib import Path

from scripts import evaluate_fa_zh_alignment as alignment_harness
from scripts.evaluate_fa_zh_alignment import evaluate_side, find_reference_audio, phrase_spans, summarize


def test_alignment_harness_help_runs_from_a_source_worktree() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/evaluate_fa_zh_alignment.py", "--help"],
        check=True,
        capture_output=True,
        text=True,
    )

    assert "--recordings-dir" in result.stdout


def test_alignment_harness_reports_vad_agreement_without_calling_it_boundary_accuracy() -> None:
    words = [
        {"text": "你", "start": 0.1, "end": 0.4},
        {"text": "好", "start": 0.4, "end": 0.7},
        {"text": "吗", "start": 1.1, "end": 1.4},
    ]
    comparison = {
        "phrases": [
            {"reference": {"word_start_index": 0, "word_end_index": 2}},
            {"reference": {"word_start_index": 2, "word_end_index": 3}},
        ]
    }
    islands = [(0.0, 0.7), (1.0, 1.5)]

    row = evaluate_side(words, islands, phrase_spans(comparison, words, "reference"))

    assert row["word_speech_overlap_rate"] == 1.0
    assert row["vad_edge_distances"] == [0.1, 0.1, 0.0, 0.1]
    assert row["vad_edge_within_250ms"] == 1.0


def test_alignment_harness_summarizes_vad_agreement_with_stable_thresholds() -> None:
    rows = [
        {"reference": {"word_speech_overlap_rate": 1.0, "vad_edge_distances": [0.1, 0.3]}},
        {"reference": {"word_speech_overlap_rate": 0.5, "vad_edge_distances": [0.2, 0.4]}},
    ]

    assert summarize(rows, "reference") == {
        "cases": 2,
        "vad_edges": 4,
        "word_speech_overlap_rate_mean": 0.75,
        "vad_edge_distance_median": 0.25,
        "vad_edge_within_120ms": 0.25,
        "vad_edge_within_250ms": 0.5,
        "vad_edge_distance_worst": 0.4,
    }


def _write_output_metadata(root: Path, name: str, metadata: dict[str, str]) -> Path:
    audio_path = root / f"{name}.wav"
    audio_path.write_bytes(b"wav")
    audio_path.with_suffix(".wav.json").write_text(json.dumps(metadata), encoding="utf-8")
    return audio_path


def test_reference_audio_uses_the_same_exact_language_and_prompt_contract_as_the_product(tmp_path: Path) -> None:
    target_text = "中" * 81
    expected = _write_output_metadata(
        tmp_path,
        "expected",
        {
            "endpoint": "practice-prompts",
            "target_language": "zh-CN",
            "tts_text": target_text,
            "text_preview": target_text[:80],
            "created_at": "20260722T010000Z",
        },
    )
    _write_output_metadata(
        tmp_path,
        "newer-wrong-language",
        {
            "endpoint": "practice-prompts",
            "target_language": "en-US",
            "tts_text": target_text,
            "text_preview": target_text[:80],
            "created_at": "20260722T020000Z",
        },
    )
    _write_output_metadata(
        tmp_path,
        "newer-wrong-endpoint",
        {
            "endpoint": "translations",
            "target_language": "zh-CN",
            "tts_text": target_text,
            "text_preview": target_text[:80],
            "created_at": "20260722T030000Z",
        },
    )

    assert find_reference_audio(tmp_path, target_text, "zh-CN", "20260722T040000Z") == expected


def test_evaluate_cases_keeps_the_aligned_result_collection_separate_from_each_transcription(
    monkeypatch,
) -> None:
    monkeypatch.setattr(alignment_harness, "detect_speech_islands", lambda _path: [(0.0, 1.0)])

    class FakeProvider:
        model = "fake"

        def force_align_detail(self, _audio_path, transcription, *, speech_islands):
            assert speech_islands == [(0.0, 1.0)]
            return transcription

    case = {
        "name": "one.wav.json",
        "attempt_audio": Path("one.wav"),
        "attempt_words": [{"text": "你", "start": 0.0, "end": 1.0}],
        "reference_audio": None,
        "reference_words": [],
        "comparison": {
            "phrases": [{"attempt": {"word_start_index": 0, "word_end_index": 1}}]
        },
    }

    result = alignment_harness.evaluate_cases([case], FakeProvider())

    assert result["aligned_vad_agreement"][0]["attempt"]["word_count"] == 1
