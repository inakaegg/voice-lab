# Voice Lab ドキュメント案内

更新日: 2026-08-08

Voice LabのSpeakLoopを理解し、変更し、運用するための文書案内です。フォルダ構成ではなく作業目的から辿れるように並べています。ルートREADMEは製品紹介とセットアップ、この案内は詳細文書への入口という役割で分けています。

読み方の前提は次のとおりです。

- 現在実装されている挙動の正は [SPEC.md](speech-translation/SPEC.md) です。
- 将来方針と未決事項は現在仕様と別の文書に置き、この案内でも区別して示します。
- 各文書の冒頭に更新日があります。内容の新しさはそこで確認してください。
- ここには仕様本文を複製しません。各文書で何が分かるかだけを示します。

## SpeakLoopと現在仕様を理解する

最初に読む区分です。製品として何ができるかは [ルートREADME](../README.md) を参照してください。

- [SpeakLoop仕様](speech-translation/SPEC.md) — 現在の実装仕様の正。分かることは正式route、録音と言語、復唱ASR、採点方式です。
- [比較再生のケーススタディ](speech-translation/COMPARISON_PLAYBACK_CASE_STUDY.md) — お手本音声と復唱音声を比べて聞く機能の解説。現在の設計、その設計を選んだ理由、評価で分かる範囲の限界が分かります。仕様の正はSPEC.mdです。
- [Zoovoice連想改善のケーススタディ](speech-translation/ZOOVOICE_ASSOCIATION_CASE_STUDY.md) — 動物連想の改善記録。辞書・Embedding・LLMの同一50問比較と、実例つきの採否判断が分かります。仕様の正はSPEC.mdです。
- [ロードマップ](speech-translation/ROADMAP.md) — 今後の改善方針。製品の方向と改善順の候補が分かります。現在の挙動の根拠には使いません。
- [既知の制限](speech-translation/KNOWN_LIMITS.md) — 現時点で分かっている制限。外部依存、声質変換の品質、ブラウザ差、応答速度が対象です。
- [未決定事項](speech-translation/OPEN_QUESTIONS.md) — まだ判断していない論点。保留している理由と、判断に必要な検証が分かります。

## 画面と操作を変更する

見える公開UIを触る前に読む区分です。

- [公開UIスタイル方針](UI_STYLE.md) — 公開画面の視覚基準。route別のCSS方式、視覚階層、必須状態が分かります。
- [公開フロントエンドの段階移行](deployment/FRONTEND_MIGRATION.md) — React移行の判断と現在の境界。route別の移行状況と次に移す範囲が分かります。
- [UIテスト方針](UI_TESTING.md) — UI回帰の検査方針。自動検査するroute・viewport・ブラウザと、人が実画面で確認する範囲が分かります。

## requestとdataの実行経路を理解する

ブラウザから外部サービスまでの流れと、保存の境界を確認する区分です。

- [現在のデプロイ構成](deployment/ARCHITECTURE.md) — この区分の入口。ブラウザ、Cloudflare Worker、OpenAI、RunPodの担当範囲が分かります。
- [Cloudflareデモ構成](deployment/CLOUDFLARE.md) — 公開Workerの構成。必要なsecret、退役route、デプロイ手順が分かります。
- [RunPodデプロイ手順](deployment/RUNPOD.md) — GPU側の実行契約。handlerのoperation、非同期jobの進捗、request境界が分かります。
- [Cloudflare保存層の境界](deployment/STORAGE.md) — 保存先の使い分け。KV・D1・R2それぞれの用途と保持期間が分かります。
- [公開デモのデータ取扱い境界](deployment/PRIVACY.md) — 実装上のデータ境界。外部へ渡す情報、Voice Labが保存する情報、logの契約が分かります。

## providerとmodelを扱う

ASR・翻訳・TTS・声質変換の差し替えと、モデルの置き場を扱う区分です。

- [ローカル実プロバイダ](speech-translation/LOCAL_PROVIDERS.md) — provider束の構成。起動モードと環境変数による切り替え方が分かります。
- [Seed-VC声質変換方針](speech-translation/VOICE_CLONE.md) — 声質変換の扱い。実行経路、参照音声の前処理、保存方針が分かります。
- [モデル保存とデプロイ方針](deployment/MODEL_STORAGE.md) — モデル本体とキャッシュの置き場。候補モデルの容量目安と外部APIとの比較方針が分かります。

## 公開と運用を行う

公開範囲、外部設定、利用者への説明を扱う区分です。

- [SpeakLoop公開デモ・ポートフォリオ](deployment/PUBLIC_DEMO_ROADMAP.md) — 公開デモの現在地と公開判断。完了済みの技術確認と運用で継続する項目が分かります。
- [Repository・公開デモの運用チェックリスト](deployment/PUBLICATION_CHECKLIST.md) — 公開前後に確認する項目。GitHub、Cloudflare、Docker Hub、RunPodの外部状態が対象です。
- [Voice Lab プライバシーポリシー](PRIVACY_POLICY.md) — 利用者向けの説明。扱う情報、音声の取り扱い、保持期間、問い合わせ先が分かります。
