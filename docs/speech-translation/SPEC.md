# Voice Lab Webアプリ仕様

更新日: 2026-08-04

## 目的

Voice Labは、音声を使って発音を学ぶSpeakLoopを公開ポートフォリオの主機能とする。ローカルFastAPI、Cloudflare Worker、RunPod Serverlessの責任を分離し、秘密情報とGPU処理をブラウザへ置かない。この構成はproduction公開環境へ反映済みである。

Zoovoiceは同じWorkerへ載せる別機能であり、音声認識から合成までをGoogle Cloud Run上のGo APIへ委譲する。production公開はflagで止めており、有効化条件は [Zoovoice](#zoovoice) に定める。

## 正式route

| route | 用途 | Cloudflareでの公開範囲 |
| --- | --- | --- |
| `/` | Voice Labポータル | 公開 |
| `/speakloop` | SpeakLoop | 公開 |
| `/zoovoice` | Zoovoice | `ZOOVOICE_ENABLED=1` の配備だけ公開 |
| `/admin` | 総合管理 | 管理者認証必須 |
| `/speakloop/admin` | SpeakLoop管理 | 管理者認証必須 |

### 管理者認証

- Cloudflare版の管理者認証は、公開生成APIと同じGoogle OAuthセッションを使う。許可メールに含まれるアカウントだけが管理routeと管理APIへアクセスできる。
- Cloudflare版の単体Seed-VCは、job作成だけでなくstatus pollingと結果取得も管理者専用にする。
- 管理者は公開quotaを消費しないが、入力サイズ上限は適用する。
- 別の管理パスワードや管理者cookieは設けない。
- ローカルFastAPIは開発者が起動する信頼済み環境として、管理ログインなしで管理画面を提供する。
- 廃止した旧routeへの互換aliasは設けない。Static AssetsのHTMLファイルを直接指定して管理者認証を迂回できないようにする。

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
- 外部AIプロバイダの利用枠超過は例外として原因カテゴリだけを利用者へ伝える。固定文言「現在サーバー側のAI利用枠を超えているため処理できません。時間をおいてもう一度お試しください。」をHTTP 503で返し、クレジット残高や課金状態の詳細は表示しない。

## Zoovoice

Zoovoiceは、録音した発話の内容から動物を1種だけ自動で選び、その鳴き声を発話のすき間へ重ねる機能である。SpeakLoopとはUIとAPIを分け、GoogleログインとSpeakLoop用quotaの対象にしない。データ境界は [公開デモのデータ取扱い境界](../deployment/PRIVACY.md) を正とする。

この節の自動連想と1画面UIはリポジトリの現在のコードに実装済みである。Cloud Runへのdeployと本番有効化は未実施である。

### 用語

- 動物連想とは、ASR本文から根拠語を探し、利用できる音源を持つ動物1種を自動で選ぶ処理を指す。
- 動物レキシコンとは、種ID・語・オノマトペ・採用音声の対応を1ファイルへ持つ生成物を指す。
- 連想根拠とは、選ばれた動物と、その選択に使った語またはfallbackの理由を指す。
- アニマル度とは、鳴き声の挿入頻度を決める設定を指す。通常UIで利用者が変えられる設定はこれだけとする。

### 動物レキシコン

- 次の項目は動物レキシコンを唯一の正本とする。

  - 自動連想が選べる動物の種ID
  - 動物の日本語ラベル
  - 照合に使う語
  - 鳴き声オノマトペ
  - 動物と音声ファイルの対応

- 動物レキシコンは追跡している生成物であり、実体は `services/zoovoice/assets/animal-lexicon.json` とする。同じ内容を実装コードやdocsへ手書きしない。
- レキシコンの動物は、検証済みの音声ファイルをちょうど1本だけ持つ。レキシコンは音声のSHA-256を記録する。
- Go APIは起動時に、レキシコンの全動物について音声ファイルの実在とSHA-256の一致を確認する。1件でも欠けるか一致しない配備では起動しない。
- 第1弾の対象は27種とする。内訳は、Stability AI Community LicenseのStable Audio生成音声24件と、CC0からの移行fallback 3件である。移行fallbackの対象は犬・猫・コオロギとする。
- 素材ごとの出所、ライセンス、採用hashは `services/zoovoice/assets/animal-sounds/manifest.json` を正とする。
- 語はConceptNet由来のため、動物そのものを指さない表記も含む。例えば `pig` の語は `豚` と `豚肉` である。
- 現在の合格条件として、「豚肉は美味しいです」は `random_fallback` にならず `pig` を選ぶ。
- 生成音声を使う公開UIは `Powered by Stability AI` を表示する。必須の表示文とlink先は [NOTICE-STABILITY-AI.md](../../services/zoovoice/NOTICE-STABILITY-AI.md) を正とする。
- 対象種の追加は入力の更新と再生成で行う。
- 約50種規模への拡張は将来の段階として扱う。現在の仕様は27種であり、拡張の時期は含めない。

### 通常の流れ

- 通常の流れはマイク録音から始める。手動停止または60秒の自動停止で確定した録音は、停止後すぐ自動で送信する。
- 送信の後はサーバー側ASR、動物連想、合成、自動再生の順で自動的に進む。専用の生成ボタンと録り直しボタンは置かない。
- 録音中は取消でき、取消した音声は送信しない。500ms未満の録音も送信しない。
- 1回の録音で自動送信する合成requestは1回だけとする。追加の合成requestは、retry可能な失敗の後に利用者が「もう一度生成」を押した場合だけ発生する。
- Turnstileが必要な配備では、tokenが未完了の間は送信を保留してtoken待ちを示す。tokenはcomposeごとに検証し、成功・失敗の後は次のtokenを取得する。
- アニマル度は録音開始時の値を初回合成に使う。「もう一度生成」では現在の値を使う。
- 合成に成功すると結果音声の自動再生を試みる。利用者は再生とダウンロードを操作できる。
- 利用者は通常UIで動物を選ばない。録音、再生、ダウンロードは設定ではなく操作として扱う。
- 動物の手動選択、preset、ランダム選択ボタン、挿入位置の個別指定は通常UIへ置かない。

### 公開範囲

- `/zoovoice` と合成系APIは `ZOOVOICE_ENABLED=1` の配備だけで公開する。この値が無い配備では `/zoovoice` を404にする。
- 公開APIは `GET /api/zoovoice/config`、`GET /api/zoovoice/animals`、`POST /api/zoovoice/compose` の3つとする。
- 無効な配備では動物一覧と合成を503で拒否する。configだけはflagの状態を伝えるため応答する。

### APIの担当

- `GET /api/zoovoice/config` は有効・無効の状態と公開設定を返す。UIはこの応答だけで利用可否を判断する。
- `GET /api/zoovoice/animals` はWorker Static Assetsの静的JSONを返す。この経路は合成backendを起動せず音声データも扱わない。
- この静的JSONは動物レキシコンから生成する。種IDと日本語ラベルだけを載せ、音源のファイル名は載せない。
- 自動連想が選べる動物は、この一覧にある音源付きの動物に限る。
- `POST /api/zoovoice/compose` は録音とアニマル度を受け取る。通常の設定契約は `{intensity}` だけとし、動物と挿入位置はGo APIが決める。
- Workerは合成前にTurnstile検証と利用上限判定を行う。
- ASR、動物連想、合成はGoogle Cloud Run上のGo APIが担当する。Workerはprivate Cloud Runへ認証付きで中継し、ブラウザからGo APIへ直接送る経路は持たない。

### 日本語ASR

- ASRはサーバー側で行う。ブラウザの音声認識APIとクラウドASR APIは使わない。
- Go APIはwhisper.cppの `whisper-cli` とsmallモデルを日本語固定で呼ぶ。
- ASRへ渡す音声は16kHz、mono、16-bit PCMへ変換する。合成に使う音声とは別に用意する。
- 認識結果が空の場合は動物を選ばず、発話を認識できなかったことを示すエラーを返す。

### 動物の自動連想

- 連想は日本語ASR本文を形態素解析し、照合に使うtoken列を得る。
- 連想は `direct`、`pun`、`conceptnet`、`random_fallback` の4段を順に試す。上位の段で決まった時点で確定する。
- `direct` と `pun` の照合には、ASR本文の表層に現れる動物レキシコンの語だけを使う。基本形や読みから一致を作らない。
- 語の一致は、始まりと終わりがtoken境界にそろう連続token列だけを認める。
- 動物名の語の一致は `direct` か `pun` のどちらかへ分類する。動物への直接の言及を `direct` とする。
- 鳴き声オノマトペの一致は、前後の音の文脈を要求せず `direct` とする。
- `pun` は、動物名の語が別の語句と重なる語呂合わせとする。「うしろ」の牛、「ぞうきん」の象のように、tokenizer上の連続token列と一致した場合だけ採用する。
- 一致が複数ある場合は `direct` を `pun` より優先し、同方式ではASR本文の先頭に近いものを選ぶ。
- 基本形と読み、隣接する内容語だけの2〜3語連接は、`direct` と `pun` で決まらなかった後のConceptNet queryの候補語にだけ使う。
- `conceptnet` は、形態素候補と隣接する内容語の2〜3語連接を使う日本語ConceptNetの1-hopとする。関係の種類ごとの係数をweightへ掛けた合計で順位を決め、同点の場合は本文の先頭に近い根拠語を優先する。
- どの段でも決まらない入力は `random_fallback` にする。
- 採用するのは最上位の1種だけとする。複数候補を利用者へ提示しない。
- 1回の合成で使う動物は1種だけとし、すべての挿入位置へ同じ動物を配置する。
- 合成応答のmetadataはASR本文、選ばれた動物、根拠語を返す。
- 合成応答のmetadataは選択方式、fallback理由、挿入位置、入出力の長さも返す。
- 根拠語は、`direct` と `pun` では一致したレキシコンの語、`conceptnet` では概念語とし、`random_fallback` ではnullとする。
- fallback理由は `random_fallback` のときだけ `no_association_match` とし、それ以外はnullとする。
- UIは、根拠語のある連想とrandom fallbackを利用者が区別できるように表示する。
- ASRモデル、ConceptNet index、必要な外部commandのいずれかが欠けた場合はエラーを返す。固定の動物へ黙って切り替えない。
- ASR本文と根拠語は応答とサーバーのメモリ内だけで扱い、ログや保存先へ残さない。

### ローカル確認

ローカル確認の正本はWranglerで動かすWorkerとする。ブラウザでの手動確認とPlaywrightのe2e確認は、どちらもWrangler localを起動する。Go APIは起動時にwhisper.cppのcommand、ASRモデル、ConceptNet indexの実在を確認し、欠けた場合は起動しない。これらはリポジトリ外へ置き、環境変数でpathを渡す。

確認modeは次の2つとし、いずれも用語をここで定義する。

- local origin modeとは、同じ開発端末で動くGo APIへWorkerが認証なしで接続する確認modeを指す。
- Cloud Run smoke modeとは、ローカルのWorkerから実際のprivate Cloud Runへ認証付きで接続する確認modeを指す。

local origin modeは次の3条件をすべて満たす場合だけ成立する。1つでも欠けた場合は認証なし接続を許さない。

- 配備設定で明示的にlocal modeを指定している
- requestのhostnameがloopbackである
- 接続先originがloopbackのHTTPである

Cloud Run smoke modeの条件は次のとおりとする。

- loopback上で動くWranglerだけがこのmodeを使える
- ローカルのgcloudがservice account impersonationで短期のGoogle ID tokenを取得する
- 取得したID tokenはloopback上のWranglerへlocal secretとして渡す。Worker自身はID tokenを取得しない
- production用のservice account keyは使わない
- 接続先はus-central1のprivate Cloud Runとする

local origin modeの通し確認はPlaywrightのe2eで行う。対象は録音から日本語ASR、動物の自動連想、合成を経て再生とダウンロードまでとする。この確認はTurnstileのtest keyを使い、実モデルと実indexを持つlocalのGo APIへ接続する。

ZoovoiceのFastAPI routeとproxyは廃止対象であり、ローカル確認の根拠に使わない。SpeakLoopのFastAPI版は従来どおり維持する。

### productionの扱い

- production配備のZoovoiceはまだ有効化していない。
- production Workerの認証は、専用invoker service accountのkeyによるID token取得方式とする。方式の決定と実装は完了しており、詳細は [CLOUDFLARE.md](../deployment/CLOUDFLARE.md) を正とする。
- production向け設定（`ZOOVOICE_ORIGIN_MODE="cloud-run"`）のWorkerは、ローカル確認用flagの配備とloopbackからのrequestを拒否する。ローカル確認用のcredentialをproduction hostnameで使わない。条件が揃わない場合はCloud Runを呼ばずfail closedにする。
- 外部deployとproduction有効化は別のgateで扱う。対象はprivateなArtifact Registryへのimage push、GCP resource作成、IAM設定と実key発行、有効化varsのmain経由deployである。
- 配備scriptはdry-run、local-only verification、明示applyの3modeを持つ。remote writeを行うのは明示applyだけとする。配備契約は [ARCHITECTURE.md](../deployment/ARCHITECTURE.md) を正とする。
- ASRモデルと連想indexを含むimageは、CPU 2とメモリ2GiBの上限付きでlocal buildと起動を実測済みである。実測値と測定条件は [ARCHITECTURE.md](../deployment/ARCHITECTURE.md) を正とする。
- 実測はApple Silicon上のlinux/amd64 emulationで行っており、Cloud Runの実CPU上の処理時間は未確認である。
- Cloud Runへの実deploy、privateなArtifact Registryへのpush、GCP resourceとIAMの作成、実keyのsecret登録と有効化はいずれも未実施である。これらを終えるまでproduction readyとして扱わない。

## 実行環境の責任

| 処理 | ローカルFastAPI | Cloudflare Worker | RunPod handler | Zoovoice Go API |
| --- | --- | --- | --- | --- |
| UI配信 | ○ | Static Assets | — | — |
| Google OAuth・公開quota | — | ○ | — | — |
| OpenAI ASR・翻訳・TTS | 母語入力、英語復唱、翻訳、TTS | 母語入力、英語復唱、翻訳、TTS | — | — |
| SpeakLoop中国語比較ASR | provider経由で非同期jobを依頼・polling | お手本／復唱音声bytesを非同期jobとして中継 | `paraformer-zh`でASR後に`fa-zh`整列とVADスナップ | — |
| Seed-VC GPU推論 | provider経由で依頼 | job APIを中継 | ○ | — |
| quota・監査・サンプルmetadata | ローカルファイル | D1、bindingなし時のみfallback | — | — |
| 音声履歴 | ローカルファイル | 保存しない | 保存しない | 保存しない |
| 公開サンプル音声blob | ローカルファイル | R2、bindingなし時のみfallback | — | — |
| Zoovoice動物一覧 | 担当しない | Static AssetsのJSONを返す | — | — |
| Zoovoice ASR・動物連想 | 担当しない | 担当しない | — | ○ |
| Zoovoice合成 | 担当しない | Turnstile検証、利用上限、認証付き中継 | — | ○ |
| Zoovoice利用上限counter | 担当しない | D1 | — | — |

Zoovoice Go APIはGoogle Cloud Run上のcontainerとして動かす。Cloud Runはprivate IAMを前提とし、unauthenticated requestとブラウザからの直接requestを拒否する。local smoke用に権限を持つdeveloperまたはservice accountは呼び出せるため、到達経路はCloudflare Workerだけに限定されない。

RunPod handlerの契約:

- URL、cookie、ブラウザ認証情報を受け取らず、音声bytesだけを受け取る。
- SpeakLoop中国語復唱では `operation_mode=practice_asr`・`audio_base64`・`target_text` を受け取る。
- SpeakLoop比較jobは `align_timestamps=true` を指定する。お手本ASRがキャッシュ済みでも、復唱音声のforced alignmentを行う。
- 単音声のFunASR確認では `align_timestamps` を省略するか `false` にする。この場合は `fa-zh` を読み込まず、`paraformer-zh` のtimestampをそのまま返す。
- お手本ASRのキャッシュが無い場合は `model_audio_base64` も受け取る。handler outputは `practice_asr_contract_version=3` と `model_transcription` を必須とする。`model_transcription.words` にはforced alignment後の時刻を保存する。
- お手本ASRのキャッシュがある場合は `model_audio_base64` を省略できる。このjobではRunPod側のお手本ASRを行わないため、`model_transcription` も返さない。WorkerまたはFastAPIはjobと対応付けたキャッシュ済みASRを使う。
- forced alignment導入前のキャッシュは再利用しない。FastAPIはキャッシュキーへ `fa-zh-v1` を含める。Cloudflareはモデル識別子 `runpod-funasr-fa-zh-v1` を使い、旧KV値は既存TTLで自然失効させる。
- `model_audio_base64` は通常TTSのお手本音声とする。`自分の声` がオンでもSeed-VC後の再生音声へ差し替えない。
- WorkerとFastAPIは、必要な `model_transcription` の欠落を一般的なASR失敗と混同せず再デプロイ案内にする。
- `自分の声` では既存の `operation_mode=voice_conversion` を使い、WorkerまたはFastAPIがSpeakLoop専用job APIとして状態を中継する。
- RunPodのprogress updateは途中stage表示に使う。最終job outputを採点と比較再生の正、Seed-VC job outputを再生音声の正とする。

## 保存とプライバシー

- 実装上のデータフローと保持境界は [公開デモのデータ取扱い境界](../deployment/PRIVACY.md)、利用者向け説明は [Voice Lab プライバシーポリシー](../PRIVACY_POLICY.md) を正とする。
- D1は48時間を超えた日次quotaと90日を超えた監査ログを日次削除し、利用者向けには実際の最大保持期間である3日未満、91日未満と案内する。署名cookieは30日、短期job snapshotは1時間、累計quotaは公開デモの運用中に保持する。
- API key・OAuth token・モデル・生成音声・録音サンプルをgit管理しない。
- 公開デモのquota・audit識別子はGoogle emailをSHA-256 hash化してD1またはKV fallbackへ保存し、平文emailを新規のquota・audit履歴へ保存しない。
- ログインしたemailと日時だけは `public_users` へ平文で保存し、管理者専用の `GET /api/public-users` と `/admin` の利用者一覧から読む。保持は公開デモの運用中に限る。quota・auditは引き続きhashだけを使う。
- 音声履歴はローカルFastAPI版だけで保存する。Cloudflare公開版は入力音声と生成音声を履歴として保存しない。
- Zoovoiceは録音、生成音声、ASR本文のいずれも保存しない。WorkerとGo APIは、これらを応答の生成に必要な間だけ扱う。
- ローカルFastAPI版は、RunPod比較の選択条件とterminal snapshotを短期job stateへ既定で1時間保存する。このstateは音声bytesを含まず、音声履歴の有効・無効とは分離する。
- 公開画面では、外部サービスで処理される音声へ個人情報や機密情報を含めないよう案内する。
- 生成物を私的利用の範囲を超えて公開・共有する場合は、参照音声の利用条件を確認する。

## UI契約

- 公開UIの視覚階層、レスポンシブ、テーマ、状態は [UI_STYLE.md](../UI_STYLE.md) を正とする。
- 通信を伴う保存・削除・生成操作は、処理中・成功・失敗をボタン付近のstatusで通知し、処理中は二重送信を防ぐ。
- ブラウザ既定audio controlsを公開・管理UIへ露出せず、共通の再生・一時停止・シーク・時間表示を使う。

## 検証

```sh
python3 -m pytest
npm test
npm run check:js
npm run check:web
npm run test:e2e
cd services/zoovoice && go vet ./... && go test ./...
```

RunPod image buildとGPU smokeは通常CIから分離し、ローカルのモデル非依存テスト通過後に必要最小限だけ実行する。
