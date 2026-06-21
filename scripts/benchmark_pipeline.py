from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from tempfile import NamedTemporaryFile

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from mo_speech.api import create_demo_pipeline, create_local_pipeline
from mo_speech.benchmark import run_benchmark
from mo_speech.pipeline import PipelineRequest, SpeechTranslationPipeline


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark the speech translation pipeline.")
    parser.add_argument("--provider-mode", choices=["fake", "local"], default=os.getenv("MO_PROVIDER_MODE", "fake"))
    parser.add_argument("--audio", type=Path)
    parser.add_argument("--source-language", default="ja-JP")
    parser.add_argument("--target-language", default="zh-CN")
    parser.add_argument("--voice-mode", default="default")
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--fresh-pipeline-per-run", action="store_true")
    parser.add_argument("--text-transform")
    parser.add_argument("--text-transform-suffix")
    parser.add_argument("--text-transform-unit", default="text")
    args = parser.parse_args()

    with _audio_path(args.audio) as audio_path:
        request = PipelineRequest(
            audio_path=audio_path,
            source_language=args.source_language,
            target_language=args.target_language,
            voice_mode=args.voice_mode,
            text_transform=args.text_transform,
            text_transform_options=_text_transform_options(args),
        )
        runs = run_benchmark(
            _pipeline_factory(args.provider_mode),
            request,
            repeat=args.repeat,
            fresh_pipeline_per_run=args.fresh_pipeline_per_run,
        )

    print(
        json.dumps(
            {
                "provider_mode": args.provider_mode,
                "source_language": args.source_language,
                "target_language": args.target_language,
                "voice_mode": args.voice_mode,
                "fresh_pipeline_per_run": args.fresh_pipeline_per_run,
                "runs": [run.to_dict() for run in runs],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def _pipeline_factory(provider_mode: str):
    def create_pipeline() -> SpeechTranslationPipeline:
        if provider_mode == "local":
            return create_local_pipeline()
        return create_demo_pipeline()

    return create_pipeline


def _text_transform_options(args: argparse.Namespace) -> dict[str, str]:
    options: dict[str, str] = {}
    if args.text_transform_suffix is not None:
        options["suffix"] = args.text_transform_suffix
    if args.text_transform_unit:
        options["unit"] = args.text_transform_unit
    return options


class _audio_path:
    def __init__(self, audio_path: Path | None) -> None:
        self.audio_path = audio_path
        self.temp_file: NamedTemporaryFile[bytes] | None = None

    def __enter__(self) -> Path:
        if self.audio_path is not None:
            return self.audio_path
        self.temp_file = NamedTemporaryFile(suffix=".wav")
        self.temp_file.write(b"fake audio")
        self.temp_file.flush()
        return Path(self.temp_file.name)

    def __exit__(self, *args: object) -> None:
        if self.temp_file is not None:
            self.temp_file.close()


if __name__ == "__main__":
    main()
