from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from threading import Event

from mo_speech.vibevoice import (
    RunpodServerlessVibeVoiceService,
    VIBEVOICE_MODEL_PRESETS,
    VibeVoiceGenerationOptions,
    VibeVoiceError,
    VibeVoiceService,
    VibeVoiceVoiceSample,
    resolve_vibevoice_model_preset,
    normalize_vibevoice_script,
)


def test_normalize_vibevoice_script_adds_speaker_tag_per_plain_line() -> None:
    assert normalize_vibevoice_script("你好。\n今天喝茶。") == "Speaker 1: 你好。\nSpeaker 1: 今天喝茶。"
    assert normalize_vibevoice_script("Speaker 2: 你好。") == "Speaker 2: 你好。"


def test_normalize_vibevoice_script_accepts_short_speaker_tags() -> None:
    assert normalize_vibevoice_script(
        "\n".join(
            [
                "1: こんにちは。",
                "2 今日はどこへ行きますか？",
                "A: Hello.",
                "B Good morning.",
                "タグなし。",
            ]
        )
    ) == "\n".join(
        [
            "Speaker 1: こんにちは。",
            "Speaker 2: 今日はどこへ行きますか？",
            "Speaker 1: Hello.",
            "Speaker 2: Good morning.",
            "Speaker 1: タグなし。",
        ]
    )


def test_normalize_vibevoice_script_does_not_treat_content_as_short_tag() -> None:
    assert normalize_vibevoice_script("I want coffee.\n2026 年の話です。") == "\n".join(
        [
            "Speaker 1: I want coffee.",
            "Speaker 1: 2026 年の話です。",
        ]
    )


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
        options=VibeVoiceGenerationOptions(
            model_id="vibevoice-1.5b-latest",
            inference_steps=3,
            seed=7,
            line_by_line=True,
            line_gap=0.25,
        ),
    )

    assert result.audio_bytes == b"RIFFfakewav"
    assert result.normalized_script == "Speaker 1: 你好。"
    command, env = calls[0]
    assert command[:2] == ["python3", str(cli)]
    assert "--text_file" in command
    assert "--voice1_file" in command
    assert "--voice" not in command
    assert str(voice) in command
    assert "--line_by_line" in command
    assert "concat" in command
    assert "--line_gap" in command
    assert "0.25" in command
    assert env["VIBEVOICE_HOME"] == str(home)
    assert env["COMFYUI_VIBEVOICE_PATH"] == str(module_dir)
    assert env["VIBEVOICE_MODEL_REPO"] == "microsoft/VibeVoice-1.5B"
    assert env["VIBEVOICE_MODEL_REVISION"] == ""
    assert env["VIBEVOICE_TOKENIZER_REPO"] == "Qwen/Qwen2.5-1.5B"
    assert env["VIBEVOICE_TOKENIZER_REVISION"] == ""
    assert result.providers["vibevoice_model_id"] == "vibevoice-1.5b-latest"


def test_vibevoice_service_auto_enables_line_by_line_for_long_scripts(tmp_path: Path) -> None:
    calls: list[list[str]] = []
    cli = tmp_path / "vibevoice.py"
    cli.write_text("# cli", encoding="utf-8")
    home = tmp_path / "models"
    module_dir = tmp_path / "ComfyUI-VibeVoice"
    home.mkdir()
    module_dir.mkdir()

    def fake_run(command, *, env, cwd, capture_output, text, timeout, check):
        calls.append(list(command))
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
    voice1 = tmp_path / "voice1.wav"
    voice2 = tmp_path / "voice2.wav"
    voice1.write_bytes(b"voice1")
    voice2.write_bytes(b"voice2")

    service.generate(
        script_text="\n".join(
            [
                "1 こんにちは。",
                "2 はい。",
                "1 北海道の話をしましょう。",
                "2 温泉も近くにあります。",
            ]
        ),
        voice_paths=[VibeVoiceVoiceSample(slot=1, path=voice1), VibeVoiceVoiceSample(slot=2, path=voice2)],
        options=VibeVoiceGenerationOptions(line_by_line=False),
    )

    command = calls[0]
    assert "--line_by_line" in command
    assert "concat" in command


def test_vibevoice_service_preserves_explicit_speaker_slots(tmp_path: Path) -> None:
    calls: list[list[str]] = []
    cli = tmp_path / "vibevoice.py"
    cli.write_text("# cli", encoding="utf-8")
    home = tmp_path / "models"
    module_dir = tmp_path / "ComfyUI-VibeVoice"
    home.mkdir()
    module_dir.mkdir()

    def fake_run(command, *, env, cwd, capture_output, text, timeout, check):
        calls.append(list(command))
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
    voice = tmp_path / "voice2.wav"
    voice.write_bytes(b"voice2")

    service.generate(
        script_text="Speaker 2: 你好。",
        voice_paths=[VibeVoiceVoiceSample(slot=2, path=voice)],
    )

    command = calls[0]
    assert "--voice2_file" in command
    assert str(voice) in command
    assert "--voice1_file" not in command
    assert "--voice" not in command


def test_vibevoice_service_reports_timeout_explicitly(tmp_path: Path) -> None:
    cli = tmp_path / "vibevoice.py"
    cli.write_text("# cli", encoding="utf-8")
    home = tmp_path / "models"
    module_dir = tmp_path / "ComfyUI-VibeVoice"
    home.mkdir()
    module_dir.mkdir()

    def fake_run(command, *, env, cwd, capture_output, text, timeout, check):
        raise subprocess.TimeoutExpired(command, timeout)

    service = VibeVoiceService(
        python="python3",
        cli_path=cli,
        vibevoice_home=home,
        comfyui_vibevoice_path=module_dir,
        timeout_seconds=7,
        subprocess_run=fake_run,
    )
    voice = tmp_path / "voice.wav"
    voice.write_bytes(b"voice")

    try:
        service.generate(script_text="你好。", voice_paths=[voice])
    except VibeVoiceError as exc:
        assert "timed out after 7s" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("VibeVoiceError was not raised")


def test_vibevoice_service_keeps_timeout_when_cancel_event_controls_job(tmp_path: Path) -> None:
    captured_timeouts: list[float | None] = []
    cli = tmp_path / "vibevoice.py"
    cli.write_text("# cli", encoding="utf-8")
    home = tmp_path / "models"
    module_dir = tmp_path / "ComfyUI-VibeVoice"
    home.mkdir()
    module_dir.mkdir()

    def fake_run(command, *, env, cwd, capture_output, text, timeout, check):
        captured_timeouts.append(timeout)
        output_index = command.index("--output") + 1
        Path(command[output_index]).write_bytes(b"RIFFfakewav")
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    service = VibeVoiceService(
        python="python3",
        cli_path=cli,
        vibevoice_home=home,
        comfyui_vibevoice_path=module_dir,
        timeout_seconds=7,
        subprocess_run=fake_run,
    )
    voice = tmp_path / "voice.wav"
    voice.write_bytes(b"voice")

    service.generate(script_text="你好。", voice_paths=[voice], cancel_event=Event())

    assert captured_timeouts == [7]


def test_vibevoice_service_streams_cli_progress_from_stderr(tmp_path: Path) -> None:
    cli = tmp_path / "fake_vibevoice_cli.py"
    cli.write_text(
        "\n".join(
            [
                "from pathlib import Path",
                "import sys",
                "import time",
                "output = Path(sys.argv[sys.argv.index('--output') + 1])",
                "sys.stderr.write('2026-07-02 00:00:00,000 - INFO - VibeVoice生成token上限: 32\\n')",
                "sys.stderr.flush()",
                "for current, percent in [(1, 3), (16, 50), (32, 100)]:",
                "    sys.stderr.write(f'\\rGenerating (active: 1/1): {percent:3d}%|###| {current}/32 [00:01<00:00, 1.00it/s]')",
                "    sys.stderr.flush()",
                "    time.sleep(0.01)",
                "sys.stderr.write('\\n')",
                "sys.stderr.flush()",
                "output.write_bytes(b'RIFFfakewav')",
            ]
        ),
        encoding="utf-8",
    )
    home = tmp_path / "models"
    module_dir = tmp_path / "ComfyUI-VibeVoice"
    home.mkdir()
    module_dir.mkdir()
    service = VibeVoiceService(
        python=sys.executable,
        cli_path=cli,
        vibevoice_home=home,
        comfyui_vibevoice_path=module_dir,
        timeout_seconds=5,
    )
    voice = tmp_path / "voice.wav"
    voice.write_bytes(b"voice")
    progress: list[tuple[str, str]] = []

    result = service.generate(
        script_text="Speaker 1: こんにちは。",
        voice_paths=[voice],
        progress_callback=lambda stage, label: progress.append((stage, label)),
    )

    assert result.audio_bytes == b"RIFFfakewav"
    assert any(stage == "generation" and "16/32" in label for stage, label in progress)
    assert any(stage == "generation" and "32/32" in label for stage, label in progress)
    assert "32/32" in result.diagnostics["stderr_tail"]


def test_vibevoice_model_presets_include_only_skit_verified_candidates() -> None:
    assert set(VIBEVOICE_MODEL_PRESETS) == {
        "vibevoice-1.5b-pinned",
        "vibevoice-1.5b-latest",
    }
    pinned = resolve_vibevoice_model_preset("vibevoice-1.5b-pinned")
    latest = resolve_vibevoice_model_preset("vibevoice-1.5b-latest")
    assert pinned.model_repo == "microsoft/VibeVoice-1.5B"
    assert pinned.model_revision == "1904eae38036e9c780d28e27990c27748984eafe"
    assert latest.model_repo == "microsoft/VibeVoice-1.5B"
    assert latest.model_revision is None


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


def test_vibevoice_service_status_ignores_no_exist_zero_byte_weights(tmp_path: Path) -> None:
    cli = tmp_path / "vibevoice.py"
    cli.write_text("# cli", encoding="utf-8")
    home = tmp_path / "models"
    module_dir = tmp_path / "ComfyUI-VibeVoice"
    no_exist = home / "models--microsoft--VibeVoice-1.5B" / ".no_exist" / "revision"
    snapshot = home / "models--microsoft--VibeVoice-1.5B" / "snapshots" / "revision"
    tokenizer_dir = home / "models--Qwen--Qwen2.5-1.5B" / "snapshots" / "tokenizer-revision"
    module_dir.mkdir(parents=True)
    no_exist.mkdir(parents=True)
    snapshot.mkdir(parents=True)
    tokenizer_dir.mkdir(parents=True)
    (no_exist / "model.safetensors").write_bytes(b"")
    (snapshot / "model-00001-of-00003.safetensors").write_bytes(b"model")
    (tokenizer_dir / "tokenizer.json").write_text("{}", encoding="utf-8")

    service = VibeVoiceService(
        cli_path=cli,
        vibevoice_home=home,
        comfyui_vibevoice_path=module_dir,
    )

    status = service.status()

    assert status["available"] is True
    assert status["model_cache_found"] is True
    assert status["model_cache_path"] == str(snapshot)


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


def test_runpod_vibevoice_service_status_reads_connection_keys_from_runpod_env_file(
    tmp_path: Path,
    monkeypatch,
) -> None:
    runpod_env_file = tmp_path / ".runpod.env"
    runpod_env_file.write_text(
        "\n".join(
            [
                "RUNPOD_ENDPOINT_ID=endpoint-from-file",
                "RUNPOD_API_KEY=secret-from-file",
                "RUNPOD_SERVERLESS_REQUEST_MODE=sync",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("RUNPOD_ENV_FILE", str(runpod_env_file))
    monkeypatch.delenv("RUNPOD_ENDPOINT_ID", raising=False)
    monkeypatch.delenv("RUNPOD_API_KEY", raising=False)
    monkeypatch.delenv("RUNPOD_SERVERLESS_REQUEST_MODE", raising=False)

    status = RunpodServerlessVibeVoiceService.from_env().status()

    assert status["available"] is True
    assert status["endpoint_id"] == "endpoint-from-file"
    assert status["request_mode"] == "sync"


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
        options=VibeVoiceGenerationOptions(
            model_id="vibevoice-1.5b-latest",
            inference_steps=2,
            do_sample=False,
        ),
    )

    assert result.audio_bytes == b"RIFF"
    assert client.payload["operation_mode"] == "vibevoice"
    assert client.payload["script"] == "Speaker 1: 你好。"
    assert client.payload["generation"]["inference_steps"] == 2
    assert client.payload["generation"]["do_sample"] is False
    assert client.payload["generation"]["model_id"] == "vibevoice-1.5b-latest"
    assert client.payload["voices"][0]["audio_base64"] != ""
    assert client.payload["voices"][0]["speaker"] == 1


def test_runpod_vibevoice_service_auto_enables_line_by_line_for_long_scripts(tmp_path: Path) -> None:
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
                "normalized_script": payload["script"],
                "timings_ms": {"vibevoice": 3.0},
                "providers": {"vibevoice": "runpod-serverless-vibevoice"},
            }

    voice = tmp_path / "voice.wav"
    voice.write_bytes(b"voice")
    client = FakeClient()
    service = RunpodServerlessVibeVoiceService(client=client)

    service.generate(
        script_text="\n".join(
            [
                "Speaker 1: こんにちは。",
                "Speaker 1: はい。",
                "Speaker 1: 北海道の話をしましょう。",
                "Speaker 1: 温泉も近くにあります。",
            ]
        ),
        voice_paths=[voice],
        options=VibeVoiceGenerationOptions(line_by_line=False),
    )

    assert client.payload["generation"]["line_by_line"] is True
