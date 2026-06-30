# 音声翻訳Webアプリ仕様

## 目的

音声入力を受け取り、別言語の音声として返すWebアプリを作る。最初はローカルで動く最小版を作り、動作確認後にRunPodまたは別GPUプラットフォームへ載せる。

将来のデモ価値として、単なる音声翻訳ではなく、母国語で言いたいことを日本語で言えるようになるまで練習するモードを追加する。詳細な実装順序は [LEARNING_ROADMAP.md](LEARNING_ROADMAP.md) を正とする。

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

- 画面はユーザー用、発音練習用、管理者用に分ける。
  - `/` はユーザー用の簡易画面とし、大きい録音ボタン、最小限の状態表示、トグルだけを表示する。
  - `/practice` は発音練習用の画面とし、学習対象言語を `ja-JP`、`zh-CN`、`en-US` から選び、母国語入力から模範音声生成、復唱録音、ASR判定までを1画面で行う。
  - `/admin` は従来の検証・管理画面とし、provider切り替え、履歴、VC比較、Seed-VC詳細設定、ユーザー画面設定を表示する。
  - 管理者用画面は別URLパスに置くが、同じbackend APIと音声履歴を使う。
- ユーザー用画面は、漢字が読めない外国人利用者を想定し、ひらがな中心の短い文言と視覚的な録音状態を使う。
- ユーザー用画面の見出しは、既定では `へんな へんかん アプリ` と `はなしてください` を表示し、利用者が特定言語で話す必要があるように見せない。
- ユーザー用画面の録音ボタンは、待機中、5秒未満の録音中、停止可能な録音中、変換中で見た目を変える。5秒未満のガードはテキストだけでなく、進捗リングや秒数表示で分かるようにする。
- ユーザー用画面の処理中表示は、マイクボタン直下の大きい状態表示に `しょりちゅう` を出し、その下にプログレスバーを置く。細かいstage名は出さない。`しょりちゅう.` から `しょりちゅう....` までの点アニメーションと、プログレスバー内の動きで停止して見えないようにする。点は固定幅の4スロットで表示し、すでに表示された点の位置が増減で動かないようにする。詳細stage名は管理者用画面に寄せる。Seed-VCが有効な場合、翻訳/TTSでベース音声ができた段階は全体完了ではないため100%にしない。ベース音声生成は70%前後まで、VC処理中は90%前後までを上限とし、最終出力音声が返った時だけ100%にする。
- ユーザー用画面の右上には表示変換トグルを置き、画面全体の文言を `🇯🇵 ひらがな`、`🇯🇵 ルビ`、`🇮🇩 Indonesia` の順に3段階で切り替える。出力テキスト欄は画面全体の表示モードとは別に、出力言語で自然な表示だけを出す。出力が日本語の場合は `ひらがな` と `ルビ` だけに対応し、ひらがな化はOpenAI Responses APIで作る。出力がインドネシア語の場合はインドネシア語テキストだけを表示し、別言語への表示用再翻訳はしない。出力テキスト欄は完了状態のすぐ下に表示し、再生ボタンや設定トグルより先に目に入る位置へ置く。日本語出力のルビ表示はモバイル幅を広げないよう、長文全体を1つの巨大な `<ruby>` にせず、折り返し可能な表示構造にする。
- ユーザー用画面の配色は管理者用画面からテーマとして選べる。初期テーマは青系を既定とし、追加で明るいポップ系、落ち着いたミント系を用意する。マイクボタンの赤は録音開始の主操作として維持し、処理中、トグル、プログレスバー、再生ボタンなどのアクセント色をテーマで切り替える。
- ユーザー用画面の設定トグルは、単なるスイッチ表示ではなく、アイコンまたは絵文字を上、短い文言を下に置くボタン型にする。OFFは軽く浮いたボタン、ONは押し込まれて凹んだボタンに見えるよう、影、内側の影、アイコン位置、背景色で状態差を出す。PCではhoverで軽く浮く視覚効果を付け、スマホでもタップ時に沈む反応が出るようにする。`ジョーク` は笑顔、`おおさかべん` は大阪城、`バリエーション` は特殊効果を連想できる表示にする。
- ユーザー用画面ではブラウザ標準のaudio controlsを主UIにせず、出力音声の再生/停止を専用トグルボタンで表示する。出力後にトグルが変更された場合、再生ボタンは作り直し操作として扱い、必要な段階だけ再処理して最新出力を置き換える。出力言語が変わった場合は録音から再翻訳し、大阪弁/バリエーションだけが変わった場合は翻訳済みテキストからテキスト加工とTTS以降だけを再実行する。ジョークだけが変わった場合は本文の翻訳/TTSを再生成せず、出力言語に応じてジョーク音声の生成または効果音挿入だけを行う。同じ録音内で既に作った組み合わせへ戻した場合は、翻訳結果、ベースTTS音声、Seed-VC音声、効果音挿入後音声を組み合わせごとにキャッシュして再利用し、不要な再生成を避ける。
- ユーザー用画面の音声翻訳は、翻訳方式を `OpenAI API` 固定、入力言語を `auto` とする。出力言語はユーザー画面専用の自動判定とし、ASR結果が日本語の場合は `id-ID`、日本語以外の場合は `ja-JP` へ翻訳する。
- 発音練習用画面ではSeed-VC、ジョーク、大阪弁、バリエーションを使わない。速度を優先し、OpenAI ASR、OpenAI翻訳、OpenAI TTSだけで模範音声を作る。母国語入力は `auto` ASR、復唱入力は選択された学習対象言語をASRへ渡す。初期判定は発音音響スコアではなく、ASRで聞き取れた文と目標文の正規化文字列類似度で行う。
- 発音練習用画面の録音UIは、トップページと同じ録音ボタン、録音中の波形/レベルメーター、処理中アニメーションを再利用する。独自の録音ボタンで視覚フィードバックを弱くしない。
- 発音練習用画面の固定文言は、ひらがなのみの日本語にはしない。ユーザーの母国語がまだ分からない初回ロード時は、日本語、中国語、英語を併記して「言いたいことを話す / 说出想说的话 / Say what you want」のように表示する。
- 発音練習用画面では模範音声の再生速度をYouTube相当の `0.25x` から `2.0x` までスライダーで選べる。速度変更は既に生成済みの音声をブラウザ再生速度で変えるだけで、TTS再生成はしない。選択した速度はブラウザ側に保存し、音声ロード後と再生直前に保存値を再適用する。
- 比較再生は、文単位の `句点` 分割と、カンマや読点も含める `句読点` 分割をUIで選べる。既定は `句読点` とし、中国語の短い節を比較しやすくする。復唱結果が出た後は、模範音声の再生ボタンを比較再生ボタンへ切り替え、同じボタンで停止できるようにする。
- 発音練習用画面は、高速に練習を回すため、PC/スマホともにできるだけ1画面内へ収める。言語選択、録音、模範文、再生速度、復唱、判定を過度な説明文や大きいカードで縦に伸ばさない。
- 発音練習用画面は、前回選んだ学習対象言語、中国語のピンイン表示ON/OFF、模範音声の再生速度をブラウザ側のlocalStorageなどへ保存し、次回ロード時の既定値にする。中国語のピンイン表示ON時は、可能な限り漢字ごとの `ruby` 表示として漢字の上に置く。
- 発音練習用画面では、母国語入力のASR結果も表示する。ユーザーが「自分が何と言ったと認識されたか」を確認できるようにする。
- 学習対象言語が `zh-CN` の場合、お手本には中国語本文に加えてピンインを表示できる。UIは中国語のお手本生成時にピンイン生成を要求し、既定ではピンインを表示する。
- ピンイン生成は有料APIへ依存しない。Python APIでは `pypinyin`、Cloudflare WorkerではJS側のローカルピンインライブラリを使い、OpenAI Responses APIをピンイン生成だけのために呼ばない。
- 復唱後の `recognized_text` は、母国語が分かっている場合は母国語1つのラベルで表示する。初回や不明時のみ多言語または汎用ラベルへ戻す。
- 復唱結果は、お手本文の直下に同程度の大きさで表示し、目標文との差分で不一致と判断した部分を赤字で目立たせる。差分箇所はクリック可能にする。復唱で抜け落ちた目標文側の語句は、認識結果内に存在しないため赤い欠落マーカーとして挿入表示する。比較再生では、複数文の場合に「1文目のお手本→1文目の復唱、2文目のお手本→2文目の復唱」の順で再生する。初期実装では精密なタイムスタンプ付き切り出しではなく、文の文字量から音声全体を概算分割する。将来はタイムスタンプ付きASRを使い、該当部分だけの比較再生へ発展させる。
- `自分の録音`、`もう一度`、`次へ` の専用小ボタンは置かない。自分の録音単体再生は初期UIでは提供せず、もう一度練習する場合は学習対象言語の録音ボタン、次の内容へ進む場合は母国語の録音ボタンを使う。
- 復唱用マイクは、お手本や判定が表示された後も画面上部の録音カード位置に置く。練習ループ中にマイクが下へ移動して、録音開始位置を探し直す状態を避ける。
- RunPod Serverless backendが利用可能な環境では、ユーザー用画面の音声翻訳は `runpod_serverless` を優先する。未設定または利用不可の場合は従来どおり `OpenAI API` を使う。RunPod利用時もブラウザへRunPod API keyを出さず、ローカルFastAPIまたは将来のgatewayがRunPod APIを呼び出す。
- ユーザー用画面では `にてるこえ` トグルを表示しない。Seed-VCが利用可能な場合は、翻訳/テキスト加工/TTSで作ったベース音声を既定でSeed-VCへ渡して声質変換する。Seed-VCの参照音声は入力音声自身、`seed_vc_reference_auto_select=true` 固定とする。runtime APIで直接VC backendの `seed-vc` が利用不可の場合は、本文音声の生成までは完了させる。
- RunPod Serverless backendのwarm状態は `/api/runtime` の `runpod_serverless` backend情報に含める。ユーザー用画面では、RunPod backendが選ばれている場合だけ画面右上付近に小さい状態ドットを出し、文字で `じゅんびまえ` などの操作を妨げる表示は出さない。ユーザー用画面のページロードでは既定で `POST /api/warmup` を実行しない。デモ前にwarmupしたい場合は管理者用画面 `/admin` の手動準備ボタンから `POST /api/warmup` を実行する。録音送信やSeed-VC実変換を行った場合もRunPod jobが作られるため、cold状態ならその時点でworker起動とモデルロードが入る。`/api/runtime` 自体は読み取り専用で、RunPod `/health` の `IDLE` や `READY` はworker存在の参考情報にとどめる。Seed-VC ready表示はwarmupまたはSeed-VC job成功によって短時間保存されたready状態だけを根拠にする。
- ユーザー用画面の `ジョーク` トグルがONの場合は、本文の出力言語に応じて追加音声の方式を切り替える。出力が `id-ID` の場合は、管理者用画面で指定したジョーク候補をインドネシア語音声として本文音声の前または後に付ける。管理者用画面では複数のジョーク文を1行1件で登録でき、ユーザー用画面では候補からランダムまたはローテーションで1件を選ぶ。ジョーク文のLLMバリエーション数を指定した場合は、管理者用設定の保存時に元ジョークごとに指定数の派生文を生成して保存し、ユーザーの変換リクエスト中にはLLMでジョーク文を増やさない。保存後と読み込み後の管理者用画面では、生成済みバリエーションと、実際にユーザー画面で選択対象になる候補プールを表示する。選ばれたジョーク文は `id-ID` に翻訳してからOpenAI TTSで音声化し、同じジョーク文のベースTTS音声はブラウザに保存して再利用する。ジョーク音声も同じ入力音声を参照にSeed-VCへ通してから再生キューへ入れる。VC済みジョーク音声は参照音声に依存するため、永続保存せず録音単位のメモリキャッシュだけで再利用する。ジョークは本文の出力テキストには表示せず、音声キューにだけ追加する。
- 出力が `id-ID` 以外の場合は、ジョーク文TTSではなく管理者用画面で登録した短い効果音ファイルをSeed-VC後の本文音声へ挿入する。Cloudflare Workerではffmpegを実行せず、選択された効果音ファイルと設定を `voice_conversion` jobへ渡す。RunPod handlerはSeed-VC後の音声に対してffmpegで無音区間を検出し、十分な無音があればその位置へ効果音を挿入する。無音区間が見つからない場合は末尾へ付加する。効果音自体はSeed-VCへ通さない。管理者用画面では効果音ファイル群、選択方式、挿入方式、最大挿入回数、最小無音長を設定できる。
- ユーザー用画面の `おおさかべん` と `バリエーション` はLLM加工を必要とし、初期実装ではOpenAI Responses APIを使う。これらは日本語出力を加工する機能なので、既定ではOFFかつ非表示にし、最新の処理結果が `target_language=ja-JP` の場合だけ表示して有効にする。表示後にON/OFFを変えた場合は、録音や翻訳をやり直さず、翻訳済み日本語テキストから加工とTTS以降だけを `つくりなおす`。将来はOpenAI互換APIとしてRunPod上のQwen/vLLMへ差し替えられるよう、モデル名は環境変数で変えられる構成にする。
- 録音中にページ再読み込みまたはページ離脱が起きそうな場合、ブラウザの離脱確認を出す。離脱が実行された場合は、録音停止イベントから翻訳ジョブを開始しないようにし、マイクストリームを閉じてローカル録音をキャンセル扱いにする。
- UIは、音声翻訳、テキスト読み上げ、VC比較を切り替えられる。
- 音声翻訳は、処理方式に応じて必要な入力だけを表示する。
  - `Qwen/local` と `OpenAI API` の3段方式では、入力言語、出力言語、声質変換、テキスト加工を表示する。
  - `OpenAI Realtime翻訳` では、入力言語を自動判定として扱い、出力言語だけを表示する。初期実装ではテキスト加工とSeed-VC後段変換は表示しない。
  - `OpenAI Realtime streaming` では、録音ファイルではなく選択したマイクをWebRTCでRealtime translationへ接続する。出力音声はremote audio trackとして受け取り、UI上で逐次再生する。
- Realtime streaming以外の音声翻訳、テキスト読み上げ、VC比較では、処理完了後に出力音声が生成されたらUIは即時自動再生を試みる。ブラウザの自動再生制限で再生できない場合も失敗扱いにはせず、ユーザーが出力音声プレイヤーから手動再生できる状態を維持する。
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
- OpenAI API、OpenAI Realtime、OpenAI Realtime streaming、OpenAI TTS APIで使う出力言語候補は、OpenAI TTS docsの対応言語リストに合わせて表示する。TTS docsはWhisperの対応言語に概ね従うとしているため、UIとOpenAI providerの許可リストは同じ言語集合にする。
- `Qwen/local` とGoogle Translate TTS endpointは、各providerで設定済みの対応言語だけを表示する。
- 変換結果のテキストは、次のテキスト読み上げ入力へ直接入れられる。
- 変換結果のテキストを読み上げ入力へ回す際、現在のTTS方式が対象言語を持っていなければ、利用可能な場合はOpenAI TTS APIへ切り替える。
- 変換結果の音声と履歴音声は、次の入力音声またはVC参照音声へ直接入れられる。
- 音声履歴欄には現在の保存先を表示する。
- RunPodでCloudflareを挟まない初期運用では、音声履歴は既存の保存機構をそのまま使い、`MO_AUDIO_HISTORY_DIR` をRunPod Network Volumeなど永続領域へ向ける。GCSなどのオブジェクトストレージ連携は、署名付きURLや削除処理を含むStorage Adapterとして別段階で追加する。

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

ユーザー用画面では、追加の加工IDとして `user_effects` を使う。`text_transform_options` はJSON文字列で渡し、以下を組み合わせられる。

- `osaka_dialect`: `true` の場合、出力文を自然な大阪弁へLLMで書き換える。
- `variation`: `true` の場合、数字、条件、対象などを少し変えた遊びのある表現へLLMで書き換える。

ジョークは本文のテキスト加工には混ぜず、本文音声とは別に `id-ID` の音声として生成し、ブラウザ側の再生キューで前後に並べる。ユーザーに表示する出力テキストは本文の翻訳結果または本文のLLM加工結果だけにし、ジョーク文は表示しない。

例:

- 翻訳文: `おはようございます。ありがとうございます。`
- 付加文字列: `モー`
- 文単位で付加した場合: `おはようございますモー。ありがとうございますモー。`

## API形状の草案

`POST /api/translate-speech`

リクエスト:

- `audio`: アップロードされた音声ファイル
- `translation_backend`: `openai`、`openai_realtime`、`openai_realtime_stream`、`qwen`、`runpod_serverless`
  - `openai`: OpenAI APIでASR、翻訳、TTSを3段に分けて行う。
  - `openai_realtime`: OpenAI Realtime translationで音声入力から翻訳音声を生成する。入力言語はAPI側の自動判定に任せる。
  - `openai_realtime_stream`: ブラウザWebRTCでOpenAI Realtime translationへ接続する。`POST /api/translate-speech-jobs` は使わず、ブラウザ側で直接Realtime translation callを確立する。
  - `qwen`: 既存のローカル/Qwen系pipelineを使う。fake modeではデモ応答を返す。
  - `runpod_serverless`: ローカルFastAPIまたはgatewayからRunPod Serverless endpointへ非同期jobを投げ、RunPod handlerのレスポンスを通常の `PipelineResult` と同じ形に戻す。endpoint IDとAPI keyが未設定の場合はruntime APIで無効表示にする。
- 音声翻訳のUI既定は `openai` とする。`OPENAI_API_KEY` が未設定の場合はUIで無効表示し、利用可能なbackendへフォールバックする。
- `source_language`: 例 `id-ID`
- `target_language`: 例 `ja-JP`。ユーザー用画面では `user-auto` を送り、ASR結果が日本語なら `id-ID`、日本語以外なら `ja-JP` として処理する。
- 管理者用画面のユーザー画面設定では、ユーザー用画面の出力言語を選ばせない。ユーザー用画面の録音翻訳は常に `user-auto` 固定で、管理者用設定はジョーク、表示テーマなどの体験設定だけを扱う。
- 管理者用画面のユーザー画面設定は `joke_texts`、`joke_position`、`joke_selection`、`joke_variation_count`、`effect_audios`、`effect_selection`、`effect_insert_mode`、`effect_max_insertions`、`effect_min_silence_ms`、`theme` を保存する。`effect_audios` は短い音声ファイルの配列で、各要素は `id`、`name`、`audio_mime_type`、`audio_base64` を持つ。効果音は本文出力が `id-ID` 以外で、ユーザーが `ジョーク` をONにしたときだけ使う。
- `voice_mode`: `default`、`clone`、`convert`
- `text_transform`: 任意の加工ID。例 `append_suffix`
- `text_transform_options`: 任意の加工設定。例 `{"suffix":"モー"}`
- multipart formでは、初期実装として `text_transform_suffix` と `text_transform_unit` を受け取る。
- `voice_mode=convert` でSeed-VCを使う場合は、`seed_vc_diffusion_steps`、`seed_vc_reference_max_seconds`、`seed_vc_reference_auto_select`、`seed_vc_length_adjust`、`seed_vc_inference_cfg_rate` を任意指定できる。
- `seed_vc_reference_auto_select=true` の場合は、Seed-VCへ渡す参照音声を `ffprobe` と `ffmpeg silencedetect` で軽量に選ぶ。発話候補を取れない場合は従来どおり先頭から `seed_vc_reference_max_seconds` 秒を使い、ノイズによって参照音声が空になる挙動にはしない。追加の選択時間は `timings_ms.reference_segment_select` で返す。
- UIでは、Seed-VC本体を実行する前に参照音声の正規化だけを実行できる。翻訳モードでは入力音声、VC単体では参照音声ファイルを対象にし、正規化前と正規化後の音声を並べて再生比較できる。
- `voice_mode=convert` では、処理状況UIがTTSと声質変換を別stageとして表示し、Seed-VC開始後は `声質変換` を実行中として表示する。

UIでは、実行内容を以下の構造にする。

- 音声翻訳: 入力言語、出力言語、翻訳方式、声質変換を表示する。
  - 翻訳方式は `OpenAI API`、`OpenAI Realtime翻訳`、`OpenAI Realtime streaming`、`Qwen/local` の順で選択できる。
  - `Qwen/local` と `OpenAI API` では、声質変換は `なし` または `Seed-VC` を選択できる。Seed-VC選択時はSeed-VC詳細設定を表示する。
  - `OpenAI Realtime翻訳` と `OpenAI Realtime streaming` では、入力言語は自動判定、声質変換は `なし` とする。
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
- streaming実装: ブラウザからWebRTCで直接Realtime translation sessionへ接続し、話している途中から翻訳音声を再生する。サーバーは標準APIキーをブラウザへ出さず、短命のclient secretだけを発行する。
- streaming出力: remote audio trackをブラウザ側で録音し、切断時にローカル音声履歴の `outputs` へ保存する。保存に失敗してもRealtime接続自体は失敗扱いにしない。
- 課金・依存リスク: Realtime translationは音声時間単位の有料APIで、料金や対応言語は変わるため運用前に公式の最新情報を確認する。

`POST /api/openai-realtime-translation-session`

リクエスト:

- `target_language`: 例 `id-ID`、`ja-JP`、`zh-CN`、`en-US`。

レスポンス:

- OpenAI Realtime translation client secret作成APIのレスポンスをそのまま返す。
- ブラウザは返却された短命client secretで `https://api.openai.com/v1/realtime/translations/calls` へSDP offerを送る。

`POST /api/audio-history/outputs`

リクエスト:

- `audio`: 保存する出力音声ファイル。
- `endpoint`: 保存元の識別子。例 `openai-realtime-streaming`。
- `translation_backend`: 任意。例 `openai_realtime_stream`。
- `target_language`: 任意。例 `ja-JP`。

レスポンス:

- `saved`: 保存できた場合は `true`。履歴保存が無効な場合は `false`。
- `entry`: 保存できた場合の履歴entry。

`POST /api/user-joke-output`

リクエスト:

- `text`: 管理者用画面で設定または生成済みのジョーク候補からユーザー画面が選んだ1件。
- `target_language`: 暫定仕様では `id-ID` 固定。
- `tts_backend`: 暫定仕様では `openai` 固定。

挙動:

- `text` をOpenAI翻訳で `id-ID` に変換してからOpenAI TTSで音声化する。
- ユーザー画面では、返された音声をブラウザに保存し、同じジョーク本文と出力言語の組み合わせでは再利用する。
- ジョーク候補のLLMバリエーション生成はこのAPIでは行わない。管理者用設定の保存時に生成済みの候補だけを受け取る。

`POST /api/practice/prompts`

リクエスト:

- `audio`: 利用者が母国語で話した音声ファイル。
- `target_language`: `ja-JP`、`zh-CN`、`en-US`。
- `include_pinyin`: `target_language=zh-CN` のとき、ピンイン表示を生成するかどうか。

レスポンス:

- `transcript`: 母国語入力のASR結果。
- `target_text`: 学習対象言語へ変換した目標文。
- `display_text`: 画面表示用テキスト。日本語ではひらがな表示を含められ、中国語では要求時に `pinyin_text` を含める。
  - `pinyin_status`: 中国語ピンイン表示の状態。`ready`、`disabled`、`unavailable` のいずれか。UIは `unavailable` を空欄として隠さず、生成できなかったことを表示する。
- `audio_mime_type` / `audio_base64`: 模範音声。
- `providers` / `timings_ms`: 利用したproviderと処理時間。

`POST /api/practice/attempts`

リクエスト:

- `audio`: 利用者が目標文を真似して話した音声ファイル。
- `target_text`: 模範文として出した目標文。
- `target_language`: `ja-JP`、`zh-CN`、`en-US`。

挙動:

- 復唱音声のASRでは入力言語を自動判定せず、`target_language` を明示して渡す。中国語練習中の復唱音声が他言語やローマ字として誤判定されることを避ける。
- `target_language=zh-CN` の比較では、ASRが一部の語を繁体字で返しても、一般的な繁体字/簡体字の字形差は同一扱いに正規化する。例: `怎么样` と `怎麼樣` は同じ発音練習結果として扱う。

レスポンス:

- `recognized_text`: 復唱音声のASR結果。
- `similarity`: 0.0から1.0の類似度。
- `grade`: `ok`、`almost`、`retry`。
- `grade_label`: 画面表示用の短い判定文。
- `diff`: 目標文とASR結果の比較表示用データ。UIで認識結果の不一致部分と抜け落ちた目標文側の語句を赤字表示できるよう、正規化後文字列の範囲情報を含める。
- `providers` / `timings_ms`: 利用したproviderと処理時間。

`GET /api/practice-history`

レスポンス:

- 発音練習用の `practice-prompts` と `practice-attempts` の履歴だけを返す。
- `/admin` が使う `GET /api/audio-history` では、発音練習用の履歴は除外する。
- 練習履歴を確認する管理画面は `/practice/admin` とし、通常の音声変換管理画面と混ぜない。

`POST /api/text-to-speech-jobs`

リクエスト:

- `text`: 読み上げるテキスト。UIでは直接入力、またはテキストファイルを読み込んで指定できる。
- `target_language`: 例 `id-ID`、`ja-JP`、`zh-CN`、`en-US`。OpenAI TTSでは `auto` を指定できる。
- `tts_backend`: `google_translate` または `openai`。

UIでの読み上げ言語の扱い:

- OpenAI TTS APIは読み上げテキストから発話言語を決めるため、既定は `auto` とする。API呼び出しでは言語パラメータを渡さない。
- Google Translate TTS endpointは `tl` パラメータが必要なため、読み上げ言語を明示指定する。
- テキストファイル指定時も、ブラウザで内容を読み込んでテキスト欄へ反映し、必要なら編集してから読み上げる。
- `/api/runtime` はプロバイダの有効/無効をUI制御に使う内部APIとして残すが、`mode fake` のような内部実行モードは通常UIには表示しない。
- `/api/runtime` の `runpod_serverless` backend情報には、endpoint設定の有無、内部で使う翻訳backend、RunPod `/health` から要約したworker存在状態、リクエスト方式を含める。health確認に失敗しても設定済みbackend自体はただちに無効扱いにせず、warm状態を不明として表示する。Seed-VCの `model_resident` は `/health` だけから推測せず、warmupまたはSeed-VC jobの成功結果から保存されたready状態を使う。

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
  - `seed_vc_reference_max_seconds`: 声質参照に使う上限秒数。自動選択OFF時は先頭からこの秒数を使う。
  - `seed_vc_reference_auto_select`: 声質参照の発話区間を軽量に自動選択する。選択不能時は先頭切り出しに戻す。
  - `seed_vc_length_adjust`: 出力長の補正倍率。
  - `seed_vc_inference_cfg_rate`: Seed-VCのCFG係数。
  - UIでは、高速確認、リーズナブル、品質優先、最高品質検証のプリセットを提供する。既定は品質優先。
- ユーザー用画面の効果音挿入で使う任意設定:
  - `audio_effect_enabled`: 効果音挿入を有効化する。
  - `audio_effect_audio`: 挿入する短い効果音ファイル。
  - `audio_effect_insert_mode`: `silence_or_tail` または `tail`。
  - `audio_effect_max_insertions`: 最大挿入回数。現行UIでは1から5。
  - `audio_effect_min_silence_ms`: 無音区間として扱う最小長。現行UIでは100から2000ms。

レスポンス:

`POST /api/seed-vc/reference-preview`

リクエスト:

- `reference_audio`: 正規化対象の参照音声ファイル
- `seed_vc_reference_max_seconds`: 声質参照に使う上限秒数。
- `seed_vc_reference_auto_select`: 声質参照の発話区間を軽量に自動選択する。

レスポンス:

- `audio_mime_type`: 正規化後音声のMIME type。現時点では `audio/wav`。
- `audio_base64`: 正規化後音声。
- `timings_ms.reference_audio_prepare`: 正規化全体の所要時間。
- `timings_ms.reference_segment_select`: 自動選択ON時の発話区間選択時間。

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

- 入力音声は `recordings` として直近100件を保存する。
- 出力音声は `outputs` として直近100件を保存する。
- 101件目以降は古い音声と対応するmetadataを削除する。
- 既定の保存先はgit管理外の `tmp/audio-history/` とする。
- リポジトリ直下から起動した場合、既定の実保存先は `<repo>/tmp/audio-history/` になる。プロセスの作業ディレクトリが変わると相対パスの解決先も変わるため、固定したい場合は `MO_AUDIO_HISTORY_DIR` に絶対パスを指定する。
- `recordings` の実保存先は `MO_AUDIO_HISTORY_DIR/recordings`、`outputs` の実保存先は `MO_AUDIO_HISTORY_DIR/outputs` とする。
- 保存先はローカル環境変数 `MO_AUDIO_HISTORY_DIR` で変更する。ブラウザUIからサーバー側の任意パスを書き換える機能は、誤操作とパス露出を避けるため初期実装には含めない。
- UIでは、直近の `recordings` と `outputs` を一覧し、保存済み音声を再生できる。
- `metadata.endpoint` が `practice-` で始まる発音練習用履歴は、通常の音声変換履歴から除外し、`/api/practice-history` と `/practice/admin` で分けて扱う。
- ブラウザ録音やアップロード由来の履歴音声は、保存前に可能な限り `24kHz / mono / PCM wav` へ正規化する。正規化できない場合はwebmなどの元形式では保存せず、処理本体を優先して履歴保存をスキップする。
- 正規化した履歴metadataには、元ファイル名、元content type、保存用audio mime typeを残す。
- 履歴一覧と再利用対象は保存済み音声ファイルだけとし、`.json` metadata、`.DS_Store`、その他の非音声ファイルは表示しない。
- UIでは、保存済み音声を次の入力音声またはVC参照音声へ再利用できる。
- UIでは、保存済み音声を履歴ごとに個別削除できる。削除時は音声ファイル本体と対応するmetadataを同時に削除する。
- 履歴音声を次の入力音声へ再利用した場合、同じ音声を新しい `recordings` として重複保存しない。新規録音または新規ファイルアップロードだけを入力履歴へ保存する。
- UIでは、保存済み音声の処理種別だけでなく、翻訳結果や読み上げテキストの短いプレビューを表示する。
- 翻訳出力やテキスト読み上げ出力の履歴では、実際にTTSへ渡したテキストを音声と紐づけて保存し、UIからテキスト読み上げ入力へ再利用できる。
- 履歴音声、録音音声、出力音声を入力またはVC参照に指定する場合、ブラウザの制約でファイルinput欄そのものには値を入れられないため、各ファイルinput直下に選択済みの種別、ファイル名、サイズを表示する。
- テストは実ユーザーの既定履歴 `tmp/audio-history/` を使わず、テストごとの一時保存先に隔離する。
- Realtime streamingの出力音声は、切断時に録音済みblobとして `outputs` へ保存する。
- サーバー運用ではFastAPIローカルファイル保存を永続保存先として使わない。必要な場合はオブジェクトストレージなどの外部保存先を使う。

## ローカルログ

- アプリのエラーは既定で `tmp/logs/mo-speech.log` に出力する。
- 保存先は `MO_LOG_DIR` で変更できる。
- OpenAI API、TTS、VC、翻訳jobの例外は、UIのエラーメッセージに加えてログへstack traceを残す。

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
