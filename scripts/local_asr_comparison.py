#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
from pathlib import Path

from mo_speech.local_asr_comparison import (
    evaluate_comparison_pairs,
    generate_comparison_pairs,
)


DEFAULT_MANIFEST = Path("tests/fixtures/asr_comparison_pair_pilot.json")
DEFAULT_OUTPUT_DIR = Path("tmp/asr-comparison-pair-pilot")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="正しいお手本と誤りを含む復唱を比較再生処理まで評価する。",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    generate = subparsers.add_parser("generate", help="paired音声を生成する。")
    _add_common_paths(generate)

    evaluate = subparsers.add_parser(
        "evaluate",
        help="両音声をASRからcanonical alignmentとUI playback planまで評価する。",
    )
    _add_common_paths(evaluate)
    _add_model_options(evaluate)

    run_all = subparsers.add_parser("all", help="音声生成とend-to-end評価を続けて実行する。")
    _add_common_paths(run_all)
    _add_model_options(run_all)

    args = parser.parse_args()
    manifest = args.manifest.resolve()
    output_dir = args.output_dir.resolve()
    if args.command in {"generate", "all"}:
        generation = generate_comparison_pairs(
            manifest,
            output_dir,
            case_limit=args.case_limit,
        )
        print(
            f"generated {len(generation['cases'])} paired cases: "
            f"{output_dir / 'generation.json'}"
        )
    if args.command in {"evaluate", "all"}:
        result = evaluate_comparison_pairs(
            manifest,
            output_dir,
            model_cache_dir=_resolve_model_cache_dir(args.model_cache_dir),
            whisper_model=args.whisper_model,
            case_limit=args.case_limit,
            project_root=Path(__file__).resolve().parents[1],
        )
        print(
            f"evaluated {len(result['cases'])} paired cases: "
            f"{output_dir / 'comparison-results.json'}"
        )
        print(result["summary"])
    return 0


def _add_common_paths(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--case-limit", type=int)


def _add_model_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--model-cache-dir", type=Path)
    parser.add_argument("--whisper-model", default="turbo")


def _resolve_model_cache_dir(argument: Path | None) -> Path:
    if argument is not None:
        return argument.expanduser().resolve()
    configured = os.getenv("MODEL_CACHE_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    raise SystemExit("--model-cache-dirまたはMODEL_CACHE_DIRが必要です。")


if __name__ == "__main__":
    raise SystemExit(main())
