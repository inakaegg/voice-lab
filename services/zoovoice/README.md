# Zoovoice 音声合成サービス

更新日: 2026-08-09

Zoovoice は録音した発話の内容から動物を1種だけ自動で選び、その鳴き声を発話の無音区間へ重ねるデモです。
このディレクトリには Go 製の API を置いています。鳴き声素材はリポジトリに置かず、実行時とimage build時に外から渡します。
1リクエストの流れは、日本語ASR、動物の自動連想、音声合成の順です。
公開のUI・API入り口はCloudflare Workerであり、Workerが有効化した配備ではこのGoサービスをprivateなGoogle Cloud Run上のコンテナとして呼び出します。
Cloud Run配備の契約は[Cloud Run配備](#cloud-run配備)を、公開側の全体構成は[ARCHITECTURE.md](../../docs/deployment/ARCHITECTURE.md)を参照してください。

## 必要なソフトウェア

- Go 1.25 以上（`go.mod` のtoolchainは1.26.1）
- ffmpeg と ffprobe
- whisper.cpp の `whisper-cli` と日本語ASR用の `ggml-small.bin`
- 連想に使うOpenAI APIのキー（`OPENAI_API_KEY`）
- リポジトリ全体のローカル確認にはNode.jsとWrangler、および`gcloud`(private Cloud Run smoke時)

`whisper-cli` とASRモデルはリポジトリで管理しません。
どちらもリポジトリ外へ置き、環境変数でpathを渡します。
保存方針は [MODEL_STORAGE.md](../../docs/deployment/MODEL_STORAGE.md) を参照してください。

## 起動方法

通常のローカル確認は、リポジトリ直下で次を実行します。

```sh
npm run dev:zoovoice
```

このコマンドはWrangler local、local D1、このGoサービスを起動し、FastAPIは使いません。
`http://127.0.0.1:8787/zoovoice` を開くとCloudflare Worker local経由で確認できます。
Playwrightによるローカルe2e確認も同じWrangler localを起動します。

local起動では`ZOOVOICE_WHISPER_COMMAND`、`ZOOVOICE_ASR_MODEL_PATH`、`ZOOVOICE_SOUNDS_DIR`、`OPENAI_API_KEY`の4つが必須です。
起動scriptはWranglerとGoサービスを立ち上げる前にこの4つを検査し、1つでも未設定または不在なら停止します。
検査を通ったpathは絶対pathへ正規化してからGoサービスへ渡すため、相対pathで指定しても作業ディレクトリの違いで壊れません。
Goサービス自身も起動時に同じ4つを確認します。

```sh
export ZOOVOICE_WHISPER_COMMAND=<repo-outside>/whisper.cpp/build/bin/whisper-cli
export ZOOVOICE_ASR_MODEL_PATH=<repo-outside>/models/ggml-small.bin
export ZOOVOICE_SOUNDS_DIR=<repo-outside>/animal-sounds
export OPENAI_API_KEY=<OpenAIのAPIキー>
```

このディレクトリのGoサービス単体だけを確認する場合は、`services/zoovoice`へ移動して起動します。

```sh
go run .
```

起動時に `ZOOVOICE_SOUNDS_DIR` の `manifest.json` を読み込み、音源のある動物をすべて公開します。
manifestが持つ音声のSHA-256と実ファイルが一致しない場合は起動しません。
鳴き声のクレジット（ライセンス・作者・出典URL）も起動時にmanifestから読み込み、合成応答に含めます。

## 機能確認CLI

サーバを立てずに、入力テキストまたは入力音声1件で連想から合成までを確認できます。
機能追加のたびに、製品へ組み込む前の動作確認へ使う想定です。

```sh
go run . preview -text "夜中に犬が吠えていた"
go run . preview -audio recording.wav -out composed.wav
```

表示する内容は次のとおりです。

- 文字起こしの結果（音声入力のとき）
- 連想した動物と、LLMが返した「連想の理由」の短文
- 採用した鳴き声ファイルのパスと、その素材のクレジット（ライセンス・作者・出典URL）
- 合成音声の出力先パス（音声入力のとき。afplay等で再生して確認できます）

`-text` はASRを使わないため、`OPENAI_API_KEY` だけで動きます。
`-audio` はwhisperの2変数（`ZOOVOICE_WHISPER_COMMAND`・`ZOOVOICE_ASR_MODEL_PATH`）も必要です。
アニマル度は `-intensity 0〜100`（既定50）、処理ログは `-verbose` で標準エラーへ出せます。

### 最終選別セット（tmp1/final）での確認

最終選別した鳴き声セット（`tmp1/final`、Git管理外）で動かす場合は、`ZOOVOICE_SOUNDS_DIR` にそのディレクトリを渡します。
サーバとCLIのどちらでも有効です。

```sh
ZOOVOICE_SOUNDS_DIR=<repo>/tmp1/final go run . preview -text "..."
```

このディレクトリは `manifest.json` を持ち、1動物に複数の鳴き声ファイルと、ファイル単位のクレジット・SHA-256を記録しています。
小森平（taira-komori）由来の素材は素材そのものの再配布が禁止のため、このセットをリポジトリへコピーしてはいけません（詳細はリポジトリ直下の THIRD_PARTY_NOTICES.md）。

private Cloud Runとの接続を確認する場合は、`ZOOVOICE_CLOUD_RUN_URL`・`ZOOVOICE_GCP_PROJECT`・`ZOOVOICE_SMOKE_SERVICE_ACCOUNT`を設定し次を実行します。

```sh
npm run dev:zoovoice:cloud-run
```

この経路はgcloud service account impersonationでaudience付きの短期ID tokenを取得し、一時env file経由でlocal Wranglerへ渡します。
取得するID tokenはproduction credentialではなく、smoke専用service accountの権限だけに限定されます。

## 環境変数

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `ZOOVOICE_PORT` | `8090` | Go API の待受ポート。設定時はこちらを優先する |
| `PORT` | `8090` | `ZOOVOICE_PORT` 未設定時のfallback。Cloud Runが自動注入する |
| `ZOOVOICE_SOUNDS_DIR` | なし（必須） | `manifest.json` 付き鳴き声ディレクトリ。音源とクレジットをここから読む |
| `ZOOVOICE_WHISPER_COMMAND` | なし（必須） | whisper.cpp の `whisper-cli` の実行ファイル |
| `ZOOVOICE_ASR_MODEL_PATH` | なし（必須） | 日本語ASRに使う `ggml-small.bin` |
| `OPENAI_API_KEY` | なし（必須） | 連想に使うOpenAI APIのキー |
| `ZOOVOICE_LLM_MODEL` | `gpt-5.6-luna` | 連想に使うモデル |
| `ZOOVOICE_LLM_ENDPOINT` | `https://api.openai.com/v1/responses` | 連想APIのエンドポイント |
| `ZOOVOICE_LLM_TIMEOUT_SECONDS` | `20` | 連想API1回の上限秒数 |
| `ZOOVOICE_ASR_THREADS` | `2` | whisper.cpp へ渡すスレッド数 |
| `ZOOVOICE_TIMEOUT_SECONDS` | `85` | ASRとffmpegを含む1リクエストの上限秒数 |
| `ZOOVOICE_LOG_PATH` | リポジトリ直下の `logs/zoovoice.log` | JST時刻と経過時間を含むサービスログ |

必須の3つは起動時に検査します。
ファイルが無い場合やAPIキーが未設定の場合は起動に失敗します。

## API

Go API はprivateな内部APIです。
ブラウザは同じ契約をCloudflare Workerの `/api/zoovoice/*` 経由で利用します。

### `GET /healthz`

プロセスの生存確認です。

```json
{"status":"ok"}
```

### `GET /animals`

現在使える種とバリアント数を返します。
素材ファイル名や素材単体の音声は返しません。

```json
{
  "animals": [
    {"id": "cat", "label_ja": "猫", "variants": 1}
  ]
}
```

### `POST /compose`

`multipart/form-data` で次の2フィールドを送ります。

- `audio`: 録音ファイル。上限は10MBかつ60秒です。
- `settings`: `intensity` だけを持つ JSON 文字列です。

`intensity` はアニマル度を表す0から100までの整数です。
この値は鳴き声の挿入頻度だけを決めます。
動物の指定、挿入位置の指定、未知のキーは受け付けません。

```sh
curl -X POST http://127.0.0.1:8090/compose \
  -F 'audio=@<recording.webm>' \
  -F 'settings={"intensity":50}'
```

成功時は合成済み WAV を base64 で返します。
発話部分が合計0.5秒未満の場合は `422` の `speech_too_short` で拒否します。
ASRが発話を1つも認識できなかった場合は `422` の `asr_empty` を返します。

```json
{
  "audio": {"format": "wav", "base64": "..."},
  "meta": {
    "transcript": "夜中に鶏が鳴いていた",
    "selected_animal": {"id": "rooster", "label_ja": "雄鶏"},
    "association_reason": "夜中に鳴く鳥といえば鶏",
    "insertions": [
      {"slot": "opening", "species": "rooster", "at_seconds": 0}
    ],
    "sound_credits": [
      {"license": "CC0 1.0", "creator": "someone", "source_url": "https://example.com/1"}
    ],
    "input_duration_seconds": 3.2,
    "output_duration_seconds": 4.6
  }
}
```

`meta` の各項目の意味は次のとおりです。

| 項目 | 内容 |
| --- | --- |
| `transcript` | 日本語ASRの認識本文 |
| `selected_animal` | 自動で選んだ動物の種IDと日本語ラベル |
| `association_reason` | その動物を選んだ理由としてLLMが返した日本語の短文 |
| `insertions` | 挿入した鳴き声の位置。`species` は全件同じ動物 |
| `sound_credits` | 使った鳴き声素材のクレジット（ライセンス・作者・出典URL）。重複は除く。素材ファイル名は含まない |

`insertions` の `slot` は `opening`・`gaps`・`ending` のいずれかです。
1回の合成で使う動物は1種だけなので、`species` はすべて `selected_animal.id` と一致します。

エラーは `{"error":{"code":"...","message":"..."}}` の形です。
動物音単体を取得または試聴する API はありません。

## 動物の自動連想

連想はASR本文だけを入力にします。
利用者が動物を選ぶ経路はUIにもAPIにもありません。

1. ASR本文と、音源のある動物の一覧（種IDと日本語ラベル）をLLMへ渡す。
2. LLMは「どんなこじつけでもよいので候補から必ず1種選ぶ」指示に従い、種IDと理由の短文を返す。
3. 候補一覧に無い種IDが返った場合はエラーにする。別の動物へ黙って読み替えない。

辞書・語彙表・意味ベクトルによる連想経路と、当てずっぽうのrandom選択は持ちません。
辞書方式との比較実測と、この方針に至った経緯は [ZOOVOICE_ASSOCIATION_CASE_STUDY.md](../../docs/speech-translation/ZOOVOICE_ASSOCIATION_CASE_STUDY.md) にあります。

選ばれる対象は、音源を持ち `/animals` に載る動物だけです。
発話内容は連想のためOpenAIのAPIへ渡ります。

ASR本文と連想の理由は応答とプロセスのメモリ内だけで扱います。
サービスログ、D1、その他の永続層へは書きません。

合成requestの処理でサービスログへ記録するのは、次の項目です。

- 処理段階と状態、失敗時のエラーコード
- 各段階の経過時間
- HTTPのmethodとpath、応答status
- 選んだ種ID
- 入力と出力のbyte数、アニマル度の値
- 入力音声と出力音声の長さ、発話の合計時間
- 無音判定の最小秒数、無音区間数、挿入数

このほか、プロセスの起動時には待受port、利用可能な動物数、timeoutの設定秒数を記録します。
起動に失敗した理由も記録します。

いずれの項目も音声や本文の内容そのものを含みません。
録音と生成音声の内容、ASR本文、連想の理由はサービスログへ書きません。

## 鳴き声素材

鳴き声素材はリポジトリに置きません。実行時は `ZOOVOICE_SOUNDS_DIR`、image build時は
`zoovoice_sounds` context で外から渡します。対象動物の正本は素材そのものであり、
一覧は [CONCEPTS/ZOOVOICE/ANIMALS.md](../../CONCEPTS/ZOOVOICE/ANIMALS.md) に写してあります
（`python3 scripts/generate_animals_doc.py <sounds-dir>` で作り直します）。

素材の形式は 24kHz、mono、signed 16-bit PCM WAV です。
1種に複数本あってよく、出所（ライセンス・作者・配布ページ）と採用時のSHA-256は
セットの `manifest.json` に1本ずつ記録します。サービスは起動時にSHA-256を照合し、
1件でも合わなければ起動しません。合成応答にはその回に使った素材のクレジットを含めます。

Stable Audioで生成した素材を含む場合の必須表示は
[NOTICE-STABILITY-AI.md](NOTICE-STABILITY-AI.md) を正とし、公開UIはfooterへ
`Powered by Stability AI` を表示します。

## 素材の準備

`tools/prepare_assets.sh` は集めた素材を実行時の形式へ規格化します。
`tools/import_stable_audio.py` は Stable Audio の生成候補から1種1本を採用して規格化し、
manifestを書き出します（モデルの実行そのものは行いません）。出力先はリポジトリ外を指定します。

```sh
python3 tools/import_stable_audio.py <stable-audio-output-dir> <repo-outside>/animal-sounds
```

どちらも取得条件を伴う素材準備用なので CI では実行しません。

## Docker image

imageは`services/zoovoice/Dockerfile`で作ります。
モデルと鳴き声素材はリポジトリへcommitしないため、buildはgit外の成果物を named context として受け取ります。

- `whisper_source`: 検証済みのwhisper.cppソース。commitは`5250a86fdebac4d51085fcfcd0b315cb0c6b91c9`に固定する
- `zoovoice_runtime`: `ggml-small.bin`と`NOTICE-STABILITY-AI.md`を置いた一時ディレクトリ
- `zoovoice_sounds`: `manifest.json`付きの鳴き声セット（`ZOOVOICE_SOUNDS_DIR`の中身をそのまま渡す）

buildは`ggml-small.bin`のSHA-256をimage内で照合します。
固定値は`1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`です。
whisper.cpp commit、ASRモデルのSHA-256、ライセンス識別子はimage labelにも残します。
連想に使うAPIキーはimageへ焼き込まず、実行時に`OPENAI_API_KEY`で渡します。

最終imageに入るのは次だけです。

- Goバイナリと`whisper-cli`
- `ggml-small.bin`
- whisper.cppとStability AIのライセンス表示
- Debian runtime、CA証明書、ffmpeg
- `zoovoice_sounds`から取り込んだ鳴き声セット（`/app/sounds`）

secretと開発用ファイルは含めません。
実行ユーザーはuid 10001のnon-rootで、待受portは8080です。

## Cloud Run配備

Cloud Runへの配備は`./scripts/deploy_zoovoice_cloud_run.sh`を使います。
実行前に次の5つを環境変数で渡します。

| 変数 | 内容 |
| --- | --- |
| `ZOOVOICE_WHISPER_SOURCE_DIR` | 検証済みwhisper.cppのソースディレクトリ |
| `ZOOVOICE_ASR_MODEL_PATH` | `ggml-small.bin` |
| `ZOOVOICE_SOUNDS_DIR` | imageへ入れる鳴き声セット（`manifest.json`付き） |
| `ZOOVOICE_SMOKE_AUDIO_PATH` | local smokeへ送る短い音声 |
| `OPENAI_API_KEY` | local smokeとCloud Runが使う連想APIのキー |

scriptはwhisper.cpp commitとASRモデルのSHA-256を先に検査します。
一致しない場合は、buildへ進まず停止します。
applyでは`OPENAI_API_KEY`をSecret Manager経由でCloud Runへ渡します。secret名は`ZOOVOICE_OPENAI_SECRET_NAME`（既定`zoovoice-openai-api-key`）で変えられます。

whisper.cppソースは、固定commitに加えて作業ツリーがcleanであることも必須です。
未commitの変更やuntracked fileが1つでもあれば、buildへ進まず停止します。

実行modeは3つで、`ZOOVOICE_GCP_PROJECT`は全modeで必須です。

| mode | 設定 | 実行内容 |
| --- | --- | --- |
| dry-run | 既定 | 実行予定の操作を表示するだけ。build、local起動、remote writeを行わない |
| local-only verification | `ZOOVOICE_LOCAL_VERIFY=1` | imageのbuild、local起動、`/healthz`と`/compose`の確認まで。remote writeを行わない |
| apply | `ZOOVOICE_DEPLOY_APPLY=1` | 上記に続けてimage push、Cloud Run deploy、IAM設定を実行する |

`ZOOVOICE_DEPLOY_APPLY=1`と`ZOOVOICE_LOCAL_VERIFY=1`は同時に指定できません。
applyはcleanなworking treeを必要とします。

Cloud Runの配備契約は次のとおりです。
CPUとメモリはlocal-only verificationで同じ上限を課して起動を確認しています。
この契約で、us-central1のprivate Cloud Run serviceへdeploy済みです。

- region: `us-central1`
- private（`--no-allow-unauthenticated`、`allUsers`と`allAuthenticatedUsers`は不可）
- CPU 2、メモリ2GiB
- port 8080、timeout 90秒、concurrency 1
- min 0、max 2
- imageはlocalでbuildし、privateなArtifact Registryの `us-central1-docker.pkg.dev/<project>/voice-lab/zoovoice:<git-sha>` へpushする
- imageはtagではなくdigestを固定して指定する

Cloud RunへGit repositoryを接続する自動buildは使いません。
container imageのbuildとpushはローカルの配備scriptだけが行います。

invoker権限はservice単位の`roles/run.invoker`だけを付与し、`allUsers`へは付与しません。
付与先はCloudflare Worker用のinvoker service accountと、smoke専用のservice accountの2つです。
active developerのgcloudアカウントは、smoke専用service account上の`roles/iam.serviceAccountTokenCreator`だけを持ち、Cloud Run自体のinvoker権限は持ちません。

### local-only verificationの実測

`ZOOVOICE_LOCAL_VERIFY=1`で、linux/amd64のCloud Run相当imageをlocal buildし、CPU 2とメモリ2GiBの上限付きでnon-root起動しました。
測定値は次のとおりです。

| 項目 | 実測値 |
| --- | --- |
| image size | 1,053,233,511 bytes（約1.05 GB） |
| compose完了後の観測メモリ | 359.4 MiB / 2 GiB |
| `/healthz` がreadyになるまで | 1,350 ms |
| 2.044秒の日本語fixtureの`/compose` | 23,826 ms |

同じ確認で、ASRモデルがnon-rootの実行ユーザーから読めることも確認しました。

`whisper-cli`はDockerfileの`-DBUILD_SHARED_LIBS=OFF`により、whisper/ggmlのlibraryをstaticに組み込んでbuildしています。
この確認では、`whisper-cli`がwhisper/ggmlを共有libraryとして要求しないことを確かめました。
libstdc++・libm・libgcc_s・libc・動的loaderへは動的にlinkするため、完全なstatic binaryではありません。

この測定はApple Silicon上のlinux/amd64 emulationで行っています。
compose時間はemulationの影響を受けるため、Cloud Runの実CPU上の値とは一致しません。
上の表の値はすべてこのlocal環境の実測であり、Cloud Run実機では未確認です。

上の表は連想をLLMへ移す前、ConceptNet indexを同梱していた頃のimageの実測です。
現在のimageでは再測定していません。

### 外部操作の状況

production Cloudflare WorkerがCloud Runを呼ぶ認証は、専用invoker service accountのkeyによるID token取得方式です。
方式の決定とWorker側の実装、契約testは完了しています。
認証フローとsecret運用の詳細は[CLOUDFLARE.md](../../docs/deployment/CLOUDFLARE.md)を参照してください。

次のremote操作は完了しています。

- privateなArtifact Registryへのimage push
- GCP projectでのCloud Run resource作成とdeploy実行
- production用invoker service accountの作成とservice単位の `roles/run.invoker` 付与
- invoker service account keyの発行とWorker secret登録
- 本番D1へのZoovoice counter migration適用
- 有効化varsを含むproduction Workerのdeploy

実環境smokeで確認済みなのは次の範囲です。

- 公開 `GET /api/zoovoice/config` と `GET /api/zoovoice/animals` の200応答
- 公開 `/zoovoice` とZoovoice用JS assetの200配信
- 実ブラウザでのUI表示とproduction Turnstile widgetの表示
- 認証付きrequestでのprivate Cloud Runの `/animals` と実音声の `POST /compose` の200応答
- 認証なしのCloud Run直接requestが403で拒否されること

Cloud Runの `/healthz` は認証付きrequestでもGoogle側で404になるため、remote smokeの確認先には使いません。
local containerでは同じpathが200を返します。

Worker経由の実 `POST /api/zoovoice/compose` は未確認です。
この確認にはproduction Turnstileの人間操作が必要であり、CAPTCHAは回避しません。
この1件を終えるまで、公開経路全体を実地確認済みとしては扱いません。

## 検証

```sh
go vet ./...
go test ./...
```

統合テストには ffmpeg で生成した決定的な fixture を使います。
ASRとLLM連想はテスト用のfakeへ差し替えます。
実モデルとAPIキーがない環境でも全テストが通ります。

音源manifestと公開する動物一覧の一致は、リポジトリ直下の `npm test` が検査します。

実モデルと実APIを使う通し確認は `tests/e2e/zoovoice-real-backend.spec.ts` です。
`ZOOVOICE_REAL_BACKEND=1` を付けた場合だけ実行し、それ以外の環境ではskipします。
このテストはWrangler localのWorker、Turnstileのtest key、native localのGoサービスを通し、録音から音声の再生とダウンロードまでをブラウザ操作で確認します。
日本語ASR、動物の自動連想、音声合成を含む1回の通しが成功しています。
所要時間はtest本体13.1秒、run全体13.7秒です。
この経路はDocker imageではなくnative localのGoサービスを使うため、上のlocal-only verificationとは測定条件が異なります。
