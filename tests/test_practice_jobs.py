from __future__ import annotations

from threading import Event

import pytest

from mo_speech.practice_jobs import PracticeJobFailure, PracticeJobStore


def test_practice_job_reports_the_actual_stage_provider_and_model() -> None:
    store = PracticeJobStore()
    entered_translation = Event()
    finish = Event()

    def run(report):
        report(
            stage="transcribing_prompt",
            label="録音を文字にしています",
            provider="OpenAI",
            model="whisper-1",
        )
        report(
            stage="translating_prompt",
            label="学習言語へ翻訳しています",
            provider="OpenAI",
            model="gpt-5.5",
        )
        entered_translation.set()
        assert finish.wait(timeout=2)
        return {"target_text": "Hello."}

    submitted = store.start(
        run,
        planned_stages=[
            {
                "stage": "transcribing_prompt",
                "label": "録音を文字にしています",
                "provider": "OpenAI",
                "model": "whisper-1",
            },
            {
                "stage": "translating_prompt",
                "label": "学習言語へ翻訳しています",
                "provider": "OpenAI",
                "model": "gpt-5.5",
            },
        ],
    )

    assert submitted["job_id"].startswith("local-")
    assert entered_translation.wait(timeout=2)
    running = store.snapshot(submitted["job_id"])
    assert running["status"] == "running"
    assert running["current_stage"] == {
        "stage": "translating_prompt",
        "label": "学習言語へ翻訳しています",
        "provider": "OpenAI",
        "model": "gpt-5.5",
    }

    finish.set()
    completed = store.wait(submitted["job_id"], timeout=2)
    assert completed["status"] == "succeeded"
    assert completed["result"] == {"target_text": "Hello."}


def test_practice_job_keeps_a_typed_failure_without_fallback() -> None:
    store = PracticeJobStore()

    def run(report):
        report(
            stage="evaluating_comparison",
            label="比較結果を作っています",
            provider="OpenAI",
            model="gpt-5.6-terra",
        )
        raise PracticeJobFailure(
            current_stage={
                "stage": "failed",
                "label": "処理に失敗しました",
                "provider": "OpenAI",
                "model": "gpt-5.6-terra",
            },
            error={
                "code": "practice_llm_failed",
                "message": "比較結果を作成できませんでした。もう一度お試しください。",
                "fallback_to_legacy": False,
            },
        )

    submitted = store.start(run, planned_stages=[])
    failed = store.wait(submitted["job_id"], timeout=2)

    assert failed["status"] == "failed"
    assert failed["current_stage"]["model"] == "gpt-5.6-terra"
    assert failed["error"]["code"] == "practice_llm_failed"
    assert failed["error"]["fallback_to_legacy"] is False
    assert failed["result"] is None


def test_practice_job_rejects_an_unknown_id() -> None:
    store = PracticeJobStore()

    with pytest.raises(KeyError):
        store.snapshot("local-missing")
