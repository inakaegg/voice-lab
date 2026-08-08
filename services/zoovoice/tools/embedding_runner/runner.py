#!/usr/bin/env python3
"""Goサービスからsubprocessとして呼ばれる連想runner。

whisper-cliと同じく1リクエスト1プロセスで起動し、標準出力へJSONを1件返す。
PyTorchやsentence-transformersへは依存せず、onnxruntimeとtokenizersだけで動く。

使い方:
  runner.py precompute --model DIR --lexicon FILE --output DIR
  runner.py associate  --model DIR --artifacts DIR --text TEXT
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any, Sequence

import numpy as np

ARTIFACT_VERSION = 2
BIAS_STD_FLOOR = "median_background_std"
# 動物と無関係な日本語文。各動物の「どの入力でも高く出る」度合いを測る基準に使う。
BACKGROUND_SENTENCES: tuple[str, ...] = (
    "今日は朝から会議が続いている",
    "駅前の書店で新しい雑誌を買った",
    "この資料は明日までに提出する必要がある",
    "週末は部屋の掃除をするつもりだ",
    "新しいアプリの使い方がよく分からない",
    "電車が遅れて約束の時間に間に合わなかった",
    "コーヒーを飲みながら本を読んでいた",
    "来月から料金が値上がりするらしい",
    "友人と映画を見に行く約束をした",
    "パソコンの調子が悪くて作業が進まない",
    "昨日は久しぶりによく眠れた",
    "この道は工事中で通れない",
    "彼はいつも丁寧に説明してくれる",
    "写真の整理に時間がかかっている",
    "予定より早く仕事が終わった",
    "天気予報では明日は雨だそうだ",
)
QUERY_PREFIX = "検索クエリ: "
DOCUMENT_PREFIX = "検索文書: "


class OnnxEmbedder:
    """ONNXの埋め込みモデル。mean poolingまで行う。"""

    def __init__(self, model_directory: Path, onnx_file: str, threads: int = 2):
        import onnxruntime
        from tokenizers import Tokenizer

        started = time.monotonic()
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        self.session = onnxruntime.InferenceSession(
            str(model_directory / onnx_file), options, providers=["CPUExecutionProvider"]
        )
        self.tokenizer = Tokenizer.from_file(str(model_directory / "tokenizer.json"))
        self.tokenizer.enable_padding()
        self.input_names = {item.name for item in self.session.get_inputs()}
        self.load_seconds = time.monotonic() - started

    def encode(self, texts: Sequence[str], prefix: str) -> np.ndarray:
        encodings = self.tokenizer.encode_batch([f"{prefix}{text}" for text in texts])
        input_ids = np.asarray([encoding.ids for encoding in encodings], dtype=np.int64)
        attention_mask = np.asarray(
            [encoding.attention_mask for encoding in encodings], dtype=np.int64
        )
        feeds = {"input_ids": input_ids, "attention_mask": attention_mask}
        if "token_type_ids" in self.input_names:
            feeds["token_type_ids"] = np.zeros_like(input_ids)
        hidden = self.session.run(None, feeds)[0]
        mask = attention_mask[..., None].astype(np.float32)
        summed = (hidden * mask).sum(axis=1)
        counts = np.clip(mask.sum(axis=1), 1e-9, None)
        return (summed / counts).astype(np.float32)


def normalized_rows(matrix: np.ndarray) -> np.ndarray:
    matrix = np.asarray(matrix, dtype=np.float32)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return np.divide(matrix, norms, out=np.zeros_like(matrix), where=norms > 0)


def load_animals(lexicon_path: Path) -> list[dict[str, Any]]:
    lexicon = json.loads(lexicon_path.read_text())
    entries = lexicon["animals"] if isinstance(lexicon, dict) else lexicon
    animals = []
    for entry in entries:
        terms = list(entry.get("terms", []) or []) + list(entry.get("onomatopoeia", []) or [])
        if entry.get("label_ja"):
            terms.append(entry["label_ja"])
        animals.append(
            {
                "id": entry["id"],
                "label_ja": entry.get("label_ja") or entry["id"],
                "terms": list(dict.fromkeys(term for term in terms if term.strip())),
            }
        )
    if not animals:
        raise ValueError("animal lexicon is empty")
    return animals


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_profiles(embedder: OnnxEmbedder, animals: Sequence[dict[str, Any]]) -> np.ndarray:
    """動物ごとの別名を1語ずつ埋め込み、平均してprofileベクトルにする。"""
    vectors = []
    for animal in animals:
        embeddings = embedder.encode(animal["terms"], DOCUMENT_PREFIX)
        vectors.append(normalized_rows(embeddings).mean(axis=0))
    return normalized_rows(np.stack(vectors))


def compute_bias(embedder: OnnxEmbedder, profiles: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """背景文に対する各動物の類似度の平均と標準偏差を返す。"""
    scores = normalized_rows(
        embedder.encode(list(BACKGROUND_SENTENCES), QUERY_PREFIX)
    ) @ profiles.T
    deviation = scores.std(axis=0)
    median_deviation = float(np.median(deviation))
    deviation_floor = median_deviation if median_deviation > 1e-6 else 1.0
    return (
        scores.mean(axis=0).astype(np.float32),
        np.maximum(deviation, deviation_floor).astype(np.float32),
    )


def rank_animals(
    embedder: OnnxEmbedder,
    text: str,
    animals: Sequence[dict[str, Any]],
    profiles: np.ndarray,
    bias_mean: np.ndarray | None,
    bias_std: np.ndarray | None,
    top_k: int,
) -> list[dict[str, Any]]:
    query = normalized_rows(embedder.encode([text], QUERY_PREFIX))
    scores = (query @ profiles.T)[0]
    if bias_mean is not None and bias_std is not None:
        scores = (scores - bias_mean) / bias_std
    order = np.argsort(-scores)[: max(1, min(top_k, len(animals)))]
    return [
        {
            "rank": rank_index,
            "id": animals[index]["id"],
            "label_ja": animals[index]["label_ja"],
            "score": float(scores[index]),
        }
        for rank_index, index in enumerate(order, start=1)
    ]


def command_precompute(args: argparse.Namespace) -> int:
    embedder = OnnxEmbedder(args.model, args.onnx_file, args.threads)
    animals = load_animals(args.lexicon)
    profiles = build_profiles(embedder, animals)
    bias_mean, bias_std = compute_bias(embedder, profiles)

    args.output.mkdir(parents=True, exist_ok=True)
    np.save(args.output / "animal_profiles.npy", profiles)
    np.save(args.output / "bias_mean.npy", bias_mean)
    np.save(args.output / "bias_std.npy", bias_std)
    (args.output / "animals.json").write_text(
        json.dumps(
            [{"id": animal["id"], "label_ja": animal["label_ja"]} for animal in animals],
            ensure_ascii=False,
        )
    )
    manifest = {
        "artifact_version": ARTIFACT_VERSION,
        "onnx_file": args.onnx_file,
        "onnx_sha256": file_sha256(args.model / args.onnx_file),
        "tokenizer_sha256": file_sha256(args.model / "tokenizer.json"),
        "lexicon_sha256": file_sha256(args.lexicon),
        "animal_count": len(animals),
        "dimension": int(profiles.shape[1]),
        "background_count": len(BACKGROUND_SENTENCES),
        "bias_std_floor": BIAS_STD_FLOOR,
        "query_prefix": QUERY_PREFIX,
        "document_prefix": DOCUMENT_PREFIX,
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(json.dumps(manifest, ensure_ascii=False))
    return 0


def command_associate(args: argparse.Namespace) -> int:
    started = time.monotonic()
    text = args.text.strip()
    if not text:
        json.dump({"error": {"code": "empty_text", "message": "text must not be empty"}}, sys.stdout)
        sys.stdout.write("\n")
        return 2

    manifest = json.loads((args.artifacts / "manifest.json").read_text())
    if manifest.get("artifact_version") != ARTIFACT_VERSION:
        raise ValueError(
            f"artifact version mismatch: {manifest.get('artifact_version')} != {ARTIFACT_VERSION}"
        )
    embedder = OnnxEmbedder(args.model, manifest["onnx_file"], args.threads)
    animals = json.loads((args.artifacts / "animals.json").read_text())
    profiles = np.load(args.artifacts / "animal_profiles.npy")
    if profiles.shape[0] != len(animals):
        raise ValueError("artifact animal count does not match profiles")
    bias_mean = bias_std = None
    if not args.no_debias:
        bias_mean = np.load(args.artifacts / "bias_mean.npy")
        bias_std = np.load(args.artifacts / "bias_std.npy")

    candidates = rank_animals(
        embedder, text, animals, profiles, bias_mean, bias_std, args.top_k
    )
    selected = candidates[0]
    payload = {
        "input": text,
        "selected_animal": {"id": selected["id"], "label_ja": selected["label_ja"]},
        "strategy": "embedding_profile",
        "score": selected["score"],
        "debiased": not args.no_debias,
        "candidates": candidates,
        "timing": {
            "model_load_ms": round(embedder.load_seconds * 1000, 1),
            "total_ms": round((time.monotonic() - started) * 1000, 1),
        },
    }
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Zoovoice embedding association runner")
    commands = parser.add_subparsers(dest="command", required=True)

    precompute = commands.add_parser("precompute")
    precompute.add_argument("--model", type=Path, required=True)
    precompute.add_argument("--lexicon", type=Path, required=True)
    precompute.add_argument("--output", type=Path, required=True)
    precompute.add_argument("--onnx-file", default="model_int8.onnx")
    precompute.add_argument("--threads", type=int, default=2)
    precompute.set_defaults(handler=command_precompute)

    associate = commands.add_parser("associate")
    associate.add_argument("--model", type=Path, required=True)
    associate.add_argument("--artifacts", type=Path, required=True)
    associate.add_argument("--text", required=True)
    associate.add_argument("--top-k", type=int, default=5)
    associate.add_argument("--threads", type=int, default=2)
    associate.add_argument("--no-debias", action="store_true")
    associate.set_defaults(handler=command_associate)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
