# 応答速度と計測

## 目的

音声翻訳の体感速度を改善するため、ASR、翻訳、テキスト加工、TTS、全体時間を同じ形式で計測する。最初は同期APIのまま測定し、どの段階がボトルネックかを分ける。

## 現在の計測項目

- `asr`: 音声から入力言語テキストへ変換する時間。
- `translation`: 入力言語テキストから出力言語テキストへ翻訳する時間。
- `text_transform`: 任意のテキスト加工時間。
- `tts`: 出力言語音声を生成する時間。
- `voice_conversion`: 既定TTS後に声質変換を行う時間。`voice_mode=convert` のときだけ返す。
- `total`: pipeline全体の時間。

local providerでは、初回実行時にモデルロード時間が各stageに含まれる。warm状態の体感を見る場合は、同じprocessで複数回実行した2回目以降を見る。

起動時にモデルロードを済ませる場合は、`MO_PRELOAD_MODELS=1` を指定する。この場合、初回リクエストの待ち時間は短くなるが、サーバ起動時間は長くなる。

## 計測コマンド

fake provider:

```sh
python3 scripts/benchmark_pipeline.py --provider-mode fake --repeat 3
```

local provider:

```sh
MO_TTS_PROVIDER=qwen-seed-vc \
python3 scripts/benchmark_pipeline.py \
  --provider-mode local \
  --audio path/to/sample.m4a \
  --source-language ja-JP \
  --target-language zh-CN \
  --repeat 3
```

cold寄りの比較:

```sh
MO_TTS_PROVIDER=qwen-seed-vc \
python3 scripts/benchmark_pipeline.py \
  --provider-mode local \
  --audio path/to/sample.m4a \
  --source-language ja-JP \
  --target-language zh-CN \
  --repeat 3 \
  --fresh-pipeline-per-run
```

## 現在の改善方針

1. モデルロードをリクエストごとに繰り返さない。
2. local providerのwarm状態を基準にUI体験を確認する。
3. 声質クローンproviderを追加した後、`tts` または `voice_conversion` の時間を分けて計測する。
4. 同期APIで待ち時間が長い場合、非同期jobまたはストリーミング出力に分ける。

## 代表値

短いfixture音声での参考値。環境により変わるため、性能保証値ではない。

| 構成 | ルート | 状態 | ASR | 翻訳 | TTS | total | メモ |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| fake ASR/翻訳 + Qwen3-TTS Base | `ja-JP -> zh-CN` | cached model / subprocess | 約0秒 | 約0秒 | 約20.5秒 | 約20.5秒 | `voice_mode=clone`。CPU/manual PyTorch経路。 |
| faster-whisper turbo + Qwen3-4B + Qwen3-TTS Base + Seed-VC | `id-ID -> ja-JP` | cached model / subprocess | 約8.4秒 | 約26.8秒 | 約149.8秒 | 約219.2秒 | `voice_mode=convert`。短い会話サンプルでのCPU実行。Seed-VCは約34.3秒。 |

現時点の最大ボトルネックは、cold start時のモデルロードとQwen3-TTS/Seed-VCのサブプロセス実行である。

声質クローン経路では、Qwen3-TTSとSeed-VCのサブプロセス起動、モデルロード、CPU実行が支配的になる。低遅延化する場合は、GPU上で常駐worker化するか、ストリーミング可能なTTS/VC経路へ分ける。

## GPUサーバーでの見込み

GPU上の実測は未取得。以下は、現在のローカル実測と各モデルの公開ベンチマークからの見積もりであり、RunPod等へ載せた後に同じbenchmark CLIで更新する。

- ASRは、`faster-whisper` を `device=cuda`、`compute_type=float16` または `int8_float16` で動かすと大きく短縮できる見込み。公開ベンチマークでは、RTX 3070 Ti上で約13分音声のlarge-v2処理がfp16で約63秒、batch処理で約17秒まで短縮されている。短い入力では、現在の約8.4秒から数秒以下を目標にする。
- 翻訳は、Qwen3-4BをGPU常駐させるとCPU実行の約26.8秒から大きく短縮できる見込み。短文中心なら数秒以内を目標にし、品質不足が残る場合はQwen3-8B、14B、32Bなど上位モデルをGPUメモリに応じて比較する。
- TTSと声質変換が最大のボトルネック。現在はQwen3-TTSが約149.8秒、Seed-VCが約34.3秒かかっている。GPU化、常駐worker化、Seed-VCのdiffusion steps削減、ストリーミング化を行うと、まずは数十秒以下、次に1桁秒から十数秒の体感を目標にする。
- 「話し終わったらすぐ再生開始」に近づけるには、同期APIのまま全工程を待つのではなく、ASR、翻訳、TTS、声質変換を常駐workerでpreloadし、可能なら音声をチャンク単位で流す設計が必要になる。

上位モデル候補:

- ASR: `faster-whisper large-v3`、`distil-large-v3`、`Qwen3-ASR-1.7B`。Qwen3-ASRはインドネシア語、日本語、中国語を含む多言語ASRとして比較対象にする。
- 翻訳: Qwen3-4Bを基準に、GPUメモリに応じてQwen3-8B以上を比較する。翻訳品質がMVPの主要課題になった場合は、外部APIとのコスト・品質比較を別途行う。
- TTS/声質: Qwen3-TTS Base/CustomVoice、Seed-VCを比較する。速度優先時はSeed-VCのdiffusion stepsを下げ、品質優先時はstepsを上げて比較する。

参考:

- `faster-whisper`: https://github.com/SYSTRAN/faster-whisper
- `Qwen3-4B`: https://huggingface.co/Qwen/Qwen3-4B
- `Qwen3-ASR-1.7B`: https://huggingface.co/Qwen/Qwen3-ASR-1.7B
- `Qwen3-TTS-12Hz-1.7B-Base`: https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base
- `Seed-VC`: https://github.com/Plachtaa/seed-vc

Phase 4で追加した改善:

- `timings_ms.total` を追加した。
- `voice_mode=convert` で `timings_ms.voice_conversion` を返す。
- 同じpipelineを再利用するbenchmark CLIを追加した。
- `MO_PRELOAD_MODELS=1` で起動時preloadを選べるようにした。
