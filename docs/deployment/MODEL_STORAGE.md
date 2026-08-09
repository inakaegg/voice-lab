# モデル保存とデプロイ方針

更新日: 2026-08-04

## 現在の保存方針

- モデル本体、Hugging Faceキャッシュ、生成音声、アップロード録音はgit管理しない。
- GPU推論用の大きいモデル重みはDocker imageに焼き込まない。
- モデルの置き場は以下のいずれかにする。
  - リポジトリ外のローカルキャッシュ。
  - RunPod Network Volume。
  - Modal Volume。
- ZoovoiceのCPU用artifactだけは例外とし、imageへ含める。条件は [Zoovoiceのruntime artifact](#zoovoiceのruntime-artifact) に定める。

## Zoovoiceのruntime artifact

ZoovoiceのGoサービスは、日本語ASRと動物連想のために次の3つを必要とする。いずれもgit管理せず、リポジトリ外へ置く。

| artifact | 内容 | 固定する識別子 |
| --- | --- | --- |
| whisper.cppソース | `whisper-cli` をbuildする元 | commit `5250a86fdebac4d51085fcfcd0b315cb0c6b91c9` |
| ASRモデル | 日本語ASR用 `ggml-small.bin` | SHA-256 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` |
| 連想index | ConceptNet 5.7.0から作った日本語のSQLite | SHA-256 `6492ed5d72629fd51f3794e3df5e568d509fbd1382c1fe3731064177a8d6297a` |

ローカル実行では、環境変数でこの3つのpathを渡す。Cloud Run向けimageでは、buildが検証済みのディレクトリをnamed contextとして受け取り、imageへ取り込む。取り込み後にimage内でSHA-256を照合し、一致しない場合はbuildを失敗させる。

RunPod用の大きいモデルと違い、imageへ焼き込む理由は次のとおりである。

- Cloud Runは永続volumeを前提にせず、起動ごとのdownloadはcold startを長くする。
- versionとhashをimageへ固定すると、選ばれる動物の再現性を保てる。
- smallモデルと1-hop indexはCPU向けであり、GPUモデル候補より小さい。

連想indexの帰属と再配布条件は `services/zoovoice/LICENSE-CONCEPTNET.md` を正とする。同じ内容をimageへ同梱する。

動物レキシコンと動物音はgit管理する。これらはリポジトリ外の3つとは扱いを分ける。imageのbuildは、追跡している `services/zoovoice/assets/animal-lexicon.json` のSHA-256も照合する。同梱する動物音のうちStable Audioで生成した24件は表示義務があり、`services/zoovoice/NOTICE-STABILITY-AI.md` をimageへ同梱する。

このimageのlocal buildと起動は実測済みである。linux/amd64のimageをCPU 2とメモリ2GiBの上限付きでnon-root起動し、image size 1,053,233,511 bytes、compose完了後の観測メモリ359.4 MiB / 2 GiBを得た。ASRモデルと連想indexはnon-rootの実行ユーザーから読める。この実測は動物レキシコン導入前のimageに対するものであり、現在のassetsを含むimageでは再測定していない。

取り込んだ `whisper-cli` はDockerfileの `-DBUILD_SHARED_LIBS=OFF` により、whisper/ggmlのlibraryをstaticに組み込んでbuildしている。この確認では、`whisper-cli` がwhisper/ggmlを共有libraryとして要求しないことを確かめた。libstdc++・libm・libgcc_s・libc・動的loaderへは動的にlinkするため、完全なstatic binaryではない。

この測定はApple Silicon上のlinux/amd64 emulationで行っている。上記の値はいずれもCloud Run実機では未確認である。測定条件と処理時間の詳細は [ARCHITECTURE.md](ARCHITECTURE.md) を参照する。

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

上記モデル容量に加えて10-30 GiB程度増える可能性がある。増える要因は実行時依存・CUDA/PyTorch wheel・tokenizer cache・一時音声・Docker layerである。

## 外部APIと自前運用の比較方針

有料外部APIは完全には除外しない。RunPodやModalで自前運用する場合のGPU課金、保存費用、初期設定、保守の手間と比較して判断する。外部APIを導入する場合は、目的・費用・依存リスク・APIキー管理を実装前に別途docsへ明記する。

## RunPod方針

低アクセスMVPでは、ワーカーを0までスケールダウンでき、ワーカー実行中だけ計算リソース課金されるRunPod Serverlessが有力。ただし、永続モデル保存の費用は残る。

公開MVPでは、静的UI配信とGPU推論APIを分ける。Web UIはCloudflare Worker Static Assets、API gatewayはWorker moduleとする。RunPodは中国語練習用FunASRとSeed-VCのGPU推論APIとして扱う。詳細は [ARCHITECTURE.md](ARCHITECTURE.md) を参照する。

初回のGPUスモーク確認では、Web UIとAPIを含むFastAPIをRunPod Podで一体起動する。これはモデルロード、GPU利用、録音またはファイルアップロードから音声出力までを先に確認するための検証構成であり、公開MVPの本番構成ではない。RunPod CLI手順は [RUNPOD.md](RUNPOD.md) を参照する。

推奨するRunPod構成:

1. コードと依存関係だけを含む小さいコンテナを作る。
2. モデル重みはRunPod Network Volumeへ置く。単一のHugging Faceモデルで足りる場合だけRunPod cached modelsも検討する。
3. PodとServerlessで環境変数を揃える。対象は `MODEL_CACHE_DIR=/runpod-volume/models`、`HF_HOME=/runpod-volume/huggingface`、`HF_HUB_CACHE=/runpod-volume/huggingface/hub` である。
4. 低アクセスMVPでは `workersMin=0` を使う。
5. 最初はREST APIまたはCLIスクリプトで自動化し、ローカル縦切りが動いてからGitHub Actionsを追加する。

複数モデル、選択したチェックポイントだけの取得、独自フォルダ構成が必要な場合はNetwork Volumeが向く。Cached modelsは単一Hugging Faceモデルでは簡単だが、複数モデルを組み合わせる音声パイプラインでは柔軟性が低い。

RunPodで最初に使うモデル配置:

| 用途 | 既定モデル | 保存先 |
| --- | --- | --- |
| ASR | `mobiuslabsgmbh/faster-whisper-large-v3-turbo` | `/runpod-volume/models/faster-whisper` |
| 翻訳 | `Qwen/Qwen3-4B` | `/runpod-volume/huggingface/hub` |
| TTS | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | `/runpod-volume/huggingface/hub` |
| 声質変換 | Seed-VC checkpoint | `/runpod-volume/huggingface/hub` または `SEED_VC_CHECKPOINT` で指定したpath |

初回取得後は、モデル更新による挙動差を避けるため、必要に応じて `FASTER_WHISPER_LOCAL_FILES_ONLY=1` と `QWEN_TRANSLATION_LOCAL_FILES_ONLY=1` に切り替える。

## Modal方針

実装がPython中心で、Pythonコード内でインフラ定義まで寄せたい場合はModalも比較対象にする。Modal Volumeはモデル重み保存とGPU functionへのattachに向く。Python中心のPoCではRunPodより簡単になる可能性があるが、Docker/REST/CLI中心のRunPodとは運用スタイルが異なる。

## 初期プラットフォーム判断

ローカルパイプラインで1つのモデル構成が動くまでは、最終プラットフォームを固定しない。最初のデプロイ実験では以下を比較する。

- コールドスタート。
- モデル読み込み時間。
- endpoint更新手順。
- 月額storage費用。
- スクリプトまたはGitHub Actionsからの自動化しやすさ。
