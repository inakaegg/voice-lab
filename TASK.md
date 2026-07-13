# TASK - Voice Lab

## 現在の状態

- 公開ポータルの主機能は、発音練習のSpeakLoopと複数話者音声生成のSkitVoice。
- ローカルFastAPI版とCloudflare Worker公開版を持ち、GPU処理はRunPod Serverlessへ分離している。
- SpeakLoopは母語録音、翻訳、模範音声、復唱録音、ASR比較、フレーズ単位の比較再生まで実装済み。
- SkitVoiceは最大4話者、VibeVoice生成、ASR timestampによる再配置、低スコア行再生成、Seed-VC後処理まで実装済み。
- 参照音声はローカル版でファイル、マイク、タブ音声、URL切り出しの4方式、Cloudflare版でURLを除く3方式を提供する。
- Cloudflare WorkerはGoogleログイン、feature別quota、入力上限、管理者除外、管理画面、簡易監査ログ、公開サンプル音声を実装済み。
- 公開サンプル音声はローカルFastAPIでも管理画面から永続保存でき、保存・削除時の処理中／成功／失敗をボタンと状態欄へ表示する。
- quota・監査・公開サンプルmetadataはD1、公開サンプル音声blobはR2へ移行済みで、bindingなし環境向けのKV fallbackを維持している。ユーザー音声履歴はローカル版だけで保存する。
- 公開ポータル、SpeakLoop、SkitVoiceはVite + React + TypeScript、共通UI生成基盤はTailwind CSS v4とrepo所有のshadcn/ui部品へ移行済み。管理・互換画面も共通Tailwind buildを使う。
- Python/Nodeの通常CIとPlaywrightの3 viewportレイアウトE2Eを持ち、RunPod image buildとGPU smokeは手動workflowに分離している。
- `/fun` はCloudflareで管理者認証済みの場合だけ利用できる実験画面とし、旧routeは削除済み。

## 完了条件として維持する検証

```sh
python3 -m pytest
npm test
npm run check:js
npm run check:web
npm run test:e2e
```

RunPod・GPU・外部APIを使うスモークは、上記のモデル非依存テストが通った後に必要最小限だけ実施する。

## 次に外部環境で行うこと

1. SkitVoiceの英語・中国語・日本語サンプル生成物を管理画面から登録する。
2. 最終コピーとサンプル反映後に、公開用のPC／スマホスクリーンショットを取得する。
3. GitHub repositoryをpublicへ切り替える。
4. RunPod imageまたは外部API経路を変更した場合だけ、費用を確認して最小の公開環境smokeを再実行する。

SpeakLoopはサンプル音声なし、ライセンスは明示的な再利用許諾なしで公開する方針を決定済み。

## 仕様の正

- 全体仕様: [docs/speech-translation/SPEC.md](docs/speech-translation/SPEC.md)
- SkitVoice: [docs/speech-translation/VIBEVOICE.md](docs/speech-translation/VIBEVOICE.md)
- Cloudflare: [docs/deployment/CLOUDFLARE.md](docs/deployment/CLOUDFLARE.md)
- 公開デモ改善: [docs/deployment/PUBLIC_DEMO_ROADMAP.md](docs/deployment/PUBLIC_DEMO_ROADMAP.md)
- 既知の制限: [docs/speech-translation/KNOWN_LIMITS.md](docs/speech-translation/KNOWN_LIMITS.md)
