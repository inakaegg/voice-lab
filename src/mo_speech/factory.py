from __future__ import annotations

import os

from .pipeline import SpeechTranslationPipeline
from .providers.fake import FakeAsrProvider, FakeTranslationProvider, FakeTtsProvider
from .providers.openai_api import create_openai_pipeline


def create_pipeline_from_env() -> SpeechTranslationPipeline:
    if os.getenv("MO_PROVIDER_MODE") == "local":
        return create_local_pipeline()
    if os.getenv("MO_PROVIDER_MODE") == "openai":
        return create_openai_pipeline()
    return create_demo_pipeline()


def create_demo_pipeline() -> SpeechTranslationPipeline:
    return SpeechTranslationPipeline(
        asr=FakeAsrProvider(
            {
                "id-ID": "Selamat pagi. Terima kasih.",
                "ja-JP": "ありがとう。",
            }
        ),
        translator=FakeTranslationProvider(
            {
                ("id-ID", "ja-JP", "Selamat pagi. Terima kasih."): "おはようございます。ありがとうございます。",
                ("ja-JP", "zh-CN", "ありがとう。"): "谢谢。",
            }
        ),
        tts=FakeTtsProvider(),
    )


def create_local_pipeline() -> SpeechTranslationPipeline:
    from .providers.local import create_local_asr_provider, create_local_translation_provider, create_local_tts_provider

    return SpeechTranslationPipeline(
        asr=create_local_asr_provider(),
        translator=create_local_translation_provider(),
        tts=create_local_tts_provider(),
    )
