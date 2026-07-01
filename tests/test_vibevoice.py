from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from mo_speech.vibevoice import (
    RunpodServerlessVibeVoiceService,
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


def test_vibevoice_service_defaults_do_not_use_legacy_project_paths(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.delenv("MO_VIBEVOICE_PYTHON", raising=False)
    monkeypatch.delenv("MO_VIBEVOICE_CLI", raising=False)
    monkeypatch.delenv("MO_VIBEVOICE_HOME", raising=False)
    monkeypatch.delenv("VIBEVOICE_HOME", raising=False)
    monkeypatch.delenv("MO_COMFYUI_VIBEVOICE_PATH", raising=False)
    monkeypatch.delenv("COMFYUI_VIBEVOICE_PATH", raising=False)
    monkeypatch.setenv("MODEL_CACHE_DIR", str(tmp_path / "models"))

    service = VibeVoiceService()

    assert service.python == sys.executable
    assert service.vibevoice_home == tmp_path / "models" / "vibevoice" / "huggingface" / "hub"
    assert service.comfyui_vibevoice_path == tmp_path / "models" / "vibevoice" / "ComfyUI-VibeVoice"
    assert "/ComfyUI" not in str(service.vibevoice_home)
    assert "/ComfyUI" not in str(service.comfyui_vibevoice_path.parent)


def test_runpod_vibevoice_service_submits_generation_payload(tmp_path: Path) -> None:
    class FakeClient:
        configured = True
        endpoint_id = "endpoint"
        request_mode = "async"

        def __init__(self):
            self.payload = None

        def submit(self, payload):
            self.payload = payload
            return {
                "audio_mime_type": "audio/wav",
                "audio_base64": "UklGRg==",
                "normalized_script": "Speaker 1: 你好。",
                "timings_ms": {"vibevoice": 3.0},
                "providers": {"vibevoice": "runpod-serverless-vibevoice"},
            }

    voice = tmp_path / "voice.wav"
    voice.write_bytes(b"voice")
    client = FakeClient()
    service = RunpodServerlessVibeVoiceService(client=client)

    result = service.generate(
        script_text="你好。",
        voice_paths=[voice],
        options=VibeVoiceGenerationOptions(inference_steps=2, do_sample=False),
    )

    assert result.audio_bytes == b"RIFF"
    assert client.payload["operation_mode"] == "vibevoice"
    assert client.payload["script"] == "Speaker 1: 你好。"
    assert client.payload["generation"]["inference_steps"] == 2
    assert client.payload["generation"]["do_sample"] is False
    assert client.payload["voices"][0]["audio_base64"] != ""
