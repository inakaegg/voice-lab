# ローカル実プロバイダ

更新日: 2026-07-20

## この文書の役割

ローカルFastAPI版の音声翻訳（研究機能）で使う実プロバイダの起動方法、設定、計測方法をまとめる。応答速度の計測とモデル評価の要点もこの文書に統合している。大容量モデルはリポジトリに入れず、既存キャッシュまたは明示的に用意したキャッシュだけを参照する。

## 起動モード

既定はfake providerを使う。fake providerはUI/API確認用で、入力音声の内容に関係なく固定のデモ応答を返す。録音内容を実際に処理する場合は、必ず `MO_PROVIDER_MODE=local` を指定する。

```sh
MO_PROVIDER_MODE=local MO_TTS_PROVIDER=qwen-seed-vc PYTHONPATH=src python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

初回リクエストの待ち時間を起動時へ寄せる場合は、`MO_PRELOAD_MODELS=1` を追加する。起動時間は長くなる。

## 依存関係

| 用途 | インストール |
| --- | --- |
| ASR/翻訳のローカル実プロバイダ | `python3 -m pip install -e ".[dev,local]"` |
| 声質クローンproviderを同じ環境へ追加 | `python3 -m pip install -e ".[dev,local,voice]"` |
| VC比較でChatterboxも試す | `python3 -m pip install -e ".[vc-compare]"` |
| OpenAI APIの音声翻訳経路 | `python3 -m pip install -e ".[openai]"` と `cp .env.example .env` |

`.env` はローカル起動時に自動で読み込まれる。シェルで設定済みの環境変数は `.env` では上書きしない。OpenAI API経路を使う場合だけ、git管理外の `.env` に `OPENAI_API_KEY` を設定する。

Qwen3-TTS、Seed-VC、Chatterboxは依存が重く、既存の機械学習環境とバージョンが衝突する場合がある。開発時は専用venvを作り、`QWEN_TTS_PYTHON`、`SEED_VC_PYTHON`、`CHATTERBOX_PYTHON` でそのPythonを指定できる。

## プロバイダ構成

- ASR: 既定では `faster-whisper` の `turbo` を使う。
- 翻訳: 既定ではQwen3系のローカルLLMを使う。
- TTS: コマンドTTSは使わず、モデルTTS/VC providerを明示する。
- `MO_TTS_PROVIDER=qwen` は `voice_mode=clone` にQwen3-TTSを使う。
- `MO_TTS_PROVIDER=seed-vc` は `voice_mode=convert` にSeed-VCを使う。前段の出力言語音声はQwen3-TTSで生成する。
- `MO_TTS_PROVIDER=qwen-seed-vc` は `clone` と `convert` の両方を選択できる。
- `voice_mode=default` はlocal providerでは使わない。
- OpenAI API経路では、ASR、翻訳、TTSをOpenAI APIで実行する。UIの翻訳方式で `音声翻訳（OpenAI API）` を選ぶ。声質変換にSeed-VCを選ぶと、OpenAI TTSの出力を入力音声の声質へ変換する。
- OpenAI Realtime翻訳経路は、録音済み音声をサーバー側WebSocketから送る一括処理とする。入力言語は自動判定で、声質変換は行わない。UIでは `音声翻訳（OpenAI Realtime）` を選ぶ。
- OpenAI Realtime streaming経路は、ブラウザのマイクをWebRTCでOpenAI Realtime translationへ接続する。サーバーは短命client secretを発行するだけで、標準APIキーはブラウザに渡さない。出力音声はブラウザ側で録音し、接続停止時にローカル履歴へ保存する。
- OpenAI系の出力言語候補はOpenAI TTS docsの対応言語リストに合わせる。OpenAI API、OpenAI Realtime、OpenAI TTS APIは同じ言語集合をUIに出す。
- テキスト読み上げでは、Google Translate TTS endpointまたはOpenAI TTS APIを選べる。Google Translate TTS endpointは公式APIではないため、開発中の比較用とし、安定運用の前提にはしない。

翻訳なしのVC比較では `MO_TTS_PROVIDER` は使わない。管理画面の「VC比較」は `MO_VC_BACKENDS` で指定したbackendをruntime APIから取得する。

| 値 | 用途 |
| --- | --- |
| `seed-vc` | 変換元音声を参照音声の声質へ直接変換する。初期基準。 |
| `chatterbox` | Chatterbox VCを使う。`CHATTERBOX_PYTHON` で実行Pythonを指定できる。 |
| `openvoice-v2` | 直接VC providerとしては未実装。tone color変換候補として別途評価する。 |

## モデルキャッシュ

`MODEL_CACHE_DIR` を指定した場合、アプリは以下の配置を優先する。

```text
${MODEL_CACHE_DIR}/
  faster-whisper/
  huggingface/
    hub/
      models--Qwen--Qwen3-4B/
```

未指定の場合は各ライブラリの標準キャッシュを参照する。キャッシュが見つからない場合は自動ダウンロードせず、設定エラーとして返す。

初回にモデル取得を許可する場合だけ、`FASTER_WHISPER_LOCAL_FILES_ONLY=0` と `QWEN_TRANSLATION_LOCAL_FILES_ONLY=0` を明示する。大容量モデルの取得を伴うため、保存先と空き容量を確認してから実行する。

Qwen3-TTSとSeed-VCは依存とモデル取得の挙動が通常providerと異なる。設定項目と保存方針は [VOICE_CLONE.md](VOICE_CLONE.md) を参照する。

## 主要な環境変数

| 変数 | 既定 | 用途 |
| --- | --- | --- |
| `MO_ASR_PROVIDER` | `faster-whisper` | ASR provider切替。 |
| `FASTER_WHISPER_MODEL` | `turbo` | faster-whisperで使うモデル名。 |
| `FASTER_WHISPER_DEVICE` | `cpu` | 実行device。GPU環境では `cuda` を想定する。 |
| `FASTER_WHISPER_COMPUTE_TYPE` | `int8` | CTranslate2の計算精度。GPUでは `float16` または `int8_float16` を比較する。 |
| `FASTER_WHISPER_LOCAL_FILES_ONLY` | `1` | `1` の場合はローカルにあるモデルだけを使う。 |
| `MO_TRANSLATION_PROVIDER` | `qwen3` | 翻訳provider切替。 |
| `QWEN_TRANSLATION_MODEL` | `Qwen/Qwen3-4B` | Qwen3翻訳モデル。 |
| `QWEN_TRANSLATION_DEVICE_MAP` | macOSでは `cpu`、その他は `auto` | Transformersのdevice配置。 |
| `QWEN_TRANSLATION_DTYPE` | `auto` | Transformersのdtype。 |
| `QWEN_TRANSLATION_LOCAL_FILES_ONLY` | `1` | `1` の場合はローカルにあるモデルだけを使う。 |
| `MO_VC_BACKENDS` | `seed-vc,chatterbox,openvoice-v2` | UIに表示するVC比較backend。 |
| `SEED_VC_PYTHON` | 現在のPython | Seed-VCを実行するPython。 |
| `SEED_VC_DIFFUSION_STEPS` | `30` | Seed-VCの変換steps。速度と品質の比較対象。 |
| `SEED_VC_LENGTH_ADJUST` | `1.0` | Seed-VCの出力長補正。 |
| `SEED_VC_INFERENCE_CFG_RATE` | `0.7` | Seed-VCのCFG係数。 |
| `SEED_VC_REFERENCE_MAX_SECONDS` | `10` | Seed-VCに渡す参照音声の上限秒数。 |
| `SEED_VC_REFERENCE_AUTO_SELECT` | `0` | `1` の場合は参照音声の発話区間を軽量に自動選択する。選択不能時は先頭切り出しに戻す。 |
| `CHATTERBOX_PYTHON` | 現在のPython | Chatterbox VCを実行するPython。 |
| `CHATTERBOX_DEVICE` | `auto` | Chatterboxのdevice。Mac M1では `auto` でMPSを優先する。 |
| `CHATTERBOX_REFERENCE_MAX_SECONDS` | `10` | Chatterboxに渡す参照音声の上限秒数。 |
| `OPENAI_API_KEY` | なし | OpenAI API backendに必要。git管理外の環境変数として渡す。 |
| `OPENAI_ASR_MODEL` | `gpt-4o-transcribe` | OpenAI文字起こしモデル。 |
| `OPENAI_TRANSLATION_MODEL` | `gpt-5.6-terra` | OpenAI翻訳用Responses APIモデル。 |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | OpenAI TTSモデル。 |
| `OPENAI_TTS_VOICE` | `coral` | OpenAI TTS voice。 |
| `OPENAI_TTS_RESPONSE_FORMAT` | `wav` | OpenAI TTSの出力形式。Seed-VC後段を考慮し既定はwav。 |
| `OPENAI_REALTIME_TRANSLATION_MODEL` | `gpt-realtime-translate` | OpenAI Realtime翻訳モデル。 |
| `OPENAI_REALTIME_TRANSLATION_SAMPLE_RATE` | `24000` | Realtimeへ送るPCM16音声のsample rate。 |
| `OPENAI_REALTIME_TRANSLATION_TIMEOUT_SECONDS` | `90` | Realtime WebSocketと音声変換のタイムアウト秒数。 |
| `GOOGLE_TTS_TIMEOUT_SECONDS` | `30` | Google Translate TTS endpointのHTTP timeout。 |
| `MO_AUDIO_HISTORY_ENABLED` | `1` | ローカル音声履歴を保存する。サーバー環境では `0` を既定にする。 |
| `MO_AUDIO_HISTORY_DIR` | `tmp/audio-history` | 録音と生成音声の保存先。git管理外に置く。 |
| `MO_AUDIO_HISTORY_LIMIT` | `100` | `recordings` と `outputs` それぞれに残す件数。 |

## 対応ルートとレスポンス

- 対応ルートは `id-ID -> ja-JP` と `ja-JP -> zh-CN`。
- API契約はfake providerと同じ形を保つ。実TTSでは音声形式がproviderごとに変わるため、レスポンスには `audio_mime_type` を含める。

## 応答速度の計測

処理段階ごとの時間を `timings_ms` として同じ形式で返す。対象はASR・翻訳・テキスト加工・TTS・声質変換・全体時間である。local providerでは初回実行時にモデルロード時間が各stageに含まれる。warm状態を見る場合は、同じprocessで複数回実行した2回目以降を見る。

計測には `scripts/benchmark_pipeline.py` を使う。

```sh
python3 scripts/benchmark_pipeline.py --provider-mode fake --repeat 3
```

```sh
MO_TTS_PROVIDER=qwen-seed-vc \
python3 scripts/benchmark_pipeline.py \
  --provider-mode local \
  --audio path/to/sample.m4a \
  --source-language ja-JP \
  --target-language zh-CN \
  --repeat 3
```

cold寄りの比較では `--fresh-pipeline-per-run` を追加する。

CPU実測の結論は次のとおり。短いfixture音声では、ASR約8秒、翻訳約27秒だった。TTSは約150秒、Seed-VCは約34秒、全体は約219秒だった。最大のボトルネックはcold start時のモデルロードと、Qwen3-TTS/Seed-VCのサブプロセス実行である。低遅延化する場合は、GPU上での常駐worker化か、ストリーミング可能なTTS/VC経路への分離が必要になる。数値は環境により変わるため、性能保証値ではない。

## モデル評価の要点

現在の既定構成は `faster-whisper turbo`、Qwen3-4B翻訳、Qwen3-TTS、Seed-VCである。評価は次の順で段階を分ける。

1. 同じ入力音声でASRだけを比較する。
2. 正しい文字起こしを固定し、翻訳だけを比較する。
3. 翻訳文を固定し、TTS/VCだけを比較する。
4. 速度はcold startとwarm状態を分けて記録する。

以下は品質要件未達のため現在の候補から外した旧構成である。再導入は、明確な品質改善理由がある場合だけ別途検討する。

| 旧構成 | 結果 |
| --- | --- |
| OpenAI Whisper small | インドネシア語の短い会話音声で語の取り違えが出た。 |
| NLLB distilled 600M | 会話文脈や口語表現の訳が不自然で、翻訳の抜け落ちも出た。 |

## 検証

```sh
python3 -m pytest
MO_PROVIDER_MODE=local MO_TTS_PROVIDER=qwen-seed-vc PYTHONPATH=src python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

スモーク確認では、短いfixture音声で文字起こし、翻訳、音声出力まで確認する。

VC比較だけ確認する場合:

```sh
SEED_VC_PYTHON=tmp/voice-venv/bin/python \
PYTHONPATH=src \
python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

`/api/runtime` の `voice_conversion_backends` で `seed-vc` が `available=true` なら、管理UIの「VC比較」から実行できる。参照音声の前処理確認には `/api/seed-vc/reference-preview` を使う。

UIでは、VC比較モードと音声翻訳モードのどちらでもSeed-VC設定をjob単位で変更できる。変更対象は `diffusion steps`・参照音声の上限秒数・発話区間自動選択・`length adjust`・`inference cfg rate` である。未変更時は起動時の環境変数から決まる既定値を使う。

Seed-VCプリセット:

| プリセット | diffusion steps | 参照音声の上限秒数 | length adjust | inference cfg rate | 用途 |
| --- | ---: | ---: | ---: | ---: | --- |
| 高速確認 | 10 | 5 | 1.0 | 0.7 | UIやルート確認を短時間で行う。 |
| リーズナブル | 25 | 8 | 1.0 | 0.7 | ローカル検証の標準候補。 |
| 品質優先 | 30 | 10 | 1.0 | 0.7 | アプリの既定値。 |
| 最高品質検証 | 50 | 15 | 1.0 | 0.7 | 最終比較用。処理時間は大きくなる。 |
