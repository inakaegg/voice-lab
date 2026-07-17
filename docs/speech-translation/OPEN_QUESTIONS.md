# 未決定事項

更新日: 2026-07-16

現在の実装仕様は [SPEC.md](SPEC.md) を正とする。この文書には、実装済みの過去の検討事項を残さず、判断が必要な事項だけを記録する。

## 公開後の構成分離

- 現在は単一Workerを正とする。
- 利用量、障害分離、secret分離の必要が生じた場合だけ、SpeakLoopとSkitVoiceのWorker分割を再検討する。

## 対応ブラウザ

- Chromium系以外の録音形式とタブ音声共有を、正式対応範囲へ含めるか。

## 公開デモのデータ保持

- D1のaudit event、日次・累計quota、KV fallbackをそれぞれ何日保持するか。
- 期限切れデータの自動削除、削除依頼、本人確認、連絡先をどう運用するか。
- Google署名cookieの既定30日を維持するか、短縮するか。
- legacy KVに残り得る平文email key／eventを、公開環境でいつ確認・削除するか。

## VibeVoice・Seed-VCの公開配布

- Microsoft公式によるVibeVoice TTSコード削除後も、固定modelと第三者実装を公開デモで継続するか。
- Seed-VC GPL-3.0とVoice Lab本体・subprocess・Docker imageの境界について、どのsource、license、noticeを配布物へ含めるか。
