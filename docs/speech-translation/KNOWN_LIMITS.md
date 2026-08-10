# 既知の制限

更新日: 2026-08-10

## 公開デモと外部依存

- Cloudflare Worker・Googleログイン・feature別quota・管理者除外・簡易監査ログは実装済みである。ただし実運用はOpenAI、RunPod、Google OAuth、Cloudflareの各設定と稼働状態に依存する。
- RunPod Serverlessにはcontainer cold start、モデルロード、queue待ちがあり、初回生成の待ち時間は一定しない。
- OpenAI APIとRunPodの障害、rate limit、仕様変更はローカルテストだけでは保証できない。公開前後に最小入力のスモーク確認が必要。
- RunPod image buildとGPU smokeは費用が発生するため通常CIには含めず、手動workflowで実行する。

## 費用の推定

- SpeakLoopの比較・採点は、`MO_PRACTICE_LLM_PRICING_JSON` を設定したときだけ推定費用を記録する。
- この推定はキャッシュへの新規書き込み（`cache_write_tokens`）の割増単価を加算しない。GPT-5.6系では初回入力の実額より小さく出る。
- 単価は各モデルの公開価格に従うため、この文書には固定値を書かない。実額が要る場合は応答の `usage` を記録する。

## 声質変換の品質

- Seed-VCの類似度と自然さは、参照音声の長さ、雑音、話し方に依存する。生成物を私的利用の範囲を超えて公開・共有する場合は、参照音声の利用条件を確認する。
- Qwen3-TTSとSeed-VCの依存は重く、CPU実行では実用速度に届かない可能性が高い。

## ブラウザ

- マイク録音にはブラウザ権限と安全なcontextが必要である。
- Chromeでの主要動作を基準とする。Safari、Firefox、スマートフォン実機の録音形式と権限は継続確認が必要である。

## 保存とプライバシー

- ローカルFastAPI版はローカル音声履歴と公開サンプルを保存できる。公開サンプルの既定保存先は `tmp/public-sample-audios.json` で、Cloudflare版と同じ管理・表示API契約を使う。
- Cloudflare公開版はユーザーの入力・生成音声を履歴保存しない。D1へquota・監査・公開サンプルmetadata、R2へ公開サンプルblobだけを置く。
- D1/R2 bindingがないローカル・preview環境では、公開サンプル、quota、監査にWorkers KV fallbackを使う。
- SpeakLoopの短期job stateとwarmup ready状態はWorkers KVに残る。中国語復唱jobはWorkerがRunPod statusを都度中継し、音声と結果をCloudflare側の履歴に保存しない。
- 現在のquotaは公開デモの過剰利用防止であり、厳密な課金台帳や永続workflow engineではない。
- 公開デモへ機密情報、個人情報、第三者の権利が不明な音声を入力しない。公開サンプルには公開許諾を確認できる素材だけを登録する。

## 応答速度

- local providerの初回リクエストはモデルロードを含むため遅い。`MO_PRELOAD_MODELS=1` で起動時に前倒しできるが、起動時間とメモリ使用量は増える。
- RunPod ServerlessはAPI往復、queue/poll、base64変換、一時ファイルI/Oの固定費がある。短い音声ではGPU推論時間より固定費が目立つ場合がある。
- Seed-VC resident providerはworker内の再ロードを減らせるが、idle終了後の次回は再度cold startする。
