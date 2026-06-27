# デプロイ構成方針

## 目的

音声翻訳Webアプリの公開MVPでは、静的UI、API gateway、GPU推論を分離し、GPUリソースをAI処理にだけ使う。ローカル開発ではFastAPIがUIとAPIを同時に提供してよいが、本番寄りの低アクセス構成では同じ形にこだわらない。

## 推奨構成

最初のGPUスモーク確認では、構成を分けすぎず、FastAPIのWeb UIとAPIをまとめてGPU環境へ載せる。これにより、モデルロード、GPU実行、録音またはアップロードから出力音声までの一通りの動作を先に確認する。

公開MVPでは、以下のように静的UI、API gateway、GPU推論を分離する。

```text
Browser
  -> Cloudflare Pages: 静的UI
  -> Cloudflare Worker: API gateway、認証、CORS、RunPod API keyの秘匿
  -> Cloudflare R2: 保存が必要な録音、生成音声
  -> Cloudflare D1 または KV: 音声履歴metadata
  -> RunPod Serverless または代替GPU API: ASR、翻訳、TTS、声質変換
  -> RunPod Network Volume または同等の永続volume: モデル重み
```

この構成では、Webサーバー相当の静的配信をGPUサーバーへ載せない。GPU側は音声入力を受け取り、文字起こし、翻訳、出力音声、処理時間、provider情報を返す推論APIとして扱う。

## 理由

- 静的UI配信はGPUを必要としないため、Cloudflare Pagesのような静的ホスティングに分ける方が安い。
- Cloudflare Pagesでは静的asset requestが無料枠で扱いやすい。
- Cloudflare Workers Freeにはリクエスト数やCPU時間の制限があるため、重い処理は置かず、薄いgatewayに限定する。
- RunPod Serverlessはワーカー実行中の秒単位課金とscale to zeroが使えるため、低アクセスMVPではGPU推論だけを載せる方が無駄が少ない。
- RunPod API keyをブラウザに直接持たせるべきではないため、公開UIから直接RunPodへ投げるより、Workerなどのgatewayを挟む。
- サーバー運用で録音や生成音声を保存する場合、GPU workerのローカルファイルやRunPod Network Volumeを履歴保存先にしない。音声blobはR2、一覧や削除管理に必要なmetadataはD1またはKVへ分ける。

## トレードオフ

- 分離すると、CORS、認証、gateway、API base URL、job polling、エラー伝播、アップロードサイズ制限の設計が増える。
- 音声ファイルをWorker経由で転送する場合、request body size、実行時間、base64化の有無を確認する必要がある。
- 音声履歴を残す場合は、保存期間、削除UI、同意表示、共有可否を先に仕様化する必要がある。
- 低遅延化では、単純なHTTP一括処理だけでなく、非同期job、polling、またはstreaming responseの設計が必要になる。
- 初回のGPUスモーク確認だけなら、FastAPIまたはRunPod handlerをGPU環境で直接動かす方が速い。その後、公開MVPへ向けてCloudflare側へUI/gatewayを分ける。

## 段階

1. ローカル開発: FastAPIが静的UIとAPIを同時に提供する。
2. GPUスモーク確認: FastAPIのWeb UIとAPIを同じGPU環境で動かし、短い音声で一通りの推論を確認する。
3. 公開MVP: Cloudflare Worker Static Assetsへ静的UIを置き、同じWorkerをgatewayとしてRunPod APIを呼ぶ。初回デモの詳細は [CLOUDFLARE.md](CLOUDFLARE.md) を正とする。
4. 低遅延化: GPU側を常駐worker化し、可能ならASR、翻訳、TTS、声質変換をstreamingまたは段階的jobに分ける。

## 実装への影響

- frontendはAPI base URLを環境ごとに切り替えられる必要がある。
- backendのレスポンスschemaは、ローカルFastAPIとGPU推論APIで揃える。
- RunPod handlerはWeb UIを配信しない推論APIとして維持する。
- API key、RunPod token、Cloudflare tokenはリポジトリに入れない。
