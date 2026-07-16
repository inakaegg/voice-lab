from __future__ import annotations

import argparse
import importlib.util
import json
import statistics
import tracemalloc
from pathlib import Path
from time import perf_counter
from types import ModuleType


def _load_module(path: Path | None) -> ModuleType:
    if path is None:
        import mo_speech.practice as module

        return module
    spec = importlib.util.spec_from_file_location("practice_alignment_benchmark_target", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load module: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _synthetic_case(phrase_count: int, words_per_phrase: int) -> dict[str, object]:
    targets: list[str] = []
    words: list[dict[str, object]] = []
    timestamp = 0.0
    for phrase_index in range(phrase_count):
        pieces = [f"word{phrase_index}", *[f"part{index}" for index in range(1, words_per_phrase)]]
        targets.append(" ".join(pieces) + ".")
        for piece in pieces:
            words.append({"text": piece, "start": timestamp, "end": timestamp + 0.08})
            timestamp += 0.1
    return {
        "target_text": " ".join(targets),
        "recognized_text": " ".join(str(word["text"]) for word in words),
        "target_language": "en-US",
        "asr_timestamps": {"available": True, "words": words},
    }


def _measure(module: ModuleType, name: str, phrase_count: int, words_per_phrase: int, iterations: int) -> dict[str, object]:
    function = getattr(module, "practice_comparison_alignment_canonical", None)
    canonical = callable(function)
    if not canonical:
        function = module.practice_comparison_alignment
    case = _synthetic_case(phrase_count, words_per_phrase)
    samples: list[float] = []
    result: dict[str, object] = {}
    function(**case)
    for _ in range(iterations):
        started = perf_counter()
        result = function(**case)
        samples.append((perf_counter() - started) * 1000)
    tracemalloc.start()
    function(**case)
    _, peak_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    ordered = sorted(samples)
    p95_index = max(0, min(len(ordered) - 1, int(len(ordered) * 0.95 + 0.999) - 1))
    diagnostics = result.get("diagnostics") if isinstance(result.get("diagnostics"), dict) else {}
    return {
        "name": name,
        "phrase_count": phrase_count,
        "timestamp_unit_count": phrase_count * words_per_phrase,
        "iterations": iterations,
        "median_elapsed_ms": round(statistics.median(samples), 3),
        "p95_elapsed_ms": round(ordered[p95_index], 3),
        "peak_traced_bytes": peak_bytes,
        "candidate_count": diagnostics.get("candidate_count", 0),
        "score_computation_count": diagnostics.get("score_computation_count", 0),
        "canonical_contract": canonical,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark SpeakLoop practice alignment.")
    parser.add_argument("--module", type=Path, help="Optional practice.py from another revision.")
    parser.add_argument("--quick", action="store_true", help="Use fewer iterations for local checks.")
    args = parser.parse_args()
    module = _load_module(args.module)
    normal_iterations = 5 if args.quick else 20
    max_iterations = 2 if args.quick else 5
    results = [
        _measure(module, "representative_4x16", 4, 4, normal_iterations),
        _measure(module, "maximum_complexity_16x64", 16, 4, max_iterations),
        _measure(module, "maximum_timestamp_1x256", 1, 256, max_iterations),
    ]
    print(json.dumps({"runtime": "python", "results": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
