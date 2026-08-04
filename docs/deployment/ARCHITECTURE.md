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

Zoovoiceは、録音した発話の内容から動物を1種だけ自動で選び、その鳴き声を発話のすき間へ重ねる機能である。公開環境へはdeployしていない。

この節はリポジトリの現在のコードの構成を示す。日本語ASRと動物の自動連想はGoサービスへ実装済みである。Cloud Runへのdeployと本番有効化は未実施であり、外部操作gateとして扱う。機能仕様は [SPEC.md](../speech-translation/SPEC.md) を正とする。

### 用語

- アニマル度とは、鳴き声の挿入頻度を決める設定を指す。通常UIで利用者が変えられる設定はこれだけとする。
- 動物の自動連想とは、ASR本文から動物1種を自動で選ぶ処理を指す。
- 根拠語とは、その選択に使ったASR本文中の語を指す。
- 連想metadataとは、選ばれた動物と根拠語と選択方式を指す。random fallbackではその理由も含む。

Workerは `ZOOVOICE_ENABLED=1` の配備だけでZoovoiceの公開routeとAPIを提供する。この値が未設定または `1` 以外の配備では、`/zoovoice` は404、`/api/zoovoice/animals` と `/api/zoovoice/compose` は503を返す。`GET /api/zoovoice/config` はflagの状態を伝えるため、無効な配備でも応答する。現在のproduction `wrangler.toml` には `ZOOVOICE_ENABLED` を設定していない。

Google Cloud Run上のGoコンテナは、日本語ASR、動物の自動連想、音声合成をこの順で担当する。自動連想は `direct`、`pun`、`conceptnet`、`random_fallback` の4段を順に試す。`direct` は動物名や鳴き声の直接言及、`pun` はaliasが別の語の一部として現れる語呂合わせである。`conceptnet` は形態素候補と隣接する内容語の連接を使う日本語ConceptNetの1-hopである。どの段でも決まらない入力は `random_fallback` にする。Cloud Runはprivate IAMを前提とし、ブラウザからCloud Runへ直接送る経路は持たない。ローカルのsmoke確認では、gcloud service account impersonationで取得した短期ID tokenをlocal Wrangler経由でこのGoサービスへ渡す。

productionのWorkerは `ZOOVOICE_ORIGIN_MODE="cloud-run"` で動き、専用invoker service accountのkeyから自力でID tokenを取得してCloud Runを呼ぶ。invoker service accountには対象service単位の `roles/run.invoker` だけを付与し、`allUsers` へは付与しない。認証フローとsecret運用の詳細は [CLOUDFLARE.md](CLOUDFLARE.md) を正とする。この認証の実装と契約testは完了している。実keyの発行、Cloud Runへの実deploy、本番有効化は未実施の外部操作である。

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

動物一覧はCloud Runを起動せず、Worker Static Assetsの静的JSONから返す。この経路では音声データを扱わない。

Cloud Runへ載せるDocker imageは、Goバイナリに加えて実行に必要なDebian runtime、CA証明書、ffmpegを含める。これに日本語ASR用のwhisper.cpp commandとモデル、versionを固定した日本語ConceptNet indexを加える。commandとモデルとindexはリポジトリで管理せず、build時にgit外の検証済みディレクトリから取り込む。取り込むcommitとSHA-256はbuildとdeploy scriptの両方で照合し、image labelへも残す。リポジトリで追跡する `services/zoovoice/assets/association-aliases.json` も、build時にSHA-256を照合してimage labelへ残す。

imageへ入れる音源素材は、リポジトリで追跡するCC0音源だけとする。素材の出所と取得時hashは `services/zoovoice/assets/manifest.json` と `services/zoovoice/README.md` を参照する。ConceptNet派生indexの帰属と再配布条件は `services/zoovoice/LICENSE-CONCEPTNET.md` を正とし、同じ内容をimageへ同梱する。リポジトリ外の追加素材とsecretはimageへ含めない。containerはnon-rootで実行する。

ASRモデル、ConceptNet index、必要な外部commandのいずれかが欠けた場合はエラーを返す。固定の動物へ黙って切り替えない。

D1へ追加するのは `zoovoice_usage_counters` テーブルだけである。対応するmigrationは `migrations/0004_zoovoice_usage_counters.sql` であり、本番D1へは未適用である。データ境界は [PRIVACY.md](PRIVACY.md) を参照する。

ASR本文、根拠語、録音、生成音声は応答の生成に必要な間だけ扱う。これらの永続保存先は持たず、D1、R2、application logへ書かない。

Cloud Runのregionは `us-central1` とする。`scripts/deploy_zoovoice_cloud_run.sh` は次の値でdeployする。

- private（`--no-allow-unauthenticated`）
- CPU 2、メモリ2GiB
- port 8080、timeout 90秒、concurrency 1
- min 0、max 2
- imageはtagではなくdigestを固定して指定する

配備scriptの実行modeはdry-run、local-only verification、明示applyの3つとする。既定はdry-runであり、remote writeを行うのは明示applyだけである。scriptは実行前に、whisper.cpp commit、ASRモデルとConceptNet indexのSHA-256、index metadataを検査する。検査対象のmetadataはschema世代、ConceptNetのversion、ライセンスである。加えて元データのSHA-256と変換内容も検査する。index metadataの `alias_sha256` が、リポジトリの `association-aliases.json` のSHA-256と一致することも検査する。

上のCPUとメモリはlocal-only verificationで実測済みである。linux/amd64のCloud Run相当imageをlocal buildし、CPU 2とメモリ2GiBの上限付きでnon-root起動して測った。image sizeは1,053,233,511 bytes、compose完了後の観測メモリは359.4 MiB / 2 GiB、`/healthz` がreadyになるまでは1,350 msである。2.044秒の日本語fixtureの合成は23,826 msだった。同じ確認で、ASRモデルと連想indexがnon-rootから読めることも確かめた。

`whisper-cli` はDockerfileの `-DBUILD_SHARED_LIBS=OFF` により、whisper/ggmlのlibraryをstaticに組み込んでbuildしている。この確認では、`whisper-cli` がwhisper/ggmlを共有libraryとして要求しないことを確かめた。libstdc++・libm・libgcc_s・libc・動的loaderへは動的にlinkするため、完全なstatic binaryではない。

この測定はApple Silicon上のlinux/amd64 emulationで行っている。合成時間はemulationの影響を受けるため、Cloud Runの実CPU上の値とは一致しない。上記の値はすべてこのlocal環境の実測であり、Cloud Run実機では未確認である。

Wrangler localからGoサービスまでの通しは、Playwrightのe2eで別途確認済みである。この確認はDocker imageではなくnative localのGoサービスを使い、Turnstileのtest keyを経由する。確認する経路は録音から日本語ASR、動物の直接連想、音声合成を経て再生とダウンロードまでである。この通しはtest本体13.1秒、run全体13.7秒で成功している。

Cloud Run側の実際の反映はCloudflare Worker deployとは別の外部操作gateとして扱う。production WorkerのCloud Run認証は方式の決定と実装が完了しており、残るのは次のremote操作である。いずれも未実施である。

- Artifact Registryへのcontainer image実push
- GCP projectでのCloud Run resource作成とdeploy実行
- invoker service accountの作成と対象serviceへの `roles/run.invoker` 付与
- invoker service account keyの発行とWorker secret登録
- production Turnstile widgetの作成
- 本番D1へのZoovoice counter migration適用
- 有効化varsのcommitとmain経由deploy
- 実環境での最小smoke確認

これらを終えるまでproduction readyとして扱わない。

## 将来の分割

productionでは単一Workerを正とする。staging用の `wrangler.toml` blockとdeploy workflowはrepositoryから削除済みで、現行deploy経路には含まない。過去に作成したremote staging Worker・D1・KV・R2は削除していない。stagingは製品の機能分割には数えない。
