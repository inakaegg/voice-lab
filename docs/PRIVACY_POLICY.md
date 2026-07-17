# Voice Lab プライバシーポリシー

最終更新日: 2026年7月17日

## 扱う情報と目的

- Googleログインのメールアドレスを、ログイン確認と利用回数の制限に使います。
- 利用回数の記録と監査ログには、メールアドレスそのものではなくSHA-256で変換した識別子を保存します。
- 入力した音声・テキストと生成音声を、翻訳、音声生成、発音評価のために処理します。

## 音声の保存

Cloudflare公開版は、利用者の入力音声と生成音声をVoice Labの履歴として保存しません。処理結果を受け渡す短期データには生成音声が含まれる場合があり、1時間で失効します。外部処理事業者側の保持は各社の条件に従います。

## 保持期間

- Googleログイン用cookie: 30日。ログアウト時は直ちに削除します。
- 処理結果の短期データ: 1時間。
- 1日ごとの利用回数: 48時間。
- 監査ログ: 90日。
- 累計利用回数と対応する識別子: 利用上限を維持するため公開デモの運用中。公開デモ終了時に削除します。

期限のある1日ごとの利用回数と監査ログは、Cloudflare Workerの日次処理で削除します。

## 外部処理事業者

- [Cloudflare](https://www.cloudflare.com/privacypolicy/): Web配信、認証中継、利用回数の記録、短期データ、監査ログ。
- [Google](https://policies.google.com/privacy?hl=ja): Google OAuthログイン。
- [OpenAI](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint): 音声認識、翻訳、テキスト加工、音声生成。
- [RunPod](https://www.runpod.io/legal/privacy-policy): 中国語音声認識と、利用者が選んだ場合の声質変換。

## 問い合わせ

保存情報についての問い合わせは、GitHub repositoryのSecurity画面にある [Report a vulnerability](https://github.com/inakaegg/voice-lab/security/advisories/new) から非公開で連絡してください。削除依頼では、Googleログインに使ったメールアドレスの確認をお願いする場合があります。公開Issueへ個人情報を投稿しないでください。
