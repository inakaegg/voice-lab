#!/usr/bin/env python3
"""各辞書を順に引き、入力から動物へ至る連想経路を確認するCLI。

使い方:
  ./tools/rensou_dict.sh "単語または文"
  ./tools/rensou_dict.sh "喉が渇いた" --top-k 3

表示する辞書は次の5つ。上から順が本番想定の優先順でもある。
  1. 動物レキシコン（直接一致）
  2. JMdict擬音語（on-mim）
  3. ConceptNet 1-hop
  4. WordNet同義語 → ConceptNet再照会
  5. Embedding（ruri-v3-70m int8）
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

WORKTREE = Path(__file__).resolve().parent.parent
# リポジトリ外のモデル・辞書資産の置き場所。環境が違う場合はZOOVOICE_MODELS_DIRで上書きする。
MODELS_DIR = Path(os.environ.get("ZOOVOICE_MODELS_DIR", "/Volumes/1T/pj/models/zoovoice"))
GO_BINARY = WORKTREE / "tmp/embedding-pilot/bin/zoovoice"
LEXICON = WORKTREE / "services/zoovoice/assets/animal-lexicon.json"
ONOMATOPOEIA = WORKTREE / "tmp/embedding-trial/onomatopoeia_candidates.json"
CONCEPTNET = MODELS_DIR / "conceptnet-ja-5.7.0-schema2.sqlite"
FULL_GRAPH = MODELS_DIR / "conceptnet-ja-full-graph.sqlite"
SYNONYMS = MODELS_DIR / "wnja-2.0-synonyms.sqlite"
RUNNER_PY = MODELS_DIR / "embedding-trial-venv/bin/python"
RUNNER = WORKTREE / "services/zoovoice/tools/embedding_runner/runner.py"
EMBED_MODEL = MODELS_DIR / "embedding-onnx/ruri-v3-70m"
EMBED_ARTIFACTS = MODELS_DIR / "embedding-artifacts/ruri-70m-int8"

SYNONYM_LIMIT_PER_TERM = 8

HIRAGANA_START, HIRAGANA_END = 0x3041, 0x3096
KATAKANA_OFFSET = 0x60


def to_hiragana(text: str) -> str:
    return "".join(
        chr(ord(ch) - KATAKANA_OFFSET)
        if HIRAGANA_START + KATAKANA_OFFSET <= ord(ch) <= HIRAGANA_END + KATAKANA_OFFSET
        else ch
        for ch in text
    )


def kana_folded_extras(terms: list[str]) -> list[str]:
    """本番エンジンが引かない、かな折りたたみ表記。診断表示専用。"""
    extras = []
    for term in terms:
        folded = to_hiragana(term)
        if folded != term and folded not in terms and folded not in extras:
            extras.append(folded)
    return extras


# 表示用の絵文字。UIアセットの先行版で、判定には使わない。
EMOJI_BY_ID = {
    "cat": "🐱", "chimpanzee": "🐵", "cow": "🐮", "cricket": "🦗", "crow": "🐦‍⬛",
    "dog": "🐶", "dolphin": "🐬", "donkey": "🫏", "duck": "🦆", "elephant": "🐘",
    "fox": "🦊", "frog": "🐸", "goat": "🐐", "goose": "🪿", "horse": "🐴",
    "hyena": "🐺", "lion": "🦁", "owl": "🦉", "peacock": "🦚", "pig": "🐷",
    "rooster": "🐓", "seal": "🦭", "sheep": "🐑", "tiger": "🐯", "turkey": "🦃",
    "whale": "🐳", "wolf": "🐺",
}
EMOJI_BY_KEYWORD = [
    ("白熊", "🐻‍❄️"), ("北極熊", "🐻‍❄️"), ("しろくま", "🐻‍❄️"), ("熊", "🐻"), ("クマ", "🐻"), ("ペンギン", "🐧"),
    ("白鳥", "🦢"), ("ハクチョウ", "🦢"), ("リス", "🐿️"), ("うさぎ", "🐰"), ("ウサギ", "🐰"),
    ("蜂", "🐝"), ("ハチ", "🐝"), ("ミツバチ", "🐝"), ("蚊", "🦟"), ("サル", "🐒"), ("猿", "🐒"),
    ("ヘビ", "🐍"), ("蛇", "🐍"), ("鹿", "🦌"), ("シカ", "🦌"), ("イノシシ", "🐗"),
    ("ネズミ", "🐭"), ("鼠", "🐭"), ("ハト", "🕊️"), ("鳩", "🕊️"), ("スズメ", "🐦"),
    ("カモメ", "🐦"), ("ツバメ", "🐦"), ("魚", "🐟"), ("鳥", "🐦"), ("ヒトデ", "⭐"),
]


def pick_emoji(label: str, animal_id: str | None) -> str:
    if animal_id and animal_id in EMOJI_BY_ID:
        return EMOJI_BY_ID[animal_id]
    for keyword, emoji in EMOJI_BY_KEYWORD:
        if keyword in label:
            return emoji
    return "🐾"


def merge_candidates(candidate_lists: list[list[dict]]) -> list[dict]:
    """全段の候補を統合する。group昇順（=信頼度の高い段が先）、群内はscore降順。"""
    merged: dict[str, dict] = {}
    for candidates in candidate_lists:
        for candidate in candidates:
            existing = merged.get(candidate["label"])
            if existing is None or (candidate["group"], -candidate["score"]) < (
                existing["group"], -existing["score"]
            ):
                merged[candidate["label"]] = candidate
    return sorted(merged.values(), key=lambda c: (c["group"], -c["score"]))


def extract_terms(text: str) -> list[str]:
    """Go本体の抽出器で語を取り出す。抽出ロジックはGoを正とする。"""
    fixture = [{"id": "T1", "role": "local", "kind": "manual", "input": text,
                "expected_strategy": [], "acceptable_animals": []}]
    with tempfile.TemporaryDirectory(prefix="rensou-dict-") as directory:
        root = Path(directory)
        (root / "f.json").write_text(json.dumps(fixture, ensure_ascii=False))
        subprocess.run(
            [str(GO_BINARY), "association-eval", "extract",
             "--fixtures", str(root / "f.json"), "--output", str(root / "e.json")],
            check=True, capture_output=True,
        )
        extracted = json.loads((root / "e.json").read_text())
    terms = extracted[0].get("terms", [])
    return [term for term in dict.fromkeys(terms) if term.strip()]


def load_lexicon() -> list[dict]:
    data = json.loads(LEXICON.read_text())
    return data["animals"]


def tier1_lexicon(text: str, terms: list[str], animals: list[dict]):
    lines = []
    candidates = []
    for animal in animals:
        for word in animal.get("terms", []) + animal.get("onomatopoeia", []):
            if word and word in text:
                kind = "鳴き声" if word in animal.get("onomatopoeia", []) else "名前"
                lines.append(f"「{word}」({kind}) → {animal['label_ja']}")
                candidates.append({
                    "label": animal["label_ja"], "id": animal["id"], "has_audio": True,
                    "group": 1, "score": float(len(word)),
                    "source": f"直接一致「{word}」({kind})",
                })
                break
    return lines, candidates


def tier2_jmdict(text: str, terms: list[str], animals: list[dict]):
    if not ONOMATOPOEIA.exists():
        return ["(JMdict抽出ファイルなし: tools/onomatopoeia/extract.py を先に実行)"], []
    data = json.loads(ONOMATOPOEIA.read_text())
    by_variant: dict[str, dict] = {}
    for entry in data["entries"]:
        for variant in entry["variants"]:
            by_variant.setdefault(variant, entry)
    animal_ids = {animal["id"]: animal["label_ja"] for animal in animals}

    # 第1段と同じく入力文への部分一致で引く。抽出語との完全一致だけだと
    # 「にゃーにゃー鳴いてる…」の「にゃーにゃー」を取りこぼす。
    hits: list[tuple[str, dict]] = []
    seen_entries: set[int] = set()
    for variant, entry in by_variant.items():
        if len(variant) < 2 or variant not in text:
            continue
        if id(entry) in seen_entries:
            continue
        seen_entries.add(id(entry))
        hits.append((variant, entry))
    hits.sort(key=lambda item: -len(item[0]))

    lines = []
    candidates = []
    for variant, entry in hits[:5]:
        glosses = entry["glosses"][:3]
        matched = [
            (animal_id, label) for animal_id, label in animal_ids.items()
            if any(animal_id in gloss.lower() for gloss in entry["glosses"])
        ]
        labels = [label for _id, label in matched]
        suffix = f" → 動物候補: {'・'.join(labels)}" if matched else "（概念対応表は未生成）"
        lines.append(f"「{variant}」 = {' / '.join(glosses)}{suffix}")
        for animal_id, label in matched:
            candidates.append({
                "label": label, "id": animal_id, "has_audio": True,
                "group": 2, "score": float(len(variant)),
                "source": f"JMdict「{variant}」= {glosses[0]}",
            })
    return lines, candidates


# 生物カテゴリ名。この下位（IsA）にある概念を「名前のみの動物」とみなす機械規則。
ANIMAL_CATEGORY_SEEDS = [
    "動物", "哺乳類", "鳥", "鳥類", "昆虫", "魚", "爬虫類", "両生類", "けもの", "家畜", "ペット",
]
NEIGHBOR_LIMIT = 30
FRONTIER_LIMIT = 300
# 意味が反転・否定される関係は連想に使わない（冬→夏→セミのような裏返りを防ぐ）。
EXCLUDED_RELATIONS = ("Antonym", "DistinctFrom", "NotDesires", "NotCapableOf", "NotHasProperty")


def load_animal_targets(graph, animals: list[dict]) -> dict[str, tuple[str, bool]]:
    """概念表記 → (表示名, 音源あり) の対応。lexicon27種 + IsA動物系の機械抽出。"""
    targets: dict[str, tuple[str, bool]] = {}
    placeholders = ",".join("?" * len(ANIMAL_CATEGORY_SEEDS))
    rows = graph.execute(
        f"SELECT DISTINCT start FROM edges WHERE relation='IsA' AND end IN ({placeholders})",
        ANIMAL_CATEGORY_SEEDS,
    ).fetchall()
    # 自身がIsAの親（10件以上の下位語を持つ）ならカテゴリ語とみなし、動物個体として扱わない。
    category_rows = graph.execute(
        "SELECT end FROM edges WHERE relation='IsA' GROUP BY end HAVING COUNT(*) >= 10"
    ).fetchall()
    categories = {row[0] for row in category_rows} | set(ANIMAL_CATEGORY_SEEDS)
    for (concept,) in rows:
        if concept in categories:
            continue
        targets[concept] = (concept, False)
    for animal in animals:
        spellings = animal.get("terms", []) + animal.get("onomatopoeia", []) + [animal["label_ja"]]
        for spelling in spellings:
            if spelling:
                targets[spelling] = (animal["label_ja"], True)
    return targets


def multihop_search(
    graph, start_terms: list[str], targets: dict[str, tuple[str, bool]], max_hops: int
) -> list[dict]:
    """全jaグラフを両方向にたどり、動物へ届く経路を探す。hop昇順・経路の最小重み降順。"""
    frontier: list[tuple[str, list[str], float]] = [
        (term, [f"「{term}」"], float("inf")) for term in dict.fromkeys(start_terms) if term
    ]
    visited = {term for term, _, _ in frontier}
    found: dict[str, dict] = {}

    for hop in range(1, max_hops + 1):
        next_frontier: list[tuple[str, list[str], float]] = []
        for node, path, strength in frontier:
            excluded = ",".join(f"'{name}'" for name in EXCLUDED_RELATIONS)
            rows = graph.execute(
                f"SELECT end, relation, weight, 0 FROM edges WHERE start=? "
                f"AND relation NOT IN ({excluded}) "
                f"UNION ALL "
                f"SELECT start, relation, weight, 1 FROM edges WHERE end=? "
                f"AND relation NOT IN ({excluded}) "
                f"ORDER BY weight DESC LIMIT ?",
                (node, node, NEIGHBOR_LIMIT),
            ).fetchall()
            for neighbor, relation, weight, reversed_flag in rows:
                arrow = f"←[{relation}]-" if reversed_flag else f"-[{relation}]→"
                new_path = path + [f"{arrow}「{neighbor}」"]
                new_strength = min(strength, weight)
                target = targets.get(neighbor)
                if target is not None:
                    label, has_audio = target
                    existing = found.get(label)
                    candidate = {
                        "label": label, "has_audio": has_audio, "hop": hop,
                        "strength": new_strength, "path": " ".join(new_path),
                    }
                    if existing is None or (hop, -new_strength) < (
                        existing["hop"], -existing["strength"]
                    ):
                        found[label] = candidate
                if neighbor not in visited:
                    visited.add(neighbor)
                    next_frontier.append((neighbor, new_path, new_strength))
        next_frontier.sort(key=lambda item: -item[2])
        frontier = next_frontier[:FRONTIER_LIMIT]
        if not frontier:
            break
    results = sorted(found.values(), key=lambda item: (item["hop"], -item["strength"]))
    return results


def tier3_multihop(terms: list[str], animals: list[dict], max_hops: int):
    graph_path = Path(FULL_GRAPH)
    if not graph_path.exists():
        return [f"(全jaグラフ未構築: tools/build_ja_graph.py を先に実行 → {FULL_GRAPH})"], []
    graph = sqlite3.connect(f"file:{FULL_GRAPH}?mode=ro", uri=True)
    targets = load_animal_targets(graph, animals)
    query_terms = list(dict.fromkeys(terms + kana_folded_extras(terms)))
    results = multihop_search(graph, query_terms, targets, max_hops)
    graph.close()

    id_by_label = {animal["label_ja"]: animal["id"] for animal in animals}
    lines = []
    candidates = []
    for item in results[:15]:
        audio_mark = "♪" if item["has_audio"] else "（名前のみ）"
        lines.append(
            f"hop{item['hop']} {item['label']}{audio_mark}  {item['path']}  最小重み{item['strength']:.2f}"
        )
    for item in results:
        candidates.append({
            "label": item["label"], "id": id_by_label.get(item["label"]),
            "has_audio": item["has_audio"], "group": 2 + item["hop"],
            "score": item["strength"], "source": f"ConceptNet hop{item['hop']}: {item['path']}",
        })
    if len(results) > 15:
        lines.append(f"…ほか{len(results) - 15}件")
    return lines, candidates


def query_edges(connection, terms: list[str], limit: int = 10):
    if not terms:
        return []
    placeholders = ",".join("?" * len(terms))
    return connection.execute(
        f"SELECT concept, animal_id, relation, weight FROM edges "
        f"WHERE concept IN ({placeholders}) ORDER BY weight DESC LIMIT {int(limit)}",
        terms,
    ).fetchall()


def tier3_conceptnet(terms: list[str], animals: list[dict]) -> list[str]:
    labels = {animal["id"]: animal["label_ja"] for animal in animals}
    connection = sqlite3.connect(f"file:{CONCEPTNET}?mode=ro", uri=True)
    lines = []
    for concept, animal_id, relation, weight in query_edges(connection, terms):
        label = labels.get(animal_id, animal_id)
        lines.append(f"「{concept}」 -[{relation} 重み{weight:.2f}]→ {label}")
    # 診断: かな折りたたみなら一致した表記（本番エンジンは引かない）
    for concept, animal_id, relation, weight in query_edges(
        connection, kana_folded_extras(terms)
    ):
        label = labels.get(animal_id, animal_id)
        lines.append(
            f"「{concept}」 -[{relation} 重み{weight:.2f}]→ {label} ※かな変換で一致（本番未対応）"
        )
    connection.close()
    return lines


def tier4_wordnet(terms: list[str], animals: list[dict]):
    labels = {animal["id"]: animal["label_ja"] for animal in animals}
    synonym_db = sqlite3.connect(f"file:{SYNONYMS}?mode=ro", uri=True)
    concept_db = sqlite3.connect(f"file:{CONCEPTNET}?mode=ro", uri=True)
    lines = []
    candidates = []
    for term in terms:
        synonyms = [row[0] for row in synonym_db.execute(
            "SELECT DISTINCT synonym FROM synonyms WHERE term=? "
            "AND part_of_speech IN ('n','v') LIMIT ?",
            (term, SYNONYM_LIMIT_PER_TERM),
        ).fetchall()]
        if not synonyms:
            continue
        placeholders = ",".join("?" * len(synonyms))
        rows = concept_db.execute(
            f"SELECT concept, animal_id, relation, weight FROM edges "
            f"WHERE concept IN ({placeholders}) ORDER BY weight DESC LIMIT 5",
            synonyms,
        ).fetchall()
        shown_synonyms = "・".join(synonyms[:5])
        if rows:
            for concept, animal_id, relation, weight in rows[:3]:
                label = labels.get(animal_id, animal_id)
                lines.append(
                    f"「{term}」→(同義語)→「{concept}」 -[{relation} 重み{weight:.2f}]→ {label}"
                )
                candidates.append({
                    "label": label, "id": animal_id, "has_audio": True,
                    "group": 6, "score": weight,
                    "source": f"WordNet「{term}」→「{concept}」-[{relation}]",
                })
        else:
            lines.append(f"「{term}」→(同義語: {shown_synonyms})→ ConceptNet一致なし")
    synonym_db.close()
    concept_db.close()
    return lines, candidates


def tier5_embedding(text: str, top_k: int):
    completed = subprocess.run(
        [RUNNER_PY, str(RUNNER), "associate", "--model", EMBED_MODEL,
         "--artifacts", EMBED_ARTIFACTS, "--text", text, "--top-k", str(top_k)],
        capture_output=True, text=True,
    )
    if completed.returncode != 0:
        message = completed.stderr.strip().splitlines()[-1] if completed.stderr else "不明"
        return [f"(runner失敗: {message})"], []
    payload = json.loads(completed.stdout)
    lines = [
        f"{candidate['rank']}. {candidate['label_ja']}  score {candidate['score']:.2f}"
        for candidate in payload["candidates"]
    ]
    candidates = [
        {
            "label": candidate["label_ja"], "id": candidate["id"], "has_audio": True,
            "group": 7, "score": candidate["score"],
            "source": f"Embedding score {candidate['score']:.2f}",
        }
        for candidate in payload["candidates"]
    ]
    return lines, candidates


def first_animal_line(lines: list[str]) -> str | None:
    for line in lines:
        if "※かな変換" in line:
            continue
        if "→" in line and "一致なし" not in line and "未生成" not in line:
            return line
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("text")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--hops", type=int, default=2, choices=(1, 2, 3),
                        help="ConceptNet探索のhop数（既定2）")
    args = parser.parse_args()
    text = args.text.strip()
    if not text:
        print("入力が空です", file=sys.stderr)
        return 1

    animals = load_lexicon()
    terms = extract_terms(text)
    print(f"入力: {text}")
    print(f"抽出語: {'・'.join(terms) if terms else '(なし)'}")

    sections = [
        ("1. 動物レキシコン（直接一致）", *tier1_lexicon(text, terms, animals)),
        ("2. JMdict擬音語（on-mim）", *tier2_jmdict(text, terms, animals)),
        (f"3. ConceptNet 多hop探索（hop≤{args.hops}・全jaグラフ。本番は1-hop・27種限定）",
         *tier3_multihop(terms, animals, args.hops)),
        ("4. WordNet同義語 → ConceptNet再照会", *tier4_wordnet(terms, animals)),
        ("5. Embedding（ruri-v3-70m int8・偏り補正）", *tier5_embedding(text, args.top_k)),
    ]
    for title, lines, _candidates in sections:
        print(f"\n■ {title}")
        if lines:
            for line in lines:
                print(f"   {line}")
        else:
            print("   一致なし")

    unified = merge_candidates([candidates for _t, _l, candidates in sections])
    print("\n■ 統合候補リスト（新UI案のCLI版。信頼群→群内スコアの優先順。×=音源なし）")
    if not unified:
        print("   ハズレ（どの辞書でも動物へ到達できず）")
        return 0
    icon_row = " ".join(
        pick_emoji(c["label"], c["id"]) + ("" if c["has_audio"] else "×") for c in unified[:12]
    )
    print(f"   {icon_row}")
    for rank, candidate in enumerate(unified[:12], start=1):
        emoji = pick_emoji(candidate["label"], candidate["id"])
        audio = "♪" if candidate["has_audio"] else "（名前のみ）"
        source = candidate["source"]
        if len(source) > 58:
            source = source[:57] + "…"
        print(f"   {rank:>2}. {emoji} {candidate['label']}{audio}  ← {source}")
    if len(unified) > 12:
        print(f"   …ほか{len(unified) - 12}件")

    playable = [c for c in unified if c["has_audio"]]
    print("\n■ 合成対象")
    top = unified[0]
    if top["has_audio"]:
        primary = top
        print(f"   1位 {pick_emoji(top['label'], top['id'])} {top['label']} の鳴き声で合成")
    elif playable:
        primary = playable[0]
        print(f"   1位 {top['label']} は音源なし → 名前を表示し、"
              f"音声は次順の {pick_emoji(primary['label'], primary['id'])} {primary['label']} で合成（案）")
    else:
        primary = None
        print("   音源を持つ候補なし → ハズレ演出")
    if primary is not None:
        second = next((c for c in playable if c["label"] != primary["label"]), None)
        if second is not None:
            print(f"   2位（オプション） {pick_emoji(second['label'], second['id'])} {second['label']}")
    print("   ※クリックで指定動物により再合成する案。CLIでは表示のみ")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
