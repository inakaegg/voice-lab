# 音声翻訳Webアプリ仕様

## 目的

音声入力を受け取り、別言語の音声として返すWebアプリを作る。最初はローカルで動く最小版を作り、動作確認後にRunPodまたは別GPUプラットフォームへ載せる。

## MVPで必須の入出力ルート

1. インドネシア語の音声入力 -> 日本語の音声出力
   - 入力言語: `id-ID`
   - 出力言語: `ja-JP`
   - 入力例: `Selamat pagi. Terima kasih.`
   - 出力意図の例: `おはようございます。ありがとうございます。`

2. 日本語の音声入力 -> 中国語の音声出力
   - 入力言語: `ja-JP`
   - 出力言語: `zh-CN`
   - ここでの `zh-CN` は普通話を前提にした中国大陸向けの簡体字中国語を指す。
   - 繁体字や台湾華語は初期MVPでは扱わない。

## 処理パイプライン

各処理を後から差し替えられるように分離する。

1. ブラウザで音声を録音する、または音声ファイルをアップロードする。
2. backendがリクエストを一時作業領域に保存する。
3. ASRが入力音声を入力言語のテキストへ変換する。
4. 翻訳が入力テキストを出力言語のテキストへ変換する。
5. 任意のテキスト加工が出力テキストを変更する。
6. TTSまたは声質クローンTTSが出力言語の音声を生成する。
7. 必要ならvoice conversionで話者類似度を調整する。
8. backendが文字起こし、翻訳文、出力音声、処理時間、プロバイダ情報を返す。

## UI状態

- UIは、音声翻訳、テキスト読み上げ、VC比較を切り替えられる。
- 音声翻訳は、処理方式に応じて必要な入力だけを表示する。
  - `Qwen/local` と `OpenAI API` の3段方式では、入力言語、出力言語、声質変換、テキスト加工を表示する。
  - `OpenAI Realtime翻訳` では、入力言語を自動判定として扱い、出力言語だけを表示する。初期実装ではテキスト加工とSeed-VC後段変換は表示しない。
- テキスト読み上げでは、入力テキスト、読み上げ言語、TTS方式だけを表示する。録音、音声入力、ASR、翻訳、VC設定は表示しない。
- VC比較では、変換元音声と参照音声を別々に指定し、選択したvoice conversion backendで変換元音声の内容を参照音声の声質へ寄せる。
- VC比較ではASR、翻訳、TTSは実行しない。
- VC比較では入力言語、出力言語、翻訳用の声設定、テキスト加工、文字起こし、翻訳、加工後の結果欄を表示しない。
- VC比較では、録音または音声ファイル選択を変換元音声として扱う。
- VC比較のbackend候補はruntime APIから取得し、ローカル環境に未導入のbackendは選択できない状態にする。
- 録音またはファイル選択後、ユーザーは入力音声を変換前に再生確認できる。
- 録音開始時は既存のファイル選択をクリアし、ファイル選択時は既存の録音をクリアする。
- ブラウザが入力デバイス一覧を返せる場合は、録音に使うマイクをUIで選択できる。
- 録音中は入力レベルを表示し、録音後はMIME typeとサイズを表示する。
- MediaRecorderのMIME typeとアップロードファイル名の拡張子は、実際の録音形式に合わせる。
- 画面には現在の実行モードとprovider名を表示する。
- 現在のproviderで使えない `voice_mode` は選べない状態にする。
- local providerのUIでは `default` を表示しない。`convert` が利用可能な場合は初期選択にする。
- 変換中は、現在の処理段階とモデル名を表示する。最小段階はASR、翻訳、テキスト加工、音声生成、声質変換とする。
- 変換中も、完了した段階から順に文字起こし、翻訳、加工後の表示を更新する。
- fake providerで動いている場合、録音内容ではなく固定のデモ応答になることが分かる表示にする。

## 初期プロバイダ候補

最初の縦切りでは軽いproviderから始めたが、実用品質評価ではASRと翻訳を上位providerへ切り替える。

- ASR: 既定は `faster-whisper` の `turbo` とする。GPU環境では `large-v3` や `distil-large-v3` も比較する。
- 翻訳: 既定はQwen3系のローカルLLMとする。会話文脈や口語表現の品質を見る。
- TTS / 声質クローン候補: Qwen3-TTS、CosyVoice2/3、OpenVoiceV2、Seed-VC。

`MO_PROVIDER_MODE=local` では以下を使う。

- ASR: `faster-whisper` のローカルキャッシュ済みモデル。
- 翻訳: Qwen3系のローカルキャッシュ済みモデル。
- TTS / 声質クローン: Qwen3-TTSまたはSeed-VC。`MO_TTS_PROVIDER` で明示する。

詳細は [LOCAL_PROVIDERS.md](LOCAL_PROVIDERS.md) を正とする。

## 声の扱い

最終的には、入力した人の声を出力音声にも反映する。これはアプリの主要な価値として扱う。

翻訳なしのVC比較では、以下を正とする。

- 入力: 変換元音声と参照音声。
- 出力: 変換元音声の発話内容を保ち、参照音声の話者らしさへ寄せた音声。
- 参照音声は数秒から試せることを重視する。
- 初期比較backendはSeed-VCを基準にし、Chatterbox VCを追加比較候補にする。
- OpenVoiceV2は軽量なtone color変換候補だが、初期の直接VC backendとしては未実装扱いにする。

段階は以下のように分ける。

- 段階1: 入力音声を参照音声として、出力言語の声質クローンTTSを使う。
- 段階2: 高品質な出力言語TTSを生成した後、Seed-VCなどの声質変換で声質を寄せる。段階1で声の類似度が足りない場合に検討する。

完成形のMVPでは段階1以上を満たす必要がある。

MVPの声寄せ推奨経路:

- `id-ID -> ja-JP`: `convert` を本命にする。Qwen3-TTSの `clone` は参照テキストのインドネシア語対応が弱いため、Seed-VCのような音声参照中心のvoice conversionを優先する。
- `ja-JP -> zh-CN`: `clone` と `convert` を比較対象にする。日本語参照テキストはQwen3-TTSの対応範囲内にある。

UI文言では、`clone` は「Qwenで直接声を寄せて生成」、`convert` は「Qwenで生成後にSeed-VCで声質変換」として表示する。声質の類似度評価ではSeed-VCの方が入力音声に近いため、初期選択は `convert` とする。

## テキスト加工

指定した文字列を出力文の末尾に付加する加工をMVP範囲に含める。ただし、最初の縦切り実装では後回しでよい。固定の `モー` 加工ではなく、ユーザーまたは設定で付加文字列を指定できる機能として扱う。

初期仕様:

- 加工IDは `append_suffix` とする。
- 付加文字列はリクエストで指定できる。
- 既定では翻訳文をそのまま使い、明示された場合だけ末尾付加を行う。
- `unit=text` の場合は出力全体の末尾に1回だけ付加する。
- `unit=sentence` の場合は文ごとの末尾に付加する。

文字列として付加した効果音や語尾をTTSに読ませても、期待した音声表現にならない場合がある。録音または音声ファイルで指定した効果音を末尾へ継ぎ足す機能は、別の加工として扱う。この場合も最終出力は入力話者の声へ寄せる必要があるため、単純に未変換の音声を末尾結合するのではなく、声質変換の前段に入れる、または効果音側も同じvoice conversionを通す。

例:

- 翻訳文: `おはようございます。ありがとうございます。`
- 付加文字列: `モー`
- 文単位で付加した場合: `おはようございますモー。ありがとうございますモー。`

## API形状の草案

`POST /api/translate-speech`

リクエスト:

- `audio`: アップロードされた音声ファイル
- `translation_backend`: `qwen`、`openai`、`openai_realtime`
  - `qwen`: 既存のローカル/Qwen系pipelineを使う。fake modeではデモ応答を返す。
  - `openai`: OpenAI APIでASR、翻訳、TTSを3段に分けて行う。
  - `openai_realtime`: OpenAI Realtime translationで音声入力から翻訳音声を生成する。入力言語はAPI側の自動判定に任せる。
- `source_language`: 例 `id-ID`
- `target_language`: 例 `ja-JP`
- `voice_mode`: `default`、`clone`、`convert`
- `text_transform`: 任意の加工ID。例 `append_suffix`
- `text_transform_options`: 任意の加工設定。例 `{"suffix":"モー"}`
- multipart formでは、初期実装として `text_transform_suffix` と `text_transform_unit` を受け取る。
- `voice_mode=convert` でSeed-VCを使う場合は、`seed_vc_diffusion_steps`、`seed_vc_reference_max_seconds`、`seed_vc_length_adjust`、`seed_vc_inference_cfg_rate` を任意指定できる。

UIでは、実行内容を以下の構造にする。

- 音声翻訳: 入力言語、出力言語、翻訳方式、声質変換を表示する。
  - 翻訳方式は `Qwen/local`、`OpenAI API`、`OpenAI Realtime翻訳` を選択できる。
  - `Qwen/local` と `OpenAI API` では、声質変換は `なし` または `Seed-VC` を選択できる。Seed-VC選択時はSeed-VC詳細設定を表示する。
  - `OpenAI Realtime翻訳` では、入力言語は自動判定、声質変換は `なし` とする。
- テキスト読み上げ: 入力テキスト、読み上げ言語、TTS方式を表示する。
  - TTS方式は `Google Translate TTS endpoint` と `OpenAI TTS API` を選択できる。
  - Google Translate TTS endpointは公式APIではないため、開発中の比較用に限定する。安定運用の既定にはしない。
- VC単体: 変換元音声、参照音声、VC backend、Seed-VC詳細設定だけを表示する。入力言語、出力言語、末尾付加、翻訳結果欄は表示しない。

OpenAI API経路では、`OPENAI_API_KEY` を環境変数で渡す。APIキーはリポジトリに保存しない。既定モデルは環境変数で差し替え可能にする。

OpenAI API経路の扱い:

- 目的: ASR、翻訳、TTSを外部APIで高速・高品質に行い、その後段に必要ならSeed-VCを接続する。
- 代替案: 既存の `Qwen/local` 経路で、faster-whisper、Qwen3翻訳、Qwen3-TTS、Seed-VCをローカルまたはGPUサーバーで動かす。
- 課金・依存リスク: OpenAI APIは有料APIで、モデル、音声長、テキスト量に応じて費用が変わる。価格や利用条件は変わるため、運用前に公式の最新情報を確認する。
- 秘密情報: `OPENAI_API_KEY` は環境変数またはデプロイ先のsecretとして渡し、`.env`、`.runpod.env`、ソースコード、docsには実値を書かない。

OpenAI Realtime翻訳の扱い:

- 目的: 音声入力から翻訳音声までを1つのRealtime sessionで処理し、3段API方式との品質、遅延、料金を比較する。
- 初期実装: 既存UIと比較しやすいように、録音済み音声をサーバー側WebSocketからRealtime translationへ流し、出力音声とinput/output transcriptを回収する一括ジョブとして扱う。
- 将来実装: ブラウザからWebRTCで直接Realtime sessionへ接続し、話している途中から翻訳音声を再生する。
- 課金・依存リスク: Realtime translationは音声時間単位の有料APIで、料金や対応言語は変わるため運用前に公式の最新情報を確認する。

`POST /api/text-to-speech-jobs`

リクエスト:

- `text`: 読み上げるテキスト。
- `target_language`: 例 `id-ID`、`ja-JP`、`zh-CN`、`en-US`。
- `tts_backend`: `google_translate` または `openai`。

レスポンス:

- `job_id`
- `status`
- `stages`
- `current_stage`
- `result`
- `error`

完了時の `result`:

- `audio_mime_type`
- `audio_base64`
- `timings_ms`
- `providers`
- `warnings`

レスポンス:

- `transcript`
- `translated_text`
- `transformed_text`
- `audio_url` またはinline音声bytes
- `audio_mime_type`
- `timings`
- `providers`
- `warnings`

`POST /api/voice-conversion-jobs`

リクエスト:

- `source_audio`: 変換元音声ファイル
- `reference_audio`: 声質参照音声ファイル
- `voice_backend`: 例 `seed-vc`、`chatterbox`
- `voice_backend=seed-vc` 選択時の任意設定:
  - `seed_vc_diffusion_steps`: 変換steps。大きいほど遅くなるが品質比較対象になる。
  - `seed_vc_reference_max_seconds`: 声質参照に使う先頭秒数。
  - `seed_vc_length_adjust`: 出力長の補正倍率。
  - `seed_vc_inference_cfg_rate`: Seed-VCのCFG係数。
  - UIでは、高速確認、リーズナブル、品質優先、最高品質検証のプリセットを提供する。既定は品質優先。

レスポンス:

- `job_id`
- `status`
- `stages`
- `current_stage`
- `result`
- `error`

完了時の `result`:

- `audio_mime_type`
- `audio_base64`
- `timings_ms`
- `providers`
- `warnings`

## ローカル音声履歴

ローカル開発では、動作確認と比較のために直近の音声を保存する。

- 入力音声は `recordings` として直近10件を保存する。
- 出力音声は `outputs` として直近10件を保存する。
- 11件目以降は古い音声と対応するmetadataを削除する。
- 既定の保存先はgit管理外の `tmp/audio-history/` とする。
- UIでは、直近の `recordings` と `outputs` を一覧し、保存済み音声を再生できる。
- サーバー運用ではFastAPIローカルファイル保存を永続保存先として使わない。必要な場合はオブジェクトストレージなどの外部保存先を使う。

## 応答速度の目標

理想は、ユーザーがスマホに向かって話し終えた直後に、出力音声が再生開始されること。最初の実装では一括処理でもよいが、設計上は以下を妨げない。

- 録音終了直後に処理を開始する。
- 文字起こし、翻訳、TTSの各処理時間を計測して返す。
- 将来、音声生成が始まった部分から順に返すストリーミング出力へ移行できるようにする。

最初のAPIは同期形式で実装してよい。ただし、処理が長くなる構成では非同期job形式またはストリーミング形式を検討する。

## 最初のローカルMVPでやらないこと

- リアルタイム同時通訳。
- 常時稼働する多ユーザー本番サービス。
- 大きいモデルをgitやDocker image layerへ入れること。
- 有料外部APIを検討なしに既定経路へ入れること。
- 後で必要になるまで、長時間音声の複数話者分離は扱わない。

## プライバシーとデータ保持

- 入力録音と生成音声は、既定では一時データとして扱う。
- 将来voice profileを保存する場合は、同意、削除方法、保存場所を先に仕様化する。
- APIキーやプラットフォームtokenはリポジトリに入れない。
