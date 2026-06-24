# mo speech translation

音声入力を別言語の音声として返す、ローカル優先の音声翻訳Webアプリです。

現在の対応ルート:

- インドネシア語音声 -> 日本語音声
- 日本語音声 -> 中国語（普通話）音声

## 現在の状態

- FastAPI backendとブラウザUIで、録音または音声アップロードから結果表示まで動きます。
- `MO_PROVIDER_MODE=local` では、faster-whisper、Qwen3翻訳、Qwen3-TTS/Seed-VCを使ったローカル縦切りを動かします。
- `voice_mode=default` はfake provider専用です。
- `MO_TTS_PROVIDER=qwen-seed-vc` では、`voice_mode=clone` をQwen3-TTS、`voice_mode=convert` をSeed-VCで比較できます。
- RunPod向けにはDockerfileとServerless handlerを用意済みです。実デプロイはRunPod認証とモデルvolume設定が必要です。

## セットアップ

```sh
python3 -m pip install -e ".[dev]"
```

ASR/翻訳のローカル実プロバイダも使う場合:

```sh
python3 -m pip install -e ".[dev,local]"
```

声質クローンproviderも使う場合は、依存が重いため専用環境を推奨します。設定は [docs/speech-translation/VOICE_CLONE.md](docs/speech-translation/VOICE_CLONE.md) を参照してください。

同じPython環境へ入れる場合:

```sh
python3 -m pip install -e ".[dev,local,voice]"
```

OpenAI API経路も使う場合:

```sh
python3 -m pip install -e ".[dev,openai]"
cp .env.example .env
```

`.env` はgit管理しません。OpenAI API経路を使う場合だけ、`.env` に `OPENAI_API_KEY` を設定します。

## 起動

fake provider:

```sh
PYTHONPATH=src python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

fake providerはUI/API確認用で、入力音声の内容に関係なく固定のデモ応答を返します。

local provider:

```sh
MO_PROVIDER_MODE=local MO_TTS_PROVIDER=qwen-seed-vc PYTHONPATH=src python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

録音内容を実際に文字起こし、翻訳、音声生成する場合はlocal providerで起動します。

初回リクエスト前にモデルをロードする場合:

```sh
MO_PROVIDER_MODE=local MO_TTS_PROVIDER=qwen-seed-vc MO_PRELOAD_MODELS=1 PYTHONPATH=src python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

ブラウザで `http://127.0.0.1:8000/` を開きます。

## テスト

```sh
python3 -m pytest
node --check src/mo_speech/web/app.js
```

## 計測

```sh
python3 scripts/benchmark_pipeline.py --provider-mode fake --repeat 3
```

local providerで計測する場合は、短い音声ファイルを指定します。

```sh
MO_TTS_PROVIDER=qwen-seed-vc \
python3 scripts/benchmark_pipeline.py \
  --provider-mode local \
  --audio path/to/sample.m4a \
  --source-language ja-JP \
  --target-language zh-CN \
  --repeat 3
```

## デプロイ準備

Docker image:

```sh
docker build -t mo-speech:local .
```

RunPod手順は [docs/deployment/RUNPOD.md](docs/deployment/RUNPOD.md) を参照してください。

## 主要ドキュメント

- [仕様](docs/speech-translation/SPEC.md)
- [実装フェーズ](docs/speech-translation/PHASES.md)
- [ローカル実プロバイダ](docs/speech-translation/LOCAL_PROVIDERS.md)
- [声質クローン方針](docs/speech-translation/VOICE_CLONE.md)
- [ASR・翻訳モデル評価方針](docs/speech-translation/MODEL_EVALUATION.md)
- [応答速度と計測](docs/speech-translation/LATENCY.md)
- [既知の制限](docs/speech-translation/KNOWN_LIMITS.md)
