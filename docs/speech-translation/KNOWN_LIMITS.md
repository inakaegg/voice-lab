# 既知の制限

## 公開デモと外部依存

- Cloudflare Worker gateway、Googleログイン、feature別quota、管理者除外、簡易監査ログは実装済みだが、実運用はOpenAI、RunPod、Google OAuth、Cloudflareの各設定と稼働状態に依存する。
- RunPod Serverlessにはcontainer cold start、モデルロード、queue待ちがあり、初回生成の待ち時間は一定しない。
- OpenAI APIとRunPodの障害、rate limit、仕様変更はローカルテストだけでは保証できない。公開前後に最小入力のスモーク確認が必要。
- RunPod image buildとGPU smokeは費用が発生するため通常CIには含めず、手動workflowで実行する。

## SkitVoice / VibeVoice品質

- VibeVoiceの話者位置と発話内容は、言語、台本、参照音声、乱数に依存する。ASR timestampによる候補選別、再配置、低スコア行再生成を行っても完全な一致は保証しない。
- 日本語生成は英語・中国語より品質が不安定な場合がある。
- Seed-VCの類似度と自然さは参照音声の長さ、雑音、話し方に依存する。生成物を私的利用の範囲を超えて公開・共有する場合は、参照音声の利用条件を確認する。
- Qwen3-TTSとSeed-VCの依存は重く、CPU実行では実用速度に届かない可能性が高い。

## URL参照音声

- URLからの参照音声切り出しはローカルFastAPI版だけの補助機能で、Cloudflare公開版とRunPod handlerはURLを受け取らない。
- ローカル版でもYouTube等の公開状態、地域制限、ログイン要求、bot対策、yt-dlp側の追随状況により取得できない場合がある。
- `yt-dlp` は対応版Nodeを `--js-runtimes node` で使う。cookieやPO Tokenは既定機能に含めない。
- URL取得に失敗した時点ではRunPod処理は開始されていない。

## ブラウザ

- マイク録音とタブ音声録音にはブラウザ権限と安全なcontextが必要。タブ音声はブラウザが共有対象と音声共有を提示できる場合だけ利用できる。
- Chromeでの主要動作を基準とする。Safari/Firefox、スマートフォン実機の録音形式、権限、タブ共有は継続確認が必要。
- タブ音声録音はユーザーが選んだ共有対象の音声だけをブラウザ内で録音し、URLやcookieを取得しない。
- ブラウザのタブ共有許可は公開・再利用の許諾ではない。生成物を公開・共有・再利用する場合は、参照したコンテンツの利用条件を別途確認する。

## 保存とプライバシー

- ローカルFastAPI版はローカル音声履歴と公開サンプルを保存できる。公開サンプルの既定保存先は `tmp/public-sample-audios.json` で、Cloudflare版と同じ管理・表示API契約を使う。公開Cloudflare版は設定に応じて短い入力・出力音声と公開サンプルを保存し、D1へquota・監査・公開サンプルmetadata、R2へ音声blobを置く。
- D1/R2 bindingがないローカル・preview環境ではWorkers KV fallbackを使う。旧KVデータも引き続き読み出せる。
- 短期job stateと一部の軽量設定はWorkers KVに残る。現在のquotaは公開デモの過剰利用防止であり、厳密な課金台帳や永続workflow engineではない。
- 公開デモへ機密情報、個人情報、第三者の権利が不明な音声を入力しない。公開サンプルには公開許諾を確認できる素材だけを登録する。

## 応答速度

- local providerの初回リクエストはモデルロードを含むため遅い。`MO_PRELOAD_MODELS=1` で起動時に前倒しできるが、起動時間とメモリ使用量は増える。
- RunPod ServerlessはAPI往復、queue/poll、base64変換、一時ファイルI/Oの固定費がある。短い音声ではGPU推論時間より固定費が目立つ場合がある。
- Seed-VC resident providerはworker内の再ロードを減らせるが、idle終了後の次回は再度cold startする。
