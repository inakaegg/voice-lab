from mo_speech.practice import classify_practice_recording, evaluate_practice_attempt, normalize_practice_text


def test_practice_normalization_handles_supported_learning_languages() -> None:
    assert normalize_practice_text("コンニチハ、WORLD！", "ja-JP") == "こんにちはworld"
    assert normalize_practice_text("你好，世界！", "zh-CN") == "你好世界"
    assert normalize_practice_text("Hello, WORLD!", "en-US") == "helloworld"


def test_practice_normalization_treats_common_chinese_variants_as_equivalent() -> None:
    target = normalize_practice_text("你好，你最近怎么样？", "zh-CN")
    recognized = normalize_practice_text("你好，你最近怎麼樣?", "zh-CN")

    assert target == "你好你最近怎么样"
    assert recognized == target


def test_practice_attempt_grades_similarity() -> None:
    ok = evaluate_practice_attempt("I want a coffee.", "i want coffee", "en-US")
    almost = evaluate_practice_attempt("I want a coffee.", "want tea", "en-US")
    retry = evaluate_practice_attempt("I want a coffee.", "good morning", "en-US")

    assert ok["grade"] == "ok"
    assert almost["grade"] == "almost"
    assert retry["grade"] == "retry"
    assert 0 <= retry["similarity"] < almost["similarity"] < ok["similarity"] <= 1
    assert ok["diff"]
    assert {"target_start", "target_end", "recognized_start", "recognized_end"} <= set(ok["diff"][0])


def test_practice_attempt_keeps_missing_target_ranges_in_diff() -> None:
    result = evaluate_practice_attempt(
        "我最近买了一辆自行车，是公路车。价格还挺贵的。",
        "我最近买了一辆自行车，是公路车。",
        "zh-CN",
    )

    deleted = [entry for entry in result["diff"] if entry["type"] == "delete"]
    assert deleted
    assert deleted[-1]["target"] == "价格还挺贵的"
    assert deleted[-1]["recognized"] == ""


def test_practice_attempt_aligns_target_phrases_to_recognized_positions() -> None:
    result = evaluate_practice_attempt(
        "昨天买了一辆自行车，是 Trek 的 Domane。这是我的第一辆公路车。",
        "嗯 昨天买了一辆自行车 是 Trek 的 Domane 啊 这是我的第一辆公路车",
        "zh-CN",
    )

    assert result["phrase_similarity"] >= 0.9
    assert result["similarity"] >= result["global_similarity"]
    assert len(result["phrase_matches"]) == 3
    assert result["phrase_matches"][0]["matched"] is True
    assert result["phrase_matches"][0]["recognized_start"] > 0
    assert result["phrase_matches"][1]["recognized_start"] >= result["phrase_matches"][0]["recognized_end"]
    assert result["phrase_matches"][2]["recognized_start"] >= result["phrase_matches"][1]["recognized_end"]


def test_practice_attempt_splits_colon_phrases_like_worker() -> None:
    result = evaluate_practice_attempt(
        "A: 我想要咖啡。B: 明天天气好吗？",
        "我想要咖啡。明天天气好吗？",
        "zh-CN",
    )

    assert [match["target"] for match in result["phrase_matches"]] == [
        "A:",
        "我想要咖啡。",
        "B:",
        "明天天气好吗？",
    ]
    assert result["phrase_matches"][1]["matched"] is True
    assert result["phrase_matches"][3]["matched"] is True


def test_practice_recording_classifier_prefers_attempt_for_target_language_repeat() -> None:
    result = classify_practice_recording(
        target_text="我想要咖啡。",
        target_language="zh-CN",
        target_recognized_text="我想要咖啡",
        auto_recognized_text="La pelan susinja se treak",
    )

    assert result["kind"] == "attempt"
    assert result["attempt_source"] == "target"
    assert result["target_similarity"] >= 0.8


def test_practice_recording_classifier_detects_new_prompt_while_target_exists() -> None:
    result = classify_practice_recording(
        target_text="我想要咖啡。",
        target_language="zh-CN",
        target_recognized_text="请问明天天气怎么样",
        auto_recognized_text="明日は天気がいいですか",
    )

    assert result["kind"] == "prompt"
