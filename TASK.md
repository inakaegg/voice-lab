# TASK - Voice Lab

## 現在の状態

- 公開ポートフォリオの主機能はSpeakLoop。SkitVoice/VibeVoiceは一般公開製品から外し、privateまたは管理者専用の研究機能として残す。
- ローカルFastAPI版とCloudflare Worker公開版を持ち、GPU処理はRunPod Serverlessへ分離している。
- SpeakLoopは母語録音、翻訳、模範音声、復唱録音、ASR比較、フレーズ単位の比較再生まで実装済み。
- SkitVoiceは最大4話者、VibeVoice生成、ASR timestampによる再配置、低スコア行再生成、Seed-VC後処理まで実装済み。Cloudflare一般ユーザー経路を閉じる変更はmerge済みmainのpreviewで検証済みだが、本番未deployでproduction公開環境には未反映。
- 参照音声はローカル版でファイル、マイク、タブ音声、URL切り出しの4方式、Cloudflare版でURLを除く3方式を提供する。
- Cloudflare Workerは既存のGoogle管理者セッションをVibeVoiceの共通認可境界にも使う。匿名・通常Googleユーザーには生成API、status、既存SkitVoiceサンプルを返さない変更はpreviewで検証済みだが、本番未deploy。
- 公開サンプル音声はローカルFastAPIでも管理画面から永続保存でき、保存・削除時の処理中／成功／失敗をボタンと状態欄へ表示する。
- quota・監査・公開サンプルmetadataはD1、公開サンプル音声blobはR2へ移行済みで、bindingなし環境向けのKV fallbackを維持している。ユーザー音声履歴はローカル版だけで保存する。
- 公開ポータル、SpeakLoop、SkitVoiceはVite + React + TypeScript、共通UI生成基盤はTailwind CSS v4とrepo所有のshadcn/ui部品へ移行済み。管理・互換画面も共通Tailwind buildを使う。
- Python/Nodeの通常CIとPlaywrightの3 viewportレイアウトE2Eを持ち、RunPod image buildとGPU smokeは手動workflowに分離している。
- Gitleaksはcommit前にstaged差分、push前にローカルGit履歴全体を検査し、全branchへのpush・pull request後も専用CI workflowで独立して再検査する。RunPod image workflowはDocker Hubの配布先と公開状態を明示・検証してからpushする。
- `/fun` はCloudflareで許可メールのGoogle OAuth管理者だけが利用できる実験画面とし、旧routeは削除済み。
- SkitVoiceの英語・中国語・日本語サンプルは外部環境に残っている可能性がある。由来metadataを確認できないため一般向けAPIから除外するが、この作業ではR2 objectを削除しない。
- GitHub repositoryは公開前再監査のためprivateへ戻した。Docker HubのRunPod image repositoryは公開状態の解消が外部作業として残っている。
- Voice Lab本体の非OSS権利表示、第三者依存一覧、frontend bundleのライセンス本文自動生成を追加済み。
- SpeakLoopの `自分の声` は同じ送信の最初の本人録音だけを参照にし、別ファイル・タブ音声・URLを受け付けない。外部一時送信、AI生成、Voice Lab履歴へ非保存、通常TTS fallbackをUIと仕様へ明示する。

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

1. Docker Hub image repositoryをprivate化するか不要tagを削除し、認証なしpullが拒否されることを確認する。
2. [公開前チェックリスト](docs/deployment/PUBLICATION_CHECKLIST.md)のP0をすべて閉じる。
3. GitHubのPrivate vulnerability reporting、Secret scanning、GitHub Push Protection、Dependabot alerts、branch protectionと正しいHomepageを設定する。
4. 公開用のPC／スマホスクリーンショットを取得し、READMEへ追加する。
5. RunPod imageまたは外部API経路を変更した場合だけ、費用を確認して最小の公開環境smokeを再実行する。
6. RunPodの実job/logをowner権限で確認し、operation別の実行時間に基づく `policy.ttl` と `policy.executionTimeout` を決める。値が未設定の間は個人音声を含むRunPod requestを送らない。

SpeakLoopはサンプル音声なし、ライセンスは明示的な再利用許諾なしで公開する方針を決定済み。GitHub source、Cloudflare demo、Docker Hub、RunPod imageは別々に公開可否を判定し、VibeVoice runtimeとRunPod imageはprivate維持を前提にする。

## 仕様の正

- 全体仕様: [docs/speech-translation/SPEC.md](docs/speech-translation/SPEC.md)
- SkitVoice: [docs/speech-translation/VIBEVOICE.md](docs/speech-translation/VIBEVOICE.md)
- Cloudflare: [docs/deployment/CLOUDFLARE.md](docs/deployment/CLOUDFLARE.md)
- 公開デモ改善: [docs/deployment/PUBLIC_DEMO_ROADMAP.md](docs/deployment/PUBLIC_DEMO_ROADMAP.md)
- 公開前ゲート: [docs/deployment/PUBLICATION_CHECKLIST.md](docs/deployment/PUBLICATION_CHECKLIST.md)
- データ取扱い境界: [docs/deployment/PRIVACY.md](docs/deployment/PRIVACY.md)
- 既知の制限: [docs/speech-translation/KNOWN_LIMITS.md](docs/speech-translation/KNOWN_LIMITS.md)
