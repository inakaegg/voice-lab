# ローカル実プロバイダ

更新日: 2026-08-02

## この文書の役割

SpeakLoopが共有するASR・翻訳・TTS providerの構成を説明する。管理画面のテキストTTSとSeed-VCも対象にする。旧音声翻訳APIや音声から音声までの一括実行経路は提供しない。

## providerの責任

`SpeechProviderBundle` はASR・翻訳・TTS providerを保持する。bundle自身は処理順やAPI routeを持たない。SpeakLoopのお手本生成が必要なproviderを明示的に呼び出す。

本番相当のSpeakLoop経路はOpenAI bundleを使う。母語録音のASR・お手本文の翻訳・通常音声のTTSを順に実行する。中国語の復唱ASRとSeed-VCはRunPod Serverlessへ分ける。

管理画面のテキストTTSは `TextTtsService` を使う。利用できるTTS backendはOpenAI TTSだけである。

管理画面のVC比較は `VoiceConversionService` を使う。`SpeechProviderBundle` のTTSとは独立している。

## 起動モード

`MO_PROVIDER_MODE` で起動時に作るbundleを選ぶ。

| 値 | 用途 |
| --- | --- |
| `fake` | UIとAPIのローカル確認用。未指定時もこの値として扱う。 |
| `openai` | OpenAIのASR・翻訳・TTS providerを使う。 |
| `local` | faster-whisper・Qwen3翻訳・明示したlocal TTS providerを使う。 |

OpenAI経路を使う場合:

```sh
python3 -m pip install -e ".[openai]"
cp .env.example .env
MO_PROVIDER_MODE=openai PYTHONPATH=src \
python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

local bundleを確認する場合:

```sh
python3 -m pip install -e ".[dev,local,voice]"
MO_PROVIDER_MODE=local \
MO_TTS_PROVIDER=qwen \
PYTHONPATH=src \
python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

`MO_PRELOAD_MODELS=1` を指定するとbundle内の対応providerを起動時に先読みする。モデルを取得する設定では、保存先と必要容量を事前に確認する。

## モデルキャッシュ

`MODEL_CACHE_DIR` を指定した場合は次の配置を優先する。

```text
${MODEL_CACHE_DIR}/
  faster-whisper/
  huggingface/
    hub/
      models--Qwen--Qwen3-4B/
```

未指定時は各libraryの標準cacheを参照する。ローカルproviderは既定で自動ダウンロードを許可しない。初回取得を許可する場合だけ `FASTER_WHISPER_LOCAL_FILES_ONLY=0` または `QWEN_TRANSLATION_LOCAL_FILES_ONLY=0` を指定する。

Seed-VCの配置と参照音声処理は [VOICE_CLONE.md](VOICE_CLONE.md) を参照する。

## 主要な環境変数

| 変数 | 既定 | 用途 |
| --- | --- | --- |
| `MO_ASR_PROVIDER` | `faster-whisper` | local ASR providerを選ぶ。 |
| `FASTER_WHISPER_MODEL` | `turbo` | faster-whisperのモデル名。 |
| `FASTER_WHISPER_DEVICE` | `cpu` | 実行device。 |
| `FASTER_WHISPER_COMPUTE_TYPE` | deviceに応じて決定 | CTranslate2の計算精度。 |
| `FASTER_WHISPER_LOCAL_FILES_ONLY` | `1` | local cacheだけを使う。 |
| `MO_TRANSLATION_PROVIDER` | `qwen3` | local翻訳providerを選ぶ。 |
| `QWEN_TRANSLATION_MODEL` | `Qwen/Qwen3-4B` | Qwen3翻訳モデル。 |
| `QWEN_TRANSLATION_DEVICE_MAP` | OSに応じて決定 | Transformersのdevice配置。 |
| `QWEN_TRANSLATION_DTYPE` | `auto` | Transformersのdtype。 |
| `QWEN_TRANSLATION_LOCAL_FILES_ONLY` | `1` | local cacheだけを使う。 |
| `OPENAI_API_KEY` | なし | OpenAI providerに必要なsecret。 |
| `OPENAI_ASR_MODEL` | `gpt-4o-transcribe` | 母語録音のASRモデル。 |
| `OPENAI_TRANSLATION_MODEL` | `gpt-5.6-terra` | お手本文の翻訳モデル。 |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | OpenAI TTSモデル。 |
| `OPENAI_TTS_VOICE` | `coral` | OpenAI TTS voice。 |
| `OPENAI_TTS_RESPONSE_FORMAT` | `wav` | OpenAI TTSの出力形式。 |
| `MO_VC_BACKENDS` | `seed-vc,chatterbox,openvoice-v2` | 管理画面に出すVC backend。 |
| `SEED_VC_PYTHON` | 現在のPython | Seed-VCを実行するPython。 |

## 検証

providerの保持とpreload契約は次で確認する。

```sh
python3 -m pytest tests/test_pipeline.py tests/test_openai_providers.py
```

管理画面ではテキストTTSとVC比較だけを提供する。`/api/runtime` の `voice_conversion_backends` で利用可能なVC backendを確認できる。Seed-VCの参照音声前処理は `/api/seed-vc/reference-preview` で確認する。
