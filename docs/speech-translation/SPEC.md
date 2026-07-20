# Voice Lab Webアプリ仕様

更新日: 2026-07-22

## 目的

Voice Labは、音声を使って発音を学ぶSpeakLoopを公開ポートフォリオの主機能とする。複数話者音声生成のSkitVoice/VibeVoiceは一般公開製品から外し、privateまたは管理者専用の研究機能として隔離する。ローカルFastAPI、Cloudflare Worker、RunPod Serverlessの責任を分離し、秘密情報とGPU処理をブラウザへ置かない。

## 正式route

| route | 用途 | Cloudflareでの公開範囲 |
| --- | --- | --- |
| `/` | Voice Labポータル | 公開 |
| `/speakloop` | SpeakLoop | 公開 |
| `/skitvoice` | 研究機能の非公開案内（生成・sampleなし） | 公開 |
| `/admin` | 総合管理 | 管理者認証必須 |
| `/speakloop/admin` | SpeakLoop管理 | 管理者認証必須 |
| `/skitvoice/admin` | SkitVoice管理 | 管理者認証必須 |
| `/fun` | 実験的な音声変換デモ | 管理者認証必須 |

### 管理者認証

- `/fun` は管理者認証済みの場合だけ表示・利用でき、公開ポータルには導線を置かない。
- Cloudflare版の管理者認証は、公開生成APIと同じGoogle OAuthセッションを使う。許可メールに含まれるアカウントだけが、管理route・管理API・`/fun` とその生成機能・Seed-VC APIへアクセスできる。
- 音声翻訳とSeed-VCは、job作成だけでなくstatus pollingと結果取得も管理者専用にする。
- `/fun` のAPI境界は、公開生成のログイン必須設定をOFFにしても維持する。
- 管理者は公開quotaを消費しないが、入力サイズ上限は適用する。
- 別の管理パスワードや管理者cookieは設けない。
- ローカルFastAPIは開発者が起動する信頼済み環境として、管理ログインなしで管理画面と `/fun` を提供する。
- 廃止した旧routeへの互換aliasは設けない。Static AssetsのHTMLファイルを直接指定して管理者認証を迂回できないようにする。

### SkitVoice/VibeVoiceの公開境界

Cloudflare版では、匿名利用者と通常のGoogleログイン利用者のどちらにも、SkitVoice/VibeVoiceのinteractive generationを許可しない。公開ポータルには製品導線を置かず、`/skitvoice` は生成フォームやsampleを含まない案内だけを返す。

次の全APIを、route個別の表示条件ではなく、既存Google管理者セッションを使う共通server-side guardで保護する。

- `GET /api/vibevoice/status`
- `POST /api/vibevoice/reference-audio-from-url`
- `POST /api/vibevoice/scripts`
- `POST /api/vibevoice/jobs`
- `GET /api/vibevoice/jobs/{id}`
- `POST /api/vibevoice/jobs/{id}/cancel`

- Cloudflare Workerにはsync generation APIを設けない。ローカルFastAPIの `POST /api/vibevoice/generate` と上記API、`/skitvoice`、`/skitvoice/admin` は、開発者が起動する信頼済み研究環境として維持する。
- Cloudflareの `/skitvoice/admin` と直接配信用HTML `/static/vibevoice.html` は管理者認証必須とする。旧 `/vibevoice*` routeは404を維持する。
- `GET /api/public-session` は非adminへSkitVoiceのfeature/quota設定を返さず、`GET /api/public-sample-audios` は非adminへSkitVoice sampleを返さない。
- 外部R2 objectはこの実装変更では削除しない。

この管理者境界はproduction公開環境へ反映済みだが、研究機能を一般公開できることの証明ではない。VibeVoice runtime、第三者Large mirror、ComfyUI fork、RunPod imageはprivate維持を前提とする。

## SpeakLoop

日本語話者が、言いたい内容を母語で録音し、学習言語の模範文と音声を作って発音を練習する。今後の学習機能の方針は [ROADMAP.md](ROADMAP.md) を参照する。

### 録音と言語

- 学習言語は `🇺🇸 English`、`🇨🇳 中文` の順とし、既定値は英語にする。
- 2つの録音ボタンが新規お手本生成と復唱評価の意図を明示し、録音内容による用途の自動判定は行わない。録音中は取消でき、取消した音声はAPIへ送らない。
- 母語で「言いたいことを話す」録音は言語自動判定が必要なため、OpenAI ASRを使う。
- 中国語の目標文とASR結果は、FastAPIとCloudflare Workerの両方で、OpenCCにより簡体字の字形へ正規化してAPIから返す。地域語彙は置き換えない。
- 公開UIでは中国語選択時だけ `字形` の `简体`／`繁體` を切り替えられる。繁体字表示はブラウザ内のOpenCC変換だけで行い、切替でAPI、TTS、採点を再実行しない。

### 復唱のASR

- 復唱録音と通常TTSのお手本音声の両方を言語別ASRにかけ、同じtimestamp形式へ正規化する。
- 中国語 `zh-CN` はRunPod Serverless endpointのFunASR `paraformer-zh`、英語 `en-US` はOpenAI `whisper-1` を使う。
- 中国語では `paraformer-zh` のASR仮説本文を、同じ音声に対する `fa-zh` のforced alignmentへ渡す。本文はスペースを挟まず連結し、`fa-zh` の先頭token消費を避ける。
- 整列後は±0.35秒以内の発話島エッジへVADスナップし、`words` の時刻だけを差し替える。認識単位の順序とLLMへ渡す位置番号は変更しない。
- `fa-zh` は中国語比較ASRだけに使う。token数がASR単位数と一致しない場合は、誤った位置対応を返さずjobを失敗させる。
- FunASRは `fsmn-vad` と `ct-punc` を併用し、文字単位timestampを既存の `asr_timestamps.words` の秒単位形式へ変換する。
- 中国語復唱でFunASRが失敗した場合、採点結果がproviderによって変動しないよう、別ASRへ黙って切り替えずエラーを返す。
- お手本音声ASRは、音声内容のハッシュ・言語・provider・整列方式の世代をキーにキャッシュする。同じお手本を再ASRしない。

### LLMによる比較・採点

- 模範音声と復唱音声のASR本文・単語時刻をLLMへ送り、目標文のフレーズ分割、両ASRとの対応付け、全体とフレーズごとの点数・コメントを一度に得る。
- LLMはフレーズごとの対応状態（`assigned`/`partial`/`missing`）、対応する認識単位の位置番号（`word_start_index`/`word_end_index`）、点数、コメントを返す。誤答や言い直しは、一致した部分だけへ狭めず、対応する発話全体を選ぶ。
- 元の時刻、余白適用後の再生時刻、一致文字列（`matched_text`）はLLMに転記させない。位置番号から一意に決まる値のため、アプリが検査済みの位置番号が指す認識単位から直接計算する。
- アプリは、フレーズを連結すると元の目標文になること、位置番号が認識単位配列の範囲内であること、点数の範囲を検査する。フレーズ分割、点数、位置番号の対応付けそのものは作り直さない。
- ローカルFastAPI版では、比較モデルと前後共通余白を画面で変更できる。比較モデルの選択肢は `gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.4-mini`、`gpt-5.4-nano` の4つとする。初期値は `gpt-5.6-terra` にする。
- 前後共通余白は0.00〜0.50秒を0.05秒刻みで選ぶ。お手本と復唱の両方へ同じ値を使い、初期値は0.30秒にする。
- 再生余白は選択範囲の外側にある無音だけへ延長する。隣接する認識単位の境界でクランプし、隣の発話へ食い込ませない。ブラウザは切り出し再生の両端へ30msのfadeを適用する。
- Cloudflare公開版では、比較モデルと前後共通余白の設定UIを表示しない。ブラウザに以前の保存値がある場合も、`gpt-5.6-terra` と0.30秒を使う。
- LLM呼び出しまたは返却値の検査に失敗した場合、従来処理へ切り替えず「比較結果を作成できませんでした。もう一度お試しください。」と表示する。
- ローカルFastAPI版とCloudflare公開版の両方がこの処理に対応済みである。ローカル版は復唱ごとの診断ログを `tmp/practice-llm-alignment/` へ保存する。Cloudflare版は診断ログを保存しない方針のため、API使用量・推定料金はユーザー画面へ返さない。
- ローカルFastAPI版は、比較モデル・再生余白・terminal snapshotを音声履歴と独立した短期job stateへ保存する。音声履歴が無効でも、再起動後のpollingで比較条件を維持する。Cloudflare版は同じ役割を `MO_SPEECH_KV` が担う。
- 文字列類似度による旧比較処理は削除済みであり、LLM処理の失敗時に旧処理へ切り替える分岐は設けない。

### 聞こえた言葉のdiff表示

- 「聞こえた言葉」はASR本文を落とさず、置換・追加を強調する。目標文側で抜けた文字は下段に `_`、その直上に正解文字を表示する。
- 連続する同種の不一致は1つのまとまりとして表示し、1文字ずつには分割しない。
- 中国語 `zh-CN` では、目標文と復唱ASR本文の文字ごとの声調つきピンインをサーバー側で生成し、置換として検出された文字対を再判定する。
  - 声調まで完全一致する場合は、同音の別字としてASRが選んだだけとみなし、誤りとして強調しない。
  - 音節が一致し声調だけ違う場合は、「声調のみの違い」として通常の誤りと異なる見た目で示す。
  - サーバーは連続する漢字をまとめて変換し、文脈依存の読みを可能な範囲で反映する。非漢字位置には空文字列を置き、文字別配列の添字を比較用文字列と一致させる。
  - ライブラリで読みを確定できない多音字（例: 副詞の「地」）は、この判定の対象外になり得る。

### 自分の声（Seed-VC）

- `自分の声` は既定オフとする。オンの場合は、母語録音をSeed-VC参照音声、通常TTSを変換元として、変換完了後の音声だけを再生用のお手本にする。
- 公開版の参照音声は、同じ `POST /api/practice/recordings` requestで利用者本人がステップ1として録音した `audio` だけを使う。自己音声用の別ファイル、タブ音声、URL、別requestの参照音声は受け付けない。ブラウザUIもMediaRecorderによるステップ1録音だけを入力面とする。
- トグル横には、hover・keyboard focus・click／tapで確認できる説明iconを置き、「同じセッションで最初に録音した音声からAI生成音声を作る」と短く案内する。
- トグルがオンの間は、録音とお手本音声を外部の音声処理サービスで一時処理し、Voice Labの履歴には保存しないことを録音前に表示する。詳細な保存・保持条件はprivacy文書を正とし、第三者の同意をcheckboxで証明できるとは扱わない。
- 通常TTSを先に成立させ、自己音声変換jobが失敗しても通常TTSで練習を続けられる契約を維持する。「本人の本当の声」や発音能力そのものが変わったと受け取れる表現を使わない。
- 比較再生の内容とtimestampは、Seed-VC前の通常TTSに対するASR結果を正とし、変換後音声をASRへ送らない。Seed-VCは発話内容、間、フレーズ時刻を変えず声質だけを変更する契約とする。
- ローカル版とCloudflare版のどちらもSeed-VC推論はRunPodへ依頼し、ローカルPython環境のSeed-VCを直接importしない。
- 公開Cloudflare版は入力音声、通常TTS、変換結果を履歴保存しない。

### 履歴からの表示確認（ローカル限定）

- ローカルFastAPI版では、成功済みの復唱履歴を `/speakloop` から選んで現在の結果表示へ復元できる。復元対象は目標文・認識結果・点数・コメント・比較区間・お手本音声・復唱音声とする。
- 復元時はOpenAIとRunPodを呼ばない。ASRとTTSも実行しない。
- 録音または音声処理の実行中は、履歴からの表示確認を開始できない。保存結果の表示中は復唱録音を無効にする。
- 保存時点の採点結果であることを画面に明示する。古い履歴に声調判定用ピンインがない場合は、ローカルの決定的な変換処理で補う。
- お手本音声は、お手本生成時に保存した `tts_text` と復唱結果の目標文が完全一致するものだけを対応付ける。同じ目標文のお手本が複数ある場合は、その復唱より前に作られた最も新しいものを選ぶ。あいまい一致や時刻の近さだけによる推測では選ばない。
- 対応するお手本音声が見つかった場合は、通常の復唱結果と同じ比較再生を復元する。見つからない場合は比較再生を無効にし、復唱音声と結果表示だけを復元する。
- 比較区間は `保存値` と `現行ロジックで再計算` のどちらで再生するかを選べる。既定は `保存値` とする。
- `現行ロジックで再計算` では、保存済みのASR単語時刻とLLMが返した位置番号を入力として、現在のサーバー実装で再生区間を計算し直す。LLMは呼び出さず、フレーズ分割・位置番号・点数・コメントは保存値をそのまま使う。
- 再計算には実装本体と同じ検証・計算経路を使う。表示確認専用の計算式を別に持たない。
- 再計算の余白は画面で選んでいる前後共通余白を使う。保存時点の余白と異なってよく、両者を画面に表示する。
- 音声長は比較時に使った値を診断メタデータへ保存し、再計算ではその保存値を使う。履歴へ保存する音声は再エンコードされるため、後から測り直すと比較時の音声長と一致しない。
- 音声長を保存していない古い履歴では、保存済み音声ファイルを測り、取得できない場合はASR単語の終了時刻で代用する。この2段は実装本体と同じ順序にする。
- 位置番号を持たない古い履歴、ASR単語が保存上限で切り詰められた履歴、お手本音声を対応付けできない履歴では再計算できない。理由を画面に示し、`保存値` のままにする。

### 非同期jobと進捗表示

- ユーザー画面は、お手本作成と復唱評価を非同期jobとして扱う。お手本の文字起こし・翻訳・通常TTS・両音声のASR・LLMによる比較結果作成を別の処理段階として受け取る。
- 中国語復唱はRunPod `/run` で非同期jobを作り、WorkerまたはFastAPIがstatusをpollingする。
- 公開UIの主要表示は処理目的で示す。表示例は `GPUサーバーの準備待ち`・`音声認識の準備`・`お手本音声の確認`・`録音の確認`・`比較結果の準備`・完了／失敗である。`自分の声` では `お手本の声を調整する準備`、`お手本の声を調整中` を使う。
- 主要文言の直下には技術詳細を小さく薄く併記する。内容はRunPod・FunASR・モデル名・raw stage・待機時間・処理時間・生のproviderエラーとする。同じ内容をサーバーログとブラウザの技術ログにも残す。
- 公開UIの主要ステータスとエラーは、providerを変更しても成立する文言にする。provider名・モデル名・raw stage・内部エラーは主要文言に含めない。分離先は弱い技術詳細・管理画面・ブラウザconsole・サーバーログとする。

## SkitVoice

- 台本と最大4つの参照音声から複数話者の会話音声を生成する。
- 初期台本は2話者・5行とし、台本自動生成は入力済みテキストを種に発展させる。
- 出力言語は `🇺🇸 English`、`🇨🇳 中文`、`🇯🇵 日本語` の順とし、既定値は英語にする。
- 台本言語と出力言語が異なる場合は自動翻訳し、生成前に翻訳文を表示する。
- 参照音声は、ローカル版ではファイル・マイク・タブ音声・URL切り出しの4方式、Cloudflare版ではURLを除く3方式に対応する。タブ音声は `getDisplayMedia` と `MediaRecorder` を利用できるブラウザだけに表示する。初期判定で非対応なら操作自体を隠し、利用開始時に非対応と判明した場合だけtoastで代替手段を案内する。
- 生成結果をASR timestampで検査し、必要に応じて話者位置補正、低スコア行再生成、Seed-VC後処理を行う。
- RunPod実行は非同期jobとし、管理者研究画面の主要表示は処理目的で区別する。provider／モデル名とraw stage、生の失敗理由は、弱い技術詳細・進捗ログ・サーバーログに残す。公開 `/skitvoice` は生成状態を持たない。
- 詳細は [VIBEVOICE.md](VIBEVOICE.md) を参照する。

## 実行環境の責任

| 処理 | ローカルFastAPI | Cloudflare Worker | RunPod handler |
| --- | --- | --- | --- |
| UI配信 | ○ | Static Assets | — |
| Google OAuth・公開quota | — | ○ | — |
| OpenAI ASR・翻訳・TTS | 母語入力、英語復唱、翻訳、TTS | 母語入力、英語復唱、翻訳、TTS | — |
| SpeakLoop中国語比較ASR | provider経由で非同期jobを依頼・polling | お手本／復唱音声bytesを非同期jobとして中継 | `paraformer-zh`でASR後に`fa-zh`整列とVADスナップ |
| URL参照音声取得 | `yt-dlp` + `ffmpeg` | 拒否 | 拒否 |
| VibeVoice・Seed-VC GPU推論 | provider経由で依頼 | job APIを中継 | ○ |
| quota・監査・サンプルmetadata | ローカルファイル | D1、bindingなし時のみfallback | — |
| 音声履歴 | ローカルファイル | 保存しない | 保存しない |
| 公開サンプル音声blob | ローカルファイル | R2、bindingなし時のみfallback | — |

RunPod handlerの契約:

- URL、cookie、ブラウザ認証情報を受け取らず、音声bytesだけを受け取る。
- SpeakLoop中国語復唱では `operation_mode=practice_asr`・`audio_base64`・`target_text` を受け取る。
- お手本ASRのキャッシュが無い場合は `model_audio_base64` も受け取る。handler outputは `practice_asr_contract_version=3` と `model_transcription` を必須とする。`model_transcription.words` にはforced alignment後の時刻を保存する。
- お手本ASRのキャッシュがある場合は `model_audio_base64` を省略できる。このjobではRunPod側のお手本ASRを行わないため、`model_transcription` も返さない。WorkerまたはFastAPIはjobと対応付けたキャッシュ済みASRを使う。
- forced alignment導入前のキャッシュは再利用しない。FastAPIはキャッシュキーへ `fa-zh-v1` を含める。Cloudflareはモデル識別子 `runpod-funasr-fa-zh-v1` を使い、旧KV値は既存TTLで自然失効させる。
- `model_audio_base64` は通常TTSのお手本音声とする。`自分の声` がオンでもSeed-VC後の再生音声へ差し替えない。
- WorkerとFastAPIは、必要な `model_transcription` の欠落を一般的なASR失敗と混同せず再デプロイ案内にする。
- `自分の声` では既存の `operation_mode=voice_conversion` を使い、WorkerまたはFastAPIがSpeakLoop専用job APIとして状態を中継する。
- RunPodのprogress updateは途中stage表示に使う。最終job outputを採点と比較再生の正、Seed-VC job outputを再生音声の正とする。
- URL取得失敗時はRunPod処理が始まっていないため、RunPodを原因として表示しない。

## 保存とプライバシー

- 実装上のデータフローと保持境界は [公開デモのデータ取扱い境界](../deployment/PRIVACY.md)、利用者向け説明は [Voice Lab プライバシーポリシー](../PRIVACY_POLICY.md) を正とする。
- D1は48時間を超えた日次quotaと90日を超えた監査ログを日次削除し、利用者向けには実際の最大保持期間である3日未満、91日未満と案内する。署名cookieは30日、短期job snapshotは1時間、累計quotaは公開デモの運用中に保持する。
- API key・OAuth token・モデル・生成音声・録音サンプルをgit管理しない。
- 公開デモのquota・audit識別子はGoogle emailをSHA-256 hash化してD1またはKV fallbackへ保存し、平文emailを新規のquota・audit履歴へ保存しない。
- ログインしたemailと日時だけは `public_users` へ平文で保存し、管理者専用の `GET /api/public-users` と `/admin` の利用者一覧から読む。保持は公開デモの運用中に限る。quota・auditは引き続きhashだけを使う。
- 音声履歴はローカルFastAPI版だけで保存する。Cloudflare公開版は入力音声と生成音声を履歴として保存しない。
- ローカルFastAPI版は、RunPod比較の選択条件とterminal snapshotを短期job stateへ既定で1時間保存する。このstateは音声bytesを含まず、音声履歴の有効・無効とは分離する。
- 公開画面では、外部サービスで処理される音声へ個人情報や機密情報を含めないよう案内する。
- タブ音声共有はユーザー操作で開始し、選択された共有元の音声trackだけを録音する。映像、URL、cookieは送信しない。
- 生成物を私的利用の範囲を超えて公開・共有する場合は、参照音声と入力素材の利用条件を確認する。

## UI契約

- 公開UIの視覚階層、レスポンシブ、テーマ、状態は [UI_STYLE.md](../UI_STYLE.md) を正とする。
- SkitVoiceは1120px以上で台本・参照音声・生成の3列、821〜1119pxで2列、820px以下で1列にする。
- 出力音声サンプルは英語、中国語、日本語の順とし、PCでは横並びにする。
- 通信を伴う保存・削除・生成操作は、処理中・成功・失敗をボタン付近のstatusで通知し、処理中は二重送信を防ぐ。
- ブラウザ既定audio controlsを公開・管理UIへ露出せず、共通の再生・一時停止・シーク・時間表示を使う。

## 検証

```sh
python3 -m pytest
npm test
npm run check:js
npm run check:web
npm run test:e2e
```

RunPod image buildとGPU smokeは通常CIから分離し、ローカルのモデル非依存テスト通過後に必要最小限だけ実行する。
