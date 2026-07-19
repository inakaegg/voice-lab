# AGENTS.md - このリポジトリの作業ルール

このリポジトリでは `~/.codex/AGENTS.md` の共通ルールを前提にする。共通ルールと衝突する場合は、「ユーザーの最新指示」→「このファイル」→「`~/.codex/AGENTS.md`」の順に優先する。

## プロジェクトの目的

- 音声入力を受け取り、別言語の音声出力として返すWebアプリを作る。
- 初期の必須ルートは `id-ID 音声 -> ja-JP 音声` と `ja-JP 音声 -> zh-CN 音声`。
- まずローカルで動く最小版を作り、動作確認後にRunPodまたは代替GPUプラットフォームへ載せる。
- 大きいモデルを扱うため、モデル本体とキャッシュをリポジトリ外の保存先に分離する。

## 仕様とドキュメント

- 合意事項、前提、要件はチャットではなく `docs/` に残す。
- 実装前に [docs/speech-translation/SPEC.md](docs/speech-translation/SPEC.md) と [docs/speech-translation/OPEN_QUESTIONS.md](docs/speech-translation/OPEN_QUESTIONS.md) を確認する。
- 見える公開UIを変更する前に [docs/UI_STYLE.md](docs/UI_STYLE.md) と [docs/deployment/FRONTEND_MIGRATION.md](docs/deployment/FRONTEND_MIGRATION.md) を確認する。
- 未確定の内部メモ、AI会話ログ、調査途中のメモは `_ai/` に置く。
- 公開docsは、外部の読み手がプロダクトの価値、使い方、仕様、設計判断、検証方法を理解する助けになる内容だけを書く。
- 公開docsに書く前に、「第三者がプロジェクトを理解、利用、評価、再現するために必要か」を確認する。答えが弱い内容は `_ai/` または `tmp/` に置く。
- 作業履歴、チャットログの移動先、ローカル環境固有の空き容量・パス・一時的な計測値、Codexの作業都合は公開docsに書かない。必要なら `_ai/` または `tmp/` に置く。
- `_ai/` と `tmp/` はgit管理しない。
- ドキュメント本文は原則として日本語で書く。英語版が必要になっても、まず日本語で内容を固定する。

### ドキュメントの明瞭さ・簡潔さ

- 1文の読点（、）は3つまでとする。超える場合は文を分けるか箇条書きにする。
- 箇条書きの1項目・1段落は1トピックに閉じる。権限境界、UI表示、保存方針など性質の異なる内容を1文・1行へ詰め込まない。
- ASR、TTS、API、UIなど既に定着した技術用語や、製品名・ライブラリ名・API名などの固有名詞はそのまま使う。それ以外にプロジェクト独自の専門用語（例:「ownership evidence」のような独自の英語複合語）を新設する場合は、使う前にその文書の用語節で日本語の定義を与える。定義なしで独自用語を使い始めない。
- 新しい公開docファイルは既定で作らない。既存の `README.md`、`SPEC.md`、`ROADMAP.md`、`docs/deployment/` 配下の該当文書のどれかへ統合できないかを先に確認する。統合先がなく新規作成する場合は、既存文書へ入らない理由を短く記す。
- 完了済みの作業手順、廃止した設計案、旧方式との比較経緯は、公開docsへ詳細を残さない。現在の実装・仕様を理解するために必要な結論だけを書き、詳細は `git log` に委ねる。
- 文書を書き終えたら、各段落が読点3つ以内・1トピックに収まっているか、独自用語に定義があるかを自己点検してから確定する。

### 実装とドキュメントの同期

- 仕様・構成・進捗を変える変更は、実装・テスト・関連docsを同じコミットで更新する。コードだけ、または進捗表だけを先に完了扱いにしない。
- 作業完了前に、変更した機能名、API path、保存先、binding名、実行環境名で `README.md`、`docs/`、`AGENTS.md` を横断検索し、旧仕様・「未実装」「外部確認待ち」などの残存表現を確認する。
- ロードマップの「完了」は、コード、必要なresource/binding、migration、テスト、対象環境への反映のうち、実際に完了した範囲を列挙する。外部操作待ちと実装待ちを同じ項目へ混ぜない。
- 現状説明を持つ文書には更新日を置き、節目の変更では更新日と進捗欄を更新する。将来計画と現在仕様を同じ文章で曖昧に表現しない。
- 実行環境マトリクス、保存先、公開API、必須UI状態など齟齬の影響が大きい項目は、可能な範囲でdocs検査テストまたは静的テストにも固定する。
- 最終報告前に `git diff --check` と全テストに加え、関連docsの差分または「変更不要と判断した根拠」を確認する。

## テストと検証

- 仕様追加やバグ修正では、原則としてテスト追加・更新を先に行い、その後に実装する。
- 実装完了条件は、該当テストと確認コマンドが通ること。
- 音声処理はモデル依存の挙動が大きいため、単体テストだけでなく短い音声ファイルを使ったスモーク確認を追加する。
- RunPod、GPUサーバー、外部API、時間課金が発生する検証へ進む前に、ローカルで検証できる範囲を先に潰す。モデル非依存のrequest/env/preset解決、processor呼び出し、token ID処理、dtype変換、出力シリアライズ、エラー処理、進捗パースはfake modelや軽量fixtureでテストする。
- VibeVoice/RunPod向けのDocker build、image deploy、serverless smokeは、ローカルの該当テストが通ってから必要最小限だけ実行する。リモートでしか確認できない場合は、その理由と最小入力を明確にしてから実行する。
- Web UIの録音、アップロード、ローディング表示、音声再生は、コード上の存在確認だけで完了扱いしない。
- FastAPIのルート/API実装を変更した場合、ローカル確認前に必ずUvicornプロセスを再起動する。静的ファイルは再起動なしで更新される一方、Pythonのルート/APIは起動中プロセスに古い実装が残るため、「フロントだけ最新、API/routeは古い」状態で確認しない。
- 既存サーバーを使って確認する場合は、`lsof -nP -iTCP:<port> -sTCP:LISTEN` と `ps -p <pid> -o pid,lstart,command` で起動時刻とコマンドを確認する。再起動できない場合は別ポートで新しく起動し、確認に使ったURLを報告する。
- ルート追加・変更時は、ユーザーが開く可能性のある末尾スラッシュ有無も確認する。例: `/speakloop/admin` と `/speakloop/admin/`。

### 公開UIの品質契約

- 見えるUI変更では、利用可能なら共通の `$ui-quality` Skillを使う。
- 公開React UIは [docs/UI_STYLE.md](docs/UI_STYLE.md) のroute別移行表を正とする。移行済みrouteはTailwind CSS v4 + repo所有shadcn/ui、未移行routeはReact共通部品 + `src/mo_speech/web/styles.css` を使い、同じrouteで両方式を読み込まない。
- Tailwind依存の見える共通部品は、利用側routeが同じ基盤へ移行するまで旧routeへ持ち込まない。shadcn/ui componentはrepo内で所有し、Voice Labのtokenとvariantへ合わせる。
- `/` を視覚基準とし、`/speakloop` と `/skitvoice` を同じ製品群として確認する。
- 基準幅は `1440px`、`1024px`、`390px` とし、Light／Dark、長い日本語、初期状態、主要な動的状態、errorを確認する。
- Web UIでは実際にレンダリングされた画面を確認する。共有ブラウザが利用できない場合も、それだけで検証を打ち切らず、利用可能なPlaywright、DevTools系手段、ローカルChromeのheadless／CDP等を検討する。
- `scrollWidth <= clientWidth`、設定の右端位置、列数、カード順、sticky要素の非遮蔽を確認する。DOM寸法の計測だけでなく、スクリーンショットを直接開いて確認する。
- 検証用スクリーンショットは原則 `tmp/` に置く。公開用またはvisual regression用として採用する場合だけ、意図を確認して管理対象へ移す。
- 実画面を確認できなければ、最終報告へ `VISUAL_QA_UNVERIFIED` と確認できなかった画面・状態を記載し、UI完成とは報告しない。

## 実装方針

- 音声処理はASR、翻訳、TTS、声質変換をプロバイダ/アダプタ境界で分け、後から差し替えられるようにする。
- 最初から重い声質クローン構成に寄せず、まず `音声 -> 文字起こし -> 翻訳 -> 音声` の縦切りを通す。
- 局所的なヒューリスティクスで1ケースだけ通す調整を避ける。
- 性能改善や容量削減を主張する変更では、変更前後の計測または見積もりを残す。

## URL参照音声の実行境界

- URL参照音声の取得は、ローカルFastAPIプロセス上の `yt-dlp` と `ffmpeg` だけで行う。
- YouTube取得では対応版NodeをJS runtimeとして使い、yt-dlpへ `--js-runtimes node` を明示する。cookieやPO Tokenを既定で扱わない。
- Cloudflare公開版ではURL入力を表示せず、URL付きAPIリクエストもWorkerで拒否する。
- RunPod handlerはURLを受け取らず、ローカルFastAPIで切り出した音声bytesだけを受け取る。RunPod imageへ `yt-dlp` とURL取得機能を含めない。
- ローカルFastAPIでURL取得に失敗した場合、後続のRunPod処理はまだ始まっていない。RunPod、Cloudflare、datacenter制限を確認済みの原因としてエラーへ表示しない。
- URL取得の責任を別環境へ移す場合やRunPod imageへ取得ツールを追加する場合は、実装前に仕様変更として `docs/` へ記録する。
- URL参照の変更では、ローカルFastAPIで取得すること、Cloudflareが拒否すること、RunPod payloadにURLが含まれないこと、RunPod imageに取得ツールがないことをテストで確認する。期待値は実装と同じ変更だけで正当化せず、仕様上の実行主体と照合する。

## モデルとデータの扱い

- モデル本体、Hugging Faceキャッシュ、生成音声、録音サンプル、APIキーはgit管理しない。
- 重いモデルはリポジトリ外のキャッシュ、RunPod Network Volume、Modal Volumeなどに置く。
- Docker imageへ大きいモデルを焼き込む構成は、MVPでは原則避ける。
- 外部API、有料API、課金、秘密情報を扱う変更は、導入前に `docs/` で目的、代替案、料金、依存リスク、キー管理を明記する。

## Git運用

- Codexはブランチ種別に関わらず、原則としてpushしない。
- pushが必要な場合は作業内容、確認結果、未確認範囲を報告し、ユーザー側で実行してもらう。
- ユーザーがそのターンで明示的に「pushして」と依頼した場合だけ、Codexがpushしてよい。
- コミットする場合は、可能なら `日本語 / English` の1行形式にする。
- 各worktreeで `./scripts/install_git_hooks.sh` を実行し、Gitleaksの `pre-commit` と `pre-push` hookを有効にする。Gitleaksがない環境ではcommit・pushを黙って通さず停止する。
- ローカルhookはGitHub ActionsとGitHub Push Protectionの代替ではない。全branchへのpush・pull requestの専用CI再検査を維持し、公開前にはGit履歴全体を別途検査する。

## 現在の検証コマンド

通常の変更では、影響範囲に応じて次を実行する。

```sh
gitleaks git --redact --log-opts='--all' .
python3 -m pytest
npm test
npm run check:js
npm run check:web
```

- Pythonの全単体・APIテストは `python3 -m pytest` を正とする。
- Cloudflare WorkerとWeb静的検査は `npm test` と `npm run check:js` を正とする。
- React公開画面の型検査とproduction buildは `npm run check:web` を正とする。
- RunPod Docker buildとGPU smokeは通常CIへ入れず、ローカル検証通過後に手動workflowで実行する。
- UI変更は上記に加え、可能なら実ブラウザでデスクトップ幅とモバイル幅を確認する。実行できない場合は未確認範囲として報告する。
