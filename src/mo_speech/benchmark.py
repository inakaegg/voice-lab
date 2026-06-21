from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Callable

from .pipeline import PipelineRequest, SpeechTranslationPipeline


@dataclass(frozen=True)
class BenchmarkRun:
    index: int
    transcript: str
    translated_text: str
    transformed_text: str
    timings_ms: dict[str, float]
    providers: dict[str, str]
    output_audio_mime_type: str
    output_audio_bytes: int

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def run_benchmark(
    pipeline_factory: Callable[[], SpeechTranslationPipeline],
    request: PipelineRequest,
    *,
    repeat: int,
    fresh_pipeline_per_run: bool = False,
) -> list[BenchmarkRun]:
    if repeat < 1:
        raise ValueError("repeat must be greater than 0")

    runs: list[BenchmarkRun] = []
    pipeline: SpeechTranslationPipeline | None = None
    if not fresh_pipeline_per_run:
        pipeline = pipeline_factory()

    for index in range(1, repeat + 1):
        active_pipeline = pipeline_factory() if fresh_pipeline_per_run else pipeline
        assert active_pipeline is not None
        result = active_pipeline.run(request)
        runs.append(
            BenchmarkRun(
                index=index,
                transcript=result.transcript,
                translated_text=result.translated_text,
                transformed_text=result.transformed_text,
                timings_ms=result.timings_ms,
                providers=result.providers,
                output_audio_mime_type=result.output_audio_mime_type,
                output_audio_bytes=len(result.output_audio_bytes),
            )
        )

    return runs
