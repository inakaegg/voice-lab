# 現在のデプロイ構成

更新日: 2026-08-02

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

ローカル版はFastAPIがUIとAPIを配信する。

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

Zoovoiceは録音した発話のすき間へ動物の鳴き声を重ねる機能である。実装はリポジトリにあるが、公開環境へはdeployしていない。

Workerは `ZOOVOICE_ENABLED=1` の配備だけでZoovoiceの公開routeとAPIを提供する。この値が未設定または `1` 以外の配備では、`/zoovoice` は404、`/api/zoovoice/animals` と `/api/zoovoice/compose` は503を返す。`GET /api/zoovoice/config` はflagの状態を伝えるため、無効な配備でも応答する。現在のproduction `wrangler.toml` には `ZOOVOICE_ENABLED` を設定していない。

合成本体はGoogle Cloud Run上のGoコンテナが担当する。Cloud Runはprivate IAMを前提とし、ブラウザからCloud Runへ直接送る経路は持たない。ローカルのsmoke確認では、gcloud service account impersonationで取得した短期ID tokenをlocal Wrangler経由でこのGoサービスへ渡す経路だけを実装済みである。productionのCloudflare WorkerがCloud Runを呼ぶ際の認証方式は未決定であり、未実装である。

```text
Browser
  -> Cloudflare Worker Static Assets
       /zoovoice
       /react/zoovoice-animals.json: 動物一覧
  -> Cloudflare Worker module
       Turnstile検証 / 利用上限 / Cloud Run向けID token
       -> Cloudflare Turnstile: token検証
       -> Google Cloud Run: 録音を一時送信して合成
       -> D1: Zoovoice共通の日次・月次counter
```

動物一覧はCloud Runを起動せず、Worker Static Assetsの静的JSONから返す。この経路では音声データを扱わない。

Cloud Runへ載せるDocker imageは、Goバイナリに加えて実行に必要なDebian runtime、CA証明書、ffmpegを含める。imageへ入れる音源素材は、リポジトリで追跡するCC0音源だけとする。素材の出所と取得時hashは `services/zoovoice/assets/manifest.json` と `services/zoovoice/README.md` を参照する。リポジトリ外の追加素材とsecretはimageへ含めない。

D1へ追加するのは `zoovoice_usage_counters` テーブルだけである。対応するmigrationは `migrations/0004_zoovoice_usage_counters.sql` であり、本番D1へは未適用である。データ境界は [PRIVACY.md](PRIVACY.md) を参照する。

Cloud Runのregionは `us-central1` とする。`services/zoovoice/README.md` の配備scriptは、この契約でdeployする。

- private（`--no-allow-unauthenticated`）
- CPU 1、メモリ512Mi
- port 8080、timeout 90秒、concurrency 1
- min 0、max 2
- imageはtagではなくdigestを固定して指定する

Cloud Run側の実際の反映はCloudflare Worker deployとは別の外部操作gateとして扱う。次はいずれも未実施である。

- Artifact Registryへのcontainer image実push（配備scriptのdry-run確認までは実施済み）
- GCP projectでのCloud Run resource作成とdeploy実行
- production Cloud Run invokerのIAM設定
- production Cloudflare WorkerからCloud Runを呼ぶ認証方式の確定と実装

## 将来の分割

productionでは単一Workerを正とする。staging用の `wrangler.toml` blockとdeploy workflowはrepositoryから削除済みで、現行deploy経路には含まない。過去に作成したremote staging Worker・D1・KV・R2は削除していない。stagingは製品の機能分割には数えない。
