# CLI 一覧

手元で機能を確かめるためのコマンド。機能を追加したら、その確認手段をここへ追記する。

## zoovoice preview — 連想と合成の確認

発話（テキストまたは音声）から動物を連想し、鳴き声を重ねた音声を作る。サーバ本体と同じ処理を通る。

### 1. 準備（1回だけ）

```sh
cd /path/to/mo/services/zoovoice && go build -o /tmp/zoovoice-cli . && cd /path/to/mo
```

### 2. テキストから連想だけ確認する

下のブロックをそのまま貼れば動く。

```sh
cd /path/to/mo
export OPENAI_API_KEY=$(grep -m1 '^OPENAI_API_KEY=' .env | cut -d= -f2- | tr -d '"')
ZOOVOICE_ASSETS_DIR=services/zoovoice/assets \
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
    クレジット: Stability AI Community License / stabilityai/stable-audio-3-small-sfx / https://stability.ai/license
```

### 3. 音声から合成まで確認する

確認用の入力音声を作ってから実行する。これもそのまま貼れば動く。

```sh
cd /path/to/mo
say -v Kyoko -o /tmp/zv-in.aiff "昨日の夜、屋根の上で何かがずっと鳴いていました"
ffmpeg -y -v error -i /tmp/zv-in.aiff -ar 16000 -ac 1 /tmp/zv-in.wav

export OPENAI_API_KEY=$(grep -m1 '^OPENAI_API_KEY=' .env | cut -d= -f2- | tr -d '"')
export W=/path/to/ext/pj/whisper.cpp/build
ZOOVOICE_ASSETS_DIR=services/zoovoice/assets \
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
  クレジット: Stability AI Community License / stabilityai/stable-audio-3-small-sfx / https://stability.ai/license

挿入位置:
  opening 0.00秒
  ending  3.91秒

合成音声: /tmp/zv-out.wav（入力3.9秒 → 出力8.9秒）
afplay等で再生して確認できます。
```

### 補足

- `-intensity 0〜100`（既定50）で鳴き声の挿入頻度を変えられる。`-verbose` で処理ログが標準エラーへ出る。
- `go run` ではなくビルドした実行ファイルを使う。署名付きの `go` 経由だと `DYLD_LIBRARY_PATH` が whisper-cli へ渡らず、音声認識が起動しない。
- `ZOOVOICE_SOUNDS_DIR` を外すと、リポジトリ同梱の26種（`services/zoovoice/assets/animal-sounds`）で動く。
- 動物の連想はOpenAI APIを呼ぶので、`OPENAI_API_KEY` が要る。テキスト入力ならこれだけで動く。
