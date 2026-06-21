# モデル保存とデプロイ方針

## 現在の保存方針

- モデル本体、Hugging Faceキャッシュ、生成音声、アップロード録音はgit管理しない。
- 最初のMVPでは、大きいモデル重みをDocker imageに焼き込まない。
- モデルの置き場は以下のいずれかにする。
  - リポジトリ外のローカルキャッシュ。
  - RunPod Network Volume。
  - Modal Volume。

## モデル候補の容量目安

モデル保存方式を選ぶため、候補モデルのおおよその容量を記録する。以下はHugging Faceのモデルメタデータを元にした概算であり、完全な実行時使用容量ではない。モデル更新や依存関係により変わるため、実装時に再確認する。

| モデル | 概算容量 | メモ |
| --- | ---: | --- |
| `mobiuslabsgmbh/faster-whisper-large-v3-turbo` | 約1.5 GiB | faster-whisperの既定ASR候補。`turbo` 指定時に取得されるCTranslate2モデル。 |
| `Systran/faster-whisper-large-v3` | 3.09 GB | MVP後に比較するASR候補。 |
| `pfnet/plamo-2-translate` | 19.07 GB | 日本語/英語翻訳モデル。licenseと商用条件の確認が必要。 |
| `Qwen/Qwen3-4B` | 約7.5 GiB | 既定のローカルLLM翻訳候補。 |
| `Qwen/Qwen3-8B` | 要再確認 | 翻訳品質比較候補。 |
| `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | 2.52 GB | 速度比較用の軽量TTS候補。 |
| `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | 約4.5 GB | 既定のQwen3-TTS候補。 |
| `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | 4.52 GB | 声色制御を比較するQwen3-TTS候補。 |
| `FunAudioLLM/CosyVoice2-0.5B` | 4.86 GB | 多言語zero-shot声質クローン候補。 |
| `Plachta/Seed-VC` | 全ファイル取得時は3.94 GB | 個別チェックポイントはより小さい。不要な全取得を避ける。 |
| `myshell-ai/OpenVoiceV2` | 0.13 GB | 変換器の重みのみ。実際の構成ではbase TTSや依存関係が別途必要になる可能性がある。 |

実行時依存、CUDA/PyTorch wheel、tokenizer cache、一時音声、Docker layerを含めると、上記モデル容量に加えて10-30 GiB程度増える可能性がある。

## 外部APIと自前運用の比較方針

有料外部APIは完全には除外しない。RunPodやModalで自前運用する場合のGPU課金、保存費用、初期設定、保守の手間と比較して判断する。外部APIを導入する場合は、目的、費用、依存リスク、APIキー管理を実装前に別途docsへ明記する。

## RunPod方針

低アクセスMVPでは、ワーカーを0までスケールダウンでき、ワーカー実行中だけ計算リソース課金されるRunPod Serverlessが有力。ただし、永続モデル保存の費用は残る。

公開MVPでは、静的UI配信とGPU推論APIを分ける。Web UIはCloudflare Pages/Worker側、RunPodはASR、翻訳、TTS、声質変換の推論API側として扱う。詳細は [ARCHITECTURE.md](ARCHITECTURE.md) を参照する。

推奨するRunPod構成:

1. コードと依存関係だけを含む小さいコンテナを作る。
2. モデル重みはRunPod Network Volumeへ置く。単一のHugging Faceモデルで足りる場合だけRunPod cached modelsも検討する。
3. Serverlessではvolumeを `/runpod-volume` にmountして読む。
4. 低アクセスMVPでは `workersMin=0` を使う。
5. 最初はREST APIまたはCLIスクリプトで自動化し、ローカル縦切りが動いてからGitHub Actionsを追加する。

複数モデル、選択したチェックポイントだけの取得、独自フォルダ構成が必要な場合はNetwork Volumeが向く。Cached modelsは単一Hugging Faceモデルでは簡単だが、複数モデルを組み合わせる音声パイプラインでは柔軟性が低い。

## Modal方針

実装がPython中心で、Pythonコード内でインフラ定義まで寄せたい場合はModalも比較対象にする。Modal Volumeはモデル重み保存とGPU functionへのattachに向く。Python中心のPoCではRunPodより簡単になる可能性があるが、Docker/REST/CLI中心のRunPodとは運用スタイルが異なる。

## 初期プラットフォーム判断

ローカルパイプラインで1つのモデル構成が動くまでは、最終プラットフォームを固定しない。最初のデプロイ実験では以下を比較する。

- コールドスタート。
- モデル読み込み時間。
- endpoint更新手順。
- 月額storage費用。
- スクリプトまたはGitHub Actionsからの自動化しやすさ。
