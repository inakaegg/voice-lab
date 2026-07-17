from __future__ import annotations

import re
import unicodedata
from math import floor, isfinite
from time import perf_counter

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
_EDGE_FILLERS = {
    "en-US": {"ah", "er", "erm", "hmm", "mm", "uh", "um", "well"},
    "ja-JP": {"あの", "ええと", "えっと", "えー", "うーん"},
    "zh-CN": {"啊", "呃", "额", "嗯", "唔"},
}
_BOUNDARY_FILLER_SEQUENCES = {
    "en-US": {"youknow", "letmethink", "youknowletmethink"},
    "ja-JP": {"あの", "ええと", "えっと", "ちょっとまって"},
    "zh-CN": {"那个", "我想一下", "那个我想一下"},
}
_NON_SPECIFIC_ALIGNMENT_PIECES = {
    "en-US": {"a", "an", "finally", "next", "please", "the", "then"},
    "ja-JP": {"そして", "それから", "つぎ", "次", "最後"},
    "zh-CN": {"然后", "最后", "接着", "再", "先", "请", "把"},
}
_DIAGNOSTIC_STOP_PIECES = {
    "en-US": {
        "a", "an", "and", "are", "at", "finally", "for", "from", "i", "in",
        "is", "it", "my", "next", "of", "on", "or", "please", "the", "then",
        "to", "was", "were", "with", "your",
    },
    "ja-JP": {"そして", "それから", "つぎ", "次", "最後", "私", "を", "が", "に", "で", "は"},
    "zh-CN": {"然后", "最后", "接着", "再", "先", "请", "把", "我", "你", "的", "到", "在", "上", "下", "要", "还要"},
}
_HIGH_CONFIDENCE_ALIGNMENT_THRESHOLD = 0.75
_PAUSE_PARTITION_GAP_SECONDS = 0.18
_DETACHED_SPEECH_GAP_SECONDS = 0.65
_MAX_ALIGNMENT_CANDIDATES_PER_PHRASE = 4096
_MAX_CANONICAL_TARGET_PHRASES = 16
_MAX_CANONICAL_TIMESTAMP_UNITS = 256
_MAX_CANONICAL_ALIGNMENT_COMPLEXITY = 1024
_PRACTICE_HARD_BOUNDARIES = frozenset("。！？!?；;\n")
_PRACTICE_CLOSING_PUNCTUATION = frozenset("\"'”’」』】）》）)]}")
_PRACTICE_PROTECTED_ABBREVIATIONS = frozenset(
    {"dr", "jr", "mr", "mrs", "ms", "prof", "sr", "st"}
)
_ENGLISH_SMALL_NUMBERS = (
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
)
_ENGLISH_TENS = ("", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety")
_CHINESE_DIGITS = ("零", "一", "二", "三", "四", "五", "六", "七", "八", "九")
_CHINESE_SMALL_NUMBER_UNITS = ("", "十", "百", "千")
_CHINESE_LARGE_NUMBER_UNITS = ("", "万", "亿", "兆", "京", "垓", "秭", "穰", "沟", "涧", "正", "载")


class PracticeAlignmentError(ValueError):
    def __init__(
        self,
        reason: str,
        *,
        stage: str = "attempt_asr",
        retryable: bool = True,
    ) -> None:
        self.error_code = "practice_alignment_provider_contract_error"
        self.reason = reason
        self.stage = stage
        self.retryable = retryable
        super().__init__(reason)


class PracticeAlignmentInputError(ValueError):
    def __init__(self, reason: str) -> None:
        self.error_code = "practice_alignment_invalid_input"
        self.reason = reason
        self.stage = "input"
        self.retryable = False
        super().__init__(reason)


def _round_score(value: float) -> float:
    return floor(max(0.0, value) * 1000 + 0.5) / 1000


def _raw_timestamp_count(value: object, rows: object) -> int:
    fallback = len(rows) if isinstance(rows, list) else 0
    try:
        parsed = int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return fallback
    return parsed if parsed > 0 else fallback


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
        normalized = _normalize_chinese_spoken_forms(normalized)
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
    phrase_macro_similarity = practice_phrase_macro_similarity(phrase_matches)
    lowest_phrase_similarity = min(
        (float(match.get("similarity") or 0.0) for match in phrase_matches),
        default=global_similarity,
    )
    similarity = min(global_similarity, phrase_macro_similarity)
    grade = practice_grade(similarity)
    return {
        "normalized_target": normalized_target,
        "normalized_recognized": normalized_recognized,
        "global_similarity": _round_score(global_similarity),
        "phrase_similarity": _round_score(phrase_similarity),
        "phrase_macro_similarity": _round_score(phrase_macro_similarity),
        "lowest_phrase_similarity": _round_score(lowest_phrase_similarity),
        "similarity": _round_score(similarity),
        "grade": grade,
        "grade_label": PRACTICE_GRADE_LABELS[grade],
        "diff": practice_diff(normalized_target, normalized_recognized),
        "phrase_matches": phrase_matches,
        "unconsumed_recognized": _practice_unconsumed_recognized(
            normalized_recognized,
            phrase_matches,
            language,
            recognized_text,
        ),
    }


def practice_similarity(normalized_target: str, normalized_recognized: str) -> float:
    if not normalized_target and not normalized_recognized:
        return 1.0
    if not normalized_target or not normalized_recognized:
        return 0.0
    if normalized_target == normalized_recognized:
        return 1.0
    sequence_score = SequenceMatcher(None, normalized_target, normalized_recognized, autojunk=False).ratio()
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
    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return []

    phrases: list[str] = []
    buffer: list[str] = []
    index = 0
    while index < len(normalized):
        char = normalized[index]
        if char == "\n":
            _append_split_phrase(phrases, buffer)
            buffer = []
            index += 1
            continue

        buffer.append(char)
        is_boundary = char in _PRACTICE_HARD_BOUNDARIES
        if char == ".":
            is_boundary = not _is_protected_phrase_period(normalized, index)
        if not is_boundary:
            index += 1
            continue

        index += 1
        while index < len(normalized):
            suffix = normalized[index]
            if suffix in _PRACTICE_HARD_BOUNDARIES or suffix == "." or suffix in _PRACTICE_CLOSING_PUNCTUATION:
                buffer.append(suffix)
                index += 1
                continue
            break
        _append_split_phrase(phrases, buffer)
        buffer = []

    _append_split_phrase(phrases, buffer)
    return phrases


def _append_split_phrase(phrases: list[str], buffer: list[str]) -> None:
    phrase = "".join(buffer).strip()
    if phrase and any(unicodedata.category(char)[0] in {"L", "M", "N"} for char in phrase):
        phrases.append(phrase)


def _is_protected_phrase_period(text: str, index: int) -> bool:
    previous = text[index - 1] if index > 0 else ""
    following = text[index + 1] if index + 1 < len(text) else ""
    if previous == "." or following == ".":
        return True
    if previous.isdigit() and following.isdigit():
        return True

    token_start = index
    while token_start > 0 and not text[token_start - 1].isspace():
        token_start -= 1
    token_end = index + 1
    while token_end < len(text) and not text[token_end].isspace():
        token_end += 1
    token = text[token_start:token_end]
    position = index - token_start
    if "@" in token and position + 1 < len(token) and token[position + 1].isalnum():
        return True
    if token.lower().startswith(("http://", "https://", "www.")) and position + 1 < len(token):
        return token[position + 1] not in _PRACTICE_HARD_BOUNDARIES

    word_start = index
    while word_start > 0 and text[word_start - 1].isalpha():
        word_start -= 1
    abbreviation = text[word_start:index].lower()
    has_following_word = any(not char.isspace() for char in text[index + 1 :])
    return abbreviation in _PRACTICE_PROTECTED_ABBREVIATIONS and has_following_word


def practice_content_matches(target_text: str, matched_text: str, target_language: str) -> bool:
    language = supported_practice_target_language(target_language)
    target_for_comparison = str(target_text or "")
    matched_for_comparison = str(matched_text or "")
    if language == "en-US":
        target_for_comparison = _replace_standalone_english_numbers(target_for_comparison)
        matched_for_comparison = _replace_standalone_english_numbers(matched_for_comparison)
    matched_normalized = _normalize_practice_content_text(matched_for_comparison, language)
    if _normalize_practice_content_text(target_for_comparison, language) == matched_normalized:
        return True
    if language != "en-US":
        return False
    return any(
        _normalize_practice_content_text(candidate, language) == matched_normalized
        for candidate in _compact_identifier_variants(target_for_comparison)
    )


def _normalize_practice_content_text(text: str, target_language: str) -> str:
    normalized = unicodedata.normalize("NFKC", str(text or "")).strip().lower()
    if target_language == "zh-CN":
        normalized = _normalize_chinese_spoken_forms(normalized)
        normalized = simplify_chinese_text(normalized)
    return "".join(
        char
        for char in normalized
        if not unicodedata.category(char).startswith(("P", "Z", "S"))
    )


def _replace_standalone_english_numbers(text: str) -> str:
    pattern = re.compile(r"(?<![\w./:+-])\d{1,6}(?![\w./:+-])")

    def replacement(match: re.Match[str]) -> str:
        words = _english_integer_words(int(match.group(0)))
        return words if words is not None else match.group(0)

    return pattern.sub(replacement, unicodedata.normalize("NFKC", str(text or "")))


def _compact_identifier_variants(text: str) -> set[str]:
    source = str(text or "")
    pattern = re.compile(r"(?i)(?<![\w])([a-z]+)(\d{1,6})(?![\w])")
    matches = list(pattern.finditer(source))
    if not matches:
        return {source}
    variants = [""]
    cursor = 0
    for match in matches:
        prefix = source[cursor : match.start()]
        number = int(match.group(2))
        cardinal = _english_integer_words(number)
        digit_words = " ".join(_ENGLISH_SMALL_NUMBERS[int(digit)] for digit in match.group(2))
        replacements = [f"{match.group(1)} {digit_words}"]
        if cardinal is not None:
            replacements.append(f"{match.group(1)} {cardinal}")
        variants = [candidate + prefix + replacement for candidate in variants for replacement in replacements]
        cursor = match.end()
    return {source, *(candidate + source[cursor:] for candidate in variants)}


def _english_integer_words(value: int) -> str | None:
    if value < 0 or value > 999_999:
        return None
    if value < 20:
        return _ENGLISH_SMALL_NUMBERS[value]
    if value < 100:
        tens, remainder = divmod(value, 10)
        return _ENGLISH_TENS[tens] + (f" {_ENGLISH_SMALL_NUMBERS[remainder]}" if remainder else "")
    if value < 1_000:
        hundreds, remainder = divmod(value, 100)
        suffix = _english_integer_words(remainder) if remainder else ""
        return f"{_ENGLISH_SMALL_NUMBERS[hundreds]} hundred" + (f" {suffix}" if suffix else "")
    thousands, remainder = divmod(value, 1_000)
    prefix = _english_integer_words(thousands)
    suffix = _english_integer_words(remainder) if remainder else ""
    return f"{prefix} thousand" + (f" {suffix}" if suffix else "")


def _normalize_chinese_spoken_forms(text: str) -> str:
    source = str(text or "")
    source = re.sub(r"(?<![a-z0-9.])[-−](?=\d)", "负", source)
    protected: list[str] = []

    def protect(pattern: str, replacement) -> None:
        nonlocal source

        def store(match: re.Match[str]) -> str:
            protected.append(str(replacement(match)))
            return chr(0xE000 + len(protected) - 1)

        source = re.sub(pattern, store, source, flags=re.IGNORECASE)

    protect(
        r"(?<![a-z0-9.])(\d+(?:\.\d+)?)\s*(?:°\s*c|℃)",
        lambda match: f"{_chinese_decimal_words(match.group(1))}度",
    )
    protect(
        r"(?<![a-z0-9.])(\d+(?:\.\d+)?)\s*%",
        lambda match: f"百分之{_chinese_decimal_words(match.group(1))}",
    )
    protect(
        r"(?<![a-z0-9])([01]?\d|2[0-3]):([0-5]\d)(?!\d)",
        lambda match: (
            f"{_chinese_integer_words(str(int(match.group(1))))}点"
            f"{'' if int(match.group(2)) == 0 else _chinese_integer_words(match.group(2))}"
        ),
    )
    protect(
        r"(?<![a-z0-9])(\d{4})(?=年)",
        lambda match: _chinese_digit_words(match.group(1)),
    )
    protect(
        r"(?<![a-z0-9])(v)(\d+(?:\.\d+)+)(?![a-z0-9])",
        lambda match: f"{match.group(1).lower()}{_chinese_version_words(match.group(2))}",
    )
    protect(
        r"(?<![a-z0-9])([a-z]+)(\d+)(?![a-z0-9])",
        lambda match: f"{match.group(1).lower()}{_chinese_digit_words(match.group(2))}",
    )
    source = re.sub(
        r"(?<![a-z0-9.])(\d+)\.(\d+)(?![a-z0-9.])",
        lambda match: f"{_chinese_integer_words(match.group(1))}点{_chinese_digit_words(match.group(2))}",
        source,
    )
    source = re.sub(
        r"(?<![a-z0-9])(\d+)(?![a-z0-9])",
        lambda match: _chinese_integer_words(match.group(1)),
        source,
    )
    for index, value in enumerate(protected):
        source = source.replace(chr(0xE000 + index), value)
    return source


def _chinese_decimal_words(value: str) -> str:
    integer, separator, fraction = str(value).partition(".")
    result = _chinese_integer_words(integer)
    if separator:
        result += f"点{_chinese_digit_words(fraction)}"
    return result


def _chinese_version_words(value: str) -> str:
    first, *remaining = str(value).split(".")
    components = [_chinese_integer_words(first)]
    components.extend(_chinese_digit_words(component) for component in remaining)
    return "点".join(components)


def _chinese_digit_words(value: str) -> str:
    return "".join(_CHINESE_DIGITS[int(digit)] for digit in str(value))


def _chinese_integer_words(value: str) -> str:
    digits = str(value)
    if not digits:
        return ""
    if len(digits) > 1 and digits.startswith("0"):
        return _chinese_digit_words(digits)
    number = int(digits)
    if number == 0:
        return _CHINESE_DIGITS[0]
    groups: list[int] = []
    while number:
        number, group = divmod(number, 10_000)
        groups.append(group)
    if len(groups) > len(_CHINESE_LARGE_NUMBER_UNITS):
        return _chinese_digit_words(digits)

    output: list[str] = []
    zero_pending = False
    for group_index in range(len(groups) - 1, -1, -1):
        group = groups[group_index]
        if group == 0:
            if output and any(groups[:group_index]):
                zero_pending = True
            continue
        if output and (zero_pending or group < 1_000):
            output.append(_CHINESE_DIGITS[0])
        output.append(
            f"{_chinese_small_integer_words(group)}{_CHINESE_LARGE_NUMBER_UNITS[group_index]}"
        )
        zero_pending = False
    result = "".join(output)
    return result[1:] if result.startswith("一十") else result


def _chinese_small_integer_words(number: int) -> str:
    digits = f"{number:d}"
    output: list[str] = []
    zero_pending = False
    for position, digit_text in enumerate(digits):
        digit = int(digit_text)
        unit_index = len(digits) - position - 1
        if digit == 0:
            if output and any(int(item) for item in digits[position + 1 :]):
                zero_pending = True
            continue
        if zero_pending:
            output.append(_CHINESE_DIGITS[0])
            zero_pending = False
        output.append(f"{_CHINESE_DIGITS[digit]}{_CHINESE_SMALL_NUMBER_UNITS[unit_index]}")
    return "".join(output)


def practice_phrase_matches(target_text: str, recognized_text: str, target_language: str) -> list[dict[str, object]]:
    language = supported_practice_target_language(target_language)
    recognized_normalized = normalize_practice_text(recognized_text, language)
    phrases = split_practice_phrases(target_text)
    normalized_targets = [normalize_practice_text(phrase, language) for phrase in phrases]
    cursor = 0
    matches: list[dict[str, object]] = []
    for index, (phrase, target_normalized) in enumerate(
        zip(phrases, normalized_targets, strict=True)
    ):
        exact_start = recognized_normalized.find(target_normalized, cursor)
        later_exact_starts = [
            start
            for later_target in normalized_targets[index + 1 :]
            if later_target
            for start in [recognized_normalized.find(later_target, cursor)]
            if start >= 0
        ]
        next_exact_start = min(later_exact_starts, default=-1)
        if exact_start >= 0 and (next_exact_start < 0 or exact_start <= next_exact_start):
            match = {
                "recognized_start": exact_start,
                "recognized_end": exact_start + len(target_normalized),
                "similarity": 1.0,
            }
        else:
            search_end = next_exact_start if next_exact_start >= cursor else len(recognized_normalized)
            match = _best_practice_phrase_match(
                target_normalized,
                recognized_normalized[:search_end],
                cursor,
            )
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
                "similarity": _round_score(similarity),
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


def practice_phrase_macro_similarity(matches: list[dict[str, object]]) -> float:
    if not matches:
        return 0.0
    return max(
        0.0,
        min(
            1.0,
            sum(float(match.get("similarity") or 0.0) for match in matches) / len(matches),
        ),
    )


def _practice_unconsumed_recognized(
    recognized_normalized: str,
    matches: list[dict[str, object]],
    target_language: str,
    recognized_text: str,
) -> list[dict[str, object]]:
    intervals = [
        (
            max(0, int(match.get("recognized_start") or 0)),
            min(len(recognized_normalized), int(match.get("recognized_end") or 0)),
        )
        for match in matches
        if match.get("matched")
        if int(match.get("recognized_end") or 0) > int(match.get("recognized_start") or 0)
    ]
    if target_language == "en-US":
        token_ranges = _english_normalized_token_ranges(recognized_text)
        intervals = [
            (
                min((token_start for token_start, token_end in token_ranges if token_end > start and token_start < end), default=start),
                max((token_end for token_start, token_end in token_ranges if token_end > start and token_start < end), default=end),
            )
            for start, end in intervals
        ]
    intervals.sort()
    merged: list[list[int]] = []
    for start, end in intervals:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    gaps: list[dict[str, object]] = []
    cursor = 0
    for start, end in [*merged, [len(recognized_normalized), len(recognized_normalized)]]:
        if start > cursor:
            text = recognized_normalized[cursor:start]
            if not _is_normalized_scoring_filler(text, target_language):
                gaps.append({"start": cursor, "end": start, "normalized_text": text})
        cursor = max(cursor, end)
    return gaps


def _english_normalized_token_ranges(text: str) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    cursor = 0
    for match in re.finditer(r"[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*", str(text or "")):
        normalized = normalize_practice_text(match.group(0), "en-US")
        if not normalized:
            continue
        ranges.append((cursor, cursor + len(normalized)))
        cursor += len(normalized)
    return ranges


def _is_normalized_scoring_filler(text: str, target_language: str) -> bool:
    if not text:
        return True
    fillers = {
        *(_EDGE_FILLERS.get(target_language, set())),
        *(_BOUNDARY_FILLER_SEQUENCES.get(target_language, set())),
    }
    return text in fillers


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

    alignment_started = perf_counter()
    language = supported_practice_target_language(target_language)
    phrases = _comparison_target_phrases(target_text, language)
    timestamp_data = asr_timestamps if isinstance(asr_timestamps, dict) else {}
    if timestamp_data.get("available") is False:
        raw_word_count = _raw_timestamp_count(
            timestamp_data.get("raw_timestamp_word_count"),
            timestamp_data.get("words"),
        )
        raw_segment_count = _raw_timestamp_count(
            timestamp_data.get("raw_timestamp_segment_count"),
            timestamp_data.get("segments"),
        )
        if (raw_word_count or raw_segment_count) and not normalize_practice_text(recognized_text, language):
            raise PracticeAlignmentError("contradictory_timestamp_payload")
        return _transcription_only_alignment_result(
            phrases,
            recognized_text,
            language,
            raw_word_count=raw_word_count,
            raw_segment_count=raw_segment_count,
            contradictory=bool(raw_word_count or raw_segment_count),
            elapsed_ms=(perf_counter() - alignment_started) * 1000,
        )
    word_spans, recognized_normalized, word_source = _asr_word_spans(
        timestamp_data.get("words"),
        language,
    )
    word_source["raw_count"] = _raw_timestamp_count(
        timestamp_data.get("raw_timestamp_word_count"),
        timestamp_data.get("words"),
    )
    if not word_source["source_valid"]:
        word_spans = []
        recognized_normalized = ""
    segments, segment_source = _asr_segments(timestamp_data.get("segments"))
    segment_source["raw_count"] = _raw_timestamp_count(
        timestamp_data.get("raw_timestamp_segment_count"),
        timestamp_data.get("segments"),
    )
    segments = _exclude_disjoint_segment_source(
        word_spans,
        bool(word_source["source_valid"]),
        segments,
        segment_source,
    )
    segment_source["segments"] = segments

    if word_spans and recognized_normalized:
        if len(phrases) == 1:
            ranges = [_align_single_phrase_to_word_spans(phrases[0], recognized_normalized, word_spans, language)]
            candidate_metrics = {"candidate_count": 1, "score_computation_count": 2}
        else:
            ranges, candidate_metrics = _align_phrases_to_word_spans(
                phrases,
                recognized_normalized,
                word_spans,
                language,
            )
        diagnostics = _alignment_diagnostics(
            ranges,
            phrases,
            word_spans,
            language,
            candidate_count=int(candidate_metrics["candidate_count"]),
            score_computation_count=int(candidate_metrics["score_computation_count"]),
            elapsed_ms=(perf_counter() - alignment_started) * 1000,
            source=word_source,
            segment_source=segment_source,
        )
        complete = bool(ranges) and all(bool(entry["available"]) for entry in ranges)
        if any(token["reason"] == "unexplained_internal_token" for token in diagnostics["unassigned_tokens"]):
            complete = False
        return {
            "available": any(bool(entry["available"]) for entry in ranges),
            "complete": complete,
            "mode": "target_phrase_word_alignment",
            "reason": "" if complete else "some target phrases could not be mapped to reliable word timestamps",
            "target_language": language,
            "recognized_normalized": recognized_normalized,
            "target_phrase_count": len(phrases),
            "ranges": ranges,
            "diagnostics": diagnostics,
        }

    if segment_source["raw_count"]:
        if (
            not segments or not segment_source["source_valid"]
        ) and not normalize_practice_text(recognized_text, language):
            raise PracticeAlignmentError("invalid_timestamp_payload")
        if not segments or not segment_source["source_valid"]:
            return _transcription_only_alignment_result(
                phrases,
                recognized_text,
                language,
                raw_word_count=int(word_source["raw_count"]),
                raw_segment_count=int(segment_source["raw_count"]),
                diagnostic_flags=[
                    *word_source["flags"],
                    *segment_source["flags"],
                    "invalid_timestamp_payload",
                ],
                invalid_timestamp_units=[
                    *word_source["invalid_units"],
                    *segment_source["invalid_units"],
                ],
                unassigned_timestamp_units=(
                    _primary_invalid_timestamp_units(word_source, segment_source)
                    if len(phrases) > 1
                    else []
                ),
                elapsed_ms=(perf_counter() - alignment_started) * 1000,
            )
        return _align_phrases_to_segments(
            phrases,
            segments,
            segment_source,
            recognized_text,
            language,
            elapsed_ms=(perf_counter() - alignment_started) * 1000,
            discarded_word_source=word_source,
        )

    raw_word_count = int(word_source["raw_count"])
    if raw_word_count and not normalize_practice_text(recognized_text, language):
        raise PracticeAlignmentError("invalid_timestamp_payload")
    if normalize_practice_text(recognized_text, language):
        return _transcription_only_alignment_result(
            phrases,
            recognized_text,
            language,
            raw_word_count=raw_word_count,
            raw_segment_count=0,
            diagnostic_flags=[
                *word_source["flags"],
                *(["invalid_timestamp_payload"] if raw_word_count else []),
            ],
            invalid_timestamp_units=list(word_source["invalid_units"]),
            unassigned_timestamp_units=(
                list(word_source["invalid_units"])
                if len(phrases) > 1
                else []
            ),
            elapsed_ms=(perf_counter() - alignment_started) * 1000,
        )

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
                "content_matched": None,
                "source": "none",
                "similarity": 0.0,
                "content_similarity": 0.0,
                "coverage": 0.0,
                "recognized_start": None,
                "recognized_end": None,
                "normalized_recognized": "",
                "matched_text": "",
                "audio_start": None,
                "audio_end": None,
                "alignment_confidence": "unavailable",
                "boundary_source": "none",
                "token_start_index": None,
                "token_end_index": None,
            }
            for index, phrase in enumerate(phrases)
        ],
        "diagnostics": _alignment_diagnostics(
            [],
            phrases,
            word_spans,
            language,
            candidate_count=0,
            score_computation_count=0,
            elapsed_ms=(perf_counter() - alignment_started) * 1000,
        ),
    }


def practice_comparison_alignment_canonical(
    *,
    target_text: str,
    recognized_text: str,
    target_language: str,
    asr_timestamps: object | None,
) -> dict[str, object]:
    validate_practice_alignment_target(target_text, target_language)
    try:
        language = supported_practice_target_language(target_language)
    except ValueError as error:
        raise PracticeAlignmentInputError("unsupported_target_language") from error
    phrases = _comparison_target_phrases(target_text, language)
    timestamp_data = asr_timestamps if isinstance(asr_timestamps, dict) else {}
    raw_word_count = _raw_timestamp_count(
        timestamp_data.get("raw_timestamp_word_count"),
        timestamp_data.get("words"),
    )
    raw_segment_count = _raw_timestamp_count(
        timestamp_data.get("raw_timestamp_segment_count"),
        timestamp_data.get("segments"),
    )
    timestamp_unit_count = raw_word_count + raw_segment_count
    if (
        len(phrases) > _MAX_CANONICAL_TARGET_PHRASES
        or timestamp_unit_count > _MAX_CANONICAL_TIMESTAMP_UNITS
        or len(phrases) * timestamp_unit_count > _MAX_CANONICAL_ALIGNMENT_COMPLEXITY
    ):
        raise PracticeAlignmentInputError("alignment_input_too_large")
    legacy = practice_comparison_alignment(
        target_text=target_text,
        recognized_text=recognized_text,
        target_language=target_language,
        asr_timestamps=asr_timestamps,
    )
    return _canonical_alignment_result(
        legacy,
        raw_word_count=raw_word_count,
        raw_segment_count=raw_segment_count,
    )


def validate_practice_alignment_target(target_text: str, target_language: str) -> None:
    try:
        language = supported_practice_target_language(target_language)
    except ValueError as error:
        raise PracticeAlignmentInputError("unsupported_target_language") from error
    phrases = _comparison_target_phrases(target_text, language)
    if not phrases:
        raise PracticeAlignmentInputError("empty_target")
    if len(phrases) > _MAX_CANONICAL_TARGET_PHRASES:
        raise PracticeAlignmentInputError("alignment_input_too_large")


def practice_alignment_legacy_adapter(canonical: dict[str, object]) -> dict[str, object]:
    phrases = canonical.get("phrases") if isinstance(canonical.get("phrases"), list) else []
    return {
        "available": bool(canonical.get("available")),
        "complete": bool(canonical.get("complete")),
        "mode": "canonical_v1_adapter",
        "reason": "",
        "target_language": canonical.get("target_language"),
        "target_phrase_count": canonical.get("target_phrase_count"),
        "ranges": [
            {
                "index": phrase["index"],
                "source_index": phrase["source_index"],
                "target": phrase["target_text"],
                "available": phrase["available"],
                "matched": phrase["content_matched"] is True,
                "content_matched": phrase["content_matched"],
                "source": (
                    phrase["text_source"]
                    if phrase["text_source"] == phrase["timestamp_source"]
                    or phrase["timestamp_source"] == "none"
                    else "none"
                ),
                "matched_text": phrase["matched_text"],
                "audio_start": phrase["audio_start"],
                "audio_end": phrase["audio_end"],
                "token_start_index": phrase["word_start_index"],
                "token_end_index": phrase["word_end_index"],
            }
            for phrase in phrases
        ],
        "diagnostics": canonical.get("diagnostics") or {},
    }


def _canonical_alignment_result(
    legacy: dict[str, object],
    *,
    raw_word_count: int,
    raw_segment_count: int,
) -> dict[str, object]:
    legacy_ranges = legacy.get("ranges") if isinstance(legacy.get("ranges"), list) else []
    legacy_diagnostics = legacy.get("diagnostics") if isinstance(legacy.get("diagnostics"), dict) else {}
    raw_unassigned = (
        legacy_diagnostics.get("unassigned_tokens")
        if isinstance(legacy_diagnostics.get("unassigned_tokens"), list)
        else []
    )
    unassigned_tokens = [_canonical_unassigned_token(token) for token in raw_unassigned]
    unassigned_non_filler_count = sum(
        token["reason"] != "boundary_filler" for token in unassigned_tokens
    )
    outcome = str(legacy.get("outcome") or "evaluated")
    if outcome != "no_speech" and not legacy.get("recognized_normalized") and not legacy_ranges:
        outcome = "no_speech"
    phrases = [] if outcome == "no_speech" else [
        _canonical_phrase_result(phrase) for phrase in legacy_ranges
    ]
    playable_phrase_count = sum(bool(phrase["available"]) for phrase in phrases)
    target_phrase_count = int(legacy.get("target_phrase_count") or len(legacy_ranges))
    all_phrases_playable = target_phrase_count > 0 and playable_phrase_count == target_phrase_count
    complete = all_phrases_playable and unassigned_non_filler_count == 0
    zero_duration_tokens = []
    raw_zero_tokens = (
        legacy_diagnostics.get("zero_duration_tokens")
        if isinstance(legacy_diagnostics.get("zero_duration_tokens"), list)
        else []
    )
    for token in raw_zero_tokens:
        source_index = int(token.get("source_index", token.get("index", 0)))
        owner = next(
            (
                phrase["index"]
                for phrase in phrases
                if phrase["word_start_index"] is not None
                and int(phrase["word_start_index"]) <= source_index < int(phrase["word_end_index"])
            ),
            token.get("owner_phrase_index"),
        )
        if owner is None:
            continue
        zero_duration_tokens.append(
            {
                "source": str(token.get("source") or "words"),
                "source_index": source_index,
                "text": str(token.get("text") or ""),
                "start": token.get("start"),
                "end": token.get("end"),
                "owner_phrase_index": int(owner),
            }
        )
    assigned_word_count = sum(
        int(phrase["word_end_index"]) - int(phrase["word_start_index"])
        for phrase in phrases
        if phrase["word_start_index"] is not None
    )
    assigned_segment_count = sum(phrase["text_source"] == "segments" for phrase in phrases)
    diagnostic_flags = legacy_diagnostics.get("diagnostic_flags") or []
    invalid_timestamp_units = (
        legacy_diagnostics.get("invalid_timestamp_units")
        if isinstance(legacy_diagnostics.get("invalid_timestamp_units"), list)
        else []
    )
    diagnostics = {
        "valid_word_count": int(
            legacy_diagnostics.get("valid_word_count", legacy_diagnostics.get("total_timestamp_token_count", 0))
            or 0
        ),
        "valid_segment_count": int(legacy_diagnostics.get("valid_segment_count", 0) or 0),
        "assigned_word_count": assigned_word_count,
        "assigned_segment_count": int(
            legacy_diagnostics.get("assigned_segment_count", assigned_segment_count) or 0
        ),
        "playable_word_count": int(
            legacy_diagnostics.get("playable_word_count", legacy_diagnostics.get("playable_token_count", 0))
            or 0
        ),
        "unassigned_non_filler_count": unassigned_non_filler_count,
        "unassigned_tokens": unassigned_tokens,
        "zero_duration_tokens": zero_duration_tokens,
        "diagnostic_flags": sorted(set(str(flag) for flag in diagnostic_flags)),
        "invalid_timestamp_units": [
            _canonical_invalid_timestamp_unit(unit)
            for unit in invalid_timestamp_units
            if isinstance(unit, dict)
        ],
        "raw_timestamp_word_count": int(
            legacy_diagnostics.get("raw_timestamp_word_count", raw_word_count) or 0
        ),
        "raw_timestamp_segment_count": int(
            legacy_diagnostics.get("raw_timestamp_segment_count", raw_segment_count) or 0
        ),
        "candidate_count": int(legacy_diagnostics.get("candidate_count", 0) or 0),
        "score_computation_count": int(legacy_diagnostics.get("score_computation_count", 0) or 0),
        "alignment_elapsed_ms": float(legacy_diagnostics.get("alignment_elapsed_ms", 0.0) or 0.0),
    }
    if outcome == "no_speech":
        unassigned_non_filler_count = 0
        diagnostics["unassigned_non_filler_count"] = 0
        diagnostics["unassigned_tokens"] = []
        diagnostics["zero_duration_tokens"] = []
        complete = False
    return {
        "alignment_contract_version": 1,
        "outcome": outcome,
        "target_language": legacy.get("target_language"),
        "available": playable_phrase_count > 0,
        "target_phrase_count": target_phrase_count,
        "playable_phrase_count": playable_phrase_count,
        "all_phrases_playable": all_phrases_playable if outcome != "no_speech" else False,
        "unassigned_non_filler_count": unassigned_non_filler_count,
        "complete": complete,
        "phrases": phrases,
        "diagnostics": diagnostics,
    }


def _canonical_phrase_result(legacy: dict[str, object]) -> dict[str, object]:
    matched_text = str(legacy.get("matched_text") or "")
    available = bool(legacy.get("available"))
    assignment_status = "assigned" if available else "text_only" if matched_text else "unassigned"
    source = str(legacy.get("source") or "none")
    word_start = legacy.get("token_start_index")
    word_end = legacy.get("token_end_index")
    text_source = source if matched_text and source in {"words", "segments", "transcription"} else (
        "words" if matched_text and word_start is not None else "none"
    )
    timestamp_source = source if available and source in {"words", "segments"} else "none"
    confidence = legacy.get("alignment_confidence")
    if confidence not in {"high", "medium", "low"}:
        confidence = "medium" if assignment_status == "text_only" else None
    return {
        "index": int(legacy.get("index") or 0),
        "source_index": int(legacy.get("source_index") or 0),
        "target_text": str(legacy.get("target") or ""),
        "assignment_status": assignment_status,
        "available": available,
        "matched_text": matched_text,
        "content_matched": legacy.get("content_matched") if assignment_status != "unassigned" else None,
        "alignment_confidence": confidence,
        "boundary_sources": _canonical_boundary_sources(str(legacy.get("boundary_source") or ""), source),
        "text_source": text_source,
        "timestamp_source": timestamp_source,
        "word_start_index": int(word_start) if word_start is not None else None,
        "word_end_index": int(word_end) if word_end is not None else None,
        "audio_start": legacy.get("audio_start") if available else None,
        "audio_end": legacy.get("audio_end") if available else None,
    }


def _canonical_boundary_sources(boundary_source: str, source: str) -> list[str]:
    values = []
    if "lexical" in boundary_source or source == "words":
        values.append("text_anchor")
    if "neighbor" in boundary_source:
        values.append("neighbor_anchors")
    if "pause" in boundary_source:
        values.append("pause")
    if "segment" in boundary_source or source == "segments":
        values.append("asr_segment")
    if "single" in boundary_source:
        values.append("single_phrase")
    if "leading" in boundary_source or "trailing" in boundary_source:
        values.append("utterance_edge")
    order = ["text_anchor", "neighbor_anchors", "pause", "asr_segment", "single_phrase", "utterance_edge"]
    return [value for value in order if value in values]


def _canonical_unassigned_token(token: dict[str, object]) -> dict[str, object]:
    reason_map = {
        "edge_or_boundary_filler": "boundary_filler",
        "unexplained_internal_token": "ambiguous_assignment",
        "no_structural_anchor": "ambiguous_assignment",
    }
    return {
        "source": str(token.get("source") or "words"),
        "source_index": int(token.get("source_index", token.get("index", 0)) or 0),
        "text": str(token.get("text") or ""),
        "start": token.get("start"),
        "end": token.get("end"),
        "reason": str(token.get("canonical_reason") or reason_map.get(
            str(token.get("reason") or ""),
            str(token.get("reason") or "ambiguous_assignment"),
        )),
    }


def _canonical_invalid_timestamp_unit(token: dict[str, object]) -> dict[str, object]:
    return {
        "source": str(token.get("source") or "words"),
        "source_index": int(token.get("source_index", token.get("index", 0)) or 0),
        "text": str(token.get("text") or ""),
        "start": token.get("start"),
        "end": token.get("end"),
        "reason": str(token.get("reason") or "non_numeric"),
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


def _target_character_coverage(target_normalized: str, candidate: str) -> float:
    if not target_normalized or not candidate:
        return 0.0
    matching_characters = sum(
        block.size
        for block in SequenceMatcher(None, target_normalized, candidate, autojunk=False).get_matching_blocks()
    )
    return max(0.0, min(1.0, matching_characters / len(target_normalized)))


def _comparison_target_phrases(target_text: str, target_language: str) -> list[dict[str, object]]:
    phrases: list[dict[str, object]] = []
    for source_index, phrase in enumerate(split_practice_phrases(target_text)):
        target_phrase = re.sub(
            r"^(?i:speaker\s*\d+|[a-z]\d*|\d+)\s*[：:]\s*",
            "",
            phrase,
            count=1,
        ).strip()
        normalized = normalize_practice_text(target_phrase, target_language)
        if not normalized or _is_comparison_label_phrase(target_phrase, normalized):
            continue
        phrases.append(
            {
                "source_index": source_index,
                "target": target_phrase,
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


def _asr_word_spans(
    words: object,
    target_language: str,
) -> tuple[list[dict[str, object]], str, dict[str, object]]:
    if not isinstance(words, list):
        return [], "", {
            "raw_count": 0,
            "source_valid": True,
            "flags": [],
            "invalid_units": [],
        }

    spans: list[dict[str, object]] = []
    normalized_pieces: list[str] = []
    invalid_units: list[dict[str, object]] = []
    flags: set[str] = set()
    cursor = 0
    for raw_index, item in enumerate(words):
        if not isinstance(item, dict):
            invalid_units.append(
                _invalid_timestamp_unit("words", raw_index, "", None, None, "non_numeric")
            )
            continue
        text = str(item.get("text") or item.get("word") or "").strip()
        start, end, invalid_reason = _timestamp_unit_values(item.get("start"), item.get("end"))
        if invalid_reason is not None:
            invalid_units.append(
                _invalid_timestamp_unit("words", raw_index, text, start, end, invalid_reason)
            )
            continue
        normalized = normalize_practice_text(text, target_language)
        if not normalized:
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
                "token_index": raw_index,
                "zero_duration": end == start,
            }
        )
        cursor = span_end
    for index, (previous, current) in enumerate(zip(spans, spans[1:]), start=1):
        zero_duration_bridge = _is_zero_duration_overlap_bridge(spans, index)
        if float(current["audio_start"]) < float(previous["audio_start"]):
            if zero_duration_bridge:
                flags.add("zero_duration_overlap_bridge")
            else:
                flags.add("non_monotonic_timestamp_source")
        if (
            current["text"] == previous["text"]
            and current["audio_start"] == previous["audio_start"]
            and current["audio_end"] == previous["audio_end"]
        ):
            flags.add("duplicate_timestamp_unit")
        if (
            float(previous["audio_end"]) > float(previous["audio_start"])
            and float(current["audio_end"]) > float(current["audio_start"])
            and float(current["audio_start"]) < float(previous["audio_end"])
        ):
            flags.add("overlapping_timestamp_units")
    if invalid_units:
        flags.add("invalid_timestamp_unit")
    source_valid = not any(
        flag in {
            "non_monotonic_timestamp_source",
            "duplicate_timestamp_unit",
            "overlapping_timestamp_units",
        }
        for flag in flags
    )
    if not source_valid:
        source_reason = next(
            flag
            for flag in (
                "non_monotonic_timestamp_source",
                "duplicate_timestamp_unit",
                "overlapping_timestamp_units",
            )
            if flag in flags
        )
        invalid_units.extend(
            _invalid_timestamp_unit(
                "words",
                int(span["token_index"]),
                str(span["text"]),
                span["audio_start"],
                span["audio_end"],
                source_reason,
            )
            for span in spans
        )
    return spans, "".join(normalized_pieces), {
        "raw_count": len(words),
        "source_valid": source_valid,
        "flags": sorted(flags),
        "invalid_units": invalid_units,
    }


def _is_zero_duration_overlap_bridge(
    spans: list[dict[str, object]],
    current_index: int,
) -> bool:
    current = spans[current_index]
    if float(current["audio_end"]) <= float(current["audio_start"]):
        return False
    zero_index = current_index - 1
    zero_points: list[float] = []
    while zero_index >= 0 and bool(spans[zero_index].get("zero_duration")):
        zero_points.append(float(spans[zero_index]["audio_start"]))
        zero_index -= 1
    if not zero_points or zero_index < 0:
        return False
    previous_positive = spans[zero_index]
    previous_start = float(previous_positive["audio_start"])
    previous_end = float(previous_positive["audio_end"])
    current_start = float(current["audio_start"])
    current_end = float(current["audio_end"])
    return (
        previous_end > previous_start
        and all(abs(point - previous_end) <= 1e-9 for point in zero_points)
        and previous_start <= current_start < previous_end
        and current_end > previous_end
    )


def _transcription_only_alignment_result(
    phrases: list[dict[str, object]],
    recognized_text: str,
    target_language: str,
    *,
    raw_word_count: int,
    raw_segment_count: int,
    elapsed_ms: float,
    contradictory: bool = False,
    diagnostic_flags: list[str] | None = None,
    invalid_timestamp_units: list[dict[str, object]] | None = None,
    unassigned_timestamp_units: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    ranges = [
        _unavailable_alignment_range(index, phrase, str(phrase["normalized_target"]))
        for index, phrase in enumerate(phrases)
    ]
    recognized_normalized = normalize_practice_text(recognized_text, target_language)
    if len(phrases) == 1 and recognized_normalized:
        phrase = phrases[0]
        content_matched = practice_content_matches(
            str(phrase["target"]),
            recognized_text,
            target_language,
        )
        ranges[0] = {
            "index": 0,
            "source_index": phrase["source_index"],
            "target": phrase["target"],
            "normalized_target": phrase["normalized_target"],
            "available": False,
            "matched": content_matched,
            "content_matched": content_matched,
            "source": "transcription",
            "similarity": _round_score(
                practice_similarity(str(phrase["normalized_target"]), recognized_normalized)
            ),
            "content_similarity": _round_score(
                practice_similarity(str(phrase["normalized_target"]), recognized_normalized)
            ),
            "coverage": _round_score(
                _target_character_coverage(str(phrase["normalized_target"]), recognized_normalized)
            ),
            "recognized_start": 0,
            "recognized_end": len(recognized_normalized),
            "normalized_recognized": recognized_normalized,
            "matched_text": str(recognized_text),
            "audio_start": None,
            "audio_end": None,
            "alignment_confidence": "high",
            "boundary_source": "single_phrase",
            "token_start_index": None,
            "token_end_index": None,
        }
    flags = list(diagnostic_flags or [])
    if contradictory:
        flags.append("contradictory_timestamp_payload")
    flags = sorted(set(flags))
    unassigned_tokens = [
        {
            "source": str(unit.get("source") or "words"),
            "source_index": int(unit.get("source_index", 0) or 0),
            "index": int(unit.get("source_index", 0) or 0),
            "text": str(unit.get("text") or ""),
            "start": unit.get("start"),
            "end": unit.get("end"),
            "reason": "ambiguous_assignment",
        }
        for unit in (unassigned_timestamp_units or [])
    ]
    return {
        "outcome": "evaluated" if recognized_normalized else "no_speech",
        "available": False,
        "complete": False,
        "mode": "transcription_only" if recognized_normalized else "unavailable",
        "reason": "timestamp payload was unavailable; only formal transcription was retained",
        "target_language": target_language,
        "recognized_normalized": recognized_normalized,
        "target_phrase_count": len(phrases),
        "ranges": ranges,
        "diagnostics": {
            "total_timestamp_token_count": 0,
            "playable_token_count": 0,
            "unassigned_tokens": unassigned_tokens,
            "zero_duration_tokens": [],
            "candidate_count": 0,
            "score_computation_count": 0,
            "alignment_elapsed_ms": round(max(0.0, elapsed_ms), 3),
            "valid_word_count": 0,
            "valid_segment_count": 0,
            "assigned_word_count": 0,
            "assigned_segment_count": 0,
            "playable_word_count": 0,
            "unassigned_non_filler_count": len(unassigned_tokens),
            "diagnostic_flags": flags,
            "invalid_timestamp_units": list(invalid_timestamp_units or []),
            "raw_timestamp_word_count": raw_word_count,
            "raw_timestamp_segment_count": raw_segment_count,
        },
    }


def _primary_invalid_timestamp_units(
    word_source: dict[str, object],
    segment_source: dict[str, object],
) -> list[dict[str, object]]:
    word_units = list(word_source.get("invalid_units", []))
    if int(word_source.get("raw_count", 0)) and word_units:
        return word_units
    return list(segment_source.get("invalid_units", []))


def _align_phrases_to_segments(
    phrases: list[dict[str, object]],
    segments: list[dict[str, object]],
    source: dict[str, object],
    recognized_text: str,
    target_language: str,
    *,
    elapsed_ms: float,
    discarded_word_source: dict[str, object] | None = None,
) -> dict[str, object]:
    ranges = [
        _unavailable_alignment_range(index, phrase, str(phrase["normalized_target"]))
        for index, phrase in enumerate(phrases)
    ]
    matches_by_segment = [
        [
            phrase_index
            for phrase_index, phrase in enumerate(phrases)
            if practice_content_matches(str(phrase["target"]), str(segment["text"]), target_language)
        ]
        for segment in segments
    ]
    unique_sequence = [matches[0] for matches in matches_by_segment if len(matches) == 1]
    sequence_conflict = any(
        right < left for left, right in zip(unique_sequence, unique_sequence[1:])
    )
    assigned_segment_indexes: set[int] = set()
    assigned_phrase_indexes: set[int] = set()
    if bool(source["source_valid"]) and not sequence_conflict:
        for segment, matches in zip(segments, matches_by_segment, strict=True):
            if len(matches) != 1:
                continue
            phrase_index = matches[0]
            if phrase_index in assigned_phrase_indexes:
                continue
            phrase = phrases[phrase_index]
            segment_text = str(segment["text"])
            available = float(segment["end"]) > float(segment["start"])
            ranges[phrase_index] = {
                "index": phrase_index,
                "source_index": phrase["source_index"],
                "target": phrase["target"],
                "normalized_target": phrase["normalized_target"],
                "available": available,
                "matched": True,
                "content_matched": True,
                "source": "segments",
                "similarity": 1.0,
                "content_similarity": 1.0,
                "coverage": 1.0,
                "recognized_start": None,
                "recognized_end": None,
                "normalized_recognized": normalize_practice_text(segment_text, target_language),
                "matched_text": segment_text,
                "audio_start": segment["start"] if available else None,
                "audio_end": segment["end"] if available else None,
                "alignment_confidence": "high",
                "boundary_source": "segment",
                "token_start_index": None,
                "token_end_index": None,
            }
            assigned_phrase_indexes.add(phrase_index)
            assigned_segment_indexes.add(int(segment["segment_index"]))

    raw_units = list(source["raw_units"])
    unassigned_tokens = []
    invalid_segment_indexes = {
        int(unit["source_index"])
        for unit in source["invalid_units"]
        if unit.get("source") == "segments"
    }
    for unit in raw_units:
        unit_index = int(unit["index"])
        if unit_index in assigned_segment_indexes or unit_index in invalid_segment_indexes:
            continue
        matching = next(
            (
                matches
                for segment, matches in zip(segments, matches_by_segment, strict=True)
                if int(segment["segment_index"]) == unit_index
            ),
            [],
        )
        segment_text = normalize_practice_text(str(unit["text"]), target_language)
        has_partial_target_evidence = any(
            _target_character_coverage(str(phrase["normalized_target"]), segment_text) >= 0.25
            or practice_similarity(str(phrase["normalized_target"]), segment_text) >= 0.35
            for phrase in phrases
        )
        reason = (
            "ambiguous_assignment"
            if matching or has_partial_target_evidence or not bool(source["source_valid"])
            else "unrelated_speech"
        )
        unassigned_tokens.append(
            {
                "source": "segments",
                "source_index": unit_index,
                "index": unit_index,
                "text": unit["text"],
                "start": unit["start"],
                "end": unit["end"],
                "reason": reason,
            }
        )
    zero_duration_tokens = [
        {
            "source": "segments",
            "source_index": int(segment["segment_index"]),
            "index": int(segment["segment_index"]),
            "text": segment["text"],
            "start": segment["start"],
            "end": segment["end"],
            "owner_phrase_index": phrase_index,
        }
        for phrase_index, phrase_range in enumerate(ranges)
        for segment in segments
        if phrase_range["source"] == "segments"
        and phrase_range["matched_text"] == segment["text"]
        and int(segment["segment_index"]) in assigned_segment_indexes
        and float(segment["start"]) == float(segment["end"])
    ]
    playable_count = sum(bool(phrase_range["available"]) for phrase_range in ranges)
    complete = bool(ranges) and playable_count == len(ranges) and not unassigned_tokens
    diagnostics = {
        "total_timestamp_token_count": int(source["raw_count"]),
        "playable_token_count": playable_count,
        "unassigned_tokens": unassigned_tokens,
        "zero_duration_tokens": zero_duration_tokens,
        "candidate_count": sum(bool(matches) for matches in matches_by_segment),
        "score_computation_count": len(segments) * len(phrases),
        "alignment_elapsed_ms": round(max(0.0, elapsed_ms), 3),
        "valid_word_count": 0,
        "valid_segment_count": len(segments),
        "assigned_word_count": 0,
        "assigned_segment_count": len(assigned_segment_indexes),
        "playable_word_count": 0,
        "unassigned_non_filler_count": len(unassigned_tokens),
        "diagnostic_flags": sorted(
            {
                *(str(flag) for flag in source["flags"]),
                *(
                    str(flag)
                    for flag in (discarded_word_source or {}).get("flags", [])
                ),
            }
        ),
        "invalid_timestamp_units": [
            *(discarded_word_source or {}).get("invalid_units", []),
            *source["invalid_units"],
        ],
        "raw_timestamp_word_count": int((discarded_word_source or {}).get("raw_count", 0)),
        "raw_timestamp_segment_count": int(source["raw_count"]),
    }
    return {
        "outcome": "evaluated",
        "available": playable_count > 0,
        "complete": complete,
        "mode": "target_phrase_segment_alignment",
        "reason": "" if complete else "some segments could not be mapped safely",
        "target_language": target_language,
        "recognized_normalized": normalize_practice_text(recognized_text, target_language),
        "target_phrase_count": len(phrases),
        "ranges": ranges,
        "diagnostics": diagnostics,
    }


def _asr_segments(segments: object) -> tuple[list[dict[str, object]], dict[str, object]]:
    if not isinstance(segments, list):
        return [], {
            "raw_count": 0,
            "source_valid": True,
            "flags": [],
            "raw_units": [],
            "invalid_units": [],
        }
    normalized: list[dict[str, object]] = []
    raw_units: list[dict[str, object]] = []
    invalid_units: list[dict[str, object]] = []
    flags: set[str] = set()
    for raw_index, item in enumerate(segments):
        if not isinstance(item, dict):
            raw_units.append({"index": raw_index, "text": "", "start": None, "end": None})
            invalid_units.append(
                _invalid_timestamp_unit("segments", raw_index, "", None, None, "non_numeric")
            )
            continue
        text = str(item.get("text") or "")
        start, end, invalid_reason = _timestamp_unit_values(item.get("start"), item.get("end"))
        raw_units.append({"index": raw_index, "text": text, "start": start, "end": end})
        if invalid_reason is not None:
            invalid_units.append(
                _invalid_timestamp_unit("segments", raw_index, text, start, end, invalid_reason)
            )
            continue
        normalized.append(
            {
                "text": text,
                "start": start,
                "end": end,
                "segment_index": raw_index,
            }
        )
    source_valid = True
    for previous, current in zip(normalized, normalized[1:]):
        if float(current["start"]) < float(previous["start"]):
            flags.add("non_monotonic_timestamp_source")
            source_valid = False
        if (
            current["text"] == previous["text"]
            and current["start"] == previous["start"]
            and current["end"] == previous["end"]
        ):
            flags.add("duplicate_timestamp_unit")
            source_valid = False
        if (
            float(previous["end"]) > float(previous["start"])
            and float(current["end"]) > float(current["start"])
            and float(current["start"]) < float(previous["end"])
        ):
            flags.add("overlapping_timestamp_units")
            source_valid = False
    if invalid_units:
        flags.add("invalid_timestamp_unit")
    if not source_valid:
        source_reason = next(
            flag
            for flag in (
                "non_monotonic_timestamp_source",
                "duplicate_timestamp_unit",
                "overlapping_timestamp_units",
            )
            if flag in flags
        )
        invalid_units.extend(
            _invalid_timestamp_unit(
                "segments",
                int(segment["segment_index"]),
                str(segment["text"]),
                segment["start"],
                segment["end"],
                source_reason,
            )
            for segment in normalized
        )
    return normalized, {
        "raw_count": len(segments),
        "source_valid": source_valid,
        "flags": sorted(flags),
        "raw_units": raw_units,
        "invalid_units": invalid_units,
    }


def _exclude_disjoint_segment_source(
    word_spans: list[dict[str, object]],
    word_source_valid: bool,
    segments: list[dict[str, object]],
    segment_source: dict[str, object],
) -> list[dict[str, object]]:
    if not word_source_valid or not segment_source["source_valid"]:
        return segments
    positive_words = [
        span
        for span in word_spans
        if float(span["audio_end"]) > float(span["audio_start"])
    ]
    positive_segments = [
        segment
        for segment in segments
        if float(segment["end"]) > float(segment["start"])
    ]
    if not positive_words or not positive_segments:
        return segments
    word_start = min(float(span["audio_start"]) for span in positive_words)
    word_end = max(float(span["audio_end"]) for span in positive_words)
    segment_start = min(float(segment["start"]) for segment in positive_segments)
    segment_end = max(float(segment["end"]) for segment in positive_segments)
    if word_start < segment_end and segment_start < word_end:
        return segments
    segment_source["source_valid"] = False
    segment_source["flags"] = sorted(
        {*segment_source["flags"], "word_segment_boundary_conflict"}
    )
    segment_source["invalid_units"].extend(
        _invalid_timestamp_unit(
            "segments",
            int(segment["segment_index"]),
            str(segment["text"]),
            segment["start"],
            segment["end"],
            "word_segment_boundary_conflict",
        )
        for segment in segments
    )
    return []


def _align_phrases_to_word_spans(
    phrases: list[dict[str, object]],
    recognized_normalized: str,
    word_spans: list[dict[str, object]],
    target_language: str,
) -> tuple[list[dict[str, object]], dict[str, int]]:
    memo: dict[tuple[int, int], tuple[float, int, tuple[dict[str, object] | None, ...]]] = {}
    candidates_by_phrase: list[list[dict[str, object]]] = []
    score_computation_count = 0
    score_cache: dict[tuple[str, str], tuple[float, float]] = {}

    def scores(target: str, candidate: str) -> tuple[float, float]:
        nonlocal score_computation_count
        key = (target, candidate)
        if key not in score_cache:
            score_cache[key] = (
                practice_similarity(target, candidate),
                _target_character_coverage(target, candidate),
            )
            score_computation_count += 1
        return score_cache[key]

    for phrase_index, phrase in enumerate(phrases):
        normalized_target = str(phrase["normalized_target"])
        target_length = len(normalized_target)
        is_last_phrase = phrase_index == len(phrases) - 1
        minimum_length = max(1, int(target_length * (0.25 if is_last_phrase else 0.35)))
        maximum_length = max(minimum_length, int(target_length * 2.2) + 3)
        phrase_candidates: list[dict[str, object]] = []
        for start_word in range(len(word_spans)):
            start = int(word_spans[start_word]["normalized_start"])
            for end_word in range(start_word + 1, len(word_spans) + 1):
                end = int(word_spans[end_word - 1]["normalized_end"])
                candidate = recognized_normalized[start:end]
                candidate_length = len(candidate)
                if candidate_length < minimum_length:
                    continue
                if candidate_length > maximum_length:
                    break
                similarity, coverage = scores(normalized_target, candidate)
                is_trailing_partial = is_last_phrase and end_word == len(word_spans)
                common_prefix_length = _common_prefix_length(normalized_target, candidate)
                is_reliable_match = similarity >= 0.40 and coverage >= 0.45
                is_tolerable_trailing_partial = (
                    is_trailing_partial
                    and similarity >= 0.30
                    and coverage >= 0.20
                    and common_prefix_length >= 2
                    and common_prefix_length / min(target_length, candidate_length) >= 0.35
                )
                if not is_reliable_match and not is_tolerable_trailing_partial:
                    continue
                matches_other_phrase_better = False
                for other_index, other_phrase in enumerate(phrases):
                    if other_index == phrase_index:
                        continue
                    other_target = str(other_phrase["normalized_target"])
                    other_similarity, other_coverage = scores(other_target, candidate)
                    if (
                        other_similarity >= 0.85
                        and other_coverage >= 0.80
                        and other_similarity > similarity + 0.15
                    ):
                        matches_other_phrase_better = True
                        break
                if matches_other_phrase_better:
                    continue
                has_out_of_order_prefix = False
                for split_word in range(start_word + 1, end_word):
                    split = int(word_spans[split_word]["normalized_start"])
                    suffix = recognized_normalized[split:end]
                    suffix_similarity, suffix_coverage = scores(normalized_target, suffix)
                    if suffix_similarity < 0.85 or suffix_coverage < 0.80:
                        continue
                    prefix = recognized_normalized[start:split]
                    for other_index, other_phrase in enumerate(phrases):
                        if other_index == phrase_index:
                            continue
                        other_target = str(other_phrase["normalized_target"])
                        prefix_similarity, prefix_coverage = scores(other_target, prefix)
                        if prefix_similarity >= 0.85 and prefix_coverage >= 0.80:
                            has_out_of_order_prefix = True
                            break
                    if has_out_of_order_prefix:
                        break
                if has_out_of_order_prefix:
                    continue
                length_delta_ratio = abs(candidate_length - target_length) / max(1, target_length)
                phrase_candidates.append(
                    {
                        "start_word": start_word,
                        "end_word": end_word,
                        "recognized_start": start,
                        "recognized_end": end,
                        "similarity": similarity,
                        "coverage": coverage,
                        "score": coverage + similarity - 0.30 * length_delta_ratio,
                        "boundary_source": "lexical_anchor",
                        "alignment_confidence": _alignment_confidence(similarity, coverage),
                    }
                )
        if any(
            float(candidate["similarity"]) >= 0.95
            and float(candidate["coverage"]) >= 0.95
            for candidate in phrase_candidates
        ):
            phrase_candidates = [
                candidate
                for candidate in phrase_candidates
                if float(candidate["similarity"]) >= 0.95
                and float(candidate["coverage"]) >= 0.95
            ]
        if len(phrase_candidates) > _MAX_ALIGNMENT_CANDIDATES_PER_PHRASE:
            phrase_candidates = sorted(
                phrase_candidates,
                key=lambda item: (-float(item["score"]), int(item["start_word"]), int(item["end_word"])),
            )[:_MAX_ALIGNMENT_CANDIDATES_PER_PHRASE]
        candidates_by_phrase.append(phrase_candidates)

    def solve(
        phrase_index: int,
        minimum_word_index: int,
    ) -> tuple[float, int, tuple[dict[str, object] | None, ...]]:
        key = (phrase_index, minimum_word_index)
        if key in memo:
            return memo[key]
        if phrase_index >= len(phrases):
            return 0.0, 0, ()

        skipped_score, skipped_count, skipped_ranges = solve(phrase_index + 1, minimum_word_index)
        best = (skipped_score, skipped_count, (None, *skipped_ranges))
        for candidate in candidates_by_phrase[phrase_index]:
            if int(candidate["start_word"]) < minimum_word_index:
                continue
            next_score, next_count, next_ranges = solve(phrase_index + 1, int(candidate["end_word"]))
            candidate_range = dict(candidate)
            candidate_score = float(candidate_range.pop("score"))
            option = (candidate_score + next_score, next_count + 1, (candidate_range, *next_ranges))
            if option[0] > best[0] + 1e-9 or (
                abs(option[0] - best[0]) <= 1e-9
                and (
                    option[1] > best[1]
                    or (
                        option[1] == best[1]
                        and best[2][0] is None
                        and float(candidate_range["similarity"]) >= 0.95
                        and float(candidate_range["coverage"]) >= 0.95
                    )
                )
            ):
                best = option

        memo[key] = best
        return best

    _, _, selected = solve(0, 0)
    lexical_anchors = tuple(dict(item) if item is not None else None for item in selected)
    selected = _expand_initial_repetition_ranges(
        phrases,
        selected,
        word_spans,
        recognized_normalized,
    )
    selected = _expand_trailing_attempt_ranges(
        phrases,
        selected,
        word_spans,
        recognized_normalized,
        target_language,
    )
    selected = _add_structural_fallback_ranges(
        phrases,
        selected,
        word_spans,
        recognized_normalized,
        target_language,
    )
    selected = _apply_pause_partition_ranges(
        phrases,
        selected,
        word_spans,
        recognized_normalized,
        target_language,
    )
    selected = _assign_unassigned_word_gaps(
        phrases,
        selected,
        word_spans,
        recognized_normalized,
        target_language,
    )
    selected = _move_prefix_before_exact_right_anchor(
        phrases,
        selected,
        word_spans,
        recognized_normalized,
        target_language,
    )
    selected = _resolve_out_of_order_gap_suffixes(
        phrases,
        lexical_anchors,
        selected,
        word_spans,
        recognized_normalized,
        target_language,
    )
    selected = _trim_detached_speech_expansions(
        phrases,
        lexical_anchors,
        selected,
        word_spans,
        recognized_normalized,
    )
    selected = _trim_boundary_fillers_from_ranges(
        phrases,
        selected,
        word_spans,
        recognized_normalized,
        target_language,
    )
    selected = _reject_weak_one_sided_assignments(
        phrases,
        selected,
        word_spans,
        target_language,
    )
    ranges: list[dict[str, object]] = []
    for index, (phrase, selection) in enumerate(zip(phrases, selected, strict=True)):
        normalized_target = str(phrase["normalized_target"])
        if selection is None:
            ranges.append(_unavailable_alignment_range(index, phrase, normalized_target))
            continue
        start_word = int(selection["start_word"])
        end_word = int(selection["end_word"])
        selected_spans = word_spans[start_word:end_word]
        start = int(selection["recognized_start"])
        end = int(selection["recognized_end"])
        audio_start, audio_end = _safe_alignment_audio_bounds(selected_spans)
        if audio_start is None or audio_end is None or audio_end <= audio_start:
            ranges.append(
                _text_only_alignment_range(
                    index,
                    phrase,
                    normalized_target,
                    selected_spans,
                    start,
                    end,
                    recognized_normalized,
                    target_language,
                    start_word,
                    end_word,
                    float(selection["similarity"]),
                    float(selection["coverage"]),
                )
            )
            continue
        content_matched = practice_content_matches(
            str(phrase["target"]),
            _join_matched_words(selected_spans, target_language),
            target_language,
        )
        ranges.append(
            {
                "index": index,
                "source_index": phrase["source_index"],
                "target": phrase["target"],
                "normalized_target": normalized_target,
                "available": True,
                "matched": content_matched,
                "content_matched": content_matched,
                "source": "words",
                "similarity": _round_score(float(selection["similarity"])),
                "content_similarity": _round_score(float(selection["similarity"])),
                "coverage": _round_score(float(selection["coverage"])),
                "recognized_start": start,
                "recognized_end": end,
                "normalized_recognized": recognized_normalized[start:end],
                "matched_text": _join_matched_words(selected_spans, target_language),
                "audio_start": audio_start,
                "audio_end": audio_end,
                "alignment_confidence": selection.get("alignment_confidence") or _alignment_confidence(
                    float(selection["similarity"]),
                    float(selection["coverage"]),
                ),
                "boundary_source": selection.get("boundary_source") or "lexical_anchor",
                "token_start_index": start_word,
                "token_end_index": end_word,
            }
        )
    ranges = _demote_overlapping_phrase_ranges(ranges)
    return ranges, {
        "candidate_count": sum(len(candidates) for candidates in candidates_by_phrase),
        "score_computation_count": score_computation_count,
    }


def _reject_weak_one_sided_assignments(
    phrases: list[dict[str, object]],
    selected: tuple[dict[str, object] | None, ...],
    word_spans: list[dict[str, object]],
    target_language: str,
) -> tuple[dict[str, object] | None, ...]:
    resolved = [dict(item) if item is not None else None for item in selected]
    exact_indexes = [
        index
        for index, item in enumerate(resolved)
        if item is not None
        and float(item.get("similarity") or 0.0) >= 0.95
        and float(item.get("coverage") or 0.0) >= 0.95
    ]
    assigned_indexes = [index for index, item in enumerate(resolved) if item is not None]
    if len(exact_indexes) != 1 or len(assigned_indexes) != 2:
        return tuple(resolved)
    exact_index = exact_indexes[0]
    weak_index = next(index for index in assigned_indexes if index != exact_index)
    if abs(weak_index - exact_index) != 1:
        return tuple(resolved)
    weak = resolved[weak_index]
    assert weak is not None
    target = str(phrases[weak_index]["normalized_target"])
    if not _has_one_sided_target_evidence(
        target,
        word_spans[int(weak["start_word"]) : int(weak["end_word"])],
        target_language,
    ):
        resolved[weak_index] = None
    return tuple(resolved)


def _matching_target_piece_count(target: str, spans: list[dict[str, object]]) -> int:
    matching_pieces = set()
    for span in spans:
        piece = str(span["normalized"])
        if not piece:
            continue
        if piece in target:
            matching_pieces.add(piece)
            continue
        if not piece.isascii():
            longest_match = max(
                (block.size for block in SequenceMatcher(None, target, piece, autojunk=False).get_matching_blocks()),
                default=0,
            )
            if longest_match >= 2:
                matching_pieces.add(piece)
    return len(matching_pieces)


def _has_one_sided_target_evidence(
    target: str,
    spans: list[dict[str, object]],
    target_language: str,
) -> bool:
    candidate = "".join(str(span["normalized"]) for span in spans)
    if not candidate or not target:
        return False
    specific_pieces = [
        span
        for span in spans
        if str(span["normalized"]) not in _NON_SPECIFIC_ALIGNMENT_PIECES.get(target_language, set())
        and not (
            str(span["normalized"]).isascii()
            and len(str(span["normalized"])) < 2
        )
    ]
    if _matching_target_piece_count(target, specific_pieces) >= 2:
        return True
    if (
        spans
        and str(spans[0]["normalized"])
        in _NON_SPECIFIC_ALIGNMENT_PIECES.get(target_language, set())
        and _matching_target_piece_count(target, specific_pieces) >= 1
        and _target_character_coverage(target, candidate) >= 0.35
    ):
        return True
    common_prefix = _common_prefix_length(target, candidate)
    return (
        common_prefix >= 2
        and common_prefix / max(1, len(target)) >= 0.35
        and common_prefix / max(1, len(candidate)) > 0.50
    )


def _has_specific_diagnostic_overlap(
    phrases: list[dict[str, object]],
    spans: list[dict[str, object]],
    target_language: str,
) -> bool:
    stops = _DIAGNOSTIC_STOP_PIECES.get(target_language, set())
    for span in spans:
        piece = str(span["normalized"])
        if not piece or piece in stops or (piece.isascii() and len(piece) < 2):
            continue
        for phrase in phrases:
            target = str(phrase["normalized_target"])
            if piece in target:
                return True
            if not piece.isascii() and max(
                (
                    block.size
                    for block in SequenceMatcher(
                        None,
                        target,
                        piece,
                        autojunk=False,
                    ).get_matching_blocks()
                ),
                default=0,
            ) >= 2:
                return True
    return False


def _alignment_confidence(similarity: float, coverage: float) -> str:
    if (
        similarity >= _HIGH_CONFIDENCE_ALIGNMENT_THRESHOLD
        and coverage >= _HIGH_CONFIDENCE_ALIGNMENT_THRESHOLD
    ):
        return "high"
    if similarity >= 0.45 and coverage >= 0.45:
        return "medium"
    return "low"


def _update_selected_word_range(
    item: dict[str, object],
    phrase: dict[str, object],
    start_word: int,
    end_word: int,
    word_spans: list[dict[str, object]],
    recognized_normalized: str,
    *,
    boundary_source: str,
) -> None:
    start = int(word_spans[start_word]["normalized_start"])
    end = int(word_spans[end_word - 1]["normalized_end"])
    candidate = recognized_normalized[start:end]
    normalized_target = str(phrase["normalized_target"])
    similarity = practice_similarity(normalized_target, candidate)
    coverage = _target_character_coverage(normalized_target, candidate)
    item.update(
        {
            "start_word": start_word,
            "end_word": end_word,
            "recognized_start": start,
            "recognized_end": end,
            "similarity": similarity,
            "coverage": coverage,
            "boundary_source": boundary_source,
            "alignment_confidence": _alignment_confidence(similarity, coverage),
        }
    )


def _is_explicit_boundary_filler(
    word_spans: list[dict[str, object]],
    target_language: str,
) -> bool:
    if not word_spans:
        return False
    pieces = [str(span["normalized"]) for span in word_spans]
    fillers = _EDGE_FILLERS.get(target_language, set())
    if all(piece in fillers for piece in pieces):
        return True
    sequences = _BOUNDARY_FILLER_SEQUENCES.get(target_language, set())
    if "".join(pieces) in sequences:
        return True
    core_start = 0
    core_end = len(pieces)
    while core_start < core_end and pieces[core_start] in fillers:
        core_start += 1
    while core_end > core_start and pieces[core_end - 1] in fillers:
        core_end -= 1
    return core_start < core_end and "".join(pieces[core_start:core_end]) in sequences


def _strongly_matches_other_target(
    phrases: list[dict[str, object]],
    excluded_indexes: set[int],
    word_spans: list[dict[str, object]],
) -> bool:
    candidate = "".join(str(span["normalized"]) for span in word_spans)
    if not candidate:
        return False
    for index, phrase in enumerate(phrases):
        if index in excluded_indexes:
            continue
        target = str(phrase["normalized_target"])
        if practice_similarity(target, candidate) >= 0.75 and _target_character_coverage(target, candidate) >= 0.70:
            return True
    return False


def _nearly_exactly_matches_other_target(
    phrases: list[dict[str, object]],
    excluded_indexes: set[int],
    word_spans: list[dict[str, object]],
) -> bool:
    candidate = "".join(str(span["normalized"]) for span in word_spans)
    if not candidate:
        return False
    for index, phrase in enumerate(phrases):
        if index in excluded_indexes:
            continue
        target = str(phrase["normalized_target"])
        if practice_similarity(target, candidate) >= 0.95 and _target_character_coverage(target, candidate) >= 0.95:
            return True
    return False


def _add_structural_fallback_ranges(
    phrases: list[dict[str, object]],
    selected: tuple[dict[str, object] | None, ...],
    word_spans: list[dict[str, object]],
    recognized_normalized: str,
    target_language: str,
) -> tuple[dict[str, object] | None, ...]:
    resolved = [dict(item) if item is not None else None for item in selected]
    index = 0
    while index < len(resolved):
        if resolved[index] is not None:
            index += 1
            continue
        run_start = index
        while index < len(resolved) and resolved[index] is None:
            index += 1
        run_end = index
        if run_end - run_start != 1:
            continue
        previous = resolved[run_start - 1] if run_start > 0 else None
        following = resolved[run_end] if run_end < len(resolved) else None
        if previous is None and following is None:
            continue
        one_sided_anchor = previous if following is None else following if previous is None else None
        lower = int(previous["end_word"]) if previous is not None else 0
        upper = int(following["start_word"]) if following is not None else len(word_spans)
        if lower >= upper:
            continue
        while lower < upper and str(word_spans[lower]["normalized"]) in _EDGE_FILLERS.get(target_language, set()):
            lower += 1
        while upper > lower and str(word_spans[upper - 1]["normalized"]) in _EDGE_FILLERS.get(target_language, set()):
            upper -= 1
        candidate_spans = word_spans[lower:upper]
        if not candidate_spans or _is_explicit_boundary_filler(candidate_spans, target_language):
            continue
        if _strongly_matches_other_target(phrases, {run_start}, candidate_spans):
            continue
        phrase = phrases[run_start]
        normalized_target = str(phrase["normalized_target"])
        if (
            one_sided_anchor is not None
            and float(one_sided_anchor.get("similarity") or 0.0) >= 0.95
            and float(one_sided_anchor.get("coverage") or 0.0) >= 0.95
            and not _has_one_sided_target_evidence(
                normalized_target,
                candidate_spans,
                target_language,
            )
        ):
            continue
        candidate = "".join(str(span["normalized"]) for span in candidate_spans)
        similarity = practice_similarity(normalized_target, candidate)
        coverage = _target_character_coverage(normalized_target, candidate)
        common_prefix = _common_prefix_length(normalized_target, candidate)
        length_ratio = len(candidate) / max(1, len(normalized_target))
        pause_before = (
            lower == 0
            or float(word_spans[lower]["audio_start"]) - float(word_spans[lower - 1]["audio_end"])
            >= _PAUSE_PARTITION_GAP_SECONDS
        )
        pause_after = (
            upper == len(word_spans)
            or float(word_spans[upper]["audio_start"]) - float(word_spans[upper - 1]["audio_end"])
            >= _PAUSE_PARTITION_GAP_SECONDS
        )
        constrained_by_neighbors = (
            previous is not None
            and following is not None
            and float(previous.get("similarity") or 0.0)
            >= _HIGH_CONFIDENCE_ALIGNMENT_THRESHOLD
            and float(previous.get("coverage") or 0.0)
            >= _HIGH_CONFIDENCE_ALIGNMENT_THRESHOLD
            and float(following.get("similarity") or 0.0)
            >= _HIGH_CONFIDENCE_ALIGNMENT_THRESHOLD
            and float(following.get("coverage") or 0.0)
            >= _HIGH_CONFIDENCE_ALIGNMENT_THRESHOLD
        )
        if constrained_by_neighbors and any(
            float(current["audio_start"]) - float(previous_span["audio_end"])
            >= _PAUSE_PARTITION_GAP_SECONDS
            for previous_span, current in zip(candidate_spans, candidate_spans[1:])
        ):
            continue
        structural_boundary = constrained_by_neighbors or pause_before or pause_after or common_prefix >= 2
        if constrained_by_neighbors:
            lexical_evidence = True
        else:
            lexical_evidence = coverage >= 0.30 and similarity >= 0.30
        if not structural_boundary or not lexical_evidence or length_ratio < 0.35:
            continue
        fallback: dict[str, object] = {}
        _update_selected_word_range(
            fallback,
            phrase,
            lower,
            upper,
            word_spans,
            recognized_normalized,
            boundary_source="neighbor_anchors" if constrained_by_neighbors else "pause_fallback",
        )
        fallback["alignment_confidence"] = "low"
        resolved[run_start] = fallback
    return tuple(resolved)


def _apply_pause_partition_ranges(
    phrases: list[dict[str, object]],
    selected: tuple[dict[str, object] | None, ...],
    word_spans: list[dict[str, object]],
    recognized_normalized: str,
    target_language: str,
) -> tuple[dict[str, object] | None, ...]:
    """Use unambiguous spoken pauses when lexical matching crosses them.

    This remains a fallback: an already aligned set of phrase boundaries is
    preserved. A pause partition is accepted only when it produces exactly one
    non-filler spoken chunk per target phrase and the chunks have some aggregate
    lexical relationship to the target. That keeps low-content mistakes
    playable without treating an arbitrary paused utterance as the target.
    """

    if len(phrases) < 2 or len(word_spans) < len(phrases):
        return selected
    boundaries = [0]
    for index in range(1, len(word_spans)):
        gap = float(word_spans[index]["audio_start"]) - float(word_spans[index - 1]["audio_end"])
        if gap >= _PAUSE_PARTITION_GAP_SECONDS:
            boundaries.append(index)
    boundaries.append(len(word_spans))
    if len(boundaries) - 1 != len(phrases):
        return selected

    expected_bounds = list(zip(boundaries[:-1], boundaries[1:], strict=True))
    fillers = _EDGE_FILLERS.get(target_language, set())
    if any(
        str(word_spans[start_word]["normalized"]) in fillers
        or str(word_spans[end_word - 1]["normalized"]) in fillers
        for start_word, end_word in expected_bounds
    ):
        return selected
    if all(
        item is not None
        and int(item["start_word"]) == start_word
        and int(item["end_word"]) == end_word
        for item, (start_word, end_word) in zip(selected, expected_bounds, strict=True)
    ):
        return selected
    has_zero_duration_overlap_bridge = any(
        _is_zero_duration_overlap_bridge(word_spans, index)
        for index in range(1, len(word_spans))
    )
    if has_zero_duration_overlap_bridge and any(
        item is not None
        and float(item.get("similarity") or 0.0) >= 0.95
        and float(item.get("coverage") or 0.0) >= 0.95
        for item in selected
    ):
        return selected

    similarities: list[float] = []
    coverages: list[float] = []
    for phrase_index, (phrase, (start_word, end_word)) in enumerate(
        zip(phrases, expected_bounds, strict=True)
    ):
        chunk = word_spans[start_word:end_word]
        if not chunk or _is_explicit_boundary_filler(chunk, target_language):
            return selected
        if _strongly_matches_other_target(phrases, {phrase_index}, chunk):
            return selected
        candidate = "".join(str(span["normalized"]) for span in chunk)
        target = str(phrase["normalized_target"])
        similarities.append(practice_similarity(target, candidate))
        coverages.append(_target_character_coverage(target, candidate))

    if max(coverages, default=0.0) < 0.25 or sum(coverages) / len(coverages) < 0.20:
        return selected
    selected_count = sum(item is not None for item in selected)
    if selected_count == 0:
        pass
    elif len(phrases) != 2:
        return selected
    elif selected_count == 1:
        anchor = next(item for item in selected if item is not None)
        if (
            float(anchor.get("similarity") or 0.0) >= 0.95
            and float(anchor.get("coverage") or 0.0) >= 0.95
        ):
            return selected
        if any(
            similarity < 0.30 or coverage < 0.30
            for similarity, coverage in zip(similarities, coverages, strict=True)
        ):
            return selected

    resolved: list[dict[str, object] | None] = []
    for phrase, (start_word, end_word) in zip(phrases, expected_bounds, strict=True):
        item: dict[str, object] = {}
        _update_selected_word_range(
            item,
            phrase,
            start_word,
            end_word,
            word_spans,
            recognized_normalized,
            boundary_source="pause_partition",
        )
        item["alignment_confidence"] = "low"
        resolved.append(item)
    return tuple(resolved)


def _assign_unassigned_word_gaps(
    phrases: list[dict[str, object]],
    selected: tuple[dict[str, object] | None, ...],
    word_spans: list[dict[str, object]],
    recognized_normalized: str,
    target_language: str,
) -> tuple[dict[str, object] | None, ...]:
    resolved = [dict(item) if item is not None else None for item in selected]
    available_indexes = [index for index, item in enumerate(resolved) if item is not None]
    if not available_indexes:
        return tuple(resolved)

    first_index = available_indexes[0]
    first = resolved[first_index]
    assert first is not None
    leading_end = int(first["start_word"])
    leading_start = 0
    while leading_start < leading_end and str(word_spans[leading_start]["normalized"]) in _EDGE_FILLERS.get(
        target_language,
        set(),
    ):
        leading_start += 1
    leading = word_spans[leading_start:leading_end]
    if (
        first_index == 0
        and leading
        and not _is_explicit_boundary_filler(leading, target_language)
        and not _strongly_matches_other_target(phrases, {0}, leading)
    ):
        _update_selected_word_range(
            first,
            phrases[0],
            leading_start,
            int(first["end_word"]),
            word_spans,
            recognized_normalized,
            boundary_source="lexical_anchor+leading_gap",
        )

    for left_index, right_index in zip(available_indexes, available_indexes[1:]):
        if right_index != left_index + 1:
            continue
        left = resolved[left_index]
        right = resolved[right_index]
        assert left is not None and right is not None
        gap_start = int(left["end_word"])
        gap_end = int(right["start_word"])
        gap_spans = word_spans[gap_start:gap_end]
        if not gap_spans or _is_explicit_boundary_filler(gap_spans, target_language):
            continue
        if _strongly_matches_other_target(phrases, {left_index, right_index}, gap_spans):
            continue
        gap_text = "".join(str(span["normalized"]) for span in gap_spans)
        left_target = str(phrases[left_index]["normalized_target"])
        right_target = str(phrases[right_index]["normalized_target"])
        left_text = recognized_normalized[int(left["recognized_start"]) : int(left["recognized_end"])]
        right_text = recognized_normalized[int(right["recognized_start"]) : int(right["recognized_end"])]
        left_gap_similarity = practice_similarity(left_target, gap_text)
        right_gap_similarity = practice_similarity(right_target, gap_text)
        left_gain = practice_similarity(left_target, left_text + gap_text) - practice_similarity(left_target, left_text)
        right_gain = practice_similarity(right_target, gap_text + right_text) - practice_similarity(right_target, right_text)
        if left_gap_similarity >= 0.75 and left_gap_similarity > right_gap_similarity + 1e-9:
            assign_to_right = False
        elif right_gap_similarity >= 0.75 and right_gap_similarity > left_gap_similarity + 1e-9:
            assign_to_right = True
        elif len(gap_spans) == 1 and len(gap_text) <= 3 and left_gain <= 0 and right_gain <= 0:
            # A short connective with no lexical gain belongs to the phrase it
            # introduces. This keeps tokens such as "at" with "midnight"
            # without turning every insertion into a language-specific rule.
            assign_to_right = True
        else:
            assign_to_right = right_gain > left_gain + 1e-9 or (
                abs(right_gain - left_gain) <= 1e-9 and len(right_text) < len(left_text)
            )
        if assign_to_right:
            _update_selected_word_range(
                right,
                phrases[right_index],
                gap_start,
                int(right["end_word"]),
                word_spans,
                recognized_normalized,
                boundary_source=f"{right.get('boundary_source') or 'lexical_anchor'}+gap_assignment",
            )
        else:
            _update_selected_word_range(
                left,
                phrases[left_index],
                int(left["start_word"]),
                gap_end,
                word_spans,
                recognized_normalized,
                boundary_source=f"{left.get('boundary_source') or 'lexical_anchor'}+gap_assignment",
            )
    return tuple(resolved)


def _move_prefix_before_exact_right_anchor(
    phrases: list[dict[str, object]],
    selected: tuple[dict[str, object] | None, ...],
    word_spans: list[dict[str, object]],
    recognized_normalized: str,
    target_language: str,
) -> tuple[dict[str, object] | None, ...]:
    """Return a misplaced prefix token to the preceding phrase.

    This only moves a boundary when the remainder is an exact right-hand text
    anchor and the moved prefix measurably improves the left phrase.
    """

    resolved = [dict(item) if item is not None else None for item in selected]
    for left_index in range(len(resolved) - 1):
        left = resolved[left_index]
        right = resolved[left_index + 1]
        if left is None or right is None:
            continue
        right_start = int(right["start_word"])
        right_end = int(right["end_word"])
        if right_end - right_start < 2:
            continue
        right_target = str(phrases[left_index + 1]["normalized_target"])
        split = next(
            (
                candidate_split
                for candidate_split in range(right_start + 1, right_end)
                if practice_similarity(
                    right_target,
                    "".join(
                        str(span["normalized"])
                        for span in word_spans[candidate_split:right_end]
                    ),
                )
                >= 0.95
                and _target_character_coverage(
                    right_target,
                    "".join(
                        str(span["normalized"])
                        for span in word_spans[candidate_split:right_end]
                    ),
                )
                >= 0.95
            ),
            None,
        )
        if split is None:
            continue
        left_target = str(phrases[left_index]["normalized_target"])
        left_start = int(left["start_word"])
        left_end = int(left["end_word"])
        left_text = "".join(str(span["normalized"]) for span in word_spans[left_start:left_end])
        expanded_left_text = "".join(
            str(span["normalized"]) for span in word_spans[left_start:split]
        )
        similarity_gain = (
            practice_similarity(left_target, expanded_left_text)
            - practice_similarity(left_target, left_text)
        )
        coverage_gain = (
            _target_character_coverage(left_target, expanded_left_text)
            - _target_character_coverage(left_target, left_text)
        )
        prefix_start = int(right["start_word"])
        temporally_attached_left = (
            prefix_start == left_end
            and float(word_spans[prefix_start]["audio_start"])
            <= float(word_spans[left_end - 1]["audio_end"]) + 1e-9
            and float(word_spans[split]["audio_start"])
            > float(word_spans[split - 1]["audio_end"])
        )
        expanded_content_matches = practice_content_matches(
            str(phrases[left_index]["target"]),
            _join_matched_words(word_spans[left_start:split], target_language),
            target_language,
        )
        if (
            similarity_gain <= 0.01
            and coverage_gain <= 0.01
            and not temporally_attached_left
            and not expanded_content_matches
        ):
            continue
        _update_selected_word_range(
            left,
            phrases[left_index],
            left_start,
            split,
            word_spans,
            recognized_normalized,
            boundary_source="exact_right_anchor",
        )
        _update_selected_word_range(
            right,
            phrases[left_index + 1],
            split,
            right_end,
            word_spans,
            recognized_normalized,
            boundary_source="exact_right_anchor",
        )
    return tuple(resolved)


def _resolve_out_of_order_gap_suffixes(
    phrases: list[dict[str, object]],
    lexical_anchors: tuple[dict[str, object] | None, ...],
    selected: tuple[dict[str, object] | None, ...],
    word_spans: list[dict[str, object]],
    recognized_normalized: str,
    target_language: str,
) -> tuple[dict[str, object] | None, ...]:
    """Keep a correction marker with its anchor, not an out-of-order phrase."""

    resolved = [dict(item) if item is not None else None for item in selected]
    for right_index, (anchor, right) in enumerate(
        zip(lexical_anchors, resolved, strict=True)
    ):
        if anchor is None or right is None or right_index == 0:
            continue
        anchor_start = int(anchor["start_word"])
        previous_anchor = next(
            (
                item
                for item in reversed(lexical_anchors[:right_index])
                if item is not None
            ),
            None,
        )
        gap_start = int(previous_anchor["end_word"]) if previous_anchor is not None else 0
        if gap_start >= anchor_start:
            continue
        out_of_order_end = None
        for split in range(gap_start + 1, anchor_start + 1):
            if _nearly_exactly_matches_other_target(
                phrases,
                {right_index},
                word_spans[gap_start:split],
            ):
                out_of_order_end = split
                break
        if out_of_order_end is None:
            continue
        suffix = word_spans[out_of_order_end:anchor_start]
        if not suffix or _is_explicit_boundary_filler(suffix, target_language):
            new_start = anchor_start
        else:
            separated_from_conflict = (
                float(suffix[0]["audio_start"])
                > float(word_spans[out_of_order_end - 1]["audio_end"])
            )
            adjacent_to_anchor = (
                float(word_spans[anchor_start]["audio_start"])
                <= float(suffix[-1]["audio_end"]) + 1e-9
            )
            if not separated_from_conflict or not adjacent_to_anchor:
                new_start = anchor_start
            else:
                new_start = out_of_order_end
        if new_start == int(right["start_word"]):
            continue
        _update_selected_word_range(
            right,
            phrases[right_index],
            new_start,
            int(right["end_word"]),
            word_spans,
            recognized_normalized,
            boundary_source="out_of_order_gap_guard",
        )
    return tuple(resolved)


def _trim_detached_speech_expansions(
    phrases: list[dict[str, object]],
    lexical_anchors: tuple[dict[str, object] | None, ...],
    selected: tuple[dict[str, object] | None, ...],
    word_spans: list[dict[str, object]],
    recognized_normalized: str,
) -> tuple[dict[str, object] | None, ...]:
    """Do not absorb a separately timed utterance into a lexical anchor.

    The gap is a rejection guard only: it can trim an expansion, but it never
    creates ownership or chooses a target slot.
    """

    resolved = [dict(item) if item is not None else None for item in selected]
    for index, (anchor, item) in enumerate(zip(lexical_anchors, resolved, strict=True)):
        if anchor is None or item is None:
            continue
        start_word = int(item["start_word"])
        end_word = int(item["end_word"])
        anchor_start = int(anchor["start_word"])
        anchor_end = int(anchor["end_word"])
        if start_word < anchor_start:
            leading_gap = (
                float(word_spans[anchor_start]["audio_start"])
                - float(word_spans[anchor_start - 1]["audio_end"])
            )
            if leading_gap >= _DETACHED_SPEECH_GAP_SECONDS:
                start_word = anchor_start
        if end_word > anchor_end and anchor_end < len(word_spans):
            trailing_gap = (
                float(word_spans[anchor_end]["audio_start"])
                - float(word_spans[anchor_end - 1]["audio_end"])
            )
            if trailing_gap >= _DETACHED_SPEECH_GAP_SECONDS:
                end_word = anchor_end
        if start_word != int(item["start_word"]) or end_word != int(item["end_word"]):
            _update_selected_word_range(
                item,
                phrases[index],
                start_word,
                end_word,
                word_spans,
                recognized_normalized,
                boundary_source="detached_speech_guard",
            )
    return tuple(resolved)


def _trim_boundary_fillers_from_ranges(
    phrases: list[dict[str, object]],
    selected: tuple[dict[str, object] | None, ...],
    word_spans: list[dict[str, object]],
    recognized_normalized: str,
    target_language: str,
) -> tuple[dict[str, object] | None, ...]:
    resolved = [dict(item) if item is not None else None for item in selected]
    for index, item in enumerate(resolved):
        if item is None:
            continue
        start_word = int(item["start_word"])
        end_word = int(item["end_word"])
        target = str(phrases[index]["normalized_target"])
        trimmed_start = start_word
        for cut in range(start_word + 1, end_word):
            prefix = word_spans[start_word:cut]
            prefix_text = "".join(str(span["normalized"]) for span in prefix)
            if _is_explicit_boundary_filler(prefix, target_language) and not target.startswith(prefix_text):
                trimmed_start = cut
        trimmed_end = end_word
        for cut in range(trimmed_start + 1, end_word):
            suffix = word_spans[cut:end_word]
            suffix_text = "".join(str(span["normalized"]) for span in suffix)
            if _is_explicit_boundary_filler(suffix, target_language) and not target.endswith(suffix_text):
                trimmed_end = cut
                break
        if trimmed_start != start_word or trimmed_end != end_word:
            _update_selected_word_range(
                item,
                phrases[index],
                trimmed_start,
                trimmed_end,
                word_spans,
                recognized_normalized,
                boundary_source="boundary_filler_guard",
            )
    return tuple(resolved)


def _safe_alignment_audio_bounds(
    selected_spans: list[dict[str, object]],
) -> tuple[float | None, float | None]:
    timed = [span for span in selected_spans if float(span["audio_end"]) > float(span["audio_start"])]
    if not timed:
        return None, None
    return (
        min(float(span["audio_start"]) for span in timed),
        max(float(span["audio_end"]) for span in timed),
    )


def _demote_overlapping_phrase_ranges(
    ranges: list[dict[str, object]],
) -> list[dict[str, object]]:
    conflict_indexes: set[int] = set()
    previous_index: int | None = None
    for index, entry in enumerate(ranges):
        if not entry.get("available"):
            continue
        if previous_index is not None:
            previous = ranges[previous_index]
            if float(entry["audio_start"]) < float(previous["audio_end"]):
                conflict_indexes.update({previous_index, index})
        previous_index = index
    for index in conflict_indexes:
        entry = ranges[index]
        entry["available"] = False
        entry["source"] = "none"
        entry["audio_start"] = None
        entry["audio_end"] = None
        entry["boundary_source"] = (
            f"{entry.get('boundary_source') or 'lexical_anchor'}+overlapping_phrase_range_guard"
        )
        entry["diagnostic_flags"] = ["overlapping_phrase_ranges"]
    return ranges


def _text_only_alignment_range(
    index: int,
    phrase: dict[str, object],
    normalized_target: str,
    selected_spans: list[dict[str, object]],
    start: int,
    end: int,
    recognized_normalized: str,
    target_language: str,
    start_word: int,
    end_word: int,
    similarity: float,
    coverage: float,
) -> dict[str, object]:
    matched_text = _join_matched_words(selected_spans, target_language)
    content_matched = practice_content_matches(
        str(phrase["target"]),
        matched_text,
        target_language,
    )
    return {
        "index": index,
        "source_index": phrase["source_index"],
        "target": phrase["target"],
        "normalized_target": normalized_target,
        "available": False,
        "matched": content_matched,
        "content_matched": content_matched,
        "source": "none",
        "similarity": _round_score(similarity),
        "content_similarity": _round_score(similarity),
        "coverage": _round_score(coverage),
        "recognized_start": start,
        "recognized_end": end,
        "normalized_recognized": recognized_normalized[start:end],
        "matched_text": matched_text,
        "audio_start": None,
        "audio_end": None,
        "alignment_confidence": "text_only",
        "boundary_source": "zero_duration_text_only",
        "token_start_index": start_word,
        "token_end_index": end_word,
    }


def _alignment_diagnostics(
    ranges: list[dict[str, object]],
    phrases: list[dict[str, object]],
    word_spans: list[dict[str, object]],
    target_language: str,
    *,
    candidate_count: int,
    score_computation_count: int,
    elapsed_ms: float,
    source: dict[str, object] | None = None,
    segment_source: dict[str, object] | None = None,
) -> dict[str, object]:
    source = source or {
        "raw_count": len(word_spans),
        "flags": [],
        "invalid_units": [],
    }
    segment_source = segment_source or {
        "raw_count": 0,
        "segments": [],
        "flags": [],
        "invalid_units": [],
    }
    owned: set[int] = set()
    playable: set[int] = set()
    for entry in ranges:
        start = entry.get("token_start_index")
        end = entry.get("token_end_index")
        if start is None or end is None:
            continue
        indexes = set(range(int(start), int(end)))
        owned.update(indexes)
        if entry.get("available"):
            playable.update(indexes)
    owned_min = min(owned) if owned else None
    owned_max = max(owned) if owned else None
    unassigned_indexes = [index for index in range(len(word_spans)) if index not in owned]
    filler_indexes: set[int] = set()
    canonical_reasons: dict[int, str] = {}
    run_start = 0
    while run_start < len(unassigned_indexes):
        run_end = run_start + 1
        while (
            run_end < len(unassigned_indexes)
            and unassigned_indexes[run_end] == unassigned_indexes[run_end - 1] + 1
        ):
            run_end += 1
        run_indexes = unassigned_indexes[run_start:run_end]
        run_spans = [word_spans[index] for index in run_indexes]
        if _is_explicit_boundary_filler(run_spans, target_language):
            filler_indexes.update(run_indexes)
        for index, span in zip(run_indexes, run_spans, strict=True):
            if bool(span.get("zero_duration")):
                canonical_reasons[index] = "no_positive_duration"

        core_start = 0
        core_end = len(run_spans)
        for cut in range(1, len(run_spans) + 1):
            if _is_explicit_boundary_filler(run_spans[:cut], target_language):
                core_start = cut
        for cut in range(core_start, len(run_spans)):
            if _is_explicit_boundary_filler(run_spans[cut:], target_language):
                core_end = cut
                break
        for position in [*range(0, core_start), *range(core_end, len(run_spans))]:
            index = run_indexes[position]
            if index not in canonical_reasons:
                canonical_reasons[index] = "boundary_filler"

        core_pairs = [
            (index, span)
            for index, span in zip(
                run_indexes[core_start:core_end],
                run_spans[core_start:core_end],
                strict=True,
            )
            if index not in canonical_reasons
        ]
        if core_pairs:
            marker_index, marker_span = core_pairs[0]
            marker = str(marker_span["normalized"])
            if (
                marker in _NON_SPECIFIC_ALIGNMENT_PIECES.get(target_language, set())
                and any(
                    str(phrase["normalized_target"]).startswith(marker)
                    for phrase in phrases
                )
                and not _strongly_matches_other_target(
                    phrases,
                    set(),
                    [span for _, span in core_pairs],
                )
            ):
                canonical_reasons[marker_index] = "ambiguous_assignment"
                core_pairs = core_pairs[1:]
        if core_pairs:
            core_indexes = [index for index, _ in core_pairs]
            core_spans = [span for _, span in core_pairs]
            if _strongly_matches_other_target(phrases, set(), core_spans):
                core_reason = "out_of_order_speech"
            else:
                candidate = "".join(str(span["normalized"]) for span in core_spans)
                is_target_prefix = any(
                    str(phrase["normalized_target"]).startswith(candidate)
                    and len(candidate) < len(str(phrase["normalized_target"]))
                    for phrase in phrases
                )
                strongest_similarity = max(
                    (
                        practice_similarity(str(phrase["normalized_target"]), candidate)
                        for phrase in phrases
                    ),
                    default=0.0,
                )
                strongest_coverage = max(
                    (
                        _target_character_coverage(str(phrase["normalized_target"]), candidate)
                        for phrase in phrases
                    ),
                    default=0.0,
                )
                first_index = core_indexes[0]
                last_index = core_indexes[-1]
                detached_before = (
                    first_index > 0
                    and float(word_spans[first_index]["audio_start"])
                    - float(word_spans[first_index - 1]["audio_end"])
                    >= _DETACHED_SPEECH_GAP_SECONDS
                )
                detached_after = (
                    last_index + 1 < len(word_spans)
                    and float(word_spans[last_index + 1]["audio_start"])
                    - float(word_spans[last_index]["audio_end"])
                    >= _DETACHED_SPEECH_GAP_SECONDS
                )
                if is_target_prefix:
                    core_reason = "ambiguous_assignment"
                elif not _has_specific_diagnostic_overlap(
                    phrases,
                    core_spans,
                    target_language,
                ):
                    core_reason = "unrelated_speech"
                else:
                    core_reason = (
                        "unrelated_speech"
                        if detached_before
                        or detached_after
                        or (strongest_similarity < 0.35 and strongest_coverage < 0.25)
                        else "ambiguous_assignment"
                    )
            for index in core_indexes:
                canonical_reasons[index] = core_reason
        run_start = run_end

    unassigned = []
    for index in unassigned_indexes:
        span = word_spans[index]
        if index in owned:
            continue
        normalized = str(span["normalized"])
        if index in filler_indexes or normalized in _EDGE_FILLERS.get(target_language, set()):
            reason = "edge_or_boundary_filler"
        elif owned_min is not None and owned_min < index < int(owned_max):
            reason = "unexplained_internal_token"
        else:
            reason = "no_structural_anchor"
        unassigned.append(
            {
                "source": "words",
                "source_index": int(span["token_index"]),
                "index": index,
                "text": span["text"],
                "start": span["audio_start"],
                "end": span["audio_end"],
                "reason": reason,
                "canonical_reason": canonical_reasons.get(index, "ambiguous_assignment"),
            }
        )
    return {
        "total_timestamp_token_count": len(word_spans),
        "playable_token_count": len(playable),
        "unassigned_tokens": unassigned,
        "zero_duration_tokens": [
            {
                "source": "words",
                "source_index": int(span["token_index"]),
                "index": index,
                "text": span["text"],
                "start": span["audio_start"],
                "end": span["audio_end"],
            }
            for index, span in enumerate(word_spans)
            if span.get("zero_duration")
        ],
        "candidate_count": candidate_count,
        "score_computation_count": score_computation_count,
        "alignment_elapsed_ms": round(max(0.0, elapsed_ms), 3),
        "valid_word_count": len(word_spans),
        "valid_segment_count": len(segment_source.get("segments", [])),
        "assigned_word_count": len(owned),
        "assigned_segment_count": 0,
        "playable_word_count": len(playable),
        "unassigned_non_filler_count": sum(
            token["reason"] != "edge_or_boundary_filler" for token in unassigned
        ),
        "diagnostic_flags": sorted(
            {
                *(str(flag) for flag in source["flags"]),
                *(str(flag) for flag in segment_source["flags"]),
                *(
                    str(flag)
                    for entry in ranges
                    for flag in entry.get("diagnostic_flags", [])
                ),
            }
        ),
        "invalid_timestamp_units": [
            *source["invalid_units"],
            *segment_source["invalid_units"],
        ],
        "raw_timestamp_word_count": int(source["raw_count"]),
        "raw_timestamp_segment_count": int(segment_source["raw_count"]),
    }


def _expand_initial_repetition_ranges(
    phrases: list[dict[str, object]],
    selected: tuple[dict[str, object] | None, ...],
    word_spans: list[dict[str, object]],
    recognized_normalized: str,
) -> tuple[dict[str, object] | None, ...]:
    """Keep adjacent restart attempts that repeat a selected phrase's prefix.

    The global alignment intentionally prefers the cleanest matching span. For
    comparison playback, however, an immediately preceding stutter or false
    start is part of the learner's attempt and must be audible. Expansion is
    bounded by the preceding selected phrase, so it cannot consume another
    phrase or a boundary filler.
    """

    expanded: list[dict[str, object] | None] = []
    previous_end_word = 0
    for phrase_index, (phrase, selection) in enumerate(zip(phrases, selected, strict=True)):
        if selection is None:
            expanded.append(None)
            continue

        item = dict(selection)
        start_word = int(item["start_word"])
        end_word = int(item["end_word"])
        original_start_word = start_word
        for candidate_start in range(start_word - 1, previous_end_word - 1, -1):
            if _is_target_prefix_attempt_sequence(
                word_spans[candidate_start:original_start_word],
                str(phrase["normalized_target"]),
            ):
                start_word = candidate_start
        substantial_prefix_start = _earliest_substantial_prefix_attempt_start(
            word_spans,
            previous_end_word,
            original_start_word,
            str(phrase["normalized_target"]),
        )
        if (
            substantial_prefix_start is not None
            and not _nearly_exactly_matches_other_target(
                phrases,
                {phrase_index},
                word_spans[substantial_prefix_start:original_start_word],
            )
        ):
            start_word = min(start_word, substantial_prefix_start)

        if start_word != original_start_word:
            start = int(word_spans[start_word]["normalized_start"])
            end = int(word_spans[end_word - 1]["normalized_end"])
            candidate = recognized_normalized[start:end]
            normalized_target = str(phrase["normalized_target"])
            item.update(
                {
                    "start_word": start_word,
                    "recognized_start": start,
                    "recognized_end": end,
                    "similarity": practice_similarity(normalized_target, candidate),
                    "coverage": _target_character_coverage(normalized_target, candidate),
                }
            )

        expanded.append(item)
        previous_end_word = end_word

    return tuple(expanded)


def _is_target_prefix_attempt_sequence(
    word_spans: list[dict[str, object]],
    normalized_target: str,
) -> bool:
    """Return whether every word can form one or more target-prefix attempts."""

    if not word_spans or not normalized_target:
        return False
    pieces = [str(span["normalized"]) for span in word_spans]
    memo: dict[int, bool] = {}

    def can_partition(start: int) -> bool:
        if start == len(pieces):
            return True
        if start in memo:
            return memo[start]
        attempt = ""
        for end in range(start, len(pieces)):
            attempt += pieces[end]
            if not normalized_target.startswith(attempt):
                break
            if can_partition(end + 1):
                memo[start] = True
                return True
        memo[start] = False
        return False

    return can_partition(0)


def _earliest_substantial_prefix_attempt_start(
    word_spans: list[dict[str, object]],
    minimum_word: int,
    selected_start_word: int,
    normalized_target: str,
) -> int | None:
    """Find a meaningful false start before the clean selected phrase span."""

    if minimum_word >= selected_start_word or not normalized_target:
        return None
    minimum_attempt_length = min(len(normalized_target), max(2, int(len(normalized_target) * 0.25)))
    for candidate_start in range(minimum_word, selected_start_word):
        attempt = ""
        for candidate_end in range(candidate_start, selected_start_word):
            attempt += str(word_spans[candidate_end]["normalized"])
            if not normalized_target.startswith(attempt):
                break
            if len(attempt) >= minimum_attempt_length:
                return candidate_start
    return None


def _expand_trailing_attempt_ranges(
    phrases: list[dict[str, object]],
    selected: tuple[dict[str, object] | None, ...],
    word_spans: list[dict[str, object]],
    recognized_normalized: str,
    target_language: str,
) -> tuple[dict[str, object] | None, ...]:
    """Keep trailing repetitions and non-filler remainder of the last phrase."""

    expanded: list[dict[str, object] | None] = []
    for index, (phrase, selection) in enumerate(zip(phrases, selected, strict=True)):
        if selection is None:
            expanded.append(None)
            continue

        item = dict(selection)
        start_word = int(item["start_word"])
        end_word = int(item["end_word"])
        next_start_word = next(
            (
                int(next_selection["start_word"])
                for next_selection in selected[index + 1 :]
                if next_selection is not None
            ),
            len(word_spans),
        )
        expanded_end_word = end_word
        normalized_target = str(phrase["normalized_target"])

        if index == len(phrases) - 1:
            expanded_end_word = next_start_word
            fillers = _EDGE_FILLERS.get(target_language, set())
            while expanded_end_word > end_word:
                token = str(word_spans[expanded_end_word - 1]["normalized"])
                if token not in fillers or normalized_target.endswith(token):
                    break
                expanded_end_word -= 1
            out_of_order_start = _find_out_of_order_target_start(
                phrases,
                index,
                word_spans,
                end_word,
                expanded_end_word,
            )
            if out_of_order_start is not None:
                expanded_end_word = out_of_order_start
        else:
            for candidate_end in range(end_word + 1, next_start_word + 1):
                if _is_target_suffix_attempt_sequence(
                    word_spans[end_word:candidate_end],
                    normalized_target,
                ):
                    expanded_end_word = candidate_end

        if expanded_end_word != end_word:
            start = int(word_spans[start_word]["normalized_start"])
            end = int(word_spans[expanded_end_word - 1]["normalized_end"])
            candidate = recognized_normalized[start:end]
            item.update(
                {
                    "end_word": expanded_end_word,
                    "recognized_start": start,
                    "recognized_end": end,
                    "similarity": practice_similarity(normalized_target, candidate),
                    "coverage": _target_character_coverage(normalized_target, candidate),
                }
            )

        expanded.append(item)

    return tuple(expanded)


def _find_out_of_order_target_start(
    phrases: list[dict[str, object]],
    current_phrase_index: int,
    word_spans: list[dict[str, object]],
    trailing_start_word: int,
    trailing_end_word: int,
) -> int | None:
    """Find trailing speech that strongly matches another target phrase."""

    other_targets = [
        str(phrase["normalized_target"])
        for index, phrase in enumerate(phrases)
        if index != current_phrase_index
    ]
    for candidate_start in range(trailing_start_word, trailing_end_word):
        candidate = ""
        for candidate_end in range(candidate_start, trailing_end_word):
            candidate += str(word_spans[candidate_end]["normalized"])
            for target in other_targets:
                if (
                    practice_similarity(target, candidate) >= 0.75
                    and _target_character_coverage(target, candidate) >= 0.70
                ):
                    return candidate_start
    return None


def _is_target_suffix_attempt_sequence(
    word_spans: list[dict[str, object]],
    normalized_target: str,
) -> bool:
    """Return whether every word can form one or more target-suffix attempts."""

    if not word_spans or not normalized_target:
        return False
    pieces = [str(span["normalized"]) for span in word_spans]
    memo: dict[int, bool] = {}

    def can_partition(start: int) -> bool:
        if start == len(pieces):
            return True
        if start in memo:
            return memo[start]
        attempt = ""
        for end in range(start, len(pieces)):
            attempt += pieces[end]
            if (
                (len(attempt) >= min(2, len(normalized_target)) or not attempt.isascii())
                and len(attempt) < len(normalized_target)
                and normalized_target.endswith(attempt)
                and can_partition(end + 1)
            ):
                memo[start] = True
                return True
        memo[start] = False
        return False

    return can_partition(0)


def _common_prefix_length(left: str, right: str) -> int:
    length = 0
    for left_character, right_character in zip(left, right):
        if left_character != right_character:
            break
        length += 1
    return length


def _unavailable_alignment_range(
    index: int,
    phrase: dict[str, object],
    normalized_target: str,
) -> dict[str, object]:
    return {
        "index": index,
        "source_index": phrase["source_index"],
        "target": phrase["target"],
        "normalized_target": normalized_target,
        "available": False,
        "matched": False,
        "content_matched": None,
        "source": "none",
        "similarity": 0.0,
        "content_similarity": 0.0,
        "coverage": 0.0,
        "recognized_start": None,
        "recognized_end": None,
        "normalized_recognized": "",
        "matched_text": "",
        "audio_start": None,
        "audio_end": None,
        "alignment_confidence": "unavailable",
        "boundary_source": "none",
        "token_start_index": None,
        "token_end_index": None,
    }


def _align_single_phrase_to_word_spans(
    phrase: dict[str, object],
    recognized_normalized: str,
    word_spans: list[dict[str, object]],
    target_language: str,
) -> dict[str, object]:
    normalized_target = str(phrase["normalized_target"])
    selected_spans = _trim_edge_filler_spans(word_spans, normalized_target, target_language)
    if not selected_spans:
        return _unavailable_alignment_range(0, phrase, normalized_target)

    start = int(selected_spans[0]["normalized_start"])
    end = int(selected_spans[-1]["normalized_end"])
    start_word = word_spans.index(selected_spans[0])
    end_word = word_spans.index(selected_spans[-1]) + 1
    selected_normalized = recognized_normalized[start:end]
    similarity = practice_similarity(normalized_target, selected_normalized)
    coverage = _target_character_coverage(normalized_target, selected_normalized)
    audio_start, audio_end = _safe_alignment_audio_bounds(selected_spans)
    if audio_start is None or audio_end is None or audio_end <= audio_start:
        return _text_only_alignment_range(
            0,
            phrase,
            normalized_target,
            selected_spans,
            start,
            end,
            recognized_normalized,
            target_language,
            start_word,
            end_word,
            similarity,
            coverage,
        )
    content_matched = practice_content_matches(
        str(phrase["target"]),
        _join_matched_words(selected_spans, target_language),
        target_language,
    )
    return {
        "index": 0,
        "source_index": phrase["source_index"],
        "target": phrase["target"],
        "normalized_target": normalized_target,
        "available": True,
        "matched": content_matched,
        "content_matched": content_matched,
        "source": "words",
        "similarity": _round_score(similarity),
        "content_similarity": _round_score(similarity),
        "coverage": _round_score(coverage),
        "recognized_start": start,
        "recognized_end": end,
        "normalized_recognized": selected_normalized,
        "matched_text": _join_matched_words(selected_spans, target_language),
        "audio_start": audio_start,
        "audio_end": audio_end,
        "alignment_confidence": _alignment_confidence(similarity, coverage),
        "boundary_source": "single_phrase",
        "token_start_index": start_word,
        "token_end_index": end_word,
    }


def _trim_edge_filler_spans(
    word_spans: list[dict[str, object]],
    normalized_target: str,
    target_language: str,
) -> list[dict[str, object]]:
    selected = list(word_spans)
    fillers = _EDGE_FILLERS.get(target_language, set())
    while selected:
        token = str(selected[0]["normalized"])
        if token not in fillers or normalized_target.startswith(token):
            break
        selected.pop(0)
    while selected:
        token = str(selected[-1]["normalized"])
        if token not in fillers or normalized_target.endswith(token):
            break
        selected.pop()
    return selected


def _join_matched_words(word_spans: list[dict[str, object]], target_language: str) -> str:
    words = [str(span.get("text") or "") for span in word_spans if str(span.get("text") or "")]
    if target_language in {"ja-JP", "zh-CN"}:
        return "".join(words)
    return " ".join(words)


def _safe_float(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if isfinite(number) else None


def _timestamp_value(value: object) -> tuple[float | None, str | None]:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None, "non_numeric"
    if not isfinite(number):
        return None, "non_finite"
    return number, None


def _timestamp_unit_values(
    start_value: object,
    end_value: object,
) -> tuple[float | None, float | None, str | None]:
    start, start_error = _timestamp_value(start_value)
    end, end_error = _timestamp_value(end_value)
    if start_error is not None or end_error is not None:
        reason = "non_numeric" if "non_numeric" in {start_error, end_error} else "non_finite"
        return start, end, reason
    if start is not None and start < 0:
        return start, end, "negative_start"
    if start is not None and end is not None and end < start:
        return start, end, "end_before_start"
    return start, end, None


def _invalid_timestamp_unit(
    source: str,
    source_index: int,
    text: str,
    start: object,
    end: object,
    reason: str,
) -> dict[str, object]:
    return {
        "source": source,
        "source_index": source_index,
        "text": text,
        "start": start,
        "end": end,
        "reason": reason,
    }


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
