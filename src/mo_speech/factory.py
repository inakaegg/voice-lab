from __future__ import annotations

import os

from .env import load_project_env
from .pipeline import SpeechProviderBundle
from .providers.fake import FakeAsrProvider, FakeTranslationProvider, FakeTtsProvider
from .providers.openai_api import create_openai_provider_bundle


load_project_env()


def create_provider_bundle_from_env() -> SpeechProviderBundle:
    if os.getenv("MO_PROVIDER_MODE") == "local":
        return create_local_provider_bundle()
    if os.getenv("MO_PROVIDER_MODE") == "openai":
        return create_openai_provider_bundle()
    return create_demo_provider_bundle()


def create_demo_provider_bundle() -> SpeechProviderBundle:
    return SpeechProviderBundle(
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


def create_local_provider_bundle() -> SpeechProviderBundle:
    from .providers.local import create_local_asr_provider, create_local_translation_provider, create_local_tts_provider

    return SpeechProviderBundle(
        asr=create_local_asr_provider(),
        translator=create_local_translation_provider(),
        tts=create_local_tts_provider(),
    )
