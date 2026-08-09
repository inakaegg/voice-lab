"""鳴き声素材を集める・組み立てるスクリプトの、素材を持たなくても確かめられる部分のテスト。

いずれも取得条件を伴う手動スクリプトなので、ネットワークも実素材も使わない範囲だけを見る。
"""

import hashlib
import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"


def load_script(name: str) -> types.ModuleType:
    # スクリプト同士が隣のファイルを直接importするため、scripts/ を検索パスへ入れる。
    if str(SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPTS_DIR))
    spec = importlib.util.spec_from_file_location(name, SCRIPTS_DIR / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_openverse_license_slugs_survive_the_allowlist() -> None:
    """Openverse は CC BY を `by` という slug で返すため、許可判定と同じ表記へ直す。"""
    fetch = load_script("fetch_animal_recordings")

    assert fetch.openverse_license_name("by", "4.0") == "CC BY 4.0"
    assert fetch.openverse_license_name("cc0", "1.0") == "CC0 1.0"
    assert fetch.openverse_license_name("pdm", "1.0") == "Public Domain Mark 1.0"
    assert fetch.openverse_license_name("", "4.0") == ""

    assert fetch.license_is_allowed(fetch.openverse_license_name("by", "4.0"))
    assert fetch.license_is_allowed(fetch.openverse_license_name("cc0", "1.0"))
    # 商用禁止と同条件公開は落としたままにする。
    assert not fetch.license_is_allowed(fetch.openverse_license_name("by-sa", "4.0"))
    assert not fetch.license_is_allowed(fetch.openverse_license_name("by-nc", "4.0"))
    assert not fetch.license_is_allowed(fetch.openverse_license_name("by-nd", "4.0"))


def write_candidate(directory: Path, payload: bytes, recorded_sha: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    candidate = directory / "candidate01.wav"
    candidate.write_bytes(payload)
    (directory / "candidates.json").write_text(
        json.dumps(
            {
                "candidates": [
                    {
                        "file": candidate.name,
                        "sha256": recorded_sha,
                        "license": "CC0 1.0",
                        "creator": "someone",
                        "landing_url": "https://example.com/sound",
                        "download_url": "https://example.com/sound.wav",
                        "title": "sound",
                        "provider": "openverse:freesound",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    return candidate


def test_build_real_recordings_rejects_a_candidate_that_changed_after_download(tmp_path: Path) -> None:
    """出所の記録と中身が食い違う候補を通すと、manifest に嘘の source_sha256 が残る。"""
    build = load_script("build_real_recordings")
    payload = b"changed audio bytes"
    stale_sha = hashlib.sha256(b"the bytes that were downloaded").hexdigest()
    candidate = write_candidate(tmp_path / "candidates" / "dog", payload, stale_sha)

    selection = tmp_path / "selection.json"
    selection.write_text(
        json.dumps(
            {
                "animals": [
                    {
                        "id": "dog",
                        "label_ja": "犬",
                        "candidate": str(candidate),
                        "reason": "テスト用",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="取得時と違う"):
        build.run(selection, tmp_path / "real-recordings")


def test_select_animal_sounds_reads_the_directory_it_is_given(tmp_path: Path) -> None:
    """素材ディレクトリは引数で受け取る。リポジトリ内の固定パスを黙って読まない。"""
    select = load_script("select_animal_sounds")

    with pytest.raises(SystemExit):
        select.main([str(tmp_path / "missing")])

    sources = tmp_path / "sources"
    (sources / "processed" / "taira-komori-selected").mkdir(parents=True)
    (sources / "processed" / "cc0").mkdir(parents=True)
    (sources / "processed" / "cc0-manifest.jsonl").write_text("", encoding="utf-8")
    (sources / "real-recordings").mkdir(parents=True)
    (sources / "real-recordings" / "manifest.json").write_text(
        json.dumps({"animals": []}), encoding="utf-8"
    )
    (sources / "animal-sound-freesound").mkdir(parents=True)
    (sources / "animal-sound-freesound" / "trim-manifest.json").write_text(
        json.dumps({"species": {}}), encoding="utf-8"
    )

    assert select.main([str(sources)]) == 0
    manifest = json.loads((sources / "final" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["animal_count"] == 0
