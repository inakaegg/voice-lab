# RunPodデプロイ手順

## 状態

現時点では、RunPodへ実デプロイする前の準備段階。Dockerfile、RunPod Serverless handler、モデルvolume方針は用意している。実際のendpoint作成、APIキー設定、push、デプロイ実行は認証が必要なため未実行。

最初のGPU確認では、FastAPIのWeb UIとAPIをまとめてRunPodへ載せ、一通り動作するかを先に確認する。RunPodは公開MVPでWeb UIを配信する場所として固定しない。推奨する本番寄り構成では、Cloudflare Pages/Workerを静的UIとgatewayにし、RunPodはGPU推論APIとして使う。構成判断は [ARCHITECTURE.md](ARCHITECTURE.md) を参照する。

## Docker image

ローカルでimageを作る場合:

```sh
docker build -t mo-speech:local .
```

ローカルでFastAPIを起動する場合:

```sh
docker run --rm -p 8000:8000 \
  -e MO_PROVIDER_MODE=local \
  -e MO_TTS_PROVIDER=qwen-seed-vc \
  -v /path/to/model-cache:/models \
  mo-speech:local
```

`/models` は `MODEL_CACHE_DIR` として扱う。モデル本体はimageに入れず、volume mountで渡す。

## RunPod Serverless handler

handlerは `mo_speech.runpod_handler:handler`。RunPodの入力例:

```json
{
  "input": {
    "audio_base64": "<base64 encoded audio>",
    "audio_mime_type": "audio/wav",
    "source_language": "ja-JP",
    "target_language": "zh-CN",
    "voice_mode": "clone"
  }
}
```

レスポンスはFastAPIと同じ主要フィールドを返す。

- `transcript`
- `translated_text`
- `transformed_text`
- `audio_mime_type`
- `audio_base64`
- `timings_ms`
- `providers`
- `warnings`

## 環境変数

| 変数 | 用途 | 例 |
| --- | --- | --- |
| `MO_PROVIDER_MODE` | provider切替 | `local` |
| `MO_TTS_PROVIDER` | TTS/VC provider切替 | `qwen-seed-vc`、`qwen`、`seed-vc` |
| `MODEL_CACHE_DIR` | モデルvolume mount先 | `/models` |
| `MO_PRELOAD_MODELS` | 起動時モデルロード | `1` |
| `MO_ASR_PROVIDER` | ASR provider切替 | `faster-whisper` |
| `FASTER_WHISPER_MODEL` | faster-whisperモデル名 | `turbo` |
| `FASTER_WHISPER_DEVICE` | faster-whisper実行device | `cuda` |
| `FASTER_WHISPER_COMPUTE_TYPE` | faster-whisper計算精度 | `float16`、`int8_float16` |
| `MO_TRANSLATION_PROVIDER` | 翻訳provider切替 | `qwen3` |
| `QWEN_TRANSLATION_MODEL` | Qwen3翻訳モデル | `Qwen/Qwen3-4B` |
| `QWEN_TRANSLATION_DEVICE_MAP` | Qwen3 device配置 | `auto` |
| `QWEN_TRANSLATION_DTYPE` | Qwen3 dtype | `auto` |

APIキーやRunPod tokenはリポジトリに置かない。

## 未完了ゲート

RunPod上で完了扱いにするには、以下が必要。

1. RunPod APIキーまたは管理画面でのendpoint作成権限。
2. Network Volumeまたは同等の永続volume。
3. volumeへfaster-whisper/Qwen3翻訳/TTS/声質クローン候補モデルを配置する手順。
4. デプロイ先 `/health` の確認。
5. 短いfixture音声でのServerless handlerまたはFastAPIスモーク確認。
6. 声質クローンproviderのモデル選定。

これらは認証、モデル配置、大容量モデル、または未決定の声質クローンproviderに関わるため、現時点では実行しない。
