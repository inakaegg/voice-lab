# SpeakLoop公開デモ・ポートフォリオ

更新日: 2026-07-23

## 現在地

- Voice Labの公開ポートフォリオはSpeakLoopを中心とする。
- Cloudflareの現在版はproduction公開環境へ反映済みで、`/`、`/speakloop`、`/privacy`を公開している。
- 実装済みの機能: Google OAuth・機能別quota・入力上限・管理者認証・簡易監査ログ。
- 利用者音声と生成音声はCloudflare版のVoice Lab履歴へ保存しない。
- quota・監査情報はD1、短期jobとfallbackはKVを使い、平文emailを含む旧quota keyは削除済み。
- 中国語ASRと任意の声質変換はprivateなRunPod Serverlessへ分離している。
- Python／Node CI、React production build、Playwright 3 viewport E2Eを実装済み。
- Gitleaksはcommit前、push前、全branchへのpush・pull requestで独立して実行する。
- GitHub repositoryはpublicである。Secret scanning、Push Protection、Private vulnerability reportingを有効にしている。
- Docker HubのRunPod image repositoryはprivateで、認証済みcold startを確認済み。
- staging Workerは配備済みで、必須Worker secretと非課金smokeも確認済みである。Googleログインの実操作は未確認である。

## 公開判断

CloudflareのSpeakLoopデモとGitHub repositoryは公開を継続する。外部状態の確認項目は[運用チェックリスト](PUBLICATION_CHECKLIST.md)を正とする。release前には全履歴GitleaksとGitHub security設定を再確認する。

Voice Lab本体にはOSSライセンスを付与せず、ポートフォリオとして閲覧可能にする方針を維持する。第三者コンポーネントにはそれぞれのライセンスが適用されるため、本体の権利表示と混同しない。

## 完了済みの技術確認

1. Cloudflare production公開URLでsmoke確認した。対象はトップ・SpeakLoop・プライバシーポリシー・匿名API境界・管理者ログイン遷移である。
2. 平文emailを含むlegacy KV quota key 2件を削除し、残存0件を確認した。
3. Docker Hub private imageをRunPodがregistry credential付きでcold startできることを確認した。
4. Git履歴全体、commit前、push前、GitHub ActionsでGitleaksを実行する。
5. `_ai/`・`tmp/`・`.env`・`.dev.vars`・`.runpod.env`をGit管理外にしている。
6. GitHub Homepageを現行のCloudflare公開URLへ更新した。
7. GitHub repositoryをpublicにし、security設定と`main`のbranch protectionを有効にした。
8. READMEへPC・スマートフォンの代表スクリーンショットを追加した。
9. staging Workerをproductionと別resourceへ配備した。

## 公開運用で継続すること

1. PRのrequired checksが最新headで完了し、未解決threadが0件であることを確認する。
2. release前にGit履歴全体をGitleaksで再検査する。
3. GitHub security設定と`main`のbranch protectionを定期確認する。
4. 匿名状態でrepositoryトップ、脆弱性報告導線、公開デモURLを確認する。
5. deploy後smokeで公開画面、公開JSON API、匿名管理APIの拒否を確認する。
6. stagingのGoogle OAuthリダイレクトURIとGoogleログインを実操作で確認する。

## 公開後に検討する改善

- Safari、Firefox、スマートフォン実機の録音形式を継続確認する。
- RunPodのcold start、queue、GPU費用を実測し、必要な場合だけwarmup運用を調整する。
- 公開画面の説明、プライバシーポリシー、実装上の保存境界が一致していることを継続監査する。

## 自動検証

```sh
python3 -m pytest
npm test
npm run check:js
npm run check:web
npm run test:e2e
```

自動検証に加え、公開URLの主要導線・認証・モバイル表示・GitHub・Docker Hub・RunPodの実設定を確認する。
