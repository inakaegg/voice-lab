# VibeVoiceスキット生成

## 現在の位置づけ

`/skitvoice` は、指定台詞向け生成のユーザー向け通常画面である。台本、最大4つの参照音声、生成ボタン、結果確認に絞り、backend/model/サンプリング、実行環境、診断JSONなどの技術情報は通常表示しない。`/skitvoice/admin` は、`zhskit` のスキット生成機能をこのアプリへ移すための検証・管理画面であり、生成パラメータや診断を直接確認できる。旧 `/vibevoice` と `/vibevoice/simple` は互換用エイリアスとして残す。

初期実装では、ローカル実行とRunPod Serverless実行を選べる。ローカル実行は開発機上のVibeVoice CLIを呼ぶ。RunPod実行はFastAPIがRunPod jobを作り、RunPod handlerが `operation_mode=vibevoice` として同じ処理を実行する。

## 生成オプション

- `モデル`: 比較検証用に、RunPod/ローカルへ渡すVibeVoiceモデルを選ぶ。通常候補は以下とする。
  - `VibeVoice 1.5B 固定版`: ローカルで動作確認した `microsoft/VibeVoice-1.5B` のrevisionを固定して使う。再現性を優先する既定値。
  - `VibeVoice 1.5B 最新`: `microsoft/VibeVoice-1.5B` のHugging Face `main` を使う。2026-07-01時点では固定版と重み/configは同一に見えるが、今後の更新比較用に残す。
  - `VibeVoice Large (RunPod)`: `aoi-ot/VibeVoice-Large` をRunPod/CUDAで検証する実験候補。ローカルmacOSでは選択不可にし、APIも `backend=local` との組み合わせを拒否する。
- `ランダム性を使う`: VibeVoiceのsamplingを有効にする。同じ台本でもseedや設定によって抑揚や細部が変わる。安定性を優先して比較したい場合はOFFも試す。
- `行ごとに生成して結合`: 台本全体を一度に生成せず、1行ずつ生成して無音を挟んで結合する。長文や複数発話で破綻を分けやすい一方、行間や話し方の連続性は不自然になる可能性がある。
- `指定台詞を1行生成してASR再配置`: 指定台詞を正確に読ませるための実験モード。表示用台本は保持し、生成時だけ話者ごとに1行テキストへまとめてVibeVoiceへ渡す。VibeVoice出力をASR timestampでフレーズ区間推定し、低スコア行だけ必要に応じて再生成する。採用範囲が決まった後に採用行クリップだけSeed-VCへ通し、元台本の行順へ並べ直し、`行間秒数` の無音を挿入して最終WAVを作る。管理画面・シンプル画面とも既定ONにする。
- `低スコア行だけ再生成`: `指定台詞を1行生成してASR再配置` の候補選別後、スコアが閾値未満の行だけ短い入力で再生成する。最大再生成行数は固定値ではなく、台本の有効行数から自動算出する。基準は `ceil(有効行数 / 2)` とし、UIでは `再生成強度` の倍率だけを調整する。たとえば有効行数が11行なら強度1.0で6行、強度2.0で12行を上限にする。
- `出力言語`: VibeVoiceへ渡す台本の言語を選ぶ。候補は `英語(en-US)`、`中国語(zh-CN)`、`日本語(ja-JP・低品質)` とする。VibeVoiceは英語・中国語で比較的安定し、日本語は研究用途の範囲では不安定なため、UI上でも低品質候補として明示する。
- `日本語台本を出力言語へ翻訳`: ONの場合、表示用の日本語台本を保持したまま、生成直前に台本本文だけを選択した出力言語へ翻訳する。話者タグ、行数、行順は維持し、`Speaker 1:`、`1 ...`、`A ...` などの話者指定は翻訳対象にしない。翻訳はVibeVoiceの短縮タグ正規化、1行化、ASR再配置より前に実行する。既定実装はOpenAI Responses APIを使い、モデルは `OPENAI_VIBEVOICE_SCRIPT_TRANSLATION_MODEL`、未指定時は `OPENAI_TRANSLATION_MODEL`、さらに未指定時は `gpt-5.5` とする。OpenAI APIキーが無い環境で翻訳ONにした場合は生成前エラーにする。診断JSONには元台本、翻訳後台本、出力言語、使用モデルを含める。
- `参照音声秒数`: 参照音声の有声区間から使う長さ。生成時は入力形式に関わらず、参照音声をmonoへdecodeし、24kHzへresampleし、前後の無音をtrimしてから、この秒数を上限に切り出す。長すぎると処理が重くなり、短すぎると声質特徴が不足する。
- 生成設定パネルにはパラメータ目安を常時表示する。探索の初期値は `cfg_scale=1.1-1.5`、`inference_steps=10-15`、本命候補で `20-30`、`temperature=0.75-0.95`、`top_p=0.85-0.95`、`top_k=0` を基準とし、不安定な時だけ `top_k=30-50` を試す。参照音声秒数は5秒を基準に、声質が弱ければ8-10秒、ノイズ混入時は3-5秒へ寄せる。

台本の正式形式は `Speaker 1: ...` だが、入力時は `1: ...`、`1 ...`、`A: ...`、`A ...` の短縮タグも使える。短縮タグは最大4つの参照音声に合わせて `1-4` または `A-D` を受け、生成前に `Speaker N:` へ正規化する。タグがない行は `Speaker 1:` として扱う。

参照音声はブラウザのIndexedDBへ保存し、次回以降は同じSpeaker枠の既定音声として再利用する。ブラウザの制約によりfile inputへ前回ファイルを直接セットすることはできないため、保存済みファイル名をSpeaker枠内に表示し、保存済みBlobをaudioコントロールで再生確認できるようにする。生成時は台本から必要なSpeaker枠を判定し、不要な保存済み音声を送らない。APIからVibeVoice CLIへ渡す時もSpeaker枠番号を保持し、`Speaker 2` の参照音声が `Speaker 1` として詰め直されないようにする。

参照音声は、ローカルファイル、ブラウザのマイク録音、ローカル/詳細画面向けの動画・音声URLから指定できる。Cloudflare公開UIでは、YouTubeなどの動画URL取得がdatacenter IPからbot確認、地域制限、ログイン要求を受けやすいため、URL入力を公開デモの標準機能にしない。公開ユーザー画面では各Speaker枠にファイル選択と録音ボタンを置き、録音した音声は保存済み参照音声としてIndexedDBへ保存して生成時に送信する。Cloudflare WorkerのVibeVoice生成APIも `voice_url_1` から `voice_url_4` を受け取った場合はRunPodへ送らず拒否する。URL切り出しはローカルFastAPI版または管理者の事前素材作成用に残し、`yt-dlp --download-sections` と `ffmpeg` で指定区間を24kHz mono PCM WAVへ切り出してから通常の参照音声として生成リクエストへ渡す。RunPod handlerはURLを受け取らず、`audio_base64` の参照音声だけを扱う。YouTubeなどの `t=`, `start=`, `time_continue=`, `#t=` に含まれる再生開始時刻を開始秒として扱い、UIで開始秒を明示した場合はその値を優先する。参照音声用途では長尺全体の無駄なDLを避けるため、section取得に失敗しても同じURLの全体DLへはフォールバックしない。

URL参照音声の実行境界は次のとおりとする。「管理者の事前素材作成」も、ローカルFastAPIへ接続している画面またはローカル処理を指し、クラウド上の管理画面でURL取得を許可する意味ではない。

| 接続先・実行環境 | ファイル | マイク録音 | タブ音声録音 | URL入力 | URL取得処理 | RunPodへ渡すもの |
| --- | --- | --- | --- | --- | --- | --- |
| ローカルFastAPI | 可 | 可 | 可 | 可 | 同じFastAPIプロセスの実行環境で `yt-dlp` / `ffmpeg` を実行 | 選択・録音・切り出し済み音声bytes |
| Cloudflare公開版 | 可 | 可 | 可 | 不可。Worker APIでも拒否 | 実行しない | 選択または録音した音声bytes |
| RunPod handler | 音声bytesのみ | 音声bytesのみ | 音声bytesのみ | URLを受け付けない | 実行しない | `audio_base64` の音声のみ |

FastAPIのURL参照APIは、既定ではリクエストURLのhostが `localhost`、`127.0.0.1`、`::1` の場合だけ許可する。`MO_VIBEVOICE_URL_REFERENCE_ENABLED=1` で非loopback接続でも明示許可でき、`0` でloopbackを含めて明示禁止できる。公開環境では許可しない。`GET /api/vibevoice/status` の `url_reference_audio` は、現在のリクエストでの有効状態と `yt-dlp` / `ffmpeg` の検出情報を返し、詳細画面ではyt-dlpのバージョンと90日超の状態を確認できる。

YouTubeのJavaScript challengeを解決するため、ローカルFastAPIのyt-dlpコマンドは `--js-runtimes node` と `--remote-components ejs:github` を指定する。Nodeはyt-dlpが対応する版をPATH上に配置し、`GET /api/vibevoice/status` の `url_reference_audio.tools.javascript_runtime` で検出パスを確認できる。cookieやPO Tokenは既定では使わず、ログイン必須コンテンツを別途仕様化する場合だけ秘密情報の管理方法とアカウントリスクを先に定める。

ローカルFastAPIでURL取得に失敗した時点では、後続のRunPod生成は開始されていない。エラー表示では、外部ツールの取得失敗を先に、更新警告などを別の警告として後に表示し、観測事実と推測上の原因候補を分ける。RunPodやdatacenter制限を確認済みの原因として表示しない。URL参照を設定したSpeaker枠には有効状態を表示し、ダイアログの「URL参照を解除」でブラウザ保存状態と生成フォームの送信対象から明示的に外せる。ファイル選択または録音を行った場合も、同じSpeaker枠のURL参照を解除する。

タブ音声録音はブラウザの `getDisplayMedia()` を使い、ユーザーが共有対象として選択したタブの音声trackだけをMediaRecorderへ渡す。開始時はブラウザの共有ダイアログで対象タブを選び、「タブの音声を共有」を有効にする必要がある。音声trackがない画面・ウインドウ共有は参照音声として受け付けない。録音中にボタンを再度押すか、ブラウザ側で共有を停止すると録音を終了し、通常の参照音声BlobとしてIndexedDBへ保存する。タブ映像は保存・送信しない。タブ音声録音はCloudflare公開版でもブラウザ内だけで完結し、URLやcookieをWorkerまたはRunPodへ送らない。

ブラウザの共有許可は、画面・音声を技術的に取得する権限であって、コンテンツの利用許諾ではない。タブ音声録音を開始する前にこの区別を表示し、自分の音声、本人から許諾を得た音声、またはライセンス上この用途で利用できる音声であることをユーザーが確認した場合だけ共有ダイアログへ進む。生成前の権利確認もタブ音声を明示的に含める。一般公開動画や配信サービスをブラウザで再生できることだけでは、参照音声として利用できる根拠にならない。

台本テキストと生成設定はブラウザの `localStorage` へ保存し、次回の表示時に復元する。保存対象は、台本本文、実行先backend、モデル、`cfg_scale`、`inference_steps`、`seed`、`temperature`、`top_p`、`top_k`、`max_voice_seconds`、`line_gap`、`do_sample`、`line_by_line`、`directed_line_mode`、`directed_retry_low_score`、`directed_retry_score_threshold`、`directed_retry_max_multiplier` とする。ローカル/詳細画面でURL参照を使う場合だけ、Speaker枠ごとのURL、開始秒、切り出し秒数も保存対象にする。台本ファイルを読み込んだ場合も、読み込み後のtextarea内容を保存対象にする。生成設定のリセット操作は、台本本文とIndexedDBの参照音声を残したまま、保存対象の生成設定だけを画面初期値へ戻す。保存は同じブラウザ、同じorigin内の作業再開用であり、Googleログインユーザーごとのサーバー保存、別ブラウザ、別端末同期は行わない。履歴管理や別端末同期は今後の生成履歴機能で扱う。

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
5. VibeVoice出力そのものをASRでフレーズ分割し、タイムスタンプを取る。ASR候補はOpenAI Whisper API、faster-whisper、VibeVoice-ASRを比較するが、RunPod Largeとの同居ではGPU上のASR常駐を避ける。
6. ASRスコアで採用範囲を決め、低スコア行だけ再生成する場合も、再生成VibeVoice出力をASRしてから通常候補と比較する。Seed-VCはこの段階ではまだロードしない。
7. ASR結果と元台本を、話者、発話順、テキスト類似度で対応付ける。完全一致を前提にせず、読み替えや脱落に備える。
8. 最終採用するVibeVoice区間だけを行クリップとして切り出し、そのクリップへSeed-VCを1回かける。Seed-VCは話し方や間を根本的に作り直す工程ではなく、採用済みクリップの声質だけを最終的に寄せる工程として扱う。
9. 元台本の発話順に、対応するVC後の行クリップを並べ直し、必要な無音、クロスフェード、音量正規化を入れて最終音声を作る。

現在のWeb UIでは、「指定台詞を1行生成してASR再配置」をONにすると指定台詞向けのASR再配置モードを使う。この設定は、表示用台本を変更せず、生成前に話者ごとの発話を句読点つきの1行へまとめる。複数話者の場合は、話者ごとにVibeVoice生成を行い、各生成ではその話者の参照音声だけを `Speaker 1` として渡す。全話者のVibeVoice生成が終わった後、VibeVoice出力へASRをかけてword/segment timestampを取り、元台本の発話行へ対応付ける。低スコア行だけ再生成する場合も、Seed-VCをロードせずにretry VibeVoice生成とASRを先に済ませる。その後、採用されたVibeVoice区間だけを行クリップとして切り出し、必要なら同じ話者の参照音声でSeed-VCへ通す。最終的に元の話者順・行順へ行クリップを並べ直す。行間には `line_gap` 秒の無音を挿入する。行ごと生成とは同時に使わない。

指定台詞向けモードのASRは、既定では `MO_VIBEVOICE_DIRECTED_ASR_PROVIDER=openai` と `MO_VIBEVOICE_DIRECTED_OPENAI_ASR_MODEL=whisper-1` を使う。これはVibeVoice LargeとSeed-VCを同じRunPod workerで扱う時に、faster-whisperをGPUへ追加ロードしてVRAMを圧迫しないためである。OpenAI経路では `OPENAI_API_KEY` が必要で、外部API課金が発生する。ローカルまたはGPU余裕のある環境で自前ASRを使う場合だけ、`MO_VIBEVOICE_DIRECTED_ASR_PROVIDER=faster-whisper` を明示する。`MO_VIBEVOICE_DIRECTED_ASR_LANGUAGE` は既定 `auto` で、必要に応じて `ja-JP`、`zh-CN`、`en-US`、`hi-IN` などを指定する。Seed-VCは既定で `MO_VIBEVOICE_DIRECTED_VC_ENABLED=1`、`MO_VIBEVOICE_DIRECTED_VC_BACKEND=seed-vc` として有効にするが、ASRとretry判定が終わるまでロードしない。

この再配置はASR結果に依存するため、ASR誤認識、台詞の脱落、生成順のずれ、長尺生成の途中終了があると切り出し位置がずれる。現在はword timestampがあればASR transcriptと元台本の正規化文字列を整列してword範囲を割り当て、wordが無ければsegment数一致または文字数比でfallbackする。最終的な実用化では、対応付け結果をUIに出して、ユーザーが台詞行ごとに採用区間を調整できる必要がある。

指定台詞向けモードの結果確認では、最終音声だけでなく、話者ごとのVibeVoice出力、台本行ごとの採用クリップ音声をUI上で再生できるようにする。話者ごとの中間音声には、実際にVibeVoiceへ渡した1行化テキストも表示する。これにより、VibeVoice側で台詞が脱落したのか、ASR timestampの分割/対応付けが誤ったのか、最終VC後の音量正規化で崩れたのかを分けて確認する。話者別に結合する台詞は、弱い読点ではなく句点相当で区切り、入力内の読点も原則として句点へ寄せる。VibeVoiceは末尾側の発話が欠落しやすいことがあるため、生成用テキストの末尾には採用対象外のガード文として冒頭側のテキストを再度付け足す。ASR再配置では元台本行だけを採用対象にし、ガード文は末尾欠落を吸収するための余白として扱う。ASR transcriptと元台本を整列する時は、対象台本に最も対応する先頭prefixだけを採用し、その後ろに続くASR wordはガード部分として破棄する。対象台本の一部が欠落している場合でも、後続ガードに現れた類似フレーズを無制限に最終台詞へ吸い込まない。

指定台詞向けモードの1行化テキストは、話者ごとに短すぎても長すぎても崩れやすい。VibeVoiceは入力後半ほど発話脱落や音声崩れが起きやすいため、最終採用する台詞は必ずVibeVoice投入テキストの先頭側に置く。現時点の経験則では、採用対象のtarget chunkは1チャンクあたりおおむね80〜120文字程度を実用範囲とし、後続のguard込みのVibeVoice投入テキストは220文字程度までに抑える。話者ごとの台本がtarget上限を超える場合は、話者内で行を崩さず均等に近い複数target chunkへ分割する。各生成では、採用するtarget chunkを先頭に置き、残りchunkをローテーション順にguardとして後ろへ付ける。たとえば `A/B/C` の3分割なら、`A+B+C` からAだけを採用し、`B+C+A` からBだけを採用し、`C+A+B` からCだけを採用する。guard側が長すぎる場合は文境界を優先しつつguardだけを切り、target chunk自体は切らない。1行だけで180文字を超える場合は、行単位では安全に分割できないため入力エラーにする。Web UIも送信前に同じ上限で単一行の過長を検出し、自動分割される話者がある場合は送信時メッセージに表示する。これは固定の品質保証ではなく暫定境界値であり、診断情報にはチャンクごとの採用対象文字数、ガード文字数、最終投入文字数、guard行、範囲外フラグを残す。

フレーズ毎候補選別では、VibeVoiceを「常に1回で正しい音声を返すTTS」ではなく、候補生成器として扱う。ASR結果を使って、台本行または短いフレーズごとに、どの候補区間が最も正確かを選ぶ。現在のローテーションガード方式は、targetとして1回、別chunkのguardとしてもう1回、同じ台詞が生成されるため、追加コストなしの複数候補生成として扱える。たとえば話者内chunkが `A/B/C` の3分割なら、生成は `A+B+C`、`B+C+A`、`C+A+B` になり、各chunkはtarget候補とguard候補を持つ。target側だけを無条件採用するのではなく、target側が壊れている場合はguard側の同一台詞候補もASRスコアで比較して採用する。

`低スコア行だけ再生成` をONにした場合は、まず通常のローテーションガード候補選別を行い、採用候補のASRスコアが `directed_retry_score_threshold` 未満の行だけを抽出する。既定では閾値 `0.65`、再生成強度 `1.0` とする。最大再生成行数は `ceil(台本の有効行数 / 2 * directed_retry_max_multiplier)` で自動算出し、互換用に `directed_retry_max_lines` が明示された場合だけその値を使う。閾値は高いほど再生成対象が増え、強度倍率は高いほど再生成できる行数上限が増える。どちらも品質は上がりやすいがRunPod時間と費用が増える。再生成では元の話者全文をそのまま再投入するのではなく、対象行をVibeVoice投入テキストの先頭に置き、同じ話者の後続/前方台詞を短いguardとして後ろへ付ける。seedは元seedに `1000 + 再生成順` を足して決定的にずらし、同じ入力の単純再試行ではなく別候補として扱う。再生成後はVibeVoice出力をASRし、通常候補と再生成候補を同じ `range_candidates` に混ぜて最終採用を選ぶ。Seed-VCは最終採用範囲が決まるまでロードせず、採用された行クリップだけにかける。診断情報には再生成の有効/無効、閾値、最大行数、初回低スコア行、実際に再生成した行、再生成候補が採用された行、再生成seedを残す。既定はONであり、コストを抑える比較確認だけOFFにする。

ASRスコアリングは、まず決定的な指標で行う。候補ごとに、元台本との文字一致率、欠落文字数、余計な語の混入、候補区間の長さ、無音率、RMS、peak張り付き、音割れ疑い、chunk内位置を計算する。台詞の文字数に対して切り出し区間が短すぎる候補は、ASRが一部の単語だけを拾った断片として減点する。chunk内位置は、同じスコアならtarget先頭側を優先し、guard後半ほど減点する。ASR transcriptと元台本の対応が曖昧な場合だけ、LLMを補助的に使う余地があるが、最初からLLM前提にはしない。診断情報には、行ごとの候補一覧、各候補のASR text、スコア、採用理由、不採用理由を残し、UIで確認できるようにする。

ASR候補選別では、「ASRがどう聞き取ったか」と「実際に切り出すべき音声範囲」を分けて考える。VibeVoice出力が耳では正しく聞こえていても、ASRが一部だけ誤認識することがある。逆に、ASRが短い単語だけをきれいに拾った候補は、余計な文字が少ないため文字一致スコアだけでは高く見えることがある。たとえば長い台詞に対して `こんにちは` の0.4秒だけを拾ったretry候補は、元の3秒程度のtarget候補より余計な文字が少なく、単純な文字スコアでは勝つ場合がある。しかしこれは「正しく短く読めた」のではなく「短すぎる断片を拾った」だけなので、台詞文字数に対する最低想定秒数を下回る候補は `duration_short_for_text` として減点する。この減点はASR精度を上げるものではなく、既に存在する長めの候補範囲を短い誤断片に負けさせないための安全策である。

低スコア行のretryも、元の話者全文をそのまま再生成する処理ではない。対象行をVibeVoice投入テキストの先頭に置き、同じ話者の前後行を短いguardとして付けた別候補を作る。seedは元seedから決定的にずらし、`retry_seeds` に記録する。これにより、同じ失敗をもう一度なぞるのではなく、対象行が先頭に来る短い入力で別の生成を得る。retry候補もtarget候補やguard候補と同じ `range_candidates` に入れて、同じASRスコアリングで比較する。retry候補が短すぎる、無音が多い、文字欠落が大きい場合は、retryしたこと自体を優先しない。

今後この周辺を調査するCodexは、スコア式を変える前に診断JSONの `speaker_vibevoice`、`asr_words`、`ranges`、`range_candidates`、`retry_scripts`、`retry_seeds`、`low_score_retry`、`voice_conversion_durations` を確認する。見る順番は、1) 話者別VibeVoice音声で台詞自体が出ているか、2) ASRがその音声をどう聞き取ったか、3) 対象行に対して複数候補があるか、4) 採用候補のdurationとテキスト長が釣り合っているか、5) retry候補がtarget候補を不当に上書きしていないか、6) 採用行クリップのSeed-VC前後durationが大きくずれていないか、である。ASRがそもそも完全な候補範囲を出していない場合、スコア調整だけでは救えないため、近傍wordへの範囲拡張、VAD併用、行単位の手動調整、またはTTS fallbackを別改善として検討する。

候補生成方式の比較:

- ローテーションガード候補選別: 生成回数を増やさず、現状のtarget候補とguard候補を比較する。追加RunPod費用がほぼ無いため、最初に実装する候補として最も費用対効果が高い。欠点は、候補が最大2回程度で、同じ生成内の崩れを完全には避けられないこと。
- 失敗行だけ再生成: まずローテーションガード候補選別を行い、ASRスコアが閾値未満の行だけ短い入力で再生成する。追加費用は壊れた行に限定されるため、実用時のコスト効率が高い。再生成時は、対象フレーズ単体では短すぎることがあるため、短い前後文または安全なガード文を付ける。現在は既定ONの `directed_retry_low_score` として実装し、費用優先の比較時だけOFFにする。
- 複数seed生成: 同じchunkをseed違いで複数回生成し、ASRスコアで最良候補を採用する。品質改善の可能性はあるが、生成回数に比例してRunPod費用が増える。全chunkで常用するより、失敗chunkだけに限定する。
- 重複window生成: `A B C D E F` に対して、window幅3なら `A B C`、`B C D`、`C D E`、`D E F`、`E F A`、`F A B` のように循環windowを作る。全フレーズが3回ずつ生成され、位置違いの候補を持てる。ただし1フレーズをwindow幅の回数だけ生成するため高コストで、通常運用の既定にはしない。品質検証や重要音声の本命生成でだけ試す候補にする。
- target中央配置: `前ガード + target + 後ガード` にして中央を採用する。先頭や末尾が不安定なモデルでは有効な可能性があるが、現在の観察では先頭側が比較的良いケースもあるため、実測してから採用する。
- OpenAI TTS + Seed-VC fallback: VibeVoice候補が内容を正しく読めない行だけ、OpenAI TTSなどの正確なTTSで台詞を生成し、Seed-VCで参照話者へ寄せる。台詞再現性は高くなりやすい一方、話し方、間、抑揚は前段TTSの影響を受け、VibeVoiceがうまく出た時ほど本人声らしくならない可能性がある。以前から実装経路は存在するが、指定台詞用途での品質比較は別途A/B確認が必要である。内容の正確さを優先する救済策として扱う。

現時点の優先順は、1) ローテーションガード候補選別、2) 失敗行だけ再生成、3) OpenAI TTS + Seed-VC fallback、4) 失敗chunkだけ複数seed、5) 重複window生成、とする。最もコスト効率が高いのは、既存のローテーションガードを候補プールとして使い、ASRスコアで採用候補を選ぶ方式である。次に費用対効果が高いのは、スコアが悪い行だけを再生成または別TTS fallbackへ回す方式である。

RunPod Serverless経由では、長尺の指定台詞向けモードで中間音声をすべて `artifacts[].audio_base64` としてjob resultへ載せると、最終音声、話者別VibeVoice音声、行ごとの採用クリップ音声が重複して巨大化し、RunPodの結果返却段階で失敗し得る。そのためRunPod handlerは、最終音声を既定でWAVからMP3へ圧縮して `audio/mpeg` として返す。互換検証では `response_audio_format=wav` または `MO_RUNPOD_VIBEVOICE_RESPONSE_AUDIO_FORMAT=wav` を指定できる。M4A/AACを試す場合は `m4a` を指定する。圧縮に失敗した場合はWAVへfallbackし、`diagnostics.runpod_audio_response` に要求形式、実返却形式、元サイズ、返却サイズ、エラーを残す。

中間音声は原因確認に必要なため、RunPod handlerは既定で「返却上限内に入る分だけ」inline返却する。ただしVC前の話者別VibeVoice出力 `speaker_vibevoice` は既定で除外し、台本行ごとの採用クリップ音声を優先する。採用クリップ音声はSeed-VC有効時にはVC後、無効時にはVibeVoice切り出し後の音声になる。中間音声も既定ではMP3へ圧縮し、`artifact_response_max_items` と `artifact_response_max_base64_chars` の範囲で入るものだけを返す。完全に省略したい場合は `return_artifacts=false` または `MO_RUNPOD_VIBEVOICE_RETURN_ARTIFACTS=0` を指定する。VC前の話者別VibeVoice音声まで含めたい場合は `artifact_response_exclude_kinds` を空にする。長尺でも中間音声を常時確認したい場合は、RunPod job outputではなく、永続Volumeやオブジェクトストレージへartifactを保存し、UIはURLや履歴APIから取得する構成に分ける。

ローカルFastAPIの `/api/vibevoice/jobs` 経由で生成した場合、ジョブ完了時に音声base64を除いた診断JSONを `tmp/vibevoice-debug/last-result.json` と `tmp/vibevoice-debug/<job_id>.json` へ保存する。保存先は `MO_VIBEVOICE_DEBUG_RESULT_DIR` で変更でき、`off`、`0`、`false` などを指定すると無効にできる。このJSONには、RunPod workerから返った `diagnostics`、`artifacts` のメタデータ、ASRの `full_text`、採用した `target_prefix_text`、破棄した `ignored_tail_text`、word数を残す。中間音声そのものをすべて保存する用途ではなく、生成後にASRがどう聞き取り、どの範囲を採用したかを後から確認するための軽量ログである。

再構成時は、採用済みの台本行クリップへ軽いDC offset除去、RMS正規化、peak制限をかけてから結合する。これは参照音声やSeed-VC後出力の音量差、切り出し区間ごとの過大peakによる音割れを減らすための後処理であり、VibeVoiceが誤った台詞を生成した場合の内容修正ではない。話者ごとの中間音声は原因確認のため元のVibeVoice出力を保持し、最終出力と台本行ごとの切り出し音声で正規化後の音を確認できるようにする。

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

20GB級GPUでLargeを使う場合は、VibeVoice以外のresident GPUモデルを同じworker processに残さない。特に `MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START=1` でSeed-VCを起動時preloadすると、親process側に数GiBのVRAMが残り、Largeのロード中にOOMしやすい。VibeVoice用RunPod imageの既定は `MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START=0` とし、VibeVoice request前に既存のVoice Conversion serviceを解放する。指定台詞向けASR再配置モードでは、複数話者のVibeVoice生成、VibeVoice音声ASR、低スコアretry生成、retry音声ASRを全て終えてから、採用行クリップだけSeed-VCへ通す。ASRの既定をOpenAI `whisper-1` にすることで、Large生成とfaster-whisper ASRが同じGPUへ同時または連続で載る状態を避ける。

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
- result size: RunPod job outputには最終音声を載せる。VibeVoiceのRunPod handlerは最終音声と中間音声を既定でMP3へ圧縮して返す。指定台詞向けモードの中間音声はVC前出力を既定で除外し、返却上限内に入るものだけを返す。diagnosticsの `runpod_artifacts` に件数、base64文字数、省略理由、除外kindを残す。

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

## 簡易画面の台本・翻訳・タブ音声

- 初期台本は Speaker 1 / 2 の5行会話とする。
- 「AIで5行生成」は、日本語で2話者・5行の短い日常会話を生成して台本欄へ反映する。
- 簡易画面では翻訳チェックを表示しない。台本の言語を固定せず、出力言語と異なる場合だけ生成前に自動翻訳する。
- 翻訳処理を行った場合は、生成結果に「翻訳後の台本」を表示する。
- タブ音声録音の開始時に、権利確認ダイアログや必須チェックを毎回要求しない。
- 画面には、個人・家庭内の私的利用を超えて公開・共有する場合は利用許諾またはライセンスを確認する旨を常設表示する。ブラウザのタブ共有許可は公開・再利用許諾そのものではない。
