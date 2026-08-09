# 現在のデプロイ構成

更新日: 2026-08-07

## 構成

Voice Labの公開版は、1つのCloudflare WorkerでSpeakLoopとZoovoiceを配信する。UIはWorker Static Assets、認証・quota・API中継はWorker moduleが担当する。SpeakLoopのGPU推論はRunPod Serverless、Zoovoiceの音声処理はprivateなGoogle Cloud Run上のGoサービスが担当する。この構成はproduction公開環境へ反映済みである。

```text
Browser
  -> Cloudflare Worker Static Assets
       /, /speakloop, /zoovoice
  -> Cloudflare Worker module
       Google OAuth / admin auth / quota / API gateway / Turnstile / Cloud Run ID token
       -> OpenAI API: native-language ASR / English practice ASR / translation / TTS
       -> RunPod Serverless: async dual-audio Chinese practice FunASR / Seed-VC
       -> Google Cloud Run (private): Zoovoice Japanese ASR / animal association / synthesis
       -> KV: settings / short-lived jobs / fallback
       -> D1: quota / audit / public sample metadata / Zoovoice usage counters
       -> R2: audio blobs
```

SpeakLoopのローカル版はFastAPIがUIとAPIを配信する。ZoovoiceのローカルUIとAPIはFastAPIを使わず、Wrangler localのWorkerとGoサービスで確認する。

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
- D1: email hashを使うquota、監査イベント、公開サンプルmetadata、Zoovoice利用counter
- R2: 管理者が登録したsample音声のblob
- RunPod: GPU jobの入力、途中progress、結果。長期保存の正にはしない
- Cloud Run: Zoovoiceの録音、合成音声、連想metadata。応答の生成に必要な間だけ扱い、永続保存しない

SpeakLoopの中国語比較はRunPodのjob IDをブラウザへ返し、WorkerまたはFastAPIがRunPod statusを都度中継する。Cloudflare側に練習音声やこのjob結果を履歴保存する必要はない。

詳細は [CLOUDFLARE.md](CLOUDFLARE.md)、[STORAGE.md](STORAGE.md)、[RUNPOD.md](RUNPOD.md) を参照する。

## Zoovoice

Zoovoiceは、録音した発話の内容から動物を1種だけ自動で選び、その鳴き声を発話のすき間へ重ねる機能である。GoサービスはprivateなCloud Runへdeploy済みである。公開Workerも有効化varsを含めてdeploy済みである。公開UIのβ版表示は本branchで追加した変更であり、production未反映である。merge後にWorker deployとdeploy後smokeを実施する。

この節はリポジトリの現在のコードの構成を示す。日本語ASRと動物の自動連想はGoサービスへ実装済みである。Cloud Runとproduction Workerへのdeployは完了しており、有効化varsも `wrangler.toml` へ設定済みである。外部操作と実環境smokeの状況はこの節の末尾に示す。機能仕様は [SPEC.md](../speech-translation/SPEC.md) を正とする。

### 用語

- アニマル度とは、鳴き声の挿入頻度を決める設定を指す。通常UIで利用者が変えられる設定はこれだけとする。
- 動物の自動連想とは、ASR本文から動物1種を自動で選ぶ処理を指す。
- 根拠語とは、その選択に使ったASR本文中の語を指す。
- 連想metadataとは、選ばれた動物と、その動物を選んだ理由の短文を指す。

Workerは `ZOOVOICE_ENABLED=1` の配備だけでZoovoiceの公開routeとAPIを提供する。この値が未設定または `1` 以外の配備では、`/zoovoice` は404、`/api/zoovoice/animals` と `/api/zoovoice/compose` は503を返す。`GET /api/zoovoice/config` はflagの状態を伝えるため、無効な配備でも応答する。現在のproduction `wrangler.toml` は `ZOOVOICE_ENABLED="1"` を設定している。

Google Cloud Run上のGoコンテナは、日本語ASR、動物の自動連想、音声合成をこの順で担当する。自動連想はLLM（既定 `gpt-5.6-luna`）へ一本化しており、ASR本文と音源カタログの候補一覧を渡して1種を必ず選ばせる。辞書やConceptNetによる連想経路と、当てずっぽうのrandom選択は持たない。

連想の候補と音声再生が参照する動物一覧は、音源manifest（`ZOOVOICE_SOUNDS_DIR` が指すディレクトリの `manifest.json`、image内では `/app/sounds/manifest.json`）を正とする。音源を持つ動物だけが候補になる。Cloud Runはprivate IAMを前提とし、ブラウザからCloud Runへ直接送る経路は持たない。ローカルのsmoke確認では、gcloud service account impersonationで取得した短期ID tokenをlocal Wrangler経由でこのGoサービスへ渡す。

productionのWorkerは `ZOOVOICE_ORIGIN_MODE="cloud-run"` で動き、専用invoker service accountのkeyから自力でID tokenを取得してCloud Runを呼ぶ。invoker service accountには対象service単位の `roles/run.invoker` だけを付与し、`allUsers` へは付与しない。認証フローとsecret運用の詳細は [CLOUDFLARE.md](CLOUDFLARE.md) を正とする。この認証の実装と契約testは完了している。invoker service accountの作成と権限付与、key発行、Worker secretの登録も完了している。

```text
Browser
  -> Cloudflare Worker Static Assets
       /zoovoice
       /react/zoovoice-animals.json: 動物一覧
  -> Cloudflare Worker module
       Turnstile検証 / 利用上限 / Cloud Run向けID token
       -> Cloudflare Turnstile: token検証
       -> Google Cloud Run: 録音とアニマル度を一時送信
            日本語ASR -> 動物の自動連想 -> 音声合成
            <- 合成音声 / ASR本文 / 連想metadata
       -> D1: Zoovoice共通の日次・月次counter
```

ブラウザが送るのは録音とアニマル度だけとする。動物と挿入位置はCloud Run側が決めるため、ブラウザから配置設定を送らない。Workerは合成応答を中継し、ASR本文と連想metadataを送信元と同じブラウザへ返す。

動物一覧はCloud RunのGo APIの `/animals` を中継して返す。実際に合成へ使う音源カタログと必ず同じ内容になる。この経路では音声データを扱わない。

Cloud Runへ載せるDocker imageは、Goバイナリに加えて実行に必要なDebian runtime、CA証明書、ffmpegを含める。これに日本語ASR用のwhisper.cpp commandとモデルを加える。commandとモデルはリポジトリで管理せず、build時にgit外の検証済みディレクトリから取り込む。取り込むcommitとSHA-256はbuildとdeploy scriptの両方で照合し、image labelへも残す。連想に使うLLMのAPIキーはimageへ焼き込まず、Cloud RunのsecretとしてOPENAI_API_KEYへ渡す。

音源素材はリポジトリで追跡せず、build時に `zoovoice_sounds` named contextから `/app/sounds` へ取り込む。素材の出所と採用hashは、そのセットの `manifest.json` を正とする。Stability AIの必須表示は `services/zoovoice/NOTICE-STABILITY-AI.md` を正とし、`/app/licenses` へ同梱する。公開UIはfooterへ `Powered by Stability AI` を表示する。secretと開発用ファイルはimageへ含めない。containerはnon-rootで実行する。

ASRモデル、必要な外部command、LLMのAPIキーのいずれかが欠けた場合は起動しない。固定の動物へ黙って切り替えない。

D1へ追加するのは `zoovoice_usage_counters` テーブルだけである。対応するmigrationは `migrations/0004_zoovoice_usage_counters.sql` であり、本番D1へ適用済みである。データ境界は [PRIVACY.md](PRIVACY.md) を参照する。

ASR本文、根拠語、録音、生成音声は応答の生成に必要な間だけ扱う。これらの永続保存先は持たず、D1、R2、application logへ書かない。

Cloud Runのregionは `us-central1` とする。`scripts/deploy_zoovoice_cloud_run.sh` は次の値でdeployする。

- private（`--no-allow-unauthenticated`）
- CPU 2、メモリ2GiB
- port 8080、timeout 90秒、concurrency 1
- min 0、max 2
- imageはlocalでbuildし、`us-central1-docker.pkg.dev/<project>/voice-lab/zoovoice:<git-sha>` へpushする
- imageはtagではなくdigestを固定して指定する

Cloud RunへGit repositoryを接続する自動buildは使わない。container imageのbuildとpushはローカルの配備scriptだけが行う。

配備scriptの実行modeはdry-run、local-only verification、明示applyの3つとする。既定はdry-runであり、remote writeを行うのは明示applyだけである。scriptは実行前に、whisper.cpp commitとASRモデルのSHA-256を検査する。local smokeでは実際のLLMを呼ぶため、`OPENAI_API_KEY` の指定も必須とする。

上のCPUとメモリはlocal-only verificationで実測済みである。linux/amd64のCloud Run相当imageをlocal buildし、CPU 2とメモリ2GiBの上限付きでnon-root起動して測った。image sizeは1,053,233,511 bytes、compose完了後の観測メモリは359.4 MiB / 2 GiB、`/healthz` がreadyになるまでは1,350 msである。2.044秒の日本語fixtureの合成は23,826 msだった。同じ確認で、ASRモデルがnon-rootから読めることも確かめた。

`whisper-cli` はDockerfileの `-DBUILD_SHARED_LIBS=OFF` により、whisper/ggmlのlibraryをstaticに組み込んでbuildしている。この確認では、`whisper-cli` がwhisper/ggmlを共有libraryとして要求しないことを確かめた。libstdc++・libm・libgcc_s・libc・動的loaderへは動的にlinkするため、完全なstatic binaryではない。

上の実測値は動物音の同梱前のimageに対するものである。連想をLLMへ移し、ConceptNet indexを外した現在のimageでは再測定していない。

この測定はApple Silicon上のlinux/amd64 emulationで行っている。合成時間はemulationの影響を受けるため、Cloud Runの実CPU上の値とは一致しない。上記の値はすべてこのlocal環境の実測であり、Cloud Run実機では未確認である。

Wrangler localからGoサービスまでの通しは、Playwrightのe2eで別途確認済みである。この確認はDocker imageではなくnative localのGoサービスを使い、Turnstileのtest keyを経由する。確認する経路は録音から日本語ASR、動物の自動連想、音声合成を経て再生とダウンロードまでである。この通しはtest本体13.1秒、run全体13.7秒で成功している。

Cloud Run側の反映はCloudflare Worker deployとは別の外部操作gateとして扱う。GCP project `mo-speech-501706` のus-central1へ、private Cloud Run service `zoovoice` をdeploy済みである。次のremote操作は完了している。

- privateなArtifact Registryへのcontainer image push
- GCP projectでのCloud Run resource作成とdeploy実行
- invoker service accountの作成と対象serviceへの `roles/run.invoker` 付与
- invoker service account keyの発行とWorker secret登録
- production Turnstile widgetの作成
- 有効化varsの `wrangler.toml` への追加
- 本番D1へのZoovoice counter migration適用
- 有効化varsを含むproduction Workerのdeploy

実環境smokeで確認済みなのは次の範囲である。

- 公開 `GET /api/zoovoice/config` が200を返し、有効な状態とTurnstile必須を示すこと
- 公開 `GET /api/zoovoice/animals` が200で音源カタログを返すこと（当時27種。この確認はビルド時の静的JSONを返していた頃のもの）
- 公開 `/zoovoice` とZoovoice用JS assetが200で配信されること
- 実ブラウザでのUI表示、production Turnstile widgetの表示、`Powered by Stability AI` の表示
- private Cloud Runの `/animals` と実音声の `POST /compose` が認証付きrequestで200を返すこと
- 認証なしのCloud Run直接requestが403で拒否されること

Worker経由の実 `POST /api/zoovoice/compose` は未確認である。この経路の通過にはproduction Turnstileの人間操作が必要なためである。CAPTCHAは回避しないため、自動smokeの対象にしない。Worker側のID token交換とorigin requestは、fake endpointを使う契約testで固定している。この1件の人間確認を終えるまで、公開経路全体を実地確認済みとして扱わない。

## 将来の分割

productionでは単一Workerを正とする。staging環境は廃止したため、環境の分割は将来の分割候補に数えない。
