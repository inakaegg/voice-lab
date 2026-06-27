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

## ユーザー設定

初回デモでは永続的な管理画面保存をCloudflare側へ移植しない。ユーザー画面設定は `USER_SETTINGS_JSON` 変数で渡す。

例:

```json
{
  "joke_texts": ["Aku cuma bercanda."],
  "joke_position": "after",
  "joke_selection": "rotation",
  "theme": "blue"
}
```

Cloudflare側で管理画面から保存するには、次段階でKVまたはD1を追加する。音声履歴も同様に、R2とmetadata storeを追加するまではCloudflareデモ範囲外とする。

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

- Cloudflareデモでは管理画面の設定保存と音声履歴は永続化しない。
- 大きい録音ファイルはWorkerとRunPodのrequest size制限を受ける。ユーザー画面では短い録音を前提にする。
- RunPod endpointはqueue-based Serverlessのまま使うため、処理中の細かいstage progressはRunPod job statusから推定する。
