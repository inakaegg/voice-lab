# Cloudflareデモ構成

更新日: 2026-07-17

## 目的

スマホから触れるデモでは、Web UI配信とAPI gatewayをCloudflare Workersへ置き、GPU推論だけをRunPod Serverlessへ送る。GPU PodでWebサーバーを常時起動しない。

公開Worker名は `voice-lab`、公開URLは `https://voice-lab.inakaegg.workers.dev/` とする。D1 database、R2 bucket、KV namespaceは既存データを引き継ぐため、Workerのブランド変更とは分けて既存resourceを継続利用する。

この文書は現在のCloudflareデモ構成と、未deployの公開境界変更を説明する。公開ポートフォリオの主機能はSpeakLoopとし、SkitVoice/VibeVoiceは既存Google管理者セッションで保護する研究機能へ閉じる。発音練習アプリと研究機能を物理的に分ける場合は、同一repoから2つのCloudflare projectまたはWorkerへデプロイする方針を [APP_SPLIT.md](APP_SPLIT.md) にまとめている。第三者が触って評価しやすい公開デモとして整えるための改善順は [PUBLIC_DEMO_ROADMAP.md](PUBLIC_DEMO_ROADMAP.md) を参照する。

データフロー、保存範囲、保持期間と削除に関する未決定事項は [PRIVACY.md](PRIVACY.md) を参照する。正式なプライバシーポリシーと公開画面からの導線が完成するまで公開再開を完了扱いにしない。

```text
Browser
  -> Cloudflare Worker Static Assets
  -> Cloudflare Worker API gateway
  -> OpenAI API: 母語ASR、英語復唱ASR、翻訳、TTS、表示用テキスト加工、ジョークTTS
  -> private RunPod Serverless Job API: 中国語復唱FunASR、Seed-VC、管理者専用SkitVoice/VibeVoice、warmup
```

## SkitVoice/VibeVoiceの認可とentry point

Cloudflare版は `/` にSpeakLoopだけを主製品として表示し、`/skitvoice` は生成フォーム・sample・model情報のない非公開案内を返す。`/skitvoice/admin` と `/static/vibevoice.html` は管理者認証必須である。旧 `/vibevoice`、`/vibevoice/simple`、`/vibevoice/admin`、`/vibevoice.html`、`/vibevoice_simple.html`、`/static/vibevoice_simple.html` は404を維持する。

VibeVoiceのstatus、URL参照、script、job submit、job status、cancelは、既存Google管理者セッションを使う共通API guardで保護する。匿名利用者は401、通常Googleユーザーは403とし、routeごとのUI条件をsecurity boundaryにしない。Cloudflare版にはsync generation APIを持たせず、ローカルFastAPIだけが `POST /api/vibevoice/generate` を維持する。

非admin向け `GET /api/public-session` はSkitVoiceのfeature/quotaを含めない。非admin向け `GET /api/public-sample-audios` は既存SkitVoice sampleを返さない。管理者は同じsample APIで研究dataを管理でき、外部R2 objectの削除はこのローカル変更に含めない。これらは未deployであり、現在の公開URLで閉鎖済みとは扱わない。

## 秘密情報

ブラウザへRunPod API keyを渡さない。Cloudflare Workerのsecretとして以下を設定する。

- `RUNPOD_API_KEY`
- `RUNPOD_ENDPOINT_ID`
- `OPENAI_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `PUBLIC_SESSION_SECRET`
- `ADMIN_GOOGLE_EMAILS`

`RUNPOD_API_KEY` は可能なら対象endpointだけに権限を絞ったRestricted API keyにする。OpenAI API keyは、ASR、翻訳、TTS、表示用ひらがな、短いテキスト加工、ジョークTTSなどWorker側で完結する処理に使う。

`GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` は、公開デモの生成APIと管理画面で共用するGoogle OAuth clientである。`PUBLIC_SESSION_SECRET` はGoogleログインcookieへの署名に使い、他のsecretへfallbackさせない。`ADMIN_GOOGLE_EMAILS` は、管理画面へアクセスできるGoogleアカウントをカンマ区切りで指定する。管理画面側の設定にも管理者メールを追加でき、secret側と保存設定側の和集合を管理者扱いにする。管理者は公開生成quotaを消費しないが、入力サイズ上限は適用する。

Google OAuth clientの「承認済みのリダイレクトURI」には `https://voice-lab.inakaegg.workers.dev/auth/google/callback` を登録する。旧Worker URLから切り替える間は旧URIを残してよいが、新URLでログイン確認が完了した後に不要な旧URIを削除する。

### Worker名変更時の移行

`wrangler.toml` の `name` を変えると、既存Workerの名前がその場で変わるのではなく、新しいWorkerが作成される。KV、D1、R2は設定済みbindingを通じて既存resourceを引き継げるが、Worker secretは引き継がれず値も読み戻せない。ブランド変更時は次の順で移行する。

1. 新Workerへ上記secretをすべて登録する。
2. Google OAuth clientへ新しい承認済みリダイレクトURIを追加する。
3. `npx wrangler deploy` で新Workerをデプロイする。
4. 新URLでトップページ、Googleログイン、SpeakLoop、公開 `/skitvoice` の非生成表示、許可済みGoogle管理者による `/skitvoice/admin` の研究用生成をそれぞれsmoke確認する。
5. 利用箇所を新URLへ切り替えた後、旧Workerと旧OAuth redirect URIを削除する。

新Workerのsmoke確認が終わるまで旧Workerを削除しない。secretが不足した状態で新Workerを本番移行先として公開しない。

## API gateway範囲

Workerは次のAPI互換エンドポイントを提供する。VibeVoice系は公開ユーザー用ではなく、共通の管理者guardを通る研究用endpointである。

- `GET /api/runtime`
- `GET /api/user-settings`
- `POST /api/user-display-text`
- `POST /api/user-text-output`
- `POST /api/user-joke-output`
- `POST /api/practice/recordings`
- `POST /api/practice/attempt-jobs`
- `GET /api/practice/attempt-jobs/{job_id}`
- `POST /api/translate-speech-jobs`
- `GET /api/translate-speech-jobs/{job_id}`
- `POST /api/voice-conversion-jobs`
- `GET /api/voice-conversion-jobs/{job_id}`
- `GET /api/practice/voice-jobs/{job_id}`
- `GET /api/vibevoice/status`
- `POST /api/vibevoice/jobs`
- `GET /api/vibevoice/jobs/{job_id}`
- `POST /api/vibevoice/jobs/{job_id}/cancel`
- `POST /api/warmup`

音声翻訳のASR、翻訳、TTSはCloudflare WorkerからOpenAI APIを直接呼び、POST時点で `succeeded` の完了jobとして返す。既存UIとの互換のため、完了job snapshotは短時間KVに保存し、`GET /api/translate-speech-jobs/{job_id}` でも同じ結果を返す。

Seed-VC、SkitVoice/VibeVoice、warmup、SpeakLoopの中国語復唱比較はRunPod Serverlessの非同期jobへ中継する。RunPodのjob IDをUI向けjob IDとして返し、status pollingで `queued`、`running`、`succeeded`、`failed` 形式へ変換する。中国語比較では、お手本と復唱の両音声を1つのRunPod jobへ送り、progress updateと `/health` を使ってworker割り当て待ち、worker初期化、FunASRモデル読込、両音声の解析、完了／失敗をUIに返す。SkitVoiceでは同じprogress updateをVibeVoiceモデル読込／生成、指定台詞ASR、Seed-VCモデル読込／声質変換、再配置、出力仕上げに分けてUIへ返す。status pollingはquotaを追加消費しない。

SpeakLoopの英語復唱比較はWorkerがお手本と復唱の両音声をOpenAI `whisper-1` で並列解析し、同じjob snapshot形式の完了結果をPOSTのレスポンスで直接返す。

公開 `/skitvoice` には参照音声入力も生成フォームも置かない。Cloudflare管理者研究画面では、参照音声をファイル、マイク、タブ音声の3方式で指定できる。タブ音声は管理者がブラウザの共有操作で選択した音声trackだけを録音し、映像、URL、cookieは送信しない。WorkerのVibeVoice生成APIは管理者認証後も `voice_url_1` から `voice_url_4` をRunPodへ送らず拒否し、RunPod handlerは `audio_base64` の参照音声だけを受け取る。`POST /api/vibevoice/reference-audio-from-url` もCloudflare版では利用不可とし、URLからの切り出しはローカルFastAPI版またはローカルでの事前素材作成だけで扱う。

## ユーザー設定と音声履歴の境界

Cloudflareデモでは、管理画面から保存するユーザー画面設定をWorkers KVへ保存する。KV binding は `MO_SPEECH_KV` とし、bindingが無い環境では `USER_SETTINGS_JSON` とWorkerプロセス内の一時設定へfallbackする。

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

音声履歴はローカルFastAPI版だけの機能とする。Cloudflare版では翻訳、VC、SpeakLoop、SkitVoice、TTSの入力音声と生成音声を履歴として保存しない。共有管理画面との状態判定用に `GET /api/audio-history` と `GET /api/practice-history` は `enabled: false` と空配列を返すが、履歴音声の登録・取得・削除APIは提供しない。

公開サンプル音声はblobをR2、metadataをD1へ置く。bindingがないローカル・テスト環境ではKVへfallbackする。R2 bindingは公開サンプル用であり、ユーザー音声履歴の保存を有効にしない。

KVは軽量設定とready状態など、厳密な整合性を必要としない値に使う。D1 database `mo-speech-demo-db` はquota、監査ログ、公開サンプルmetadataを保存する。R2 binding、D1 schema、fallbackは [STORAGE.md](STORAGE.md) を参照する。

## 公開デモのGoogleログインとquota

公開デモとして共有する場合、ページ閲覧自体は誰でも可能にし、OpenAI APIやRunPod課金が発生する生成APIだけをGoogleログイン必須にする。招待コードは共有URLから訪問する初回利用者の体験に向かないため使わない。

公開生成の制御はWorker内で行う。

- `PUBLIC_GOOGLE_AUTH_REQUIRED=1` または管理画面設定でGoogleログイン必須にする。
- ログイン済みGoogleアカウントのemailをSHA-256 hash化し、feature別の日次回数と累計回数をD1へ保存する。D1 bindingがない環境だけKVへfallbackする。
- `ADMIN_GOOGLE_EMAILS` または管理画面設定の管理者メールに含まれるアカウントは、管理画面へアクセスでき、日次・累計quotaを消費しない。
- quota対象は、SpeakLoop録音、従来の音声変換/TTS、Seed-VC変換である。SkitVoice生成は管理者研究経路だけに閉じ、管理者は公開quotaを消費しない。
- job status polling、静的ページ表示、runtime確認、管理画面閲覧は公開quotaを消費しない。
- Google OAuth設定が不足している状態でGoogleログイン必須にした場合、生成APIは `503` を返す。課金APIを開放したまま失敗するより、fail closedを優先する。

公開quotaと入力上限はKVに `public-access-settings` として保存する。admin画面から以下を変更できるようにする。

- Googleログイン必須のON/OFF
- 管理画面へのアクセスを許可するGoogle email
- SpeakLoopの日次/累計回数、録音最大byte数、対象文最大文字数
- SkitVoiceの台本最大文字数、参照音声最大byte数。既存の日次/累計設定は互換のため残るが、非adminのfeature/quotaとして公開しない
- へんな変換/翻訳/TTSの日次/累計回数、録音最大byte数、テキスト最大文字数
- Seed-VCの日次/累計回数、source/reference音声最大byte数

入力上限は生成前に検証する。上限超過はquotaを消費しない。quota消費は入力検証後、外部APIやRunPodへ送る直前にD1で更新する。この構成は公開デモの過剰利用防止を目的とし、厳密な課金制御ではない。課金水準の強い同時更新保証が必要になった場合はDurable Objectsを検討する。

公開Googleログインとquota判定は監査用にD1へ最近のイベントを保存し、管理APIからのみ読む。emailはSHA-256 hashとして保存する。音声、台本、入力本文、OAuth token、raw IP addressは保存しない。これは公開デモの過剰利用確認と簡易トラブルシュートを目的とし、法的な監査証跡や課金台帳としては扱わない。

sample metadataはD1、音声blobは非公開R2へ保存する。`/skitvoice/admin` では日本語、中国語、英語を個別登録・削除できるが、現在のSkitVoice sampleは由来を確認できないため、非adminの `GET /api/public-sample-audios` から除外する。削除は `DELETE /api/public-sample-audios/skitvoice?language=<code>` を使うが、外部R2 dataの削除はこのローカル変更では行わない。将来一般表示へ戻す場合は、由来、許諾、生成model、AI生成表示を先に確認する。

## warmup

`GET /api/runtime` はRunPod `/health` を読むだけの確認APIとして扱う。これはRunPod jobを作らず、worker起動やSeed-VC preloadを要求しない。RunPod `/health` の `IDLE`、`READY` などはendpointまたはworkerの存在確認には使えるが、それだけでSeed-VCモデルがworker process内にresident load済みとは判定しない。

`POST /api/warmup` はRunPod Serverlessへ `operation_mode=warmup` を投げる。これはRunPod jobを作成するため、`workers-min=0` の場合でもworker起動、image/container準備、Seed-VC preloadが起こり得る。つまりデモ前にcold startとモデルロードを前倒しできる一方で、実行中とidle timeoutまでのGPU課金対象になり得る。

RunPod endpointはFlashBootを有効にしてcontainer cold start短縮を狙う。ただしFlashBootはSeed-VCの実推論や初回モデルロードそのものを必ず消す機能ではないため、体感が遅い場合はwarmup job、`serverless_timings_ms`、`timings_ms.voice_conversion` を分けて確認する。

ユーザー画面は既定ではページロード後に `POST /api/warmup` を投げない。ユーザー画面の準備状態は小さい状態ドットだけにし、未準備でも録音送信時の実変換jobでRunPodが起動する。デモ前にcold startとSeed-VC preloadを前倒ししたい場合は、管理者用画面 `/admin` の手動準備ボタンから `POST /api/warmup` を実行する。検証用途などでユーザー画面ロード時の自動warmupを戻したい場合だけ、`RUNPOD_AUTO_WARMUP_ON_USER_LOAD=1` を明示設定する。

warmup jobまたはSeed-VC voice conversion jobが成功し、レスポンス上で `providers.voice_conversion=seed-vc` またはVC出力が確認できた場合だけ、Cloudflare KVへ短時間のVC ready状態を保存する。ready状態は `RUNPOD_ENDPOINT_ID` ごとに分けて保存し、GPUやendpointを切り替えた後に旧endpointのready状態を流用しない。既定TTLは `RUNPOD_WARMUP_READY_TTL_SECONDS` または300秒とし、期限切れ後は `/api/runtime` がworkerを見つけても `model_resident=false` として返す。

ページ表示そのものはCloudflare側で完了するため、ページが表示されたことはRunPod workerのwarm完了シグナルにはならない。RunPodの準備状態は `/api/runtime` と `/api/warmup` の結果で見る。

## デプロイ

`wrangler.toml` のStatic Assetsで `src/mo_speech/web` を配信し、Worker moduleでroute、認証、`/api/*` を処理する。`/`、`/speakloop`、`/skitvoice` は公開し、`/admin`、`/speakloop/admin`、`/skitvoice/admin`、`/fun` は管理者認証で保護する。旧routeと旧HTML直指定は404にする。Static Assetsの `run_worker_first` と `html_handling="none"` を使い、認証前にHTML clean URL処理へ渡さない。秘密情報はリポジトリへ書かず、`wrangler secret put` で登録する。

`workers.dev` のまま公開ページを認証なしにして管理機能を守るため、公開生成APIと管理機能の認証をWorker内のGoogle OAuthへ一本化する。対象は `/admin`、`/skitvoice/admin`、`/speakloop/admin`、`/fun` と、管理画面が使う設定保存、履歴機能の状態確認、warmup APIである。未ログインの管理ページはGoogleログインへ遷移し、ログイン済みでもemailが管理者リストにない場合は403を返す。管理APIは同じ条件で401または403を返す。Google OAuth設定または管理者メールが不足する場合はfail closedで503を返す。

`/fun`を含む公開生成APIも同じGoogleセッションを使う。`/fun`のテキスト・音声生成APIとSeed-VC APIは、job作成、status polling、結果取得を含め、公開生成のGoogleログイン必須設定にかかわらず管理者だけに許可する。管理者メールに含まれるアカウントはquotaを消費しないが、入力サイズ上限は維持する。管理者専用の別パスワード、別cookie、認証例外は設けない。

現在は単一Workerを正とする。分割は利用量、障害、secret、デプロイ頻度を独立管理する必要が生じた場合だけ [APP_SPLIT.md](APP_SPLIT.md) に従って検討する。

```sh
wrangler secret put RUNPOD_API_KEY
wrangler secret put RUNPOD_ENDPOINT_ID
wrangler secret put OPENAI_API_KEY
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -base64 32
wrangler secret put PUBLIC_SESSION_SECRET
wrangler secret put ADMIN_GOOGLE_EMAILS
wrangler deploy
```

公開サンプル音声blobをR2へ保存するため、bucket作成後に次のbindingを `wrangler.toml` へ追加する。bucket名は環境ごとに決め、リポジトリへ実アカウント固有値を固定しない。

```toml
[[r2_buckets]]
binding = "MO_SPEECH_AUDIO_R2"
bucket_name = "mo-speech-audio"
preview_bucket_name = "mo-speech-audio-preview"
```

## 制限

- `MO_SPEECH_KV` binding が無い環境では、管理画面の設定を永続化できない。R2を設定してもCloudflare版のユーザー音声履歴は有効にならない。
- 大きい録音ファイルはWorkerとRunPodのrequest size制限を受ける。ユーザー画面では短い録音を前提にする。
- OpenAI ASR、翻訳、TTSはWorkerのHTTP request内で完了を待つ。SpeakLoop中国語復唱ASRはRunPodの非同期jobとprogress updateを使うが、queueの詳細原因や残高不足はRunPodが明示した範囲でしか判定できない。
- SpeakLoop中国語比較の完了outputに `practice_asr_contract_version=2` または `model_transcription` が無い場合は、旧RunPod imageとして再デプロイを案内する。一般的な「お手本解析結果なし」には丸めない。
- Seed-VCはRunPod endpointのqueue-based Serverlessを使うため、VC処理中の細かいstage progressはRunPod job statusから推定する。
