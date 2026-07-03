from __future__ import annotations

import subprocess
import sys
import wave
from pathlib import Path
from types import SimpleNamespace
from threading import Event

import pytest
import mo_speech.vibevoice as vibevoice_module

from mo_speech.vibevoice import (
    RunpodServerlessVibeVoiceService,
    VIBEVOICE_MODEL_PRESETS,
    VibeVoiceGenerationOptions,
    VibeVoiceError,
    VibeVoiceService,
    VibeVoiceVoiceSample,
    is_vibevoice_model_supported_by_backend,
    resolve_vibevoice_model_preset,
    normalize_vibevoice_directed_line_script,
    normalize_vibevoice_script,
)


class FakeDirectedAsrProvider:
    name = "fake-directed-asr"

    def __init__(self, word_batches: list[list[dict[str, object]]], events: list[str] | None = None):
        self.word_batches = list(word_batches)
        self.calls: list[tuple[Path, str, bool]] = []
        self.events = events

    def transcribe_detail(self, audio_path: Path, source_language: str, *, include_timestamps: bool = False):
        self.calls.append((audio_path, source_language, include_timestamps))
        if self.events is not None:
            self.events.append(f"asr:{audio_path.name}")
        words = self.word_batches.pop(0)
        return SimpleNamespace(
            text="".join(str(item["text"]) for item in words),
            model="fake",
            words=words,
            segments=[],
            has_timestamps=True,
        )

    def release(self) -> None:
        if self.events is not None:
            self.events.append("release-asr")


class FakeDirectedVoiceConversionService:
    def __init__(self, events: list[str] | None = None):
        self.events = events
        self.calls: list[object] = []

    def convert(self, request):
        self.calls.append(request)
        if self.events is not None:
            self.events.append(f"vc:{request.source_audio_path.name}")
        return SimpleNamespace(
            output_audio_bytes=request.source_audio_path.read_bytes(),
            output_audio_mime_type="audio/wav",
            timings_ms={"voice_conversion": 1.0},
            providers={"voice_conversion": "fake-directed-vc"},
            warnings=[],
        )

    def release(self) -> None:
        if self.events is not None:
            self.events.append("release-vc")


def _write_test_wav(path: Path, *, seconds: float = 1.0, sample_value: int = 1200, sample_rate: int = 1000) -> None:
    frame_count = max(1, int(seconds * sample_rate))
    frame = int(sample_value).to_bytes(2, "little", signed=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(frame * frame_count)


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wav:
        return wav.getnframes() / wav.getframerate()


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


def test_normalize_vibevoice_directed_line_script_collapses_one_speaker_with_punctuation() -> None:
    assert normalize_vibevoice_directed_line_script(
        "\n".join(
            [
                "1 あっ、小鸡さん、こんにちは〜",
                "1 こんにちは。ご無沙汰してます",
                "1 最近、北海道に移住したって聞きました",
            ]
        )
    ) == "Speaker 1: あっ、小鸡さん、こんにちは〜、こんにちは。ご無沙汰してます、最近、北海道に移住したって聞きました"


def test_normalize_vibevoice_directed_line_script_rejects_multiple_speakers() -> None:
    with pytest.raises(ValueError, match="複数話者"):
        normalize_vibevoice_directed_line_script("1 こんにちは。\n2 こんにちは。")


def test_directed_asr_provider_defaults_to_openai_whisper_timestamp_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MO_VIBEVOICE_DIRECTED_ASR_PROVIDER", raising=False)
    monkeypatch.delenv("MO_ASR_PROVIDER", raising=False)
    monkeypatch.delenv("MO_VIBEVOICE_DIRECTED_OPENAI_ASR_MODEL", raising=False)

    provider = vibevoice_module._create_directed_asr_provider()

    assert provider.name == "openai-asr-whisper-1"


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


def test_vibevoice_service_directed_line_mode_sends_single_line_without_line_by_line(tmp_path: Path) -> None:
    calls: list[list[str]] = []
    script_texts: list[str] = []
    cli = tmp_path / "vibevoice.py"
    cli.write_text("# cli", encoding="utf-8")
    home = tmp_path / "models"
    module_dir = tmp_path / "ComfyUI-VibeVoice"
    home.mkdir()
    module_dir.mkdir()

    def fake_run(command, *, env, cwd, capture_output, text, timeout, check):
        calls.append(list(command))
        script_texts.append(Path(command[command.index("--text_file") + 1]).read_text(encoding="utf-8"))
        output_index = command.index("--output") + 1
        _write_test_wav(Path(command[output_index]), seconds=1.0)
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    asr = FakeDirectedAsrProvider(
        [
            [
                {"text": "あっこんにちは", "start": 0.0, "end": 0.1},
                {"text": "北海道", "start": 0.2, "end": 0.3},
                {"text": "温泉", "start": 0.4, "end": 0.5},
                {"text": "仕事", "start": 0.6, "end": 0.7},
            ]
        ]
    )
    service = VibeVoiceService(
        python="python3",
        cli_path=cli,
        vibevoice_home=home,
        comfyui_vibevoice_path=module_dir,
        subprocess_run=fake_run,
        directed_asr_provider=asr,
        directed_voice_conversion_service=FakeDirectedVoiceConversionService(),
    )
    voice = tmp_path / "voice.wav"
    voice.write_bytes(b"voice")

    result = service.generate(
        script_text="\n".join(
            [
                "1 あっ、こんにちは",
                "1 最近、北海道に移住したって聞きました",
                "1 温泉も近くにありますか",
                "1 お仕事は何ですか",
            ]
        ),
        voice_paths=[voice],
        options=VibeVoiceGenerationOptions(directed_line_mode=True, line_by_line=False, line_gap=0.25),
    )

    command = calls[0]
    assert script_texts[0] == (
        "Speaker 1: あっ、こんにちは、最近、北海道に移住したって聞きました、温泉も近くにありますか、お仕事は何ですか"
    )
    assert result.normalized_script == "\n".join(
        [
            "Speaker 1: あっ、こんにちは",
            "Speaker 1: 最近、北海道に移住したって聞きました",
            "Speaker 1: 温泉も近くにありますか",
            "Speaker 1: お仕事は何ですか",
        ]
    )
    assert result.providers["vibevoice_directed_asr"] == "fake-directed-asr"
    assert result.providers["vibevoice_directed_vc"] == "fake-directed-vc"
    assert result.diagnostics["directed_line_mode"]["line_count"] == 4
    assert len(result.diagnostics["directed_line_mode"]["ranges"]) == 4
    assert [artifact["kind"] for artifact in result.artifacts] == [
        "speaker_vibevoice",
        "speaker_voice_conversion",
        "line_segment",
        "line_segment",
        "line_segment",
        "line_segment",
    ]
    assert result.artifacts[0]["label"] == "Speaker 1 VibeVoice"
    assert result.artifacts[2]["line_index"] == 1
    assert "--line_by_line" not in command
    output = tmp_path / "directed-output.wav"
    output.write_bytes(result.audio_bytes)
    assert 1.1 <= _wav_duration(output) <= 1.2
    assert asr.calls[0][1:] == ("auto", True)


def test_vibevoice_service_directed_line_mode_generates_per_speaker_and_reorders(tmp_path: Path) -> None:
    script_texts: list[str] = []
    events: list[str] = []
    cli = tmp_path / "vibevoice.py"
    cli.write_text("# cli", encoding="utf-8")
    home = tmp_path / "models"
    module_dir = tmp_path / "ComfyUI-VibeVoice"
    home.mkdir()
    module_dir.mkdir()

    def fake_run(command, *, env, cwd, capture_output, text, timeout, check):
        script_texts.append(Path(command[command.index("--text_file") + 1]).read_text(encoding="utf-8"))
        events.append(f"vv:{len(script_texts)}")
        output_index = command.index("--output") + 1
        _write_test_wav(Path(command[output_index]), seconds=1.0, sample_value=1000 + len(script_texts))
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    asr = FakeDirectedAsrProvider(
        [
            [
                {"text": "一番", "start": 0.0, "end": 0.1},
                {"text": "三番", "start": 0.2, "end": 0.3},
            ],
            [
                {"text": "二番", "start": 0.1, "end": 0.2},
                {"text": "四番", "start": 0.3, "end": 0.4},
            ],
        ],
        events=events,
    )
    service = VibeVoiceService(
        python="python3",
        cli_path=cli,
        vibevoice_home=home,
        comfyui_vibevoice_path=module_dir,
        subprocess_run=fake_run,
        directed_asr_provider=asr,
        directed_voice_conversion_service=FakeDirectedVoiceConversionService(events=events),
    )
    voice1 = tmp_path / "voice1.wav"
    voice2 = tmp_path / "voice2.wav"
    voice1.write_bytes(b"voice1")
    voice2.write_bytes(b"voice2")

    result = service.generate(
        script_text="\n".join(
            [
                "1 一番目です",
                "2 二番目です",
                "1 三番目です",
                "2 四番目です",
            ]
        ),
        voice_paths=[VibeVoiceVoiceSample(slot=1, path=voice1), VibeVoiceVoiceSample(slot=2, path=voice2)],
        options=VibeVoiceGenerationOptions(directed_line_mode=True, line_gap=0.1),
    )

    assert script_texts == [
        "Speaker 1: 一番目です、三番目です",
        "Speaker 1: 二番目です、四番目です",
    ]
    assert events == [
        "vv:1",
        "vv:2",
        "vc:speaker-1.wav",
        "vc:speaker-2.wav",
        "asr:speaker-1-vc.wav",
        "asr:speaker-2-vc.wav",
    ]
    assert result.normalized_script == "\n".join(
        [
            "Speaker 1: 一番目です",
            "Speaker 2: 二番目です",
            "Speaker 1: 三番目です",
            "Speaker 2: 四番目です",
        ]
    )
    ranges = result.diagnostics["directed_line_mode"]["ranges"]
    assert [item["speaker"] for item in ranges] == [1, 2, 1, 2]
    output = tmp_path / "directed-multi-output.wav"
    output.write_bytes(result.audio_bytes)
    assert 0.65 <= _wav_duration(output) <= 0.75


def test_vibevoice_service_directed_line_mode_releases_owned_asr_after_transcription(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    cli = tmp_path / "vibevoice.py"
    cli.write_text("# cli", encoding="utf-8")
    home = tmp_path / "models"
    module_dir = tmp_path / "ComfyUI-VibeVoice"
    home.mkdir()
    module_dir.mkdir()

    def fake_run(command, *, env, cwd, capture_output, text, timeout, check):
        events.append("vv")
        output_index = command.index("--output") + 1
        _write_test_wav(Path(command[output_index]), seconds=0.5)
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    asr = FakeDirectedAsrProvider(
        [[{"text": "一番", "start": 0.0, "end": 0.2}]],
        events=events,
    )
    monkeypatch.setattr(vibevoice_module, "_create_directed_asr_provider", lambda: asr)
    service = VibeVoiceService(
        python="python3",
        cli_path=cli,
        vibevoice_home=home,
        comfyui_vibevoice_path=module_dir,
        subprocess_run=fake_run,
        directed_voice_conversion_service=FakeDirectedVoiceConversionService(events=events),
    )
    voice = tmp_path / "voice.wav"
    voice.write_bytes(b"voice")

    service.generate(
        script_text="1 一番目です",
        voice_paths=[VibeVoiceVoiceSample(slot=1, path=voice)],
        options=VibeVoiceGenerationOptions(directed_line_mode=True, line_gap=0.1),
    )

    assert events == ["vv", "vc:speaker-1.wav", "asr:speaker-1-vc.wav", "release-asr"]
    assert service._directed_asr_provider_instance is None


def test_vibevoice_service_directed_line_mode_releases_owned_voice_conversion(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    cli = tmp_path / "vibevoice.py"
    cli.write_text("# cli", encoding="utf-8")
    home = tmp_path / "models"
    module_dir = tmp_path / "ComfyUI-VibeVoice"
    home.mkdir()
    module_dir.mkdir()

    def fake_run(command, *, env, cwd, capture_output, text, timeout, check):
        events.append("vv")
        output_index = command.index("--output") + 1
        _write_test_wav(Path(command[output_index]), seconds=0.5)
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    asr = FakeDirectedAsrProvider(
        [[{"text": "一番", "start": 0.0, "end": 0.2}]],
        events=events,
    )
    vc = FakeDirectedVoiceConversionService(events=events)
    monkeypatch.setattr(vibevoice_module, "_create_directed_asr_provider", lambda: asr)
    monkeypatch.setattr(vibevoice_module, "_create_directed_voice_conversion_service", lambda: vc)
    service = VibeVoiceService(
        python="python3",
        cli_path=cli,
        vibevoice_home=home,
        comfyui_vibevoice_path=module_dir,
        subprocess_run=fake_run,
    )
    voice = tmp_path / "voice.wav"
    voice.write_bytes(b"voice")

    service.generate(
        script_text="1 一番目です",
        voice_paths=[VibeVoiceVoiceSample(slot=1, path=voice)],
        options=VibeVoiceGenerationOptions(directed_line_mode=True, line_gap=0.1),
    )

    assert events == ["vv", "vc:speaker-1.wav", "release-vc", "asr:speaker-1-vc.wav", "release-asr"]
    assert service._directed_voice_conversion_service_instance is None


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


def test_vibevoice_service_does_not_auto_enable_line_by_line_for_large(tmp_path: Path) -> None:
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
    voice = tmp_path / "voice.wav"
    voice.write_bytes(b"voice")

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
        options=VibeVoiceGenerationOptions(
            line_by_line=False,
            model_id="vibevoice-large-aoi-pinned",
        ),
    )

    command = calls[0]
    assert "--line_by_line" not in command


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


def test_vibevoice_service_disables_timeout_when_cancel_event_controls_job(tmp_path: Path) -> None:
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

    assert captured_timeouts == [None]


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


def test_vibevoice_service_streams_line_by_line_overall_progress(tmp_path: Path) -> None:
    cli = tmp_path / "fake_vibevoice_cli.py"
    cli.write_text(
        "\n".join(
            [
                "from pathlib import Path",
                "import sys",
                "import time",
                "output = Path(sys.argv[sys.argv.index('--output') + 1])",
                "sys.stderr.write('2026-07-02 00:00:00,000 - INFO - 行単位モードで音声を生成します。対象行数: 4 (mode=concat)\\n')",
                "sys.stderr.flush()",
                "sys.stderr.write('2026-07-02 00:00:00,000 - INFO - 行001: 新規に音声を生成します\\n')",
                "sys.stderr.flush()",
                "sys.stderr.write('\\rGenerating (active: 1/1):  50%|###| 16/32 [00:01<00:08, 1.00it/s]')",
                "sys.stderr.flush()",
                "time.sleep(0.01)",
                "sys.stderr.write('\\n2026-07-02 00:00:00,000 - INFO - 行002: 新規に音声を生成します\\n')",
                "sys.stderr.flush()",
                "sys.stderr.write('\\rGenerating (active: 1/1): 100%|###| 32/32 [00:01<00:00, 1.00it/s]')",
                "sys.stderr.flush()",
                "sys.stderr.write('\\n2026-07-02 00:00:00,000 - INFO - 行単位モード: 4件の音声を結合しました (gap=1.00s)\\n')",
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
        script_text="\n".join(
            [
                "Speaker 1: こんにちは。",
                "Speaker 1: 北海道の話です。",
                "Speaker 1: 温泉があります。",
                "Speaker 1: 牛の世話をします。",
            ]
        ),
        voice_paths=[voice],
        options=VibeVoiceGenerationOptions(line_by_line=True),
        progress_callback=lambda stage, label: progress.append((stage, label)),
    )

    labels = [label for stage, label in progress if stage == "generation"]
    assert result.audio_bytes == b"RIFFfakewav"
    assert any("行単位生成 1/4 (12.5%" in label and "行内 16/32" in label for label in labels)
    assert any("行単位生成 2/4 (50%" in label and "行内 32/32" in label for label in labels)
    assert labels[-1] == "行単位生成 4/4 (100%)"


def test_vibevoice_model_presets_include_runpod_only_large_candidate() -> None:
    assert set(VIBEVOICE_MODEL_PRESETS) == {
        "vibevoice-1.5b-pinned",
        "vibevoice-1.5b-latest",
        "vibevoice-large-aoi-pinned",
    }
    pinned = resolve_vibevoice_model_preset("vibevoice-1.5b-pinned")
    latest = resolve_vibevoice_model_preset("vibevoice-1.5b-latest")
    large = resolve_vibevoice_model_preset("vibevoice-large-aoi-pinned")
    assert pinned.model_repo == "microsoft/VibeVoice-1.5B"
    assert pinned.model_revision == "1904eae38036e9c780d28e27990c27748984eafe"
    assert pinned.supported_backends == ("local", "runpod_serverless")
    assert latest.model_repo == "microsoft/VibeVoice-1.5B"
    assert latest.model_revision is None
    assert latest.supported_backends == ("local", "runpod_serverless")
    assert large.model_repo == "aoi-ot/VibeVoice-Large"
    assert large.model_revision == "1b81fecc784a076dcd935678db551871f4598ebf"
    assert large.tokenizer_repo == "Qwen/Qwen2.5-7B"
    assert large.tokenizer_revision == "d149729398750b98c0af14eb82c78cfe92750796"
    assert large.torch_dtype == "bfloat16"
    assert large.generation_config_mode == "explicit"
    assert large.min_audio_tokens == 1
    assert pinned.auto_line_by_line is True
    assert large.auto_line_by_line is False
    assert large.supported_backends == ("runpod_serverless",)
    assert is_vibevoice_model_supported_by_backend("vibevoice-large-aoi-pinned", "runpod_serverless")
    assert not is_vibevoice_model_supported_by_backend("vibevoice-large-aoi-pinned", "local")


def test_vibevoice_service_sets_large_dtype_override(tmp_path: Path) -> None:
    calls: list[tuple[list[str], dict[str, str]]] = []
    cli = tmp_path / "vibevoice.py"
    cli.write_text("# cli", encoding="utf-8")
    home = tmp_path / "models"
    model_dir = home / "models--aoi-ot--VibeVoice-Large" / "snapshots" / "large"
    tokenizer_dir = home / "models--Qwen--Qwen2.5-7B" / "snapshots" / "tokenizer"
    module_dir = tmp_path / "ComfyUI-VibeVoice"
    model_dir.mkdir(parents=True)
    tokenizer_dir.mkdir(parents=True)
    module_dir.mkdir()
    (model_dir / "model-00001-of-00009.safetensors").write_bytes(b"model")
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

    service.generate(
        script_text="你好。",
        voice_paths=[voice],
        options=VibeVoiceGenerationOptions(model_id="vibevoice-large-aoi-pinned"),
    )

    _command, env = calls[0]
    assert env["VIBEVOICE_MODEL_REPO"] == "aoi-ot/VibeVoice-Large"
    assert env["VIBEVOICE_TOKENIZER_REPO"] == "Qwen/Qwen2.5-7B"
    assert env["VIBEVOICE_TORCH_DTYPE"] == "bfloat16"
    assert env["VIBEVOICE_GENERATION_CONFIG_MODE"] == "explicit"
    assert env["VIBEVOICE_MIN_AUDIO_TOKENS"] == "1"


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
            model_id="vibevoice-large-aoi-pinned",
            inference_steps=2,
            do_sample=False,
        ),
    )

    assert result.audio_bytes == b"RIFF"
    assert client.payload["operation_mode"] == "vibevoice"
    assert client.payload["script"] == "Speaker 1: 你好。"
    assert client.payload["generation"]["inference_steps"] == 2
    assert client.payload["generation"]["do_sample"] is False
    assert client.payload["generation"]["model_id"] == "vibevoice-large-aoi-pinned"
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


def test_runpod_vibevoice_service_preserves_large_line_by_line_off(tmp_path: Path) -> None:
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
        options=VibeVoiceGenerationOptions(
            line_by_line=False,
            model_id="vibevoice-large-aoi-pinned",
        ),
    )

    assert client.payload["generation"]["line_by_line"] is False
