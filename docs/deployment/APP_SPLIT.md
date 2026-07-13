# SpeakLoop / SkitVoice分割判断

更新日: 2026-07-13

## 現在の判断

公開版は単一の`voice-lab` Workerを正とする。ポータル、2つの公開アプリ、3つの管理画面、実験画面を同じWorkerから配信し、共通のOAuth、quota、D1、R2、KVを使う。

構成を分割すること自体をロードマップ上の未完了タスクにはしない。

## 分割を再検討する条件

次のいずれかが実際の問題になった場合に限り、別Worker化を検討する。

- SpeakLoopとSkitVoiceで公開範囲や利用者が異なる
- RunPod secretをSkitVoice側だけへ限定する必要がある
- 一方の障害やデプロイを他方から分離する必要がある
- quota、費用、監査を製品単位で独立管理する必要がある
- URLまたはブランドを別製品として分ける

## 分割する場合の境界

- 共通コードは同じrepoで維持し、Worker設定とbindingだけを環境別に分ける。
- SpeakLoop WorkerはRunPod secretを持たない構成を優先する。
- SkitVoice WorkerだけがVibeVoice/Seed-VC endpointへ接続する。
- D1/R2/KVを共有するか分けるかは、移行前にデータ所有者とmigrationを文書化する。
- 現URLからのredirect、OAuth callback、管理route、CORS、secret再登録を移行計画へ含める。

分割前後の現在構成は [ARCHITECTURE.md](ARCHITECTURE.md) を正とする。
