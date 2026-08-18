<!-- 自動生成ファイル。手で書き換えない。 作り直し: python3 scripts/generate_animals_doc.py <sounds-dir> -->

# Zoovoice の対象動物（46種）

**この文書は自動生成である。手で書き換えないこと。**
内容を直すときは鳴き声セットの `manifest.json` を直し、
`python3 scripts/generate_animals_doc.py <sounds-dir>` で作り直す。

この一覧の正本は実際の音声ファイルである。音源のある動物だけが連想の候補になるので、
動物を増やしたり減らしたりするときは音声ファイルの側を変え、この文書を作り直す。

音声ファイルは全部で66本ある。1種に複数本ある動物は、合成のたびにその中から選ばれる。

## 一覧

| 動物 | id | 音声の本数 |
| --- | --- | --- |
| トビ | `black-kite` | 1 |
| イソヒヨドリ | `blue-rock-thrush` | 1 |
| ヒグマ | `brown-bear` | 1 |
| ウシガエル | `bullfrog` | 1 |
| ウグイス | `bush-warbler` | 1 |
| ノスリ | `buzzard` | 1 |
| 猫 | `cat` | 11 |
| チンパンジー | `chimpanzee` | 1 |
| 牛 | `cow` | 1 |
| コオロギ | `cricket` | 1 |
| カラス | `crow` | 2 |
| 犬 | `dog` | 6 |
| イルカ | `dolphin` | 1 |
| ロバ | `donkey` | 1 |
| アヒル | `duck` | 1 |
| ゾウ | `elephant` | 1 |
| フラミンゴ | `flamingo` | 2 |
| キツネ | `fox` | 1 |
| カエル | `frog` | 1 |
| ヤギ | `goat` | 1 |
| ガチョウ | `goose` | 1 |
| ゴリラ | `gorilla` | 1 |
| サギ | `heron` | 2 |
| ヒグラシ | `higurashi` | 1 |
| 馬 | `horse` | 1 |
| ハイエナ | `hyena` | 1 |
| ライオン | `lion` | 1 |
| カイツブリ | `little-grebe` | 3 |
| カササギ | `magpie` | 1 |
| マガモ | `mallard` | 1 |
| ミンミンゼミ | `minminzemi` | 1 |
| フクロウ | `owl` | 1 |
| クジャク | `peacock` | 1 |
| 豚 | `pig` | 1 |
| ハト | `pigeon` | 1 |
| ニワトリ | `rooster` | 1 |
| アシカ | `sea-lion` | 1 |
| 羊 | `sheep` | 1 |
| スズメ | `sparrow` | 1 |
| スズムシ | `suzumushi` | 1 |
| ツバメ | `swallow` | 1 |
| トラ | `tiger` | 1 |
| シチメンチョウ | `turkey` | 1 |
| セキレイ | `wagtail` | 1 |
| クジラ | `whale` | 1 |
| オオカミ | `wolf` | 1 |

## 音声の出どころ

- Taira Komori 利用規約: 31本
- CC0 1.0: 24本
- CC0: 8本
- CC BY 4.0: 3本

出どころと採用した音声の SHA-256 は `manifest.json` に1本ずつ記録してある。
素材そのものはリポジトリへ置かず、container image を作るときだけ取り込む。
