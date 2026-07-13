# UIテスト方針

## 目的

Voice Labのレイアウト回帰はPlaywrightで自動検査し、美観と情報階層は実際のスクリーンショットを人が直接確認する。DOM文字列検査、build成功、座標計測だけでUI完成とは判断しない。

## 自動検査の対象

主要route:

- `/`
- `/speakloop`
- `/skitvoice`
- `/admin`
- `/speakloop/admin`
- `/skitvoice/admin`

管理者専用の実験routeも、共通ブランド、横overflow、主要操作の到達性を検査する。

- `/fun`

基準viewport:

- desktop: `1440x900`
- intermediate: `1024x768`
- mobile: `390x844`

共通検査:

- `scrollWidth <= clientWidth`
- visibleな主要controlがviewport左右からはみ出さない
- h1と主要actionが表示され、keyboard focusできる
- 公開3画面のLight／Dark／Systemと設定menu
- ポータルの2導線が初期viewport内にある
- SpeakLoopのprompt表示前後の列構成
- SkitVoiceの台本・生成・参照音声の順とbreakpoint
- 管理画面のsection順、フォーム幅、長い履歴、empty／error

## 実行環境

通常のE2Eはfake providerのローカルFastAPIを新規portで起動する。既存serverを再利用せず、GPU、RunPod、OpenAI、OAuth、本番データへ依存させない。管理画面が読む設定、サンプル、履歴、runtime APIはPlaywright fixtureで固定する。

Cloudflareの管理password認証はWorker単体テストを正とし、通常CIへ本番passwordを持ち込まない。公開環境smokeは秘密情報を保護した手動workflowとして分ける。

## screenshotとbaseline

- 失敗時のscreenshot、trace、videoは`tmp/playwright/`へ保存し、CIでは失敗artifactとして短期間保持する。
- 再設計中はpixel baselineをコミットしない。レイアウトが安定してから、時刻、audio、進捗などの動的領域をmaskできる画面だけをvisual regression候補にする。
- UI変更時は自動検査とは別に基準画面を直接開き、blocking defectを修正して同条件で再確認する。

## コマンド

```bash
npm run test:e2e
```

合格画面を目視確認するための画像は、任意実行の次のコマンドで`tmp/playwright/visual-review/`へ保存する。pixel差分の合否判定には使わず、PC／スマホの情報階層と美観を直接確認する。

```bash
npm run test:e2e:visual
```

初回またはbrowser revision更新時は次を実行する。

```bash
npx playwright install chromium
```
