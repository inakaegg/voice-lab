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

OpenAI APIの音声翻訳経路も試す場合:

```sh
python3 -m pip install -e ".[openai]"
cp .env.example .env
```

`.env` はローカル起動時に自動で読み込まれる。既にシェルで設定済みの環境変数は `.env` では上書きしない。OpenAI API経路を使う場合だけ、git管理外の `.env` に `OPENAI_API_KEY` を設定する。

Qwen3-TTS、Seed-VC、Chatterboxは依存が重く、既存の機械学習環境とバージョンが衝突する場合がある。開発時は専用venvを作り、`QWEN_TTS_PYTHON`、`SEED_VC_PYTHON`、`CHATTERBOX_PYTHON` でそのPythonを指定できる。

## プロバイダ構成

- ASR: 既定では `faster-whisper` の `turbo` を使う。
- 翻訳: 既定ではQwen3系のローカルLLMを使う。
- TTS: コマンドTTSは使わず、モデルTTS/VC providerを明示する。
- `MO_TTS_PROVIDER=qwen` では、`voice_mode=clone` にQwen3-TTSを使う。
- `MO_TTS_PROVIDER=seed-vc` では、`voice_mode=convert` にSeed-VCを使う。前段の出力言語音声はQwen3-TTSで生成する。
- `MO_TTS_PROVIDER=qwen-seed-vc` では、`voice_mode=clone` と `voice_mode=convert` の両方を選択できる。
- `voice_mode=default` はlocal providerでは使わない。
- OpenAI API経路では、ASR、翻訳、TTSをOpenAI APIで実行する。UIの翻訳方式で `音声翻訳（OpenAI API）` を選ぶ。声質変換にSeed-VCを選ぶと、OpenAI TTSの出力をSeed-VCで入力音声の声質へ変換する。
- OpenAI Realtime翻訳経路では、音声入力から翻訳音声までをRealtime translationでまとめて実行する。UIの翻訳方式で `音声翻訳（OpenAI Realtime）` を選ぶ。録音済み音声をサーバー側WebSocketから送る一括処理で、入力言語は自動判定、声質変換は行わない。
- OpenAI Realtime streaming経路では、ブラウザのマイクをWebRTCでOpenAI Realtime translationへ接続する。UIの翻訳方式で `音声翻訳（OpenAI Realtime streaming）` を選ぶ。サーバーは短命client secretを発行するだけで、標準APIキーはブラウザに渡さない。出力音声はブラウザ側で録音し、接続停止時にローカル履歴へ保存する。
- OpenAI系の出力言語候補はOpenAI TTS docsの対応言語リストに合わせる。OpenAI TTS docsはWhisperの対応言語に概ね従うとしているため、OpenAI API、OpenAI Realtime、OpenAI TTS APIは同じ言語集合をUIに出す。
- テキスト読み上げでは、Google Translate TTS endpointまたはOpenAI TTS APIを選べる。Google Translate TTS endpointは公式APIではないため、開発中の比較用とし、安定運用の前提にはしない。

翻訳なしのVC比較では、`MO_TTS_PROVIDER` は使わない。管理画面の「VC比較」とSeed-VC単体画面 `/seed-vc` は `MO_VC_BACKENDS` で指定したbackendをruntime APIから取得する。

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
| `SEED_VC_DIFFUSION_STEPS` | `30` | Seed-VCの変換steps。速度と品質の比較対象。 |
| `SEED_VC_LENGTH_ADJUST` | `1.0` | Seed-VCの出力長補正。 |
| `SEED_VC_INFERENCE_CFG_RATE` | `0.7` | Seed-VCのCFG係数。 |
| `SEED_VC_REFERENCE_MAX_SECONDS` | `10` | Seed-VCに渡す参照音声の上限秒数。 |
| `SEED_VC_REFERENCE_AUTO_SELECT` | `0` | `1` の場合は、参照音声の発話区間を軽量に自動選択する。選択不能時は先頭切り出しに戻す。 |
| `CHATTERBOX_PYTHON` | 現在のPython | Chatterbox VCを実行するPython。 |
| `CHATTERBOX_DEVICE` | `auto` | Chatterboxのdevice。Mac M1では `auto` でMPSを優先する。 |
| `CHATTERBOX_REFERENCE_MAX_SECONDS` | `10` | Chatterboxに渡す参照音声の上限秒数。 |
| `OPENAI_API_KEY` | なし | OpenAI API backendを使う場合に必要。git管理外の環境変数として渡す。 |
| `OPENAI_ASR_MODEL` | `gpt-4o-transcribe` | OpenAI文字起こしモデル。 |
| `OPENAI_TRANSLATION_MODEL` | `gpt-5.5` | OpenAI翻訳用Responses APIモデル。 |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | OpenAI TTSモデル。 |
| `OPENAI_TTS_VOICE` | `coral` | OpenAI TTS voice。 |
| `OPENAI_TTS_RESPONSE_FORMAT` | `wav` | OpenAI TTSの出力形式。Seed-VC後段を考慮し既定はwav。 |
| `OPENAI_REALTIME_TRANSLATION_MODEL` | `gpt-realtime-translate` | OpenAI Realtime翻訳モデル。 |
| `OPENAI_REALTIME_TRANSLATION_SAMPLE_RATE` | `24000` | Realtimeへ送るPCM16音声のsample rate。 |
| `OPENAI_REALTIME_TRANSLATION_TIMEOUT_SECONDS` | `90` | Realtime WebSocketと音声変換のタイムアウト秒数。 |
| `GOOGLE_TTS_TIMEOUT_SECONDS` | `30` | Google Translate TTS endpointのHTTP timeout。 |
| `MO_AUDIO_HISTORY_ENABLED` | `1` | ローカル音声履歴を保存する。RunPodなどのサーバー環境では `0` を既定にする。 |
| `MO_AUDIO_HISTORY_DIR` | `tmp/audio-history` | 録音と生成音声の保存先。git管理外に置く。 |
| `MO_AUDIO_HISTORY_LIMIT` | `100` | `recordings` と `outputs` それぞれに残す件数。 |

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

`/api/runtime` の `voice_conversion_backends` で `seed-vc` が `available=true` になっていれば、UIの「VC比較」または `/seed-vc` から実行できる。

Seed-VCだけを確認したい場合は、`/seed-vc` を使う。この画面は翻訳、TTS、ユーザー画面設定を介さず、変換元音声と参照音声を `/api/voice-conversion-jobs` へ直接送る。変換元音声はファイル選択またはマイク録音で指定でき、管理画面と同じマイク選択、録音/停止、入力レベル、録音プレビューを表示する。参照音声の前処理確認は `/api/seed-vc/reference-preview` を使う。Seed-VCの数値設定はrange操作と現在値表示で変更できる。

UIでは、VC比較モードでSeed-VCを選択した場合と、音声翻訳モードで `Qwen生成後にSeed-VC変換` を選択した場合に、`diffusion steps`、参照音声の上限秒数、参照音声の発話区間自動選択、`length adjust`、`inference cfg rate` をjob単位で変更できる。未変更時は起動時の環境変数から決まる既定値を使う。

OpenAI API経路を使う場合も、UIの声質変換でSeed-VCを選ぶと同じSeed-VC設定を使う。

Seed-VCプリセット:

| プリセット | diffusion steps | 参照音声の上限秒数 | length adjust | inference cfg rate | 用途 |
| --- | ---: | ---: | ---: | ---: | --- |
| 高速確認 | 10 | 5 | 1.0 | 0.7 | UIやルート確認を短時間で行う。 |
| リーズナブル | 25 | 8 | 1.0 | 0.7 | ローカル検証の標準候補。 |
| 品質優先 | 30 | 10 | 1.0 | 0.7 | アプリの既定値。 |
| 最高品質検証 | 50 | 15 | 1.0 | 0.7 | 最終比較用。処理時間は大きくなる。 |
