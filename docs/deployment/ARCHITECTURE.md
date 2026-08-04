# 現在のデプロイ構成

更新日: 2026-08-04

## 構成

Voice Labの公開版は、1つのCloudflare WorkerでSpeakLoopを配信する。UIはWorker Static Assets、認証・quota・API中継はWorker module、GPU推論はRunPod Serverlessが担当する。この構成はproduction公開環境へ反映済みである。

```text
Browser
  -> Cloudflare Worker Static Assets
       /, /speakloop
  -> Cloudflare Worker module
       Google OAuth / admin auth / quota / API gateway
       -> OpenAI API: native-language ASR / English practice ASR / translation / TTS
       -> RunPod Serverless: async dual-audio Chinese practice FunASR / Seed-VC
       -> KV: settings / short-lived jobs / fallback
       -> D1: quota / audit / public sample metadata
       -> R2: audio blobs
```

SpeakLoopのローカル版はFastAPIがUIとAPIを配信する。ZoovoiceのローカルUIとAPIはFastAPIを使わず、Wrangler localのWorkerとGoサービスで確認する。

## routeと認証

| route | 用途 | 公開版 |
| --- | --- | --- |
| `/` | ポータル | 公開 |
| `/speakloop` | SpeakLoop | 公開 |
| `/zoovoice` | Zoovoice | `ZOOVOICE_ENABLED=1` の配備だけ公開 |
| `/admin` | 総合管理 | 管理者認証必須 |
| `/speakloop/admin` | SpeakLoop管理 | 管理者認証必須 |

SpeakLoopの公開生成APIと管理画面は同じGoogle OAuthセッションを使う。`ADMIN_GOOGLE_EMAILS`または保存済み設定に含まれるemailだけを管理者とする。管理APIは匿名利用者を401、通常Googleユーザーを403で拒否する。管理者は公開quotaを消費しないが、入力サイズ上限は引き続き適用する。別の管理パスワードや管理者cookieは持たない。

## データ境界

- KV: 設定、短期job snapshot、ready状態、binding不足時のfallback
- D1: email hashを使うquota、監査イベント、公開サンプルmetadata
- R2: 管理者が登録したsample音声のblob
- RunPod: GPU jobの入力、途中progress、結果。長期保存の正にはしない

SpeakLoopの中国語比較はRunPodのjob IDをブラウザへ返し、WorkerまたはFastAPIがRunPod statusを都度中継する。Cloudflare側に練習音声やこのjob結果を履歴保存する必要はない。

詳細は [CLOUDFLARE.md](CLOUDFLARE.md)、[STORAGE.md](STORAGE.md)、[RUNPOD.md](RUNPOD.md) を参照する。

## Zoovoice

Zoovoiceは、録音した発話の内容から動物を1種だけ自動で選び、その鳴き声を発話のすき間へ重ねる機能である。GoサービスはprivateなCloud Runへdeploy済みである。公開Workerも有効化varsを含めてdeploy済みである。

この節はリポジトリの現在のコードの構成を示す。日本語ASRと動物の自動連想はGoサービスへ実装済みである。Cloud Runとproduction Workerへのdeployは完了しており、有効化varsも `wrangler.toml` へ設定済みである。外部操作と実環境smokeの状況はこの節の末尾に示す。機能仕様は [SPEC.md](../speech-translation/SPEC.md) を正とする。

### 用語

- アニマル度とは、鳴き声の挿入頻度を決める設定を指す。通常UIで利用者が変えられる設定はこれだけとする。
- 動物の自動連想とは、ASR本文から動物1種を自動で選ぶ処理を指す。
- 根拠語とは、その選択に使ったASR本文中の語を指す。
- 連想metadataとは、選ばれた動物と根拠語と選択方式を指す。random fallbackではその理由も含む。

Workerは `ZOOVOICE_ENABLED=1` の配備だけでZoovoiceの公開routeとAPIを提供する。この値が未設定または `1` 以外の配備では、`/zoovoice` は404、`/api/zoovoice/animals` と `/api/zoovoice/compose` は503を返す。`GET /api/zoovoice/config` はflagの状態を伝えるため、無効な配備でも応答する。現在のproduction `wrangler.toml` は `ZOOVOICE_ENABLED="1"` を設定している。

Google Cloud Run上のGoコンテナは、日本語ASR、動物の自動連想、音声合成をこの順で担当する。自動連想は `direct`、`pun`、`conceptnet`、`random_fallback` の4段を順に試す。`direct` は動物名や鳴き声の直接言及、`pun` は動物名の語が別の語句の一部として現れる語呂合わせである。`conceptnet` は形態素候補と隣接する内容語の連接を使う日本語ConceptNetの1-hopである。どの段でも決まらない入力は `random_fallback` にする。

連想と音声再生が参照する語彙は、リポジトリで追跡する生成物 `services/zoovoice/assets/animal-lexicon.json` を正とする。生成入力はConceptNet 5.7.0のassertions、採否を固定したAI判断の記録、採用音声のmanifestの3つとする。3つの入力のSHA-256は生成物のmetadataへ埋め込む。現在の対象は第1段階の27種である。Cloud Runはprivate IAMを前提とし、ブラウザからCloud Runへ直接送る経路は持たない。ローカルのsmoke確認では、gcloud service account impersonationで取得した短期ID tokenをlocal Wrangler経由でこのGoサービスへ渡す。

productionのWorkerは `ZOOVOICE_ORIGIN_MODE="cloud-run"` で動き、専用invoker service accountのkeyから自力でID tokenを取得してCloud Runを呼ぶ。invoker service accountには対象service単位の `roles/run.invoker` だけを付与し、`allUsers` へは付与しない。認証フローとsecret運用の詳細は [CLOUDFLARE.md](CLOUDFLARE.md) を正とする。この認証の実装と契約testは完了している。invoker service accountの作成と権限付与、key発行、Worker secretの登録も完了している。

```text
Browser
  -> Cloudflare Worker Static Assets
       /zoovoice
       /react/zoovoice-animals.json: 動物一覧
  -> Cloudflare Worker module
       Turnstile検証 / 利用上限 / Cloud Run向けID token
       -> Cloudflare Turnstile: token検証
       -> Google Cloud Run: 録音とアニマル度を一時送信
            日本語ASR -> 動物の自動連想 -> 音声合成
            <- 合成音声 / ASR本文 / 連想metadata
       -> D1: Zoovoice共通の日次・月次counter
```

ブラウザが送るのは録音とアニマル度だけとする。動物と挿入位置はCloud Run側が決めるため、ブラウザから配置設定を送らない。Workerは合成応答を中継し、ASR本文と連想metadataを送信元と同じブラウザへ返す。

動物一覧はCloud Runを起動せず、Worker Static Assetsの静的JSONから返す。この静的JSONは動物レキシコンから同期し、現在は27種を載せる。この経路では音声データを扱わない。

Cloud Runへ載せるDocker imageは、Goバイナリに加えて実行に必要なDebian runtime、CA証明書、ffmpegを含める。これに日本語ASR用のwhisper.cpp commandとモデル、versionを固定した日本語ConceptNet indexを加える。commandとモデルとindexはリポジトリで管理せず、build時にgit外の検証済みディレクトリから取り込む。取り込むcommitとSHA-256はbuildとdeploy scriptの両方で照合し、image labelへも残す。リポジトリで追跡する `services/zoovoice/assets/animal-lexicon.json` も、build時にSHA-256を照合してimage labelへ残す。

imageへ入れる音源素材は、リポジトリで追跡する `services/zoovoice/assets/animal-sounds/` の27件だけとする。動物1種につき規格化済みWAVを1本だけ同梱し、27件の合計は5,965,364 bytesである。内訳はStable Audioで生成した24件と、既存の連想評価を退行させないために残したCC0移行の3件である。素材の出所と採用hashは `services/zoovoice/assets/animal-sounds/manifest.json` を正とする。ConceptNet派生indexの帰属は `services/zoovoice/LICENSE-CONCEPTNET.md`、Stability AIの必須表示は `services/zoovoice/NOTICE-STABILITY-AI.md` を正とし、どちらも `/app/licenses` へ同梱する。公開UIはfooterへ `Powered by Stability AI` を表示する。secretと開発用ファイルはimageへ含めない。containerはnon-rootで実行する。

ASRモデル、ConceptNet index、必要な外部commandのいずれかが欠けた場合はエラーを返す。固定の動物へ黙って切り替えない。

D1へ追加するのは `zoovoice_usage_counters` テーブルだけである。対応するmigrationは `migrations/0004_zoovoice_usage_counters.sql` であり、本番D1へ適用済みである。データ境界は [PRIVACY.md](PRIVACY.md) を参照する。

ASR本文、根拠語、録音、生成音声は応答の生成に必要な間だけ扱う。これらの永続保存先は持たず、D1、R2、application logへ書かない。

Cloud Runのregionは `us-central1` とする。`scripts/deploy_zoovoice_cloud_run.sh` は次の値でdeployする。

- private（`--no-allow-unauthenticated`）
- CPU 2、メモリ2GiB
- port 8080、timeout 90秒、concurrency 1
- min 0、max 2
- imageはlocalでbuildし、`us-central1-docker.pkg.dev/<project>/voice-lab/zoovoice:<git-sha>` へpushする
- imageはtagではなくdigestを固定して指定する

Cloud RunへGit repositoryを接続する自動buildは使わない。container imageのbuildとpushはローカルの配備scriptだけが行う。

配備scriptの実行modeはdry-run、local-only verification、明示applyの3つとする。既定はdry-runであり、remote writeを行うのは明示applyだけである。scriptは実行前に、whisper.cpp commit、ASRモデルとConceptNet indexのSHA-256、index metadataを検査する。検査対象のmetadataはschema世代、ConceptNetのversion、ライセンスである。現在のschema世代は2である。加えて元データのSHA-256と変換内容も検査する。index metadataの `lexicon_sha256` が、リポジトリの `services/zoovoice/assets/animal-lexicon.json` のSHA-256と一致することも検査する。動物レキシコンを作り直した場合は、連想indexを作り直すまでこの検査で止まる。

上のCPUとメモリはlocal-only verificationで実測済みである。linux/amd64のCloud Run相当imageをlocal buildし、CPU 2とメモリ2GiBの上限付きでnon-root起動して測った。image sizeは1,053,233,511 bytes、compose完了後の観測メモリは359.4 MiB / 2 GiB、`/healthz` がreadyになるまでは1,350 msである。2.044秒の日本語fixtureの合成は23,826 msだった。同じ確認で、ASRモデルと連想indexがnon-rootから読めることも確かめた。

`whisper-cli` はDockerfileの `-DBUILD_SHARED_LIBS=OFF` により、whisper/ggmlのlibraryをstaticに組み込んでbuildしている。この確認では、`whisper-cli` がwhisper/ggmlを共有libraryとして要求しないことを確かめた。libstdc++・libm・libgcc_s・libc・動的loaderへは動的にlinkするため、完全なstatic binaryではない。

上の実測値は動物レキシコン導入前のimageに対するものである。動物音27件を同梱する現在のimageでは再測定していない。

この測定はApple Silicon上のlinux/amd64 emulationで行っている。合成時間はemulationの影響を受けるため、Cloud Runの実CPU上の値とは一致しない。上記の値はすべてこのlocal環境の実測であり、Cloud Run実機では未確認である。

Wrangler localからGoサービスまでの通しは、Playwrightのe2eで別途確認済みである。この確認はDocker imageではなくnative localのGoサービスを使い、Turnstileのtest keyを経由する。確認する経路は録音から日本語ASR、動物の直接連想、音声合成を経て再生とダウンロードまでである。この通しはtest本体13.1秒、run全体13.7秒で成功している。

Cloud Run側の反映はCloudflare Worker deployとは別の外部操作gateとして扱う。GCP project `mo-speech-501706` のus-central1へ、private Cloud Run service `zoovoice` をdeploy済みである。次のremote操作は完了している。

- privateなArtifact Registryへのcontainer image push
- GCP projectでのCloud Run resource作成とdeploy実行
- invoker service accountの作成と対象serviceへの `roles/run.invoker` 付与
- invoker service account keyの発行とWorker secret登録
- production Turnstile widgetの作成
- 有効化varsの `wrangler.toml` への追加
- 本番D1へのZoovoice counter migration適用
- 有効化varsを含むproduction Workerのdeploy

実環境smokeで確認済みなのは次の範囲である。

- 公開 `GET /api/zoovoice/config` が200を返し、有効な状態とTurnstile必須を示すこと
- 公開 `GET /api/zoovoice/animals` が200で27種を返すこと
- 公開 `/zoovoice` とZoovoice用JS assetが200で配信されること
- 実ブラウザでのUI表示、production Turnstile widgetの表示、`Powered by Stability AI` の表示
- private Cloud Runの `/animals` と実音声の `POST /compose` が認証付きrequestで200を返すこと
- 認証なしのCloud Run直接requestが403で拒否されること

Worker経由の実 `POST /api/zoovoice/compose` は未確認である。この経路の通過にはproduction Turnstileの人間操作が必要なためである。CAPTCHAは回避しないため、自動smokeの対象にしない。Worker側のID token交換とorigin requestは、fake endpointを使う契約testで固定している。この1件の人間確認を終えるまで、公開経路全体を実地確認済みとして扱わない。

## 将来の分割

productionでは単一Workerを正とする。staging用の `wrangler.toml` blockとdeploy workflowはrepositoryから削除済みで、現行deploy経路には含まない。過去に作成したremote staging Worker・D1・KV・R2は削除していない。stagingは製品の機能分割には数えない。
