# 声質クローン方針

更新日: 2026-07-20

## 目的

ローカル音声翻訳（研究機能）では、入力話者の声を出力音声に反映する。声質クローンは後付けの例外処理ではなく、APIとpipelineの明示的な `voice_mode` として扱う。

## voice mode

- `default`: fake providerでAPI/UI確認に使う。local providerでは使わない。
- `clone`: 入力音声を参照音声として、TTS時点で声質を寄せる。Qwen3-TTS Baseを使う。
- `convert`: モデルTTSで音声生成した後、Seed-VCで入力話者の声へ変換する。

違いは処理順である。`clone` はQwen3-TTSが「テキスト、参照音声、参照テキスト」を受け取り、最初から声を寄せた出力音声を生成する。`convert` は、まずQwen3-TTSで出力言語の音声を作り、その生成音声をSeed-VCで入力音声の話者らしさへ変換する。

`MO_TTS_PROVIDER=qwen-seed-vc` では `clone` と `convert` の両方を選択できる。対応providerが設定されていない `voice_mode` は設定エラーとして返す。

ルート別の扱い:

- `id-ID -> ja-JP`: Seed-VCの `convert` を推奨経路にする。
- `ja-JP -> zh-CN`: Qwen3-TTSの `clone` とSeed-VCの `convert` を比較する。

現時点の聴感確認ではSeed-VCの `convert` の方が入力話者に近いため、UIの初期選択は `convert` にする。

## 保存方針

- 既定では入力音声、生成音声、voice profileを永続保存しない。
- voice profileを保存する機能を追加する場合は、実装前に次を仕様化する。
  - 保存の同意をどの画面で得るか。
  - 保存先と暗号化の有無。
  - 削除方法。
  - voice profileをエクスポートできるか。

## 参照音声の前処理

Qwen3-TTSは参照音声とその文字起こしを使う。参照音声の言語がモデルの明示対応外の場合は、speaker embeddingのみを使う設定に切り替える。

Seed-VCでは、翻訳後TTS音声を `source`、入力音声を `target` として扱う。これはSeed-VCのCLIが `source` を変換元音声、`target` を参照音声として扱うためである。

Seed-VCへ渡す `target` は、アップロード音声そのものではなく、サーバー側で短いmono WAVへ正規化した参照音声にする。ブラウザ録音はWebM/Opusになりやすく、無音や余分な長さを含むとSeed-VCの処理時間が大きく伸びるためである。既定では先頭10秒までを使い、`SEED_VC_REFERENCE_MAX_SECONDS` と `SEED_VC_REFERENCE_SAMPLE_RATE` で調整できる。

### 発話区間の自動選択

UIの `参照音声の発話区間を自動選択`（`seed_vc_reference_auto_select`）をONにした場合は、先頭からの単純な切り出しではなく、軽量な発話区間選択を行う。

- `ffprobe` で参照音声の長さを取得する。
- `ffmpeg silencedetect` で無音区間を検出し、無音ではない区間を発話候補として扱う。
- 候補のうち、上限秒数内で最も長い発話区間を選ぶ。
- 候補が上限秒数より長い場合は、区間の中央寄りから上限秒数ぶんを切り出す。
- 候補が取れない場合や検出が失敗する場合は、従来どおり先頭から切り出す。

この処理は先頭の無音や余計な間を避けるための前処理であり、音声品質を厳密に判定するものではない。ノイズを理由に参照音声を空にはしない。所要時間はAPIレスポンスの `timings_ms.reference_segment_select` に入る。

UIでは、Seed-VC本体を実行する前に参照音声の正規化だけを実行し、正規化前後をaudio要素で聴き比べられる。翻訳モードでは入力音声、VC比較モードでは参照音声ファイルを対象にする。

## ローカル設定

Qwen3-TTSとSeed-VCを比較できる状態で使う場合:

```sh
MO_PROVIDER_MODE=local \
MO_TTS_PROVIDER=qwen-seed-vc \
QWEN_TTS_PYTHON=path/to/python \
SEED_VC_PYTHON=path/to/python \
QWEN_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-1.7B-Base \
PYTHONPATH=src python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

Qwen3-TTSだけなら `MO_TTS_PROVIDER=qwen`、Seed-VCの変換経路だけなら `MO_TTS_PROVIDER=seed-vc` を指定する。

Seed-VCは、checkpointとconfigを明示しない場合、初回実行時に公式の既定モデルを取得する。配置済みのファイルを使う場合は `SEED_VC_CHECKPOINT` と `SEED_VC_CONFIG` を指定する。

## 確認済みの動作と制限

短い参照音声で、`clone`（Qwen3-TTS Base）と `convert`（Seed-VC）のWAV生成を確認済み。CPU実行では短文でも十数秒以上かかり、実用速度には届かない。現状のローカル実装はモデル評価とAPI契約の確認を目的とし、低遅延本番経路ではない。

## 未評価候補

- Qwen3-TTS CustomVoice: 指示による声色制御として別途評価する。
- OpenVoice: Seed-VCで声質類似度または速度が不足する場合に比較する。
- 外部API: 完全除外はしないが、導入前に費用、キー管理、依存リスクをdocsに明記する。
