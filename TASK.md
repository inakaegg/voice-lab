# TASK - SpeakLoop

## 現在の状態

- 公開ポートフォリオの主機能はSpeakLoop。
- SpeakLoopは母語録音、学習文と模範音声の生成、復唱録音、ASR比較、フレーズ単位の聞き比べまで実装済み。
- 「自分の声」は同じ送信で最初に録音した本人音声だけを参照し、変換に失敗しても通常のお手本音声へfallbackする。
- ローカルFastAPI版とCloudflare Worker公開版を持ち、GPU処理はprivateなRunPod Serverlessへ分離している。
- Cloudflareの現在版はproduction公開環境へ反映済み。公開版の利用者音声と生成音声はVoice Labの履歴へ保存しない。
- quota・監査情報はD1、短期jobとbinding不足時のfallbackはKVを使う。平文emailを含む旧quota keyは削除済み。
- 公開UIはVite、React、TypeScript、Tailwind CSS v4とrepo所有のshadcn/ui部品を使う。
- Python／Nodeの通常CIとPlaywrightの3 viewport E2Eを持ち、GPU smokeは費用確認後の手動workflowへ分離している。
- Gitleaksはcommit前にstaged差分、push前にGit履歴全体を検査し、全branchへのpush・pull requestでも専用CIが再検査する。
- GitHub repositoryは公開向けREADMEと状態文書の整理中のためprivate。文書PRのmergeと再監査後に再公開する。
- Docker HubのRunPod image repositoryはprivateで、認証済みのRunPod cold startを確認済み。
- Voice Lab本体の非OSS権利表示、第三者依存一覧、frontend bundleのライセンス本文自動生成を維持する。

## 完了条件として維持する検証

```sh
gitleaks git --redact --log-opts='--all' .
python3 -m pytest
npm test
npm run check:js
npm run check:web
npm run test:e2e
git diff --check
```

RunPod、GPU、外部APIを使うスモークは、モデル非依存テストが通った後に必要最小限だけ実施する。

## 次に行うこと

1. SpeakLoop中心のREADME・公開状態文書をreview-ready PRとしてmerge可能にする。
2. PRのCIとCodexレビューが完了し、未解決のactionable threadが0件であることを確認する。
3. 再公開直前にGit履歴全体をGitleaksで検査する。
4. GitHub repositoryをpublicへ戻し、Secret scanning、Push Protection、Private vulnerability reporting、Dependabot alerts、`main`保護を再確認する。
5. GitHubトップと公開デモの主要導線を匿名でsmoke確認する。

## 仕様の正

- 全体仕様: [docs/speech-translation/SPEC.md](docs/speech-translation/SPEC.md)
- Cloudflare: [docs/deployment/CLOUDFLARE.md](docs/deployment/CLOUDFLARE.md)
- RunPod: [docs/deployment/RUNPOD.md](docs/deployment/RUNPOD.md)
- 公開デモ改善: [docs/deployment/PUBLIC_DEMO_ROADMAP.md](docs/deployment/PUBLIC_DEMO_ROADMAP.md)
- 再公開ゲート: [docs/deployment/PUBLICATION_CHECKLIST.md](docs/deployment/PUBLICATION_CHECKLIST.md)
- データ取扱い境界: [docs/deployment/PRIVACY.md](docs/deployment/PRIVACY.md)
- 既知の制限: [docs/speech-translation/KNOWN_LIMITS.md](docs/speech-translation/KNOWN_LIMITS.md)
