from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any, Mapping, Sequence


STAGE_SIZES = [3, 6, 12, 24, 48, 96, 192, 384]

_CONTEXT_SETS = [
    ["你好，很高兴认识你。", "我正在学习中文。", "请你说慢一点。", "谢谢你的帮助。"],
    ["早上好，我们开始吧。", "今天的天气很好。", "下午我想去公园。", "明天我们再见。"],
    ["我有一个问题。", "请你仔细听一下。", "这个句子有点难。", "我想再练习一次。"],
    ["我刚刚来到这里。", "现在我住在上海。", "周末我常去图书馆。", "晚上我在家休息。"],
    ["请问你有时间吗？", "我想预订一张票。", "火车下午三点出发。", "到站以后给我打电话。"],
    ["今天我要去上课。", "老师让我们读课文。", "下课以后一起吃饭。", "然后我们回宿舍。"],
    ["欢迎来到北京。", "这里有很多好吃的。", "我们先坐地铁。", "最后去看夜景。"],
    ["我身体不太舒服。", "昨天晚上没有睡好。", "医生让我多喝水。", "今天应该早点休息。"],
    ["我想买一些东西。", "这件衣服多少钱？", "可以便宜一点吗？", "我用手机付款。"],
    ["周末你有什么计划？", "我打算和朋友见面。", "我们一起喝咖啡。", "晚上去看电影。"],
    ["请告诉我怎么走。", "一直往前走。", "在第二个路口左转。", "车站就在银行旁边。"],
    ["我的中文还不太好。", "有时候我听不明白。", "请你不要说得太快。", "我会继续努力。"],
]

_ACOUSTIC_PROFILES: list[dict[str, object]] = [
    {"name": "clear", "voice": "Tingting", "rate_wpm": 160, "pause_ms": 260},
    {
        "name": "slow",
        "voice": "Eddy (中国語（中国本土）)",
        "rate_wpm": 125,
        "tempo": 0.9,
        "pause_ms": 520,
    },
    {
        "name": "fast",
        "voice": "Flo (中国語（中国本土）)",
        "rate_wpm": 225,
        "tempo": 1.12,
        "pause_ms": 120,
    },
    {
        "name": "quiet",
        "voice": "Reed (中国語（中国本土）)",
        "rate_wpm": 155,
        "volume_db": -12.0,
        "pause_ms": 320,
    },
    {
        "name": "lowpass",
        "voice": "Sandy (中国語（中国本土）)",
        "rate_wpm": 165,
        "lowpass_hz": 3200,
        "pause_ms": 280,
    },
    {
        "name": "light-noise",
        "voice": "Shelley (中国語（中国本土）)",
        "rate_wpm": 150,
        "noise_amplitude": 0.003,
        "pause_ms": 380,
    },
    {
        "name": "room-echo",
        "voice": "Grandpa (中国語（中国本土）)",
        "rate_wpm": 145,
        "echo_delay_ms": 90,
        "echo_decay": 0.22,
        "pause_ms": 600,
    },
    {
        "name": "flat-f0",
        "voice": "Grandma (中国語（中国本土）)",
        "rate_wpm": 150,
        "pitch_contour": "flat",
        "pause_ms": 360,
    },
    {
        "name": "rising-f0",
        "voice": "Rocko (中国語（中国本土）)",
        "rate_wpm": 165,
        "pitch_contour": "rising",
        "pause_ms": 220,
    },
    {
        "name": "falling-f0",
        "voice": "Eddy (中国語（中国本土）)",
        "rate_wpm": 165,
        "pitch_contour": "falling",
        "pause_ms": 220,
    },
    {
        "name": "short-pauses",
        "voice": "Tingting",
        "rate_wpm": 175,
        "pause_ms": 90,
    },
    {
        "name": "long-pauses",
        "voice": "Flo (中国語（中国本土）)",
        "rate_wpm": 140,
        "pause_ms": 1100,
    },
]


def build_staged_comparison_manifest(
    pilot_manifest: Mapping[str, object],
    sample_manifests: Sequence[Mapping[str, object]],
    *,
    case_count: int = 384,
) -> dict[str, object]:
    pilot_cases = pilot_manifest.get("cases")
    if not isinstance(pilot_cases, list) or len(pilot_cases) != 3:
        raise ValueError("paired pilot must contain exactly three seed cases")
    if case_count < len(pilot_cases):
        raise ValueError("case_count must preserve the three seed cases")

    source_cases = _eligible_chinese_sources(sample_manifests)
    if not source_cases:
        raise ValueError("no eligible Chinese source cases")

    cases = deepcopy(pilot_cases)
    for index in range(len(cases), case_count):
        source_index = (index - len(pilot_cases)) % len(source_cases)
        profile_index = ((index - len(pilot_cases)) // len(source_cases)) % len(
            _ACOUSTIC_PROFILES
        )
        source = source_cases[source_index]
        profile = _ACOUSTIC_PROFILES[profile_index]
        cases.append(_build_case(index, source, profile))

    return {
        "schema_version": 1,
        "created_at": "2026-07-17",
        "purpose": (
            "中国語学習者の発音・脱落・挿入・流暢性・録音条件を模したpaired音声を、"
            "FunASRからcanonical alignmentとUI playback planまで段階評価する。"
        ),
        "stage_sizes": [size for size in STAGE_SIZES if size <= case_count],
        "evaluation_policy": deepcopy(pilot_manifest["evaluation_policy"]),
        "provenance": {
            "seed_fixture": "tests/fixtures/asr_comparison_pair_pilot.json",
            "source_fixtures": [
                "tests/fixtures/asr_learning_samples_manifest.json",
                "tests/fixtures/asr_learning_samples_manifest_pilot_2.json",
            ],
            "expectation_timing": "ASR実行前に生成規則と期待phrase indexを固定する。",
            "limitations": [
                "Apple TTSと音響加工は制御可能なproxyであり、実在学習者の録音ではない。",
                "文字置換は発音誤りを近似するが、調音そのものを完全再現しない。",
                "段階合格後も実録音holdoutによる確認が別途必要である。",
            ],
        },
        "cases": cases,
    }


def load_json_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"JSON root must be an object: {path}")
    return payload


def _eligible_chinese_sources(
    manifests: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    eligible: list[dict[str, object]] = []
    for manifest in manifests:
        raw_cases = manifest.get("cases")
        if not isinstance(raw_cases, list):
            continue
        for raw_case in raw_cases:
            if not isinstance(raw_case, Mapping) or raw_case.get("language") != "zh-CN":
                continue
            target = str(raw_case.get("target_text") or "").strip()
            spoken = str(raw_case.get("expected_spoken_text") or "").strip()
            if not target or not spoken or _hard_boundary_count(target) != 1:
                continue
            eligible.append(dict(raw_case))
    return eligible


def _build_case(
    index: int,
    source: Mapping[str, object],
    profile: Mapping[str, object],
) -> dict[str, object]:
    context = list(_CONTEXT_SETS[index % len(_CONTEXT_SETS)])
    phrase_count = 2 + (index % 3)
    target_phrases = context[:phrase_count]
    changed_index = (index // 3) % phrase_count
    target_phrases[changed_index] = str(source["target_text"])

    omission_kind = _omission_kind(index)
    omitted_index = (
        changed_index
        if omission_kind == "changed"
        else (0 if omission_kind == "leading" else phrase_count - 1)
        if omission_kind
        else None
    )
    model_segments = _segments(
        target_phrases,
        pause_ms=240 + ((index % 4) * 60),
    )
    attempt_segments: list[dict[str, object]] = []
    for phrase_index, phrase in enumerate(target_phrases):
        if phrase_index == omitted_index:
            continue
        text = (
            str(source["expected_spoken_text"])
            if phrase_index == changed_index
            else phrase
        )
        segment: dict[str, object] = {
            "phrase_index": phrase_index,
            "text": text,
        }
        if phrase_index < phrase_count - 1:
            segment["pause_after_ms"] = int(profile["pause_ms"])
        if phrase_index == changed_index and profile.get("pitch_contour"):
            segment["pitch_contour"] = profile["pitch_contour"]
        attempt_segments.append(segment)

    attempt_indices = [int(segment["phrase_index"]) for segment in attempt_segments]
    all_indices = list(range(phrase_count))
    category = (
        f"phrase_omission_{omission_kind}"
        if omission_kind
        else str(source["category"])
    )
    source_id = str(source["id"])
    profile_name = str(profile["name"])
    return {
        "id": f"pair-zh-{index + 1:03d}-{source_id}-{profile_name}",
        "language": "zh-CN",
        "category": category,
        "source_case_id": source_id,
        "acoustic_profile": profile_name,
        "target_phrases": target_phrases,
        "model": {
            "voice": "Tingting" if index % 2 == 0 else "Eddy (中国語（中国本土）)",
            "rate_wpm": 155 + ((index % 3) * 10),
            "segments": model_segments,
        },
        "attempt": {
            **{
                key: value
                for key, value in profile.items()
                if key
                in {
                    "voice",
                    "rate_wpm",
                    "tempo",
                    "noise_amplitude",
                    "volume_db",
                    "lowpass_hz",
                    "echo_delay_ms",
                    "echo_decay",
                }
            },
            "segments": attempt_segments,
        },
        "expected": {
            "model_available_phrase_indices": all_indices,
            "attempt_available_phrase_indices": attempt_indices,
            "paired_phrase_indices": attempt_indices,
            "playback_mode": "phrase" if attempt_indices == all_indices else "partial_phrase",
        },
    }


def _segments(phrases: Sequence[str], *, pause_ms: int) -> list[dict[str, object]]:
    return [
        {
            "phrase_index": index,
            "text": phrase,
            **({"pause_after_ms": pause_ms} if index < len(phrases) - 1 else {}),
        }
        for index, phrase in enumerate(phrases)
    ]


def _omission_kind(index: int) -> str | None:
    value = index % 19
    if value == 5:
        return "changed"
    if value == 11:
        return "leading"
    if value == 17:
        return "trailing"
    return None


def _hard_boundary_count(text: str) -> int:
    return sum(character in "。！？!?" for character in text)
