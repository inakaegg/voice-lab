# Cloudflareデモ構成

## 目的

スマホから触れるデモでは、Web UI配信とAPI gatewayをCloudflare Workersへ置き、GPU推論だけをRunPod Serverlessへ送る。GPU PodでWebサーバーを常時起動しない。

この文書は現在のCloudflareデモ構成を説明する。発音練習アプリとSkitVoiceを分ける場合は、同一repoから2つのCloudflare projectまたはWorkerへデプロイする方針を [APP_SPLIT.md](APP_SPLIT.md) にまとめている。第三者が触って評価しやすい公開デモとして整えるための改善順は [PUBLIC_DEMO_ROADMAP.md](PUBLIC_DEMO_ROADMAP.md) を参照する。

```text
Browser
  -> Cloudflare Worker Static Assets
  -> Cloudflare Worker API gateway
  -> OpenAI API: ASR、翻訳、TTS、表示用テキスト加工、ジョークTTS
  -> RunPod Serverless Job API: Seed-VC、SkitVoice/VibeVoice、warmup
```

## 秘密情報

ブラウザへRunPod API keyを渡さない。Cloudflare Workerのsecretとして以下を設定する。

- `RUNPOD_API_KEY`
- `RUNPOD_ENDPOINT_ID`
- `OPENAI_API_KEY`
- `ADMIN_PASSWORD_SHA256`
- `ADMIN_SESSION_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `PUBLIC_SESSION_SECRET`
- `ADMIN_GOOGLE_EMAILS`

`RUNPOD_API_KEY` は可能なら対象endpointだけに権限を絞ったRestricted API keyにする。OpenAI API keyは、ASR、翻訳、TTS、表示用ひらがな、短いテキスト加工、ジョークTTSなどWorker側で完結する処理に使う。

`ADMIN_PASSWORD_SHA256` は管理画面ログイン用パスワードのSHA-256 hex digestである。平文パスワードはsecretにもリポジトリにも保存しない。`ADMIN_SESSION_SECRET` は管理セッションcookieへ署名するためのランダム文字列で、パスワードとは別の値にする。

`GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` は、公開デモで生成APIをGoogleログイン必須にするためのOAuth clientである。`PUBLIC_SESSION_SECRET` は公開ユーザーのログインcookie署名に使う。未設定の場合は `ADMIN_SESSION_SECRET` にfallbackできるが、公開運用では別値を推奨する。`ADMIN_GOOGLE_EMAILS` は、quota対象外にする管理者Googleアカウントをカンマ区切りで指定する。管理画面側の設定にも管理者メールを追加でき、secret側とKV設定側の和集合を管理者扱いにする。保存後は管理画面に保存済み表示とquota対象外メール件数を出し、同じメールでGoogleログイン済みの公開ユーザーは次の生成リクエストからquota消費なしで通す。

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
- `GET /api/vibevoice/status`
- `POST /api/vibevoice/jobs`
- `GET /api/vibevoice/jobs/{job_id}`
- `POST /api/vibevoice/jobs/{job_id}/cancel`
- `POST /api/warmup`

音声翻訳のASR、翻訳、TTSはCloudflare WorkerからOpenAI APIを直接呼び、POST時点で `succeeded` の完了jobとして返す。既存UIとの互換のため、完了job snapshotは短時間KVに保存し、`GET /api/translate-speech-jobs/{job_id}` でも同じ結果を返す。

Seed-VC、SkitVoice/VibeVoice、warmupはRunPod Serverlessの非同期jobへ中継する。RunPodのjob IDをUI向けjob IDとして返し、status pollingで既存UIの `queued`、`running`、`succeeded`、`failed` 形式へ変換する。

SkitVoiceの公開UIでは、参照音声はファイルアップロードまたはブラウザのマイク録音で指定する。YouTubeなどの動画URL取得は、Cloudflare WorkerやRunPodのdatacenter IPからbot確認、地域制限、ログイン要求を受けやすく、公開デモの安定機能として扱わない。そのため公開UIにはURL入力を表示せず、WorkerのVibeVoice生成APIも `voice_url_1` から `voice_url_4` を受け取った場合はRunPodへ送らずに拒否する。RunPod handlerもURL取得を行わず、参照音声は `audio_base64` として受け取る。`POST /api/vibevoice/reference-audio-from-url` もCloudflare版では利用不可とし、URLからの切り出しはローカルFastAPI版または管理者の事前素材作成だけで扱う。

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

## 公開デモのGoogleログインとquota

公開デモとして共有する場合、ページ閲覧自体は誰でも可能にし、OpenAI APIやRunPod課金が発生する生成APIだけをGoogleログイン必須にする。招待コードは共有URLから訪問する初回利用者の体験に向かないため使わない。

公開生成の制御はWorker内で行う。

- `PUBLIC_GOOGLE_AUTH_REQUIRED=1` または管理画面設定でGoogleログイン必須にする。
- ログイン済みGoogleアカウントのemail単位で、feature別の日次回数と累計回数を `MO_SPEECH_KV` に保存する。
- `ADMIN_GOOGLE_EMAILS` または管理画面設定の管理者メールに含まれるアカウントは、日次・累計quotaを消費しない。
- quota対象は、SpeakLoop録音、従来の音声変換/TTS、Seed-VC変換、SkitVoice生成APIである。
- job status polling、静的ページ表示、runtime確認、管理画面閲覧は公開quotaを消費しない。
- Google OAuth設定が不足している状態でGoogleログイン必須にした場合、生成APIは `503` を返す。課金APIを開放したまま失敗するより、fail closedを優先する。

公開quotaと入力上限はKVに `public-access-settings` として保存する。admin画面から以下を変更できるようにする。

- Googleログイン必須のON/OFF
- quota対象外にする管理者Google email
- SpeakLoopの日次/累計回数、録音最大byte数、対象文最大文字数
- SkitVoiceの日次/累計回数、台本最大文字数、参照音声最大byte数
- へんな変換/翻訳/TTSの日次/累計回数、録音最大byte数、テキスト最大文字数
- Seed-VCの日次/累計回数、source/reference音声最大byte数

入力上限は生成前に検証する。上限超過はquotaを消費しない。quota消費は入力検証後、外部APIやRunPodへ送る直前に行う。Workers KVは厳密なatomic incrementを持たないため、同時アクセスが集中すると数回分の誤差は起こり得る。この構成は公開デモの過剰利用防止を目的とし、厳密な課金制御を目的にしない。課金機能へ進む場合はD1またはDurable Objectsで使用量台帳を分ける。

公開Googleログインとquota判定は監査用にKVへ最近のイベントを保存する。保存先は `public-audit-log` で、管理APIからのみ読める。記録対象は、Googleログイン成功、ログアウト、quota消費、quota上限ブロック、管理者emailによるquota免除、公開アクセス設定の更新、公開サンプル音声設定の登録・削除である。イベントには時刻、Google email、feature、API path、quota使用数、上限値を含める。音声、台本、入力本文、OAuth token、raw IP addressは保存しない。これは公開デモの過剰利用確認と簡易トラブルシュートを目的にしたもので、法的な監査証跡や課金台帳としては扱わない。厳密な監査が必要になった場合はD1または外部ログ基盤へ移す。

公開ページに表示するサンプル出力音声は `public-sample-audios` としてKVへ保存する。管理画面 `/admin`、`/speakloop/admin`、`/skitvoice/admin` からfeature別に1件ずつ登録でき、公開ページは `GET /api/public-sample-audios` で読み取る。保存対象はタイトル、説明、音声MIME、base64音声、元ファイル名である。保存済みサンプルは管理画面からfeature単位で削除でき、Workerは `DELETE /api/public-sample-audios/:feature` で該当featureを `null` に戻す。サンプル音声は公開表示前提なので、機密音声や第三者権利が不明な音声を置かない。

## warmup

`GET /api/runtime` はRunPod `/health` を読むだけの確認APIとして扱う。これはRunPod jobを作らず、worker起動やSeed-VC preloadを要求しない。RunPod `/health` の `IDLE`、`READY` などはendpointまたはworkerの存在確認には使えるが、それだけでSeed-VCモデルがworker process内にresident load済みとは判定しない。

`POST /api/warmup` はRunPod Serverlessへ `operation_mode=warmup` を投げる。これはRunPod jobを作成するため、`workers-min=0` の場合でもworker起動、image/container準備、Seed-VC preloadが起こり得る。つまりデモ前にcold startとモデルロードを前倒しできる一方で、実行中とidle timeoutまでのGPU課金対象になり得る。

RunPod endpointはFlashBootを有効にしてcontainer cold start短縮を狙う。ただしFlashBootはSeed-VCの実推論や初回モデルロードそのものを必ず消す機能ではないため、体感が遅い場合はwarmup job、`serverless_timings_ms`、`timings_ms.voice_conversion` を分けて確認する。

ユーザー画面は既定ではページロード後に `POST /api/warmup` を投げない。ユーザー画面の準備状態は小さい状態ドットだけにし、未準備でも録音送信時の実変換jobでRunPodが起動する。デモ前にcold startとSeed-VC preloadを前倒ししたい場合は、管理者用画面 `/admin` の手動準備ボタンから `POST /api/warmup` を実行する。検証用途などでユーザー画面ロード時の自動warmupを戻したい場合だけ、`RUNPOD_AUTO_WARMUP_ON_USER_LOAD=1` を明示設定する。

warmup jobまたはSeed-VC voice conversion jobが成功し、レスポンス上で `providers.voice_conversion=seed-vc` またはVC出力が確認できた場合だけ、Cloudflare KVへ短時間のVC ready状態を保存する。ready状態は `RUNPOD_ENDPOINT_ID` ごとに分けて保存し、GPUやendpointを切り替えた後に旧endpointのready状態を流用しない。既定TTLは `RUNPOD_WARMUP_READY_TTL_SECONDS` または300秒とし、期限切れ後は `/api/runtime` がworkerを見つけても `model_resident=false` として返す。

ページ表示そのものはCloudflare側で完了するため、ページが表示されたことはRunPod workerのwarm完了シグナルにはならない。RunPodの準備状態は `/api/runtime` と `/api/warmup` の結果で見る。

## デプロイ

`wrangler.toml` のStatic Assetsで `src/mo_speech/web` を配信し、Worker moduleで `/api/*` を処理する。`/` はポータル、`/fun` は従来の簡易変換画面、`/speakloop` は発音練習画面、`/skitvoice` はSkitVoiceユーザー画面、`/admin` は従来の管理画面へ振り分ける必要があるため、Static Assetsの `run_worker_first` を有効にする。Cloudflare AssetsのHTML clean URL redirectで `/user.html` が `/user` へ変換されると既存URL互換が崩れるため、`html_handling="none"` にする。秘密情報はリポジトリへ書かず、`wrangler secret put` で登録する。

`workers.dev` のまま公開ページを認証なしにして管理画面だけを守る場合は、Cloudflare AccessではなくWorker内の簡易管理ログインを使う。対象は `/admin`、`/skitvoice/admin`、`/vibevoice/admin`、`/speakloop/admin`、`/practice/admin` と、管理画面が使う設定保存、履歴閲覧/削除、practice履歴、warmup APIである。ログイン成功時は `HttpOnly; Secure; SameSite=Lax` cookieを発行し、以後の管理画面/APIだけで検証する。`ADMIN_PASSWORD_SHA256` または `ADMIN_SESSION_SECRET` が未設定の場合、管理ルートはsetup errorを返し、公開ページと生成APIは動かし続ける。

公開生成APIのGoogleログインは管理画面ログインとは別である。管理画面は従来どおり管理パスワードで守り、公開ユーザーは `/auth/google/login` からGoogle OAuthでログインする。管理者本人が公開ページで生成する場合もGoogleログインは使うが、emailが管理者リストに含まれていればquotaは消費しない。

2アプリ化後は、発音練習アプリとSkitVoiceで `wrangler.toml`、Worker名、secret、KV/D1/R2 bindingを分ける。発音練習側はRunPod secretを持たず、SkitVoice側だけRunPod endpointとGPU推論用secretを持つ。

SkitVoice単体公開では、公開ページを `/`、管理画面を `/admin` とする。`/admin` はCloudflare AccessのAccess applicationとしてpath単位で保護し、Googleをidentity providerに設定したうえで、管理者本人のGoogleアカウントだけをAllow policyに含める。`/` と生成APIのうち公開画面に必要な範囲は認証なしで使えるようにし、詳細設定、診断、履歴、warmupなど管理操作は `/admin` 側へ寄せる。

```sh
wrangler secret put RUNPOD_API_KEY
wrangler secret put RUNPOD_ENDPOINT_ID
wrangler secret put OPENAI_API_KEY
printf '管理パスワード' | shasum -a 256
wrangler secret put ADMIN_PASSWORD_SHA256
openssl rand -base64 32
wrangler secret put ADMIN_SESSION_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -base64 32
wrangler secret put PUBLIC_SESSION_SECRET
wrangler secret put ADMIN_GOOGLE_EMAILS
wrangler deploy
```

## 制限

- `MO_SPEECH_KV` binding が無い環境では、管理画面の設定保存と音声履歴は永続化しない。
- 大きい録音ファイルはWorkerとRunPodのrequest size制限を受ける。ユーザー画面では短い録音を前提にする。
- OpenAI ASR、翻訳、TTSはWorker内で同期実行するため、細かいstage progressはUI側の推定表示になる。
- Seed-VCはRunPod endpointのqueue-based Serverlessを使うため、VC処理中の細かいstage progressはRunPod job statusから推定する。
