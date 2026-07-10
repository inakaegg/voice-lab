# 公開UIスタイル方針

## 対象と基準

この文書は、公開ポータル、SpeakLoop、SkitVoiceの見えるUIに適用する。管理画面と旧互換画面は、React移行時に必要な範囲で本方針へ揃える。

- `/` のVoice Labポータルを視覚基準にする。
- 暖かいニュートラル背景、控えめな影、明快な見出し、少数のアクセント色、十分な余白を維持する。
- SpeakLoopとSkitVoiceは同じ製品群と分かる共通骨格を使い、SpeakLoopは青、SkitVoiceは暖色のaccentで識別する。
- SaaSダッシュボード風のカード乱用や、機能と関係のない装飾を避ける。
- Tailwind等のCSS方式は本書では決定しない。現行のCSS変数とReact共通部品を正とし、別方式を追加する場合は混在させず、移行方針を先に決める。

## 視覚階層

優先順位は次の通りとする。

1. ページタイトルと主要操作
2. 現在の作業カード（録音、台本、参照音声、生成、結果）
3. 説明、サンプル、状態
4. 注意、補足、診断

- 説明、注意、ツールバーまで同じカード表現にしない。
- 説明は短いaccent、注意は小さい補足、主要作業だけにpaper、border、shadowを使う。
- 各画面または作業領域のprimary actionは原則1つにする。
- 文字を極端に縮めて詰めず、二重枠、重複padding、hidden要素用の空領域を先に減らす。
- コンテンツよりUIクロームや装飾が強くならないようにする。

## トークンと共通部品

現在のsemantic tokenを正とする。

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

## 画面固有の契約

### SpeakLoop

- prompt未生成時は録音Stepを横長1枚で表示する。
- prompt表示後だけ録音Stepと復唱Stepを2列へ切り替える。
- 録音操作と短い行動ラベルを近接させる。
- 非同期更新で録音対象、結果、本文、スクロール位置を不用意に動かさない。

### SkitVoice

- 台本、生成、参照音声の優先順を保つ。
- 生成CTAを見失わせず、進捗、取消、エラーの表示で作業領域を不必要にずらさない。
- 参照音声slotの同格操作は同じサイズと配置にする。
- 言語選択肢は `🇯🇵 日本語` のように国旗を先頭へ置く。

## レスポンシブ契約

- `1120px以上`: SkitVoiceは台本、参照音声、生成の3列にする。
- `821〜1119px`: 台本と生成の2列にし、参照音声は下段にする。
- `820px以下`: 1列にし、SkitVoiceは台本、追従生成、参照音声の順にする。設定はヘッダー右上、authは必要時だけ次段に置く。
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

SkitVoice:

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

hidden要素のための空列を残さない。非同期表示の出入りで本文位置、主要CTA、選択、スクロール位置を不用意に動かさない。

## テーマと文言

- Light／Dark／Systemを同一DOMで支える。
- Darkでも入力、select、status、focus、disabledのcontrastを個別に確認する。
- ユーザー向け文言は日本語を正とする。製品名と短いsection labelは英語でもよい。
- 内部実装名、backend名、診断用専門語を通常画面へ露出しない。
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
