from mo_speech.practice import evaluate_practice_attempt, normalize_practice_text


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
