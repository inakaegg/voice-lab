# Voice Lab Webアプリ仕様

更新日: 2026-07-17

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

この境界は管理者経路への暫定的な封じ込めであり、一般公開可の証明ではない。VibeVoice runtime、第三者Large mirror、ComfyUI fork、RunPod imageはprivate維持を前提とする。この節の変更はローカル実装であり、deploy完了を意味しない。

## SpeakLoop

- 日本語話者が、言いたい内容を母語で録音し、学習言語の模範文と音声を作る。
- 公開版の `自分の声` は、同じ `POST /api/practice/recordings` requestで利用者本人がステップ1として録音した `audio` だけを参照音声に使う。自己音声用の別ファイル、タブ音声、URL、別requestの参照音声は受け付けない。ブラウザUIもMediaRecorderによるステップ1録音だけを入力面とする。
- `自分の声` を選ぶ前から、本人録音と模範TTSを外部処理事業者へ一時送信すること、結果が本人の声質に近づけたAI生成音声であること、Cloudflare版のVoice Lab履歴には保存しないことを表示する。第三者の同意をcheckboxで証明できるとは扱わない。
- 通常TTSを先に成立させ、自己音声変換jobが失敗しても通常TTSで練習を続けられる契約を維持する。「本人の本当の声」や発音能力そのものが変わったと受け取れる表現を使わない。
- 学習言語は `🇺🇸 English`、`🇨🇳 中文` の順とし、既定値は英語にする。
- 中国語の目標文とASR結果は、FastAPIとCloudflare Workerの両方でOpenCCにより簡体字の字形へ正規化してAPIから返す。地域語彙は置き換えない。公開UIでは中国語選択時だけ `字形` の `简体`／`繁體` を切り替えられ、繁体字表示はブラウザ内のOpenCC変換だけで行う。切替でAPI、TTS、採点を再実行しない。
- 模範音声を聞いて復唱し、ASR結果、文字列類似度、フレーズ単位の交互再生で比較する。
- 比較再生の正は [PRACTICE_ALIGNMENT_CANONICAL_SPEC_FINAL.md](PRACTICE_ALIGNMENT_CANONICAL_SPEC_FINAL.md) とする。目標文をsentence終端、semicolon、改行で分け、email、URL、小数、version、`Ms.`等の内部periodを保護する。ASR側の句読点や、segment数とphrase数が同じという理由だけでは境界を決めない。
- APIは `alignment_contract_version=1` と `phrases` を返す。各phraseの実timestampによる再生可能性を `available`、正規化後の文字内容の完全一致を `content_matched`、所有判断を `assignment_status`、位置の信頼度を `alignment_confidence`、文字と時刻の出所を `text_source`／`timestamp_source`として分離する。`content_similarity`は採点・診断用であり、`content_matched`や再生可否を決めない。
- 中国語の発話比較では表示文字列を保持したまま、targetとASR本文の両方へ同じspoken-form正規化を適用する。一般整数、年、小数、割合、温度、時刻、`v`付きversion、compact identifierを文脈別に扱い、数値変更、単位や小数点の脱落、一般数量のdigit-by-digit読みを同一視しない。一般整数は4桁groupと`万`以上の単位を保った通常の中国語数詞へ変換し、桁数が大きくてもJavaScript `Number`の丸めで値を変えない。時刻のhourは`03`を`三`として扱う一方、minuteの`05`は`零五`を保持する。`v1.2.3`のような複数componentのversionは、先頭componentを通常数詞、後続componentを先頭ゼロ保持のdigit読みとして、すべての区切りを`点`へ変換する。
- 複数phraseの所有判断はfalse positiveを重く見る。単一phrase、前後の文字anchorで一意に挟まれたspan、順序どおりの完全一致segment等、数値化済みの根拠で位置を特定できる場合だけ割り当てる。前後anchor間にphrase境界相当のpauseが複数partitionを作る場合、その全体を一意な中央spanとして強制所有しない。pauseは、target数と同数の一意な非フィラーchunk、順序整合、他targetとの非競合、全体の文字根拠を同時に満たす場合だけ境界補助に使う。片側anchor、pause、空いているslot、録音端のいずれかだけを理由に無関係な発話へ区間を作らない。どもり、言い直し、自己訂正は、所有できたphrase内部から理由なく落とさない。
- `start == end` のASR tokenは文字列、`matched_text`、内容類似度、診断から削除しない。再生範囲は同じ所有span内の正時間tokenだけから作り、zero-duration tokenの時刻で端を延ばさない。直前の正時間token終端にzero-duration tokenがあり、次の正時間wordだけが直前rangeへ戻ってその終端より後まで続く構造は、raw順とraw時刻を変えず限定的に受理できる。最終phrase rangeが重なる場合は境界を補正せずtext-onlyへ下げる。zero-duration tokenしかなく安全な時間anchorがない区間は文字情報だけを保持し、`available=false` とする。timestamp payload自体が `available=false` の場合は、内部に古いword列が残っていても再生境界へ使わない。
- 復唱ASR本文が空でword/segment timestampもない場合、job自体が成功しても結果を `outcome=no_speech` とする。score、grade、diff、比較再生を通常結果として扱わず、「音声を検出できませんでした。もう一度録音してください。」と再録音を促す。
- providerが `available=false` とtimestamp列を同時に返した場合、そのtimestampは再生、文字一致、phrase所有へ使わず、正式transcriptionだけで制限付き評価を続ける。正式transcriptionも空なら `no_speech` へ混ぜず、型付き `practice_alignment_provider_contract_error` とする。空target、未対応言語、公開上限超過はHTTP 400の `practice_alignment_invalid_input` とする。
- 公開上限はtarget phrase 16件、raw wordとsegmentの合計256件、両者の積1024、phraseごとの候補4096件とする。超過時に一部を黙って切り捨てたり、全体再生へfallbackしたりしない。
- canonical回帰は、既存手作業500件とsegment policy 12件のraw 512件を同じoverlayで評価する。発話意図を文字とtimestampだけで一意に決められない10件は両runtime・変更前後で同条件除外し、固定502件はPythonとCloudflare Workerの双方でexact matchを常設gateとする。この502/502は確認済みfixtureへの契約適合であり、未知録音の精度100%を意味しない。
- 比較ボタンの表示と実際の再生方式は同じplanを使う。全フレーズ対応は `フレーズごと比較再生`、一部対応は `一部フレーズ比較再生`、対応なしは `全体比較再生`、`no_speech` はお手本の `再生` とする。区間再生はAPIの `audio_end` ちょうどで停止し、固定の早止めやpaddingを加えない。
- 句読点と記号は発音の脱落として扱わず、採点と「聞こえた言葉」の差分表示から除外する。単語・文字の脱落は従来どおり `_` と直上の正解文字で示す。
- 最終scoreは、正規化した全文の`global_similarity`と、各target phraseを同じ重みで平均した`phrase_macro_similarity`の小さい方とする。文字数加重の`phrase_similarity`と`lowest_phrase_similarity`は診断値として保持し、phrase探索が飛ばした非フィラー文字列は`unconsumed_recognized`へ残す。後続targetの完全一致は先行する低一致phraseの候補へ消費せず、短い誤答や未発話phraseがあっても後続の正解phraseを独立して評価する。scoreはASR本文との整合性を表すものであり、実際の発音品質そのものとはみなさない。`no_speech`ではこれらのscoreを生成しない。
- 復唱録音とお手本音声の両方を言語別ASRにかけ、同じtimestamp形式へ正規化する。中国語 `zh-CN` は同じRunPod Serverless endpointのFunASR `paraformer-zh`、英語 `en-US` はOpenAI `whisper-1` を使う。母語で「言いたいことを話す」録音は言語自動判定が必要なため、従来どおりOpenAI ASRを使う。
- FunASRは `fsmn-vad` と `ct-punc` を併用し、文字単位timestampを既存の `asr_timestamps.words` の秒単位形式へ変換する。中国語復唱でFunASRが失敗した場合、採点結果がproviderによって変動しないよう、別ASRへ黙って切り替えずエラーを返す。
- 中国語復唱はRunPod `/run` で非同期jobを作り、WorkerまたはFastAPIがstatusをpollingする。公開UIの主要表示は `GPUサーバーの準備待ち`、`音声認識の準備`、`お手本音声の確認`、`録音の確認`、`比較結果の準備`、完了／失敗のように処理目的で示す。その直下には、RunPod、FunASR、モデル名、raw stage、待機・処理時間、生のproviderエラーを小さく薄い技術詳細として併記し、サーバーログとブラウザの技術ログにも残す。
- `自分の声` は既定オフとし、オンの場合は母語録音をSeed-VC参照音声、通常TTSを変換元として、変換完了後の音声だけをお手本にする。ローカルFastAPI版とCloudflare版のどちらもSeed-VC推論はRunPodへ依頼し、ローカルPython環境のSeed-VCを直接importしない。公開UIは `GPUサーバーの準備待ち`、`お手本の声を調整する準備`、`お手本の声を調整中`、完了／失敗を主要文言として表示し、その直下にprovider、モデル、raw stage、待機・処理時間を小さく薄い技術詳細として併記する。公開Cloudflare版は入力音声、通常TTS、変換結果を履歴保存しない。
- 「聞こえた言葉」はASR本文を落とさず、置換・追加を強調し、目標文側で抜けた文字は下段に `_`、その直上に正解文字を表示する。
- 2つの録音ボタンが新規お手本生成と復唱評価の意図を明示し、録音内容による用途の自動判定は行わない。録音中は取消でき、取消した音声はAPIへ送らない。
- 公開UIの主要ステータスとエラーはproviderを変更しても成立する文言にする。provider名、モデル名、raw stage、内部エラーは、非同期job status内の弱い技術詳細、管理画面、ブラウザconsole、サーバーログへ分離する。
- 詳細な学習機能の方針は [LEARNING_ROADMAP.md](LEARNING_ROADMAP.md) を参照する。

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

RunPod handlerはURL、cookie、ブラウザ認証情報を受け取らず、音声bytesだけを受け取る。SpeakLoop中国語復唱では `operation_mode=practice_asr`、`audio_base64`、`model_audio_base64`、`target_text` を受け取り、両音声の認識本文とtimestampを返す。両音声比較のhandler outputは `practice_asr_contract_version=2` と `model_transcription` を必須とし、WorkerとFastAPIは旧imageの欠落を一般的なASR失敗と混同せず再デプロイ案内にする。`自分の声` では既存の `operation_mode=voice_conversion` を使い、WorkerまたはFastAPIがSpeakLoop専用job APIとして状態を中継する。RunPodのprogress updateは途中stage表示に使い、最終job outputを採点、比較再生、変換済みお手本の正とする。URL取得失敗時はRunPod処理が始まっていないため、RunPodを原因として表示しない。

## 保存とプライバシー

- 実装済みのデータフローと未決定事項は [公開デモのデータ取扱い境界](../deployment/PRIVACY.md) を正とする。D1/KVの保持期間、削除手段、連絡先、正式な利用者向けpolicyを確定するまで公開再開を完了扱いにしない。
- API key、OAuth token、モデル、生成音声、録音サンプルをgit管理しない。
- 公開デモのquota・audit識別子はGoogle emailをSHA-256 hash化してD1またはKV fallbackへ保存し、平文emailを新規のquota・audit履歴へ保存しない。署名cookieと管理者allowlist、legacy KVの扱いはデータ取扱い境界を正とする。
- 音声履歴はローカルFastAPI版だけで保存する。Cloudflare公開版は入力音声と生成音声を履歴として保存しない。
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
