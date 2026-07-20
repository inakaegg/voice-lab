#!/usr/bin/env python3
"""保存済みSpeakLoop音声でfa-zh整列とVADの整合性を回帰確認する。"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from mo_speech.practice_forced_alignment import detect_speech_islands
from mo_speech.providers.funasr import FunAsrPracticeProvider
from mo_speech.providers.openai_api import AsrTranscription


def overlaps(span: tuple[float, float], islands: list[tuple[float, float]]) -> bool:
    start, end = span
    return any(island_start < end and start < island_end for island_start, island_end in islands)


def nearest_edge_error(value: float, edges: list[float]) -> float:
    return min(abs(value - edge) for edge in edges)


def phrase_spans(
    comparison: dict[str, Any],
    words: list[dict[str, Any]],
    side: str,
) -> list[tuple[float, float]]:
    spans: list[tuple[float, float]] = []
    for phrase in comparison.get("phrases") or []:
        selected = phrase.get(side) or {}
        start_index = selected.get("word_start_index")
        end_index = selected.get("word_end_index")
        if not (
            isinstance(start_index, int)
            and isinstance(end_index, int)
            and 0 <= start_index < end_index <= len(words)
        ):
            continue
        spans.append((float(words[start_index]["start"]), float(words[end_index - 1]["end"])))
    return spans


def evaluate_side(
    words: list[dict[str, Any]],
    islands: list[tuple[float, float]],
    spans: list[tuple[float, float]],
) -> dict[str, Any]:
    onsets = [start for start, _ in islands]
    offsets = [end for _, end in islands]
    word_hits = [overlaps((float(word["start"]), float(word["end"])), islands) for word in words]
    onset_errors = [nearest_edge_error(start, onsets) for start, _ in spans]
    offset_errors = [nearest_edge_error(end, offsets) for _, end in spans]
    vad_edge_distances = onset_errors + offset_errors
    return {
        "word_count": len(words),
        "word_speech_overlap_rate": sum(word_hits) / len(word_hits) if word_hits else None,
        "phrase_count": len(spans),
        "vad_edge_distances": [round(error, 3) for error in vad_edge_distances],
        "vad_edge_distance_median": (
            round(statistics.median(vad_edge_distances), 3) if vad_edge_distances else None
        ),
        "vad_edge_within_120ms": (
            sum(error <= 0.12 for error in vad_edge_distances) / len(vad_edge_distances)
            if vad_edge_distances
            else None
        ),
        "vad_edge_within_250ms": (
            sum(error <= 0.25 for error in vad_edge_distances) / len(vad_edge_distances)
            if vad_edge_distances
            else None
        ),
    }


def summarize(rows: list[dict[str, Any]], side: str) -> dict[str, Any]:
    evaluated = [row[side] for row in rows if row.get(side)]
    distances = [distance for row in evaluated for distance in row["vad_edge_distances"]]
    word_rates = [
        row["word_speech_overlap_rate"]
        for row in evaluated
        if row["word_speech_overlap_rate"] is not None
    ]
    return {
        "cases": len(evaluated),
        "vad_edges": len(distances),
        "word_speech_overlap_rate_mean": round(statistics.mean(word_rates), 3) if word_rates else None,
        "vad_edge_distance_median": round(statistics.median(distances), 3) if distances else None,
        "vad_edge_within_120ms": (
            round(sum(distance <= 0.12 for distance in distances) / len(distances), 3)
            if distances
            else None
        ),
        "vad_edge_within_250ms": (
            round(sum(distance <= 0.25 for distance in distances) / len(distances), 3)
            if distances
            else None
        ),
        "vad_edge_distance_worst": round(max(distances), 3) if distances else None,
    }


def find_reference_audio(
    outputs_dir: Path,
    target_text: str,
    target_language: str,
    created_at: str,
) -> Path | None:
    best: tuple[str, Path] | None = None
    for metadata_path in outputs_dir.glob("*.wav.json"):
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        timestamp = str(metadata.get("created_at") or "")
        audio_path = metadata_path.with_suffix("")
        if (
            metadata.get("endpoint") == "practice-prompts"
            and metadata.get("target_language") == target_language
            and metadata.get("tts_text") == target_text
            and timestamp <= created_at
            and audio_path.is_file()
        ):
            if best is None or timestamp > best[0]:
                best = (timestamp, audio_path)
    return best[1] if best else None


def collect_cases(recordings_dir: Path, outputs_dir: Path) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for metadata_path in sorted(recordings_dir.glob("*.wav.json")):
        record = json.loads(metadata_path.read_text(encoding="utf-8"))
        diagnostics = record.get("practice_diagnostics") or {}
        comparison = diagnostics.get("llm_comparison") or {}
        attempt_timestamps = diagnostics.get("asr_timestamps") or {}
        model_timestamps = diagnostics.get("model_asr_timestamps") or {}
        attempt_audio = metadata_path.with_suffix("")
        if not (
            diagnostics.get("target_language") == "zh-CN"
            and comparison.get("phrases")
            and attempt_timestamps.get("words")
            and model_timestamps.get("words")
            and attempt_audio.is_file()
        ):
            continue
        target_text = str(diagnostics.get("target_text") or "")
        cases.append(
            {
                "name": metadata_path.name,
                "attempt_audio": attempt_audio,
                "attempt_words": attempt_timestamps["words"],
                "reference_audio": find_reference_audio(
                    outputs_dir,
                    target_text,
                    str(diagnostics.get("target_language") or ""),
                    str(record.get("created_at") or ""),
                ),
                "reference_words": model_timestamps["words"],
                "comparison": comparison,
            }
        )
    return cases


def evaluate_cases(cases: list[dict[str, Any]], provider: FunAsrPracticeProvider) -> dict[str, Any]:
    baseline: list[dict[str, Any]] = []
    aligned_rows: list[dict[str, Any]] = []
    for case in cases:
        before_row: dict[str, Any] = {"name": case["name"]}
        after_row: dict[str, Any] = {"name": case["name"]}
        for side in ("attempt", "reference"):
            audio_path = case[f"{side}_audio"]
            if audio_path is None:
                continue
            old_words = case[f"{side}_words"]
            islands = detect_speech_islands(audio_path)
            transcription = AsrTranscription(
                text="".join(str(word.get("text") or "") for word in old_words),
                model=provider.model,
                words=old_words,
                segments=[],
            )
            aligned_transcription = provider.force_align_detail(
                audio_path,
                transcription,
                speech_islands=islands,
            )
            before_row[side] = evaluate_side(
                old_words, islands, phrase_spans(case["comparison"], old_words, side)
            )
            after_row[side] = evaluate_side(
                aligned_transcription.words,
                islands,
                phrase_spans(case["comparison"], aligned_transcription.words, side),
            )
        baseline.append(before_row)
        aligned_rows.append(after_row)
    return {
        "metric_scope": {
            "name": "vad_agreement_not_boundary_accuracy",
            "description": (
                "発話島との整合性を確認する回帰指標。VADスナップ後の値はVAD境界を使うため、"
                "手動正解境界に対する精度や製品上の改善を示さない。"
            ),
        },
        "baseline_vad_agreement": baseline,
        "aligned_vad_agreement": aligned_rows,
        "summary": {
            side: {"baseline": summarize(baseline, side), "aligned": summarize(aligned_rows, side)}
            for side in ("attempt", "reference")
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recordings-dir", type=Path, default=REPO_ROOT / "tmp/audio-history/recordings")
    parser.add_argument("--outputs-dir", type=Path, default=REPO_ROOT / "tmp/audio-history/outputs")
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "tmp/fa-zh-alignment-results.json")
    parser.add_argument("--fa-model", default="funasr/fa-zh")
    parser.add_argument("--hub", default="hf")
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()

    provider = FunAsrPracticeProvider(alignment_model=args.fa_model, hub=args.hub, device=args.device)
    result = evaluate_cases(collect_cases(args.recordings_dir, args.outputs_dir), provider)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result["summary"], ensure_ascii=False, indent=2))
    print(f"results: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
