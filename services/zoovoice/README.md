# Zoovoice 音声合成サービス

Zoovoice は発話の無音区間へ動物の鳴き声を重ねるローカルデモです。
このディレクトリには Go 製の合成 API と素材マスタを置いています。
Phase 1 では Cloud Run や Cloudflare Worker へデプロイしません。

## 必要なソフトウェア

- Go 1.21 以上
- ffmpeg と ffprobe
- ローカル画面も使う場合は Voice Lab 本体の Python と Node.js 環境

## 起動方法

リポジトリの `services/zoovoice` へ移動して起動します。

```sh
go run .
```

既定では CC0 の12種だけを読み込みます。
repo 外の追加素材も使う場合は規格化済み WAV のディレクトリを指定します。

```sh
ZOOVOICE_EXTRA_ASSETS_DIR=<repo-outside-assets>/taira-komori go run .
```

別のターミナルで FastAPI を起動すると `/zoovoice` から利用できます。

```sh
PYTHONPATH=src \
  ZOOVOICE_BACKEND_URL=http://127.0.0.1:8090 \
  python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

ブラウザで `http://127.0.0.1:8000/zoovoice` を開きます。
画面は録音した音声をローカルの Go サービスへ送信します。

## 環境変数

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `ZOOVOICE_PORT` | `8090` | Go API の待受ポート |
| `ZOOVOICE_ASSETS_DIR` | 自動検出した `assets` | `animals.json` と `cc0/` の親ディレクトリ |
| `ZOOVOICE_EXTRA_ASSETS_DIR` | 未設定 | repo 外の追加 WAV ディレクトリ |
| `ZOOVOICE_TIMEOUT_SECONDS` | `30` | ffmpeg と ffprobe を含む1リクエストの上限秒数 |
| `ZOOVOICE_LOG_PATH` | リポジトリ直下の `logs/zoovoice.log` | JST時刻と経過時間を含むサービスログ |
| `ZOOVOICE_BACKEND_URL` | `http://127.0.0.1:8090` | FastAPI proxy が接続する Go API |

追加素材の場所が未設定または不在でも起動できます。
その場合は警告をログへ記録し、実在する CC0 素材だけを公開します。

## API

Go API はローカルの内部 API です。
ブラウザは同じ契約を FastAPI の `/api/zoovoice/*` 経由で利用します。

### `GET /healthz`

プロセスの生存確認です。

```json
{"status":"ok"}
```

### `GET /animals`

現在使える種とバリアント数を返します。
素材ファイル名や素材単体の音声は返しません。

```json
{
  "animals": [
    {"id": "cat", "label_ja": "猫", "variants": 1}
  ]
}
```

### `POST /compose`

`multipart/form-data` で次の2フィールドを送ります。

- `audio`: 録音ファイル。上限は10MBかつ60秒です。
- `settings`: `arrangement` と `intensity` を持つ JSON 文字列です。

`arrangement` の各値は種ID、`"lucky"`、`null` のいずれかです。
`intensity` は0から100までの整数です。

```sh
curl -X POST http://127.0.0.1:8090/compose \
  -F 'audio=@<recording.webm>' \
  -F 'settings={"arrangement":{"opening":"rooster","gaps":"cow","ending":"rooster"},"intensity":50}'
```

成功時は合成済み WAV を base64 で返します。
発話部分が合計0.5秒未満の場合は `422` で拒否します。

```json
{
  "audio": {"format": "wav", "base64": "..."},
  "meta": {
    "insertions": [
      {"slot": "opening", "species": "rooster", "at_seconds": 0}
    ],
    "input_duration_seconds": 3.2,
    "output_duration_seconds": 4.6
  }
}
```

エラーは `{"error":{"code":"...","message":"..."}}` の形です。
動物音単体を取得または試聴する API はありません。

## 素材の準備

`tools/prepare_assets.sh` は取得済みの音源を実行時形式へ規格化します。
素材の取得自体は行いません。

```sh
./tools/prepare_assets.sh <raw-cc0-dir> <raw-extra-dir> <output-dir>
```

一方の素材群を処理しない場合は入力ディレクトリの代わりに `-` を渡します。
出力は `<output-dir>/cc0` と `<output-dir>/extra` へ分かれます。
追加素材を使う際は後者を `ZOOVOICE_EXTRA_ASSETS_DIR` に指定します。

処理内容は次のとおりです。

1. `-40dB` を閾値として先頭無音を除去する。
2. `0.5` 秒以上の内部無音で最初の鳴き声を切り出す。
3. `2.5` 秒を上限とし、末尾 `0.35` 秒を fade out する。
4. ピークを `-1dBFS` へ正規化する。
5. `24kHz`、mono、signed 16-bit PCM WAV へ変換する。

切り出し結果が0.15秒未満なら全長版へフォールバックします。
進捗はリポジトリ直下の `logs/zoovoice-prepare-assets.log` へ残します。
このスクリプトは取得条件を伴う素材準備用なので CI では実行しません。

## 同梱する CC0 素材

12件は Freesound の各配布ページから取得した CC0 音源です。
`assets/manifest.json` には取得時の元音源 SHA-256 と取得日も保存しています。

| 種 | タイトル | 作者 | 配布ページ |
| --- | --- | --- | --- |
| 犬 | Single Dog Bark | kwahmah_02 | [Freesound 277058](https://freesound.org/people/kwahmah_02/sounds/277058) |
| 猫 | Cat meow | philsapphire | [Freesound 256452](https://freesound.org/people/philsapphire/sounds/256452) |
| 牛 | Cow - Moo 5 - 96kHz.wav | JarredGibb | [Freesound 233134](https://freesound.org/people/JarredGibb/sounds/233134) |
| おんどり | Rooster crow | jsbarrett | [Freesound 200339](https://freesound.org/people/jsbarrett/sounds/200339) |
| 馬 | Horse | poodaddy69 | [Freesound 521246](https://freesound.org/people/poodaddy69/sounds/521246) |
| 羊 | sheep 3.mp3 | esperar | [Freesound 171149](https://freesound.org/people/esperar/sounds/171149) |
| ヤギ | Single Goat Bleating 2x | Kinoton | [Freesound 581240](https://freesound.org/people/Kinoton/sounds/581240) |
| カモ・アヒル | Toy Ducks Quacking | nebyoolae | [Freesound 348791](https://freesound.org/people/nebyoolae/sounds/348791) |
| カエル | Frog croaking sound effect | betterchinese | [Freesound 354132](https://freesound.org/people/betterchinese/sounds/354132) |
| コオロギ | Crickets chirping loop | Patrick_Corra | [Freesound 633196](https://freesound.org/people/Patrick_Corra/sounds/633196) |
| ゾウ | Elephant Trumpets Growls.flac | D.jones | [Freesound 527845](https://freesound.org/people/D.jones/sounds/527845) |
| ライオン | lion roar | bkyte | [Freesound 510476](https://freesound.org/people/bkyte/sounds/510476) |

各音源のライセンスは [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) です。

## repo 外の追加素材

小森平の動物効果音は repo に同梱しません。
素材ファイルの再配布を避け、利用環境が用意した規格化済み WAV だけを読み込みます。

- 取得元: [動物～フリー効果音・無料効果音素材](https://taira-komori.net/animals01.html)
- 利用規約: [無料効果音で遊ぼう！](https://taira-komori.net/welcome.html)

追加素材が存在する場合でも `/animals` は種と件数だけを返します。
合成結果以外から追加素材を取り出す経路は提供しません。

## 検証

```sh
go vet ./...
go test ./...
```

統合テストには ffmpeg で生成した決定的な fixture を使います。
repo 外の追加素材がない環境でも全テストが通ります。
