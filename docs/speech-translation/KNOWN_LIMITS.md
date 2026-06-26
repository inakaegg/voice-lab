# 既知の制限

## 声質クローン

- `MO_TTS_PROVIDER=qwen-seed-vc` では、`voice_mode=clone` はQwen3-TTS、`voice_mode=convert` はSeed-VCで動作する。
- Qwen3-TTSとSeed-VCの依存は重いため、通常の `local` providerとは分けて設定する。
- CPU実行では実用速度に届かない可能性が高い。GPU環境での再計測が必要。
- 現在のQwen3-TTS/Seed-VC providerはサブプロセス実行で、リクエストごとにモデルロードが発生する。
- 本物の声質類似度は、短いサンプルでの聴感確認とGPU環境での比較が必要。

## デプロイ

- Dockerfile、RunPod Serverless handler、ローカルFastAPIからRunPod Serverlessを呼ぶbackend adapterは用意済み。
- RunPod endpoint作成、APIキー設定、Network Volumeへのモデル配置、デプロイ先 `/health` 確認は未実行。
- 実デプロイは認証とモデル配置が必要なため、現時点では完了扱いにしない。

## TTS品質

- コマンドTTSは使わない。local providerではQwen3-TTSまたはSeed-VCのモデルproviderを明示する。
- 完成形の音声品質と声質類似度は、Qwen3-TTS、Seed-VC、または別TTS/VC providerの評価後に決める。

## 応答速度

- local providerの初回リクエストはモデルロードを含むため遅い。
- `MO_PRELOAD_MODELS=1` で起動時にロードを前倒しできるが、起動時間は長くなる。
- FastAPI gatewayからRunPod Serverlessへ投げる非同期job形式は実装済み。
- Qwen3-TTS/Seed-VCの低遅延常駐workerとストリーミング出力は未実装。

## ブラウザ

- UIはChromeでデスクトップ幅とモバイル幅の表示確認済み。
- スマホ実機の録音権限、Safari/Firefoxの録音形式差分は未確認。

## データ保持

- 入力音声、生成音声、voice profileは既定では永続保存しない。
- voice profile保存を追加する場合は、同意、保存先、削除方法を先に仕様化する。
