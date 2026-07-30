# Seed-VC声質変換方針

更新日: 2026-07-30

## 目的

Seed-VCはSpeakLoopの「自分の声」と管理画面のVC比較に使う。旧音声翻訳の一部としては扱わず、入力音声を参照話者へ寄せる独立した処理とする。

## 現在の実行経路

SpeakLoopでは通常TTSの音声を変換元にする。同じ練習requestの最初の録音を参照音声にする。別のファイル・URL・ブラウザタブ音声は参照元として受け付けない。

管理画面のVC比較ではsource音声とreference音声を個別に指定する。jobごとに次の設定を変更できる。

- diffusion steps
- 参照音声の上限秒数
- 発話区間の自動選択
- length adjust
- inference cfg rate

Cloudflare公開版ではRunPod Serverlessの非同期jobを使う。ローカルFastAPI版では設定したdirect VC providerを使う。

## 保存方針

- Cloudflare公開版はsource音声・reference音声・変換結果を履歴保存しない。
- ローカルFastAPI版の音声履歴はgit管理外へ置く。
- voice profileを永続保存する機能は提供しない。
- 将来保存する場合は同意・保存先・暗号化・削除方法を先に仕様化する。

## 参照音声の前処理

Seed-VCへ渡すreference音声はサーバー側で短いmono WAVへ正規化する。ブラウザ録音はWebM/Opusになりやすい。無音や余分な長さは処理時間を増やすため前処理する。

既定では先頭10秒までを使う。上限は `SEED_VC_REFERENCE_MAX_SECONDS` で変更できる。sample rateは `SEED_VC_REFERENCE_SAMPLE_RATE` で指定する。

### 発話区間の自動選択

`seed_vc_reference_auto_select` をONにした場合は次の順で処理する。

1. `ffprobe` で参照音声の長さを取得する。
2. `ffmpeg silencedetect` で無音区間を検出する。
3. 上限秒数内で最も長い発話区間を選ぶ。
4. 長すぎる区間は中央寄りから切り出す。
5. 検出できない場合は先頭から切り出す。

この処理は先頭の無音や余分な間を避ける前処理である。音声品質を判定する処理ではない。所要時間は `timings_ms.reference_segment_select` に含める。

管理画面ではSeed-VC本体の実行前にreference音声だけを正規化できる。正規化前後のaudioを聴き比べられる。

## ローカル設定

Seed-VCだけをVC backendとして使う場合:

```sh
MO_VC_BACKENDS=seed-vc \
SEED_VC_PYTHON=path/to/python \
PYTHONPATH=src \
python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

checkpointとconfigを明示する場合は `SEED_VC_CHECKPOINT` と `SEED_VC_CONFIG` を使う。指定しない場合はprovider側の既定配置を使う。モデル取得前に保存先と必要容量を確認する。

主な調整値:

| 変数 | 既定 | 用途 |
| --- | --- | --- |
| `SEED_VC_DIFFUSION_STEPS` | `30` | 速度と品質の調整値。 |
| `SEED_VC_REFERENCE_MAX_SECONDS` | `10` | reference音声の上限秒数。 |
| `SEED_VC_REFERENCE_AUTO_SELECT` | `0` | 発話区間を自動選択する。 |
| `SEED_VC_LENGTH_ADJUST` | `1.0` | 出力長を調整する。 |
| `SEED_VC_INFERENCE_CFG_RATE` | `0.7` | CFG係数。 |
| `SEED_VC_FP16` | `false` | 対応GPUで半精度を使う。 |

## 検証

自動テストではrequest設定・reference前処理・provider呼び出しをfakeで確認する。

```sh
python3 -m pytest tests/test_voice_providers.py tests/test_api.py
```

実モデルの品質と速度は環境依存である。実行時はsourceとreferenceを固定し、cold startとwarm実行を分けて記録する。
