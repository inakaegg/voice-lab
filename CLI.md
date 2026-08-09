# CLI 一覧

手元で機能を確かめるためのコマンドをまとめる。機能を追加したら、その確認手段をここへ追記する。

## 準備（zoovoice 共通）

```sh
cd services/zoovoice && go build -o /tmp/zoovoice-cli .
```

`go run` ではなくビルドした実行ファイルを使う。macOS の署名付き `go` 経由だと下の `DYLD_LIBRARY_PATH` が子プロセスへ渡らず、音声認識が起動しないため。

環境変数（音声を渡すときだけ ASR 系が要る）:

| 変数 | 例 | 用途 |
| --- | --- | --- |
| `ZOOVOICE_ASSETS_DIR` | `services/zoovoice/assets` | 動物レキシコン等の置き場 |
| `ZOOVOICE_SOUNDS_DIR` | `tmp1/final` | 鳴き声素材の置き場（未指定なら assets 同梱） |
| `ZOOVOICE_CONCEPTNET_INDEX_PATH` | `/path/to/ext/pj/models/zoovoice/conceptnet-ja-5.7.0-schema2-lex8572568d.sqlite` | 連想に使う ConceptNet 索引 |
| `ZOOVOICE_WHISPER_COMMAND` | `/path/to/ext/pj/whisper.cpp/build/bin/whisper-cli` | 音声認識の実行ファイル |
| `ZOOVOICE_ASR_MODEL_PATH` | `/path/to/ext/pj/whisper.cpp/models/ggml-small.bin` | 音声認識のモデル |
| `DYLD_LIBRARY_PATH` | `/path/to/ext/pj/whisper.cpp/build/src:.../ggml/src:.../ggml/src/ggml-blas:.../ggml/src/ggml-metal` | whisper-cli が参照する共有ライブラリ |

## zoovoice preview — 連想と合成の確認

入力テキストまたは入力音声を渡し、連想された動物・使った鳴き声素材とクレジット・合成音声を表示する。サーバ本体と同じ処理を通る。

```
zoovoice preview (-text <入力テキスト> | -audio <音声ファイル>) [-out 出力.wav] [-intensity 0-100] [-verbose]
```

### テキストを渡す（連想だけ確認）

```sh
ZOOVOICE_ASSETS_DIR=services/zoovoice/assets \
ZOOVOICE_SOUNDS_DIR=tmp1/final \
ZOOVOICE_CONCEPTNET_INDEX_PATH=/path/to/ext/pj/models/zoovoice/conceptnet-ja-5.7.0-schema2-lex8572568d.sqlite \
/tmp/zoovoice-cli preview -text "牧場で干し草の匂いがした"
```

```
動物カタログ: 26種
注: 音源はあるが連想語彙が未整備のため選ばれない動物が20種あります: black-kite, ...

入力テキスト: 牧場で干し草の匂いがした
連想した動物: 牛（cow）
決まった経路: conceptnet（ConceptNetの連想で関係の重み合計が最大）
根拠語: 牧場
連想の内訳（スコア上位）:
  概念「牧場」 AtLocation 重み5.95×1.00=5.95

鳴き声素材:
  tmp1/final/cow/cow-1.wav
    クレジット: CC0 1.0 / JarredGibb / https://freesound.org/people/JarredGibb/sounds/233134
```

### 音声を渡す（文字起こしから合成まで）

上の環境変数に加えて `ZOOVOICE_WHISPER_COMMAND` / `ZOOVOICE_ASR_MODEL_PATH` / `DYLD_LIBRARY_PATH` を付ける。

```sh
/tmp/zoovoice-cli preview -audio /tmp/zv-in.wav -out /tmp/zv-out.wav
```

```
入力音声: /tmp/zv-in.wav（処理中。ASRに数十秒かかることがあります）
文字起こし: 昨日の夜、屋根の上で、何かがずっと泣いていました。
連想した動物: 猫（cat）
決まった経路: conceptnet（ConceptNetの連想で関係の重み合計が最大）
根拠語: 屋根

使った鳴き声素材:
  tmp1/final/cat/cat-9.wav
  tmp1/final/cat/cat-10.wav
  クレジット: Taira Komori 利用規約（商用・加工可、素材そのものの再配布・販売・直リンク禁止） / 小森平（Taira Komori） / https://taira-komori.net/

挿入位置:
  opening 0.00秒
  ending  3.91秒

合成音声: /tmp/zv-out.wav（入力3.9秒 → 出力5.3秒）
afplay等で再生して確認できます。
```

確認用の入力音声は `say -v Kyoko -o in.aiff "…"` と `ffmpeg -i in.aiff -ar 16000 -ac 1 in.wav` で作れる。

## zoovoice association-eval — 連想方式の比較

用意した例文集（fixture）に対して連想結果をまとめて出し、方式 A/B/C を比べる。単発の確認ではなく、方式を変えたときの良し悪しを測るためのもの。

```sh
/tmp/zoovoice-cli association-eval extract  -fixtures <例文.json> [-output -]
/tmp/zoovoice-cli association-eval evaluate -fixtures <例文.json> -expansions <展開語.json> \
  -lexicon services/zoovoice/assets/animal-lexicon.json -index <ConceptNet索引.sqlite> \
  -candidate A -seed 7 [-output -]
```

結果は JSON で標準出力へ出る（`-output` でファイルにも書ける）。

## データを作り直す CLI

素材やレキシコンを更新したときだけ使う。いずれも出力先を明示して実行する。

| コマンド | 役割 |
| --- | --- |
| `go run ./cmd/animal-lexicon -source <conceptnet.csv.gz> -source-sha256 <SHA> -judgments <判断記録.json> -audio-manifest <音源manifest.json> -output <animal-lexicon.json>` | 動物レキシコンを作り直す |
| `go run ./cmd/conceptnet-index -source <conceptnet.csv.gz> -source-sha256 <SHA> -lexicon <animal-lexicon.json> -output <索引.sqlite>` | 連想用の索引を作り直す（約2分） |
| `go run ./cmd/synonym-index -source <wnja-2.0.xml> -output <索引.sqlite>` | 日本語 WordNet の同義語索引を作る |
| `python3 scripts/select_animal_sounds.py` | `tmp1/` の3系統から優先順位で最終セット `tmp1/final/` を選び直す |
| `node scripts/sync_zoovoice_animals.mjs` | レキシコンから Web 側の動物リストを同期する |

レキシコンを作り直したら連想索引も作り直す。索引はレキシコンの SHA と対応しており、古い索引は使えない。
