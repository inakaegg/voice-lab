# VibeVoiceスキット生成

## 現在の位置づけ

`/vibevoice` は、`zhskit` のスキット生成機能をこのアプリへ移すための検証画面である。台本、最大4つの参照音声、生成パラメータを入力し、VibeVoiceでWAVを生成する。

初期実装では、ローカル実行とRunPod Serverless実行を選べる。ローカル実行は開発機上のVibeVoice CLIを呼ぶ。RunPod実行はFastAPIがRunPod jobを作り、RunPod handlerが `operation_mode=vibevoice` として同じ処理を実行する。

## 生成オプション

- `モデル`: 比較検証用に、RunPod/ローカルへ渡すVibeVoiceモデルを選ぶ。通常候補は以下とする。
  - `VibeVoice 1.5B 固定版`: ローカルで動作確認した `microsoft/VibeVoice-1.5B` のrevisionを固定して使う。再現性を優先する既定値。
  - `VibeVoice 1.5B 最新`: `microsoft/VibeVoice-1.5B` のHugging Face `main` を使う。2026-07-01時点では固定版と重み/configは同一に見えるが、今後の更新比較用に残す。
- `ランダム性を使う`: VibeVoiceのsamplingを有効にする。同じ台本でもseedや設定によって抑揚や細部が変わる。安定性を優先して比較したい場合はOFFも試す。
- `行ごとに生成して結合`: 台本全体を一度に生成せず、1行ずつ生成して無音を挟んで結合する。長文や複数発話で破綻を分けやすい一方、行間や話し方の連続性は不自然になる可能性がある。
- `参照音声秒数`: 参照音声の先頭から使う長さ。長すぎると処理が重くなり、短すぎると声質特徴が不足する。

台本の正式形式は `Speaker 1: ...` だが、入力時は `1: ...`、`1 ...`、`A: ...`、`A ...` の短縮タグも使える。短縮タグは最大4つの参照音声に合わせて `1-4` または `A-D` を受け、生成前に `Speaker N:` へ正規化する。タグがない行は `Speaker 1:` として扱う。

参照音声はブラウザのIndexedDBへ保存し、次回以降は同じSpeaker枠の既定音声として再利用する。ブラウザの制約によりfile inputへ前回ファイルを直接セットすることはできないため、保存済みファイル名をSpeaker枠内に表示し、生成時に保存済みBlobを送信する。生成時は台本から必要なSpeaker枠を判定し、不要な保存済み音声を送らない。APIからVibeVoice CLIへ渡す時もSpeaker枠番号を保持し、`Speaker 2` の参照音声が `Speaker 1` として詰め直されないようにする。

台本テキストと生成設定はブラウザの `localStorage` へ保存し、次回の `/vibevoice` 表示時に復元する。保存対象は、台本本文、実行先backend、モデル、`cfg_scale`、`inference_steps`、`seed`、`temperature`、`top_p`、`top_k`、`max_voice_seconds`、`line_gap`、`do_sample`、`line_by_line` とする。台本ファイルを読み込んだ場合も、読み込み後のtextarea内容を保存対象にする。保存は同じブラウザ内の作業再開用であり、履歴管理や別端末同期は今後の生成履歴機能で扱う。

長い台本の生成は同期リクエストではなくVibeVoiceジョブとして扱う。UIはジョブの状態をポーリングし、現在ステージ、経過時間、完了時の生成時間を表示する。現時点のプログレスバーは処理中であることを示すインジケータであり、VibeVoice CLIの `tqdm` 出力に含まれる実進捗値はまだ反映していない。成功、失敗、キャンセルなどの終端状態では、完了時の経過時間表示は残してよいが、処理中インジケータのアニメーションは必ず停止する。ローカル実行のジョブでは固定timeoutで停止せず、生成中にキャンセルでき、キャンセル時はVibeVoice CLI subprocessを終了する。互換用の同期 `POST /api/vibevoice/generate` は残すが、画面からの通常生成は `POST /api/vibevoice/jobs` を使う。

`VibeVoice Large` は過去のREADMEでMicrosoft公式候補として言及されていたが、現在の `microsoft/VibeVoice-Large` は公開Hugging Face repoとして取得できない。community copyである `aoi-ot/VibeVoice-Large` は取得できるが、2026-07-01のRunPod検証では現行の非streamingスキット生成CLIで音声生成まで通らなかった。Large repoには `tokenizer.json` がないため `Qwen/Qwen2.5-7B` tokenizerに分ける必要があり、この404は解消できる。しかしその後の生成で、sampling時は `torch.multinomial` のCUDA assert、greedy時は音声波形なしで終了する。これは「Largeが原理的に使えない」という意味ではなく、このアプリが現在固定しているComfyUI-VibeVoice ref、Transformers/Torch組み合わせ、非streamingスキット生成CLIがLargeの推奨生成経路に対応できていないという扱いにする。そのため通常UIのモデル候補には出さない。Largeを扱う場合は、別の実装ref、推奨生成コード、必要GPU/VRAMを再確認してから実験候補として戻す。

`microsoft/VibeVoice-Realtime-0.5B` は `model_type=vibevoice_streaming`、architectureも `VibeVoiceStreaming...` 系で、現在の非streamingスキット生成CLIとは別経路である。RunPod上の通常スキット生成ではCUDA assertまで進むため、通常UIのモデル候補には出さない。これも「Realtimeが使えない」という意味ではなく、streaming model用の入力、生成ループ、出力処理を別実装として持っていないという意味である。Realtimeモデルを扱う場合は、別途streaming向け実装として仕様化してから追加する。

## 関連モデルの扱い

- `microsoft/VibeVoice-1.5B`: 現在のスキット生成の主対象。長めの複数話者TTSを想定する。
- `microsoft/VibeVoice-Realtime-0.5B`: 低遅延TTS候補。streaming modelであり、現在の複数話者スキット生成CLIの通常候補には含めない。
- `microsoft/VibeVoice-ASR` / `microsoft/VibeVoice-ASR-HF`: TTSではなく、ASR、話者分離、タイムスタンプをまとめて出すためのモデル。長い会話音声を「誰が、いつ、何を話したか」に落とす用途で、VibeVoiceスキット生成の直接代替にはしない。
- `aoi-ot/VibeVoice-Large`: Microsoft公式HF repoではないが、ModelScope由来の重みコピーとして取得できるLarge候補。現行CLIではRunPod生成に失敗するため、通常候補には含めない。
- `microsoft/VibeVoice-Large`: 過去の案内では上位候補として見えていたが、現時点では公開repoとして取得できない。

## モデル配置方針

モデル本体やComfyUI-VibeVoice拡張はリポジトリへ入れない。プロジェクトごとの作業ディレクトリには依存させず、`MODEL_CACHE_DIR` または明示的なVibeVoice用環境変数で参照先を決める。

推奨するローカル配置:

```text
<MODEL_CACHE_DIR>/
  vibevoice/
    huggingface/hub/
      models--microsoft--VibeVoice-1.5B/
      models--Qwen--Qwen2.5-1.5B/
    ComfyUI-VibeVoice/
```

対応する環境変数:

```bash
export MODEL_CACHE_DIR=/path/to/shared-models
export MO_VIBEVOICE_HOME=$MODEL_CACHE_DIR/vibevoice/huggingface/hub
export VIBEVOICE_HOME=$MO_VIBEVOICE_HOME
export COMFYUI_VIBEVOICE_PATH=$MODEL_CACHE_DIR/vibevoice/ComfyUI-VibeVoice
export MO_VIBEVOICE_CLI=/path/to/vibevoice.py
export MO_VIBEVOICE_PYTHON=/path/to/python
export VIBEVOICE_DEVICE=cpu
```

`MO_VIBEVOICE_HOME` はアプリ側サービスが参照する設定で、`vibevoice_cli.py` を直接実行する場合は `VIBEVOICE_HOME` を参照する。そのため、ローカル検証では同じパスを両方へ入れる。`MODEL_CACHE_DIR` を指定した場合はその配下を明示設定として扱い、既に存在する `~/.cache/mo-speech` へ自動fallbackしない。`MODEL_CACHE_DIR` もVibeVoice用環境変数も未指定の場合、ローカル実行は `~/.cache/mo-speech/models/vibevoice` 配下を既定候補にする。旧ComfyUIプロジェクトなど、他プロジェクト固有のパスへはfallbackしない。

ローカルmacOSでは、MPS backendがVibeVoiceの複数話者生成中にMetal側で落ちる場合があるため、既定deviceはCPUにする。MPSを明示的に試す場合だけ `VIBEVOICE_DEVICE=mps` を設定する。RunPodなどCUDA環境ではCUDAを自動利用する。

Transformers 5系では、VibeVoice拡張の `tie_weights()` が `decoder_config.tie_word_embeddings` を見ずに早期returnし、`lm_head.weight` がランダム初期化のままになる場合がある。この状態では生成音声が言葉として崩れる可能性が高いため、アプリ内CLIではロード時に `lm_head.weight` を `model.language_model.embed_tokens.weight` へ明示的に結び直す。

RunPod Network Volumeでは、モデルキャッシュを `/workspace` または `/runpod-volume` 配下に置く。ComfyUI-VibeVoice拡張はDocker image内の `/app/ComfyUI-VibeVoice` に入れる構成を既定とし、別途Volumeへ置く場合だけ環境変数で上書きする。

ComfyUI-VibeVoice固定refでは、processorのraw text fallbackが `vibevoice.modules.utils` を参照する一方、実際の `utils.py` は拡張ルート直下の `modules/` にある。processorのraw text経路を外すと台本条件や参照音声スロットが崩れやすいため、アプリ内CLIはraw textをprocessorへ渡し、`vibevoice.modules.utils.parse_script_1_based` だけを軽量aliasで補う。

行単位生成では、各行を1つの局所的な台本として生成する。元台本上の `Speaker 2` だけを単独でprocessorへ渡すと、processor内部のspeaker正規化と参照音声の並びがずれるため、生成時は各行を `Speaker 1` として渡し、その行の元speakerに対応する参照音声だけを使う。元のspeaker番号、テキスト、出力区間はメタデータに保持する。1.5B系では長い複数行台本を一括生成すると同じ行の繰り返しや崩れが出やすいため、4行以上または本文180文字以上の台本は、UI設定が一括生成のままでも自動で行単位生成に切り替える。

VibeVoice本体の既定生成長は、テキストだけでなく参照音声promptを含む入力長から決まるため、短い台本でも150 token程度まで生成が続くことがある。アプリ内CLIでは、`max_new_tokens` を台本文字数と行数から見積もって明示的に渡し、短文が20秒級の無関係な音声として伸び続ける回帰を避ける。

ローカル実行では、VibeVoice CLIの標準エラー出力をAPI側で逐次読み取り、`Generating ... 22/32` のようなtqdm進捗をjob statusへ反映する。Web UIはpollingごとに現在のstage labelと直近ログを表示し、数値進捗が取れた時点でプログレスバーをdeterminate表示へ切り替える。完了まで無変化のアニメーションだけが続く状態にしない。キャンセル要求はこのストリーミング実行中にも監視し、子プロセスを終了する。job API経由でも `MO_VIBEVOICE_TIMEOUT_SECONDS` の上限は有効で、キャンセル監視のためにtimeoutを無効化しない。

```bash
MO_VIBEVOICE_HOME=/workspace/models/vibevoice/huggingface/hub
COMFYUI_VIBEVOICE_PATH=/app/ComfyUI-VibeVoice
MO_VIBEVOICE_CLI=/app/src/mo_speech/vibevoice_cli.py
VIBEVOICE_MODEL_REPO=microsoft/VibeVoice-1.5B
VIBEVOICE_MODEL_REVISION=1904eae38036e9c780d28e27990c27748984eafe
VIBEVOICE_TOKENIZER_REPO=Qwen/Qwen2.5-1.5B
VIBEVOICE_TOKENIZER_REVISION=8faed761d45a263340a0528343f099c05c9a4323
```

Largeを再検証する場合は、モデルrepoとtokenizer repoを分ける。ただし、以下の組み合わせは2026-07-01時点の現行CLIではモデル読み込み後の生成に失敗しており、通常運用には使わない。

```bash
VIBEVOICE_MODEL_REPO=aoi-ot/VibeVoice-Large
VIBEVOICE_MODEL_REVISION=1b81fecc784a076dcd935678db551871f4598ebf
VIBEVOICE_TOKENIZER_REPO=Qwen/Qwen2.5-7B
VIBEVOICE_TOKENIZER_REVISION=d149729398750b98c0af14eb82c78cfe92750796
```

`VIBEVOICE_MODEL_REVISION` と `VIBEVOICE_TOKENIZER_REVISION` は、ローカルで動作確認したキャッシュと同じrevisionをRunPod初回ダウンロードでも使うために固定する。未固定のままHugging Faceの `main` を取得すると、後日のモデル更新で同じ入力でも挙動が変わる可能性がある。

UIでモデルを選んだ場合は、そのリクエストの間だけ `VIBEVOICE_MODEL_REPO`、`VIBEVOICE_MODEL_REVISION`、`VIBEVOICE_TOKENIZER_REPO`、`VIBEVOICE_TOKENIZER_REVISION` 相当の値をRunPod handlerへ渡す。RunPod Volumeに該当モデルがなければ、初回生成内でHugging Faceからダウンロードされる。

## 既知の品質課題

- 日本語の漢字読みが誤ることがある。例として、参照音声が中国語の場合に「最近」を中国語読みへ寄せるなど、参照音声言語の影響を受ける可能性がある。
- 日本語参照音声でも漢字読みを誤る場合がある。台本をひらがなにすると改善するため、テキスト正規化または読み指定の仕組みが必要。
- 途中にノイズや不自然な音が混じることがある。RunPod実行、依存ライブラリ、GPU、生成パラメータ、参照音声前処理の差分を分けて検証する。
- `VibeVoice Realtime 0.5B` は既存の非streamingスキット生成CLIと互換でないため、通常UIでは選択肢に出さない。
- `aoi-ot/VibeVoice-Large` はtokenizerを `Qwen/Qwen2.5-7B` に分けることで404は避けられるが、現行CLIでは生成時にCUDA assertまたは音声波形なしで失敗するため、通常UIでは選択肢に出さない。
- ローカルmacOSのMPS backendでは、モデル読み込み後の生成中にMetal/MPS内部のshape不整合でプロセスがabortする場合がある。CPUは生成が極端に遅いため、品質確認と速度確認はRunPod/CUDAでも必ず行う。
- 台本全体生成と行ごと生成では、自然さ、破綻のしにくさ、行間の違和感が変わる。品質比較では、ブラウザに復元される直近の生成設定と入力台本に加えて、後から比較できる生成履歴が必要。

## これから詰める仕様

### 1. 台本テキストと読み指定

VibeVoiceへ渡す生成用テキストと、ユーザーが編集・確認する表示用テキストを分けるか決める。日本語では漢字を含む自然な台本をUIに残しつつ、生成時だけひらがな、カタカナ、読み付きテキストへ変換する選択肢がある。

- 表示用台本: ユーザーが読みやすく、保存履歴として再利用しやすい表記を保持する。
- 生成用台本: VibeVoiceが読み誤りにくい表記へ変換する。日本語はひらがな化、中国語は簡体字・ピンイン補助、英語はそのまま、など言語ごとに方針が変わる。
- 読み指定: 全文自動変換だけで足りない固有名詞、数字、略語、地名、人名をどう上書きするかを決める。将来は `漢字{よみ}` のような簡易マークアップ、または台本行ごとの読み欄を検討する。
- 保存対象: 元テキスト、生成用に正規化したテキスト、正規化方式、手動読み指定をセットで履歴保存する。

初期方針としては、UIを複雑にしすぎないため、自動正規化はOFF/ON程度に留める。読み誤りが実用上の主要課題として残る場合に、手動読み指定を追加する。

### 2. 参照音声と言語の関係

参照音声の話者言語と出力台本の言語が異なると、音色は近くても発音、抑揚、漢字読みが不自然になる可能性がある。仕様として、話者ごとに「参照音声の言語」と「台本の言語」を持つかを決める。

- 同一言語参照: 品質確認の基準。日本語台本なら日本語参照、中国語台本なら中国語参照を推奨する。
- クロスリンガル参照: デモとしては便利だが、読み誤りやアクセント崩れを許容するかを明示する。
- 混在参照: 1つの台本で話者ごとに参照音声の言語が違う場合、UI上で警告するか、単に実験機能として扱うかを決める。
- 参照音声の長さ: 先頭固定ではなく、発話区間自動選択、無音トリム、音量正規化をどこまで標準化するかを決める。

比較時は、同じ台本、同じseed、同じ生成パラメータで「日本語参照」「中国語参照」「同一話者の別区間」を出し分け、読み誤りと自然さを分けて評価する。

### 3. 生成品質とノイズ対策

ノイズや不自然な音は、モデル、依存実装、GPU、生成パラメータ、参照音声前処理、台本表記のどれが原因か分けて確認する必要がある。

- 生成パラメータ: `cfg_scale`、`inference_steps`、`temperature`、`top_p`、`top_k`、`do_sample`、`seed` を履歴に残す。
- 比較単位: 1つの長い台本だけで判断せず、短文、会話、長文、数字や固有名詞を含む文を分ける。
- ノイズの再現性: 同じseedで再現するならモデル/実装寄り、seedで変わるならsampling寄り、参照音声で変わるなら前処理寄りとして切り分ける。
- 後処理: 音量正規化、先頭末尾無音トリム、短いクリック音の検出、結合時のクロスフェードを追加するか決める。

まずは生成履歴へ入力・参照・パラメータ・出力を残し、同条件で再生成できる状態を優先する。

### 4. 行ごと生成と全体生成

`行ごとに生成して結合` は、長文破綻を抑えやすい一方で、行間の間、抑揚の連続性、話者の感情変化が切れやすい。全体生成は自然につながる可能性がある一方、長文で破綻した場合に原因を追いにくい。

- 既定値: 短いスキットは全体生成、長い教材・説明文は行ごと生成を候補にする。
- 分割単位: UIの「行」をそのまま使うか、句読点で自動分割するかを決める。
- 結合方式: 単純結合、固定無音、クロスフェード、話者切替時だけ間を長くする、などを選ぶ。
- 表示: 「行ごと生成」は内部実装名に近い。ユーザー向けには「長い台本を安定生成」など、目的が分かる表現へ変える余地がある。

### 5. RunPod運用

RunPod Serverlessでは、初回起動、モデル未キャッシュ時のダウンロード、GPU種別、Network Volume、timeout設定が体感速度とコストに直結する。

- イメージ: ComfyUI-VibeVoice拡張はDocker imageへ入れる。モデル本体はNetwork VolumeまたはHugging Face cacheへ置く。
- 初回生成: モデルがVolumeに無い場合は生成リクエスト内でダウンロードが走るため、初回だけ非常に遅くなる。デモ前にwarmupまたは短い生成を行う。
- timeout: VibeVoiceはSeed-VCより長くなる可能性があるため、RunPod job timeoutとAPI側timeoutを分けて管理する。
- GPU選定: VRAM使用量、生成速度、課金単価を記録し、A4500/RTX 2000 Ada/16GB級GPUで足りるかを確認する。
- 失敗ログ: RunPod job id、handler stderr末尾、モデル検出状態、生成パラメータをAPIレスポンスの診断情報として扱う。

本番デモでは、ブラウザへRunPod API keyを渡さず、FastAPIまたはCloudflare Workerなどのサーバー側からRunPod jobを作る構成を維持する。

### 6. zhskit相当機能の取捨選択

`zhskit` の機能をそのまま移植するのではなく、VibeVoice生成の価値に直結するものから選ぶ。

- 優先度高: 台本ファイル読み込み、参照音声の正規化、生成履歴、パラメータ比較、ダウンロード。
- 優先度中: URLからの台本/音声読み込み、複数候補生成、生成結果のクラウド保存、話者プリセット。
- 優先度低: 教材生成、動画レンダリング、外部公開ページなど、音声生成品質の検証と直接関係しない周辺機能。

まずは「同じ入力を条件違いで比較できる」ことを最優先にする。品質課題が残る段階で周辺機能を増やすと、問題の切り分けが難しくなる。

### 7. 実進捗表示

ローカル実行ではVibeVoice CLIがstderrへ `tqdm` 形式の進捗を出すため、これをジョブ状態へ取り込み、UIのプログレスバーへ反映する余地がある。

- ローカル: `subprocess.Popen` のstderrを逐次読み、`Loading weights`、`Generating`、`line-by-line` の現在値、総数、割合をジョブstoreへ保存する。
- UI: indeterminate表示は初期化や未知ステージだけに使い、進捗値が取れるステージではバー幅とパーセントを実値へ切り替える。
- キャンセル: 進捗読取中でもキャンセル要求を優先し、subprocessをterminate/killする。
- RunPod: 通常のRunPod job statusだけではCLI内部stderrの細かい進捗は取れない。RunPodでも実進捗を出す場合は、handlerから外部storeへ進捗を書き、gateway/UIがそれを読む設計が必要になる。

## zhskitから未移植の主な機能

- 台本URL読み込み。
- 参照音声URL読み込み。
- 生成結果のクラウドアップロード。
- スキット作成支援、台本拡張、HSK教材生成、動画レンダリングなどの周辺機能。
- 生成履歴とパラメータ比較。

これらはVibeVoice生成品質とRunPod実行経路が安定した後に、必要なものだけ移植する。
