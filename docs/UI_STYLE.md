# 公開UIスタイル方針

更新日: 2026-08-04

## 対象と基準

この文書は、Voice Labの公開ポータルとSpeakLoop、Zoovoice、管理2画面に適用する。

- `/` のVoice Labポータルを視覚基準にする。
- 暖かいニュートラル背景、控えめな影、明快な見出しを維持する。少数のアクセント色と十分な余白も維持する。
- SpeakLoopは青、Zoovoiceはamberを製品accentにする。共通の管理操作とfocusは青を使う。
- 録音ボタンは待機中から赤系で識別し、録音中はより強い赤、波形、`REC`表示を組み合わせる。エラーと削除は録音色より暗い赤と明示的な文言で区別する。
- SaaSダッシュボード風のカード乱用や、機能と関係のない装飾を避ける。
- React公開UIは、route単位でTailwind CSS v4とshadcn/uiへ段階移行する。移行済みrouteでは旧`styles.css`を同時に読み込まず、1画面内に2つのスタイル方式を混在させない。

## CSS/UI基盤

- 新規または移行済みのReact routeでは、Tailwind CSS v4をCSS生成基盤、shadcn/uiのrepo所有コンポーネントをUI部品の起点とする。
- shadcn/uiは完成テーマをそのまま適用するためではなく、アクセシブルな構造とvariantをrepo内で管理するために使う。本書のVoice Lab方針へ合わせる対象は配色、余白、角丸、影である。
- 公開ポータル`/`は専用の軽量Tailwind entryを使う。SpeakLoopと管理画面は共通のTailwind buildを使う。あわせて既存controller selectorを保つcompatibility layerも使う。
- faviconは、Voice Lab共通の青い吹き出しと音声波形の二色マークを全routeで使う。16pxでも識別できる太い形を維持し、製品ごとの別faviconを増やさない。
- 移行済みrouteのHTMLは`/static/styles.css`を直接読まない。旧selectorが必要な間はVite build内のcompatibility layerとして取り込み、適用順と削除境界を一箇所で管理する。
- 共通部品へ昇格するのは、利用routeが同じスタイル基盤へ移行してからとする。移行前にTailwind依存の見える部品を旧routeへ持ち込まない。
- routeを移行する際は、先に対象状態とレスポンシブ契約を固定し、HTMLから旧stylesheetを外し、production buildで他routeへCSSが流入していないことを確認する。

## 視覚階層

優先順位は次の通りとする。

1. ページタイトルと主要操作
2. 現在の作業カード（録音・台本・参照音声・生成・結果）
3. 説明、サンプル、状態
4. 注意、補足、診断

- 説明、注意、ツールバーまで同じカード表現にしない。
- 説明は短いaccent、注意は小さい補足にする。主要作業だけにpaper、border、shadowを使う。
- 外部音声処理に関する共通注意文は、音声を送信する画面で同じフッター部品を使う。短い初期画面ではビューポート下部の左端へ置き、コンテンツが伸びた場合は主要コンテンツ末尾へ続ける。introやサンプル領域へ混在させない。
- 各画面または作業領域のprimary actionは原則1つにする。
- 文字を極端に縮めて詰めず、二重枠、重複padding、hidden要素用の空領域を先に減らす。
- コンテンツよりUIクロームや装飾が強くならないようにする。

## トークンと共通部品

旧`styles.css`を使うrouteでは、現在のsemantic tokenを正とする。

- `--react-ink`
- `--react-muted`
- `--react-accent`
- `--react-accent-hover`
- `--react-accent-soft`
- `--react-border`
- `--react-focus`
- `--react-paper`
- `--react-shadow`

共通化の起点は [apps/web/src/shared/components.tsx](../apps/web/src/shared/components.tsx) と [styles.css](../src/mo_speech/web/styles.css) とする。

- 再利用する共通部品: `ProductHeader`・`ThemeSettings`・intro・`SampleAudio`・work／flow／generate／result card・record control・notice／status・voice slot。
- 同じ役割のボタン、入力、選択、アイコンは表現を揃える。揃える対象は高さ・幅ポリシー・文字・余白・focus・disabled・loadingである。
- 呼び出し側の局所上書きで同じ部品の見た目を分岐させず、必要なら中央のvariantまたは共通部品を追加する。
- アイコンは同一のoutline styleを使う。styleの内訳は `fill: none`、`stroke: currentColor`、round linecap／joinである。文字記号や黒い塗り潰しアイコンを代用しない。
- hoverだけに意味を持たせず、`:focus-visible`、disabled、processingでも操作対象と状態を判別できるようにする。

Tailwindへ移行済みのrouteでは、shadcn/ui互換のsemantic tokenと`apps/web/src/components/ui/`の部品を正とする。生の色や任意値を画面ごとに増やさず、まずtokenまたは中央のvariantへ意味を付ける。

### 管理画面の共通契約

- headerに `Voice Lab 管理` と、総合管理・SpeakLoop・公開画面への短いnavigationを置く。
- 保存・削除など通信を伴うボタンは、`保存中…` / `削除中…`、成功、失敗の状態をボタン自身と近接した `role="status"` の両方へ表示する。処理中は二重送信を防ぎ、成功表示は一定時間後に通常ラベルへ戻してよい。
- 複数カードをまとめて保存する領域では、状態表示をカード群の下だけに置かず、保存ボタンと同じヘッダー内にも配置する。
- `/admin` は実行設定と結果をPCで2列にし、結果を確認しながら左側の設定を変更できるようにする。スマホでは1列へ戻す。
- `/speakloop/admin` は公開制限・サンプル設定、録音履歴・お手本履歴をそれぞれ同格の2列にし、狭い幅では1列にする。
- 公開制限・サンプル・運用設定は既定で短いsummaryにまとめ、主要な変換、履歴、生成を先に使えるようにする。DOMは折りたたみ内にも常駐させる。
- 既定値で実行できる高度な生成・VC設定は必要時に展開する。閉じた状態でも主要CTAを表示し、開いた状態でもsticky要素で設定controlを覆わない。
- 管理画面は情報量が多いため、カードを増やすのではなく、section見出し・divider・grid・sticky結果領域で階層を作る。
- controllerが初期化時に参照するDOMはunmountしない。折りたたみや表示切替を導入する場合も、既存IDとdata属性を常駐させる。

## 画面固有の契約

### Voice Labポータル

- 上部はブランドと配色設定だけの短いheaderとし、設定を常に右上へ置く。
- intro-copyの見出しと説明は維持し、その直後に `01 SpeakLoop` と `02 Zoovoice` を同格の製品行として番号順に表示する。
- 各製品行は製品行の領域全体を対応routeへのlinkとする。2製品を囲む外側カード全体はlinkにしない。
- Zoovoiceの製品行は、公開configの `enabled` が `true` のときだけ表示する。
- `1440x900` と `1024x768` の初期状態では、2製品の説明とactionまでを1viewport内に収める。
- `390x844` では縦スクロールを許容し、スクロール後に両製品へ到達できるようにする。
- どの幅でも横overflow、固定高による切れ、操作不能を起こさない。
- モバイルでは見出しを読める大きさのまま段階的に縮め、カードの装飾余白と二重paddingを先に減らす。

### SpeakLoop

- 現在は日本語話者向けとし、公開UIの学習言語は `🇺🇸 English`、`🇨🇳 中文` の順で2つだけを表示する。初回の既定値と、旧保存値や未対応値のfallbackは `en-US` とする。現在対応中の保存値はそのまま復元する。
- コンパクトな録音ボタンのマイクは、ボタン内に収まるoutline SVGで表示する。大きい録音ボタン向けの疑似要素を縮小流用して円外や操作文言へはみ出させない。
- prompt未生成時は録音Stepを横長1枚で表示する。
- prompt表示後だけ録音Stepと復唱Stepを2列へ切り替える。
- 録音操作と短い行動ラベルを近接させる。
- ステップ1の録音は常に新しいお手本生成、ステップ2の録音は常に復唱評価とし、録音内容から操作意図を自動判定しない。
- 録音開始時は再生中の音声を止め、反対側の録音操作を無効にする。録音中だけ小さな取消ボタンを表示し、取消時は音声を送信せず破棄する。
- 復唱の評価後は比較音声を自動再生し、設定用チェックボックスは表示しない。比較再生とは別に `お手本だけ再生` を残し、速度調整も維持する。
- 比較モデルと前後余白は、ローカルFastAPI版だけで表示する。Cloudflare版では非表示とし、保存値に関係なくTerraと0.30秒を使う。
- ローカルFastAPI版だけ、折りたたみ式の `過去の結果で表示確認` を設定の下へ表示する。成功済みの復唱履歴を現在の結果UIへ復元し、表示時に外部APIや音声処理を呼び出さない。録音・音声処理中は表示操作を無効にし、保存結果の表示中は復唱録音を無効にする。
- 保存履歴のお手本音声は目標文の完全一致で対応付け、あいまい一致では選ばない。対応付けできた場合は通常と同じ比較再生を復元し、できない場合は比較再生を無効にして復唱音声だけを再生可能にする。
- 表示確認の操作列へ `比較区間` の `保存値`／`現行ロジックで再計算` を置く。既定は `保存値` とする。
- 再計算を選んだときは、使った余白と保存時の余白をstatusへ示す。再計算できない履歴では `保存値` へ戻し、理由をstatusへ示す。
- 中国語選択時だけ、学習言語の隣に `字形` の `简体`／`繁體` segmented controlを置く。既定は `简体` とし、選択はブラウザへ保存する。切替対象はお手本、聞こえた言葉、差分の正解語句までとし、APIや音声を再生成しない。
- 字形のsegmented controlは、選択背景が2項目間を約320msで滑らかに移動するアニメーションを持たせる。開始直後に移動し切るeasingを避ける。文字色だけで選択を示さず、`aria-pressed`、keyboard focus、`prefers-reduced-motion`を維持する。
- `自分の声` は録音前に選べる練習設定ツールバーへ置き、既定はオフとする。オンの場合はステップ1の録音を参照音声に使い、変換完了後の音声だけをお手本として自動再生する。処理中は録音操作を無効にし、job statusをprovider非依存で表示する。表示対象はGPUサーバーの準備待ち、音声処理の準備、変換、失敗である。
- `自分の声` の操作全体をhoverまたはkeyboard focusしたとき、「同じセッションで最初に録音した音声からAI生成音声を作る」と短く表示する。説明専用アイコンは置かない。外部サービスでの処理とVoice Labの履歴へ保存しないことは、画面下部の共通注意文へ1回だけ表示する。
- 「聞こえた言葉」の差分は単語・文字の脱落だけを `_` で示し、ASRが付けなかった句読点や記号は発音誤りとして表示しない。差分リンクは対応するフレーズ区間がある場合だけ操作可能にし、クリック時はそのフレーズの先頭からお手本と復唱を比較再生する。
- 非同期更新で録音対象、結果、本文、スクロール位置を不用意に動かさない。

### Zoovoice

この節は公開UIの契約とする。実装は現在のコードがこの契約へそろっている。実画面の確認結果は各変更の報告を正とし、本書を確認済みの根拠にはしない。

- 通常操作はorb型の録音操作・アニマル度スライダー・結果の再生／ダウンロードだけとする。調整可能な設定はアニマル度スライダーだけとする。
- 通常の生成ボタンと録り直しボタンは置かない。録音の停止を送信の起点とする。
- 手動停止または60秒の自動停止で確定した録音は、停止後すぐ1回だけ自動送信して生成する。1回の録音で自動送信するrequestは1回だけとする。
- 録音中だけorbの近くに取消ボタン（X）を表示する。取消した音声は送信しない。
- 500ms未満の録音は送信しない。短すぎたことを伝えて待機状態へ戻す。
- Turnstileのscriptとwidgetは、config取得後のページ表示時から読み込む。調整可能な設定ではなく、生成前に完了させる検証として扱う。
- 停止後にTurnstileが未完了の場合はtoken待ちを明示し、orbを無効にする。tokenはcomposeごとに検証し、成功・失敗の後は次のtokenへresetする。
- 追加送信は、retry可能な失敗の後に利用者が「もう一度生成」を押した場合だけとする。retry不能な失敗ではこのボタンを表示しない。
- アニマル度は録音開始時の値を初回生成に使う。retry可能なerrorの後の「もう一度生成」には現在の値を使う。
- 生成成功時は結果音声の自動再生を試みる。利用者は結果を再生・ダウンロードできる。
- 手動の動物選択、preset、feel lucky、冒頭・間・末尾の調整controlは公開UIへ出さない。
- 結果には選ばれた動物、根拠語、選択方式、ASRテキストを表示する。
- 根拠語がない場合は「該当なし」と示し、空欄にしない。
- 処理中・token待ち・取消直後・短すぎた録音・Turnstile失敗・エラー・ランダムfallbackの状態を明示する。ランダムfallbackでは根拠語がないことを短く示す。
- `1440x900` と `1024x768` は、初期状態と結果表示中の両方で主要領域を1viewport内に収める。対象は録音・アニマル度・Turnstile検証・結果の4領域とする。
- `390x844` は1列の縦スクロールを許容する。どの幅でも横方向のoverflowを起こさない。

## レスポンシブ契約

- `820px以下`: 1列にする。設定はヘッダー右上、authは必要時だけ次段に置く。
- `480px以下`: touch target、折り返し、録音ボタン、action群を個別に調整する。
- すべての対応幅で意図しない横スクロール、切れ、重なりを発生させない。
- ブレークポイントの直前直後でも情報の優先順位と操作順を維持する。

## 必須状態

SpeakLoop:

- idle
- recording
- prompt生成中／完了
- repeat録音
- 評価中
- 結果
- 保存済み結果
- error

Zoovoice:

- idle
- recording（取消ボタン表示中）
- 取消直後（送信しない）
- 500ms未満で送信しなかった直後
- token待ち（orb無効）
- 生成中
- 生成成功（自動再生）
- ランダムfallback
- retry可能なerror（「もう一度生成」表示）
- retry不能なerror

共通:

- auth表示／非表示
- sampleあり／なし
- 長い日本語入力
- 権限拒否
- quota超過
- Light／Dark／System
- theme menu、dialog、sticky要素の展開状態

- Light／Dark
- 長い日本語でも主要actionと説明が切れない状態

hidden要素のための空列を残さない。非同期表示の出入りで本文位置、主要CTA、選択、スクロール位置を不用意に動かさない。

## テーマと文言

- Light／Dark／Systemを同一DOMで支える。
- Darkでもcontrastを個別に確認する。確認対象は入力・select・status・focus・disabledである。
- ユーザー向け文言は日本語を正とする。製品名と短いsection labelは英語でもよい。
- 公開画面の主要ステータスとエラーは、利用者が待つ理由と次の行動だけをprovider非依存で示す。非同期jobのstatus内では、主要文言の直下に限り、技術詳細を小さく薄く表示してよい。技術詳細の内容はprovider名・モデル名・raw stage・生のエラー・待機・処理時間である。技術詳細は主要文言と同じ強さにせず、ブラウザconsoleとサーバーログにも残す。
- action labelは短い動詞にし、同じ操作へ複数の表現を使わない。

## Blocking defect

次が1つでもあれば、見えるUI変更を完了扱いにしない。

- 意図しない横overflow
- 操作や文言の重なり、切れ
- 同格コントロールの明白なサイズ、配置、baseline不一致
- 設定がヘッダー右上から外れる
- 主要CTAが初期導線から見失われる
- sticky要素が操作対象や本文を隠す
- モバイルの操作順が本書と異なる
- 非同期更新による不要なlayout shift
- Light／Darkの判読不能
- keyboard focusまたは主要なaccessibility pathの欠落
- 既存controllerが必要とするDOM契約の破壊

## 実画面検証

対象route:

- `/`
- `/speakloop`
- `/admin`
- `/speakloop/admin`
- `/zoovoice`（`ZOOVOICE_ENABLED=1` を渡したWrangler localで確認する）

Zoovoiceの確認にはFastAPIを使わない。Worker localのroute、config API、Turnstile test keyを通した画面で確認する。

基準幅:

- desktop: `1440px`
- intermediate: `1024px`
- mobile: `390px`

検証すること:

- LightとDark
- 初期状態、主要な動的状態、error、長文
- `scrollWidth <= clientWidth`
- 設定アイコンの右端位置
- 想定した列数とカード順
- sticky要素が内容を隠さないこと
- focus、hover、disabled、loadingの識別性

変更後は `npm run check:web` と `npm test` を実行する。ビルドやソース監査だけで完了とせず、利用可能な実ブラウザ・Playwright・DevTools系手段・ローカルChromeのheadless／CDP等で実際の画面を描画する。描画した画面のスクリーンショットを直接確認する。確認できなければ `VISUAL_QA_UNVERIFIED` として未確認状態を列挙する。

自動レイアウト検査の正は [UIテスト方針](UI_TESTING.md) とする。Playwrightはoverflow・viewport・focus・theme・主要actionの回帰を検査する。ただし美観の最終判断は実画像を直接確認して行う。
