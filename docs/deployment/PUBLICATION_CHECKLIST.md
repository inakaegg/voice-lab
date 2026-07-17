# Repository・公開デモの公開前チェックリスト

更新日: 2026-07-17

## 現在の判定

**公開再開不可。** GitHub repositoryは公開前再監査のためprivateへ戻している。以下のblocking項目を完了し、証拠を再確認するまでpublicへ切り替えない。

## 外部状態スナップショット（2026-07-16確認）

- GitHub repository `inakaegg/voice-lab` はprivate。
- Docker Hub repository `dockerhubfd/mo-speech` はpublic（APIの `is_private=false`）。GitHubをprivateへ戻しただけでは、image layer内の `/app/src` は非公開にならない。
- Cloudflare公開デモ `https://voice-lab.inakaegg.workers.dev/` はHTTP 200で公開中。
- GitHubのHomepageは旧URL `https://voice-lab.functional-dog.workers.dev/` のまま。
- Private vulnerability reporting APIは404で、有効であることを確認できない。
- Secret scanningは無効、Dependabot alertsは無効、Code scanningは未導入。
- private状態ではbranch protectionとrulesetのAPIは403となり、GitHubからProへのupgradeまたはpublic化が必要と返される。public化と同時に保護なしの時間を作らない手順を別途決める。
- `main` 以外のremote branchが7本残っている。削除要否は内容を確認してから判断する。

この節は確認時点の観測値であり、公開直前に各APIと実画面を再確認する。

## P0: 外部へ残っている配布物

- [ ] Docker HubのRunPod image repositoryをprivateへ変更するか、公開不要なtagを削除する。
- [ ] 認証なしのDocker pullが拒否されることを確認し、Docker Hubの公開状態を記録する。
- [x] RunPod image workflowから既定の配布先を削除し、毎回 `image_name` と `expected_visibility` を明示する。
- [x] workflowがDocker Hub APIで実際の公開状態を確認し、不一致ならbuild/push前に停止する。
- [ ] Cloudflare公開デモを継続するか停止するかを決め、repository再監査とデモ公開を別の判断として記録する。
- [ ] このローカル差分をdeployする前に、公開ポータル、`/skitvoice`、全VibeVoice API、public session/sample APIの一般ユーザー閉鎖をpreviewで確認する。現時点の公開環境で停止済みとは扱わない。

## P0: 権利・第三者依存

- [x] Voice Lab本体が非OSSであることを `LICENSE` とREADMEへ明記する。
- [x] frontend bundleの依存ライセンス本文をbuild時に生成し、wheelへ同梱する。
- [x] 主なモデル・GPU依存を `THIRD_PARTY_NOTICES.md` へ列挙する。
- [ ] Seed-VCのGPL-3.0と、Voice Lab本体・Python subprocess・配布Docker imageの境界を確認し、必要なsource・license・notice提供方法を決める。
- [ ] Microsoft公式がVibeVoice TTSコードを削除した現在の状態を踏まえ、固定modelと第三者実装の由来、モデル条件、悪用防止策、公開デモ継続可否を決める。
- [ ] public container imageを配布する場合、実imageからSBOMとtransitive license一覧を生成して保存する。
- [ ] VibeVoice runtime、第三者Large mirror、ComfyUI fork、RunPod imageをprivate維持し、GitHub source／Cloudflare demo／Docker Hub／RunPod imageの公開可否を別々に記録する。
- [ ] audible disclaimer、watermark、対応detector、hashed inference loggingを別項目として確認し、self-hosted runtimeへ未継承の仕組みを実装済みと表示しない。

## P0: プライバシー

- [x] 現在の実装上のデータフローと保存境界を `PRIVACY.md` へ固定する。
- [x] 新規のKV fallback quota keyとaudit eventをSHA-256 hash識別子へ変更し、署名cookieから未使用の表示名・画像URLを除く。
- [ ] legacy KVの平文email key／audit eventを公開環境で確認し、残存分を削除して件数と実行日を記録する。
- [ ] D1 audit、日次・累計quota、KV fallbackの保持期間を決める。
- [ ] Google署名cookieの有効期間を決める。
- [ ] 期限切れデータの削除処理と検証を実装する。
- [ ] 削除依頼先、連絡先、本人確認方法を決める。
- [ ] 外部処理事業者と送信データを示す正式なプライバシーポリシーを作り、公開画面から到達可能にする。
- [ ] RunPodの全operationをowner logで実測し、operation別の `policy.ttl` と `policy.executionTimeout` を決める。未設定時に個人音声requestが安全停止することを確認する。
- [ ] RunPodのjob input/result/log保持、cancel／failure／timeout後の残存、問い合わせ先を確認して正式policyへ記載する。

## P1: GitHubの公開設定

- [ ] publicへ変更する直前にGit履歴全体をGitleaksで再走査する。
- [x] push・pull requestでGitleaksを実行するCI jobを追加する。
- [ ] GitHubのPrivate vulnerability reportingを有効にし、`SECURITY.md`の導線を実画面で確認する。
- [ ] Secret scanningとDependabot alertsを有効にする。
- [ ] Code scanningを導入するか、導入しない理由と代替検査を記録する。
- [ ] `main`のbranch protectionまたはrulesetで、required checks、force push禁止、削除禁止を設定する。
- [ ] GitHubのHomepageを実際に到達できる公開デモURLへ直す。
- [ ] 不要なremote feature branchを削除し、公開対象の履歴を再確認する。

## P1: ポートフォリオ表示

- [ ] READMEへPC・スマートフォンのスクリーンショットを追加する。
- [ ] READMEの最初の画面だけで、価値、主要機能、技術構成、試し方、制限が分かることを確認する。
- [ ] 公開URLでトップ、SpeakLoop、SkitVoice非公開案内、Googleログイン、許可・不許可アカウント、管理routeをsmoke確認する。
- [ ] 匿名・通常GoogleユーザーがVibeVoice status/script/job/status/cancelを直接呼んでも拒否され、adminだけが研究経路を使えることを確認する。
- [ ] SpeakLoop自己音声の本人録音限定、外部一時送信、AI生成表示、Voice Lab履歴へ非保存、通常TTS fallbackがREADME、利用画面、仕様で一致することを確認する。

## 検証ゲート

```sh
gitleaks git --redact --log-opts='--all' .
python3 -m pytest
npm test
npm run check:js
npm run check:web
npm run test:e2e
git diff --check
```

自動テスト成功は、ライセンス互換性、プライバシーポリシーの妥当性、外部設定、実画面の正しさを保証しない。P0をすべて閉じ、P1の外部設定と実画面を別途確認してから公開可否を判断する。
