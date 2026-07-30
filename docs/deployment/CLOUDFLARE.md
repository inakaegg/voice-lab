# Cloudflareデモ構成

更新日: 2026-07-30

## 目的

スマホから触れるデモでは、Web UI配信とAPI gatewayをCloudflare Workersへ置き、GPU推論だけをRunPod Serverlessへ送る。GPU PodでWebサーバーを常時起動しない。

公開Worker名は `voice-lab`、公開URLは `https://voice-lab.inakaegg.workers.dev/` とする。D1 database、R2 bucket、KV namespaceは既存データを引き継ぐため、Workerのブランド変更とは分けて既存resourceを継続利用する。

日次quotaと監査ログの期限切れ削除は、`wrangler.toml` のCron Triggerで毎日03:17 UTCに実行する。48時間を超えた日次quotaと90日を超えた監査ログを削除するため、日次実行の間隔を含む実際の最大保持期間はそれぞれ3日未満、91日未満となる。累計quotaは利用上限維持のため公開デモの運用中に保持する。

この文書はproduction公開環境へ反映済みのCloudflareデモ構成を説明する。公開ポートフォリオの主機能はSpeakLoopとする。第三者が触って評価しやすいproduction公開デモとして整えるための改善順は [PUBLIC_DEMO_ROADMAP.md](PUBLIC_DEMO_ROADMAP.md) を参照する。

データフロー、保存範囲、保持期間と削除処理は [PRIVACY.md](PRIVACY.md)、利用者向けの説明は [Voice Lab プライバシーポリシー](../PRIVACY_POLICY.md) を参照する。公開画面では `/privacy` とSpeakLoopフッターから確認できる。

```text
Browser
  -> Cloudflare Worker Static Assets
  -> Cloudflare Worker API gateway
  -> OpenAI API: 母語ASR、英語復唱ASR、翻訳、TTS、表示用テキスト加工
  -> private RunPod Serverless Job API: 中国語復唱FunASR、Seed-VC、warmup
```

## 退役route

旧研究機能のrouteはWorkerが404を返す。対象は `/fun`・`/user`・`/skitvoice`・`/skitvoice/admin`・`/vibevoice*`・`/seed-vc` である。旧HTMLの直接指定と旧音声翻訳APIも404を返す。

## 秘密情報

ブラウザへRunPod API keyを渡さない。Cloudflare Workerのsecretとして以下を設定する。

- `RUNPOD_API_KEY`
- `RUNPOD_ENDPOINT_ID`
- `OPENAI_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `PUBLIC_SESSION_SECRET`
- `ADMIN_GOOGLE_EMAILS`

`RUNPOD_API_KEY` は可能なら対象endpointだけに権限を絞ったRestricted API keyにする。OpenAI API keyはWorker側で完結する処理に使う。対象処理はASR・翻訳・TTS・表示用ひらがなである。

`GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` は、公開デモの生成APIと管理画面で共用するGoogle OAuth clientである。`PUBLIC_SESSION_SECRET` はGoogleログインcookieへの署名に使い、他のsecretへfallbackさせない。`ADMIN_GOOGLE_EMAILS` は、管理画面へアクセスできるGoogleアカウントをカンマ区切りで指定する。管理画面側の設定にも管理者メールを追加でき、secret側と保存設定側の和集合を管理者扱いにする。管理者は公開生成quotaを消費しない。ただし入力サイズ上限は適用する。

Google OAuth clientの「承認済みのリダイレクトURI」には `https://voice-lab.inakaegg.workers.dev/auth/google/callback` を登録する。旧Worker URLから切り替える間は旧URIを残してよいが、新URLでログイン確認が完了した後に不要な旧URIを削除する。

### Worker名変更時の移行

`wrangler.toml` の `name` を変えると、既存Workerの名前がその場で変わるのではなく、新しいWorkerが作成される。KV、D1、R2は設定済みbindingを通じて既存resourceを引き継げるが、Worker secretは引き継がれず値も読み戻せない。ブランド変更時は次の順で移行する。

1. 新Workerへ上記secretをすべて登録する。
2. Google OAuth clientへ新しい承認済みリダイレクトURIを追加する。
3. `npx wrangler d1 migrations apply mo-speech-demo-db --remote` で未適用のD1 migrationを本番databaseへ適用する。
4. `npx wrangler deploy` で新Workerをデプロイする。
5. 新URLでそれぞれsmoke確認する。対象はトップページ・Googleログイン・SpeakLoopである。
6. 利用箇所を新URLへ切り替えた後、旧Workerと旧OAuth redirect URIを削除する。

新Workerのsmoke確認が終わるまで旧Workerを削除しない。secretが不足した状態で新Workerを本番移行先として公開しない。

## API gateway範囲

Workerは次の主要なAPI互換エンドポイントを提供する。

- `GET /api/runtime`
- `GET /api/public-session`
- `GET /api/public-access-settings`
- `GET /api/public-sample-audios`
- `POST /api/practice/prompts`
- `POST /api/practice/recordings`
- `POST /api/practice/attempt-jobs`
- `GET /api/practice/attempt-jobs/{job_id}`
- `GET /api/practice/voice-jobs/{job_id}`
- `POST /api/voice-conversion-jobs`
- `GET /api/voice-conversion-jobs/{job_id}`
- `POST /api/warmup`
- `GET /api/warmup/{job_id}`

Seed-VC・warmup・SpeakLoopの中国語復唱比較はRunPod Serverlessの非同期jobへ中継する。RunPodのjob IDをUI向けjob IDとして返し、status pollingで `queued`・`running`・`succeeded`・`failed` 形式へ変換する。中国語比較では、お手本と復唱の両音声を1つのRunPod jobへ送る。progress updateと `/health` を使ってUIへ返す状態は、worker割り当て待ち・worker初期化・FunASRモデル読込・両音声の解析・完了／失敗である。status pollingはquotaを追加消費しない。

SpeakLoopの英語復唱比較はWorkerがお手本と復唱の両音声をOpenAI `whisper-1` で並列解析し、同じjob snapshot形式の完了結果をPOSTのレスポンスで直接返す。

## 設定と音声履歴の境界

Cloudflareデモでは、公開アクセス設定をWorkers KVへ保存する。KV bindingは `MO_SPEECH_KV` とする。bindingが無いテスト環境ではWorker process内の一時設定へfallbackする。

音声履歴はローカルFastAPI版だけの機能とする。Cloudflare版はSpeakLoopやVCの音声を履歴として保存しない。共有管理画面との状態判定用に `GET /api/audio-history` と `GET /api/practice-history` は `enabled: false` と空配列を返す。履歴音声の登録・取得・削除APIは提供しない。

公開サンプル音声はblobをR2、metadataをD1へ置く。bindingがないローカル・テスト環境ではKVへfallbackする。R2 bindingは公開サンプル用であり、ユーザー音声履歴の保存を有効にしない。

KVは軽量設定とready状態など、厳密な整合性を必要としない値に使う。D1 database `mo-speech-demo-db` はquota、監査ログ、公開サンプルmetadataを保存する。R2 binding、D1 schema、fallbackは [STORAGE.md](STORAGE.md) を参照する。

## 公開デモのGoogleログインとquota

公開デモとして共有する場合、ページ閲覧自体は誰でも可能にし、OpenAI APIやRunPod課金が発生する生成APIだけをGoogleログイン必須にする。招待コードは共有URLから訪問する初回利用者の体験に向かないため使わない。

公開生成の制御はWorker内で行う。

- `PUBLIC_GOOGLE_AUTH_REQUIRED=1` または管理画面設定でGoogleログイン必須にする。
- ログイン済みGoogleアカウントのemailをSHA-256 hash化し、feature別の日次回数と累計回数をD1へ保存する。D1 bindingがない環境だけKVへfallbackする。
- `ADMIN_GOOGLE_EMAILS` または管理画面設定の管理者メールに含まれるアカウントは、管理画面へアクセスでき、日次・累計quotaを消費しない。
- quota対象はSpeakLoop録音とSeed-VC変換である。管理者は公開quotaを消費しない。
- job status polling、静的ページ表示、runtime確認、管理画面閲覧は公開quotaを消費しない。
- Google OAuth設定が不足している状態でGoogleログイン必須にした場合、生成APIは `503` を返す。課金APIを開放したまま失敗するより、fail closedを優先する。

公開quotaと入力上限はKVに `public-access-settings` として保存する。admin画面から以下を変更できるようにする。

- Googleログイン必須のON/OFF
- 管理画面へのアクセスを許可するGoogle email
- SpeakLoopの日次/累計回数、録音最大byte数、対象文最大文字数
- Seed-VCの日次/累計回数、source/reference音声最大byte数

入力上限は生成前に検証する。上限超過はquotaを消費しない。quota消費は入力検証後、外部APIやRunPodへ送る直前にD1で更新する。この構成は公開デモの過剰利用防止を目的とし、厳密な課金制御ではない。課金水準の強い同時更新保証が必要になった場合はDurable Objectsを検討する。

公開Googleログインとquota判定は監査用にD1へ最近のイベントを保存し、管理APIからのみ読む。emailはSHA-256 hashとして保存する。保存しない対象は音声・台本・入力本文・OAuth token・raw IP addressである。これは公開デモの過剰利用確認と簡易トラブルシュートを目的とし、法的な監査証跡や課金台帳としては扱わない。

ログインした利用者のemailと日時は `public_users` へ保存し、管理者専用の `GET /api/public-users` と `/admin` の利用者一覧から確認する。audit eventのemailはSHA-256 hashのままとする。

sample metadataはD1、音声blobは非公開R2へ保存する。過去の研究機能で登録したsample dataは一般向けAPIから返らない。保持は保証せず、管理者のsample保存・削除操作でD1 rowとR2 objectごと削除され得る。

## warmup

`GET /api/runtime` はRunPod `/health` を読むだけの確認APIとして扱う。これはRunPod jobを作らず、worker起動やSeed-VC preloadを要求しない。RunPod `/health` の `IDLE`、`READY` などはendpointまたはworkerの存在確認には使えるが、それだけでSeed-VCモデルがworker process内にresident load済みとは判定しない。

`POST /api/warmup` はRunPod Serverlessへ `operation_mode=warmup` を投げる。これはRunPod jobを作成するため、`workers-min=0` の場合でもworker起動、image/container準備、Seed-VC preloadが起こり得る。つまりデモ前にcold startとモデルロードを前倒しできる一方で、実行中とidle timeoutまでのGPU課金対象になり得る。

RunPod endpointはFlashBootを有効にしてcontainer cold start短縮を狙う。ただしFlashBootはSeed-VCの実推論や初回モデルロードそのものを必ず消す機能ではないため、体感が遅い場合はwarmup job、`serverless_timings_ms`、`timings_ms.voice_conversion` を分けて確認する。

公開画面はページロード時に `POST /api/warmup` を投げない。デモ前にcold startとSeed-VC preloadを前倒しする場合は `/admin` の手動準備ボタンを使う。ページ表示だけではRunPod jobを作らない。

warmup jobまたはSeed-VC voice conversion jobが成功し、レスポンス上で `providers.voice_conversion=seed-vc` またはVC出力が確認できた場合だけ、Cloudflare KVへ短時間のVC ready状態を保存する。ready状態は `RUNPOD_ENDPOINT_ID` ごとに分けて保存し、GPUやendpointを切り替えた後に旧endpointのready状態を流用しない。既定TTLは `RUNPOD_WARMUP_READY_TTL_SECONDS` または300秒とし、期限切れ後は `/api/runtime` がworkerを見つけても `model_resident=false` として返す。

ページ表示そのものはCloudflare側で完了するため、ページが表示されたことはRunPod workerのwarm完了シグナルにはならない。RunPodの準備状態は `/api/runtime` と `/api/warmup` の結果で見る。

## デプロイ

`wrangler.toml` のStatic Assetsで `src/mo_speech/web` を配信し、Worker moduleでrouteと認証を処理する。`/api/*` も同じmoduleが処理する。`/` と `/speakloop` は公開する。`/admin` と `/speakloop/admin` は管理者認証で保護する。旧routeと旧HTML直指定は404にする。Static Assetsの `run_worker_first` と `html_handling="none"` を使う。秘密情報はリポジトリへ書かず `wrangler secret put` で登録する。

`workers.dev` のまま公開ページを認証なしにして管理機能を守るため、公開生成APIと管理機能の認証をWorker内のGoogle OAuthへ一本化する。対象routeは `/admin` と `/speakloop/admin` である。対象APIは設定保存・履歴状態確認・warmup・管理者用VCである。未ログインの管理ページはGoogleログインへ遷移する。emailが管理者リストにない場合は403を返す。管理APIは同じ条件で401または403を返す。Google OAuth設定が不足する場合はfail closedで503を返す。

管理画面の単体Seed-VCとwarmupは同じGoogleセッションを使う。単体Seed-VCはjob作成から結果取得まで管理者だけに許可する。管理者メールに含まれるアカウントはquotaを消費しない。入力サイズ上限は維持する。管理者専用の別パスワード、別cookie、認証例外は設けない。

production Workerとstaging Workerは配備済みである。現在は2 Workerを同じrepoから配備する。stagingの必須Worker secretは登録済みで、deploy後smokeも成功している。Googleログインの実操作確認は未実施である。

### production

mainへのpushではGitHub Actionsの `CI` を先に実行する。`Deploy Cloudflare Production` はpush起点のCIが成功した場合だけ動く。CIが検証したcommit SHAをcheckoutし、React成果物を再生成してから次の順で本番へ反映する。

1. `npx wrangler d1 migrations apply mo-speech-demo-db --remote`
2. `npx wrangler deploy --env=""`
3. `python3 scripts/smoke_cloudflare_deployment.py --base-url https://voice-lab.inakaegg.workers.dev`

D1 migrationはWorkerより先に適用する。`--remote`を省略するとlocal databaseが対象になるため省略しない。deploy後のsmokeは公開画面、公開JSON API、認証境界を確認する。有料の生成APIは呼ばない。RunPod imageはこの自動deployへ含めず、既存の手動workflowを維持する。

GitHub repositoryには次のActions secretsを登録する。未登録の場合はworkflowが対象名を示して失敗する。

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

API tokenはCloudflareの `Edit Cloudflare Workers` templateを基にする。対象accountだけへscopeを絞り、Accountの `D1 Edit` 権限を追加する。D1 migrationはdatabaseへのwriteを伴うため、この権限が必要である。

production Workerのsecretは次のコマンドで環境未指定のWorkerへ登録する。secret値はコマンド引数やリポジトリへ書かず、対話入力する。

```sh
wrangler secret put RUNPOD_API_KEY
wrangler secret put RUNPOD_ENDPOINT_ID
wrangler secret put OPENAI_API_KEY
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -base64 32
wrangler secret put PUBLIC_SESSION_SECRET
wrangler secret put ADMIN_GOOGLE_EMAILS
```

### staging

`[env.staging]` は `voice-lab-staging` として配備する。productionの利用者データへ触れないよう、永続resourceを次のように分ける。

| binding | production | staging |
| --- | --- | --- |
| `MO_SPEECH_KV` | `MO_SPEECH_KV` | `MO_SPEECH_KV_STAGING` |
| `MO_SPEECH_DB` | `mo-speech-demo-db` | `mo-speech-staging-db` |
| `MO_SPEECH_AUDIO_R2` | `mo-speech-audio` | `mo-speech-audio-preview` |

stagingはproductionのCron Triggerを継承しないよう、`crons = []` を明示する。通常のWorker設定値は `[env.staging.vars]` へ複製する。ただし `PUBLIC_CANONICAL_ORIGIN` はクロール許可を正規公開originへ限定するため複製しない。初回配備から課金APIを匿名公開しないよう、`PUBLIC_GOOGLE_AUTH_REQUIRED=1` を既定にする。Worker secretも環境間で継承されない。

`Deploy Cloudflare Staging` は `workflow_dispatch` 専用である。GitHub Actionsの実行画面でbranchを選び、そのrevisionのReact成果物を再生成する。その後に次の順でstagingへ反映する。

1. `npx wrangler d1 migrations apply mo-speech-staging-db --env staging --remote`
2. `npx wrangler deploy --env staging`
3. `python3 scripts/smoke_cloudflare_deployment.py --base-url https://voice-lab-staging.inakaegg.workers.dev`

staging Workerには次のsecretを環境指定で登録する。`PUBLIC_SESSION_SECRET` はproductionと別の値を生成する。

```sh
wrangler secret put RUNPOD_API_KEY --env staging
wrangler secret put RUNPOD_ENDPOINT_ID --env staging
wrangler secret put OPENAI_API_KEY --env staging
wrangler secret put GOOGLE_CLIENT_ID --env staging
wrangler secret put GOOGLE_CLIENT_SECRET --env staging
openssl rand -base64 32
wrangler secret put PUBLIC_SESSION_SECRET --env staging
wrangler secret put ADMIN_GOOGLE_EMAILS --env staging
```

Google OAuth clientの承認済みリダイレクトURIには、`https://voice-lab-staging.inakaegg.workers.dev/auth/google/callback` を追加する。

staging Workerは2026-07-22（米国太平洋時間）に初回deploy済みである。Cloudflare APIの記録は `2026-07-23T04:38:20Z` である。2026-07-23に `OPENAI_API_KEY`、`RUNPOD_API_KEY`、`RUNPOD_ENDPOINT_ID`、`PUBLIC_SESSION_SECRET` を登録した。同日に `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`ADMIN_GOOGLE_EMAILS` も登録し、deploy後smokeの全6項目が成功した。Google OAuth clientのリダイレクトURIとGoogleログインの実操作は別途確認する。

残るstaging確認は次の順で行う。

1. Google OAuth clientへstagingのリダイレクトURIを追加する。
2. `Deploy Cloudflare Staging` で確認対象branchを選ぶ。
3. D1 migration、Worker deploy、deploy後smokeの成功を確認する。
4. Googleログインと管理画面の認可を確認する。
5. 費用上限を確認してから、最小入力でOpenAI経路とRunPod経路を個別に確認する。

GitHub Actions secretsが無い場合はmigration前にworkflowが失敗する。Worker secretが無い初回deployでは静的画面を配信できるが、対応する生成APIは503でfail closedする。Google OAuth用secretまたは管理者メールが無い場合も、ログインと管理機能は503でfail closedする。

## ログと監視

- Workers Logsは `wrangler.toml` の `[observability]` で本番とstagingの両方を有効にする。
- WorkerはOpenAI upstream失敗・API失敗・練習jobの失敗をconsole.errorへ記録する。ログへ音声データや台本などのpayloadは含めない。
- 過去ログはCloudflare dashboardの対象Worker → Logsで確認する。リアルタイム確認は `npx wrangler tail voice-lab` を使う。
- Workers LogsのFreeプラン枠は1日20万イベント・保持3日である。超過する場合は `head_sampling_rate` を下げる。

## 検索・共有メタ情報

公開3route(`/`・`/speakloop`・`/privacy`)の配信HTMLには共有・検索用のメタ情報を静的に埋め込む。内容はmeta description・OGP・Twitter Card・canonical URL・apple-touch-iconである。共有カード用のOG画像は全routeで `og-voice-lab.png`(1200×630)を共用し、`apps/web/public/` からビルドで `/react/` 配下へ配置する。`/` と `/speakloop` にはJSON-LD構造化データ(`WebSite`・`WebApplication`)を置く。

Workerは `/robots.txt` と `/sitemap.xml` を配信する。クロール許可は `PUBLIC_CANONICAL_ORIGIN` が要求originと一致する配備だけに与える。productionでは `wrangler.toml` の `[vars]` でこの値を公開URLへ設定する。stagingは設定しないため、robots.txtが全体Disallowを返しsitemapは404になる。`PUBLIC_GOOGLE_AUTH_REQUIRED` は生成APIのログイン必須設定でありページ閲覧を制限しないため、クロール可否の判定に使わない。

sitemapへ載せるのは `/`・`/speakloop`・`/privacy` だけとする。管理系routeと `/api/`・`/auth/` はrobots.txtでDisallowする。対象の管理系routeは `/admin` と `/speakloop/admin` である。

deploy後smokeはrobots.txtとsitemap.xmlの整合も確認する。HTMLメタとWorker配信の回帰は `tests/react_public_ui.test.mjs` と `tests/cloudflare_worker.test.mjs` が検査する。Google Search Consoleへの登録とsitemap送信は外部操作のため未実施である。

## 制限

- `MO_SPEECH_KV` binding が無い環境では、管理画面の設定を永続化できない。R2を設定してもCloudflare版のユーザー音声履歴は有効にならない。
- 大きい録音ファイルはWorkerとRunPodのrequest size制限を受ける。SpeakLoopでは短い録音を前提にする。
- OpenAI ASR、翻訳、TTSはWorkerのHTTP request内で完了を待つ。SpeakLoop中国語復唱ASRはRunPodの非同期jobとprogress updateを使うが、queueの詳細原因や残高不足はRunPodが明示した範囲でしか判定できない。
- SpeakLoop中国語比較の完了outputでは `practice_asr_contract_version=3` を必須とする。`model_audio_base64` を送ったjobでは `model_transcription` も必須とし、欠落時は旧RunPod imageとして再デプロイを案内する。
- お手本ASRのキャッシュ命中により `model_audio_base64` を省略したjobは、`model_transcription` も返さない。この場合はWorkerまたはFastAPIがjobと対応付けたキャッシュ済みASRを使い、旧imageとは判定しない。
- Seed-VCはRunPod endpointのqueue-based Serverlessを使うため、VC処理中の細かいstage progressはRunPod job statusから推定する。
