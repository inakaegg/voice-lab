#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from mo_speech.local_asr_comparison_catalog import (
    build_staged_comparison_manifest,
    load_json_object,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "tests" / "fixtures" / "asr_comparison_pair_corpus.json"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="段階評価用の中国語paired ASR corpus fixtureを決定的に生成する。",
    )
    parser.add_argument("--case-count", type=int, default=384)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    manifest = build_staged_comparison_manifest(
        load_json_object(ROOT / "tests" / "fixtures" / "asr_comparison_pair_pilot.json"),
        [
            load_json_object(
                ROOT / "tests" / "fixtures" / "asr_learning_samples_manifest.json"
            ),
            load_json_object(
                ROOT
                / "tests"
                / "fixtures"
                / "asr_learning_samples_manifest_pilot_2.json"
            ),
        ],
        case_count=args.case_count,
    )
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {len(manifest['cases'])} paired cases: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
