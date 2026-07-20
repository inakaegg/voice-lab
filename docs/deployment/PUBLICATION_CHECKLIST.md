# Repository・公開デモの再公開チェックリスト

更新日: 2026-07-17

## 現在の判定

CloudflareのSpeakLoopデモはproduction公開中。GitHub repositoryは公開向けREADMEと状態文書の整理中のためprivateであり、この文書PRのmergeと再監査後に再公開する。

## 外部状態スナップショット（2026-07-17確認）

- GitHub repository `inakaegg/voice-lab` は文書整理中のためprivate。Homepageは `https://voice-lab.inakaegg.workers.dev/`。
- Dependabot alertsは有効。Secret scanningとGitHub Push Protectionはpublic化時に再確認する。
- private状態ではbranch protectionのAPIが403となり、Private vulnerability reportingも外部から利用できない。public化直後に再設定・再確認する。
- Code scanningは未導入。現時点の代替検査は、全branchのPython／Node CI・型静的検査・Playwright・Gitleaksである。Dependabot alertsも代替検査に含む。外部contributorを受け入れる場合に再検討する。
- Docker Hub repository `dockerhubfd/mo-speech` はprivate（APIの `is_private=true`）で、匿名pullを拒否する。
- RunPodのDocker Hub read-only registry credentialは1件を登録済み。private imageを参照するtemplateで強制scale-to-zero後の新しいworkerを起動し、image revisionとの一致を確認した。Docker HubとRunPodの公開状態は別々に確認する。
- Cloudflare production公開URLでの確認結果は次のとおり。`/`、`/speakloop`、`/privacy` は200。匿名の管理用status APIは401。公開sample APIは全featureが `null`。管理HTMLはGoogle OAuthへ302。旧routeは404。
- Cloudflare KVは全5件で、平文emailを含むlegacy quota keyは0件。削除前に確認したD1 audit 97件では、hash形式でないactor識別子またはdetail内の平文email候補は0件だった。

この節は確認時点の観測値であり、再公開直前にGitHub・Cloudflare・Docker Hub・RunPodの実状態を再確認する。

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
- [x] D1の日次quota、audit、KV fallbackへ保持期限と日次削除を設定する。
- [x] Google署名cookieを30日とし、ログアウト時に削除する。
- [x] 外部送信、保存有無、保持期間を説明するプライバシーポリシーを公開し、`/privacy` とSpeakLoopから到達可能にする。

## P1: GitHubの再公開設定

- [x] Gitleaksのrepo管理 `pre-commit`、`pre-push` hookとinstallerを用意する。
- [x] 全branchへのpush・pull requestでGitleaksを再実行するCIを用意する。
- [ ] publicへ変更する直前にGit履歴全体をGitleaksで再走査する。
- [ ] repositoryをpublicへ戻し、Secret scanningとPush Protectionを有効化・確認する。
- [ ] Private vulnerability reportingを有効化し、`SECURITY.md`の導線を匿名状態で確認する。
- [x] Dependabot alertsを有効にする。
- [x] Code scanningを直ちに導入しない理由と、現行の代替検査を記録する。
- [ ] `main`のbranch protectionでrequired checks、force push禁止、削除禁止、会話解決を設定する。
- [x] GitHub Homepageを実際のCloudflare公開デモURLへ更新する。

## P1: ポートフォリオ表示

- [ ] SpeakLoop中心のREADME・TASK・公開ロードマップをmergeする。
- [x] READMEの最初の画面だけで分かることを確認する。確認対象は価値、主要機能、試し方、データ取扱いである。
- [x] GitHubのrepository descriptionから非公開研究機能名を除き、SpeakLoop中心にする。
- [ ] GitHub repositoryを再公開後、匿名状態でトップREADMEと主要リンクを確認する。
- [x] Cloudflare公開URLでsmoke確認する。対象はトップ・SpeakLoop・プライバシーポリシー・Googleログイン・管理routeである。
- [x] 匿名利用者が管理APIを直接呼んでも拒否されることを確認する。
- [x] 「自分の声」に関する説明をREADME、利用画面、仕様で一致させる。説明対象は本人録音限定・外部一時送信・AI生成・履歴へ非保存・通常TTS fallbackである。
- [ ] PC・スマートフォンの代表スクリーンショット追加は公開後の改善として扱う。

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

自動テスト成功だけで外部状態や公開表示を保証しない。再公開直前と直後にGitHubと公開URLを読み取り確認する。
