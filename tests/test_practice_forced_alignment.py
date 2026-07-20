from __future__ import annotations

import importlib

import pytest


def _module():
    return importlib.import_module("mo_speech.practice_forced_alignment")


def test_replace_word_timestamps_preserves_word_indices_and_non_time_fields() -> None:
    result = _module().replace_word_timestamps(
        [
            {"text": "你", "start": 0.4, "end": 0.8, "confidence": 0.9},
            {"text": "好", "start": 0.8, "end": 1.2, "confidence": 0.8},
        ],
        [
            {"text": "你", "start": 0.1, "end": 0.3},
            {"text": "好", "start": 0.3, "end": 0.55},
        ],
    )

    assert result == [
        {"text": "你", "start": 0.1, "end": 0.3, "confidence": 0.9},
        {"text": "好", "start": 0.3, "end": 0.55, "confidence": 0.8},
    ]


def test_replace_word_timestamps_rejects_token_mismatch_instead_of_shifting_indices() -> None:
    with pytest.raises(ValueError, match="tokens do not match"):
        _module().replace_word_timestamps(
            [{"text": "你", "start": 0.0, "end": 0.2}],
            [{"text": "好", "start": 0.0, "end": 0.2}],
        )


def test_speech_islands_are_the_inverse_of_ffmpeg_silence_ranges() -> None:
    islands = _module().speech_islands_from_silencedetect(
        "\n".join(
            [
                "[silencedetect] silence_start: 0.7",
                "[silencedetect] silence_end: 1.0 | silence_duration: 0.3",
                "[silencedetect] silence_start: 1.8",
                "[silencedetect] silence_end: 2.0 | silence_duration: 0.2",
            ]
        ),
        2.4,
    )

    assert islands == [(0.0, 0.7), (1.0, 1.8), (2.0, 2.4)]


def test_vad_snap_moves_only_first_and_last_word_of_each_speech_island() -> None:
    words = [
        {"text": "你", "start": 0.10, "end": 0.30},
        {"text": "好", "start": 0.30, "end": 0.68},
        {"text": "吗", "start": 1.08, "end": 1.62},
    ]

    result = _module().snap_word_timestamps_to_speech_islands(
        words,
        [(0.0, 0.7), (1.0, 1.7)],
        max_distance_seconds=0.35,
    )

    assert result == [
        {"text": "你", "start": 0.0, "end": 0.30},
        {"text": "好", "start": 0.30, "end": 0.7},
        {"text": "吗", "start": 1.0, "end": 1.7},
    ]


def test_vad_snap_keeps_an_edge_outside_the_configured_window() -> None:
    result = _module().snap_word_timestamps_to_speech_islands(
        [{"text": "你", "start": 0.4, "end": 0.8}],
        [(0.0, 1.3)],
        max_distance_seconds=0.35,
    )

    assert result == [{"text": "你", "start": 0.4, "end": 0.8}]
