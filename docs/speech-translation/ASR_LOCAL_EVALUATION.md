# ローカルASR合成コーパス評価

更新日: 2026-07-18

## 目的

ローカルASRの探索用corpusでは、同じ音声へfaster-whisperとFunASRを入力し、次を分けて測る。

1. 正しく発音された合成音声をASRがどこまで正しく認識できるか。
2. 学習者が起こしやすい誤りをASRが目標文へ過剰補正せず観測できるか。
3. ASR本文、採点、フレーズ比較再生のどの層に誤差が入るか。

この評価はASRモデルのfine-tuning用training corpusではない。製品の比較再生評価とは役割を分ける。

製品の復唱ASRは、中国語がFunASR `paraformer-zh`、英語がOpenAI `whisper-1` である。ローカルfaster-whisperはOpenAI `whisper-1` と同じprovider・model・timestamp実装ではないため、英語の製品精度を代替評価しない。製品経路を最後まで評価するpaired corpusは中国語だけを対象とし、[ASR_COMPARISON_PAIRED_PILOT.md](ASR_COMPARISON_PAIRED_PILOT.md) を正とする。

## データの役割

第1pilotのmanifestは [asr_learning_samples_manifest.json](../../tests/fixtures/asr_learning_samples_manifest.json)、第2pilotは [asr_learning_samples_manifest_pilot_2.json](../../tests/fixtures/asr_learning_samples_manifest_pilot_2.json) とする。音声とASR出力は再生成できるローカルartifactであり、`tmp/` に置いてgit管理しない。

| source kind | 作るもの | 分かること | 分からないこと |
| --- | --- | --- | --- |
| `apple_tts_native` | 中国語・英語voiceの正答音声 | ASR側のnative synthetic ceiling | 実際の学習者発話での精度 |
| `apple_tts_text_substitution` | 声調、子音、語、脱落、重複を別の文字列として発話 | 意図した音節・内容誤りをASRが観測するか | 同一話者が自然に誤発音した音響 |
| `apple_tts_pitch_manipulated` | Praatで特定音節のF0 contourを平坦化・反転 | 声調contour変化へのASRの反応 | 母音、子音、共調音を伴う完全な声調誤り |
| `apple_tts_cross_language_phonetic` | 日本語・英語voiceに音写を発話させたstress test | 強い非ネイティブ風入力への耐性 | 特定母語話者の代表的な訛り |
| `apple_tts_acoustic_variant` | 速度、ポーズ、雑音、音量、帯域、反響を変えた音声 | 流暢性・収録条件への耐性 | 発音器官由来の学習者誤り |

Apple TTS音声を「実学習者音声」または「自然な非ネイティブ音声」と表現しない。pitch加工とcross-language音写はproxyとして別集計する。

## 依存関係

Python 3.11の専用venvを推奨する。

```sh
python3.11 -m venv tmp/local-asr-venv
tmp/local-asr-venv/bin/python -m pip install -e ".[dev,local,funasr,asr-eval]"
```

`asr-eval`は評価専用のPraat Parselmouthを追加する。製品runtime、Cloudflare Worker、RunPod imageには含めない。

macOSの `say` と `ffmpeg` が必要である。manifestで指定するApple voiceが未導入の場合は、システム設定から該当voiceを追加する。

## モデルと保存先

モデルはリポジトリ外へ置く。保存先を `MODEL_CACHE_DIR` で明示し、空き容量を確認してから初回downloadを許可する。

```sh
export MODEL_CACHE_DIR=/path/to/models/mo-asr
```

| provider | model | 実行設定 | 用途 |
| --- | --- | --- | --- |
| faster-whisper | `turbo`（Whisper large-v3-turbo CTranslate2変換） | macOS CPU / int8 | 探索用のローカル参考値。英語製品経路の代替にはしない |
| FunASR | `funasr/paraformer-zh` | macOS CPU | 中国語ASR |
| FunASR VAD | `funasr/fsmn-vad` | macOS CPU | 発話区間 |
| FunASR punctuation | `funasr/ct-punc` | macOS CPU | 句読点復元 |

モデル取得元、package version、resolved revision、実行日時は `transcriptions.json` に記録する。FunASR toolkitとmodel weightのlicenseを混同せず、model cardのlicenseも確認する。

## 実行

音声生成:

```sh
tmp/local-asr-venv/bin/python scripts/local_asr_corpus.py generate
```

両ASRの文字起こし:

```sh
tmp/local-asr-venv/bin/python scripts/local_asr_corpus.py transcribe \
  --model-cache-dir "$MODEL_CACHE_DIR" \
  --whisper-model turbo
```

両方を続けて実行:

```sh
tmp/local-asr-venv/bin/python scripts/local_asr_corpus.py all \
  --model-cache-dir "$MODEL_CACHE_DIR" \
  --whisper-model turbo
```

第2pilotはmanifestと出力先を分けて実行する。別pilotの実行中に既存manifestを変更し、記録済みhashと内容を不一致にしない。

```sh
tmp/local-asr-venv/bin/python scripts/local_asr_corpus.py all \
  --manifest tests/fixtures/asr_learning_samples_manifest_pilot_2.json \
  --output-dir tmp/asr-learning-samples-pilot-2 \
  --model-cache-dir "$MODEL_CACHE_DIR" \
  --whisper-model turbo
```

生成物:

```text
tmp/asr-learning-samples/
  audio/                 16kHz mono PCM WAV
  raw/                   Apple TTS・加工途中の音声
  generation.json        音声hash、長さ、生成条件
  transcriptions.json    provider別本文、timestamp、所要時間、評価値
  report.md              provider summaryとcase別比較表
```

文字起こし時は、現在のmanifestと `generation.json` の `manifest_sha256` が一致する必要がある。manifestを変更した場合は、case IDが同じでも既存音声を評価へ流用せず、先に音声を再生成する。

## 評価面

各caseは次の2つを分ける。

- `target_text`: 学習者へ提示した正解文。
- `expected_spoken_text`: 合成音声で実際に発話させた内容。

ASR精度はASR本文と `expected_spoken_text` の類似度で測る。練習採点への影響はASR本文と `target_text` の類似度で測る。意図的誤りのcaseでは、前者が後者を上回る場合だけ「ASRが誤りを観測できた」と数える。テスト期待値を現在のASR出力へ合わせて書き換えない。

pitch加工のcaseは文字列上の正誤が同じため、`error_was_observable` の件数へ混ぜない。F0 contour、ASR本文、実音声の人手確認を別々に扱う。

## 小規模pilotと大量化の条件

第1pilotは20件（中国語16件、英語4件）、第2pilotは20件（中国語18件、英語2件）で構成する。第2pilotでは声調・子音・語末鼻音、脱落・挿入・語順、フィラー・途中停止、低音量・帯域制限・反響を追加する。大量生成へ進む前に次を満たす。

1. 全音声が16kHz mono PCM WAVとして生成され、hashと生成条件が残る。
2. 正答音声、文字列置換、pitch加工、cross-language音写、速度・ポーズの各方式について、少なくとも1件は意図した音響またはASR stressとして成立する。
3. 正答音声でASRが誤るcaseを、学習者の誤りとして数えない。
4. 文字列置換caseでは、ASRが `expected_spoken_text` を認識したかと、目標文へ言語モデル補正したかを分けて報告する。
5. pitch加工とcross-language音写は代表音声を人が聴き、意図したproxyになっていないcaseを除外する。
6. 実学習者録音を最後まで未使用のholdoutとして残し、合成音声だけで採用判断しない。

探索用ASR corpusを増やす場合、次段階は50〜100件に限定し、case category、Apple voice、速度、誤り位置の組み合わせを固定して同じmanifestから生成する。次の場合は残件へ進まない。

- 正答音声での誤認識が多く、ASR側のceilingと学習者誤りを分離できない。
- proxy音声が人の聴取で意図した誤りに聞こえない。
- 合成pilotで選んだ変更が実学習者holdoutを改善しない、または悪化させる。
- 生成数だけ増え、製品の採点・比較再生の改善指標が定義できない。

中国語の製品比較再生については、別のpaired corpusで3→6→12→24→48→96→192→384件の累積評価を完了した。2026-07-18時点の最終結果は371/384であり、合成proxyの限界と残存失敗を [ASR_COMPARISON_PAIRED_PILOT.md](ASR_COMPARISON_PAIRED_PILOT.md) に記録する。

## 出典

- FunASR repository: <https://github.com/modelscope/FunASR>
- faster-whisper repository: <https://github.com/SYSTRAN/faster-whisper>
- Paraformer-zh model card: <https://huggingface.co/funasr/paraformer-zh>
- FSMN-VAD model card: <https://huggingface.co/funasr/fsmn-vad>
- CT-Punc model card: <https://huggingface.co/funasr/ct-punc>
- Whisper large-v3-turbo CTranslate2 model card: <https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo>
- Parselmouth pitch manipulation: <https://parselmouth.readthedocs.io/en/stable/examples/pitch_manipulation.html>

確認日: 2026-07-17
