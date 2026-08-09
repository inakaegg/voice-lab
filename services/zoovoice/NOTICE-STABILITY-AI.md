# Stability AI Community Licenseの表示

更新日: 2026-08-09

Zoovoiceの動物の鳴き声のうち23種は、Stable Audioで生成した音声である（アザラシは生成音の収録内容の不備で削除済み）。この文書はその必須表示と生成物の由来を示す。Cloud Run用imageへは `/app/licenses/NOTICE-STABILITY-AI.md` として同梱する。配備scriptとDockerfileが独立したファイルとして取り込むため、既存文書へ統合せずここに置く。

## 必須の表示文

```
This Stability AI Model is licensed under the Stability AI Community License
```

ライセンス本文は公式ページを正とする。本書へは全文を転載しない。

- ライセンス: [Stability AI Community License](https://stability.ai/license)

## 生成物の由来

| 項目 | 内容 |
| --- | --- |
| モデル | `stabilityai/stable-audio-3-small-sfx` |
| モデルrevision | `ae12755283df9d62ca39a9b050a39a0b607b8c20` |
| 生成物 | `assets/animal-sounds/` のうち `source_kind` が `stable_audio` の23件 |
| 由来の記録 | `assets/animal-sounds/manifest.json` |
| ライセンス | Stability AI Community License |
| ライセンスURL | `https://stability.ai/license` |

manifestは動物ごとに次を記録する。

- prompt
- seed
- 生成元ファイルのSHA-256
- 正規化後の出力のSHA-256
- 音声指標（長さ・sample rate・channel数・bit深度・平均dBFS・peak dBFS）
- 採用したcandidateと不採用のcandidateの両方のreceipt

生成音声は24 kHzのmono PCM16へ正規化し、長さは5秒とする。

## 表示場所

Zoovoiceの公開画面はfooterへ `Powered by Stability AI` を表示し、`https://stability.ai/` へlinkする。生成音声を提供する画面と配布物では、この表示と上の必須表示文を保つ。

## 適用範囲

この文書はStable Audioで生成した音声だけを対象とする。同じディレクトリにあるCC0音源3件（`dog`・`cat`・`cricket`）はこの対象に含まない。各音声の区分は `manifest.json` の `source_kind` と `license` を正とする。

他の成果物のライセンスは別の文書を参照する。ConceptNet派生データベースは [LICENSE-CONCEPTNET.md](LICENSE-CONCEPTNET.md)、CC0音源3件の帰属は [README.md](README.md) の同梱する動物音、リポジトリ本体と他の第三者成果物は [LICENSE](../../LICENSE) と [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) とする。

本書はライセンスが求める表示と、生成物の由来を記録するための文書である。条件の解釈や適法性の判断を示すものではない。
