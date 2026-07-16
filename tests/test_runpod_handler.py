from __future__ import annotations

import base64
import sys
from types import SimpleNamespace

import pytest

from mo_speech import runpod_handler
from mo_speech.pipeline import PipelineProgress, PipelineResult, TtsOutput
from mo_speech.providers.openai_api import AsrTranscription
from mo_speech.providers.voice import VoiceConversionBackendInfo, VoiceConversionService


def test_runpod_progress_failure_does_not_abort_processing(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_progress_update(*_args: object) -> None:
        raise RuntimeError("progress channel unavailable")

    fake_runpod = SimpleNamespace(
        serverless=SimpleNamespace(progress_update=fail_progress_update),
    )
    monkeypatch.setitem(sys.modules, "runpod", fake_runpod)

    runpod_handler._report_runpod_progress(
        {"id": "job-1"},
        {"stage": "loading_model", "label": "FunASRモデルを読み込んでいます"},
    )


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


def test_runpod_handler_transcribes_chinese_practice_with_funasr(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeFunAsrProvider:
        name = "funasr-paraformer-zh"
        model = "funasr/paraformer-zh"

        def transcribe_detail(self, audio_path, source_language, *, include_timestamps):
            assert audio_path.read_bytes() == b"chinese attempt"
            assert source_language == "zh-CN"
            assert include_timestamps is True
            return AsrTranscription(
                text="在中国的AI服务方面。",
                model=self.model,
                words=[
                    {"text": "在", "start": 0.1, "end": 0.2},
                    {"text": "中国", "start": 0.2, "end": 0.5},
                ],
                segments=[{"text": "在中国的AI服务方面。", "start": 0.1, "end": 1.4}],
                timestamp_granularities=["word"],
            )

    monkeypatch.setattr(runpod_handler, "_FUNASR_PRACTICE_PROVIDER", FakeFunAsrProvider())

    payload = runpod_handler.handler(
        {
            "input": {
                "operation_mode": "practice_asr",
                "audio_base64": base64.b64encode(b"chinese attempt").decode("ascii"),
                "audio_mime_type": "audio/webm;codecs=opus",
                "source_language": "zh-CN",
            }
        }
    )

    assert payload["text"] == "在中国的AI服务方面。"
    assert payload["model"] == "funasr/paraformer-zh"
    assert payload["words"][0] == {"text": "在", "start": 0.1, "end": 0.2}
    assert payload["timestamp_granularities"] == ["word"]
    assert payload["providers"] == {"asr": "funasr-paraformer-zh"}
    assert payload["serverless"]["operation_mode"] == "practice_asr"


def test_runpod_handler_transcribes_model_and_attempt_with_progress(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[bytes, str]] = []
    progress: list[dict[str, object]] = []

    class FakeFunAsrProvider:
        name = "funasr-paraformer-zh"
        model = "funasr/paraformer-zh"

        def transcribe_detail(self, audio_path, source_language, *, include_timestamps):
            assert source_language == "zh-CN"
            assert include_timestamps is True
            audio = audio_path.read_bytes()
            text = "你好吗？" if audio == b"model audio" else "你哈吗？"
            calls.append((audio, text))
            return AsrTranscription(
                text=text,
                model=self.model,
                words=[{"text": text.rstrip("？"), "start": 0.1, "end": 0.9}],
                timestamp_granularities=["word"],
            )

    monkeypatch.setattr(runpod_handler, "_FUNASR_PRACTICE_PROVIDER", FakeFunAsrProvider())
    monkeypatch.setattr(runpod_handler, "_report_runpod_progress", lambda _event, value: progress.append(value))

    payload = runpod_handler.handler(
        {
            "id": "job-1",
            "input": {
                "operation_mode": "practice_asr",
                "audio_base64": base64.b64encode(b"attempt audio").decode("ascii"),
                "model_audio_base64": base64.b64encode(b"model audio").decode("ascii"),
                "audio_mime_type": "audio/webm",
                "model_audio_mime_type": "audio/wav",
                "source_language": "zh-CN",
                "target_text": "你好吗？",
            },
        }
    )

    assert calls == [(b"model audio", "你好吗？"), (b"attempt audio", "你哈吗？")]
    assert payload["text"] == "你哈吗？"
    assert payload["target_text"] == "你好吗？"
    assert payload["model_transcription"]["text"] == "你好吗？"
    assert payload["practice_asr_contract_version"] == 2
    assert [entry["stage"] for entry in progress] == [
        "initializing",
        "transcribing_model",
        "transcribing_attempt",
        "finalizing",
    ]
    assert all(entry["model"] == "funasr/paraformer-zh" for entry in progress)


def test_runpod_handler_releases_voice_conversion_before_funasr(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    class FakeVoiceConversionService:
        def release(self):
            calls.append("release-vc")

    class FakeFunAsrProvider:
        name = "funasr-paraformer-zh"

        def transcribe_detail(self, _audio_path, _source_language, *, include_timestamps):
            assert include_timestamps is True
            calls.append("transcribe-funasr")
            return AsrTranscription(text="你好", model="funasr/paraformer-zh")

    monkeypatch.setattr(runpod_handler, "_VOICE_CONVERSION_SERVICE", FakeVoiceConversionService())
    monkeypatch.setattr(runpod_handler, "_VOICE_CONVERSION_SERVICE_LOAD_MS", 1.0)
    monkeypatch.setattr(runpod_handler, "_FUNASR_PRACTICE_PROVIDER", FakeFunAsrProvider())

    runpod_handler.handler(
        {
            "input": {
                "operation_mode": "practice_asr",
                "audio_base64": base64.b64encode(b"attempt").decode("ascii"),
                "source_language": "zh-CN",
            }
        }
    )

    assert calls == ["release-vc", "transcribe-funasr"]
    assert runpod_handler._VOICE_CONVERSION_SERVICE is None
    assert runpod_handler._VOICE_CONVERSION_SERVICE_LOAD_MS is None


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


def test_runpod_handler_reports_seed_vc_model_progress(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = FakeVcProvider()
    progress = []
    monkeypatch.setattr(runpod_handler, "_VOICE_CONVERSION_SERVICE", VoiceConversionService([provider]))
    monkeypatch.setattr(runpod_handler, "_report_runpod_progress", lambda _event, item: progress.append(item))

    runpod_handler.handler(
        {
            "id": "voice-job-1",
            "input": {
                "operation_mode": "voice_conversion",
                "source_audio_base64": base64.b64encode(b"source audio").decode("ascii"),
                "reference_audio_base64": base64.b64encode(b"reference audio").decode("ascii"),
                "source_audio_mime_type": "audio/wav",
                "reference_audio_mime_type": "audio/wav",
                "voice_backend": "seed-vc",
            },
        }
    )

    assert progress[0]["stage"] == "initializing"
    assert progress[1]["stage"] == "loading_seed_vc_model"
    assert progress[-1]["stage"] == "voice_conversion"
    assert all(item["model"] for item in progress)


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
    progress: list[dict[str, object]] = []

    class FakeVibeVoiceService:
        def generate(self, *, script_text, voice_paths, options, progress_callback=None):
            assert script_text == "Speaker 1: 你好。"
            assert len(voice_paths) == 1
            assert voice_paths[0].slot == 1
            assert voice_paths[0].path.read_bytes() == b"voice"
            assert options.model_id == "vibevoice-large-aoi-pinned"
            assert options.inference_steps == 2
            assert progress_callback is not None
            progress_callback("generation", "VibeVoice生成中 4/10 (40%)")
            progress_callback("asr", "指定台詞ASR")
            progress_callback("loading_model", "Seed-VCモデルを読み込んでいます")
            progress_callback("voice_conversion", "指定台詞 Line 1 VC 1/1")
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
    monkeypatch.setattr(runpod_handler, "_report_runpod_progress", lambda _event, value: progress.append(value))
    event = {
        "id": "vv-job",
        "input": {
            "operation_mode": "vibevoice",
            "response_audio_format": "wav",
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
            "script_translation": {
                "enabled": True,
                "output_language": "zh-CN",
                "source_script": "Speaker 1: こんにちは。",
                "translated_script": "Speaker 1: 你好。",
                "model": "test-model",
                "provider": "openai-responses",
            },
        }
    }

    payload = runpod_handler.handler(event)

    assert payload["audio_mime_type"] == "audio/wav"
    assert base64.b64decode(payload["audio_base64"]) == b"vv audio"
    assert payload["normalized_script"] == "Speaker 1: 你好。"
    assert payload["providers"]["vibevoice"] == "fake-vibevoice"
    assert payload["diagnostics"]["script_translation"]["translated_script"] == "Speaker 1: 你好。"
    assert payload["diagnostics"]["script_translation"]["model"] == "test-model"
    assert payload["serverless"]["operation_mode"] == "vibevoice"
    assert [item["stage"] for item in progress] == [
        "initializing",
        "loading_vibevoice_model",
        "vibevoice_generation",
        "directed_asr",
        "loading_seed_vc_model",
        "voice_conversion",
        "finalizing",
    ]
    assert progress[1]["model"] == "vibevoice-large-aoi-pinned"
    assert progress[3]["model"] == "whisper-1"
    assert progress[4]["model"] == "Seed-VC"


def test_runpod_handler_rejects_vibevoice_url_voice() -> None:
    with pytest.raises(ValueError, match="audio_base64 is required"):
        runpod_handler.handler(
            {
                "input": {
                    "operation_mode": "vibevoice",
                    "response_audio_format": "wav",
                    "script": "Speaker 1: こんにちは。",
                    "voices": [
                        {
                            "speaker": 1,
                            "url": "https://youtu.be/zDZvAmCJJaY?t=2129",
                            "duration_seconds": 6,
                        }
                    ],
                }
            }
        )


def test_runpod_handler_rejects_reference_audio_from_url_operation() -> None:
    with pytest.raises(ValueError, match="unsupported operation_mode: reference_audio_from_url"):
        runpod_handler.handler(
            {
                "input": {
                    "operation_mode": "reference_audio_from_url",
                    "url": "https://youtu.be/zDZvAmCJJaY?t=2129",
                    "duration_seconds": 5,
                }
            }
        )


def test_runpod_handler_compresses_vibevoice_audio_to_mp3_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class FakeVibeVoiceService:
        def generate(self, *, script_text, voice_paths, options):
            return type(
                "FakeVibeVoiceResult",
                (),
                {
                    "audio_bytes": b"RIFF fake wav",
                    "audio_mime_type": "audio/wav",
                    "normalized_script": script_text,
                    "timings_ms": {"vibevoice": 1.0},
                    "providers": {"vibevoice": "fake-vibevoice"},
                    "diagnostics": {},
                    "artifacts": [],
                },
            )()

    def fake_encode(audio_bytes, *, source_mime_type, output_format, bitrate, timeout_seconds):
        captured["audio_bytes"] = audio_bytes
        captured["source_mime_type"] = source_mime_type
        captured["output_format"] = output_format
        captured["bitrate"] = bitrate
        captured["timeout_seconds"] = timeout_seconds
        return b"mp3 audio", "audio/mpeg"

    monkeypatch.setattr(runpod_handler, "_VIBEVOICE_SERVICE", FakeVibeVoiceService())
    monkeypatch.setattr(runpod_handler, "_encode_runpod_response_audio_with_ffmpeg", fake_encode)
    monkeypatch.delenv("MO_RUNPOD_VIBEVOICE_RESPONSE_AUDIO_FORMAT", raising=False)

    payload = runpod_handler.handler(
        {
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
            }
        }
    )

    assert captured["audio_bytes"] == b"RIFF fake wav"
    assert captured["source_mime_type"] == "audio/wav"
    assert captured["output_format"] == "mp3"
    assert captured["bitrate"] == "96k"
    assert payload["audio_mime_type"] == "audio/mpeg"
    assert base64.b64decode(payload["audio_base64"]) == b"mp3 audio"
    assert payload["diagnostics"]["runpod_audio_response"]["encoded"] is True
    assert payload["diagnostics"]["runpod_audio_response"]["requested_format"] == "mp3"
    assert payload["diagnostics"]["runpod_audio_response"]["source_size_bytes"] == len(b"RIFF fake wav")
    assert payload["diagnostics"]["runpod_audio_response"]["size_bytes"] == len(b"mp3 audio")


def test_runpod_handler_falls_back_to_wav_when_vibevoice_audio_compression_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeVibeVoiceService:
        def generate(self, *, script_text, voice_paths, options):
            return type(
                "FakeVibeVoiceResult",
                (),
                {
                    "audio_bytes": b"RIFF fake wav",
                    "audio_mime_type": "audio/wav",
                    "normalized_script": script_text,
                    "timings_ms": {"vibevoice": 1.0},
                    "providers": {"vibevoice": "fake-vibevoice"},
                    "diagnostics": {},
                    "artifacts": [],
                },
            )()

    def fake_encode(*args, **kwargs):
        raise RuntimeError("ffmpeg failed")

    monkeypatch.setattr(runpod_handler, "_VIBEVOICE_SERVICE", FakeVibeVoiceService())
    monkeypatch.setattr(runpod_handler, "_encode_runpod_response_audio_with_ffmpeg", fake_encode)

    payload = runpod_handler.handler(
        {
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
            }
        }
    )

    assert payload["audio_mime_type"] == "audio/wav"
    assert base64.b64decode(payload["audio_base64"]) == b"RIFF fake wav"
    assert payload["diagnostics"]["runpod_audio_response"]["encoded"] is False
    assert payload["diagnostics"]["runpod_audio_response"]["error"] == "ffmpeg failed"
    assert any("MP3" in warning or "圧縮" in warning for warning in payload["warnings"])


def test_runpod_handler_returns_limited_vibevoice_artifacts_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeVibeVoiceService:
        def generate(self, *, script_text, voice_paths, options):
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
                    "artifacts": [
                        {
                            "kind": "speaker_vibevoice",
                            "label": "Speaker 1 VibeVoice",
                            "audio_mime_type": "audio/wav",
                            "audio_base64": base64.b64encode(b"before vc").decode("ascii"),
                            "size_bytes": 9,
                        },
                        {
                            "kind": "speaker_voice_conversion",
                            "label": "Speaker 1 Seed-VC",
                            "audio_mime_type": "audio/wav",
                            "audio_base64": base64.b64encode(b"after vc").decode("ascii"),
                            "size_bytes": 8,
                        },
                        {
                            "kind": "line_segment",
                            "label": "Line 1",
                            "audio_mime_type": "audio/wav",
                            "audio_base64": base64.b64encode(b"x" * 1024).decode("ascii"),
                            "size_bytes": 1024,
                        }
                    ],
                },
            )()

    monkeypatch.setattr(runpod_handler, "_VIBEVOICE_SERVICE", FakeVibeVoiceService())
    monkeypatch.setattr(
        runpod_handler,
        "_encode_runpod_response_audio_with_ffmpeg",
        lambda audio_bytes, **kwargs: (b"mp3:" + audio_bytes, "audio/mpeg"),
    )
    monkeypatch.delenv("MO_RUNPOD_VIBEVOICE_RETURN_ARTIFACTS", raising=False)

    payload = runpod_handler.handler(
        {
            "input": {
                "operation_mode": "vibevoice",
                "response_audio_format": "wav",
                "artifact_response_max_base64_chars": 3000,
                "script": "Speaker 1: 你好。",
                "voices": [
                    {
                        "speaker": 1,
                        "filename": "voice.wav",
                        "audio_mime_type": "audio/wav",
                        "audio_base64": base64.b64encode(b"voice").decode("ascii"),
                    }
                ],
            }
        }
    )

    assert [artifact["kind"] for artifact in payload["artifacts"]] == ["speaker_voice_conversion", "line_segment"]
    assert payload["artifacts"][0]["audio_mime_type"] == "audio/mpeg"
    assert base64.b64decode(payload["artifacts"][0]["audio_base64"]) == b"mp3:after vc"
    assert payload["diagnostics"]["runpod_artifacts"]["total_available"] == 3
    assert payload["diagnostics"]["runpod_artifacts"]["available"] == 2
    assert payload["diagnostics"]["runpod_artifacts"]["returned"] == 2
    assert payload["diagnostics"]["runpod_artifacts"]["omitted"] == 0
    assert payload["diagnostics"]["runpod_artifacts"]["excluded_kinds"] == ["speaker_vibevoice"]
    assert payload["diagnostics"]["runpod_artifacts"]["filtered_out"] == 1


def test_runpod_handler_can_disable_vibevoice_artifacts(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeVibeVoiceService:
        def generate(self, *, script_text, voice_paths, options):
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
                    "artifacts": [
                        {
                            "kind": "line_segment",
                            "label": "Line 1",
                            "audio_mime_type": "audio/wav",
                            "audio_base64": base64.b64encode(b"x" * 1024).decode("ascii"),
                            "size_bytes": 1024,
                        }
                    ],
                },
            )()

    monkeypatch.setattr(runpod_handler, "_VIBEVOICE_SERVICE", FakeVibeVoiceService())

    payload = runpod_handler.handler(
        {
            "input": {
                "operation_mode": "vibevoice",
                "response_audio_format": "wav",
                "return_artifacts": False,
                "script": "Speaker 1: 你好。",
                "voices": [
                    {
                        "speaker": 1,
                        "filename": "voice.wav",
                        "audio_mime_type": "audio/wav",
                        "audio_base64": base64.b64encode(b"voice").decode("ascii"),
                    }
                ],
            }
        }
    )

    assert payload["artifacts"] == []
    assert payload["diagnostics"]["runpod_artifacts"]["available"] == 1
    assert payload["diagnostics"]["runpod_artifacts"]["returned"] == 0
    assert payload["diagnostics"]["runpod_artifacts"]["omitted"] == 1
    assert payload["diagnostics"]["runpod_artifacts"]["omitted_reason"] == "disabled"


def test_runpod_handler_can_return_limited_vibevoice_artifacts(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeVibeVoiceService:
        def generate(self, *, script_text, voice_paths, options):
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
                    "artifacts": [
                        {
                            "kind": "speaker_vibevoice",
                            "label": "Speaker 1 VibeVoice",
                            "audio_mime_type": "audio/wav",
                            "audio_base64": base64.b64encode(b"a" * 12).decode("ascii"),
                            "size_bytes": 12,
                        },
                        {
                            "kind": "line_segment",
                            "label": "Line 1",
                            "audio_mime_type": "audio/wav",
                            "audio_base64": base64.b64encode(b"b" * 12).decode("ascii"),
                            "size_bytes": 12,
                        },
                    ],
                },
            )()

    monkeypatch.setattr(runpod_handler, "_VIBEVOICE_SERVICE", FakeVibeVoiceService())

    payload = runpod_handler.handler(
        {
            "input": {
                "operation_mode": "vibevoice",
                "response_audio_format": "wav",
                "artifact_response_audio_format": "wav",
                "script": "Speaker 1: 你好。",
                "return_artifacts": True,
                "artifact_response_max_items": 1,
                "artifact_response_max_base64_chars": 1000,
                "voices": [
                    {
                        "speaker": 1,
                        "filename": "voice.wav",
                        "audio_mime_type": "audio/wav",
                        "audio_base64": base64.b64encode(b"voice").decode("ascii"),
                    }
                ],
            }
        }
    )

    assert [artifact["kind"] for artifact in payload["artifacts"]] == ["line_segment"]
    assert payload["diagnostics"]["runpod_artifacts"]["total_available"] == 2
    assert payload["diagnostics"]["runpod_artifacts"]["available"] == 1
    assert payload["diagnostics"]["runpod_artifacts"]["returned"] == 1
    assert payload["diagnostics"]["runpod_artifacts"]["omitted"] == 0
    assert payload["diagnostics"]["runpod_artifacts"]["filtered_out"] == 1


def test_runpod_handler_releases_voice_conversion_before_vibevoice(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    class FakeVoiceConversionService:
        def release(self):
            calls.append("release-vc")

    class FakeVibeVoiceService:
        def generate(self, *, script_text, voice_paths, options):
            calls.append("generate-vibevoice")
            assert runpod_handler._VOICE_CONVERSION_SERVICE is None
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

    monkeypatch.setattr(runpod_handler, "_VOICE_CONVERSION_SERVICE", FakeVoiceConversionService())
    monkeypatch.setattr(runpod_handler, "_VOICE_CONVERSION_SERVICE_LOAD_MS", 1.0)
    monkeypatch.setattr(runpod_handler, "_VIBEVOICE_SERVICE", FakeVibeVoiceService())
    monkeypatch.setenv("MO_RUNPOD_RELEASE_VOICE_CONVERSION_BEFORE_VIBEVOICE", "1")
    event = {
        "input": {
            "operation_mode": "vibevoice",
            "response_audio_format": "wav",
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

    runpod_handler.handler(event)

    assert calls == ["release-vc", "generate-vibevoice"]
    assert runpod_handler._VOICE_CONVERSION_SERVICE is None
    assert runpod_handler._VOICE_CONVERSION_SERVICE_LOAD_MS is None


def test_runpod_handler_releases_funasr_before_vibevoice(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    class FakeFunAsrProvider:
        def release(self):
            calls.append("release-funasr")

    class FakeVibeVoiceService:
        def generate(self, *, script_text, voice_paths, options):
            calls.append("generate-vibevoice")
            assert runpod_handler._FUNASR_PRACTICE_PROVIDER is None
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

    monkeypatch.setattr(runpod_handler, "_FUNASR_PRACTICE_PROVIDER", FakeFunAsrProvider())
    monkeypatch.setattr(runpod_handler, "_FUNASR_PRACTICE_PROVIDER_LOAD_MS", 1.0)
    monkeypatch.setattr(runpod_handler, "_VIBEVOICE_SERVICE", FakeVibeVoiceService())
    event = {
        "input": {
            "operation_mode": "vibevoice",
            "response_audio_format": "wav",
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

    runpod_handler.handler(event)

    assert calls == ["release-funasr", "generate-vibevoice"]
    assert runpod_handler._FUNASR_PRACTICE_PROVIDER_LOAD_MS is None


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


def test_runpod_preload_skips_voice_conversion_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
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
    monkeypatch.delenv("MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START", raising=False)
    monkeypatch.delenv("RUNPOD_SERVERLESS_TRANSLATION_BACKEND", raising=False)

    runpod_handler._preload_for_serverless()

    assert calls == [("translation", "openai")]


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
