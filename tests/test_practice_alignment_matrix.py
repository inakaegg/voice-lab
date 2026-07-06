from __future__ import annotations

from dataclasses import dataclass

import pytest

from mo_speech.practice import practice_comparison_alignment


@dataclass(frozen=True)
class Phrase:
    text: str
    words: tuple[str, ...]


@dataclass(frozen=True)
class AlignmentCase:
    name: str
    language: str
    phrases: tuple[Phrase, ...]
    words: tuple[dict[str, object], ...]
    expected_complete: bool | None
    min_available: int
    max_available: int | None = None
    expect_low_similarity: bool = False

    @property
    def target_text(self) -> str:
        return "".join(phrase.text for phrase in self.phrases)

    @property
    def recognized_text(self) -> str:
        separator = " " if self.language == "en-US" else ""
        return separator.join(str(word["text"]) for word in self.words)


FILLERS = {
    "en-US": "um",
    "ja-JP": "えー",
    "zh-CN": "嗯",
}
EXTRAS = {
    "en-US": "today",
    "ja-JP": "ちょっと",
    "zh-CN": "那个",
}
WRONG_WORDS = {
    "en-US": "bus",
    "ja-JP": "電車",
    "zh-CN": "奶茶",
}
SELF_CORRECTIONS = {
    "en-US": "car",
    "ja-JP": "昨日",
    "zh-CN": "昨天",
}
PRONUNCIATION_CONFUSIONS = {
    "en-US": {
        "to": "too",
        "there": "their",
        "train": "terrain",
    },
    "ja-JP": {
        "買いました": "変えました",
        "公園に": "講演に",
        "駅の": "液の",
    },
    "zh-CN": {
        "想": "香",
        "买了": "卖了",
        "公园": "工院",
    },
}


SCRIPTS: dict[str, tuple[tuple[Phrase, ...], ...]] = {
    "en-US": (
        (
            Phrase("I bought a bike.", ("I", "bought", "a", "bike")),
            Phrase("It is my first road bike.", ("It", "is", "my", "first", "road", "bike")),
            Phrase("The price was high.", ("The", "price", "was", "high")),
        ),
        (
            Phrase("I want some coffee.", ("I", "want", "some", "coffee")),
            Phrase("Can I pay by card?", ("Can", "I", "pay", "by", "card")),
            Phrase("Thank you.", ("Thank", "you")),
        ),
        (
            Phrase("Yesterday I studied Chinese.", ("Yesterday", "I", "studied", "Chinese")),
            Phrase("The tones were difficult.", ("The", "tones", "were", "difficult")),
            Phrase("I will try again.", ("I", "will", "try", "again")),
        ),
        (
            Phrase("Please open the window.", ("Please", "open", "the", "window")),
            Phrase("It is a little hot.", ("It", "is", "a", "little", "hot")),
            Phrase("The weather is nice.", ("The", "weather", "is", "nice")),
        ),
        (
            Phrase("I live near the station.", ("I", "live", "near", "the", "station")),
            Phrase("The train is convenient.", ("The", "train", "is", "convenient")),
            Phrase("I go there every day.", ("I", "go", "there", "every", "day")),
        ),
    ),
    "ja-JP": (
        (
            Phrase("昨日自転車を買いました。", ("昨日", "自転車を", "買いました")),
            Phrase("初めてのロードバイクです。", ("初めての", "ロードバイクです")),
            Phrase("値段は高かったです。", ("値段は", "高かったです")),
        ),
        (
            Phrase("今日は公園に行きました。", ("今日は", "公園に", "行きました")),
            Phrase("天気がとてもよかったです。", ("天気が", "とても", "よかったです")),
            Phrase("また行きたいです。", ("また", "行きたいです")),
        ),
        (
            Phrase("コーヒーを一杯ください。", ("コーヒーを", "一杯", "ください")),
            Phrase("カードで払えますか。", ("カードで", "払えますか")),
            Phrase("ありがとうございます。", ("ありがとうございます",)),
        ),
        (
            Phrase("駅の近くに住んでいます。", ("駅の", "近くに", "住んでいます")),
            Phrase("電車が便利です。", ("電車が", "便利です")),
            Phrase("毎日そこへ行きます。", ("毎日", "そこへ", "行きます")),
        ),
        (
            Phrase("窓を開けてください。", ("窓を", "開けて", "ください")),
            Phrase("少し暑いです。", ("少し", "暑いです")),
            Phrase("外は涼しいです。", ("外は", "涼しいです")),
        ),
    ),
    "zh-CN": (
        (
            Phrase("昨天买了一辆自行车。", ("昨天", "买了", "一辆", "自行车")),
            Phrase("这是我的第一辆公路车。", ("这是", "我的", "第一辆", "公路车")),
            Phrase("价格还挺贵的。", ("价格", "还挺", "贵的")),
        ),
        (
            Phrase("我想喝咖啡。", ("我", "想", "喝", "咖啡")),
            Phrase("可以刷卡吗？", ("可以", "刷卡", "吗")),
            Phrase("谢谢。", ("谢谢",)),
        ),
        (
            Phrase("昨天我学习中文。", ("昨天", "我", "学习", "中文")),
            Phrase("声调有点难。", ("声调", "有点", "难")),
            Phrase("我会再练习。", ("我", "会", "再", "练习")),
        ),
        (
            Phrase("请打开窗户。", ("请", "打开", "窗户")),
            Phrase("今天有点热。", ("今天", "有点", "热")),
            Phrase("天气很好。", ("天气", "很好")),
        ),
        (
            Phrase("我住在车站附近。", ("我", "住在", "车站", "附近")),
            Phrase("坐火车很方便。", ("坐", "火车", "很", "方便")),
            Phrase("我每天去那里。", ("我", "每天", "去", "那里")),
        ),
    ),
}


def _audio_ranges_are_monotonic(ranges: list[dict[str, object]]) -> bool:
    previous_end = -1.0
    for entry in ranges:
        start = float(entry["audio_start"])
        end = float(entry["audio_end"])
        if start < previous_end or end <= start:
            return False
        previous_end = end
    return True


def _build_matrix_cases() -> list[AlignmentCase]:
    cases: list[AlignmentCase] = []
    for language, scripts in SCRIPTS.items():
        for script_index, phrases in enumerate(scripts):
            for mutation in MUTATIONS:
                words, expectation = mutation(language, phrases)
                cases.append(
                    AlignmentCase(
                        name=f"{language}_{script_index}_{mutation.__name__}",
                        language=language,
                        phrases=phrases,
                        words=tuple(_timestamp_words(words)),
                        expected_complete=expectation["complete"],
                        min_available=expectation["min_available"],
                        max_available=expectation.get("max_available"),
                        expect_low_similarity=bool(expectation.get("low_similarity", False)),
                    )
                )
    return cases


def _timestamp_words(words: list[dict[str, object] | str]) -> list[dict[str, object]]:
    output: list[dict[str, object]] = []
    cursor = 0.0
    for item in words:
        if isinstance(item, dict):
            text = str(item["text"])
            gap_before = float(item.get("gap_before", 0.0))
            gap_after = float(item.get("gap_after", 0.08))
        else:
            text = str(item)
            gap_before = 0.0
            gap_after = 0.08
        cursor += gap_before
        duration = max(0.12, min(0.5, 0.05 * len(text) + 0.1))
        output.append({"text": text, "start": round(cursor, 3), "end": round(cursor + duration, 3)})
        cursor += duration + gap_after
    return output


def _all_words(phrases: tuple[Phrase, ...]) -> list[str]:
    return [word for phrase in phrases for word in phrase.words]


def _phrase_words(phrases: tuple[Phrase, ...], indexes: set[int] | None = None) -> list[str]:
    allowed = set(range(len(phrases))) if indexes is None else indexes
    return [word for index, phrase in enumerate(phrases) if index in allowed for word in phrase.words]


def _with_gaps(words: list[str], gap_after: float) -> list[dict[str, object]]:
    return [{"text": word, "gap_after": gap_after} for word in words]


def _insert_after_first(words: tuple[str, ...], insert: str) -> list[str]:
    if not words:
        return [insert]
    return [words[0], insert, *words[1:]]


def _replace_first_known_word(language: str, phrases: tuple[Phrase, ...], replacement: str) -> list[str]:
    words = _all_words(phrases)
    if not words:
        return []
    return [replacement, *words[1:]]


def exact(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    return _all_words(phrases), {"complete": True, "min_available": len(phrases)}


def leading_filler(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    return [FILLERS[language], *_all_words(phrases)], {"complete": True, "min_available": len(phrases)}


def trailing_filler(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    return [*_all_words(phrases), FILLERS[language]], {"complete": True, "min_available": len(phrases)}


def filler_between_phrases(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    words: list[str] = []
    for index, phrase in enumerate(phrases):
        if index > 0:
            words.append(FILLERS[language])
        words.extend(phrase.words)
    return words, {"complete": True, "min_available": len(phrases)}


def filler_inside_first_phrase(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    return [
        *_insert_after_first(phrases[0].words, FILLERS[language]),
        *_phrase_words(phrases, set(range(1, len(phrases)))),
    ], {"complete": True, "min_available": len(phrases), "low_similarity": True}


def filler_inside_each_phrase(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    words: list[str] = []
    for phrase in phrases:
        words.extend(_insert_after_first(phrase.words, FILLERS[language]))
    return words, {"complete": True, "min_available": len(phrases), "low_similarity": True}


def extra_before_first(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    return [EXTRAS[language], *_all_words(phrases)], {"complete": True, "min_available": len(phrases)}


def extra_between_phrases(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    words: list[str] = []
    for index, phrase in enumerate(phrases):
        if index > 0:
            words.append(EXTRAS[language])
        words.extend(phrase.words)
    return words, {"complete": True, "min_available": len(phrases)}


def extra_inside_each_phrase(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    words: list[str] = []
    for phrase in phrases:
        words.extend(_insert_after_first(phrase.words, EXTRAS[language]))
    return words, {"complete": True, "min_available": len(phrases), "low_similarity": True}


def stutter_first_word(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    first = phrases[0].words[0]
    return [first, *_all_words(phrases)], {"complete": True, "min_available": len(phrases)}


def stutter_each_phrase_first_word(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    words: list[str] = []
    for phrase in phrases:
        words.extend((phrase.words[0], *phrase.words))
    return words, {"complete": True, "min_available": len(phrases)}


def repeat_first_phrase_before_second(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    words = [*phrases[0].words, *phrases[0].words, *_phrase_words(phrases, set(range(1, len(phrases))))]
    return words, {"complete": True, "min_available": len(phrases)}


def repeat_last_phrase_after_end(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    words = [*_all_words(phrases), *phrases[-1].words]
    return words, {"complete": True, "min_available": len(phrases)}


def pause_between_phrases(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[dict[str, object]], dict[str, object]]:
    words: list[dict[str, object]] = []
    for index, phrase in enumerate(phrases):
        for word in phrase.words:
            words.append({"text": word, "gap_after": 0.08})
        if index < len(phrases) - 1:
            words[-1]["gap_after"] = 0.75
    return words, {"complete": True, "min_available": len(phrases)}


def long_pause_inside_first_phrase(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[dict[str, object]], dict[str, object]]:
    words: list[dict[str, object]] = []
    for phrase_index, phrase in enumerate(phrases):
        for word_index, word in enumerate(phrase.words):
            words.append({"text": word, "gap_after": 0.9 if phrase_index == 0 and word_index == 0 else 0.08})
    return words, {"complete": True, "min_available": len(phrases)}


def omit_first_phrase(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    return _phrase_words(phrases, set(range(1, len(phrases)))), {
        "complete": False,
        "min_available": len(phrases) - 1,
        "max_available": len(phrases) - 1,
    }


def omit_middle_phrase(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    return _phrase_words(phrases, {0, len(phrases) - 1}), {
        "complete": False,
        "min_available": len(phrases) - 1,
        "max_available": len(phrases) - 1,
    }


def omit_last_phrase(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    return _phrase_words(phrases, set(range(0, len(phrases) - 1))), {
        "complete": False,
        "min_available": len(phrases) - 1,
        "max_available": len(phrases) - 1,
    }


def omit_first_word_each_phrase(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    words = [word for phrase in phrases for word in phrase.words[1:]]
    return words, {"complete": None, "min_available": 1, "low_similarity": True}


def omit_last_word_each_phrase(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    words = [word for phrase in phrases for word in phrase.words[:-1]]
    return words, {"complete": None, "min_available": 1, "low_similarity": True}


def vocab_mistake_first_phrase(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    words = _replace_first_known_word(language, phrases, WRONG_WORDS[language])
    return words, {"complete": True, "min_available": len(phrases), "low_similarity": True}


def vocab_mistake_each_phrase(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    words: list[str] = []
    for phrase in phrases:
        words.extend(_insert_after_first(phrase.words, WRONG_WORDS[language]))
    return words, {"complete": True, "min_available": len(phrases), "low_similarity": True}


def self_correction_first_phrase(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    words = [SELF_CORRECTIONS[language], *_all_words(phrases)]
    return words, {"complete": True, "min_available": len(phrases)}


def pronunciation_confusion_first_phrase(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    replacements = PRONUNCIATION_CONFUSIONS[language]
    words = _all_words(phrases)
    confused = [replacements.get(word, word) for word in words]
    if confused == words:
        confused = _replace_first_known_word(language, phrases, WRONG_WORDS[language])
    return confused, {"complete": True, "min_available": len(phrases), "low_similarity": True}


def wrong_order_reverse(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    words = [word for phrase in reversed(phrases) for word in phrase.words]
    return words, {"complete": False, "min_available": 1, "max_available": len(phrases) - 1}


def wrong_order_swap_first_two(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    reordered = (phrases[1], phrases[0], *phrases[2:])
    words = [word for phrase in reordered for word in phrase.words]
    return words, {"complete": False, "min_available": 1, "max_available": len(phrases) - 1}


def no_word_timestamps(language: str, phrases: tuple[Phrase, ...]) -> tuple[list[str], dict[str, object]]:
    return [], {"complete": False, "min_available": 0, "max_available": 0}


MUTATIONS = (
    exact,
    leading_filler,
    trailing_filler,
    filler_between_phrases,
    filler_inside_first_phrase,
    filler_inside_each_phrase,
    extra_before_first,
    extra_between_phrases,
    extra_inside_each_phrase,
    stutter_first_word,
    stutter_each_phrase_first_word,
    repeat_first_phrase_before_second,
    repeat_last_phrase_after_end,
    pause_between_phrases,
    long_pause_inside_first_phrase,
    omit_first_phrase,
    omit_middle_phrase,
    omit_last_phrase,
    omit_first_word_each_phrase,
    omit_last_word_each_phrase,
    vocab_mistake_first_phrase,
    vocab_mistake_each_phrase,
    self_correction_first_phrase,
    pronunciation_confusion_first_phrase,
    wrong_order_reverse,
    wrong_order_swap_first_two,
    no_word_timestamps,
)

MATRIX_CASES = _build_matrix_cases()


def test_practice_alignment_matrix_has_at_least_100_cases_per_language() -> None:
    counts = {language: 0 for language in SCRIPTS}
    for case in MATRIX_CASES:
        counts[case.language] += 1

    assert counts == {"en-US": 135, "ja-JP": 135, "zh-CN": 135}


@pytest.mark.parametrize("case", MATRIX_CASES, ids=lambda case: case.name)
def test_practice_comparison_alignment_matrix(case: AlignmentCase) -> None:
    result = practice_comparison_alignment(
        target_text=case.target_text,
        recognized_text=case.recognized_text,
        target_language=case.language,
        asr_timestamps={"available": bool(case.words), "words": list(case.words)},
    )
    ranges = result["ranges"]
    available = [entry for entry in ranges if entry["available"]]

    assert len(ranges) == len(case.phrases)
    assert len(available) >= case.min_available
    if case.max_available is not None:
        assert len(available) <= case.max_available
    if case.expected_complete is not None:
        assert result["complete"] is case.expected_complete
    if case.expect_low_similarity:
        assert any(float(entry["similarity"]) < 0.999 for entry in ranges)
    assert _audio_ranges_are_monotonic(available)
