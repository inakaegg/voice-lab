# Zoovoice 音声合成サービス

Zoovoice は録音した発話の内容から動物を1種だけ自動で選び、その鳴き声を発話の無音区間へ重ねるデモです。
このディレクトリには Go 製の API と素材マスタ、動物連想用の索引生成ツールを置いています。
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

既定では CC0 の12種だけを読み込みます。
repo 外の追加素材も使う場合は規格化済み WAV のディレクトリを指定します。

```sh
ZOOVOICE_EXTRA_ASSETS_DIR=<repo-outside-assets>/taira-komori go run .
```

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
| `ZOOVOICE_ASSETS_DIR` | 自動検出した `assets` | `animals.json`・`association-aliases.json`・`cc0/` の親ディレクトリ |
| `ZOOVOICE_EXTRA_ASSETS_DIR` | 未設定 | repo 外の追加 WAV ディレクトリ |
| `ZOOVOICE_WHISPER_COMMAND` | なし（必須） | whisper.cpp の `whisper-cli` の実行ファイル |
| `ZOOVOICE_ASR_MODEL_PATH` | なし（必須） | 日本語ASRに使う `ggml-small.bin` |
| `ZOOVOICE_CONCEPTNET_INDEX_PATH` | なし（必須） | ConceptNet派生の連想index（SQLite） |
| `ZOOVOICE_ASR_THREADS` | `2` | whisper.cpp へ渡すスレッド数 |
| `ZOOVOICE_TIMEOUT_SECONDS` | `85` | ASRとffmpegを含む1リクエストの上限秒数 |
| `ZOOVOICE_LOG_PATH` | リポジトリ直下の `logs/zoovoice.log` | JST時刻と経過時間を含むサービスログ |

必須の3つは起動時に検査します。
ファイルが無い場合や連想indexのmetadataが想定と違う場合は起動に失敗します。
固定の動物へ黙って切り替える動作は持ちません。

追加素材の場所が未設定または不在でも起動できます。
その場合は警告をログへ記録し、実在する CC0 素材だけを公開します。

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
    "selected_animal": {"id": "rooster", "label_ja": "おんどり"},
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
| `evidence_term` | 選択に使った根拠語。random fallbackでは `null` |
| `selection_strategy` | `direct`・`conceptnet`・`random_fallback` のいずれか |
| `fallback_reason` | random fallbackのときだけ理由。それ以外は `null` |
| `insertions` | 挿入した鳴き声の位置。`species` は全件同じ動物 |

`insertions` の `slot` は `opening`・`gaps`・`ending` のいずれかです。
1回の合成で使う動物は1種だけなので、`species` はすべて `selected_animal.id` と一致します。

エラーは `{"error":{"code":"...","message":"..."}}` の形です。
動物音単体を取得または試聴する API はありません。

## 動物の自動連想

連想はASR本文だけを入力にします。
利用者が動物を選ぶ経路はUIにもAPIにもありません。

1. ASR本文を形態素解析し、表層形・基本形・読みと短い連接語を候補語にする。
2. 動物名やオノマトペの直接言及があれば、最も前に現れたものを採用する。
3. 直接言及がなければ、連想indexで候補語の1-hop edgeを引き、関係別の重み付き合計が最大の動物を選ぶ。
4. どちらでも決まらない場合だけ、利用できる動物からrandomで1種を選ぶ。

動物名とオノマトペの定義は `assets/association-aliases.json` を正とします。
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
追加素材が見つからない場合の警告や、起動に失敗した理由も記録します。

いずれの項目も音声や本文の内容そのものを含みません。
録音と生成音声の内容、ASR本文、根拠語はサービスログへ書きません。

## 連想indexの生成

連想indexはConceptNet 5.7.0のassertionsから作るSQLiteファイルです。
生成物はリポジトリで管理せず、リポジトリ外へ置きます。

```sh
go run ./cmd/conceptnet-index \
  -source <repo-outside>/conceptnet-assertions-5.7.0.csv.gz \
  -output <repo-outside>/data/conceptnet-ja-5.7.0.sqlite \
  -aliases assets/association-aliases.json \
  -source-sha256 <元データのSHA-256>
```

処理は長いため、既定で10万行ごとにcheckpointを書きます。
中断した場合は同じ引数で再実行すると途中から続けます。
metadataが一致しない再実行は続行せず失敗します。

帰属、変換内容、share-alike条件は [LICENSE-CONCEPTNET.md](LICENSE-CONCEPTNET.md) を参照してください。

## 素材の準備

`tools/prepare_assets.sh` は取得済みの音源を実行時形式へ規格化します。
素材の取得自体は行いません。

```sh
./tools/prepare_assets.sh <raw-cc0-dir> <raw-extra-dir> <output-dir>
```

一方の素材群を処理しない場合は入力ディレクトリの代わりに `-` を渡します。
出力は `<output-dir>/cc0` と `<output-dir>/extra` へ分かれます。
追加素材を使う際は後者を `ZOOVOICE_EXTRA_ASSETS_DIR` に指定します。

処理内容は次のとおりです。

1. `-40dB` を閾値として先頭無音を除去する。
2. `0.5` 秒以上の内部無音で最初の鳴き声を切り出す。
3. `2.5` 秒を上限とし、末尾 `0.35` 秒を fade out する。
4. ピークを `-1dBFS` へ正規化する。
5. `24kHz`、mono、signed 16-bit PCM WAV へ変換する。

切り出し結果が0.15秒未満なら全長版へフォールバックします。
進捗はリポジトリ直下の `logs/zoovoice-prepare-assets.log` へ残します。
このスクリプトは取得条件を伴う素材準備用なので CI では実行しません。

## 同梱する CC0 素材

12件は Freesound の各配布ページから取得した CC0 音源です。
`assets/manifest.json` には取得時の元音源 SHA-256 と取得日も保存しています。

| 種 | タイトル | 作者 | 配布ページ |
| --- | --- | --- | --- |
| 犬 | Single Dog Bark | kwahmah_02 | [Freesound 277058](https://freesound.org/people/kwahmah_02/sounds/277058) |
| 猫 | Cat meow | philsapphire | [Freesound 256452](https://freesound.org/people/philsapphire/sounds/256452) |
| 牛 | Cow - Moo 5 - 96kHz.wav | JarredGibb | [Freesound 233134](https://freesound.org/people/JarredGibb/sounds/233134) |
| おんどり | Rooster crow | jsbarrett | [Freesound 200339](https://freesound.org/people/jsbarrett/sounds/200339) |
| 馬 | Horse | poodaddy69 | [Freesound 521246](https://freesound.org/people/poodaddy69/sounds/521246) |
| 羊 | sheep 3.mp3 | esperar | [Freesound 171149](https://freesound.org/people/esperar/sounds/171149) |
| ヤギ | Single Goat Bleating 2x | Kinoton | [Freesound 581240](https://freesound.org/people/Kinoton/sounds/581240) |
| カモ・アヒル | Toy Ducks Quacking | nebyoolae | [Freesound 348791](https://freesound.org/people/nebyoolae/sounds/348791) |
| カエル | Frog croaking sound effect | betterchinese | [Freesound 354132](https://freesound.org/people/betterchinese/sounds/354132) |
| コオロギ | Crickets chirping loop | Patrick_Corra | [Freesound 633196](https://freesound.org/people/Patrick_Corra/sounds/633196) |
| ゾウ | Elephant Trumpets Growls.flac | D.jones | [Freesound 527845](https://freesound.org/people/D.jones/sounds/527845) |
| ライオン | lion roar | bkyte | [Freesound 510476](https://freesound.org/people/bkyte/sounds/510476) |

各音源のライセンスは [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) です。

## repo 外の追加素材

小森平の動物効果音は repo に同梱しません。
素材ファイルの再配布を避け、利用環境が用意した規格化済み WAV だけを読み込みます。

- 取得元: [動物～フリー効果音・無料効果音素材](https://taira-komori.net/animals01.html)
- 利用規約: [無料効果音で遊ぼう！](https://taira-komori.net/welcome.html)

追加素材が存在する場合でも `/animals` は種と件数だけを返します。
合成結果以外から追加素材を取り出す経路は提供しません。

## Docker image

imageは`services/zoovoice/Dockerfile`で作ります。
モデルと連想indexはリポジトリへcommitしないため、buildはgit外の成果物を named context として受け取ります。

- `whisper_source`: 検証済みのwhisper.cppソース。commitは`5250a86fdebac4d51085fcfcd0b315cb0c6b91c9`に固定する
- `zoovoice_runtime`: `ggml-small.bin`、連想index、`LICENSE-CONCEPTNET.md`を置いた一時ディレクトリ

buildは`ggml-small.bin`と連想index、`assets/association-aliases.json`のSHA-256をimage内で照合します。
固定値はASRモデルが`1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`、連想indexが`91f5a07310b3791ebe3b0bab70cfd137c5388ff02dd291673f3fdd8313343344`です。
alias定義のSHA-256はリポジトリのファイルから算出して渡し、現在の値は`f879910acfac376ff7f09dc7309cc5886f94bc5771f897a8fb370fbabe014f2f`です。
whisper.cpp commit、3つのSHA-256、ライセンス識別子はimage labelにも残します。

最終imageに入るのは次だけです。

- Goバイナリと`whisper-cli`
- `ggml-small.bin`と連想index
- whisper.cppと連想indexのライセンス表示
- Debian runtime、CA証明書、ffmpeg
- リポジトリで追跡するCC0素材12件

リポジトリ外の追加素材、secret、開発用ファイルは含めません。
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

- schema世代
- ConceptNetのversion
- ライセンス
- 元データのSHA-256
- 変換内容
- `alias_sha256`とリポジトリの`assets/association-aliases.json`のSHA-256の一致

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
残りの項目はscriptが指定する値であり、production環境での適用結果は未確認です。

- region: `us-central1`
- private（`--no-allow-unauthenticated`、`allUsers`と`allAuthenticatedUsers`は不可）
- CPU 2、メモリ2GiB
- port 8080、timeout 90秒、concurrency 1
- min 0、max 2
- imageはtagではなくdigestを固定して指定する

invoker権限は、smoke専用のservice accountだけへservice単位で`roles/run.invoker`を付与します。
active developerのgcloudアカウントは、そのservice account上の`roles/iam.serviceAccountTokenCreator`だけを持ち、Cloud Run自体のinvoker権限は持ちません。

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

### 未実施の範囲

- Artifact Registryへのimage push
- GCP projectでのCloud Run resource作成とdeploy実行
- production invokerのIAM設定と本番反映
- production Cloudflare WorkerからCloud Runを呼ぶ認証方式

これらを終えるまでproduction readyとして扱いません。

## 検証

```sh
go vet ./...
go test ./...
```

統合テストには ffmpeg で生成した決定的な fixture を使います。
ASRとConceptNetはテスト用のfakeと小さな固定indexへ差し替えます。
repo 外の追加素材、実モデル、実indexがない環境でも全テストが通ります。

実モデルと実indexを使う通し確認は `tests/e2e/zoovoice-real-backend.spec.ts` です。
`ZOOVOICE_REAL_BACKEND=1` を付けた場合だけ実行し、それ以外の環境ではskipします。
このテストはWrangler localのWorker、Turnstileのtest key、native localのGoサービスを通し、録音から音声の再生とダウンロードまでをブラウザ操作で確認します。
日本語ASR、犬の直接連想、音声合成を含む1回の通しが成功しています。
所要時間はtest本体13.1秒、run全体13.7秒です。
この経路はDocker imageではなくnative localのGoサービスを使うため、上のlocal-only verificationとは測定条件が異なります。
