from __future__ import annotations

from .pipeline import SpeechProviderBundle
from .providers.voice import VoiceConversionService


def provider_names(bundle: SpeechProviderBundle) -> dict[str, str]:
    return {
        "asr": bundle.asr.name,
        "translation": bundle.translator.name,
        "tts": bundle.tts.name,
    }


def supported_voice_modes(bundle: SpeechProviderBundle) -> list[str]:
    return list(dict.fromkeys(getattr(bundle.tts, "supported_voice_modes", ("default",))))


def voice_conversion_backends(service: VoiceConversionService) -> list[dict[str, object]]:
    return [
        {
            "id": item.backend_id,
            "label": item.label,
            "provider": item.provider,
            "available": item.available,
            "reason": item.reason,
            "settings": item.settings,
        }
        for item in service.backend_infos()
    ]
