# 公開UIスタイル方針

更新日: 2026-07-17

## 対象と基準

この文書は、Voice Labの公開ポータル、SpeakLoop、SkitVoiceの非公開案内、管理3画面に適用する。管理者専用の`/fun`も、ブランドheader、基本token、overflow、focusの最低基準は本方針へ揃える。

- `/` のVoice Labポータルを視覚基準にする。
- 暖かいニュートラル背景、控えめな影、明快な見出し、少数のアクセント色、十分な余白を維持する。
- 公開ポータルとSpeakLoopは青を主accentにする。SkitVoiceのテラコッタaccentは管理者研究画面と直接URLの控えめな非公開案内に限る。共通の管理操作とfocusは青を使う。
- 録音ボタンは待機中から赤系で識別し、録音中はより強い赤、波形、`REC`表示を組み合わせる。エラーと削除は録音色より暗い赤と明示的な文言で区別する。
- SaaSダッシュボード風のカード乱用や、機能と関係のない装飾を避ける。
- React公開UIは、route単位でTailwind CSS v4とshadcn/uiへ段階移行する。移行済みrouteでは旧`styles.css`を同時に読み込まず、1画面内に2つのスタイル方式を混在させない。

## CSS/UI基盤

- 新規または移行済みのReact routeでは、Tailwind CSS v4をCSS生成基盤、shadcn/uiのrepo所有コンポーネントをUI部品の起点とする。
- shadcn/uiは完成テーマをそのまま適用するためではなく、アクセシブルな構造とvariantをrepo内で管理するために使う。配色、余白、角丸、影は本書のVoice Lab方針へ合わせる。
- 公開ポータル`/`は専用の軽量Tailwind entryを使う。SpeakLoop、SkitVoice、管理画面、実験画面は共通のTailwind buildと、既存controller selectorを保つcompatibility layerを使う。
- 移行済みrouteのHTMLは`/static/styles.css`を直接読まない。旧selectorが必要な間はVite build内のcompatibility layerとして取り込み、適用順と削除境界を一箇所で管理する。
- 共通部品へ昇格するのは、利用routeが同じスタイル基盤へ移行してからとする。移行前にTailwind依存の見える部品を旧routeへ持ち込まない。
- routeを移行する際は、先に対象状態とレスポンシブ契約を固定し、HTMLから旧stylesheetを外し、production buildで他routeへCSSが流入していないことを確認する。

## 視覚階層

優先順位は次の通りとする。

1. ページタイトルと主要操作
2. 現在の作業カード（録音、台本、参照音声、生成、結果）
3. 説明、サンプル、状態
4. 注意、補足、診断

- 説明、注意、ツールバーまで同じカード表現にしない。
- 説明は短いaccent、注意は小さい補足、主要作業だけにpaper、border、shadowを使う。
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

- `ProductHeader`、`ThemeSettings`、intro、`SampleAudio`、work／flow／generate／result card、record control、notice／status、voice slotを再利用する。
- 同じ役割のボタン、入力、選択、アイコンは、高さ、幅ポリシー、文字、余白、focus、disabled、loading表現を揃える。
- 呼び出し側の局所上書きで同じ部品の見た目を分岐させず、必要なら中央のvariantまたは共通部品を追加する。
- アイコンは同一のoutline style（`fill: none`、`stroke: currentColor`、round linecap／join）を使う。文字記号や黒い塗り潰しアイコンを代用しない。
- hoverだけに意味を持たせず、`:focus-visible`、disabled、processingでも操作対象と状態を判別できるようにする。

Tailwindへ移行済みのrouteでは、shadcn/ui互換のsemantic tokenと`apps/web/src/components/ui/`の部品を正とする。生の色や任意値を画面ごとに増やさず、まずtokenまたは中央のvariantへ意味を付ける。

### 管理画面の共通契約

- headerに `Voice Lab 管理` と、総合管理・SpeakLoop・SkitVoice・公開画面への短いnavigationを置く。
- 保存・削除など通信を伴うボタンは、`保存中…` / `削除中…`、成功、失敗の状態をボタン自身と近接した `role="status"` の両方へ表示する。処理中は二重送信を防ぎ、成功表示は一定時間後に通常ラベルへ戻してよい。
- 複数カードをまとめて保存する領域では、状態表示をカード群の下だけに置かず、保存ボタンと同じヘッダー内にも配置する。
- `/admin` は実行設定と結果をPCで2列にし、結果を確認しながら左側の設定を変更できるようにする。スマホでは1列へ戻す。
- `/speakloop/admin` は公開制限・サンプル設定、録音履歴・お手本履歴をそれぞれ同格の2列にし、狭い幅では1列にする。
- `/skitvoice/admin` は公開設定、日英中サンプル、台本、参照音声、詳細生成設定の順を明確にし、生成CTAを詳細設定の中で見失わせない。
- 公開制限・サンプル・運用設定は既定で短いsummaryにまとめ、主要な変換、履歴、生成を先に使えるようにする。DOMは折りたたみ内にも常駐させる。
- 既定値で実行できる高度な生成・VC設定は必要時に展開する。閉じた状態でも主要CTAを表示し、開いた状態でもsticky要素で設定controlを覆わない。
- 管理画面は情報量が多いため、カードを増やすのではなく、section見出し、divider、grid、sticky結果領域で階層を作る。
- controllerが初期化時に参照するDOMはunmountしない。折りたたみや表示切替を導入する場合も、既存IDとdata属性を常駐させる。

## 画面固有の契約

### Voice Labポータル

- 上部はブランドと配色設定だけの短いheaderとし、設定を常に右上へ置く。
- intro-copyの見出しと説明は維持し、その直後にSpeakLoopだけを主製品・主actionとして表示する。SkitVoiceを同格のカードや副製品として表示しない。
- `1440x900`、`1024x768`、`390x844`の初期状態では、原則としてSpeakLoopの価値とactionまでを1viewport内に収める。
- 文字拡大や長文で収まらない場合はスクロールを許容し、固定高による切れや操作不能を起こさない。
- モバイルでは見出しを読める大きさのまま段階的に縮め、カードの装飾余白と二重paddingを先に減らす。
- カード全体を曖昧なclick targetにせず、各製品の説明と明示的なlink actionをセマンティックに構成する。

### SpeakLoop

- 現在は日本語話者向けとし、公開UIの学習言語は `🇺🇸 English`、`🇨🇳 中文` の順で2つだけを表示する。初回の既定値と、旧保存値や未対応値のfallbackは `en-US` とする。現在対応中の保存値はそのまま復元する。
- コンパクトな録音ボタンのマイクは、ボタン内に収まるoutline SVGで表示する。大きい録音ボタン向けの疑似要素を縮小流用して円外や操作文言へはみ出させない。
- prompt未生成時は録音Stepを横長1枚で表示する。
- prompt表示後だけ録音Stepと復唱Stepを2列へ切り替える。
- 録音操作と短い行動ラベルを近接させる。
- ステップ1の録音は常に新しいお手本生成、ステップ2の録音は常に復唱評価とし、録音内容から操作意図を自動判定しない。
- 録音開始時は再生中の音声を止め、反対側の録音操作を無効にする。録音中だけ小さな取消ボタンを表示し、取消時は音声を送信せず破棄する。
- 復唱の評価後は比較音声を自動再生し、設定用チェックボックスは表示しない。比較再生とは別に `お手本だけ再生` を残し、速度調整も維持する。
- 中国語選択時だけ、学習言語の隣に `字形` の `简体`／`繁體` segmented controlを置く。既定は `简体` とし、選択はブラウザへ保存する。切替対象はお手本、聞こえた言葉、差分の正解語句までとし、APIや音声を再生成しない。
- 字形のsegmented controlは、選択背景が2項目間を約320msで滑らかに移動するアニメーションを持たせる。開始直後に移動し切るeasingを避け、文字色だけで選択を示さず、`aria-pressed`、keyboard focus、`prefers-reduced-motion`を維持する。
- `自分の声` は録音前に選べる練習設定ツールバーへ置き、既定はオフとする。オンの場合はステップ1の録音を参照音声に使い、変換完了後の音声だけをお手本として自動再生する。処理中は録音操作を無効にし、GPUサーバーの準備待ち、音声処理の準備、変換、失敗をprovider非依存のjob statusで表示する。
- `自分の声` の横に説明用のoutline iconを置き、hover、keyboard focus、click／tapで「同じセッションで最初に録音した音声からAI生成音声を作る」と短く表示する。トグルがオンの間だけ、外部の音声処理サービスで一時処理し、Voice Labの履歴には保存しないことをツールバー直下へ1文で表示する。長文をtooltipやcheckbox labelへ入れない。
- 「聞こえた言葉」の差分は単語・文字の脱落だけを `_` で示し、ASRが付けなかった句読点や記号は発音誤りとして表示しない。差分リンクは対応するフレーズ区間がある場合だけ操作可能にし、クリック時はそのフレーズの先頭からお手本と復唱を比較再生する。
- 非同期更新で録音対象、結果、本文、スクロール位置を不用意に動かさない。

### SkitVoice

- 公開 `/skitvoice` は研究機能が一般公開されていないことを短く伝え、`SpeakLoopで練習する` を唯一の主要actionにする。生成フォーム、sample、model、RunPod endpoint、login CTAを表示しない。匿名、通常Googleログイン、error状態で同じ非生成境界を維持する。
- 生成フォーム、参照音声、サンプル、進捗、診断は `/skitvoice/admin` とローカル研究画面だけに残す。
- SkitVoice管理画面のサンプル登録も英語、中国語、日本語の順でPCでは横並びにする。公開表示名を編集させず、ファイル選択後は音声プレビューと保存状態で確認できるようにし、ファイル名は表示しない。
- Voice Labの公開・管理画面で利用者が操作する音声は、サンプル、参照音声、生成結果、行ごとの中間音声、履歴を含め、ブラウザ既定のaudio controlsを露出せず、共通の再生／一時停止ボタン、シーク、経過時間／総時間表示を使う。キーボード操作と読み上げ用ラベルを維持し、実際のaudio要素は再生エンジンとして残す。
- 台本、生成、参照音声の優先順を保つ。
- 生成CTAを見失わせず、進捗、取消、エラーの表示で作業領域を不必要にずらさない。
- 参照音声slotの同格操作は同じサイズと配置にする。
- タブ音声録音はブラウザの機能検出を行い、非対応環境では操作と案内文中の選択肢を表示しない。APIが存在しても実行時に非対応と判明した場合はtoastで代替手段を案内し、そのセッション中は操作を隠す。権限キャンセルは非対応扱いにしない。
- 参照音声の保存成功、利用不可、権限拒否などの短い操作結果は、出力言語や生成設定の直下へ混在させず、画面を押し下げないtoastへ表示する。生成中の進捗、取消、長い失敗理由は生成カード内のstatusを維持する。
- 言語選択肢は `🇺🇸 English`、`🇨🇳 中文`、`🇯🇵 日本語` のように国旗と各言語の自称表記を使う。SkitVoiceの出力音声サンプル名は、別途定めた日本語UIの固定名を維持する。

## レスポンシブ契約

- `1120px以上`: SkitVoice管理画面は台本、参照音声、生成の3列にする。
- `821〜1119px`: SkitVoice管理画面は台本と生成の2列にし、参照音声は下段にする。
- `820px以下`: 1列にし、SkitVoice管理画面は台本、追従生成、参照音声の順にする。設定はヘッダー右上、authは必要時だけ次段に置く。
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
- error

SkitVoice管理画面:

- editing
- validating／uploading
- queued／running
- succeeded
- failed
- cancelling／cancelled

共通:

- auth表示／非表示
- sampleあり／なし
- 長い日本語入力
- 権限拒否
- quota超過
- Light／Dark／System
- theme menu、dialog、sticky要素の展開状態

公開 `/skitvoice`:

- 通常の直接URL
- 匿名／通常Googleログイン
- assetまたはsession取得error
- Light／Dark
- 長い日本語でも主要actionと説明が切れない状態

hidden要素のための空列を残さない。非同期表示の出入りで本文位置、主要CTA、選択、スクロール位置を不用意に動かさない。

## テーマと文言

- Light／Dark／Systemを同一DOMで支える。
- Darkでも入力、select、status、focus、disabledのcontrastを個別に確認する。
- ユーザー向け文言は日本語を正とする。製品名と短いsection labelは英語でもよい。
- 公開画面の主要ステータスとエラーは、利用者が待つ理由と次の行動だけをprovider非依存で示す。非同期jobのstatus内では、主要文言の直下に限り、provider名、モデル名、raw stage、生のエラー、待機・処理時間を小さく薄い技術詳細として表示してよい。技術詳細は主要文言と同じ強さにせず、ブラウザconsoleとサーバーログにも残す。
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
- `/skitvoice`
- `/admin`
- `/speakloop/admin`
- `/skitvoice/admin`

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

変更後は `npm run check:web` と `npm test` を実行する。ビルドやソース監査だけで完了せず、利用可能な実ブラウザ、Playwright、DevTools系手段、ローカルChromeのheadless／CDP等で実際の画面を描画し、スクリーンショットを直接確認する。確認できなければ `VISUAL_QA_UNVERIFIED` として未確認状態を列挙する。

自動レイアウト検査の正は [UIテスト方針](UI_TESTING.md) とする。Playwrightはoverflow、viewport、focus、theme、主要actionの回帰を検査するが、美観の最終判断は実画像を直接確認して行う。
