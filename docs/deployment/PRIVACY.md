# 公開デモのデータ取扱い境界

更新日: 2026-07-16

この文書は実装されているデータフローと未決定事項を固定する技術文書であり、利用者へ提示する完全なプライバシーポリシーではない。連絡先、保持期間、削除依頼手順、外部処理事業者の条件を確定した正式文書ができるまで、ポートフォリオ用repositoryと公開デモの公開再開を完了扱いにしない。

## 外部処理

| 処理主体 | 渡す情報 | 用途 |
| --- | --- | --- |
| Cloudflare Worker | Googleログイン結果、入力テキスト、音声bytes、job状態 | 認証、quota、API gateway、短期job中継 |
| Google OAuth | OAuth認証に必要な情報 | 公開生成APIと管理画面のログイン |
| OpenAI | 対象機能の入力音声またはテキスト | ASR、翻訳、テキスト加工、TTS |
| RunPod Serverless | 対象機能の音声bytes、台本、生成設定 | FunASR、VibeVoice、Seed-VC |

ブラウザへOpenAI・RunPodのAPI keyを渡さない。URL参照音声の取得はローカルFastAPIだけで行い、Cloudflare WorkerとRunPodへURL、cookie、ログイン情報を送らない。

## Voice Labが保存する情報

- Cloudflare公開版は、利用者の入力音声と生成音声をVoice Labの履歴として保存しない。
- Google emailはquotaと監査の識別に使う前にSHA-256 hash化する。D1と現在のKV fallbackは、quota keyとaudit eventへ平文emailを新規保存しない。
- 2026-07-16より前のlegacy KVには、quota keyまたはaudit eventへ平文emailが残っている可能性がある。現在の実装は利用時にhash key／`email_hash`へ移行するが、公開環境で旧keyと旧eventを検索・削除した証拠は別途必要である。
- Googleログイン後のブラウザには、email、発行時刻、有効期限を含む署名cookieを `HttpOnly`、`Secure`、`SameSite=Lax` で保存する。payloadは改ざん検知されるが暗号化はされない。既定の有効期間は30日で、未使用のGoogle表示名と画像URLはcookieへ保存しない。
- D1はquota使用数、hash化した識別子、簡易audit event、公開サンプルmetadataを保存する。
- R2は管理者が公開用として登録したサンプル音声だけを保存する。
- KVは短期job snapshot、ready状態、設定、bindingがない環境のfallbackに使う。管理設定の `admin_google_emails` には運営者の平文emailを保存し、`/fun` のuser settingsには管理者が入力した設定・本文を保存できる。一般利用者のquota・audit識別子とは用途を分ける。
- ローカルFastAPI版は開発者の端末へ音声履歴と診断情報を保存でき、Cloudflare公開版とは保存境界が異なる。

「履歴として保存しない」は、OpenAI、RunPod、Google、Cloudflareがそれぞれのサービス条件に基づいて行う処理やログ保持まで否定する表現として使わない。正式なプライバシーポリシーでは、各処理事業者の現行条件を確認して案内する。

## 公開再開前に決める事項

1. D1のaudit event、日次quota、累計quota、KV fallbackごとの保持期間。
2. 期限を超えたデータの自動削除または運用削除の実装と検証方法。
3. legacy KVの平文email key／eventが残っていないことの確認と、残存時の削除記録。
4. Google署名cookieの30日という有効期間を維持するか、短縮するか。
5. 利用者が問い合わせ・削除依頼を行うための連絡先と本人確認方法。
6. 外部処理事業者、処理目的、送信データ、各社policyへのリンク。
7. Googleログイン前と音声送信前に提示する同意・注意文と、正式policyへの導線。
8. 公開サンプル音声の権利確認記録と削除依頼への対応方法。

保持期間や連絡先を未決定のまま推測で本文へ入れない。決定後は [SPEC.md](../speech-translation/SPEC.md)、[STORAGE.md](STORAGE.md)、README、公開画面を同時に更新する。
