from pathlib import Path

import pytest

from mo_speech.pipeline import PipelineProgress, PipelineRequest, SpeechTranslationPipeline, TtsOutput
from mo_speech.providers.fake import FakeAsrProvider, FakeTranslationProvider, FakeTtsProvider
from mo_speech.providers.openai_api import OpenAiSeedVcTtsProvider


def test_pipeline_runs_required_id_to_ja_route(tmp_path: Path) -> None:
    request = PipelineRequest(
        audio_path=tmp_path / "input.wav",
        source_language="id-ID",
        target_language="ja-JP",
    )
    request.audio_path.write_bytes(b"fake audio")

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"id-ID": "Selamat pagi. Terima kasih."}),
        translator=FakeTranslationProvider(
            {("id-ID", "ja-JP", "Selamat pagi. Terima kasih."): "おはようございます。ありがとうございます。"}
        ),
        tts=FakeTtsProvider(),
    )

    result = pipeline.run(request)

    assert result.transcript == "Selamat pagi. Terima kasih."
    assert result.translated_text == "おはようございます。ありがとうございます。"
    assert result.transformed_text == "おはようございます。ありがとうございます。"
    assert result.providers == {"asr": "fake-asr", "translation": "fake-translation", "tts": "fake-tts"}
    assert result.output_audio_bytes.startswith(b"FAKE-WAV:ja-JP:")
    assert result.timings_ms["total"] >= result.timings_ms["asr"]


def test_pipeline_reports_processing_progress(tmp_path: Path) -> None:
    request = PipelineRequest(
        audio_path=tmp_path / "input.wav",
        source_language="id-ID",
        target_language="ja-JP",
        text_transform="append_suffix",
        text_transform_options={"suffix": "モー", "unit": "text"},
    )
    request.audio_path.write_bytes(b"fake audio")
    progress: list[PipelineProgress] = []
    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"id-ID": "Selamat pagi."}),
        translator=FakeTranslationProvider({("id-ID", "ja-JP", "Selamat pagi."): "おはようございます。"}),
        tts=FakeTtsProvider(),
    )

    pipeline.run(request, progress_callback=progress.append)

    assert progress == [
        PipelineProgress(stage="asr", label="文字起こし", provider="fake-asr"),
        PipelineProgress(stage="translation", label="翻訳", provider="fake-translation", transcript="Selamat pagi."),
        PipelineProgress(
            stage="text_transform",
            label="テキスト加工",
            provider="append_suffix",
            transcript="Selamat pagi.",
            translated_text="おはようございます。",
        ),
        PipelineProgress(
            stage="tts",
            label="音声生成",
            provider="fake-tts",
            transcript="Selamat pagi.",
            translated_text="おはようございます。",
            transformed_text="おはようございます。モー",
        ),
    ]


def test_pipeline_rejects_unsupported_route(tmp_path: Path) -> None:
    request = PipelineRequest(
        audio_path=tmp_path / "input.wav",
        source_language="en-US",
        target_language="ja-JP",
    )
    request.audio_path.write_bytes(b"fake audio")

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"en-US": "hello"}),
        translator=FakeTranslationProvider({("en-US", "ja-JP", "hello"): "こんにちは"}),
        tts=FakeTtsProvider(),
    )

    with pytest.raises(ValueError, match="unsupported route"):
        pipeline.run(request)


def test_append_suffix_to_whole_text(tmp_path: Path) -> None:
    request = PipelineRequest(
        audio_path=tmp_path / "input.wav",
        source_language="ja-JP",
        target_language="zh-CN",
        text_transform="append_suffix",
        text_transform_options={"suffix": "!", "unit": "text"},
    )
    request.audio_path.write_bytes(b"fake audio")

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"ja-JP": "ありがとう。"}),
        translator=FakeTranslationProvider({("ja-JP", "zh-CN", "ありがとう。"): "谢谢。"}),
        tts=FakeTtsProvider(),
    )

    assert pipeline.run(request).transformed_text == "谢谢。!"


def test_append_suffix_to_each_sentence(tmp_path: Path) -> None:
    request = PipelineRequest(
        audio_path=tmp_path / "input.wav",
        source_language="id-ID",
        target_language="ja-JP",
        text_transform="append_suffix",
        text_transform_options={"suffix": "モー", "unit": "sentence"},
    )
    request.audio_path.write_bytes(b"fake audio")

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"id-ID": "Selamat pagi. Terima kasih."}),
        translator=FakeTranslationProvider(
            {("id-ID", "ja-JP", "Selamat pagi. Terima kasih."): "おはようございます。ありがとうございます。"}
        ),
        tts=FakeTtsProvider(),
    )

    assert pipeline.run(request).transformed_text == "おはようございますモー。ありがとうございますモー。"


def test_pipeline_rejects_unknown_voice_mode(tmp_path: Path) -> None:
    request = PipelineRequest(
        audio_path=tmp_path / "input.wav",
        source_language="ja-JP",
        target_language="zh-CN",
        voice_mode="unknown",
    )
    request.audio_path.write_bytes(b"fake audio")

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"ja-JP": "ありがとう。"}),
        translator=FakeTranslationProvider({("ja-JP", "zh-CN", "ありがとう。"): "谢谢。"}),
        tts=FakeTtsProvider(),
    )

    with pytest.raises(ValueError, match="unsupported voice mode"):
        pipeline.run(request)


def test_pipeline_rejects_clone_when_tts_does_not_support_voice_mode(tmp_path: Path) -> None:
    request = PipelineRequest(
        audio_path=tmp_path / "input.wav",
        source_language="ja-JP",
        target_language="zh-CN",
        voice_mode="clone",
    )
    request.audio_path.write_bytes(b"fake audio")

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"ja-JP": "ありがとう。"}),
        translator=FakeTranslationProvider({("ja-JP", "zh-CN", "ありがとう。"): "谢谢。"}),
        tts=FakeTtsProvider(),
    )

    with pytest.raises(RuntimeError, match="voice_mode=clone is not supported"):
        pipeline.run(request)


def test_pipeline_rejects_default_when_tts_does_not_support_default(tmp_path: Path) -> None:
    request = PipelineRequest(
        audio_path=tmp_path / "input.wav",
        source_language="ja-JP",
        target_language="zh-CN",
        voice_mode="default",
    )
    request.audio_path.write_bytes(b"fake audio")

    class CloneOnlyTtsProvider(FakeTtsProvider):
        name = "clone-only-tts"
        supported_voice_modes = ("clone",)

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"ja-JP": "ありがとう。"}),
        translator=FakeTranslationProvider({("ja-JP", "zh-CN", "ありがとう。"): "谢谢。"}),
        tts=CloneOnlyTtsProvider(),
    )

    with pytest.raises(RuntimeError, match="voice_mode=default is not supported"):
        pipeline.run(request)


def test_pipeline_passes_reference_audio_to_voice_tts(tmp_path: Path) -> None:
    request = PipelineRequest(
        audio_path=tmp_path / "input.wav",
        source_language="ja-JP",
        target_language="zh-CN",
        voice_mode="clone",
    )
    request.audio_path.write_bytes(b"fake audio")
    captured: dict[str, object] = {}

    class VoiceCloneTtsProvider(FakeTtsProvider):
        name = "voice-clone-tts"
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
        ) -> bytes:
            captured["text"] = text
            captured["target_language"] = target_language
            captured["reference_audio_path"] = reference_audio_path
            captured["reference_text"] = reference_text
            captured["reference_language"] = reference_language
            captured["voice_mode"] = voice_mode
            return b"VOICE-CLONE"

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"ja-JP": "ありがとう。"}),
        translator=FakeTranslationProvider({("ja-JP", "zh-CN", "ありがとう。"): "谢谢。"}),
        tts=VoiceCloneTtsProvider(),
    )

    result = pipeline.run(request)

    assert result.output_audio_bytes == b"VOICE-CLONE"
    assert result.providers["tts"] == "voice-clone-tts"
    assert captured == {
        "text": "谢谢。",
        "target_language": "zh-CN",
        "reference_audio_path": request.audio_path,
        "reference_text": "ありがとう。",
        "reference_language": "ja-JP",
        "voice_mode": "clone",
    }


def test_pipeline_merges_voice_provider_timings_and_warnings(tmp_path: Path) -> None:
    request = PipelineRequest(
        audio_path=tmp_path / "input.wav",
        source_language="ja-JP",
        target_language="zh-CN",
        voice_mode="convert",
    )
    request.audio_path.write_bytes(b"fake audio")

    class TimedVoiceTtsProvider(FakeTtsProvider):
        name = "timed-voice-tts"
        audio_mime_type = "audio/mp4"
        supported_voice_modes = ("convert",)

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
            return TtsOutput(
                audio_bytes=b"VOICE-CONVERT",
                audio_mime_type="audio/wav",
                timings_ms={"tts": 12.5, "voice_conversion": 34.5},
                warnings=["voice conversion warning"],
            )

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"ja-JP": "ありがとう。"}),
        translator=FakeTranslationProvider({("ja-JP", "zh-CN", "ありがとう。"): "谢谢。"}),
        tts=TimedVoiceTtsProvider(),
    )

    result = pipeline.run(request)

    assert result.output_audio_bytes == b"VOICE-CONVERT"
    assert result.output_audio_mime_type == "audio/wav"
    assert result.timings_ms["tts"] == 12.5
    assert result.timings_ms["voice_conversion"] == 34.5
    assert result.timings_ms["total"] >= 0
    assert result.warnings == ["voice conversion warning"]


def test_openai_seed_vc_pipeline_reports_voice_conversion_progress(tmp_path: Path) -> None:
    request = PipelineRequest(
        audio_path=tmp_path / "input.wav",
        source_language="ja-JP",
        target_language="zh-CN",
        voice_mode="convert",
    )
    request.audio_path.write_bytes(b"fake audio")
    progress: list[PipelineProgress] = []

    class BaseTtsProvider:
        model = "fake-gpt-4o-mini-tts"
        name = "fake-openai-tts"
        audio_mime_type = "audio/wav"
        supported_voice_modes = ("default",)

        def synthesize(self, text: str, target_language: str) -> TtsOutput:
            return TtsOutput(audio_bytes=b"openai source wav", audio_mime_type="audio/wav", timings_ms={"tts": 1.0})

    class SeedVcProvider:
        def synthesize_with_voice(
            self,
            text: str,
            target_language: str,
            *,
            reference_audio_path: Path,
            reference_text: str,
            reference_language: str,
            voice_mode: str,
            voice_settings: dict[str, object] | None = None,
            progress_callback=None,
        ) -> TtsOutput:
            if progress_callback is not None:
                progress_callback(PipelineProgress("tts", "音声生成", "fake-openai-tts"))
                progress_callback(PipelineProgress("voice_conversion", "声質変換", "Seed-VC"))
            return TtsOutput(
                audio_bytes=b"seed vc wav",
                audio_mime_type="audio/wav",
                timings_ms={"tts": 1.0, "voice_conversion": 2.0},
            )

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"ja-JP": "ありがとう。"}),
        translator=FakeTranslationProvider({("ja-JP", "zh-CN", "ありがとう。"): "谢谢。"}),
        tts=OpenAiSeedVcTtsProvider(base_tts=BaseTtsProvider(), seed_vc_tts=SeedVcProvider()),  # type: ignore[arg-type]
    )

    pipeline.run(request, progress_callback=progress.append)

    assert [item.stage for item in progress] == [
        "asr",
        "translation",
        "text_transform",
        "tts",
        "voice_conversion",
    ]


def test_pipeline_preloads_providers_that_support_it() -> None:
    called: list[str] = []

    class PreloadAsrProvider(FakeAsrProvider):
        def preload(self) -> None:
            called.append("asr")

    class PreloadTranslationProvider(FakeTranslationProvider):
        def preload(self) -> None:
            called.append("translation")

    class PreloadTtsProvider(FakeTtsProvider):
        def preload(self) -> None:
            called.append("tts")

    pipeline = SpeechTranslationPipeline(
        asr=PreloadAsrProvider({"ja-JP": "ありがとう。"}),
        translator=PreloadTranslationProvider({("ja-JP", "zh-CN", "ありがとう。"): "谢谢。"}),
        tts=PreloadTtsProvider(),
    )

    pipeline.preload()

    assert called == ["asr", "translation", "tts"]
