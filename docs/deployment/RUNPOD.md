# RunPodデプロイ手順

## 現在の状態

RunPodへデプロイするためのDockerfile、CLI補助スクリプト、Serverless handlerは用意している。RunPod APIキー、Docker registry、Network Volume ID、GPU在庫はアカウント側の設定が必要なため、実リソース作成は未実行。

結論として、次のRunPod対応ブランチではServerlessを先にアプリの推論backendとして接続する。

1. RunPod Serverless endpointを推論APIとして用意し、ローカルFastAPIを一時的なUI/gatewayとして使う。
2. FastAPIの `runpod_serverless` 翻訳backendと `seed-vc` VC backendからRunPodへ非同期jobを投げる。
3. RunPod `/health` と `warmup` operationでcold startとwarm状態を分けて表示、計測する。
4. Seed-VCのwarm実行が十分速いと実測できた場合だけ、ユーザー画面ではVCを既定動作にし、`にてるこえ` トグルを隠す検討に進む。
5. 公開MVPではUI/gatewayをCloudflare側へ分け、RunPodは推論APIだけにする。

## Podで確認する場合

RunPod Serverlessはhandler型の推論APIに向く。一方、現在のアプリはFastAPIがWeb UIも配信しているため、ブラウザで録音、アップロード、結果表示、音声再生まで確認する初回検証にはPodが向く。

RunPod PodではHTTP portを公開できる。`8000/http` を公開すると、FastAPIには以下の形式でアクセスする。

```text
https://<pod-id>-8000.proxy.runpod.net
```

Serverlessは後段の推論APIとして使う。URLはRunPodの形式に従う。長い音声処理は `/run` で非同期jobを作り、`/status/<job-id>` をpollingする。短い確認やwarmup確認では `/runsync` も使える。

```text
https://api.runpod.ai/v2/<endpoint-id>/runsync
https://api.runpod.ai/v2/<endpoint-id>/run
https://api.runpod.ai/v2/<endpoint-id>/status/<job-id>
https://api.runpod.ai/v2/<endpoint-id>/health
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
| `RUNPOD_VOLUME_MOUNT_PATH` | Network Volumeのmount先。Serverlessでは返却されたtemplateのmount先にcache設定を合わせる。 |
| `RUNPOD_SERVERLESS_TEMPLATE_ID` | Serverless endpoint作成時のtemplate ID |
| `RUNPOD_ENDPOINT_ID` | Serverlessスモーク確認先 |
| `RUNPOD_API_KEY` | ローカルFastAPI gatewayやスモーク確認からRunPod APIを呼ぶためのAPIキー |
| `RUNPOD_SERVERLESS_TRANSLATION_BACKEND` | Serverless handler内部で使う翻訳backend。既定は `openai`。GPU上のローカルモデル検証では `qwen`。 |
| `RUNPOD_SERVERLESS_REQUEST_MODE` | FastAPI gatewayからRunPodへ投げる方式。既定は `async`。 |
| `RUNPOD_SERVERLESS_TIMEOUT_SECONDS` | RunPod job完了待ちの上限秒数。 |
| `RUNPOD_SERVERLESS_HEALTH_TIMEOUT_SECONDS` | `/api/runtime` からRunPod `/health` を見るときの上限秒数。 |
| `RUNPOD_IDLE_TIMEOUT_SECONDS` | Serverless workerをidle後に落とすまでの秒数。デモ用途の既定は `300`。 |
| `RUNPOD_FLASH_BOOT` | Serverless endpoint作成時にFlashBootを有効にする。デモ用途では `1` を既定にする。 |
| `RUNPOD_WORKERS_MIN` | 最小worker数。デモ用途では待機課金を避けるため `0` を既定にする。 |
| `RUNPOD_WORKERS_MAX` | 最大worker数。既定は `1`。`2` 以上にすると同時VC jobを別workerへ振れるが、新規workerはcold startとSeed-VC preloadをそれぞれ行うため、低頻度デモでは必ず高速化する設定ではない。 |
| `MO_PRELOAD_MODELS` | FastAPI通常pipelineの起動時preload。30GB最小デモでは `0` にし、VCだけを別途preloadする。 |
| `MO_VC_BACKENDS` | UI/VC比較で使うVC backend。RunPod単体デモでは `seed-vc` に絞る。 |
| `OPENAI_API_KEY` | OpenAI API経路を使う場合だけ設定するAPIキー |

課金リソースを作らずにコマンドだけ確認する場合は、各CLIスクリプトに `RUNPOD_DRY_RUN=1` を付ける。

```sh
RUNPOD_DRY_RUN=1 scripts/runpod_create_gpu_pod.sh
```

`.runpod.env` はコンテナ内へファイルとしてアップロードしない。作成スクリプトがローカルで `.runpod.env` を読み、RunPodのPod/Serverless templateへ `--env '{...}'` として環境変数を登録する。ローカルFastAPIをUI/gatewayとして起動する場合は、RunPod clientが `.runpod.env` から接続に必要なキーだけを読み、不足している値だけ環境変数へ入れる。既にシェルで設定済みの値やデプロイ先secretは上書きしない。`.runpod.env` 内の `MO_PROVIDER_MODE` や `MODEL_CACHE_DIR` などRunPodコンテナ用のアプリ設定は、ローカルFastAPIへ自動反映しない。既存のtemplateを作った後に `.runpod.env` だけを変更しても、RunPod側の環境変数は自動更新されない。OpenAI APIキーを追加・変更した場合は、templateまたはPodを作り直すか、RunPod管理画面で環境変数を更新する。

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

### GitHub Actionsでbuild/pushする

ローカル回線の上りが遅い場合は、GitHub ActionsでRunPod用imageをbuildし、GitHub側からDocker Hubへpushする。ローカルMacから大きいDocker layerをアップロードしないため、個人回線の上り速度に依存しにくい。

このリポジトリでは手動実行用workflowとして `.github/workflows/runpod-image.yml` を使う。通常のpushごとに巨大imageをbuildしないよう、`workflow_dispatch` のみで起動する。

GitHub Actionsの手動実行では、`workflow_dispatch` を持つworkflowファイルがdefault branchに存在している必要がある。新規workflowをfeature branchで追加した直後は、そのbranchをpushするだけではActions画面や `gh workflow run` から見つからない場合がある。初回はworkflowファイルをmainへ入れてから、必要に応じて `--ref <branch>` で対象branchのコードをbuildする。

RunPod用base imageはCUDA/PyTorchを含むため大きい。GitHub-hosted runnerではbase image展開中に容量不足になることがあるため、workflowはbuild前にAndroid、.NET、hosted tool cache、runner側CUDAなどの不要なプリインストールを削除してからDocker buildを開始する。

事前にGitHub repository secretsへ以下を登録する。

| Secret | 用途 |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hubのユーザー名 |
| `DOCKERHUB_TOKEN` | Docker Hubのaccess token。パスワードではなくpush権限を持つtokenを使う |

`DOCKERHUB_USERNAME` と `DOCKERHUB_TOKEN` はGitHub Actions専用の認証情報としてGitHub Secretsへ保存する。`.env` や `.runpod.env` へは書かない。ローカルで `gh secret set` を実行するときも、履歴にtokenが残らない入力方式を使う。

GitHub CLIで登録する場合:

```bash
gh secret set DOCKERHUB_USERNAME --body "<Docker Hub user>"
gh secret set DOCKERHUB_TOKEN
```

実行手順:

```bash
gh workflow run runpod-image.yml \
  --ref feature/vibevoice-zhskit-mode \
  -f image_name=docker.io/dockerhubfd/mo-speech \
  -f image_tag=runpod-vibevoice-$(git rev-parse --short HEAD)
```

Actions実行が成功したら、出力されたimage tagを `.runpod.env` の `RUNPOD_IMAGE` に反映し、Serverless templateを更新する。Docker HubへのpushはGitHub側で完了しているため、ローカルではRunPod APIへの小さいリクエストだけで済む。

`image_tag` はcommitごとに一意にする。固定タグを再利用すると、registry上のdigestが更新されてもRunPod側の既存workerやimage cacheが古いコードを実行し続けるかを切り分けにくい。`image_tag` を空にした場合、workflowは `runpod-<short-sha>` を使う。

Actions経由でpush済みなら、ローカルで `scripts/runpod_build_push.sh` は実行しない。既存Serverless templateはRunPod管理画面またはRunPod APIでimageだけ差し替えられるが、確実な検証では新しいtemplateを作り、endpointの `templateId` 自体を切り替える。`.runpod.env` の `RUNPOD_IMAGE` をActionsでpushしたtagにしてからtemplate作成スクリプトを実行する。

```bash
# .runpod.env
RUNPOD_IMAGE=docker.io/dockerhubfd/mo-speech:runpod-vibevoice-<short-sha>
```

既存templateへ反映する場合:

```bash
scripts/runpod_update_serverless_template.sh
```

このスクリプトは `.runpod.env` を読み、`RUNPOD_SERVERLESS_TEMPLATE_ID` のimageと環境変数を更新する。Serverless endpointが同じtemplate IDを参照している場合、新しく起動するworkerは更新後のimageをpullする。既に起動済みのworkerは古いimageのまま残ることがあるため、確実に新imageで確認したい場合は既存workerを落とすか、idle timeout後に再実行する。

新しいtemplateとして切り替える場合:

```bash
scripts/runpod_create_serverless_template.sh
```

返ってきたtemplate IDを `.runpod.env` の `RUNPOD_SERVERLESS_TEMPLATE_ID` に反映し、RunPod管理画面またはREST APIでendpointの `templateId` をそのIDへ更新する。既存workerが残る場合は、一時的に `workersMax=0` へ下げてから `workersMax=1` へ戻すと、旧workerを避けて新templateから起動し直せる。

image更新後は、生成jobを投げる前に軽量なdiagnostics jobでworker内の実行コードを確認する。`runpod-image.yml` はbuild時のGit commit SHAをimage環境変数 `MO_IMAGE_REVISION` に埋め込み、diagnosticsはその値と `/app/src/mo_speech/vibevoice_cli.py` の実装マーカーを返す。VibeVoice確認では `vibevoice_cli.uses_parsed_scripts=true`、`vibevoice_cli.uses_raw_text_processor_call=false`、`image.revision` がbuild対象commitに一致することを先に確認する。

```bash
python scripts/runpod_smoke_serverless.py \
  --operation-mode diagnostics \
  --request-mode async
```

diagnosticsが未対応、または `uses_raw_text_processor_call=true` を返す場合、RunPod endpointは古いimageまたは古いworkerを使っている。Serverless templateのimage更新、endpointのworker入れ替え、またはidle timeout後の再実行を先に行い、VibeVoice生成の成否判断に進まない。

diagnosticsが新imageを示した後、VibeVoice単体のServerless smokeを実行する。UIやローカルFastAPIを介さず、RunPod handlerへ直接 `operation_mode=vibevoice` を投げるため、endpoint側のモデルロード、参照音声処理、VibeVoice CLI実行の問題を分けて確認できる。

```bash
python scripts/runpod_smoke_serverless.py \
  --operation-mode vibevoice \
  --request-mode async \
  --script "Speaker 1: こんにちは。" \
  --voice-audio 1:/path/to/reference.wav \
  --vibevoice-inference-steps 2 \
  --vibevoice-max-voice-seconds 3
```

`runpodctl template get` などの確認コマンドは、template envの値をそのまま表示する場合がある。出力を保存・共有するときはAPI keyやtokenが含まれていないことを確認し、必要なら伏せる。

## モデル配置

モデル本体はDocker imageに焼き込まない。RunPod Network Volumeへ置く。

GPU Podで明示mountする場合の推奨mount path:

```text
/runpod-volume
```

Serverless templateではRunPod側のtemplate返却値が `/workspace` になる場合がある。重要なのは、templateの `volumeMountPath` とアプリ側のcache rootを同じ値に揃えること。`.runpod.env` の `RUNPOD_VOLUME_MOUNT_PATH` を決めると、作成スクリプトの既定cache pathもそこから派生する。

アプリ側の保存先例:

```text
${RUNPOD_VOLUME_MOUNT_PATH}/models
${RUNPOD_VOLUME_MOUNT_PATH}/huggingface
${RUNPOD_VOLUME_MOUNT_PATH}/huggingface/hub
${RUNPOD_VOLUME_MOUNT_PATH}/work/seed-vc
```

RunPod PodではCLIの `--volume-mount-path /runpod-volume` で揃える。Serverlessではtemplate作成後の返却値を確認し、必要なら `.runpod.env` の `RUNPOD_VOLUME_MOUNT_PATH` とcache pathを作り直す。

初回は `*_LOCAL_FILES_ONLY=0` にして起動時または初回リクエスト時に取得させる。Network Volumeへ必要モデルが入った後は、再現性を優先して `*_LOCAL_FILES_ONLY=1` に切り替える。

## 初回GPU検証モデル

最初にRunPodで通す構成は、ローカルMVPと同じモデルをGPU常駐させる。

| 処理 | 既定モデル | RunPod環境変数 |
| --- | --- | --- |
| ASR | `mobiuslabsgmbh/faster-whisper-large-v3-turbo` | `FASTER_WHISPER_MODEL`、`FASTER_WHISPER_DEVICE=cuda`、`FASTER_WHISPER_COMPUTE_TYPE=float16` |
| 翻訳 | `Qwen/Qwen3-4B` | `QWEN_TRANSLATION_MODEL`、`QWEN_TRANSLATION_DEVICE_MAP=auto` |
| TTS | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | `QWEN_TTS_MODEL`、`QWEN_TTS_DEVICE_MAP=auto`、`QWEN_TTS_DTYPE=float16` |
| 声質変換 | Seed-VC | `SEED_VC_EXECUTION_MODE=resident`、`SEED_VC_FP16=true`、`SEED_VC_DIFFUSION_STEPS=8`、`SEED_VC_REFERENCE_MAX_SECONDS=12` |

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
  --translation-backend openai \
  --source-language id-ID \
  --target-language ja-JP \
  --voice-mode convert
```

`scripts/runpod_smoke_serverless.py` は既定でレスポンス中の `audio_base64` を長さ表示に置き換える。音声base64全体を確認したい場合だけ `--print-audio-base64` を付ける。async pollingでは `--http-timeout` で1回ごとのHTTP timeoutを指定できる。

workerを明示的にwarmupする場合:

```sh
RUNPOD_ENDPOINT_ID=<endpoint-id> \
RUNPOD_API_KEY=<api-key> \
python scripts/runpod_smoke_serverless.py \
  --operation-mode warmup \
  --translation-backend openai \
  --preload-voice-conversion
```

ローカルFastAPIからServerless backendを使う場合は、FastAPI側にもRunPod接続設定を渡す。シェルで渡してもよいし、git管理外の `.runpod.env` に `RUNPOD_ENDPOINT_ID` と `RUNPOD_API_KEY` を入れてもよい。ローカルFastAPI自体のprovider設定を変える場合は、`.env` またはシェルで明示する。

```sh
uvicorn mo_speech.api:app --host 0.0.0.0 --port 8000
```

RunPod実行先を選んだときに `RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY are required for RunPod Serverless backend.` が出る場合は、起動中のFastAPIプロセスが `RUNPOD_ENDPOINT_ID` と `RUNPOD_API_KEY` を読めていない。`.runpod.env` を直した後は、Uvicornプロセスを再起動してから確認する。

この構成ではFastAPIがUIと履歴保存を担当し、ASR/翻訳/TTS/VCはRunPod Serverless handlerへ送る。Cloudflare gatewayとオブジェクトストレージ履歴は別段階で追加する。

GPU上のローカル翻訳を比較する場合は、RunPod endpointの環境変数に `MO_TRANSLATION_PROVIDER=qwen3` を渡した上で `--translation-backend qwen` を指定する。ユーザー画面相当の品質確認では、OpenAI API経路を使う。

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

RunPod管理画面のendpoint `ready` やWorkersタブの `idle` は、endpointまたはworker recordの状態を示すもので、アプリ内のSeed-VCモデルがresident load済みであることとは別に扱う。UIで `じゅんびOK` と表示する条件は、`/health` でworkerが見えることではなく、`warmup` operationまたはSeed-VC voice conversion jobが成功し、その結果からVC ready状態を短時間だけ確認できることにする。

Serverlessでは、完全にscale-to-zeroすると初回リクエストでworker起動とモデルロードが入る。デモ用途では `RUNPOD_FLASH_BOOT=1` でFlashBootを有効にし、container cold startを短縮する。FlashBootはworker/containerの起動遅延を減らすための設定であり、Seed-VC serviceの初回ロード、Network Volumeからのモデル読み込み、実際のVC推論時間まで必ず消えるわけではない。レスポンスが遅い場合は、RunPod側のcold startだけでなく、`serverless_timings_ms.voice_conversion_service_load`、`timings_ms.voice_conversion`、queue/poll往復を分けて見る。

FlashBoot状態はRunPod REST APIのendpoint詳細で `flashboot=true` を確認する。`runpodctl serverless create --help` ではFlashBootが既定有効になっているが、既存endpointの確認や更新はCLIのversion差分を受ける場合がある。既存endpointが `flashboot=false` の場合は、REST APIの `POST /v1/endpoints/{endpoint_id}/update` に `{"flashboot": true}` を送るか、FlashBoot有効のendpointを作り直す。

VC単体の検証では `MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START=1` と `SEED_VC_EXECUTION_MODE=resident` を使い、handler起動時にVC serviceとSeed-VCモデルをworker process内へロードする。30GBのNetwork VolumeでSeed-VC最小構成を試す場合は、通常pipelineの起動時preloadを避けるため `MO_PRELOAD_MODELS=0`、VC backendを絞るため `MO_VC_BACKENDS=seed-vc` にする。`RUNPOD_WORKERS_MIN=0` のままでも、デモ直前に管理者用画面 `/admin` の手動準備ボタンからwarmup requestを投げ、`RUNPOD_IDLE_TIMEOUT_SECONDS=300` の範囲内で利用すれば、待機課金を常時発生させずにwarm workerを使いやすい。CloudflareのページHTML配信だけではRunPod jobは起きず、管理者用画面の手動操作、または録音送信後の実変換でRunPod jobが作られる。

`RUNPOD_WORKERS_MAX` を増やすと、同時アクセス時にRunPodが追加workerを起動できる。ただし `RUNPOD_WORKERS_MIN=0` のデモ運用では、追加workerは基本的にcold状態から起動し、各worker内でSeed-VC preloadが必要になる。1つ目のwarm workerだけで処理できる程度の同時数なら `workers-max=1` の方が予測しやすい。複数人が同時にVCを使うデモでは `workers-max=2` を試せるが、2人目以降の初回VCはcold start分だけ遅くなる可能性を測定して判断する。

スマホから見るデモでは、ローカルMacのFastAPIをUI/gatewayにしない。Cloudflare gatewayを置く前の暫定運用では、同じRunPod imageをGPU Podとして起動し、`CMD` のFastAPI/Uvicornを `8000/http` で公開する。`MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START=1` の場合、Webサーバー起動時にVC preloadが完了してから画面を返せるため、cold start後に `/` が表示されたことを「Webプロセスと常駐VC providerの初期化が完了した」シグナルとして扱える。

## 完了条件

RunPod移行の初回完了条件は以下。

1. `runpodctl` からPodまたはServerless endpointを作成できる。
2. Network Volumeのmount先とcache環境変数が一致し、モデルcacheがNetwork Volume上に作られる。
3. `/health` と `/api/runtime` が成功する。
4. 短い `id-ID -> ja-JP` と `ja-JP -> zh-CN` の音声入力で、文字起こし、翻訳、音声出力が返る。
5. `timings_ms` とRunPod側メトリクスで、cold startとwarm実行の時間を分けて記録できる。
6. Podでの一体動作確認後、Serverless handlerでも同じ入力が通る。
