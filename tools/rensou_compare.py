#!/usr/bin/env python3
"""ConceptNet方式とEmbedding方式を同じ入力で実行し、連想経緯つきで並べて表示する。

提案構成（ConceptNetが経路を出せばそれを使い、出せなければEmbeddingへ回す）の
最終回答も表示する。どちらが優れているかを入力ごとに判断する材料にする。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

WORKTREE = Path(__file__).resolve().parent.parent
# リポジトリ外のモデル・辞書資産の置き場所。環境が違う場合はZOOVOICE_MODELS_DIRで上書きする。
MODELS_DIR = Path(os.environ.get("ZOOVOICE_MODELS_DIR", "/Volumes/1T/pj/models/zoovoice"))
PILOT_PY = MODELS_DIR / "embedding-pilot-venv/bin/python"
RUNNER_PY = MODELS_DIR / "embedding-trial-venv/bin/python"
GO_BINARY = WORKTREE / "tmp/embedding-pilot/bin/zoovoice"
LEXICON = WORKTREE / "services/zoovoice/assets/animal-lexicon.json"
INDEX = MODELS_DIR / "conceptnet-ja-5.7.0-schema2.sqlite"
MODEL = MODELS_DIR / "embedding-onnx/ruri-v3-70m"
ARTIFACTS = MODELS_DIR / "embedding-artifacts/ruri-70m-int8"

STRATEGY_LABELS = {
    "direct": "直接言及",
    "pun": "同音語",
    "conceptnet": "ConceptNet連想",
    "random_fallback": "連想できず（ランダム）",
    "embedding_profile": "意味ベクトル連想",
}


def run_conceptnet(text: str) -> dict:
    completed = subprocess.run(
        [
            PILOT_PY,
            str(WORKTREE / "services/zoovoice/tools/embedding_pilot/pilot.py"),
            "associate",
            "--method", "conceptnet",
            "--text", text,
            "--go-binary", str(GO_BINARY),
            "--lexicon", str(LEXICON),
            "--index", INDEX,
            "--output", "-",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(completed.stdout)


def run_embedding(text: str, top_k: int) -> dict:
    completed = subprocess.run(
        [
            RUNNER_PY,
            str(WORKTREE / "services/zoovoice/tools/embedding_runner/runner.py"),
            "associate",
            "--model", MODEL,
            "--artifacts", ARTIFACTS,
            "--text", text,
            "--top-k", str(top_k),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(completed.stdout)


def describe_conceptnet(result: dict) -> tuple[str, list[str]]:
    association = result["association"]
    strategy = association["strategy"]
    animal = result["selected_animal"]["label_ja"]
    lines: list[str] = []
    if strategy in ("direct", "pun"):
        lines.append(f"経緯: 入力中の「{association.get('evidence_term')}」が動物へ{STRATEGY_LABELS[strategy]}")
    elif strategy == "conceptnet":
        score = association.get("score") or {}
        for item in score.get("contributions", []):
            lines.append(
                f"経緯: 「{item['concept']}」 -[{item['relation']} 重み{item['weight']}]-> {animal}"
            )
        if not lines:
            lines.append(f"経緯: 「{association.get('evidence_term')}」から{animal}へ連想")
    else:
        lines.append("経緯: 語彙・ConceptNetのどちらにも一致が無く、ランダムに選択")
    return strategy, lines


def main() -> int:
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        print(f"使い方: {sys.argv[0]} \"日本語の文\"", file=sys.stderr)
        return 1
    text = sys.argv[1]
    top_k = int(sys.argv[2]) if len(sys.argv) > 2 else 5

    conceptnet = run_conceptnet(text)
    embedding = run_embedding(text, top_k)

    print(f"入力: {text}")
    print()

    strategy, path_lines = describe_conceptnet(conceptnet)
    print(f"■ 現行方式（直接一致 → ConceptNet）: {conceptnet['selected_animal']['label_ja']}"
          f"  [{STRATEGY_LABELS.get(strategy, strategy)}]")
    for line in path_lines:
        print(f"   {line}")
    print()

    selected = embedding["selected_animal"]
    print(f"■ Embedding方式（ruri-v3-70m int8・文全体・偏り補正）: {selected['label_ja']}")
    print(f"   経緯: 文全体の意味ベクトルと各動物の語彙profileの類似度で順位付け")
    for candidate in embedding["candidates"]:
        print(f"   {candidate['rank']}. {candidate['label_ja']:<8} score {candidate['score']:.2f}")
    print()

    if strategy == "random_fallback":
        final = selected["label_ja"]
        reason = "現行方式が連想できなかったため、Embeddingの1位を採用"
    else:
        final = conceptnet["selected_animal"]["label_ja"]
        reason = f"現行方式が{STRATEGY_LABELS.get(strategy, strategy)}で経路を出せたため、そちらを優先"
    print(f"■ 提案構成（現行 → 失敗時だけEmbedding）の答え: {final}")
    print(f"   {reason}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
