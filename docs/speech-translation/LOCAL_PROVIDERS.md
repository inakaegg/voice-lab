# ローカル実プロバイダ

## 目的

Phase 2では、fake providerで固定したAPI契約を保ったまま、ローカルで動く実プロバイダへ差し替える。大容量モデルはリポジトリに入れず、既存キャッシュまたは明示的に用意したキャッシュだけを参照する。

## 起動モード

既定はfake providerを使う。ローカル実プロバイダを使う場合は、起動時に以下を指定する。

```sh
MO_PROVIDER_MODE=local MO_TTS_PROVIDER=qwen-seed-vc PYTHONPATH=src python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

fake providerはUI/API確認用で、入力音声の内容に関係なく固定のデモ応答を返す。録音内容を実際に処理する場合は、必ず `MO_PROVIDER_MODE=local` を指定する。

初回リクエストの待ち時間を起動時へ寄せる場合は、以下を追加する。

```sh
MO_PROVIDER_MODE=local MO_TTS_PROVIDER=qwen-seed-vc MO_PRELOAD_MODELS=1 PYTHONPATH=src python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

## 依存関係

ASR/翻訳のローカル実プロバイダ:

```sh
python3 -m pip install -e ".[dev,local]"
```

声質クローンproviderを同じPython環境へ入れる場合:

```sh
python3 -m pip install -e ".[dev,local,voice]"
```

VC比較でChatterboxも試す場合:

```sh
python3 -m pip install -e ".[vc-compare]"
```

Qwen3-TTS、Seed-VC、Chatterboxは依存が重く、既存の機械学習環境とバージョンが衝突する場合がある。開発時は専用venvを作り、`QWEN_TTS_PYTHON`、`SEED_VC_PYTHON`、`CHATTERBOX_PYTHON` でそのPythonを指定できる。

## プロバイダ構成

- ASR: 既定では `faster-whisper` の `turbo` を使う。
- 翻訳: 既定ではQwen3系のローカルLLMを使う。
- TTS: コマンドTTSは使わず、モデルTTS/VC providerを明示する。
- `MO_TTS_PROVIDER=qwen` では、`voice_mode=clone` にQwen3-TTSを使う。
- `MO_TTS_PROVIDER=seed-vc` では、`voice_mode=convert` にSeed-VCを使う。前段の出力言語音声はQwen3-TTSで生成する。
- `MO_TTS_PROVIDER=qwen-seed-vc` では、`voice_mode=clone` と `voice_mode=convert` の両方を選択できる。
- `voice_mode=default` はlocal providerでは使わない。

翻訳なしのVC比較では、`MO_TTS_PROVIDER` は使わない。UIの「VC比較」は `MO_VC_BACKENDS` で指定したbackendをruntime APIから取得する。

| 値 | 用途 |
| --- | --- |
| `seed-vc` | 変換元音声を参照音声の声質へ直接変換する。初期基準。 |
| `chatterbox` | Chatterbox VCを使う。`chatterbox-tts` が入っているPythonを `CHATTERBOX_PYTHON` で指定できる。 |
| `openvoice-v2` | 直接VC providerとしては未実装。tone color変換候補として別途評価する。 |

ASR providerは `MO_ASR_PROVIDER` で切り替える。

| 値 | 用途 |
| --- | --- |
| `faster-whisper` | 既定。CTranslate2経路でWhisper系モデルを実行する。 |

翻訳providerは `MO_TRANSLATION_PROVIDER` で切り替える。

| 値 | 用途 |
| --- | --- |
| `qwen3` | 既定。Qwen3系ローカルLLMで会話文脈を含めて翻訳する。 |

## モデルキャッシュ

`MODEL_CACHE_DIR` を指定した場合、アプリは以下の配置を優先する。

```text
${MODEL_CACHE_DIR}/
  faster-whisper/
  huggingface/
    hub/
      models--Qwen--Qwen3-4B/
```

`MODEL_CACHE_DIR` が未指定の場合は、各ライブラリの標準キャッシュを参照する。キャッシュが見つからない場合は自動ダウンロードせず、設定エラーとして返す。

Qwen3-TTSとSeed-VCは依存とモデル取得の挙動が通常providerと異なる。設定項目と保存方針は [VOICE_CLONE.md](VOICE_CLONE.md) を参照する。

初回にモデル取得を許可する場合だけ、以下のように `LOCAL_FILES_ONLY` を明示的に無効化する。

```sh
FASTER_WHISPER_LOCAL_FILES_ONLY=0 \
QWEN_TRANSLATION_LOCAL_FILES_ONLY=0 \
MO_PROVIDER_MODE=local \
MO_TTS_PROVIDER=qwen-seed-vc \
PYTHONPATH=src \
python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

大容量モデルの取得を伴うため、保存先と空き容量を確認してから実行する。

主要な環境変数:

| 変数 | 既定 | 用途 |
| --- | --- | --- |
| `MO_ASR_PROVIDER` | `faster-whisper` | ASR provider切替。 |
| `FASTER_WHISPER_MODEL` | `turbo` | faster-whisperで使うモデル名。 |
| `FASTER_WHISPER_DEVICE` | `cpu` | faster-whisperの実行device。RunPodでは `cuda` を想定する。 |
| `FASTER_WHISPER_COMPUTE_TYPE` | `int8` | CTranslate2の計算精度。GPUでは `float16` または `int8_float16` を比較する。 |
| `FASTER_WHISPER_LOCAL_FILES_ONLY` | `1` | `1` の場合はローカルにあるモデルだけを使う。 |
| `MO_TRANSLATION_PROVIDER` | `qwen3` | 翻訳provider切替。 |
| `QWEN_TRANSLATION_MODEL` | `Qwen/Qwen3-4B` | Qwen3翻訳モデル。 |
| `QWEN_TRANSLATION_DEVICE_MAP` | macOSでは `cpu`、その他は `auto` | Transformersのdevice配置。RunPodでは `auto` を指定してGPU利用を確認する。 |
| `QWEN_TRANSLATION_DTYPE` | `auto` | Transformersのdtype。 |
| `QWEN_TRANSLATION_LOCAL_FILES_ONLY` | `1` | `1` の場合はローカルにあるモデルだけを使う。 |
| `MO_VC_BACKENDS` | `seed-vc,chatterbox,openvoice-v2` | UIに表示するVC比較backend。 |
| `SEED_VC_PYTHON` | 現在のPython | Seed-VCを実行するPython。 |
| `SEED_VC_DIFFUSION_STEPS` | `8` | Seed-VCの変換steps。速度と品質の比較対象。 |
| `SEED_VC_REFERENCE_MAX_SECONDS` | `12` | Seed-VCに渡す参照音声の上限秒数。 |
| `CHATTERBOX_PYTHON` | 現在のPython | Chatterbox VCを実行するPython。 |
| `CHATTERBOX_DEVICE` | `auto` | Chatterboxのdevice。Mac M1では `auto` でMPSを優先する。 |
| `CHATTERBOX_REFERENCE_MAX_SECONDS` | `10` | Chatterboxに渡す参照音声の上限秒数。 |

## 対応ルート

- `id-ID -> ja-JP`
- `ja-JP -> zh-CN`

## レスポンス

API契約はfake providerと同じ形を保つ。実TTSでは音声形式がproviderごとに変わるため、レスポンスには `audio_mime_type` を含める。

## 検証

```sh
python3 -m pytest
MO_PROVIDER_MODE=local MO_TTS_PROVIDER=qwen-seed-vc PYTHONPATH=src python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

ローカル実プロバイダのスモーク確認では、短いfixture音声を使って、文字起こし、翻訳、音声出力まで確認する。

VC比較だけ確認する場合:

```sh
SEED_VC_PYTHON=tmp/voice-venv/bin/python \
PYTHONPATH=src \
python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

`/api/runtime` の `voice_conversion_backends` で `seed-vc` が `available=true` になっていれば、UIの「VC比較」から実行できる。
