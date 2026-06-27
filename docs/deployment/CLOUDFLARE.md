# Cloudflareデモ構成

## 目的

スマホから触れるデモでは、Web UI配信とAPI gatewayをCloudflare Workersへ置き、GPU推論だけをRunPod Serverlessへ送る。GPU PodでWebサーバーを常時起動しない。

```text
Browser
  -> Cloudflare Worker Static Assets
  -> Cloudflare Worker API gateway
  -> RunPod Serverless Job API
```

## 秘密情報

ブラウザへRunPod API keyを渡さない。Cloudflare Workerのsecretとして以下を設定する。

- `RUNPOD_API_KEY`
- `RUNPOD_ENDPOINT_ID`
- `OPENAI_API_KEY`

`RUNPOD_API_KEY` は可能なら対象endpointだけに権限を絞ったRestricted API keyにする。OpenAI API keyは、表示用ひらがな、短いテキスト加工、ジョークTTSなどWorker側で完結する軽量処理に使う。

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

音声翻訳、TTS、VC本体はRunPod Serverlessの非同期jobへ中継する。RunPodのjob IDをそのままUI向けjob IDとして返し、status pollingで既存UIの `queued`、`running`、`succeeded`、`failed` 形式へ変換する。

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

音声履歴は `/api/audio-history` 互換で返す。Cloudflare版では短いデモ音声だけを対象に、録音、RunPod完了出力、ユーザー画面のテキストTTS、ジョークTTSをKVへ保存する。保存件数は `CLOUDFLARE_AUDIO_HISTORY_LIMIT` で制御し、既定は各10件。

KVは簡易デモ向けの保存先であり、大きい音声や長期保存には使わない。本番運用で履歴保存を続ける場合は、音声blobをR2、metadataをD1またはKVへ分ける。

## warmup

`POST /api/warmup` はRunPod Serverlessへ `operation_mode=warmup` を投げる。`workers-min=0` の場合、デモ前に一度warmupを呼ぶことでcold startとモデルロードを前倒しできる。

ページ表示そのものはCloudflare側で完了するため、ページが表示されたことはRunPod workerのwarm完了シグナルにはならない。RunPodの準備状態は `/api/runtime` と `/api/warmup` の結果で見る。

## デプロイ

`wrangler.toml` のStatic Assetsで `src/mo_speech/web` を配信し、Worker moduleで `/api/*` を処理する。`/` はユーザー画面の `user.html`、`/admin` は管理画面の `index.html` へ振り分ける必要があるため、Static Assetsの `run_worker_first` を有効にする。Cloudflare AssetsのHTML clean URL redirectで `/user.html` が `/user` へ変換されると既存URL互換が崩れるため、`html_handling="none"` にする。秘密情報はリポジトリへ書かず、`wrangler secret put` で登録する。

```sh
wrangler secret put RUNPOD_API_KEY
wrangler secret put RUNPOD_ENDPOINT_ID
wrangler secret put OPENAI_API_KEY
wrangler deploy
```

## 制限

- `MO_SPEECH_KV` binding が無い環境では、管理画面の設定保存と音声履歴は永続化しない。
- 大きい録音ファイルはWorkerとRunPodのrequest size制限を受ける。ユーザー画面では短い録音を前提にする。
- RunPod endpointはqueue-based Serverlessのまま使うため、処理中の細かいstage progressはRunPod job statusから推定する。
