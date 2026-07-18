#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
from pathlib import Path

from mo_speech.local_asr_corpus import generate_corpus, transcribe_corpus


DEFAULT_MANIFEST = Path("tests/fixtures/asr_learning_samples_manifest.json")
DEFAULT_OUTPUT_DIR = Path("tmp/asr-learning-samples")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Apple TTSで学習者向けASR corpusを生成し、ローカルASRで比較する。",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    generate = subparsers.add_parser("generate", help="Apple TTS音声を生成する。")
    _add_common_paths(generate)

    transcribe = subparsers.add_parser(
        "transcribe",
        help="生成済み音声をfaster-whisperとFunASRで文字起こしする。",
    )
    _add_common_paths(transcribe)
    _add_model_options(transcribe)

    run_all = subparsers.add_parser("all", help="音声生成と文字起こしを続けて実行する。")
    _add_common_paths(run_all)
    _add_model_options(run_all)

    args = parser.parse_args()
    manifest = args.manifest.resolve()
    output_dir = args.output_dir.resolve()

    if args.command in {"generate", "all"}:
        generation = generate_corpus(manifest, output_dir)
        print(f"generated {len(generation['cases'])} cases: {output_dir / 'generation.json'}")

    if args.command in {"transcribe", "all"}:
        cache_dir = _resolve_model_cache_dir(args.model_cache_dir)
        result = transcribe_corpus(
            manifest,
            output_dir,
            model_cache_dir=cache_dir,
            whisper_model=args.whisper_model,
        )
        print(f"transcribed {len(result['cases'])} cases: {output_dir / 'transcriptions.json'}")
        print(result["summary"])
    return 0


def _add_common_paths(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)


def _add_model_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--model-cache-dir",
        type=Path,
        help="モデルcacheのroot。未指定時はMODEL_CACHE_DIRを使う。",
    )
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
