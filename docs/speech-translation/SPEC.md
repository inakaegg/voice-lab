# Voice Lab Webアプリ仕様

更新日: 2026-08-24

## English summary

- Normative spec for the Voice Lab web app. The Japanese text below is the source of truth.
- SpeakLoop is the main public feature. Zoovoice rides on the same Worker behind the `ZOOVOICE_ENABLED` flag.
- Responsibilities are split across local FastAPI, the Cloudflare Worker, and private GPU backends. Secrets and GPU work stay out of the browser.
- Defines the official routes and admin authentication (the same Google OAuth session as the public APIs).
- SpeakLoop spec: recording and languages / repetition ASR / LLM comparison and scoring / heard-text diff / own-voice (Seed-VC) / async jobs.
- Zoovoice spec: terms / sound catalog and licensing / flow / API responsibilities / Japanese ASR / loudness / LLM animal association.
- Also fixes execution-environment responsibilities, storage and privacy boundaries, the UI contract, and verification.

## 目的

Voice Labは、音声を使って発音を学ぶSpeakLoopを公開ポートフォリオの主機能とする。ローカルFastAPI、Cloudflare Worker、RunPod Serverlessの責任を分離し、秘密情報とGPU処理をブラウザへ置かない。この構成はproduction公開環境へ反映済みである。

Zoovoiceは同じWorkerへ載せる別機能であり、音声認識から合成までをGoogle Cloud Run上のGo APIへ委譲する。production公開は `ZOOVOICE_ENABLED` のflagで制御し、有効化条件は [Zoovoice](#zoovoice) に定める。

## 正式route

| route | 用途 | Cloudflareでの公開範囲 |
| --- | --- | --- |
| `/` | Voice Labポータル | 公開 |
| `/speakloop` | SpeakLoop | 公開 |
| `/zoovoice` | Zoovoice | `ZOOVOICE_ENABLED=1` の配備だけ公開 |
| `/admin` | 総合管理 | 管理者認証が必須 |
| `/speakloop/admin` | SpeakLoop管理 | 管理者認証が必須 |

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
- 整列後はVADスナップをかける。各認識単位と各発話島の重なり時間を測り、重なりが最大の1つの島だけへその認識単位を割り当てる。
- スナップの対象は、島ごとに割り当てた認識単位の先頭の開始時刻と末尾の終了時刻だけとする。島端との差が±0.35秒以内の場合だけ、その時刻を島端へ差し替える。
- VADスナップはフレーズ境界を入力に取らない。余白を足す前の選択区間が変わるのは、そのフレーズの先頭単位の開始時刻または末尾単位の終了時刻が差し替わった場合だけである。
- 余白を含む再生区間は、直前の認識単位の終了時刻または直後の認識単位の開始時刻が差し替わった場合も、後述のクランプを通して変わり得る。
- スナップで変えるのは `words` の時刻だけとする。認識単位の順序とLLMへ渡す位置番号は変更しない。
- `fa-zh` は中国語比較ASRだけに使う。`fa-zh` が返すtoken数とtimestamp行数のどちらかがASR認識単位数と一致しない場合は、誤った位置対応を返さずjobを失敗させる。余分なtokenを切り捨てて対応付けることはしない。
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
- 再生余白は選択範囲の前後へ足し、音声全体の長さでクランプする。開始側は直前の認識単位の終了時刻より前へ広げず、終了側は直後の認識単位の開始時刻より後へ広げない。
- 隣接する認識単位の時刻が選択範囲と重なる場合は、その側の余白を無効にして選択範囲の境界をそのまま使う。対象は、直前の終了時刻が選択開始以上の場合と、直後の開始時刻が選択終了以下の場合である。
- この計算はVADや無音検出を入力に取らない。余白が無音の方向だけへ広がることと、隣の発話島へ食い込まないことは保証しない。
- ブラウザは切り出し再生の両端へ30msのfadeを適用する。
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
- 外部AIプロバイダの利用枠超過は例外として原因カテゴリだけを利用者へ伝える。固定文言「現在サーバー側のAI利用枠を超えているため処理できません。時間をおいてもう一度お試しください。」をHTTP 503で返す。運営側の契約状況や残高といった課金の内情は表示しない。
- 利用者自身のプリペイドクレジットが足りない場合は、チャージが要ることだけを伝える。固定文言「クレジットが不足しています。チャージしてからもう一度お試しください。」をHTTP 402で返し、機械判定用に `code: "credit_insufficient"` を添える。残高の数値、消費予定額、台帳の状態は返さない。

## Zoovoice

Zoovoiceは、録音した発話の内容から動物を自動で選び、その鳴き声を言葉の切れ目へ差し込む機能である。挿入したぶん出力音声は長くなる。SpeakLoopとはUIとAPIを分け、GoogleログインとSpeakLoop用quotaの対象にしない。データ境界は [公開デモのデータ取扱い境界](../deployment/PRIVACY.md) を正とする。

Zoovoiceは通常公開とする。公開UIへβ版バッジは表示しない。連想精度と音源の拡充は今後も継続する。

この節の自動連想と1画面UIはリポジトリの現在のコードに実装済みである。既存構成のCloud Runとproduction Workerへのdeployは完了しており、公開環境でZoovoiceのrouteは有効である。

### 用語

- 動物連想とは、ASR本文をLLMへ渡し、音源のある動物を指定数だけ必ず選ばせる処理を指す。
- 音源カタログとは、動物の種ID・日本語ラベル・鳴き声ファイル・出典の対応を持つmanifestを指す。
- 連想の理由とは、その動物を選んだ理由としてLLMが返す日本語の短文を指す。
- アニマル度とは、入力音声1秒あたりの文中挿入密度を0〜100で調整する設定を指す。
- 動物の種類数とは、連想する動物を1種にするか2種にするかの設定を指す。通常UIで利用者が変えられる設定は、アニマル度と動物の種類数の2つだけとする。
- 公開UIはアニマル度を5段階で選ばせる。Go APIは受け取った0〜100を入力音声長へ掛け、固定本数表へ丸めない。

### 音源カタログ

- 音源の取得方針、ライセンス方針、正規化仕様は本仕様の [音源の取得・ライセンス方針](#音源の取得ライセンス方針) 以降の節を正本とする。
- 次の項目は音源manifestを唯一の正本とする。

  - 自動連想が選べる動物の種ID
  - 動物の日本語ラベル
  - 動物と鳴き声ファイルの対応
  - 素材ごとの出所・ライセンス・採用hash

- 連想に使う語彙表（レキシコン）は持たない。動物を選ぶ知識はLLM側にあり、サービスは候補の一覧だけを渡す。
- manifestの実体は `ZOOVOICE_SOUNDS_DIR` が指すディレクトリの `manifest.json` とする（image内では `/app/sounds/manifest.json`）。素材はリポジトリへ置かない。同じ内容を実装コードやdocsへ手書きしない。
- Go APIは起動時に、manifestの全ファイルについて実在とSHA-256の一致を確認する。1件でも欠けるか一致しない配備では起動しない。
- 音源を1本も持たない動物はカタログへ載せない。載っていない動物は連想の候補にもならない。
- 対象種の追加は音源の追加とmanifestの更新で行う。

### 音源の取得・ライセンス方針

- 鳴き声は生成音声ではなく、実録音の音声ファイルを無償で取得する。同じ動物に実録音と生成音の両方があるときは必ず実録音を採る。
- 対象動物の正本は実際の音声ファイル（セットの `manifest.json`）である。[services/zoovoice/ANIMALS.md](../../services/zoovoice/ANIMALS.md) はそこから作り直す写しであり、手で書き換えない。
- 動物名と実音声ファイルの対応リスト（鳴き声リスト）を正とし、実装はそこから参照する。
- ライセンスの第一候補はCC0またはパブリックドメインとする。第二候補はCC BYとし、採用した場合は帰属表示を必ず行う。NC・SA・NDを含むライセンスは採用しない。
- 素材ごとの出所と採用hashは、鳴き声セットの `manifest.json` に記録する。
- 素材そのものはリポジトリへ置かず、実行時は `ZOOVOICE_SOUNDS_DIR`、container image ではbuild時に取り込む。

### 音源の正規化・トリム加工仕様

- 正規化は24kHz、モノラル、16bitとする。1本あたり最長30秒とする。
- 取得素材には長い無音や複数の鳴き声区間が混在するため、次の手順で1本の代表区間へ切り出す。

  1. 無音判定: ピーク音量から-35dB以下が0.3秒以上続く区間を無音とみなす。
  2. 区間検出: 無音以外を鳴き声候補とし、間隔1秒未満の候補は1区間へ統合する。
  3. 採用: 統合区間が複数ある場合、平均音量（RMS）が最大の1区間だけを採用する。複数区間の切り貼り結合は、つなぎ目が不自然になるため行わない。
  4. 整形: 採用区間の前後へ0.2秒の余白を残し、両端へ1.5秒ずつフェードを掛ける。ぶつ切りを避けるための長いフェードであり、5秒の音声では中央約2秒が本来の音量で残る。区間が短い場合はフェードを区間長の3分の1へ縮める。
  5. 長さ: 採用区間は最長5秒とする。超える場合はRMS最大位置を中心に切り詰める。挿入用には鳴き声が短いほど扱いやすいためである。

- しきい値（-35dB・0.3秒・1秒・5秒・フェード1.5秒）は試聴結果に応じて調整してよい。適用値はmanifestへ記録する。
- 挿入処理の側で改めてフェードを掛ける方式（挿入時にフェードイン1.5秒・フェードアウト1.5秒）も選べる。採用するかは挿入処理の設計時に決める。
- CC BY素材は帰属表示へ「無音除去・トリムを実施」と改変の旨を明記する。CC BY 4.0の改変時条件による。

### 音源の集め方

素材は Wikimedia Commons と Openverse から集める。どちらもAPIキーが要らない。集めた候補から商用利用できるライセンスのものだけを残し、1本ずつ聴いて声の主を確かめてから採用する。道具は `scripts/fetch_animal_recordings.py`・`scripts/prepare_animal_recording.py`・`scripts/build_real_recordings.py` に置いてある。

どの候補を採るか、どこを切り出すかという判断はコードへ書かない。理由をつけてリポジトリ外の選定ファイルへ残す。効果音として作られた「モンスターの唸り」の類が動物名で配布されていることがあり、ファイル名だけでは選べないためである。

生成音声は使わない。試しに生成して実録音と聴き比べたところ、よく知られた種はある程度使えたが、セミのようにメジャーでない種は実際と懸け離れた音になった。現在のセットはすべて実録音である。

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
- `GET /api/zoovoice/animals` はGo APIの `/animals` を中継して返す。実際に合成で使う音源カタログと必ず同じ内容になる。ビルド時に作った静的JSONは持たない。
- 応答は種IDと日本語ラベルと音源本数だけを載せ、音源のファイル名は載せない。
- 自動連想が選べる動物は、この一覧にある音源付きの動物に限る。
- `POST /api/zoovoice/compose` は録音と2つの設定を受け取る。設定契約は `{intensity, animal_count}` とし、どの動物を選ぶかと挿入位置はGo APIが決める。`animal_count` を省いた要求は1種として扱う。
- 文中の目標挿入数は `round(入力音声長 × 0.5 × intensity / 100)` とする。intensity=100は入力2秒あたり文中1本、既定50は入力4秒あたり文中1本に相当する。末尾へ必ず入れる1本はこの密度計算に含めない。
- Workerは、この密度契約が生む上限（入力上限60秒・アニマル度100で文中30本と末尾1本）を超える挿入数の応答を受け取らない。
- Workerは合成前にTurnstile検証と利用上限の判定をする。
- ASR、動物連想、合成はGoogle Cloud Run上のGo APIが担当する。Workerはprivate Cloud Runへ認証付きで中継し、ブラウザからGo APIへ直接送る経路は持たない。

### 日本語ASR

- ASRはサーバー側で行う。ブラウザの音声認識APIとクラウドASR APIは使わない。
- Go APIはwhisper.cppの `whisper-cli` とsmallモデルを日本語固定で呼ぶ。
- ASRへ渡す音声は16kHz、mono、16-bit PCMへ変換する。合成に使う音声とは別に用意する。
- 認識結果が空の場合は動物を選ばず、発話を認識できなかったことを示すエラーを返す。

### 合成後の音量

- 合成した音声はEBU R128で測り、モノラル向けの `-19 LUFS` を上限とする。これより静かな音声は持ち上げない。
- true peakが `-1.5 dBTP` を超える場合はピーク安全性を優先し、`-19 LUFS` より静かにする。
- 調整は完成音声の全体へ掛ける静的gainだけで行う。limiterは使わない。
- 末尾へ必ず挿入する鳴き声を含め、完成音声の全体へ同じ調整を掛ける。人間の発話と鳴き声の聞こえの大きさはこの段でそろう。

### 動物の自動連想

- 連想はLLM（既定 `gpt-5.6-luna`）へ一本化する。辞書・語彙表・意味ベクトルによる連想経路と、当てずっぽうのrandom選択は持たない。判断の根拠は [ZOOVOICE_ASSOCIATION_CASE_STUDY.md](ZOOVOICE_ASSOCIATION_CASE_STUDY.md) を参照。
- Go APIはASR本文と音源カタログの候補一覧（種IDと日本語ラベル）をLLMへ渡す。
- プロンプトは「どんなこじつけでもよいので候補から必ず指定数だけ選ぶ」方式とする。「選べない」という回答は許さない。Zoovoiceは遊びの製品であり、手がかりの薄い発話にも動物を返すことを優先する。
- LLMは選んだ種IDと、選んだ理由の日本語短文を返す。
- 候補一覧に無い種IDが返った場合はエラーとする。別の動物へ黙って読み替えない。
- 動物の種類数は利用者が1種か2種かを選ぶ。既定は1種とする。APIでは `settings.animal_count` で受け取る。
- 1種のときはすべての挿入位置へ同じ動物を配置する。2種のときは挿入位置へ交互に配置し、末尾は1件目の動物とする。
- 同じ動物が重ねて返った場合は1件へまとめる。結果が1種になってもエラーにしない。
- 鳴き声は無音区間ではなく、ASR本文を形態素解析して得た単語の切れ目へ差し込む。先頭へは差し込まない。末尾はアニマル度に関わらず必ず1つ差し込む。
- 合成応答のmetadataはASR本文と選ばれた動物、連想の理由を返す。あわせて素材のクレジットと挿入位置、入出力の長さも返す。
- UIは連想の理由と、使った鳴き声素材のクレジットを利用者へ表示する。CC BY素材の帰属表示が利用条件であるためである。
- ASRモデル、必要な外部command、LLMのAPIキーのいずれかが欠けた場合は起動しない。LLMの呼び出しに失敗した合成はエラーを返し、固定の動物へ黙って切り替えない。
- ASR本文と連想の理由は応答とサーバーのメモリ内だけで扱い、ログや保存先へ残さない。
- 発話内容は連想のため外部のLLM APIへ渡る。この点はプライバシー説明へ明記する。

### ローカル確認

ローカル確認の正本はWranglerで動かすWorkerとする。ブラウザでの手動確認とPlaywrightのe2e確認は、どちらもWrangler localを起動する。Go APIは起動時にwhisper.cppのcommandとASRモデルの実在、およびLLMのAPIキーの設定を確認し、欠けた場合は起動しない。commandとモデルはリポジトリ外へ置き、環境変数でpathを渡す。

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

local origin modeの通し確認はPlaywrightのe2eで行う。対象は録音から日本語ASR、動物の自動連想、合成を経て再生とダウンロードまでとする。この確認はTurnstileのtest keyを使い、実モデルを持つlocalのGo APIへ接続する。

ZoovoiceのFastAPI routeとproxyは廃止対象であり、ローカル確認の根拠に使わない。SpeakLoopのFastAPI版は従来どおり維持する。

### productionの扱い

- productionの有効化varsは `wrangler.toml` を正とする。
- production Workerの認証は、専用invoker service accountのkeyによるID token取得方式とする。詳細は [CLOUDFLARE.md](../deployment/CLOUDFLARE.md) を正とする。
- production向け設定（`ZOOVOICE_ORIGIN_MODE="cloud-run"`）のWorkerは、ローカル確認用flagの配備とloopbackからのrequestを拒否する。ローカル確認用のcredentialをproduction hostnameで使わない。条件が揃わない場合はCloud Runを呼ばずfail closedにする。
- 配備scriptはdry-run、local-only verification、明示applyの3modeを持つ。remote writeを行うのは明示applyだけとする。配備契約は [services/zoovoice/README.md](../../services/zoovoice/README.md) を正とする。
- Cloud RunのCPU 2とメモリ2GiBは現在の設定値である。測定条件と実測値は [services/zoovoice/README.md](../../services/zoovoice/README.md) を正とする。
- 何をどこまで実地確認したかは [services/zoovoice/README.md](../../services/zoovoice/README.md) の「外部操作の状況」を正とする。この文書には個々のdeployの状況を書かない。

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
| Zoovoice動物一覧 | 担当しない | Go APIの `/animals` を認証付きで中継 | — | 音源manifestから一覧を返す |
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
- D1は48時間を超えた日次quotaと90日を超えた監査ログを日次削除し、利用者向けには実際の最大保持期間である3日未満、91日未満と案内する。署名cookieは30日、native session token（iOSアプリのログイン。[CLOUDFLARE.md](../deployment/CLOUDFLARE.md) を正とする）は最大1時間、短期job snapshotは1時間、累計quotaは公開デモの運用中に保持する。
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
