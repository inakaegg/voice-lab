from mo_speech.api_runtime import supported_voice_modes
from mo_speech.pipeline import SpeechProviderBundle
from mo_speech.providers.fake import FakeAsrProvider, FakeTranslationProvider, FakeTtsProvider


def test_provider_bundle_holds_shared_speech_providers() -> None:
    asr = FakeAsrProvider({"ja-JP": "ありがとう。"})
    translator = FakeTranslationProvider({("ja-JP", "zh-CN", "ありがとう。"): "谢谢。"})
    tts = FakeTtsProvider()

    bundle = SpeechProviderBundle(asr=asr, translator=translator, tts=tts)

    assert bundle.asr is asr
    assert bundle.translator is translator
    assert bundle.tts is tts


def test_provider_bundle_reports_tts_voice_modes_without_translation_flow() -> None:
    class VoiceModeTtsProvider(FakeTtsProvider):
        supported_voice_modes = ("default", "convert", "default")

    bundle = SpeechProviderBundle(
        asr=FakeAsrProvider({}),
        translator=FakeTranslationProvider({}),
        tts=VoiceModeTtsProvider(),
    )

    assert supported_voice_modes(bundle) == ["default", "convert"]
    assert not hasattr(bundle, "run")
    assert not hasattr(bundle, "supported_routes")


def test_provider_bundle_preloads_providers_that_support_it() -> None:
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

    bundle = SpeechProviderBundle(
        asr=PreloadAsrProvider({}),
        translator=PreloadTranslationProvider({}),
        tts=PreloadTtsProvider(),
    )

    bundle.preload()

    assert called == ["asr", "translation", "tts"]
