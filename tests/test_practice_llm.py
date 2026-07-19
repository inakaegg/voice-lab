from __future__ import annotations

import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from mo_speech.practice_llm import (
    PRACTICE_COMPARISON_MODELS,
    PRACTICE_LLM_PROMPT,
    PracticeLlmError,
    PracticeLlmService,
    comparison_alignments_from_llm_result,
    supported_practice_comparison_model,
    validate_playback_padding_seconds,
    validate_practice_llm_result,
)


FIXTURE_PATH = (
    Path(__file__).parent
    / "fixtures"
    / "practice_llm_comparison"
    / "zh_real_20260718_75a32d86.json"
)


def load_fixture() -> dict[str, object]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _assert_deep_close(actual: object, expected: object) -> None:
    """Compare recursively, tolerating float rounding from end+padding arithmetic."""
    if isinstance(expected, float):
        assert actual == pytest.approx(expected, abs=1e-6)
    elif isinstance(expected, dict):
        assert isinstance(actual, dict)
        assert actual.keys() == expected.keys()
        for key in expected:
            _assert_deep_close(actual[key], expected[key])
    elif isinstance(expected, list):
        assert isinstance(actual, list)
        assert len(actual) == len(expected)
        for actual_item, expected_item in zip(actual, expected):
            _assert_deep_close(actual_item, expected_item)
    else:
        assert actual == expected


def _strip_llm_supplied_timestamps(response: dict[str, object]) -> dict[str, object]:
    """Shape a fixture's evidence response like what the model now returns.

    The fixture records a real, reviewed request/response pair from before this
    change, when the LLM still echoed matched_text/start/end/playback_start/
    playback_end. The app now computes those from word_start_index/word_end_index
    instead, so tests that simulate a model response strip them here.
    """
    stripped = copy.deepcopy(response)
    for phrase in stripped["phrases"]:
        for side in ("reference", "attempt"):
            range_value = phrase[side]
            for key in ("matched_text", "start", "end", "playback_start", "playback_end"):
                range_value.pop(key, None)
    return stripped


def test_prompt_requires_complete_wrong_utterance_and_delegates_timestamps_to_app() -> None:
    assert "誤って発話した語を含む対応発話全体" in PRACTICE_LLM_PROMPT
    assert "一致した末尾だけへ狭めない" in PRACTICE_LLM_PROMPT
    assert "word_start_index" in PRACTICE_LLM_PROMPT
    assert "返す必要はない" in PRACTICE_LLM_PROMPT
    assert "playback_start" not in PRACTICE_LLM_PROMPT
    assert "アプリ側で意味判断や採点を作り直す必要がない完成結果" in PRACTICE_LLM_PROMPT


def test_model_and_padding_settings_are_restricted() -> None:
    assert PRACTICE_COMPARISON_MODELS == (
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.4-mini",
        "gpt-5.4-nano",
    )
    assert supported_practice_comparison_model("") == "gpt-5.6-terra"
    assert supported_practice_comparison_model("gpt-5.4-nano") == "gpt-5.4-nano"
    with pytest.raises(ValueError):
        supported_practice_comparison_model("gpt-4o")

    assert validate_playback_padding_seconds("0.1") == pytest.approx(0.1)
    assert validate_playback_padding_seconds("0.50") == pytest.approx(0.5)
    for value in ("-0.05", "0.03", "0.55", "not-a-number"):
        with pytest.raises(ValueError):
            validate_playback_padding_seconds(value)


def test_reviewed_real_asr_pair_computes_timestamps_from_word_indexes() -> None:
    fixture = load_fixture()
    model_output = _strip_llm_supplied_timestamps(fixture["llm_response"])

    validated = validate_practice_llm_result(model_output, fixture["input"])

    assert validated["overall_score"] == 59
    # Recomputed purely from word_start_index/word_end_index must reproduce the
    # same numbers that were previously observed as correct in the real session.
    _assert_deep_close(validated["phrases"][3]["attempt"], fixture["llm_response"]["phrases"][3]["attempt"])
    _assert_deep_close(
        validated["phrases"][3]["attempt"],
        {
            "status": "partial",
            "word_start_index": 17,
            "word_end_index": 24,
            "matched_text": "你就像咱妈样呢",
            "start": 8.459,
            "end": 10.289,
            "playback_start": 8.359,
            "playback_end": 10.26,
        },
    )


def test_matched_text_from_llm_is_ignored_even_if_present() -> None:
    fixture = load_fixture()
    model_output = _strip_llm_supplied_timestamps(fixture["llm_response"])
    model_output["phrases"][0]["reference"]["matched_text"] = "位置番号と無関係な文字列"

    validated = validate_practice_llm_result(model_output, fixture["input"])

    assert validated["phrases"][0]["reference"]["matched_text"] == "你好"


def test_missing_range_computes_empty_matched_text_and_null_timestamps() -> None:
    fixture = load_fixture()
    model_output = _strip_llm_supplied_timestamps(fixture["llm_response"])
    missing = model_output["phrases"][0]["reference"]
    missing.update(
        {
            "status": "missing",
            "word_start_index": None,
            "word_end_index": None,
            # Stray fields the model has no schema slot for anymore; must be ignored.
            "matched_text": "位置番号がない場合の誤った文字列",
            "start": 1.0,
        }
    )

    validated = validate_practice_llm_result(model_output, fixture["input"])

    assert validated["phrases"][0]["reference"] == {
        "status": "missing",
        "word_start_index": None,
        "word_end_index": None,
        "matched_text": "",
        "start": None,
        "end": None,
        "playback_start": None,
        "playback_end": None,
    }


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("phrases", 0, "reference", "word_start_index"), -1),
        (("phrases", 3, "reference", "word_end_index"), 24),
        (("phrases", 2, "attempt", "word_end_index"), 9),
        (("phrases", 3, "phrase_index"), 2),
        (("phrases", 1, "target_text"), "花了三个多小时"),
        (("phrases", 0, "reference", "status"), "unknown"),
    ],
)
def test_invalid_llm_result_is_rejected_without_legacy_fallback(path, value) -> None:
    fixture = load_fixture()
    model_output = _strip_llm_supplied_timestamps(fixture["llm_response"])
    target = model_output
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = value

    with pytest.raises(PracticeLlmError) as raised:
        validate_practice_llm_result(model_output, fixture["input"])

    assert raised.value.stage == "validate_response"
    assert raised.value.fallback_to_legacy is False


def test_llm_result_is_exposed_to_existing_phrase_playback_without_changing_times() -> None:
    fixture = load_fixture()
    validated = validate_practice_llm_result(
        _strip_llm_supplied_timestamps(fixture["llm_response"]),
        fixture["input"],
    )

    attempt, reference = comparison_alignments_from_llm_result(validated)

    assert attempt["target_phrase_count"] == 4
    assert attempt["all_phrases_playable"] is True
    assert attempt["phrases"][3]["audio_start"] == pytest.approx(8.359)
    assert attempt["phrases"][3]["audio_end"] == pytest.approx(10.26)
    assert reference["phrases"][3]["audio_start"] == pytest.approx(6.13675)
    assert reference["phrases"][3]["audio_end"] == pytest.approx(7.413083)


class FakeResponses:
    def __init__(self, output: dict[str, object]) -> None:
        self.output = output
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            id="resp_test",
            status="completed",
            output_text=json.dumps(self.output, ensure_ascii=False),
            usage=SimpleNamespace(
                input_tokens=100,
                output_tokens=50,
                total_tokens=150,
                input_tokens_details=SimpleNamespace(cached_tokens=20),
                output_tokens_details=SimpleNamespace(reasoning_tokens=10),
            ),
            model_dump=lambda mode="json": {
                "id": "resp_test",
                "status": "completed",
                "output_text": json.dumps(self.output, ensure_ascii=False),
            },
        )


def test_service_sends_strict_schema_and_writes_a_complete_diagnostic_log(tmp_path) -> None:
    fixture = load_fixture()
    model_output = _strip_llm_supplied_timestamps(fixture["llm_response"])
    responses = FakeResponses(model_output)
    service = PracticeLlmService(
        client=SimpleNamespace(responses=responses),
        log_dir=tmp_path,
        pricing={
            "gpt-5.6-terra": {
                "input_per_million": 2.0,
                "cached_input_per_million": 0.2,
                "output_per_million": 8.0,
            }
        },
    )

    evaluated = service.evaluate(
        model="gpt-5.6-terra",
        input_payload=fixture["input"],
    )

    call = responses.calls[0]
    assert call["model"] == "gpt-5.6-terra"
    assert call["instructions"] == PRACTICE_LLM_PROMPT
    assert call["text"]["format"]["type"] == "json_schema"
    assert call["text"]["format"]["strict"] is True
    # The service reconstructs matched_text/start/end/playback_* from word
    # indexes, so the final result matches the full (pre-strip) fixture even
    # though the simulated model only returned status/word_start_index/word_end_index.
    _assert_deep_close(evaluated.result, fixture["llm_response"])
    assert evaluated.usage["total_tokens"] == 150
    assert evaluated.estimated_cost_usd == pytest.approx(0.000564)

    [log_path] = list(tmp_path.glob("*.json"))
    log = json.loads(log_path.read_text(encoding="utf-8"))
    assert log["status"] == "succeeded"
    assert log["request"]["prompt"] == PRACTICE_LLM_PROMPT
    assert log["request"]["input"] == fixture["input"]
    assert log["response"]["parsed"] == model_output
    _assert_deep_close(log["final_result"], fixture["llm_response"])
    assert log["billing"]["estimated_cost_usd"] == pytest.approx(0.000564)
    assert "api_key" not in json.dumps(log).lower()


def test_service_ignores_a_stray_matched_text_field_from_the_model(tmp_path) -> None:
    fixture = load_fixture()
    raw_result = _strip_llm_supplied_timestamps(fixture["llm_response"])
    raw_result["phrases"][0]["reference"]["matched_text"] = "LLMが誤記した文字列"
    responses = FakeResponses(raw_result)
    service = PracticeLlmService(
        client=SimpleNamespace(responses=responses),
        log_dir=tmp_path,
        pricing={},
    )

    evaluated = service.evaluate(
        model="gpt-5.6-terra",
        input_payload=fixture["input"],
    )

    [log_path] = list(tmp_path.glob("*.json"))
    log = json.loads(log_path.read_text(encoding="utf-8"))
    assert log["response"]["parsed"]["phrases"][0]["reference"]["matched_text"] == "LLMが誤記した文字列"
    assert log["final_result"]["phrases"][0]["reference"]["matched_text"] == "你好"
    assert evaluated.result["phrases"][0]["reference"]["matched_text"] == "你好"


def test_service_keeps_the_llm_return_and_usage_in_a_validation_failure_log(tmp_path) -> None:
    fixture = load_fixture()
    invalid = _strip_llm_supplied_timestamps(fixture["llm_response"])
    invalid["phrases"][0]["attempt"]["word_start_index"] = 999
    responses = FakeResponses(invalid)
    service = PracticeLlmService(
        client=SimpleNamespace(responses=responses),
        log_dir=tmp_path,
        pricing={},
    )

    with pytest.raises(PracticeLlmError) as caught:
        service.evaluate(
            model="gpt-5.6-terra",
            input_payload=fixture["input"],
        )

    assert caught.value.stage == "validate_response"
    [log_path] = list(tmp_path.glob("*.json"))
    log = json.loads(log_path.read_text(encoding="utf-8"))
    assert log["status"] == "failed"
    assert log["response"]["parsed"] == invalid
    assert log["billing"]["usage"]["total_tokens"] == 150
    assert log["final_result"] is None
    assert log["failure"]["fallback_to_legacy"] is False
