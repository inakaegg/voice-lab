from types import SimpleNamespace

from mo_speech.api_audio_history import (
    save_audio_history_uploaded_output,
    serialize_audio_history_entry,
    serialize_audio_history_settings,
)
from mo_speech.api_runtime import provider_names, supported_voice_modes
from mo_speech.audio_history import AudioHistoryStore


def test_runtime_helpers_serialize_provider_names_and_voice_modes() -> None:
    class CustomBundle:
        asr = SimpleNamespace(name="custom-asr")
        translator = SimpleNamespace(name="custom-translation")
        tts = SimpleNamespace(name="custom-tts", supported_voice_modes=("convert", "clone", "convert"))

    assert provider_names(CustomBundle()) == {
        "asr": "custom-asr",
        "translation": "custom-translation",
        "tts": "custom-tts",
    }
    assert supported_voice_modes(CustomBundle()) == ["convert", "clone"]


def test_audio_history_api_helpers_prepare_and_serialize_uploaded_output(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "mo_speech.api_audio_history.prepare_audio_history_wav",
        lambda audio_bytes, suffix: (
            b"normalized wav",
            ".wav",
            {
                "audio_mime_type": "audio/wav",
                "history_audio_format": "wav_24000_mono_pcm16",
                "original_audio_suffix": suffix,
            },
        ),
    )
    store = AudioHistoryStore(root=tmp_path / "history", limit=7, enabled=True)

    saved = save_audio_history_uploaded_output(
        store,
        b"uploaded webm",
        suffix=".webm",
        metadata={
            "endpoint": "openai-realtime-streaming",
            "filename": "streaming.webm",
            "content_type": "audio/webm",
            "target_language": "ja-JP",
        },
    )

    assert saved is not None
    settings = serialize_audio_history_settings(store)
    entry = serialize_audio_history_entry("outputs", saved)
    assert settings["limit"] == 7
    assert entry["filename"].endswith(".wav")
    assert entry["label"] == "Realtime streaming出力"
    assert entry["media_type"] == "audio/wav"
    assert entry["details"] == ["openai-realtime-streaming", "ja-JP", "streaming.webm"]
    assert entry["metadata"]["original_filename"] == "streaming.webm"
    assert entry["metadata"]["original_content_type"] == "audio/webm"
    assert saved.audio_path.read_bytes() == b"normalized wav"
