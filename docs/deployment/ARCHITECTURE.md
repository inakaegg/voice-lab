# 現在のデプロイ構成

更新日: 2026-07-17

## 構成

Voice Labの公開版は、1つのCloudflare WorkerでSpeakLoopとSkitVoiceの非公開案内を配信する。一般ユーザー向け製品はSpeakLoopだけで、SkitVoiceの生成・sample・statusは管理者研究境界へ閉じる。UIはWorker Static Assets、認証・quota・API中継はWorker module、GPU推論はRunPod Serverlessが担当する。この構成はproduction公開環境へ反映済みである。

```text
Browser
  -> Cloudflare Worker Static Assets
       /, /speakloop, /skitvoice
  -> Cloudflare Worker module
       Google OAuth / admin auth / quota / API gateway
       -> OpenAI API: native-language ASR / English practice ASR / translation / TTS
       -> RunPod Serverless: async dual-audio Chinese practice FunASR / admin-only VibeVoice / Seed-VC
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
| `/skitvoice` | 研究機能の非公開案内。生成・sampleなし | 公開 |
| `/admin` | 総合管理 | 管理者認証必須 |
| `/speakloop/admin` | SpeakLoop管理 | 管理者認証必須 |
| `/skitvoice/admin` | SkitVoice管理 | 管理者認証必須 |
| `/fun` | 実験画面 | 管理者認証必須 |

SpeakLoopの公開生成APIと管理画面は同じGoogle OAuthセッションを使う。`ADMIN_GOOGLE_EMAILS`または保存済み設定に含まれるemailだけを管理者とし、管理route、VibeVoiceを含む管理API、`/fun`へのアクセスを許可する。VibeVoice APIは匿名利用者を401、通常Googleユーザーを403で拒否する。管理者は公開quotaを消費しないが、入力サイズ上限は引き続き適用する。別の管理パスワードや管理者cookieは持たない。

## データ境界

- KV: 設定、短期job snapshot、ready状態、binding不足時のfallback
- D1: email hashを使うquota、監査イベント、公開サンプルmetadata
- R2: 管理者が登録したsample音声のblob。由来未確認のSkitVoice sampleは一般向けAPIから除外
- RunPod: GPU jobの入力、途中progress、結果。長期保存の正にはしない

SpeakLoopの中国語比較はRunPodのjob IDをブラウザへ返し、WorkerまたはFastAPIがRunPod statusを都度中継する。Cloudflare側に練習音声やこのjob結果を履歴保存する必要はない。

詳細は [CLOUDFLARE.md](CLOUDFLARE.md)、[STORAGE.md](STORAGE.md)、[RUNPOD.md](RUNPOD.md) を参照する。

## 将来の分割

現時点では単一Workerを正とする。障害、費用、secret、デプロイ頻度を別々に管理する必要が生じた場合だけ、[APP_SPLIT.md](APP_SPLIT.md) の条件で分割を検討する。
