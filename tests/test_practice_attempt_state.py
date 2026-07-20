import os
import time

from mo_speech.practice_attempt_state import PracticeAttemptStateStore


def test_practice_attempt_state_store_persists_options_and_terminal_snapshot(tmp_path) -> None:
    store = PracticeAttemptStateStore(root=tmp_path / "attempt-state")
    store.save_options(
        "runpod/job:1",
        {
            "comparison_model": "gpt-5.4-nano",
            "playback_padding_seconds": 0.25,
        },
    )
    store.save_terminal_snapshot(
        "runpod/job:1",
        {
            "job_id": "runpod/job:1",
            "status": "succeeded",
            "result": {"overall_score": 100},
        },
    )

    reloaded = PracticeAttemptStateStore(root=tmp_path / "attempt-state")
    assert reloaded.load_options("runpod/job:1") == {
        "comparison_model": "gpt-5.4-nano",
        "playback_padding_seconds": 0.25,
    }
    assert reloaded.load_terminal_snapshot("runpod/job:1") == {
        "job_id": "runpod/job:1",
        "status": "succeeded",
        "result": {"overall_score": 100},
    }
    assert [path.name for path in reloaded.root.glob("*.json")] != ["runpod/job:1.json"]


def test_practice_attempt_state_store_expires_old_job_state(tmp_path) -> None:
    store = PracticeAttemptStateStore(
        root=tmp_path / "attempt-state",
        ttl_seconds=60,
    )
    store.save_options("old-job", {"comparison_model": "gpt-5.6-terra"})
    path = next(store.root.glob("*.json"))
    expired_time = time.time() - 61
    os.utime(path, (expired_time, expired_time))

    assert store.load_options("old-job") is None
    assert not path.exists()
