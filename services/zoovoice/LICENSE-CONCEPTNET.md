# ConceptNet派生データベースのライセンス表示

更新日: 2026-08-04

Zoovoiceの動物連想は、ConceptNet 5.7.0から作った日本語の派生データベースを使う。この文書はその帰属と再配布条件を示す。Cloud Run用imageへは `/app/licenses/LICENSE-CONCEPTNET.md` として同梱する。

## 帰属

このデータベースはConceptNet 5.7.0を元にした派生物である。ConceptNetプロジェクト自身の配布物ではなく、Zoovoice向けに抽出した部分集合である。

| 項目 | 内容 |
| --- | --- |
| 元データ | ConceptNet 5.7.0 assertions |
| 取得元 | `https://s3.amazonaws.com/conceptnet/downloads/2019/edges/conceptnet-assertions-5.7.0.csv.gz` |
| プロジェクト | [ConceptNet](https://conceptnet.io/) |
| ライセンス | Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) |

ライセンス本文は公式ページを正とする。本書へは全文を転載しない。

- 概要: [CC BY-SA 4.0 Deed](https://creativecommons.org/licenses/by-sa/4.0/)
- 全文: [CC BY-SA 4.0 Legal Code](https://creativecommons.org/licenses/by-sa/4.0/legalcode)

## 変換内容

派生データベースは元データから次の手順で作る。実装の正は `internal/conceptindex` と `cmd/conceptnet-index` とする。

1. 両端が日本語概念（`/c/ja/`）のedgeだけを対象にする。
2. 片方の端点だけが動物レキシコンの語へ一致するedgeを残す。動物レキシコンとは、`assets/animal-lexicon.json` が持つ種ごとの語とオノマトペの生成物を指す。
3. 残ったedgeを概念・動物ID・関係の組で保存する。同じ組が重複した場合は最大weightだけを残す。
4. 出力はSQLiteファイルとし、概念による検索indexを付ける。

抽出と集約だけを行い、元データの語・関係・weightの値は書き換えない。

## 生成物のmetadata

派生データベースは `metadata` テーブルへ次を保存する。配備scriptはこの値と生成物のSHA-256を検査してからimageを作る。

| key | 内容 |
| --- | --- |
| `schema_version` | 派生データベースのschema世代 |
| `source_version` | ConceptNetのversion |
| `source_url` | 元データの取得元URL |
| `source_sha256` | 元データのSHA-256 |
| `license` | `CC BY-SA 4.0` |
| `transformation` | 変換内容の短い説明 |
| `lexicon_sha256` | 変換に使った `assets/animal-lexicon.json` のSHA-256 |
| `generated_at` | 生成完了時刻（UTC） |

## share-alike条件

CC BY-SA 4.0はshare-alikeを求める。この派生データベースを配布または再配布する場合は、CC BY-SA 4.0または互換ライセンスで提供し、本書と同等の帰属表示を添える。

この条件はデータベースとその内容だけに適用する。Zoovoiceのコード、同梱する動物音、whisper.cppとモデルには適用しない。同梱する動物音のうちStable Audioで生成した24件は [NOTICE-STABILITY-AI.md](NOTICE-STABILITY-AI.md) を正とする。リポジトリ本体の権利は [LICENSE](../../LICENSE)、その他の第三者成果物は [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) を参照する。
