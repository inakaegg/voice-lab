from __future__ import annotations

import re
import unicodedata

from opencc import OpenCC
from difflib import SequenceMatcher


PRACTICE_TARGET_LANGUAGES = {
    "ja-JP": {"label": "日本語", "speech_name": "Japanese"},
    "zh-CN": {"label": "中文", "speech_name": "Mandarin Chinese"},
    "en-US": {"label": "English", "speech_name": "English"},
}

PRACTICE_GRADE_LABELS = {
    "perfect": "できました",
    "ok": "いいかんじ",
    "almost": "まあまあ",
    "retry": "もう一回",
}
_CHINESE_TRADITIONAL_TO_SIMPLIFIED = OpenCC("t2s")


def simplify_chinese_text(text: str) -> str:
    return _CHINESE_TRADITIONAL_TO_SIMPLIFIED.convert(str(text or ""))


def supported_practice_target_language(value: str | None) -> str:
    language = str(value or "ja-JP")
    if language not in PRACTICE_TARGET_LANGUAGES:
        raise ValueError(f"unsupported practice target language: {language}")
    return language


def normalize_practice_text(text: str, target_language: str) -> str:
    normalized = unicodedata.normalize("NFKC", str(text or "")).strip().lower()
    if target_language == "ja-JP":
        normalized = _katakana_to_hiragana(normalized)
    if target_language == "zh-CN":
        normalized = simplify_chinese_text(normalized)
    return "".join(
        char
        for char in normalized
        if not unicodedata.category(char).startswith(("P", "Z", "S"))
    )


def evaluate_practice_attempt(target_text: str, recognized_text: str, target_language: str) -> dict[str, object]:
    language = supported_practice_target_language(target_language)
    normalized_target = normalize_practice_text(target_text, language)
    normalized_recognized = normalize_practice_text(recognized_text, language)
    global_similarity = practice_similarity(normalized_target, normalized_recognized)
    phrase_matches = practice_phrase_matches(target_text, recognized_text, language)
    phrase_similarity = practice_phrase_similarity(phrase_matches)
    similarity = max(global_similarity, phrase_similarity)
    grade = practice_grade(similarity)
    return {
        "normalized_target": normalized_target,
        "normalized_recognized": normalized_recognized,
        "global_similarity": round(global_similarity, 3),
        "phrase_similarity": round(phrase_similarity, 3),
        "similarity": round(similarity, 3),
        "grade": grade,
        "grade_label": PRACTICE_GRADE_LABELS[grade],
        "diff": practice_diff(normalized_target, normalized_recognized),
        "phrase_matches": phrase_matches,
    }


def practice_similarity(normalized_target: str, normalized_recognized: str) -> float:
    if not normalized_target and not normalized_recognized:
        return 1.0
    if not normalized_target or not normalized_recognized:
        return 0.0
    if normalized_target == normalized_recognized:
        return 1.0
    sequence_score = SequenceMatcher(None, normalized_target, normalized_recognized).ratio()
    if normalized_target in normalized_recognized or normalized_recognized in normalized_target:
        shorter = min(len(normalized_target), len(normalized_recognized))
        longer = max(len(normalized_target), len(normalized_recognized))
        containment_score = shorter / longer
        sequence_score = max(sequence_score, containment_score)
    return max(0.0, min(1.0, sequence_score))


def practice_grade(similarity: float) -> str:
    if similarity >= 0.995:
        return "perfect"
    if similarity >= 0.95:
        return "ok"
    if similarity >= 0.90:
        return "almost"
    return "retry"


def practice_diff(normalized_target: str, normalized_recognized: str) -> list[dict[str, str]]:
    matcher = SequenceMatcher(None, normalized_target, normalized_recognized)
    diff: list[dict[str, str]] = []
    for tag, target_start, target_end, recognized_start, recognized_end in matcher.get_opcodes():
        diff.append(
            {
                "type": tag,
                "target": normalized_target[target_start:target_end],
                "recognized": normalized_recognized[recognized_start:recognized_end],
                "target_start": target_start,
                "target_end": target_end,
                "recognized_start": recognized_start,
                "recognized_end": recognized_end,
            }
        )
    return diff


def split_practice_phrases(text: str) -> list[str]:
    normalized = str(text or "").replace("\r", "\n").strip()
    if not normalized:
        return []
    phrases = [match.group(0).strip() for match in re.finditer(r"[^。！？!?.,，、；;：:\n]+[。！？!?.,，、；;：:]?", normalized)]
    return [phrase for phrase in phrases if phrase]


def practice_phrase_matches(target_text: str, recognized_text: str, target_language: str) -> list[dict[str, object]]:
    language = supported_practice_target_language(target_language)
    recognized_normalized = normalize_practice_text(recognized_text, language)
    cursor = 0
    matches: list[dict[str, object]] = []
    for index, phrase in enumerate(split_practice_phrases(target_text)):
        target_normalized = normalize_practice_text(phrase, language)
        match = _best_practice_phrase_match(target_normalized, recognized_normalized, cursor)
        similarity = match["similarity"]
        matched = bool(target_normalized) and similarity >= 0.45
        if matched:
            cursor = int(match["recognized_end"])
        matches.append(
            {
                "index": index,
                "target": phrase,
                "normalized_target": target_normalized,
                "recognized_start": int(match["recognized_start"]),
                "recognized_end": int(match["recognized_end"]),
                "normalized_recognized": recognized_normalized[
                    int(match["recognized_start"]) : int(match["recognized_end"])
                ],
                "similarity": round(similarity, 3),
                "matched": matched,
            }
        )
    return matches


def practice_phrase_similarity(matches: list[dict[str, object]]) -> float:
    weighted_total = 0.0
    weight_sum = 0
    for match in matches:
        weight = len(str(match.get("normalized_target") or ""))
        if weight <= 0:
            continue
        weighted_total += weight * float(match.get("similarity") or 0.0)
        weight_sum += weight
    if weight_sum == 0:
        return 0.0
    return max(0.0, min(1.0, weighted_total / weight_sum))


def practice_comparison_alignment(
    *,
    target_text: str,
    recognized_text: str,
    target_language: str,
    asr_timestamps: object | None,
) -> dict[str, object]:
    """Map target-side phrases to ASR timestamp ranges for comparison playback.

    This is intentionally target-driven. ASR punctuation is often missing or
    shifted, so splitting the recognized transcript first is too fragile for
    phrase playback.
    """

    language = supported_practice_target_language(target_language)
    phrases = _comparison_target_phrases(target_text, language)
    timestamp_data = asr_timestamps if isinstance(asr_timestamps, dict) else {}
    word_spans, recognized_normalized = _asr_word_spans(timestamp_data.get("words"), language)

    if word_spans and recognized_normalized:
        ranges = _align_phrases_to_word_spans(phrases, recognized_normalized, word_spans, language)
        complete = bool(ranges) and all(bool(entry["available"]) for entry in ranges)
        return {
            "available": any(bool(entry["available"]) for entry in ranges),
            "complete": complete,
            "mode": "target_phrase_word_alignment",
            "reason": "" if complete else "some target phrases could not be mapped to reliable word timestamps",
            "target_language": language,
            "recognized_normalized": recognized_normalized,
            "target_phrase_count": len(phrases),
            "ranges": ranges,
        }

    segments = _asr_segments(timestamp_data.get("segments"))
    if phrases and len(segments) == len(phrases):
        ranges = []
        for index, (phrase, segment) in enumerate(zip(phrases, segments)):
            segment_text = str(segment.get("text") or "")
            similarity = practice_similarity(
                str(phrase["normalized_target"]),
                normalize_practice_text(segment_text, language),
            )
            available = similarity >= 0.45
            ranges.append(
                {
                    "index": index,
                    "source_index": phrase["source_index"],
                    "target": phrase["target"],
                    "normalized_target": phrase["normalized_target"],
                    "available": available,
                    "matched": available,
                    "source": "segments",
                    "similarity": round(similarity, 3),
                    "coverage": 1.0 if available else 0.0,
                    "recognized_start": None,
                    "recognized_end": None,
                    "normalized_recognized": normalize_practice_text(segment_text, language),
                    "matched_text": segment_text,
                    "audio_start": segment["start"] if available else None,
                    "audio_end": segment["end"] if available else None,
                }
            )
        complete = all(bool(entry["available"]) for entry in ranges)
        return {
            "available": any(bool(entry["available"]) for entry in ranges),
            "complete": complete,
            "mode": "target_phrase_segment_fallback",
            "reason": "word timestamps were unavailable; segment count matched target phrase count",
            "target_language": language,
            "recognized_normalized": normalize_practice_text(recognized_text, language),
            "target_phrase_count": len(phrases),
            "ranges": ranges,
        }

    return {
        "available": False,
        "complete": False,
        "mode": "unavailable",
        "reason": "word timestamps were unavailable and segments could not be mapped safely",
        "target_language": language,
        "recognized_normalized": normalize_practice_text(recognized_text, language),
        "target_phrase_count": len(phrases),
        "ranges": [
            {
                "index": index,
                "source_index": phrase["source_index"],
                "target": phrase["target"],
                "normalized_target": phrase["normalized_target"],
                "available": False,
                "matched": False,
                "source": "none",
                "similarity": 0.0,
                "coverage": 0.0,
                "recognized_start": None,
                "recognized_end": None,
                "normalized_recognized": "",
                "matched_text": "",
                "audio_start": None,
                "audio_end": None,
            }
            for index, phrase in enumerate(phrases)
        ],
    }


def _best_practice_phrase_match(target_normalized: str, recognized_normalized: str, start_index: int) -> dict[str, float]:
    if not target_normalized or not recognized_normalized or start_index >= len(recognized_normalized):
        start = min(max(0, start_index), len(recognized_normalized))
        return {"recognized_start": start, "recognized_end": start, "similarity": 0.0}
    best = {"recognized_start": start_index, "recognized_end": start_index, "similarity": 0.0}
    expected_length = len(target_normalized)
    best_length_delta = float("inf")
    min_length = max(1, int(expected_length * 0.45))
    max_length = max(min_length, int(expected_length * 1.8) + 3)
    for start in range(start_index, len(recognized_normalized)):
        last_end = min(len(recognized_normalized), start + max_length)
        for end in range(start + min_length, last_end + 1):
            candidate = recognized_normalized[start:end]
            similarity = practice_similarity(target_normalized, candidate)
            length_delta = abs(len(candidate) - expected_length)
            is_better_similarity = similarity > best["similarity"] + 1e-9
            is_equal_similarity_better_length = (
                abs(similarity - best["similarity"]) <= 1e-9 and length_delta < best_length_delta
            )
            if is_better_similarity or is_equal_similarity_better_length:
                best = {"recognized_start": start, "recognized_end": end, "similarity": similarity}
                best_length_delta = length_delta
            if similarity >= 0.999:
                return best
    return best


def _comparison_target_phrases(target_text: str, target_language: str) -> list[dict[str, object]]:
    phrases: list[dict[str, object]] = []
    for source_index, phrase in enumerate(split_practice_phrases(target_text)):
        normalized = normalize_practice_text(phrase, target_language)
        if not normalized or _is_comparison_label_phrase(phrase, normalized):
            continue
        phrases.append(
            {
                "source_index": source_index,
                "target": phrase,
                "normalized_target": normalized,
            }
        )
    return phrases


def _is_comparison_label_phrase(phrase: str, normalized: str) -> bool:
    label = str(phrase or "").strip().rstrip("：:")
    if not label:
        return True
    if re.fullmatch(r"(?i:speaker\s*\d+|[a-z]\d*|\d+)", label):
        return True
    return len(normalized) <= 2 and phrase.strip().endswith((":", "："))


def _asr_word_spans(words: object, target_language: str) -> tuple[list[dict[str, object]], str]:
    if not isinstance(words, list):
        return [], ""

    spans: list[dict[str, object]] = []
    normalized_pieces: list[str] = []
    cursor = 0
    for item in words:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or item.get("word") or "").strip()
        start = _safe_float(item.get("start"))
        end = _safe_float(item.get("end"))
        normalized = normalize_practice_text(text, target_language)
        if not normalized or start is None or end is None or end <= start:
            continue
        normalized_pieces.append(normalized)
        span_end = cursor + len(normalized)
        spans.append(
            {
                "text": text,
                "normalized": normalized,
                "normalized_start": cursor,
                "normalized_end": span_end,
                "audio_start": start,
                "audio_end": end,
            }
        )
        cursor = span_end
    return spans, "".join(normalized_pieces)


def _asr_segments(segments: object) -> list[dict[str, object]]:
    if not isinstance(segments, list):
        return []
    normalized: list[dict[str, object]] = []
    for item in segments:
        if not isinstance(item, dict):
            continue
        start = _safe_float(item.get("start"))
        end = _safe_float(item.get("end"))
        if start is None or end is None or end <= start:
            continue
        normalized.append(
            {
                "text": str(item.get("text") or ""),
                "start": start,
                "end": end,
            }
        )
    return normalized


def _align_phrases_to_word_spans(
    phrases: list[dict[str, object]],
    recognized_normalized: str,
    word_spans: list[dict[str, object]],
    target_language: str,
) -> list[dict[str, object]]:
    cursor = 0
    ranges: list[dict[str, object]] = []
    for index, phrase in enumerate(phrases):
        normalized_target = str(phrase["normalized_target"])
        match = _best_practice_phrase_match(normalized_target, recognized_normalized, cursor)
        start = int(match["recognized_start"])
        end = int(match["recognized_end"])
        similarity = float(match["similarity"])
        coverage = (end - start) / len(normalized_target) if normalized_target else 0.0
        matched = bool(normalized_target) and similarity >= 0.45 and coverage >= 0.50
        overlapping = _overlapping_word_spans(word_spans, start, end) if matched else []
        available = bool(overlapping)
        if available:
            cursor = max(cursor, int(overlapping[-1]["normalized_end"]))
        ranges.append(
            {
                "index": index,
                "source_index": phrase["source_index"],
                "target": phrase["target"],
                "normalized_target": normalized_target,
                "available": available,
                "matched": matched,
                "source": "words" if available else "none",
                "similarity": round(similarity, 3),
                "coverage": round(coverage, 3),
                "recognized_start": start if available else None,
                "recognized_end": end if available else None,
                "normalized_recognized": recognized_normalized[start:end] if available else "",
                "matched_text": _join_matched_words(overlapping, target_language) if available else "",
                "audio_start": overlapping[0]["audio_start"] if available else None,
                "audio_end": overlapping[-1]["audio_end"] if available else None,
            }
        )
    return ranges


def _overlapping_word_spans(
    word_spans: list[dict[str, object]],
    normalized_start: int,
    normalized_end: int,
) -> list[dict[str, object]]:
    return [
        span
        for span in word_spans
        if int(span["normalized_end"]) > normalized_start and int(span["normalized_start"]) < normalized_end
    ]


def _join_matched_words(word_spans: list[dict[str, object]], target_language: str) -> str:
    words = [str(span.get("text") or "") for span in word_spans if str(span.get("text") or "")]
    if target_language in {"ja-JP", "zh-CN"}:
        return "".join(words)
    return " ".join(words)


def _safe_float(value: object) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _is_han_character(char: str) -> bool:
    if not char:
        return False
    codepoint = ord(char[0])
    return (
        0x3400 <= codepoint <= 0x4DBF
        or 0x4E00 <= codepoint <= 0x9FFF
        or 0x20000 <= codepoint <= 0x2A6DF
        or 0x2A700 <= codepoint <= 0x2B73F
        or 0x2B740 <= codepoint <= 0x2B81F
        or 0x2B820 <= codepoint <= 0x2CEAF
    )


def _katakana_to_hiragana(text: str) -> str:
    return re.sub(
        r"[\u30a1-\u30f6]",
        lambda match: chr(ord(match.group(0)) - 0x60),
        text,
    )
