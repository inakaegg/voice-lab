#!/usr/bin/env python3
"""tmp1/ の3系統の鳴き声音源から、優先順位に従って最終セットを組み立てる。

優先順位（CONCEPT.md 指示欄）:
  1. processed/ (taira-komori-selected と cc0。どちらも使えるので全ファイル残す)
  2. animal-sounds/
  3. animal-sound-freesound/

同じ動物が上位に既にあれば、下位のものは採用しない。
出力先は tmp1/final/<動物キー>/ と tmp1/final/manifest.json。
"""

from __future__ import annotations

import json
import shutil
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tmp1"
OUT = SRC / "final"

# taira-komori のファイル名は動物キーを直接持たないため対応表を置く。
TAIRA_KEYS = {
    "blue_rock_thrush": "blue-rock-thrush",
    "buzzard": "buzzard",
    "cat": "cat",
    "crow": "crow",
    "dog_barking": "dog",
    "dog": "dog",
    "flamingos_at_zoo": "flamingo",
    "grebe_couple": "little-grebe",
    "little_grebe": "little-grebe",
    "heron": "heron",
    "magpie": "magpie",
    "mallard": "mallard",
    "sparrows": "sparrow",
    "swallows": "swallow",
    "wagtail": "wagtail",
}

LABEL_JA = {
    "black-kite": "トビ",
    "blue-rock-thrush": "イソヒヨドリ",
    "brown-bear": "ヒグマ",
    "bullfrog": "ウシガエル",
    "bush-warbler": "ウグイス",
    "buzzard": "ノスリ",
    "cat": "猫",
    "chimpanzee": "チンパンジー",
    "cow": "牛",
    "cricket": "コオロギ",
    "crow": "カラス",
    "dog": "犬",
    "dolphin": "イルカ",
    "donkey": "ロバ",
    "duck": "アヒル",
    "elephant": "ゾウ",
    "flamingo": "フラミンゴ",
    "fox": "キツネ",
    "frog": "カエル",
    "goat": "ヤギ",
    "goose": "ガチョウ",
    "gorilla": "ゴリラ",
    "heron": "サギ",
    "higurashi": "ヒグラシ",
    "horse": "馬",
    "hyena": "ハイエナ",
    "lion": "ライオン",
    "little-grebe": "カイツブリ",
    "magpie": "カササギ",
    "mallard": "マガモ",
    "minminzemi": "ミンミンゼミ",
    "owl": "フクロウ",
    "peacock": "クジャク",
    "pig": "豚",
    "pigeon": "ハト",
    "rooster": "ニワトリ",
    "sea-lion": "アシカ",
    "seal": "アザラシ",
    "sheep": "羊",
    "sparrow": "スズメ",
    "suzumushi": "スズムシ",
    "swallow": "ツバメ",
    "tiger": "トラ",
    "turkey": "シチメンチョウ",
    "wagtail": "セキレイ",
    "whale": "クジラ",
    "wolf": "オオカミ",
}


def taira_key(stem: str) -> str:
    """cat3b → cat, dog_barking1 → dog のように末尾の連番・枝番を落として動物キーを得る。"""
    base = stem.rstrip("abcdefghijklmnopqrstuvwxyz")
    base = base.rstrip("0123456789")
    base = base.rstrip("_")
    if base in TAIRA_KEYS:
        return TAIRA_KEYS[base]
    if stem in TAIRA_KEYS:
        return TAIRA_KEYS[stem]
    raise KeyError(f"未知の taira ファイル名: {stem}")


def superseded_by_retrim(path: Path) -> bool:
    """30秒の 24k 原音は、人が切り直した *_retrimmed.wav があればそちらに譲る。

    自動トリムが鳴き声本体を切り落としたため 24k 原音を採用していた音源を、
    retrim_long_finals.py で切り直した分。両方を採用しないための判定。
    """
    if not path.name.endswith("_24k.wav"):
        return False
    return path.with_name(path.name.replace("_24k.wav", "_retrimmed.wav")).exists()


def wav_seconds(path: Path) -> float:
    with wave.open(str(path)) as w:
        return round(w.getnframes() / w.getframerate(), 3)


def collect() -> list[dict]:
    """(優先順位, 動物キー, 元ファイル, 出典情報) の候補を優先順に並べて返す。"""
    items: list[dict] = []

    for path in sorted((SRC / "processed" / "taira-komori-selected").glob("*.wav")):
        items.append(
            {
                "priority": 1,
                "key": taira_key(path.stem),
                "path": path,
                "source": "processed/taira-komori-selected",
                "license": "Taira Komori（配布元の利用条件に従う。要出典表記の確認）",
            }
        )

    for path in sorted((SRC / "processed" / "cc0").glob("*.wav")):
        items.append(
            {
                "priority": 1,
                "key": path.stem,
                "path": path,
                "source": "processed/cc0",
                "license": "CC0 1.0",
            }
        )

    for path in sorted((SRC / "animal-sounds").glob("*.wav")):
        items.append(
            {
                "priority": 2,
                "key": path.stem,
                "path": path,
                "source": "animal-sounds",
                "license": "animal-sounds/manifest.json の該当エントリ参照",
            }
        )

    for path in sorted(
        p
        for p in (SRC / "animal-sound-freesound").rglob("*.wav")
        if p.is_file() and not superseded_by_retrim(p)
    ):
        items.append(
            {
                "priority": 3,
                "key": path.parent.name,
                "path": path,
                "source": "animal-sound-freesound",
                "license": "freesound（CC0 または CC BY。trim-manifest.json 参照）",
            }
        )

    items.sort(key=lambda i: (i["priority"], i["key"], i["path"].name))
    return items


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    adopted: dict[str, dict] = {}
    skipped: list[dict] = []

    for item in collect():
        key = item["key"]
        if key in adopted and adopted[key]["priority"] < item["priority"]:
            skipped.append(
                {
                    "animal": key,
                    "file": str(item["path"].relative_to(SRC)),
                    "reason": f"優先順位{adopted[key]['priority']}に同じ動物が採用済み",
                }
            )
            continue
        entry = adopted.setdefault(
            key,
            {
                "id": key,
                "label_ja": LABEL_JA.get(key, ""),
                "priority": item["priority"],
                "files": [],
            },
        )
        dest_dir = OUT / key
        dest_dir.mkdir(exist_ok=True)
        dest = dest_dir / f"{key}-{len(entry['files']) + 1}.wav"
        shutil.copy2(item["path"], dest)
        entry["files"].append(
            {
                "file": f"{key}/{dest.name}",
                "source_file": str(item["path"].relative_to(SRC)),
                "source_set": item["source"],
                "license": item["license"],
                "duration_seconds": wav_seconds(dest),
            }
        )

    animals = [adopted[k] for k in sorted(adopted)]
    manifest = {
        "schema_version": 1,
        "note": (
            "tmp1/ の3系統から優先順位で最終選別したセット。"
            "優先順位1=processed(taira-komori-selected と cc0)、2=animal-sounds、"
            "3=animal-sound-freesound。上位に同じ動物があれば下位は採用しない。"
        ),
        "animal_count": len(animals),
        "file_count": sum(len(a["files"]) for a in animals),
        "animals": animals,
        "skipped": skipped,
    }
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(f"動物 {len(animals)} 種 / ファイル {manifest['file_count']} 個 → {OUT}")
    for a in animals:
        sets = sorted({f["source_set"] for f in a["files"]})
        print(f"  [{a['priority']}] {a['id']:<18} {len(a['files'])}個  {', '.join(sets)}")
    print(f"不採用（上位に同じ動物あり）: {len(skipped)} 件")


if __name__ == "__main__":
    main()
