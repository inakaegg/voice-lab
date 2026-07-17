# 第三者コンポーネントとライセンス境界

更新日: 2026-07-17

Voice Lab本体にはオープンソースライセンスを付与していない。リポジトリ直下の [LICENSE](LICENSE) はVoice Lab本体に適用し、第三者のソフトウェア、モデル、データに既に付与されている権利を変更しない。

## ブラウザbundle

Vite production buildにはReact、React DOM、OpenCC JS、Lucide、Tailwind CSS、clsx、tailwind-merge等が含まれる。Viteの `build.license` で、bundleへ実際に含まれた依存の名称、version、ライセンス識別子、ライセンス本文を次へ自動生成する。

- `src/mo_speech/web/react/assets/licenses.md`

このファイルをbundled dependency licensesの正とし、Python wheelにも同梱する。生成済みJavaScriptには同ファイルへの参照を付ける。OpenCC JSが同梱する辞書データは `opencc-data` の派生物でApache-2.0が適用されるため、build後にpackage内の `THIRD_PARTY_LICENSES.md` を同じ生成物へ追記する。依存更新後は `npm run check:web` で再生成し、管理対象の出力と一緒に更新する。

## Cloudflare Worker

Cloudflare Workerはピンイン生成に [pinyin-pro](https://github.com/zh-lx/pinyin-pro) 3.28.1をimportし、deploy時のWorker bundleへ含める。pinyin-proはMIT Licenseである。この依存はViteのブラウザbundle入力ではないため、上記の自動生成ファイルには含まれない。source packageのライセンスmetadataと通知を維持し、Worker依存の更新時は `package-lock.json` と配布bundleの依存を別途確認する。

## Python・GPU imageの主な依存

次は公開・再配布条件への影響が大きい直接依存である。完全なtransitive dependency一覧や法的な互換性判断を表すものではない。

| 依存 | 現在の取得方法 | upstreamのライセンス・状態 | このリポジトリでの扱い |
| --- | --- | --- | --- |
| [Seed-VC](https://github.com/Plachtaa/seed-vc) | `seed-vc==0.4.3` | GPL-3.0 | RunPod imageへインストールする。Voice Lab本体・配布imageとの境界とGPL上の提供物を確認するまで、public image配布を完了扱いにしない。 |
| [ComfyUI-VibeVoice](https://github.com/wildminder/ComfyUI-VibeVoice) | `Dockerfile.runpod`でcommit固定clone | MIT | cloneされたupstreamのライセンスファイルをimage内に保持する。forkのprovenanceと改変範囲は未確認で、VibeVoice runtimeとimageはprivate維持を前提にする。 |
| [Microsoft VibeVoice](https://github.com/microsoft/VibeVoice) | Hugging Face model revisionと第三者実装 | 公式repoはMITだが、TTSコードは悪用事例を理由に削除されDisabled状態 | コードライセンスだけで公開デモの妥当性を判断しない。research目的のmodel card、モデル条件、第三者mirrorの由来、悪用防止策を公開再開前に確認する。aoi-ot/VibeVoice-LargeをMicrosoft公式配布と表現しない。 |
| [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) | `qwen-tts==0.1.1`とmodel repository | Apache-2.0 | packageとmodelのversion・条件をimage単位で確認する。 |

FastAPI、OpenAI SDK、RunPod SDK、FunASR、faster-whisper、PyTorch、Transformers等にも個別のライセンスがある。package managerで導入されるライセンスmetadataを削除せず、public imageを配布する場合は対象imageからSBOMとライセンス一覧を生成して確認する。

## 配布前の扱い

- `Dockerfile`と`Dockerfile.runpod`は本ファイルと `LICENSE` をimageへ含める。
- public container imageを配布する前に、[公開前チェックリスト](docs/deployment/PUBLICATION_CHECKLIST.md)の権利・依存項目を完了する。
- GitHub source repository、Cloudflare demo、Docker Hub、RunPod imageは別々の公開面として判断する。VibeVoice runtimeとRunPod imageはprivate維持を前提にし、Docker Hubの404をprivate確定の証拠にしない。
- この文書は依存と未確認範囲の記録であり、法的助言やライセンス互換性の最終判断ではない。
