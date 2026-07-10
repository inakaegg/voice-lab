# TASK - Voice Lab

## 現在の状態

- 公開ポータルの主機能は、発音練習のSpeakLoopと複数話者音声生成のSkitVoice。
- ローカルFastAPI版とCloudflare Worker公開版を持ち、GPU処理はRunPod Serverlessへ分離している。
- SpeakLoopは母語録音、翻訳、模範音声、復唱録音、ASR比較、フレーズ単位の比較再生まで実装済み。
- SkitVoiceは最大4話者、VibeVoice生成、ASR timestampによる再配置、低スコア行再生成、Seed-VC後処理まで実装済み。
- 参照音声はローカル版でファイル、マイク、タブ音声、URL切り出しの4方式、Cloudflare版でURLを除く3方式を提供する。
- Cloudflare WorkerはGoogleログイン、feature別quota、入力上限、管理者除外、管理画面、簡易監査ログ、公開サンプル音声を実装済み。
- Python/Nodeの通常CIを持ち、RunPod image buildとGPU smokeは手動workflowに分離している。

## 完了条件として維持する検証

```sh
python3 -m pytest
npm test
npm run check:js
```

RunPod・GPU・外部APIを使うスモークは、上記のモデル非依存テストが通った後に必要最小限だけ実施する。

## 次に外部環境で行うこと

1. 公開URLでGoogle OAuth、quota、管理者除外、SkitVoice生成をスモーク確認する。
2. SpeakLoopとSkitVoiceの権利確認済みサンプル音声を管理画面から登録する。
3. 実ブラウザとスマートフォンで録音、タブ音声、比較再生、レスポンシブ表示を確認し、公開用スクリーンショットを取得する。
4. 作成済みD1 bindingへquota/audit経路を段階移行する。R2はCloudflare Dashboardでアカウント機能を有効化した後、bucketとbindingを作成する。
5. 公開ユーザー画面のReact/TypeScript移行は、状態境界ごとに互換テストを追加して段階実施する。

## 仕様の正

- 全体仕様: [docs/speech-translation/SPEC.md](docs/speech-translation/SPEC.md)
- SkitVoice: [docs/speech-translation/VIBEVOICE.md](docs/speech-translation/VIBEVOICE.md)
- Cloudflare: [docs/deployment/CLOUDFLARE.md](docs/deployment/CLOUDFLARE.md)
- 公開デモ改善: [docs/deployment/PUBLIC_DEMO_ROADMAP.md](docs/deployment/PUBLIC_DEMO_ROADMAP.md)
- 既知の制限: [docs/speech-translation/KNOWN_LIMITS.md](docs/speech-translation/KNOWN_LIMITS.md)
