#!/usr/bin/env python3
"""Normalize one approved Stable Audio candidate per animal and write its manifest."""

from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
import subprocess
import wave
from collections import defaultdict
from pathlib import Path

MAX_OUTPUT_BYTES = 15_000_000
LICENSE = "Stability AI Community License"
LICENSE_URL = "https://stability.ai/license"
NOTICE = "This Stability AI Model is licensed under the Stability AI Community License"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def wav_metrics(path: Path) -> dict[str, int | float]:
    with wave.open(str(path), "rb") as source:
        channels = source.getnchannels()
        sample_rate = source.getframerate()
        sample_width = source.getsampwidth()
        frames = source.getnframes()
        samples = array.array("h")
        samples.frombytes(source.readframes(frames))
    if channels != 1 or sample_rate != 24_000 or sample_width != 2:
        raise ValueError(f"unexpected normalized WAV format: {path}")
    if not samples:
        raise ValueError(f"normalized WAV is empty: {path}")
    peak = max(abs(value) for value in samples)
    rms = math.sqrt(sum(value * value for value in samples) / len(samples))
    if peak == 0 or rms == 0:
        raise ValueError(f"normalized WAV is silent: {path}")
    return {
        "duration_seconds": round(frames / sample_rate, 6),
        "sample_rate": sample_rate,
        "channels": channels,
        "bits_per_sample": sample_width * 8,
        "mean_dbfs": round(20 * math.log10(rms / 32767), 1),
        "peak_dbfs": round(20 * math.log10(peak / 32767), 1),
    }


def candidate(item: dict[str, object]) -> dict[str, object]:
    source_file = str(item["file"])
    return {
        "variant": int(item["variant"]),
        "seed": int(item["seed"]),
        "prompt": str(item["prompt"]),
        "source_file": source_file,
        "source_sha256": str(item["sha256"]),
        "receipt_file": source_file.removesuffix(".wav") + ".receipt.json",
    }


def normalize(source_path: Path, destination: Path) -> dict[str, int | float]:
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error", "-i", str(source_path),
            "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
            "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", str(destination),
        ],
        check=True,
    )
    return wav_metrics(destination)


def run(
    source_dir: Path,
    output_dir: Path,
    cc0_assets_dir: Path | None = None,
    cc0_master_path: Path | None = None,
    cc0_manifest_path: Path | None = None,
    cc0_ids: tuple[str, ...] = (),
) -> None:
    source_manifest_path = source_dir / "manifest.json"
    source_manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    grouped: dict[str, list[dict[str, object]]] = defaultdict(list)
    for item in source_manifest["items"]:
        grouped[str(item["species"])].append(item)
    output_dir.mkdir(parents=True, exist_ok=True)
    animals: list[dict[str, object]] = []
    for animal_id in sorted(grouped):
        candidates = sorted(grouped[animal_id], key=lambda item: int(item["variant"]))
        if [int(item["variant"]) for item in candidates] != [1, 2]:
            raise ValueError(f"{animal_id} must have exactly variants 1 and 2")
        for item in candidates:
            source_path = source_dir / str(item["file"])
            receipt_path = source_dir / candidate(item)["receipt_file"]
            if sha256(source_path) != item["sha256"]:
                raise ValueError(f"source hash mismatch: {source_path}")
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            if receipt.get("model") != source_manifest["model"] or receipt.get("item") != item:
                raise ValueError(f"receipt mismatch: {receipt_path}")
        adopted = candidates[0]
        source_path = source_dir / str(adopted["file"])
        destination = output_dir / f"{animal_id}.wav"
        metrics = normalize(source_path, destination)
        if not (4.99 <= float(metrics["duration_seconds"]) <= 5.01):
            raise ValueError(f"unexpected duration: {destination}")
        if not (-60 <= float(metrics["mean_dbfs"]) <= -1):
            raise ValueError(f"unexpected mean dBFS: {destination}")
        if not (-6 <= float(metrics["peak_dbfs"]) <= 0.1):
            raise ValueError(f"unexpected peak dBFS: {destination}")
        animals.append(
            {
                "id": animal_id,
                "label_ja": str(adopted["label_ja"]),
                "file": destination.name,
                "normalized_sha256": sha256(destination),
                "source_kind": "stable_audio",
                "license": LICENSE,
                "creator": source_manifest["model"],
                "landing_url": LICENSE_URL,
                **metrics,
                "adopted_candidate": candidate(adopted),
                "candidates": [candidate(item) for item in candidates],
            }
        )
    if cc0_ids:
        if not cc0_assets_dir or not cc0_master_path or not cc0_manifest_path:
            raise ValueError("CC0 assets, master, and manifest are required for CC0 IDs")
        masters = {item["id"]: item for item in json.loads(cc0_master_path.read_text(encoding="utf-8"))}
        provenance = {item["animal"]: item for item in json.loads(cc0_manifest_path.read_text(encoding="utf-8"))}
        for animal_id in sorted(cc0_ids):
            master = masters[animal_id]
            source = next(item for item in master["sources"] if item["dir"] == "cc0")
            source_path = cc0_assets_dir / source["file"]
            source_entry = provenance[animal_id]
            tracked_source_sha256 = sha256(source_path)
            destination = output_dir / f"{animal_id}.wav"
            metrics = normalize(source_path, destination)
            if not (0.15 <= float(metrics["duration_seconds"]) <= 5.01):
                raise ValueError(f"unexpected CC0 duration: {destination}")
            animals.append(
                {
                    "id": animal_id,
                    "label_ja": master["label_ja"],
                    "file": destination.name,
                    "normalized_sha256": sha256(destination),
                    "source_kind": "cc0_migration_fallback",
                    "license": "CC0 1.0",
                    "creator": source_entry["creator"],
                    "landing_url": source_entry["landing_url"],
                    "provenance_sha256": source_entry["sha256"],
                    **metrics,
                    "adopted_candidate": {
                        "variant": 1,
                        "seed": 0,
                        "prompt": source_entry["title"],
                        "source_file": source["file"],
                        "source_sha256": tracked_source_sha256,
                        "receipt_file": "",
                    },
                    "candidates": [],
                }
            )
    animals.sort(key=lambda animal: str(animal["id"]))
    total_bytes = sum((output_dir / str(animal["file"])).stat().st_size for animal in animals)
    if total_bytes > MAX_OUTPUT_BYTES:
        raise ValueError(f"normalized audio exceeds {MAX_OUTPUT_BYTES} bytes: {total_bytes}")
    manifest = {
        "schema_version": 1,
        "generated_from": "Stable Audio receipt manifest; variant 1 selected deterministically",
        "selection_policy": "Use variant 1 for each species; retain both candidate receipts in this manifest.",
        "model": source_manifest["model"],
        "model_revision": source_manifest["model_revision"],
        "license": "Mixed; see each animal entry",
        "license_url": LICENSE_URL,
        "notice": NOTICE,
        "animals": animals,
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--cc0-assets-dir", type=Path)
    parser.add_argument("--cc0-master", type=Path)
    parser.add_argument("--cc0-manifest", type=Path)
    parser.add_argument("--include-cc0", nargs="*", default=[])
    args = parser.parse_args()
    run(
        args.source_dir.resolve(),
        args.output_dir.resolve(),
        args.cc0_assets_dir.resolve() if args.cc0_assets_dir else None,
        args.cc0_master.resolve() if args.cc0_master else None,
        args.cc0_manifest.resolve() if args.cc0_manifest else None,
        tuple(args.include_cc0),
    )


if __name__ == "__main__":
    main()
