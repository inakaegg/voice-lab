#!/usr/bin/env python3
"""Go baseline、WordNet fallback、Embedding fallbackを同じfixtureで比較する。"""
from __future__ import annotations

import argparse
import copy
import json
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Any, Iterable, Sequence


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def unique_strings(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(value.strip() for value in values if value.strip()))


def filter_fixtures(
    fixtures: Sequence[dict[str, Any]], roles: set[str]
) -> list[dict[str, Any]]:
    if not roles:
        return list(fixtures)
    return [fixture for fixture in fixtures if fixture.get("role") in roles]


def synonym_expansions(
    connection: sqlite3.Connection,
    extracted: Sequence[dict[str, Any]],
    allowed_pos: set[str],
    per_term_limit: int,
) -> tuple[dict[str, list[str]], dict[str, list[dict[str, str]]]]:
    if not allowed_pos:
        raise ValueError("at least one WordNet part of speech is required")
    if per_term_limit < 1:
        raise ValueError("per-term synonym limit must be positive")
    placeholders = ",".join("?" for _ in sorted(allowed_pos))
    expansions: dict[str, list[str]] = {}
    details: dict[str, list[dict[str, str]]] = {}
    for item in extracted:
        expanded: list[str] = []
        detail: list[dict[str, str]] = []
        for term in unique_strings(item.get("terms", [])):
            rows = connection.execute(
                "SELECT DISTINCT synonym, part_of_speech FROM synonyms "
                f"WHERE term=? AND synonym<>? AND part_of_speech IN ({placeholders}) "
                "ORDER BY synonym, part_of_speech LIMIT ?",
                [term, term, *sorted(allowed_pos), per_term_limit],
            ).fetchall()
            for synonym, part_of_speech in rows:
                if synonym in expanded:
                    continue
                expanded.append(synonym)
                detail.append(
                    {
                        "source_term": term,
                        "synonym": synonym,
                        "part_of_speech": part_of_speech,
                    }
                )
        expansions[item["id"]] = expanded
        details[item["id"]] = detail
    return expansions, details


def validate_result_ids(fixtures: Sequence[dict[str, Any]], results: Sequence[dict[str, Any]]) -> None:
    fixture_ids = [item["id"] for item in fixtures]
    result_ids = [item["id"] for item in results]
    if fixture_ids != result_ids:
        raise ValueError(f"result IDs do not match fixture IDs: {result_ids} != {fixture_ids}")


def semantic_ok(fixture: dict[str, Any], result: dict[str, Any]) -> bool:
    expected = set(fixture.get("expected_strategy", []))
    if "error" in expected:
        return bool(result.get("error"))
    if result.get("error") or not result.get("selection"):
        return False
    selection = result["selection"]
    acceptable = set(fixture.get("acceptable_animals", []))
    if acceptable:
        return selection.get("species") in acceptable
    return selection.get("strategy") in expected


def annotate_semantic(
    fixtures: Sequence[dict[str, Any]], results: Sequence[dict[str, Any]]
) -> list[dict[str, Any]]:
    validate_result_ids(fixtures, results)
    annotated = copy.deepcopy(list(results))
    for fixture, result in zip(fixtures, annotated, strict=True):
        result["semantic_ok"] = semantic_ok(fixture, result)
    return annotated


def embedding_fallback_results(
    fixtures: Sequence[dict[str, Any]],
    baseline: Sequence[dict[str, Any]],
    embedding_by_id: dict[str, dict[str, Any]],
    threshold: float,
) -> list[dict[str, Any]]:
    validate_result_ids(fixtures, baseline)
    results: list[dict[str, Any]] = []
    for fixture, base in zip(fixtures, baseline, strict=True):
        result = copy.deepcopy(base)
        result["candidate"] = "E"
        selection = result.get("selection") or {}
        if not result.get("error") and selection.get("strategy") == "random_fallback":
            embedding = embedding_by_id.get(fixture["id"])
            candidates = embedding.get("candidates", []) if embedding else []
            if candidates and float(candidates[0]["score"]) >= threshold:
                selected = candidates[0]
                result["selection"] = {
                    "species": selected["id"],
                    "label_ja": selected["label_ja"],
                    "evidence_term": fixture["input"],
                    "strategy": "embedding_profile",
                    "score": {"total": float(selected["score"]), "contributions": []},
                }
                result.pop("error", None)
        result["semantic_ok"] = semantic_ok(fixture, result)
        results.append(result)
    return results


def summarize(results: Sequence[dict[str, Any]]) -> dict[str, Any]:
    strategies: dict[str, int] = {}
    semantic_count = path_count = fallback_count = error_count = 0
    for result in results:
        semantic_count += int(bool(result.get("semantic_ok")))
        if result.get("error"):
            error_count += 1
            strategy = result["error"].get("code", "error")
        else:
            strategy = result.get("selection", {}).get("strategy", "missing")
            if strategy == "random_fallback":
                fallback_count += 1
            elif strategy != "missing":
                path_count += 1
        strategies[strategy] = strategies.get(strategy, 0) + 1
    return {
        "total": len(results),
        "semantic_ok_count": semantic_count,
        "association_path_count": path_count,
        "random_fallback_count": fallback_count,
        "error_count": error_count,
        "strategies": dict(sorted(strategies.items())),
    }


def metrics_by_role(
    fixtures: Sequence[dict[str, Any]], results: Sequence[dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    validate_result_ids(fixtures, results)
    roles = sorted({fixture.get("role", "") for fixture in fixtures})
    return {
        role: summarize(
            [
                result
                for fixture, result in zip(fixtures, results, strict=True)
                if fixture.get("role", "") == role
            ]
        )
        for role in roles
    }


def compare_to_baseline(
    baseline: Sequence[dict[str, Any]], candidate: Sequence[dict[str, Any]]
) -> dict[str, int]:
    validate_result_ids(baseline, candidate)
    counts = {"improved": 0, "regressed": 0, "unchanged": 0}
    for base, result in zip(baseline, candidate, strict=True):
        before = bool(base.get("semantic_ok"))
        after = bool(result.get("semantic_ok"))
        if after and not before:
            counts["improved"] += 1
        elif before and not after:
            counts["regressed"] += 1
        else:
            counts["unchanged"] += 1
    return counts


def run_command(command: Sequence[str]) -> tuple[float, str]:
    started = time.monotonic()
    completed = subprocess.run(command, check=True, capture_output=True, text=True)
    return time.monotonic() - started, completed.stdout


def invoke_go(
    args: argparse.Namespace,
    command: str,
    fixtures_path: Path,
    output_path: Path,
    *,
    candidate: str | None = None,
    expansions_path: Path | None = None,
) -> float:
    invocation = [str(args.go_binary), "association-eval", command, "--fixtures", str(fixtures_path)]
    if command == "evaluate":
        invocation.extend(
            [
                "--lexicon",
                str(args.lexicon),
                "--index",
                str(args.concept_index),
                "--candidate",
                candidate or "A",
                "--seed",
                str(args.seed),
            ]
        )
        if expansions_path is not None:
            invocation.extend(["--expansions", str(expansions_path)])
    invocation.extend(["--output", str(output_path)])
    elapsed, _ = run_command(invocation)
    return elapsed


def run_embedding_fallbacks(
    args: argparse.Namespace,
    fixtures: Sequence[dict[str, Any]],
    baseline: Sequence[dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], float]:
    raw: dict[str, dict[str, Any]] = {}
    elapsed = 0.0
    for fixture, base in zip(fixtures, baseline, strict=True):
        if base.get("error") or base.get("selection", {}).get("strategy") != "random_fallback":
            continue
        duration, stdout = run_command(
            [
                str(args.embedding_python),
                str(args.embedding_runner),
                "associate",
                "--model",
                str(args.embedding_model),
                "--artifacts",
                str(args.embedding_artifacts),
                "--text",
                fixture["input"],
                "--top-k",
                "1",
                "--threads",
                str(args.embedding_threads),
            ]
        )
        elapsed += duration
        raw[fixture["id"]] = json.loads(stdout)
    return raw, elapsed


def total_size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def embedding_referenced_size(model: Path, artifacts: Path) -> int:
    manifest = read_json(artifacts / "manifest.json")
    return sum(
        (model / filename).stat().st_size
        for filename in (manifest["onnx_file"], "tokenizer.json")
    )


def candidate_score(
    baseline: Sequence[dict[str, Any]], results: Sequence[dict[str, Any]]
) -> tuple[int, int, int, int]:
    metrics = summarize(results)
    comparison = compare_to_baseline(baseline, results)
    return (
        metrics["semantic_ok_count"],
        -comparison["regressed"],
        comparison["improved"],
        metrics["association_path_count"],
    )


def parse_ints(value: str) -> list[int]:
    values = unique_strings(value.split(","))
    parsed = [int(item) for item in values]
    if not parsed or any(item < 1 for item in parsed):
        raise ValueError("integer candidate values must be positive")
    return parsed


def parse_floats(value: str) -> list[float]:
    parsed = [float(item) for item in unique_strings(value.split(","))]
    if not parsed:
        raise ValueError("at least one float candidate is required")
    return parsed


def run(args: argparse.Namespace) -> int:
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    all_fixtures = read_json(args.fixtures)
    fixtures = filter_fixtures(all_fixtures, set(unique_strings(args.roles.split(","))))
    if not fixtures:
        raise ValueError("no fixtures match the requested roles")
    fixture_snapshot = output / "fixtures.json"
    write_json(fixture_snapshot, fixtures)

    extracted_path = output / "extracted.json"
    extract_seconds = invoke_go(args, "extract", fixture_snapshot, extracted_path)
    extracted = read_json(extracted_path)

    baseline_path = output / "candidate_A.json"
    baseline_seconds = invoke_go(
        args, "evaluate", fixture_snapshot, baseline_path, candidate="A"
    )
    baseline = annotate_semantic(fixtures, read_json(baseline_path))
    write_json(baseline_path, baseline)

    allowed_pos = set(unique_strings(args.synonym_pos.split(",")))
    limits = parse_ints(args.synonym_limits)
    wordnet_grid: dict[int, dict[str, Any]] = {}
    synonym_connection = sqlite3.connect(f"file:{args.synonym_index}?mode=ro", uri=True)
    try:
        for limit in limits:
            expansions, details = synonym_expansions(
                synonym_connection, extracted, allowed_pos, limit
            )
            expansion_path = output / f"candidate_W_limit_{limit}_expansions.json"
            result_path = output / f"candidate_W_limit_{limit}.json"
            write_json(expansion_path, expansions)
            write_json(output / f"candidate_W_limit_{limit}_details.json", details)
            seconds = invoke_go(
                args,
                "evaluate",
                fixture_snapshot,
                result_path,
                candidate="B",
                expansions_path=expansion_path,
            )
            results = annotate_semantic(fixtures, read_json(result_path))
            for result in results:
                result["candidate"] = "W"
            write_json(result_path, results)
            wordnet_grid[limit] = {
                "results": results,
                "seconds": seconds,
                "metrics": summarize(results),
                "comparison": compare_to_baseline(baseline, results),
            }
    finally:
        synonym_connection.close()
    chosen_limit = max(
        limits,
        key=lambda limit: (*candidate_score(baseline, wordnet_grid[limit]["results"]), -limit),
    )

    embedding_raw, embedding_seconds = run_embedding_fallbacks(args, fixtures, baseline)
    write_json(output / "candidate_E_raw.json", embedding_raw)
    thresholds = parse_floats(args.embedding_thresholds)
    embedding_grid: dict[float, dict[str, Any]] = {}
    for threshold in thresholds:
        results = embedding_fallback_results(fixtures, baseline, embedding_raw, threshold)
        result_path = output / f"candidate_E_threshold_{threshold:g}.json"
        write_json(result_path, results)
        embedding_grid[threshold] = {
            "results": results,
            "metrics": summarize(results),
            "comparison": compare_to_baseline(baseline, results),
        }
    chosen_threshold = max(
        thresholds,
        key=lambda threshold: (
            *candidate_score(baseline, embedding_grid[threshold]["results"]),
            threshold,
        ),
    )

    summary = {
        "fixture_count": len(fixtures),
        "chosen": {
            "wordnet_per_term_limit": chosen_limit,
            "wordnet_part_of_speech": sorted(allowed_pos),
            "embedding_threshold": chosen_threshold,
        },
        "metrics": {
            "A": summarize(baseline),
            "W": wordnet_grid[chosen_limit]["metrics"],
            "E": embedding_grid[chosen_threshold]["metrics"],
        },
        "metrics_by_role": {
            "A": metrics_by_role(fixtures, baseline),
            "W": metrics_by_role(fixtures, wordnet_grid[chosen_limit]["results"]),
            "E": metrics_by_role(fixtures, embedding_grid[chosen_threshold]["results"]),
        },
        "comparison_to_A": {
            "W": wordnet_grid[chosen_limit]["comparison"],
            "E": embedding_grid[chosen_threshold]["comparison"],
        },
        "grid": {
            "W": {
                str(limit): {
                    "metrics": wordnet_grid[limit]["metrics"],
                    "comparison": wordnet_grid[limit]["comparison"],
                }
                for limit in limits
            },
            "E": {
                f"{threshold:g}": {
                    "metrics": embedding_grid[threshold]["metrics"],
                    "comparison": embedding_grid[threshold]["comparison"],
                }
                for threshold in thresholds
            },
        },
        "timing_seconds": {
            "extract": extract_seconds,
            "A": baseline_seconds,
            "W": wordnet_grid[chosen_limit]["seconds"],
            "E_all_fallback_processes": embedding_seconds,
        },
        "dependency_bytes": {
            "concept_index": total_size(args.concept_index),
            "synonym_index": total_size(args.synonym_index),
            "embedding_model_referenced": embedding_referenced_size(
                args.embedding_model, args.embedding_artifacts
            ),
            "embedding_model_directory": total_size(args.embedding_model),
            "embedding_artifacts": total_size(args.embedding_artifacts),
        },
    }
    write_json(output / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--go-binary", type=Path, required=True)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument(
        "--roles",
        default="",
        help="comma-separated fixture roles; empty selects every role",
    )
    parser.add_argument("--lexicon", type=Path, required=True)
    parser.add_argument("--concept-index", type=Path, required=True)
    parser.add_argument("--synonym-index", type=Path, required=True)
    parser.add_argument("--synonym-pos", default="n,v")
    parser.add_argument("--synonym-limits", default="1,3,5,10")
    parser.add_argument("--embedding-python", type=Path, required=True)
    parser.add_argument("--embedding-runner", type=Path, required=True)
    parser.add_argument("--embedding-model", type=Path, required=True)
    parser.add_argument("--embedding-artifacts", type=Path, required=True)
    parser.add_argument("--embedding-thresholds", default="2.0,2.5,3.0,3.5,4.0,4.5,5.0,10.0")
    parser.add_argument("--embedding-threads", type=int, default=2)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main() -> int:
    return run(build_parser().parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
