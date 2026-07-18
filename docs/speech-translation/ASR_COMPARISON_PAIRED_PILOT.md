# 中国語ASR比較再生 Paired Corpus

更新日: 2026-07-18

## 目的

正しいお手本音声と、学習者が起こしやすい誤りを含む復唱音声を対で生成し、実FunASR本文・timestampからSpeakLoopのcanonical alignmentとUI playback planまでをend-to-end評価する。

この評価はASRモデルの文字起こし精度を競わせるものではない。FunASRが誤発音を目標語へ補完した場合も含め、正しいtarget phraseへ安全な再生rangeを割り当て、お手本と復唱を同じphrase indexで比較再生できるかを測る。

製品の復唱ASRは、中国語がFunASR `paraformer-zh`、英語がOpenAI `whisper-1` である。ローカルfaster-whisperをOpenAI `whisper-1` の代替とみなせないため、このpaired corpusは中国語だけを評価対象とする。

## 正の入力と生成物

正のfixtureは [asr_comparison_pair_corpus.json](../../tests/fixtures/asr_comparison_pair_corpus.json) とする。384件、22カテゴリで、各caseは次を持つ。

- 2〜4件の`target_phrases`
- 正しい`model`音声のphrase別segment
- 誤りを含む`attempt`音声のphrase別segment
- model側・attempt側で再生可能であるべきphrase index
- 両音声で対にできるphrase index
- 期待するUI playback mode

音声本体とASR出力は再生成可能なローカルartifactとして`tmp/asr-comparison-pair-corpus/`へ置き、git管理しない。fixture期待値は実ASR出力を見る前に固定し、失敗を通す目的で変更しない。

## 発話と収録条件のバリエーション

Apple TTSへ正答文または誤り文を入力し、必要に応じてPraatまたはffmpegで音響条件を変える。

- 声調、声母、韻母、語、助数詞の置換
- 脱落、挿入、語順変更、途中終了、自己訂正、フィラー、code-switch
- 正答発話によるnative synthetic ceiling
- slow、fast、quiet、lowpass、light-noise、room-echo
- F0輪郭のflat、rising、falling
- short-pauses、long-pauses
- 中国語以外のApple voiceを使ったcross-language accent proxy

F0は基本周波数であり、Praat加工は声質変換ではない。文字列を変えずに高さの時間変化を平坦・上昇・下降へ変える。語や音節の置換は、Apple TTSへ渡す文字列自体を変える別方式である。

Apple TTSと音響加工は、実学習者音声や自然な非ネイティブ訛りの代替ではない。比較処理を壊しやすい条件を再現する合成proxyとして扱う。

## 評価軸

次を別々に評価する。

1. model側phrase ownershipと再生range
2. attempt側phrase ownershipと再生range
3. model・attemptで共通するpaired phrase index
4. UI playback mode
5. 生成時の正解rangeとASR由来rangeのIoU
6. rangeが隣接する別phraseの実音声を含まないこと

minimum range IoUは`0.65`とする。ASR本文の文字一致率や`content_matched`は診断として保存するが、目標語への推測補完だけを比較処理の失敗に数えない。

存在しないphraseへのrange割当、隣接phraseを含むrange、modelとattemptで異なるphraseを対にする結果はblocking failureとする。

## 製品実装のtimestamp処理

FunASRの認識本文は変更しない。次の条件でtimestampだけを精密化する。

- FunASRの元timestampを`raw_start`／`raw_end`として保持する。
- targetと認識本文のlexical alignmentからtoken境界候補を作る。
- 音声から独立に検出した0.12秒以上の無音だけを境界根拠に使う。
- raw timestampを無音候補の優先根拠に使うのは、phraseの未割当と未割当の非フィラー音声が同時に残る場合、または文末記号が低一致のlexical境界を近傍で訂正する場合に限る。完全なlexical alignmentや、語彙的に一致する後続phraseの境界はraw timestampや生成句読点で上書きしない。
- 句順、非フィラーchunk、他targetとの非競合、lexical evidenceが揃う場合だけ低信頼rangeを補う。
- 根拠が不足する場合はraw timestampまたは`available=false`を維持し、別ASRへ切り替えない。
- RunPodの実経路では、一時音声が存在する間にmodel音声とattempt音声の両方へ同じ処理を適用する。

ASRへ渡すのは録音またはお手本の元音声であり、Seed-VC等の声質変換後音声ではない。

## 段階評価結果

| 累積case数 | 合格 | 不合格 | 判断 |
| ---: | ---: | ---: | --- |
| 3 | 3 | 0 | pilot合格 |
| 6 | 6 | 0 | 継続 |
| 12 | 12 | 0 | 継続 |
| 24 | 24 | 0 | 継続 |
| 48 | 48 | 0 | 継続 |
| 96 | 96 | 0 | 継続 |
| 192 | 192 | 0 | 継続 |
| 384 初回 | 366 | 18 | 実装修正 |
| 384 最終 | 371 | 13 | 採用、既知限界を記録 |

384件での初回から最終への差は5件改善、既存合格ケースの新規悪化0である。最終合格率は96.6%だが、合成proxyでの値であり、実学習者発話の精度を意味しない。

残存13件は、short-pauses 6件、rising-F0 3件、falling-F0 2件、flat-F0 1件、long-pauses 1件である。主な失敗はrange IoU不足、隣接phrase音声の混入、ASR観測だけでは意図した誤りと無関係発話を区別できないphrase ownership不足である。

0.08秒の短休止、target位置優先、target句長比からの境界追加を組み合わせた候補は、局所caseを改善した一方、384件全体で337/384まで悪化したため撤回した。合成時に意図した誤りだと分かっていても、実アプリが持たない生成metadataを根拠にrangeを割り当てない。

## 実行

```sh
tmp/local-asr-venv/bin/python scripts/local_asr_comparison.py generate \
  --manifest tests/fixtures/asr_comparison_pair_corpus.json \
  --output-dir tmp/asr-comparison-pair-corpus \
  --case-limit 384

tmp/local-asr-venv/bin/python scripts/local_asr_comparison.py evaluate \
  --manifest tests/fixtures/asr_comparison_pair_corpus.json \
  --output-dir tmp/asr-comparison-pair-corpus \
  --case-limit 384 \
  --model-cache-dir "$MODEL_CACHE_DIR"
```

生成物:

```text
audio/                    model・attempt WAV
raw/                      Apple TTSと加工途中の音声
generation.json           phrase別正解range、音声hash、生成条件
comparison-results.json   ASR、両側alignment、UI playback plan、評価結果
report.md                 case別の比較表
```

同一manifest・同一音声を再利用する再生成では、最初の生成時刻とgenerator情報を保持する。音声とphrase rangeが変わらなければ `generation.json` のSHA-256も変わらず、既存評価を無関係な実行時刻だけで失効させない。

## 次の検証

実学習者録音を、合成データでの調整に使わないholdoutとして収集する。母語、習熟度、発話速度、録音環境を分け、合成corpusで採用した処理が実録音でも改善し、既存正常例を悪化させないことを確認する。
