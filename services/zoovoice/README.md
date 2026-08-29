# Zoovoice 音声合成サービス

更新日: 2026-08-24

Zoovoice は録音した発話の内容から動物を自動で選び、その鳴き声を言葉の切れ目へ差し込むデモです。
差し込んだぶん出力音声は長くなります。動物の種類数は利用者が1種か2種かを選べます（既定は1種）。
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
動物IDと表示名、クレジットの文字数と出典URLは、公開経路のWorkerが課している条件と同じ形かを起動時に確かめます。
条件を外れたmanifestでは起動しません。合成のたびに応答が捨てられる状態を先に止めるためです。

## 機能確認CLI

貼り付けて実行できる `./zoovoice preview` コマンドは、リポジトリ直下の [CLI.md](../../CLI.md) に集約します。
`-text` で連想と素材を、`-audio` でASRから合成までを確認します。
`-species` は音源カタログの1種か2種を固定し、LLMと `OPENAI_API_KEY` を不要にします。
`-animals` と `-species` は同時に指定できません。
アニマル度は `-intensity 0〜100`（既定50）で指定します。
`-verbose` は処理ログを標準エラーへ出します。

### 最終選別セット（tmp1/final）での確認

最終選別した鳴き声セット（`tmp1/final`、Git管理外）で動かす場合は、`ZOOVOICE_SOUNDS_DIR` にそのディレクトリを渡します。
サーバとCLIのどちらでも有効です。

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

必須の4つは起動時に検査します。
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
- `settings`: `intensity` と `animal_count` を持つ JSON 文字列です。

`intensity` はアニマル度を表す0から100までの整数です。
文中の目標挿入数は `round(入力音声の秒数 × 0.5 × intensity / 100)` です。
末尾へ必ず入れる1本はこの密度計算に含めません。
`animal_count` は連想する動物の種類数で、1か2を指定します。
省略した場合は1として扱うので、この項目を持たない古い呼び出しもそのまま通ります。
動物の指定、挿入位置の指定、未知のキーは受け付けません。

```sh
curl -X POST http://127.0.0.1:8090/compose \
  -F 'audio=@<recording.webm>' \
  -F 'settings={"intensity":50,"animal_count":1}'
```

成功時は合成済み WAV を base64 で返します。
発話部分が合計0.5秒未満の場合は `422` の `speech_too_short` で拒否します。
ASRが発話を1つも認識できなかった場合は `422` の `asr_empty` を返します。
連想に使うAPIの一時的な失敗（接続不可・混雑・上流の障害）は `503` の `association_unavailable` を返します。
このコードは画面側の再試行対象なので、利用者は同じ録音のまま送り直せます。
認証の誤りや解釈できない応答など、送り直しても直らない失敗は `502` の `association_failed` を返します。

```json
{
  "audio": {"format": "wav", "base64": "..."},
  "meta": {
    "transcript": "夜中に鶏が鳴いていた",
    "selected_animal": {"id": "rooster", "label_ja": "雄鶏"},
    "selected_animals": [
      {"id": "rooster", "label_ja": "雄鶏", "reason": "夜中に鳴く鳥といえば鶏"}
    ],
    "association_reason": "夜中に鳴く鳥といえば鶏",
    "insertions": [
      {"slot": "word", "species": "rooster", "at_seconds": 1.4, "duration_seconds": 0.8},
      {"slot": "ending", "species": "rooster", "at_seconds": 3.2, "duration_seconds": 2.5}
    ],
    "sound_credits": [
      {"license": "CC0 1.0", "creator": "someone", "source_url": "https://example.com/1"}
    ],
    "input_duration_seconds": 3.2,
    "output_duration_seconds": 6.5
  }
}
```

`meta` の各項目の意味は次のとおりです。

| 項目 | 内容 |
| --- | --- |
| `transcript` | 日本語ASRの認識本文 |
| `selected_animal` | 自動で選んだ動物のうち1件目の種IDと日本語ラベル |
| `selected_animals` | 選んだ動物の一覧。各件が種ID・日本語ラベル・理由を持つ。1種のときも配列で返す |
| `association_reason` | 1件目の動物を選んだ理由としてLLMが返した日本語の短文 |
| `insertions` | 差し込んだ鳴き声の位置と長さ |
| `sound_credits` | 使った鳴き声素材のクレジット（ライセンス・作者・出典URL）。重複は除く。素材ファイル名は含まない |

`insertions` の `slot` は `word`（言葉の切れ目）か `ending`（末尾）です。
先頭には差し込みません。末尾はアニマル度に関わらず必ず1つ入ります。
`selected_animals` が2件のときは `species` が2種を交互に指し、末尾は1件目の動物になります。
LLMの結果が1件へまとまった場合は、全件が `selected_animal.id` と一致します。

エラーは `{"error":{"code":"...","message":"..."}}` の形です。
動物音単体を取得または試聴する API はありません。

## 動物の自動連想

連想はASR本文だけを入力にします。
利用者が動物を選ぶ経路はUIにもAPIにもありません。

1. ASR本文と、音源のある動物の一覧（種IDと日本語ラベル）をLLMへ渡す。
2. LLMは「どんなこじつけでもよいので候補から必ず指定数だけ選ぶ」指示に従い、種IDと理由の短文を返す。
3. 候補一覧に無い種IDが返った場合はエラーにする。別の動物へ黙って読み替えない。
4. 同じ動物が重ねて返った場合は1件へまとめる。結果が1件でもエラーにはしない。

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
- 形態素の数と挿入候補の数、挿入数、選んだ動物の数

このほか、プロセスの起動時には待受port、利用可能な動物数、timeoutの設定秒数を記録します。
起動に失敗した理由も記録します。

いずれの項目も音声や本文の内容そのものを含みません。
録音と生成音声の内容、ASR本文、連想の理由はサービスログへ書きません。

## 鳴き声素材

鳴き声素材はリポジトリに置きません。実行時は `ZOOVOICE_SOUNDS_DIR`、image build時は
`zoovoice_sounds` context で外から渡します。対象動物の正本は素材そのものであり、
一覧は [ANIMALS.md](ANIMALS.md) に写してあります
（`python3 scripts/generate_animals_doc.py <sounds-dir>` で作り直します）。

素材の形式は 24kHz、mono、signed 16-bit PCM WAV です。
1種に複数本あってよく、出所（ライセンス・作者・配布ページ）と採用時のSHA-256は
セットの `manifest.json` に1本ずつ記録します。サービスは起動時にSHA-256を照合し、
1件でも合わなければ起動しません。合成応答にはその回に使った素材のクレジットを含めます。

素材はすべて実録音で、無償で商用利用できるライセンス（CC0・CC BY・小森平の利用規約）の
ものだけを使います。生成音声は使いません。

## 素材の準備

実録音を新しく集めるところからやり直す場合は、リポジトリ直下の3つのスクリプトを順に使います。
2番目の出力先は、3番目へ渡す素材ディレクトリの下の `real-recordings/` にします。

```sh
python3 scripts/fetch_animal_recordings.py <queries.json> <素材ディレクトリ>/candidates
python3 scripts/build_real_recordings.py <selection.json> <素材ディレクトリ>/real-recordings
python3 scripts/select_animal_sounds.py <素材ディレクトリ>
```

1番目は候補を集めて `candidates.json` に取得時のSHA-256を記録します。
2番目は選んだ候補を実行時の形式（24kHz・mono・16-bit PCM WAV）へ規格化します。
記録したSHA-256と中身が食い違う候補があれば、そこで止まります。
3番目は各系統から優先順位で選び、`<素材ディレクトリ>/final` に `ZOOVOICE_SOUNDS_DIR` の中身を作ります。

いずれも取得条件を伴う素材準備用なので CI では実行しません。

## Docker image

imageは`services/zoovoice/Dockerfile`で作ります。
モデルと鳴き声素材はリポジトリへcommitしないため、buildはgit外の成果物を named context として受け取ります。

- `whisper_source`: 検証済みのwhisper.cppソース。commitは`edea8a9c3cf0eb7676dcdb604991eb2f95c3d984`に固定する
- `zoovoice_runtime`: `ggml-small.bin`を置いた一時ディレクトリ
- `zoovoice_sounds`: `manifest.json`付きの鳴き声セット（`ZOOVOICE_SOUNDS_DIR`の中身をそのまま渡す）

buildは`ggml-small.bin`のSHA-256をimage内で照合します。
固定値は`1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`です。
whisper.cpp commit、ASRモデルのSHA-256、ライセンス識別子はimage labelにも残します。
連想に使うAPIキーはimageへ焼き込まず、実行時に`OPENAI_API_KEY`で渡します。

最終imageに入るのは次だけです。

- Goバイナリと`whisper-cli`
- `ggml-small.bin`
- whisper.cppのライセンス表示
- KagomeとKagome辞書のMIT License、mecab-ipadicのNOTICE
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

次の3つは任意です。CIが使い、ローカルでは省略できます。

| 変数 | 内容 |
| --- | --- |
| `ZOOVOICE_LLM_ENDPOINT` | 連想APIの向き先。未設定なら公式endpointを使う |
| `ZOOVOICE_BUILD_CACHE_FROM` | `docker buildx` へ渡すcacheの読み出し先 |
| `ZOOVOICE_BUILD_CACHE_TO` | 同じくcacheの書き込み先 |

ASRモデルと鳴き声セットは、Cloud Storageから取得できます。
取得先のディレクトリは`ZOOVOICE_ARTIFACTS_DIR`で渡します。

```sh
ZOOVOICE_ARTIFACTS_DIR=/tmp/zoovoice-artifacts ./scripts/fetch_zoovoice_artifacts.sh
```

取得時にSHA-256を照合し、`ZOOVOICE_ASR_MODEL_PATH`と`ZOOVOICE_SOUNDS_DIR`へ渡すべき2つのpathを出力します。

scriptはwhisper.cpp commitとASRモデルのSHA-256を先に検査します。
一致しない場合は、buildへ進まず停止します。
Cloud Run上の`OPENAI_API_KEY`はSecret Manager `zoovoice-openai-api-key` から渡します。この紐付けはTerraform（`infra/gcp/`）が管理し、scriptは変更しません。

whisper.cppソースは、固定commitに加えて作業ツリーがcleanであることも必須です。
未commitの変更やuntracked fileが1つでもあれば、buildへ進まず停止します。

実行modeは3つで、`ZOOVOICE_GCP_PROJECT`は全modeで必須です。

| mode | 設定 | 実行内容 |
| --- | --- | --- |
| dry-run | 既定 | 実行予定の操作を表示するだけ。build、local起動、remote writeを行わない |
| local-only verification | `ZOOVOICE_LOCAL_VERIFY=1` | imageのbuild、local起動、`/healthz`と`/compose`の確認まで。remote writeを行わない |
| apply | `ZOOVOICE_DEPLOY_APPLY=1` | 上記に続けてimage pushと、Cloud Run serviceのimage入れ替えを実行する |

`ZOOVOICE_DEPLOY_APPLY=1`と`ZOOVOICE_LOCAL_VERIFY=1`は同時に指定できません。
applyはcleanなworking treeを必要とします。

Cloud Runの配備契約は次のとおりです。
CPUとメモリはlocal-only verificationで同じ上限を課して起動できます。
現在のimageでの実測値は未取得です（後述の「local-only verificationで測るもの」を参照）。
この契約で、us-central1のprivate Cloud Run serviceへdeploy済みです。
サービス設定（下記の資源上限・ingress・IAM・secret紐付け）の正本はTerraform（`infra/gcp/`）で、scriptが担当するのはimage buildとpush、digest指定での入れ替えだけです。

- region: `us-central1`
- private（未認証アクセス不可。`allUsers`と`allAuthenticatedUsers`は不可）
- CPU 2、メモリ2GiB
- port 8080、timeout 90秒、concurrency 1
- min 0、max 2
- imageはlocalでbuildし、privateなArtifact Registryの `us-central1-docker.pkg.dev/<project>/voice-lab/zoovoice:<git-sha>` へpushする
- imageはtagではなくdigestを固定して指定する

Cloud RunへGit repositoryを接続する自動buildは使いません。
container imageのbuildとpushは、この配備scriptだけが行います。
`main`へのpushではGitHub Actionsが同じscriptを呼び出し、手元から実行するときも同じ経路を通ります。

invoker権限はservice単位の`roles/run.invoker`だけを付与し、`allUsers`へは付与しません。
付与先はCloudflare Worker用のinvoker service account、smoke専用のservice account、CD用のservice accountの3つです。
CD用へ直接付与しているのは、smoke専用service accountを借用させるとその相手の権限をすべて引き継ぐためです。
active developerのgcloudアカウントは、smoke専用service account上の`roles/iam.serviceAccountTokenCreator`だけを持ち、Cloud Run自体のinvoker権限は持ちません。
これらのIAMもTerraform（`infra/gcp/`）が管理します。scriptはapply時に`allUsers`が居ないことの確認だけを行います。

### local-only verificationで測るもの

`ZOOVOICE_LOCAL_VERIFY=1`は、linux/amd64のCloud Run相当imageをlocal buildします。
CPU 2とメモリ2GiBの上限付きでnon-root起動し、`/healthz`がreadyになるまで待ちます。
続けて日本語fixtureで`/compose`を1回実行し、返ってきた音声とmetaの形を検査します。
最後にimage size、使用メモリ、起動までの時間、compose時間を標準出力へ出します。

`whisper-cli`はDockerfileの`-DBUILD_SHARED_LIBS=OFF`により、whisper/ggmlのlibraryをstaticに組み込んでbuildしています。
libstdc++・libm・libgcc_s・libc・動的loaderへは動的にlinkするため、完全なstatic binaryではありません。

実測値は次のとおりです。localはApple Silicon上のlinux/amd64 emulationで、Cloud Runと同じCPU 2・メモリ2GiBの上限を課した値です。

| 測定 | 条件 | 値 |
| --- | --- | --- |
| 起動（cold start） | local container | 1.7秒 |
| `/compose` 1回 | local container、日本語fixture | 30.6秒 |
| `/compose` 1回 | Cloud Run、入力3.9秒の実音声 | 36.0秒 |

emulationのlocal値はCloud Runの実CPU上の値より遅くなり得ます。再測定にはimage buildと、課金の発生するLLM呼び出しが1回必要です。

### 外部操作の状況

production Cloudflare WorkerがCloud Runを呼ぶ認証は、専用invoker service accountのkeyによるID token取得方式です。
認証フローとsecret運用の詳細は[CLOUDFLARE.md](../../docs/deployment/CLOUDFLARE.md)を参照してください。

Cloudflare Workerは`main`へのpushで自動反映します。
Cloud Runも同じ`Deploy Production`から反映する構成にしてありますが、**この経路はまだ有効ではありません**。
有効になるのは、次の3つの外部操作が済んだ後です。いずれも未実行で、`deploy-cloud-run`のjobは一度も動いていません。

1. `infra/gcp`の`terraform apply`（bucketとservice accountの作成）
2. build資材のCloud Storageへのアップロード
3. CI用service account鍵のGitHub Secretへの登録

それまでのCloud Runへの反映は、従来どおり手元から`./scripts/deploy_zoovoice_cloud_run.sh`を明示applyで実行します。

反映の前に、`Deploy Production`のjobがrunner上でimageを起動して`POST /compose`を1回通します。
このとき連想APIの向き先だけを`ZOOVOICE_LLM_ENDPOINT`でrunner上のstubへ変え、課金の発生する外部呼び出しを避けます。
stubはGoのテスト内で使う`stubDoer`とは別物で、runner上に立てる実際のHTTPサーバーです。
imageには手を入れないため、検証した成果物と配布する成果物は同一です。
`ZOOVOICE_LLM_ENDPOINT`はテスト専用の仕組みではなく、サービスが元から持つ設定項目です。

反映のたびに同じjobが次を確認します。満たさない場合はjobが失敗します。

- 認証なしのCloud Run直接requestが403で拒否されること
- CD用service accountでの`GET /animals`の200応答
- 公開側は`python3 scripts/smoke_cloudflare_deployment.py --base-url https://voice-lab.inakaegg.workers.dev`

実音声での`POST /compose`は自動化しません。実LLM呼び出しに課金が発生するためです。
挿入位置と選んだ動物の妥当性は、必要なときに手元で確かめます。

Cloud Runの`/healthz`は認証付きrequestでもGoogle側で404になるため、remote smokeの確認先には使いません。
local containerでは同じpathが200を返します。

Worker経由の実`POST /api/zoovoice/compose`は、常に未確認のまま残ります。
この確認にはproduction Turnstileの人間操作が必要であり、CAPTCHAは回避しないためです。
自動smokeの対象にはせず、必要なときにブラウザで`/zoovoice`を開いて確かめます。

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
この経路はDocker imageではなくnative localのGoサービスを使うため、local-only verificationとは測定条件が異なります。
