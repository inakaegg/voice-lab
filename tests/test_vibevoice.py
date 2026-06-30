from __future__ import annotations

import subprocess
from pathlib import Path

from mo_speech.vibevoice import (
    VibeVoiceGenerationOptions,
    VibeVoiceService,
    normalize_vibevoice_script,
)


def test_normalize_vibevoice_script_adds_speaker_tag_per_plain_line() -> None:
    assert normalize_vibevoice_script("你好。\n今天喝茶。") == "Speaker 1: 你好。\nSpeaker 1: 今天喝茶。"
    assert normalize_vibevoice_script("Speaker 2: 你好。") == "Speaker 2: 你好。"


def test_vibevoice_service_builds_cli_command_and_env(tmp_path: Path) -> None:
    calls: list[tuple[list[str], dict[str, str]]] = []
    cli = tmp_path / "vibevoice.py"
    cli.write_text("# cli", encoding="utf-8")
    home = tmp_path / "models"
    model_dir = home / "models--microsoft--VibeVoice-1.5B" / "snapshots" / "a"
    tokenizer_dir = home / "models--Qwen--Qwen2.5-1.5B" / "snapshots" / "b"
    module_dir = tmp_path / "ComfyUI-VibeVoice"
    model_dir.mkdir(parents=True)
    tokenizer_dir.mkdir(parents=True)
    module_dir.mkdir()
    (model_dir / "model-00001-of-00003.safetensors").write_bytes(b"model")
    (tokenizer_dir / "tokenizer.json").write_text("{}", encoding="utf-8")

    def fake_run(command, *, env, cwd, capture_output, text, timeout, check):
        calls.append((list(command), dict(env)))
        output_index = command.index("--output") + 1
        Path(command[output_index]).write_bytes(b"RIFFfakewav")
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    service = VibeVoiceService(
        python="python3",
        cli_path=cli,
        vibevoice_home=home,
        comfyui_vibevoice_path=module_dir,
        subprocess_run=fake_run,
    )
    voice = tmp_path / "voice.wav"
    voice.write_bytes(b"voice")

    result = service.generate(
        script_text="你好。",
        voice_paths=[voice],
        options=VibeVoiceGenerationOptions(inference_steps=3, seed=7, line_by_line=True, line_gap=0.25),
    )

    assert result.audio_bytes == b"RIFFfakewav"
    assert result.normalized_script == "Speaker 1: 你好。"
    command, env = calls[0]
    assert command[:2] == ["python3", str(cli)]
    assert "--text_file" in command
    assert "--voice" in command
    assert str(voice) in command
    assert "--line_by_line" in command
    assert "concat" in command
    assert "--line_gap" in command
    assert "0.25" in command
    assert env["VIBEVOICE_HOME"] == str(home)
    assert env["COMFYUI_VIBEVOICE_PATH"] == str(module_dir)


def test_vibevoice_service_status_reports_missing_assets(tmp_path: Path) -> None:
    service = VibeVoiceService(
        cli_path=tmp_path / "missing.py",
        vibevoice_home=tmp_path / "models",
        comfyui_vibevoice_path=tmp_path / "missing-module",
    )

    status = service.status()

    assert status["available"] is False
    assert status["cli_exists"] is False
    assert status["comfyui_vibevoice_exists"] is False
    assert status["model_cache_found"] is False
    assert status["tokenizer_found"] is False
