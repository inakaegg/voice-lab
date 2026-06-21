from __future__ import annotations

from pathlib import Path

from mo_speech.benchmark import run_benchmark
from mo_speech.pipeline import PipelineRequest, SpeechTranslationPipeline
from mo_speech.providers.fake import FakeAsrProvider, FakeTranslationProvider, FakeTtsProvider


def test_run_benchmark_reuses_pipeline_by_default(tmp_path: Path) -> None:
    request = PipelineRequest(
        audio_path=tmp_path / "input.wav",
        source_language="ja-JP",
        target_language="zh-CN",
    )
    request.audio_path.write_bytes(b"fake audio")
    created = 0

    def pipeline_factory() -> SpeechTranslationPipeline:
        nonlocal created
        created += 1
        return SpeechTranslationPipeline(
            asr=FakeAsrProvider({"ja-JP": "ありがとう。"}),
            translator=FakeTranslationProvider({("ja-JP", "zh-CN", "ありがとう。"): "谢谢。"}),
            tts=FakeTtsProvider(),
        )

    runs = run_benchmark(pipeline_factory, request, repeat=3)

    assert created == 1
    assert len(runs) == 3
    assert runs[0].index == 1
    assert runs[0].transcript == "ありがとう。"
    assert runs[0].translated_text == "谢谢。"
    assert runs[0].timings_ms["total"] >= 0
    assert runs[0].providers == {"asr": "fake-asr", "translation": "fake-translation", "tts": "fake-tts"}


def test_run_benchmark_can_create_fresh_pipeline_per_run(tmp_path: Path) -> None:
    request = PipelineRequest(
        audio_path=tmp_path / "input.wav",
        source_language="ja-JP",
        target_language="zh-CN",
    )
    request.audio_path.write_bytes(b"fake audio")
    created = 0

    def pipeline_factory() -> SpeechTranslationPipeline:
        nonlocal created
        created += 1
        return SpeechTranslationPipeline(
            asr=FakeAsrProvider({"ja-JP": "ありがとう。"}),
            translator=FakeTranslationProvider({("ja-JP", "zh-CN", "ありがとう。"): "谢谢。"}),
            tts=FakeTtsProvider(),
        )

    runs = run_benchmark(pipeline_factory, request, repeat=3, fresh_pipeline_per_run=True)

    assert created == 3
    assert [run.index for run in runs] == [1, 2, 3]
