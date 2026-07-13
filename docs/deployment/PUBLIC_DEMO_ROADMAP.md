# 公開デモ・ポートフォリオ準備

更新日: 2026-07-13

## 現在地

- Voice Labポータル、SpeakLoop、SkitVoiceをCloudflare Worker Static Assetsで公開済み。
- Google OAuth、管理者認証、feature別quota、入力上限、監査ログを実装済み。
- quota・監査・公開サンプルmetadataはD1、公開サンプル音声blobはR2へ保存済み。ユーザー音声履歴は保存しない。
- VibeVoice・Seed-VCはRunPod Serverlessへ分離済み。
- Python/Node CI、React production build、Playwright 3 viewport E2Eを実装済み。
- Git履歴のgitleaks検査、Security policy、Dependabot設定を追加済み。
- `/fun`は管理者専用の実験画面とし、旧routeは廃止済み。
- SkitVoiceの英語、中国語、日本語サンプル音声を公開環境へ登録済み。
- 公開Workerの主要route、認証境界、サンプル配信、OpenAI／RunPod接続をsmoke確認済み。
- GitHub repositoryはpublicへ切り替え、description、homepage、topicsを設定済み。
- Cloudflare版で履歴保存を廃止した後、旧音声履歴のKV／R2データを削除済み。

## 公開前に残る作業

### 外部素材・ユーザー作業が必要

1. PCとスマートフォンの公開用スクリーンショットを撮影し、READMEへ追加する。

SpeakLoopにはサンプル音声を表示しない。現時点ではOSSライセンスを付与せず、ポートフォリオとしてソースを公開する。

### 完了した公開確認

1. 公開Workerでトップ、OAuth開始、SpeakLoop、SkitVoice、管理ログイン境界をsmoke確認した。
2. `/fun`が未認証では管理ログインへ遷移し、旧routeと旧HTML直指定が404になることを確認した。
3. SkitVoiceの英語、中国語、日本語サンプルが公開APIから配信されることを確認した。
4. OpenAIとRunPodの設定、RunPod healthを公開Workerのruntime APIで確認した。
5. `gitleaks git --log-opts='--all' .` でGit履歴全体を検査し、漏洩なしを確認した。
6. GitHub description、homepage、topicsを設定した。

## 公開後の改善

- SpeakLoopとSkitVoiceの旧controllerをreducer/hooksへ小単位で移し、compatibility CSSを縮小する。
- Safari/Firefoxとスマートフォン実機の録音形式・共有音声対応を整理する。
- 利用量や障害分離の必要が出た場合だけWorker分割を検討する。
- RunPodのcold start、queue、GPU費用を実測し、必要ならwarmup運用を調整する。

## 完了条件

```sh
python3 -m pytest
npm test
npm run check:js
npm run check:web
npm run test:e2e
```

上記に加え、公開URLの主要導線、認証、サンプル再生、生成、モバイル表示を実ブラウザで確認し、未確認範囲を残さない。
