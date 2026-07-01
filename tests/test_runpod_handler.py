from __future__ import annotations

import base64

import pytest

from mo_speech import runpod_handler
from mo_speech.pipeline import PipelineProgress, PipelineResult, TtsOutput
from mo_speech.providers.voice import VoiceConversionBackendInfo, VoiceConversionService


def test_runpod_handler_translates_base64_audio(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runpod_handler, "_PIPELINE", None)
    monkeypatch.setattr(runpod_handler, "_PIPELINE_LOAD_MS", None)
    event = {
        "input": {
            "audio_base64": base64.b64encode(b"fake audio").decode("ascii"),
            "translation_backend": "qwen",
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
    assert payload["serverless"]["operation_mode"] == "translation"
    assert payload["serverless"]["worker_cold"] is True
    assert payload["serverless_timings_ms"]["handler_total"] >= 0
    assert payload["serverless_timings_ms"]["pipeline_load"] >= 0


def test_runpod_handler_defaults_to_openai_translation_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = {}

    class FakePipeline:
        def run(self, request):
            captured["translation_backend"] = "openai"
            return PipelineResult(
                transcript="こんにちは。",
                translated_text="Halo.",
                transformed_text="Halo.",
                output_audio_bytes=b"openai audio",
                output_audio_mime_type="audio/wav",
                timings_ms={"total": 1.0},
                providers={
                    "asr": "fake-openai-asr",
                    "translation": "fake-openai-translation",
                    "tts": "fake-openai-tts",
                },
            )

    def fake_translation_pipeline(translation_backend):
        captured["translation_backend"] = translation_backend
        return FakePipeline(), 1.0

    monkeypatch.setattr(runpod_handler, "_translation_pipeline", fake_translation_pipeline)
    event = {
        "input": {
            "audio_base64": base64.b64encode(b"fake audio").decode("ascii"),
            "source_language": "ja-JP",
            "target_language": "zh-CN",
            "voice_mode": "default",
        }
    }

    payload = runpod_handler.handler(event)

    assert captured["translation_backend"] == "openai"
    assert payload["providers"] == {
        "asr": "fake-openai-asr",
        "translation": "fake-openai-translation",
        "tts": "fake-openai-tts",
    }


def test_runpod_handler_accepts_user_effect_options_json(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runpod_handler, "_PIPELINE", None)
    event = {
        "input": {
            "audio_base64": base64.b64encode(b"fake audio").decode("ascii"),
            "translation_backend": "qwen",
            "source_language": "ja-JP",
            "target_language": "zh-CN",
            "voice_mode": "default",
            "text_transform": "user_effects",
            "text_transform_options": '{"joke_text":"先にひとこと。","joke_position":"before"}',
        }
    }

    payload = runpod_handler.handler(event)

    assert payload["transformed_text"] == "先にひとこと。 谢谢。"


def test_runpod_handler_converts_voice_base64_audio(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = FakeVcProvider()
    monkeypatch.setattr(runpod_handler, "_VOICE_CONVERSION_SERVICE", VoiceConversionService([provider]))
    event = {
        "input": {
            "operation_mode": "voice_conversion",
            "source_audio_base64": base64.b64encode(b"source audio").decode("ascii"),
            "reference_audio_base64": base64.b64encode(b"reference audio").decode("ascii"),
            "source_audio_mime_type": "audio/wav",
            "reference_audio_mime_type": "audio/wav",
            "voice_backend": "seed-vc",
            "seed_vc_diffusion_steps": 10,
            "seed_vc_reference_max_seconds": 5,
            "seed_vc_reference_auto_select": True,
        }
    }

    payload = runpod_handler.handler(event)

    assert payload["audio_mime_type"] == "audio/wav"
    assert payload["audio_base64"] != ""
    assert payload["providers"]["voice_conversion"] == "fake-vc-provider"
    assert payload["serverless"]["operation_mode"] == "voice_conversion"
    assert payload["serverless_timings_ms"]["handler_total"] >= 0
    assert provider.last_seed_vc_settings is not None
    assert provider.last_seed_vc_settings.reference_auto_select is True


def test_runpod_handler_inserts_audio_effect_after_voice_conversion(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = FakeVcProvider()
    captured = {}

    def fake_insert(payload, output_audio_bytes, output_audio_mime_type):
        captured["payload"] = payload
        captured["output_audio_bytes"] = output_audio_bytes
        captured["output_audio_mime_type"] = output_audio_mime_type
        return runpod_handler.AudioEffectInsertResult(
            audio_bytes=b"converted with effect",
            audio_mime_type="audio/wav",
            timings_ms={"audio_effect_insert": 2.0},
            warnings=[],
            inserted_count=1,
            insertion_points=[0.5],
        )

    monkeypatch.setattr(runpod_handler, "_VOICE_CONVERSION_SERVICE", VoiceConversionService([provider]))
    monkeypatch.setattr(runpod_handler, "_insert_audio_effect_from_payload", fake_insert)
    event = {
        "input": {
            "operation_mode": "voice_conversion",
            "source_audio_base64": base64.b64encode(b"source audio").decode("ascii"),
            "reference_audio_base64": base64.b64encode(b"reference audio").decode("ascii"),
            "audio_effect_audio_base64": base64.b64encode(b"moo").decode("ascii"),
            "audio_effect_audio_mime_type": "audio/mpeg",
            "audio_effect_enabled": True,
            "audio_effect_insert_mode": "silence_or_tail",
            "audio_effect_max_insertions": 2,
            "audio_effect_min_silence_ms": 450,
        }
    }

    payload = runpod_handler.handler(event)

    assert captured["output_audio_bytes"] == b"fake converted wav"
    assert payload["audio_base64"] == base64.b64encode(b"converted with effect").decode("ascii")
    assert payload["providers"]["audio_effect_insert"] == "ffmpeg"
    assert payload["timings_ms"]["audio_effect_insert"] == 2.0
    assert payload["audio_effect_inserted_count"] == 1
    assert payload["audio_effect_insertion_points"] == [0.5]


def test_runpod_handler_audio_suffix_ignores_mime_parameters() -> None:
    assert runpod_handler._audio_suffix("audio/webm;codecs=opus") == ".webm"
    assert runpod_handler._audio_suffix("video/webm; codecs=opus") == ".webm"
    assert runpod_handler._audio_suffix("audio/mp4; codecs=mp4a.40.2") == ".m4a"
    assert runpod_handler._audio_suffix("audio/mpeg; charset=binary") == ".mp3"


def test_runpod_handler_generates_text_tts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runpod_handler, "_TEXT_TTS_PROVIDERS", {"fake": FakeTextTtsProvider()})
    event = {
        "input": {
            "operation_mode": "text_tts",
            "text": "こんにちは",
            "target_language": "ja-JP",
            "tts_backend": "fake",
        }
    }

    payload = runpod_handler.handler(event)

    assert payload["audio_mime_type"] == "audio/wav"
    assert base64.b64decode(payload["audio_base64"]) == "TTS:ja-JP:こんにちは".encode()
    assert payload["providers"] == {"tts": "fake-text-tts"}
    assert payload["serverless"]["operation_mode"] == "text_tts"
    assert payload["serverless_timings_ms"]["text_tts_provider_load"] >= 0


def test_runpod_handler_generates_vibevoice_audio(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeVibeVoiceService:
        def generate(self, *, script_text, voice_paths, options):
            assert script_text == "Speaker 1: 你好。"
            assert len(voice_paths) == 1
            assert voice_paths[0].slot == 1
            assert voice_paths[0].path.read_bytes() == b"voice"
            assert options.model_id == "vibevoice-large-aoi-pinned"
            assert options.inference_steps == 2
            return type(
                "FakeVibeVoiceResult",
                (),
                {
                    "audio_bytes": b"vv audio",
                    "audio_mime_type": "audio/wav",
                    "normalized_script": script_text,
                    "timings_ms": {"vibevoice": 1.0},
                    "providers": {"vibevoice": "fake-vibevoice"},
                    "diagnostics": {},
                },
            )()

    monkeypatch.setattr(runpod_handler, "_VIBEVOICE_SERVICE", FakeVibeVoiceService())
    event = {
        "input": {
            "operation_mode": "vibevoice",
            "script": "Speaker 1: 你好。",
            "voices": [
                {
                    "speaker": 1,
                    "filename": "voice.wav",
                    "audio_mime_type": "audio/wav",
                    "audio_base64": base64.b64encode(b"voice").decode("ascii"),
                }
            ],
            "generation": {"model_id": "vibevoice-large-aoi-pinned", "inference_steps": 2},
        }
    }

    payload = runpod_handler.handler(event)

    assert payload["audio_mime_type"] == "audio/wav"
    assert base64.b64decode(payload["audio_base64"]) == b"vv audio"
    assert payload["normalized_script"] == "Speaker 1: 你好。"
    assert payload["providers"]["vibevoice"] == "fake-vibevoice"
    assert payload["serverless"]["operation_mode"] == "vibevoice"


def test_runpod_handler_reports_worker_diagnostics(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    cli_path = tmp_path / "vibevoice_cli.py"
    cli_path.write_text(
        "\n".join(
            [
                "def _install_vibevoice_modules_utils_alias():",
                "    pass",
                "inputs = self.processor(",
                "    text=[script_text],",
                "    voice_samples=[voice_samples_np],",
                ")",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("MO_IMAGE_REVISION", "abc123")
    monkeypatch.setenv("MO_IMAGE_TAG", "docker.io/example/mo-speech:test")
    monkeypatch.setenv("MO_VIBEVOICE_CLI", str(cli_path))

    payload = runpod_handler.handler({"input": {"operation_mode": "diagnostics"}})

    assert payload["image"]["revision"] == "abc123"
    assert payload["image"]["tag"] == "docker.io/example/mo-speech:test"
    assert payload["vibevoice_cli"]["path"] == str(cli_path)
    assert payload["vibevoice_cli"]["exists"] is True
    assert payload["vibevoice_cli"]["uses_parsed_scripts"] is False
    assert payload["vibevoice_cli"]["uses_raw_text_processor_call"] is True
    assert payload["vibevoice_cli"]["installs_vibevoice_modules_utils_alias"] is True
    assert payload["serverless"]["operation_mode"] == "diagnostics"


def test_runpod_handler_warms_translation_and_voice_conversion(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def fake_translation_pipeline(translation_backend):
        calls.append(("translation", translation_backend))
        return object(), 12.0

    def fake_voice_conversion_service():
        calls.append(("voice_conversion", "seed-vc"))
        return object(), 34.0

    monkeypatch.setattr(runpod_handler, "_translation_pipeline", fake_translation_pipeline)
    monkeypatch.setattr(runpod_handler, "_voice_conversion_service", fake_voice_conversion_service)

    payload = runpod_handler.handler(
        {
            "input": {
                "operation_mode": "warmup",
                "translation_backend": "qwen",
                "preload_translation": True,
                "preload_voice_conversion": True,
            }
        }
    )

    assert calls == [("translation", "qwen"), ("voice_conversion", "seed-vc")]
    assert payload["warm"] is True
    assert payload["providers"] == {"translation_backend": "qwen", "voice_conversion": "seed-vc"}
    assert payload["serverless"]["operation_mode"] == "warmup"
    assert payload["serverless"]["worker_cold"] is True
    assert payload["serverless_timings_ms"]["pipeline_load"] == 12.0
    assert payload["serverless_timings_ms"]["voice_conversion_service_load"] == 34.0


def test_runpod_handler_warmup_defaults_to_openai_translation_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def fake_translation_pipeline(translation_backend):
        calls.append(("translation", translation_backend))
        return object(), 12.0

    monkeypatch.setattr(runpod_handler, "_translation_pipeline", fake_translation_pipeline)

    payload = runpod_handler.handler(
        {
            "input": {
                "operation_mode": "warmup",
                "preload_translation": True,
                "preload_voice_conversion": False,
            }
        }
    )

    assert calls == [("translation", "openai")]
    assert payload["providers"] == {"translation_backend": "openai"}


def test_runpod_preload_defaults_to_openai_translation_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def fake_translation_pipeline(translation_backend):
        calls.append(("translation", translation_backend))
        return object(), 12.0

    def fake_voice_conversion_service():
        calls.append(("voice_conversion", "seed-vc"))
        return object(), 34.0

    monkeypatch.setattr(runpod_handler, "_translation_pipeline", fake_translation_pipeline)
    monkeypatch.setattr(runpod_handler, "_voice_conversion_service", fake_voice_conversion_service)
    monkeypatch.setenv("MO_RUNPOD_PRELOAD_ON_START", "1")
    monkeypatch.setenv("MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START", "1")
    monkeypatch.delenv("RUNPOD_SERVERLESS_TRANSLATION_BACKEND", raising=False)

    runpod_handler._preload_for_serverless()

    assert calls == [("translation", "openai"), ("voice_conversion", "seed-vc")]


def test_runpod_voice_conversion_service_preloads_provider_on_first_load(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    class FakeService:
        def preload(self):
            calls.append("preload")

    service = FakeService()
    monkeypatch.setattr(runpod_handler, "_VOICE_CONVERSION_SERVICE", None)
    monkeypatch.setattr(runpod_handler, "_VOICE_CONVERSION_SERVICE_LOAD_MS", None)
    monkeypatch.setattr(runpod_handler, "create_voice_conversion_service_from_env", lambda: service)

    loaded, first_load_ms = runpod_handler._voice_conversion_service()
    loaded_again, second_load_ms = runpod_handler._voice_conversion_service()

    assert loaded is service
    assert loaded_again is service
    assert first_load_ms is not None
    assert second_load_ms is None
    assert calls == ["preload"]


def test_runpod_handler_requires_audio_base64(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runpod_handler, "_PIPELINE", None)

    with pytest.raises(ValueError, match="audio_base64 is required"):
        runpod_handler.handler({"input": {"source_language": "ja-JP", "target_language": "zh-CN"}})


@pytest.mark.parametrize(
    ("mime_type", "suffix"),
    [
        ("audio/mp4", ".m4a"),
        ("audio/mp4a-latm", ".m4a"),
        ("audio/x-m4a", ".m4a"),
        ("audio/webm", ".webm"),
        ("video/webm", ".webm"),
        ("audio/mpeg", ".mp3"),
        ("audio/x-wav", ".wav"),
    ],
)
def test_runpod_handler_audio_suffix_keeps_container_type(mime_type: str, suffix: str) -> None:
    assert runpod_handler._audio_suffix(mime_type) == suffix


class FakeVcProvider:
    backend_id = "seed-vc"
    label = "Seed-VC"
    name = "fake-vc-provider"
    audio_mime_type = "audio/wav"

    def __init__(self):
        self.last_seed_vc_settings = None

    def backend_info(self) -> VoiceConversionBackendInfo:
        return VoiceConversionBackendInfo(self.backend_id, self.label, self.name, True)

    def convert(self, *, source_audio_path, reference_audio_path, seed_vc_settings=None, progress_callback=None):
        self.last_seed_vc_settings = seed_vc_settings
        if progress_callback is not None:
            progress_callback(PipelineProgress("voice_conversion", "声質変換", self.name))
        return type(
            "FakeTtsOutput",
            (),
            {
                "audio_bytes": b"fake converted wav",
                "audio_mime_type": "audio/wav",
                "timings_ms": {"voice_conversion": 1.0},
                "warnings": [],
            },
        )()


class FakeTextTtsProvider:
    name = "fake-text-tts"
    audio_mime_type = "audio/wav"

    def synthesize(self, text, target_language):
        return TtsOutput(
            audio_bytes=f"TTS:{target_language}:{text}".encode(),
            audio_mime_type="audio/wav",
            timings_ms={"tts": 1.0, "total": 1.0},
            warnings=[],
        )
