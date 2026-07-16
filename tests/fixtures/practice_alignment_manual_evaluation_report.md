# SpeakLoop 手作業アラインメント独立評価

作成日: 2026-07-15

## 固定した評価データ

- fixture: `tests/fixtures/practice_alignment_manual_evaluation_cases.json`
- 総件数: 200件
- 中国語 (`zh-CN`): 100件
- 英語 (`en-US`): 100件
- source: `hand-authored-manual-evaluation`
- 固定時SHA-256: `cf35826ecd61e428c7b8d7e981392890b9ec83b14b36aefbd5f627de26fd39fe`
- 期待値レビュー訂正後SHA-256: `7967010c9b10fb9128a8da2c1f128cbd9671629c0ca9045bbf4972fd17f84da5`

このSHAは、現在のPython版またはCloudflare Worker版のアラインメント関数を初めて実行する前に記録した。期待値作成中は `src/mo_speech/practice.py` と `cloudflare/worker.mjs` のアラインメント実装を読まず、公開仕様、既存fixtureのスキーマ、実録音ログのtimestamp形式だけを参照した。既存fixtureの `comparison_alignment` や今回の現実装出力を期待値の根拠には使っていない。

作成は、最初に中国語10件・英語10件、次に各55件、最後に各100件の順で段階化した。各段階でJSON構造、名前・目標文・認識文の一意性、timestamp順序、期待区間に含まれるtoken列を検査した。

### 初回評価後の期待値レビュー訂正

初回実行はPython版173/200件、Worker版172/200件だった。その失敗を個別にレビューしたところ、次の7件は公開仕様に記載された「目標文の句読点でフレーズを分ける」という境界ルールに対して、手作業期待値側が通常のcommaを境界として扱っていなかった。実装が返した区間をコピーせず、目標文の句読点と元のASR token timestampから期待値を再計算した。

| case | 変更前 | 変更後 | 訂正理由 |
| --- | --- | --- | --- |
| `manual_eval_en_015_leading_fillers_excluded_return` | 1区間: 全文 `0.93–3.09` | 2区間: `0.93–2.02`, `2.02–3.09` | commaの前後を別フレーズとして扱う |
| `manual_eval_en_039_similar_boundary_right_right` | 2区間: 第2区間 `right away you'll see the bank` | 3区間: `Turn right`, `right away`, `you'll see the bank` | periodに加え `Right away,` のcommaも境界にする |
| `manual_eval_zh_059_leading_clause_omitted_package` | 1区間、`complete=true` | 第1区間なし、第2区間 `请联系快递公司`、`complete=false` | comma前の条件節は発話されていない |
| `manual_eval_en_059_leading_clause_omitted_refund` | 1区間、`complete=true` | 第1区間なし、第2区間 `I'd like a full refund`、`complete=false` | comma前の理由節は発話されていない |
| `manual_eval_zh_074_first_phrase_starts_halfway` | 2区間、`complete=true` | 第1区間なし、後続2区間あり、`complete=false` | comma前の理由節を独立した未対応フレーズにする |
| `manual_eval_en_074_first_phrase_starts_halfway_conference` | 2区間、`complete=true` | 第1区間なし、後続2区間あり、`complete=false` | comma前の理由節を独立した未対応フレーズにする |
| `manual_eval_en_082_no_punctuation_dialogue` | 3区間: `yes I checked twice`を一体化 | 4区間: `yes`と`I checked twice`を分離 | 目標側 `Yes,` のcommaを境界にする |

この7件以外は、現実装が失敗したことを理由に期待値を変更していない。訂正後のfixtureを再固定し、以後の最終評価は訂正後SHAを対象とする。

## 手作業性と重複レビュー

- 200ケースは一件ずつ、発話場所、話者の意図、失敗の起き方、比較すべき区間を決めて記述した。
- テンプレートへの単語差し替え、直積、組み合わせ総当たり、生成規則によるケース作成は行っていない。
- 既存4 fixtureとの `target_text + recognized_text` 完全一致は0件だった。
- 今回fixture内では名前、目標文、認識文がすべて一意である。
- 同一言語内の正規化済み目標文を全組み合わせで確認し、`SequenceMatcher >= 0.68` の近似ペアは0件だった。
- 全体レビューで中国語ケースをそのまま英訳したように見えた英語ケースを抽出し、場面と発話内容を独立したものへ書き直した。

## timestampと期待値の静的検査

- 全token/segment: 1,647区間
- timestamp: すべて非負、開始・終了順は単調増加、`end >= start`
- 区間長: 259種類。word間隔を一律生成していない。
- 各 `expected.ranges` の `matched_text` は、指定した `audio_start` / `audio_end` 内の生token列と一致する。
- `expected.available` は利用可能rangeの有無、`expected.complete` は全range利用可否と一致する。
- range indexは0から連続し、`range_count` とrange配列長が一致する。

## カテゴリ別件数

| category | 合計 | 中国語 | 英語 |
| --- | ---: | ---: | ---: |
| `boundary_similarity` | 4 | 2 | 2 |
| `combined_error` | 2 | 1 | 1 |
| `contraction` | 1 | 0 | 1 |
| `ending_omission` | 1 | 0 | 1 |
| `exact` | 8 | 4 | 4 |
| `filler` | 13 | 6 | 7 |
| `hesitation` | 7 | 4 | 3 |
| `insertion` | 10 | 5 | 5 |
| `mixed_script` | 7 | 4 | 3 |
| `omission` | 26 | 13 | 13 |
| `partial_match` | 8 | 4 | 4 |
| `partial_recording` | 11 | 5 | 6 |
| `phrase_order` | 8 | 4 | 4 |
| `pronunciation_confusion` | 12 | 4 | 8 |
| `proper_noun` | 3 | 1 | 2 |
| `punctuation` | 8 | 4 | 4 |
| `repeated_prefix` | 4 | 2 | 2 |
| `repetition` | 10 | 5 | 5 |
| `script_normalization` | 3 | 3 | 0 |
| `segment_fallback` | 2 | 1 | 1 |
| `self_correction` | 21 | 11 | 10 |
| `stutter` | 7 | 3 | 4 |
| `timestamps` | 6 | 3 | 3 |
| `tone_confusion` | 3 | 3 | 0 |
| `unavailable` | 11 | 6 | 5 |
| `wrong_content` | 4 | 2 | 2 |

英語の冠詞・前置詞・短縮形・語尾の失敗は `omission`、`contraction`、`ending_omission`、`pronunciation_confusion` に分けている。中国語の同音・近音・声調由来の別漢字は `pronunciation_confusion` と `tone_confusion`、簡体字・繁体字混在は `script_normalization` と `combined_error` に分けている。

## 評価結果

期待値訂正後のSHAが変わっていないことを確認してから、同じfixtureをPython版とCloudflare Worker版へ入力した。

| runtime | 成功 | 失敗 | 中国語 | 英語 |
| --- | ---: | ---: | ---: | ---: |
| Python (`src/mo_speech/practice.py`) | 180/200 | 20/200 | 90/100 | 90/100 |
| Cloudflare Worker (`cloudflare/worker.mjs`) | 179/200 | 21/200 | 90/100 | 89/100 |

失敗が残ったcategoryは次のとおり。表の値は `Python / Worker` の失敗件数である。

| category | 失敗件数 |
| --- | ---: |
| `filler` | 2 / 2 |
| `insertion` | 4 / 4 |
| `mixed_script` | 2 / 2 |
| `omission` | 1 / 1 |
| `partial_match` | 3 / 3 |
| `phrase_order` | 2 / 2 |
| `repetition` | 2 / 2 |
| `self_correction` | 4 / 4 |
| `unavailable` | 0 / 1 |

## 失敗原因の分類

初回評価で失敗したケースをレビューした分類である。期待値不適切の7件は上記の履歴どおり訂正し、最終評価では成功している。他の期待値は現実装へ合わせて変更していない。

| 分類 | Python | Worker | 対象 |
| --- | ---: | ---: | --- |
| 実装側の問題 | 14 | 15 | 下記の共有14件、およびWorkerだけの1件 |
| fixtureの期待値が不適切 | 7 | 7 | 初回評価後に訂正したcomma境界7件。最終評価の失敗には残っていない |
| 仕様が曖昧で一意に決められない | 6 | 6 | 戻り発話2件、フレーズ間の意味文挿入2件、email/decimal内のperiod 2件 |
| ASR timestampだけでは正しく判定できない | 0 | 0 | 今回の失敗には該当なし |

### 実装側の問題

- 内部の迷い・意味のある前置き・誤文からの言い直しを区間から落とす: `manual_eval_zh_003_long_internal_filler_phone_call`、`manual_eval_en_004_long_internal_filler_recipe`、`manual_eval_zh_024_immediate_false_start_date`、`manual_eval_zh_068_wrong_route_then_restart`、`manual_eval_zh_070_meaningful_preamble`、`manual_eval_en_070_meaningful_preamble_charger`
- 完全な第1フレーズ再発話を最初の1回だけに縮める: `manual_eval_zh_022_full_first_phrase_repeated`、`manual_eval_en_022_full_first_phrase_repeated`
- 後続語を前の区間へ取り込む、抜けた別フレーズへ語を誤配分する、または同じ接頭辞を持つ順序違いを対応済みにする: `manual_eval_en_033_partial_match_then_other_content`、`manual_eval_en_060_last_two_phrases_omitted_concert`、`manual_eval_zh_097_reordered_same_prefix`、`manual_eval_en_097_reordered_same_prefix`
- 核心語が異なる部分一致を対応可能と判定する: `manual_eval_zh_100_first_phrase_partial_second_exact`、`manual_eval_en_100_first_phrase_partial_second_exact`
- Workerだけが無関係な発話を対応可能と判定する: `manual_eval_en_076_unrelated_three_phrases_home_repair`

### 仕様が曖昧なケース

- `manual_eval_zh_023_return_to_previous_phrase`、`manual_eval_en_023_return_to_previous_phrase`: 第2フレーズを話した後に第1へ戻り、再度第2を話した連続区間を、どの目標フレーズが所有するかが公開仕様だけでは一意でない。重複しない連続rangeという表現制約もある。
- `manual_eval_zh_028_extra_sentence_between_phrases`、`manual_eval_en_028_extra_sentence_between_phrases`: 二つの目標フレーズ間に挿入した意味のある理由文を、前の区間の末尾、次の区間の先頭、または比較対象外のどれにするかが未規定である。
- `manual_eval_zh_055_email_and_version_number`、`manual_eval_en_046_email_version_digits`: 文区切りのperiodと、email addressや`2.1`内のperiodを同じ句読点として分割するかが未規定である。fixtureは構造化token内のperiodを文境界にしない期待値とした。

今回のtimestampは、期待した連続区間を表現するのに十分だったため、残存失敗をtimestamp情報だけの限界には分類しなかった。ただし、このfixtureは合成済みASR本文とtimestampの対応処理を評価するものであり、声調・近音を実音声からASRが正しく認識できるかは評価しない。

## Python版とWorker版の差

公開契約である `available`、`complete`、各rangeの利用可否・文字列・時刻が異なったのは、`manual_eval_en_076_unrelated_three_phrases_home_repair` の1件だった。Python版は3フレーズすべてを対応不能としたが、Worker版は無関係な調理発話 `with milk and cook the batter` を目標の `Water is under the cabinet.` に対応させた。

`manual_eval_en_100_first_phrase_partial_second_exact` は、両実装とも同じ誤ったrangeを返した一方、内部の `similarity` / `coverage` がPython `0.760 / 0.731`、Worker `0.800 / 0.769` と異なった。比較再生契約の差ではないが、採点ロジックがランタイム間で完全には一致していない証拠として残す。整数と小数のJSON表現差だけのケースは挙動差へ数えていない。

## 公開デモへ出せるか

現時点では、比較再生を正確な主要機能として公開デモへ出せる精度とは判定しない。このfixtureは難例を意図的に多く含むため、90%という数値を実利用の失敗率へそのまま換算はできない。一方で、失敗には単なる数ミリ秒のずれだけでなく、言い直しや反復を落とす、後続フレーズへ誤配分する、無関係な発話を対応可能とする例が含まれ、学習者へ誤った比較区間を提示する。

完全一致、句読点欠落・位置違い、単純な途中終了、timestampの長い間・不均等間隔、近音・声調由来のASR置換などは今回の期待値を満たした。したがって、機能全体を破棄する結果ではないが、少なくとも上記の誤対応を一般条件で減らし、別の未使用データでも悪化がないことを確認してから公開品質と判断する。

## 一般化できる改善候補

個別文や個別語の例外は追加せず、次を候補として同じfixture全体と新しい未使用データで比較する。

1. 句読点分割の前に、email address、decimal、version numberなど構造化token内のperiodを文境界から保護する。ただし先に公開仕様で境界規則を確定する。
2. 選択候補の外側を局所的に広げる現在の考え方だけでなく、内部の意味語、完全な再発話、ある程度話した誤文からのrestartを保持できる連続区間候補を比較する。
3. 同じ接頭辞を持つフレーズの順序違いと欠落では、後続の高品質一致を守り、弱い候補が別フレーズの語を取り込まない順序・占有制約を強める。
4. 長い共通接頭辞だけで核心語が違う候補や、無関係な中程度類似候補を `unavailable` にできる拒否条件を比較する。単一の類似度閾値を1ケースに合わせず、改善数・悪化数と誤対応の重大度を分けて測る。
5. PythonとWorkerの候補評価式・閾値・丸めを共通契約へ固定し、この200件を変更に使わない評価fixtureとして両ランタイムへ継続適用する。

## 実行と検証

- 独立評価: `PYTHONPATH=src python3 tmp/evaluate_manual_alignment.py`
- Worker独立評価: `node tmp/evaluate_manual_alignment.mjs`
- 既存Python回帰: `PYTHONPATH=src python3 -m pytest tests/test_practice_alignment.py -q` — 108件成功
- 既存Worker回帰: `node --test tests/practice_alignment_worker.test.mjs` — 100件成功
- Python全体: `python3 -m pytest` — 846件成功、失敗0件（既知のdeprecation warning 5件）
- Node全体: `npm test` — 192件成功、失敗0件
- JavaScript構文検査: `npm run check:js` — 成功
- 差分検査: `git diff --check` と新規2ファイルの `git diff --no-index --check` — whitespace errorなし
- 評価の詳細JSONは `tmp/practice_alignment_manual_evaluation_python.json` と `tmp/practice_alignment_manual_evaluation_worker.json` に出力した。`tmp/`はgit管理外で、永続的な評価結果と分類は本書を正とする。
