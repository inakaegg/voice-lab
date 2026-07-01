from __future__ import annotations

import os
from pathlib import Path

from mo_speech.env import _candidate_env_files, load_project_env, load_runpod_gateway_env


def test_load_project_env_reads_key_values_without_overriding(tmp_path: Path, monkeypatch) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "\n".join(
            [
                "# ignored",
                "OPENAI_API_KEY=from-file",
                "MO_TEST_TTS_VOICE=\"verse\"",
                "MO_TEST_TTS_INSTRUCTIONS='Speak clearly # not a comment'",
                "export MO_TEST_PROVIDER_MODE=local",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("OPENAI_API_KEY", "from-shell")
    monkeypatch.delenv("MO_TEST_TTS_VOICE", raising=False)
    monkeypatch.delenv("MO_TEST_TTS_INSTRUCTIONS", raising=False)
    monkeypatch.delenv("MO_TEST_PROVIDER_MODE", raising=False)

    load_project_env(env_file=env_file)

    assert os.environ["OPENAI_API_KEY"] == "from-shell"
    assert os.environ["MO_TEST_TTS_VOICE"] == "verse"
    assert os.environ["MO_TEST_TTS_INSTRUCTIONS"] == "Speak clearly # not a comment"
    assert os.environ["MO_TEST_PROVIDER_MODE"] == "local"
    os.environ.pop("MO_TEST_TTS_VOICE", None)
    os.environ.pop("MO_TEST_TTS_INSTRUCTIONS", None)
    os.environ.pop("MO_TEST_PROVIDER_MODE", None)


def test_default_project_env_candidates_only_include_app_env(monkeypatch) -> None:
    monkeypatch.delenv("MO_ENV_FILE", raising=False)

    paths = _candidate_env_files(None)

    assert [path.name for path in paths] == [".env"]


def test_load_project_env_reads_multiple_files_without_overriding(tmp_path: Path, monkeypatch) -> None:
    env_file = tmp_path / ".env"
    runpod_env_file = tmp_path / ".runpod.env"
    env_file.write_text(
        "\n".join(
            [
                "OPENAI_API_KEY=from-env-file",
                "RUNPOD_ENDPOINT_ID=endpoint-from-env-file",
            ]
        ),
        encoding="utf-8",
    )
    runpod_env_file.write_text(
        "\n".join(
            [
                "RUNPOD_ENDPOINT_ID=endpoint-from-runpod-env",
                "RUNPOD_API_KEY=runpod-secret",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("OPENAI_API_KEY", "from-shell")
    monkeypatch.delenv("RUNPOD_ENDPOINT_ID", raising=False)
    monkeypatch.delenv("RUNPOD_API_KEY", raising=False)

    load_project_env(env_file=[env_file, runpod_env_file])

    assert os.environ["OPENAI_API_KEY"] == "from-shell"
    assert os.environ["RUNPOD_ENDPOINT_ID"] == "endpoint-from-env-file"
    assert os.environ["RUNPOD_API_KEY"] == "runpod-secret"


def test_load_runpod_gateway_env_reads_connection_keys_only(tmp_path: Path, monkeypatch) -> None:
    runpod_env_file = tmp_path / ".runpod.env"
    runpod_env_file.write_text(
        "\n".join(
            [
                "RUNPOD_ENDPOINT_ID=endpoint-from-runpod-env",
                "RUNPOD_API_KEY=runpod-secret",
                "RUNPOD_SERVERLESS_REQUEST_MODE=sync",
                "MO_PROVIDER_MODE=local",
                "MODEL_CACHE_DIR=/workspace/models",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("RUNPOD_ENV_FILE", str(runpod_env_file))
    monkeypatch.delenv("RUNPOD_ENDPOINT_ID", raising=False)
    monkeypatch.delenv("RUNPOD_API_KEY", raising=False)
    monkeypatch.delenv("RUNPOD_SERVERLESS_REQUEST_MODE", raising=False)
    monkeypatch.delenv("MO_PROVIDER_MODE", raising=False)
    monkeypatch.delenv("MODEL_CACHE_DIR", raising=False)

    load_runpod_gateway_env()

    assert os.environ["RUNPOD_ENDPOINT_ID"] == "endpoint-from-runpod-env"
    assert os.environ["RUNPOD_API_KEY"] == "runpod-secret"
    assert os.environ["RUNPOD_SERVERLESS_REQUEST_MODE"] == "sync"
    assert "MO_PROVIDER_MODE" not in os.environ
    assert "MODEL_CACHE_DIR" not in os.environ


def test_load_project_env_ignores_missing_file(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    load_project_env(env_file=tmp_path / "missing.env")

    assert "OPENAI_API_KEY" not in os.environ
