# ASR・翻訳モデル評価方針

## 目的

現在のローカルMVPは、実用品質評価用の `faster-whisper turbo`、Qwen3系翻訳、Qwen3-TTS、Seed-VCを既定構成にする。実用品質を判断する前に、ASR誤認識、翻訳誤訳、TTS/VC品質を分けて評価する。

## 現状の課題

- Whisper smallでは、短い会話音声でも語の取り違えが起きる。
- NLLB distilled 600Mでは、会話文脈や口語表現の訳が不自然になる場合がある。
- 語尾や効果音を文字列としてTTSに読ませても、期待した音声表現にならない場合がある。

## 現在の実装とGPU候補

ローカルMVPの既定構成と、GPU環境で最初に比較する候補を同じ表で管理する。GPU候補は品質と速度の比較対象であり、採用は実測後に決める。

| 処理 | 現在のローカル既定 | 実際のモデル名 | GPU環境で最初に試す構成 | 比較候補 |
| --- | --- | --- | --- | --- |
| ASR | `MO_ASR_PROVIDER=faster-whisper`、`FASTER_WHISPER_MODEL=turbo` | `mobiuslabsgmbh/faster-whisper-large-v3-turbo` | 同じ `turbo` を `FASTER_WHISPER_DEVICE=cuda`、`FASTER_WHISPER_COMPUTE_TYPE=float16` または `int8_float16` で動かす。 | `Systran/faster-whisper-large-v3`、`distil-large-v3`、`Qwen/Qwen3-ASR-1.7B` |
| 翻訳 | `MO_TRANSLATION_PROVIDER=qwen3` | `Qwen/Qwen3-4B` | 同じ `Qwen/Qwen3-4B` を `QWEN_TRANSLATION_DEVICE_MAP=auto` でGPU常駐させる。 | `Qwen/Qwen3-8B`、`Qwen/Qwen3-14B`、`Qwen/Qwen3-32B`、外部翻訳API |
| TTS | `MO_TTS_PROVIDER=qwen-seed-vc`、`QWEN_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-1.7B-Base` | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | 同じBaseモデルをGPU上で常駐化し、TTS単体速度を測る。 | 速度比較: `Qwen/Qwen3-TTS-12Hz-0.6B-Base`。声色制御比較: `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` |
| 声質変換 | `voice_mode=convert` でSeed-VC | Seed-VCの既定checkpoint。明示する場合は `SEED_VC_CHECKPOINT` と `SEED_VC_CONFIG` を指定する。 | Seed-VCをGPUで実行し、`SEED_VC_DIFFUSION_STEPS`、`SEED_VC_FP16`、`SEED_VC_INFERENCE_CFG_RATE` を比較する。 | Seed-VCの高品質steps設定、OpenVoiceV2、CosyVoice系 |

## ASR候補

| 候補 | 位置づけ | 備考 |
| --- | --- | --- |
| faster-whisper turbo | 既定候補 | large-v3系の高速候補。音声翻訳ではなく文字起こし用途で評価する。 |
| faster-whisper large-v3 | 精度比較候補 | turboより重い。GPU環境で比較する。 |
| faster-whisper distil-large-v3 | 速度比較候補 | GPU環境で比較する。 |

参考:

- faster-whisper: https://github.com/SYSTRAN/faster-whisper

## 翻訳候補

| 候補 | 位置づけ | 備考 |
| --- | --- | --- |
| Qwen3 4B系 | 既定候補 | インドネシア語、日本語、中国語を含む多言語対応。CPU/MPSでは遅い可能性があるため、RunPod GPUでも確認する。 |
| Qwen3 8B以上 | 品質比較候補 | 4Bより重い。GPU環境で比較する。 |
| 外部翻訳API | 品質比較候補 | DeepLやOpenAI APIなど。導入前に費用、キー管理、依存リスクを仕様化する。 |

参考:

- Qwen3: https://qwenlm.github.io/blog/qwen3/

## 要件未達だった旧構成

以下はMVPの品質要件を満たさなかったため、現在の実装候補から外す。再導入は、明確な品質改善理由がある場合だけ別途検討する。

| 旧構成 | 結果 |
| --- | --- |
| OpenAI Whisper small | インドネシア語の短い会話音声で語の取り違えが出た。 |
| NLLB distilled 600M | 会話文脈や口語表現の訳が不自然で、翻訳の抜け落ちも出た。 |

## 評価方法

1. 同じ入力音声でASRだけを比較する。
2. 正しい文字起こしを固定し、翻訳だけを比較する。
3. 翻訳文を固定し、TTS/VCだけを比較する。
4. 速度はcold startとwarm状態を分けて記録する。

provider差し替え後も、同じ評価入力で候補間を比較できるようにする。
