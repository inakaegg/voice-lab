# Voice Lab Webアプリ仕様

更新日: 2026-07-15

## 目的

Voice Labは、音声を使って「学ぶ」「演じる」体験を提供するWebアプリである。公開ポータルでは発音練習のSpeakLoopと、複数話者音声生成のSkitVoiceを提供する。ローカルFastAPI、Cloudflare Worker、RunPod Serverlessの責任を分離し、秘密情報とGPU処理をブラウザへ置かない。

## 正式route

| route | 用途 | Cloudflareでの公開範囲 |
| --- | --- | --- |
| `/` | Voice Labポータル | 公開 |
| `/speakloop` | SpeakLoop | 公開 |
| `/skitvoice` | SkitVoice | 公開 |
| `/admin` | 総合管理 | 管理者認証必須 |
| `/speakloop/admin` | SpeakLoop管理 | 管理者認証必須 |
| `/skitvoice/admin` | SkitVoice管理 | 管理者認証必須 |
| `/fun` | 実験的な音声変換デモ | 管理者認証必須 |

`/fun` は管理者認証済みの場合だけ表示・利用でき、公開ポータルには導線を置かない。Cloudflare版の管理者認証は公開生成APIと同じGoogle OAuthセッションを使い、許可メールに含まれるアカウントだけが管理route、管理API、`/fun`とそのテキスト・音声生成、Seed-VC APIへアクセスできる。音声翻訳とSeed-VCは、job作成だけでなくstatus pollingと結果取得も管理者専用にする。`/fun`のAPI境界は公開生成のログイン必須設定をOFFにしても維持する。管理者は公開quotaを消費しないが、入力サイズ上限は適用する。別の管理パスワードや管理者cookieは設けない。ローカルFastAPIは開発者が起動する信頼済み環境として、管理ログインなしで管理画面と`/fun`を提供する。

廃止した旧routeへの互換aliasは設けない。Static AssetsのHTMLファイルを直接指定して管理者認証を迂回できないようにする。

## SpeakLoop

- 日本語話者が、言いたい内容を母語で録音し、学習言語の模範文と音声を作る。
- 学習言語は `🇺🇸 English`、`🇨🇳 中文` の順とし、既定値は英語にする。
- 中国語の目標文とASR結果は、FastAPIとCloudflare Workerの両方でOpenCCにより簡体字の字形へ正規化してAPIから返す。地域語彙は置き換えない。公開UIでは中国語選択時だけ `字形` の `简体`／`繁體` を切り替えられ、繁体字表示はブラウザ内のOpenCC変換だけで行う。切替でAPI、TTS、採点を再実行しない。
- 模範音声を聞いて復唱し、ASR結果、文字列類似度、フレーズ単位の交互再生で比較する。
- 句読点と記号は発音の脱落として扱わず、採点と「聞こえた言葉」の差分表示から除外する。単語・文字の脱落は従来どおり `_` と直上の正解文字で示す。
- 復唱録音とお手本音声の両方を言語別ASRにかけ、同じtimestamp形式へ正規化する。中国語 `zh-CN` は同じRunPod Serverless endpointのFunASR `paraformer-zh`、英語 `en-US` はOpenAI `whisper-1` を使う。母語で「言いたいことを話す」録音は言語自動判定が必要なため、従来どおりOpenAI ASRを使う。
- FunASRは `fsmn-vad` と `ct-punc` を併用し、文字単位timestampを既存の `asr_timestamps.words` の秒単位形式へ変換する。中国語復唱でFunASRが失敗した場合、採点結果がproviderによって変動しないよう、別ASRへ黙って切り替えずエラーを返す。
- 中国語復唱はRunPod `/run` で非同期jobを作り、WorkerまたはFastAPIがstatusをpollingする。UIはworker割り当て待ち、worker初期化、FunASRモデル読込、お手本解析、復唱解析、比較準備、完了／失敗を表示する。残高不足はRunPodのエラーが明示した場合だけ利用者向けに説明する。
- `自分の声` は既定オフとし、オンの場合は母語録音をSeed-VC参照音声、通常TTSを変換元として、変換完了後の音声だけをお手本にする。ローカルFastAPI版とCloudflare版のどちらもSeed-VC推論はRunPodへ依頼し、ローカルPython環境のSeed-VCを直接importしない。UIはGPU割り当て待ち、worker初期化、Seed-VCモデル読込、声質変換、完了／失敗を表示する。公開Cloudflare版は入力音声、通常TTS、変換結果を履歴保存しない。
- 「聞こえた言葉」はASR本文を落とさず、置換・追加を強調し、目標文側で抜けた文字は下段に `_`、その直上に正解文字を表示する。
- 2つの録音ボタンが新規お手本生成と復唱評価の意図を明示し、録音内容による用途の自動判定は行わない。録音中は取消でき、取消した音声はAPIへ送らない。
- 公開UIではASRモデルなどの内部設定を表示しない。
- 詳細な学習機能の方針は [LEARNING_ROADMAP.md](LEARNING_ROADMAP.md) を参照する。

## SkitVoice

- 台本と最大4つの参照音声から複数話者の会話音声を生成する。
- 初期台本は2話者・5行とし、台本自動生成は入力済みテキストを種に発展させる。
- 出力言語は `🇺🇸 English`、`🇨🇳 中文`、`🇯🇵 日本語` の順とし、既定値は英語にする。
- 台本言語と出力言語が異なる場合は自動翻訳し、生成前に翻訳文を表示する。
- 参照音声は、ローカル版ではファイル、マイク、タブ音声、URL切り出しの4方式、Cloudflare版ではURLを除く3方式に対応する。
- 生成結果をASR timestampで検査し、必要に応じて話者位置補正、低スコア行再生成、Seed-VC後処理を行う。
- RunPod実行は非同期jobとし、UIはGPU割り当て待ち、worker初期化、VibeVoiceモデル読込、音声生成、指定台詞ASR、Seed-VCモデル読込／声質変換、再配置、出力仕上げ、完了／失敗を区別して表示する。モデル名はステージに付帯させ、残高不足などはRunPodが明示した原因だけを表示する。
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

- API key、OAuth token、モデル、生成音声、録音サンプルをgit管理しない。
- 公開デモのquota識別子はGoogle emailをSHA-256 hash化してD1へ保存し、平文emailをquota履歴へ保存しない。
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
