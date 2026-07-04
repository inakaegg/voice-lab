# アプリ分離方針

## 目的

このリポジトリには、目的の異なる2つのWebアプリが同居し始めている。

- 発音練習アプリ: 利用者が言いたい内容を学習対象言語へ変換し、模範音声を聞いて復唱し、ASR結果との比較で練習する。
- VibeVoiceスキット作成アプリ: 指定台本と参照音声から、特定の声に近い音声や会話音声を生成する実験的な制作ツール。

両者は音声処理という基盤は近いが、プロダクト価値、品質要求、コスト構造、公開時の説明が異なる。今後のCloudflare対応やポートフォリオ公開へ進む前に、アプリ境界を明確にする。

## 現時点の推奨判断

当面は、**同一リポジトリ内に2つのアプリを置き、デプロイ単位だけ分ける**。

つまり、すぐに別リポジトリへ分けるのではなく、monorepoとして以下を分離する。

- UIルート
- Cloudflare WorkerまたはPages project
- 環境変数とsecret
- 履歴保存先
- RunPod endpoint
- 公開URL
- docs上の説明

この方針なら、共通の音声処理基盤を共有しながら、公開時には別アプリとして見せられる。

## 理由

### 共通部分がまだ多い

次の処理は、発音練習アプリとVibeVoiceスキット作成アプリで共有しやすい。

- 音声録音、アップロード、再生UI
- 音声ファイルの正規化、音量処理、形式変換
- OpenAI ASR/TTS、Whisper互換ASR、RunPod job pollingなどのprovider境界
- Seed-VC、参照音声取得、URL音声切り出し
- 履歴metadata、診断JSON、音声blob保存
- Cloudflare Worker gateway、R2/D1/KVの使い分け
- RunPod Serverlessのdeploy、smoke test、env管理
- UIの録音状態、処理中表示、音声履歴、管理画面の基本部品

この段階でrepoを分けると、共通処理の複製、deploy scriptの重複、テストfixtureの分散が増えやすい。

### プロダクト境界はまだ変わり得る

発音練習アプリは、低遅延、低コスト、安定した学習ループが重要である。VibeVoiceやSeed-VCは声質の面では魅力があるが、GPUコストと生成品質の不安定さがあるため、発音練習の標準経路にはまだ置かない。

一方、VibeVoiceスキット作成アプリは、現時点では制作・実験寄りである。指定台詞を特定の声で言わせる用途には価値があるが、出力の欠落、後半劣化、ASR再配置、再生成、VC後処理などの品質管理が必要で、学習用途として安定提供するにはまだ距離がある。

このため、repo分割より先に、同一repo内でアプリ境界を固めた方がよい。

## Cloudflareでの扱い

同一repo内に2アプリがあっても、Cloudflare上では別アプリとしてデプロイできる。

推奨は、**2つのCloudflare projectまたはWorkerを作る** 構成である。

```text
same repository
  -> pronunciation app build
     -> Cloudflare project: mo-practice
     -> Worker secrets: OPENAI_API_KEY など
     -> storage: practice用KV/D1/R2

  -> vibevoice app build
     -> Cloudflare project: mo-vibevoice
     -> Worker secrets: OPENAI_API_KEY, RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID など
     -> storage: vibevoice用KV/D1/R2
     -> RunPod endpoint: VibeVoice/Seed-VC用
```

1つのWorkerで `/practice` と `/vibevoice` を振り分けることも可能だが、公開アプリとして分けるなら別Workerの方が扱いやすい。

- secretの混在を避けられる。
- RunPod依存のない発音練習アプリを軽く保てる。
- 片方のdeployや障害がもう片方へ影響しにくい。
- ポートフォリオ上で別URL、別説明、別スクリーンショットにできる。
- 料金やアクセスログをアプリ別に見やすい。

Cloudflare側は、同じGitHub repoから複数projectを作り、それぞれbuild command、output directory、Worker entrypoint、環境変数を変えればよい。

## 目標ディレクトリ構成案

現状のファイル配置を一度に大きく動かす必要はない。まずはアプリ境界を意識して、段階的に次のような構成へ寄せる。

```text
apps/
  practice/
    web/
    worker/
  vibevoice/
    web/
    worker/

src/mo_speech/
  shared/
    audio/
    providers/
    storage/
  practice/
  vibevoice/

docs/
  speech-translation/
  deployment/
```

既存の `src/mo_speech/web` やFastAPIルートをすぐ移動するより、先にURL、API、Worker設定、docs上の境界を決める。

## アプリごとの位置づけ

### 発音練習アプリ

目的は、学習者が短いループで何度も発音練習できること。

- 既定経路は低遅延、低コストを優先する。
- VibeVoiceやSeed-VCは標準経路に入れない。
- 模範音声はOpenAI TTSなどの安定したTTSを優先する。
- ASR結果と目標文の比較、履歴、再練習を価値の中心に置く。
- 将来、音声品質デモとしてVCを任意追加しても、練習ループ本体とは分ける。

### VibeVoiceスキット作成アプリ

目的は、指定台本を特定の声で生成する制作・実験ツールである。

- GPUコストと待ち時間がある前提でUIを設計する。
- VibeVoice単体の不安定さを、ASR再配置、低スコア行の再生成、Seed-VC後処理で補う。
- 生成品質の診断JSONと中間結果を確認できるようにする。
- 発音練習アプリと同じ公開説明に混ぜない。
- Realtime-0.5B系の別性質モデルは、標準計画には含めず、必要になった場合だけ別実験として扱う。

## 別リポジトリへ分ける条件

次の条件が複数当てはまるようになったら、repo分割を再検討する。

- 2アプリの公開対象、branding、README、採用向け見せ方が完全に別になった。
- リリース周期とCIが大きくズレ、同一repoのCI時間や依存関係が重くなった。
- VibeVoice側のGPU/RunPod依存が、発音練習アプリの開発やdeployを頻繁に壊す。
- 共通moduleが安定し、別packageとして切り出せる状態になった。
- 一方を公開OSS、もう一方をprivateまたは商用実験として扱う必要が出た。

repo分割する場合でも、先に `src/mo_speech/shared` 相当の共通moduleを整理し、履歴やdeploy scriptの依存を切ってから移す。

## 今後の作業順

1. 現行の `/practice` と `/vibevoice` の責務をdocs上で確定する。
2. 同一repo内で、発音練習アプリとVibeVoiceアプリのUI入口、API、管理画面、履歴を分ける。
3. 共通化できる音声処理、provider、storage、診断JSON処理を薄いshared moduleへ寄せる。
4. 発音練習アプリをRunPodなしでCloudflareへ載せられる形にする。
5. VibeVoiceアプリをRunPod前提の別Cloudflare projectとして載せる。
6. 2アプリのCloudflare secret、KV/D1/R2 binding、RunPod endpointを分ける。
7. 実際のdeploy、CI、テストの重さを見て、repo分割が必要か再判断する。

