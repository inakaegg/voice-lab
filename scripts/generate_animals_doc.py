#!/usr/bin/env python3
"""鳴き声セットの manifest.json から CONCEPTS/ZOOVOICE/ANIMALS.md を作り直す。

対象動物の正本は実際の音声ファイルであり、この文書は音声ファイルの一覧を
人が読める形に写したものである。人が手で編集しない。

使い方:
    python3 scripts/generate_animals_doc.py <sounds-dir> [--check]

--check を付けると書き換えず、内容が一致しないときだけ終了コード1を返す。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
DOCUMENT_PATH = REPOSITORY_ROOT / "CONCEPTS" / "ZOOVOICE" / "ANIMALS.md"


def render(manifest: dict) -> str:
    animals = sorted(manifest["animals"], key=lambda animal: animal["id"])
    file_count = sum(len(animal["files"]) for animal in animals)
    licenses: dict[str, int] = {}
    for animal in animals:
        for entry in animal["files"]:
            name = entry["license"].split("（", 1)[0].strip()
            licenses[name] = licenses.get(name, 0) + 1

    lines = [
        "<!-- 自動生成ファイル。手で書き換えない。"
        " 作り直し: python3 scripts/generate_animals_doc.py <sounds-dir> -->",
        "",
        f"# Zoovoice の対象動物（{len(animals)}種）",
        "",
        "**この文書は自動生成である。手で書き換えないこと。**",
        "内容を直すときは鳴き声セットの `manifest.json` を直し、",
        "`python3 scripts/generate_animals_doc.py <sounds-dir>` で作り直す。",
        "",
        "この一覧の正本は実際の音声ファイルである。音源のある動物だけが連想の候補になるので、",
        "動物を増やしたり減らしたりするときは音声ファイルの側を変え、この文書を作り直す。",
        "",
        f"音声ファイルは全部で{file_count}本ある。1種に複数本ある動物は、合成のたびにその中から選ばれる。",
        "",
        "## 一覧",
        "",
        "| 動物 | id | 音声の本数 |",
        "| --- | --- | --- |",
    ]
    for animal in animals:
        lines.append(f"| {animal['label_ja']} | `{animal['id']}` | {len(animal['files'])} |")

    lines += ["", "## 音声の出どころ", ""]
    for name, count in sorted(licenses.items(), key=lambda item: (-item[1], item[0])):
        lines.append(f"- {name}: {count}本")
    lines += [
        "",
        "出どころと採用した音声の SHA-256 は `manifest.json` に1本ずつ記録してある。",
        "素材そのものはリポジトリへ置かず、container image を作るときだけ取り込む。",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sounds_dir", type=Path, help="manifest.json のある鳴き声ディレクトリ")
    parser.add_argument("--check", action="store_true", help="書き換えず内容の一致だけ確かめる")
    arguments = parser.parse_args()

    manifest_path = arguments.sounds_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    document = render(manifest)

    if arguments.check:
        current = DOCUMENT_PATH.read_text(encoding="utf-8") if DOCUMENT_PATH.exists() else ""
        if current != document:
            print(f"{DOCUMENT_PATH} is stale; regenerate it from {manifest_path}", file=sys.stderr)
            return 1
        return 0

    DOCUMENT_PATH.write_text(document, encoding="utf-8")
    print(f"wrote {DOCUMENT_PATH} from {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
