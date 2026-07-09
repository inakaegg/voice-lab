# 公開デモ品質向上ロードマップ

## 目的

SpeakLoopとSkitVoiceを、第三者が短時間で価値と技術構成を理解し、実際に触って評価できる公開デモへ整える。

この文書では、採用や営業などの内部目的ではなく、公開プロダクトとして自然に必要になる改善だけを書く。公開上の狙いや見せ方の内部メモは `_ai/` に分ける。

## 現状の強み

- SpeakLoopは、母国語入力、学習対象言語への変換、模範音声、復唱、ASR比較、フレーズごとの比較再生までを1つの練習ループとして実装している。
- SkitVoiceは、台本、複数話者、参照音声、VibeVoice、ASR再配置、低スコア行再生成、Seed-VC後処理を組み合わせた音声生成ツールとして実装している。
- Cloudflare Workerを公開API gatewayにし、OpenAI APIとRunPod Serverlessを分けている。
- RunPod API keyやOpenAI API keyをブラウザへ出さず、Worker secretまたはRunPod側環境変数として扱う。
- Googleログイン、公開quota、管理者除外、管理画面設定、監査ログ方針がある。
- Pythonのpytest、Nodeの `node --test`、Cloudflare Worker test、RunPod handler testがあり、モデル非依存部分はローカルで検証できる。
- VibeVoiceの不安定さに対し、ASR timestamp、候補選別、再生成、診断JSONで品質を制御する構成を持つ。

## 現状の弱点

- READMEが旧来の音声翻訳アプリ寄りで、現在の主役であるSpeakLoopとSkitVoiceが前面に出ていない。
- ユーザー向け画面は改善しているが、内部検証画面や過去の実験機能が同居しており、初見では主要導線が分かりにくい。
- フロントエンドはvanilla HTML/CSS/JavaScript中心で、状態管理やUI部品の再利用が大きくなり始めている。
- 保存層はWorkers KV中心であり、音声blob、生成履歴、quota台帳、監査ログを長期運用するにはD1/R2などへ分ける必要がある。
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
- SkitVoice公開UIは、外部URL取得ではなくファイルアップロード、マイク録音、権利確認済みサンプル音声を主導線にする。

## ReactとDBの扱い

ReactやDBが無いこと自体は欠陥ではない。現在のMVPでは、vanilla JSとWorkers KVで早く縦切りを作ったことに意味がある。

ただし、公開デモを継続運用するなら、次の段階ではReact/TypeScriptとD1/R2を入れる価値がある。

- React/TypeScriptは、録音、比較再生、job polling、フォーム状態の複雑化に対する保守性改善として採用する。
- D1/R2は、ユーザー、quota、履歴、監査、音声blobを役割別に保存するために採用する。
- どちらも「流行技術を入れるため」ではなく、現状の複雑さと保存要件に対する具体的な解決策として扱う。

## 推奨作業順

1. READMEをSpeakLoop/SkitVoice中心へ書き直す。
2. 公開デモのスクリーンショット、サンプル入力、サンプル音声を整える。
3. D1/R2の保存設計を決め、KVから移す対象を絞る。
4. SpeakLoopユーザー画面だけReact/TypeScriptで再実装する。
5. SkitVoiceユーザー画面をReact/TypeScriptへ移す。
6. CIに公開デモ向けの検証セットを固定する。
7. 必要ならSpeakLoopとSkitVoiceをCloudflare project単位で分ける。
