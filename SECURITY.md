# セキュリティポリシー

## 報告方法

脆弱性はGitHubのPrivate vulnerability reportingで非公開に報告してください。入口は[Securityタブの報告フォーム](https://github.com/inakaegg/voice-lab/security/advisories/new)です。

公開Issueへ秘密情報、個人情報、未修正の脆弱性の詳細を投稿しないでください。

報告に含めてください: 影響するrouteまたはcomponent、再現条件、想定される影響、確認したrevision。添付しないでください: API key、token、個人情報、第三者の音声データ。

## 対象

保守対象は`main`ブランチの最新版です。過去commit、個人のローカル環境、第三者サービス自体の脆弱性は、Voice Lab側で再現・軽減できる場合に限り調査対象とします。

## 公開デモのデータ

公開デモへ機密情報を入力しないでください。音声には個人情報や生体情報が含まれ得ます。生成物を公開・共有する場合は、入力素材と参照音声の利用条件を確認してください。
