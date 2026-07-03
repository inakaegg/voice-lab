# VibeVoiceスキット生成

## 現在の位置づけ

`/vibevoice` は、`zhskit` のスキット生成機能をこのアプリへ移すための検証画面である。台本、最大4つの参照音声、生成パラメータを入力し、VibeVoiceでWAVを生成する。

初期実装では、ローカル実行とRunPod Serverless実行を選べる。ローカル実行は開発機上のVibeVoice CLIを呼ぶ。RunPod実行はFastAPIがRunPod jobを作り、RunPod handlerが `operation_mode=vibevoice` として同じ処理を実行する。

## 生成オプション

- `モデル`: 比較検証用に、RunPod/ローカルへ渡すVibeVoiceモデルを選ぶ。通常候補は以下とする。
  - `VibeVoice 1.5B 固定版`: ローカルで動作確認した `microsoft/VibeVoice-1.5B` のrevisionを固定して使う。再現性を優先する既定値。
  - `VibeVoice 1.5B 最新`: `microsoft/VibeVoice-1.5B` のHugging Face `main` を使う。2026-07-01時点では固定版と重み/configは同一に見えるが、今後の更新比較用に残す。
  - `VibeVoice Large (RunPod)`: `aoi-ot/VibeVoice-Large` をRunPod/CUDAで検証する実験候補。ローカルmacOSでは選択不可にし、APIも `backend=local` との組み合わせを拒否する。
- `ランダム性を使う`: VibeVoiceのsamplingを有効にする。同じ台本でもseedや設定によって抑揚や細部が変わる。安定性を優先して比較したい場合はOFFも試す。
- `行ごとに生成して結合`: 台本全体を一度に生成せず、1行ずつ生成して無音を挟んで結合する。長文や複数発話で破綻を分けやすい一方、行間や話し方の連続性は不自然になる可能性がある。
- `指定台詞を1行生成してASR再配置`: 指定台詞を正確に読ませるための実験モード。表示用台本は保持し、生成時だけ話者ごとに1行テキストへまとめてVibeVoiceへ渡す。生成後に話者ごとのSeed-VCを1回かけ、VC後の音声をASR timestampでフレーズ区間推定し、元台本の行順へ並べ直し、`行間秒数` の無音を挿入して最終WAVを作る。
- `参照音声秒数`: 参照音声の有声区間から使う長さ。生成時は入力形式に関わらず、参照音声をmonoへdecodeし、24kHzへresampleし、前後の無音をtrimしてから、この秒数を上限に切り出す。長すぎると処理が重くなり、短すぎると声質特徴が不足する。
- 生成設定パネルにはパラメータ目安を常時表示する。探索の初期値は `cfg_scale=1.1-1.5`、`inference_steps=10-15`、本命候補で `20-30`、`temperature=0.75-0.95`、`top_p=0.85-0.95`、`top_k=0` を基準とし、不安定な時だけ `top_k=30-50` を試す。参照音声秒数は5秒を基準に、声質が弱ければ8-10秒、ノイズ混入時は3-5秒へ寄せる。

台本の正式形式は `Speaker 1: ...` だが、入力時は `1: ...`、`1 ...`、`A: ...`、`A ...` の短縮タグも使える。短縮タグは最大4つの参照音声に合わせて `1-4` または `A-D` を受け、生成前に `Speaker N:` へ正規化する。タグがない行は `Speaker 1:` として扱う。

参照音声はブラウザのIndexedDBへ保存し、次回以降は同じSpeaker枠の既定音声として再利用する。ブラウザの制約によりfile inputへ前回ファイルを直接セットすることはできないため、保存済みファイル名をSpeaker枠内に表示し、保存済みBlobをaudioコントロールで再生確認できるようにする。生成時は台本から必要なSpeaker枠を判定し、不要な保存済み音声を送らない。APIからVibeVoice CLIへ渡す時もSpeaker枠番号を保持し、`Speaker 2` の参照音声が `Speaker 1` として詰め直されないようにする。

参照音声は、ローカルファイルに加えて動画/音声URLから取得できる。URL取得はブラウザではなくローカルFastAPI側で行い、`yt-dlp` で対象メディアを取得し、`ffmpeg` で24kHz mono PCM WAVへ切り出す。YouTubeなどの `t=`, `start=`, `time_continue=`, `#t=` に含まれる再生開始時刻を開始秒として扱い、UIで開始秒を明示した場合はその値を優先する。取得秒数はUIで指定し、既定は5秒とする。取得に成功したWAVは選択したSpeaker枠の保存済み参照音声としてIndexedDBへ入れ、保存済み音声プレイヤーでその場で確認できるようにする。以後の生成ではファイル選択した参照音声と同じ扱いにする。認証が必要なURL、playlist一括取得、長尺全体の保存は扱わない。

台本テキストと生成設定はブラウザの `localStorage` へ保存し、次回の `/vibevoice` 表示時に復元する。保存対象は、台本本文、実行先backend、モデル、`cfg_scale`、`inference_steps`、`seed`、`temperature`、`top_p`、`top_k`、`max_voice_seconds`、`line_gap`、`do_sample`、`line_by_line`、`directed_line_mode` とする。台本ファイルを読み込んだ場合も、読み込み後のtextarea内容を保存対象にする。生成設定のリセット操作は、台本本文とIndexedDBの参照音声を残したまま、保存対象の生成設定だけを画面初期値へ戻す。保存は同じブラウザ内の作業再開用であり、履歴管理や別端末同期は今後の生成履歴機能で扱う。

長い台本の生成は同期リクエストではなくVibeVoiceジョブとして扱う。UIはジョブの状態をポーリングし、現在ステージ、経過時間、完了時の生成時間を表示する。ローカル実行ではVibeVoice CLIの `tqdm` 出力に含まれる実進捗値を取り込み、プログレスバーを数値進捗へ切り替える。進捗値がまだ取れない初期化や未知ステージだけ、処理中インジケータとしてアニメーション表示する。成功、失敗、キャンセルなどの終端状態では、完了時の経過時間表示は残してよいが、処理中インジケータのアニメーションは必ず停止する。ローカル実行のジョブでは固定timeoutで停止せず、生成中にキャンセルでき、キャンセル時はVibeVoice CLI subprocessを終了する。互換用の同期 `POST /api/vibevoice/generate` は残すが、画面からの通常生成は `POST /api/vibevoice/jobs` を使う。

`VibeVoice Large` は過去のREADMEでMicrosoft公式候補として言及されていたが、現在の `microsoft/VibeVoice-Large` は公開Hugging Face repoとして取得できない。community copyである `aoi-ot/VibeVoice-Large` は取得できるため、RunPod/CUDA専用の実験候補として扱う。Large repoには `tokenizer.json` がないため、tokenizerは `Qwen/Qwen2.5-7B` に分けて指定する。Largeの利用例はCUDA上で `bfloat16` 読み込みを使っているため、`vibevoice-large-aoi-pinned` はCLIへ `VIBEVOICE_TORCH_DTYPE=bfloat16` を渡す。UIではRunPod Serverlessを選んだ時だけLargeを選択可能にし、ローカルbackendへは送らない。

2026-07-02のRunPod検証では、Largeのモデル読み込みと `Qwen/Qwen2.5-7B` tokenizer読み込みは通るが、1.5B向けに組み立てた明示 `generation_config` をLargeへ渡すと、最初のtoken生成前に `torch.multinomial` の確率テンソル不正でCUDA assertする。`do_sample=false` ではCUDA assertを避けられるが、先頭でEOS相当になり音声波形が返らない。Large公開例は `generation_config` を明示しないが、RunPod imageで使うwildminder/ComfyUI-VibeVoiceの生成実装は `generation_config=None` の場合に新規 `GenerationConfig` を作り、greedyでEOSを選びやすい。そのためLargeプリセットでは明示samplingを使う。さらに同実装は `generate()` 引数の `logits_processor` を内部で作り直すため、CLIから渡したprocessorは効かない。CLIは起動時に内部 `VibeVoiceTokenConstraintProcessor` をruntime patchし、sampling直前に有効token候補が空、NaN、Infだけにならないように補正し、最初の音声diffusion tokenが出るまでEOS/speech_end/speech_start/bosをmaskする。この判定では、参照音声prompt内に含まれるdiffusion tokenを生成済みtokenとして数えない。

同日の再検証では、raw text fallback経路のまま新しいComfyUI-VibeVoice processorへ渡すと、`speaker_ids_for_prompt` が空になり参照音声promptが作られず、1 tokenでEOSになって音声波形が返らないことも確認した。RunPod imageで使うwildminder/ComfyUI-VibeVoice固定refは `parsed_scripts` と `speaker_ids_for_prompt` を明示する経路を持つため、CLIはその引数がprocessorに存在する場合だけ本体nodeと同じ明示parsed経路を使い、古いprocessorでは従来のraw text経路へfallbackする。Largeは引き続き安定運用候補ではなく、RunPod上で短い台本、参照音声、生成パラメータを固定して検証する対象とする。

`microsoft/VibeVoice-Realtime-0.5B` は `model_type=vibevoice_streaming`、architectureも `VibeVoiceStreaming...` 系で、現在の非streamingスキット生成CLIとは別経路である。RunPod上の通常スキット生成ではCUDA assertまで進むため、通常UIのモデル候補には出さない。これも「Realtimeが使えない」という意味ではなく、streaming model用の入力、生成ループ、出力処理を別実装として持っていないという意味である。Realtimeモデルを扱う場合は、別途streaming向け実装として仕様化してから追加する。

## 2026-07-02時点の品質整理

VibeVoice 1.5BとLarge系は、長尺・複数話者の会話音声生成を主目的にした研究用TTSとして扱う。[microsoft/VibeVoice-1.5B](https://huggingface.co/microsoft/VibeVoice-1.5B) のmodel cardは、モデルが英語と中国語データで学習されており、それ以外の言語はunsupportedで結果が不明瞭または不適切になり得ると説明している。また、speech-onlyであり、背景音、効果音、音楽のような非音声生成は対象外とされている。日本語台本で読み誤り、意味をなさない音声、音楽のような非音声が混じる場合は、まずこの言語・用途制約の影響として切り分ける。

Large候補の [aoi-ot/VibeVoice-Large](https://huggingface.co/aoi-ot/VibeVoice-Large) はcommunity copyとして取得できるが、同じく英語・中国語以外をunsupportedとする注意を継承している。Largeはモデル規模により品質が改善する可能性はあるが、日本語が正式対応になるわけではない。Largeの品質評価はRunPod/CUDA上で、短文、10行程度の会話、英語、中国語、日本語を分け、同じseedと生成パラメータで一括生成と行単位生成を比較する。

[microsoft/VibeVoice-Realtime-0.5B](https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B) は低遅延のstreaming TTSで、single speaker前提である。model card上は英語向けが主で、日本語を含む追加言語は探索用と説明されている。現在の複数話者スキット生成UIとは別経路にする。

参照音声のファイル形式差は、生成直前のdecode後には主要因にしない。wav、m4a、mp3などは `librosa` でmonoへdecodeし、24kHzへresampleしてからVibeVoiceへ渡す。品質差を比較する時は、形式ではなく、先頭無音、音量、ノイズ、音楽混入、参照音声の言語、発話内容の明瞭さを分けて見る。

### 指定台詞向けの実用モード仮説

2026-07-02の手元検証では、改行や長い空白を含む台本よりも、発話を1行の連続テキストとして渡した方が、日本語、中国語、ヒンディー語で台詞再現性と声質安定性が大きく改善した。英語でも同じ傾向になる可能性がある。これはVibeVoice本来の「複数話者の自然な会話ターン生成」とは別の使い方であり、指定台詞を特定声で正確に読ませるための実用モードとして扱う。

このモードでは、改行や長い空白をそのまま渡さない。空白を単純削除するのではなく、発話境界には `、`、`。`、`,`、`.` などの句読点を維持または補い、VibeVoiceには単一話者の連続発話として渡す。改行、複数スペース、空行、話者タグを含む台本をそのまま渡すと、境界ごとに声質、性別、話速、話し方が変わる場合がある。これはモデルが境界を話者交代や会話構造として解釈している可能性がある。

観察された制約:

- 日本語と中国語では、1行化で高品質になっても、30秒前後で生成が終わり、台本の後半が出ないことが多い。
- ヒンディー語では同じ1行化で約1分30秒まで出る例があったが、1分を過ぎたあたりから不正な発話や異音が混じった。
- 参照音声が日本語の場合は高品質だが、早口でややぶっきらぼうな話し方になりやすい。参照音声が中国語の場合は、ゆっくりでやや機械的な話し方になる傾向がある。
- VibeVoice単体でも参照話者に近い音声になるが、最終採用音声としてはまだ少し似ていない場合がある。VibeVoice出力を同じ話者のSeed-VCへ1回通すと、声質の最後の差分が埋まり、かなり安定して参照話者へ寄る場合がある。2回目以降の追加変換は改善が小さい。
- 別話者Bの音声をSeed-VCで話者Aへ変換し、さらにAへ再変換すると声質は寄る場合があるが、Bの話し方、間、抑揚が残るため、VibeVoiceでAとして生成した出力より自然さが落ちる場合がある。

今後の構成案:

1. 表示用台本は、元の改行、話者タグ、読みやすい表記を保持する。
2. 生成用台本は、話者ごとに発話を抽出し、句読点でつないだ1行テキストへ正規化する。
3. 1話者の場合は、正規化した1行テキストを `Speaker 1:` としてVibeVoiceへ1回渡す。
4. 複数話者の場合は、話者ごとに1行テキストを作り、話者数分だけVibeVoice生成を行う。各生成では、その話者の参照音声だけを使い、VibeVoice上は単一話者として扱う。
5. 各VibeVoice出力へSeed-VCを1回かけ、VibeVoiceで作った台詞再現と発話品質を維持しつつ、声質だけを最終的に寄せる。Seed-VCは話し方や間を根本的に作り直す工程ではないため、前段のVibeVoice生成品質を先に安定させる。
6. VC後の話者別音声をASRでフレーズ分割し、タイムスタンプを取る。ASR候補はOpenAI Whisper API、faster-whisper、VibeVoice-ASRを比較するが、RunPod Largeとの同居ではGPU上のASR常駐を避ける。
7. ASR結果と元台本を、話者、発話順、テキスト類似度で対応付ける。完全一致を前提にせず、読み替えや脱落に備える。
8. 元台本の発話順に、対応するVC後の音声区間を並べ直し、必要な無音、クロスフェード、音量正規化を入れて最終音声を作る。

現在のWeb UIでは、「指定台詞を1行生成してASR再配置」をONにすると指定台詞向けのASR再配置モードを使う。この設定は、表示用台本を変更せず、生成前に話者ごとの発話を句読点つきの1行へまとめる。複数話者の場合は、話者ごとにVibeVoice生成を行い、各生成ではその話者の参照音声だけを `Speaker 1` として渡す。全話者のVibeVoice生成が終わった後、話者ごとのVibeVoice出力を同じ話者の参照音声でSeed-VCへ通す。さらにVC後の音声へASRをかけてword/segment timestampを取り、元台本の発話行へ対応付け、元の話者順・行順にWAV区間を切り出して再配置する。行間には `line_gap` 秒の無音を挿入する。行ごと生成とは同時に使わない。

指定台詞向けモードのASRは、既定では `MO_VIBEVOICE_DIRECTED_ASR_PROVIDER=openai` と `MO_VIBEVOICE_DIRECTED_OPENAI_ASR_MODEL=whisper-1` を使う。これはVibeVoice LargeとSeed-VCを同じRunPod workerで扱う時に、faster-whisperをGPUへ追加ロードしてVRAMを圧迫しないためである。OpenAI経路では `OPENAI_API_KEY` が必要で、外部API課金が発生する。ローカルまたはGPU余裕のある環境で自前ASRを使う場合だけ、`MO_VIBEVOICE_DIRECTED_ASR_PROVIDER=faster-whisper` を明示する。`MO_VIBEVOICE_DIRECTED_ASR_LANGUAGE` は既定 `auto` で、必要に応じて `ja-JP`、`zh-CN`、`en-US`、`hi-IN` などを指定する。Seed-VCは既定で `MO_VIBEVOICE_DIRECTED_VC_ENABLED=1`、`MO_VIBEVOICE_DIRECTED_VC_BACKEND=seed-vc` として有効にする。

この再配置はASR結果に依存するため、ASR誤認識、台詞の脱落、生成順のずれ、長尺生成の途中終了があると切り出し位置がずれる。現在はword timestampがあればASR transcriptと元台本の正規化文字列を整列してword範囲を割り当て、wordが無ければsegment数一致または文字数比でfallbackする。最終的な実用化では、対応付け結果をUIに出して、ユーザーが台詞行ごとに採用区間を調整できる必要がある。

指定台詞向けモードの結果確認では、最終音声だけでなく、話者ごとのVibeVoice出力、話者ごとのSeed-VC後出力、台本行ごとの切り出し音声をUI上で再生できるようにする。話者ごとの中間音声には、実際にVibeVoiceへ渡した1行化テキストも表示する。これにより、VibeVoice側で台詞が脱落したのか、Seed-VCで音質や音量が崩れたのか、ASR timestampの分割/対応付けが誤ったのかを分けて確認する。話者別に結合する台詞は、弱い読点ではなく句点相当で区切り、入力内の読点も原則として句点へ寄せる。VibeVoiceは末尾側の発話が欠落しやすいことがあるため、生成用テキストの末尾には採用対象外のガード文として冒頭側のテキストを再度付け足す。ASR再配置では元台本行だけを採用対象にし、ガード文は末尾欠落を吸収するための余白として扱う。ASR transcriptと元台本を整列する時も、対象台本の終端を最終境界にし、ガード文側の単語を最終出力へ含めない。

RunPod Serverless経由では、長尺の指定台詞向けモードで中間音声をすべて `artifacts[].audio_base64` としてjob resultへ載せると、最終音声、話者別VV/VC音声、行ごとの切り出し音声が重複して巨大化し、RunPodの結果返却段階で失敗し得る。そのためRunPod handlerは既定では中間音声をinline返却せず、最終音声と診断情報だけを返す。短い検証で必要な場合だけ `return_artifacts=true` または `MO_RUNPOD_VIBEVOICE_RETURN_ARTIFACTS=1` を使い、`artifact_response_max_items` と `artifact_response_max_base64_chars` で上限をかける。長尺でも中間音声を常時確認したい場合は、RunPod job outputではなく、永続Volumeやオブジェクトストレージへartifactを保存し、UIはURLや履歴APIから取得する構成に分ける。

再構成時は、台本行ごとに切り出したWAV区間へ軽いDC offset除去、RMS正規化、peak制限をかけてから結合する。これは参照音声やSeed-VC後出力の音量差、切り出し区間ごとの過大peakによる音割れを減らすための後処理であり、VibeVoiceが誤った台詞を生成した場合の内容修正ではない。話者ごとの中間音声は原因確認のため元の出力を保持し、最終出力と台本行ごとの切り出し音声で正規化後の音を確認できるようにする。

機械的な文字数比分割だけでは、日本語ASRの誤認識、言い換え、脱落、途中終了を正しく扱えない。`zhskit` のFunASR分割モードは、元台本へ厳密に戻すのではなく、ASRが切った自然なセグメントを正として後段へ渡す設計だった。指定台詞向けモードでは元台本順への再構成が必要なため、ASR transcriptと元台本をテキスト整列して範囲推定し、それでも対応できない行は別フレーズを無理に割り当てず警告として表示する必要がある。

## 関連モデルの扱い

- `microsoft/VibeVoice-1.5B`: 現在のスキット生成の主対象。長めの複数話者TTSを想定する。
- `microsoft/VibeVoice-Realtime-0.5B`: 低遅延TTS候補。streaming modelであり、現在の複数話者スキット生成CLIの通常候補には含めない。
- `microsoft/VibeVoice-ASR` / `microsoft/VibeVoice-ASR-HF`: TTSではなく、ASR、話者分離、タイムスタンプをまとめて出すためのモデル。長い会話音声を「誰が、いつ、何を話したか」に落とす用途で、VibeVoiceスキット生成の直接代替にはしない。
- `aoi-ot/VibeVoice-Large`: Microsoft公式HF repoではないが、ModelScope由来の重みコピーとして取得できるLarge候補。ローカルbackendでは扱わず、RunPod/CUDA専用の実験候補にする。
- `microsoft/VibeVoice-Large`: 過去の案内では上位候補として見えていたが、現時点では公開repoとして取得できない。

## モデル配置方針

モデル本体やComfyUI-VibeVoice拡張はリポジトリへ入れない。プロジェクトごとの作業ディレクトリには依存させず、`MODEL_CACHE_DIR` または明示的なVibeVoice用環境変数で参照先を決める。

推奨するローカル配置:

```text
<MODEL_CACHE_DIR>/
  vibevoice/
    huggingface/hub/
      models--microsoft--VibeVoice-1.5B/
      models--Qwen--Qwen2.5-1.5B/
    ComfyUI-VibeVoice/
```

対応する環境変数:

```bash
export MODEL_CACHE_DIR=/path/to/shared-models
export MO_VIBEVOICE_HOME=$MODEL_CACHE_DIR/vibevoice/huggingface/hub
export VIBEVOICE_HOME=$MO_VIBEVOICE_HOME
export COMFYUI_VIBEVOICE_PATH=$MODEL_CACHE_DIR/vibevoice/ComfyUI-VibeVoice
export MO_VIBEVOICE_CLI=/path/to/vibevoice.py
export MO_VIBEVOICE_PYTHON=/path/to/python
export VIBEVOICE_DEVICE=cpu
```

`MO_VIBEVOICE_HOME` はアプリ側サービスが参照する設定で、`vibevoice_cli.py` を直接実行する場合は `VIBEVOICE_HOME` を参照する。そのため、ローカル検証では同じパスを両方へ入れる。`MODEL_CACHE_DIR` を指定した場合はその配下を明示設定として扱い、既に存在する `~/.cache/mo-speech` へ自動fallbackしない。`MODEL_CACHE_DIR` もVibeVoice用環境変数も未指定の場合、ローカル実行は `~/.cache/mo-speech/models/vibevoice` 配下を既定候補にする。旧ComfyUIプロジェクトなど、他プロジェクト固有のパスへはfallbackしない。

ローカルmacOSでは、MPS backendがVibeVoiceの複数話者生成中にMetal側で落ちる場合があるため、既定deviceはCPUにする。MPSを明示的に試す場合だけ `VIBEVOICE_DEVICE=mps` を設定する。RunPodなどCUDA環境ではCUDAを自動利用する。

Transformers 5系では、VibeVoice拡張の `tie_weights()` が `decoder_config.tie_word_embeddings` を見ずに早期returnし、`lm_head.weight` がランダム初期化のままになる場合がある。この状態では生成音声が言葉として崩れる可能性が高いため、アプリ内CLIではロード時に `lm_head.weight` を `model.language_model.embed_tokens.weight` へ明示的に結び直す。

RunPod Network Volumeでは、モデルキャッシュを `/workspace` または `/runpod-volume` 配下に置く。ComfyUI-VibeVoice拡張はDocker image内の `/app/ComfyUI-VibeVoice` に入れる構成を既定とし、別途Volumeへ置く場合だけ環境変数で上書きする。

ComfyUI-VibeVoice固定refでは、processorのraw text fallbackが `vibevoice.modules.utils` を参照する一方、実際の `utils.py` は拡張ルート直下の `modules/` にある。processorのraw text経路を外すと台本条件や参照音声スロットが崩れやすいため、アプリ内CLIはraw textをprocessorへ渡し、`vibevoice.modules.utils.parse_script_1_based` だけを軽量aliasで補う。

行単位生成では、各行を1つの局所的な台本として生成する。元台本上の `Speaker 2` だけを単独でprocessorへ渡すと、processor内部のspeaker正規化と参照音声の並びがずれるため、生成時は各行を `Speaker 1` として渡し、その行の元speakerに対応する参照音声だけを使う。元のspeaker番号、テキスト、出力区間はメタデータに保持する。1.5B系では長い複数行台本を一括生成すると同じ行の繰り返しや崩れが出やすいため、4行以上または本文180文字以上の台本は、UI設定が一括生成のままでも自動で行単位生成に切り替える。Web UIではこの状態を「行ごとに生成して結合」のチェック済み・無効化として表示し、短い台本へ戻した時はユーザーが保存していた手動設定へ戻す。LargeはRunPod上で一括生成と行単位生成の品質比較が必要なため、台本の行数や文字数に関わらず自動切替せず、ユーザーのチェック状態をそのまま使う。

VibeVoice本体の既定生成長は、テキストだけでなく参照音声promptを含む入力長から決まるため、短い台本でも150 token程度まで生成が続くことがある。アプリ内CLIでは、`max_new_tokens` を台本文字数と行数から見積もって明示的に渡し、短文が20秒級の無関係な音声として伸び続ける回帰を避ける。

ローカル実行では、VibeVoice CLIの標準エラー出力をAPI側で逐次読み取り、`Generating ... 22/32` のようなtqdm進捗をjob statusへ反映する。行単位生成では、各行の内部tqdmをそのまま表示すると行ごとに0%へ戻って全体の進み具合が分からないため、`行単位生成 2/11 (18.2%, 行内 16/32 50%)` のように全体行数に対する進捗へ変換して表示する。Web UIはpollingごとに現在のstage labelと直近ログを表示し、数値進捗が取れた時点でプログレスバーをdeterminate表示へ切り替える。完了まで無変化のアニメーションだけが続く状態にしない。キャンセル要求はこのストリーミング実行中にも監視し、子プロセスを終了する。ローカルjob API経由では固定timeoutで停止せず、ユーザーのキャンセル要求で子プロセスを終了する。`MO_VIBEVOICE_TIMEOUT_SECONDS` は互換用の同期生成やRunPod handler内の直接実行など、キャンセルイベントを持たない呼び出しの上限として扱う。

```bash
MO_VIBEVOICE_HOME=/workspace/models/vibevoice/huggingface/hub
COMFYUI_VIBEVOICE_PATH=/app/ComfyUI-VibeVoice
MO_VIBEVOICE_CLI=/app/src/mo_speech/vibevoice_cli.py
VIBEVOICE_MODEL_REPO=microsoft/VibeVoice-1.5B
VIBEVOICE_MODEL_REVISION=1904eae38036e9c780d28e27990c27748984eafe
VIBEVOICE_TOKENIZER_REPO=Qwen/Qwen2.5-1.5B
VIBEVOICE_TOKENIZER_REVISION=8faed761d45a263340a0528343f099c05c9a4323
```

LargeをRunPodで扱う場合は、モデルrepoとtokenizer repoを分ける。以下の組み合わせを `vibevoice-large-aoi-pinned` として固定し、ローカルbackendでは選択不可にする。2026-07-01時点の現行CLIではモデル読み込み後の生成に失敗していたため、RunPod上で短い台本から再検証する。

```bash
VIBEVOICE_MODEL_REPO=aoi-ot/VibeVoice-Large
VIBEVOICE_MODEL_REVISION=1b81fecc784a076dcd935678db551871f4598ebf
VIBEVOICE_TOKENIZER_REPO=Qwen/Qwen2.5-7B
VIBEVOICE_TOKENIZER_REVISION=d149729398750b98c0af14eb82c78cfe92750796
VIBEVOICE_TORCH_DTYPE=bfloat16
VIBEVOICE_GENERATION_CONFIG_MODE=explicit
VIBEVOICE_MIN_AUDIO_TOKENS=1
```

20GB級GPUでLargeを使う場合は、VibeVoice以外のresident GPUモデルを同じworker processに残さない。特に `MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START=1` でSeed-VCを起動時preloadすると、親process側に数GiBのVRAMが残り、Largeのロード中にOOMしやすい。VibeVoice用RunPod imageの既定は `MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START=0` とし、VibeVoice request前に既存のVoice Conversion serviceを解放する。指定台詞向けASR再配置モードでは、複数話者のVibeVoice生成を全て終え、次に話者ごとのSeed-VCを実行し、その後にVC後音声へASR timestamp取得を行う。ASRの既定をOpenAI `whisper-1` にすることで、Large生成とfaster-whisper ASRが同じGPUへ同時または連続で載る状態を避ける。

`VIBEVOICE_MIN_AUDIO_TOKENS` はLargeで `speech_start` 直後にEOSへ落ちる挙動を避けるための下限指定である。CLIはこの値を固定の生成長としては扱わず、台本文字数、行数、`max_new_tokens` から実際に強制する最低音声token数を見積もる。これにより短文でも1tokenだけで終了せず、長い台本では台本長に応じた最低限の音声tokenを要求する。

`VIBEVOICE_MODEL_REVISION` と `VIBEVOICE_TOKENIZER_REVISION` は、ローカルで動作確認したキャッシュと同じrevisionをRunPod初回ダウンロードでも使うために固定する。未固定のままHugging Faceの `main` を取得すると、後日のモデル更新で同じ入力でも挙動が変わる可能性がある。

UIでモデルを選んだ場合は、そのリクエストの間だけ `VIBEVOICE_MODEL_REPO`、`VIBEVOICE_MODEL_REVISION`、`VIBEVOICE_TOKENIZER_REPO`、`VIBEVOICE_TOKENIZER_REVISION` 相当の値をRunPod handlerへ渡す。RunPod Volumeに該当モデルがなければ、初回生成内でHugging Faceからダウンロードされる。

## 既知の品質課題

- 日本語の漢字読みが誤ることがある。例として、参照音声が中国語の場合に「最近」を中国語読みへ寄せるなど、参照音声言語の影響を受ける可能性がある。
- 日本語参照音声でも漢字読みを誤る場合がある。台本をひらがなにすると改善するため、テキスト正規化または読み指定の仕組みが必要。
- 途中にノイズや不自然な音が混じることがある。RunPod実行、依存ライブラリ、GPU、生成パラメータ、参照音声前処理の差分を分けて検証する。
- `VibeVoice Realtime 0.5B` は既存の非streamingスキット生成CLIと互換でないため、通常UIでは選択肢に出さない。
- `aoi-ot/VibeVoice-Large` はtokenizerを `Qwen/Qwen2.5-7B` に分けることで404は避けられる。UI/APIではRunPod専用候補として扱い、CLIはLarge時だけ初期音声token制約とlogits有限化を使う。生成安定性は短文から再検証が必要。
- ローカルmacOSのMPS backendでは、モデル読み込み後の生成中にMetal/MPS内部のshape不整合でプロセスがabortする場合がある。CPUは生成が極端に遅いため、品質確認と速度確認はRunPod/CUDAでも必ず行う。
- 台本全体生成と行ごと生成では、自然さ、破綻のしにくさ、行間の違和感が変わる。品質比較では、ブラウザに復元される直近の生成設定と入力台本に加えて、後から比較できる生成履歴が必要。

## これから詰める仕様

### 1. 台本テキストと読み指定

VibeVoiceへ渡す生成用テキストと、ユーザーが編集・確認する表示用テキストを分けるか決める。日本語では漢字を含む自然な台本をUIに残しつつ、生成時だけひらがな、カタカナ、読み付きテキストへ変換する選択肢がある。

- 表示用台本: ユーザーが読みやすく、保存履歴として再利用しやすい表記を保持する。
- 生成用台本: VibeVoiceが読み誤りにくい表記へ変換する。日本語はひらがな化、中国語は簡体字・ピンイン補助、英語はそのまま、など言語ごとに方針が変わる。
- 読み指定: 全文自動変換だけで足りない固有名詞、数字、略語、地名、人名をどう上書きするかを決める。将来は `漢字{よみ}` のような簡易マークアップ、または台本行ごとの読み欄を検討する。
- 保存対象: 元テキスト、生成用に正規化したテキスト、正規化方式、手動読み指定をセットで履歴保存する。

初期方針としては、UIを複雑にしすぎないため、自動正規化はOFF/ON程度に留める。読み誤りが実用上の主要課題として残る場合に、手動読み指定を追加する。

### 2. 参照音声と言語の関係

参照音声の話者言語と出力台本の言語が異なると、音色は近くても発音、抑揚、漢字読みが不自然になる可能性がある。仕様として、話者ごとに「参照音声の言語」と「台本の言語」を持つかを決める。

- 同一言語参照: 品質確認の基準。日本語台本なら日本語参照、中国語台本なら中国語参照を推奨する。
- クロスリンガル参照: デモとしては便利だが、読み誤りやアクセント崩れを許容するかを明示する。
- 混在参照: 1つの台本で話者ごとに参照音声の言語が違う場合、UI上で警告するか、単に実験機能として扱うかを決める。
- 参照音声の長さ: 先頭固定ではなく、発話区間自動選択、無音トリム、音量正規化をどこまで標準化するかを決める。

比較時は、同じ台本、同じseed、同じ生成パラメータで「日本語参照」「中国語参照」「同一話者の別区間」を出し分け、読み誤りと自然さを分けて評価する。

現在の実装では、参照音声を次の順で標準化してからモデルへ渡す。

1. `librosa` で入力音声をmono floatへdecodeする。
2. 24kHzへresampleする。
3. NaN/Infを0へ置き換える。
4. 前後の無音をtrimする。
5. `参照音声秒数` を上限に、有声区間の先頭から切り出す。
6. DC offsetを落とし、RMSを約 -20 dBFS 相当へ近づけ、peakは0.95以下に抑える。

この正規化はファイル形式差を減らすための共通前処理であり、発話内容そのものの品質は改善しない。BGM、強い環境音、長い沈黙、複数人の重なり、違う言語の参照音声は引き続き品質低下要因になる。

### 3. 生成品質とノイズ対策

ノイズや不自然な音は、モデル、依存実装、GPU、生成パラメータ、参照音声前処理、台本表記のどれが原因か分けて確認する必要がある。

- 生成パラメータ: `cfg_scale`、`inference_steps`、`temperature`、`top_p`、`top_k`、`do_sample`、`seed` を履歴に残す。
- 比較単位: 1つの長い台本だけで判断せず、短文、会話、長文、数字や固有名詞を含む文を分ける。
- ノイズの再現性: 同じseedで再現するならモデル/実装寄り、seedで変わるならsampling寄り、参照音声で変わるなら前処理寄りとして切り分ける。
- 後処理: 音量正規化、先頭末尾無音トリム、短いクリック音の検出、結合時のクロスフェードを追加するか決める。

まずは生成履歴へ入力・参照・パラメータ・出力を残し、同条件で再生成できる状態を優先する。

### 4. 行ごと生成と全体生成

`行ごとに生成して結合` は、長文破綻を抑えやすい一方で、行間の間、抑揚の連続性、話者の感情変化が切れやすい。全体生成は自然につながる可能性がある一方、長文で破綻した場合に原因を追いにくい。

- 既定値: 短いスキットは全体生成、長い教材・説明文は行ごと生成を候補にする。
- 分割単位: UIの「行」をそのまま使うか、句読点で自動分割するかを決める。
- 結合方式: 単純結合、固定無音、クロスフェード、話者切替時だけ間を長くする、などを選ぶ。
- 表示: 「行ごと生成」は内部実装名に近い。ユーザー向けには「長い台本を安定生成」など、目的が分かる表現へ変える余地がある。

### 5. RunPod運用

RunPod Serverlessでは、初回起動、モデル未キャッシュ時のダウンロード、GPU種別、Network Volume、timeout設定が体感速度とコストに直結する。

- イメージ: ComfyUI-VibeVoice拡張はDocker imageへ入れる。モデル本体はNetwork VolumeまたはHugging Face cacheへ置く。
- 初回生成: モデルがVolumeに無い場合は生成リクエスト内でダウンロードが走るため、初回だけ非常に遅くなる。デモ前にwarmupまたは短い生成を行う。
- timeout: VibeVoiceはSeed-VCより長くなる可能性があるため、RunPod job timeoutとAPI側timeoutを分けて管理する。
- GPU選定: VRAM使用量、生成速度、課金単価を記録し、A4500/RTX 2000 Ada/16GB級GPUで足りるかを確認する。
- 失敗ログ: RunPod job id、handler stderr末尾、モデル検出状態、生成パラメータをAPIレスポンスの診断情報として扱う。
- result size: RunPod job outputには最終音声を載せる。指定台詞向けモードの中間音声はサイズが大きいため既定では省略し、diagnosticsの `runpod_artifacts` に件数、base64文字数、省略理由を残す。

本番デモでは、ブラウザへRunPod API keyを渡さず、FastAPIまたはCloudflare Workerなどのサーバー側からRunPod jobを作る構成を維持する。

### 6. zhskit相当機能の取捨選択

`zhskit` の機能をそのまま移植するのではなく、VibeVoice生成の価値に直結するものから選ぶ。

- 優先度高: 台本ファイル読み込み、参照音声の正規化、生成履歴、パラメータ比較、ダウンロード。
- 優先度中: URLからの台本/音声読み込み、複数候補生成、生成結果のクラウド保存、話者プリセット。
- 優先度低: 教材生成、動画レンダリング、外部公開ページなど、音声生成品質の検証と直接関係しない周辺機能。

まずは「同じ入力を条件違いで比較できる」ことを最優先にする。品質課題が残る段階で周辺機能を増やすと、問題の切り分けが難しくなる。

### 7. 実進捗表示

ローカル実行ではVibeVoice CLIがstderrへ `tqdm` 形式の進捗を出すため、これをジョブ状態へ取り込み、UIのプログレスバーへ反映する。

- ローカル: `subprocess.Popen` のstderrを逐次読み、`Loading weights`、`Generating`、`line-by-line` の現在値、総数、割合をジョブstoreへ保存する。
- UI: indeterminate表示は初期化や未知ステージだけに使い、進捗値が取れるステージではバー幅とパーセントを実値へ切り替える。
- キャンセル: 進捗読取中でもキャンセル要求を優先し、subprocessをterminate/killする。
- RunPod: 通常のRunPod job statusだけではCLI内部stderrの細かい進捗は取れない。RunPodでも実進捗を出す場合は、handlerから外部storeへ進捗を書き、gateway/UIがそれを読む設計が必要になる。

## zhskitから未移植の主な機能

- 台本URL読み込み。
- 参照音声URL読み込み。
- 生成結果のクラウドアップロード。
- スキット作成支援、台本拡張、HSK教材生成、動画レンダリングなどの周辺機能。
- 生成履歴とパラメータ比較。

これらはVibeVoice生成品質とRunPod実行経路が安定した後に、必要なものだけ移植する。
