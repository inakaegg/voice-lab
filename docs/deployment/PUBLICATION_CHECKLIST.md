# Repository・公開デモの公開前チェックリスト

更新日: 2026-07-17

## 現在の判定

**公開再開不可。** GitHub repositoryは公開前再監査のためprivateへ戻している。以下のblocking項目を完了し、証拠を再確認するまでpublicへ切り替えない。

## 外部状態スナップショット（2026-07-17確認）

- GitHub repository `inakaegg/voice-lab` はprivate。
- Docker Hub repository `dockerhubfd/mo-speech` はprivate（APIの `is_private=true`）。tag `runpod-vibevoice-1807d21` は匿名manifest取得がHTTP 401、認証済み取得がHTTP 200。
- RunPodのDocker Hub read-only registry credentialは1件を登録済み。endpoint `78i71pqw2h24xc` のtemplate `9oabmrsr64` は `containerRegistryAuthId` を持ち、private image `docker.io/dockerhubfd/mo-speech:runpod-vibevoice-1807d21` を参照する。
- endpointを一度 `workersMax=0` へ変更してworker 0件を確認し、設定を `workersMin=0`、`workersMax=1`、`idleTimeout=300` へ戻した。強制scale-to-zero後の新しいworkerでdiagnosticsが完了し、image revision `1807d21ed599bd3f0db6f9d29089d9c7b1f0c27e` とtagが一致した。
- Cloudflare公開デモ `https://voice-lab.inakaegg.workers.dev/` は旧versionのままHTTP 200で公開中。匿名のVibeVoice statusとSkitVoice sample音声を現在も返すため、閉鎖済みとは扱わない。
- merge済みmainのCloudflare version `0baddaf6-abcf-4c47-a795-1084165d3654` をproduction trafficへ割り当てずpreviewへuploadした。`https://publication-check-voice-lab.inakaegg.workers.dev/` では匿名VibeVoice statusが401、sample APIは200でも全featureが `null`、管理HTMLはGoogle OAuthへ302、旧VibeVoice routeは404。
- Cloudflare KVは値を表示せずkey名を集計し、全7件中、平文emailを含むlegacy累計quota keyが2件残っていることを確認した。D1 audit 97件は、hash形式でないactor識別子またはdetail内の平文email候補が0件だった。
- GitHubのHomepageは旧URL `https://voice-lab.functional-dog.workers.dev/` のまま。
- Private vulnerability reporting APIは404で、有効であることを確認できない。
- Secret scanningは無効、Dependabot alertsは無効、Code scanningは未導入。
- private状態ではbranch protectionとrulesetのAPIは403となり、GitHubからProへのupgradeまたはpublic化が必要と返される。public化と同時に保護なしの時間を作らない手順を別途決める。
- `main` 以外のremote branchが7本残っている。削除要否は内容を確認してから判断する。

この節は確認時点の観測値であり、公開直前に各APIと実画面を再確認する。

## P0: 外部へ残っている配布物

- [x] Docker HubのRunPod image repositoryをprivateへ変更するか、公開不要なtagを削除する。
- [x] 認証なしのDocker pullが拒否されることを確認し、Docker Hubの公開状態を記録する。
- [x] Docker Hubのread-only tokenをRunPod registry credentialへ登録し、そのIDをServerless templateへ設定する。tokenはRunPod credentialだけに保存し、ローカルにはcredential IDだけを保持する。
- [x] endpointを強制scale-to-zeroし、新しいworkerでprivate imageの起動とdiagnosticsのrevision/tag一致を確認する。
- [x] RunPod image workflowから既定の配布先を削除し、毎回 `image_name` と `expected_visibility` を明示する。
- [x] workflowがDocker Hub APIで実際の公開状態を確認し、不一致ならbuild/push前に停止する。
- [ ] Cloudflare公開デモを継続するか停止するかを決め、repository再監査とデモ公開を別の判断として記録する。
- [x] merge済みmainをCloudflare versioned previewへuploadし、公開ポータル、`/skitvoice`、VibeVoice status、public session/sample API、管理HTML、旧routeの匿名境界を確認する。sample APIは公開契約を維持するため200だが、全featureが `null` で音声を返さない。
- [ ] previewで確認したversionをproductionへdeployし、同じ匿名境界を公開URLで再確認する。preview確認だけで現時点の公開環境で停止済みとは扱わない。

## P0: 権利・第三者依存

- [x] Voice Lab本体が非OSSであることを `LICENSE` とREADMEへ明記する。
- [x] frontend bundleの依存ライセンス本文をbuild時に生成し、wheelへ同梱する。
- [x] 主なモデル・GPU依存を `THIRD_PARTY_NOTICES.md` へ列挙する。
- [x] Seed-VC 0.4.3のGPL-3.0を記録し、現行方針ではSeed-VCを含むcontainer imageをpublic配布しない。将来変更する場合はCorresponding Source、license・noticeと実imageのtransitive依存を別途確認する。
- [x] Microsoft公式がVibeVoice TTSコードを削除した現在の状態、固定1.5B model、第三者実装・Large mirrorを分離し、一般向けVibeVoice生成・sampleを公開しない運用判断を記録する。
- [x] 現行方針ではpublic container imageを配布しない。将来public配布へ変更する場合は、実imageからSBOMとtransitive license一覧を生成して本項目を再度開く。
- [x] GitHub source／Cloudflare demo／Docker Hub／RunPod runtimeを別々に記録し、VibeVoice runtime、第三者Large mirror、ComfyUI fork、RunPod imageはprivate維持とする。
- [x] audible disclaimer、watermark、対応detector、hashed inference loggingを別項目とし、self-hosted runtimeへ未継承の仕組みを実装済みと表示しない。

## P0: プライバシー

- [x] 現在の実装上のデータフローと保存境界を `PRIVACY.md` へ固定する。
- [x] 新規のKV fallback quota keyとaudit eventをSHA-256 hash識別子へ変更し、署名cookieから未使用の表示名・画像URLを除く。
- [x] legacy KVとD1 auditを公開環境で値を表示せず読み取り確認する。2026-07-17時点でKVに平文emailを含むlegacy累計quota keyが2件、D1 audit 97件中の平文email候補は0件。
- [ ] 新Workerをproductionへ反映してlegacy keyを新規生成しない状態にした後、KVの残存2件を削除し、再検査の件数と実行日を記録する。
- [ ] D1 audit、日次・累計quota、KV fallbackの保持期間を決める。
- [ ] Google署名cookieの有効期間を決める。
- [ ] 期限切れデータの削除処理と検証を実装する。
- [ ] 削除依頼先、連絡先、本人確認方法を決める。
- [ ] 外部処理事業者と送信データを示す正式なプライバシーポリシーを作り、公開画面から到達可能にする。

## P1: GitHubの公開設定

- [x] staged差分をcommit前に検査するrepo管理のGitleaks `pre-commit` hookとinstallerを追加する。
- [x] Git履歴全体をpush前に検査するrepo管理のGitleaks `pre-push` hookとinstallerを追加する。
- [x] 全branchへのpush・pull requestでGitleaksを再実行するCI jobを追加する。
- [ ] GitHub Secret scanningとGitHub Push Protectionを有効にし、検出したpushがremoteへ到達する前に拒否されることを確認する。
- [ ] publicへ変更する直前にGit履歴全体をGitleaksで再走査する。
- [ ] GitHubのPrivate vulnerability reportingを有効にし、`SECURITY.md`の導線を実画面で確認する。
- [ ] Dependabot alertsを有効にする。
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
test "$(git config --worktree --get core.hooksPath)" = ".githooks"
gitleaks git --redact --log-opts='--all' .
python3 -m pytest
npm test
npm run check:js
npm run check:web
npm run test:e2e
git diff --check
```

自動テスト成功は、ライセンス互換性、プライバシーポリシーの妥当性、外部設定、実画面の正しさを保証しない。P0をすべて閉じ、P1の外部設定と実画面を別途確認してから公開可否を判断する。
