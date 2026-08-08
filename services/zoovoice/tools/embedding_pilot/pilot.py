#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import math
import random
import sqlite3
import subprocess
import sys
import tempfile
import time
import zoneinfo
from pathlib import Path
from typing import Any, Sequence

import numpy as np
from safetensors.numpy import load_file
from tokenizers import Tokenizer


class ProgressLogger:
    def __init__(self) -> None:
        self.started = time.monotonic()
        self.timezone = zoneinfo.ZoneInfo("Asia/Tokyo")

    def emit(
        self,
        phase: str,
        status: str,
        completed: int | None = None,
        total: int | None = None,
        detail: str | None = None,
    ) -> None:
        fields = [
            f"time={datetime.datetime.now(self.timezone).isoformat(timespec='milliseconds')}",
            f"elapsed_ms={int((time.monotonic() - self.started) * 1000)}",
            f"phase={phase}",
            f"status={status}",
        ]
        if completed is not None:
            fields.append(f"completed={completed}")
        if total is not None:
            fields.append(f"total={total}")
        if detail:
            fields.append(f"detail={detail}")
        print(" ".join(fields), file=sys.stderr, flush=True)


class StaticEmbeddingModel:
    def __init__(self, model_directory: Path, truncate_dim: int | None = None):
        started = time.monotonic()
        weights = load_file(str(model_directory / "model.safetensors"))["embedding.weight"]
        if truncate_dim is not None:
            if truncate_dim < 1 or truncate_dim > weights.shape[1]:
                raise ValueError(f"truncate_dim must be between 1 and {weights.shape[1]}")
            weights = weights[:, :truncate_dim]
        self.weights = np.asarray(weights, dtype=np.float32)
        self.tokenizer = Tokenizer.from_file(str(model_directory / "tokenizer.json"))
        self.tokenizer.no_padding()
        if self.tokenizer.get_vocab_size() != self.weights.shape[0]:
            raise ValueError(
                f"tokenizer vocabulary {self.tokenizer.get_vocab_size()} does not match "
                f"embedding rows {self.weights.shape[0]}"
            )
        self.load_seconds = time.monotonic() - started

    def encode(self, texts: Sequence[str]) -> np.ndarray:
        encodings = self.tokenizer.encode_batch(list(texts), add_special_tokens=False)
        vectors: list[np.ndarray] = []
        for encoding in encodings:
            if encoding.ids:
                vectors.append(self.weights[np.asarray(encoding.ids, dtype=np.int64)].mean(axis=0))
            else:
                vectors.append(np.zeros(self.weights.shape[1], dtype=np.float32))
        if not vectors:
            return np.empty((0, self.weights.shape[1]), dtype=np.float32)
        return np.stack(vectors).astype(np.float32, copy=False)


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


def normalized_rows(matrix: np.ndarray) -> np.ndarray:
    matrix = np.asarray(matrix, dtype=np.float32)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return np.divide(matrix, norms, out=np.zeros_like(matrix), where=norms > 0)


def compute_animal_bias(
    model: Any, profile_embeddings: np.ndarray, background: Sequence[str] | None = None
) -> tuple[np.ndarray, np.ndarray]:
    """各動物が背景文へ返す類似度の平均と標準偏差を測る。

    どの入力でも高い類似度を返す動物ほど平均が大きくなる。この平均を差し引くと、
    入力とほぼ無関係に上位へ来る動物を抑えられる。
    """
    sentences = list(background) if background is not None else list(BACKGROUND_SENTENCES)
    if not sentences:
        raise ValueError("background sentences must not be empty")
    profiles = normalized_rows(profile_embeddings)
    scores = normalized_rows(np.asarray(model.encode(sentences), dtype=np.float32)) @ profiles.T
    bias_mean = scores.mean(axis=0)
    deviation = scores.std(axis=0)
    median_deviation = float(np.median(deviation))
    deviation_floor = median_deviation if median_deviation > 1e-6 else 1.0
    bias_std = np.maximum(deviation, deviation_floor).astype(np.float32)
    return bias_mean.astype(np.float32), bias_std


def score_animals_for_text(
    model: Any,
    text: str,
    profile_embeddings: np.ndarray,
    bias: tuple[np.ndarray, np.ndarray] | None = None,
) -> np.ndarray:
    """入力文をそのまま埋め込み、各動物profileとの類似度を返す。

    語ごとに埋め込んで平均する方式と違い、助詞や文脈を保ったまま比較する。
    """
    profiles = normalized_rows(profile_embeddings)
    query = normalized_rows(np.asarray(model.encode([text]), dtype=np.float32))
    scores = (query @ profiles.T)[0]
    if bias is None:
        return scores
    bias_mean, bias_std = bias
    return (scores - bias_mean) / bias_std


def rank_animal_candidates(
    terms: Sequence[str],
    model: Any,
    animals: Sequence[dict[str, Any]],
    profile_embeddings: np.ndarray,
    top_k: int,
) -> list[dict[str, Any]]:
    cleaned_terms = list(dict.fromkeys(term.strip() for term in terms if term.strip()))
    if not cleaned_terms:
        raise ValueError("text produced no embedding terms")
    if top_k < 1 or top_k > len(animals):
        raise ValueError(f"top_k must be between 1 and {len(animals)}")
    profiles = normalized_rows(profile_embeddings)
    if profiles.shape[0] != len(animals):
        raise ValueError("animal profile count does not match profile embeddings")
    term_embeddings = np.asarray(model.encode(cleaned_terms), dtype=np.float32)
    if term_embeddings.ndim != 2 or term_embeddings.shape[0] != len(cleaned_terms):
        raise ValueError("embedding model returned an invalid term matrix")
    if profiles.ndim != 2 or profiles.shape[1] != term_embeddings.shape[1]:
        raise ValueError("model and animal profile dimensions do not match")
    query = normalized_rows(term_embeddings.mean(axis=0, keepdims=True))
    similarities = (query @ profiles.T)[0]
    term_similarities = normalized_rows(term_embeddings) @ profiles.T
    ordered_indices = sorted(
        range(len(animals)),
        key=lambda index: (-float(similarities[index]), str(animals[index]["id"])),
    )[:top_k]
    candidates: list[dict[str, Any]] = []
    for rank, animal_index in enumerate(ordered_indices, start=1):
        evidence_index = max(
            range(len(cleaned_terms)),
            key=lambda index: (float(term_similarities[index, animal_index]), cleaned_terms[index]),
        )
        animal = animals[animal_index]
        candidates.append(
            {
                "rank": rank,
                "id": animal["id"],
                "label_ja": animal["label_ja"],
                "similarity": float(similarities[animal_index]),
                "evidence_term": cleaned_terms[evidence_index],
                "evidence_similarity": float(term_similarities[evidence_index, animal_index]),
            }
        )
    return candidates


def expand_terms(
    terms: Sequence[str],
    model: Any,
    concepts: Sequence[str],
    concept_embeddings: np.ndarray,
    threshold: float,
    top_k: int,
) -> tuple[list[str], list[dict[str, Any]]]:
    cleaned_terms = list(dict.fromkeys(term.strip() for term in terms if term.strip()))
    if not cleaned_terms or top_k < 1:
        return [], []
    queries = normalized_rows(model.encode(cleaned_terms))
    candidates = normalized_rows(concept_embeddings)
    similarities = queries @ candidates.T
    source_terms = set(cleaned_terms)
    best: dict[str, tuple[float, str]] = {}
    for term_index, term in enumerate(cleaned_terms):
        for concept_index, concept in enumerate(concepts):
            score = float(similarities[term_index, concept_index])
            if concept in source_terms or score < threshold:
                continue
            previous = best.get(concept)
            if previous is None or score > previous[0] or (score == previous[0] and term < previous[1]):
                best[concept] = (score, term)
    ordered = sorted(best.items(), key=lambda item: (-item[1][0], item[0]))[:top_k]
    details = [
        {"concept": concept, "source_term": source, "similarity": score}
        for concept, (score, source) in ordered
    ]
    return [item["concept"] for item in details], details


def summarize_results(results: Sequence[dict[str, Any]]) -> dict[str, Any]:
    total = len(results)
    path_count = 0
    fallback_count = 0
    error_count = 0
    contract_count = 0
    semantic_count = 0
    strategies: dict[str, int] = {}
    for result in results:
        selection = result.get("selection")
        if result.get("error"):
            error_count += 1
            strategy = result["error"].get("code", "error")
        elif selection:
            strategy = selection.get("strategy", "unknown")
            if strategy == "random_fallback":
                fallback_count += 1
            else:
                path_count += 1
        else:
            strategy = "missing"
            error_count += 1
        strategies[strategy] = strategies.get(strategy, 0) + 1
        contract_count += int(bool(result.get("contract_ok")))
        semantic_count += int(bool(result.get("semantic_ok", result.get("contract_ok"))))
    denominator = total or 1
    return {
        "total": total,
        "association_path_count": path_count,
        "association_path_rate": path_count / denominator,
        "random_fallback_count": fallback_count,
        "random_fallback_rate": fallback_count / denominator,
        "error_count": error_count,
        "error_rate": error_count / denominator,
        "contract_ok_count": contract_count,
        "contract_ok_rate": contract_count / denominator,
        "semantic_ok_count": semantic_count,
        "semantic_ok_rate": semantic_count / denominator,
        "strategies": dict(sorted(strategies.items())),
    }


def profile_candidate_results(
    extracted: Sequence[dict[str, Any]],
    baseline: Sequence[dict[str, Any]],
    fixtures: Sequence[dict[str, Any]],
    model: Any,
    animals: Sequence[dict[str, str]],
    profile_embeddings: np.ndarray,
    threshold: float,
    seed: int,
    query_mode: str = "terms",
    background: Sequence[str] | None = None,
) -> list[dict[str, Any]]:
    """候補Dの選定結果を作る。

    query_mode が "sentence" のとき、抽出語の平均ではなく入力文をそのまま埋め込む。
    background を与えると、動物ごとの出やすさの偏りを補正する。
    """
    if query_mode not in {"terms", "sentence"}:
        raise ValueError(f"query_mode must be 'terms' or 'sentence': {query_mode}")
    baseline_by_id = {item["id"]: item for item in baseline}
    fixtures_by_id = {item["id"]: item for item in fixtures}
    profiles = normalized_rows(profile_embeddings)
    bias = compute_animal_bias(model, profile_embeddings, background) if background else None
    animal_ids = [animal["id"] for animal in animals]
    animal_by_id = {animal["id"]: animal for animal in animals}
    results: list[dict[str, Any]] = []
    for item in extracted:
        fixture_id = item["id"]
        base = baseline_by_id[fixture_id]
        fixture = fixtures_by_id[fixture_id]
        result = {
            "id": fixture_id,
            "role": item.get("role", ""),
            "kind": item.get("kind", ""),
            "input": item.get("input", ""),
            "candidate": "D",
            "extracted_terms": item.get("terms", []),
        }
        base_selection = base.get("selection")
        if base.get("error"):
            result["error"] = base["error"]
            result["contract_ok"] = base.get("contract_ok", False)
            result["semantic_ok"] = result["contract_ok"]
            results.append(result)
            continue
        if base_selection and base_selection.get("strategy") in {"direct", "pun"}:
            result["selection"] = dict(base_selection)
            result["contract_ok"] = base.get("contract_ok", False)
            result["semantic_ok"] = result["contract_ok"]
            results.append(result)
            continue
        terms = [term for term in item.get("embedding_terms", item.get("terms", [])) if term.strip()]
        text = item.get("input", "")
        if query_mode == "sentence" and text.strip():
            scores_row = score_animals_for_text(model, text, profile_embeddings, bias)
            evidence = text
        else:
            vector = (
                model.encode(terms).mean(axis=0, keepdims=True)
                if terms
                else np.zeros((1, profiles.shape[1]))
            )
            scores_row = (normalized_rows(vector) @ profiles.T)[0]
            if bias is not None:
                bias_mean, bias_std = bias
                scores_row = (scores_row - bias_mean) / bias_std
            evidence = terms[0] if terms else ""
        best_index = int(np.argmax(scores_row)) if len(animals) else -1
        best_score = float(scores_row[best_index]) if best_index >= 0 else -math.inf
        if best_index >= 0 and best_score >= threshold:
            animal = animals[best_index]
            result["selection"] = {
                "species": animal["id"],
                "label_ja": animal["label_ja"],
                "evidence_term": evidence,
                "strategy": "embedding_profile",
                "score": {"total": best_score, "contributions": []},
            }
        else:
            digest = hashlib.sha256(f"{seed}:{fixture_id}".encode()).digest()
            fallback_index = int.from_bytes(digest[:8], "big") % len(animal_ids)
            fallback_id = animal_ids[fallback_index]
            animal = animal_by_id[fallback_id]
            result["selection"] = {
                "species": fallback_id,
                "label_ja": animal["label_ja"],
                "strategy": "random_fallback",
                "fallback_reason": "no_association_match",
            }
        acceptable = fixture.get("acceptable_animals", [])
        selected_id = result["selection"]["species"]
        result["semantic_ok"] = not acceptable or selected_id in acceptable
        expected = fixture.get("expected_strategy", [])
        result["contract_ok"] = (
            result["selection"]["strategy"] in expected
            and (not acceptable or selected_id in acceptable)
        )
        results.append(result)
    return results


def build_blind_comparison(
    candidates: dict[str, Sequence[dict[str, Any]]], seed: int
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    rng = random.Random(seed)
    by_candidate = {name: {item["id"]: item for item in results} for name, results in candidates.items()}
    fixture_ids = sorted(set.intersection(*(set(items) for items in by_candidate.values())))
    sheet: list[dict[str, Any]] = []
    key: list[dict[str, str]] = []
    for fixture_id in fixture_ids:
        options = []
        for candidate, items in sorted(by_candidate.items()):
            result = items[fixture_id]
            selection = result.get("selection", {})
            options.append(
                {
                    "candidate": candidate,
                    "animal": selection.get("label_ja"),
                    "animal_id": selection.get("species"),
                    "association_path": selection.get("evidence_term"),
                    "error": result.get("error", {}).get("message"),
                }
            )
        rng.shuffle(options)
        public_options = []
        for option_index, option in enumerate(options, start=1):
            option_id = f"{fixture_id}-option-{option_index}"
            key.append({"option_id": option_id, "candidate": option.pop("candidate")})
            public_options.append({"option_id": option_id, **option, "rating": None, "note": ""})
        exemplar = next(iter(by_candidate.values()))[fixture_id]
        sheet.append(
            {
                "fixture_id": fixture_id,
                "input": exemplar.get("input", ""),
                "options": public_options,
            }
        )
    return sheet, key


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def file_record(path: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return {"file": path.name, "size_bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def verify_model_artifact_set(model_directory: Path, provenance: dict[str, Any]) -> None:
    records = provenance.get("files")
    if not isinstance(records, list) or not records:
        raise ValueError("model provenance does not contain file hashes")
    for expected in records:
        filename = expected.get("file") if isinstance(expected, dict) else None
        if not isinstance(filename, str) or Path(filename).name != filename:
            raise ValueError("model provenance contains an invalid filename")
        actual = file_record(model_directory / filename)
        if (
            actual["size_bytes"] != expected.get("size_bytes")
            or actual["sha256"] != expected.get("sha256")
        ):
            raise ValueError(f"model artifact does not match provenance: {filename}")


def precompute(args: argparse.Namespace) -> None:
    progress = ProgressLogger()
    progress.emit("precompute", "start", detail=f"truncate_dim={args.truncate_dim}")
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    model = StaticEmbeddingModel(args.model, args.truncate_dim)
    progress.emit("model_load", "complete", detail=f"seconds={model.load_seconds:.6f}")
    with sqlite3.connect(f"file:{args.index}?mode=ro", uri=True) as database:
        concepts = [row[0] for row in database.execute("SELECT DISTINCT concept FROM edges ORDER BY concept")]
    concept_embeddings = model.encode(concepts)
    progress.emit("concept_embeddings", "complete", completed=len(concepts), total=len(concepts))
    lexicon = read_json(args.lexicon)
    animals: list[dict[str, Any]] = []
    profile_vectors: list[np.ndarray] = []
    for animal in lexicon["animals"]:
        terms = list(dict.fromkeys(animal.get("terms", []) + animal.get("onomatopoeia", [])))
        vector = model.encode(terms).mean(axis=0) if terms else np.zeros(concept_embeddings.shape[1])
        animals.append({"id": animal["id"], "label_ja": animal["label_ja"], "terms": terms})
        profile_vectors.append(vector)
    progress.emit("animal_profiles", "complete", completed=len(animals), total=len(animals))
    np.save(output / "concept_embeddings.npy", concept_embeddings)
    np.save(output / "animal_profile_embeddings.npy", np.stack(profile_vectors).astype(np.float32))
    write_json(output / "concepts.json", concepts)
    write_json(output / "animal_profiles.json", animals)
    provenance = {
        "model_id": args.model_id,
        "revision": args.revision,
        "license": args.license,
        "truncate_dim": args.truncate_dim,
        "load_seconds": model.load_seconds,
        "concept_count": len(concepts),
        "animal_count": len(animals),
        "files": [file_record(args.model / name) for name in ("model.safetensors", "tokenizer.json")],
    }
    write_json(output / "provenance.json", provenance)
    progress.emit("precompute", "complete")


def invoke_go(go_binary: Path, arguments: Sequence[str]) -> None:
    subprocess.run([str(go_binary), "association-eval", *arguments], check=True)


def go_result_for_text(
    go_binary: Path,
    text: str,
    lexicon: Path | None = None,
    index: Path | None = None,
    seed: int = 7,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    fixture = [
        {
            "id": "interactive",
            "role": "local",
            "kind": "manual",
            "input": text,
            "expected_strategy": [],
            "acceptable_animals": [],
        }
    ]
    with tempfile.TemporaryDirectory(prefix="zoovoice-associate-") as directory:
        root = Path(directory)
        fixtures_path = root / "fixture.json"
        extracted_path = root / "extracted.json"
        write_json(fixtures_path, fixture)
        invoke_go(
            go_binary,
            ["extract", "--fixtures", str(fixtures_path), "--output", str(extracted_path)],
        )
        extracted = read_json(extracted_path)
        if len(extracted) != 1:
            raise ValueError("Go extractor returned an unexpected result count")
        if lexicon is None and index is None:
            return extracted[0], None
        if lexicon is None or index is None:
            raise ValueError("conceptnet method requires both lexicon and index")
        result_path = root / "conceptnet.json"
        invoke_go(
            go_binary,
            [
                "evaluate",
                "--fixtures",
                str(fixtures_path),
                "--lexicon",
                str(lexicon),
                "--index",
                str(index),
                "--candidate",
                "A",
                "--seed",
                str(seed),
                "--output",
                str(result_path),
            ],
        )
        results = read_json(result_path)
        if len(results) != 1:
            raise ValueError("Go evaluator returned an unexpected result count")
        return extracted[0], results[0]


def write_association_json(path: Path, value: Any) -> None:
    if str(path) == "-":
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return
    write_json(path, value)


def associate_text(args: argparse.Namespace) -> None:
    text = args.text.strip()
    if not text:
        raise ValueError("text must not be empty")
    if args.method == "conceptnet":
        if args.lexicon is None or args.index is None:
            raise ValueError("conceptnet method requires --lexicon and --index")
        extracted, evaluated = go_result_for_text(
            args.go_binary, text, args.lexicon, args.index, args.seed
        )
        if evaluated is None:
            raise ValueError("ConceptNet evaluation did not return a result")
        if evaluated.get("error"):
            error = evaluated["error"]
            raise ValueError(f"ConceptNet association failed: {error.get('code')}: {error.get('message')}")
        selection = evaluated.get("selection")
        if not selection:
            raise ValueError("ConceptNet association did not return a selection")
        candidate = {
            "rank": 1,
            "id": selection["species"],
            "label_ja": selection["label_ja"],
            "strategy": selection["strategy"],
            "evidence_term": selection.get("evidence_term"),
            "score": selection.get("score"),
        }
        output = {
            "input": text,
            "method": "conceptnet",
            "extracted_terms": extracted.get("terms", []),
            "embedding_terms": extracted.get("embedding_terms", []),
            "selected_animal": {"id": candidate["id"], "label_ja": candidate["label_ja"]},
            "association": {
                "strategy": selection["strategy"],
                "evidence_term": selection.get("evidence_term"),
                "fallback_reason": selection.get("fallback_reason"),
                "score": selection.get("score"),
            },
            "candidates": [candidate],
        }
        write_association_json(args.output, output)
        return
    if args.model is None or args.precomputed is None:
        raise ValueError("embedding method requires --model and --precomputed")
    extracted, _ = go_result_for_text(args.go_binary, text)
    provenance = read_json(args.precomputed / "provenance.json")
    verify_model_artifact_set(args.model, provenance)
    model = StaticEmbeddingModel(args.model, provenance.get("truncate_dim"))
    animals = read_json(args.precomputed / "animal_profiles.json")
    profiles = np.load(args.precomputed / "animal_profile_embeddings.npy")
    if args.query_mode == "sentence":
        bias = None if args.no_debias else compute_animal_bias(model, profiles)
        scores = score_animals_for_text(model, text, profiles, bias)
        order = np.argsort(-scores)[: args.top_k]
        candidates = [
            {
                "rank": rank_index,
                "id": animals[index]["id"],
                "label_ja": animals[index]["label_ja"],
                "similarity": float(scores[index]),
                "evidence_term": text,
            }
            for rank_index, index in enumerate(order, start=1)
        ]
    else:
        candidates = rank_animal_candidates(
            extracted.get("embedding_terms", []), model, animals, profiles, args.top_k
        )
    selected = candidates[0]
    output = {
        "input": text,
        "method": "embedding",
        "query_mode": args.query_mode,
        "debiased": args.query_mode == "sentence" and not args.no_debias,
        "model": {
            key: provenance.get(key)
            for key in ("model_id", "revision", "license", "truncate_dim")
        },
        "extracted_terms": extracted.get("terms", []),
        "embedding_terms": extracted.get("embedding_terms", []),
        "selected_animal": {"id": selected["id"], "label_ja": selected["label_ja"]},
        "association": {
            "strategy": "embedding_profile",
            "evidence_term": selected["evidence_term"],
            "similarity": selected["similarity"],
        },
        "candidates": candidates,
    }
    write_association_json(args.output, output)


def expansion_map(
    extracted: Sequence[dict[str, Any]],
    model: StaticEmbeddingModel,
    concepts: Sequence[str],
    embeddings: np.ndarray,
    threshold: float,
    top_k: int,
) -> tuple[dict[str, list[str]], dict[str, list[dict[str, Any]]]]:
    expansions: dict[str, list[str]] = {}
    details: dict[str, list[dict[str, Any]]] = {}
    for item in extracted:
        expanded, detail = expand_terms(
            item.get("embedding_terms", item.get("terms", [])),
            model,
            concepts,
            embeddings,
            threshold,
            top_k,
        )
        expansions[item["id"]] = expanded
        details[item["id"]] = detail
    return expansions, details


def choose_result(
    candidates: Sequence[tuple[tuple[float, int], Sequence[dict[str, Any]]]],
    semantic_field: str = "contract_ok",
) -> tuple[tuple[float, int], Sequence[dict[str, Any]]]:
    def score(item: tuple[tuple[float, int], Sequence[dict[str, Any]]]) -> tuple[Any, ...]:
        (threshold, top_k), results = item
        metrics = summarize_results(results)
        semantic_count = sum(bool(result.get(semantic_field)) for result in results)
        valid_path_count = sum(
            bool(result.get(semantic_field))
            and result.get("selection", {}).get("strategy") != "random_fallback"
            for result in results
        )
        invalid_path_count = sum(
            not bool(result.get(semantic_field))
            and result.get("selection", {}).get("strategy") not in {None, "random_fallback"}
            for result in results
        )
        return (
            semantic_count,
            valid_path_count,
            -invalid_path_count,
            -metrics["random_fallback_count"],
            -top_k,
            threshold,
        )

    return max(candidates, key=score)


def run_pilot(args: argparse.Namespace) -> None:
    progress = ProgressLogger()
    progress.emit("pilot", "start", detail=f"roles={args.roles}")
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    fixtures = read_json(args.fixtures)
    allowed_roles = {role.strip() for role in args.roles.split(",") if role.strip()}
    if not allowed_roles:
        raise ValueError("at least one role is required")
    selected_fixtures = [fixture for fixture in fixtures if fixture.get("role") in allowed_roles]
    selected_path = output / "fixtures.selected.json"
    write_json(selected_path, selected_fixtures)
    extracted_path = output / "extracted_terms.json"
    invoke_go(args.go_binary, ["extract", "--fixtures", str(selected_path), "--output", str(extracted_path)])
    extracted = read_json(extracted_path)
    progress.emit("extract", "complete", completed=len(extracted), total=len(selected_fixtures))
    baseline_path = output / "candidate_A.json"
    invoke_go(
        args.go_binary,
        [
            "evaluate", "--fixtures", str(selected_path), "--lexicon", str(args.lexicon),
            "--index", str(args.index), "--candidate", "A", "--seed", str(args.seed),
            "--output", str(baseline_path),
        ],
    )
    baseline = read_json(baseline_path)
    progress.emit("candidate_A", "complete", completed=len(baseline), total=len(selected_fixtures))
    model = StaticEmbeddingModel(args.model, args.truncate_dim)
    progress.emit("model_load", "complete", detail=f"seconds={model.load_seconds:.6f}")
    concepts = read_json(args.precomputed / "concepts.json")
    concept_embeddings = np.load(args.precomputed / "concept_embeddings.npy")
    animals = read_json(args.precomputed / "animal_profiles.json")
    profile_embeddings = np.load(args.precomputed / "animal_profile_embeddings.npy")
    thresholds = [float(value) for value in args.thresholds.split(",")]
    top_ks = [int(value) for value in args.top_ks.split(",")]
    development_ids = {fixture["id"] for fixture in selected_fixtures if fixture.get("role") == "development"}
    tuning_extracted = [item for item in extracted if item["id"] in development_ids]
    tuning_fixtures = [item for item in selected_fixtures if item["id"] in development_ids]
    tuning_path = output / "fixtures.tuning.json"
    write_json(tuning_path, tuning_fixtures)
    chosen: dict[str, tuple[float, int]] = {}
    final_results: dict[str, Sequence[dict[str, Any]]] = {"A": baseline}
    with tempfile.TemporaryDirectory(prefix="grid-", dir=output) as temporary:
        temp = Path(temporary)
        for candidate in ("B", "C"):
            grid: list[tuple[tuple[float, int], Sequence[dict[str, Any]]]] = []
            for threshold in thresholds:
                for top_k in top_ks:
                    expansions, _ = expansion_map(
                        tuning_extracted, model, concepts, concept_embeddings, threshold, top_k
                    )
                    expansion_path = temp / f"{candidate}-{threshold}-{top_k}-expansions.json"
                    result_path = temp / f"{candidate}-{threshold}-{top_k}-results.json"
                    write_json(expansion_path, expansions)
                    invoke_go(
                        args.go_binary,
                        [
                            "evaluate", "--fixtures", str(tuning_path), "--expansions", str(expansion_path),
                            "--lexicon", str(args.lexicon), "--index", str(args.index),
                            "--candidate", candidate, "--seed", str(args.seed), "--output", str(result_path),
                        ],
                    )
                    grid.append(((threshold, top_k), read_json(result_path)))
            (threshold, top_k), _ = choose_result(grid)
            chosen[candidate] = (threshold, top_k)
            expansions, details = expansion_map(
                extracted, model, concepts, concept_embeddings, threshold, top_k
            )
            expansion_path = output / f"candidate_{candidate}_expansions.json"
            write_json(expansion_path, expansions)
            write_json(output / f"candidate_{candidate}_neighbors.json", details)
            result_path = output / f"candidate_{candidate}.json"
            invoke_go(
                args.go_binary,
                [
                    "evaluate", "--fixtures", str(selected_path), "--expansions", str(expansion_path),
                    "--lexicon", str(args.lexicon), "--index", str(args.index),
                    "--candidate", candidate, "--seed", str(args.seed), "--output", str(result_path),
                ],
            )
            final_results[candidate] = read_json(result_path)
            progress.emit(
                f"candidate_{candidate}",
                "complete",
                completed=len(final_results[candidate]),
                total=len(selected_fixtures),
                detail=f"threshold={threshold},top_k={top_k}",
            )
        d_grid = []
        tuning_baseline = [item for item in baseline if item["id"] in development_ids]
        background = None if args.no_debias else list(BACKGROUND_SENTENCES)
        for threshold in thresholds:
            results = profile_candidate_results(
                tuning_extracted, tuning_baseline, tuning_fixtures, model,
                animals, profile_embeddings, threshold, args.seed,
                query_mode=args.query_mode, background=background,
            )
            d_grid.append(((threshold, 0), results))
        (d_threshold, _), _ = choose_result(d_grid, semantic_field="semantic_ok")
        chosen["D"] = (d_threshold, 0)
    final_results["D"] = profile_candidate_results(
        extracted, baseline, selected_fixtures, model, animals, profile_embeddings,
        d_threshold, args.seed, query_mode=args.query_mode, background=background,
    )
    write_json(output / "candidate_D.json", final_results["D"])
    progress.emit(
        "candidate_D", "complete", completed=len(final_results["D"]),
        total=len(selected_fixtures), detail=f"threshold={d_threshold}",
    )
    summary = {
        "roles": sorted(allowed_roles),
        "fixture_count": len(selected_fixtures),
        "model_load_seconds": model.load_seconds,
        "chosen_parameters": {
            candidate: {"threshold": values[0], "top_k": values[1]} for candidate, values in chosen.items()
        },
        "metrics": {candidate: summarize_results(results) for candidate, results in final_results.items()},
    }
    write_json(output / "summary.json", summary)
    sheet, key = build_blind_comparison(final_results, args.seed)
    write_json(output / "blind_comparison.json", sheet)
    write_json(output / "blind_key.json", key)
    progress.emit("pilot", "complete", completed=len(selected_fixtures), total=len(selected_fixtures))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Zoovoice embedding comparison pilot")
    commands = parser.add_subparsers(dest="command", required=True)
    precompute_parser = commands.add_parser("precompute")
    precompute_parser.add_argument("--model", type=Path, required=True)
    precompute_parser.add_argument("--model-id", required=True)
    precompute_parser.add_argument("--revision", required=True)
    precompute_parser.add_argument("--license", required=True)
    precompute_parser.add_argument("--index", type=Path, required=True)
    precompute_parser.add_argument("--lexicon", type=Path, required=True)
    precompute_parser.add_argument("--output", type=Path, required=True)
    precompute_parser.add_argument("--truncate-dim", type=int, default=256)
    precompute_parser.set_defaults(handler=precompute)
    run_parser = commands.add_parser("run")
    run_parser.add_argument("--go-binary", type=Path, required=True)
    run_parser.add_argument("--fixtures", type=Path, required=True)
    run_parser.add_argument("--lexicon", type=Path, required=True)
    run_parser.add_argument("--index", type=Path, required=True)
    run_parser.add_argument("--model", type=Path, required=True)
    run_parser.add_argument("--precomputed", type=Path, required=True)
    run_parser.add_argument("--output", type=Path, required=True)
    run_parser.add_argument("--roles", default="development,regression")
    run_parser.add_argument("--thresholds", default="0.35,0.45,0.55,0.65,0.75,0.85,0.95,0.99,1.01")
    run_parser.add_argument("--top-ks", default="1,3,5")
    run_parser.add_argument("--truncate-dim", type=int, default=256)
    run_parser.add_argument("--seed", type=int, default=7)
    run_parser.add_argument(
        "--query-mode",
        choices=("sentence", "terms"),
        default="sentence",
        help="候補Dのクエリ構成。sentenceは入力文をそのまま埋め込む",
    )
    run_parser.add_argument(
        "--no-debias",
        action="store_true",
        help="動物ごとの出やすさの偏り補正を無効にする",
    )
    run_parser.set_defaults(handler=run_pilot)
    associate_parser = commands.add_parser(
        "associate", help="associate one text with animals using a selected local method"
    )
    associate_parser.add_argument(
        "--method", choices=("conceptnet", "embedding"), required=True,
        help="association method to run",
    )
    associate_parser.add_argument("--text", required=True, help="Japanese text to associate")
    associate_parser.add_argument("--go-binary", type=Path, required=True)
    associate_parser.add_argument("--lexicon", type=Path, help="required for conceptnet")
    associate_parser.add_argument("--index", type=Path, help="required for conceptnet")
    associate_parser.add_argument("--model", type=Path, help="required for embedding")
    associate_parser.add_argument("--precomputed", type=Path, help="required for embedding")
    associate_parser.add_argument(
        "--top-k", type=int, default=5,
        help="number of ranked embedding animal candidates to return",
    )
    associate_parser.add_argument("--seed", type=int, default=7)
    associate_parser.add_argument(
        "--query-mode",
        choices=("sentence", "terms"),
        default="sentence",
        help="sentenceは入力文をそのまま埋め込む。termsは抽出語の平均を使う旧方式",
    )
    associate_parser.add_argument(
        "--no-debias",
        action="store_true",
        help="動物ごとの出やすさの偏り補正を無効にする",
    )
    associate_parser.add_argument("--output", type=Path, default=Path("-"))
    associate_parser.set_defaults(handler=associate_text)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        args.handler(args)
    except (OSError, ValueError, subprocess.CalledProcessError, sqlite3.Error) as error:
        print(f"embedding pilot failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
