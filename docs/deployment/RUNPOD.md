# RunPodデプロイ手順

## 現在の状態

RunPodへデプロイするためのDockerfile、CLI補助スクリプト、Serverless handlerは用意している。RunPod APIキー、Docker registry、Network Volume ID、GPU在庫はアカウント側の設定が必要なため、実リソース作成は未実行。

結論として、いまの推奨手順は以下。

1. RunPod PodでFastAPIのWeb UIとAPIをまとめて動かし、GPU上で縦切り動作を確認する。
2. 同じモデル構成で速度、VRAM、コールドスタート、音質を測る。
3. 公開MVPではUI/gatewayをCloudflare側へ分け、RunPodは推論APIだけにする。
4. Serverless化は、Podでモデルと依存関係が動くことを確認してから行う。

## なぜ最初はPodで確認するか

RunPod Serverlessはhandler型の推論APIに向く。一方、現在のアプリはFastAPIがWeb UIも配信しているため、ブラウザで録音、アップロード、結果表示、音声再生まで確認する初回検証にはPodが向く。

RunPod PodではHTTP portを公開できる。`8000/http` を公開すると、FastAPIには以下の形式でアクセスする。

```text
https://<pod-id>-8000.proxy.runpod.net
```

Serverlessは後段の推論APIとして使う。URLはRunPodの形式に従う。

```text
https://api.runpod.ai/v2/<endpoint-id>/runsync
https://api.runpod.ai/v2/<endpoint-id>/run
https://api.runpod.ai/v2/<endpoint-id>/status/<job-id>
```

## CLI準備

RunPod CLIは `runpodctl` を使う。macOSではHomebrewで入れられる。

```sh
brew install runpod/runpodctl/runpodctl
runpodctl version
runpodctl doctor
```

APIキーを手動で設定する場合:

```sh
runpodctl config --apiKey "<RunPod API key>"
```

APIキーやDocker registry tokenはリポジトリに保存しない。

## 環境ファイル

設定テンプレートをコピーして使う。

```sh
cp scripts/runpod.env.example .runpod.env
```

`.runpod.env` はgit管理しない。主に以下を埋める。

| 変数 | 用途 |
| --- | --- |
| `RUNPOD_IMAGE` | Docker registryへpushするimage名 |
| `RUNPOD_GPU_ID` | 例: `NVIDIA A40`、`NVIDIA GeForce RTX 4090` |
| `RUNPOD_DATA_CENTER_ID` | Network Volume作成先 |
| `RUNPOD_DATA_CENTER_IDS` | Pod/Serverless配置先候補 |
| `RUNPOD_NETWORK_VOLUME_ID` | 作成済みNetwork Volume ID |
| `RUNPOD_SERVERLESS_TEMPLATE_ID` | Serverless endpoint作成時のtemplate ID |
| `RUNPOD_ENDPOINT_ID` | Serverlessスモーク確認先 |
| `OPENAI_API_KEY` | OpenAI API経路を使う場合だけ設定するAPIキー |

課金リソースを作らずにコマンドだけ確認する場合は、各CLIスクリプトに `RUNPOD_DRY_RUN=1` を付ける。

```sh
RUNPOD_DRY_RUN=1 scripts/runpod_create_gpu_pod.sh
```

`.runpod.env` はコンテナ内へファイルとしてアップロードしない。作成スクリプトがローカルで `.runpod.env` を読み、RunPodのPod/Serverless templateへ `--env '{...}'` として環境変数を登録する。既存のtemplateを作った後に `.runpod.env` だけを変更しても、RunPod側の環境変数は自動更新されない。OpenAI APIキーを追加・変更した場合は、templateまたはPodを作り直すか、RunPod管理画面で環境変数を更新する。

## Docker image

ローカル開発用の `Dockerfile` と、RunPod GPU用の `Dockerfile.runpod` を分ける。

- `Dockerfile`: ローカル/軽量確認用。
- `Dockerfile.runpod`: RunPodのCUDA/PyTorch base imageを使うGPU用。

### registryの選択

初回はDocker Hubのpublic imageが最も簡単。RunPodから追加認証なしでpullでき、CLIスクリプトも `RUNPOD_IMAGE=docker.io/<user>/mo-speech:gpu-smoke` を前提にできる。Docker Hub Personalではpublic repositoryを使えるため、秘密情報をimageに含めない限りMVP検証には足りる。

GHCRはGitHub Container Registryのこと。GitHub repositoryとimageの権限を合わせたい場合、またはGitHub Actionsでbuild/pushしたい場合に向く。ただしprivate imageにするとRunPod側のregistry auth設定が必要になるため、初回検証ではDocker Hub publicより手順が増える。

RunPodのGitHub連携は、GitHub repositoryからRunPod側でimageをbuildし、RunPodのregistryに保存してServerless endpointへdeployする用途に向く。ローカルMacのDocker build容量を避けられるのが利点。ただし初回のWeb UI込みPod検証では、明示的なDocker imageをregistryへpushしてPodからpullする方が手順を追いやすい。

RunPod用imageをbuildしてregistryへpushする。

```sh
scripts/runpod_build_push.sh
```

このスクリプトは以下を実行する。

```sh
docker buildx build --platform linux/amd64 -f Dockerfile.runpod -t "$RUNPOD_IMAGE" --push .
```

Mac上のDocker buildは容量を使う。`buildx --push` を使い、最終imageをローカルに保持しない。ローカル容量が厳しい場合は、RunPod上の一時Pod、GitHub Actions、または別マシンでbuildする。

## モデル配置

モデル本体はDocker imageに焼き込まない。RunPod Network Volumeへ置く。

推奨mount path:

```text
/runpod-volume
```

アプリ側の保存先:

```text
/runpod-volume/models
/runpod-volume/huggingface
/runpod-volume/huggingface/hub
/runpod-volume/work/seed-vc
```

RunPod PodではCLIの `--volume-mount-path /runpod-volume` で揃える。ServerlessではRunPodのNetwork Volumeが `/runpod-volume` にmountされる前提で環境変数を設定する。

初回は `*_LOCAL_FILES_ONLY=0` にして起動時または初回リクエスト時に取得させる。Network Volumeへ必要モデルが入った後は、再現性を優先して `*_LOCAL_FILES_ONLY=1` に切り替える。

## 初回GPU検証モデル

最初にRunPodで通す構成は、ローカルMVPと同じモデルをGPU常駐させる。

| 処理 | 既定モデル | RunPod環境変数 |
| --- | --- | --- |
| ASR | `mobiuslabsgmbh/faster-whisper-large-v3-turbo` | `FASTER_WHISPER_MODEL`、`FASTER_WHISPER_DEVICE=cuda`、`FASTER_WHISPER_COMPUTE_TYPE=float16` |
| 翻訳 | `Qwen/Qwen3-4B` | `QWEN_TRANSLATION_MODEL`、`QWEN_TRANSLATION_DEVICE_MAP=auto` |
| TTS | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | `QWEN_TTS_MODEL`、`QWEN_TTS_DEVICE_MAP=auto`、`QWEN_TTS_DTYPE=float16` |
| 声質変換 | Seed-VC | `SEED_VC_FP16=true`、`SEED_VC_DIFFUSION_STEPS=30`、`SEED_VC_REFERENCE_MAX_SECONDS=10` |

次に試す上位または比較候補:

| 処理 | 比較候補 | 目的 |
| --- | --- | --- |
| ASR | `Systran/faster-whisper-large-v3` | turboより重い精度比較 |
| ASR | `Systran/faster-distil-whisper-large-v3` | GPU上での速度比較 |
| 翻訳 | `Qwen/Qwen3-8B` | 4Bより翻訳品質が上がるか確認 |
| 翻訳 | `Qwen/Qwen3-14B`、`Qwen/Qwen3-32B` | 48GB以上のVRAMまたは量子化前提での品質比較 |
| TTS | `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | 速度比較 |
| TTS | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | 声色制御とクローン品質比較 |
| 声質変換 | Seed-VC高品質steps設定 | 類似度と遅延のバランス確認 |

最初のGPUは24GB VRAM級でも試せるが、4B翻訳、Qwen3-TTS 1.7B、Seed-VCを同時に扱うため、まずは48GB VRAM級のA40/L40S/RTX 6000 Adaを優先する。Japan regionにH100/H200しかない場合は、初回検証には過剰になりやすい。8B以上や14B以上は、Pod上でVRAM実測後に判断する。

## Network Volume作成

利用可能なdata centerを確認する。

```sh
runpodctl datacenter list
```

注意点として、`runpodctl datacenter list` に出るdata centerが必ずNetwork Volume作成に対応しているとは限らない。Network Volume作成時に「Available data centers」が返った場合は、その中からGPU候補もあるdata centerを選ぶ。初回検証では、Network Volume対応かつ48GB VRAM級GPUがあるdata centerを優先する。

`.runpod.env` に `RUNPOD_DATA_CENTER_ID` と容量を設定して作成する。

```sh
scripts/runpod_create_volume.sh
```

作成後、返ってきたNetwork Volume IDを `.runpod.env` の `RUNPOD_NETWORK_VOLUME_ID` に設定する。

## Pod作成

Docker imageをpushし、Network Volume IDを設定した後にPodを作る。

```sh
scripts/runpod_create_gpu_pod.sh
```

主要なRunPod CLI設定:

- `--image "$RUNPOD_IMAGE"`
- `--gpu-id "$RUNPOD_GPU_ID"`
- `--ports "8000/http"`
- `--network-volume-id "$RUNPOD_NETWORK_VOLUME_ID"`
- `--volume-mount-path /runpod-volume`
- `--env '{...}'`

Pod IDが分かったら、Web UIを開く。

```text
https://<pod-id>-8000.proxy.runpod.net
```

CLIで確認する場合:

```sh
RUNPOD_POD_ID=<pod-id> scripts/runpod_smoke_fastapi.sh
```

音声fixtureも投げる場合:

```sh
RUNPOD_POD_ID=<pod-id> \
RUNPOD_SMOKE_AUDIO=/path/to/audio.mp3 \
scripts/runpod_smoke_fastapi.sh
```

## Serverless化

Pod上でモデルロードと短い音声の縦切りが通った後、同じimageをServerless handlerとして使う。

まずServerless templateを作る。

```sh
scripts/runpod_create_serverless_template.sh
```

返ってきたtemplate IDを `.runpod.env` の `RUNPOD_SERVERLESS_TEMPLATE_ID` に設定する。

次にendpointを作る。

```sh
scripts/runpod_create_serverless_endpoint.sh
```

スモーク確認:

```sh
RUNPOD_ENDPOINT_ID=<endpoint-id> \
RUNPOD_API_KEY=<api-key> \
python scripts/runpod_smoke_serverless.py \
  --audio /path/to/audio.mp3 \
  --translation-backend qwen \
  --source-language id-ID \
  --target-language ja-JP \
  --voice-mode convert
```

OpenAI API経路を測る場合は、RunPod endpointの環境変数に `OPENAI_API_KEY` を渡した上で `--translation-backend openai` を指定する。

```sh
RUNPOD_ENDPOINT_ID=<endpoint-id> \
RUNPOD_API_KEY=<api-key> \
python scripts/runpod_smoke_serverless.py \
  --audio /path/to/audio.mp3 \
  --translation-backend openai \
  --source-language id-ID \
  --target-language ja-JP \
  --voice-mode default
```

OpenAI Realtime翻訳を測る場合は、同じく `OPENAI_API_KEY` を渡した上で `--translation-backend openai_realtime` を指定する。Realtime経路は入力言語をAPI側で自動判定するため、`--source-language` は互換用の値として扱う。

```sh
RUNPOD_ENDPOINT_ID=<endpoint-id> \
RUNPOD_API_KEY=<api-key> \
python scripts/runpod_smoke_serverless.py \
  --audio /path/to/audio.mp3 \
  --translation-backend openai_realtime \
  --source-language auto \
  --target-language ja-JP \
  --voice-mode default
```

テキスト読み上げだけを測る場合は `operation_mode=text_tts` を使う。Google Translate TTS endpointは公式APIではないため、安定運用の既定にはしない。OpenAI TTSを測る場合は `--tts-backend openai` を指定し、endpoint側に `OPENAI_API_KEY` を渡す。

```sh
RUNPOD_ENDPOINT_ID=<endpoint-id> \
RUNPOD_API_KEY=<api-key> \
python scripts/runpod_smoke_serverless.py \
  --operation-mode text_tts \
  --text "こんにちは" \
  --target-language ja-JP \
  --tts-backend google_translate
```

VC単体を測る場合は、翻訳パイプラインを通さず `operation_mode=voice_conversion` を使う。

```sh
RUNPOD_ENDPOINT_ID=<endpoint-id> \
RUNPOD_API_KEY=<api-key> \
python scripts/runpod_smoke_serverless.py \
  --operation-mode voice_conversion \
  --audio /path/to/source.wav \
  --reference-audio /path/to/reference.wav \
  --voice-backend seed-vc \
  --seed-vc-diffusion-steps 30 \
  --seed-vc-reference-max-seconds 10
```

Serverless handlerのレスポンスには、通常の `timings_ms` に加えて `serverless_timings_ms` と `serverless` を含める。`serverless_timings_ms.pipeline_load` または `serverless_timings_ms.voice_conversion_service_load` が大きい場合は、worker cold startまたはモデルpreloadが支配的である。`serverless.worker_cold=true` の実行と、同じworker上でのwarm実行を分けて記録する。

Serverlessでは、完全にscale-to-zeroすると初回リクエストでworker起動とモデルロードが入る。検証時は `MO_RUNPOD_PRELOAD_ON_START=1` を使い、worker起動時にpipelineを先にロードしてからhandlerを受け付ける。低アクセス本番ではcold startを許容し、録音開始時のwarmup jobやCloudflare Worker側の進行表示で体感を補う。

VC単体の検証では `MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START=1` を使い、handler起動時にVC serviceを初期化する。ただし現状のSeed-VC providerは変換時にCLI subprocessを起動するため、モデルを完全に常駐させる構成ではない。Seed-VCだけを本番の主処理にする場合は、次の高速化として「Seed-VCモデルをworker process内に常駐させるprovider」を別途実装する。

## 完了条件

RunPod移行の初回完了条件は以下。

1. `runpodctl` からPodまたはServerless endpointを作成できる。
2. Network Volumeが `/runpod-volume` にmountされ、モデルcacheがそこへ作られる。
3. `/health` と `/api/runtime` が成功する。
4. 短い `id-ID -> ja-JP` と `ja-JP -> zh-CN` の音声入力で、文字起こし、翻訳、音声出力が返る。
5. `timings_ms` とRunPod側メトリクスで、cold startとwarm実行の時間を分けて記録できる。
6. Podでの一体動作確認後、Serverless handlerでも同じ入力が通る。
