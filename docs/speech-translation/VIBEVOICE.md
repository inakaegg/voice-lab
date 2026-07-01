# VibeVoiceスキット生成

## 現在の位置づけ

`/vibevoice` は、`zhskit` のスキット生成機能をこのアプリへ移すための検証画面である。台本、最大4つの参照音声、生成パラメータを入力し、VibeVoiceでWAVを生成する。

初期実装では、ローカル実行とRunPod Serverless実行を選べる。ローカル実行は開発機上のVibeVoice CLIを呼ぶ。RunPod実行はFastAPIがRunPod jobを作り、RunPod handlerが `operation_mode=vibevoice` として同じ処理を実行する。

## 生成オプション

- `モデル`: 比較検証用に、RunPod/ローカルへ渡すVibeVoiceモデルを選ぶ。初期候補は以下とする。
  - `VibeVoice 1.5B 固定版`: ローカルで動作確認した `microsoft/VibeVoice-1.5B` のrevisionを固定して使う。再現性を優先する既定値。
  - `VibeVoice 1.5B 最新`: `microsoft/VibeVoice-1.5B` のHugging Face `main` を使う。2026-07-01時点では固定版と重み/configは同一に見えるが、今後の更新比較用に残す。
  - `VibeVoice Realtime 0.5B`: `microsoft/VibeVoice-Realtime-0.5B` を使う実験候補。軽量で初回応答が速い可能性がある一方、単一話者寄り・英語寄りのモデルであり、既存CLIとの互換性と日本語/中国語品質は検証対象とする。
  - `VibeVoice Large 実験`: `aoi-ot/VibeVoice-Large` を使う実験候補。Microsoft公式HF repoではなく、ModelScope由来のcommunity copyなので、取得元とrevisionを固定して比較する。
- `ランダム性を使う`: VibeVoiceのsamplingを有効にする。同じ台本でもseedや設定によって抑揚や細部が変わる。安定性を優先して比較したい場合はOFFも試す。
- `行ごとに生成して結合`: 台本全体を一度に生成せず、1行ずつ生成して無音を挟んで結合する。長文や複数発話で破綻を分けやすい一方、行間や話し方の連続性は不自然になる可能性がある。
- `参照音声秒数`: 参照音声の先頭から使う長さ。長すぎると処理が重くなり、短すぎると声質特徴が不足する。

台本の正式形式は `Speaker 1: ...` だが、入力時は `1: ...`、`1 ...`、`A: ...`、`A ...` の短縮タグも使える。短縮タグは最大4つの参照音声に合わせて `1-4` または `A-D` を受け、生成前に `Speaker N:` へ正規化する。タグがない行は `Speaker 1:` として扱う。

参照音声はブラウザのIndexedDBへ保存し、次回以降は同じSpeaker枠の既定音声として再利用する。ブラウザの制約によりfile inputへ前回ファイルを直接セットすることはできないため、保存済みファイル名をSpeaker枠内に表示し、生成時に保存済みBlobを送信する。

`VibeVoice Large` は過去のREADMEでMicrosoft公式候補として言及されていたが、現在の `microsoft/VibeVoice-Large` は公開Hugging Face repoとして取得できない。RunPod比較では、community copyである `aoi-ot/VibeVoice-Large` を実験扱いで使う。

## 関連モデルの扱い

- `microsoft/VibeVoice-1.5B`: 現在のスキット生成の主対象。長めの複数話者TTSを想定する。
- `microsoft/VibeVoice-Realtime-0.5B`: 低遅延TTS候補。軽量だが、単一話者寄りで、既存の複数話者スキット生成CLIと同じように使えるかは検証対象。
- `microsoft/VibeVoice-ASR` / `microsoft/VibeVoice-ASR-HF`: TTSではなく、ASR、話者分離、タイムスタンプをまとめて出すためのモデル。長い会話音声を「誰が、いつ、何を話したか」に落とす用途で、VibeVoiceスキット生成の直接代替にはしない。
- `aoi-ot/VibeVoice-Large`: Microsoft公式HF repoではないが、ModelScope由来の重みコピーとして取得できるLarge実験候補。約17GiBの重みを持つため、RunPod Volume容量、初回DL時間、GPU VRAMを分けて測る。
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
export COMFYUI_VIBEVOICE_PATH=$MODEL_CACHE_DIR/vibevoice/ComfyUI-VibeVoice
export MO_VIBEVOICE_CLI=/path/to/vibevoice.py
export MO_VIBEVOICE_PYTHON=/path/to/python
```

`MODEL_CACHE_DIR` もVibeVoice用環境変数も未指定の場合、ローカル実行は `~/.cache/mo-speech/models/vibevoice` 配下を既定候補にする。旧ComfyUIプロジェクトなど、他プロジェクト固有のパスへはfallbackしない。

RunPod Network Volumeでは、モデルキャッシュを `/workspace` または `/runpod-volume` 配下に置く。ComfyUI-VibeVoice拡張はDocker image内の `/app/ComfyUI-VibeVoice` に入れる構成を既定とし、別途Volumeへ置く場合だけ環境変数で上書きする。

```bash
MO_VIBEVOICE_HOME=/workspace/models/vibevoice/huggingface/hub
COMFYUI_VIBEVOICE_PATH=/app/ComfyUI-VibeVoice
MO_VIBEVOICE_CLI=/app/src/mo_speech/vibevoice_cli.py
VIBEVOICE_MODEL_REPO=microsoft/VibeVoice-1.5B
VIBEVOICE_MODEL_REVISION=1904eae38036e9c780d28e27990c27748984eafe
VIBEVOICE_TOKENIZER_REPO=Qwen/Qwen2.5-1.5B
VIBEVOICE_TOKENIZER_REVISION=8faed761d45a263340a0528343f099c05c9a4323
```

`VIBEVOICE_MODEL_REVISION` と `VIBEVOICE_TOKENIZER_REVISION` は、ローカルで動作確認したキャッシュと同じrevisionをRunPod初回ダウンロードでも使うために固定する。未固定のままHugging Faceの `main` を取得すると、後日のモデル更新で同じ入力でも挙動が変わる可能性がある。

UIでモデルを選んだ場合は、そのリクエストの間だけ `VIBEVOICE_MODEL_REPO`、`VIBEVOICE_MODEL_REVISION`、`VIBEVOICE_TOKENIZER_REPO`、`VIBEVOICE_TOKENIZER_REVISION` 相当の値をRunPod handlerへ渡す。RunPod Volumeに該当モデルがなければ、初回生成内でHugging Faceからダウンロードされる。

## 既知の品質課題

- 日本語の漢字読みが誤ることがある。例として、参照音声が中国語の場合に「最近」を中国語読みへ寄せるなど、参照音声言語の影響を受ける可能性がある。
- 日本語参照音声でも漢字読みを誤る場合がある。台本をひらがなにすると改善するため、テキスト正規化または読み指定の仕組みが必要。
- 途中にノイズや不自然な音が混じることがある。RunPod実行、依存ライブラリ、GPU、生成パラメータ、参照音声前処理の差分を分けて検証する。
- 台本全体生成と行ごと生成では、自然さ、破綻のしにくさ、行間の違和感が変わる。品質比較用に生成設定と入力台本を保存できる仕組みが今後必要。

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

## zhskitから未移植の主な機能

- 台本URL読み込み。
- 参照音声URL読み込み。
- 生成結果のクラウドアップロード。
- スキット作成支援、台本拡張、HSK教材生成、動画レンダリングなどの周辺機能。
- 生成履歴とパラメータ比較。

これらはVibeVoice生成品質とRunPod実行経路が安定した後に、必要なものだけ移植する。
