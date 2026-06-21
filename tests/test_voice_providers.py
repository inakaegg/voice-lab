from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from mo_speech.providers.fake import FakeTtsProvider
from mo_speech.pipeline import PipelineProgress, TtsOutput
from mo_speech.providers.voice import QwenSeedVcTtsProvider, QwenVoiceCloneTtsProvider, SeedVcVoiceConversionTtsProvider


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
    assert captured["command"][:2] == ["voice-python", str(provider.script_path)]
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
        output_dir = Path(command[command.index("--output") + 1])
        source_path = Path(command[command.index("--source") + 1])
        target_path = Path(command[command.index("--target") + 1])
        captured["command"] = command
        captured["source_bytes"] = source_path.read_bytes()
        captured["target_path"] = target_path
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
    )

    assert result.audio_bytes == b"seed vc wav"
    assert result.audio_mime_type == "audio/wav"
    assert result.timings_ms["tts"] >= 0
    assert result.timings_ms["voice_conversion"] >= 0
    assert captured["command"][:3] == ["voice-python", "-m", "seed_vc.inference"]
    assert captured["source_bytes"].startswith(b"FAKE-WAV:zh-CN:")
    assert captured["target_path"] == reference_audio
    assert "--diffusion-steps" in captured["command"]
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
