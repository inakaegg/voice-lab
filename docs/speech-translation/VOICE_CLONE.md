# 声質クローン方針

## 目的

MVP完成形では、入力話者の声を出力音声に反映する。Phase 3では、声質クローンを後付けの例外処理ではなく、APIとpipelineの明示的な `voice_mode` として扱う。

## voice mode

- `default`: fake providerでAPI/UI確認に使う。local providerでは使わない。
- `clone`: 入力音声を参照音声として、TTS時点で声質を寄せる。
- `convert`: モデルTTSで音声生成した後、声質変換で入力話者に寄せる。

ローカル実プロバイダでは、以下の2経路を評価対象にする。

- `clone`: Qwen3-TTS Baseを使い、入力音声を参照音声としてTTS時点で声質を寄せる。
- `convert`: Qwen3-TTSで翻訳後音声を生成し、その音声をSeed-VCで入力話者の声へ変換する。

違いは処理順である。`clone` はQwen3-TTSが「テキスト、参照音声、参照テキスト」を受け取り、最初から声を寄せた出力音声を生成する。`convert` は、まずQwen3-TTSで出力言語の音声を作り、その生成音声をSeed-VCで入力音声の話者らしさへ変換する。

`MO_TTS_PROVIDER=qwen-seed-vc` では `clone` と `convert` の両方を選択できる。対応providerが設定されていない `voice_mode` は設定エラーとして返す。

## 保存方針

- 既定では入力音声、生成音声、voice profileを永続保存しない。
- voice profileを保存する機能を追加する場合は、実装前に以下を仕様化する。
  - 保存の同意をどの画面で得るか。
  - 保存先と暗号化の有無。
  - 削除方法。
  - voice profileをエクスポートできるか。

## モデル選択

Phase 3では、以下を最初の評価対象として固定する。

- Qwen3-TTS Base: `voice_mode=clone` の直接声質クローンTTSとして評価する。
- Seed-VC: `voice_mode=convert` の後段voice conversionとして評価する。

Qwen3-TTSは参照音声とその文字起こしを使う。参照音声の言語がモデルの明示対応外の場合は、speaker embeddingのみを使う設定に切り替える。

Seed-VCでは、翻訳後TTS音声を `source`、入力音声を `target` として扱う。これは、Seed-VCのCLIが `source` を変換元音声、`target` を参照音声として扱うためである。

Seed-VCへ渡す `target` は、アップロード音声そのものではなく、サーバー側で短いmono WAVへ正規化した参照音声にする。ブラウザ録音はWebM/Opusになりやすく、無音や余分な長さを含むとSeed-VCの処理時間が大きく伸びるためである。既定では先頭10秒までを参照音声として使い、`SEED_VC_REFERENCE_MAX_SECONDS` と `SEED_VC_REFERENCE_SAMPLE_RATE` で調整できる。

`seed_vc_reference_auto_select` をONにした場合は、参照音声をそのまま先頭から切らず、`ffmpeg silencedetect` で軽量に発話区間を推定してから切り出す。発話候補が取れない場合は先頭切り出しに戻すため、ノイズ環境でも参照音声が空になることは避ける。実装メモと今後深掘りする候補は [REFERENCE_SELECTION.md](REFERENCE_SELECTION.md) に残す。

ルート別の扱い:

- `id-ID -> ja-JP`: Seed-VCの `convert` を推奨経路にする。ASRと翻訳は通常通り行い、声質は入力音声そのものを参照して後段変換する。
- `ja-JP -> zh-CN`: Qwen3-TTSの `clone` とSeed-VCの `convert` を比較する。

現時点の聴感確認ではSeed-VCの `convert` の方が入力話者に近いため、UIの初期選択は `convert` にする。

外部APIは完全除外しないが、導入前に費用、キー管理、依存リスクをdocsに明記する。

## ローカル設定

Qwen3-TTSとSeed-VCを比較できる状態で使う場合:

```sh
MO_PROVIDER_MODE=local \
MO_TTS_PROVIDER=qwen-seed-vc \
QWEN_TTS_PYTHON=path/to/python \
SEED_VC_PYTHON=path/to/python \
QWEN_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-1.7B-Base \
PYTHONPATH=src python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

Qwen3-TTSだけを使う場合は `MO_TTS_PROVIDER=qwen`、Seed-VCの変換経路だけを使う場合は `MO_TTS_PROVIDER=seed-vc` を指定する。

Seed-VCだけを使う場合:

```sh
MO_PROVIDER_MODE=local \
MO_TTS_PROVIDER=seed-vc \
SEED_VC_PYTHON=path/to/python \
PYTHONPATH=src python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

Seed-VCは、checkpointとconfigを明示しない場合、初回実行時に公式の既定モデルを取得する。既に配置済みのファイルを使う場合は `SEED_VC_CHECKPOINT` と `SEED_VC_CONFIG` を指定する。

## ローカルスモーク確認

短い参照音声で以下を確認済み。

| provider | voice mode | 結果 | 備考 |
| --- | --- | --- | --- |
| Qwen3-TTS Base | `clone` | WAV生成成功 | CPU/manual PyTorch経路では短文でも十数秒以上かかる。 |
| Seed-VC | `convert` | WAV生成成功 | 初回は既定checkpoint取得を含む。取得後もサブプロセス起動とモデルロードが毎回かかる。 |

実用速度の判断はGPU環境で再計測する。現状のローカル実装はモデル評価とAPI契約の確認を目的とし、低遅延本番経路ではない。

## 未評価候補

- Qwen3-TTS CustomVoice: 直接のvoice cloneではなく、指示による声色制御として別途評価する。
- VibeVoice: 長尺・複数話者TTS候補だが、対象言語と用途がMVPの声質クローン要件と一致するか確認が必要。
- OpenVoice: Seed-VCで声質類似度または速度が不足する場合に比較する。
- 外部API: 完全除外はしないが、導入前に費用、キー管理、依存リスクをdocsに明記する。
