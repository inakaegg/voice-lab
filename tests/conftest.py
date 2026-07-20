import pytest

from mo_speech import api as mo_speech_api


@pytest.fixture(autouse=True)
def _reset_practice_model_asr_cache():
    # 複数のテストが同じダミー音声バイト列と同じprovider名(実装のFakeクラスが
    # 本物のprovider.nameを模倣する)を使って/api/practice/attempt-jobsを呼ぶため、
    # プロセス内グローバルなお手本音声ASRキャッシュがテスト間で汚染されうる。
    mo_speech_api._practice_model_asr_cache.clear()
    yield
    mo_speech_api._practice_model_asr_cache.clear()
