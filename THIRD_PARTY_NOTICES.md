# 第三者コンポーネントとライセンス境界

更新日: 2026-07-17

Voice Lab本体にはオープンソースライセンスを付与していない。リポジトリ直下の [LICENSE](LICENSE) はVoice Lab本体に適用し、第三者のソフトウェア、モデル、データに既に付与されている権利を変更しない。

## ブラウザbundle

Vite production buildには以下が含まれる。

- React、React DOM
- OpenCC JS
- Lucide
- Tailwind CSS
- clsx、tailwind-merge等

Viteの `build.license` で、bundleへ実際に含まれた依存の情報を次へ自動生成する。生成する情報は名称、version、ライセンス識別子、ライセンス本文である。

- `src/mo_speech/web/react/assets/licenses.md`

このファイルをbundled dependency licensesの正とし、Python wheelにも同梱する。生成済みJavaScriptには同ファイルへの参照を付ける。OpenCC JSが同梱する辞書データは `opencc-data` の派生物でApache-2.0が適用されるため、build後にpackage内の `THIRD_PARTY_LICENSES.md` を同じ生成物へ追記する。依存更新後は `npm run check:web` で再生成し、管理対象の出力と一緒に更新する。

## Cloudflare Worker

Cloudflare Workerはピンイン生成に [pinyin-pro](https://github.com/zh-lx/pinyin-pro) 3.28.1をimportし、deploy時のWorker bundleへ含める。pinyin-proはMIT Licenseである。この依存はViteのブラウザbundle入力ではないため、上記の自動生成ファイルには含まれない。source packageのライセンスmetadataと通知を維持し、Worker依存の更新時は `package-lock.json` と配布bundleの依存を別途確認する。

## Python・GPU imageの主な依存

次は公開・再配布条件への影響が大きい直接依存である。完全なtransitive dependency一覧や法的な互換性判断を表すものではない。

| 依存 | 現在の取得方法 | upstreamのライセンス・状態 | このリポジトリでの扱い |
| --- | --- | --- | --- |
| [Seed-VC](https://github.com/Plachtaa/seed-vc) | `seed-vc==0.4.3` | GPL-3.0 | privateなRunPod imageへインストールする。現行方針ではpublic container imageを配布しない。将来public配布へ変更する場合は、Voice Lab本体・Python subprocess・配布imageの境界、Corresponding Source、license・noticeの提供方法を別途確認する。 |
| [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) | `qwen-tts==0.1.1`とmodel repository | Apache-2.0 | packageとmodelのversion・条件をimage単位で確認する。 |

その他の依存(FastAPI・OpenAI SDK・RunPod SDK・FunASR・faster-whisper・PyTorch・Transformers等)にも個別のライセンスがある。package managerで導入されるライセンスmetadataを削除しない。public imageを配布する場合は、対象imageからSBOMとライセンス一覧を生成して確認する。

## 現在の公開面判断

| 公開面 | 現在の判断 |
| --- | --- |
| GitHub source repository | モデルweightとcontainer imageを含めないsource公開候補。Voice Lab本体は非OSSのままで、権利判断だけを理由に現在の公開前チェックを省略しない。 |
| Cloudflare demo | SpeakLoopを一般向けとする。研究用の音声生成機能は提供しない。 |
| Docker Hub image | privateを維持し、public container imageを配布しない。 |
| RunPod runtime | private imageとregistry credentialを使う管理者用runtimeとして維持する。 |

## 配布前の扱い

- `Dockerfile`と`Dockerfile.runpod`は本ファイルと `LICENSE` をimageへ含める。
- 現行方針ではpublic container imageを配布しない。方針を変更する場合は、対象imageからSBOMとtransitive license一覧を生成し、[公開前チェックリスト](docs/deployment/PUBLICATION_CHECKLIST.md)の権利・依存項目を再度開く。
- GitHub source repository、Cloudflare demo、Docker Hub、RunPod imageは別々の公開面として判断する。RunPod imageはprivate維持を前提にし、Docker Hubの404をprivate確定の証拠にしない。
- この文書は依存と未確認範囲の記録であり、法的助言やライセンス互換性の最終判断ではない。
