# セキュリティポリシー

## 報告方法

脆弱性や秘密情報の露出を発見した場合は、公開Issueへ詳細を書かず、GitHub repositoryの `Security` タブにある `Report a vulnerability` からPrivate vulnerability reportingを利用してください。repositoryをpublicへ切り替える前に、この機能を有効にして導線を実画面確認することを公開条件とします。

`Report a vulnerability` が表示されない場合は、公開Issueへ再現情報を書かず、repository ownerのGitHub profileに掲載された連絡手段からprivateな報告経路を確認してください。

公開デモの保存情報に関する問い合わせ・削除依頼も、個人情報を公開Issueへ書かず、同じPrivate vulnerability reportingから連絡してください。

報告には、影響するrouteまたはcomponent、再現条件、想定される影響、確認したrevisionを含めてください。API key、token、個人情報、第三者の音声データは添付しないでください。

## 対象

保守対象は`main`ブランチの最新版です。過去commit、個人のローカル環境、第三者サービス自体の脆弱性は、Voice Lab側で再現・軽減できる場合に限り調査対象とします。

## 公開デモのデータ

公開デモへ機密情報を入力しないでください。音声には個人情報や生体情報が含まれ得ます。生成物を公開・共有する場合は、入力素材と参照音声の利用条件を確認してください。
