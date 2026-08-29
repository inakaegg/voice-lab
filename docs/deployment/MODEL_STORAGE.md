# モデル保存とデプロイ方針

更新日: 2026-08-29

## 現在の保存方針

- モデル本体、Hugging Faceキャッシュ、生成音声、アップロード録音はgit管理しない。
- GPU推論用の大きいモデル重みはDocker imageに焼き込まない。
- モデルの置き場は以下のいずれかにする。
  - リポジトリ外のローカルキャッシュ。
  - RunPod Network Volume。
  - Modal Volume。
- ZoovoiceのCPU用artifactだけは例外とし、imageへ含める。条件は [Zoovoiceのruntime artifact](#zoovoiceのruntime-artifact) に定める。

## Zoovoiceのruntime artifact

ZoovoiceのGoサービスは、日本語ASRのために次の2つを必要とする。いずれもgit管理せず、リポジトリ外へ置く。動物連想はLLMのAPIで行うため、連想用の辞書やindexは持たない。

| artifact | 内容 | 固定する識別子 |
| --- | --- | --- |
| whisper.cppソース | `whisper-cli` をbuildする元 | commit `edea8a9c3cf0eb7676dcdb604991eb2f95c3d984` |
| ASRモデル | 日本語ASR用 `ggml-small.bin` | SHA-256 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` |

whisper.cppソースはupstreamのcommitを固定し、CIとローカルのどちらもGitHubから取得する。ASRモデルと動物音源セットはCloud Storageに置く。配置と復旧の方針は [build資材の保管と復旧](#build資材の保管と復旧) に定める。

ローカル実行では、環境変数でこの2つのpathを渡す。連想に使うAPIキーは `OPENAI_API_KEY` で渡す。Cloud Run向けimageでは、buildが検証済みのディレクトリをnamed contextとして受け取り、imageへ取り込む。取り込み後にimage内でSHA-256を照合し、一致しない場合はbuildを失敗させる。

RunPod用の大きいモデルと違い、imageへ焼き込む理由は次のとおりである。

- Cloud Runは永続volumeを前提にせず、起動ごとのdownloadはcold startを長くする。
- versionとhashをimageへ固定すると、選ばれる動物の再現性を保てる。
- smallモデルはCPU向けであり、GPUモデル候補より小さい。

動物音もgit管理せず、ASRモデルと同じくリポジトリ外へ置き、build時に `zoovoice_sounds` named contextからimageへ取り込む。出所と採用hashはそのセットの `manifest.json` を正とし、Goサービスが起動時にSHA-256を照合する。

imageの実測値と測定条件、whisper-cliのlink構成は [services/zoovoice/README.md](../../services/zoovoice/README.md) を正とする。

## build資材の保管と復旧

Zoovoiceのbuild資材はgit管理しない。かつて正本がローカルの一時ディレクトリにしか無く、リポジトリ名の変更でそのディレクトリが引き継がれず、動物音源セットを失った。同じことを繰り返さないため、資材ごとに役割と復旧の順序を決める。

### 資材の役割

| 役割 | 実体 | 位置づけ |
| --- | --- | --- |
| 正本 | Cloud Storageのobject | 内容hashをpathへ含め、既存objectを上書きしない |
| 二次復旧元 | 稼働中のCloud Run image | deployのたびに資材が焼き込まれ、正本と同じ内容が自動で二重化される |
| 作業用複製 | ローカルのファイル | 正本ではない。失っても上の2つから復元できる |

whisper.cppソースはこの3分類の外にある。upstreamのcommitを固定して取得するため、正本はupstreamのリポジトリである。

### bucketの保護

bucketは `mo-speech-501706-zoovoice-artifacts` で、リージョンは `us-central1` とする。定義は `infra/gcp/storage.tf` を正とする。

- 動物音源には再配布が禁止された素材を含むため、public access preventionをenforcedにする。
- 誤削除と誤上書きから戻せるよう、versioningとsoft deleteを有効にする。
- CI用service accountにはobjectの読み取りだけを与える。削除と上書きの権限は与えない。

### 復旧の順序と確認方法

1. Cloud Storageのobjectから取り出す。`ZOOVOICE_ARTIFACTS_DIR=<復元先> ./scripts/fetch_zoovoice_artifacts.sh` を実行する。objectを消していても、versioningの旧versionから戻せる。
2. 稼働中のCloud Run imageから取り出す。`python3 scripts/recover_zoovoice_sounds_from_image.py <復元先>` を実行する。
3. ローカルの作業用複製を使う。

どの経路でも、復元できたかどうかはSHA-256で確かめる。ASRモデルは既知のSHA-256と照合し、動物音源セットは `manifest.json` に記録した全ファイルのSHA-256と照合する。上の2つのscriptはこの照合まで自動で行い、1件でも合わなければ失敗する。

imageからの復旧は、image全体を取得しない。`COPY . /app/sounds` に対応するlayerだけを取り出すため、必要な通信量は数MiBで済む。

### 残っているリスク

bucketは単一リージョンの単一bucketである。リージョン全体の障害では、二次復旧元と作業用複製に頼ることになる。複数リージョンへの複製は無料枠を超えるため採用しない。

### 資材の差し替え

資材を新しくするときは、新しいobjectを別のpathへ置いてから `scripts/zoovoice_artifacts_common.sh` の定数を更新する。既存objectは上書きしない。アップロードは `scripts/upload_zoovoice_artifacts.sh` を使う。既定はdry-runで、内容を確かめてから `ZOOVOICE_ARTIFACTS_UPLOAD_APPLY=1` を付けて実行する。

```sh
ZOOVOICE_ASR_MODEL_PATH=<ggml-small.binのpath> \
ZOOVOICE_SOUNDS_DIR=<manifest.json付きの音源ディレクトリ> \
./scripts/upload_zoovoice_artifacts.sh
```

動物音源セットは決定的なtar.gzにまとめる。同じ入力から同じSHA-256になるよう、entryの順序と時刻、gzipヘッダに入るファイル名まで固定している。作成は `scripts/build_zoovoice_sounds_archive.py` が行う。

### CI用service account鍵の扱い

CIはservice account鍵で認証する。鍵はTerraformで作らない。秘密鍵がstateへ入るためである。

**作成と登録**

1. `gcloud iam service-accounts keys create` で作る。出力はGitHub Secretへ移し、ローカルへ残さない。
2. GitHub Secret `GCP_ZOOVOICE_CI_SA_KEY` へ設定する。
3. 反映jobの認証stepが通ることを確認する。

**交換**

1. 新しい鍵を作り、GitHub Secretを差し替える。
2. 旧鍵は削除せず `keys disable` で止める。問題があれば戻せる。
3. 一定期間動作に問題がなければ `keys delete` で消す。

**漏洩したとき**

1. 即座に `keys delete` で当該鍵を消す。
2. GitHub Secretを削除する。
3. 監査ログで当該service accountの操作を確認する。

## モデル候補の容量目安

モデル保存方式を選ぶため、候補モデルのおおよその容量を記録する。以下はHugging Faceのモデルメタデータを元にした概算であり、実行時の使用容量の全体ではない。モデル更新や依存関係により変わるため、実装時に再確認する。

| モデル | 概算容量 | メモ |
| --- | ---: | --- |
| `mobiuslabsgmbh/faster-whisper-large-v3-turbo` | 約1.5 GiB | faster-whisperの既定ASR候補。`turbo` 指定時に取得されるCTranslate2モデル。 |
| `Systran/faster-whisper-large-v3` | 3.09 GB | MVP後に比較するASR候補。 |
| `pfnet/plamo-2-translate` | 19.07 GB | 日本語/英語翻訳モデル。licenseと商用条件の確認が必要。 |
| `Qwen/Qwen3-4B` | 約7.5 GiB | 既定のローカルLLM翻訳候補。 |
| `Qwen/Qwen3-8B` | 要再確認 | 翻訳品質の比較候補。 |
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
