# RunPodデプロイ手順

更新日: 2026-08-24

## 役割

RunPodはGPU依存処理だけを担当する。公開UIとAPI gatewayはCloudflare Workerが担当し、ローカル確認ではFastAPIを使える。実リソース状態はアカウント側で変わるため、デプロイ時に `.runpod.env` とRunPod管理画面で確認する。

Serverless handlerが受け付けるoperationは次の5種類である。

- `practice_asr`
- `text_tts`
- `voice_conversion`
- `warmup`
- `diagnostics`

`practice_asr` はSpeakLoopの中国語の発音練習に使う。お手本と復唱をFunASR Paraformer Chineseでtimestamp付きASRし、VADと句読点モデルを併用する。英語発音練習と母語録音の処理はOpenAI経路を使う。

SpeakLoopの中国語比較は `/runsync` で待たず、`/run` でjobを作り `/status/<job-id>` をpollingする。handlerが送るprogress updateの種類は次のとおり。

- `initializing`
- `loading_model`
- `transcribing_model`
- `transcribing_attempt`
- `finalizing`

queue中はjob statusと `/health` のworker数から、worker割り当て待ちとworker初期化中を区別する。RunPodが返す `delayTime` と `executionTime` もUIの補足情報に使う。

Seed-VCも同じ非同期job経路で進捗を返す。handlerが送るprogress updateの種類は次のとおり。

- `loading_seed_vc_model`
- `voice_conversion`
- `reconstruct`
- `finalizing`

SpeakLoopで `自分の声` を選んだ場合も、通常TTSを変換元、最初の録音をSeed-VC参照音声として同じvoice conversion jobへ送る。失敗時はRunPodが返した原因を保持し、残高不足を文言から明確に判別できる場合だけBillingの確認を案内する。

Serverless endpointのURLはRunPodの形式に従う。

```text
https://api.runpod.ai/v2/<endpoint-id>/runsync
https://api.runpod.ai/v2/<endpoint-id>/run
https://api.runpod.ai/v2/<endpoint-id>/status/<job-id>
https://api.runpod.ai/v2/<endpoint-id>/health
```

## requestと保存境界

Cloudflare Worker、ローカルFastAPI、smoke scriptは、RunPodへ `input` だけを送る。jobの保持期間と実行上限はRunPodの既定を使い、application側でoperation別policyを重複管理しない。

```json
{
  "input": { "operation_mode": "voice_conversion" }
}
```

application logと利用者向けerrorにはraw音声base64・台本・request全体・response全体を含めない。cancel・failure・timeout・JSON parse failureでも非payload metadataだけを使う。非payload metadataはjob ID・HTTP status・正規化したstageなどである。RunPod側の一時処理と保持は同社のサービス条件に従う。公開時はRunPodを外部送信先として案内する。

## CLI準備

RunPod CLIは `runpodctl` を使う。macOSではHomebrewで入れられる。

```sh
brew install runpod/runpodctl/runpodctl
runpodctl config --apiKey "<RunPod API key>"
runpodctl doctor
```

APIキーやDocker registry tokenはリポジトリに保存しない。

## 環境ファイル

設定テンプレート `scripts/runpod.env.example` を `.runpod.env` へコピーして使う。`.runpod.env` はgit管理しない。主な変数は次のとおり。

| 変数 | 用途 |
| --- | --- |
| `RUNPOD_IMAGE` | Docker registryへpushするimage名 |
| `RUNPOD_IMAGE_VISIBILITY` | image repositoryの実際の可視性。既定は `private`。 |
| `RUNPOD_REGISTRY_AUTH_ID` | RunPodへ登録したpull専用container registry credentialのID。credentialのtoken自体は保存しない。private imageでは必須。 |
| `RUNPOD_GPU_ID` | 例: `NVIDIA A40`、`NVIDIA GeForce RTX 4090` |
| `RUNPOD_DATA_CENTER_ID` | Network Volume作成先 |
| `RUNPOD_DATA_CENTER_IDS` | Pod/Serverless配置先候補 |
| `RUNPOD_NETWORK_VOLUME_ID` | 作成済みNetwork Volume ID |
| `RUNPOD_VOLUME_MOUNT_PATH` | Network Volumeのmount先。Serverlessでは返却されたtemplateのmount先にcache設定を合わせる。 |
| `RUNPOD_SERVERLESS_TEMPLATE_ID` | Serverless endpoint作成時のtemplate ID |
| `RUNPOD_ENDPOINT_ID` | Serverlessスモーク確認先 |
| `RUNPOD_API_KEY` | ローカルFastAPI gatewayやスモーク確認からRunPod APIを呼ぶためのAPIキー |
| `RUNPOD_SERVERLESS_REQUEST_MODE` | FastAPI gatewayからRunPodへ投げる方式。既定は `async`。 |
| `RUNPOD_SERVERLESS_TIMEOUT_SECONDS` | RunPod job完了待ちの上限秒数。 |
| `RUNPOD_SERVERLESS_HEALTH_TIMEOUT_SECONDS` | `/api/runtime` からRunPod `/health` を見るときの上限秒数。 |
| `RUNPOD_IDLE_TIMEOUT_SECONDS` | Serverless workerをidle後に落とすまでの秒数。デモ用途の既定は `300`。 |
| `RUNPOD_FLASH_BOOT` | Serverless endpoint作成時にFlashBootを有効にする。デモ用途では `1` を既定にする。 |
| `RUNPOD_WORKERS_MIN` | 最小worker数。デモ用途では待機課金を避けるため `0` を既定にする。 |
| `RUNPOD_WORKERS_MAX` | 最大worker数。既定は `1`。追加workerはcold startとSeed-VC preloadを各自で行うため、増やす場合は実測して判断する。 |
| `MO_PRELOAD_MODELS` | FastAPI通常pipelineの起動時preload。30GB最小デモでは `0` にし、VCだけを別途preloadする。 |
| `MO_VC_BACKENDS` | UI/VC比較で使うVC backend。RunPod単体デモでは `seed-vc` に絞る。 |
| `FUNASR_MODEL` / `FUNASR_FA_MODEL` | 中国語の発音練習ASRとforced alignmentのモデル。既定は `funasr/paraformer-zh` と `funasr/fa-zh`。 |
| `FUNASR_VAD_MODEL` / `FUNASR_PUNC_MODEL` | 中国語の発音練習のVADと句読点モデル。既定は `funasr/fsmn-vad` と `funasr/ct-punc`。 |
| `FUNASR_HUB` / `FUNASR_DEVICE` | FunASRの取得元と実行device。RunPod imageの既定は `hf` / `cuda`。 |
| `MO_RUNPOD_PRELOAD_FUNASR_ON_START` | 起動時にFunASRを先読みするか。Seed-VCとVRAMを共用するため既定は `0`。 |
| `MO_RUNPOD_RELEASE_VOICE_CONVERSION_BEFORE_FUNASR` | FunASRをロードする前に常駐Seed-VCを解放するか。既定は `1`。 |
| `MO_RUNPOD_RELEASE_FUNASR_BEFORE_VOICE_CONVERSION` | Seed-VC実行前にFunASRを解放するか。既定は `1`。 |
| `OPENAI_API_KEY` | OpenAI API経路を使う場合だけ設定するAPIキー。 |

課金リソースを作らずにコマンドだけ確認する場合は、各CLIスクリプトに `RUNPOD_DRY_RUN=1` を付ける。

`.runpod.env` はコンテナ内へファイルとしてアップロードしない。作成スクリプトがローカルで読み、RunPodのtemplateへ `--env '{...}'` として環境変数を登録する。既存templateを作った後に `.runpod.env` だけを変更しても、RunPod側の環境変数は自動更新されない。変更を反映するにはtemplateを更新するか作り直す。

## Docker image

RunPod GPU用は `Dockerfile.runpod` を使う（ローカル/軽量確認用の `Dockerfile` と分ける）。モデル本体はimageへ焼き込まず、Network Volumeへ置く（[MODEL_STORAGE.md](MODEL_STORAGE.md)）。

### private registry

RunPod imageはprivate repositoryを既定とする。imageには `/app/src` と実行環境が含まれるため、GitHub repositoryをprivateにしてもcontainer repositoryがpublicなら実装を取得できる。public配布は [公開前チェックリスト](PUBLICATION_CHECKLIST.md) の権利・プライバシー・外部設定を完了した場合だけ明示的に選ぶ。

Docker HubではRunPod専用のread-only Personal Access Tokenを作る。通常のpush用tokenやアカウントパスワードをRunPodへ渡さない。RunPod ConsoleのRegistry Credentialsへ登録し、返されたIDだけをgit管理外の `.runpod.env` へ保存する。

```bash
# credential登録後、secretではないIDだけを保存する
RUNPOD_IMAGE_VISIBILITY=private
RUNPOD_REGISTRY_AUTH_ID=<RunPod registry credential ID>
```

Serverless templateのcreate/updateは `scripts/runpod_template_api.py` を通じてRunPod REST APIを使い、`containerRegistryAuthId` を明示する。`runpodctl template create/update` にはこのIDを渡すoptionがないため使用しない。private imageなのに `RUNPOD_REGISTRY_AUTH_ID` が空の場合、deploy、create、updateの各スクリプトは外部変更前に安全停止する。Docker Hub tokenはRunPod側credentialだけに保存し、`.runpod.env`、GitHub Secrets、template envへ複製しない。

### GitHub Actionsでのbuild/push

imageのbuildとpushは手動実行用workflow `.github/workflows/runpod-image.yml` で行う。巨大imageを通常のpushごとにbuildしないよう、`workflow_dispatch` のみで起動する。実行時に既存のDocker Hub repositoryと `expected_visibility` を毎回指定し、実際の可視性と一致しなければlogin・build・push前に停止する。既定の期待値は `private` である。

事前にGitHub repository secretsへ次を登録する。`.env` や `.runpod.env` へは書かない。

| Secret | 用途 |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hubのユーザー名 |
| `DOCKERHUB_TOKEN` | Docker Hubのaccess token。パスワードではなくpush権限を持つtokenを使う |

ローカルDockerで直接buildする場合は `scripts/runpod_build_push.sh` を使う。`buildx --push` で最終imageをローカルに保持しない。

## deployスクリプトの使い分け

| スクリプト | 使う場面 | 主な処理 |
| --- | --- | --- |
| `scripts/runpod_deploy_serverless_image.sh` | 通常のdeploy。push済みの現在HEADをRunPod Serverlessへ反映したい時 | GitHub Actionsでimageをbuild/pushし、registry credential付きの新しいServerless templateを作り、endpointの `templateId` を切り替え、`.runpod.env` を更新し、diagnostics smokeを実行する |
| `scripts/runpod_update_serverless_template.sh` | imageは既にbuild/push済みで、既存templateのimage/envだけを更新したい時 | RunPod REST APIで既存templateを更新する。endpoint切替やworker入れ替えは行わない |
| `scripts/runpod_create_serverless_template.sh` | 手動で新templateだけ作りたい時 | `.runpod.env` のimageとregistry credentialから新templateを作る。IDの保存とendpoint切替は手動で行う |
| `scripts/runpod_create_serverless_endpoint.sh` | endpointを新規作成する時 | `.runpod.env` のtemplate IDからServerless endpointを作る |
| `scripts/runpod_create_volume.sh` | Network Volumeを新規作成する時 | `RUNPOD_DATA_CENTER_ID` と容量からNetwork Volumeを作る |
| `scripts/runpod_build_push.sh` | ローカルDockerで直接build/pushしたい時 | `Dockerfile.runpod` をbuildx buildしてregistryへpushする。Actions運用では通常使わない |
| `scripts/runpod_smoke_serverless.py` | deploy後の確認、または生成問題の切り分け | handlerへdiagnostics、中国語練習ASR、TTS、Seed-VCなどのjobを直接投げる |

通常のdeployは `scripts/runpod_deploy_serverless_image.sh` の1本で行う。判断に迷う場合は `RUNPOD_DRY_RUN=1` を付け、実行予定のtag、template名、workflow起動内容を確認してから本実行する。

deployスクリプトの前提と規約は次のとおり。

- 現在のHEADがupstreamへpush済みであることを確認する。GitHub Actionsはpush済みcommitしかcheckoutできない。
- image tagは `runpod-app-<short-sha>`、template名は `mo-speech-serverless-<short-sha>` とし、commitごとに一意にする。固定tagの再利用は、古いworkerやimage cacheとの取り違えを生むため避ける。
- 反映は既存templateの書き換えではなく、新template作成とendpointの `templateId` 切替を既定とする。
- 同じcommitで再実行した場合は、同名の自分のtemplateを検索してPATCHで再利用する。`Template name must be unique` が出たら同じcommitのまま再実行する。

image更新後は、生成jobを投げる前にdiagnostics jobでworker内の実行コードを確認する。workflowはbuild時のGit commit SHAを環境変数 `MO_IMAGE_REVISION` としてimageへ埋め込み、diagnosticsはその値を返す。古いrevisionが返る場合は、templateのimage更新かworker入れ替えを先に行い、生成jobの成否判断へ進まない。

```bash
python scripts/runpod_smoke_serverless.py \
  --operation-mode diagnostics \
  --request-mode async
```

`runpodctl template get` などの確認コマンドは、template envの値をそのまま表示する場合がある。出力を保存・共有するときはAPIキー等が含まれていないことを確認する。

## モデル配置

モデル本体はDocker imageに焼き込まず、RunPod Network Volumeへ置く。templateの `volumeMountPath` とアプリ側のcache rootを同じ値に揃える。`.runpod.env` の `RUNPOD_VOLUME_MOUNT_PATH` を決めると、作成スクリプトの既定cache pathもそこから派生する。

```text
${RUNPOD_VOLUME_MOUNT_PATH}/models
${RUNPOD_VOLUME_MOUNT_PATH}/huggingface
${RUNPOD_VOLUME_MOUNT_PATH}/huggingface/hub
${RUNPOD_VOLUME_MOUNT_PATH}/work/seed-vc
```

初回は `*_LOCAL_FILES_ONLY=0` にして初回リクエスト時に取得させる。必要モデルが入った後は、再現性を優先して `*_LOCAL_FILES_ONLY=1` に切り替える。

| 処理 | 既定モデル | RunPod環境変数 |
| --- | --- | --- |
| 中国語ASR | `funasr/paraformer-zh` | `FUNASR_MODEL`、`FUNASR_DEVICE=cuda` |
| forced alignment | `funasr/fa-zh` | `FUNASR_FA_MODEL` |
| VAD・句読点 | `funasr/fsmn-vad`・`funasr/ct-punc` | `FUNASR_VAD_MODEL`・`FUNASR_PUNC_MODEL` |
| 声質変換 | Seed-VC | `SEED_VC_EXECUTION_MODE=resident`、`SEED_VC_FP16=true`、`SEED_VC_DIFFUSION_STEPS=8`、`SEED_VC_REFERENCE_MAX_SECONDS=12` |

FunASRとSeed-VCは同じworker processへ同時常駐させない。operation切替時に使わない側を解放し、VRAM使用量を抑える。

Network Volumeの作成先は `runpodctl datacenter list` で確認する。一覧に出るdata centerが必ずNetwork Volume作成に対応しているとは限らないため、作成時に返る「Available data centers」からGPU候補もある場所を選ぶ。

## smoke確認

`scripts/runpod_smoke_serverless.py` でoperation別にhandlerを直接確認する。既定でレスポンス中の `audio_base64` は長さ表示に置き換える。

scriptは `.runpod.env` を読まないため、以降の例の前に認証情報をshellへ読み込む。

```sh
export RUNPOD_ENDPOINT_ID=$(grep '^RUNPOD_ENDPOINT_ID=' .runpod.env | cut -d= -f2-)
export RUNPOD_API_KEY=$(grep '^RUNPOD_API_KEY=' .runpod.env | cut -d= -f2-)
```

workerのwarmup（Seed-VC preload込み）:

```sh
python scripts/runpod_smoke_serverless.py \
  --operation-mode warmup \
  --preload-voice-conversion
```

FunASRをwarmupする場合は `--preload-practice-asr` を使う。Seed-VCとFunASRを同じwarmup requestで同時に先読みする指定は受け付けない。

中国語の発音練習ASR:

```sh
python scripts/runpod_smoke_serverless.py \
  --operation-mode practice_asr \
  --audio /path/to/chinese-attempt.webm \
  --model-audio /path/to/chinese-model.wav \
  --target-text '你好吗？你今天去哪里？' \
  --request-mode async
```

`--model-audio` と `--target-text` を省略すると復唱音声単体のFunASR確認になる。この場合は `align_timestamps=false` を送り、`fa-zh` を読み込まない。両音声を指定したsmokeは `practice_asr_contract_version=3` と `model_transcription` も検査し、旧imageや不完全な応答では終了コード1にする。

テキスト読み上げ（backendはOpenAI TTSのみ。endpoint側に `OPENAI_API_KEY` が必要）:

```sh
python scripts/runpod_smoke_serverless.py \
  --operation-mode text_tts \
  --text "こんにちは" \
  --target-language ja-JP \
  --tts-backend openai
```

VC単体:

```sh
python scripts/runpod_smoke_serverless.py \
  --operation-mode voice_conversion \
  --audio /path/to/source.wav \
  --reference-audio /path/to/reference.wav \
  --voice-backend seed-vc
```

## cold startと準備状態の見方

- handlerのレスポンスは `timings_ms` に加えて `serverless_timings_ms` と `serverless` を含む。`pipeline_load` や `voice_conversion_service_load` が大きい場合は、worker cold startかモデルpreloadが支配的である。
- RunPod管理画面の `ready` や `idle` はendpoint/worker recordの状態であり、Seed-VCモデルのresident load完了とは別に扱う。UIの準備完了は、warmupまたはVC jobの成功結果だけから判定する。
- FlashBootはcontainer cold startを短縮する設定であり、モデルの初回ロードや推論時間まで消すものではない。遅い場合はcold start、モデルロード、queue/poll往復を分けて見る。
- ページHTMLの配信はCloudflare側で完了するため、ページ表示はRunPod workerのwarm完了シグナルにならない。準備状態は `/api/runtime` と `/api/warmup` の結果で見る（[CLOUDFLARE.md](CLOUDFLARE.md)）。

ローカルFastAPIからServerless backendを使う場合は、`.runpod.env` へ `RUNPOD_ENDPOINT_ID` と `RUNPOD_API_KEY` を入れてUvicornを起動する。`RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY are required` が出る場合は、起動中のプロセスが値を読めていないので再起動してから確認する。

## 完了条件

RunPod構成の確認条件は以下。

1. `runpodctl` またはREST APIからServerless endpointを作成できる。
2. Network Volumeのmount先とcache環境変数が一致し、モデルcacheがNetwork Volume上に作られる。
3. `/health` と `/api/runtime` が成功する。
4. diagnosticsが現在のimage revisionと依存情報を返す。
5. `practice_asr` がcontract version 3の中国語結果を返す。
6. `text_tts` と `voice_conversion` がoperation別の結果を返す。
7. `timings_ms` とRunPod側metricsでcold startとwarm実行を分けて記録できる。
