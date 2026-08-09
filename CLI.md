# 手元で動かす手順

機能を確かめるための入口は2つ。機能を追加したら、その確認手段をここへ追記する。

| 確認したいこと | 使うもの | 見出し |
| --- | --- | --- |
| 連想の結果・合成音声（文字だけで速く回したい） | `preview` コマンド | [1. CLI で確かめる](#1-cli-で確かめる) |
| 画面の見た目・録音ボタン・再生まで通しで | ブラウザ（ローカルサーバ） | [2. ブラウザで確かめる](#2-ブラウザで確かめる) |

どちらもサーバ本体と同じ処理を通る。

## 共通の準備

`.env` の `OPENAI_API_KEY` を使う。音声を入れる場合は whisper.cpp も要る。

| 環境変数 | 中身 | 手元での値 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 動物を連想する OpenAI API のキー | `.env` から読む |
| `ZOOVOICE_WHISPER_COMMAND` | 文字起こしの実行ファイル | `/path/to/ext/pj/whisper.cpp/build/bin/whisper-cli` |
| `ZOOVOICE_ASR_MODEL_PATH` | 文字起こしのモデル | `/path/to/ext/pj/whisper.cpp/models/ggml-small.bin` |
| `ZOOVOICE_SOUNDS_DIR` | 鳴き声素材の置き場（必須） | `tmp1/final`（46種） |

## 1. CLI で確かめる

### 準備（1回だけ）

```sh
cd /path/to/mo/services/zoovoice && go build -o /tmp/zoovoice-cli . && cd /path/to/mo
```

### 使い方

| やること | 指定 |
| --- | --- |
| テキストから連想だけ見る | `-text "…"` |
| 音声から合成まで通す | `-audio 入力.wav -out 出力.wav` |
| 鳴き声の入る量を変える | `-intensity 0〜100`（既定50） |
| 処理の途中経過を見る | `-verbose`（標準エラーへ出る） |

### テキストから連想だけ確認する

下のブロックをそのまま貼れば動く。

```sh
cd /path/to/mo
export OPENAI_API_KEY=$(grep -m1 '^OPENAI_API_KEY=' .env | cut -d= -f2- | tr -d '"')
ZOOVOICE_SOUNDS_DIR=tmp1/final \
/tmp/zoovoice-cli preview -text "夜中に遠吠えが聞こえた"
```

実際の出力:

```
動物カタログ: 46種（すべて連想の候補になります）

入力テキスト: 夜中に遠吠えが聞こえた
連想した動物: オオカミ（wolf）
連想の理由: 夜中の遠吠えといえば、月夜に響くオオカミの声を連想します。

鳴き声素材:
  tmp1/final/wolf/wolf-1.wav
    クレジット: CC0 1.0 / craigsmith / https://freesound.org/people/craigsmith/sounds/675445
```

### 音声から合成まで確認する

確認用の入力音声を作ってから実行する。これもそのまま貼れば動く。

```sh
cd /path/to/mo
say -v Kyoko -o /tmp/zv-in.aiff "昨日の夜、屋根の上で何かがずっと鳴いていました"
ffmpeg -y -v error -i /tmp/zv-in.aiff -ar 16000 -ac 1 /tmp/zv-in.wav

export OPENAI_API_KEY=$(grep -m1 '^OPENAI_API_KEY=' .env | cut -d= -f2- | tr -d '"')
export W=/path/to/ext/pj/whisper.cpp/build
ZOOVOICE_SOUNDS_DIR=tmp1/final \
ZOOVOICE_WHISPER_COMMAND=$W/bin/whisper-cli \
ZOOVOICE_ASR_MODEL_PATH=/path/to/ext/pj/whisper.cpp/models/ggml-small.bin \
DYLD_LIBRARY_PATH=$W/src:$W/ggml/src:$W/ggml/src/ggml-blas:$W/ggml/src/ggml-metal \
/tmp/zoovoice-cli preview -audio /tmp/zv-in.wav -out /tmp/zv-out.wav

afplay /tmp/zv-out.wav
```

実際の出力:

```
動物カタログ: 46種（すべて連想の候補になります）

入力音声: /tmp/zv-in.wav（処理中。ASRに数十秒かかることがあります）
文字起こし: 昨日の夜、屋根の上で、何かがずっと泣いていました。
連想した動物: フクロウ（owl）
連想の理由: 夜の屋根で泣く声といえば、怪しげに鳴くフクロウを連想します。

使った鳴き声素材:
  tmp1/final/owl/owl-1.wav
  クレジット: CC0 1.0 / faxfaxfax / https://freesound.org/people/faxfaxfax/sounds/655380

挿入位置:
  opening 0.00秒
  ending  3.91秒

合成音声: /tmp/zv-out.wav（入力3.9秒 → 出力8.9秒）
afplay等で再生して確認できます。
```

## 2. ブラウザで確かめる

`npm run dev:zoovoice` が、画面・Cloudflare Worker・連想と合成の API をまとめて立ち上げる。
下のブロックをそのまま貼れば動く。

```sh
cd /path/to/mo
export OPENAI_API_KEY=$(grep -m1 '^OPENAI_API_KEY=' .env | cut -d= -f2- | tr -d '"')
export W=/path/to/ext/pj/whisper.cpp/build
ZOOVOICE_WHISPER_COMMAND=$W/bin/whisper-cli \
ZOOVOICE_ASR_MODEL_PATH=/path/to/ext/pj/whisper.cpp/models/ggml-small.bin \
ZOOVOICE_WHISPER_LIB_PATH=$W/src:$W/ggml/src:$W/ggml/src/ggml-blas:$W/ggml/src/ggml-metal \
ZOOVOICE_SOUNDS_DIR=tmp1/final \
npm run dev:zoovoice
```

`Ready on http://127.0.0.1:8787` と出たら、ブラウザで **http://127.0.0.1:8787/zoovoice** を開く。
止めるときは Ctrl+C。

| 立ち上がるもの | 場所 | 役目 |
| --- | --- | --- |
| 画面と Worker | http://127.0.0.1:8787 | ブラウザが開く入口 |
| 連想と合成の API | http://127.0.0.1:8090 | Worker が中で呼ぶ本体 |

ポートを変えたいときは `ZOOVOICE_DEV_PORT`（画面側）と `ZOOVOICE_API_PORT`（API側）を指定する。
別のプロジェクトが 8787 を使っている場合はこれで避けられる。

```sh
ZOOVOICE_DEV_PORT=8788 ZOOVOICE_API_PORT=8091 …（上と同じ環境変数）… npm run dev:zoovoice
```

### 補足

- `ZOOVOICE_WHISPER_LIB_PATH` は whisper.cpp の共有ライブラリの場所。macOS は `npm` を経由すると
  `DYLD_LIBRARY_PATH` を捨ててしまうため、この名前で渡してスクリプト側で付け直している。
  指定しないと文字起こしが起動せず、録音を送っても「音声を文字に変換できませんでした」になる。
- ボット判定（Turnstile）はローカルでは常に通る鍵で動くので、画面から確認するだけなら設定は要らない。
- 動物一覧（`/api/zoovoice/animals`）は起動中の API が読んだ鳴き声セットをそのまま返すので、
  `ZOOVOICE_SOUNDS_DIR` を指定すればその中身が出る。

### 全体の補足

- `go run` ではなくビルドした実行ファイルを使う。署名付きの `go` 経由だと `DYLD_LIBRARY_PATH` が
  whisper-cli へ渡らず、音声認識が起動しない。
- `ZOOVOICE_SOUNDS_DIR` は必須。鳴き声素材はリポジトリに置かず、ここで場所を渡す（手元では `tmp1/final` の46種）。
- 動物の連想は OpenAI API を呼ぶので、`OPENAI_API_KEY` が要る。テキスト入力ならこれだけで動く。
