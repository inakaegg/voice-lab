# Cloudflareデモ構成

## 目的

スマホから触れるデモでは、Web UI配信とAPI gatewayをCloudflare Workersへ置き、GPU推論だけをRunPod Serverlessへ送る。GPU PodでWebサーバーを常時起動しない。

この文書は現在のCloudflareデモ構成を説明する。発音練習アプリとSkitVoiceを分ける場合は、同一repoから2つのCloudflare projectまたはWorkerへデプロイする方針を [APP_SPLIT.md](APP_SPLIT.md) にまとめている。

```text
Browser
  -> Cloudflare Worker Static Assets
  -> Cloudflare Worker API gateway
  -> OpenAI API: ASR、翻訳、TTS、表示用テキスト加工、ジョークTTS
  -> RunPod Serverless Job API: Seed-VC、warmup
```

## 秘密情報

ブラウザへRunPod API keyを渡さない。Cloudflare Workerのsecretとして以下を設定する。

- `RUNPOD_API_KEY`
- `RUNPOD_ENDPOINT_ID`
- `OPENAI_API_KEY`

`RUNPOD_API_KEY` は可能なら対象endpointだけに権限を絞ったRestricted API keyにする。OpenAI API keyは、ASR、翻訳、TTS、表示用ひらがな、短いテキスト加工、ジョークTTSなどWorker側で完結する処理に使う。

## API gateway範囲

Workerは既存ユーザー画面が使う以下のAPI互換エンドポイントを提供する。

- `GET /api/runtime`
- `GET /api/user-settings`
- `POST /api/user-display-text`
- `POST /api/user-text-output`
- `POST /api/user-joke-output`
- `POST /api/translate-speech-jobs`
- `GET /api/translate-speech-jobs/{job_id}`
- `POST /api/voice-conversion-jobs`
- `GET /api/voice-conversion-jobs/{job_id}`
- `POST /api/warmup`

音声翻訳のASR、翻訳、TTSはCloudflare WorkerからOpenAI APIを直接呼び、POST時点で `succeeded` の完了jobとして返す。既存UIとの互換のため、完了job snapshotは短時間KVに保存し、`GET /api/translate-speech-jobs/{job_id}` でも同じ結果を返す。

Seed-VCとwarmupだけRunPod Serverlessの非同期jobへ中継する。RunPodのjob IDをUI向けjob IDとして返し、status pollingで既存UIの `queued`、`running`、`succeeded`、`failed` 形式へ変換する。

## ユーザー設定と履歴

Cloudflareデモでは、管理画面から保存するユーザー画面設定と短い音声履歴をWorkers KVへ保存する。KV binding は `MO_SPEECH_KV` とし、bindingが無い環境では従来どおり `USER_SETTINGS_JSON` とWorkerプロセス内の一時設定へfallbackする。

例:

```json
{
  "joke_texts": ["Aku cuma bercanda."],
  "joke_position": "after",
  "joke_selection": "rotation",
  "theme": "blue"
}
```

ジョーク候補は管理画面保存時に正規化し、`joke_variation_count` が1以上ならOpenAI Responses APIでバリエーションを生成して `joke_variants` と `joke_pool` に保存する。ユーザーの変換処理中にはバリエーション生成を行わない。

音声履歴は `/api/audio-history` 互換で返す。Cloudflare版では短いデモ音声だけを対象に、翻訳入力録音、翻訳出力、VC入力source音声、VC出力、ユーザー画面のテキストTTS、ジョークTTS、手動アップロード出力をKVへ保存する。保存件数は `CLOUDFLARE_AUDIO_HISTORY_LIMIT` で制御し、既定は入力と出力それぞれ100件。

KVは簡易デモ向けの保存先であり、大きい音声や長期保存には使わない。本番運用で履歴保存を続ける場合は、音声blobをR2、metadataをD1またはKVへ分ける。

## warmup

`GET /api/runtime` はRunPod `/health` を読むだけの確認APIとして扱う。これはRunPod jobを作らず、worker起動やSeed-VC preloadを要求しない。RunPod `/health` の `IDLE`、`READY` などはendpointまたはworkerの存在確認には使えるが、それだけでSeed-VCモデルがworker process内にresident load済みとは判定しない。

`POST /api/warmup` はRunPod Serverlessへ `operation_mode=warmup` を投げる。これはRunPod jobを作成するため、`workers-min=0` の場合でもworker起動、image/container準備、Seed-VC preloadが起こり得る。つまりデモ前にcold startとモデルロードを前倒しできる一方で、実行中とidle timeoutまでのGPU課金対象になり得る。

RunPod endpointはFlashBootを有効にしてcontainer cold start短縮を狙う。ただしFlashBootはSeed-VCの実推論や初回モデルロードそのものを必ず消す機能ではないため、体感が遅い場合はwarmup job、`serverless_timings_ms`、`timings_ms.voice_conversion` を分けて確認する。

ユーザー画面は既定ではページロード後に `POST /api/warmup` を投げない。ユーザー画面の準備状態は小さい状態ドットだけにし、未準備でも録音送信時の実変換jobでRunPodが起動する。デモ前にcold startとSeed-VC preloadを前倒ししたい場合は、管理者用画面 `/admin` の手動準備ボタンから `POST /api/warmup` を実行する。検証用途などでユーザー画面ロード時の自動warmupを戻したい場合だけ、`RUNPOD_AUTO_WARMUP_ON_USER_LOAD=1` を明示設定する。

warmup jobまたはSeed-VC voice conversion jobが成功し、レスポンス上で `providers.voice_conversion=seed-vc` またはVC出力が確認できた場合だけ、Cloudflare KVへ短時間のVC ready状態を保存する。ready状態は `RUNPOD_ENDPOINT_ID` ごとに分けて保存し、GPUやendpointを切り替えた後に旧endpointのready状態を流用しない。既定TTLは `RUNPOD_WARMUP_READY_TTL_SECONDS` または300秒とし、期限切れ後は `/api/runtime` がworkerを見つけても `model_resident=false` として返す。

ページ表示そのものはCloudflare側で完了するため、ページが表示されたことはRunPod workerのwarm完了シグナルにはならない。RunPodの準備状態は `/api/runtime` と `/api/warmup` の結果で見る。

## デプロイ

`wrangler.toml` のStatic Assetsで `src/mo_speech/web` を配信し、Worker moduleで `/api/*` を処理する。`/` はユーザー画面の `user.html`、`/admin` は管理画面の `index.html` へ振り分ける必要があるため、Static Assetsの `run_worker_first` を有効にする。Cloudflare AssetsのHTML clean URL redirectで `/user.html` が `/user` へ変換されると既存URL互換が崩れるため、`html_handling="none"` にする。秘密情報はリポジトリへ書かず、`wrangler secret put` で登録する。

2アプリ化後は、発音練習アプリとSkitVoiceで `wrangler.toml`、Worker名、secret、KV/D1/R2 bindingを分ける。発音練習側はRunPod secretを持たず、SkitVoice側だけRunPod endpointとGPU推論用secretを持つ。

SkitVoice単体公開では、公開ページを `/`、管理画面を `/admin` とする。`/admin` はCloudflare AccessのAccess applicationとしてpath単位で保護し、Googleをidentity providerに設定したうえで、管理者本人のGoogleアカウントだけをAllow policyに含める。`/` と生成APIのうち公開画面に必要な範囲は認証なしで使えるようにし、詳細設定、診断、履歴、warmupなど管理操作は `/admin` 側へ寄せる。

```sh
wrangler secret put RUNPOD_API_KEY
wrangler secret put RUNPOD_ENDPOINT_ID
wrangler secret put OPENAI_API_KEY
wrangler deploy
```

## 制限

- `MO_SPEECH_KV` binding が無い環境では、管理画面の設定保存と音声履歴は永続化しない。
- 大きい録音ファイルはWorkerとRunPodのrequest size制限を受ける。ユーザー画面では短い録音を前提にする。
- OpenAI ASR、翻訳、TTSはWorker内で同期実行するため、細かいstage progressはUI側の推定表示になる。
- Seed-VCはRunPod endpointのqueue-based Serverlessを使うため、VC処理中の細かいstage progressはRunPod job statusから推定する。
