# 公開デモのデータ取扱い境界

更新日: 2026-08-04

この文書は実装上のデータフローと保存境界を固定する技術文書である。利用者向けの案内は [Voice Lab プライバシーポリシー](../PRIVACY_POLICY.md) を正とし、公開画面の `/privacy` から同じ内容を確認できるようにする。

## 外部処理

| 処理主体 | 渡す情報 | 用途 |
| --- | --- | --- |
| Cloudflare Worker | Googleログイン結果、入力テキスト、音声bytes、job状態 | 認証、quota、API gateway、短期job中継 |
| Google OAuth | OAuth認証に必要な情報 | 公開生成APIと管理画面のログイン |
| OpenAI | 対象機能の入力音声またはテキスト | ASR、翻訳、テキスト加工、TTS |
| RunPod Serverless | SpeakLoopの本人録音、模範TTS、復唱・お手本音声 | FunASR、Seed-VC |
| Cloudflare Turnstile | Zoovoiceの検証tokenとclient IP | 自動化された大量利用の抑止 |
| Google Cloud Run | Zoovoiceの録音音声とアニマル度 | 日本語ASR、動物の自動連想、鳴き声を重ねた音声の合成 |

最後の2行はZoovoice専用である。この2つの送信は `ZOOVOICE_ENABLED=1` の配備でだけ発生する。Zoovoiceは公開環境へdeployしていない。

ブラウザへOpenAI・RunPodのAPI keyを渡さない。Cloudflare WorkerとRunPodへURL、cookie、ログイン情報を送らない。公開SpeakLoopの自己音声は同じ送信のステップ1本人録音だけを参照にし、別ファイル、タブ音声、URLを受け付けない。

同意・AI生成表示・保存/削除・外部送信・abuse対応は、Seed-VCと将来の音声providerに適用するVoice Lab共通方針とする。利用者が送信権限を持つ音声だけを扱い、用途、送信先、Voice Lab側の保存有無を送信前に表示する。checkboxは第三者本人の同意を証明するものではないため、公開入力面とserver contractでも扱える参照音声を制限する。

## Voice Labが保存する情報

- Cloudflare公開版は、利用者の入力音声と生成音声をVoice Labの履歴として保存しない。
- Google emailはquotaと監査の識別に使う前にSHA-256 hash化する。D1と現在のKV fallbackは、quota keyとaudit eventへ平文emailを新規保存しない。
- ログインしたメールアドレスと日時は `public_users` テーブルへ平文で保存し、管理者だけが `GET /api/public-users` と `/admin` の利用者一覧で読む。quota keyとaudit eventは従来どおりhashだけを保存する。平文emailは公開デモの運用中に限り保持し、公開デモ終了時に削除する。
- 2026-07-16より前に作られた平文emailを含むlegacy KV quota keyは、新Workerのproduction反映後に2件を削除した。2026-07-17の再検査で、legacy KVの平文email keyは0件である。
- Googleログイン後のブラウザには署名cookieを保存する。cookieの内容はemail、発行時刻、有効期限である。保存属性は `HttpOnly`、`Secure`、`SameSite=Lax` とする。payloadは改ざん検知されるが暗号化はされない。有効期間は30日とし、ログアウト時に削除する。未使用のGoogle表示名と画像URLはcookieへ保存しない。
- D1はquota使用数、hash化した識別子、簡易audit event、公開サンプルmetadataを保存する。48時間を超えた日次quotaと90日を超えたaudit eventを日次処理で削除するため、実際の最大保持期間はそれぞれ3日未満、91日未満となる。累計quotaと対応するhash識別子は利用上限を維持するため公開デモの運用中に限り保持する。
- R2は管理者が公開用として登録したサンプル音声だけを保存する。
- 過去の研究機能で登録したsampleは、一般向けsample APIから返らない。保持は保証せず、管理者のsample保存・削除操作で削除され得る。
- KVは短期job snapshot、ready状態、公開アクセス設定、bindingがない環境のfallbackに使う。短期job snapshotは1時間、fallbackの日次quotaは48時間、audit eventは90日で失効する。fallbackの累計quotaは公開デモの運用中に限り保持する。管理設定の `admin_google_emails` には運営者の平文emailを保存する。一般利用者のquota・audit識別子とは用途を分ける。
- ローカルFastAPI版は開発者の端末へ音声履歴と診断情報を保存でき、Cloudflare公開版とは保存境界が異なる。

「履歴として保存しない」は、外部処理事業者が行う処理やログ保持まで否定する表現として使わない。対象事業者はOpenAI、RunPod、Google、Cloudflareである。正式なプライバシーポリシーでは、各処理事業者の現行条件を確認して案内する。

## RunPodのjob・result・log境界

RunPod requestは入力音声base64と台本をapplication logやerrorへ含めない。cancel、failure、timeout、malformed responseでもraw payloadを文字列化しない。これはVoice Lab application logの契約であり、RunPod platform側のjob input/result/log保持を削除する保証ではない。

Voice LabはRunPod requestへoperation別の独自policyを付けず、RunPodの既定でjobを実行する。Cloudflare公開版は音声をVoice Labの履歴へ保存しない。RunPod側の一時処理・保持は同社のサービス条件に従うため、Voice Labが保持ゼロを保証する表現はしない。これは外部送信の説明事項であり、operation別policyの設定を公開停止条件にはしない。

## Zoovoiceのデータ境界

Zoovoiceは `ZOOVOICE_ENABLED=1` の配備だけで公開routeとAPIを提供する。公開環境へはdeployしていない。この節は有効化した配備でのデータ境界を示す。

この節が示すASR、動物の自動連想、応答metadataはリポジトリの現在のコードに実装済みである。Cloud Runへのdeployと本番有効化は未実施である。機能仕様は [SPEC](../speech-translation/SPEC.md) を正とする。

### 用語

- アニマル度とは、鳴き声の挿入頻度を決める設定を指す。通常UIで利用者が変えられる設定はこれだけとする。
- 動物の自動連想とは、ASR本文から動物1種を自動で選ぶ処理を指す。
- 根拠語とは、その選択に使ったASR本文中の語を指す。
- 連想metadataとは、選ばれた動物と根拠語と選択方式を指す。random fallbackではその理由も含む。

### 送信経路と処理

`/zoovoice` のページは、config取得後のページ表示時からTurnstileのscriptとwidgetをCloudflareから読み込む。録音しない訪問でも、この読み込みでブラウザからCloudflareへの接触が起きる。

compose用の録音とアニマル度は、ブラウザからCloudflare Workerへ送る。送信は録音の手動停止または60秒の自動停止の直後に、自動で1回だけ行う。録音中に取消した音声と500ms未満の録音はWorkerへ送らない。追加の送信は、retry可能な失敗の後に利用者が「もう一度生成」を押した場合だけ発生する。

Workerは受け取った録音とアニマル度をGoogle Cloud Runへ一時送信する。Cloud Runは日本語ASR、動物の自動連想、鳴き声を重ねた音声の合成を担当する。Cloud Runはprivate IAMを前提とし、ブラウザからCloud Runへ直接送る経路は持たない。

productionのWorkerは、専用invoker service accountのkeyで署名したJWTをGoogleのtoken endpointで短期ID tokenへ交換し、そのtokenを付けてCloud Runを呼ぶ。ID tokenはisolate内のmemoryだけへ短期cacheし、KV・D1・R2へ保存しない。service account key、JWT、ID tokenは応答とlogへ含めない。この認証は実装済みであり、実keyの登録とCloud Runへの実deployは未実施の外部操作である。ローカルのsmoke確認では、developer端末のgcloud service account impersonationで取得した短期ID tokenをlocal Wrangler経由で渡す。

WorkerはTurnstileをserver-sideで検証する。検証はcompose requestごとに行う。ブラウザは使ったtokenを成功・失敗の後にresetし、次のtokenを取得する。この検証では検証tokenをCloudflareのSiteverify APIへ送る。Cloudflareがrequest headerで渡すclient IPを取得できた場合は、そのIPも同じrequestへ添えて送る。Turnstile tokenはCloud Runへ転送しない。Cloud Runへ渡すのは録音の音声bytesとアニマル度の設定JSONだけである。動物と挿入位置はCloud Run側が決めるため、ブラウザから配置設定を送らない。

入力上限と利用上限は合成前に判定する。音声ファイルは10MB以下、設定JSONは64KB以下とする。利用上限はUTC日次100件、UTC月次1,200件とする。この上限は利用者ごとではなく、Zoovoice全体の合計へ適用する。

次のいずれかに当たる場合、WorkerはCloud Runを呼ばない。

- Turnstileの検証に失敗した
- Cloud Run向けID tokenを取得できなかった
- D1へ到達できない、またはcounterを更新できなかった
- 日次または月次の上限を超えた

ASR本文、根拠語、録音、生成音声は応答の生成に必要な間だけ扱う。これらをapplication log、D1、R2、Voice Labの履歴へ書かない。合成応答は、ASR本文と連想metadataを送信元と同じブラウザへ返す。

合成requestの処理でGo APIのサービスログへ記録するのは、次の項目である。

- 処理段階と状態、失敗時のエラーコード
- 各段階の経過時間
- HTTPのmethodとpath、応答status
- 選んだ種IDと選択方式
- 入力と出力のbyte数、アニマル度の値
- 入力音声と出力音声の長さ、発話の合計時間
- 無音判定の最小秒数、無音区間数、挿入数

このほか、プロセスの起動時には待受port、利用可能な動物数、timeoutの設定秒数を記録する。追加素材が見つからない場合の警告や、起動に失敗した理由も記録する。

いずれの項目も音声や本文の内容そのものを含まない。録音と生成音声の内容、ASR本文、根拠語はサービスログへ書かない。

D1へ音声と入力本文を保存しない。保存するのはZoovoice共通の日次・月次counterと更新時刻だけである。Cloudflare公開版は入力音声と生成音声をVoice Labの履歴として保存しない。ただしCloudflareとGoogleの側で起こる一時処理やlog保持がゼロだとは保証しない。

動物一覧はCloud Runを起動せず、Worker Static Assetsの静的JSONから返す。この経路では音声データを扱わない。

Cloud Runのregionは `us-central1` とする。実際のCloud Run deployと有効化は別の外部操作gateであり、未実施である。有効化する前に本書と [Voice Lab プライバシーポリシー](../PRIVACY_POLICY.md) を確認する。

## 保持期間、削除と問い合わせ

期限のあるD1の日次quotaとaudit eventは、Cloudflare WorkerのCron Triggerで1日1回削除する。KVの短期job、日次quota、audit fallbackにはTTLを設定する。累計quotaは利用上限を維持するデータなので公開デモ運用中は自動削除せず、デモ終了時に削除する。

GitHub repositoryはpublicである。Private vulnerability reportingは有効であり、外部からsecurity advisoryを非公開で報告できる。

productionへの新Worker反映とlegacy KV削除は完了しており、平文email keyの残存は0件である。
