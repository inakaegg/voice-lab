# VibeVoiceスキット生成

## 現在の位置づけ

`/vibevoice` は、`zhskit` のスキット生成機能をこのアプリへ移すための検証画面である。台本、最大4つの参照音声、生成パラメータを入力し、VibeVoiceでWAVを生成する。

初期実装では、ローカル実行とRunPod Serverless実行を選べる。ローカル実行は開発機上のVibeVoice CLIを呼ぶ。RunPod実行はFastAPIがRunPod jobを作り、RunPod handlerが `operation_mode=vibevoice` として同じ処理を実行する。

## 生成オプション

- `ランダム性を使う`: VibeVoiceのsamplingを有効にする。同じ台本でもseedや設定によって抑揚や細部が変わる。安定性を優先して比較したい場合はOFFも試す。
- `行ごとに生成して結合`: 台本全体を一度に生成せず、1行ずつ生成して無音を挟んで結合する。長文や複数発話で破綻を分けやすい一方、行間や話し方の連続性は不自然になる可能性がある。
- `参照音声秒数`: 参照音声の先頭から使う長さ。長すぎると処理が重くなり、短すぎると声質特徴が不足する。

## モデル配置方針

モデル本体やComfyUI-VibeVoice拡張はリポジトリへ入れない。今後はプロジェクトごとの作業ディレクトリではなく、共有モデルルートへ寄せる。

推奨するローカル配置:

```text
/Volumes/KIOXIA_1T/pj/models/
  vibevoice/
    huggingface/hub/
      models--microsoft--VibeVoice-1.5B/
      models--Qwen--Qwen2.5-1.5B/
    ComfyUI-VibeVoice/
```

対応する環境変数:

```bash
export MO_VIBEVOICE_HOME=/Volumes/KIOXIA_1T/pj/models/vibevoice/huggingface/hub
export COMFYUI_VIBEVOICE_PATH=/Volumes/KIOXIA_1T/pj/models/vibevoice/ComfyUI-VibeVoice
export MO_VIBEVOICE_CLI=/path/to/vibevoice.py
export MO_VIBEVOICE_PYTHON=/path/to/python
```

RunPod Network Volumeでは、モデルキャッシュを `/workspace` または `/runpod-volume` 配下に置く。ComfyUI-VibeVoice拡張はDocker image内の `/app/ComfyUI-VibeVoice` に入れる構成を既定とし、別途Volumeへ置く場合だけ環境変数で上書きする。

```bash
MO_VIBEVOICE_HOME=/workspace/models/vibevoice/huggingface/hub
COMFYUI_VIBEVOICE_PATH=/app/ComfyUI-VibeVoice
MO_VIBEVOICE_CLI=/app/src/mo_speech/vibevoice_cli.py
```

## 既知の品質課題

- 日本語の漢字読みが誤ることがある。例として、参照音声が中国語の場合に「最近」を中国語読みへ寄せるなど、参照音声言語の影響を受ける可能性がある。
- 日本語参照音声でも漢字読みを誤る場合がある。台本をひらがなにすると改善するため、テキスト正規化または読み指定の仕組みが必要。
- 途中にノイズや不自然な音が混じることがある。RunPod実行、依存ライブラリ、GPU、生成パラメータ、参照音声前処理の差分を分けて検証する。
- 台本全体生成と行ごと生成では、自然さ、破綻のしにくさ、行間の違和感が変わる。品質比較用に生成設定と入力台本を保存できる仕組みが今後必要。

## zhskitから未移植の主な機能

- 台本URL読み込み。
- 参照音声URL読み込み。
- 生成結果のクラウドアップロード。
- スキット作成支援、台本拡張、HSK教材生成、動画レンダリングなどの周辺機能。
- 生成履歴とパラメータ比較。

これらはVibeVoice生成品質とRunPod実行経路が安定した後に、必要なものだけ移植する。
