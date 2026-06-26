from __future__ import annotations

from .pipeline import SpeechTranslationPipeline
from .providers.openai_api import (
    openai_pipeline_status,
    openai_realtime_pipeline_status,
    openai_realtime_streaming_status,
)
from .providers.runpod_serverless import (
    RunpodServerlessSpeechTranslationPipeline,
    runpod_serverless_pipeline_status,
)
from .providers.voice import VoiceConversionService


def provider_names(pipeline: SpeechTranslationPipeline) -> dict[str, str]:
    return {
        "asr": pipeline.asr.name,
        "translation": pipeline.translator.name,
        "tts": pipeline.tts.name,
    }


def translation_backends(
    qwen_pipeline: SpeechTranslationPipeline,
    openai_pipeline: SpeechTranslationPipeline,
    openai_realtime_pipeline,
    runpod_serverless_pipeline: RunpodServerlessSpeechTranslationPipeline | None = None,
) -> list[dict[str, object]]:
    return [
        openai_pipeline_status(openai_pipeline),
        openai_realtime_pipeline_status(openai_realtime_pipeline),
        openai_realtime_streaming_status(),
        {
            "id": "qwen",
            "label": "音声翻訳（Qwen/local）",
            "available": True,
            "reason": "",
            "providers": provider_names(qwen_pipeline),
            "settings": {
                "supported_routes": [
                    {"source_language": "id-ID", "target_language": "ja-JP"},
                    {"source_language": "ja-JP", "target_language": "zh-CN"},
                ],
                "supported_voice_modes": supported_voice_modes(qwen_pipeline),
                "source_language_mode": "specified",
                "text_transform": True,
            },
        },
        runpod_serverless_pipeline_status(runpod_serverless_pipeline),
    ]


def select_translation_pipeline(
    pipelines: dict[str, object],
    translation_backend: str,
):
    if translation_backend not in pipelines:
        raise ValueError(f"unsupported translation backend: {translation_backend}")
    return pipelines[translation_backend]


def supported_voice_modes(pipeline: SpeechTranslationPipeline) -> list[str]:
    provider_modes = getattr(pipeline.tts, "supported_voice_modes", ("default",))
    modes: list[str] = []
    for mode in provider_modes:
        mode_text = str(mode)
        if mode_text not in modes:
            modes.append(mode_text)
    return modes


def voice_conversion_backends(service: VoiceConversionService) -> list[dict[str, object]]:
    return [
        {
            "id": info.backend_id,
            "label": info.label,
            "provider": info.provider,
            "available": info.available,
            "reason": info.reason,
            "settings": info.settings,
        }
        for info in service.backend_infos()
    ]
