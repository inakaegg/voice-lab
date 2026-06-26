from pathlib import Path
from time import sleep
from types import SimpleNamespace

from mo_speech.api_audio_history import (
    save_audio_history_uploaded_output,
    serialize_audio_history_entry,
    serialize_audio_history_settings,
)
from mo_speech.api_jobs import TranslationJobStore
from mo_speech.api_runtime import provider_names, supported_voice_modes
from mo_speech.audio_history import AudioHistoryStore
from mo_speech.pipeline import PipelineProgress, PipelineRequest, PipelineResult


def test_runtime_helpers_serialize_provider_names_and_voice_modes() -> None:
    class CustomPipeline:
        asr = SimpleNamespace(name="custom-asr")
        translator = SimpleNamespace(name="custom-translation")
        tts = SimpleNamespace(name="custom-tts", supported_voice_modes=("convert", "clone", "convert"))

    assert provider_names(CustomPipeline()) == {
        "asr": "custom-asr",
        "translation": "custom-translation",
        "tts": "custom-tts",
    }
    assert supported_voice_modes(CustomPipeline()) == ["convert", "clone"]


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


def test_translation_job_store_runs_pipeline_and_saves_history(tmp_path) -> None:
    class FakePipeline:
        asr = SimpleNamespace(name="fake-asr")
        translator = SimpleNamespace(name="fake-translation")
        tts = SimpleNamespace(name="fake-tts")

        def run(self, request, progress_callback=None) -> PipelineResult:
            if progress_callback is not None:
                progress_callback(PipelineProgress("translation", "翻訳", self.translator.name, transcript="Halo."))
            return PipelineResult(
                transcript="Halo.",
                translated_text="こんにちは。",
                transformed_text="こんにちは。",
                output_audio_bytes=b"translated wav",
                output_audio_mime_type="audio/wav",
                timings_ms={"total": 1.0},
                providers={"asr": self.asr.name, "translation": self.translator.name, "tts": self.tts.name},
            )

    history_store = AudioHistoryStore(root=tmp_path / "history", limit=10, enabled=True)
    audio_path = tmp_path / "input.wav"
    audio_path.write_bytes(b"input wav")
    job_store = TranslationJobStore({"qwen": FakePipeline()}, history_store)
    request = PipelineRequest(
        audio_path=audio_path,
        source_language="id-ID",
        target_language="ja-JP",
        voice_mode="default",
    )

    started = job_store.start(request, audio_path, "qwen")

    for _ in range(20):
        snapshot = job_store.snapshot(started["job_id"])
        if snapshot["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("translation job did not finish")

    assert snapshot["partial_result"] == {
        "transcript": "Halo.",
        "translated_text": "こんにちは。",
        "transformed_text": "こんにちは。",
    }
    assert snapshot["result"]["audio_base64"] != ""
    assert not audio_path.exists()
    outputs = history_store.list_entries("outputs")
    assert len(outputs) == 1
    assert outputs[0].metadata is not None
    assert outputs[0].metadata["text_preview"] == "こんにちは。"
