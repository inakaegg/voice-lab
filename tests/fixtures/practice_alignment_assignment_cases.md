# SpeakLoop フレーズ割当 第2弾独立評価

作成日: 2026-07-15

## 目的

このfixtureは、目標文との文字列類似度ではなく、学習者が実際に話した音声をどのtarget phraseへ構造的に割り当てるべきかを評価する。言い間違い、挿入、自己訂正、低一致発話を比較区間から不当に落とさない一方、構造的根拠のない発話や実在しないtimestampは割り当てない。

第1弾の次のファイルは読み取り専用とし、この作業では変更しない。

- `tests/fixtures/practice_alignment_manual_evaluation_cases.json`
- `tests/fixtures/practice_alignment_manual_evaluation_report.md`

## 独立性

- 期待値は公開仕様、実録音分析、既存fixtureのスキーマを基準に人間が決める。
- 約200件の期待値を固定するまで、`src/mo_speech/practice.py` と `cloudflare/worker.mjs` の現行アラインメント関数を実行しない。
- テンプレート展開、単語差し替えによる水増し、組み合わせ総当たり、ケース生成スクリプトを使わない。
- JSON構文、件数、timestamp、token割当、重複の検査だけはスクリプトで行う。
- 現行実装と異なっても、テストを通す目的で期待値を変更しない。

## スキーマ

既存の `expected.ranges` 契約に、レビュー用メタデータを追加する。

- `target_phrases`: 句読点で分けた目標フレーズ一覧。
- `subcategories`: 1ケースが同時に検査する副観点。
- `token_start_index` / `token_end_index`: rangeが所有する `words` の両端index。両端を含む。
- `alignment_confidence`: 文字列の正解度ではなく、そのrangeを対象phraseへ構造的に割り当てる確信度。`high`、`medium`、`low`、`text_only`、`unavailable`を使う。
- `expected_unassigned_tokens`: 音声rangeへ入れないwordと理由。全tokenはrangeかこの一覧のどちらか一方だけに属する。
- `expected_text_only_tokens`: 文字列上はphraseへ対応するが、zero-durationなどで安全な再生rangeを作れないtoken。
- `expected_invariants`: 実装方式に依存しない守るべき条件。
- `expected_alignment_confidence`: ケース全体の構造判断。複数rangeで異なる場合は`mixed`。
- `alignment_input_side`: コアアラインメントへの入力が学習者側、お手本側、または両側へ独立に適用する契約のどれを表すか。指定がないケースは学習者側を想定する。
- `segment_start_index` / `segment_end_index`: word timestampがなく、実在するsegmentをそのまま使えるケースだけで使う。文字数比によるsegment内部の推定には使わない。
- `expected_text_without_timestamp`: ASR本文には存在するがword/segment timestampがなく、安全な再生区間を作れない文字列情報。

`expected.complete`は全target phraseに再生可能rangeがあることを表す。明示的edge fillerや、target完了後の独立した無関係発話が理由付きで未割当でも、全target phraseが再生可能なら`complete=true`とする。説明不能な未割当tokenがある状態を`complete=true`にはしない。

zero-duration tokenは、文字列情報と再生時間を分ける。同じphraseの正の長さを持つ隣接tokenへ安全に含められる場合は`matched_text`とtoken範囲へ保持する。zero-duration tokenだけで独立phraseを構成し、安全に広げられない場合は、そのphraseを`unavailable`とし`expected_text_only_tokens`へ記録する。

## 段階的作成

### 初回20件

- 中国語10件、英語10件。
- 文頭の意味語とedge fillerの区別、フレーズ間の誤認識・false start、低一致だがanchorで位置が決まる発話、zero-duration、抜けとどもり、末尾の追加説明、無関係発話、長い冒頭無音、空ASRを含めた。
- 現行実装は未実行。

初回20件の構文、timestamp、token完全分類、内容重複を確認後に次のbatchへ進む。

### 追加batchと固定

- 60件（中国語30件・英語30件）で、先頭・フレーズ間割当を再検査した。
- 110件（中国語55件・英語55件）で、低一致、末尾、省略、順序を再検査した。
- 160件（中国語80件・英語80件）で、zero-duration、pause、segment、無音状態を再検査した。
- 200件（中国語100件・英語100件）で、複合ケース、句読点、正常系、8フレーズ性能基準を加えて横断監査した。
- 各batchの検査はJSON構文、timestamp、range、token分類、重複だけであり、現行アラインメント関数は実行していない。

固定時のJSON SHA-256:

```text
7b0b6ba1c7657c9389511c486af8aa1cd46a3537fa4b17f1f127997f2624f9cf
```

固定前の横断監査結果:

- 総数200件、中国語100件、英語100件。
- 既存6 fixtureとの `target_text + recognized_text` 完全重複は0件。
- 第2弾内のtarget完全重複、recognized text完全重複、description完全重複、rationale完全重複はいずれも0件。
- 同一言語内でtarget textのSequenceMatcher比が0.68以上の組は0組。
- zero-duration tokenを含むケースは34件、理由付き未割当tokenを含むケースは31件。
- 低または中confidenceでも再生可能なrangeを持つケースは51件。
- 全phraseがunavailableのケースは10件、一部phraseだけunavailableのケースは34件。
- target phrase数は2文131件、3文49件、4文10件、5文4件、6文4件、8文2件。

## カテゴリ別件数

`category`は主目的を一つだけ示す。複数の現象を含むケースは`subcategories`へ併記した。

| category | 中国語 | 英語 | 合計 |
|---|---:|---:|---:|
| `zero_duration` | 15 | 15 | 30 |
| `omission_and_order` | 13 | 13 | 26 |
| `interphrase_assignment` | 13 | 12 | 25 |
| `leading_assignment` | 11 | 11 | 22 |
| `composite` | 10 | 10 | 20 |
| `pause_timestamp` | 9 | 10 | 19 |
| `structural_low_similarity` | 6 | 6 | 12 |
| `normal_regression` | 6 | 6 | 12 |
| `trailing_assignment` | 5 | 5 | 10 |
| `silence_non_speech` | 3 | 4 | 7 |
| `punctuation_boundary` | 3 | 3 | 6 |
| `asr_variation` | 2 | 2 | 4 |
| `unavailable` | 2 | 1 | 3 |
| `performance_regression` | 1 | 1 | 2 |
| `ambiguous_unavailable` | 1 | 1 | 2 |
| 合計 | 100 | 100 | 200 |

rawの`subcategories`は311種類ある。頻出する観点は、前方割当17件、後方割当12件、自己訂正9件、長いpause・pauseなし・side metadata・4フレーズが各6件、境界zero-duration・途中終了・低confidenceでも再生可能・順序を戻るケースなどが各4件である。これは生成規則のラベルではなく、個々の発話をレビューするときの説明用タグである。

## 手作業性と重複の確認

- JSONの各ケースは`apply_patch`で個別に記述し、ケース生成script、テンプレート置換、組み合わせ展開は使っていない。
- target、ASR発話、誤り方、pause、timestamp、期待rangeをケースごとに読み、`rationale`で割当根拠を説明した。
- scriptは構文、集計、timestamp単調性、token完全分類、文字列重複の検出にだけ使った。
- 第2弾内のtarget、recognized text、description、rationaleの完全重複はいずれも0件だった。
- 同一言語内のtarget textについてSequenceMatcher比0.68以上の組は0組であり、単語差し替えに見える近似targetもなかった。
- 既存6 fixtureとの`target_text + recognized_text`完全重複は0件だった。
- 20件、60件、110件、160件、200件の各段階で静的レビューを行い、次のbatchへ進む前にtimestampと割当を再確認した。
- 固定後に期待値を変更したケースは0件である。実装結果へ合わせた修正も0件である。

## API・UI層で別に扱う候補

アラインメントfixtureだけでは、実録音のエネルギーやprovider job状態を表せない。次は最終集計で別テスト候補として整理する。

- 完全な無音、ごく短い環境音、息だけ、マイク接触音、発話開始前の録音終了をno-speechとして扱う処理。
- providerが`succeeded`でもASR本文、words、segmentsがすべて空になる経路。
- timestampなしのhallucinated textを、比較可能な発話として成功扱いしない経路。
- お手本側だけ、学習者側だけ、両方のASRが失敗したAPI snapshot。
- no-speech、空ASR、timestampなしhallucinationで、APIが採点やアラインメントを開始しないこと。
- 同じ状態でUIが音声全体へfallbackして「比較成功」に見せず、理由を示して再録音を促すこと。

このfixtureでは`silence_non_speech`を7件用意したが、音声energyやprovider状態をコア関数の入力だけで再現できないため、上記は別のAPI/UIテストにする必要がある。今回は指定された2ファイル以外を変更できないため、テスト候補の記録までとした。

## 評価結果

### 評価条件

200件の期待値を固定し、JSONのSHA-256が次の値であることを確認してから初めて実装を読み、実行した。

```text
fixture: 7b0b6ba1c7657c9389511c486af8aa1cd46a3537fa4b17f1f127997f2624f9cf
```

比較した契約は`available`、`complete`、range数、および各rangeの`index`、`source`、`available`、`matched_text`、`audio_start`、`audio_end`である。文字列一致の採点だけではなく、比較再生範囲の境界が期待通りかを判定した。

本作業中、対象外の実装ファイルへ並行した未コミット変更が入った。そのため、独立評価直後と最終確認時の2スナップショットを分ける。どちらの実行前後でもfixtureのSHAは変わっていない。

| スナップショット | Python | Worker | 両実装の契約差分 |
|---|---:|---:|---:|
| 期待固定直後 | 167成功 / 33失敗 | 106成功 / 94失敗 | 94件 |
| 最終確認時の作業ツリー | 167成功 / 33失敗 | 167成功 / 33失敗 | 0件 |

最終確認時の実装SHA-256は次の通りである。

```text
Python: 22196ffc02bd8a75c9637dfc1b8799b2b9dde425f4c6213f6e633255463eca27
Worker: cccfa71041ba66cf8e3e4c1ab1f508c6bf22e24175713c0fcdef125e2b1a9a6c
```

最終値の言語別内訳:

| 実装 | 中国語 | 英語 | 合計 |
|---|---:|---:|---:|
| Python | 84成功 / 16失敗 | 83成功 / 17失敗 | 167成功 / 33失敗 |
| Worker | 84成功 / 16失敗 | 83成功 / 17失敗 | 167成功 / 33失敗 |

### 最終値のカテゴリ別失敗数

PythonとWorkerは最終確認時に同じ33件で失敗した。

| category | 失敗数 |
|---|---:|
| `interphrase_assignment` | 7 |
| `zero_duration` | 6 |
| `trailing_assignment` | 4 |
| `composite` | 4 |
| `structural_low_similarity` | 3 |
| `omission_and_order` | 3 |
| `leading_assignment` | 2 |
| `normal_regression` | 1 |
| `pause_timestamp` | 1 |
| `asr_variation` | 1 |
| `ambiguous_unavailable` | 1 |
| 合計 | 33 |

失敗ケース一覧:

- `ambiguous_unavailable`: `assignment_en_100_generic_then_without_closing_anchor`
- `asr_variation`: `assignment_en_090_api_id_and_codex_name_variants`
- `composite`: `assignment_zh_083_same_prefix_reorder_with_filler`、`assignment_zh_099_omit_then_return_out_of_order`、`assignment_en_083_same_suffix_reordered_with_filler`、`assignment_en_099_skipped_second_then_returns_after_third`
- `interphrase_assignment`: `assignment_zh_022_multiword_interphrase_thought_kept`、`assignment_zh_023_boundary_fillers_excluded`、`assignment_zh_026_next_phrase_early_false_start_kept`、`assignment_zh_028_asr_tail_error_attached_backward`、`assignment_en_023_multiple_boundary_fillers_excluded`、`assignment_zh_050_discrete_extra_sentence_between_targets`、`assignment_en_050_unrelated_middle_phone_message`
- `leading_assignment`: `assignment_zh_020_unrelated_intro_separated_and_excluded`、`assignment_en_020_unrelated_intro_separated_and_excluded`
- `normal_regression`: `assignment_en_054_long_five_phrase_technical_baseline`
- `omission_and_order`: `assignment_en_008_reordered_same_suffix_keeps_order_constraint`、`assignment_zh_044_reverse_phrase_order`、`assignment_en_044_reversed_two_phrase_order`
- `pause_timestamp`: `assignment_en_070_long_pause_during_name_recall`
- `structural_low_similarity`: `assignment_zh_005_low_similarity_middle_bounded_by_anchors`、`assignment_zh_037_shared_connector_only_low_confidence`、`assignment_zh_038_bounded_phrase_with_homophone_errors`
- `trailing_assignment`: `assignment_en_007_unrelated_trailing_comment_excluded`、`assignment_zh_034_trailing_new_topic_excluded`、`assignment_en_032_trailing_disfluency_excluded`、`assignment_en_034_trailing_phone_conversation_excluded`
- `zero_duration`: `assignment_zh_007_zero_duration_entire_short_phrase_unavailable`、`assignment_en_006_zero_duration_entire_short_phrase_unavailable`、`assignment_zh_059_only_exact_anchor_is_zero_duration`、`assignment_zh_063_all_tokens_of_short_phrase_zero_unavailable`、`assignment_en_063_entire_one_word_phrase_zero_unavailable`、`assignment_en_065_attempt_only_zero_duration_case`

### 失敗原因の一次分類

最終値では両実装が同じ結果なので、原因分類も共通である。

| 原因分類 | 件数 | 判断 |
|---|---:|---|
| phrase境界・順序制約の問題 | 14 | 前後どちらへextraを含めるか、戻り発話、逆順、同じprefix/suffixの所有範囲を誤る |
| unrelated speechを割り当てた | 10 | 長いpause後の別話題、独立した中間文、target完了後の会話を隣接phraseへ吸収する |
| zero-duration処理 | 6 | 文字列情報と安全な音声rangeの分離が期待と一致しない |
| 実在する発話を落とした | 1 | 両側anchorで位置が決まる低一致phraseをunavailableにする |
| 仕様が曖昧 | 2 | `Ms.`を句点として分割する略語問題と、closing anchorのないgeneric `then`の所有先 |
| fixtureの期待値が不適切 | 0 | 実装結果だけを理由に期待値を直した例はない |
| ASR timestampだけでは判定不能 | 0 | 保留が必要なケースはfixture側でunavailableまたはambiguousとして固定済み |
| 合計 | 33 |  |

`assignment_en_070_long_pause_during_name_recall`は、自然な略語`Ms.`をtarget phrase分割器が文末句点として扱い、期待2 phraseに対して3 phraseを返す。email、decimal、version番号にも波及する仕様問題であり、個別fixtureへ合わせて直すべきではない。`assignment_en_100_generic_then_without_closing_anchor`はtimestampだけで前後どちらのphraseに属するか一意に決めにくいため、公開仕様で保守的な扱いを決める必要がある。

### 指定観点の件数

- 明示的な未割当を持つケース: 31件、未割当token合計112個。
- 主な未割当理由: target順序衝突33 token、closing anchorのない別内容9 token、phrase根拠のない同一領域8 token、完全に無関係な発話6 token、長いpause後の別の話しかけ6 token。
- zero-durationを含むケース: 34件、zero-duration token合計39個。最終値の失敗は両実装とも6件。
- lowまたはmedium confidenceでも再生可能rangeを持つケース: 51件、該当rangeは64個。最終値の失敗は両実装とも8件。
- 発話全体が完全に無関係で全phraseをunavailableとしたケース: 3件。
- 全phraseがunavailableのケース: 10件。一部phraseだけunavailableのケース: 34件。
- fixture作成時点で曖昧として保留したケース: 2件。実行後に略語分割の仕様曖昧性が1件追加で判明した。
- API/UI層へ回すno-speech・空ASR・hallucination・片側/両側ASR失敗候補: `silence_non_speech` 7件相当。

### 実装間差分

最終確認時は、200件についてplayback rangeとdiagnosticsを含む契約を比較し、差分は0件だった。従って最終値として列挙する差分ケースはない。

ただし期待固定直後のWorkerでは94件がPythonと異なっていた。主な差分はzero-duration 27件、interphrase assignment 20件、leading assignment 18件、composite 13件、低一致7件、抜け・順序5件だった。比較フィールド別では`matched_text` 94件、`audio_start` 52件、`audio_end` 20件、`available`・`complete`・`source`が各5件だった。この変化はfixture修正ではなく、本作業対象外のWorker実装差分による。

期待固定直後に差分があった94件は次の通りである。

- `ambiguous_unavailable` 1件: `assignment_en_100_generic_then_without_closing_anchor`
- `asr_variation` 2件: `assignment_zh_090_alphanumeric_names_misrecognized`、`assignment_en_090_api_id_and_codex_name_variants`
- `composite` 13件: `assignment_zh_081_leading_delay_middle_omission_final_correction`、`assignment_zh_082_zero_duration_long_pause_and_homophone`、`assignment_zh_083_same_prefix_reorder_with_filler`、`assignment_zh_084_wrong_middle_content_followed_by_exact_final`、`assignment_zh_086_long_six_phrases_many_asr_errors`、`assignment_zh_097_no_pause_relevant_extra_between_phrases`、`assignment_zh_098_zero_duration_inside_self_correction`、`assignment_en_081_leading_aside_omission_and_final_correction`、`assignment_en_082_zero_duration_pause_and_near_sound_error`、`assignment_en_083_same_suffix_reordered_with_filler`、`assignment_en_084_different_middle_story_bounded_by_exact_phrases`、`assignment_en_097_relevant_no_pause_extra_attached_forward`、`assignment_en_098_zero_duration_correction_marker`
- `interphrase_assignment` 20件: `assignment_zh_003_interphrase_asr_error_attached_forward`、`assignment_en_003_interphrase_false_start_attached_forward`、`assignment_zh_021_single_interphrase_word_attached_forward`、`assignment_zh_022_multiword_interphrase_thought_kept`、`assignment_zh_023_boundary_fillers_excluded`、`assignment_zh_024_interphrase_hesitation_attached_forward`、`assignment_zh_026_next_phrase_early_false_start_kept`、`assignment_zh_027_boundary_self_correction_attached_forward`、`assignment_zh_028_asr_tail_error_attached_backward`、`assignment_zh_029_conjunction_attached_to_next_phrase`、`assignment_en_021_single_interphrase_word_attached_forward`、`assignment_en_022_multiword_checking_phrase_kept`、`assignment_en_023_multiple_boundary_fillers_excluded`、`assignment_en_024_word_search_attached_forward`、`assignment_en_026_next_phrase_false_start_kept`、`assignment_en_027_boundary_noun_correction_attached_forward`、`assignment_en_028_asr_tail_error_attached_backward`、`assignment_en_029_conjunction_attached_forward`、`assignment_zh_050_discrete_extra_sentence_between_targets`、`assignment_en_050_unrelated_middle_phone_message`
- `leading_assignment` 18件: `assignment_zh_001_leading_address_and_adjective_kept`、`assignment_en_001_leading_adjectives_kept`、`assignment_zh_011_leading_adverb_kept`、`assignment_zh_012_leading_person_call_kept`、`assignment_zh_013_leading_code_switch_kept`、`assignment_zh_014_similar_false_start_kept`、`assignment_zh_015_unrelated_false_start_with_marker_kept`、`assignment_zh_016_wrong_subject_then_correction_kept`、`assignment_zh_018_long_polite_preamble_kept`、`assignment_zh_020_unrelated_intro_separated_and_excluded`、`assignment_en_011_leading_attitude_adverb_kept`、`assignment_en_012_leading_professional_address_kept`、`assignment_en_013_leading_japanese_code_switch_kept`、`assignment_en_014_similar_time_false_start_kept`、`assignment_en_015_unrelated_false_start_with_marker_kept`、`assignment_en_016_wrong_subject_then_correction_kept`、`assignment_en_018_long_contextual_preamble_kept`、`assignment_en_020_unrelated_intro_separated_and_excluded`
- `normal_regression` 1件: `assignment_en_054_long_five_phrase_technical_baseline`
- `omission_and_order` 5件: `assignment_en_008_reordered_same_suffix_keeps_order_constraint`、`assignment_zh_045_return_to_previous_phrase`、`assignment_zh_046_whole_phrase_repeated`、`assignment_en_045_returns_to_first_detail`、`assignment_en_046_repeats_entire_warning`
- `structural_low_similarity` 7件: `assignment_zh_005_low_similarity_middle_bounded_by_anchors`、`assignment_en_004_low_similarity_middle_bounded_by_pauses`、`assignment_zh_035_wrong_opening_sentence_then_restart`、`assignment_zh_036_wrong_predicate_but_phrase_position_clear`、`assignment_zh_038_bounded_phrase_with_homophone_errors`、`assignment_en_035_long_wrong_instruction_then_restart`、`assignment_en_036_wrong_action_in_bounded_middle`
- `zero_duration` 27件: `assignment_zh_006_zero_duration_noun_retained_with_neighbors`、`assignment_zh_007_zero_duration_entire_short_phrase_unavailable`、`assignment_en_005_zero_duration_boundary_word_kept_forward`、`assignment_en_006_zero_duration_entire_short_phrase_unavailable`、`assignment_zh_056_zero_duration_first_token_safe`、`assignment_zh_057_zero_duration_middle_verb_safe`、`assignment_zh_058_zero_duration_final_token_safe`、`assignment_zh_060_zero_duration_important_noun`、`assignment_zh_061_zero_duration_at_phrase_boundary_backward`、`assignment_zh_062_two_consecutive_zero_tokens_inside_phrase`、`assignment_zh_063_all_tokens_of_short_phrase_zero_unavailable`、`assignment_zh_064_zero_chain_shares_one_boundary`、`assignment_zh_065_attempt_side_zero_with_reference_assumed_normal`、`assignment_zh_066_reference_side_zero_with_attempt_assumed_normal`、`assignment_zh_067_both_sides_can_have_zero_duration`、`assignment_en_056_zero_duration_initial_article_safe`、`assignment_en_057_zero_duration_internal_preposition_safe`、`assignment_en_058_zero_duration_final_word_safe`、`assignment_en_059_unique_matching_anchor_has_zero_duration`、`assignment_en_060_zero_duration_proper_name`、`assignment_en_061_zero_duration_second_phrase_prefix_forward`、`assignment_en_062_consecutive_zero_tokens_before_positive_suffix`、`assignment_en_063_entire_one_word_phrase_zero_unavailable`、`assignment_en_064_zero_tokens_share_boundary_with_positive_word`、`assignment_en_065_attempt_only_zero_duration_case`、`assignment_en_066_reference_only_zero_duration_case`、`assignment_en_067_both_audio_sides_zero_rule`

### 性能観測

これは同一マシンでの単発観測であり、厳密なbenchmarkではない。最終確認時の200件合計、中央値、p95、最大値は次の通りだった。

| 実装 | 合計 | 中央値/件 | p95/件 | 最大/件 |
|---|---:|---:|---:|---:|
| Python | 1,289.313 ms | 1.552 ms | 16.860 ms | 207.699 ms |
| Worker | 401.454 ms | 0.525 ms | 5.215 ms | 67.397 ms |

最も遅い成功ケースは、両実装とも`assignment_en_086_long_six_phrase_many_recognition_errors`と`assignment_en_091_exact_eight_phrase_performance_baseline`だった。短い通常ケースに比べて明確に重いため、候補探索数とphrase数に対する増加を継続計測する必要がある。

### 公開デモへ出せるか

現状は、比較再生の正確さを主要価値として前面に出す公開デモへは出せない。最終値は両実装とも167/200、83.5%であり、単なる低一致採点ではなく、学習者が聞き直したい言い間違いを落とす、無関係な会話を吸収する、phrase順序を誤る、zero-durationの扱いが不安定という製品上目立つ失敗が33件残る。両実装のparityは達成しているが、同じ誤りを返すことは正しさの証明ではない。

限定公開する場合でも、「比較区間は参考」「低confidenceまたはunavailableを明示」「全体再生へ勝手にfallbackしない」「再録音手段を常に残す」が必要である。

### 一般化できる改善候補

1. text similarity、構造的なphrase所有、音声rangeの再生可能性を別々の値として扱い、低一致でも位置が確定した発話を落とさない。
2. reliable range間の未割当tokenに対し、前方/後方所有、明示的edge filler、pause、自己訂正marker、話題独立性を使う共通ownership passを設ける。
3. zero-duration tokenは文字列とdiagnosticsへ残し、再生境界は正の長さを持つ安全な隣接tokenだけから作る。zero-durationだけのphraseはtext-onlyまたはunavailableにする。
4. 戻り発話、逆順、同じprefix/suffix、phrase再発話に対して、単調な時間順とtarget順序を混同しない明示的なorder/occupancy契約を設ける。
5. 長いpause後の別話題、別の話しかけ、独立した中間文を隣接phraseへ吸収しない。ただし個別語のblacklistではなく、pause、target完了、closing anchor、内容独立性の一般条件で判定する。
6. `Ms.`、email、decimal、version、英数字固有名詞を壊さないtarget phrase tokenizer仕様を先に固定する。
7. PythonとWorkerの共通fixtureとparityを保ちつつ、candidate生成、score cache、上限、phrase数別の計測を追加して長文性能を改善する。
8. API入口でno-speech、空ASR、timestampなしhallucination、片側ASR失敗を成功した採点から分離し、UIでは理由付きの再録音へ誘導する。

いずれも今回の個別ケース名や特定単語を条件にする修正ではなく、複数カテゴリへ適用できる成立条件として検証する必要がある。

## 検証結果

- `PYTHONPATH=src python3 scripts/evaluate_practice_alignment.py --summary-only tests/fixtures/practice_alignment_assignment_cases.json`: 167成功 / 33失敗。
- `node scripts/evaluate_practice_alignment.mjs --summary-only tests/fixtures/practice_alignment_assignment_cases.json`: 167成功 / 33失敗。
- assignment fixtureに対するPython/Worker契約比較: 200件中差分0件。
- `PYTHONPATH=src python3 -m pytest tests/test_practice_alignment.py -q`: 119 passed。
- `node --test tests/practice_alignment_worker.test.mjs`: 111 passed。
- `python3 -m pytest -q`: 859 passed。
- `npm test`: 208 passed、1 failed。失敗は対象外の進行中UI差分で、静的テストが期待する`全体比較再生`という表示文言が`src/mo_speech/web/app_practice.js`に存在しないもの。
- `npm run check:js`: 成功。
- `npm run check:web`: typecheck、production build、style boundary検査に成功。既存のlarge chunk warningあり。
- `git diff --check`: 成功。新規2ファイルも`git diff --no-index --check`相当でwhitespace errorなし。
- JSONの最終SHA-256は固定時と同じ`7b0b6ba1c7657c9389511c486af8aa1cd46a3537fa4b17f1f127997f2624f9cf`。

アラインメント実装、API、UI、既存fixture、第1弾fixtureは変更していない。commit、push、PR、deployも行っていない。
