"""Zoovoiceのbuild資材CLI（取得・アップロード・アーカイブ作成）の検査。

資材そのものは巨大でrepositoryにも無いため、実物と同じ形の小さなfixtureで動かす。
期待するSHA-256は `scripts/zoovoice_artifacts_common.sh` の定数なので、
テストはその定数だけを差し替えた複製のscriptディレクトリを使う。ロジックは同一である。
"""

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
COMMON = "zoovoice_artifacts_common.sh"
BUILDER = "build_zoovoice_sounds_archive.py"
FETCH = "fetch_zoovoice_artifacts.sh"
UPLOAD = "upload_zoovoice_artifacts.sh"

REAL_MODEL_SHA = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"
REAL_SOUNDS_SHA = "c60cf12c5c9fa0bcd6aa272b8b0fb1f4632711f865761aaeac42d7de8f2f6329"


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_sounds_fixture(directory: Path) -> Path:
    """実物と同じ構成（manifest.json + 動物ごとのディレクトリ）の小さな音源セットを作る。"""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "cat").mkdir(exist_ok=True)
    audio = directory / "cat" / "cat-1.wav"
    audio.write_bytes(b"RIFF" + b"\x00" * 60)
    manifest = {
        "schema_version": 1,
        "animals": [
            {
                "id": "cat",
                "label_ja": "猫",
                "files": [
                    {
                        "file": "cat/cat-1.wav",
                        "license": "CC0 1.0",
                        "creator": "someone",
                        "source_url": "https://example.com/cat",
                        "sha256": sha256_of(audio),
                    }
                ],
            }
        ],
    }
    (directory / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return directory


def install_scripts(destination: Path, model_sha: str, sounds_sha: str) -> Path:
    """定数だけを差し替えたscriptディレクトリを作る。"""
    destination.mkdir(parents=True, exist_ok=True)
    for name in (COMMON, BUILDER, FETCH, UPLOAD):
        shutil.copy2(SCRIPTS / name, destination / name)
    common = destination / COMMON
    text = common.read_text(encoding="utf-8")
    text = text.replace(REAL_MODEL_SHA, model_sha).replace(REAL_SOUNDS_SHA, sounds_sha)
    common.write_text(text, encoding="utf-8")
    return destination


def install_fake_gcloud(bin_directory: Path, payloads: dict[str, Path], missing: set[str]) -> Path:
    """gcloud storage cp を偽装する。payloadsのobject名に対応するファイルを複製する。"""
    bin_directory.mkdir(parents=True, exist_ok=True)
    log = bin_directory / "gcloud.log"
    lines = ["#!/usr/bin/env bash", "set -eu", f'printf "%s\\n" "$*" >> {log}']
    lines.append('if [ "${1:-}" = "storage" ]; then')
    lines.append("  source_object=\"\"; target=\"\"")
    lines.append("  for argument in \"$@\"; do")
    lines.append('    case "$argument" in gs://*) source_object="$argument" ;; /*) target="$argument" ;; esac')
    lines.append("  done")
    for name in sorted(missing):
        lines.append(f'  case "$source_object" in *{name}) exit 1 ;; esac')
    for name, path in sorted(payloads.items()):
        lines.append(f'  case "$source_object" in *{name}) cp "{path}" "$target"; exit 0 ;; esac')
    lines.append("  exit 1")
    lines.append("fi")
    lines.append("exit 0")
    fake = bin_directory / "gcloud"
    fake.write_text("\n".join(lines) + "\n", encoding="utf-8")
    fake.chmod(0o755)
    return log


def run_fetch(scripts: Path, artifacts_dir: Path, bin_directory: Path):
    environment = dict(os.environ)
    environment["PATH"] = f"{bin_directory}:{environment['PATH']}"
    environment["ZOOVOICE_ARTIFACTS_DIR"] = str(artifacts_dir)
    return subprocess.run(
        ["bash", str(scripts / FETCH)],
        env=environment, text=True, capture_output=True, check=False,
    )


# --- アーカイブ作成 ---------------------------------------------------------


def test_archive_is_reproducible_across_output_names(tmp_path: Path) -> None:
    """出力ファイル名が違っても同じSHA-256になる。gzip headerへ名前が入る罠を塞ぐ。"""
    source = make_sounds_fixture(tmp_path / "sounds")
    first = tmp_path / "first-name.tar.gz"
    second = tmp_path / "totally-different.tar.gz"
    for target in (first, second):
        subprocess.run(
            ["python3", str(SCRIPTS / BUILDER), str(source), str(target)],
            check=True, capture_output=True, text=True,
        )
    assert sha256_of(first) == sha256_of(second)


def test_archive_requires_manifest(tmp_path: Path) -> None:
    source = tmp_path / "sounds"
    source.mkdir()
    (source / "cat.wav").write_bytes(b"RIFF")
    result = subprocess.run(
        ["python3", str(SCRIPTS / BUILDER), str(source), str(tmp_path / "out.tar.gz")],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode != 0
    assert "manifest.json" in result.stderr


# --- 取得 -------------------------------------------------------------------


@pytest.fixture()
def prepared(tmp_path: Path):
    sounds = make_sounds_fixture(tmp_path / "sounds")
    archive = tmp_path / "sounds.tar.gz"
    subprocess.run(
        ["python3", str(SCRIPTS / BUILDER), str(sounds), str(archive)],
        check=True, capture_output=True, text=True,
    )
    model = tmp_path / "ggml-small.bin"
    model.write_bytes(b"fake model bytes")
    scripts = install_scripts(tmp_path / "scripts", sha256_of(model), sha256_of(archive))
    return scripts, model, archive


def test_fetch_downloads_and_verifies(tmp_path: Path, prepared) -> None:
    scripts, model, archive = prepared
    install_fake_gcloud(
        tmp_path / "bin",
        {"ggml-small-1be3a9b20638.bin": model, "zoovoice-sounds-c60cf12c5c9f.tar.gz": archive},
        missing=set(),
    )
    artifacts = tmp_path / "artifacts"
    result = run_fetch(scripts, artifacts, tmp_path / "bin")

    assert result.returncode == 0, result.stderr
    assert (artifacts / "ggml-small.bin").is_file()
    assert (artifacts / "sounds" / "manifest.json").is_file()
    assert f"ZOOVOICE_ASR_MODEL_PATH={artifacts / 'ggml-small.bin'}" in result.stdout
    assert f"ZOOVOICE_SOUNDS_DIR={artifacts / 'sounds'}" in result.stdout


def test_fetch_fails_on_sha256_mismatch(tmp_path: Path, prepared) -> None:
    scripts, _model, archive = prepared
    tampered = tmp_path / "tampered.bin"
    tampered.write_bytes(b"different bytes entirely")
    install_fake_gcloud(
        tmp_path / "bin",
        {"ggml-small-1be3a9b20638.bin": tampered, "zoovoice-sounds-c60cf12c5c9f.tar.gz": archive},
        missing=set(),
    )
    result = run_fetch(scripts, tmp_path / "artifacts", tmp_path / "bin")

    assert result.returncode != 0
    assert "SHA-256が期待値と一致しません" in result.stderr


def test_fetch_fails_when_object_is_missing(tmp_path: Path, prepared) -> None:
    scripts, _model, archive = prepared
    install_fake_gcloud(
        tmp_path / "bin",
        {"zoovoice-sounds-c60cf12c5c9f.tar.gz": archive},
        missing={"ggml-small-1be3a9b20638.bin"},
    )
    result = run_fetch(scripts, tmp_path / "artifacts", tmp_path / "bin")

    assert result.returncode != 0
    assert "取得できませんでした" in result.stderr


def test_fetch_skips_download_when_already_verified(tmp_path: Path, prepared) -> None:
    """再実行を安くする。判定はファイルの有無ではなくSHA-256の一致で行う。"""
    scripts, model, archive = prepared
    log = install_fake_gcloud(
        tmp_path / "bin",
        {"ggml-small-1be3a9b20638.bin": model, "zoovoice-sounds-c60cf12c5c9f.tar.gz": archive},
        missing=set(),
    )
    artifacts = tmp_path / "artifacts"
    assert run_fetch(scripts, artifacts, tmp_path / "bin").returncode == 0
    first_calls = log.read_text(encoding="utf-8").count("storage cp")
    assert run_fetch(scripts, artifacts, tmp_path / "bin").returncode == 0
    assert log.read_text(encoding="utf-8").count("storage cp") == first_calls


# --- アップロード -----------------------------------------------------------


def run_upload(scripts: Path, model: Path, sounds: Path, bin_directory: Path, apply: str):
    environment = dict(os.environ)
    environment["PATH"] = f"{bin_directory}:{environment['PATH']}"
    environment["ZOOVOICE_ASR_MODEL_PATH"] = str(model)
    environment["ZOOVOICE_SOUNDS_DIR"] = str(sounds)
    environment["ZOOVOICE_ARTIFACTS_UPLOAD_APPLY"] = apply
    return subprocess.run(
        ["bash", str(scripts / UPLOAD)],
        env=environment, text=True, capture_output=True, check=False,
    )


def test_upload_dry_run_does_not_write(tmp_path: Path, prepared) -> None:
    scripts, model, _archive = prepared
    log = install_fake_gcloud(tmp_path / "bin", {}, missing=set())
    result = run_upload(scripts, model, tmp_path / "sounds", tmp_path / "bin", "0")

    assert result.returncode == 0, result.stderr
    assert "[dry-run]" in result.stdout
    assert "storage cp" not in (log.read_text(encoding="utf-8") if log.exists() else "")


def test_upload_stops_before_remote_write_on_model_mismatch(tmp_path: Path, prepared) -> None:
    scripts, _model, _archive = prepared
    wrong = tmp_path / "wrong-model.bin"
    wrong.write_bytes(b"not the model")
    log = install_fake_gcloud(tmp_path / "bin", {}, missing=set())
    result = run_upload(scripts, wrong, tmp_path / "sounds", tmp_path / "bin", "1")

    assert result.returncode != 0
    assert "SHA-256が期待値と一致しません" in result.stderr
    assert "storage cp" not in (log.read_text(encoding="utf-8") if log.exists() else "")
