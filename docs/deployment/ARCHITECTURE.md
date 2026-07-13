# 現在のデプロイ構成

更新日: 2026-07-13

## 構成

Voice Labの公開版は、1つのCloudflare WorkerでSpeakLoopとSkitVoiceを配信する。UIはWorker Static Assets、認証・quota・API中継はWorker module、GPU推論はRunPod Serverlessが担当する。

```text
Browser
  -> Cloudflare Worker Static Assets
       /, /speakloop, /skitvoice
  -> Cloudflare Worker module
       Google OAuth / admin auth / quota / API gateway
       -> OpenAI API: ASR / translation / TTS
       -> RunPod Serverless: VibeVoice / Seed-VC
       -> KV: settings / short-lived jobs / fallback
       -> D1: quota / audit / public sample metadata
       -> R2: audio blobs
```

ローカル版はFastAPIがUIとAPIを配信する。URL参照音声はローカルFastAPI上の`yt-dlp`と`ffmpeg`だけが取得し、音声bytesへ変換してからRunPodへ渡す。

## routeと認証

| route | 用途 | 公開版 |
| --- | --- | --- |
| `/` | ポータル | 公開 |
| `/speakloop` | SpeakLoop | 公開 |
| `/skitvoice` | SkitVoice | 公開 |
| `/admin` | 総合管理 | 管理者認証必須 |
| `/speakloop/admin` | SpeakLoop管理 | 管理者認証必須 |
| `/skitvoice/admin` | SkitVoice管理 | 管理者認証必須 |
| `/fun` | 実験画面 | 管理者認証必須 |

公開画面の生成APIは、設定に応じてGoogle OAuthを要求する。管理画面のパスワード認証とは別のセッションである。

## データ境界

- KV: 設定、短期job snapshot、ready状態、binding不足時のfallback
- D1: email hashを使うquota、監査イベント、公開サンプルmetadata
- R2: 管理者が登録した公開サンプル音声のblob
- RunPod: GPU jobの入力と結果。長期保存の正にはしない

詳細は [CLOUDFLARE.md](CLOUDFLARE.md)、[STORAGE.md](STORAGE.md)、[RUNPOD.md](RUNPOD.md) を参照する。

## 将来の分割

現時点では単一Workerを正とする。障害、費用、secret、デプロイ頻度を別々に管理する必要が生じた場合だけ、[APP_SPLIT.md](APP_SPLIT.md) の条件で分割を検討する。
