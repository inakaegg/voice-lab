from __future__ import annotations

from copy import deepcopy
import json
import math
import os
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter
from typing import Any
from uuid import uuid4

PRACTICE_COMPARISON_MODELS = (
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
)
DEFAULT_PRACTICE_COMPARISON_MODEL = PRACTICE_COMPARISON_MODELS[0]
DEFAULT_PLAYBACK_PADDING_SECONDS = 0.1
PRACTICE_COMPARISON_ERROR_MESSAGE = "比較結果を作成できませんでした。もう一度お試しください。"

PRACTICE_LLM_PROMPT = """\
あなたは発音練習アプリの比較・採点処理です。入力された目標文、お手本ASR、復唱ASRだけを根拠に、UI表示とフレーズ比較再生にそのまま使える完成JSONを返してください。

規則:
- 目標文を意味と文法のまとまりでフレーズ分割する。フレーズのtarget_textを順に連結すると、空白・句読点を含めて元のtarget_textと完全一致すること。
- reference_asr.wordsとattempt_asr.wordsの配列位置を使う。word_start_indexは0始まりinclusive、word_end_indexはexclusive。
- 対応できる連続範囲だけをassignedまたはpartialにする。対応できない場合はmissingとし、word_start_indexとword_end_indexをnullにする。
- 復唱が目標と異なる場合も、誤って発話した語を含む対応発話全体を選ぶ。目標と一致した末尾だけへ狭めない。
- 一致文字列と再生時刻はアプリ側が選択した位置番号から直接計算するため、返す必要はない。word_start_index/word_end_indexで対応範囲を正確に選ぶことだけに集中する。
- scoreとoverall_scoreは0から100の整数。ASRで認識された内容と目標文の一致を評価する。声調や発音などASR文字列から分からないことを断定しない。
- commentとoverall_commentは日本語で簡潔に書く。
- アプリ側で意味判断や採点を作り直す必要がない完成結果を返す。
- schema以外の説明を出力しない。
"""


def _range_schema() -> dict[str, object]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["status", "word_start_index", "word_end_index"],
        "properties": {
            "status": {"type": "string", "enum": ["assigned", "partial", "missing"]},
            "word_start_index": {"type": ["integer", "null"]},
            "word_end_index": {"type": ["integer", "null"]},
        },
    }


PRACTICE_LLM_RESULT_SCHEMA: dict[str, object] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["schema_version", "overall_score", "overall_comment", "phrases"],
    "properties": {
        "schema_version": {"type": "integer", "const": 1},
        "overall_score": {"type": "integer", "minimum": 0, "maximum": 100},
        "overall_comment": {"type": "string"},
        "phrases": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "phrase_index",
                    "target_text",
                    "score",
                    "comment",
                    "reference",
                    "attempt",
                ],
                "properties": {
                    "phrase_index": {"type": "integer", "minimum": 0},
                    "target_text": {"type": "string", "minLength": 1},
                    "score": {"type": "integer", "minimum": 0, "maximum": 100},
                    "comment": {"type": "string"},
                    "reference": _range_schema(),
                    "attempt": _range_schema(),
                },
            },
        },
    },
}


class PracticeLlmError(RuntimeError):
    def __init__(self, detail: str, *, stage: str) -> None:
        super().__init__(detail)
        self.detail = detail
        self.stage = stage
        self.fallback_to_legacy = False


@dataclass(frozen=True)
class PracticeLlmEvaluation:
    result: dict[str, object]
    usage: dict[str, int]
    estimated_cost_usd: float | None
    elapsed_ms: float
    log_path: Path


def supported_practice_comparison_model(value: object) -> str:
    model = str(value or DEFAULT_PRACTICE_COMPARISON_MODEL).strip()
    if model not in PRACTICE_COMPARISON_MODELS:
        raise ValueError("unsupported practice comparison model")
    return model


def validate_playback_padding_seconds(value: object) -> float:
    try:
        padding = float(value if value not in (None, "") else DEFAULT_PLAYBACK_PADDING_SECONDS)
    except (TypeError, ValueError) as exc:
        raise ValueError("playback padding must be a number") from exc
    rounded_steps = round(padding / 0.05)
    if padding < 0 or padding > 0.5 or not math.isclose(
        padding,
        rounded_steps * 0.05,
        abs_tol=1e-9,
    ):
        raise ValueError("playback padding must be between 0.00 and 0.50 in 0.05 increments")
    return round(padding, 2)


def probe_audio_duration_seconds(path: Path, *, fallback_words: list[dict[str, object]]) -> float:
    try:
        completed = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        duration = float(completed.stdout.strip())
        if math.isfinite(duration) and duration > 0:
            return duration
    except (FileNotFoundError, subprocess.SubprocessError, TypeError, ValueError):
        pass
    return max(
        (float(word.get("end") or 0.0) for word in fallback_words if isinstance(word, dict)),
        default=0.0,
    )


def build_practice_llm_input(
    *,
    target_language: str,
    target_text: str,
    padding_seconds: float,
    reference_asr: dict[str, object],
    attempt_asr: dict[str, object],
    reference_audio_duration: float,
    attempt_audio_duration: float,
) -> dict[str, object]:
    return {
        "target_language": target_language,
        "target_text": target_text,
        "padding_seconds": padding_seconds,
        "reference_audio_duration": reference_audio_duration,
        "attempt_audio_duration": attempt_audio_duration,
        "reference_asr": reference_asr,
        "attempt_asr": attempt_asr,
    }


def validate_practice_llm_result(
    value: object,
    input_payload: dict[str, object],
) -> dict[str, object]:
    if not isinstance(value, dict):
        raise PracticeLlmError("response is not an object", stage="validate_response")
    result = deepcopy(value)
    if result.get("schema_version") != 1:
        raise PracticeLlmError("unsupported schema_version", stage="validate_response")
    _validate_score(result.get("overall_score"), "overall_score")
    if not isinstance(result.get("overall_comment"), str):
        raise PracticeLlmError("overall_comment is invalid", stage="validate_response")
    phrases = result.get("phrases")
    if not isinstance(phrases, list) or not phrases:
        raise PracticeLlmError("phrases is empty", stage="validate_response")

    expected_indices = list(range(len(phrases)))
    indices = [phrase.get("phrase_index") if isinstance(phrase, dict) else None for phrase in phrases]
    if indices != expected_indices:
        raise PracticeLlmError("phrase_index must be sequential", stage="validate_response")
    if "".join(str(phrase.get("target_text") or "") for phrase in phrases) != str(
        input_payload.get("target_text") or ""
    ):
        raise PracticeLlmError("target phrases do not reconstruct target_text", stage="validate_response")

    padding = _required_finite_number(input_payload.get("padding_seconds"), "padding_seconds")
    for phrase in phrases:
        if not isinstance(phrase, dict) or not str(phrase.get("target_text") or ""):
            raise PracticeLlmError("phrase is invalid", stage="validate_response")
        _validate_score(phrase.get("score"), "phrase score")
        if not isinstance(phrase.get("comment"), str):
            raise PracticeLlmError("phrase comment is invalid", stage="validate_response")
        _validate_range(
            phrase.get("reference"),
            input_payload.get("reference_asr"),
            duration=input_payload.get("reference_audio_duration"),
            padding=padding,
            label="reference",
        )
        _validate_range(
            phrase.get("attempt"),
            input_payload.get("attempt_asr"),
            duration=input_payload.get("attempt_audio_duration"),
            padding=padding,
            label="attempt",
        )
    return result


def _validate_score(value: object, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
        raise PracticeLlmError(f"{label} is invalid", stage="validate_response")


def _validate_range(
    value: object,
    asr_value: object,
    *,
    duration: object,
    padding: float,
    label: str,
) -> None:
    if not isinstance(value, dict) or not isinstance(asr_value, dict):
        raise PracticeLlmError(f"{label} range is invalid", stage="validate_response")
    words = asr_value.get("words")
    if not isinstance(words, list):
        raise PracticeLlmError(f"{label} words are invalid", stage="validate_response")
    status = value.get("status")
    start_index = value.get("word_start_index")
    end_index = value.get("word_end_index")
    if status == "missing":
        if start_index is not None or end_index is not None:
            raise PracticeLlmError(f"{label} missing range has word indexes", stage="validate_response")
        value["matched_text"] = ""
        value["start"] = None
        value["end"] = None
        value["playback_start"] = None
        value["playback_end"] = None
        return
    if status not in {"assigned", "partial"}:
        raise PracticeLlmError(f"{label} status is invalid", stage="validate_response")

    if (
        isinstance(start_index, bool)
        or isinstance(end_index, bool)
        or not isinstance(start_index, int)
        or not isinstance(end_index, int)
        or start_index < 0
        or end_index <= start_index
        or end_index > len(words)
    ):
        raise PracticeLlmError(f"{label} word range is invalid", stage="validate_response")
    selected = words[start_index:end_index]
    if not selected or any(not isinstance(word, dict) for word in selected):
        raise PracticeLlmError(f"{label} selected words are invalid", stage="validate_response")

    # start/end/playback_start/playback_end はword_start_index/word_end_indexが決まれば
    # 一意に定まる値なので、LLMには転記させずここで直接計算する。LLMによる四則演算の
    # 取りこぼしで比較結果全体が失敗する事態を避けるための設計。
    start = _required_finite_number(selected[0].get("start"), f"{label} word start")
    end = _required_finite_number(selected[-1].get("end"), f"{label} word end")
    audio_duration = _required_finite_number(duration, f"{label} audio duration")
    playback_start = max(0.0, start - padding)
    playback_end = min(audio_duration, end + padding)
    if playback_end <= playback_start:
        raise PracticeLlmError(f"{label} playback range is empty", stage="validate_response")

    value["matched_text"] = "".join(str(word.get("text") or "") for word in selected)
    value["start"] = start
    value["end"] = end
    value["playback_start"] = playback_start
    value["playback_end"] = playback_end


def _required_finite_number(value: object, label: str) -> float:
    if isinstance(value, bool):
        raise PracticeLlmError(f"{label} is invalid", stage="validate_response")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise PracticeLlmError(f"{label} is invalid", stage="validate_response") from exc
    if not math.isfinite(number):
        raise PracticeLlmError(f"{label} is invalid", stage="validate_response")
    return number


def comparison_alignments_from_llm_result(
    result: dict[str, object],
) -> tuple[dict[str, object], dict[str, object]]:
    phrases = result["phrases"]
    if not isinstance(phrases, list):
        raise PracticeLlmError("phrases is invalid", stage="validate_response")
    attempt = _playback_alignment(phrases, "attempt")
    reference = _playback_alignment(phrases, "reference")
    return attempt, reference


def _playback_alignment(phrases: list[object], side: str) -> dict[str, object]:
    playback_phrases: list[dict[str, object]] = []
    for phrase in phrases:
        if not isinstance(phrase, dict) or not isinstance(phrase.get(side), dict):
            raise PracticeLlmError(f"{side} phrase is invalid", stage="validate_response")
        selected = phrase[side]
        available = selected.get("status") != "missing"
        playback_phrases.append(
            {
                "index": phrase["phrase_index"],
                "target_text": phrase["target_text"],
                "available": available,
                "audio_start": selected.get("playback_start"),
                "audio_end": selected.get("playback_end"),
                "matched_text": selected.get("matched_text"),
                "status": selected.get("status"),
            }
        )
    playable = sum(phrase["available"] is True for phrase in playback_phrases)
    complete = playable == len(playback_phrases)
    return {
        "alignment_contract_version": 2,
        "outcome": "evaluated",
        "available": playable > 0,
        "target_phrase_count": len(playback_phrases),
        "playable_phrase_count": playable,
        "all_phrases_playable": complete,
        "complete": complete,
        "phrases": playback_phrases,
    }


class PracticeLlmService:
    def __init__(
        self,
        *,
        client: object | None = None,
        log_dir: Path | None = None,
        pricing: dict[str, dict[str, float]] | None = None,
    ) -> None:
        self._client = client
        self._log_dir = log_dir or Path(
            os.getenv("MO_PRACTICE_LLM_LOG_DIR", "tmp/practice-llm-alignment")
        ).expanduser()
        self._pricing = pricing if pricing is not None else _pricing_from_env()

    def evaluate(
        self,
        *,
        model: str,
        input_payload: dict[str, object],
    ) -> PracticeLlmEvaluation:
        selected_model = supported_practice_comparison_model(model)
        started = perf_counter()
        log: dict[str, object] = {
            "log_version": 1,
            "created_at": datetime.now(UTC).isoformat(),
            "status": "running",
            "request": {
                "model": selected_model,
                "prompt": PRACTICE_LLM_PROMPT,
                "input": input_payload,
                "schema": PRACTICE_LLM_RESULT_SCHEMA,
            },
            "response": None,
            "final_result": None,
            "billing": None,
            "elapsed_ms": None,
            "failure": None,
        }
        log_path = self._next_log_path()
        stage = "call_api"
        try:
            response = self._load_client().responses.create(
                model=selected_model,
                instructions=PRACTICE_LLM_PROMPT,
                input=json.dumps(input_payload, ensure_ascii=False, separators=(",", ":")),
                text={
                    "format": {
                        "type": "json_schema",
                        "name": "speakloop_practice_comparison",
                        "strict": True,
                        "schema": PRACTICE_LLM_RESULT_SCHEMA,
                    }
                },
            )
            output_text = str(getattr(response, "output_text", "") or "")
            usage = _usage_dict(getattr(response, "usage", None))
            estimated_cost = _estimated_cost_usd(selected_model, usage, self._pricing)
            log["response"] = {
                "raw": _response_dump(response),
                "output_text": output_text,
                "parsed": None,
            }
            log["billing"] = {
                "usage": usage,
                "unit_prices_usd_per_million_tokens": self._pricing.get(selected_model),
                "estimated_cost_usd": estimated_cost,
            }
            stage = "parse_response"
            parsed = json.loads(output_text)
            log["response"]["parsed"] = parsed
            stage = "validate_response"
            result = validate_practice_llm_result(parsed, input_payload)
            elapsed_ms = (perf_counter() - started) * 1000
            log.update(
                {
                    "status": "succeeded",
                    "final_result": result,
                    "elapsed_ms": elapsed_ms,
                }
            )
            self._write_log(log_path, log)
            return PracticeLlmEvaluation(
                result=result,
                usage=usage,
                estimated_cost_usd=estimated_cost,
                elapsed_ms=elapsed_ms,
                log_path=log_path,
            )
        except PracticeLlmError as exc:
            self._write_failure(log_path, log, started, exc.stage, exc)
            raise
        except Exception as exc:
            self._write_failure(log_path, log, started, stage, exc)
            raise PracticeLlmError(str(exc), stage=stage) from exc

    def _load_client(self):
        if self._client is None:
            try:
                from openai import OpenAI
            except ImportError as exc:
                raise PracticeLlmError("openai package is not installed", stage="call_api") from exc
            self._client = OpenAI()
        return self._client

    def _next_log_path(self) -> Path:
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        return self._log_dir / f"{stamp}-{uuid4().hex[:8]}.json"

    def _write_failure(
        self,
        path: Path,
        log: dict[str, object],
        started: float,
        stage: str,
        error: Exception,
    ) -> None:
        log.update(
            {
                "status": "failed",
                "elapsed_ms": (perf_counter() - started) * 1000,
                "failure": {
                    "stage": stage,
                    "error_type": type(error).__name__,
                    "detail": str(error),
                    "fallback_to_legacy": False,
                },
            }
        )
        self._write_log(path, log)

    def _write_log(self, path: Path, value: dict[str, object]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n",
            encoding="utf-8",
        )


def _usage_dict(value: object) -> dict[str, int]:
    def read(source: object, key: str) -> int:
        raw = source.get(key) if isinstance(source, dict) else getattr(source, key, 0)
        try:
            return int(raw or 0)
        except (TypeError, ValueError):
            return 0

    input_details = (
        value.get("input_tokens_details")
        if isinstance(value, dict)
        else getattr(value, "input_tokens_details", None)
    )
    output_details = (
        value.get("output_tokens_details")
        if isinstance(value, dict)
        else getattr(value, "output_tokens_details", None)
    )
    return {
        "input_tokens": read(value, "input_tokens"),
        "cached_input_tokens": read(input_details, "cached_tokens"),
        "cache_write_tokens": read(input_details, "cache_write_tokens"),
        "output_tokens": read(value, "output_tokens"),
        "reasoning_tokens": read(output_details, "reasoning_tokens"),
        "total_tokens": read(value, "total_tokens"),
    }


def _pricing_from_env() -> dict[str, dict[str, float]]:
    raw = os.getenv("MO_PRACTICE_LLM_PRICING_JSON", "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    pricing: dict[str, dict[str, float]] = {}
    for model, rates in parsed.items():
        if not isinstance(rates, dict):
            continue
        try:
            pricing[str(model)] = {
                "input_per_million": float(rates["input_per_million"]),
                "cached_input_per_million": float(rates["cached_input_per_million"]),
                "output_per_million": float(rates["output_per_million"]),
            }
        except (KeyError, TypeError, ValueError):
            continue
    return pricing


def _estimated_cost_usd(
    model: str,
    usage: dict[str, int],
    pricing: dict[str, dict[str, float]],
) -> float | None:
    rates = pricing.get(model)
    if not rates:
        return None
    cached = min(usage["input_tokens"], usage["cached_input_tokens"])
    uncached = max(0, usage["input_tokens"] - cached)
    cost = (
        uncached * rates["input_per_million"]
        + cached * rates["cached_input_per_million"]
        + usage["output_tokens"] * rates["output_per_million"]
    ) / 1_000_000
    return cost


def _response_dump(response: object) -> object:
    dump = getattr(response, "model_dump", None)
    if callable(dump):
        return dump(mode="json")
    if isinstance(response, (dict, list, str, int, float, bool)) or response is None:
        return response
    return str(response)
