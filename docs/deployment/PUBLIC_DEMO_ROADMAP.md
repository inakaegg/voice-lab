# 公開デモ品質向上ロードマップ

## 目的

SpeakLoopとSkitVoiceを、第三者が短時間で価値と技術構成を理解し、実際に触って評価できる公開デモへ整える。

この文書では、採用や営業などの内部目的ではなく、公開プロダクトとして自然に必要になる改善だけを書く。公開上の狙いや見せ方の内部メモは `_ai/` に分ける。

## 進捗（2026-07-10）

- 完了: READMEの主役をSpeakLoop/SkitVoiceへ更新し、構成図、セットアップ、検証、制限、権利・プライバシー上の注意を掲載。
- 完了: push/PRでpytest、Node test、JavaScript構文検査、React build、Playwright 3 viewportレイアウトE2Eを行う通常CIを追加。GPU build/smokeは手動workflowのまま分離。
- 完了: SkitVoiceの参照音声を、ローカル版4方式（ファイル、マイク、タブ音声、URL）とCloudflare版3方式（URL以外）に整理。
- 完了: 公開UIへプライバシー注意と、私的利用を超えて公開・共有する場合の簡潔な利用条件確認を追加。操作ごとの確認ダイアログは要求しない。
- 完了: D1 database、`MO_SPEECH_DB` binding、全migration、R2 production/preview bucket、`MO_SPEECH_AUDIO_R2` bindingを作成・deploy。quota/auditはD1、公開サンプルmetadataはD1、音声blobはR2へ移行し、bindingなし環境のKV fallbackと旧KVデータ引き継ぎも維持。
- 完了: 公開ポータル、SpeakLoop、SkitVoiceの表示構造とレスポンシブレイアウトをVite + React + TypeScriptへ切替。Tailwind CSS v4とrepo所有のshadcn/ui部品を導入し、管理・互換画面も共通Tailwind buildへ統合。録音、IndexedDB、比較再生、job pollingは既存controllerをReact mount後に読み込む互換段階で、状態管理のhooks/reducer移行は後続。
- 完了: 公開URLでのOAuth/quota/RunPod実ブラウザE2E確認。
- 素材待ち: 英語・中国語・日本語の公開サンプル生成物登録。
- 完了: React画面はコンパクト作業台を採用。説明文を圧縮表示し、明色・暗色・システム設定、PC・中間幅・スマホの作業レイアウトをPlaywrightとスクリーンショットで調整した。公開用スクリーンショットの選定はサンプル登録後に行う。

## 現状の強み

- SpeakLoopは、母国語入力、学習対象言語への変換、模範音声、復唱、ASR比較、フレーズごとの比較再生までを1つの練習ループとして実装している。
- SkitVoiceは、台本、複数話者、参照音声、VibeVoice、ASR再配置、低スコア行再生成、Seed-VC後処理を組み合わせた音声生成ツールとして実装している。
- Cloudflare Workerを公開API gatewayにし、OpenAI APIとRunPod Serverlessを分けている。
- RunPod API keyやOpenAI API keyをブラウザへ出さず、Worker secretまたはRunPod側環境変数として扱う。
- Googleログイン、公開quota、管理者除外、管理画面設定、監査ログ方針がある。
- Pythonのpytest、Nodeの `node --test`、Cloudflare Worker test、RunPod handler testがあり、モデル非依存部分はローカルで検証できる。
- VibeVoiceの不安定さに対し、ASR timestamp、候補選別、再生成、診断JSONで品質を制御する構成を持つ。

## 現状の弱点

- READMEはSpeakLoopとSkitVoice中心へ刷新済み。実画面スクリーンショットはサンプル登録と最終コピー確認後に追加する。
- ユーザー向け画面は改善しているが、内部検証画面や過去の実験機能が同居しており、初見では主要導線が分かりにくい。
- 公開画面の構造はReact/TypeScriptへ移行したが、録音やjob pollingの状態処理は既存vanilla JavaScript controllerとの互換段階にある。
- 保存層は、quota・監査・公開サンプルmetadataをD1、音声blobをR2、軽量設定・ready状態・音声履歴indexをKVへ分離済み。
- RunPodやVibeVoiceは外部要因とGPU費用の影響を受けるため、公開デモではサンプル音声、入力制限、分かりやすい失敗表示が必要である。

## 優先度

### 1. READMEと公開導線を刷新する

READMEの冒頭は、内部実装名ではなく、Voice Labと現在の公開アプリであるSpeakLoop、SkitVoiceを主役にする。

- 何ができるかを短く説明する。
- `/speakloop`、`/skitvoice`、`/fun` の位置づけを明確にする。
- アーキテクチャ図を置く。
- Cloudflare Worker、OpenAI API、RunPod Serverless、KV、D1、R2の関係を説明する。
- 動作確認コマンドとデプロイ手順を、開発者が追える粒度でまとめる。
- 既知の制限を隠さず、VibeVoice品質、RunPod cold start、quota制御、URL参照音声の制約を説明する。

### 2. 保存層をKVだけに寄せない

公開デモではKVだけでも動くが、長期運用や履歴管理を考えると、保存先を役割ごとに分ける。

- D1: quota、監査ログ、公開サンプル音声metadata。
- R2: 録音、生成音声、公開サンプル音声などのblob。
- KV: 短期job、cache、軽量設定、ready状態などの低整合性でよい値。

Workers KVは厳密なatomic incrementを持たないため、公開quotaの過剰利用防止には使えるが、課金台帳や厳密な監査には使わない。厳密性が必要になった時点でD1またはDurable Objectsへ寄せる。

### 3. 公開ユーザー画面をReact/TypeScriptへ段階移行する

全画面を一度に移行しない。公開ユーザーが触る画面だけを先に対象にする。

- 対象: SpeakLoopユーザー画面、SkitVoiceユーザー画面、共通ポータル。
- 非対象: 既存の管理画面、内部検証画面、旧互換画面。
- 目的: 録音状態、ジョブpolling、比較再生、ログイン状態、入力制限表示を部品化し、UI状態の見通しを良くする。
- Worker/APIは既存互換を維持し、フロントだけ段階的に差し替える。

移行候補:

```text
apps/
  web/
    src/
      speakloop/
      skitvoice/
      shared/
cloudflare/
  worker.mjs
src/mo_speech/
  ...
```

Vite + React + TypeScriptを採用済み。CSS生成基盤はTailwind CSS v4、共通部品の起点はrepo所有のshadcn/ui構造とし、既存controllerが必要とするDOM契約は維持する。管理・互換画面はReact化せず、同じTailwind compatibility buildで見た目とresponsive contractを揃える。

### 4. CIを公開デモ向けに固定する

最低限、以下をGitHub Actionsで毎回確認する。

- `python -m pytest`
- `npm run test:worker`
- `node --check cloudflare/worker.mjs`
- 公開HTML/JSの構文チェック
- Dockerfile.runpodの静的検査
- React typecheck／production build
- PlaywrightのPC・中間幅・スマホlayout E2E

RunPod buildやGPU smokeは費用がかかるため、通常CIではなく手動workflowにする。RunPodへ進む前に、handler、payload、env、シリアライズ、進捗パース、エラー処理をローカルテストで確認する。

### 5. 公開デモの失敗しにくさを上げる

- 各ページに短いサンプル音声とサンプル入力を置く。
- 生成APIはGoogleログインとfeature別quotaで制御する。
- 管理者Google emailはquota対象外にする。
- 入力上限は外部APIやRunPodへ送る前に検証する。
- SkitVoiceは、VibeVoiceが失敗した時の診断JSONと分かりやすいエラーを返す。
- SkitVoice公開UIは、外部URL取得ではなくファイルアップロード、マイク録音、タブ音声録音、権利確認済みサンプル音声を主導線にする。
- タブ音声はユーザーがブラウザで共有対象を明示選択して録音する。URL、cookie、ログイン情報は取得しない。
- 私的利用を超えて生成物を公開・共有する利用者へ、音声の利用条件を確認するよう常設表示する。
- SpeakLoopとSkitVoiceの公開画面に、機密音声を入力しないこと、公開デモでは設定に応じて短い履歴を保存し得ることを示すプライバシー注意を置く。

## ReactとDBの扱い

初期MVPはvanilla JSとWorkers KVで縦切りを作り、現在は複雑化した表示構造と保存要件に対応する範囲だけReact/TypeScriptとD1/R2へ移行した。

- React/TypeScriptは公開3画面の表示構造と共通部品に採用した。録音、比較再生、job pollingのcontrollerは互換層として残し、状態境界ごとに段階縮小する。
- D1はquota・監査・公開サンプルmetadata、R2は音声blob、KVは短期job・軽量設定・fallbackに使い分ける。
- いずれも流行技術の追加ではなく、UI状態の複雑さ、atomicなquota更新、blob容量という具体的な問題への対応として扱う。

## 推奨作業順

1. ~~READMEをSpeakLoop/SkitVoice中心へ書き直す。~~ 完了。
2. 英語・中国語・日本語の公開サンプル生成物を登録する。スクリーンショットはReact/TypeScript移行と画面レイアウト改善後に撮影する。
3. ~~D1/R2の保存設計、resource、binding、quota/audit、公開サンプル音声の移行。~~ 完了。
4. ~~公開ポータル、SpeakLoop、SkitVoiceの表示構造をReact/TypeScriptへ切り替える。~~ 完了。
5. ~~React画面を実ブラウザとPlaywrightで確認し、レイアウトを微調整する。~~ 完了。公開用画像の選定はサンプル登録後に行う。
6. 録音、比較再生、IndexedDB、job pollingを小単位でhooks/reducerへ移し、旧controllerを縮小する。
7. ~~CIに公開デモ向けの検証セットとReact typecheck/buildを固定する。~~ 完了。
8. 必要ならSpeakLoopとSkitVoiceをCloudflare project単位で分ける。
