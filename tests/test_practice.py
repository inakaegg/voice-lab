from mo_speech.practice import evaluate_practice_attempt, normalize_practice_text


def test_practice_normalization_handles_supported_learning_languages() -> None:
    assert normalize_practice_text("コンニチハ、WORLD！", "ja-JP") == "こんにちはworld"
    assert normalize_practice_text("你好，世界！", "zh-CN") == "你好世界"
    assert normalize_practice_text("Hello, WORLD!", "en-US") == "helloworld"


def test_practice_attempt_grades_similarity() -> None:
    ok = evaluate_practice_attempt("I want a coffee.", "i want coffee", "en-US")
    almost = evaluate_practice_attempt("I want a coffee.", "want tea", "en-US")
    retry = evaluate_practice_attempt("I want a coffee.", "good morning", "en-US")

    assert ok["grade"] == "ok"
    assert almost["grade"] == "almost"
    assert retry["grade"] == "retry"
    assert 0 <= retry["similarity"] < almost["similarity"] < ok["similarity"] <= 1
    assert ok["diff"]
