# Zoovoice 音声合成サービス

更新日: 2026-08-07

Zoovoice は録音した発話の内容から動物を1種だけ自動で選び、その鳴き声を発話の無音区間へ重ねるデモです。
このディレクトリには Go 製の API と生成済みの動物レキシコン、鳴き声素材、索引生成ツールを置いています。
1リクエストの流れは、日本語ASR、動物の自動連想、音声合成の順です。
公開のUI・API入り口はCloudflare Workerであり、Workerが有効化した配備ではこのGoサービスをprivateなGoogle Cloud Run上のコンテナとして呼び出します。
Cloud Run配備の契約は[Cloud Run配備](#cloud-run配備)を、公開側の全体構成は[ARCHITECTURE.md](../../docs/deployment/ARCHITECTURE.md)を参照してください。

## 必要なソフトウェア

- Go 1.25 以上（`go.mod` のtoolchainは1.26.1）
- ffmpeg と ffprobe
- whisper.cpp の `whisper-cli` と日本語ASR用の `ggml-small.bin`
- ConceptNet派生の日本語連想index（SQLite）
- リポジトリ全体のローカル確認にはNode.jsとWrangler、および`gcloud`(private Cloud Run smoke時)

`whisper-cli`、ASRモデル、連想indexはリポジトリで管理しません。
いずれもリポジトリ外へ置き、環境変数でpathを渡します。
保存方針は [MODEL_STORAGE.md](../../docs/deployment/MODEL_STORAGE.md)、連想indexの帰属とライセンスは [LICENSE-CONCEPTNET.md](LICENSE-CONCEPTNET.md) を参照してください。

## 起動方法

通常のローカル確認は、リポジトリ直下で次を実行します。

```sh
npm run dev:zoovoice
```

このコマンドはWrangler local、local D1、このGoサービスを起動し、FastAPIは使いません。
`http://127.0.0.1:8787/zoovoice` を開くとCloudflare Worker local経由で確認できます。
Playwrightによるローカルe2e確認も同じWrangler localを起動します。

local起動では`ZOOVOICE_WHISPER_COMMAND`、`ZOOVOICE_ASR_MODEL_PATH`、`ZOOVOICE_CONCEPTNET_INDEX_PATH`の3つが必須です。
起動scriptはWranglerとGoサービスを立ち上げる前にこの3つの実在を検査し、1つでも未設定または不在なら停止します。
検査を通ったpathは絶対pathへ正規化してからGoサービスへ渡すため、相対pathで指定しても作業ディレクトリの違いで壊れません。
Goサービス自身も起動時に同じ3つの実在を確認します。

```sh
export ZOOVOICE_WHISPER_COMMAND=<repo-outside>/whisper.cpp/build/bin/whisper-cli
export ZOOVOICE_ASR_MODEL_PATH=<repo-outside>/models/ggml-small.bin
export ZOOVOICE_CONCEPTNET_INDEX_PATH=<repo-outside>/data/conceptnet-ja-5.7.0.sqlite
```

このディレクトリのGoサービス単体だけを確認する場合は、`services/zoovoice`へ移動して起動します。

```sh
go run .
```

起動時に `assets/animal-lexicon.json` と `assets/animal-sounds/` を読み込み、27種すべてを公開します。
レキシコンが持つ音声のSHA-256と実ファイルが一致しない場合は起動しません。

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
| `ZOOVOICE_ASSETS_DIR` | 自動検出した `assets` | `animal-lexicon.json` と `animal-sounds/` の親ディレクトリ |
| `ZOOVOICE_WHISPER_COMMAND` | なし（必須） | whisper.cpp の `whisper-cli` の実行ファイル |
| `ZOOVOICE_ASR_MODEL_PATH` | なし（必須） | 日本語ASRに使う `ggml-small.bin` |
| `ZOOVOICE_CONCEPTNET_INDEX_PATH` | なし（必須） | ConceptNet派生の連想index（SQLite） |
| `ZOOVOICE_ASR_THREADS` | `2` | whisper.cpp へ渡すスレッド数 |
| `ZOOVOICE_TIMEOUT_SECONDS` | `85` | ASRとffmpegを含む1リクエストの上限秒数 |
| `ZOOVOICE_LOG_PATH` | リポジトリ直下の `logs/zoovoice.log` | JST時刻と経過時間を含むサービスログ |

必須の3つは起動時に検査します。
ファイルが無い場合や連想indexのmetadataが想定と違う場合は起動に失敗します。
固定の動物へ黙って切り替える動作は持ちません。

連想indexのmetadataは、読み込んだ `assets/animal-lexicon.json` のSHA-256とも照合します。
レキシコンとindexの組合せが違う場合も起動に失敗します。

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
    "evidence_term": "鶏",
    "selection_strategy": "direct",
    "fallback_reason": null,
    "insertions": [
      {"slot": "opening", "species": "rooster", "at_seconds": 0}
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
| `evidence_term` | 選択に使った根拠語。`direct`・`pun` では一致したレキシコンの語、`conceptnet` では概念語、random fallbackでは `null` |
| `selection_strategy` | `direct`・`pun`・`conceptnet`・`random_fallback` のいずれか |
| `fallback_reason` | random fallbackのときだけ `no_association_match`。それ以外は `null` |
| `insertions` | 挿入した鳴き声の位置。`species` は全件同じ動物 |

`insertions` の `slot` は `opening`・`gaps`・`ending` のいずれかです。
1回の合成で使う動物は1種だけなので、`species` はすべて `selected_animal.id` と一致します。

エラーは `{"error":{"code":"...","message":"..."}}` の形です。
動物音単体を取得または試聴する API はありません。

## 動物の自動連想

連想はASR本文だけを入力にします。
利用者が動物を選ぶ経路はUIにもAPIにもありません。

1. ASR本文を形態素解析し、本文の表層でレキシコンの語を探す。一致は始まりと終わりがtoken境界にそろう連続token列だけを認め、基本形や読みから一致を作らない。
2. 動物名の語の一致は、動物への直接の言及なら `direct` に分類する。
3. 動物名の語の一致のうち、別の語句と重なる語呂合わせは `pun` に分類する。「うしろ」の牛、「ぞうきん」の象のような連続token列との一致も意図的に対象にする。
4. 鳴き声オノマトペの一致は、前後の音の文脈を要求せず `direct` とする。
5. 一致が複数ある場合は `direct` を `pun` より優先し、同方式では最も前に現れたものを選ぶ。
6. `direct` と `pun` で決まらなければ、Kagome v2のIPA辞書でConceptNet候補を作る。
   - 名詞・動詞・形容詞などの内容語を残し、助詞や代名詞などを除く。
   - 表層形と基本形に加え、ひらがなへ変換した読みも候補にする。
   - 隣り合う名詞2語は1回だけ結合する。3語以上や非名詞の連接は作らない。
   - 連想indexで1-hop edgeを引き、関係別の重み付き合計が最大の動物を `conceptnet` として選ぶ。
7. どの段でも決まらない場合だけ、利用できる動物からrandomで1種を選ぶ。

動物名とオノマトペの定義は生成物の `assets/animal-lexicon.json` を正とします。
選ばれる対象は、音源を持ち `/animals` に載る動物だけです。

ASR本文と根拠語は応答とプロセスのメモリ内だけで扱います。
サービスログ、D1、その他の永続層へは書きません。

合成requestの処理でサービスログへ記録するのは、次の項目です。

- 処理段階と状態、失敗時のエラーコード
- 各段階の経過時間
- HTTPのmethodとpath、応答status
- 選んだ種IDと選択方式
- 入力と出力のbyte数、アニマル度の値
- 入力音声と出力音声の長さ、発話の合計時間
- 無音判定の最小秒数、無音区間数、挿入数

このほか、プロセスの起動時には待受port、利用可能な動物数、timeoutの設定秒数を記録します。
起動に失敗した理由も記録します。

いずれの項目も音声や本文の内容そのものを含みません。
録音と生成音声の内容、ASR本文、根拠語はサービスログへ書きません。

## 動物レキシコンの生成

`assets/animal-lexicon.json` は、連想と音声再生が共通で参照するリポジトリ追跡の生成物です。
現在の対象は第1段階の27種です。
手書きの語彙定義ファイルは持たず、`cmd/animal-lexicon` が次の3つを入力にして生成します。

| 入力 | 内容 |
| --- | --- |
| ConceptNet 5.7.0 assertions | 動物候補の抽出元。リポジトリ外へ置く |
| `assets/animal-lexicon-judgments.json` | 候補ごとの採否・理由・オノマトペを固定したAI判断の記録 |
| `assets/animal-sounds/manifest.json` | 採用した音声の形式とSHA-256、生成元の記録 |

3つの入力のSHA-256は、生成物の `metadata` へ埋め込みます。

```sh
go run ./cmd/animal-lexicon \
  -source <repo-outside>/conceptnet-assertions-5.7.0.csv.gz \
  -source-sha256 <元データのSHA-256> \
  -judgments assets/animal-lexicon-judgments.json \
  -audio-manifest assets/animal-sounds/manifest.json \
  -output assets/animal-lexicon.json
```

候補抽出は、日本語ConceptNetの `IsA` を動物系の上位概念とWordNetの動物senseからたどり、`Synonym` で表記を広げます。
生成時には採用種の音声実体、日本語ラベルの一致、種をまたぐ語の重複を検査します。
1つでも崩れた場合は出力せずに失敗します。

`-candidates-output` を付けると、AI判断へ渡す候補一覧を別ファイルへ書き出せます。
`-output` を省いた実行は候補抽出だけを行います。

語はConceptNet由来のため、動物そのものを指さない表記も入ります。
例えば `pig` の語は `豚` と `豚肉` です。

生成物を直接編集しないでください。
入力を直してから再生成し、続けて連想indexも作り直します。

## 連想indexの生成

連想indexはConceptNet 5.7.0のassertionsから作るSQLiteファイルです。
生成物はリポジトリで管理せず、リポジトリ外へ置きます。

```sh
go run ./cmd/conceptnet-index \
  -source <repo-outside>/conceptnet-assertions-5.7.0.csv.gz \
  -output <repo-outside>/data/conceptnet-ja-5.7.0.sqlite \
  -lexicon assets/animal-lexicon.json \
  -source-sha256 <元データのSHA-256>
```

indexは動物レキシコンの語に一致するedgeだけを残し、そのSHA-256を `lexicon_sha256` としてmetadataへ保存します。
metadataのschema世代は `2` です。
レキシコンを作り直した場合はindexも作り直します。

処理は長いため、既定で10万行ごとにcheckpointを書きます。
中断した場合は同じ引数で再実行すると途中から続けます。
metadataが一致しない再実行は続行せず失敗します。

帰属、変換内容、share-alike条件は [LICENSE-CONCEPTNET.md](LICENSE-CONCEPTNET.md) を参照してください。

## 同梱する動物音

`assets/animal-sounds/` には27種の規格化済み WAV を1種1本ずつ置きます。
内訳はStable Audioで生成した24種と、CC0音源から移行した3種です。
27件のWAVの合計は5,965,364 bytes（約5.7 MiB）です。

| 区分 | 種数 | ライセンス | 形式 |
| --- | --- | --- | --- |
| Stable Audio生成 | 24 | Stability AI Community License | 24kHz、mono、signed 16-bit PCM、5秒 |
| CC0移行fallback | 3 | CC0 1.0 | 24kHz、mono、signed 16-bit PCM |

犬・猫・コオロギの3種は、既存の連想評価が退行しないようCC0音源のまま残しています。
この3件は Freesound の各配布ページから取得した音源です。

| 種 | タイトル | 作者 | 配布ページ |
| --- | --- | --- | --- |
| 犬 | Single Dog Bark | kwahmah_02 | [Freesound 277058](https://freesound.org/people/kwahmah_02/sounds/277058) |
| 猫 | Cat meow | philsapphire | [Freesound 256452](https://freesound.org/people/philsapphire/sounds/256452) |
| コオロギ | Crickets chirping loop | Patrick_Corra | [Freesound 633196](https://freesound.org/people/Patrick_Corra/sounds/633196) |

この3件のライセンスは [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) です。
Stable Audioで生成した24件の必須表示と由来は [NOTICE-STABILITY-AI.md](NOTICE-STABILITY-AI.md) を正とします。
公開UIはfooterへ `Powered by Stability AI` を表示します。

種ごとの出所は `assets/animal-sounds/manifest.json` に保存します。
Stable Audio分はモデル `stabilityai/stable-audio-3-small-sfx` とそのrevisionを記録します。
各動物では採用variantのpromptとseed、生成元と規格化後のSHA-256、音声指標を残します。
不採用を含む候補2件のreceiptも同じmanifestへ残します。
CC0の3件は作者と配布ページ、移行前の音源のSHA-256を記録します。

## 動物音の準備

`tools/import_stable_audio.py` は、生成済みの候補から1種1本を採用して規格化し、manifestを書き出します。
モデルの実行そのものは行いません。

```sh
python3 tools/import_stable_audio.py <stable-audio-output-dir> assets/animal-sounds
```

処理内容は次のとおりです。

1. 候補manifestとreceiptを突き合わせ、生成元のSHA-256を検査する。
2. 種ごとにvariant 1を決定論的に採用する。
3. `24kHz`、mono、signed 16-bit PCM WAV へ変換する。
4. 生成音声は長さが5秒であること、平均dBFSとピークdBFSが想定範囲にあることを検査する。
5. 出力するWAV全体の合計が15,000,000 bytesを超えないことを検査する。

CC0の3種は `--include-cc0` で同じ出力へ含めます。
移行元の素材はリポジトリに残していないため、この3件の再生成には移行前の素材と出所manifestが要ります。
このスクリプトは取得条件を伴う素材準備用なので CI では実行しません。

## Docker image

imageは`services/zoovoice/Dockerfile`で作ります。
モデルと連想indexはリポジトリへcommitしないため、buildはgit外の成果物を named context として受け取ります。

- `whisper_source`: 検証済みのwhisper.cppソース。commitは`5250a86fdebac4d51085fcfcd0b315cb0c6b91c9`に固定する
- `zoovoice_runtime`: `ggml-small.bin`、連想index、`LICENSE-CONCEPTNET.md`、`NOTICE-STABILITY-AI.md`を置いた一時ディレクトリ

buildは`ggml-small.bin`と連想index、`assets/animal-lexicon.json`のSHA-256をimage内で照合します。
固定値はASRモデルが`1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`、連想indexが`088d3e4b199604a538e4f0cac7c29b6f21da1d995c24354fc5d07c7cf3b03a71`です。
動物レキシコンのSHA-256はリポジトリのファイルから算出して`ZOOVOICE_ANIMAL_LEXICON_SHA256`へ渡します。
現在の値は`ba3f08ca64a8736121704ace37e3766b61d816447befe5364de8edebad7b248d`です。
whisper.cpp commit、3つのSHA-256、ライセンス識別子はimage labelにも残します。

最終imageに入るのは次だけです。

- Goバイナリと`whisper-cli`
- `ggml-small.bin`と連想index
- whisper.cpp、ConceptNet派生index、Stability AIのライセンス表示
- Debian runtime、CA証明書、ffmpeg
- リポジトリで追跡する動物レキシコンと動物音27件

secretと開発用ファイルは含めません。
実行ユーザーはuid 10001のnon-rootで、待受portは8080です。

## Cloud Run配備

Cloud Runへの配備は`./scripts/deploy_zoovoice_cloud_run.sh`を使います。
実行前に次の4つを環境変数で渡します。

| 変数 | 内容 |
| --- | --- |
| `ZOOVOICE_WHISPER_SOURCE_DIR` | 検証済みwhisper.cppのソースディレクトリ |
| `ZOOVOICE_ASR_MODEL_PATH` | `ggml-small.bin` |
| `ZOOVOICE_CONCEPTNET_INDEX_PATH` | 連想index |
| `ZOOVOICE_SMOKE_AUDIO_PATH` | local smokeへ送る短い音声 |

scriptはこれらのcommitとSHA-256、連想indexのmetadataを先に検査します。
検査対象のmetadataは次のとおりです。

- schema世代（`2`）
- ConceptNetのversion
- ライセンス
- 元データのSHA-256
- 変換内容
- `lexicon_sha256`とリポジトリの`assets/animal-lexicon.json`のSHA-256の一致

1つでも一致しない場合は、buildへ進まず停止します。

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

同じ確認で、ASRモデルと連想indexがnon-rootの実行ユーザーから読めることも確認しました。

`whisper-cli`はDockerfileの`-DBUILD_SHARED_LIBS=OFF`により、whisper/ggmlのlibraryをstaticに組み込んでbuildしています。
この確認では、`whisper-cli`がwhisper/ggmlを共有libraryとして要求しないことを確かめました。
libstdc++・libm・libgcc_s・libc・動的loaderへは動的にlinkするため、完全なstatic binaryではありません。

この測定はApple Silicon上のlinux/amd64 emulationで行っています。
compose時間はemulationの影響を受けるため、Cloud Runの実CPU上の値とは一致しません。
上の表の値はすべてこのlocal環境の実測であり、Cloud Run実機では未確認です。

上の表は動物レキシコンと動物音を入れ替える前のimageの実測です。
現在のassetsを含むimageでは再測定していません。

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
ASRとConceptNetはテスト用のfakeと小さな固定indexへ差し替えます。
実モデルと実indexがない環境でも全テストが通ります。

動物レキシコンと公開する動物一覧の一致は、リポジトリ直下の `npm test` が検査します。

実モデルと実indexを使う通し確認は `tests/e2e/zoovoice-real-backend.spec.ts` です。
`ZOOVOICE_REAL_BACKEND=1` を付けた場合だけ実行し、それ以外の環境ではskipします。
このテストはWrangler localのWorker、Turnstileのtest key、native localのGoサービスを通し、録音から音声の再生とダウンロードまでをブラウザ操作で確認します。
日本語ASR、犬の直接連想、音声合成を含む1回の通しが成功しています。
所要時間はtest本体13.1秒、run全体13.7秒です。
この経路はDocker imageではなくnative localのGoサービスを使うため、上のlocal-only verificationとは測定条件が異なります。
