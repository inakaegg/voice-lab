from mo_speech.practice import normalize_practice_text, simplify_chinese_text


def test_practice_normalization_handles_supported_learning_languages() -> None:
    assert normalize_practice_text("コンニチハ、WORLD！", "ja-JP") == "こんにちはworld"
    assert normalize_practice_text("你好，世界！", "zh-CN") == "你好世界"
    assert normalize_practice_text("Hello, WORLD!", "en-US") == "helloworld"


def test_practice_normalization_treats_common_chinese_variants_as_equivalent() -> None:
    target = normalize_practice_text("你好，你最近怎么样？", "zh-CN")
    recognized = normalize_practice_text("你好，你最近怎麼樣?", "zh-CN")

    assert target == "你好你最近怎么样"
    assert recognized == target


def test_practice_opencc_conversion_changes_script_without_replacing_regional_vocabulary() -> None:
    assert simplify_chinese_text("我想學習軟體開發，也喜歡龍馬精神。") == "我想学习软体开发，也喜欢龙马精神。"
