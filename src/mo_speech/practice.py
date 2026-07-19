from __future__ import annotations
import re
import unicodedata
from opencc import OpenCC


PRACTICE_TARGET_LANGUAGES = {
    "ja-JP": {"label": "日本語", "speech_name": "Japanese"},
    "zh-CN": {"label": "中文", "speech_name": "Mandarin Chinese"},
    "en-US": {"label": "English", "speech_name": "English"},
}


_CHINESE_TRADITIONAL_TO_SIMPLIFIED = OpenCC("t2s")


_MAX_CANONICAL_TARGET_PHRASES = 16


_PRACTICE_HARD_BOUNDARIES = frozenset("。！？!?；;\n")


_PRACTICE_CLOSING_PUNCTUATION = frozenset("\"'”’」』】）》）)]}")


_PRACTICE_PROTECTED_ABBREVIATIONS = frozenset(
    {"dr", "jr", "mr", "mrs", "ms", "prof", "sr", "st"}
)


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


def _katakana_to_hiragana(text: str) -> str:
    return re.sub(
        r"[\u30a1-\u30f6]",
        lambda match: chr(ord(match.group(0)) - 0x60),
        text,
    )
