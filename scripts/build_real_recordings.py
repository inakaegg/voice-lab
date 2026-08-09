#!/usr/bin/env python3
"""選んだ実録音を鳴き声セット用に整えて、出所つきの manifest を書く。

候補集め（fetch_animal_recordings.py）と整音（prepare_animal_recording.py）の結果を
つなぐ最後の一手である。どの候補を採るか・どこを切り出すかの判断は選定ファイル
（JSON）へ書く。判断をコードへ埋め込まないため、選定ファイルは外から渡す。

使い方:
    python3 scripts/build_real_recordings.py <selection.json> <出力ディレクトリ>

selection.json の形:
    {"animals": [{"id": "duck", "label_ja": "アヒル",
                  "candidate": "tmp1/wikimedia/openverse/duck/candidate06.mp3",
                  "start_seconds": 0.6, "end_seconds": 4.6,
                  "reason": "採用理由を人が読める文で書く"}]}

`candidate` と同じディレクトリにある candidates.json から、ライセンス・作者・配布ページ・
取得時のSHA-256を引く。出力ディレクトリには `<id>/<id>-1.wav` と `manifest.json` を書く。
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from prepare_animal_recording import run as prepare


def provenance(candidate_path: Path) -> dict:
    manifest_path = candidate_path.parent / "candidates.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for entry in manifest["candidates"]:
        if entry["file"] == candidate_path.name:
            return entry
    raise KeyError(f"{manifest_path} に {candidate_path.name} の記録がない")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(selection_path: Path, output_dir: Path) -> int:
    selection = json.loads(selection_path.read_text(encoding="utf-8"))
    output_dir.mkdir(parents=True, exist_ok=True)
    animals: list[dict] = []
    settings: dict = {}
    for item in sorted(selection["animals"], key=lambda entry: entry["id"]):
        animal_id = item["id"]
        candidate_path = Path(item["candidate"]).resolve()
        source = provenance(candidate_path)
        # 取得時のhashと今のhashが違う候補は、出所の記録と中身が食い違っている。
        # そのまま進めると manifest へ嘘の source_sha256 を書いてしまうので止める。
        actual = sha256(candidate_path)
        if actual != source["sha256"]:
            raise ValueError(
                f"{candidate_path} の内容が取得時と違う: "
                f"candidates.json={source['sha256']} 実ファイル={actual}"
            )
        destination = output_dir / animal_id / f"{animal_id}-1.wav"
        result = prepare(
            candidate_path,
            destination,
            item.get("start_seconds"),
            item.get("end_seconds"),
        )
        settings = result["settings"]
        animals.append(
            {
                "id": animal_id,
                "label_ja": item["label_ja"],
                "file": f"{animal_id}/{destination.name}",
                "sha256": sha256(destination),
                "duration_seconds": result["duration_seconds"],
                "license": source["license"],
                "creator": source["creator"],
                "source_url": source["landing_url"] or source["download_url"],
                "source_title": source["title"],
                "source_provider": source["provider"],
                "source_download_url": source["download_url"],
                "source_sha256": source["sha256"],
                "trimmed_from_seconds": result["start_seconds"],
                "trimmed_to_seconds": result["end_seconds"],
                "gain_db": result["gain_db"],
                "integrated_lufs": result["integrated_lufs"],
                "true_peak_dbfs": result["true_peak_dbfs"],
                "adopted_reason": item["reason"],
            }
        )
        print(
            f"{animal_id:12} {result['duration_seconds']:5.2f}秒  "
            f"{result['integrated_lufs']:6.1f} LUFS  peak {result['true_peak_dbfs']:5.1f} dBFS  "
            f"{source['license']}"
        )
    manifest = {
        "schema_version": 1,
        "note": "無償で商用利用できる実録音を集めて整えたセット。切り出し位置と採用理由は動物ごとに記録する。",
        "settings": settings,
        "animals": animals,
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"{len(animals)} 種 → {output_dir}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("selection", type=Path)
    parser.add_argument("output_dir", type=Path)
    arguments = parser.parse_args()
    return run(arguments.selection.resolve(), arguments.output_dir.resolve())


if __name__ == "__main__":
    raise SystemExit(main())
