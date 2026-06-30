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
    similarity = practice_similarity(normalized_target, normalized_recognized)
    grade = practice_grade(similarity)
    return {
        "normalized_target": normalized_target,
        "normalized_recognized": normalized_recognized,
        "similarity": round(similarity, 3),
        "grade": grade,
        "grade_label": PRACTICE_GRADE_LABELS[grade],
        "diff": practice_diff(normalized_target, normalized_recognized),
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


def _katakana_to_hiragana(text: str) -> str:
    return re.sub(
        r"[\u30a1-\u30f6]",
        lambda match: chr(ord(match.group(0)) - 0x60),
        text,
    )
