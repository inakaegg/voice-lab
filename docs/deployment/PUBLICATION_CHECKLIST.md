# Repository・公開デモの運用チェックリスト

更新日: 2026-07-23

## 現在の判定

CloudflareのSpeakLoopデモはproduction公開中である。GitHub repositoryもpublicであり、公開時のsecurity設定を有効にしている。staging Workerは必須secretを登録済みで、非課金smokeも成功している。

## 外部状態スナップショット（2026-07-23確認）

- GitHub repository `inakaegg/voice-lab` はpublic。Homepageは `https://voice-lab.inakaegg.workers.dev/`。
- Dependabot alertsは有効。Secret scanningとGitHub Push Protectionは有効である。
- Private vulnerability reportingは有効である。
- `main`のbranch protectionはrequired checksを必須にする。対象は `test`、`ui-e2e`、`Gitleaks` である。force pushとbranch削除は禁止し、会話解決も必須にしている。
- Code scanningは未導入。現時点の代替検査は、全branchのPython／Node CI・型静的検査・Playwright・Gitleaksである。Dependabot alertsも代替検査に含む。外部contributorを受け入れる場合に再検討する。
- Docker Hub repository `dockerhubfd/mo-speech` はprivate（APIの `is_private=true`）。2026-07-17の確認では匿名pullを拒否した。
- RunPodのDocker Hub read-only registry credentialは1件を登録済み。2026-07-17には強制scale-to-zero後の新しいworkerを起動し、private image revisionとの一致を確認した。Docker HubとRunPodの公開状態は別々に確認する。
- Cloudflare production公開URLでの確認結果は次のとおり。`/`、`/speakloop`、`/privacy` は200。匿名の管理用status APIは401。公開sample APIは全featureが `null`。管理HTMLはGoogle OAuthへ302。旧routeは404。
- Cloudflare stagingは2026-07-22に配備済み。2026-07-23に必須Worker secret 7件を登録し、非課金smokeの全6項目が成功した。Googleログインの実操作は未確認である。
- 2026-07-17に確認したCloudflare KVは全5件で、平文emailを含むlegacy quota keyは0件。削除前に確認したD1 audit 97件では、hash形式でないactor識別子またはdetail内の平文email候補は0件だった。

この節は確認時点の観測値である。release前と外部設定変更後にGitHub・Cloudflare・Docker Hub・RunPodの実状態を再確認する。

## P0: 外部配布物と実行環境

- [x] Docker HubのRunPod image repositoryをprivateにする。
- [x] 匿名Docker pullが拒否され、認証済みpullが成功することを確認する。
- [x] Docker Hub read-only credentialをRunPodへ登録し、Serverless templateへ設定する。
- [x] RunPod endpointを強制scale-to-zeroし、新しいworkerでprivate imageを起動する。
- [x] RunPod image workflowで配布先と期待するvisibilityを毎回明示し、不一致ならpush前に停止する。
- [x] Cloudflare productionへ現在版を反映し、公開画面・匿名API境界・管理者認証を確認する。

## P0: 権利・第三者依存

- [x] Voice Lab本体が非OSSであることを `LICENSE` とREADMEへ明記する。
- [x] frontend bundleの依存ライセンス本文をbuild時に生成し、wheelへ同梱する。
- [x] 主なモデル・GPU依存を `THIRD_PARTY_NOTICES.md` へ列挙する。
- [x] Seed-VC 0.4.3のGPL-3.0を記録し、Seed-VCを含むcontainer imageをpublic配布しない。
- [x] Microsoft公式VibeVoiceの現在状態、固定model、第三者実装・mirrorを区別し、一般向け生成機能として公開しない。
- [x] GitHub source、Cloudflare demo、Docker Hub、RunPod runtimeの公開範囲を別々に確認する。
- [x] public container imageを配布しない。将来変更する場合はSBOM、transitive license、Corresponding Sourceを再監査する。

## P0: プライバシー

- [x] 実装上のデータフローと保存境界を `PRIVACY.md` へ固定する。
- [x] quotaとauditの利用者識別子をSHA-256 hash化し、平文emailを新規保存しない。
- [x] productionへ新Workerを反映後、平文emailを含むlegacy KV quota key 2件を削除し、残存0件を確認する。
- [x] `public_users` の平文emailは管理画面の利用者一覧のための意図的な保存として扱う。読み手を管理者APIに限定し、プライバシーポリシーへ用途と保持期間を記載する。
- [x] D1の日次quota、audit、KV fallbackへ保持期限と日次削除を設定する。
- [x] Google署名cookieを30日とし、ログアウト時に削除する。
- [x] 外部送信、保存有無、保持期間を説明するプライバシーポリシーを公開し、`/privacy` とSpeakLoopから到達可能にする。

## P1: GitHubの公開設定

- [x] Gitleaksのrepo管理 `pre-commit`、`pre-push` hookとinstallerを用意する。
- [x] 全branchへのpush・pull requestでGitleaksを再実行するCIを用意する。
- [ ] 次の公開release前にGit履歴全体をGitleaksで再走査する。
- [x] repositoryをpublicにし、Secret scanningとPush Protectionを有効化する。
- [x] Private vulnerability reportingを有効化する。
- [x] Dependabot alertsを有効にする。
- [x] Code scanningを直ちに導入しない理由と、現行の代替検査を記録する。
- [x] `main`のbranch protectionでrequired checks、force push禁止、削除禁止、会話解決を設定する。
- [x] GitHub Homepageを実際のCloudflare公開デモURLへ更新する。

## P1: ポートフォリオ表示

- [x] SpeakLoop中心のREADMEと公開ロードマップをmergeする。
- [x] READMEの最初の画面だけで分かることを確認する。確認対象は価値、主要機能、試し方、データ取扱いである。
- [x] GitHubのrepository descriptionから非公開研究機能名を除き、SpeakLoop中心にする。
- [ ] 匿名状態でGitHubのトップREADMEと主要リンクを定期確認する。
- [x] Cloudflare公開URLでsmoke確認する。対象はトップ・SpeakLoop・プライバシーポリシー・Googleログイン・管理routeである。
- [x] 匿名利用者が管理APIを直接呼んでも拒否されることを確認する。
- [x] 「自分の声」に関する説明をREADME、利用画面、仕様で一致させる。説明対象は本人録音限定・外部一時送信・AI生成・履歴へ非保存・通常TTS fallbackである。
- [x] READMEへPC・スマートフォンの代表スクリーンショットを追加する。

## 検証ゲート

```sh
test "$(git config --worktree --get core.hooksPath)" = ".githooks"
gitleaks git --redact --log-opts='--all' .
python3 -m pytest
npm test
npm run check:js
npm run check:web
npm run test:e2e
git diff --check
```

自動テスト成功だけで外部状態や公開表示を保証しない。release前と外部設定変更後にGitHubと公開URLを読み取り確認する。
