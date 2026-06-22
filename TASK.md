# TASK - 音声翻訳Webアプリ

## 現在の状態

- MVPの必須入出力は `id-ID 音声 -> ja-JP 音声` と `ja-JP 音声 -> zh-CN 音声`。
- 最終的には入力話者の声を出力音声にも反映する。初期実装では、声質クローンなしの縦切りを先に作る。
- 指定した文字列を出力文の末尾に付加するテキスト加工はMVP範囲に含めるが、最初の実装では後回しでよい。
- ローカル動作確認後、RunPodまたは別GPUプラットフォームへ載せる。
- feature branchでは、fake providerを使ったパイプラインと `POST /api/translate-speech` の最小APIが動いている。
- ブラウザUIから、音声アップロード、録音、末尾付加設定、結果表示、音声再生を操作できる。
- `MO_PROVIDER_MODE=local` で、faster-whisper、Qwen3翻訳、Qwen3-TTS/Seed-VCを使うローカル実プロバイダを選択できる。
- `voice_mode` のAPI契約、応答時間計測、Qwen3-TTS/Seed-VC provider、Dockerfile、RunPod handler、README、既知の制限を追加済み。
- RunPod GPU用DockerfileとCLI補助スクリプトを追加し、初回はPodでWeb UIとAPIを一体確認、その後Serverlessへ分ける方針にした。

## 次にやること

実装フェーズは [docs/speech-translation/PHASES.md](docs/speech-translation/PHASES.md) を正とする。

1. Qwen3-TTSとSeed-VCの声質、速度、GPU費用を比較し、採用経路を決める。
2. RunPodのAPIキー、Docker registry、Network Volume IDを設定し、GPU Podを作成する。
3. RunPod上で、デプロイ先 `/health` と短いfixture音声のスモーク確認を行う。
4. スマホ実機録音、Safari/Firefox、voice profile保存方針を必要に応じて追加確認する。

## 実装時に追加する検証

- パイプラインのルート選択とプロバイダアダプタの単体テスト。
- `POST /api/translate-speech` のAPIテスト。
- 短い録音またはfixture音声を使ったローカルスモークテスト。
- 録音、アップロード、ローディング状態、文字起こし表示、翻訳表示、音声再生のUIスモークテスト。
