import base64
import json
import sys
from pathlib import Path
from threading import Event
from time import sleep
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from mo_speech.api import create_app
from mo_speech.audio_history import AudioHistoryStore
from mo_speech.media_reference import ReferenceAudioClip
from mo_speech.pipeline import PipelineProgress, PipelineResult, SpeechTranslationPipeline, TtsOutput
from mo_speech.practice_llm import PracticeLlmError, PracticeLlmEvaluation
from mo_speech.providers.fake import FakeAsrProvider, FakeTranslationProvider, FakeTtsProvider
from mo_speech.providers.openai_api import AsrTranscription
from mo_speech.providers.voice import (
    SeedVcRuntimeSettings,
    VoiceConversionBackendInfo,
    VoiceConversionService,
)


@pytest.fixture(autouse=True)
def isolate_default_audio_history(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MO_AUDIO_HISTORY_ENABLED", "1")
    monkeypatch.setenv("MO_AUDIO_HISTORY_DIR", str(tmp_path / "default-audio-history"))
    monkeypatch.setenv("MO_AUDIO_HISTORY_LIMIT", "10")
    monkeypatch.setenv("MO_VIBEVOICE_DEBUG_RESULT_DIR", str(tmp_path / "vibevoice-debug"))
    monkeypatch.setenv("MO_PUBLIC_SAMPLE_AUDIO_PATH", str(tmp_path / "public-sample-audios.json"))
    monkeypatch.setenv(
        "MO_PRACTICE_ATTEMPT_STATE_DIR",
        str(tmp_path / "practice-attempt-state"),
    )
    monkeypatch.setenv("RUNPOD_ENV_FILE", str(tmp_path / "missing.runpod.env"))
    monkeypatch.delenv("RUNPOD_ENDPOINT_ID", raising=False)
    monkeypatch.delenv("RUNPOD_API_KEY", raising=False)
    monkeypatch.delenv("MO_VIBEVOICE_URL_REFERENCE_ENABLED", raising=False)


def test_local_public_sample_audio_api_persists_and_serves_skitvoice_samples(tmp_path, monkeypatch) -> None:
    storage_path = tmp_path / "public-sample-audios.json"
    monkeypatch.setenv("MO_PUBLIC_SAMPLE_AUDIO_PATH", str(storage_path))
    sample = {
        "title": "中国語サンプル",
        "description": "短い会話",
        "filename": "zh.wav",
        "audio_mime_type": "audio/wav",
        "audio_base64": base64.b64encode(b"sample audio").decode("ascii"),
    }
    payload = {"features": {"skitvoice": {"samples": {"zh-CN": sample}}}}

    first_client = TestClient(create_app())
    saved = first_client.put("/api/public-sample-audios", json=payload)

    assert saved.status_code == 200
    assert saved.json()["features"]["skitvoice"]["samples"]["zh-CN"]["title"] == "中国語サンプル"
    assert saved.json()["features"]["skitvoice"]["samples"]["zh-CN"]["size_bytes"] == len(b"sample audio")
    assert storage_path.is_file()

    reloaded_client = TestClient(create_app())
    fetched = reloaded_client.get("/api/public-sample-audios")
    assert fetched.status_code == 200
    assert fetched.json()["features"]["skitvoice"]["samples"]["zh-CN"]["audio_base64"] == sample["audio_base64"]

    deleted = reloaded_client.delete("/api/public-sample-audios/skitvoice?language=zh-CN")
    assert deleted.status_code == 200
    assert deleted.json()["features"]["skitvoice"]["samples"]["zh-CN"] is None


def test_local_public_sample_audio_api_rejects_unsupported_language() -> None:
    client = TestClient(create_app())
    payload = {
        "features": {
            "skitvoice": {
                "samples": {
                    "fr-FR": {
                        "title": "unsupported",
                        "filename": "fr.wav",
                        "audio_mime_type": "audio/wav",
                        "audio_base64": base64.b64encode(b"sample").decode("ascii"),
                    }
                }
            }
        }
    }

    response = client.put("/api/public-sample-audios", json=payload)

    assert response.status_code == 400


def test_audio_history_is_isolated_from_repository_default(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MO_AUDIO_HISTORY_ENABLED", "1")
    monkeypatch.setenv("MO_AUDIO_HISTORY_DIR", str(tmp_path / "isolated-history"))
    monkeypatch.setattr(
        "mo_speech.api_audio_history.prepare_audio_history_wav",
        lambda audio_bytes, suffix: (b"normalized wav", ".wav", {"audio_mime_type": "audio/wav"}),
    )
    client = TestClient(create_app())

    response = client.post(
        "/api/translate-speech",
        data={"translation_backend": "qwen", "source_language": "ja-JP", "target_language": "zh-CN", "voice_mode": "default"},
        files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
    )

    assert response.status_code == 200
    assert (tmp_path / "isolated-history" / "recordings").is_dir()
    assert Path("tmp/audio-history").resolve() != (tmp_path / "isolated-history").resolve()


def test_root_serves_voice_lab_portal() -> None:
    client = TestClient(create_app())

    response = client.get("/")

    assert response.status_code == 200
    assert "Voice Lab" in response.text
    assert "/react/assets/portal.js" in response.text
    assert '<div id="root"></div>' in response.text
    assert "へんな へんかん アプリ" not in response.text


def test_privacy_policy_route_serves_public_policy() -> None:
    client = TestClient(create_app())

    for path in ("/privacy", "/privacy/"):
        response = client.get(path)
        assert response.status_code == 200
        assert "プライバシーポリシー" in response.text
        assert "/react/assets/privacy.js" in response.text


def test_fun_serves_operator_only_experimental_ui_locally() -> None:
    client = TestClient(create_app())

    response = client.get("/fun")

    assert response.status_code == 200
    assert "へんな へんかん アプリ" in response.text
    assert "display-mode-button" in response.text
    assert "user-warmup-status" in response.text
    assert "じゅんびかくにんちゅう" not in response.text
    assert "はなしてください" in response.text
    assert "5びょう いじょう はなしてください" in response.text
    assert "にてるこえ" not in response.text
    assert "similar_voice" in response.text
    assert "ジョーク" in response.text
    assert "おおさかべん" in response.text
    assert "バリエーション" in response.text
    assert "toggle-icon" in response.text
    assert "😊" in response.text
    assert "🏯" in response.text
    assert "✨" in response.text
    assert "target_language" in response.text
    assert 'value="user-auto"' in response.text
    assert "user-processing-panel" in response.text
    assert "user-processing-bar" in response.text
    assert "user-output-text" in response.text
    assert "user-replay-button" in response.text
    assert "translation_backend" not in response.text
    assert "operation_mode" not in response.text
    assert "/static/app_user.js" in response.text
    assert response.text.index("user-record-button") < response.text.index("user-status")
    assert response.text.index("user-status") < response.text.index("user-output-texts")
    assert response.text.index("user-output-texts") < response.text.index("user-processing-panel")
    assert response.text.index("user-processing-panel") < response.text.index("user-toggles")
    assert response.text.index("user-toggles") < response.text.index("user-replay-button")


def test_retired_local_ui_routes_return_not_found() -> None:
    client = TestClient(create_app())

    for path in (
        "/user",
        "/vibevoice",
        "/vibevoice/simple",
        "/vibevoice/admin",
        "/seed-vc",
        "/static/vibevoice_simple.html",
        "/static/seed_vc.html",
    ):
        assert client.get(path).status_code == 404, path


def test_speakloop_is_the_only_pronunciation_practice_ui_route() -> None:
    client = TestClient(create_app())

    response = client.get("/speakloop")

    assert response.status_code == 200
    assert "SpeakLoop" in response.text
    assert "言いたいことで発音練習" in response.text
    assert "Pronunciation Practice" not in response.text
    assert "发音练习" not in response.text
    assert "/react/assets/speakloop.js" in response.text
    assert "practice-settings-button" not in response.text
    assert "practice-settings-overlay" not in response.text
    assert "practice-asr-model" not in response.text
    assert 'value="gpt-4o-transcribe"' not in response.text
    assert 'value="gpt-4o-mini-transcribe"' not in response.text
    assert "whisper-1（フレーズ比較）" not in response.text
    assert "通常は whisper-1" not in response.text
    assert "gpt-4o/mini は全体比較再生" not in response.text

    for legacy_path in ("/practice", "/practice/", "/practice/admin", "/practice/admin/", "/static/practice.html"):
        assert client.get(legacy_path).status_code == 404
    assert "practice-segment-mode" not in response.text
    assert "practice-next-prompt-button" not in response.text
    assert "practice-repeat-audio-button" not in response.text
    assert "practice-compare-button" not in response.text
    assert "practice-retry-button" not in response.text
    assert "practice-next-button" not in response.text


def test_speakloop_alias_serves_practice_ui() -> None:
    client = TestClient(create_app())

    response = client.get("/speakloop")

    assert response.status_code == 200
    assert "SpeakLoop" in response.text
    assert "/react/assets/speakloop.js" in response.text


def test_practice_attempt_job_rejects_unsupported_asr_model() -> None:
    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"en-US": "I want coffee"}),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(create_app(openai_pipeline=pipeline))

    response = client.post(
        "/api/practice/attempt-jobs",
        data={"target_language": "en-US", "target_text": "I want a coffee.", "asr_model": "unknown-asr"},
        files={
            "audio": ("repeat.webm", b"repeat audio", "audio/webm"),
            "model_audio": ("model.wav", b"model audio", "audio/wav"),
        },
    )

    assert response.status_code == 400
    assert "unsupported practice ASR model" in response.json()["detail"]


def test_practice_prompt_job_reports_asr_translation_and_tts_models() -> None:
    asr_entered = Event()
    release_asr = Event()
    translation_entered = Event()
    release_translation = Event()
    tts_entered = Event()
    release_tts = Event()

    class BlockingAsr:
        name = "test-asr"
        model = "asr-model"

        def transcribe_detail(self, *_args, **_kwargs):
            asr_entered.set()
            assert release_asr.wait(timeout=2)
            return AsrTranscription(text="こんにちは", model=self.model)

    class BlockingTranslator:
        name = "test-translation"
        model = "translation-model"

        def translate(self, *_args, **_kwargs):
            translation_entered.set()
            assert release_translation.wait(timeout=2)
            return "Hello."

    class BlockingTts:
        name = "test-tts"
        model = "tts-model"
        audio_mime_type = "audio/wav"

        def synthesize(self, *_args, **_kwargs):
            tts_entered.set()
            assert release_tts.wait(timeout=2)
            return b"test wav"

    pipeline = SpeechTranslationPipeline(
        asr=BlockingAsr(),
        translator=BlockingTranslator(),
        tts=BlockingTts(),
    )
    client = TestClient(create_app(openai_pipeline=pipeline))

    submitted = client.post(
        "/api/practice/recordings",
        data={
            "recording_intent": "prompt",
            "target_language": "en-US",
            "asr_model": "whisper-1",
            "progress_mode": "job",
        },
        files={"audio": ("prompt.webm", b"prompt audio", "audio/webm")},
    )

    assert submitted.status_code == 202
    job_id = submitted.json()["job_id"]
    assert asr_entered.wait(timeout=2)
    asr_snapshot = client.get(f"/api/practice/prompt-jobs/{job_id}").json()
    assert asr_snapshot["current_stage"] == {
        "stage": "transcribing_prompt",
        "label": "録音を文字にしています",
        "provider": "test-asr",
        "model": "asr-model",
    }

    release_asr.set()
    assert translation_entered.wait(timeout=2)
    translation_snapshot = client.get(f"/api/practice/prompt-jobs/{job_id}").json()
    assert translation_snapshot["current_stage"] == {
        "stage": "translating_prompt",
        "label": "学習言語へ翻訳しています",
        "provider": "test-translation",
        "model": "translation-model",
    }

    release_translation.set()
    assert tts_entered.wait(timeout=2)
    tts_snapshot = client.get(f"/api/practice/prompt-jobs/{job_id}").json()
    assert tts_snapshot["current_stage"] == {
        "stage": "synthesizing_prompt",
        "label": "お手本音声を作っています",
        "provider": "test-tts",
        "model": "tts-model",
    }

    release_tts.set()
    for _ in range(100):
        completed = client.get(f"/api/practice/prompt-jobs/{job_id}")
        if completed.json()["status"] == "succeeded":
            break
        sleep(0.01)
    assert completed.status_code == 200
    assert completed.json()["result"]["target_text"] == "Hello."


def test_practice_attempt_job_reuses_cached_model_asr_across_retries(tmp_path) -> None:
    class CountingAsr:
        name = "counting-asr"

        def __init__(self) -> None:
            self.calls_by_content: dict[bytes, int] = {}

        def transcribe_detail(self, audio_path, source_language, *, include_timestamps):
            content = audio_path.read_bytes()
            self.calls_by_content[content] = self.calls_by_content.get(content, 0) + 1
            if content == b"model audio":
                return AsrTranscription(
                    text="Please close the window.",
                    model="whisper-1",
                    words=[{"text": "Please close the window", "start": 0.1, "end": 1.2}],
                    timestamp_granularities=["word"],
                )
            return AsrTranscription(
                text="Please close the door.",
                model="whisper-1",
                words=[{"text": "Please close the door", "start": 0.1, "end": 1.2}],
                timestamp_granularities=["word"],
            )

    class FakePracticeLlm:
        def evaluate(self, *, model, input_payload):
            return PracticeLlmEvaluation(
                result={
                    "schema_version": 1,
                    "overall_score": 50,
                    "overall_comment": "windowがdoorになっています。",
                    "phrases": [
                        {
                            "phrase_index": 0,
                            "target_text": "Please close the window.",
                            "score": 50,
                            "comment": "windowがdoorになっています。",
                            "reference": {
                                "status": "assigned",
                                "word_start_index": 0,
                                "word_end_index": 1,
                                "matched_text": "Please close the window",
                                "start": 0.1,
                                "end": 1.2,
                                "playback_start": 0.0,
                                "playback_end": 1.2,
                            },
                            "attempt": {
                                "status": "partial",
                                "word_start_index": 0,
                                "word_end_index": 1,
                                "matched_text": "Please close the door",
                                "start": 0.1,
                                "end": 1.2,
                                "playback_start": 0.0,
                                "playback_end": 1.2,
                            },
                        }
                    ],
                },
                usage={"total_tokens": 90},
                estimated_cost_usd=None,
                elapsed_ms=8.0,
                log_path=tmp_path / "practice-llm.json",
            )

    asr = CountingAsr()
    pipeline = SpeechTranslationPipeline(
        asr=asr,
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(create_app(openai_pipeline=pipeline, practice_llm_service=FakePracticeLlm()))

    for attempt_audio in (b"attempt take one", b"attempt take two"):
        response = client.post(
            "/api/practice/attempt-jobs",
            data={"target_language": "en-US", "target_text": "Please close the window."},
            files={
                "audio": ("attempt.wav", attempt_audio, "audio/wav"),
                "model_audio": ("model.wav", b"model audio", "audio/wav"),
            },
        )
        assert response.status_code == 200

    # The reference/model audio is byte-identical across both attempts (the
    # client resends the same TTS'd prompt audio every time), so it must be
    # transcribed only once. Each attempt recording is genuinely new audio and
    # must always be transcribed.
    assert asr.calls_by_content[b"model audio"] == 1
    assert asr.calls_by_content[b"attempt take one"] == 1
    assert asr.calls_by_content[b"attempt take two"] == 1


def test_practice_attempt_job_uses_selected_llm_and_common_padding(tmp_path) -> None:
    class TimestampAsr:
        name = "timestamp-asr"

        def __init__(self) -> None:
            self.call_count = 0

        def transcribe_detail(self, *_args, **_kwargs):
            self.call_count += 1
            if self.call_count == 1:
                return AsrTranscription(
                    text="Hello world",
                    model=self.name,
                    words=[
                        {"text": "Hello", "start": 0.0, "end": 0.4},
                        {"text": " world", "start": 0.4, "end": 0.8},
                    ],
                    timestamp_granularities=["word"],
                )
            return AsrTranscription(
                text="Hello word",
                model=self.name,
                words=[
                    {"text": "Hello", "start": 0.1, "end": 0.5},
                    {"text": " word", "start": 0.5, "end": 0.9},
                ],
                timestamp_granularities=["word"],
            )

    class FakePracticeLlm:
        def __init__(self) -> None:
            self.calls = []

        def evaluate(self, *, model, input_payload):
            self.calls.append({"model": model, "input": input_payload})
            result = {
                "schema_version": 1,
                "overall_score": 72,
                "overall_comment": "最後の単語を確認しましょう。",
                "phrases": [
                    {
                        "phrase_index": 0,
                        "target_text": "Hello world.",
                        "score": 72,
                        "comment": "worldがwordとして認識されています。",
                        "reference": {
                            "status": "assigned",
                            "word_start_index": 0,
                            "word_end_index": 2,
                            "matched_text": "Hello world",
                            "start": 0.0,
                            "end": 0.8,
                            "playback_start": 0.0,
                            "playback_end": 0.8,
                        },
                        "attempt": {
                            "status": "partial",
                            "word_start_index": 0,
                            "word_end_index": 2,
                            "matched_text": "Hello word",
                            "start": 0.1,
                            "end": 0.9,
                            "playback_start": 0.0,
                            "playback_end": 0.9,
                        },
                    }
                ],
            }
            return PracticeLlmEvaluation(
                result=result,
                usage={"total_tokens": 321},
                estimated_cost_usd=None,
                elapsed_ms=12.5,
                log_path=tmp_path / "practice-llm.json",
            )

    asr = TimestampAsr()
    llm = FakePracticeLlm()
    pipeline = SpeechTranslationPipeline(
        asr=asr,
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(create_app(openai_pipeline=pipeline, practice_llm_service=llm))

    response = client.post(
        "/api/practice/attempt-jobs",
        data={
            "target_language": "en-US",
            "target_text": "Hello world.",
            "comparison_model": "gpt-5.4-nano",
            "playback_padding_seconds": "0.15",
        },
        files={
            "audio": ("attempt.webm", b"attempt audio", "audio/webm"),
            "model_audio": ("model.wav", b"model audio", "audio/wav"),
        },
    )

    assert response.status_code == 200
    result = response.json()["result"]
    assert result["overall_score"] == 72
    assert result["overall_comment"] == "最後の単語を確認しましょう。"
    assert result["llm_comparison"]["phrases"][0]["score"] == 72
    assert result["comparison_alignment"]["phrases"][0]["audio_start"] == pytest.approx(0.0)
    assert result["comparison_alignment"]["phrases"][0]["audio_end"] == pytest.approx(0.9)
    assert result["model_comparison_alignment"]["phrases"][0]["audio_start"] == pytest.approx(0.0)
    assert result["model_comparison_alignment"]["phrases"][0]["audio_end"] == pytest.approx(0.8)
    assert "similarity" not in result
    assert llm.calls[0]["model"] == "gpt-5.4-nano"
    assert llm.calls[0]["input"]["padding_seconds"] == pytest.approx(0.15)
    assert llm.calls[0]["input"]["reference_asr"]["recognized_text"] == "Hello world"
    assert llm.calls[0]["input"]["attempt_asr"]["recognized_text"] == "Hello word"


def test_practice_attempt_job_rejects_non_timestamp_asr_model_for_llm_comparison() -> None:
    class FakePracticeLlm:
        def evaluate(self, *, model, input_payload):
            raise AssertionError("LLM must not be called when asr_model can't provide timestamps")

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"auto": "unused"}),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(create_app(openai_pipeline=pipeline, practice_llm_service=FakePracticeLlm()))

    response = client.post(
        "/api/practice/attempt-jobs",
        data={
            "target_language": "en-US",
            "target_text": "Hello world.",
            "asr_model": "gpt-4o-transcribe",
            "comparison_model": "gpt-5.4-nano",
        },
        files={
            "audio": ("attempt.webm", b"attempt audio", "audio/webm"),
            "model_audio": ("model.wav", b"model audio", "audio/wav"),
        },
    )

    assert response.status_code == 400
    assert "does not return word timestamps" in response.json()["detail"]


def test_local_practice_attempt_job_reports_both_asr_and_llm_stages(tmp_path) -> None:
    reference_entered = Event()
    release_reference = Event()
    attempt_entered = Event()
    release_attempt = Event()
    llm_entered = Event()
    release_llm = Event()

    class BlockingTimestampAsr:
        name = "test-asr"
        model = "asr-model"

        def __init__(self) -> None:
            self.call_count = 0

        def transcribe_detail(self, *_args, **_kwargs):
            self.call_count += 1
            if self.call_count == 1:
                reference_entered.set()
                assert release_reference.wait(timeout=2)
                return AsrTranscription(
                    text="Hello world",
                    model=self.model,
                    words=[{"text": "Hello world", "start": 0.0, "end": 0.8}],
                    timestamp_granularities=["word"],
                )
            attempt_entered.set()
            assert release_attempt.wait(timeout=2)
            return AsrTranscription(
                text="Hello word",
                model=self.model,
                words=[{"text": "Hello word", "start": 0.1, "end": 0.9}],
                timestamp_granularities=["word"],
            )

    class BlockingPracticeLlm:
        def evaluate(self, *, model, input_payload):
            assert model == "gpt-5.6-terra"
            llm_entered.set()
            assert release_llm.wait(timeout=2)
            result = {
                "schema_version": 1,
                "overall_score": 80,
                "overall_comment": "最後の単語を確認しましょう。",
                "phrases": [
                    {
                        "phrase_index": 0,
                        "target_text": "Hello world.",
                        "score": 80,
                        "comment": "worldを確認しましょう。",
                        "reference": {
                            "status": "assigned",
                            "word_start_index": 0,
                            "word_end_index": 1,
                            "matched_text": "Hello world",
                            "start": 0.0,
                            "end": 0.8,
                            "playback_start": 0.0,
                            "playback_end": 0.8,
                        },
                        "attempt": {
                            "status": "partial",
                            "word_start_index": 0,
                            "word_end_index": 1,
                            "matched_text": "Hello word",
                            "start": 0.1,
                            "end": 0.9,
                            "playback_start": 0.0,
                            "playback_end": 0.9,
                        },
                    }
                ],
            }
            return PracticeLlmEvaluation(
                result=result,
                usage={"total_tokens": 123},
                estimated_cost_usd=None,
                elapsed_ms=10.0,
                log_path=tmp_path / "practice-llm.json",
            )

    pipeline = SpeechTranslationPipeline(
        asr=BlockingTimestampAsr(),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(
        create_app(openai_pipeline=pipeline, practice_llm_service=BlockingPracticeLlm())
    )

    submitted = client.post(
        "/api/practice/attempt-jobs",
        data={
            "target_language": "en-US",
            "target_text": "Hello world.",
            "comparison_model": "gpt-5.6-terra",
            "playback_padding_seconds": "0.10",
            "progress_mode": "job",
        },
        files={
            "audio": ("attempt.webm", b"attempt audio", "audio/webm"),
            "model_audio": ("model.wav", b"model audio", "audio/wav"),
        },
    )

    assert submitted.status_code == 202
    job_id = submitted.json()["job_id"]
    assert reference_entered.wait(timeout=2)
    reference_snapshot = client.get(f"/api/practice/attempt-jobs/{job_id}").json()
    assert reference_snapshot["current_stage"] == {
        "stage": "transcribing_model",
        "label": "お手本音声を確認しています",
        "provider": "test-asr",
        "model": "asr-model",
    }

    release_reference.set()
    assert attempt_entered.wait(timeout=2)
    attempt_snapshot = client.get(f"/api/practice/attempt-jobs/{job_id}").json()
    assert attempt_snapshot["current_stage"] == {
        "stage": "transcribing_attempt",
        "label": "録音を確認しています",
        "provider": "test-asr",
        "model": "asr-model",
    }

    release_attempt.set()
    assert llm_entered.wait(timeout=2)
    llm_snapshot = client.get(f"/api/practice/attempt-jobs/{job_id}").json()
    assert llm_snapshot["current_stage"] == {
        "stage": "evaluating_comparison",
        "label": "比較結果を作っています",
        "provider": "OpenAI",
        "model": "gpt-5.6-terra",
    }

    release_llm.set()
    for _ in range(100):
        completed = client.get(f"/api/practice/attempt-jobs/{job_id}")
        if completed.json()["status"] == "succeeded":
            break
        sleep(0.01)
    assert completed.json()["result"]["overall_score"] == 80


def test_chinese_practice_attempt_job_reports_llm_stage_after_runpod_asr(tmp_path) -> None:
    llm_entered = Event()
    release_llm = Event()

    class CompletedRunpodAsr:
        name = "runpod-funasr-paraformer-zh"

        def submit_comparison_job(self, **_kwargs):
            return {"id": "practice-job-with-llm", "status": "IN_QUEUE"}

        def health(self):
            return {"workers": {"idle": 0, "running": 1, "initializing": 0}}

        def job_status(self, job_id):
            assert job_id == "practice-job-with-llm"
            return {
                "id": job_id,
                "status": "COMPLETED",
                "output": {
                    "practice_asr_contract_version": 2,
                    "target_text": "你好。",
                    "text": "你好",
                    "model": "funasr/paraformer-zh",
                    "timestamp_granularities": ["word"],
                    "words": [{"text": "你好", "start": 0.1, "end": 0.8}],
                    "segments": [],
                    "model_transcription": {
                        "text": "你好",
                        "model": "funasr/paraformer-zh",
                        "timestamp_granularities": ["word"],
                        "words": [{"text": "你好", "start": 0.0, "end": 0.7}],
                        "segments": [],
                    },
                    "providers": {"asr": "funasr-paraformer-zh"},
                },
            }

    class BlockingPracticeLlm:
        def evaluate(self, *, model, input_payload):
            assert model == "gpt-5.6-terra"
            llm_entered.set()
            release_llm.wait(timeout=0.5)
            return PracticeLlmEvaluation(
                result={
                    "schema_version": 1,
                    "overall_score": 100,
                    "overall_comment": "正確です。",
                    "phrases": [
                        {
                            "phrase_index": 0,
                            "target_text": "你好。",
                            "score": 100,
                            "comment": "正確です。",
                            "reference": {
                                "status": "assigned",
                                "word_start_index": 0,
                                "word_end_index": 1,
                                "matched_text": "你好",
                                "start": 0.0,
                                "end": 0.7,
                                "playback_start": 0.0,
                                "playback_end": 0.7,
                            },
                            "attempt": {
                                "status": "assigned",
                                "word_start_index": 0,
                                "word_end_index": 1,
                                "matched_text": "你好",
                                "start": 0.1,
                                "end": 0.8,
                                "playback_start": 0.0,
                                "playback_end": 0.8,
                            },
                        }
                    ],
                },
                usage={"total_tokens": 80},
                estimated_cost_usd=None,
                elapsed_ms=10.0,
                log_path=tmp_path / "practice-llm.json",
            )

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"zh-CN": "OpenAI should not be used"}),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(
        create_app(
            openai_pipeline=pipeline,
            runpod_practice_asr_provider=CompletedRunpodAsr(),
            practice_llm_service=BlockingPracticeLlm(),
        )
    )

    submitted = client.post(
        "/api/practice/attempt-jobs",
        data={
            "target_language": "zh-CN",
            "target_text": "你好。",
            "comparison_model": "gpt-5.6-terra",
            "playback_padding_seconds": "0.10",
            "progress_mode": "job",
        },
        files={
            "audio": ("attempt.webm", b"attempt audio", "audio/webm"),
            "model_audio": ("model.wav", b"model audio", "audio/wav"),
        },
    )

    assert submitted.status_code == 202
    job_id = submitted.json()["job_id"]
    llm_snapshot = client.get(f"/api/practice/attempt-jobs/{job_id}").json()
    assert llm_entered.wait(timeout=2)
    assert llm_snapshot["status"] == "running"
    assert llm_snapshot["current_stage"] == {
        "stage": "evaluating_comparison",
        "label": "比較結果を作っています",
        "provider": "OpenAI",
        "model": "gpt-5.6-terra",
    }

    release_llm.set()
    for _ in range(100):
        completed = client.get(f"/api/practice/attempt-jobs/{job_id}")
        if completed.json()["status"] == "succeeded":
            break
        sleep(0.01)
    assert completed.json()["job_id"] == job_id
    assert completed.json()["result"]["overall_score"] == 100


def test_chinese_practice_attempt_job_preserves_context_for_polyphonic_diff_pinyin(
    tmp_path,
) -> None:
    class CompletedRunpodAsr:
        name = "runpod-funasr-paraformer-zh"

        def submit_comparison_job(self, **_kwargs):
            return {"id": "practice-job-pinyin", "status": "IN_QUEUE"}

        def health(self):
            return {"workers": {"idle": 0, "running": 1, "initializing": 0}}

        def job_status(self, job_id):
            return {
                "id": job_id,
                "status": "COMPLETED",
                "output": {
                    "practice_asr_contract_version": 2,
                    "target_text": "银行。",
                    "text": "银形",
                    "model": "funasr/paraformer-zh",
                    "timestamp_granularities": ["word"],
                    "words": [
                        {"text": "银", "start": 0.0, "end": 0.3},
                        {"text": "形", "start": 0.3, "end": 0.6},
                    ],
                    "segments": [],
                    "model_transcription": {
                        "text": "银行",
                        "model": "funasr/paraformer-zh",
                        "timestamp_granularities": ["word"],
                        "words": [
                            {"text": "银", "start": 0.0, "end": 0.3},
                            {"text": "行", "start": 0.3, "end": 0.6},
                        ],
                        "segments": [],
                    },
                    "providers": {"asr": "funasr-paraformer-zh"},
                },
            }

    class BlockingPracticeLlm:
        def evaluate(self, *, model, input_payload):
            return PracticeLlmEvaluation(
                result={
                    "schema_version": 1,
                    "overall_score": 90,
                    "overall_comment": "二文字目の発音を確認しましょう。",
                    "phrases": [
                        {
                            "phrase_index": 0,
                            "target_text": "银行。",
                            "score": 90,
                            "comment": "「行」が「形」と認識されています。",
                            "reference": {
                                "status": "assigned",
                                "word_start_index": 0,
                                "word_end_index": 2,
                                "matched_text": "银行",
                                "start": 0.0,
                                "end": 0.6,
                                "playback_start": 0.0,
                                "playback_end": 0.6,
                            },
                            "attempt": {
                                "status": "assigned",
                                "word_start_index": 0,
                                "word_end_index": 2,
                                "matched_text": "银形",
                                "start": 0.0,
                                "end": 0.6,
                                "playback_start": 0.0,
                                "playback_end": 0.6,
                            },
                        }
                    ],
                },
                usage={"total_tokens": 90},
                estimated_cost_usd=None,
                elapsed_ms=10.0,
                log_path=tmp_path / "practice-llm.json",
            )

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"zh-CN": "OpenAI should not be used"}),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(
        create_app(
            openai_pipeline=pipeline,
            runpod_practice_asr_provider=CompletedRunpodAsr(),
            practice_llm_service=BlockingPracticeLlm(),
        )
    )

    submitted = client.post(
        "/api/practice/attempt-jobs",
        data={
            "target_language": "zh-CN",
            "target_text": "银行。",
            "comparison_model": "gpt-5.6-terra",
            "playback_padding_seconds": "0.10",
        },
        files={
            "audio": ("attempt.webm", b"attempt audio", "audio/webm"),
            "model_audio": ("model.wav", b"model audio", "audio/wav"),
        },
    )

    assert submitted.status_code == 202
    job_id = submitted.json()["job_id"]
    completed = client.get(f"/api/practice/attempt-jobs/{job_id}")
    assert completed.json()["status"] == "succeeded"
    result = completed.json()["result"]
    # 「银行」の「行」は周囲の語によってhang2になる。「银形」の「形」はxing2のため、
    # 1文字ずつ変換して両方をxing2にすると実際の違いを隠してしまう。
    assert result["comparison_target_pinyin"] == ["yin2", "hang2"]
    assert result["comparison_recognized_pinyin"] == ["yin2", "xing2"]


def test_chinese_practice_attempt_job_reuses_cached_model_asr_across_retries(
    tmp_path,
    monkeypatch,
) -> None:
    class RetryTrackingRunpodAsr:
        name = "runpod-funasr-paraformer-zh"

        def __init__(self) -> None:
            self.submissions: list[dict[str, object]] = []
            self.status_calls = 0

        def submit_comparison_job(self, **kwargs):
            job_id = f"practice-job-{len(self.submissions) + 1}"
            self.submissions.append({"model_audio_included": kwargs["model_audio_path"] is not None})
            return {"id": job_id, "status": "IN_QUEUE"}

        def health(self):
            return {"workers": {"idle": 0, "running": 1, "initializing": 0}}

        def job_status(self, job_id):
            self.status_calls += 1
            output = {
                "practice_asr_contract_version": 2,
                "target_text": "你好。",
                "text": "你好",
                "model": "funasr/paraformer-zh",
                "timestamp_granularities": ["word"],
                "words": [{"text": "你好", "start": 0.1, "end": 0.8}],
                "segments": [],
                "providers": {"asr": "funasr-paraformer-zh"},
            }
            job_index = int(job_id.rsplit("-", 1)[-1]) - 1
            # model_audioを含むjobだけがRunPod側でお手本音声をASRし、
            # model_transcriptionを返す。
            if self.submissions[job_index]["model_audio_included"]:
                output["model_transcription"] = {
                    "text": "你好",
                    "model": "funasr/paraformer-zh",
                    "timestamp_granularities": ["word"],
                    "words": [{"text": "你好", "start": 0.0, "end": 0.7}],
                    "segments": [],
                }
            return {"id": job_id, "status": "COMPLETED", "output": output}

    class FixedPracticeLlm:
        def __init__(self) -> None:
            self.calls = 0
            self.models: list[str] = []
            self.paddings: list[float] = []

        def evaluate(self, *, model, input_payload):
            self.calls += 1
            self.models.append(model)
            self.paddings.append(float(input_payload["padding_seconds"]))
            return PracticeLlmEvaluation(
                result={
                    "schema_version": 1,
                    "overall_score": 100,
                    "overall_comment": "正確です。",
                    "phrases": [
                        {
                            "phrase_index": 0,
                            "target_text": "你好。",
                            "score": 100,
                            "comment": "正確です。",
                            "reference": {
                                "status": "assigned",
                                "word_start_index": 0,
                                "word_end_index": 1,
                                "matched_text": "你好",
                                "start": 0.0,
                                "end": 0.7,
                                "playback_start": 0.0,
                                "playback_end": 0.7,
                            },
                            "attempt": {
                                "status": "assigned",
                                "word_start_index": 0,
                                "word_end_index": 1,
                                "matched_text": "你好",
                                "start": 0.1,
                                "end": 0.8,
                                "playback_start": 0.0,
                                "playback_end": 0.8,
                            },
                        }
                    ],
                },
                usage={"total_tokens": 80},
                estimated_cost_usd=None,
                elapsed_ms=10.0,
                log_path=tmp_path / "practice-llm.json",
            )

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"zh-CN": "OpenAI should not be used"}),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    runpod = RetryTrackingRunpodAsr()
    practice_llm = FixedPracticeLlm()
    history_store = AudioHistoryStore(root=tmp_path / "practice-history", limit=10, enabled=True)
    monkeypatch.setattr(
        "mo_speech.api_audio_history.prepare_audio_history_wav",
        lambda audio_bytes, suffix: (audio_bytes, ".wav", {"audio_mime_type": "audio/wav"}),
    )
    client = TestClient(
        create_app(
            openai_pipeline=pipeline,
            runpod_practice_asr_provider=runpod,
            audio_history_store=history_store,
            practice_llm_service=practice_llm,
        )
    )

    for attempt_index in range(2):
        submitted = client.post(
            "/api/practice/attempt-jobs",
            data={
                "target_language": "zh-CN",
                "target_text": "你好。",
                "comparison_model": "gpt-5.6-terra",
                "playback_padding_seconds": "0.10",
            },
            files={
                "audio": ("attempt.webm", b"attempt audio", "audio/webm"),
                "model_audio": ("model.wav", b"model audio cache restart", "audio/wav"),
            },
        )
        assert submitted.status_code == 202
        job_id = submitted.json()["job_id"]
        if attempt_index == 1:
            # RunPod jobの提出後にFastAPIが再起動しても、jobと一緒に永続化した
            # お手本ASRを復元し、model_audioを省略したjobを完了できること。
            client = TestClient(
                create_app(
                    openai_pipeline=pipeline,
                    runpod_practice_asr_provider=runpod,
                    audio_history_store=history_store,
                    practice_llm_service=practice_llm,
                )
            )
        completed = client.get(f"/api/practice/attempt-jobs/{job_id}")
        assert completed.json()["status"] == "succeeded", completed.json()
        assert completed.json()["result"]["overall_score"] == 100
        calls_after_completion = practice_llm.calls
        status_calls_after_completion = runpod.status_calls
        client = TestClient(
            create_app(
                openai_pipeline=pipeline,
                runpod_practice_asr_provider=runpod,
                audio_history_store=history_store,
                practice_llm_service=practice_llm,
            )
        )
        repeated = client.get(f"/api/practice/attempt-jobs/{job_id}")
        assert repeated.json() == completed.json()
        assert practice_llm.calls == calls_after_completion
        assert runpod.status_calls == status_calls_after_completion

    # 1回目はお手本音声を含めてjobを送るが、2回目は同じお手本音声(同一バイト列)なので
    # キャッシュを再利用し、model_audio_pathを送らずRunPod側のFunASR推論を省略する。
    assert runpod.submissions == [
        {"model_audio_included": True},
        {"model_audio_included": False},
    ]

    disabled_history_root = tmp_path / "disabled-history"
    disabled_history_client = TestClient(
        create_app(
            openai_pipeline=pipeline,
            runpod_practice_asr_provider=runpod,
            audio_history_store=AudioHistoryStore(
                root=disabled_history_root,
                limit=10,
                enabled=False,
            ),
            practice_llm_service=practice_llm,
        )
    )
    submitted = disabled_history_client.post(
        "/api/practice/attempt-jobs",
        data={
            "target_language": "zh-CN",
            "target_text": "你好。",
            "comparison_model": "gpt-5.4-nano",
            "playback_padding_seconds": "0.25",
        },
        files={
            "audio": ("attempt.webm", b"attempt audio", "audio/webm"),
            "model_audio": ("model.wav", b"model audio cache restart", "audio/wav"),
        },
    )
    assert submitted.status_code == 202
    disabled_history_client = TestClient(
        create_app(
            openai_pipeline=pipeline,
            runpod_practice_asr_provider=runpod,
            audio_history_store=AudioHistoryStore(
                root=disabled_history_root,
                limit=10,
                enabled=False,
            ),
            practice_llm_service=practice_llm,
        )
    )
    completed = disabled_history_client.get(
        f"/api/practice/attempt-jobs/{submitted.json()['job_id']}"
    )
    assert completed.json()["status"] == "succeeded", completed.json()
    assert completed.json()["result"]["comparison_model"] == "gpt-5.4-nano"
    assert completed.json()["result"]["playback_padding_seconds"] == 0.25
    assert practice_llm.models[-1] == "gpt-5.4-nano"
    assert practice_llm.paddings[-1] == 0.25
    # 永続化先が無効なら、再起動後にお手本ASRを失うjobを作らないよう音声を含める。
    assert runpod.submissions[-1] == {"model_audio_included": True}


def test_practice_attempt_job_returns_comparison_error_without_legacy_fallback() -> None:
    class TimestampAsr:
        name = "timestamp-asr"

        def transcribe_detail(self, *_args, **_kwargs):
            return AsrTranscription(
                text="Hello",
                model=self.name,
                words=[{"text": "Hello", "start": 0.0, "end": 0.5}],
                timestamp_granularities=["word"],
            )

    class FailingPracticeLlm:
        def evaluate(self, **_kwargs):
            raise PracticeLlmError("invalid response", stage="validate_response")

    pipeline = SpeechTranslationPipeline(
        asr=TimestampAsr(),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(
        create_app(openai_pipeline=pipeline, practice_llm_service=FailingPracticeLlm())
    )

    response = client.post(
        "/api/practice/attempt-jobs",
        data={
            "target_language": "en-US",
            "target_text": "Hello.",
            "comparison_model": "gpt-5.6-terra",
            "playback_padding_seconds": "0.10",
        },
        files={
            "audio": ("attempt.webm", b"attempt audio", "audio/webm"),
            "model_audio": ("model.wav", b"model audio", "audio/wav"),
        },
    )

    assert response.status_code == 502
    assert response.json() == {
        "error": {
            "code": "practice_llm_failed",
            "stage": "validate_response",
            "message": "比較結果を作成できませんでした。もう一度お試しください。",
            "retryable": True,
            "fallback_to_legacy": False,
        }
    }


def test_practice_admin_serves_practice_history_ui() -> None:
    client = TestClient(create_app())

    response = client.get("/speakloop/admin")

    assert response.status_code == 200
    assert "SpeakLoop 管理" in response.text
    assert "Voice Lab" in response.text
    assert "/api/practice-history" not in response.text
    assert "/static/app_practice_history.js" in response.text


def test_skitvoice_serves_simple_user_ui_without_admin_controls() -> None:
    client = TestClient(create_app())

    response = client.get("/skitvoice")

    assert response.status_code == 200
    assert "SkitVoice" in response.text
    assert "SkitVoice 管理" not in response.text
    assert 'data-vibevoice-mode="simple"' in response.text
    assert "/react/assets/skitvoice.js" in response.text
    assert '<div id="root"></div>' in response.text


def test_vibevoice_serves_admin_skit_ui() -> None:
    client = TestClient(create_app())

    response = client.get("/skitvoice/admin")

    assert response.status_code == 200
    assert "SkitVoice 管理" in response.text
    assert "vibevoice-script" in response.text
    assert 'data-vibevoice-mode="simple"' not in response.text
    assert 'data-reference-url-open-slot="1"' in response.text
    assert 'id="vibevoice-reference-url-dialog"' in response.text
    assert 'name="directed_retry_max_multiplier"' in response.text
    assert "/static/app_vibevoice.js" in response.text


def test_vibevoice_status_api_uses_service() -> None:
    class FakeVibeVoiceService:
        def status(self):
            return {"available": True, "provider": "fake-vibevoice"}

    client = TestClient(create_app(vibevoice_service=FakeVibeVoiceService()))

    response = client.get("/api/vibevoice/status")

    assert response.status_code == 200
    assert response.json()["available"] is True
    assert response.json()["provider"] == "fake-vibevoice"
    assert response.json()["url_reference_audio"]["enabled"] is False
    assert "yt_dlp" in response.json()["url_reference_audio"]["tools"]
    assert response.json()["url_reference_audio"]["tools"]["javascript_runtime"]["command"] == "node"


def test_vibevoice_status_api_reports_loopback_url_reference_availability(monkeypatch: pytest.MonkeyPatch) -> None:
    client = TestClient(create_app(), base_url="http://127.0.0.1")

    enabled_response = client.get("/api/vibevoice/status")
    monkeypatch.setenv("MO_VIBEVOICE_URL_REFERENCE_ENABLED", "0")
    disabled_response = client.get("/api/vibevoice/status")

    assert enabled_response.json()["url_reference_audio"]["enabled"] is True
    assert disabled_response.json()["url_reference_audio"]["enabled"] is False


def test_vibevoice_generate_api_returns_audio() -> None:
    class FakeVibeVoiceResult:
        audio_bytes = b"RIFFfakewav"
        audio_mime_type = "audio/wav"
        normalized_script = "Speaker 1: 你好。"
        timings_ms = {"vibevoice": 12.0, "total": 12.0}
        diagnostics = {"stdout_tail": "ok", "stderr_tail": ""}
        providers = {"vibevoice": "fake-vibevoice"}
        artifacts = [
            {
                "kind": "speaker_vibevoice",
                "label": "Speaker 1 VibeVoice",
                "audio_mime_type": "audio/wav",
                "audio_base64": base64.b64encode(b"speaker wav").decode("ascii"),
            }
        ]

    class FakeVibeVoiceService:
        def __init__(self):
            self.calls = []
            self.voice_bytes = b""

        def generate(self, *, script_text, voice_paths, options):
            self.calls.append((script_text, voice_paths, options))
            self.voice_bytes = voice_paths[0].path.read_bytes()
            return FakeVibeVoiceResult()

    service = FakeVibeVoiceService()
    client = TestClient(create_app(vibevoice_service=service))

    response = client.post(
        "/api/vibevoice/generate",
        data={
            "script": "你好。",
            "inference_steps": "3",
            "line_by_line": "true",
            "directed_line_mode": "true",
            "directed_retry_low_score": "true",
            "directed_retry_score_threshold": "0.7",
            "directed_retry_max_lines": "4",
            "model_id": "vibevoice-1.5b-latest",
        },
        files={"voice_file_1": ("voice.wav", b"voice", "audio/wav")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["audio_mime_type"] == "audio/wav"
    assert payload["audio_base64"] == base64.b64encode(b"RIFFfakewav").decode("ascii")
    assert payload["normalized_script"] == "Speaker 1: 你好。"
    assert payload["artifacts"][0]["label"] == "Speaker 1 VibeVoice"
    assert payload["providers"]["vibevoice"] == "fake-vibevoice"
    assert len(service.calls) == 1
    assert service.calls[0][2].model_id == "vibevoice-1.5b-latest"
    assert service.calls[0][2].inference_steps == 3
    assert service.calls[0][2].line_by_line is True
    assert service.calls[0][2].directed_line_mode is True
    assert service.calls[0][2].directed_retry_low_score is True
    assert service.calls[0][2].directed_retry_score_threshold == 0.7
    assert service.calls[0][2].directed_retry_max_lines == 4


def test_vibevoice_generate_api_translates_script_before_generation(monkeypatch) -> None:
    class FakeVibeVoiceResult:
        audio_bytes = b"RIFFfakewav"
        audio_mime_type = "audio/wav"
        normalized_script = "Speaker 1: 你好。"
        timings_ms = {"vibevoice": 12.0, "total": 12.0}
        diagnostics = {}
        providers = {"vibevoice": "fake-vibevoice"}

    class FakeVibeVoiceService:
        def __init__(self):
            self.calls = []

        def generate(self, *, script_text, voice_paths, options):
            self.calls.append((script_text, voice_paths, options))
            return FakeVibeVoiceResult()

    def fake_translate(script_text: str, output_language: str, model: str) -> str:
        assert script_text == "1 こんにちは\n2 元気ですか"
        assert output_language == "zh-CN"
        assert model == "test-vv-translation-model"
        return '{"source_language":"ja-JP","script":"1 你好。\\n2 你好吗？"}'

    monkeypatch.setenv("OPENAI_VIBEVOICE_SCRIPT_TRANSLATION_MODEL", "test-vv-translation-model")
    monkeypatch.setattr("mo_speech.api._openai_vibevoice_translate_script", fake_translate, raising=False)
    service = FakeVibeVoiceService()
    client = TestClient(create_app(vibevoice_service=service))

    response = client.post(
        "/api/vibevoice/generate",
        data={
            "script": "1 こんにちは\n2 元気ですか",
            "output_language": "zh-CN",
            "translate_script": "true",
        },
        files={"voice_file_1": ("voice.wav", b"voice", "audio/wav")},
    )

    assert response.status_code == 200
    assert service.calls[0][0] == "1 你好。\n2 你好吗？"
    diagnostics = response.json()["diagnostics"]["script_translation"]
    assert diagnostics["enabled"] is True
    assert diagnostics["source_language"] == "ja-JP"
    assert diagnostics["output_language"] == "zh-CN"
    assert diagnostics["source_script"] == "1 こんにちは\n2 元気ですか"
    assert diagnostics["translated_script"] == "1 你好。\n2 你好吗？"
    assert diagnostics["model"] == "test-vv-translation-model"


def test_vibevoice_script_api_generates_exact_five_lines_from_current_script(monkeypatch) -> None:
    captured: dict[str, str] = {}

    def fake_generate(seed_script: str) -> str:
        captured["seed_script"] = seed_script
        return "1 こんにちは\n2 久しぶりです\n1 元気でしたか\n2 元気です\n1 また話しましょう"

    monkeypatch.setattr(
        "mo_speech.api._openai_vibevoice_generate_script",
        fake_generate,
    )
    client = TestClient(create_app())

    response = client.post("/api/vibevoice/scripts", json={"seed_script": "1 AIについて話そう\n2 いいですね"})

    assert response.status_code == 200
    assert captured["seed_script"] == "1 AIについて話そう\n2 いいですね"
    assert response.json()["script"].splitlines() == [
        "1 こんにちは",
        "2 久しぶりです",
        "1 元気でしたか",
        "2 元気です",
        "1 また話しましょう",
    ]


def test_vibevoice_generate_api_defaults_to_directed_retry_mode() -> None:
    class FakeVibeVoiceResult:
        audio_bytes = b"RIFFfakewav"
        audio_mime_type = "audio/wav"
        normalized_script = "Speaker 1: 你好。"
        timings_ms = {"vibevoice": 12.0, "total": 12.0}
        diagnostics = {}
        providers = {"vibevoice": "fake-vibevoice"}

    class FakeVibeVoiceService:
        def __init__(self):
            self.calls = []

        def generate(self, *, script_text, voice_paths, options):
            self.calls.append((script_text, voice_paths, options))
            return FakeVibeVoiceResult()

    service = FakeVibeVoiceService()
    client = TestClient(create_app(vibevoice_service=service))

    response = client.post(
        "/api/vibevoice/generate",
        data={"script": "\n".join(f"1 你好{i}。" for i in range(1, 12))},
        files={"voice_file_1": ("voice.wav", b"voice", "audio/wav")},
    )

    assert response.status_code == 200
    assert len(service.calls) == 1
    options = service.calls[0][2]
    assert options.directed_line_mode is True
    assert options.directed_retry_low_score is True
    assert options.directed_retry_score_threshold == 0.65
    assert options.directed_retry_max_lines == 6


def test_vibevoice_generate_api_scales_retry_max_lines_from_multiplier() -> None:
    class FakeVibeVoiceResult:
        audio_bytes = b"RIFFfakewav"
        audio_mime_type = "audio/wav"
        normalized_script = "Speaker 1: 你好。"
        timings_ms = {"vibevoice": 12.0, "total": 12.0}
        diagnostics = {}
        providers = {"vibevoice": "fake-vibevoice"}

    class FakeVibeVoiceService:
        def __init__(self):
            self.calls = []

        def generate(self, *, script_text, voice_paths, options):
            self.calls.append((script_text, voice_paths, options))
            return FakeVibeVoiceResult()

    service = FakeVibeVoiceService()
    client = TestClient(create_app(vibevoice_service=service))

    response = client.post(
        "/api/vibevoice/generate",
        data={
            "script": "\n".join(f"1 你好{i}。" for i in range(1, 12)),
            "directed_retry_max_multiplier": "2",
        },
        files={"voice_file_1": ("voice.wav", b"voice", "audio/wav")},
    )

    assert response.status_code == 200
    assert service.calls[0][2].directed_retry_max_lines == 12


def test_vibevoice_generate_api_preserves_voice_slots() -> None:
    class FakeVibeVoiceResult:
        audio_bytes = b"RIFFfakewav"
        audio_mime_type = "audio/wav"
        normalized_script = "Speaker 2: 你好。"
        timings_ms = {"vibevoice": 12.0, "total": 12.0}
        diagnostics = {}
        providers = {"vibevoice": "fake-vibevoice"}

    class FakeVibeVoiceService:
        def __init__(self):
            self.calls = []
            self.voice_bytes = b""

        def generate(self, *, script_text, voice_paths, options):
            self.calls.append((script_text, voice_paths, options))
            self.voice_bytes = voice_paths[0].path.read_bytes()
            return FakeVibeVoiceResult()

    service = FakeVibeVoiceService()
    client = TestClient(create_app(vibevoice_service=service))

    response = client.post(
        "/api/vibevoice/generate",
        data={"script": "Speaker 2: 你好。"},
        files={"voice_file_2": ("voice2.wav", b"voice2", "audio/wav")},
    )

    assert response.status_code == 200
    assert len(service.calls) == 1
    voice_samples = service.calls[0][1]
    assert len(voice_samples) == 1
    assert voice_samples[0].slot == 2
    assert service.voice_bytes == b"voice2"


def test_vibevoice_reference_audio_from_url_api_returns_wav() -> None:
    class FakeReferenceAudioExtractor:
        def __init__(self):
            self.calls = []

        def extract_from_url(self, url, *, start_seconds=None, duration_seconds=5.0):
            self.calls.append((url, start_seconds, duration_seconds))
            return ReferenceAudioClip(
                audio_bytes=b"RIFFurlwav",
                audio_mime_type="audio/wav",
                filename="reference_url_s75_d5.wav",
                source_url=url,
                start_seconds=75.0 if start_seconds is None else start_seconds,
                detected_start_seconds=75.0,
                duration_seconds=duration_seconds,
            )

    extractor = FakeReferenceAudioExtractor()
    client = TestClient(create_app(reference_audio_extractor=extractor), base_url="http://127.0.0.1")

    response = client.post(
        "/api/vibevoice/reference-audio-from-url",
        data={"url": "https://youtu.be/example?t=75", "duration_seconds": "5"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["audio_mime_type"] == "audio/wav"
    assert payload["audio_base64"] == base64.b64encode(b"RIFFurlwav").decode("ascii")
    assert payload["filename"] == "reference_url_s75_d5.wav"
    assert payload["start_seconds"] == 75.0
    assert payload["detected_start_seconds"] == 75.0
    assert extractor.calls == [("https://youtu.be/example?t=75", None, 5.0)]


def test_vibevoice_reference_audio_from_url_api_rejects_non_local_request() -> None:
    class FailingReferenceAudioExtractor:
        def extract_from_url(self, *args, **kwargs):
            raise AssertionError("extractor must not run for a non-local request")

    client = TestClient(create_app(reference_audio_extractor=FailingReferenceAudioExtractor()))

    response = client.post(
        "/api/vibevoice/reference-audio-from-url",
        data={"url": "https://youtu.be/example", "duration_seconds": "5"},
    )

    assert response.status_code == 403
    assert response.json() == {
        "detail": "URL参照音声取得はローカルFastAPIへのloopback接続でのみ利用できます。"
    }


def test_vibevoice_reference_audio_from_url_api_allows_explicit_override(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeReferenceAudioExtractor:
        def extract_from_url(self, url, *, start_seconds=None, duration_seconds=5.0):
            return ReferenceAudioClip(
                audio_bytes=b"RIFFurlwav",
                audio_mime_type="audio/wav",
                filename="reference.wav",
                source_url=url,
                start_seconds=0.0,
                detected_start_seconds=None,
                duration_seconds=duration_seconds,
            )

    monkeypatch.setenv("MO_VIBEVOICE_URL_REFERENCE_ENABLED", "1")
    client = TestClient(create_app(reference_audio_extractor=FakeReferenceAudioExtractor()))

    response = client.post(
        "/api/vibevoice/reference-audio-from-url",
        data={"url": "https://example.com/audio", "duration_seconds": "5"},
    )

    assert response.status_code == 200


def test_vibevoice_generate_api_resolves_url_reference_before_runpod_backend() -> None:
    class FakeReferenceAudioExtractor:
        def __init__(self):
            self.calls = []

        def extract_from_url(self, url, *, start_seconds=None, duration_seconds=5.0):
            self.calls.append((url, start_seconds, duration_seconds))
            return ReferenceAudioClip(
                audio_bytes=b"RIFFurlwav",
                audio_mime_type="audio/wav",
                filename="reference_url_s12_d6.wav",
                source_url=url,
                start_seconds=12.0,
                detected_start_seconds=75.0,
                duration_seconds=duration_seconds,
            )

    class FakeVibeVoiceResult:
        audio_bytes = b"RIFrunpod"
        audio_mime_type = "audio/wav"
        normalized_script = "Speaker 1: 你好。"
        timings_ms = {"vibevoice": 12.0, "runpod_handler_total": 20.0, "total": 20.0}
        diagnostics = {}
        providers = {"vibevoice": "runpod-serverless-vibevoice"}

    class FakeRunpodVibeVoiceService:
        def __init__(self):
            self.calls = []
            self.voice_bytes = b""
            self.voice_names = []

        def status(self):
            return {"available": True, "provider": "fake-runpod"}

        def generate(self, *, script_text, voice_paths, options):
            self.calls.append((script_text, voice_paths, options))
            self.voice_bytes = voice_paths[0].path.read_bytes()
            self.voice_names = [voice.path.name for voice in voice_paths]
            return FakeVibeVoiceResult()

    extractor = FakeReferenceAudioExtractor()
    runpod_service = FakeRunpodVibeVoiceService()
    client = TestClient(
        create_app(reference_audio_extractor=extractor, runpod_vibevoice_service=runpod_service),
        base_url="http://127.0.0.1",
    )

    response = client.post(
        "/api/vibevoice/generate",
        data={
            "script": "你好。",
            "backend": "runpod_serverless",
            "model_id": "vibevoice-large-aoi-pinned",
            "voice_url_1": "https://youtu.be/example?t=75",
            "voice_url_start_1": "12",
            "voice_url_duration_1": "6",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["providers"]["vibevoice"] == "runpod-serverless-vibevoice"
    assert payload["diagnostics"]["url_reference_audio"] == [
        {
            "slot": 1,
            "filename": "reference_url_s12_d6.wav",
            "source_url": "https://youtu.be/example?t=75",
            "start_seconds": 12.0,
            "detected_start_seconds": 75.0,
            "duration_seconds": 6.0,
            "size_bytes": len(b"RIFFurlwav"),
        }
    ]
    assert extractor.calls == [("https://youtu.be/example?t=75", 12.0, 6.0)]
    assert len(runpod_service.calls) == 1
    assert runpod_service.voice_bytes == b"RIFFurlwav"
    assert runpod_service.voice_names == ["voice-1.wav"]


def test_vibevoice_generate_api_rejects_url_reference_from_non_local_request() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/api/vibevoice/generate",
        data={
            "script": "你好。",
            "voice_url_1": "https://youtu.be/example",
            "voice_url_duration_1": "5",
        },
    )

    assert response.status_code == 403


def test_vibevoice_job_api_rejects_url_reference_from_non_local_request() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/api/vibevoice/jobs",
        data={
            "script": "你好。",
            "voice_url_1": "https://youtu.be/example",
            "voice_url_duration_1": "5",
        },
    )

    assert response.status_code == 403


def test_vibevoice_generate_api_can_use_runpod_backend() -> None:
    class FakeVibeVoiceResult:
        audio_bytes = b"RIFrunpod"
        audio_mime_type = "audio/wav"
        normalized_script = "Speaker 1: 你好。"
        timings_ms = {"vibevoice": 12.0, "runpod_handler_total": 20.0, "total": 20.0}
        diagnostics = {}
        providers = {"vibevoice": "runpod-serverless-vibevoice"}

    class FakeVibeVoiceService:
        def __init__(self):
            self.calls = []

        def status(self):
            return {"available": True, "provider": "fake-runpod"}

        def generate(self, *, script_text, voice_paths, options):
            self.calls.append((script_text, voice_paths, options))
            return FakeVibeVoiceResult()

    runpod_service = FakeVibeVoiceService()
    client = TestClient(create_app(runpod_vibevoice_service=runpod_service))

    response = client.post(
        "/api/vibevoice/generate",
        data={"script": "你好。", "backend": "runpod_serverless", "model_id": "vibevoice-large-aoi-pinned"},
        files={"voice_file_1": ("voice.wav", b"voice", "audio/wav")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["providers"]["vibevoice"] == "runpod-serverless-vibevoice"
    assert payload["audio_base64"] == base64.b64encode(b"RIFrunpod").decode("ascii")
    assert len(runpod_service.calls) == 1
    assert runpod_service.calls[0][2].model_id == "vibevoice-large-aoi-pinned"


def test_vibevoice_generate_api_rejects_runpod_only_model_on_local_backend() -> None:
    class FakeVibeVoiceService:
        def __init__(self):
            self.calls = []

        def generate(self, *, script_text, voice_paths, options):
            self.calls.append((script_text, voice_paths, options))
            raise AssertionError("local service should not be called for a RunPod-only model")

    service = FakeVibeVoiceService()
    client = TestClient(create_app(vibevoice_service=service))

    response = client.post(
        "/api/vibevoice/generate",
        data={"script": "你好。", "backend": "local", "model_id": "vibevoice-large-aoi-pinned"},
        files={"voice_file_1": ("voice.wav", b"voice", "audio/wav")},
    )

    assert response.status_code == 400
    assert "runpod_serverless" in response.json()["detail"]
    assert service.calls == []


def test_vibevoice_job_api_rejects_runpod_only_model_on_local_backend() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/api/vibevoice/jobs",
        data={"script": "你好。", "backend": "local", "model_id": "vibevoice-large-aoi-pinned"},
        files={"voice_file_1": ("voice.wav", b"voice", "audio/wav")},
    )

    assert response.status_code == 400
    assert "runpod_serverless" in response.json()["detail"]


def test_vibevoice_job_api_reports_elapsed_and_result(tmp_path: Path) -> None:
    class FakeVibeVoiceResult:
        audio_bytes = b"RIFFfakewav"
        audio_mime_type = "audio/wav"
        normalized_script = "Speaker 1: 你好。"
        timings_ms = {"vibevoice": 12.0, "total": 12.0}
        diagnostics = {"used_voice_samples": [{"slot": 1, "filename": "voice.wav", "size": 5}]}
        providers = {"vibevoice": "fake-vibevoice"}

    class FakeVibeVoiceService:
        def generate(self, *, script_text, voice_paths, options, progress_callback=None, cancel_event=None):
            if progress_callback is not None:
                progress_callback("generation", "VibeVoice生成")
                progress_callback("generation", "生成中 16/32 (50%, 残り約00:08)")
            return FakeVibeVoiceResult()

    client = TestClient(create_app(vibevoice_service=FakeVibeVoiceService()))

    response = client.post(
        "/api/vibevoice/jobs",
        data={"script": "你好。"},
        files={"voice_file_1": ("voice.wav", b"voice", "audio/wav")},
    )

    assert response.status_code == 200
    job_id = response.json()["job_id"]
    status_payload = None
    for _ in range(20):
        status_response = client.get(f"/api/vibevoice/jobs/{job_id}")
        assert status_response.status_code == 200
        status_payload = status_response.json()
        if status_payload["status"] == "succeeded":
            break
    assert status_payload is not None
    assert status_payload["status"] == "succeeded"
    assert status_payload["elapsed_ms"] >= 0
    assert status_payload["result"]["audio_base64"] == base64.b64encode(b"RIFFfakewav").decode("ascii")
    assert any("16/32" in item["label"] for item in status_payload["progress_log"])
    debug_payload = json.loads((tmp_path / "vibevoice-debug" / "last-result.json").read_text(encoding="utf-8"))
    assert debug_payload["job_id"] == job_id
    assert debug_payload["result"]["audio_base64_chars"] == len(base64.b64encode(b"RIFFfakewav").decode("ascii"))
    assert "audio_base64" not in debug_payload["result"]
    assert debug_payload["result"]["diagnostics"]["used_voice_samples"] == FakeVibeVoiceResult.diagnostics["used_voice_samples"]
    assert debug_payload["result"]["diagnostics"]["script_translation"]["enabled"] is False
    assert debug_payload["result"]["diagnostics"]["script_translation"]["output_language"] == "zh-CN"


def test_vibevoice_job_api_resolves_url_reference_and_reports_diagnostics(tmp_path: Path) -> None:
    class FakeReferenceAudioExtractor:
        def __init__(self):
            self.calls = []

        def extract_from_url(self, url, *, start_seconds=None, duration_seconds=5.0):
            self.calls.append((url, start_seconds, duration_seconds))
            return ReferenceAudioClip(
                audio_bytes=b"RIFFjoburlwav",
                audio_mime_type="audio/wav",
                filename="reference_url_s75_d5.wav",
                source_url=url,
                start_seconds=75.0,
                detected_start_seconds=75.0,
                duration_seconds=duration_seconds,
            )

    class FakeVibeVoiceResult:
        audio_bytes = b"RIFFfakewav"
        audio_mime_type = "audio/wav"
        normalized_script = "Speaker 1: 你好。"
        timings_ms = {"vibevoice": 12.0, "total": 12.0}
        diagnostics = {}
        providers = {"vibevoice": "fake-vibevoice"}

    class FakeVibeVoiceService:
        def __init__(self):
            self.voice_bytes = b""

        def generate(self, *, script_text, voice_paths, options, progress_callback=None, cancel_event=None):
            self.voice_bytes = voice_paths[0].path.read_bytes()
            return FakeVibeVoiceResult()

    extractor = FakeReferenceAudioExtractor()
    service = FakeVibeVoiceService()
    client = TestClient(
        create_app(reference_audio_extractor=extractor, vibevoice_service=service),
        base_url="http://127.0.0.1",
    )

    response = client.post(
        "/api/vibevoice/jobs",
        data={
            "script": "你好。",
            "voice_url_1": "https://youtu.be/example?t=75",
            "voice_url_duration_1": "5",
        },
    )

    assert response.status_code == 200
    job_id = response.json()["job_id"]
    status_payload = None
    for _ in range(20):
        status_response = client.get(f"/api/vibevoice/jobs/{job_id}")
        assert status_response.status_code == 200
        status_payload = status_response.json()
        if status_payload["status"] == "succeeded":
            break
    assert status_payload is not None
    assert status_payload["status"] == "succeeded"
    assert service.voice_bytes == b"RIFFjoburlwav"
    assert extractor.calls == [("https://youtu.be/example?t=75", None, 5.0)]
    assert status_payload["result"]["diagnostics"]["url_reference_audio"][0]["source_url"] == "https://youtu.be/example?t=75"
    debug_payload = json.loads((tmp_path / "vibevoice-debug" / "last-result.json").read_text(encoding="utf-8"))
    assert debug_payload["result"]["diagnostics"]["url_reference_audio"][0]["filename"] == "reference_url_s75_d5.wav"


def test_vibevoice_job_api_can_request_cancel() -> None:
    class FakeVibeVoiceService:
        def generate(self, *, script_text, voice_paths, options, progress_callback=None, cancel_event=None):
            if cancel_event is not None:
                cancel_event.wait(timeout=2)
            raise RuntimeError("cancel observed")

    client = TestClient(create_app(vibevoice_service=FakeVibeVoiceService()))
    response = client.post(
        "/api/vibevoice/jobs",
        data={"script": "你好。"},
        files={"voice_file_1": ("voice.wav", b"voice", "audio/wav")},
    )
    assert response.status_code == 200
    job_id = response.json()["job_id"]

    cancel_response = client.post(f"/api/vibevoice/jobs/{job_id}/cancel")

    assert cancel_response.status_code == 200
    assert cancel_response.json()["status"] in {"cancelling", "cancelled", "failed"}


def test_practice_prompt_api_generates_target_phrase_and_audio() -> None:
    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"auto": "コーヒーがほしいです"}),
        translator=FakeTranslationProvider({("auto", "zh-CN", "コーヒーがほしいです"): "我想要咖啡。"}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(create_app(openai_pipeline=pipeline))

    response = client.post(
        "/api/practice/prompts",
        data={"target_language": "zh-CN"},
        files={"audio": ("native.webm", b"native audio", "audio/webm")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["transcript"] == "コーヒーがほしいです"
    assert payload["target_text"] == "我想要咖啡。"
    assert payload["target_language"] == "zh-CN"
    assert payload["display_text"]["pinyin_text"] == ""
    assert payload["audio_base64"] == base64.b64encode("FAKE-WAV:zh-CN:我想要咖啡。".encode()).decode()
    assert payload["providers"]["asr"] == "fake-asr"


def test_practice_prompt_api_includes_local_pinyin_when_requested(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"auto": "コーヒーがほしいです"}),
        translator=FakeTranslationProvider({("auto", "zh-CN", "コーヒーがほしいです"): "我想要咖啡。"}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(create_app(openai_pipeline=pipeline))

    response = client.post(
        "/api/practice/prompts",
        data={"target_language": "zh-CN", "include_pinyin": "true"},
        files={"audio": ("native.webm", b"native audio", "audio/webm")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["display_text"]["pinyin_text"] == "wǒ xiǎng yào kā fēi"
    assert payload["display_text"]["pinyin_status"] == "ready"


def test_practice_prompt_api_omits_non_chinese_tokens_from_local_pinyin(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"auto": "外付けSSDを買いました"}),
        translator=FakeTranslationProvider(
            {("auto", "zh-CN", "外付けSSDを買いました"): "我买了一个外接 SSD，容量有 1TB。"}
        ),
        tts=FakeTtsProvider(),
    )
    client = TestClient(create_app(openai_pipeline=pipeline))

    response = client.post(
        "/api/practice/prompts",
        data={"target_language": "zh-CN", "include_pinyin": "true"},
        files={"audio": ("native.webm", b"native audio", "audio/webm")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["display_text"]["pinyin_text"] == "wǒ mǎi le yí gè wài jiē róng liàng yǒu"
    assert "SSD" not in payload["display_text"]["pinyin_text"]
    assert "1TB" not in payload["display_text"]["pinyin_text"]


def test_practice_attempt_job_rejects_a_boundary_only_target_before_asr() -> None:
    class MustNotRunAsr:
        name = "must-not-run"

        def transcribe_detail(self, *args, **kwargs):
            raise AssertionError("ASR must not run for an invalid target")

    pipeline = SpeechTranslationPipeline(
        asr=MustNotRunAsr(),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(create_app(openai_pipeline=pipeline))

    response = client.post(
        "/api/practice/attempt-jobs",
        data={"target_language": "en-US", "target_text": "..."},
        files={
            "audio": ("repeat.webm", b"repeat audio", "audio/webm"),
            "model_audio": ("model.wav", b"model audio", "audio/wav"),
        },
    )

    assert response.status_code == 400
    assert response.json() == {
        "error": {
            "code": "practice_alignment_invalid_input",
            "reason": "empty_target",
            "stage": "input",
            "retryable": False,
            "message": "入力内容を確認して、もう一度お試しください。",
            "diagnostic_flags": ["empty_target"],
        }
    }


def test_practice_attempt_job_rejects_oversized_targets_before_asr() -> None:
    class MustNotRunAsr:
        name = "must-not-run"

        def transcribe_detail(self, *args, **kwargs):
            raise AssertionError("ASR must not run for an oversized target")

    pipeline = SpeechTranslationPipeline(
        asr=MustNotRunAsr(),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(create_app(openai_pipeline=pipeline))
    target_text = " ".join(f"Phrase {index}." for index in range(17))

    response = client.post(
        "/api/practice/attempt-jobs",
        data={"target_language": "en-US", "target_text": target_text},
        files={
            "audio": ("attempt.webm", b"attempt audio", "audio/webm"),
            "model_audio": ("model.wav", b"model audio", "audio/wav"),
        },
    )

    assert response.status_code == 400
    assert response.json() == {
        "error": {
            "code": "practice_alignment_invalid_input",
            "reason": "alignment_input_too_large",
            "stage": "input",
            "retryable": False,
            "message": "入力内容を確認して、もう一度お試しください。",
            "diagnostic_flags": ["alignment_input_too_large"],
        }
    }


def test_practice_attempt_job_returns_runpod_queue_and_completed_dual_alignment(tmp_path, monkeypatch) -> None:
    class FakeAsyncRunpodAsr:
        name = "runpod-funasr-paraformer-zh"

        def submit_comparison_job(self, **kwargs):
            assert kwargs["attempt_audio_path"].read_bytes() == b"attempt audio"
            assert kwargs["model_audio_path"].read_bytes() == b"model audio"
            assert kwargs["source_language"] == "zh-CN"
            assert kwargs["target_text"] == "你好吗？你今天去哪里？"
            return {"id": "practice-job-1", "status": "IN_QUEUE"}

        def health(self):
            return {"workers": {"idle": 0, "running": 0, "initializing": 1}}

        def job_status(self, job_id):
            assert job_id == "practice-job-1"
            return {
                "id": job_id,
                "status": "COMPLETED",
                "delayTime": 1200,
                "executionTime": 450,
                "output": {
                    "practice_asr_contract_version": 2,
                    "target_text": "你好吗？你今天去哪里？",
                    "text": "你哈吗？你今天到那里？",
                    "model": "funasr/paraformer-zh",
                    "timestamp_granularities": ["word"],
                    "words": [
                        {"text": "你哈吗", "start": 0.1, "end": 0.8},
                        {"text": "你今天", "start": 1.0, "end": 1.5},
                        {"text": "到那里", "start": 1.5, "end": 2.3},
                    ],
                    "segments": [],
                    "model_transcription": {
                        "text": "你好吗？你今天去哪里？",
                        "model": "funasr/paraformer-zh",
                        "timestamp_granularities": ["word"],
                        "words": [
                            {"text": "你好吗", "start": 0.1, "end": 0.8},
                            {"text": "你今天", "start": 1.0, "end": 1.5},
                            {"text": "去哪里", "start": 1.5, "end": 2.4},
                        ],
                        "segments": [],
                    },
                    "providers": {"asr": "funasr-paraformer-zh"},
                },
            }

    class FakePracticeLlm:
        def evaluate(self, *, model, input_payload):
            # このfakeはPracticeLlmServiceの代わりであり、validate_practice_llm_result済みの
            # 結果を直接返す。そのためmatched_text/start/end/playback_*も自前で計算して含める。
            result = {
                "schema_version": 1,
                "overall_score": 80,
                "overall_comment": "「哈」と「到」が異なります。",
                "phrases": [
                    {
                        "phrase_index": 0,
                        "target_text": "你好吗？你今天去哪里？",
                        "score": 80,
                        "comment": "「哈」と「到」が異なります。",
                        "reference": {
                            "status": "assigned",
                            "word_start_index": 0,
                            "word_end_index": 3,
                            "matched_text": "你好吗你今天去哪里",
                            "start": 0.1,
                            "end": 2.4,
                            "playback_start": 0.0,
                            "playback_end": 2.5,
                        },
                        "attempt": {
                            "status": "partial",
                            "word_start_index": 0,
                            "word_end_index": 3,
                            "matched_text": "你哈吗你今天到那里",
                            "start": 0.1,
                            "end": 2.3,
                            "playback_start": 0.0,
                            "playback_end": 2.4,
                        },
                    }
                ],
            }
            return PracticeLlmEvaluation(
                result=result,
                usage={"total_tokens": 100},
                estimated_cost_usd=None,
                elapsed_ms=5.0,
                log_path=tmp_path / "practice-llm.json",
            )

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"zh-CN": "OpenAI should not be used"}),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    history_store = AudioHistoryStore(root=tmp_path / "practice-history", limit=10, enabled=True)
    monkeypatch.setattr(
        "mo_speech.api_audio_history.prepare_audio_history_wav",
        lambda audio_bytes, suffix: (audio_bytes, ".wav", {"audio_mime_type": "audio/wav"}),
    )
    client = TestClient(
        create_app(
            openai_pipeline=pipeline,
            runpod_practice_asr_provider=FakeAsyncRunpodAsr(),
            audio_history_store=history_store,
            practice_llm_service=FakePracticeLlm(),
        )
    )

    submitted = client.post(
        "/api/practice/attempt-jobs",
        data={
            "target_language": "zh-CN",
            "target_text": "你好吗？你今天去哪里？",
            "comparison_model": "gpt-5.6-terra",
            "playback_padding_seconds": "0.1",
        },
        files={
            "audio": ("attempt.webm", b"attempt audio", "audio/webm"),
            "model_audio": ("model.wav", b"model audio", "audio/wav"),
        },
    )

    assert submitted.status_code == 202
    queued = submitted.json()
    assert queued["job_id"] == "practice-job-1"
    assert queued["status"] == "queued"
    assert queued["current_stage"]["stage"] == "initializing"
    assert queued["current_stage"]["model"] == "funasr/paraformer-zh"
    submitted_history = history_store.list_entries("recordings")
    assert len(submitted_history) == 1
    assert submitted_history[0].metadata["practice_job_id"] == "practice-job-1"
    assert submitted_history[0].metadata["practice_job_status"] == "queued"

    completed = client.get("/api/practice/attempt-jobs/practice-job-1")
    assert completed.status_code == 200
    snapshot = completed.json()
    assert snapshot["status"] == "succeeded"
    assert snapshot["metrics"] == {"delay_time_ms": 1200.0, "execution_time_ms": 450.0}
    assert snapshot["result"]["recognized_text"] == "你哈吗？你今天到那里？"
    assert snapshot["result"]["overall_score"] == 80
    assert snapshot["result"]["comparison_alignment"]["complete"] is True
    assert snapshot["result"]["comparison_alignment"]["phrases"][0]["audio_end"] == pytest.approx(2.4)
    assert snapshot["result"]["model_comparison_alignment"]["complete"] is True
    assert snapshot["result"]["model_comparison_alignment"]["phrases"][0]["audio_end"] == pytest.approx(2.5)
    completed_history = history_store.list_entries("recordings")
    assert len(completed_history) == 1
    metadata = completed_history[0].metadata
    assert metadata["practice_job_status"] == "succeeded"
    assert metadata["practice_job_metrics"] == {"delay_time_ms": 1200.0, "execution_time_ms": 450.0}
    diagnostics = metadata["practice_diagnostics"]
    assert diagnostics["outcome"] == "evaluated"
    assert diagnostics["overall_score"] == 80
    assert diagnostics["recognized_text"] == "你哈吗？你今天到那里？"
    assert diagnostics["model_recognized_text"] == "你好吗？你今天去哪里？"
    assert diagnostics["asr_timestamps"]["words"][0] == {"text": "你哈吗", "start": 0.1, "end": 0.8}
    assert diagnostics["model_asr_timestamps"]["words"][0] == {"text": "你好吗", "start": 0.1, "end": 0.8}


@pytest.mark.parametrize("llm_fails", [False, True])
def test_practice_attempt_job_reuses_cached_runpod_comparison_on_repeated_polls(
    tmp_path,
    monkeypatch,
    llm_fails,
) -> None:
    class FakeAsyncRunpodAsr:
        name = "runpod-funasr-paraformer-zh"

        def submit_comparison_job(self, **kwargs):
            return {"id": "practice-repoll-job", "status": "IN_QUEUE"}

        def health(self):
            return {"workers": {"idle": 0, "running": 0, "initializing": 1}}

        def job_status(self, job_id):
            return {
                "id": job_id,
                "status": "COMPLETED",
                "output": {
                    "practice_asr_contract_version": 2,
                    "target_text": "你好。",
                    "text": "你好。",
                    "model": "funasr/paraformer-zh",
                    "timestamp_granularities": ["word"],
                    "words": [{"text": "你好", "start": 0.1, "end": 0.8}],
                    "segments": [],
                    "model_transcription": {
                        "text": "你好。",
                        "model": "funasr/paraformer-zh",
                        "timestamp_granularities": ["word"],
                        "words": [{"text": "你好", "start": 0.0, "end": 0.7}],
                        "segments": [],
                    },
                    "providers": {"asr": "funasr-paraformer-zh"},
                },
            }

    class FakePracticeLlm:
        def __init__(self) -> None:
            self.calls = 0

        def evaluate(self, *, model, input_payload):
            self.calls += 1
            if llm_fails:
                raise PracticeLlmError("invalid response", stage="validate_response")
            result = {
                "schema_version": 1,
                "overall_score": 90,
                "overall_comment": "よくできました。",
                "phrases": [
                    {
                        "phrase_index": 0,
                        "target_text": "你好。",
                        "score": 90,
                        "comment": "よくできました。",
                        "reference": {
                            "status": "assigned",
                            "word_start_index": 0,
                            "word_end_index": 1,
                            "matched_text": "你好",
                            "start": 0.0,
                            "end": 0.7,
                            "playback_start": 0.0,
                            "playback_end": 0.7,
                        },
                        "attempt": {
                            "status": "assigned",
                            "word_start_index": 0,
                            "word_end_index": 1,
                            "matched_text": "你好",
                            "start": 0.1,
                            "end": 0.8,
                            "playback_start": 0.0,
                            "playback_end": 0.8,
                        },
                    }
                ],
            }
            return PracticeLlmEvaluation(
                result=result,
                usage={"total_tokens": 90},
                estimated_cost_usd=None,
                elapsed_ms=5.0,
                log_path=tmp_path / "practice-llm.json",
            )

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"zh-CN": "OpenAI should not be used"}),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    monkeypatch.setattr(
        "mo_speech.api_audio_history.prepare_audio_history_wav",
        lambda audio_bytes, suffix: (audio_bytes, ".wav", {"audio_mime_type": "audio/wav"}),
    )
    llm = FakePracticeLlm()
    client = TestClient(
        create_app(
            openai_pipeline=pipeline,
            runpod_practice_asr_provider=FakeAsyncRunpodAsr(),
            practice_llm_service=llm,
        )
    )

    client.post(
        "/api/practice/attempt-jobs",
        data={"target_language": "zh-CN", "target_text": "你好。", "comparison_model": "gpt-5.6-terra"},
        files={
            "audio": ("attempt.webm", b"attempt audio", "audio/webm"),
            "model_audio": ("model.wav", b"model audio", "audio/wav"),
        },
    )

    first = client.get("/api/practice/attempt-jobs/practice-repoll-job")
    second = client.get("/api/practice/attempt-jobs/practice-repoll-job")

    assert first.status_code == 200
    assert second.status_code == 200
    if llm_fails:
        assert first.json()["status"] == "failed"
        assert second.json() == first.json()
        assert first.json()["error"]["code"] == "practice_llm_failed"
    else:
        assert first.json()["result"]["overall_score"] == 90
        assert second.json()["result"]["overall_score"] == 90
    assert llm.calls == 1, "re-polling a completed RunPod job must reuse the cached comparison instead of calling the LLM again"


def test_practice_attempt_job_falls_back_to_asr_word_ends_when_duration_probe_failed(monkeypatch) -> None:
    # ffprobeが無い/対応できない環境では、提出時点のaudio_duration probeが0.0のまま
    # 保存される。0.0がそのままLLM検証のplayback_end = min(duration, end+padding)へ
    # 渡ると、有効な単語範囲でもplayback_endが0になり誤ってpractice_llm_failedになる
    # (Codexレビュー指摘)。実際のPracticeLlmService.evaluate/validate_practice_llm_result
    # を通してこの回帰を検出するため、practice_llm_serviceはfakeにせずopenaiクライアント
    # だけをモックする。
    class FakeAsyncRunpodAsr:
        name = "runpod-funasr-paraformer-zh"

        def submit_comparison_job(self, **kwargs):
            return {"id": "practice-duration-fallback-job", "status": "IN_QUEUE"}

        def health(self):
            return {"workers": {"idle": 0, "running": 0, "initializing": 1}}

        def job_status(self, job_id):
            return {
                "id": job_id,
                "status": "COMPLETED",
                "output": {
                    "practice_asr_contract_version": 2,
                    "target_text": "你好。",
                    "text": "你好。",
                    "model": "funasr/paraformer-zh",
                    "timestamp_granularities": ["word"],
                    "words": [{"text": "你好", "start": 0.1, "end": 0.8}],
                    "segments": [],
                    "model_transcription": {
                        "text": "你好。",
                        "model": "funasr/paraformer-zh",
                        "timestamp_granularities": ["word"],
                        "words": [{"text": "你好", "start": 0.0, "end": 0.7}],
                        "segments": [],
                    },
                    "providers": {"asr": "funasr-paraformer-zh"},
                },
            }

    class Responses:
        @staticmethod
        def create(**kwargs):
            return SimpleNamespace(
                output_text=json.dumps(
                    {
                        "schema_version": 1,
                        "overall_score": 100,
                        "overall_comment": "正確です。",
                        "phrases": [
                            {
                                "phrase_index": 0,
                                "target_text": "你好。",
                                "score": 100,
                                "comment": "正確です。",
                                "reference": {"status": "assigned", "word_start_index": 0, "word_end_index": 1},
                                "attempt": {"status": "assigned", "word_start_index": 0, "word_end_index": 1},
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                usage=None,
            )

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"zh-CN": "OpenAI should not be used"}),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    monkeypatch.setattr(
        "mo_speech.api_audio_history.prepare_audio_history_wav",
        lambda audio_bytes, suffix: (audio_bytes, ".wav", {"audio_mime_type": "audio/wav"}),
    )
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=lambda: SimpleNamespace(responses=Responses())))
    client = TestClient(
        create_app(
            openai_pipeline=pipeline,
            runpod_practice_asr_provider=FakeAsyncRunpodAsr(),
        )
    )

    client.post(
        "/api/practice/attempt-jobs",
        data={"target_language": "zh-CN", "target_text": "你好。", "comparison_model": "gpt-5.6-terra"},
        files={
            # ffprobeでは音声として解析できない中身にして、提出時点のduration probeを
            # 0.0(probe失敗)にする。
            "audio": ("attempt.webm", b"not a real audio file", "audio/webm"),
            "model_audio": ("model.wav", b"not a real audio file either", "audio/wav"),
        },
    )

    response = client.get("/api/practice/attempt-jobs/practice-duration-fallback-job")

    assert response.status_code == 200
    snapshot = response.json()
    assert snapshot["status"] == "succeeded", snapshot.get("error")
    assert snapshot["result"]["outcome"] == "evaluated"
    assert snapshot["result"]["comparison_alignment"]["phrases"][0]["audio_end"] == pytest.approx(0.8)
    assert snapshot["result"]["model_comparison_alignment"]["phrases"][0]["audio_end"] == pytest.approx(0.7)


def test_practice_attempt_job_explains_outdated_runpod_image() -> None:
    class OutdatedRunpodAsr:
        name = "runpod-funasr-paraformer-zh"

        def job_status(self, job_id):
            return {
                "id": job_id,
                "status": "COMPLETED",
                "output": {
                    "target_text": "你好吗？",
                    "text": "你好吗？",
                    "model": "funasr/paraformer-zh",
                },
            }

        def health(self):
            return {}

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({}),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(create_app(openai_pipeline=pipeline, runpod_practice_asr_provider=OutdatedRunpodAsr()))

    response = client.get("/api/practice/attempt-jobs/outdated-practice-job")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "failed"
    assert payload["current_stage"]["label"] == "RunPod imageの更新が必要です"
    assert "practice ASR contract v2" in payload["error"]
    assert "再デプロイ" in payload["error"]


def test_practice_attempt_job_fails_with_typed_empty_reference_error() -> None:
    class EmptyReferenceRunpodAsr:
        name = "runpod-funasr-paraformer-zh"

        def job_status(self, job_id):
            return {
                "id": job_id,
                "status": "COMPLETED",
                "output": {
                    "practice_asr_contract_version": 2,
                    "target_text": "你好吗？",
                    "text": "你好吗？",
                    "model": "funasr/paraformer-zh",
                    "words": [{"text": "你好吗", "start": 0.1, "end": 0.8}],
                    "segments": [],
                    "model_transcription": {
                        "text": "",
                        "model": "funasr/paraformer-zh",
                        "words": [],
                        "segments": [],
                    },
                },
            }

        def health(self):
            return {}

    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({}),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(create_app(openai_pipeline=pipeline, runpod_practice_asr_provider=EmptyReferenceRunpodAsr()))

    response = client.get("/api/practice/attempt-jobs/empty-reference")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "failed"
    assert payload["result"] is None
    assert payload["error"] == {
        "code": "practice_alignment_provider_contract_error",
        "reason": "empty_reference_asr",
        "stage": "reference_asr",
        "retryable": True,
        "message": "音声の解析結果を確認できませんでした。もう一度お試しください。",
        "diagnostic_flags": ["empty_reference_asr"],
    }


def test_practice_attempt_job_transcribes_both_english_audios_with_whisper(tmp_path) -> None:
    class SequencedAsr:
        name = "fake-whisper"

        def __init__(self):
            self.calls = []

        def transcribe_detail(self, audio_path, source_language, *, include_timestamps):
            audio = audio_path.read_bytes()
            self.calls.append((audio, source_language, include_timestamps))
            if audio == b"model audio":
                return AsrTranscription(
                    text="Where are you going?",
                    model="whisper-1",
                    words=[{"text": "Where are you going", "start": 0.1, "end": 1.2}],
                    timestamp_granularities=["word"],
                )
            return AsrTranscription(
                text="Where you going?",
                model="whisper-1",
                words=[{"text": "Where you going", "start": 0.1, "end": 1.0}],
                timestamp_granularities=["word"],
            )

    class FakePracticeLlm:
        def evaluate(self, *, model, input_payload):
            return PracticeLlmEvaluation(
                result={
                    "schema_version": 1,
                    "overall_score": 80,
                    "overall_comment": "areが抜けています。",
                    "phrases": [
                        {
                            "phrase_index": 0,
                            "target_text": "Where are you going?",
                            "score": 80,
                            "comment": "areが抜けています。",
                            "reference": {
                                "status": "assigned",
                                "word_start_index": 0,
                                "word_end_index": 1,
                                "matched_text": "Where are you going",
                                "start": 0.1,
                                "end": 1.2,
                                "playback_start": 0.0,
                                "playback_end": 1.2,
                            },
                            "attempt": {
                                "status": "partial",
                                "word_start_index": 0,
                                "word_end_index": 1,
                                "matched_text": "Where you going",
                                "start": 0.1,
                                "end": 1.0,
                                "playback_start": 0.0,
                                "playback_end": 1.0,
                            },
                        }
                    ],
                },
                usage={"total_tokens": 90},
                estimated_cost_usd=None,
                elapsed_ms=8.0,
                log_path=tmp_path / "practice-llm.json",
            )

    asr = SequencedAsr()
    pipeline = SpeechTranslationPipeline(asr=asr, translator=FakeTranslationProvider({}), tts=FakeTtsProvider())
    client = TestClient(create_app(openai_pipeline=pipeline, practice_llm_service=FakePracticeLlm()))

    response = client.post(
        "/api/practice/attempt-jobs",
        data={"target_language": "en-US", "target_text": "Where are you going?"},
        files={
            "audio": ("attempt.webm", b"attempt audio", "audio/webm"),
            "model_audio": ("model.wav", b"model audio", "audio/wav"),
        },
    )

    assert response.status_code == 200
    snapshot = response.json()
    assert snapshot["status"] == "succeeded"
    assert snapshot["result"]["recognized_text"] == "Where you going?"
    assert snapshot["result"]["model_recognized_text"] == "Where are you going?"
    assert snapshot["result"]["model_comparison_alignment"]["complete"] is True
    assert asr.calls == [
        (b"model audio", "en-US", True),
        (b"attempt audio", "en-US", True),
    ]


def test_practice_attempt_job_returns_no_speech_for_llm_comparison_without_calling_llm() -> None:
    class NoSpeechAttemptAsr:
        name = "fake-whisper"

        def transcribe_detail(self, audio_path, source_language, *, include_timestamps):
            if audio_path.read_bytes() == b"model audio":
                return AsrTranscription(
                    text="Please close the window.",
                    model="whisper-1",
                    words=[{"text": "Please close the window", "start": 0.1, "end": 1.2}],
                    timestamp_granularities=["word"],
                )
            return AsrTranscription(
                text="",
                model="whisper-1",
                words=[],
                segments=[],
                timestamp_granularities=["word", "segment"],
            )

    class FakePracticeLlm:
        def __init__(self) -> None:
            self.calls: list[dict[str, object]] = []

        def evaluate(self, *, model, input_payload):
            self.calls.append({"model": model, "input": input_payload})
            raise AssertionError("LLM must not be called for a silent attempt recording")

    pipeline = SpeechTranslationPipeline(
        asr=NoSpeechAttemptAsr(),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    llm = FakePracticeLlm()
    client = TestClient(create_app(openai_pipeline=pipeline, practice_llm_service=llm))

    response = client.post(
        "/api/practice/attempt-jobs",
        data={
            "target_language": "en-US",
            "target_text": "Please close the window.",
            "comparison_model": "gpt-5.4-nano",
            "playback_padding_seconds": "0.1",
        },
        files={
            "audio": ("silent.wav", b"0.72 seconds of silence", "audio/wav"),
            "model_audio": ("model.wav", b"model audio", "audio/wav"),
        },
    )

    assert response.status_code == 200
    snapshot = response.json()
    assert snapshot["status"] == "succeeded"
    assert snapshot["result"]["outcome"] == "no_speech"
    assert snapshot["result"]["message"] == "音声を検出できませんでした。もう一度録音してください。"
    assert snapshot["result"]["comparison_alignment"] is None
    assert snapshot["result"]["model_comparison_alignment"] is None
    assert snapshot["result"]["comparison_model"] == "gpt-5.4-nano"
    assert llm.calls == []


def test_practice_attempt_job_reports_typed_alignment_error_in_job_mode() -> None:
    class EmptyReferenceAsr:
        name = "empty-reference-fake-asr"

        def transcribe_detail(self, audio_path, source_language, *, include_timestamps):
            if audio_path.read_bytes() == b"empty reference model audio":
                return AsrTranscription(text="", model="whisper-1", words=[], segments=[])
            return AsrTranscription(
                text="Please close the window.",
                model="whisper-1",
                words=[{"text": "Please close the window", "start": 0.1, "end": 1.2}],
                timestamp_granularities=["word"],
            )

    pipeline = SpeechTranslationPipeline(
        asr=EmptyReferenceAsr(),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(create_app(openai_pipeline=pipeline))

    submitted = client.post(
        "/api/practice/attempt-jobs",
        data={
            "target_language": "en-US",
            "target_text": "Please close the window.",
            "comparison_model": "gpt-5.4-nano",
            "progress_mode": "job",
        },
        files={
            "audio": ("attempt.webm", b"attempt audio for empty reference test", "audio/webm"),
            "model_audio": ("model.wav", b"empty reference model audio", "audio/wav"),
        },
    )
    job_id = submitted.json()["job_id"]

    completed = None
    for _ in range(500):
        completed = client.get(f"/api/practice/attempt-jobs/{job_id}").json()
        if completed["status"] == "failed":
            break
        sleep(0.02)

    assert completed["status"] == "failed"
    assert completed["error"]["code"] == "practice_alignment_provider_contract_error"
    assert completed["error"]["reason"] == "empty_reference_asr"


def test_practice_recording_api_rejects_attempt_intent() -> None:
    """/api/practice/recordings only creates prompts now; attempts go through
    /api/practice/attempt-jobs (which needs the model audio for comparison)."""
    client = TestClient(create_app(openai_pipeline=SpeechTranslationPipeline(
        asr=FakeAsrProvider({"auto": "unused"}),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )))

    response = client.post(
        "/api/practice/recordings",
        data={"recording_intent": "attempt", "target_language": "zh-CN", "current_target_text": "我想学习软体开发"},
        files={"audio": ("recording.webm", b"repeat audio", "audio/webm")},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "recording_intent must be prompt"


def test_practice_recording_api_uses_explicit_prompt_intent_even_when_target_exists() -> None:
    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"auto": "明日は天気がいいですか"}),
        translator=FakeTranslationProvider({("auto", "zh-CN", "明日は天気がいいですか"): "我想學習軟體開發。"}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(create_app(openai_pipeline=pipeline))

    response = client.post(
        "/api/practice/recordings",
        data={
            "recording_intent": "prompt",
            "target_language": "zh-CN",
            "current_target_text": "我想要咖啡。",
            "include_pinyin": "true",
        },
        files={"audio": ("recording.webm", b"new prompt audio", "audio/webm")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["recording_kind"] == "prompt"
    assert payload["transcript"] == "明日は天気がいいですか"
    assert payload["target_text"] == "我想学习软体开发。"
    assert payload["audio_base64"] == base64.b64encode("FAKE-WAV:zh-CN:我想学习软体开发。".encode()).decode()
    assert "classification" not in payload


def test_practice_recording_api_can_create_seed_vc_model_voice_job(monkeypatch) -> None:
    class PracticeSeedVcProvider(FakeVoiceConversionProvider):
        backend_id = "seed-vc"
        label = "Seed-VC"
        name = "fake-seed-vc"

        def __init__(self) -> None:
            super().__init__()
            self.source_audio_bytes = b""
            self.reference_audio_bytes = b""

        def convert(self, *, source_audio_path, reference_audio_path, seed_vc_settings=None, progress_callback=None):
            self.source_audio_bytes = source_audio_path.read_bytes()
            self.reference_audio_bytes = reference_audio_path.read_bytes()
            return super().convert(
                source_audio_path=source_audio_path,
                reference_audio_path=reference_audio_path,
                seed_vc_settings=seed_vc_settings,
                progress_callback=progress_callback,
            )

    provider = PracticeSeedVcProvider()
    monkeypatch.setattr(
        "mo_speech.api.RunpodServerlessVoiceConversionProvider",
        lambda: provider,
    )
    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"auto": "今日は何をしますか"}),
        translator=FakeTranslationProvider({("auto", "en-US", "今日は何をしますか"): "What are you doing today?"}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(
        create_app(
            openai_pipeline=pipeline,
        )
    )

    response = client.post(
        "/api/practice/recordings",
        data={"recording_intent": "prompt", "target_language": "en-US", "use_own_voice": "true"},
        files={"audio": ("recording.webm", b"my reference voice", "audio/webm")},
    )

    assert response.status_code == 200
    payload = response.json()
    job = payload["voice_conversion_job"]
    assert job["status"] in {"queued", "running", "succeeded"}
    assert job["job_id"]

    for _ in range(20):
        snapshot = client.get(f"/api/practice/voice-jobs/{job['job_id']}").json()
        if snapshot["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("practice voice conversion job did not finish")

    assert snapshot["result"]["audio_base64"] == base64.b64encode(b"fake converted wav").decode("ascii")
    assert provider.source_audio_bytes == b"FAKE-WAV:en-US:What are you doing today?"
    assert provider.reference_audio_bytes == b"my reference voice"
    assert provider.last_seed_vc_settings is not None
    assert provider.last_seed_vc_settings.reference_auto_select is True


def test_practice_recording_api_requires_explicit_recording_intent() -> None:
    client = TestClient(create_app(openai_pipeline=SpeechTranslationPipeline(
        asr=FakeAsrProvider({"auto": "unused"}),
        translator=FakeTranslationProvider({}),
        tts=FakeTtsProvider(),
    )))

    response = client.post(
        "/api/practice/recordings",
        data={"target_language": "zh-CN"},
        files={"audio": ("recording.webm", b"audio", "audio/webm")},
    )

    assert response.status_code == 422


def test_practice_recording_api_saves_generated_prompt_audio_to_practice_history(tmp_path) -> None:
    from mo_speech.audio_history import AudioHistoryStore

    history_store = AudioHistoryStore(root=tmp_path / "history", limit=10, enabled=True)
    pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"auto": "明日は天気がいいですか"}),
        translator=FakeTranslationProvider({("auto", "zh-CN", "明日は天気がいいですか"): "明天天气好吗？"}),
        tts=FakeTtsProvider(),
    )
    client = TestClient(create_app(openai_pipeline=pipeline, audio_history_store=history_store))

    response = client.post(
        "/api/practice/recordings",
        data={"recording_intent": "prompt", "target_language": "zh-CN"},
        files={"audio": ("recording.webm", b"new prompt audio", "audio/webm")},
    )
    history = client.get("/api/practice-history").json()

    assert response.status_code == 200
    assert len(history["outputs"]) == 1
    assert history["outputs"][0]["metadata"]["endpoint"] == "practice-prompts"
    assert history["outputs"][0]["metadata"]["tts_text"] == "明天天气好吗？"


def test_audio_history_excludes_practice_entries_and_practice_history_lists_them(tmp_path) -> None:
    from mo_speech.audio_history import AudioHistoryStore

    history_store = AudioHistoryStore(root=tmp_path / "history", limit=10, enabled=True)
    history_store.save_recording(
        b"practice input",
        suffix=".wav",
        metadata={"endpoint": "practice-prompts", "target_language": "zh-CN"},
    )
    history_store.save_output(
        b"normal output",
        suffix=".wav",
        metadata={"endpoint": "translate-speech", "target_language": "ja-JP", "text_preview": "通常履歴"},
    )
    client = TestClient(create_app(audio_history_store=history_store))

    normal_history = client.get("/api/audio-history").json()
    practice_history = client.get("/api/practice-history").json()

    assert len(normal_history["recordings"]) == 0
    assert len(normal_history["outputs"]) == 1
    assert normal_history["outputs"][0]["metadata"]["endpoint"] == "translate-speech"
    assert len(practice_history["recordings"]) == 1
    assert practice_history["recordings"][0]["metadata"]["endpoint"] == "practice-prompts"
    assert len(practice_history["outputs"]) == 0


def test_admin_serves_browser_ui() -> None:
    client = TestClient(create_app())

    response = client.get("/admin")

    assert response.status_code == 200
    assert "音声翻訳" in response.text
    assert "source_language" in response.text
    assert "operation_mode" in response.text
    assert "translation_backend" in response.text
    assert "text_tts" in response.text
    assert "tts_text" in response.text
    assert "tts_backend" in response.text
    assert "voice_processing" in response.text
    assert "voice_backend" in response.text
    assert "reference_audio" in response.text
    assert "seed-vc-settings" in response.text
    assert "seed_vc_preset" in response.text
    assert "品質優先" in response.text
    assert "最高品質検証" in response.text
    assert "seed_vc_diffusion_steps" in response.text
    assert "seed_vc_reference_max_seconds" in response.text
    assert "seed_vc_reference_auto_select" in response.text
    assert "seed-vc-reference-preview-button" in response.text
    assert "reference-preview-section" in response.text
    assert "reference-preview-original" in response.text
    assert "reference-preview-normalized" in response.text
    assert "seed_vc_length_adjust" in response.text
    assert "seed_vc_inference_cfg_rate" in response.text
    assert "translation-only" in response.text
    assert "user_target_language" not in response.text
    assert "入力が日本語ならインドネシア語、それ以外なら日本語へ自動切替します。" in response.text
    assert "audio-label" in response.text
    assert "audio-selection-status" in response.text
    assert "source-audio-hint" in response.text
    assert "reference-audio-selection-status" in response.text
    assert "text-result-section" in response.text
    assert "output-audio-heading" in response.text
    assert "route-hint" in response.text
    assert "runtime-mode" not in response.text
    assert "runtime-note" not in response.text
    assert "mode</span>" not in response.text
    assert "input-audio" in response.text
    assert "audio_device" in response.text
    assert "audio-device-refresh" in response.text
    assert "input-level" in response.text
    assert "recording-details" in response.text
    assert "voice-mode-hint" in response.text
    assert "音声翻訳（Qwen/local）" in response.text
    assert "音声翻訳（OpenAI API）" in response.text
    assert "音声翻訳（OpenAI Realtime）" in response.text
    assert "音声翻訳（OpenAI Realtime streaming）" in response.text
    assert "音声翻訳（RunPod Serverless）" in response.text
    assert "runpod-warmup-button" in response.text
    assert "runpod-warmup-status" in response.text
    assert "RunPod手動準備" in response.text
    assert response.text.index("runpod-warmup-panel") < response.text.index("operation_mode")
    assert response.text.index('value="openai"') < response.text.index('value="qwen"')
    assert "realtime-streaming-panel" in response.text
    assert "接続開始後に話す" in response.text
    assert "Google Translate TTS endpoint" in response.text
    assert "OpenAI TTS API" in response.text
    assert "tts_text_file" in response.text
    assert "テキストファイル" in response.text
    assert "history-recordings" in response.text
    assert "history-outputs" in response.text
    assert "history-storage" in response.text
    assert "user-settings-panel" in response.text
    assert "user_joke_text" in response.text
    assert "user_joke_selection" in response.text
    assert "user_joke_variation_count" in response.text
    assert "user_joke_variants_preview" in response.text
    assert "user_joke_pool_preview" in response.text
    assert "user_effect_audio_files" in response.text
    assert "user_effect_audio_preview" in response.text
    assert "user_effect_selection" in response.text
    assert "user_effect_insert_mode" in response.text
    assert "user_effect_max_insertions" in response.text
    assert "user_effect_min_silence_ms" in response.text
    assert "生成済みバリエーション" in response.text
    assert "実際に使うジョーク候補" in response.text
    assert "効果音ファイル" in response.text
    assert "user_theme" in response.text
    assert "ローテーション" in response.text
    assert "ランダム" in response.text
    assert "青" in response.text
    assert "ポップ" in response.text
    assert "ミント" in response.text
    assert "user-settings-save" in response.text
    assert "use-output-as-input" in response.text
    assert "use-output-as-reference" in response.text
    assert "text-result-action" in response.text
    assert "Seed-VCで入力音声に寄せる" in response.text
    assert "既定音声" not in response.text
    assert "processing-panel" in response.text
    assert "processing-steps" in response.text
    assert "error-message" in response.text
    assert "末尾付加" in response.text
    assert "VC比較" in response.text
    assert response.text.index("/static/app_dom.js") < response.text.index("/static/app_config.js")
    assert response.text.index("/static/app_config.js") < response.text.index("/static/app_state.js")
    assert response.text.index("/static/app_state.js") < response.text.index("/static/app_audio.js")
    assert response.text.index("/static/app_audio.js") < response.text.index("/static/app_realtime.js")
    assert response.text.index("/static/app_realtime.js") < response.text.index("/static/app_history.js")
    assert response.text.index("/static/app_history.js") < response.text.index("/static/app_seed_vc.js")
    assert response.text.index("/static/app_seed_vc.js") < response.text.index("/static/app.js")
    assert response.text.index("/static/app.js") < response.text.index("/static/app_admin_settings.js")
    assert "/static/app.js" in response.text
    assert "/static/app_admin_settings.js" in response.text


def test_static_assets_are_served() -> None:
    client = TestClient(create_app())

    js_asset_names = [
        "app_dom.js",
        "app_config.js",
        "app_state.js",
        "app_audio.js",
        "app_realtime.js",
        "app_history.js",
        "app_seed_vc.js",
        "app.js",
        "app_admin_settings.js",
        "app_user.js",
        "app_practice.js",
    ]
    js_responses = [client.get(f"/static/{name}") for name in js_asset_names]
    js_text = "\n".join(response.text for response in js_responses)
    css_response = client.get("/static/styles.css")

    assert all(response.status_code == 200 for response in js_responses)
    assert "submitTranslation" in js_text
    assert "append_suffix" in js_text
    assert "loadRuntime" in js_text
    assert "translationBackendSelect" in js_text
    assert "submitTextToSpeech" in js_text
    assert "handleTtsTextFileChange" in js_text
    assert "ttsTextFileInput" in js_text
    assert "deleteHistoryAudio" in js_text
    assert "history-delete-button" in js_text
    assert "loadAudioHistory" in js_text
    assert "useHistoryAudioAsInput" in js_text
    assert "useHistoryAudioAsReference" in js_text
    assert "useHistoryTextForTts" in js_text
    assert "useTextResultForTts" in js_text
    assert "ensureTtsLanguage" in js_text
    assert "renderAudioHistorySettings" in js_text
    assert "history-title" in js_text
    assert "history-text" in js_text
    assert "playable_hint" in js_text
    assert "requestData()" not in js_text
    assert "openAiTargetLanguages" in js_text
    assert "isRealtimeTranslationBackend" in js_text
    assert "isRealtimeStreamingTranslationBackend" in js_text
    assert "startRealtimeStreaming" in js_text
    assert "stopRealtimeStreaming" in js_text
    assert "saveRealtimeStreamingOutput" in js_text
    assert "startRealtimeOutputRecording" in js_text
    assert "openai-realtime-translation-session" in js_text
    assert "syncTtsBackendAvailability" in js_text
    assert "voiceProcessingSelect" in js_text
    assert "submitCurrentOperation" in js_text
    assert "submitVoiceConversion" in js_text
    assert "pollVoiceConversionJob" in js_text
    assert "syncOperationMode" in js_text
    assert "syncVoiceBackendAvailability" in js_text
    assert "syncSeedVcSettingsVisibility" in js_text
    assert "appendSeedVcSettings" in js_text
    assert "seed_vc_reference_auto_select" in js_text
    assert "previewSeedVcReferenceAudio" in js_text
    assert "seed-vc/reference-preview" in js_text
    assert "参照音声の確認APIに接続できませんでした" in js_text
    assert "renderSeedVcReferencePreview" in js_text
    assert "seedVcPresets" in js_text
    assert "applySeedVcPreset" in js_text
    assert "syncSeedVcPresetSelection" in js_text
    assert "selectedVoiceBackend" in js_text
    assert "translationOnlyElements" in js_text
    assert "textResultSection" in js_text
    assert "変換元音声ファイル" in js_text
    assert "VC出力音声" in js_text
    assert "renderOutputAudioBlob" in js_text
    assert "outputAudio.play()" in js_text
    assert "submitUserTranslation" in js_text
    assert "loadUserDisplayText" in js_text
    assert "refreshUserSettings" in js_text
    assert "selectedUserTranslationBackend" in js_text
    assert "syncUserWarmupStatus" in js_text
    assert "displayModeButton" in js_text
    assert "toggleUserReplay" in js_text
    assert "reprocessLatestUserOutput" in js_text
    assert "markUserOutputStale" in js_text
    assert "syncJapaneseTextEffectAvailability" in js_text
    assert "applyUserTheme" in js_text
    assert "cancelUserRecordingForNavigation" in js_text
    assert "beforeunload" in js_text
    assert "runUserTextOutput" in js_text
    assert "runUserVoiceConversion" in js_text
    assert "applyUserVoiceModeToBase" in js_text
    assert "syncSimilarVoiceAvailability" in js_text
    assert "userStatus.hidden" in js_text
    assert "translationResultCache" in js_text
    assert "baseResultCache" in js_text
    assert "voiceResultCache" in js_text
    assert "displayTextCache" in js_text
    assert "jokeAudioCache" in js_text
    assert "userJokePool" in js_text
    assert "selectUserJokeText" in js_text
    assert "currentUserJokeSettingsSignature" in js_text
    assert "joke_variants" in js_text
    assert "joke_selection" in js_text
    assert "convertUserJokeAudioBlob" in js_text
    assert "localStorage" in js_text
    assert "startProcessingLabelAnimation" in js_text
    assert "buildProcessingLabelHtml" in js_text
    assert "processing-dot" in js_text
    assert "processing-dots" in js_text
    assert "user-text-output" in js_text
    assert "user-joke-output" in js_text
    assert "user-auto" in js_text
    assert "id-ID" in js_text
    assert "voice-conversion-jobs" in js_text
    assert "cycleUserTextMode" in js_text
    assert '["hiragana", "ruby", "indonesian"]' in js_text
    assert "indonesian_text" in js_text
    assert "🇯🇵 ひらがな" in js_text
    assert "🇯🇵 ルビ" in js_text
    assert "🇮🇩 Indonesia" in js_text
    assert "setUserProcessingProgress" in js_text
    assert "processingProgressCeiling" in js_text
    assert "baseJobCompleteProgressPercent" in js_text
    assert "userVoiceConversionEnabled() ? 70 : 100" in js_text
    assert "setUserProcessingProgress(82, { ceiling: 90 })" in js_text
    assert "renderUserOutputRubyText" in js_text
    assert "output-ruby-stack" in js_text
    assert "しょりちゅう" in js_text
    assert "seed_vc_reference_auto_select" in js_text
    assert "user-settings" in js_text
    assert "user_theme" in js_text
    assert "user_joke_selection" in js_text
    assert "user_joke_variation_count" in js_text
    assert "splitAdminJokeTexts" in js_text
    assert "renderAdminJokePreview" in js_text
    assert "settings.joke_variants" in js_text
    assert "settings.joke_pool" in js_text
    assert "renderInputAudioPreview" in js_text
    assert "setInputAudioSelectionStatus" in js_text
    assert "setReferenceAudioSelectionStatus" in js_text
    assert "履歴から入力" in js_text
    assert "履歴からVC参照" in js_text
    assert "loadAudioDevices" in js_text
    assert "selectedAudioConstraint" in js_text
    assert "joke_text: hasJoke" not in js_text
    assert "chooseRecorderOptions" in js_text
    assert "startInputLevelMeter" in js_text
    assert "syncTranslationBackendAvailability" in js_text
    assert "syncVoiceProcessingAvailability" in js_text
    assert "pollTranslationJob" in js_text
    assert "renderProcessingJob" in js_text
    assert "renderPartialResult" in js_text
    assert "syncTargetOptions" in js_text
    assert "renderError" in js_text
    assert css_response.status_code == 200
    assert ".status" in css_response.text
    assert ".runtime-panel" not in css_response.text
    assert ".processing-panel" in css_response.text
    assert ".history-panel" in css_response.text
    assert ".user-stage" in css_response.text
    assert '[data-theme="blue"]' in css_response.text
    assert '[data-theme="pop"]' in css_response.text
    assert '[data-theme="mint"]' in css_response.text
    assert ".display-mode-button" in css_response.text
    assert ".record-orb" in css_response.text
    assert ".record-progress" in css_response.text
    assert ".user-processing-panel" in css_response.text
    assert ".user-processing-fill" in css_response.text
    assert ".processing-dots" in css_response.text
    assert ".processing-dot" in css_response.text
    assert "progress-sheen" in css_response.text
    assert ".replay-button" in css_response.text
    assert ".user-output-texts" in css_response.text
    assert ".user-output-text" in css_response.text
    assert ".ruby-line" in css_response.text
    assert ".output-ruby-stack" in css_response.text
    assert ".output-ruby-reading" in css_response.text
    assert "overflow-x: hidden" in css_response.text
    assert ".toggle-tile" in css_response.text
    assert ".toggle-tile.is-disabled" in css_response.text
    assert ".toggle-icon" in css_response.text
    assert ".toggle-tile::after" not in css_response.text
    assert ".toggle-tile:not(.is-disabled):hover" in css_response.text
    assert ".toggle-tile:not(.is-disabled):active" in css_response.text
    assert "inset 0 5px 12px" in css_response.text
    assert "translateY(2px) scale(0.96)" in css_response.text
    assert ".joke-preview-title" in css_response.text
    assert ".joke-preview-list" in css_response.text
    assert ".history-title" in css_response.text
    assert ".history-text" in css_response.text
    assert ".history-warning" in css_response.text
    assert ".history-storage" in css_response.text
    assert ".history-actions" in css_response.text
    assert ".history-delete-button" in css_response.text
    assert ".result-actions" in css_response.text
    assert ".error-message" in css_response.text


def test_runtime_api_returns_active_mode_and_provider_names(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    client = TestClient(create_app(voice_conversion_service=_fake_voice_conversion_service()))

    response = client.get("/api/runtime")

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider_mode"] == "fake"
    assert payload["providers"] == {"asr": "fake-asr", "translation": "fake-translation", "tts": "fake-tts"}
    assert payload["supported_voice_modes"] == ["default"]
    assert [backend["id"] for backend in payload["translation_backends"]] == [
        "openai",
        "openai_realtime",
        "openai_realtime_stream",
        "qwen",
        "runpod_serverless",
    ]
    assert payload["translation_backends"][0]["available"] is False
    assert payload["translation_backends"][0]["settings"]["supported_target_languages"][:4] == [
        "id-ID",
        "ja-JP",
        "zh-CN",
        "en-US",
    ]
    assert "fr" in payload["translation_backends"][0]["settings"]["supported_target_languages"]
    assert "uk" in payload["translation_backends"][1]["settings"]["supported_target_languages"]
    assert "vi" in payload["translation_backends"][2]["settings"]["supported_target_languages"]
    assert payload["translation_backends"][1]["available"] is False
    assert payload["translation_backends"][2]["available"] is False
    assert payload["translation_backends"][3]["settings"]["supported_routes"] == [
        {"source_language": "id-ID", "target_language": "ja-JP"},
        {"source_language": "ja-JP", "target_language": "zh-CN"},
    ]
    assert payload["translation_backends"][4]["available"] is False
    assert "RUNPOD_ENDPOINT_ID" in payload["translation_backends"][4]["reason"]
    assert [backend["id"] for backend in payload["text_tts_backends"]] == ["google_translate", "openai"]
    assert payload["text_tts_backends"][1]["settings"]["supported_target_languages"][0] == "auto"
    assert "fr" in payload["text_tts_backends"][1]["settings"]["supported_target_languages"]
    assert payload["voice_conversion_backends"] == [
        {
            "id": "fake-vc",
            "label": "Fake VC",
            "provider": "fake-vc-provider",
            "available": True,
            "reason": "",
            "settings": {},
        }
    ]


def test_user_settings_api_defaults_to_japanese(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MO_USER_SETTINGS_PATH", str(tmp_path / "user-settings.json"))
    client = TestClient(create_app())

    response = client.get("/api/user-settings")

    assert response.status_code == 200
    assert response.json() == {
        "target_language": "ja-JP",
        "joke_text": "",
        "joke_texts": [],
        "joke_position": "after",
        "joke_selection": "rotation",
        "joke_variation_count": 0,
        "joke_variants": [],
        "joke_pool": [],
        "effect_audios": [],
        "effect_selection": "rotation",
        "effect_insert_mode": "silence_or_tail",
        "effect_max_insertions": 1,
        "effect_min_silence_ms": 300,
        "theme": "blue",
    }


def test_user_settings_api_persists_admin_settings(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MO_USER_SETTINGS_PATH", str(tmp_path / "user-settings.json"))
    client = TestClient(create_app())

    response = client.put(
        "/api/user-settings",
        json={
            "target_language": "ja-JP",
            "joke_texts": ["きょうも がんばってください。", "いいこえです。"],
            "joke_position": "before",
            "joke_selection": "random",
            "joke_variation_count": 0,
            "effect_audios": [
                {
                    "id": "cow",
                    "name": "cow.wav",
                    "audio_mime_type": "audio/wav",
                    "audio_base64": "UklGRg==",
                }
            ],
            "effect_selection": "random",
            "effect_insert_mode": "tail",
            "effect_max_insertions": 2,
            "effect_min_silence_ms": 450,
            "theme": "pop",
        },
    )

    assert response.status_code == 200
    assert response.json()["joke_position"] == "before"
    assert response.json()["joke_selection"] == "random"
    assert response.json()["effect_audios"][0]["id"] == "cow"
    assert response.json()["effect_selection"] == "random"
    assert response.json()["effect_insert_mode"] == "tail"
    assert response.json()["effect_max_insertions"] == 2
    assert response.json()["effect_min_silence_ms"] == 450
    assert response.json()["theme"] == "pop"
    assert client.get("/api/user-settings").json()["joke_text"] == "きょうも がんばってください。\nいいこえです。"
    assert client.get("/api/user-settings").json()["joke_pool"] == [
        "きょうも がんばってください。",
        "いいこえです。",
    ]
    assert client.get("/api/user-settings").json()["theme"] == "pop"


def test_user_settings_api_generates_joke_variations_on_admin_save(tmp_path, monkeypatch) -> None:
    captured: dict[str, object] = {}

    class Responses:
        @staticmethod
        def create(**kwargs):
            captured.update(kwargs)
            return SimpleNamespace(output_text='{"variants":[["A1","A2"],["B1","B2"]]}')

    monkeypatch.setenv("MO_USER_SETTINGS_PATH", str(tmp_path / "user-settings.json"))
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=lambda: SimpleNamespace(responses=Responses())))
    client = TestClient(create_app())

    response = client.put(
        "/api/user-settings",
        json={
            "target_language": "ja-JP",
            "joke_texts": ["A", "B"],
            "joke_position": "after",
            "joke_selection": "rotation",
            "joke_variation_count": 2,
            "theme": "blue",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["joke_variants"] == ["A1", "B1", "A2", "B2"]
    assert payload["joke_pool"] == ["A", "B", "A1", "B1", "A2", "B2"]
    assert "variants_per_joke" in captured["input"]
    assert '"variants_per_joke": 2' in captured["input"]
    assert client.get("/api/user-settings").json()["joke_pool"] == ["A", "B", "A1", "B1", "A2", "B2"]


def test_user_settings_api_rejects_unknown_joke_selection(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MO_USER_SETTINGS_PATH", str(tmp_path / "user-settings.json"))
    client = TestClient(create_app())

    response = client.put(
        "/api/user-settings",
        json={"target_language": "ja-JP", "joke_position": "after", "joke_selection": "shuffle", "theme": "blue"},
    )

    assert response.status_code == 400
    assert "unsupported joke_selection" in response.json()["detail"]


def test_user_settings_api_rejects_unknown_theme(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MO_USER_SETTINGS_PATH", str(tmp_path / "user-settings.json"))
    client = TestClient(create_app())

    response = client.put(
        "/api/user-settings",
        json={"target_language": "ja-JP", "joke_position": "after", "theme": "sepia"},
    )

    assert response.status_code == 400
    assert "unsupported theme" in response.json()["detail"]


def test_user_display_text_api_returns_hiragana_with_openai(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class Responses:
        @staticmethod
        def create(**kwargs):
            captured.update(kwargs)
            return SimpleNamespace(output_text="きゅうりょうを あげてください。")

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=lambda: SimpleNamespace(responses=Responses())))
    client = TestClient(create_app())

    response = client.post(
        "/api/user-display-text",
        json={"text": "給料を上げてください。", "target_language": "ja-JP"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "kanji_text": "給料を上げてください。",
        "hiragana_text": "きゅうりょうを あげてください。",
        "indonesian_text": "",
    }
    assert "hiragana only" in captured["instructions"]
    assert captured["input"] == "給料を上げてください。"


def test_user_display_text_api_uses_indonesian_output_as_indonesian_text() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/api/user-display-text",
        json={"text": "Terima kasih.", "target_language": "id-ID"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "kanji_text": "Terima kasih.",
        "hiragana_text": "",
        "indonesian_text": "Terima kasih.",
    }


def test_user_text_output_api_reuses_translated_text_for_tts(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class Speech:
        @staticmethod
        def create(**kwargs):
            captured.update(kwargs)
            return SimpleNamespace(content=b"wav")

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setitem(
        sys.modules,
        "openai",
        SimpleNamespace(OpenAI=lambda: SimpleNamespace(audio=SimpleNamespace(speech=Speech()))),
    )
    client = TestClient(create_app())

    response = client.post(
        "/api/user-text-output",
        json={
            "transcript": "I want a raise.",
            "translated_text": "給料を上げてください。",
            "target_language": "ja-JP",
            "text_transform_options": {"joke_text": "お願いします。", "joke_position": "after"},
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["transcript"] == "I want a raise."
    assert payload["translated_text"] == "給料を上げてください。"
    assert payload["transformed_text"] == "給料を上げてください。 お願いします。"
    assert payload["target_language"] == "ja-JP"
    assert payload["audio_base64"] != ""
    assert payload["providers"]["asr"] == "cached"
    assert payload["providers"]["translation"] == "cached"
    assert captured["input"] == "給料を上げてください。 お願いします。"


def test_user_joke_output_api_translates_to_indonesian_then_tts() -> None:
    captured: dict[str, object] = {}

    class FakeTranslator:
        name = "fake-openai-translation"

        def translate(self, text, source_language, target_language):
            captured["translation"] = {
                "text": text,
                "source_language": source_language,
                "target_language": target_language,
            }
            return "Ini lelucon singkat."

    class FakeTts:
        name = "fake-openai-tts"
        audio_mime_type = "audio/wav"

        def synthesize(self, text, target_language):
            captured["tts"] = {"text": text, "target_language": target_language}
            return TtsOutput(audio_bytes=f"TTS:{target_language}:{text}".encode(), audio_mime_type="audio/wav")

    openai_pipeline = SimpleNamespace(translator=FakeTranslator(), tts=FakeTts())
    client = TestClient(create_app(openai_pipeline=openai_pipeline))  # type: ignore[arg-type]

    response = client.post(
        "/api/user-joke-output",
        json={"text": "まずはジョークです。", "target_language": "id-ID", "tts_backend": "openai"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["transcript"] == "まずはジョークです。"
    assert payload["translated_text"] == "Ini lelucon singkat."
    assert payload["target_language"] == "id-ID"
    assert base64.b64decode(payload["audio_base64"]) == b"TTS:id-ID:Ini lelucon singkat."
    assert captured["translation"] == {
        "text": "まずはジョークです。",
        "source_language": "auto",
        "target_language": "id-ID",
    }
    assert captured["tts"] == {"text": "Ini lelucon singkat.", "target_language": "id-ID"}


def test_runtime_api_returns_supported_voice_modes_from_tts_provider() -> None:
    class CustomPipeline:
        asr = SimpleNamespace(name="custom-asr")
        translator = SimpleNamespace(name="custom-translation")
        tts = SimpleNamespace(name="custom-tts", supported_voice_modes=("convert", "clone", "convert"))

    client = TestClient(
        create_app(pipeline=CustomPipeline(), voice_conversion_service=_fake_voice_conversion_service())
    )  # type: ignore[arg-type]

    response = client.get("/api/runtime")

    assert response.status_code == 200
    assert response.json()["supported_voice_modes"] == ["convert", "clone"]


def test_runtime_api_marks_unavailable_voice_conversion_backend() -> None:
    client = TestClient(create_app(voice_conversion_service=_fake_voice_conversion_service(available=False)))

    response = client.get("/api/runtime")

    assert response.status_code == 200
    assert response.json()["voice_conversion_backends"] == [
        {
            "id": "fake-vc",
            "label": "Fake VC",
            "provider": "fake-vc-provider",
            "available": False,
            "reason": "not installed",
            "settings": {},
        }
    ]


def test_create_app_preloads_pipeline_when_enabled(monkeypatch) -> None:
    class PreloadPipeline:
        preloaded = False

        def preload(self) -> None:
            self.preloaded = True

    pipeline = PreloadPipeline()
    monkeypatch.setenv("MO_PRELOAD_MODELS", "1")

    create_app(pipeline=pipeline)  # type: ignore[arg-type]

    assert pipeline.preloaded is True


def test_translate_speech_api_accepts_audio_upload() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/api/translate-speech",
        data={
            "translation_backend": "qwen",
            "source_language": "id-ID",
            "target_language": "ja-JP",
            "text_transform": "append_suffix",
            "text_transform_suffix": "モー",
            "text_transform_unit": "sentence",
        },
        files={"audio": ("sample.wav", b"fake audio", "audio/wav")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["transcript"] == "Selamat pagi. Terima kasih."
    assert payload["translated_text"] == "おはようございます。ありがとうございます。"
    assert payload["transformed_text"] == "おはようございますモー。ありがとうございますモー。"
    assert payload["providers"] == {"asr": "fake-asr", "translation": "fake-translation", "tts": "fake-tts"}
    assert payload["audio_mime_type"] == "audio/wav"
    assert payload["audio_base64"] != ""


def test_translate_speech_api_saves_local_audio_history_as_wav(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MO_AUDIO_HISTORY_ENABLED", "1")
    monkeypatch.setenv("MO_AUDIO_HISTORY_DIR", str(tmp_path / "history"))
    monkeypatch.setenv("MO_AUDIO_HISTORY_LIMIT", "10")
    monkeypatch.setattr(
        "mo_speech.api_audio_history.prepare_audio_history_wav",
        lambda audio_bytes, suffix: (
            b"normalized recording wav",
            ".wav",
            {
                "audio_mime_type": "audio/wav",
                "history_audio_format": "wav_24000_mono_pcm16",
                "original_audio_suffix": suffix,
            },
        ),
    )
    client = TestClient(create_app())

    response = client.post(
        "/api/translate-speech",
        data={"translation_backend": "qwen", "source_language": "ja-JP", "target_language": "zh-CN", "voice_mode": "default"},
        files={"audio": ("recording.webm", b"fake audio", "audio/webm;codecs=opus")},
    )

    assert response.status_code == 200
    recordings = list((tmp_path / "history" / "recordings").glob("*.wav"))
    assert len(recordings) == 1
    assert recordings[0].read_bytes() == b"normalized recording wav"
    assert len(list((tmp_path / "history" / "recordings").glob("*.webm"))) == 0
    assert len(list((tmp_path / "history" / "outputs").glob("*.wav"))) == 1
    history = client.get("/api/audio-history").json()
    assert history["outputs"][0]["text_preview"] == "谢谢。"
    assert history["outputs"][0]["tts_text"] == "谢谢。"
    assert history["outputs"][0]["metadata"]["tts_text"] == "谢谢。"
    assert history["outputs"][0]["metadata"]["transcript_preview"] == "ありがとう。"
    assert history["outputs"][0]["label"] == "谢谢。"
    assert history["recordings"][0]["text_preview"] == "ありがとう。"
    assert history["recordings"][0]["label"] == "ありがとう。"
    assert history["recordings"][0]["filename"].endswith(".wav")
    assert history["recordings"][0]["media_type"] == "audio/wav"
    assert history["recordings"][0]["metadata"]["filename"] == "recording.webm"
    assert history["recordings"][0]["metadata"]["original_content_type"] == "audio/webm;codecs=opus"
    assert history["recordings"][0]["metadata"]["original_audio_suffix"] == ".webm"


def test_translate_speech_job_reusing_history_input_does_not_duplicate_recording(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MO_AUDIO_HISTORY_ENABLED", "1")
    monkeypatch.setenv("MO_AUDIO_HISTORY_DIR", str(tmp_path / "history"))
    monkeypatch.setenv("MO_AUDIO_HISTORY_LIMIT", "10")
    monkeypatch.setattr(
        "mo_speech.api_audio_history.prepare_audio_history_wav",
        lambda audio_bytes, suffix: (b"normalized wav", ".wav", {"audio_mime_type": "audio/wav"}),
    )
    client = TestClient(create_app())

    first_response = client.post(
        "/api/translate-speech-jobs",
        data={"translation_backend": "qwen", "source_language": "ja-JP", "target_language": "zh-CN", "voice_mode": "default"},
        files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
    )
    assert first_response.status_code == 200
    first_job_id = first_response.json()["job_id"]
    for _ in range(20):
        first_status = client.get(f"/api/translate-speech-jobs/{first_job_id}").json()
        if first_status["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("initial translation job did not finish")

    initial_history = client.get("/api/audio-history").json()
    reused_filename = initial_history["recordings"][0]["filename"]

    second_response = client.post(
        "/api/translate-speech-jobs",
        data={
            "translation_backend": "qwen",
            "source_language": "ja-JP",
            "target_language": "zh-CN",
            "voice_mode": "default",
            "input_history_kind": "recordings",
            "input_history_filename": reused_filename,
        },
        files={"audio": ("recording.webm", b"fake audio", "audio/webm")},
    )
    assert second_response.status_code == 200
    second_job_id = second_response.json()["job_id"]
    for _ in range(20):
        second_status = client.get(f"/api/translate-speech-jobs/{second_job_id}").json()
        if second_status["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("reused history translation job did not finish")

    history = client.get("/api/audio-history").json()
    assert [entry["filename"] for entry in history["recordings"]] == [reused_filename]


def test_translate_speech_api_accepts_seed_vc_settings_for_convert_mode() -> None:
    captured_request = None

    class CapturingPipeline:
        def run(self, request, progress_callback=None) -> PipelineResult:
            nonlocal captured_request
            captured_request = request
            return PipelineResult(
                transcript="こんにちは。",
                translated_text="你好。",
                transformed_text="你好。",
                output_audio_bytes=b"wav",
                output_audio_mime_type="audio/wav",
                timings_ms={"total": 1.0},
                providers={"asr": "capture-asr", "translation": "capture-translation", "tts": "capture-tts"},
            )

    client = TestClient(create_app(pipeline=CapturingPipeline()))  # type: ignore[arg-type]

    response = client.post(
        "/api/translate-speech",
        data={
            "translation_backend": "qwen",
            "source_language": "ja-JP",
            "target_language": "zh-CN",
            "voice_mode": "convert",
            "seed_vc_diffusion_steps": "6",
            "seed_vc_length_adjust": "0.95",
            "seed_vc_inference_cfg_rate": "0.6",
            "seed_vc_reference_max_seconds": "5",
            "seed_vc_reference_auto_select": "true",
        },
        files={"audio": ("sample.wav", b"fake audio", "audio/wav")},
    )

    assert response.status_code == 200
    assert captured_request is not None
    settings = captured_request.voice_settings["seed_vc"]
    assert settings.diffusion_steps == 6
    assert settings.length_adjust == 0.95
    assert settings.inference_cfg_rate == 0.6
    assert settings.reference_max_seconds == 5.0
    assert settings.reference_auto_select is True


def test_translate_speech_job_api_reports_progress_and_result() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/api/translate-speech-jobs",
        data={
            "translation_backend": "qwen",
            "source_language": "id-ID",
            "target_language": "ja-JP",
            "text_transform": "append_suffix",
            "text_transform_suffix": "モー",
            "text_transform_unit": "sentence",
        },
        files={"audio": ("sample.wav", b"fake audio", "audio/wav")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] in {"queued", "running", "succeeded"}
    assert payload["stages"] == [
        {"stage": "asr", "label": "文字起こし", "provider": "fake-asr"},
        {"stage": "translation", "label": "翻訳", "provider": "fake-translation"},
        {"stage": "text_transform", "label": "テキスト加工", "provider": "append_suffix"},
        {"stage": "tts", "label": "音声生成", "provider": "fake-tts"},
    ]

    job_id = payload["job_id"]
    for _ in range(20):
        status_response = client.get(f"/api/translate-speech-jobs/{job_id}")
        assert status_response.status_code == 200
        status_payload = status_response.json()
        if status_payload["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("translation job did not finish")

    assert status_payload["result"]["transcript"] == "Selamat pagi. Terima kasih."
    assert status_payload["result"]["transformed_text"] == "おはようございますモー。ありがとうございますモー。"
    assert status_payload["result"]["audio_base64"] != ""
    assert status_payload["partial_result"] == {
        "transcript": "Selamat pagi. Terima kasih.",
        "translated_text": "おはようございます。ありがとうございます。",
        "transformed_text": "おはようございますモー。ありがとうございますモー。",
    }


def test_translate_speech_job_api_runs_openai_backend() -> None:
    class FakeOpenAiPipeline:
        asr = SimpleNamespace(name="fake-openai-asr")
        translator = SimpleNamespace(name="fake-openai-translation")
        tts = SimpleNamespace(name="fake-openai-tts", supported_voice_modes=("default", "convert"))

        def run(self, request, progress_callback=None) -> PipelineResult:
            if progress_callback is not None:
                progress_callback(PipelineProgress("asr", "文字起こし", self.asr.name))
            return PipelineResult(
                transcript="こんにちは。",
                translated_text="Halo.",
                transformed_text="Halo.",
                output_audio_bytes=b"openai-wav",
                output_audio_mime_type="audio/wav",
                timings_ms={"total": 1.0},
                providers={
                    "asr": "fake-openai-asr",
                    "translation": "fake-openai-translation",
                    "tts": "fake-openai-tts",
                },
            )

    client = TestClient(
        create_app(openai_pipeline=FakeOpenAiPipeline(), voice_conversion_service=_fake_voice_conversion_service())
    )  # type: ignore[arg-type]

    response = client.post(
        "/api/translate-speech-jobs",
        data={"translation_backend": "openai", "source_language": "ja-JP", "target_language": "zh-CN"},
        files={"audio": ("sample.wav", b"fake audio", "audio/wav")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["stages"] == [
        {"stage": "asr", "label": "文字起こし", "provider": "fake-openai-asr"},
        {"stage": "translation", "label": "翻訳", "provider": "fake-openai-translation"},
        {"stage": "text_transform", "label": "テキスト加工", "provider": "なし"},
        {"stage": "tts", "label": "音声生成", "provider": "fake-openai-tts"},
    ]

    for _ in range(20):
        status_payload = client.get(f"/api/translate-speech-jobs/{payload['job_id']}").json()
        if status_payload["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("openai translation job did not finish")

    assert status_payload["result"]["translated_text"] == "Halo."


def test_translate_speech_job_api_accepts_user_auto_target_language() -> None:
    openai_pipeline = SpeechTranslationPipeline(
        asr=FakeAsrProvider({"auto": "Halo."}),
        translator=FakeTranslationProvider({("auto", "ja-JP", "Halo."): "こんにちは。"}),
        tts=FakeTtsProvider(),
    )
    openai_pipeline.supported_routes = {("auto", "id-ID"), ("auto", "ja-JP")}
    client = TestClient(
        create_app(openai_pipeline=openai_pipeline, voice_conversion_service=_fake_voice_conversion_service())
    )

    response = client.post(
        "/api/translate-speech-jobs",
        data={
            "translation_backend": "openai",
            "source_language": "auto",
            "target_language": "user-auto",
            "voice_mode": "default",
        },
        files={"audio": ("sample.webm", b"fake audio", "audio/webm")},
    )

    assert response.status_code == 200
    payload = response.json()
    for _ in range(20):
        status_payload = client.get(f"/api/translate-speech-jobs/{payload['job_id']}").json()
        if status_payload["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("user-auto translation job did not finish")

    assert status_payload["error"] is None
    assert status_payload["result"]["translated_text"] == "こんにちは。"
    assert status_payload["result"]["target_language"] == "ja-JP"


def test_translate_speech_job_api_marks_unexpected_provider_error_failed() -> None:
    class FailingPipeline:
        asr = SimpleNamespace(name="failing-asr")
        translator = SimpleNamespace(name="failing-translation")
        tts = SimpleNamespace(name="failing-tts")

        def run(self, request, progress_callback=None) -> PipelineResult:
            raise Exception("Audio file might be corrupted or unsupported")

    client = TestClient(create_app(pipeline=FailingPipeline()))  # type: ignore[arg-type]

    response = client.post(
        "/api/translate-speech-jobs",
        data={"translation_backend": "qwen", "source_language": "id-ID", "target_language": "ja-JP"},
        files={"audio": ("recording.webm", b"broken audio", "audio/webm")},
    )

    assert response.status_code == 200
    job_id = response.json()["job_id"]
    for _ in range(20):
        status_payload = client.get(f"/api/translate-speech-jobs/{job_id}").json()
        if status_payload["status"] == "failed":
            break
        sleep(0.05)
    else:
        raise AssertionError("translation job did not fail")

    assert status_payload["error"] == "Audio file might be corrupted or unsupported"


def test_translate_speech_job_api_defaults_to_openai_backend() -> None:
    class FakeOpenAiPipeline:
        asr = SimpleNamespace(name="fake-openai-asr")
        translator = SimpleNamespace(name="fake-openai-translation")
        tts = SimpleNamespace(name="fake-openai-tts", supported_voice_modes=("default",))

        def run(self, request, progress_callback=None) -> PipelineResult:
            return PipelineResult(
                transcript="こんにちは。",
                translated_text="Halo.",
                transformed_text="Halo.",
                output_audio_bytes=b"openai-wav",
                output_audio_mime_type="audio/wav",
                timings_ms={"total": 1.0},
                providers={
                    "asr": "fake-openai-asr",
                    "translation": "fake-openai-translation",
                    "tts": "fake-openai-tts",
                },
            )

    client = TestClient(
        create_app(openai_pipeline=FakeOpenAiPipeline(), voice_conversion_service=_fake_voice_conversion_service())
    )  # type: ignore[arg-type]

    response = client.post(
        "/api/translate-speech-jobs",
        data={"source_language": "ja-JP", "target_language": "zh-CN"},
        files={"audio": ("sample.wav", b"fake audio", "audio/wav")},
    )

    assert response.status_code == 200
    payload = response.json()
    for _ in range(20):
        status_payload = client.get(f"/api/translate-speech-jobs/{payload['job_id']}").json()
        if status_payload["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("default openai translation job did not finish")

    assert status_payload["result"]["providers"] == {
        "asr": "fake-openai-asr",
        "translation": "fake-openai-translation",
        "tts": "fake-openai-tts",
    }


def test_translate_speech_api_rejects_unknown_translation_backend() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/api/translate-speech",
        data={
            "translation_backend": "unknown",
            "source_language": "id-ID",
            "target_language": "ja-JP",
        },
        files={"audio": ("sample.wav", b"fake audio", "audio/wav")},
    )

    assert response.status_code == 400
    assert "unsupported translation backend" in response.json()["detail"]


def test_text_to_speech_job_api_generates_audio_and_history(tmp_path) -> None:
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

    from mo_speech.audio_history import AudioHistoryStore

    history_store = AudioHistoryStore(root=tmp_path / "history", limit=10, enabled=True)
    client = TestClient(
        create_app(
            text_tts_providers={"fake": FakeTextTtsProvider()},
            voice_conversion_service=_fake_voice_conversion_service(),
            audio_history_store=history_store,
        )
    )

    response = client.post(
        "/api/text-to-speech-jobs",
        data={"text": "こんにちは", "target_language": "ja-JP", "tts_backend": "fake"},
    )

    assert response.status_code == 200
    payload = response.json()
    for _ in range(20):
        status_payload = client.get(f"/api/text-to-speech-jobs/{payload['job_id']}").json()
        if status_payload["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("text-to-speech job did not finish")

    assert status_payload["result"]["providers"] == {"tts": "fake-text-tts"}
    history = client.get("/api/audio-history").json()
    assert len(history["outputs"]) == 1
    assert history["outputs"][0]["label"] == "こんにちは"
    assert history["outputs"][0]["text_preview"] == "こんにちは"
    assert history["outputs"][0]["tts_text"] == "こんにちは"
    assert history["outputs"][0]["details"][0] == "text-to-speech-jobs"
    audio_response = client.get(history["outputs"][0]["url"])
    assert audio_response.status_code == 200
    assert audio_response.content == "TTS:ja-JP:こんにちは".encode()


def test_openai_realtime_translation_session_api_uses_target_language(monkeypatch) -> None:
    captured = {}

    def fake_client_secret(target_language):
        captured["target_language"] = target_language
        return {"value": "ephemeral-test-key"}

    monkeypatch.setattr("mo_speech.api.create_openai_realtime_translation_client_secret", fake_client_secret)
    client = TestClient(create_app(voice_conversion_service=_fake_voice_conversion_service()))

    response = client.post("/api/openai-realtime-translation-session", json={"target_language": "ja-JP"})

    assert response.status_code == 200
    assert response.json() == {"value": "ephemeral-test-key"}
    assert captured == {"target_language": "ja-JP"}


def test_audio_history_output_api_saves_uploaded_audio_as_wav(tmp_path, monkeypatch) -> None:
    from mo_speech.audio_history import AudioHistoryStore

    monkeypatch.setattr(
        "mo_speech.api_audio_history.prepare_audio_history_wav",
        lambda audio_bytes, suffix: (
            b"normalized streaming wav",
            ".wav",
            {
                "audio_mime_type": "audio/wav",
                "history_audio_format": "wav_24000_mono_pcm16",
                "original_audio_suffix": suffix,
            },
        ),
    )
    history_store = AudioHistoryStore(root=tmp_path / "history", limit=10, enabled=True)
    client = TestClient(
        create_app(
            voice_conversion_service=_fake_voice_conversion_service(),
            audio_history_store=history_store,
        )
    )

    response = client.post(
        "/api/audio-history/outputs",
        data={
            "endpoint": "openai-realtime-streaming",
            "translation_backend": "openai_realtime_stream",
            "target_language": "ja-JP",
        },
        files={"audio": ("streaming.webm", b"streaming output", "audio/webm")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["saved"] is True
    assert payload["entry"]["filename"].endswith(".wav")
    assert payload["entry"]["media_type"] == "audio/wav"
    assert payload["entry"]["metadata"]["endpoint"] == "openai-realtime-streaming"
    assert payload["entry"]["metadata"]["filename"] == "streaming.webm"
    assert payload["entry"]["metadata"]["original_content_type"] == "audio/webm"
    audio_response = client.get(payload["entry"]["url"])
    assert audio_response.status_code == 200
    assert audio_response.content == b"normalized streaming wav"


def test_audio_history_api_reports_storage_settings(tmp_path) -> None:
    from mo_speech.audio_history import AudioHistoryStore

    history_root = tmp_path / "history"
    client = TestClient(
        create_app(
            voice_conversion_service=_fake_voice_conversion_service(),
            audio_history_store=AudioHistoryStore(root=history_root, limit=7, enabled=True),
        )
    )

    response = client.get("/api/audio-history")

    assert response.status_code == 200
    settings = response.json()["settings"]
    assert settings["enabled"] is True
    assert settings["root"] == str(history_root)
    assert settings["resolved_root"] == str(history_root.resolve())
    assert settings["recordings_dir"] == str(history_root.resolve() / "recordings")
    assert settings["outputs_dir"] == str(history_root.resolve() / "outputs")
    assert settings["limit"] == 7
    assert settings["env_var"] == "MO_AUDIO_HISTORY_DIR"


def test_audio_history_api_deletes_entry_and_metadata(tmp_path) -> None:
    from mo_speech.audio_history import AudioHistoryStore

    history_store = AudioHistoryStore(root=tmp_path / "history", limit=10, enabled=True)
    saved = history_store.save_output(
        b"output-audio",
        suffix=".wav",
        metadata={"filename": "output.wav", "text_preview": "こんにちは"},
    )
    assert saved is not None
    client = TestClient(
        create_app(
            voice_conversion_service=_fake_voice_conversion_service(),
            audio_history_store=history_store,
        )
    )

    response = client.delete(f"/api/audio-history/outputs/{saved.audio_path.name}")

    assert response.status_code == 200
    assert response.json() == {"deleted": True}
    assert not saved.audio_path.exists()
    assert not saved.metadata_path.exists()
    assert client.get(f"/api/audio-history/outputs/{saved.audio_path.name}").status_code == 404
    assert client.get("/api/audio-history").json()["outputs"] == []


def test_translate_speech_job_api_reports_partial_result_while_running() -> None:
    progress_reported = Event()
    finish_job = Event()

    class SlowPipeline:
        asr = SimpleNamespace(name="slow-asr")
        translator = SimpleNamespace(name="slow-translation")
        tts = SimpleNamespace(name="slow-tts")

        def run(self, request, progress_callback=None) -> PipelineResult:
            if progress_callback is not None:
                progress_callback(
                    PipelineProgress(
                        stage="translation",
                        label="翻訳",
                        provider="slow-translation",
                        transcript="Selamat pagi.",
                    )
                )
            progress_reported.set()
            assert finish_job.wait(timeout=2)
            return PipelineResult(
                transcript="Selamat pagi.",
                translated_text="おはようございます。",
                transformed_text="おはようございます。",
                output_audio_bytes=b"wav",
                output_audio_mime_type="audio/wav",
                timings_ms={"total": 0.0},
                providers={"asr": "slow-asr", "translation": "slow-translation", "tts": "slow-tts"},
            )

    client = TestClient(create_app(pipeline=SlowPipeline()))  # type: ignore[arg-type]

    response = client.post(
        "/api/translate-speech-jobs",
        data={"translation_backend": "qwen", "source_language": "id-ID", "target_language": "ja-JP"},
        files={"audio": ("sample.wav", b"fake audio", "audio/wav")},
    )
    assert response.status_code == 200
    job_id = response.json()["job_id"]

    assert progress_reported.wait(timeout=2)
    status_response = client.get(f"/api/translate-speech-jobs/{job_id}")
    assert status_response.status_code == 200
    status_payload = status_response.json()
    assert status_payload["status"] == "running"
    assert status_payload["current_stage"] == {
        "stage": "translation",
        "label": "翻訳",
        "provider": "slow-translation",
    }
    assert status_payload["partial_result"] == {"transcript": "Selamat pagi."}

    finish_job.set()
    for _ in range(20):
        status_payload = client.get(f"/api/translate-speech-jobs/{job_id}").json()
        if status_payload["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("translation job did not finish")


def test_voice_conversion_job_api_runs_selected_backend() -> None:
    client = TestClient(create_app(voice_conversion_service=_fake_voice_conversion_service()))

    response = client.post(
        "/api/voice-conversion-jobs",
        data={"voice_backend": "fake-vc"},
        files={
            "source_audio": ("source.wav", b"source audio", "audio/wav"),
            "reference_audio": ("reference.wav", b"reference audio", "audio/wav"),
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] in {"queued", "running", "succeeded"}
    assert payload["stages"] == [
        {"stage": "source_audio_prepare", "label": "変換元音声準備", "provider": "ffmpeg"},
        {"stage": "reference_audio_prepare", "label": "参照音声準備", "provider": "ffmpeg"},
        {"stage": "voice_conversion", "label": "声質変換", "provider": "fake-vc-provider"},
    ]

    job_id = payload["job_id"]
    for _ in range(20):
        status_payload = client.get(f"/api/voice-conversion-jobs/{job_id}").json()
        if status_payload["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("voice conversion job did not finish")

    assert status_payload["result"]["audio_base64"] != ""
    assert status_payload["result"]["audio_mime_type"] == "audio/wav"
    assert status_payload["result"]["providers"] == {"voice_conversion": "fake-vc-provider"}
    assert status_payload["result"]["timings_ms"]["voice_conversion"] == 1.0


def test_voice_conversion_job_api_marks_failed_stage() -> None:
    class FailingVoiceConversionProvider(FakeVoiceConversionProvider):
        def convert(
            self,
            *,
            source_audio_path: Path,
            reference_audio_path: Path,
            seed_vc_settings: SeedVcRuntimeSettings | None = None,
            progress_callback=None,
        ):
            if progress_callback is not None:
                progress_callback(PipelineProgress("gpu_wait", "利用可能なGPUを待っています", "RunPod Serverless"))
            raise RuntimeError(
                "RunPod job failed with status FAILED: job_id=remote-job-1: "
                "libcudart.so.13: cannot open shared object file"
            )

    service = VoiceConversionService(providers=[FailingVoiceConversionProvider()])
    client = TestClient(create_app(voice_conversion_service=service))

    response = client.post(
        "/api/voice-conversion-jobs",
        data={"voice_backend": "fake-vc"},
        files={
            "source_audio": ("source.wav", b"source audio", "audio/wav"),
            "reference_audio": ("reference.wav", b"reference audio", "audio/wav"),
        },
    )

    assert response.status_code == 200
    job_id = response.json()["job_id"]
    for _ in range(20):
        status_payload = client.get(f"/api/voice-conversion-jobs/{job_id}").json()
        if status_payload["status"] == "failed":
            break
        sleep(0.05)
    else:
        raise AssertionError("voice conversion job did not fail")

    assert status_payload["current_stage"] == {
        "stage": "failed",
        "label": "処理に失敗しました",
        "provider": "fake-vc",
    }
    assert "job_id=remote-job-1" in status_payload["error"]


def test_voice_conversion_job_api_accepts_seed_vc_settings() -> None:
    provider = FakeVoiceConversionProvider()
    client = TestClient(create_app(voice_conversion_service=VoiceConversionService(providers=[provider])))

    response = client.post(
        "/api/voice-conversion-jobs",
        data={
            "voice_backend": "fake-vc",
            "seed_vc_diffusion_steps": "5",
            "seed_vc_length_adjust": "1.2",
            "seed_vc_inference_cfg_rate": "0.55",
            "seed_vc_reference_max_seconds": "4.5",
            "seed_vc_reference_auto_select": "true",
        },
        files={
            "source_audio": ("source.wav", b"source audio", "audio/wav"),
            "reference_audio": ("reference.wav", b"reference audio", "audio/wav"),
        },
    )

    assert response.status_code == 200
    for _ in range(20):
        status_payload = client.get(f"/api/voice-conversion-jobs/{response.json()['job_id']}").json()
        if status_payload["status"] == "succeeded":
            break
        sleep(0.05)
    else:
        raise AssertionError("voice conversion job did not finish")

    assert provider.last_seed_vc_settings is not None
    assert provider.last_seed_vc_settings.diffusion_steps == 5
    assert provider.last_seed_vc_settings.length_adjust == 1.2
    assert provider.last_seed_vc_settings.inference_cfg_rate == 0.55
    assert provider.last_seed_vc_settings.reference_max_seconds == 4.5
    assert provider.last_seed_vc_settings.reference_auto_select is True


def test_create_app_preloads_voice_conversion_service_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    class Service(VoiceConversionService):
        def preload(self) -> None:
            calls.append("preload")

    monkeypatch.setenv("MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START", "1")

    create_app(voice_conversion_service=Service(providers=[]))

    assert calls == ["preload"]


def test_seed_vc_reference_preview_api_reports_prepare_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_prepare_reference_preview(audio_path: Path, seed_vc_settings: SeedVcRuntimeSettings | None = None) -> TtsOutput:
        raise RuntimeError("ffmpeg failed")

    monkeypatch.setattr(
        "mo_speech.api._prepare_seed_vc_reference_preview",
        fake_prepare_reference_preview,
    )
    client = TestClient(create_app())

    response = client.post(
        "/api/seed-vc/reference-preview",
        data={"seed_vc_reference_auto_select": "false"},
        files={"reference_audio": ("reference.wav", b"reference audio", "audio/wav")},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "ffmpeg failed"


def test_seed_vc_reference_preview_api_returns_normalized_audio(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def fake_prepare_reference_preview(audio_path: Path, seed_vc_settings: SeedVcRuntimeSettings | None = None) -> TtsOutput:
        captured["audio_exists"] = audio_path.exists()
        captured["audio_bytes"] = audio_path.read_bytes()
        captured["settings"] = seed_vc_settings
        return TtsOutput(
            audio_bytes=b"normalized reference wav",
            audio_mime_type="audio/wav",
            timings_ms={"reference_audio_prepare": 12.5, "reference_segment_select": 3.5},
        )

    monkeypatch.setattr(
        "mo_speech.api._prepare_seed_vc_reference_preview",
        fake_prepare_reference_preview,
    )
    client = TestClient(create_app())

    response = client.post(
        "/api/seed-vc/reference-preview",
        data={
            "seed_vc_reference_max_seconds": "4.5",
            "seed_vc_reference_auto_select": "true",
        },
        files={"reference_audio": ("reference.wav", b"reference audio", "audio/wav")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert base64.b64decode(payload["audio_base64"]) == b"normalized reference wav"
    assert payload["audio_mime_type"] == "audio/wav"
    assert payload["timings_ms"] == {"reference_audio_prepare": 12.5, "reference_segment_select": 3.5}
    assert payload["providers"] == {"reference_audio_prepare": "ffmpeg"}
    assert captured["audio_exists"] is True
    assert captured["audio_bytes"] == b"reference audio"
    settings = captured["settings"]
    assert isinstance(settings, SeedVcRuntimeSettings)
    assert settings.reference_max_seconds == 4.5
    assert settings.reference_auto_select is True


def test_translate_speech_api_rejects_unsupported_route() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/api/translate-speech",
        data={"translation_backend": "qwen", "source_language": "en-US", "target_language": "ja-JP"},
        files={"audio": ("sample.wav", b"fake audio", "audio/wav")},
    )

    assert response.status_code == 400
    assert "unsupported route" in response.json()["detail"]


def test_translate_speech_api_preserves_uploaded_audio_suffix() -> None:
    captured: dict[str, Path] = {}

    class CapturePipeline:
        asr = SimpleNamespace(name="capture-asr")
        translator = SimpleNamespace(name="capture-translation")
        tts = SimpleNamespace(name="capture-tts")

        def run(self, request) -> PipelineResult:
            captured["audio_path"] = request.audio_path
            return PipelineResult(
                transcript="Selamat pagi.",
                translated_text="おはようございます。",
                transformed_text="おはようございます。",
                output_audio_bytes=b"wav",
                output_audio_mime_type="audio/wav",
                timings_ms={"total": 0.0},
                providers={"asr": "capture-asr", "translation": "capture-translation", "tts": "capture-tts"},
            )

    client = TestClient(create_app(pipeline=CapturePipeline()))  # type: ignore[arg-type]

    response = client.post(
        "/api/translate-speech",
        data={"translation_backend": "qwen", "source_language": "id-ID", "target_language": "ja-JP"},
        files={"audio": ("recording.webm", b"fake audio", "audio/webm;codecs=opus")},
    )

    assert response.status_code == 200
    assert captured["audio_path"].suffix == ".webm"


class FakeVoiceConversionProvider:
    backend_id = "fake-vc"
    label = "Fake VC"
    name = "fake-vc-provider"
    audio_mime_type = "audio/wav"

    def __init__(self, *, available: bool = True) -> None:
        self.available = available
        self.last_seed_vc_settings: SeedVcRuntimeSettings | None = None

    def backend_info(self) -> VoiceConversionBackendInfo:
        return VoiceConversionBackendInfo(
            self.backend_id,
            self.label,
            self.name,
            self.available,
            "" if self.available else "not installed",
        )

    def convert(
        self,
        *,
        source_audio_path: Path,
        reference_audio_path: Path,
        seed_vc_settings: SeedVcRuntimeSettings | None = None,
        progress_callback=None,
    ):
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


def _fake_voice_conversion_service(*, available: bool = True) -> VoiceConversionService:
    return VoiceConversionService(providers=[FakeVoiceConversionProvider(available=available)])
