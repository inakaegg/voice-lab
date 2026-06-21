from __future__ import annotations

import base64

import pytest

from mo_speech import runpod_handler


def test_runpod_handler_translates_base64_audio(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runpod_handler, "_PIPELINE", None)
    event = {
        "input": {
            "audio_base64": base64.b64encode(b"fake audio").decode("ascii"),
            "source_language": "ja-JP",
            "target_language": "zh-CN",
            "voice_mode": "default",
        }
    }

    payload = runpod_handler.handler(event)

    assert payload["transcript"] == "ありがとう。"
    assert payload["translated_text"] == "谢谢。"
    assert payload["audio_mime_type"] == "audio/wav"
    assert payload["providers"] == {"asr": "fake-asr", "translation": "fake-translation", "tts": "fake-tts"}
    assert payload["audio_base64"] != ""


def test_runpod_handler_requires_audio_base64(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runpod_handler, "_PIPELINE", None)

    with pytest.raises(ValueError, match="audio_base64 is required"):
        runpod_handler.handler({"input": {"source_language": "ja-JP", "target_language": "zh-CN"}})
