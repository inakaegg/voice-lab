# 未決定事項

更新日: 2026-07-16

現在の実装仕様は [SPEC.md](SPEC.md) を正とする。この文書には、実装済みの過去の検討事項を残さず、判断が必要な事項だけを記録する。

## 公開境界と構成分離

- 現在は単一Workerを正とする。
- SkitVoice/VibeVoiceは一般公開せず、同一Worker内でも管理者研究境界へ閉じる。
- secret、障害、デプロイ権限の物理分離が必要になった場合だけ、SpeakLoopと研究用SkitVoiceのWorker分割を再検討する。

## 対応ブラウザ

- Chromium系以外の録音形式を正式対応範囲へ含めるか。タブ音声共有は管理者研究画面だけの検討対象とする。

## 公開デモのデータ保持

- D1のaudit event、日次・累計quota、KV fallbackをそれぞれ何日保持するか。
- 期限切れデータの自動削除、削除依頼、本人確認、連絡先をどう運用するか。
- Google署名cookieの既定30日を維持するか、短縮するか。
- legacy KVに残り得る平文email key／eventを、公開環境でいつ確認・削除するか。

## VibeVoice・Seed-VCの配布境界

- Microsoft公式によるVibeVoice TTSコード削除後も、固定modelと第三者実装をprivate/admin-only研究で継続するか。一般向けinteractive generationを再開する判断とは分ける。
- Seed-VC GPL-3.0とVoice Lab本体・subprocess・Docker imageの境界について、どのsource、license、noticeを配布物へ含めるか。
