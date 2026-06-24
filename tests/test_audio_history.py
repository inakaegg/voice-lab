from __future__ import annotations

import json

from mo_speech.audio_history import AudioHistoryStore


def test_audio_history_store_keeps_latest_files(tmp_path) -> None:
    store = AudioHistoryStore(root=tmp_path / "history", limit=2, enabled=True)

    store.save_recording(b"recording-1", suffix=".webm", metadata={"index": 1})
    store.save_recording(b"recording-2", suffix=".webm", metadata={"index": 2})
    latest = store.save_recording(b"recording-3", suffix=".webm", metadata={"index": 3})

    recordings = sorted((tmp_path / "history" / "recordings").glob("*.webm"))
    metadata = sorted((tmp_path / "history" / "recordings").glob("*.json"))
    assert len(recordings) == 2
    assert len(metadata) == 2
    assert latest is not None
    assert latest.audio_path in recordings
    assert latest.metadata_path in metadata
    assert b"recording-1" not in [path.read_bytes() for path in recordings]
    assert json.loads(latest.metadata_path.read_text(encoding="utf-8"))["index"] == 3


def test_audio_history_store_keeps_outputs_separate(tmp_path) -> None:
    store = AudioHistoryStore(root=tmp_path / "history", limit=10, enabled=True)

    recording = store.save_recording(b"recording", suffix=".wav", metadata={})
    output = store.save_output(b"output", suffix=".wav", metadata={"route": "ja-JP->zh-CN"})

    assert recording is not None
    assert output is not None
    assert recording.audio_path.parent.name == "recordings"
    assert output.audio_path.parent.name == "outputs"
    assert output.audio_path.read_bytes() == b"output"


def test_audio_history_store_lists_and_resolves_entries(tmp_path) -> None:
    store = AudioHistoryStore(root=tmp_path / "history", limit=10, enabled=True)
    saved = store.save_output(b"output", suffix=".wav", metadata={"route": "ja-JP->id-ID"})

    assert saved is not None
    entries = store.list_entries("outputs")

    assert len(entries) == 1
    assert entries[0].metadata is not None
    assert entries[0].metadata["route"] == "ja-JP->id-ID"
    assert store.resolve_audio_path("outputs", saved.audio_path.name) == saved.audio_path


def test_audio_history_store_rejects_invalid_history_filename(tmp_path) -> None:
    store = AudioHistoryStore(root=tmp_path / "history", limit=10, enabled=True)

    try:
        store.resolve_audio_path("outputs", "../secret.wav")
    except ValueError as exc:
        assert "invalid audio history filename" in str(exc)
    else:
        raise AssertionError("invalid filename was accepted")
