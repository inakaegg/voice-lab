from __future__ import annotations

import os
from pathlib import Path

from mo_speech.env import load_project_env


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


def test_load_project_env_ignores_missing_file(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    load_project_env(env_file=tmp_path / "missing.env")

    assert "OPENAI_API_KEY" not in os.environ
