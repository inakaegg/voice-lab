# RunPodデプロイ手順

更新日: 2026-08-02

## 現在の状態

RunPod向けDockerfile・CLI補助スクリプト・Serverless handlerを実装している。CloudflareとローカルFastAPIから接続できる。実リソース状態はアカウント側で変わるため、デプロイ時に `.runpod.env` とRunPod管理画面で確認する。

RunPodはGPU依存処理だけを担当する。公開UIとAPI gatewayはCloudflare Workerが担当する。ローカル確認ではFastAPIを使える。

Serverless handlerが受け付けるoperationは次の5種類である。

- `practice_asr`
- `text_tts`
- `voice_conversion`
- `warmup`
- `diagnostics`

`practice_asr` はSpeakLoopの中国語発音練習に使う。お手本と復唱をFunASR Paraformer Chineseでtimestamp付きASRし、VADと句読点モデルを併用する。英語発音練習と母語録音の処理はOpenAI経路を使う。

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

SpeakLoopで `自分の声` を選んだ場合も、通常TTSを変換元、最初の録音をSeed-VC参照音声として同じvoice conversion jobへ送る。表示内容はGPU待機、Seed-VCモデル読込、声質変換である。Cloudflare WorkerとローカルFastAPIは途中結果を履歴保存せず、RunPod job statusをpollingして既存進捗欄へ表示する。失敗時はRunPodが返した原因を保持し、残高不足を文言から明確に判別できる場合だけBillingの確認を案内する。

## requestと保存境界

Cloudflare Worker、ローカルFastAPI、smoke scriptは、RunPodへ `input` だけを送る。jobの保持期間と実行上限はRunPodの既定を使い、application側でoperation別policyを重複管理しない。

```json
{
  "input": { "operation_mode": "voice_conversion" }
}
```

application logと利用者向けerrorにはraw音声base64・台本・request全体・response全体を含めない。cancel・failure・timeout・JSON parse failureでも非payload metadataだけを使う。非payload metadataはjob ID・HTTP status・正規化したstageなどである。RunPod側の一時処理と保持は同社のサービス条件に従う。公開時はRunPodを外部送信先として案内する。

## Podで確認する場合

RunPod Serverlessはhandler型の推論APIに向く。一方、現在のアプリはFastAPIがWeb UIも配信している。ブラウザで確認する初回検証にはPodが向く。確認対象は録音、アップロード、結果表示、音声再生である。

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
| `RUNPOD_WORKERS_MAX` | 最大worker数。既定は `1`。`2` 以上にすると同時VC jobを別workerへ振れるが、新規workerはcold startとSeed-VC preloadをそれぞれ行うため、低頻度デモでは必ず高速化する設定ではない。 |
| `MO_PRELOAD_MODELS` | FastAPI通常pipelineの起動時preload。30GB最小デモでは `0` にし、VCだけを別途preloadする。 |
| `MO_VC_BACKENDS` | UI/VC比較で使うVC backend。RunPod単体デモでは `seed-vc` に絞る。 |
| `FUNASR_MODEL` / `FUNASR_FA_MODEL` | 中国語発音練習ASRとforced alignmentのモデル。既定は `funasr/paraformer-zh` と `funasr/fa-zh`。 |
| `FUNASR_VAD_MODEL` / `FUNASR_PUNC_MODEL` | 中国語発音練習のVADと句読点モデル。既定は `funasr/fsmn-vad` と `funasr/ct-punc`。 |
| `FUNASR_HUB` / `FUNASR_DEVICE` | FunASRの取得元と実行device。RunPod imageの既定は `hf` / `cuda`。 |
| `MO_RUNPOD_PRELOAD_FUNASR_ON_START` | 起動時にFunASRを先読みするか。Seed-VCとVRAMを共用するため既定は `0`。 |
| `MO_RUNPOD_RELEASE_VOICE_CONVERSION_BEFORE_FUNASR` | FunASRをロードする前に常駐Seed-VCを解放するか。既定は `1`。 |
| `MO_RUNPOD_RELEASE_FUNASR_BEFORE_VOICE_CONVERSION` | Seed-VC実行前にFunASRを解放するか。既定は `1`。 |
| `OPENAI_API_KEY` | OpenAI API経路を使う場合だけ設定するAPIキー。 |

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

RunPod imageはprivate repositoryを既定とする。imageには `/app/src` と実行環境が含まれるため、GitHub repositoryをprivateにしてもcontainer repositoryがpublicなら実装を取得できる。Docker Hub側でrepositoryを先にprivateとして作成し、RunPodへregistry認証を設定してから使う。

GHCRはGitHub Container Registryのこと。GitHub repositoryとimageの権限を合わせたい場合に向く。Docker Hub、GHCRのどちらでもprivate imageにはRunPod側のregistry auth設定が必要である。手順が増えることを理由にpublicへ切り替えず、public配布は [公開前チェックリスト](PUBLICATION_CHECKLIST.md) の権利・プライバシー・外部設定を完了した場合だけ明示的に選ぶ。

Docker HubではRunPod専用のread-only Personal Access Tokenを作る。通常のpush用tokenやアカウントパスワードをRunPodへ渡さない。既定手順はRunPod ConsoleのRegistry Credentialsから登録し、返されたIDだけをgit管理外の `.runpod.env` へ保存する。REST APIを使う場合もtokenをcommand line引数やshell履歴へ残さず、保護された秘密値入力から `POST /v1/containerregistryauth` のrequest bodyへ渡す。

```bash
# credential登録後、secretではないIDだけを保存する
RUNPOD_IMAGE_VISIBILITY=private
RUNPOD_REGISTRY_AUTH_ID=<RunPod registry credential ID>
```

Serverless templateのcreate/updateは `scripts/runpod_template_api.py` を通じてRunPod REST APIを使い、`containerRegistryAuthId` を明示する。`runpodctl template create/update` にはこのIDを渡すoptionがないため使用しない。private imageなのに `RUNPOD_REGISTRY_AUTH_ID` が空の場合、deploy、create、updateの各スクリプトは外部変更前に安全停止する。Docker Hub tokenはRunPod側credentialだけに保存し、`.runpod.env`、GitHub Secrets、template envへ複製しない。

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

workflowには既定の `image_name` を持たせない。実行時に既存のDocker Hub repositoryと `expected_visibility` を毎回指定し、Docker Hub APIが返す実際の可視性と一致しなければlogin・build・push前に停止する。既定の期待値は `private` であり、public repositoryへpushするには `public` を明示選択する。

GitHub Actionsの手動実行では、`workflow_dispatch` を持つworkflowファイルがdefault branchに存在している必要がある。新規workflowをfeature branchで追加した直後は、そのbranchをpushするだけではActions画面や `gh workflow run` から見つからない場合がある。初回はworkflowファイルをmainへ入れてから、必要に応じて `--ref <branch>` で対象branchのコードをbuildする。

RunPod用base imageはCUDA/PyTorchを含むため大きい。GitHub-hosted runnerではbase image展開中に容量不足になることがある。そのためworkflowはbuild前に不要なプリインストールを削除してからDocker buildを開始する。削除対象はAndroid、.NET、hosted tool cache、runner側CUDAなどである。

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

### deploy系スクリプトの使い分け

push後にRunPod Serverlessへ反映する通常手順では、まず `scripts/runpod_deploy_serverless_image.sh` を使う。これは次の作業をまとめて行う。まとめて行うことで、固定tag再利用や古いworkerを踏むリスクを減らせる。

- Actions build
- image push
- 新template作成
- endpoint切替
- `.runpod.env` 更新
- diagnostics確認

| スクリプト | 使う場面 | 主な処理 |
| --- | --- | --- |
| `scripts/runpod_deploy_serverless_image.sh` | 通常のdeploy。push済みの現在HEADをRunPod Serverlessへ反映したい時 | GitHub Actionsでimageをbuild/pushし、registry credential付きの新しいServerless templateを作り、endpointの `templateId` を切り替え、`.runpod.env` を更新し、diagnostics smokeを実行する |
| `scripts/runpod_update_serverless_template.sh` | imageは既にbuild/push済みで、既存templateのimage/envだけを更新したい時 | `.runpod.env` のtemplate/image/registry credentialを使い、RunPod REST APIで既存templateを更新する。endpoint切替やworker入れ替えは行わない |
| `scripts/runpod_create_serverless_template.sh` | 手動で新templateだけ作りたい時 | `.runpod.env` のimageとregistry credentialからRunPod REST APIで新しいServerless templateを作る。返ったtemplate IDの保存とendpoint切替は手動で行う |
| `scripts/runpod_build_push.sh` | ローカルDockerで直接build/pushしたい時 | `Dockerfile.runpod` をローカルでbuildx buildしてregistryへpushする。Actions運用では通常使わない |
| `scripts/runpod_smoke_serverless.py` | deploy後の確認、または生成問題の切り分け | RunPod Serverless handlerへdiagnostics、翻訳、中国語練習ASR、Seed-VCなどのjobを直接投げる |

判断に迷う場合は、`RUNPOD_DRY_RUN=1 scripts/runpod_deploy_serverless_image.sh` で実行予定のtag、template名、workflow起動内容を確認してからdry-runなしで実行する。

通常は、以下のdeployスクリプトを使う。このスクリプトは現在のGit HEADから一意なimage tagを決め、GitHub Actionsでimageをbuild/pushする。続けて `.runpod.env` の `RUNPOD_REGISTRY_AUTH_ID` を引き継いだ新しいServerless templateをRunPod REST APIで作成し、endpointの `templateId` を切り替える。さらに `.runpod.env` の `RUNPOD_IMAGE` / `RUNPOD_SERVERLESS_TEMPLATE_NAME` / `RUNPOD_SERVERLESS_TEMPLATE_ID` を更新し、最後にdiagnostics jobでworker内のimage revisionを確認する。

```bash
scripts/runpod_deploy_serverless_image.sh
```

既定のimage tagは `runpod-app-<short-sha>`、template名は `mo-speech-serverless-<short-sha>` とする。これにより、固定tag再利用によるRunPod image cacheや既存workerの取り違えを避ける。

同じcommitでdeployを再実行した場合、template名も同じになる。前回実行でtemplate作成後に失敗した場合でも、deployスクリプトは同名の自分のtemplateを検索する。失敗要因の例はendpoint更新、worker起動、diagnostics、残高不足などである。検索後はRunPod REST APIのtemplate PATCHでimage、env、registry credentialを更新して再利用する。RunPod側の `Template name must be unique` が出た場合は、まず最新のdeployスクリプトで同じcommitのまま再実行する。

スクリプトは、現在のHEADがupstreamへpush済みであることを確認する。push前のローカルcommitを指定してActionsを起動してもGitHub側ではそのcommitをcheckoutできないため、通常は先にpushする。確認だけしたい場合はdry-runを使う。

```bash
RUNPOD_DRY_RUN=1 scripts/runpod_deploy_serverless_image.sh
```

個別に手順を実行する場合:

```bash
gh workflow run runpod-image.yml \
  --ref main \
  -f image_name=docker.io/<user>/<private-repository> \
  -f expected_visibility=private \
  -f image_tag=runpod-app-$(git rev-parse --short HEAD)
```

Actions実行が成功したら、出力されたimage tagを `.runpod.env` の `RUNPOD_IMAGE` に反映し、Serverless templateを更新する。Docker HubへのpushはGitHub側で完了しているため、ローカルではRunPod APIへの小さいリクエストだけで済む。deployスクリプトを使う場合、この `.runpod.env` 更新も自動で行う。

`image_tag` はcommitごとに一意にする。固定タグを再利用すると、registry上のdigestが更新されてもRunPod側の既存workerやimage cacheが古いコードを実行し続けるかを切り分けにくい。`image_tag` を空にした場合、workflowは `runpod-<short-sha>` を使う。

Actions経由でpush済みなら、ローカルで `scripts/runpod_build_push.sh` は実行しない。既存Serverless templateはRunPod管理画面またはRunPod APIでimageだけ差し替えられるが、確実な検証では新しいtemplateを作り、endpointの `templateId` 自体を切り替える。deployスクリプトはこの新template方式を既定とする。手動で行う場合は、`.runpod.env` の `RUNPOD_IMAGE` をActionsでpushしたtagにしてからtemplate作成スクリプトを実行する。

```bash
# .runpod.env
RUNPOD_IMAGE=docker.io/<user>/<private-repository>:runpod-app-<short-sha>
RUNPOD_IMAGE_VISIBILITY=private
RUNPOD_REGISTRY_AUTH_ID=<RunPod registry credential ID>
```

既存templateへ反映する場合:

```bash
scripts/runpod_update_serverless_template.sh
```

このスクリプトは `.runpod.env` を読み、`RUNPOD_SERVERLESS_TEMPLATE_ID` のimage、環境変数、`containerRegistryAuthId` をRunPod REST APIで更新する。Serverless endpointが同じtemplate IDを参照している場合、新しく起動するworkerは更新後のcredentialでprivate imageをpullする。既に起動済みのworkerは古いimageのまま残ることがあるため、確実に新imageで確認したい場合は既存workerを落とすか、idle timeout後に再実行する。

新しいtemplateとして切り替える場合:

```bash
scripts/runpod_create_serverless_template.sh
```

返ってきたtemplate IDを `.runpod.env` の `RUNPOD_SERVERLESS_TEMPLATE_ID` に反映し、RunPod管理画面またはREST APIでendpointの `templateId` をそのIDへ更新する。既存workerが残る場合は、一時的に `workersMax=0` へ下げてから `workersMax=1` へ戻すと、旧workerを避けて新templateから起動し直せる。

image更新後は、生成jobを投げる前に軽量なdiagnostics jobでworker内の実行コードを確認する。`runpod-image.yml` はbuild時のGit commit SHAをimage環境変数 `MO_IMAGE_REVISION` に埋め込み、diagnosticsはその値を返す。`image.revision` がbuild対象commitに一致することを先に確認する。

```bash
python scripts/runpod_smoke_serverless.py \
  --operation-mode diagnostics \
  --request-mode async
```

diagnosticsが未対応、または古いrevisionを返す場合、RunPod endpointは古いimageまたは古いworkerを使っている。Serverless templateのimage更新、endpointのworker入れ替え、またはidle timeout後の再実行を先に行い、生成jobの成否判断に進まない。

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

RunPod imageには中国語練習ASRとSeed-VCに必要な依存を入れる。モデル本体はNetwork Volumeへ置く。

| 処理 | 既定モデル | RunPod環境変数 |
| --- | --- | --- |
| 中国語ASR | `funasr/paraformer-zh` | `FUNASR_MODEL`、`FUNASR_DEVICE=cuda` |
| forced alignment | `funasr/fa-zh` | `FUNASR_FA_MODEL` |
| VAD・句読点 | `funasr/fsmn-vad`・`funasr/ct-punc` | `FUNASR_VAD_MODEL`・`FUNASR_PUNC_MODEL` |
| 声質変換 | Seed-VC | `SEED_VC_EXECUTION_MODE=resident`、`SEED_VC_FP16=true`、`SEED_VC_DIFFUSION_STEPS=8`、`SEED_VC_REFERENCE_MAX_SECONDS=12` |

FunASRとSeed-VCは同じworker processへ同時常駐させない。operation切替時に使わない側を解放し、VRAM使用量を抑える。必要GPUは実測で決める。

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

CLIでは公開URLの `/health` を確認する。音声処理はServerless化後にoperation別smokeを使う。

```sh
curl --fail --show-error "https://<pod-id>-8000.proxy.runpod.net/health"
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

最初にdiagnosticsでimage revisionと依存関係を確認する。

```sh
RUNPOD_ENDPOINT_ID=<endpoint-id> \
RUNPOD_API_KEY=<api-key> \
python scripts/runpod_smoke_serverless.py \
  --operation-mode diagnostics
```

`scripts/runpod_smoke_serverless.py` は既定でレスポンス中の `audio_base64` を長さ表示に置き換える。音声base64全体を確認したい場合だけ `--print-audio-base64` を付ける。async pollingでは `--http-timeout` で1回ごとのHTTP timeoutを指定できる。

workerを明示的にwarmupする場合:

```sh
RUNPOD_ENDPOINT_ID=<endpoint-id> \
RUNPOD_API_KEY=<api-key> \
python scripts/runpod_smoke_serverless.py \
  --operation-mode warmup \
  --preload-voice-conversion
```

中国語発音練習ASRだけを直接確認する場合:

```sh
RUNPOD_ENDPOINT_ID=<endpoint-id> \
RUNPOD_API_KEY=<api-key> \
python scripts/runpod_smoke_serverless.py \
  --operation-mode practice_asr \
  --audio /path/to/chinese-attempt.webm \
  --model-audio /path/to/chinese-model.wav \
  --target-text '你好吗？你今天去哪里？' \
  --request-mode async
```

`--model-audio` と `--target-text` を省略すると復唱音声単体のFunASR確認になる。この場合は `align_timestamps=false` を送り、`fa-zh` を読み込まない。SpeakLoopの比較経路では `align_timestamps=true` を送る。両音声を指定したsmokeは `practice_asr_contract_version=3` と `model_transcription` も検査する。旧imageまたは不完全なhandler応答では終了コード1にする。

保存済みSpeakLoop音声で整列とVADの整合性を回帰確認する場合は `scripts/evaluate_fa_zh_alignment.py` を使う。このスクリプトは従来timestampと `fa-zh` + VADスナップ後について、同じ発話島との距離を記録する。VADスナップ後の値はVAD境界を使うため、手動正解境界に対する精度や製品上の改善を示さない。境界品質の採否には、別に固定した手動正解境界または聴取評価を使う。既定では結果をgit管理外の `tmp/fa-zh-alignment-results.json` へ保存する。

```sh
python scripts/evaluate_fa_zh_alignment.py \
  --recordings-dir tmp/audio-history/recordings \
  --outputs-dir tmp/audio-history/outputs \
  --device cpu
```

FunASRをwarmupする場合は `--operation-mode warmup --preload-practice-asr` を使う。Seed-VCとFunASRを同じwarmup requestで同時に先読みする指定は受け付けない。

ローカルFastAPIからServerless backendを使う場合は、FastAPI側にもRunPod接続設定を渡す。シェルで渡してもよいし、git管理外の `.runpod.env` に `RUNPOD_ENDPOINT_ID` と `RUNPOD_API_KEY` を入れてもよい。ローカルFastAPI自体のprovider設定を変える場合は、`.env` またはシェルで明示する。

```sh
uvicorn mo_speech.api:app --host 0.0.0.0 --port 8000
```

RunPod実行先を選んだときに `RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY are required for RunPod Serverless backend.` が出る場合は、起動中のFastAPIプロセスが `RUNPOD_ENDPOINT_ID` と `RUNPOD_API_KEY` を読めていない。`.runpod.env` を直した後は、Uvicornプロセスを再起動してから確認する。

この構成ではFastAPIがUIとローカル履歴を担当する。RunPodへ送る処理は中国語練習ASRとVCである。SpeakLoopのお手本ASR・翻訳・通常TTSはOpenAI providerを使う。

テキスト読み上げだけを測る場合は `operation_mode=text_tts` を使う。利用できるTTS backendはOpenAI TTSだけである。`--tts-backend openai` を指定し、endpoint側に `OPENAI_API_KEY` を渡す。

```sh
RUNPOD_ENDPOINT_ID=<endpoint-id> \
RUNPOD_API_KEY=<api-key> \
python scripts/runpod_smoke_serverless.py \
  --operation-mode text_tts \
  --text "こんにちは" \
  --target-language ja-JP \
  --tts-backend openai
```

VC単体を測る場合は `operation_mode=voice_conversion` を使う。

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

Serverlessでは、完全にscale-to-zeroすると初回リクエストでworker起動とモデルロードが入る。デモ用途では `RUNPOD_FLASH_BOOT=1` でFlashBootを有効にし、container cold startを短縮する。FlashBootはworker/containerの起動遅延を減らすための設定であり、Seed-VC serviceの初回ロード、Network Volumeからのモデル読み込み、実際のVC推論時間まで必ず消えるわけではない。レスポンスが遅い場合は、RunPod側のcold startだけでなく他の要因も分けて見る。他の要因とは `serverless_timings_ms.voice_conversion_service_load`、`timings_ms.voice_conversion`、queue/poll往復である。

FlashBoot状態はRunPod REST APIのendpoint詳細で `flashboot=true` を確認する。`runpodctl serverless create --help` ではFlashBootが既定有効になっているが、既存endpointの確認や更新はCLIのversion差分を受ける場合がある。既存endpointが `flashboot=false` の場合は、REST APIの `POST /v1/endpoints/{endpoint_id}/update` に `{"flashboot": true}` を送るか、FlashBoot有効のendpointを作り直す。

VC単体の検証では `MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START=1` と `SEED_VC_EXECUTION_MODE=resident` を使い、handler起動時にVC serviceとSeed-VCモデルをworker process内へロードできる。中国語練習用FunASRも同じworker processへ遅延ロードするが、Seed-VCを使う操作へ切り替える際はFunASRを解放し、逆にFunASRを使う前は常駐Seed-VCを解放する。つまりDocker imageとendpointは共通でも、大きいGPUモデルをすべて同時常駐させる構成ではない。30GBのNetwork VolumeでSeed-VC最小構成を試す場合は、通常pipelineの起動時preloadを避けるため `MO_PRELOAD_MODELS=0`、VC backendを絞るため `MO_VC_BACKENDS=seed-vc` にする。`RUNPOD_WORKERS_MIN=0` のままでも、デモ直前に管理者用画面 `/admin` の手動準備ボタンからwarmup requestを投げ、`RUNPOD_IDLE_TIMEOUT_SECONDS=300` の範囲内で利用すれば、待機課金を常時発生させずにwarm workerを使いやすい。CloudflareのページHTML配信だけではRunPod jobは起きず、管理者用画面の手動操作、または録音送信後の実変換でRunPod jobが作られる。

`RUNPOD_WORKERS_MAX` を増やすと、同時アクセス時にRunPodが追加workerを起動できる。ただし `RUNPOD_WORKERS_MIN=0` のデモ運用では、追加workerは基本的にcold状態から起動し、各worker内でSeed-VC preloadが必要になる。1つ目のwarm workerだけで処理できる程度の同時数なら `workers-max=1` の方が予測しやすい。複数人が同時にVCを使うデモでは `workers-max=2` を試せるが、2人目以降の初回VCはcold start分だけ遅くなる可能性を測定して判断する。

スマホから見るデモでは、ローカルMacのFastAPIをUI/gatewayにしない。Cloudflare gatewayを置く前の暫定運用では、同じRunPod imageをGPU Podとして起動し、`CMD` のFastAPI/Uvicornを `8000/http` で公開する。VC専用デモで `MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START=1` の場合、Webサーバー起動時にVC preloadが完了してから画面を返せるため、cold start後に `/` が表示されたことを「Webプロセスと常駐VC providerの初期化が完了した」シグナルとして扱える。

## 完了条件

RunPod構成の確認条件は以下。

1. `runpodctl` からPodまたはServerless endpointを作成できる。
2. Network Volumeのmount先とcache環境変数が一致し、モデルcacheがNetwork Volume上に作られる。
3. `/health` と `/api/runtime` が成功する。
4. diagnosticsが現在のimage revisionと依存情報を返す。
5. `practice_asr` がcontract version 3の中国語結果を返す。
6. `text_tts` と `voice_conversion` がoperation別の結果を返す。
7. `timings_ms` とRunPod側metricsでcold startとwarm実行を分けて記録できる。
