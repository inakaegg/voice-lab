from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher


PRACTICE_TARGET_LANGUAGES = {
    "ja-JP": {"label": "日本語", "speech_name": "Japanese"},
    "zh-CN": {"label": "中文", "speech_name": "Mandarin Chinese"},
    "en-US": {"label": "English", "speech_name": "English"},
}

PRACTICE_GRADE_LABELS = {
    "ok": "いいかんじ",
    "almost": "もうすこし",
    "retry": "ちがうかも",
}
_ZH_TRADITIONAL_TO_SIMPLIFIED = str.maketrans(
    {
        "後": "后",
        "裏": "里",
        "裡": "里",
        "著": "着",
        "麼": "么",
        "麽": "么",
        "樣": "样",
        "嗎": "吗",
        "呢": "呢",
        "妳": "你",
        "們": "们",
        "個": "个",
        "這": "这",
        "那": "那",
        "哪": "哪",
        "會": "会",
        "說": "说",
        "話": "话",
        "語": "语",
        "學": "学",
        "習": "习",
        "聽": "听",
        "問": "问",
        "題": "题",
        "現": "现",
        "開": "开",
        "關": "关",
        "見": "见",
        "歡": "欢",
        "愛": "爱",
        "買": "买",
        "賣": "卖",
        "車": "车",
        "輛": "辆",
        "價": "价",
        "還": "还",
        "貴": "贵",
        "綠": "绿",
        "啡": "啡",
        "種": "种",
        "點": "点",
        "氣": "气",
        "電": "电",
        "腦": "脑",
        "網": "网",
        "寫": "写",
        "讀": "读",
        "書": "书",
        "時": "时",
        "間": "间",
        "國": "国",
        "東": "东",
        "風": "风",
        "來": "来",
        "過": "过",
        "長": "长",
        "門": "门",
        "無": "无",
        "實": "实",
        "體": "体",
        "應": "应",
        "讓": "让",
        "給": "给",
        "對": "对",
        "從": "从",
        "為": "为",
        "發": "发",
        "聲": "声",
        "區": "区",
        "別": "别",
        "當": "当",
        "幾": "几",
        "難": "难",
        "簡": "简",
        "漢": "汉",
        "雖": "虽",
        "舊": "旧",
        "新": "新",
    }
)


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
        normalized = normalized.translate(_ZH_TRADITIONAL_TO_SIMPLIFIED)
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
    if similarity >= 0.82:
        return "ok"
    if similarity >= 0.45:
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
    phrases = [match.group(0).strip() for match in re.finditer(r"[^。！？!?.,，、；;\n]+[。！？!?.,，、；;]?", normalized)]
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


def classify_practice_recording(
    *,
    target_text: str,
    target_language: str,
    target_recognized_text: str,
    auto_recognized_text: str,
) -> dict[str, object]:
    language = supported_practice_target_language(target_language)
    if not target_text.strip():
        return {
            "kind": "prompt",
            "attempt_source": "",
            "target_similarity": 0.0,
            "auto_similarity": 0.0,
            "target_language_signal": 0.0,
            "auto_language_signal": practice_language_signal(auto_recognized_text, language),
        }

    target_evaluation = evaluate_practice_attempt(target_text, target_recognized_text, language)
    auto_evaluation = evaluate_practice_attempt(target_text, auto_recognized_text, language)
    target_similarity = float(target_evaluation["similarity"])
    auto_similarity = float(auto_evaluation["similarity"])
    target_signal = practice_language_signal(target_recognized_text, language)
    auto_signal = practice_language_signal(auto_recognized_text, language)
    best_similarity = max(target_similarity, auto_similarity if auto_signal >= 0.35 else 0.0)
    attempt_source = "target" if target_similarity >= auto_similarity else "auto"
    is_attempt = (
        best_similarity >= 0.35
        or (target_similarity >= 0.25 and target_signal >= 0.3)
        or (auto_similarity >= 0.25 and auto_signal >= 0.55)
    )
    return {
        "kind": "attempt" if is_attempt else "prompt",
        "attempt_source": attempt_source if is_attempt else "",
        "target_similarity": round(target_similarity, 3),
        "auto_similarity": round(auto_similarity, 3),
        "target_language_signal": round(target_signal, 3),
        "auto_language_signal": round(auto_signal, 3),
    }


def practice_language_signal(text: str, target_language: str) -> float:
    language = supported_practice_target_language(target_language)
    content = [char for char in str(text or "") if not unicodedata.category(char).startswith(("P", "Z", "S"))]
    if not content:
        return 0.0
    if language == "zh-CN":
        matching = sum(1 for char in content if _is_han_character(char))
    elif language == "ja-JP":
        matching = sum(1 for char in content if _is_han_character(char) or "\u3040" <= char <= "\u30ff")
    elif language == "en-US":
        matching = sum(1 for char in content if "a" <= char.lower() <= "z")
    else:
        matching = 0
    return matching / len(content)


def _best_practice_phrase_match(target_normalized: str, recognized_normalized: str, start_index: int) -> dict[str, float]:
    if not target_normalized or not recognized_normalized or start_index >= len(recognized_normalized):
        start = min(max(0, start_index), len(recognized_normalized))
        return {"recognized_start": start, "recognized_end": start, "similarity": 0.0}
    best = {"recognized_start": start_index, "recognized_end": start_index, "similarity": 0.0}
    expected_length = len(target_normalized)
    min_length = max(1, int(expected_length * 0.45))
    max_length = max(min_length, int(expected_length * 1.8) + 3)
    for start in range(start_index, len(recognized_normalized)):
        last_end = min(len(recognized_normalized), start + max_length)
        for end in range(start + min_length, last_end + 1):
            candidate = recognized_normalized[start:end]
            similarity = practice_similarity(target_normalized, candidate)
            if similarity > best["similarity"]:
                best = {"recognized_start": start, "recognized_end": end, "similarity": similarity}
            if similarity >= 0.999:
                return best
    return best


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
