# Voice Lab プライバシーポリシー

最終更新日: 2026年8月4日

## English summary

- Privacy policy. The Japanese text below is the binding version; this summary is informational.
- The Google login email is used for sign-in checks and usage limits. Usage-count records and operation logs store a SHA-256 identifier, not the raw address.
- The logged-in email address and login time are also stored where the operator can review them, to check usage and investigate misuse.
- Input audio and text are processed by external services (OpenAI, RunPod, Google Cloud Run) for generation and evaluation.
- The public deployment does not store user input audio or generated audio as history. Short-lived result data may contain generated audio and expires in one hour.
- Zoovoice sends a recording once, automatically, when recording stops; canceled or sub-0.5-second recordings are not sent.
- Only the recognized text goes to OpenAI for animal association; the audio itself does not.
- Retention: login cookie 30 days / short-lived results 1 hour / daily usage counts deleted within 3 days / operation logs about 90 days.
- Cumulative usage counts (hashed IDs) and the login email and time records are kept while the public demo operates and deleted when it ends.
- Transient processing and provider-side logs (Cloudflare, Google) are not guaranteed to be zero.

## 扱う情報と目的

- Googleログインのメールアドレスを、ログイン確認と利用回数の制限に使います。
- 利用上限を管理するため、利用者ごとの利用回数を記録します。音声や入力内容はこの記録に含まれません。
- 利用回数の記録と操作ログには、メールアドレスそのものではなくSHA-256で変換した識別子を保存します。
- ログインしたメールアドレスと日時は、運営者が管理画面で確認できる形で保存します。利用状況の把握と不正利用の確認に使います。
- 入力した音声・テキストと生成音声を、翻訳、音声生成、発音評価のために処理します。

## 音声の取り扱い

SpeakLoopのCloudflare公開版は、利用者の入力音声と生成音声をVoice Labの履歴として保存しません。処理のため、入力音声・テキストはCloudflareを経由してOpenAIまたはRunPodへ送られます。処理結果を受け渡す短期データには生成音声が含まれる場合があり、1時間で失効します。

### Zoovoice

Zoovoiceを利用したときの処理内容は次のとおりです。

- Zoovoiceのページを開くと、不正利用防止のためのCloudflare Turnstileをすぐに読み込みます。録音しない場合でも、この読み込みでブラウザはCloudflareと通信します。
- 録音は、手動で止めたときか60秒で自動停止したときに、1回だけ自動で送信されます。送信前に押すボタンはありません。
- 録音中にキャンセルした音声と、0.5秒未満の短い録音は送信しません。
- もう一度送信されるのは、失敗した後に利用者が「もう一度生成」を押した場合だけです。
- ブラウザの録音と2つの設定は、Cloudflare Workerを経由して非公開のGoogle Cloud Runへ送られます。2つの設定とは、鳴き声の挿入頻度（アニマル度）と動物の種類数です。
- Cloud Runは日本語の音声認識、動物の自動連想、鳴き声を差し込んだ音声の合成をします。どの動物になるかは話した内容から自動で選ばれ、利用者が動物を指定する項目はありません。
- 動物を選ぶのはOpenAIのAPIです。認識した文字は、この連想のためOpenAIへ送られます。音声そのものはOpenAIへ送りません。
- 認識した文字と連想の結果は、送信元と同じブラウザにだけ返します。連想の結果とは、選ばれた動物と、その動物を選んだ理由の短い説明です。
- 録音、生成音声、認識した文字、連想の理由は保存しません。Voice Labの履歴、D1、R2、アプリケーションログのいずれにも保存しません。
- ただしCloudflareとGoogleの側で起こる一時処理やprovider側のログ保持が、ゼロだとは保証しません。

## 保持期間

- Googleログイン用cookie: 30日。ログアウト時は直ちに削除します。
- 処理結果の短期データ: 1時間。
- 日ごとの利用回数は、利用日から3日以内に削除します。
- 操作ログは、約90日間保存します。
- 累計利用回数と対応する識別子: 利用上限を維持するため公開デモの運用中。公開デモ終了時に削除します。
- ログインしたメールアドレスと日時: 公開デモの運用中。公開デモ終了時に削除します。
