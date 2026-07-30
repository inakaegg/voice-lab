# 現在のデプロイ構成

更新日: 2026-07-30

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

## 将来の分割

productionでは単一Workerを正とする。staging Workerは別resourceで配備し、必須Worker secretも登録済みである。stagingは製品の機能分割には数えない。
