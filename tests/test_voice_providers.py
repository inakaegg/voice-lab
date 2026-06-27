from __future__ import annotations

import json
import subprocess
from types import SimpleNamespace
from pathlib import Path

import pytest

from mo_speech.providers.fake import FakeTtsProvider
from mo_speech.pipeline import PipelineProgress, TtsOutput
from mo_speech.providers.voice import (
    ChatterboxDirectVoiceConversionProvider,
    DEFAULT_SEED_VC_DIFFUSION_STEPS,
    DEFAULT_SEED_VC_INFERENCE_CFG_RATE,
    DEFAULT_SEED_VC_LENGTH_ADJUST,
    DEFAULT_SEED_VC_REFERENCE_AUTO_SELECT,
    DEFAULT_SEED_VC_REFERENCE_MAX_SECONDS,
    QwenSeedVcTtsProvider,
    QwenVoiceCloneTtsProvider,
    SeedVcDirectVoiceConversionProvider,
    SeedVcResidentDirectVoiceConversionProvider,
    SeedVcRuntimeSettings,
    SeedVcVoiceConversionTtsProvider,
    VoiceConversionBackendInfo,
    VoiceConversionService,
    create_voice_conversion_service_from_env,
)


def test_seed_vc_default_settings_are_quality_preset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SEED_VC_DIFFUSION_STEPS", raising=False)
    monkeypatch.delenv("SEED_VC_LENGTH_ADJUST", raising=False)
    monkeypatch.delenv("SEED_VC_INFERENCE_CFG_RATE", raising=False)
    monkeypatch.delenv("SEED_VC_REFERENCE_AUTO_SELECT", raising=False)
    monkeypatch.delenv("SEED_VC_REFERENCE_MAX_SECONDS", raising=False)

    provider = SeedVcDirectVoiceConversionProvider()

    assert DEFAULT_SEED_VC_DIFFUSION_STEPS == 30
    assert DEFAULT_SEED_VC_REFERENCE_MAX_SECONDS == 10.0
    assert DEFAULT_SEED_VC_REFERENCE_AUTO_SELECT is False
    assert provider.diffusion_steps == DEFAULT_SEED_VC_DIFFUSION_STEPS
    assert provider.reference_max_seconds == DEFAULT_SEED_VC_REFERENCE_MAX_SECONDS
    assert provider.reference_auto_select is DEFAULT_SEED_VC_REFERENCE_AUTO_SELECT
    assert provider.length_adjust == DEFAULT_SEED_VC_LENGTH_ADJUST
    assert provider.inference_cfg_rate == DEFAULT_SEED_VC_INFERENCE_CFG_RATE


def test_qwen_voice_clone_provider_invokes_helper_with_reference_text(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audio_path = tmp_path / "reference.wav"
    audio_path.write_bytes(b"reference audio")
    captured: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        input_json = Path(command[command.index("--input-json") + 1])
        output_path = Path(command[command.index("--output") + 1])
        captured["command"] = command
        captured["input"] = json.loads(input_json.read_text(encoding="utf-8"))
        captured["kwargs"] = kwargs
        output_path.write_bytes(b"qwen wav")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr("mo_speech.providers.voice.subprocess.run", fake_run)

    provider = QwenVoiceCloneTtsProvider(
        python_executable="voice-python",
        model_id="Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    )

    result = provider.synthesize_with_voice(
        "谢谢。",
        "zh-CN",
        reference_audio_path=audio_path,
        reference_text="ありがとう。",
        reference_language="ja-JP",
        voice_mode="clone",
    )

    assert result.audio_bytes == b"qwen wav"
    assert result.audio_mime_type == "audio/wav"
    assert result.timings_ms["tts"] >= 0
    assert captured["command"][:3] == ["voice-python", "-m", "mo_speech.qwen_tts_synthesize"]
    assert captured["input"] == {
        "model": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        "text": "谢谢。",
        "language": "Chinese",
        "reference_audio": str(audio_path),
        "reference_text": "ありがとう。",
        "x_vector_only_mode": False,
        "device_map": "cpu",
        "dtype": "float32",
        "attn_implementation": None,
    }


def test_qwen_voice_clone_provider_reports_model_progress(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audio_path = tmp_path / "reference.wav"
    audio_path.write_bytes(b"reference audio")
    progress: list[PipelineProgress] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        output_path = Path(command[command.index("--output") + 1])
        output_path.write_bytes(b"qwen wav")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr("mo_speech.providers.voice.subprocess.run", fake_run)

    provider = QwenVoiceCloneTtsProvider(
        python_executable="voice-python",
        model_id="Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    )

    provider.synthesize_with_voice(
        "谢谢。",
        "zh-CN",
        reference_audio_path=audio_path,
        reference_text="ありがとう。",
        reference_language="ja-JP",
        voice_mode="clone",
        progress_callback=progress.append,
    )

    assert progress == [
        PipelineProgress(stage="tts", label="音声生成", provider="Qwen/Qwen3-TTS-12Hz-1.7B-Base")
    ]


def test_qwen_voice_clone_provider_uses_x_vector_for_unsupported_reference_language(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audio_path = tmp_path / "reference.wav"
    audio_path.write_bytes(b"reference audio")
    captured: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        input_json = Path(command[command.index("--input-json") + 1])
        output_path = Path(command[command.index("--output") + 1])
        captured["input"] = json.loads(input_json.read_text(encoding="utf-8"))
        output_path.write_bytes(b"qwen wav")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr("mo_speech.providers.voice.subprocess.run", fake_run)

    provider = QwenVoiceCloneTtsProvider(python_executable="voice-python")

    provider.synthesize_with_voice(
        "おはようございます。",
        "ja-JP",
        reference_audio_path=audio_path,
        reference_text="Selamat pagi.",
        reference_language="id-ID",
        voice_mode="clone",
    )

    assert captured["input"]["language"] == "Japanese"
    assert captured["input"]["reference_text"] == ""
    assert captured["input"]["x_vector_only_mode"] is True


def test_seed_vc_provider_converts_default_tts_audio_to_reference_voice(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reference_audio = tmp_path / "reference.wav"
    reference_audio.write_bytes(b"reference audio")
    captured: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        if command[0] == "ffmpeg":
            output_path = Path(command[-1])
            captured["ffmpeg_command"] = command
            output_path.write_bytes(b"prepared reference wav")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        output_dir = Path(command[command.index("--output") + 1])
        source_path = Path(command[command.index("--source") + 1])
        target_path = Path(command[command.index("--target") + 1])
        captured["command"] = command
        captured["source_bytes"] = source_path.read_bytes()
        captured["target_path"] = target_path
        captured["target_bytes"] = target_path.read_bytes()
        captured["kwargs"] = kwargs
        (output_dir / "converted.wav").write_bytes(b"seed vc wav")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr("mo_speech.providers.voice.subprocess.run", fake_run)

    provider = SeedVcVoiceConversionTtsProvider(
        base_tts=FakeTtsProvider(),
        python_executable="voice-python",
        work_dir=tmp_path / "seed-work",
        diffusion_steps=8,
        fp16=False,
    )

    result = provider.synthesize_with_voice(
        "谢谢。",
        "zh-CN",
        reference_audio_path=reference_audio,
        reference_text="ありがとう。",
        reference_language="ja-JP",
        voice_mode="convert",
        voice_settings={
            "seed_vc": SeedVcRuntimeSettings(
                diffusion_steps=5,
                length_adjust=1.1,
                inference_cfg_rate=0.45,
                reference_max_seconds=2.5,
            )
        },
    )

    assert result.audio_bytes == b"seed vc wav"
    assert result.audio_mime_type == "audio/wav"
    assert result.timings_ms["tts"] >= 0
    assert result.timings_ms["voice_reference_prepare"] >= 0
    assert result.timings_ms["voice_conversion"] >= 0
    assert captured["ffmpeg_command"][:6] == ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i"]
    assert "-t" in captured["ffmpeg_command"]
    assert captured["command"][:3] == ["voice-python", "-m", "seed_vc.inference"]
    assert captured["source_bytes"].startswith(b"FAKE-WAV:zh-CN:")
    assert captured["target_path"] != reference_audio
    assert captured["target_bytes"] == b"prepared reference wav"
    assert captured["ffmpeg_command"][captured["ffmpeg_command"].index("-t") + 1] == "2.5"
    assert captured["command"][captured["command"].index("--diffusion-steps") + 1] == "5"
    assert captured["command"][captured["command"].index("--length-adjust") + 1] == "1.1"
    assert captured["command"][captured["command"].index("--inference-cfg-rate") + 1] == "0.45"
    assert "--fp16" in captured["command"]


def test_seed_vc_provider_can_use_clone_only_source_tts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reference_audio = tmp_path / "reference.wav"
    reference_audio.write_bytes(b"reference audio")
    captured: dict[str, object] = {}

    class CloneOnlyTtsProvider:
        name = "clone-only"
        audio_mime_type = "audio/wav"
        supported_voice_modes = ("clone",)

        def synthesize(self, text: str, target_language: str) -> bytes:
            raise RuntimeError("default is not supported")

        def synthesize_with_voice(
            self,
            text: str,
            target_language: str,
            *,
            reference_audio_path: Path,
            reference_text: str,
            reference_language: str,
            voice_mode: str,
        ) -> bytes:
            captured["source_tts"] = {
                "text": text,
                "target_language": target_language,
                "reference_audio_path": reference_audio_path,
                "reference_text": reference_text,
                "reference_language": reference_language,
                "voice_mode": voice_mode,
            }
            return b"clone source wav"

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        if command[0] == "ffmpeg":
            output_path = Path(command[-1])
            output_path.write_bytes(b"prepared reference wav")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        output_dir = Path(command[command.index("--output") + 1])
        source_path = Path(command[command.index("--source") + 1])
        captured["source_bytes"] = source_path.read_bytes()
        (output_dir / "converted.wav").write_bytes(b"seed vc wav")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr("mo_speech.providers.voice.subprocess.run", fake_run)

    provider = SeedVcVoiceConversionTtsProvider(
        base_tts=CloneOnlyTtsProvider(),
        python_executable="voice-python",
        work_dir=tmp_path / "seed-work",
    )

    result = provider.synthesize_with_voice(
        "谢谢。",
        "zh-CN",
        reference_audio_path=reference_audio,
        reference_text="ありがとう。",
        reference_language="ja-JP",
        voice_mode="convert",
    )

    assert result.audio_bytes == b"seed vc wav"
    assert captured["source_bytes"] == b"clone source wav"
    assert captured["source_tts"] == {
        "text": "谢谢。",
        "target_language": "zh-CN",
        "reference_audio_path": reference_audio,
        "reference_text": "ありがとう。",
        "reference_language": "ja-JP",
        "voice_mode": "clone",
    }


def test_seed_vc_provider_reports_conversion_progress(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reference_audio = tmp_path / "reference.wav"
    reference_audio.write_bytes(b"reference audio")
    progress: list[PipelineProgress] = []

    class CloneOnlyTtsProvider:
        name = "clone-only"
        audio_mime_type = "audio/wav"
        supported_voice_modes = ("clone",)

        def synthesize_with_voice(
            self,
            text: str,
            target_language: str,
            *,
            reference_audio_path: Path,
            reference_text: str,
            reference_language: str,
            voice_mode: str,
            progress_callback=None,
        ) -> bytes:
            if progress_callback is not None:
                progress_callback(PipelineProgress(stage="tts", label="音声生成", provider="source-model"))
            return b"clone source wav"

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        if command[0] == "ffmpeg":
            output_path = Path(command[-1])
            output_path.write_bytes(b"prepared reference wav")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        output_dir = Path(command[command.index("--output") + 1])
        (output_dir / "converted.wav").write_bytes(b"seed vc wav")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr("mo_speech.providers.voice.subprocess.run", fake_run)

    provider = SeedVcVoiceConversionTtsProvider(
        base_tts=CloneOnlyTtsProvider(),
        python_executable="voice-python",
        work_dir=tmp_path / "seed-work",
    )

    provider.synthesize_with_voice(
        "谢谢。",
        "zh-CN",
        reference_audio_path=reference_audio,
        reference_text="ありがとう。",
        reference_language="ja-JP",
        voice_mode="convert",
        progress_callback=progress.append,
    )

    assert progress == [
        PipelineProgress(stage="tts", label="音声生成", provider="source-model"),
        PipelineProgress(stage="voice_conversion", label="声質変換", provider="Plachta/Seed-VC"),
    ]


def test_seed_vc_direct_provider_converts_source_to_reference_voice(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_audio = tmp_path / "source.webm"
    reference_audio = tmp_path / "reference.wav"
    source_audio.write_bytes(b"source audio")
    reference_audio.write_bytes(b"reference audio")
    captured: dict[str, object] = {}
    prepared_files: list[Path] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        if command[0] == "ffmpeg":
            output_path = Path(command[-1])
            prepared_files.append(output_path)
            output_path.write_bytes(f"prepared:{output_path.name}".encode())
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        output_dir = Path(command[command.index("--output") + 1])
        captured["command"] = command
        captured["source_bytes"] = Path(command[command.index("--source") + 1]).read_bytes()
        captured["target_bytes"] = Path(command[command.index("--target") + 1]).read_bytes()
        (output_dir / "converted.wav").write_bytes(b"direct seed vc wav")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr("mo_speech.providers.voice.subprocess.run", fake_run)

    provider = SeedVcDirectVoiceConversionProvider(
        python_executable="voice-python",
        work_dir=tmp_path / "seed-work",
        diffusion_steps=6,
        fp16=False,
    )

    result = provider.convert(source_audio_path=source_audio, reference_audio_path=reference_audio)

    assert result.audio_bytes == b"direct seed vc wav"
    assert result.audio_mime_type == "audio/wav"
    assert result.timings_ms["source_audio_prepare"] >= 0
    assert result.timings_ms["reference_audio_prepare"] >= 0
    assert result.timings_ms["voice_conversion"] >= 0
    assert len(prepared_files) == 2
    assert captured["command"][:3] == ["voice-python", "-m", "seed_vc.inference"]
    assert captured["source_bytes"] == b"prepared:source.wav"
    assert captured["target_bytes"] == b"prepared:reference.wav"
    assert "--diffusion-steps" in captured["command"]


def test_seed_vc_direct_provider_uses_runtime_settings(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_audio = tmp_path / "source.webm"
    reference_audio = tmp_path / "reference.wav"
    source_audio.write_bytes(b"source audio")
    reference_audio.write_bytes(b"reference audio")
    captured: dict[str, object] = {}
    ffmpeg_commands: list[list[str]] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        if command[0] == "ffmpeg":
            ffmpeg_commands.append(command)
            Path(command[-1]).write_bytes(b"prepared wav")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        output_dir = Path(command[command.index("--output") + 1])
        captured["command"] = command
        (output_dir / "converted.wav").write_bytes(b"runtime tuned seed vc wav")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr("mo_speech.providers.voice.subprocess.run", fake_run)

    provider = SeedVcDirectVoiceConversionProvider(
        python_executable="voice-python",
        work_dir=tmp_path / "seed-work",
        diffusion_steps=8,
        length_adjust=1.0,
        inference_cfg_rate=0.7,
        reference_max_seconds=12,
    )

    result = provider.convert(
        source_audio_path=source_audio,
        reference_audio_path=reference_audio,
        seed_vc_settings=SeedVcRuntimeSettings(
            diffusion_steps=4,
            length_adjust=1.15,
            inference_cfg_rate=0.5,
            reference_max_seconds=3.5,
        ),
    )

    command = captured["command"]
    assert result.audio_bytes == b"runtime tuned seed vc wav"
    assert command[command.index("--diffusion-steps") + 1] == "4"
    assert command[command.index("--length-adjust") + 1] == "1.15"
    assert command[command.index("--inference-cfg-rate") + 1] == "0.5"
    assert any("-t" in command and "3.5" in command for command in ffmpeg_commands)


def test_seed_vc_direct_provider_auto_selects_reference_segment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_audio = tmp_path / "source.webm"
    reference_audio = tmp_path / "reference.wav"
    source_audio.write_bytes(b"source audio")
    reference_audio.write_bytes(b"reference audio")
    captured: dict[str, object] = {}
    ffmpeg_commands: list[list[str]] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        if command[0] == "ffprobe":
            return subprocess.CompletedProcess(command, 0, stdout="8.0\n", stderr="")

        if command[0] == "ffmpeg":
            ffmpeg_commands.append(command)
            if "-af" in command and "silencedetect" in command[command.index("-af") + 1]:
                return subprocess.CompletedProcess(
                    command,
                    0,
                    stdout="",
                    stderr=(
                        "[silencedetect @ 0x1] silence_start: 0\n"
                        "[silencedetect @ 0x1] silence_end: 1 | silence_duration: 1\n"
                        "[silencedetect @ 0x1] silence_start: 4\n"
                        "[silencedetect @ 0x1] silence_end: 8 | silence_duration: 4\n"
                    ),
                )
            Path(command[-1]).write_bytes(f"prepared:{Path(command[-1]).name}".encode())
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        output_dir = Path(command[command.index("--output") + 1])
        captured["command"] = command
        captured["target_bytes"] = Path(command[command.index("--target") + 1]).read_bytes()
        (output_dir / "converted.wav").write_bytes(b"auto selected seed vc wav")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr("mo_speech.providers.voice.subprocess.run", fake_run)

    provider = SeedVcDirectVoiceConversionProvider(
        python_executable="voice-python",
        work_dir=tmp_path / "seed-work",
        reference_max_seconds=2,
    )

    result = provider.convert(
        source_audio_path=source_audio,
        reference_audio_path=reference_audio,
        seed_vc_settings=SeedVcRuntimeSettings(reference_auto_select=True),
    )

    reference_prepare_command = next(command for command in ffmpeg_commands if Path(command[-1]).name == "reference.wav")

    assert result.audio_bytes == b"auto selected seed vc wav"
    assert result.timings_ms["reference_segment_select"] >= 0
    assert captured["target_bytes"] == b"prepared:reference.wav"
    assert "-ss" in reference_prepare_command
    assert reference_prepare_command[reference_prepare_command.index("-ss") + 1] == "1.5"
    assert reference_prepare_command[reference_prepare_command.index("-t") + 1] == "2"


def test_seed_vc_resident_provider_reuses_loaded_model(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_audio = tmp_path / "source.webm"
    reference_audio = tmp_path / "reference.wav"
    source_audio.write_bytes(b"source audio")
    reference_audio.write_bytes(b"reference audio")
    load_calls: list[object] = []
    inference_calls: list[dict[str, object]] = []

    class FakeStreamState:
        def __init__(self, args, target=None, new_target_name=None, realtime=True):
            load_calls.append(args)
            self.target_name = new_target_name

        def prepare_target(self, f0_condition, target, new_target_name=None):
            self.target_name = new_target_name

    def fake_inference(**kwargs):
        inference_calls.append(kwargs)
        kwargs["stream_state"].prepare_target(False, kwargs["target"], kwargs["new_target_name"])
        return SimpleNamespace(samples=b"converted", sample_rate=24000)

    fake_api = SimpleNamespace(_V1StreamState=FakeStreamState, inference=fake_inference)

    def fake_prepare_vc_audio(input_path, output_path, **_kwargs):
        output_path.write_bytes(f"prepared:{Path(input_path).name}".encode())

    monkeypatch.setattr("mo_speech.providers.voice._prepare_vc_audio", fake_prepare_vc_audio)
    monkeypatch.setattr(
        "mo_speech.providers.voice._prepare_seed_reference_audio",
        lambda input_path, output_path, **_kwargs: fake_prepare_vc_audio(input_path, output_path)
        or SimpleNamespace(reference_segment_select_ms=None),
    )
    monkeypatch.setattr("mo_speech.providers.voice._read_seed_vc_audio_data_from_wav", lambda path: SimpleNamespace(path=path))
    monkeypatch.setattr(
        "mo_speech.providers.voice._write_seed_vc_audio_data_to_wav",
        lambda audio, path: path.write_bytes(audio.samples),
    )

    provider = SeedVcResidentDirectVoiceConversionProvider(
        work_dir=tmp_path / "seed-work",
        diffusion_steps=8,
        fp16=True,
    )
    monkeypatch.setattr(provider, "_load_seed_vc_api", lambda: fake_api)

    provider.preload()
    first = provider.convert(source_audio_path=source_audio, reference_audio_path=reference_audio)
    second = provider.convert(
        source_audio_path=source_audio,
        reference_audio_path=reference_audio,
        seed_vc_settings=SeedVcRuntimeSettings(diffusion_steps=4),
    )

    assert len(load_calls) == 1
    assert first.audio_bytes == b"converted"
    assert second.audio_bytes == b"converted"
    assert inference_calls[0]["stream_state"] is inference_calls[1]["stream_state"]
    assert inference_calls[0]["diffusion_steps"] == 8
    assert inference_calls[1]["diffusion_steps"] == 4
    assert inference_calls[0]["streaming"] is True
    assert inference_calls[0]["end_of_stream"] is True


def test_voice_conversion_service_preloads_resident_capable_provider() -> None:
    calls = []

    class Provider:
        backend_id = "seed-vc"
        label = "Seed-VC"
        name = "fake"
        audio_mime_type = "audio/wav"

        def backend_info(self):
            return VoiceConversionBackendInfo(self.backend_id, self.label, self.name, True)

        def preload(self):
            calls.append("preload")

        def convert(self, *, source_audio_path, reference_audio_path, seed_vc_settings=None, progress_callback=None):
            raise AssertionError("not used")

    VoiceConversionService([Provider()]).preload()

    assert calls == ["preload"]


def test_voice_conversion_service_from_env_can_use_seed_vc_resident(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MO_VC_BACKENDS", "seed-vc")
    monkeypatch.setenv("SEED_VC_EXECUTION_MODE", "resident")

    service = create_voice_conversion_service_from_env()

    assert isinstance(service.providers[0], SeedVcResidentDirectVoiceConversionProvider)


def test_chatterbox_direct_provider_invokes_helper(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_audio = tmp_path / "source.wav"
    reference_audio = tmp_path / "reference.wav"
    source_audio.write_bytes(b"source audio")
    reference_audio.write_bytes(b"reference audio")
    captured: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        if command[0] == "ffmpeg":
            Path(command[-1]).write_bytes(b"prepared wav")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        output_path = Path(command[command.index("--output") + 1])
        captured["command"] = command
        captured["kwargs"] = kwargs
        output_path.write_bytes(b"chatterbox wav")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr("mo_speech.providers.voice.subprocess.run", fake_run)

    provider = ChatterboxDirectVoiceConversionProvider(
        python_executable="voice-python",
        work_dir=tmp_path / "chatterbox-work",
        device="mps",
        model_dir="/models/chatterbox",
    )

    result = provider.convert(source_audio_path=source_audio, reference_audio_path=reference_audio)

    assert result.audio_bytes == b"chatterbox wav"
    assert result.audio_mime_type == "audio/wav"
    command = captured["command"]
    assert command[:3] == ["voice-python", "-m", "mo_speech.chatterbox_vc_convert"]
    assert command[command.index("--device") + 1] == "mps"
    assert command[command.index("--model-dir") + 1] == "/models/chatterbox"


def test_voice_conversion_service_from_env_lists_configured_backends(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MO_VC_BACKENDS", "seed-vc,chatterbox,openvoice-v2,unknown")

    service = create_voice_conversion_service_from_env()

    assert [info.backend_id for info in service.backend_infos()] == [
        "seed-vc",
        "chatterbox",
        "openvoice-v2",
        "unknown",
    ]


def test_qwen_seed_vc_provider_routes_clone_and_convert(tmp_path: Path) -> None:
    reference_audio = tmp_path / "reference.wav"
    reference_audio.write_bytes(b"reference audio")
    captured: list[dict[str, object]] = []

    class CloneTtsProvider:
        name = "clone"

        def synthesize_with_voice(
            self,
            text: str,
            target_language: str,
            *,
            reference_audio_path: Path,
            reference_text: str,
            reference_language: str,
            voice_mode: str,
        ) -> TtsOutput:
            captured.append(
                {
                    "provider": "clone",
                    "text": text,
                    "target_language": target_language,
                    "reference_audio_path": reference_audio_path,
                    "reference_text": reference_text,
                    "reference_language": reference_language,
                    "voice_mode": voice_mode,
                }
            )
            return TtsOutput(audio_bytes=b"clone wav", timings_ms={"tts": 1.0})

    class ConvertTtsProvider:
        name = "convert"

        def synthesize_with_voice(
            self,
            text: str,
            target_language: str,
            *,
            reference_audio_path: Path,
            reference_text: str,
            reference_language: str,
            voice_mode: str,
        ) -> TtsOutput:
            captured.append(
                {
                    "provider": "convert",
                    "text": text,
                    "target_language": target_language,
                    "reference_audio_path": reference_audio_path,
                    "reference_text": reference_text,
                    "reference_language": reference_language,
                    "voice_mode": voice_mode,
                }
            )
            return TtsOutput(audio_bytes=b"convert wav", timings_ms={"voice_conversion": 2.0})

    provider = QwenSeedVcTtsProvider(
        clone_tts=CloneTtsProvider(),
        conversion_tts=ConvertTtsProvider(),
    )

    clone_result = provider.synthesize_with_voice(
        "おはようございます。",
        "ja-JP",
        reference_audio_path=reference_audio,
        reference_text="Selamat pagi.",
        reference_language="id-ID",
        voice_mode="clone",
    )
    convert_result = provider.synthesize_with_voice(
        "おはようございます。",
        "ja-JP",
        reference_audio_path=reference_audio,
        reference_text="Selamat pagi.",
        reference_language="id-ID",
        voice_mode="convert",
    )

    assert provider.supported_voice_modes == ("clone", "convert")
    assert clone_result.audio_bytes == b"clone wav"
    assert convert_result.audio_bytes == b"convert wav"
    assert captured == [
        {
            "provider": "clone",
            "text": "おはようございます。",
            "target_language": "ja-JP",
            "reference_audio_path": reference_audio,
            "reference_text": "Selamat pagi.",
            "reference_language": "id-ID",
            "voice_mode": "clone",
        },
        {
            "provider": "convert",
            "text": "おはようございます。",
            "target_language": "ja-JP",
            "reference_audio_path": reference_audio,
            "reference_text": "Selamat pagi.",
            "reference_language": "id-ID",
            "voice_mode": "convert",
        },
    ]


def test_voice_providers_reject_wrong_voice_mode(tmp_path: Path) -> None:
    audio_path = tmp_path / "reference.wav"
    audio_path.write_bytes(b"reference audio")

    qwen = QwenVoiceCloneTtsProvider()
    seed = SeedVcVoiceConversionTtsProvider(base_tts=FakeTtsProvider())
    combined = QwenSeedVcTtsProvider(clone_tts=qwen, conversion_tts=seed)

    with pytest.raises(RuntimeError, match="voice_mode=default"):
        qwen.synthesize("谢谢。", "zh-CN")

    with pytest.raises(RuntimeError, match="voice_mode=default"):
        seed.synthesize("谢谢。", "zh-CN")

    with pytest.raises(RuntimeError, match="voice_mode=default"):
        combined.synthesize("谢谢。", "zh-CN")

    with pytest.raises(RuntimeError, match="voice_mode=convert"):
        qwen.synthesize_with_voice(
            "谢谢。",
            "zh-CN",
            reference_audio_path=audio_path,
            reference_text="ありがとう。",
            reference_language="ja-JP",
            voice_mode="convert",
        )

    with pytest.raises(RuntimeError, match="voice_mode=clone"):
        seed.synthesize_with_voice(
            "谢谢。",
            "zh-CN",
            reference_audio_path=audio_path,
            reference_text="ありがとう。",
            reference_language="ja-JP",
            voice_mode="clone",
        )

    with pytest.raises(RuntimeError, match="voice_mode=unknown"):
        combined.synthesize_with_voice(
            "谢谢。",
            "zh-CN",
            reference_audio_path=audio_path,
            reference_text="ありがとう。",
            reference_language="ja-JP",
            voice_mode="unknown",
        )
