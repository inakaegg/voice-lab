#!/usr/bin/env python3
"""ConceptNet全ダンプから日本語⇔日本語のエッジだけを抜き出してSQLite化する。

多hop探索の実験用。本番indexとは別物で、フィルタ（27動物限定）をかけない。
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sqlite3
import time
from pathlib import Path


def concept_label(uri: str) -> str | None:
    if not uri.startswith("/c/ja/"):
        return None
    rest = uri[len("/c/ja/"):]
    return rest.split("/", 1)[0].replace("_", " ")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    started = time.monotonic()
    args.output.unlink(missing_ok=True)
    db = sqlite3.connect(args.output)
    db.executescript(
        """
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        CREATE TABLE edges (
          start TEXT NOT NULL,
          end TEXT NOT NULL,
          relation TEXT NOT NULL,
          weight REAL NOT NULL
        );
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """
    )

    sha = hashlib.sha256()
    line_count = 0
    edge_count = 0
    batch = []
    with gzip.open(args.source, "rt", encoding="utf-8") as handle:
        for line in handle:
            line_count += 1
            fields = line.rstrip("\n").split("\t")
            if len(fields) < 5:
                continue
            start = concept_label(fields[2])
            end = concept_label(fields[3])
            if start is None or end is None or start == end:
                continue
            relation = fields[1].removeprefix("/r/")
            try:
                weight = float(json.loads(fields[4]).get("weight", 0))
            except (json.JSONDecodeError, TypeError, ValueError):
                continue
            if weight <= 0:
                continue
            batch.append((start, end, relation, weight))
            edge_count += 1
            if len(batch) >= 50000:
                db.executemany("INSERT INTO edges VALUES(?,?,?,?)", batch)
                batch.clear()
    if batch:
        db.executemany("INSERT INTO edges VALUES(?,?,?,?)", batch)

    with args.source.open("rb") as raw:
        for chunk in iter(lambda: raw.read(1024 * 1024), b""):
            sha.update(chunk)

    db.execute("CREATE INDEX edges_start_idx ON edges(start)")
    db.execute("CREATE INDEX edges_end_idx ON edges(end)")
    for key, value in {
        "schema_version": "1",
        "source_sha256": sha.hexdigest(),
        "transformation": "all ConceptNet ja-to-ja edges, unfiltered",
        "edge_count": str(edge_count),
        "lines_processed": str(line_count),
    }.items():
        db.execute("INSERT INTO metadata VALUES(?,?)", (key, value))
    db.commit()
    db.close()
    print(f"edges={edge_count} lines={line_count} seconds={time.monotonic()-started:.0f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
