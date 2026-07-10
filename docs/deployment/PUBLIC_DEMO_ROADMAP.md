# 公開デモ品質向上ロードマップ

## 目的

SpeakLoopとSkitVoiceを、第三者が短時間で価値と技術構成を理解し、実際に触って評価できる公開デモへ整える。

この文書では、採用や営業などの内部目的ではなく、公開プロダクトとして自然に必要になる改善だけを書く。公開上の狙いや見せ方の内部メモは `_ai/` に分ける。

## 進捗（2026-07-10）

- 完了: READMEの主役をSpeakLoop/SkitVoiceへ更新し、構成図、セットアップ、検証、制限、権利・プライバシー上の注意を掲載。
- 完了: push/PRでpytest、Node test、JavaScript構文検査を行う通常CIを追加。GPU build/smokeは手動workflowのまま分離。
- 完了: SkitVoiceの参照音声を、ローカル版4方式（ファイル、マイク、タブ音声、URL）とCloudflare版3方式（URL以外）に整理。
- 完了: 公開UIへプライバシー注意と、私的利用を超えて公開・共有する場合の簡潔な利用条件確認を追加。操作ごとの確認ダイアログは要求しない。
- 完了: D1 database、`MO_SPEECH_DB` binding、全migration、R2 production/preview bucket、`MO_SPEECH_AUDIO_R2` bindingを作成・deploy。quota/auditはD1、公開サンプルmetadataはD1、音声blobはR2へ移行し、bindingなし環境のKV fallbackと旧KVデータ引き継ぎも維持。
- 設計完了・移行未着手: React/TypeScriptへの段階移行境界を [FRONTEND_MIGRATION.md](FRONTEND_MIGRATION.md) に固定。
- 完了: 公開URLでのOAuth/quota/RunPod実ブラウザE2E確認。
- 素材待ち: 英語・中国語・日本語の公開サンプル生成物登録。
- 後続: React/TypeScript移行と画面レイアウト改善後に公開スクリーンショットを撮影する。別ブランチで行う。

## 現状の強み

- SpeakLoopは、母国語入力、学習対象言語への変換、模範音声、復唱、ASR比較、フレーズごとの比較再生までを1つの練習ループとして実装している。
- SkitVoiceは、台本、複数話者、参照音声、VibeVoice、ASR再配置、低スコア行再生成、Seed-VC後処理を組み合わせた音声生成ツールとして実装している。
- Cloudflare Workerを公開API gatewayにし、OpenAI APIとRunPod Serverlessを分けている。
- RunPod API keyやOpenAI API keyをブラウザへ出さず、Worker secretまたはRunPod側環境変数として扱う。
- Googleログイン、公開quota、管理者除外、管理画面設定、監査ログ方針がある。
- Pythonのpytest、Nodeの `node --test`、Cloudflare Worker test、RunPod handler testがあり、モデル非依存部分はローカルで検証できる。
- VibeVoiceの不安定さに対し、ASR timestamp、候補選別、再生成、診断JSONで品質を制御する構成を持つ。

## 現状の弱点

- READMEはSpeakLoopとSkitVoice中心へ刷新済み。実画面スクリーンショットはReact/TypeScript移行後に追加する。
- ユーザー向け画面は改善しているが、内部検証画面や過去の実験機能が同居しており、初見では主要導線が分かりにくい。
- フロントエンドはvanilla HTML/CSS/JavaScript中心で、状態管理やUI部品の再利用が大きくなり始めている。
- 保存層は、quota・監査・公開サンプルmetadataをD1、音声blobをR2、軽量設定・ready状態・音声履歴indexをKVへ分離済み。
- RunPodやVibeVoiceは外部要因とGPU費用の影響を受けるため、公開デモではサンプル音声、入力制限、分かりやすい失敗表示が必要である。

## 優先度

### 1. READMEと公開導線を刷新する

READMEの冒頭は、`mo speech translation` ではなく、現在の公開アプリであるSpeakLoopとSkitVoiceを主役にする。

- 何ができるかを短く説明する。
- `/speakloop`、`/skitvoice`、`/fun` の位置づけを明確にする。
- アーキテクチャ図を置く。
- Cloudflare Worker、OpenAI API、RunPod Serverless、KV、将来のD1/R2の関係を説明する。
- 動作確認コマンドとデプロイ手順を、開発者が追える粒度でまとめる。
- 既知の制限を隠さず、VibeVoice品質、RunPod cold start、quota制御、URL参照音声の制約を説明する。

### 2. 保存層をKVだけに寄せない

公開デモではKVだけでも動くが、長期運用や履歴管理を考えると、保存先を役割ごとに分ける。

- D1: ユーザー、quota、生成job metadata、監査ログ、公開サンプル音声metadata。
- R2: 録音、生成音声、公開サンプル音声などのblob。
- KV: 短期キャッシュ、軽量設定、ready状態などの低整合性でよい値。

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

Vite + React + TypeScriptを候補にする。CSS frameworkは必須ではない。見た目の一貫性を優先し、導入する場合も公開ユーザー画面に閉じる。

### 4. CIを公開デモ向けに固定する

最低限、以下をGitHub Actionsで毎回確認する。

- `python -m pytest`
- `npm run test:worker`
- `node --check cloudflare/worker.mjs`
- 公開HTML/JSの構文チェック
- Dockerfile.runpodの静的検査

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

ReactやDBが無いこと自体は欠陥ではない。現在のMVPでは、vanilla JSとWorkers KVで早く縦切りを作ったことに意味がある。

ただし、公開デモを継続運用するなら、次の段階ではReact/TypeScriptとD1/R2を入れる価値がある。

- React/TypeScriptは、録音、比較再生、job polling、フォーム状態の複雑化に対する保守性改善として採用する。
- D1/R2は、ユーザー、quota、履歴、監査、音声blobを役割別に保存するために採用する。
- どちらも「流行技術を入れるため」ではなく、現状の複雑さと保存要件に対する具体的な解決策として扱う。

## 推奨作業順

1. ~~READMEをSpeakLoop/SkitVoice中心へ書き直す。~~ 完了。
2. 英語・中国語・日本語の公開サンプル生成物を登録する。スクリーンショットはReact/TypeScript移行と画面レイアウト改善後に撮影する。
3. ~~D1/R2の保存設計、resource、binding、quota/audit、公開サンプル音声の移行。~~ 完了。
4. SpeakLoopユーザー画面を、互換テストを維持しながらReact/TypeScriptへ段階移行する。
5. SkitVoiceユーザー画面をReact/TypeScriptへ段階移行する。
6. ~~CIに公開デモ向けの検証セットを固定する。~~ 完了。
7. 必要ならSpeakLoopとSkitVoiceをCloudflare project単位で分ける。
