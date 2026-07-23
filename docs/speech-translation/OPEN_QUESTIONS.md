# 未決定事項

更新日: 2026-07-23

現在の実装仕様は [SPEC.md](SPEC.md) を正とする。この文書には、実装済みの過去の検討事項を残さず、判断が必要な事項だけを記録する。

## 公開境界と構成分離

- production内では単一Workerを正とする。staging Workerは別resourceで配備し、必須Worker secretも登録済みである。Googleログインの実操作確認は未実施である。
- SkitVoice/VibeVoiceは一般公開せず、同一Worker内でも管理者研究境界へ閉じる。
- secret、障害、デプロイ権限の物理分離が必要になった場合だけ、SpeakLoopと研究用SkitVoiceのWorker分割を再検討する。

## 対応ブラウザ

- Chromium系以外の録音形式を正式対応範囲へ含めるか。タブ音声共有は管理者研究画面だけの検討対象とする。

## SpeakLoopの採点対象

- 現行実装は、目標文 `target_text` と復唱録音のASR本文 `recognized_text` を比較してscore・grade・diffを計算する。目標文は翻訳で確定したものを使う。お手本音声のASR本文 `model_recognized_text` は、お手本側のphrase割当と再生区間の取得に使うが、採点計算には使わない。
- お手本ASR本文と復唱ASR本文を直接比較する方式、または現行方式と併用する方式の方が、同じASRによる表記揺れや認識傾向を相殺できるかは未評価である。一方、お手本側のASR誤認識を採点の正にすると、正しく復唱した利用者を誤って減点する可能性がある。
- 採点対象は現時点では変更しない。変更を検討する場合は、目標文とお手本ASR本文と復唱ASR本文を揃えた複数の実録音を使う。同じデータ上で現行方式、ASR本文同士の比較、併用方式を比較し、改善数と悪化数を確認してから判断する。

## VibeVoice・Seed-VCの配布境界

- Microsoft公式によるVibeVoice TTSコード削除後も、固定modelと第三者実装をprivate/admin-only研究で継続するか。一般向けinteractive generationを再開する判断とは分ける。
- Seed-VC GPL-3.0とVoice Lab本体・subprocess・Docker imageの境界について、どのsource、license、noticeを配布物へ含めるか。
