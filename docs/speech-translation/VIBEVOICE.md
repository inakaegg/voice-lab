# VibeVoiceスキット生成

更新日: 2026-07-20

## この文書の役割

管理者専用の研究機能であるSkitVoice/VibeVoiceの、公開境界、生成の仕組み、モデル配置を説明する。日付つきの検証経緯と実験ログの詳細はGit履歴に委ね、この文書には現在の実装と結論だけを残す。

## 現在の位置づけ

SkitVoice/VibeVoiceは一般公開製品ではなく、privateまたは管理者専用の研究機能である。Cloudflareの `/skitvoice` は、生成フォーム・参照音声・サンプル・model情報を含まない非公開案内だけを表示する。`/skitvoice/admin` は、スキット生成の検証・管理画面として生成パラメータや診断を直接確認できる。ローカルFastAPIは信頼済みの開発環境として研究画面とAPIを維持する。旧routeの互換エイリアスは提供しない。

Cloudflareでは次のVibeVoice APIを、既存Google管理者セッションによる共通guardで保護する。匿名利用者と通常のGoogleログイン利用者は拒否する。

- `GET /api/vibevoice/status`
- `POST /api/vibevoice/reference-audio-from-url`
- `POST /api/vibevoice/scripts`
- `POST /api/vibevoice/jobs`
- `GET /api/vibevoice/jobs/{id}`
- `POST /api/vibevoice/jobs/{id}/cancel`

Cloudflare版にはsync `POST /api/vibevoice/generate` は存在しない。ローカルFastAPIは上記に加えてsync生成を維持する。Cloudflareの非admin向け `public-session` にはSkitVoice feature/quotaを含めず、public sample APIはSkitVoice sampleを返さない。外部R2 dataの削除は別の外部操作として扱う。管理者専用化は一般公開可の証明ではなく、暫定的な封じ込めとして扱う。

実行はローカル実行とRunPod Serverless実行を選べる。ローカル実行は開発機上のVibeVoice CLIを呼ぶ。RunPod実行はFastAPIがRunPod jobを作り、RunPod handlerが `operation_mode=vibevoice` として同じ処理を実行する。

## upstreamの状態と公開判断

[Microsoft公式VibeVoice repository](https://github.com/microsoft/VibeVoice) は、意図に反する利用事例を確認したとしてTTSコードを削除している（2026-07-16時点）。現在のVoice Labは、固定した `microsoft/VibeVoice-1.5B` model revisionと、commit固定した第三者のComfyUI-VibeVoice実装を使う。この構成をMicrosoftの現在の公式TTS実装であるかのように説明しない。

過去にコードへMIT licenseが付与されていたことだけでは、model利用条件・第三者実装の由来・音声クローンの悪用リスク・公開デモとしての妥当性は確定しない。GitHub source・Cloudflare demo・Docker Hub・RunPod imageは別々の公開面として判定し、VibeVoice runtimeとRunPod imageはprivate維持を前提にする。公開を再開する前に、[第三者コンポーネント一覧](../../THIRD_PARTY_NOTICES.md)と[公開前チェックリスト](../deployment/PUBLICATION_CHECKLIST.md)に従って判断する。

VibeVoice固有の未確認事項は、製品共通の同意・保存方針と分けて管理する。audible disclaimerは実音声で聴取確認するもの、watermarkは対応detectorで検証するものである。hashed inference loggingはself-hosted RunPodへ自動継承されない運用機構であり、同じ対策として扱わない。いずれも現時点で実装・検証済みとは記載しない。

## 生成オプション

- `モデル`: 比較検証用にVibeVoiceモデルを選ぶ。
  - `VibeVoice 1.5B 固定版`: 動作確認済みrevisionを固定して使う既定値。
  - `VibeVoice 1.5B 最新`: Hugging Face `main` を使う。今後の更新比較用。
  - `VibeVoice Large (RunPod)`: `aoi-ot/VibeVoice-Large` をRunPod/CUDAで検証する実験候補。ローカルでは選択不可とし、APIも `backend=local` との組み合わせを拒否する。
- `ランダム性を使う`: samplingを有効にする。同じ台本でもseedや設定で抑揚が変わる。
- `行ごとに生成して結合`: 台本を1行ずつ生成して無音を挟んで結合する。長文の破綻を分けやすい一方、行間の連続性は落ちる可能性がある。
- `指定台詞を1行生成してASR再配置`: 指定台詞を正確に読ませる実用モード。詳細は後述。管理画面・シンプル画面とも既定ON。
- `低スコア行だけ再生成`: ASRスコアが閾値未満の行だけ再生成する。上限行数は台本の有効行数から `ceil(有効行数 / 2)` を基準に自動算出し、UIでは `再生成強度` の倍率だけを調整する。
- `出力言語`: 候補は `🇺🇸 English (en-US)`、`🇨🇳 中文 (zh-CN)`、`🇯🇵 日本語 (ja-JP・低品質)`。既定は英語で、保存済みの選択があれば復元する。VibeVoiceは英語・中国語で比較的安定し、日本語は不安定なため低品質候補として明示する。
- `日本語台本を出力言語へ翻訳`: ONの場合、表示用の日本語台本を保持したまま、生成直前に台本本文だけを翻訳する。話者タグ、行数、行順は維持する。既定実装はOpenAI Responses APIを使い、モデルは `OPENAI_VIBEVOICE_SCRIPT_TRANSLATION_MODEL`、未指定時は `OPENAI_TRANSLATION_MODEL`、さらに未指定時は `gpt-5.6-terra` とする。APIキーが無い環境で翻訳ONにした場合は生成前エラーにする。
- `参照音声秒数`: 参照音声の有声区間から使う長さ。長すぎると処理が重く、短すぎると声質特徴が不足する。
- 生成設定パネルにはパラメータ目安を常時表示する。初期値の目安は `cfg_scale=1.1-1.5`・`inference_steps=10-15`（本命候補で `20-30`）・`temperature=0.75-0.95`・`top_p=0.85-0.95`・`top_k=0` とする。

台本の正式形式は `Speaker 1: ...` とする。入力時は `1: ...`・`1 ...`・`A: ...`・`A ...` の短縮タグも使え、生成前に `Speaker N:` へ正規化する。タグがない行は `Speaker 1:` として扱う。

台本テキストと生成設定はブラウザの `localStorage` へ保存し、次回の表示時に復元する。生成設定のリセット操作は、台本本文と参照音声を残したまま生成設定だけを初期値へ戻す。保存は同じブラウザ、同じorigin内の作業再開用とし、サーバー保存や別端末同期は行わない。

## 参照音声の入力方式とURL境界

参照音声はブラウザのIndexedDBへ保存し、次回以降は同じSpeaker枠の既定音声として再利用する。保存済みファイル名をSpeaker枠内に表示し、保存済みBlobをaudioコントロールで再生確認できる。生成時は台本から必要なSpeaker枠を判定し、Speaker枠番号を保持したままCLIへ渡す。

| 接続先・実行環境 | ファイル | マイク録音 | タブ音声録音 | URL入力 | URL取得処理 | RunPodへ渡すもの |
| --- | --- | --- | --- | --- | --- | --- |
| ローカルFastAPI | 可 | 可 | 可 | 可 | 同じFastAPIプロセスで `yt-dlp` / `ffmpeg` を実行 | 選択・録音・切り出し済み音声bytes |
| Cloudflare管理者研究版 | 可 | 可 | 可 | 不可。Worker APIでも拒否 | 実行しない | 選択または録音した音声bytes |
| RunPod handler | 音声bytesのみ | 音声bytesのみ | 音声bytesのみ | URLを受け付けない | 実行しない | `audio_base64` の音声のみ |

- URL切り出しはローカルFastAPI専用の補助機能とする。ローカル専用の `url-reference` optional dependencyで導入した `yt-dlp` と `ffmpeg` で、指定区間を24kHz mono PCM WAVへ切り出す。RunPod imageの `vibevoice` optional dependencyには `yt-dlp` を含めない。
- FastAPIのURL参照APIは、既定ではリクエストURLのhostがloopbackの場合だけ許可する。`MO_VIBEVOICE_URL_REFERENCE_ENABLED` で明示的に許可・禁止を切り替えられる。公開環境では許可しない。
- yt-dlpコマンドは `--js-runtimes node` と `--remote-components ejs:github` を指定する。Nodeはyt-dlpが対応する版をPATH上に配置する。cookieやPO Tokenは既定では使わない。
- URLの `t=` などの再生開始時刻は開始秒として扱い、UIで開始秒を明示した場合はその値を優先する。section取得に失敗しても全体DLへはフォールバックしない。
- URL取得に失敗した時点では、後続のRunPod生成は開始されていない。エラー表示では取得失敗の観測事実を先に示し、RunPodやdatacenter制限を確認済みの原因として表示しない。
- URL参照を設定したSpeaker枠には有効状態を表示し、「URL参照を解除」で明示的に外せる。ファイル選択または録音を行った場合も同じ枠のURL参照を解除する。
- `GET /api/vibevoice/status` の `url_reference_audio` は、有効状態と `yt-dlp` / `ffmpeg` / JS runtimeの検出情報を返す。

## タブ音声録音と権利確認

タブ音声録音はブラウザの `getDisplayMedia()` を使い、共有対象として選択したタブの音声trackだけをMediaRecorderへ渡す。音声trackがない画面・ウインドウ共有は受け付けない。タブ映像、URL、cookieは保存・送信しない。

ブラウザの共有許可は、画面・音声を技術的に取得する権限であって、コンテンツの利用許諾ではない。タブ音声録音の開始前に権利確認を必須とする。自分の音声、本人から許諾を得た音声、またはライセンス上この用途で利用できる音声であることを、ユーザーが画面上で確認した場合だけ共有ダイアログへ進む。生成前の権利確認もファイル、マイク、タブ音声、URLを明示的に含める。確認状態はlocalStorageやサーバーへ保存せず、画面を開くたび未確認から始める。

## ジョブと進捗表示

長い台本の生成は同期リクエストではなくジョブとして扱う。画面からの通常生成は `POST /api/vibevoice/jobs` を使い、UIは状態をポーリングして現在ステージ、経過時間、完了時の生成時間を表示する。

- ローカル実行はVibeVoice CLIのtqdm出力から実進捗値を取り込み、プログレスバーを数値進捗へ切り替える。行単位生成では行ごとの進捗を全体進捗へ変換して表示する。
- RunPod実行はhandlerのprogress updateをjob statusとしてpollingする。表示内容はGPU待ち・初期化・モデル読込・生成・ASR・声質変換・仕上げである。外部の進捗storeは使わず、最終音声もjob outputだけで受け取る。
- 終端状態では処理中インジケータのアニメーションを必ず停止する。
- ローカルjobは固定timeoutで停止せず、キャンセル要求でCLI subprocessを終了する。`MO_VIBEVOICE_TIMEOUT_SECONDS` は、キャンセルイベントを持たない同期呼び出しの上限として扱う。

## 指定台詞向けASR再配置モード

VibeVoiceを「常に1回で正しい音声を返すTTS」ではなく候補生成器として扱い、指定台詞を特定声で正確に読ませるモード。改行や話者タグを含む台本をそのまま渡すと、境界ごとに声質や話し方が変わる場合があるという観察に基づく。

処理の流れ:

1. 表示用台本は元の改行、話者タグ、表記を保持する。
2. 生成用台本は話者ごとに発話を抽出し、句読点でつないだ1行テキストへ正規化する。話者ごとにVibeVoice生成を行い、各生成ではその話者の参照音声だけを `Speaker 1` として渡す。
3. 話者ごとの台本が長い場合は複数のtarget chunkへ分割する。各生成では採用するtarget chunkを先頭に置き、残りchunkをローテーション順にguardとして後ろへ付ける。VibeVoiceは末尾側の発話が欠落しやすいため、末尾には採用対象外のガード文を付ける。
4. VibeVoice出力をASRしてword/segment timestampを取り、元台本の発話行へ対応付ける。ASRの既定は `MO_VIBEVOICE_DIRECTED_ASR_PROVIDER=openai` と `whisper-1` を使う。これはLargeとfaster-whisperを同じGPUへ載せないためで、GPUに余裕がある環境だけ `faster-whisper` を明示する。
5. 候補は決定的な指標でスコアリングする。指標は文字一致率・欠落・混入・区間長・無音率・音量・chunk内位置とする。台詞文字数に対して短すぎる断片は減点し、target候補とguard候補を同じ候補プールで比較する。
6. `低スコア行だけ再生成` がONの場合、閾値未満の行だけを短い入力で再生成し、通常候補と同じ候補プールで比較する。既定は閾値 `0.65`、強度 `1.0`、既定ON。
7. 採用範囲が決まった後、採用行クリップだけをSeed-VCへ通す。Seed-VCは採用済みクリップの声質を寄せる工程とし、それまでロードしない。
8. 元台本の行順へ並べ直し、行間に `line_gap` 秒の無音を挿入して最終音声を作る。結合前にDC offset除去、RMS正規化、peak制限をかける。これは音量差と音割れを減らす後処理であり、台詞内容の修正ではない。

結果確認では、最終音声に加えて、話者ごとのVibeVoice出力と行ごとの採用クリップをUI上で再生できる。話者ごとの中間音声には実際に渡した1行化テキストも表示する。対応付けできない行は別フレーズを無理に割り当てず、警告として表示する。

RunPod経由の返却は巨大化を避けるため、最終音声を既定でMP3へ圧縮して返す。中間音声は返却上限内に入る分だけ返し、VC前の話者別出力は既定で除外する。`return_artifacts=false` で完全に省略できる。診断は `diagnostics.runpod_artifacts` と `diagnostics.runpod_audio_response` に残す。

ローカルの `/api/vibevoice/jobs` 経由では、ジョブ完了時に音声base64を除いた診断JSONを `tmp/vibevoice-debug/` へ保存する。保存先は `MO_VIBEVOICE_DEBUG_RESULT_DIR` で変更・無効化できる。

## モデルの扱い

- `microsoft/VibeVoice-1.5B`: 現在のスキット生成の主対象。
- `aoi-ot/VibeVoice-Large`: Microsoft公式repoではないcommunity copy。ローカルでは扱わず、RunPod/CUDA専用の実験候補にする。tokenizerは `Qwen/Qwen2.5-7B` を分けて指定する。安定運用候補ではなく、短い台本から検証する対象とする。
- `microsoft/VibeVoice-Large`: 現時点では公開repoとして取得できない。
- `microsoft/VibeVoice-Realtime-0.5B`: streaming専用modelで、現在の非streaming生成CLIとは別経路。通常UIの候補には出さない。扱う場合はstreaming向け実装として別途仕様化する。
- `microsoft/VibeVoice-ASR`: TTSではなくASR・話者分離・タイムスタンプ用のモデル。スキット生成の直接代替にはしない。

モデルカード上、VibeVoiceは英語と中国語データで学習されており、それ以外の言語は結果が不明瞭または不適切になり得る。speech-onlyであり、背景音、効果音、音楽の生成は対象外とされている。日本語台本での読み誤りや異音は、まずこの言語・用途制約の影響として切り分ける。

参照音声のファイル形式差は、生成直前のdecode後には主要因にしない。品質差を比較する時は、先頭無音・音量・ノイズ・参照音声の言語などを分けて見る。参照音声は次の順で標準化してからモデルへ渡す。

1. mono decode
2. 24kHz resample
3. NaN/Inf除去
4. 無音trim
5. 上限秒数で切り出し
6. 音量正規化

## モデル配置

モデル本体とComfyUI-VibeVoice拡張はリポジトリへ入れない。`MODEL_CACHE_DIR` または明示的なVibeVoice用環境変数で参照先を決める。

```bash
export MODEL_CACHE_DIR=/path/to/shared-models
export MO_VIBEVOICE_HOME=$MODEL_CACHE_DIR/vibevoice/huggingface/hub
export VIBEVOICE_HOME=$MO_VIBEVOICE_HOME
export COMFYUI_VIBEVOICE_PATH=$MODEL_CACHE_DIR/vibevoice/ComfyUI-VibeVoice
export MO_VIBEVOICE_CLI=/path/to/vibevoice.py
export MO_VIBEVOICE_PYTHON=/path/to/python
export VIBEVOICE_DEVICE=cpu
```

- `MO_VIBEVOICE_HOME` はアプリ側サービス、`VIBEVOICE_HOME` はCLI直接実行が参照するため、ローカル検証では同じパスを両方へ入れる。
- 未指定の場合は `~/.cache/mo-speech/models/vibevoice` 配下を既定候補にする。他プロジェクト固有のパスへはfallbackしない。
- ローカルmacOSの既定deviceはCPUにする。MPS backendは生成中にMetal側で落ちる場合があるため、明示的に試す場合だけ `VIBEVOICE_DEVICE=mps` を設定する。CUDA環境では自動利用する。
- RunPodではモデルキャッシュをNetwork Volumeへ置き、ComfyUI-VibeVoice拡張はDocker image内の `/app/ComfyUI-VibeVoice` に入れる。

RunPodの1.5B既定構成:

```bash
MO_VIBEVOICE_HOME=/workspace/models/vibevoice/huggingface/hub
COMFYUI_VIBEVOICE_PATH=/app/ComfyUI-VibeVoice
MO_VIBEVOICE_CLI=/app/src/mo_speech/vibevoice_cli.py
VIBEVOICE_MODEL_REPO=microsoft/VibeVoice-1.5B
VIBEVOICE_MODEL_REVISION=1904eae38036e9c780d28e27990c27748984eafe
VIBEVOICE_TOKENIZER_REPO=Qwen/Qwen2.5-1.5B
VIBEVOICE_TOKENIZER_REVISION=8faed761d45a263340a0528343f099c05c9a4323
```

Large（`vibevoice-large-aoi-pinned`）の固定構成:

```bash
VIBEVOICE_MODEL_REPO=aoi-ot/VibeVoice-Large
VIBEVOICE_MODEL_REVISION=1b81fecc784a076dcd935678db551871f4598ebf
VIBEVOICE_TOKENIZER_REPO=Qwen/Qwen2.5-7B
VIBEVOICE_TOKENIZER_REVISION=d149729398750b98c0af14eb82c78cfe92750796
VIBEVOICE_TORCH_DTYPE=bfloat16
VIBEVOICE_GENERATION_CONFIG_MODE=explicit
VIBEVOICE_MIN_AUDIO_TOKENS=1
```

revisionを固定するのは、ローカルで動作確認したキャッシュと同じものをRunPod初回ダウンロードでも使うためである。UIでモデルを選んだ場合は、そのリクエストの間だけこれらの値をRunPod handlerへ渡す。

実装上の注意（結論のみ。経緯はGit履歴を参照）:

- Transformers 5系では拡張の `tie_weights()` が効かず `lm_head.weight` が未初期化のままになる場合がある。アプリ内CLIはロード時に `lm_head.weight` を明示的に結び直す。
- ComfyUI-VibeVoice固定refのprocessor経路差を吸収するため、CLIは新しいprocessorでは明示parsed経路、古いprocessorではraw text経路を使う。
- Largeは1.5B向けの `generation_config` でCUDA assertするため、Largeプリセットでは明示samplingと初期音声token制約を使う。`VIBEVOICE_MIN_AUDIO_TOKENS` は生成直後にEOSへ落ちる挙動を避ける下限指定で、CLIが台本長に応じた最低音声token数を見積もる。
- 生成長は入力長から決まるため、CLIは `max_new_tokens` を台本文字数と行数から見積もって明示し、短文が長時間の無関係な音声へ伸びる回帰を避ける。
- 行単位生成では各行を `Speaker 1` として渡し、その行の元speakerに対応する参照音声だけを使う。元のspeaker番号はメタデータに保持する。1.5B系では4行以上または本文180文字以上の台本を自動で行単位生成へ切り替える。Largeは品質比較のため自動切替しない。
- 20GB級GPUでLargeを使う場合は、他のresident GPUモデルを同じworker processに残さない。VibeVoice用RunPod imageの既定は `MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START=0` とし、生成前に既存のVoice Conversion serviceとFunASRを解放する。

## 既知の品質課題

- 日本語の漢字読みを誤ることがある。参照音声の言語にも影響を受け、台本をひらがなにすると改善する。テキスト正規化または読み指定の仕組みが必要。
- 途中にノイズや不自然な音が混じることがある。同じseedで再現するならモデル/実装寄り、seedで変わるならsampling寄り、参照音声で変わるなら前処理寄りとして切り分ける。
- 日本語と中国語の1行化生成は、30秒前後で生成が終わり台本の後半が出ないことが多い。ローテーションガードと再生成はこの対策を兼ねる。
- 台本全体生成と行ごと生成では自然さと破綻のしにくさが変わる。品質比較には後から比較できる生成履歴が必要。

## これから詰める仕様

- 台本テキストと読み指定: 表示用台本と生成用台本の分離は実装済み。固有名詞などの手動読み指定（例: `漢字{よみ}` 形式）は、読み誤りが主要課題として残る場合に追加する。
- 参照音声と言語の関係: 話者ごとに参照音声の言語と台本の言語を持つか決める。クロスリンガル参照の扱いを明示する。
- 生成履歴: 入力・参照音声・パラメータ・出力を残し、同条件で再生成できる状態を優先する。
- RunPod運用: GPU種別ごとのVRAM使用量、生成速度、課金単価の記録。デモ前のwarmup。job timeoutとAPI側timeoutの分離。
- zhskit相当機能の取捨選択: 台本ファイル読み込み、生成履歴、パラメータ比較を優先する。教材生成、動画レンダリングなどの周辺機能は品質検証と直接関係しないため後回しにする。

## zhskitから未移植の主な機能

- 台本URL読み込み、参照音声URL読み込み。
- 生成結果のクラウドアップロード。
- スキット作成支援、台本拡張、HSK教材生成、動画レンダリングなどの周辺機能。
- 生成履歴とパラメータ比較。

これらはVibeVoice生成品質とRunPod実行経路が安定した後に、必要なものだけ移植する。

クラウドアップロードは、VibeVoice CLIにzhskit由来のS3／GCS実装が残っていたが削除した。アプリ経路から到達できず、依存も宣言していなかったためである。再導入する場合は、保存先、公開範囲、認証情報の管理を先に仕様化する。

## 簡易画面の台本・翻訳・タブ音声

- 初期台本は Speaker 1 / 2 の5行会話とする。
- 「台本自動生成」は、現在の台本を着想元として日本語で2話者・5行の会話へ再構成する。台本が空欄の場合は短い日常会話を新規生成する。
- 簡易画面では翻訳チェックを表示しない。台本の言語を固定せず、出力言語と異なる場合だけ生成前に自動翻訳する。翻訳した場合は生成結果に「翻訳後の台本」を表示する。
- 参照音声の権利確認チェックを生成操作の直前に常設し、タブ音声録音の開始前と生成前に同じ確認状態を検査する。確認状態は画面を開くたび未確認から始める。
- タブ音声録音は `getDisplayMedia` と `MediaRecorder` を利用できるブラウザだけに表示する。初期判定で非対応なら操作と案内を隠す。利用開始時に非対応と判明した場合だけtoastで代替手段を案内し、そのセッション中は操作を隠す。権限ダイアログのキャンセルだけでは操作を隠さない。
- 主要な生成ステータスとエラーは処理目的で表現する。provider・モデル・raw stage・詳細エラーは弱い技術詳細・進捗ログ・サーバーログへ分離する。公開 `/skitvoice` は生成状態を持たない。
- 画面には、参照音声が自分の音声、本人から許諾を得た音声、またはライセンス上利用できる音声であることの確認を常設表示する。
- 自動翻訳の診断には、モデルが判定した入力台本の言語コードを残す。
