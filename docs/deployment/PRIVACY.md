# 公開デモのデータ取扱い境界

更新日: 2026-07-17

この文書は実装上のデータフローと保存境界を固定する技術文書である。利用者向けの案内は [Voice Lab プライバシーポリシー](../PRIVACY_POLICY.md) を正とし、公開画面の `/privacy` から同じ内容を確認できるようにする。

## 外部処理

| 処理主体 | 渡す情報 | 用途 |
| --- | --- | --- |
| Cloudflare Worker | Googleログイン結果、入力テキスト、音声bytes、job状態 | 認証、quota、API gateway、短期job中継 |
| Google OAuth | OAuth認証に必要な情報 | 公開生成APIと管理画面のログイン |
| OpenAI | 対象機能の入力音声またはテキスト | ASR、翻訳、テキスト加工、TTS |
| RunPod Serverless | SpeakLoopの本人録音、模範TTS、復唱・お手本音声。管理者研究時は参照音声、台本、翻訳結果、生成設定 | FunASR、Seed-VC、管理者専用VibeVoice |

ブラウザへOpenAI・RunPodのAPI keyを渡さない。URL参照音声の取得はローカルFastAPIだけで行い、Cloudflare WorkerとRunPodへURL、cookie、ログイン情報を送らない。公開SpeakLoopの自己音声は同じ送信のステップ1本人録音だけを参照にし、別ファイル、タブ音声、URLを受け付けない。

同意、AI生成表示、保存・削除、外部送信、abuse対応はVibeVoice固有ではなく、Seed-VCと将来の音声providerにも適用するVoice Lab共通方針とする。利用者が送信権限を持つ音声だけを扱い、用途、送信先、Voice Lab側の保存有無を送信前に表示する。checkboxは第三者本人の同意を証明するものではないため、公開入力面とserver contractでも扱える参照音声を制限する。

## Voice Labが保存する情報

- Cloudflare公開版は、利用者の入力音声と生成音声をVoice Labの履歴として保存しない。
- Google emailはquotaと監査の識別に使う前にSHA-256 hash化する。D1と現在のKV fallbackは、quota keyとaudit eventへ平文emailを新規保存しない。
- 2026-07-16より前のlegacy KVには、quota keyまたはaudit eventへ平文emailが残っている可能性がある。現在の実装は利用時にhash key／`email_hash`へ移行するが、公開環境で旧keyと旧eventを検索・削除した証拠は別途必要である。
- Googleログイン後のブラウザには、email、発行時刻、有効期限を含む署名cookieを `HttpOnly`、`Secure`、`SameSite=Lax` で保存する。payloadは改ざん検知されるが暗号化はされない。有効期間は30日とし、ログアウト時に削除する。未使用のGoogle表示名と画像URLはcookieへ保存しない。
- D1はquota使用数、hash化した識別子、簡易audit event、公開サンプルmetadataを保存する。日次quotaは48時間、audit eventは90日で削除し、累計quotaと対応するhash識別子は利用上限を維持するため公開デモの運用中に限り保持する。
- R2は管理者が公開用として登録したサンプル音声だけを保存する。
- 既存SkitVoice sampleは由来・許諾・生成model・AI生成表示を確認できないため、一般向けsample APIから返さない。外部R2 objectはこのローカル変更では削除せず、管理者経路でのみ確認・管理する。
- KVは短期job snapshot、ready状態、設定、bindingがない環境のfallbackに使う。短期job snapshotは1時間、fallbackの日次quotaは48時間、audit eventは90日で失効する。fallbackの累計quotaは公開デモの運用中に限り保持する。管理設定の `admin_google_emails` には運営者の平文emailを保存し、`/fun` のuser settingsには管理者が入力した設定・本文を保存できる。一般利用者のquota・audit識別子とは用途を分ける。
- ローカルFastAPI版は開発者の端末へ音声履歴と診断情報を保存でき、Cloudflare公開版とは保存境界が異なる。

「履歴として保存しない」は、OpenAI、RunPod、Google、Cloudflareがそれぞれのサービス条件に基づいて行う処理やログ保持まで否定する表現として使わない。正式なプライバシーポリシーでは、各処理事業者の現行条件を確認して案内する。

## RunPodのjob・result・log境界

RunPod requestは入力音声base64、台本、翻訳結果をapplication logやerrorへ含めない。cancel、failure、timeout、malformed responseでもraw payloadを文字列化しない。これはVoice Lab application logの契約であり、RunPod platform側のjob input/result/log保持を削除する保証ではない。

Voice LabはRunPod requestへoperation別の独自policyを付けず、RunPodの既定でjobを実行する。Cloudflare公開版は音声をVoice Labの履歴へ保存しない。RunPod側の一時処理・保持は同社のサービス条件に従うため、Voice Labが保持ゼロを保証する表現はしない。これは外部送信の説明事項であり、operation別policyの設定を公開停止条件にはしない。

## 保持期間、削除と問い合わせ

期限のあるD1の日次quotaとaudit eventは、Cloudflare WorkerのCron Triggerで1日1回削除する。KVの短期job、日次quota、audit fallbackにはTTLを設定する。累計quotaは利用上限を維持するデータなので公開デモ運用中は自動削除せず、デモ終了時に削除する。

利用者向けの問い合わせはGitHub repositoryのPrivate vulnerability reportingを非公開連絡経路として使う。削除依頼では対象を特定するためGoogleログインに使ったemailの確認を求める場合がある。公開Issueへ個人情報を書かせない。

公開再開前の外部作業として、productionへ新Workerを反映した後にlegacy KVの平文email keyを削除し、残存0件を再確認する。
