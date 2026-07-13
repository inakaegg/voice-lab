# 公開デモ・ポートフォリオ準備

更新日: 2026-07-13

## 現在地

- Voice Labポータル、SpeakLoop、SkitVoiceをCloudflare Worker Static Assetsで公開済み。
- Google OAuth、管理者認証、feature別quota、入力上限、監査ログを実装済み。
- quota・監査・公開サンプルmetadataはD1、音声blobはR2へ保存済み。
- VibeVoice・Seed-VCはRunPod Serverlessへ分離済み。
- Python/Node CI、React production build、Playwright 3 viewport E2Eを実装済み。
- Git履歴のgitleaks検査、Security policy、Dependabot設定を追加済み。
- `/fun`は管理者専用の実験画面とし、旧routeは廃止済み。

## 公開前に残る作業

### 外部素材・ユーザー判断が必要

1. SkitVoiceの英語、中国語、日本語サンプル音声を管理画面から登録する。
2. SpeakLoopのサンプルを汎用1件のままにするか、英語・中国語別へ拡張するか決める。
3. サンプル反映後、PCとスマートフォンの公開用スクリーンショットを撮影する。
4. OSSライセンスを付けるか、閲覧目的のソース公開にするか決める。
5. GitHub repositoryをpublicへ切り替える時点を決める。

### 公開直前の確認

1. 公開Workerでトップ、OAuth、SpeakLoop、SkitVoice、管理ログインをsmoke確認する。
2. `/fun`が未認証では管理ログインへ遷移し、認証後だけ表示されることを確認する。
3. 廃止routeと旧HTML直指定が404になることを確認する。
4. `gitleaks git --log-opts='--all' .` でGit履歴全体を検査する。
5. READMEへ確定したスクリーンショットを追加し、デモURLを最上部から到達可能にする。
6. GitHub description、homepage、topicsを設定する。

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
