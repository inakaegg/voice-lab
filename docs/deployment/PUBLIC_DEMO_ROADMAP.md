# 公開デモ・ポートフォリオ準備

更新日: 2026-07-17

## 現在地

- Voice LabポータルとSpeakLoopを一般公開の中心とし、SkitVoice/VibeVoiceを管理者専用研究機能へ閉じる変更はmerge済みmainのpreviewで検証済み。本番未deployのためproduction公開環境へ反映済みとは扱わない。
- Google OAuth、feature別quota、入力上限、管理者認証、簡易監査ログを実装済み。
- quota・監査・公開サンプルmetadataはD1、公開サンプル音声blobはR2へ保存し、ユーザー音声履歴はCloudflare版で保存しない。
- Seed-VCと管理者専用VibeVoiceはprivateなRunPod Serverlessへ分離する前提である。
- Python/Node CI、React production build、Playwright 3 viewport E2Eを実装済み。
- Git履歴の手動Gitleaks検査、commit前・push前のGit hook、Security policy、Dependabot設定に加え、全branchへのpush・pull requestでGitleaksを再実行するCI jobを追加した。GitHub Push Protectionの有効化と実確認は外部作業として残っている。
- frontend bundleの依存ライセンス本文をbuild時に生成し、wheelへ同梱する。
- GitHub repositoryは誤ってpublicにした状態から、公開前再監査のためprivateへ戻した。
- Docker HubのRunPod image repositoryは公開状態の解消が外部作業として残っている。

## 公開判断

現時点では公開再開不可とする。blocking項目、外部設定、確認証拠は [Repository・公開デモの公開前チェックリスト](PUBLICATION_CHECKLIST.md) を正とする。

主なblocking項目は次のとおり。

1. Docker Hub imageのprivate化または不要tag削除と、認証なしpull拒否の確認。
2. Seed-VC GPL-3.0、VibeVoiceの現在のupstream状態、public container imageの権利・配布条件の確認。
3. audit・quotaの保持期間、削除手段、連絡先を含む正式なプライバシーポリシーの確定。
4. Private vulnerability reporting、Secret scanning、GitHub Push Protection、Dependabot alerts、branch protection等のGitHub公開設定。
5. 到達不能なGitHub Homepageの修正、不要remote branch整理、READMEスクリーンショット。
6. RunPod operation別の実行時間、policy値、platform側job/result/log保持のowner確認。

Voice Lab本体にはOSSライセンスを付与せず、ポートフォリオとして閲覧可能にする方針を維持する。第三者コンポーネントにはそれぞれのライセンスが適用されるため、本体の権利表示と混同しない。

## 完了済みの技術確認

1. 旧production Workerでトップ、OAuth開始、SpeakLoop、SkitVoiceをsmoke確認した。今回のSkitVoice閉鎖はpreviewで確認済みだが本番未deployであり、公開URLでの再確認が必要である。
2. 管理route、旧route・旧HTML直指定、公開サンプル配信、OpenAI／RunPod接続を確認した。
3. Cloudflare版の旧音声履歴KV／R2データを削除した。
4. Git履歴全体をGitleaksで検査し、2026-07-16の監査時点で検出0件を確認した。
5. `_ai/`、`tmp/`、`.env`、`.dev.vars`、`.runpod.env`がGit管理外で、履歴にも含まれないことを確認した。

上記は再公開時点の外部状態を保証しない。公開直前に同じ確認を再実行する。

## 公開後に検討する改善

- SpeakLoopとSkitVoiceの旧controllerをreducer/hooksへ小単位で移し、compatibility CSSを縮小する。
- Safari/Firefoxとスマートフォン実機の録音形式・共有音声対応を整理する。
- 利用量や障害分離の必要が出た場合だけWorker分割を検討する。
- RunPodのcold start、queue、GPU費用を実測し、必要ならwarmup運用を調整する。

## 自動検証

```sh
python3 -m pytest
npm test
npm run check:js
npm run check:web
npm run test:e2e
```

自動検証に加え、公開URLの主要導線、認証、サンプル再生、生成、モバイル表示、GitHubとDocker Hubの実設定を確認する。
