# Voice Lab Webアプリ仕様

更新日: 2026-07-20

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

`/fun` は管理者認証済みの場合だけ表示・利用でき、公開ポータルには導線を置かない。Cloudflare版の管理者認証は公開生成APIと同じGoogle OAuthセッションを使い、許可メールに含まれるアカウントだけが管理route、管理API、`/fun`とそのテキスト・音声生成、Seed-VC APIへアクセスできる。音声翻訳とSeed-VCは、job作成だけでなくstatus pollingと結果取得も管理者専用にする。`/fun`のAPI境界は公開生成のログイン必須設定をOFFにしても維持する。管理者は公開quotaを消費しないが、入力サイズ上限は適用する。別の管理パスワードや管理者cookieは設けない。ローカルFastAPIは開発者が起動する信頼済み環境として、管理ログインなしで管理画面と`/fun`を提供する。

廃止した旧routeへの互換aliasは設けない。Static AssetsのHTMLファイルを直接指定して管理者認証を迂回できないようにする。

### SkitVoice/VibeVoiceの公開境界

Cloudflare版では、匿名利用者と通常のGoogleログイン利用者のどちらにもSkitVoice/VibeVoiceのinteractive generationを許可しない。公開ポータルには製品導線を置かず、`/skitvoice` は生成フォームやsampleを含まない案内だけを返す。次の全APIを、route個別の表示条件ではなく既存Google管理者セッションを使う共通server-side guardで保護する。

- `GET /api/vibevoice/status`
- `POST /api/vibevoice/reference-audio-from-url`
- `POST /api/vibevoice/scripts`
- `POST /api/vibevoice/jobs`
- `GET /api/vibevoice/jobs/{id}`
- `POST /api/vibevoice/jobs/{id}/cancel`

Cloudflare Workerにはsync generation APIを設けない。ローカルFastAPIの `POST /api/vibevoice/generate` と上記API、`/skitvoice`、`/skitvoice/admin` は、開発者が起動する信頼済み研究環境として維持する。Cloudflareの `/skitvoice/admin` と直接配信用HTML `/static/vibevoice.html` は管理者認証必須とする。旧 `/vibevoice*` routeは404を維持する。`GET /api/public-session` は非adminへSkitVoiceのfeature/quota設定を返さず、`GET /api/public-sample-audios` は非adminへSkitVoice sampleを返さない。外部R2 objectはこの実装変更では削除しない。

この管理者境界はproduction公開環境へ反映済みだが、研究機能を一般公開できることの証明ではない。VibeVoice runtime、第三者Large mirror、ComfyUI fork、RunPod imageはprivate維持を前提とする。

## SpeakLoop

- 日本語話者が、言いたい内容を母語で録音し、学習言語の模範文と音声を作る。
- 公開版の `自分の声` は、同じ `POST /api/practice/recordings` requestで利用者本人がステップ1として録音した `audio` だけを参照音声に使う。自己音声用の別ファイル、タブ音声、URL、別requestの参照音声は受け付けない。ブラウザUIもMediaRecorderによるステップ1録音だけを入力面とする。
- `自分の声` のトグル横には、hover、keyboard focus、click／tapで確認できる説明iconを置き、「同じセッションで最初に録音した音声からAI生成音声を作る」と短く案内する。トグルがオンの間は、録音とお手本音声を外部の音声処理サービスで一時処理し、Voice Labの履歴には保存しないことを録音前に表示する。詳細な保存・保持条件はprivacy文書を正とし、第三者の同意をcheckboxで証明できるとは扱わない。
- 通常TTSを先に成立させ、自己音声変換jobが失敗しても通常TTSで練習を続けられる契約を維持する。「本人の本当の声」や発音能力そのものが変わったと受け取れる表現を使わない。
- 学習言語は `🇺🇸 English`、`🇨🇳 中文` の順とし、既定値は英語にする。
- 中国語の目標文とASR結果は、FastAPIとCloudflare Workerの両方でOpenCCにより簡体字の字形へ正規化してAPIから返す。地域語彙は置き換えない。公開UIでは中国語選択時だけ `字形` の `简体`／`繁體` を切り替えられ、繁体字表示はブラウザ内のOpenCC変換だけで行う。切替でAPI、TTS、採点を再実行しない。
- 模範音声と復唱音声のASR本文・単語時刻をLLMへ送り、目標文のフレーズ分割、両ASRとの対応付け、全体とフレーズごとの点数・コメントを一度に得る。
- LLMはフレーズごとの対応状態（`assigned`/`partial`/`missing`）と、対応する認識単位の位置番号（`word_start_index`/`word_end_index`）、点数、コメントを返す。元の時刻・余白適用後の再生時刻・一致文字列（`matched_text`）はLLMに転記させない。誤答や言い直しは、一致した部分だけへ狭めず、対応する発話全体を選ぶ。
- アプリは、フレーズを連結すると元の目標文になること、位置番号が入力の認識単位配列の範囲内であること、点数の範囲を検査する。比較再生に使う認識文字列と元の時刻・余白適用後の再生時刻は、検査済みの位置番号が指す認識単位からアプリが直接計算する。位置番号はword_start_index/word_end_indexから一意に決まる値のため、LLMに時刻や文字列の転記をさせて完全一致を検査すると、位置番号の選択自体は正しくても転記の誤りだけで比較結果全体が失敗しうる。フレーズ分割、点数、位置番号の対応付けそのものは作り直さない。
- ローカルFastAPI版では、比較モデルと前後共通余白を画面で変更できる。比較モデルの選択肢は次の4つにする。
  - `gpt-5.6-terra`
  - `gpt-5.6-luna`
  - `gpt-5.4-mini`
  - `gpt-5.4-nano`
- 前後共通余白は0.00〜0.50秒を0.05秒刻みで選ぶ。お手本と復唱の両方へ同じ値を使い、初期値は0.30秒にする。比較モデルの初期値は `gpt-5.6-terra` にする。
- Cloudflare公開版では、比較モデルと前後共通余白の設定UIを表示しない。ブラウザに以前の保存値がある場合も、`gpt-5.6-terra` と0.30秒を使う。
- LLM呼び出しまたは返却値の検査に失敗した場合、従来処理へ切り替えず「比較結果を作成できませんでした。もう一度お試しください。」と表示する。
- ローカルFastAPI版とCloudflare公開版の両方がこの処理に対応済みである。Cloudflare版は診断ログを保存しない方針のため、API使用量・推定料金はユーザー画面へ返さない。従来処理専用コードの削除は、実画面での動作確認後に行う[ROADMAP.md](ROADMAP.md)の未完了項目とする。
- 復唱録音と通常TTSのお手本音声の両方を言語別ASRにかけ、同じtimestamp形式へ正規化する。`自分の声` がオンでも、お手本側ASRにはSeed-VC前の通常TTSを使う。Seed-VCは発話内容、間、フレーズ時刻を変えず声質だけを変更する契約とし、変換後音声を再ASRせず、通常TTSから得たtimestampを比較再生へ引き継ぐ。中国語 `zh-CN` は同じRunPod Serverless endpointのFunASR `paraformer-zh`、英語 `en-US` はOpenAI `whisper-1` を使う。母語で「言いたいことを話す」録音は言語自動判定が必要なため、従来どおりOpenAI ASRを使う。
- FunASRは `fsmn-vad` と `ct-punc` を併用し、文字単位timestampを既存の `asr_timestamps.words` の秒単位形式へ変換する。中国語復唱でFunASRが失敗した場合、採点結果がproviderによって変動しないよう、別ASRへ黙って切り替えずエラーを返す。
- 中国語復唱はRunPod `/run` で非同期jobを作り、WorkerまたはFastAPIがstatusをpollingする。公開UIの主要表示は `GPUサーバーの準備待ち`、`音声認識の準備`、`お手本音声の確認`、`録音の確認`、`比較結果の準備`、完了／失敗のように処理目的で示す。その直下には、RunPod、FunASR、モデル名、raw stage、待機・処理時間、生のproviderエラーを小さく薄い技術詳細として併記し、サーバーログとブラウザの技術ログにも残す。
- ユーザー画面は、お手本作成と復唱評価を非同期jobとして扱う。お手本の文字起こし、翻訳、通常TTS、両音声のASR、LLMによる比較結果作成を別の処理段階として受け取り、主要文言の直下に実際のサービス名とモデル名を小さく薄く表示する。現在、この全段階を返す処理はローカルFastAPI版に実装されている。
- `自分の声` は既定オフとし、オンの場合は母語録音をSeed-VC参照音声、通常TTSを変換元として、変換完了後の音声だけを再生用のお手本にする。比較再生の内容とtimestampはSeed-VC前の通常TTSに対するASR結果を正とし、変換後音声をASRへ送らない。ローカルFastAPI版とCloudflare版のどちらもSeed-VC推論はRunPodへ依頼し、ローカルPython環境のSeed-VCを直接importしない。公開UIは `GPUサーバーの準備待ち`、`お手本の声を調整する準備`、`お手本の声を調整中`、完了／失敗を主要文言として表示し、その直下にprovider、モデル、raw stage、待機・処理時間を小さく薄い技術詳細として併記する。公開Cloudflare版は入力音声、通常TTS、変換結果を履歴保存しない。
- 「聞こえた言葉」はASR本文を落とさず、置換・追加を強調し、目標文側で抜けた文字は下段に `_`、その直上に正解文字を表示する。連続する同種の不一致は1つのまとまりとして表示し、1文字ずつには分割しない。
- 中国語 `zh-CN` では、目標文と復唱ASR本文の文字ごとの声調つきピンインをサーバー側で生成し、置換として検出された文字対をこのピンインで再判定する。声調まで完全一致する場合は誤りとして強調せず（同音の別字としてASRが選んだだけとみなす）、音節が一致し声調だけ違う場合は「声調のみの違い」として通常の誤りと異なる見た目で示す。サーバーは連続する漢字をまとめて変換し、文脈依存の読みを可能な範囲で反映する。非漢字位置には空文字列を置き、文字別配列の添字を目標文・ASR本文の比較用文字列と一致させる。ライブラリで読みを確定できない多音字（例: 副詞の「地」）は、この判定の対象外になり得る。
- ローカルFastAPI版では、成功済みの復唱履歴を `/speakloop` から選んで現在の結果表示へ復元できる。復元対象は目標文・認識結果・点数・コメント・比較区間とする。
- 履歴からの表示確認ではOpenAIとRunPodを呼ばない。ASRとTTSも実行しない。
- 履歴からの表示確認では、保存時点の採点結果であることを画面に明示する。古い履歴に声調判定用ピンインがない場合は、ローカルの決定的な変換処理で補う。
- 履歴からの表示確認では、過去に使ったお手本音声を推測で選ばない。お手本音声を一意に特定できない履歴では比較再生を無効にし、復唱音声と結果表示だけを復元する。
- 2つの録音ボタンが新規お手本生成と復唱評価の意図を明示し、録音内容による用途の自動判定は行わない。録音中は取消でき、取消した音声はAPIへ送らない。
- 公開UIの主要ステータスとエラーはproviderを変更しても成立する文言にする。provider名、モデル名、raw stage、内部エラーは、非同期job status内の弱い技術詳細、管理画面、ブラウザconsole、サーバーログへ分離する。
- 今後の学習機能の方針は [ROADMAP.md](ROADMAP.md) を参照する。

## SkitVoice

- 台本と最大4つの参照音声から複数話者の会話音声を生成する。
- 初期台本は2話者・5行とし、台本自動生成は入力済みテキストを種に発展させる。
- 出力言語は `🇺🇸 English`、`🇨🇳 中文`、`🇯🇵 日本語` の順とし、既定値は英語にする。
- 台本言語と出力言語が異なる場合は自動翻訳し、生成前に翻訳文を表示する。
- 参照音声は、ローカル版ではファイル、マイク、タブ音声、URL切り出しの4方式、Cloudflare版ではURLを除く3方式に対応する。ただしタブ音声は `getDisplayMedia` と `MediaRecorder` を利用できるブラウザだけに表示する。初期判定で非対応なら案内を出さず操作自体を隠し、利用開始時に非対応と判明した場合だけtoastで代替手段を案内して、そのセッション中は操作を隠す。
- 生成結果をASR timestampで検査し、必要に応じて話者位置補正、低スコア行再生成、Seed-VC後処理を行う。
- RunPod実行は非同期jobとし、管理者研究画面の主要表示はGPUサーバーの準備待ち、音声生成の準備、生成、仕上げ、完了／失敗を区別する。RunPod、VibeVoice、Seed-VCなどのprovider／モデル名とraw stage、生の失敗理由は主要表示と分け、弱い技術詳細、進捗ログ、サーバーログに残す。公開 `/skitvoice` は生成状態を持たない。
- 詳細は [VIBEVOICE.md](VIBEVOICE.md) を参照する。

## 実行環境の責任

| 処理 | ローカルFastAPI | Cloudflare Worker | RunPod handler |
| --- | --- | --- | --- |
| UI配信 | ○ | Static Assets | — |
| Google OAuth・公開quota | — | ○ | — |
| OpenAI ASR・翻訳・TTS | 母語入力、英語復唱、翻訳、TTS | 母語入力、英語復唱、翻訳、TTS | — |
| SpeakLoop中国語比較ASR | provider経由で非同期jobを依頼・polling | お手本／復唱音声bytesを非同期jobとして中継 | 両音声をFunASR `paraformer-zh`でtimestamp付きASR |
| URL参照音声取得 | `yt-dlp` + `ffmpeg` | 拒否 | 拒否 |
| VibeVoice・Seed-VC GPU推論 | provider経由で依頼 | job APIを中継 | ○ |
| quota・監査・サンプルmetadata | ローカルファイル | D1、bindingなし時のみfallback | — |
| 音声履歴 | ローカルファイル | 保存しない | 保存しない |
| 公開サンプル音声blob | ローカルファイル | R2、bindingなし時のみfallback | — |

RunPod handlerはURL、cookie、ブラウザ認証情報を受け取らず、音声bytesだけを受け取る。SpeakLoop中国語復唱では `operation_mode=practice_asr`、`audio_base64`、`target_text` を受け取る。

- お手本ASRのキャッシュが無い場合は `model_audio_base64` も受け取る。handler outputは `practice_asr_contract_version=2` と `model_transcription` を必須とする。
- お手本ASRのキャッシュがある場合は `model_audio_base64` を省略できる。このjobではRunPod側のお手本ASRを行わないため、`model_transcription` も返さない。WorkerまたはFastAPIはjobと対応付けたキャッシュ済みASRを使う。
- `model_audio_base64` は通常TTSのお手本音声とする。`自分の声` がオンでもSeed-VC後の再生音声へ差し替えない。

WorkerとFastAPIは、必要な `model_transcription` の欠落を一般的なASR失敗と混同せず再デプロイ案内にする。`自分の声` では既存の `operation_mode=voice_conversion` を使う。WorkerまたはFastAPIがSpeakLoop専用job APIとして状態を中継する。

RunPodのprogress updateは途中stage表示に使う。最終job outputを採点と比較再生の正とし、Seed-VC job outputを再生音声の正とする。URL取得失敗時はRunPod処理が始まっていないため、RunPodを原因として表示しない。

## 保存とプライバシー

- 実装上のデータフローと保持境界は [公開デモのデータ取扱い境界](../deployment/PRIVACY.md)、利用者向け説明は [Voice Lab プライバシーポリシー](../PRIVACY_POLICY.md) を正とする。D1は48時間を超えた日次quotaと90日を超えた監査ログを日次削除し、利用者向けには実際の最大保持期間である3日未満、91日未満と案内する。署名cookieは30日、短期job snapshotは1時間、累計quotaは公開デモの運用中に保持する。
- API key、OAuth token、モデル、生成音声、録音サンプルをgit管理しない。
- 公開デモのquota・audit識別子はGoogle emailをSHA-256 hash化してD1またはKV fallbackへ保存し、平文emailを新規のquota・audit履歴へ保存しない。署名cookieと管理者allowlist、legacy KVの扱いはデータ取扱い境界を正とする。
- 音声履歴はローカルFastAPI版だけで保存する。Cloudflare公開版は入力音声と生成音声を履歴として保存しない。
- ローカルFastAPI版は、RunPod比較の選択条件とterminal snapshotを短期job stateへ既定で1時間保存する。このstateは音声bytesを含まず、音声履歴の有効・無効とは分離する。
- 公開画面では、外部サービスで処理される音声へ個人情報や機密情報を含めないよう案内する。
- タブ音声共有はユーザー操作で開始し、選択された共有元の音声trackだけを録音する。映像、URL、cookieは送信しない。
- 生成物を私的利用の範囲を超えて公開・共有する場合は、参照音声と入力素材の利用条件を確認する。

## UI契約

- 公開UIの視覚階層、レスポンシブ、テーマ、状態は [UI_STYLE.md](../UI_STYLE.md) を正とする。
- SkitVoiceは1120px以上で台本・参照音声・生成の3列、821〜1119pxで2列、820px以下で1列にする。
- 出力音声サンプルは英語、中国語、日本語の順とし、PCでは横並びにする。
- 通信を伴う保存・削除・生成操作は、処理中、成功、失敗をボタン付近のstatusで通知し、処理中は二重送信を防ぐ。
- ブラウザ既定audio controlsを公開・管理UIへ露出せず、共通の再生、一時停止、シーク、時間表示を使う。

## 検証

```sh
python3 -m pytest
npm test
npm run check:js
npm run check:web
npm run test:e2e
```

RunPod image buildとGPU smokeは通常CIから分離し、ローカルのモデル非依存テスト通過後に必要最小限だけ実行する。
