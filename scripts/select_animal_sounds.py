#!/usr/bin/env python3
"""tmp1/ の鳴き声音源から、優先順位に従って最終セットを組み立てる。

優先順位（CONCEPT.md 指示欄「自然音声優先」）:
  1. processed/ (taira-komori-selected と cc0。どちらも実録音で、全ファイル残す)
     と real-recordings/ (声の主を1本ずつ確かめた実録音)
  2. animal-sound-freesound/ (実録音)

すべて実録音である。同じ動物が上位に既にあれば、下位のものは採用しない。
出力先は tmp1/final/<動物キー>/ と tmp1/final/manifest.json。
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tmp1"
OUT = SRC / "final"

# taira-komori は素材セット単位の出典（配布zip同梱の read me.txt と
# THIRD_PARTY_NOTICES.md「zoovoiceの鳴き声音源」を正とする）。
TAIRA_CREDIT = {
    "license": "Taira Komori 利用規約（商用・加工可、素材そのものの再配布・販売・直リンク禁止）",
    "creator": "小森平（Taira Komori）",
    "source_url": "https://taira-komori.net/",
}

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


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_cc0_credits() -> dict[str, dict]:
    """processed/cc0 の取得記録（Openverse経由freesound）を動物キーで引く。"""
    credits: dict[str, dict] = {}
    with (SRC / "processed" / "cc0-manifest.jsonl").open(encoding="utf-8") as f:
        for line in f:
            entry = json.loads(line)
            credits[entry["animal"]] = {
                "license": "CC0 1.0" if entry["license"] == "cc0" else entry["license"],
                "creator": entry["creator"],
                "source_url": entry["landing_url"],
            }
    return credits


def load_real_recording_credits() -> dict[str, dict]:
    """real-recordings/manifest.json（Wikimedia CommonsとOpenverse由来の実録音）を動物キーで引く。"""
    manifest = json.loads((SRC / "real-recordings" / "manifest.json").read_text(encoding="utf-8"))
    return {
        entry["id"]: {
            "license": entry["license"],
            "creator": entry["creator"],
            "source_url": entry["source_url"],
        }
        for entry in manifest["animals"]
    }


def load_freesound_credits() -> dict[tuple[str, int], dict]:
    """trim-manifest.json を (動物キー, candidate番号) で引く。"""
    manifest = json.loads(
        (SRC / "animal-sound-freesound" / "trim-manifest.json").read_text(encoding="utf-8")
    )
    credits: dict[tuple[str, int], dict] = {}
    for key, species in manifest["species"].items():
        for candidate in species["candidates"]:
            credits[(key, candidate["candidate"])] = {
                "license": candidate["license"],
                "creator": candidate["creator"],
                "source_url": candidate["landing_url"],
            }
    return credits


def freesound_candidate_number(path: Path) -> int:
    match = re.match(r"candidate(\d+)_", path.name)
    if not match:
        raise KeyError(f"candidate番号を持たない freesound ファイル名: {path}")
    return int(match.group(1))


def collect() -> list[dict]:
    """(優先順位, 動物キー, 元ファイル, 出典情報) の候補を優先順に並べて返す。"""
    items: list[dict] = []
    cc0_credits = load_cc0_credits()
    real_recording_credits = load_real_recording_credits()
    freesound_credits = load_freesound_credits()

    for path in sorted((SRC / "processed" / "taira-komori-selected").glob("*.wav")):
        items.append(
            {
                "priority": 1,
                "key": taira_key(path.stem),
                "path": path,
                "source": "processed/taira-komori-selected",
                "credit": TAIRA_CREDIT,
            }
        )

    for path in sorted((SRC / "processed" / "cc0").glob("*.wav")):
        items.append(
            {
                "priority": 1,
                "key": path.stem,
                "path": path,
                "source": "processed/cc0",
                "credit": cc0_credits[path.stem],
            }
        )

    for path in sorted((SRC / "real-recordings").glob("*/*.wav")):
        items.append(
            {
                "priority": 1,
                "key": path.parent.name,
                "path": path,
                "source": "real-recordings",
                "credit": real_recording_credits[path.parent.name],
            }
        )

    for path in sorted(
        p
        for p in (SRC / "animal-sound-freesound").rglob("*.wav")
        if p.is_file() and not superseded_by_retrim(p)
    ):
        items.append(
            {
                "priority": 2,
                "key": path.parent.name,
                "path": path,
                "source": "animal-sound-freesound",
                "credit": freesound_credits[(path.parent.name, freesound_candidate_number(path))],
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
                "license": item["credit"]["license"],
                "creator": item["credit"]["creator"],
                "source_url": item["credit"]["source_url"],
                "sha256": file_sha256(dest),
                "duration_seconds": wav_seconds(dest),
            }
        )

    animals = [adopted[k] for k in sorted(adopted)]
    manifest = {
        "schema_version": 1,
        "note": (
            "tmp1/ の各系統から優先順位で最終選別したセット。すべて実録音である。"
            "優先順位1=processed(taira-komori-selected と cc0) と real-recordings、"
            "2=animal-sound-freesound。"
            "上位に同じ動物があれば下位は採用しない。"
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
