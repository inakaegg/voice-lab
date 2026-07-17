# SpeakLoop フレーズ比較再生 Canonical SPEC 統合版

更新日: 2026-07-17

> **Status: Adopted canonical contract — single source of truth**
> 本文書は、独立に作成した2つのcanonical SPEC案、policy profiles、評価・移行計画、未決定事項を統合し、固定fixture、Python、Cloudflare Worker、API、UIへ適用した正の契約である。本文書内では、`fixed`を実装方式に依存しない規範、`baseline`を評価時の既定候補、`challenger`を比較候補として扱う。

関連文書:

- [現行SPEC](SPEC.md)
- [学習ロードマップ](LEARNING_ROADMAP.md)

旧canonical案、旧policy案、旧評価計画、旧未決定事項一覧は本文書に統合済みであり、規範として参照しない。

## 1. 位置付け

本文書を、実装、回帰テスト、次の評価で使用する唯一のcanonical contractとする。実装ごとに異なるcanonical SPECや期待値を作らない。統合時に未決定だった事項も別文書へ分散させず、本文書の「決定事項register」で状態と完了条件を管理する。

本文書は次を固定する。

- target phraseとASR文字・timestampの所有関係
- phrase音声を比較再生できるかを表す`available`
- 発音対象の文字内容一致を表す`content_matched`
- text-only、未割当、無音、provider応答矛盾の扱い
- Python版とCloudflare Worker版が共有するcanonical schema
- UIが比較再生modeを決める契約
- fixtureの役割、評価段階、採用条件、停止条件

次は本文書では固定しない。

- `SequenceMatcher`、LCS、Levenshtein等の文字列比較方式
- DP、anchor partition、forced alignment等の探索方式
- 候補生成、score cache、枝刈り等の内部最適化
- pause、similarity、coverageの具体的な数値閾値
- `content_similarity`の計算式、閾値、丸め
- 性能最適化の具体的な実装

方式の採用理由、実装比較、個別fixtureの結果、処理時間は、canonical SPEC本文ではなく評価記録または設計判断へ残す。
ただし、採用実装を再現するための数値は[18.7](#187-採用実装の数値パラメータ)へ記録し、境界fixtureと両runtime parityで変更を検出する。数値だけをcanonicalなownership根拠にはしない。

## 2. 用語

### 2.1 target phrase

target textをcanonical target phrase splitterで分割した、比較再生の最小slot。phrase順と`source_index`はtarget側を正とする。

### 2.2 transcription

ASR providerが正式な認識本文として返した文字列。timestamp payload内部のwordまたはsegment textとは区別する。

### 2.3 ASR token

`asr_timestamps.words[]`の1要素。英語のwordだけでなく、中国語の文字または複数文字単位を含み得る。

### 2.4 assignment

ASR token、segment、または単一phrase時の正式transcriptionが、どのtarget phraseの試行として発話されたかという所有関係。内容一致、再生可能性とは別概念である。

### 2.5 playable / `available`

実在する正の長さのtimestamp rangeを使って、そのphraseに対応する音声を安全に比較再生できること。

### 2.6 `content_matched`

採用content policyによる正規化後に、発音対象の文字内容がtarget phraseと一致していること。意味類似、位置の信頼度、音響上の発音品質を表さない。

### 2.7 text-only

target phraseへの文字上の所有位置は一意だが、安全な正時間rangeを作れない状態。文字情報と所有関係は保持するが、比較再生には使用しない。

### 2.8 alignment confidence

文字または音声区間が該当target phraseの試行であるという、位置・所有判断の信頼度。内容の正しさとは別である。

### 2.9 boundary source

phraseの所有位置または再生rangeの境界を決めた根拠。confidence値とは分離する。

## 3. 入力と責任境界

alignment coreは概念上、次を受け取る。

- `target_text`
- `target_language`
- `transcription`: 正式な認識本文
- `asr_timestamps.available`
- `asr_timestamps.words[]`
- `asr_timestamps.segments[]`
- 入力が学習者attemptかreference音声かを表すrole

target phrase splitterはalignment coreの前段に置く。alignment coreはsplitterが返した順序付きtarget phraseを変更しない。

ASR側の句読点、word、segmentは実音声位置の補助証拠として使用できるが、target phrase一覧を作り直さない。

次はattemptの`no_speech`ではなく、alignment開始前のvalidation errorとする。

- target textが空、または正規化後に句読点・空白しかない
- splitter結果が0 phrase
- target languageが未対応または不明

APIは入力validation error、attempt provider error、reference provider error、正常な`no_speech`を区別する。HTTP status、非同期job status、公開error body等の外部契約は[GAP-P0-02](#gap-p0-02-provider-errorのapijob契約)で決定する。

## 4. target phrase splitter

target phrase splitterはalignment方式から分離したcanonical部品とする。

- hard boundaryは`。`、`！`、`？`、`.`、`!`、`?`、`；`、`;`、改行とする。boundary記号は直前phraseの`target_text`へ保持する。
- `、`、`，`、`,`、`：`、`:`は既定ではphrase境界にしない。
- email address、URL内部のperiodをphrase境界にしない。
- 小数、version番号の内部periodをphrase境界にしない。
- `Ms.`、`Mr.`、`Mrs.`、`Dr.`、`Prof.`、`Sr.`、`Jr.`、`St.`等、後ろに同じ文の語が続く略語終端をphrase境界にしない。
- protected patternの後に本当の文末記号が続く場合は、文末として分割する。
- `...`と`…`は単独ではhard boundaryにせず、後続のhard boundaryがある場合だけそのphraseへ保持する。
- 連続するhard boundary、閉じ引用符、閉じ括弧、直後のemojiは、次の有意文字が現れるまで直前phraseへ保持する。
- 空白またはboundary記号だけの断片はphraseを作らず、`source_index`は空断片を除いたsplitter出力順の0始まりindexとする。
- ASR transcriptionの句読点はtarget phraseの正にしない。

splitterは専用fixtureで検証する。splitter不一致によってtarget phrase数が変わったケースをalignment方式の品質スコアへ混ぜない。

## 5. timestampの妥当性

wordまたはsegmentのtimestamp unitは、少なくとも次を満たす場合だけalignment入力候補にできる。

- `asr_timestamps.available=true`
- `start`と`end`が数値かつ有限値
- `start >= 0`
- `end >= start`
- 音声実長が既知なら`end`が実長を越えない

`start == end`は有効なtext-only候補であり、入力から削除しない。ただし、正時間の再生rangeを単独では作れない。

`available=true`のphrase rangeは、さらに次を満たす。

- `audio_start`と`audio_end`が実timestamp由来
- `audio_end > audio_start`
- 所有するwordまたはsegmentの実時間を越えない
- 他phraseのrangeと重複せず、target順と時刻順が一致する

文字数比、録音全長比、固定padding、隣接phraseの時刻を借りてrangeを作ってはならない。

入力順が時刻順でない、tokenが重複・交差する、wordsとsegmentsが矛盾する等の異常を黙って並べ替え、clamp、結合してはならない。異常入力は次の順で扱う。

1. unitの`start`または`end`が非数値、非有限、負値、`end < start`、または既知の音声実長を越える場合、そのunitだけを除外し、source、index、reasonをdiagnosticsへ残す。
2. 除外後の同一source内に非単調な順序、同一unitの重複、正時間range同士の交差が残る場合、原則としてそのsource全体をownershipと再生時刻へ使用しない。並べ替え、重複除去、境界短縮で救済しない。ただしwordsでは、直前の正時間tokenの`end`と同一点に1個以上のzero-duration tokenが続き、その次の正時間tokenが直前の正時間range内から始まって同rangeの`end`より後まで続く形だけを`zero_duration_overlap_bridge`として扱う。この形ではprovider順とraw時刻を変えず、文字tokenを保持してwordsを使用できる。固定秒数やprovider名による許容幅は設けない。
3. wordsが安全に使用できる場合はwordsをownershipの第一sourceとする。両sourceに正時間unitがあり、source全体の時間範囲が重ならない場合は明白な`word_segment_boundary_conflict`とし、segmentsをboundary evidenceにも使用せずflagを残す。wordsとsegmentsを同じ発話として二重計上しない。範囲が重なるsource間の細かな境界差は、未定義の許容幅で矛盾扱いしない。
4. wordsが使用不能でもsegmentsが安全であれば、採用済みsegment-only policyの範囲でsegmentsを使用できる。segment数とphrase数の一致だけでは割り当てない。
5. 使用できるtimestamp sourceがなく、正式transcriptionが非空なら、[6.4](#64-availablefalseとの矛盾)と同じ制限付きevaluated resultを返す。
6. 使用できるtimestamp sourceがなく、正式transcriptionも空だがraw timestamp dataが存在する場合は、`practice_alignment_provider_contract_error`とする。

`zero_duration_overlap_bridge`を受理しても、phraseの再生rangeは所有span内の正時間tokenだけから作る。結果として別phraseのrangeと交差する場合、交差するphraseを`text_only`へ下げて`overlapping_phrase_ranges`をflagへ残し、境界をclampして再生可能にしない。segment sourceにはこの例外を適用しない。

unit除外reasonは少なくとも`non_numeric`、`non_finite`、`negative_start`、`end_before_start`、`beyond_audio_duration`を区別する。primitive不正を1件以上除外したsourceは`invalid_timestamp_unit`をflagへ残す。source全体のflagは少なくとも`non_monotonic_timestamp_source`、`duplicate_timestamp_unit`、`overlapping_timestamp_units`、`word_segment_boundary_conflict`を区別し、限定受理と最終range拒否は`zero_duration_overlap_bridge`と`overlapping_phrase_ranges`で区別する。浮動小数の比較許容差は[GAP-P2-03](#gap-p2-03-時刻比較の許容誤差)で別に固定し、許容差を補正値としてcanonical rangeへ書き込まない。

## 6. 入力状態

### 6.1 evaluated attempt

正式transcriptionまたは有効なword/segmentに発話内容があり、処理を中止すべきprovider errorがない学習者attemptは`outcome=evaluated`とする。正式transcriptionが非空なら、使用不能なtimestamp payloadが内包dataを持つ矛盾をdiagnosticへ残した上で、制限付きのevaluated resultを返せる。

### 6.2 no-speech attempt

次がすべて空で、provider応答が矛盾していない学習者attemptは`outcome=no_speech`とする。

- 正規化後の正式transcription
- 有効なwords
- 有効なsegments

no-speechではscore、grade、diff、学習者音声との比較再生を生成しない。空発話を0点の通常attemptとして保存・表示せず、UIは再録音を案内する。

### 6.3 reference側の空ASR

reference音声の正式transcription、有効なwords、segmentsがすべて空の場合は、学習者attemptのno-speechとして扱わない。お手本生成、音声読込、ASRまたはprovider errorとして比較処理を失敗させる。

### 6.4 `available=false`との矛盾

`asr_timestamps.available=false`は、timestamp payloadをalignmentへ使用できるかについて正とする。内包するwordsまたはsegmentsはraw diagnosticsとして保存できるが、次へ使用しない。

- `matched_text`
- content normalization、similarity、`content_matched`
- phraseへのtoken/segment割当
- `audio_start`、`audio_end`
- `available`判定

正式transcriptionが空で、`available=false`なのにraw wordsまたはsegmentsだけが存在する場合はno-speechではない。blockingな`contradictory_timestamp_payload` provider errorとしてjob/APIを失敗させる。

正式transcriptionが非空で`available=false`の場合、raw words/segmentsは使用しない。内包dataが存在すれば`contradictory_timestamp_payload`をnon-blocking diagnostic flagとして記録し、phrase別の扱いは次とする。

- target phraseが1つだけなら、正式transcription全体をその一回の試行として`text_only`へ割り当て、内容評価できる。
- target phraseが複数で、正式transcriptionにcanonicalなphrase span情報がない場合は、transcriptionを推測分割しない。各phraseは`unassigned`、`content_matched=null`とする。
- 将来、正式transcription上のspanをphraseへ割り当てる場合は、word timestamp indexと混同しない別schemaを先にcanonical化する。

### 6.5 validation errorとprovider error

alignment成功resultの`outcome`は`evaluated`または`no_speech`だけとする。入力不正とprovider契約違反を第3のoutcomeへ追加しない。

canonical error envelopeは次とする。

```json
{
  "error": {
    "code": "practice_alignment_provider_contract_error",
    "reason": "contradictory_timestamp_payload",
    "stage": "attempt_asr",
    "retryable": true,
    "message": "音声の解析結果を確認できませんでした。もう一度お試しください。",
    "diagnostic_flags": ["contradictory_timestamp_payload"]
  }
}
```

| 種別 | HTTP / job | `code` | `retryable` |
| --- | --- | --- | --- |
| 空target、0 phrase、未対応言語等 | 同期・job作成前にHTTP 400 | `practice_alignment_invalid_input` | `false` |
| attempt/reference ASRのprovider契約違反 | 同期APIはHTTP 502 | `practice_alignment_provider_contract_error` | `true` |
| 非同期job内のprovider契約違反 | polling responseはHTTP 200、job `status=failed` | `practice_alignment_provider_contract_error` | `true` |
| 正常な無音attempt | HTTP 200、job `status=succeeded`、result `outcome=no_speech` | errorなし | 該当なし |

`reason`は少なくとも次を区別する。

- `contradictory_timestamp_payload`: `available=false`なのに正式transcriptionが空でraw words/segmentsだけ存在する
- `invalid_timestamp_payload`: 正式transcriptionが空で、raw timestamp dataがすべて使用不能
- `empty_reference_asr`: reference側の正式transcriptionと安全なtimestamp dataがすべて空
- `alignment_input_too_large`: phrase数、timestamp unit数、または両者の積が公開上限を超える

`stage`は`attempt_asr`または`reference_asr`とする。利用者向け`message`はprovider名や内部構造を断定せず、開発者向けの`code`、`reason`、`diagnostic_flags`と分離する。

public API、永続化history、Cloudflare Worker logへraw provider payloadを含めない。件数、reason、flagだけを残す。ローカル開発用のraw保存は明示的に有効化した診断時だけ、既存の保存・privacy方針に従って行い、既定では保存しない。

## 7. canonical result schema

### 7.1 top-level result

```json
{
  "alignment_contract_version": 1,
  "outcome": "evaluated",
  "target_language": "en-US",
  "available": true,
  "target_phrase_count": 2,
  "playable_phrase_count": 1,
  "all_phrases_playable": false,
  "unassigned_non_filler_count": 1,
  "complete": false,
  "phrases": [],
  "diagnostics": {}
}
```

| field | 型 | 意味 |
| --- | --- | --- |
| `alignment_contract_version` | integer | provider契約と分離したalignment schema version。初版は`1` |
| `outcome` | `evaluated \| no_speech` | 学習者attemptの結果種別 |
| `target_language` | string | normalizationとsplitterに使用したtarget language |
| `available` | boolean | `playable_phrase_count > 0`のderived互換field |
| `target_phrase_count` | integer | splitterが返したtarget phrase数 |
| `playable_phrase_count` | integer | phraseの`available=true`件数 |
| `all_phrases_playable` | boolean | target phraseが1件以上あり、すべてplayableか |
| `unassigned_non_filler_count` | integer | boundary filler以外の未割当token数 |
| `complete` | boolean | 既存互換のderived field |
| `phrases` | array | target phrase順のphrase alignment result |
| `diagnostics` | object | 未割当、zero-duration、入力矛盾、判定根拠 |

derived fieldは次で計算する。

```text
available = playable_phrase_count > 0
all_phrases_playable = target_phrase_count > 0
  && playable_phrase_count == target_phrase_count
complete = all_phrases_playable
  && unassigned_non_filler_count == 0
```

provider errorは成功resultの`outcome`へ追加せず、job/API errorとして扱う。

`outcome=no_speech`では`phrases=[]`、`available=false`、`playable_phrase_count=0`、`unassigned_non_filler_count=0`、`all_phrases_playable=false`、`complete=false`とする。`target_phrase_count`は保持する。

### 7.2 phrase result

```json
{
  "index": 0,
  "source_index": 0,
  "target_text": "Open the API console.",
  "assignment_status": "assigned",
  "available": true,
  "matched_text": "Open the A P I console",
  "content_matched": true,
  "alignment_confidence": "high",
  "boundary_sources": ["text_anchor", "utterance_edge"],
  "text_source": "words",
  "timestamp_source": "words",
  "word_start_index": 0,
  "word_end_index": 5,
  "audio_start": 0.12,
  "audio_end": 1.36
}
```

| field | 型 | 意味 |
| --- | --- | --- |
| `index` | integer | alignment対象phraseの0始まりindex |
| `source_index` | integer | splitter出力上の元index |
| `target_text` | string | target phrase原文 |
| `assignment_status` | `assigned \| text_only \| unassigned` | 文字・音声の所有状態 |
| `available` | boolean | 正時間rangeを比較再生できるか |
| `matched_text` | string | 所有する元文字列。text-onlyでも保持する |
| `content_matched` | `boolean \| null` | 内容一致。未評価は`null` |
| `alignment_confidence` | `high \| medium \| low \| null` | 所有位置判断の信頼度 |
| `boundary_sources` | array | 所有・境界判断のcanonical根拠 |
| `text_source` | `words \| segments \| transcription \| none` | `matched_text`の出所 |
| `timestamp_source` | `words \| segments \| none` | 再生rangeを作ったtimestampの出所 |
| `word_start_index` | integerまたはnull | 所有する先頭word index。含む |
| `word_end_index` | integerまたはnull | 所有する末尾の次のword index。含まない |
| `audio_start` | numberまたはnull | 実timestamp由来の開始秒 |
| `audio_end` | numberまたはnull | 実timestamp由来の終了秒 |

状態間の制約:

| `assignment_status` | `available` | text | time | `content_matched` |
| --- | --- | --- | --- | --- |
| `assigned` | `true` | `matched_text`必須 | `audio_end > audio_start` | `true`または`false` |
| `text_only` | `false` | `matched_text`必須 | 両方`null` | `true`または`false` |
| `unassigned` | `false` | `matched_text=""` | 両方`null` | `null` |

`available=false`では`audio_start=null`、`audio_end=null`とする。内容不一致と未評価を区別するため、unassignedを`content_matched=false`にしない。

`normalized_target`、`normalized_recognized`、`content_similarity`、coverage等は評価・診断に追加できるが、方式採用前の必須canonical fieldにしない。

### 7.3 textとtimestampのsource

`text_source`と`timestamp_source`を分離する。

- word timestampから文字と正時間rangeを得た場合: `words` / `words`
- segmentから文字と正時間rangeを得た場合: `segments` / `segments`
- zero-duration wordだけを所有する場合: `words` / `none`
- 単一phraseへ正式transcriptionだけを所有させる場合: `transcription` / `none`
- unassignedの場合: `none` / `none`

`text_source`または`timestamp_source`を、`boundary_sources`やconfidenceの代用にしない。

### 7.4 word index

`word_start_index`は含み、`word_end_index`は含まない半開区間`[word_start_index, word_end_index)`とする。

- wordを所有するassigned/text-onlyで設定する。
- segment-only、transcription-only、unassignedでは両方`null`とする。
- 同じword indexを複数phraseへ割り当てない。

## 8. confidenceとboundary sources

### 8.1 alignment confidence

| 値 | 意味 |
| --- | --- |
| `high` | 強い文字根拠と矛盾しない境界により所有位置が明確 |
| `medium` | 複数の独立根拠で位置が一意だが強い全文字anchorではない |
| `low` | 構造上は一意だが文字または境界根拠が弱い |
| `null` | phraseの所有位置を決めていない |

`anchor`、`structural`、`none`をconfidence値にしない。text-onlyでも所有位置が一意ならconfidenceを保持できる。

### 8.2 boundary sources

canonical値と出力順は次とする。

1. `text_anchor`
2. `neighbor_anchors`
3. `pause`
4. `asr_segment`
5. `single_phrase`
6. `utterance_edge`

複数根拠を使用した場合はすべて記録する。ただし、同じ音響的な切れ目を表すpauseとASR segmentを、ownership判断上の独立した2根拠として二重計上しない。

## 9. phrase所有の不変条件

実装方式と評価中のpolicyにかかわらず、次を守る。

1. phrase rangeをtarget phrase順に並べる。
2. 1つのword、zero-duration word、segmentを複数phraseへ所有させない。
3. assigned phraseのword indexとaudio rangeを重ねず、単調増加させる。
4. `available=true`なら`audio_end > audio_start`とする。
5. `available=false`なら`audio_start`と`audio_end`を`null`にする。
6. zero-duration tokenを文字列、所有関係、diagnosticsから削除しない。
7. 実在しないtimestampを推定・捏造しない。
8. target phraseへ強く一致するtokenを別phraseのgap埋めに使わない。
9. 完全に無関係で構造根拠のない発話を、空きslotだけで割り当てない。
10. 後続targetへ進んだ後の戻り発話を、時間を逆行させて先行rangeへ追加しない。
11. false positiveを隠すために未割当tokenを削除しない。
12. `complete=true`で説明不能な非フィラー未割当tokenを残さない。
13. 所有済みphraseの間に未割当target slotがある場合、その間のtokenを左右phraseへgapとして配らない。一意な別根拠がないtokenは未割当のまま残す。

## 10. assignment contract

### 10.1 ownership evidence groups

片側anchorや低一致発話の根拠は、次の独立したgroupへ分類する。

#### 10.1.1 textual evidence

- target phraseの実質部分との非自明な文字一致
- target固有の語、文字列、英数字identifier
- target phraseの明確なprefixまたはsuffixの試行
- 同じphrase内のfalse start、自己訂正、完全な言い直しとの関係

generic connector、機能語、複数targetに共通する短い文字列だけを強い文字根拠にしない。

#### 10.1.2 boundary evidence

- 独立したASR segment境界
- phrase境界として説明できる明確なword間pause
- target句読点と矛盾しないASR句読点補助情報

pauseの存在だけで所有先を決めない。同じ音響的な切れ目を表すpauseとASR segmentは、独立した2根拠として数えない。

#### 10.1.3 neighboring-anchor evidence

- 前後の高信頼anchor
- 片側の高信頼anchorと、そのrangeが所有するtoken端
- anchor間に残る一意な連続token span

前後anchorに挟まれていても、複数の未発話slotまたは複数partitionが成立する場合は、一意な根拠としない。

#### 10.1.4 sequence/slot evidence

- target phrase順と発話時間順が矛盾しない
- 他target phraseへより強く一致しない
- 一意な未使用slotがある
- utterance edgeに接する
- 既存rangeを重複・逆行させない

target順、空きslot、utterance edgeは同じ構造系groupとして扱う。複数項目を満たしても、複数の独立groupとして数えない。

### 10.2 単一phrase

target phraseが1つだけの場合、明確な録音端フィラーを除いた正時間の発話全体を、その一回の試行として扱う。

- 内容が大きく異なっても`available=true`にできる。
- 内容差は`content_matched=false`で表す。
- zero-duration tokenしか残らない場合はtext-onlyとする。
- 明確なフィラーしか残らない場合はunassignedとする。
- 矛盾payloadやno-speechからrangeを作らない。

### 10.3 前後anchor

前後の高信頼anchorに挟まれ、1つの未発話slotと1つの連続spanへ一意に対応する発話は、文字内容が異なっても中央phraseの試行として割り当てられる。

間に複数slotまたは複数partitionが成立する場合、他targetへ強く一致する場合、独立した別話題と判断できる場合は強制割当しない。

### 10.3.1 制約付きpause partition

低一致の言い間違いでもphraseごとの比較再生を維持するため、word間pauseは次をすべて満たす場合だけ複数phraseの境界補助に使える。

- 正時間のword列が、target phrase数と同数の連続chunkへ一意に分かれる。
- 各chunkの端がboundary fillerではない。
- 各chunkが対応先以外のtarget phraseへより強く一致しない。
- target順、word index、時刻順が一致する。
- 全chunkを合わせてtargetとの非自明な文字関係がある。
- 既存の一意な完全一致anchorを上書きしない。

pause、phrase数、空きslotだけでは割り当てない。上記条件で採用した場合もconfidenceは`low`とし、`boundary_sources`へ`pause`を残す。productionの数値境界はcanonical定義ではなく[18.7](#187-採用実装の数値パラメータ)の評価済み実装値とする。

### 10.4 片側anchorの採用policy

productionのownership policyは`ownership.conservative`とする。再生不能なphraseがあっても、UIは共通playable phraseを使って`partial_phrase`を維持できるため、false positiveを増やす回収を優先しない。

片側anchorに隣接する低一致発話は、次をすべて満たす場合だけ割り当て候補にする。

- 片側に高信頼anchorがある。
- neighboring-anchor以外の異なるevidence groupから2群以上の根拠がある。
- 2群のうち少なくとも1群はboundary evidenceである。
- target順、word index、時刻に矛盾しない。
- 他target phraseへより強く一致しない。
- 競合する別の割当説明がない。
- 共通の拒否条件に該当しない。

文字根拠と一意なslotだけでは`conservative`の条件を満たさない。明確なpauseまたは独立したASR segment境界が必要である。

次だけでは割り当てない。

- `then`、`然后`等のgeneric connector
- 録音の文頭・文末にあること
- pauseがあること
- target側に空きslotがあること
- 順序と空きslotの組み合わせ
- 全target phrase割当後の追加発話

segment数とtarget phrase数が一致するという事実だけを、固定coreまたは`conservative`の自動割当条件にしない。数値化されていない「strong」「明確」等の根拠だけで自動回収せず、決定的なfixtureと両runtime parityを持たない片側低一致spanは`ambiguous_assignment`として未割当にする。

### 10.5 不採用の`ownership.balanced`候補

`ownership.balanced`は、片側anchorに加え、強い文字根拠または明確な境界根拠のどちらか1つと、順序guardによって位置が一意な発話を追加回収する候補とする。

次はbalancedでも割り当てない。

- 順序と空きslotだけ
- generic connectorとutterance edgeだけ
- 全target phrase割当後の無関係発話
- 複数targetへ同程度に対応するspan
- 完全に無関係で境界以外の根拠がない発話

独立判定済みのunrelated speechでfalse positiveを生じ、partial phrase UXで未回収phraseを安全にskipできるため、balancedはproductionへ採用しない。将来再評価する場合も別の隠れた実行時switchとして残さず、独立fixture、仕様改訂、contract version更新を先に行う。

### 10.6 抜け、逆順、戻り発話

- 発話されていないphraseへtimestampを作らない。
- target順と逆の発話を、全phraseが揃うように並べ替えない。
- 戻り発話を時間順に反して先行rangeへ結合しない。
- 戻り発話は`out_of_order_speech`として未割当にするか、直前phraseの自己訂正である明確な根拠がある場合だけ直前rangeへ含める。

### 10.7 target完了後の追加発話

全target phraseが割当済みの後に続く発話は、録音末尾にあるだけでは最後のphraseへ含めない。

最後のphraseの自己訂正、言い直し、直前内容の継続である明確な根拠がある場合だけ同じrangeへ含める。長いpause後の新しい話題、別の相手への発話、無関係な会話は`unrelated_speech`として未割当にする。

### 10.8 segment-onlyの固定baseline

安全なwordsを使用できずsegmentsだけがある場合、`ownership.conservative`は次をすべて満たすsegmentだけを割り当てる。

- [5](#5-timestampの妥当性)のsource妥当性を満たす。
- segment textが常時正規化後に1つのtarget phraseと文字内容一致する。
- target順とsegment時刻順が一致する。
- 同じsegmentまたは同じtarget phraseを複数割当に使用しない。
- 逆順anchor、重複anchor、複数の同等な単調割当が競合しない。

segment数とtarget phrase数の一致は十分条件でも独立根拠でもない。無関係なsegment、順序が逆のsegment、既に割当済みtargetの重複segmentを、空きslotだけで割り当てない。強いanchor同士が順序矛盾する場合、都合のよい一部だけを選んで完全に見せず、競合segmentを未割当にする。

正時間のsegmentは`assignment_status=assigned`、`text_source=segments`、`timestamp_source=segments`とする。正規化後に一意に対応するが`start == end`のsegmentは`text_only`とし、再生rangeを作らない。segment-onlyではword indexを`null`とする。

部分一致、ASR等価表記、低一致だが実際の試行であるsegmentの追加回収は、固定baselineへ含めない。人手ラベル付きfixtureでfalse positiveが増えないと確認できた場合だけchallengerとして評価する。

## 11. filler、どもり、言い直し

- 文頭、文末、phrase境界の明確なフィラーは再生rangeから除外できる。
- 除外したフィラーもdiagnosticsから削除しない。
- target phrase自体に含まれる語を、表面的にフィラー語と同じという理由で削除しない。
- phrase内部の言い淀み、どもり、反復、false start、自己訂正、完全な言い直しは、所有phraseが一意なら同じrangeへ含める。
- 単なる反復を境界フィラー扱いしない。
- generic connectorを単独のownership根拠にしない。

言語別フィラーは無制限な単語blacklistではなく、位置と周辺構造を含む一般条件で管理する。

## 12. zero-duration token

`start == end`のtokenを文字列alignment、所有関係、diagnosticsから削除しない。

正時間tokenと同じphraseへ一意に属する場合:

- `matched_text`へ含める。
- word index範囲へ含める。
- `zero_duration_tokens`へowner phrase indexとともに記録する。
- `audio_start`と`audio_end`は同じ所有範囲の正時間tokenだけから決める。

phraseがzero-duration tokenだけの場合:

- `assignment_status=text_only`
- `available=false`
- `matched_text`へ所有文字列を保持
- `text_source=words`
- `timestamp_source=none`
- `audio_start=null`、`audio_end=null`
- 所有位置が一意ならconfidenceとboundary sourcesを保持

前後phraseの時刻を借りず、同じzero-duration tokenを複数phraseへ割り当てない。

zero-duration tokenの`start`または`end`を正時間rangeの端として採用しない。所有span内に正時間tokenがある場合も、`audio_start`は正時間tokenの最小`start`、`audio_end`は正時間tokenの最大`end`とする。

## 13. content contract

### 13.1 意味

`content_matched`は意味類似ではなく、発音対象の文字内容一致を表す。

常に行う正規化:

- Unicode互換表現と全角・半角
- 英字の大文字・小文字
- 発音対象でない句読点、記号、空白
- 中国語の簡体字・繁体字の字形差

簡体字・繁体字は字形変換に限定し、地域語彙を別語彙へ置換しない。

一致扱いしないもの:

- paraphrase
- 類義語
- 中国語の同音字・近音字
- 声調差により別漢字として認識されたもの
- 核心語、数量、否定、固有名詞を変える置換

これらがあっても所有位置と再生rangeが一意なら、`available=true`、`content_matched=false`にできる。

### 13.2 採用content policy

productionは`content.canonical_normalized`を採用する。`content_matched`は、[13.1](#131-意味)の常時正規化後にtargetと所有文字列が完全一致する場合だけ`true`とする。編集距離、類似度、coverage、ASR confidenceの閾値で`true`へ繰り上げない。

中国語では表示文字列と発話比較用文字列を分離し、targetと認識文字列の両方へ同じspoken-form正規化を適用する。一般整数は通常の中国語数詞、4桁の年は1桁ずつ、小数は`点`と各桁、割合は`百分之`、`℃`／`°C`は同じ数値の`度`、24時間表記は`点`、`v`付きversionと英字数字を連結したcompact identifierは数字を1桁ずつ読む形を同じ内容として扱う。表示用target、ASR本文、raw tokenは書き換えない。

この等価化は数値と文脈を保持する。温度の数値変更、割合から単位を落とすこと、小数点を落とすこと、一般数量を1桁ずつ読んだ別表現、paraphrase、否定や核心語の変更は一致扱いしない。個別の数値や語を登録する方式へ広げない。

明確なcompact identifier文脈に限り、英字部分と数字部分を分離した次の表記を同じ文字内容として扱う。

```text
A17
A seventeen
A one seven
```

identifier文脈はtarget側を正とし、target tokenが英字1文字以上と数字1桁以上を空白なしで連結したcompact identifierである場合、または同じtarget phraseが`ID`、`request ID`、`code`、`model`等で直後の英数字を明示する場合に限定する。認識文字列側だけの見た目からidentifierへ昇格しない。

英字は文字名を空白区切りで認識した表記、数字は通常の英語数詞または1桁ずつの読みを候補にできる。候補生成はtarget identifier部分だけへ閉じ、phraseの他の文字列は完全一致を要求する。

一般数値、数量としての`A 17`、日付、時刻、電話番号、version、小数、target側にないidentifier候補へdigit-by-digit等価化を広げない。paraphrase、同音語、数量変更、否定、固有名詞、核心語置換も候補へ追加しない。

### 13.3 診断用similarity

`content_similarity`は採点、差分表示、評価用diagnosticであり、`content_matched`の真偽やplayback availabilityを決めない。計算方式と閾値はcanonical parity対象外とし、変更時は採点用fixtureで別に評価する。

方式選定中は次を守る。

- 同じownership spanを各content候補へ入力する。
- playback availabilityをcontent thresholdで変更しない。
- 実装出力のsimilarity値をfixture期待値へコピーしない。
- 個別case名や個別語blacklistで期待値へ合わせない。
- `content_similarity`を実装横断順位やcanonical parity必須fieldにしない。

## 14. diagnostics

canonical diagnosticsは少なくとも次を持つ。

```json
{
  "valid_word_count": 0,
  "valid_segment_count": 0,
  "assigned_word_count": 0,
  "assigned_segment_count": 0,
  "playable_word_count": 0,
  "unassigned_non_filler_count": 0,
  "unassigned_tokens": [],
  "zero_duration_tokens": [],
  "invalid_timestamp_units": [],
  "diagnostic_flags": [],
  "raw_timestamp_word_count": 0,
  "raw_timestamp_segment_count": 0
}
```

`unassigned_tokens`の要素schemaは次とする。

```json
{
  "source": "words",
  "source_index": 4,
  "text": "well",
  "start": 1.42,
  "end": 1.71,
  "reason": "boundary_filler"
}
```

`source`は`words | segments`、`source_index`はprovider配列上の0始まりindex、`text`はprovider文字列、`start`と`end`は有限の実timestampまたは`null`とする。要素順は`words`を先、`segments`を後とし、各source内で`source_index`昇順にする。

`zero_duration_tokens`の要素schemaは、同じ`source`、`source_index`、`text`、`start`、`end`に加えて`owner_phrase_index`を必須とする。所有先がないzero-duration unitはここへ入れず、`unassigned_tokens`へ`reason=no_positive_duration`として入れる。

`invalid_timestamp_units`の要素は`source`、provider配列上の`source_index`、`text`、有限なら`start`／`end`、unitまたはsourceを除外した`reason`を持つ。primitive不正unitだけを除外できる場合はそのunitだけを記録する。非単調、重複、交差、明白なword/segment矛盾でsource全体を使用不能にした場合は、そのsourceの妥当なprimitive unitもsource-level reason付きで記録する。他に安全なownership sourceがある場合や、単一phraseを正式transcriptionへtext-only所有できる場合は`unassigned_non_filler_count`へ加算せず二重計上しない。複数phraseで唯一のtimestamp sourceが使用不能になり所有先も決められない場合だけ、同じunitを`unassigned_tokens`へも残して未割当件数へ含める。

segmentを境界補助にだけ使用し、phrase textやrangeをwordから作った場合、そのsegmentをassigned countへ重複計上しない。segment-only alignmentの場合だけ`assigned_segment_count`を使用する。`unassigned_non_filler_count`も、実際にownership単位として使用したwordsまたはsegmentsの一方から数え、同じ発話を二重計上しない。

`unassigned_tokens`の各要素は、少なくとも次を持つ。

- 元のtoken index
- 元文字列
- `start`、`end`。存在しなければ`null`
- canonical reason

canonical reason:

- `boundary_filler`
- `unrelated_speech`
- `ambiguous_assignment`
- `out_of_order_speech`
- `no_positive_duration`

`diagnostic_flags`は重複を除き、canonical flag名の辞書順で返す。raw provider payload、raw音声、個人情報はcanonical diagnosticsへ入れない。raw件数は`raw_timestamp_word_count`と`raw_timestamp_segment_count`だけに限定する。`alignment_contract_version`と採用policyはtop-level schemaと実装versionで追跡し、provider versionは公開resultの必須fieldにしない。

一意に所有されたzero-duration tokenはunassignedへ入れず、`zero_duration_tokens`へowner phrase indexとともに記録する。

`contradictory_timestamp_payload`は通常のunassigned reasonではなくdiagnostic flagとする。正式transcriptionが空ならblocking provider error、非空なら制限付きevaluated resultに付くnon-blocking flagとする。どちらでもraw words/segmentsをcanonical token ownershipへ入れず、件数だけをcanonical diagnosticsに残す。

候補数、score計算数、anchor数、内部探索理由、処理時間は実装評価に追加できるが、アルゴリズム非依存のcanonical parity fieldにしない。

## 15. Python / Cloudflare Worker parity

同じ採用policyを実装するPython版とWorker版は、同じ入力に対して次を一致させる。

- `outcome`
- target language、phrase数、phrase順
- `assignment_status`
- `available`とderived count
- `matched_text`
- 採用方式決定後の`content_matched`
- `alignment_confidence`
- `boundary_sources`
- `text_source`、`timestamp_source`
- word index
- audio range
- unassigned/zero-duration diagnostics
- deterministicなdiagnostic flags

処理時間、provider固有metadata、未採用のsimilarity、内部候補scoreはcanonical parity対象から除外する。

Python/Worker parityは製品上の正しさの得点ではなく、同じ実装契約を再現したことの検証とする。

## 16. UI playback contract

UIはreferenceとattemptの両方で`available=true`の共通phrase indexを昇順に求め、同じplayback planを表示ラベルと実再生経路に使用する。

| 条件 | mode | 表示 |
| --- | --- | --- |
| no-speech、attempt音声なし、結果未表示 | `model` | `再生` |
| 共通indexが全target phrase | `phrase` | `フレーズごと比較再生` |
| 共通indexが1件以上、全件未満 | `partial_phrase` | `一部フレーズ比較再生` |
| 共通indexが0件で両音声あり | `whole` | `全体比較再生` |

- `complete`や`content_matched`でmodeを決めない。
- phrase playbackはreference、attemptの順で交互再生する。
- `audio_start`から`audio_end`ちょうどまで再生する。
- 固定の早止め、padding、文字数比rangeを加えない。
- reference/provider error時は比較modeへ進まない。
- `partial_phrase`では再生可能な共通phraseだけを再生し、再生不能なphraseを全体再生へ切り替える理由にしない。
- 再生不能なphraseには「このフレーズは区間を確認できませんでした」と表示できるが、内部用語のanchor、alignment、timestampを主要文言へ出さない。
- `text_only`は文字内容を表示できるが、再生buttonを無効にし、「音声区間を確認できませんでした」とする。
- `no_speech`は通常の0点結果にせず、「音声を確認できませんでした。もう一度録音してください」と再録音導線を示す。
- provider errorは「音声の解析結果を確認できませんでした。もう一度お試しください」を主要文言とし、codeとreasonは展開可能な詳細または開発者向けlogへ分離する。
- reference error時はattemptの成績や比較buttonを表示せず、お手本音声の再生成または再読込を案内する。

## 17. fixtureとadjudication

### 17.1 fixtureの役割

- legacy fixture: 過去の不具合と旧契約の履歴。canonical変換前は総合順位へ加算しない。
- implementation-origin challenge set: 各実装が発見した問題領域。canonical期待値を人手で付け、両実装へcross-runする。
- canonical evaluation set: 候補選定後まで未使用にし、実行前に入力、期待値、対象policy、除外条件、SHA-256を固定する。
- ambiguous/adjudication-required set: 発話意図を入力だけから一意に決められないケース。総合順位から除外する。

実装ごとに異なる期待値を作らない。実装結果を見た後に期待値を変更したケースは、そのroundの独立評価から外してchallenge setへ移す。

既存fixtureの暫定的な役割は次とする。

| fixture | 役割 | 注意点 |
| --- | --- | --- |
| `practice_alignment_cases.json` | legacy | 旧集計field中心 |
| `practice_alignment_golden_cases.json` | legacy / challenge | 実装調整に使用済み |
| `practice_alignment_boundary_cases.json` | implementation-origin challenge | どもり、言い直し、フィラー、抜け |
| `practice_alignment_assignment_cases.json` | canonical challenge source | `assignment_expectations.json`で200件を固定 |
| `practice_alignment_regression_cases.json` | implementation-origin challenge | 発見済み回帰 |
| `practice_alignment_holdout_cases.json` | training / challenge | 結果確認・調整済みなら今後holdoutと呼ばない |
| `practice_alignment_validation_cases.json` | training / challenge | 結果確認済み |
| 第1弾手作業200件 | canonical challenge source | 194件固定、6件ambiguous除外。方式比較・調整に使用済み |
| 第2弾100件 | canonical pilot / challenge source | 96件固定、4件ambiguous除外。初回実行後に内容確認済み |

「holdout」というファイル名だけで未使用性を判断しない。どの実装・期待値調整にも未使用であることを評価roundごとに記録する。

### 17.2 ownershipとcontentの分離

ownership fixtureは次を期待値に持つ。

- assignment status
- matched text
- word index
- audio range
- confidenceの許容範囲
- boundary sources
- unassigned tokenとreason
- zero-duration tokenのowner

content fixtureは正しいownership spanを固定し、人手の`expected_content_matched`を持つ。splitter、ownership、content、API/UI、performanceを一つの総合点へ混ぜない。

#### 17.2.1 canonical expectation overlay

既存fixtureのraw inputと旧期待値を同じ変更で書き換えず、canonical評価では別のexpectation overlayを使用する。overlayは少なくとも次を持つ。

- `fixture_contract_version`: overlay schema version。初版は`1`
- `alignment_contract_version`: 本文書のschema version。初版は`1`
- `evaluation_role`: `pilot | challenge | canonical_evaluation`
- `source_fixture`: raw inputを持つ既存fixtureへの相対path
- `source_sha256`: overlay作成時のsource fixture SHA-256
- `ownership_profile`と`content_profile`
- source caseと1対1で対応する`cases`

`fixture_contract_version=2`では、top-level件数だけで理由差を隠さないため、正常`expected`へ`unassigned_tokens`の完全配列を必須追加する。各要素は`source`、`source_index`、`text`、`start`、`end`、canonical `reason`を持ち、provider順を保持する。version 1 overlayは既存pilotとの互換用に読み取れるが、新規・再ラベルoverlayはversion 2を使用する。

各caseの`expectation_status`は次のいずれかとする。

- `fixed`: 本文書の固定coreと指定profileから期待値を一意に決められる
- `evaluation_required`: policy候補の比較前に一意な期待値を置かない
- `adjudication_required`: 発話意図等の人手判定前に一意な期待値を置かない
- `ambiguous_excluded`: 人手判定を実施したが、入力だけでは一意に決められず順位から除外する

`fixed`だけをpass/failへ含める。他の状態は`excluded_from_score=true`とし、`expected`または`expected_error`を持たせない。除外caseもsourceから削除せず、名前、状態、理由をoverlayへ残す。

正常結果を期待する`fixed` caseの`expected`は、content、confidence、boundary algorithmを混ぜず、次を固定する。

- `outcome`
- target/playable phrase count、`all_phrases_playable`、`unassigned_non_filler_count`、`complete`
- phraseごとの`index`、`source_index`、`target_text`
- `assignment_status`、`available`、`matched_text`
- `text_source`、`timestamp_source`
- word indexの半開区間、実timestamp由来の`audio_start` / `audio_end`
- zero-duration wordのowner phrase index

provider contract errorを期待する`fixed` caseは正常結果の`expected`を持たず、代わりに`expected_error`へ次を固定する。

- `error_code`
- `reason`
- `retryable`

1つの`fixed` caseが`expected`と`expected_error`の両方を持つことは禁止する。

content、confidence、boundary source、完全diagnosticsは別axisのfixtureで固定する。ownership overlayから実装へ有利な値を逆算しない。adapterはfield rename、derived field、既に半開区間であるindexの転記だけを行い、ownership、文字、時刻、availabilityを補正しない。

### 17.3 部分重複negative

既存第2弾データの`partial_overlap_negative` 12件は、旧期待値を自動的に維持せず、また両profileで自動的にplayableへ変更しない。

これらは、次のどちらかをtimestampと文字列だけから確定できない。

- target phraseを大きく言い間違えた実際の試行
- targetと一部だけ重なる無関係な追加発話

各caseへ人手で次の`attempt_intent`を付ける。

- `relevant_attempt`
- `unrelated_speech`
- `ambiguous`

`ambiguous`はprofile順位から除外する。人手ラベルがない間は`adjudication_required`、判定後も一意に決められなかったcaseは`ambiguous_excluded`として扱い、canonical pass/failを付けない。

2026-07-16に、実装出力、既存期待値、case名、説明を見せない独立判定を実施した。結果は`relevant_attempt` 5件、`unrelated_speech` 3件、`ambiguous` 4件である。判断理由を含む正のartifactは`tests/fixtures/practice_alignment_canonical/partial_overlap_attempt_intent.json`とし、SHA-256は`72d9f89e47de5c9a1d1f74dbbfd9ee023218a1dc3e9b150791d6291a63b10b20`である。

- `relevant_attempt`: 対応するphraseへ発話全体を所有させ、文字不一致はcontent軸で評価する
- `unrelated_speech`: 対応するphraseへ所有させず、発話tokenを未割当として数える
- `ambiguous`: `ambiguous_excluded`として同じ条件で両実装の順位から除外する

### 17.4 確認済み手作業データ

統合時点で確認済みの入力とSHA-256は次である。

| データ | path | 件数 | SHA-256 |
| --- | --- | ---: | --- |
| 第1弾手作業 | `tests/fixtures/practice_alignment_manual_evaluation_cases.json` | 200 | `7967010c9b10fb9128a8da2c1f128cbd9671629c0ca9045bbf4972fd17f84da5` |
| assignment手作業 | `tests/fixtures/practice_alignment_assignment_cases.json` | 200 | `7b0b6ba1c7657c9389511c486af8aa1cd46a3537fa4b17f1f127997f2624f9cf` |
| 第2弾pilot | `tests/fixtures/practice_alignment_manual_round2/pilot_cases.json` | 20 | `f9a8341e8fcab48efb373627af6f9c946a172820f719624ef5e7c5390fe73cea` |
| 第2弾holdout | `tests/fixtures/practice_alignment_manual_round2/holdout_cases.json` | 80 | `3a2bc2d080acfd130b822686cdcdd412e11b6d8472a0345919ac3855851ee152` |

これらの既存expected schemaは主に`available`、`complete`、range件数、旧`source`、`matched_text`、時刻を持つが、canonicalな`content_matched`、`assignment_status`、word index、confidence、boundary source、unassigned reason、zero-duration ownerを網羅しない。したがって既存成功件数をcanonical適合率として使わない。

既知の再審査対象は次である。

- 第1弾の戻り発話、phrase間の独立文、先頭partialと後続exactに該当する英中6件: 提示targetと会話文脈なしでは所有を一意に決められないため、`ambiguous_excluded`とする。
- 第2弾`partial_overlap_negative` 12件: [17.3](#173-部分重複negative)に従ってadjudication済み。4件の`ambiguous`だけをpass/failから除外する。
- `manual_r2_zh_030_available_false_ignores_words`と`manual_r2_en_040_available_false_ignores_words`: raw timestamp data不使用に加え、provider応答矛盾として再分類する。
- point timestamp 16件: zero-duration文字を保持する旧期待に加え、owner、index、assignment、boundary source、confidenceを追加ラベルする。zero-durationだけのtext-only phraseは別challenge caseを追加する。

## 18. 評価手順

### 18.1 事前固定

各評価roundは、実行前に次を固定する。

- 評価する軸とpolicy名
- 入力と期待値
- ambiguous除外条件
- 件数
- SHA-256
- 合格条件と停止条件

### 18.2 pilot

ownershipとcontentを別々に10〜20件で評価する。英語と中国語、正常例、問題例、境界例を含める。

ownership pilotには少なくとも次を含める。

- 前後anchorの低一致発話
- 片側anchorの実際のtarget試行
- 長いpause後の無関係発話
- generic connectorだけが共通する発話
- 最終phraseの言い間違いとtarget完了後の追加会話
- phrase抜け、逆順、戻り発話
- zero-duration、境界フィラー、text-only
- segment数とphrase数が一致するが文字anchorがないケース

content pilotには少なくとも次を含める。

- 常時正規化後の一致
- `A17`、`A seventeen`、`A one seven`
- 一般数値とidentifierの区別
- 核心語、数量、否定、固有名詞の置換
- 中国語の同音字、近音字、声調由来の別漢字
- paraphraseと類義語

#### 18.2.1 ownership overlay初回pilot

2026-07-16に、第2弾pilot 20件をraw inputとしてcanonical ownership overlayを作成した。

| artifact | SHA-256 |
| --- | --- |
| `tests/fixtures/practice_alignment_manual_round2/pilot_cases.json` | `f9a8341e8fcab48efb373627af6f9c946a172820f719624ef5e7c5390fe73cea` |
| `tests/fixtures/practice_alignment_canonical/pilot_expectations.json` | `4429f348194d6603c364423812a9483797bc57f3400d63085c175718ada22b42` |

分類と結果:

- `fixed`: 20件。独立判定前に固定済みの18件はPython 18/18、Cloudflare Worker 18/18で一致
- adjudication後に`unrelated_speech`と確定した2件は、Python、Cloudflare Workerとも誤って第2phraseへ割り当てた
- content、confidence、boundary source、完全diagnosticsはこのoverlayの評価対象外

採用前の結果はPython 18/20、Cloudflare Worker 18/20だった。2件の差は期待値未確定ではなく、独立判定済みの無関係発話を片側anchorと空きslotだけで所有させるfalse positiveだった。`ownership.conservative`適用後は両runtimeとも20/20である。

#### 18.2.2 segment-only policy pilot

segment数一致だけのfallbackと、一意な文字anchorを要求する保守baselineを比較するため、英語・中国語各6件、合計12件を作成した。

| artifact | SHA-256 |
| --- | --- |
| `tests/fixtures/practice_alignment_canonical/segment_policy_pilot_cases.json` | `da70fbda3499736bda7c696b9a18f63dc52d93a93c4c23628a1c5010d662f9f1` |
| `tests/fixtures/practice_alignment_canonical/segment_policy_pilot_expectations.json` | `e35f1b0b1f787bba324a42aa962f7773bde0925d34737e23022523d4c1dbcbf4` |

内訳:

- 正規化後に各target phraseと一意に一致する正例: 6件
- segment数だけ一致する無関係発話: 2件
- 逆順anchor: 1件
- 既割当targetの重複segment: 1件
- 交差する不正timestamp source: 1件
- zero-duration segmentをtext-onlyにするケース: 1件

採用前のcount-only fallbackはPython 6/12、Cloudflare Worker 6/12で、同じ6件に失敗した。失敗はすべて、数の一致をownership根拠にしたこと、または正時間を検査しなかったことによる。よってcount-only fallbackを不採用とし、[10.8](#108-segment-onlyの固定baseline)を`ownership.conservative`へ統合した。採用後は両runtimeとも12/12である。

交差する不正timestamp sourceの2 segmentは、再生には使用しないが、`unassigned_non_filler_count=2`としてdiagnostics上は失わない。

### 18.3 小規模試行

pilotで次を満たした軸だけ、50〜100件の小規模試行へ進める。

- canonical core違反がない。
- 両実装を同じ意味で評価できるschemaがある。
- adapterがownership、文字、時刻等の挙動差を隠していない。
- profile間に測定可能な差がある。
- 個別case名や個別語blacklistへ依存しない。

差がなく複雑さだけが増える場合は、単純なbaselineを採用する。

#### 18.3.1 第2弾80件challenge

adjudication完了後、第2弾の旧`holdout_cases.json` 80件を小規模challengeとして使用した。このデータは既に内容と旧期待値を確認済みなので、未使用のcanonical evaluation setではない。

| artifact | SHA-256 |
| --- | --- |
| `tests/fixtures/practice_alignment_manual_round2/holdout_cases.json` | `3a2bc2d080acfd130b822686cdcdd412e11b6d8472a0345919ac3855851ee152` |
| `tests/fixtures/practice_alignment_canonical/partial_overlap_attempt_intent.json` | `72d9f89e47de5c9a1d1f74dbbfd9ee023218a1dc3e9b150791d6291a63b10b20` |
| `tests/fixtures/practice_alignment_canonical/round2_challenge_expectations.json` | `ac47c8dbe168b427ce2531c4f3529fe609ef5c03f9e3591b0ff88f602944b9d4` |

splitterとcontentの独立contract fixtureは次を正とする。

| artifact | SHA-256 |
| --- | --- |
| `tests/fixtures/practice_alignment_canonical/splitter_contract.json` | `4f5b98ad8a52e08337163d6cfa9accb38ddf6676cbe2104281985f1ae6611eb2` |
| `tests/fixtures/practice_alignment_canonical/content_contract.json` | `7b1a73bc1f6ffdf2e9884c7eed0b2e098971927bdbef4bd4692c721cfd123c4a` |

overlayは旧手作業rangeのうちcanonical coreと矛盾しないものだけをfield変換し、次を本文書から上書きした。実装出力から期待値を逆算していない。

- `partial_overlap_negative`の独立判定
- `available=false`とraw timestamp payloadが矛盾する2件の制限付きevaluated result
- segment数が一致しなくても、一意な完全一致segmentだけを所有できる2件
- word/segment index、zero-duration owner、未割当ownership unit数

分類は正常結果76件、`ambiguous_excluded` 4件である。正式transcriptionが非空の2件はraw wordsを無視してmulti-phraseを推測分割せず、`contradictory_timestamp_payload`をdiagnosticsへ残す正常resultとした。修正前のPythonとCloudflare Workerはともに固定76件中72件に一致し、同じ4件に失敗した。

| 差 | 件数 | 採用前挙動 |
| --- | ---: | --- |
| confirmed unrelated speechの誤割当 | 1 | 時刻だけが共通する第2発話をphraseへ所有させる |
| segment数不一致時の一意な完全一致segment | 2 | 安全に回収できるphraseもすべて捨て、未割当segmentもdiagnosticsへ残さない |
| 所有可能なsegmentがないcount mismatch | 1 | 再生不能結果は一致するが、未割当segment数を0として失う |

pilotと合わせた独立判定12件では、採用前の両runtimeとも`relevant_attempt` 5/5を所有できた一方、`unrelated_speech` 0/3で3件すべてを誤割当した。`ambiguous` 4件は除外した。これは低一致発話を一律に捨てる問題ではなく、片側anchor後の発話を内容にかかわらず所有させる問題だった。したがって単なるsimilarity閾値変更へ進まず、confirmed unrelated speechを除外する構造条件を実装・再評価した。

[18.4](#184-停止条件)の「confirmed unrelated speechを新たに割り当てる」に該当したため、採用前方式のまま次の評価へ進めず、保守policyへ固定した。

再評価には次の実装非依存overlayを両runtimeへそのまま渡す。通常テストはoverlayのschema、source SHA、期待値の内部整合を検査し、未採用canonical契約へのproduction適合率は次の専用scriptで測る。

```sh
PYTHONPATH=src python3 scripts/evaluate_practice_alignment_canonical.py \
  tests/fixtures/practice_alignment_canonical/round2_challenge_expectations.json \
  --summary-only

node scripts/evaluate_practice_alignment_canonical.mjs \
  tests/fixtures/practice_alignment_canonical/round2_challenge_expectations.json \
  --summary-only
```

採用実装への再評価結果は次である。いずれもPythonとCloudflare Workerで同じ結果になった。

| set | evaluated | excluded | pass |
| --- | ---: | ---: | ---: |
| pilot | 20 | 0 | 20 |
| segment policy pilot | 12 | 0 | 12 |
| round2 challenge | 76 | 4 | 76 |

`ownership.conservative`によりconfirmed unrelated speechの誤割当を解消し、一意な完全一致segmentをcount mismatch時も回収した。`ambiguous` 4件は期待値へ推測を入れず、引き続きscoreから除外する。

### 18.3.2 既存400件のcanonical再ラベルと全件比較

第1弾手作業200件とassignment手作業200件を、旧実装用期待値のまま件数へ加えず、同じcanonical schemaへ変換した。変換はcanonical splitter、word所有の半開区間、実timestamp、zero-duration owner、未割当tokenとreasonを固定し、仕様と衝突する旧期待値だけを明示的に裁定する。生成手順は`scripts/build_practice_alignment_canonical_overlays.py`で再現できる。

| source | canonical overlay | raw | fixed | excluded | overlay SHA-256 |
| --- | --- | ---: | ---: | ---: | --- |
| `practice_alignment_manual_evaluation_cases.json` | `manual_evaluation_expectations.json` | 200 | 194 | 6 | `fac8043a758d96ca40678f81b44817135f26912f0c30dc4a9d7b0efd62e82217` |
| `practice_alignment_assignment_cases.json` | `assignment_expectations.json` | 200 | 200 | 0 | `0c41e356e94ee46b0e9fa5adfcc93fbddfc4a0f5d71194b80f4e5e7dfbc0e7d7` |

第1弾の除外6件は、英中それぞれの戻り発話、phrase間の独立文、先頭partialと後続exactである。文字列とtimestampだけでは、学習者がどのtargetを提示されて発話したか、言い直しか別発話かを一意に決められない。両runtime、変更前後のいずれにも同じ除外を適用した。assignment 200件はすべて固定した。

変更前は、期待値を固定したcommit `39d41a1`のPythonとCloudflare Workerへ、今回の同じoverlayを渡して測定した。変更後も同じ入力、期待値、除外条件、exact field比較を用いた。

| canonical set | fixed件数 | `39d41a1` | 採用後 | 改善 |
| --- | ---: | ---: | ---: | ---: |
| ownership pilot | 20 | 18 | 20 | +2 |
| segment policy pilot | 12 | 6 | 12 | +6 |
| round2 challenge | 76 | 72 | 76 | +4 |
| 第1弾手作業 | 194 | 174 | 194 | +20 |
| assignment手作業 | 200 | 161 | 200 | +39 |
| **合計** | **502** | **431 (85.9%)** | **502 (100%)** | **+71** |

PythonとCloudflare Workerは変更前後とも同じ件数・同じcaseで一致した。採用後は502件のphrase所有、時刻、文字、zero-duration owner、未割当reasonを含むcanonical期待値へ全件一致し、固定case上の悪化は0件だった。逆順で1件だけ残せる同点ケースは「発話時刻が早いtarget」ではなく「小さいtarget index」を選ぶ決定規則へ統一し、旧holdout／validationの4期待値も同じ規則へ更新した。

これは確認済みデータに対するcontract適合率であり、未知録音に対する一般化精度100%を意味しない。次の方式変更は[18.5](#185-最終確認)の未使用set gateを必要とする。

### 18.4 停止条件

次のいずれかで試行を止め、残件へ自動的に進まない。

- balancedがconfirmed unrelated speechを新たに割り当てる。
- ASR等価正規化が数量、否定、核心語、固有名詞のcontent false positiveを生む。
- 既存の正常例、順序、zero-duration、境界フィラーを悪化させる。
- 同じprofileの大きな成立条件変更が2回に達する。
- 見積り件数または作業量が2倍を超える。
- 製品上の改善が横ばいまたは悪化する。

停止時は改善数、悪化数、false positive、false negative、未解決条件、安全なbaselineを報告する。

### 18.5 最終確認

各軸の採用候補だけを結合し、integration challenge setで確認する。今回利用できた第1弾200件、assignment 200件、第2弾100件は、いずれも仕様統合または実装比較の過程で内容・出力を確認済みである。このため、502/502を「最後まで未使用の評価setでの精度」とは呼ばない。

contract version 1の移行可否は、固定期待値への適合、既存回帰、Python/Worker parity、API/UI契約、性能budgetで判断した。次にownershipまたはcontent policyを変更する場合は、変更案を実行する前に新しい実録音を確保し、入力、期待値、除外条件、SHA-256を固定した未使用canonical evaluation setを必須gateとする。今回確認した500件を名前だけ変えてheld-outへ戻さない。

報告では少なくとも次を分ける。

- ownership exact match
- relevant attemptの回収数
- unrelated speechの誤割当数
- content false positive / false negative
- ambiguous除外数
- 言語別・カテゴリ別結果
- legacy fixtureとの衝突
- Python/Worker parity
- 処理時間
- 実装・保守の複雑さ

### 18.6 指標と報告形式

ownershipではphrase/token assignment exact match、false-positive assigned phrase、false-negative unassigned phrase、boundary tokenの過不足、audio range差、unassigned reason、relevant attempt回収、unrelated speech誤割当を分け、false positiveとfalse negativeを相殺しない。

contentではtrue/false positive、true/false negativeを、identifier表記差、核心語、数量、否定、固有名詞、中国語字形・同音・声調由来別漢字、短文・長文に分ける。UIでは共通phrase index、playback mode、表示と経路、停止時刻、no-speech/reference errorを検査する。性能ではmedian/p95、最大入力、memory、候補数、探索上限、追加規則・状態・依存、runtime間の重複実装量を測る。

各profileは少なくとも次を報告する。

```text
profile:
evaluation_set_sha256:
total_cases:
canonical_pass:
false_positive:
false_negative:
ambiguous_excluded:
python_worker_parity:
median_elapsed_ms:
regressions_on_legacy_challenge:
implementation_complexity:
```

加えて言語別、カテゴリ別、代表的な改善例・悪化例を示す。

### 18.7 採用実装の数値パラメータ

次はcontract fieldではなく、PythonとCloudflare Workerで同じ値を使うproduction実装パラメータである。変更時は境界fixture、502件のcanonical gate、両runtime parity、性能budgetを再実行する。

| パラメータ | 採用値 | 用途と制限 |
| --- | ---: | --- |
| pause partition境界 | `0.18`秒以上 | [10.3.1](#1031-制約付きpause-partition)をすべて満たす場合だけ境界補助に使う。`0.180`秒と`0.179`秒の対になる回帰caseを持つ。 |
| detached speech guard | `0.65`秒以上 | 文字anchorから拡張されたrangeに別発話が混ざるのをtrimする拒否guard。ownershipを新規作成しない。 |
| high-confidence表示・neighbor判定 | similarityとcoverageがともに`0.75`以上 | 内部候補の表示と前後anchor条件に使う。片側発話をこの数値だけで所有させない。 |
| nearly-exact anchor | similarityとcoverageがともに`0.95`以上 | 完全一致に近い候補の競合排除と決定的な同点解消に使う。`content_matched`はこの値ではなくcanonical正規化後の完全一致で決める。 |

最大入力と処理時間budgetは[GAP-P2-05](#gap-p2-05-性能budget)の契約を正とする。ブラウザ再生停止には固定の許容ミリ秒、padding、早止めを設けない。UIは`audio_end`を目標にし、実停止誤差は計測値として別に記録する。したがって再生停止誤差をphrase境界の補正や隣接音声混入の許可には使わない。

## 19. policy選定規則

- ownershipで同程度なら`ownership.conservative`を採用する。
- `ownership.balanced`は採用せず、片側低一致spanを決定的に説明できない場合は未割当にする。
- contentは`content.canonical_normalized`を採用し、固定正規化後の完全一致とtarget側で明示されたcompact identifier等価表記だけをtrueにする。
- 採用後はprofileを次のcontract versionへ統合し、不採用profileを隠れた実行時switchとして残さない。
- 利用者が選択する明確な製品価値がない限り、複数profileを公開設定にしない。

## 20. 既存実装との接続

既存実装のfield名やenumがcanonical schemaと異なる場合、比較runnerでadapterを使用できる。

adapterが機械的に正規化してよいもの:

- field名
- enum名
- inclusive indexからhalf-open indexへの変換
- derived field

adapterが補正してはならないもの:

- phrase ownership
- matched text
- content判定
- audio range
- availability
- 未割当tokenの削除

canonical配列名は`phrases`とする。現行APIが`ranges`を要求する移行期間だけ、外部adapterで`phrases`から機械的にrenameできる。`ranges`をcanonical schemaへ併記せず、どちらが正かを曖昧にしない。旧`source=words|segments|none`は、意味を確認した上で`text_source`と`timestamp_source`へ分離する。

旧rangeにowner情報がない、旧`anchor` / `structural`からconfidenceとboundary sourceを一意に復元できない等、lossless変換できない場合は`null`で意味を捏造せず、adapter上で比較不能とする。adapter自体にfixtureとparity testを持たせる。

移行adapterはcanonical resultからlegacy resultへの一方向変換に限定する。`phrases -> ranges`、`target_text -> target`、`text_source=timestamp_source`の場合の`source`転記、canonical値から計算できるderived fieldだけを許可する。legacy resultからcanonical resultを復元するadapterは提供しない。canonicalにないownership、confidence、boundary、content、時刻を補完せず、legacy schemaで表せないfieldは明示的に欠落させる。

## 21. 決定事項register

本文書へ統合した製品契約、policy評価、実装・運用の論点は、暗黙の実装判断で閉じず、次の状態と完了条件で管理した。

- `open`: 人手による製品・schema判断が必要
- `evaluation_required`: 共通fixtureによる候補比較が必要
- `adjudication_required`: 発話意図等の人手ラベルが必要
- `closed`: 決定が本文書へ反映済み

優先度は、`P0`を実装適合開始前、`P1`をpolicy選定・最終評価set作成前、`P2`を正式公開前に閉じる事項とする。

### GAP-P0-01 canonical文書とschemaの正

状態: `closed`

決定:

- 本文書だけをcanonical contractの正とする。
- `alignment_contract_version`は整数で初版を`1`とする。
- canonical phrase配列は`phrases`、原文fieldは`target_text`とする。
- `target_language`、`source_index`、`text_source`、`timestamp_source`をcanonical fieldとする。
- `content_matched`はnullable、top-level `available`と`complete`はderived互換fieldとする。
- 現行APIの`ranges`は移行adapterでのみ扱う。

schema fixture、Python、Worker、UIはcanonical名へ移行済みであり、命名判断は再度分岐させない。

### GAP-P0-02 provider errorのAPI/job契約

状態: `closed`

[6.5](#65-validation-errorとprovider-error)の型付きerror envelopeを採用する。validation errorはHTTP 400、同期provider契約違反はHTTP 502、非同期job内ではHTTP 200のpolling response中で`status=failed`とする。`no_speech`は成功resultのまま維持する。raw payloadはpublic response、永続化history、Worker logへ残さない。

API schema、Python/Worker、UI表示fixtureへ反映済みであり、errorを成功resultへ混ぜる方式へ戻さない。

### GAP-P0-03 不正timestampの扱い

状態: `closed`

[5](#5-timestampの妥当性)の保守契約を採用する。単独unitのprimitive異常はunit除外、一般の非単調・重複・交差はsource全体を使用不能、wordsとsegmentsの矛盾は安全なwordsを優先してsegmentsを根拠から外す。wordsの`zero_duration_overlap_bridge`だけは構造条件をすべて満たす場合にraw順・raw時刻のまま受理し、別phraseの最終rangeが交差する場合は該当phraseをtext-onlyへ下げる。補正、並べ替え、clamp、時刻捏造は行わない。

正式transcriptionが非空なら安全なtimestampだけで制限付き評価を続け、すべて使用不能かつtranscriptionも空ならprovider契約違反とする。異常種別fixtureとPython/Worker parityへ反映済みである。provider timestampと実音声長の照合はalignment coreではなく、各provider adapterが音声metadataを持つ場合のvalidation責任とする。

### GAP-P0-04 空targetとsplitter結果0件

状態: `closed`

空target、句読点・空白だけのtarget、0 phrase、未対応・不明言語はvalidation errorとし、attemptの`no_speech`へ混ぜない。外部error表現はGAP-P0-02で固定する。

### GAP-P1-01 conservative片側anchorの根拠要件

状態: `closed`

製品では[10.4](#104-片側anchorの採用policy)の`ownership.conservative`を採用する。独立判定済みの関連発話5件は現行方式で回収できた一方、無関係発話3件はすべて誤割当だった。共通playable phraseが1件以上あればpartial phrase UXを維持できるため、追加回収よりfalse positive回避を優先する。

数値化されていない根拠だけの片側低一致spanは未割当にし、`ownership.balanced`をproduction switchとして残さない。

### GAP-P1-02 evidence用語の実装可能な定義

状態: `closed`

次の用語は説明用・評価用であり、数値境界を持たないままproductionの自動回収条件に使用しない。

- strong textual evidence
- high-confidence anchor
- 明確なpause、長いpause
- 独立したASR segment
- 競合する別解
- 別話題、独立した会話

production baselineは常時正規化後の文字anchor、単一phrase、前後anchorで一意なspan、固定済みsegment-only規則に加え、[10.3.1](#1031-制約付きpause-partition)の全条件を満たすpause partitionだけを使用する。pause単独、空きslot単独、数値化されていない「明確さ」だけでは所有しない。実装値は[18.7](#187-採用実装の数値パラメータ)へ固定し、正例、反例、閾値直上・直下、502件の全canonical gate、両runtime parityで変更を検出する。

### GAP-P1-03 `partial_overlap_negative`のattempt intent

状態: `closed`

[17.3](#173-部分重複negative)の12件を、実装出力を見ない独立担当が判定した。結果は`relevant_attempt` 5件、`unrelated_speech` 3件、`ambiguous` 4件であり、同じラベルを両runtimeへ適用した。判断理由と不足情報は`partial_overlap_attempt_intent.json`へ固定した。

### GAP-P1-04 segment-only alignment

状態: `closed`

[10.8](#108-segment-onlyの固定baseline)を採用する。segment数とphrase数の一致だけでは割り当てず、正規化後に一意な文字anchorを持ち、妥当なsource上でtarget順と時刻順が一致するsegmentだけを割り当てる。正時間ならassigned、zero-durationならtext-only、word indexは`null`とする。

12件pilotで現行count-only fallbackはPython/Workerとも6/12、固定baseline期待値は12件すべてに一意なownershipを与えた。部分一致segmentの追加回収はこの決定へ含めず、別challengerとして扱う。

### GAP-P1-05 content similarity方式と閾値

状態: `closed`

`content_matched`は`content.canonical_normalized`による完全一致で決め、similarity metric、閾値、ASR confidenceを使用しない。similarityは採点・診断専用とし、ownershipとplayabilityへ流用しない。

採点用similarityの方式変更は別の人手ラベル付きcontent setで評価できるが、canonical boolean contractを変更しない。

### GAP-P1-06 英数字identifierの文脈判定

状態: `closed`

[13.2](#132-採用content-policy)のtarget側compact identifier規則を採用する。`A17`、`A seventeen`、`A one seven`はtargetに`A17`がある文脈で等価とし、一般数値、数量として空白を含む`A 17`、日付、時刻、電話番号、version等へ自動拡張しない。

### GAP-P1-07 target phrase splitterの完全な契約

状態: `closed`

[4](#4-target-phrase-splitter)のhard boundaryとprotected pattern規則を採用する。読点、カンマ、colonは既定で分割せず、sentence終端、semicolon、改行で分割する。専用fixtureでphrase text、`source_index`、空phrase除外とPython/Worker parityを固定する。

### GAP-P1-08 filler判定

状態: `closed`

言語別候補語は、録音端または所有済みphrase間の独立spanであり、targetの対応位置に同じ語がなく、隣接tokenの反復・false start・自己訂正でない場合だけboundary fillerとして除外する。phrase内部の同語、target本文中の同語、どもり、完全な言い直しは所有rangeへ保持する。除外tokenもdiagnosticsへ残す。

### GAP-P2-01 diagnosticsの完全schema

状態: `closed`

[14](#14-diagnostics)のschema、順序、flag重複除去、raw件数だけを保持するprivacy境界を採用する。schema fixtureと両runtime parityを実装完了条件とする。

### GAP-P2-02 canonical adapterの限界

状態: `closed`

canonicalからlegacyへの一方向・機械的変換だけを許可する。legacyからcanonicalを復元せず、欠落情報を推測しない。losslessに表せないcanonical fieldはlegacy側で欠落させ、adapter fixtureで挙動差を隠していないことを検証する。

### GAP-P2-03 時刻比較の許容誤差

状態: `closed`

canonical schemaはprovider由来の有限値を丸めず保存する。Python/Worker parityとfixture比較だけ`1e-6`秒以下を同値とする。入力妥当性の`end >= start`とphrase rangeの`end > start`は補正せず実値で判定する。UIはcanonical `audio_end`を目標にし、event粒度による実停止誤差を別計測する。padding、固定早止め、隣接音声混入の正当化へepsilonを使わない。

### GAP-P2-04 UIのエラー・部分結果表示

状態: `closed`

[16](#16-ui-playback-contract)の平易な主要文言と部分結果表示を採用する。共通playable phraseが1件以上なら不完全でもphrase比較を続け、0件の場合だけwholeへ戻す。通常、partial、whole、text-only、no-speech、reference error、attempt errorを実ブラウザで確認し、表示と実playback planを一致させる。

### GAP-P2-05 性能budget

状態: `closed`

production入力上限は次とする。

- target phrase: 最大16件
- raw wordとsegmentの合計: 最大256件
- `target_phrase_count * timestamp_unit_count`: 最大1024
- phraseごとのalignment候補: 最大4096件

いずれかを超えた場合はsilent fallbackや一部切り捨てを行わず、HTTP 400の`practice_alignment_invalid_input`、`reason=alignment_input_too_large`を返す。

Apple M1 Pro、Python 3.11.9、Node 23.11.0で、固定前commit `39d41a1`と採用実装を同じ生成入力で比較した。値はwarm-up後のwall-clockであり、絶対性能のCI合否ではなく、方式変更時の回帰基準とする。

| runtime / case | fixed前 median / p95 | 採用後 median / p95 | 採用後memory観測 |
| --- | ---: | ---: | ---: |
| Python 4 phrase / 16 token | 11.389 / 11.583ms | 10.440 / 10.671ms | traced peak 79,271 bytes |
| Python 16 phrase / 64 token | 337.103 / 371.110ms | 235.553 / 236.343ms | traced peak 1,614,413 bytes |
| Python 1 phrase / 256 token | 27.213 / 28.124ms | 27.121 / 27.177ms | traced peak 179,021 bytes |
| Worker 4 phrase / 16 token | 4.335 / 5.857ms | 3.842 / 4.981ms | GC後heap差 235,264 bytes |
| Worker 16 phrase / 64 token | 150.915 / 152.983ms | 99.306 / 101.041ms | GC後heap差 1,466,968 bytes |
| Worker 1 phrase / 256 token | 14.397 / 14.603ms | 13.595 / 14.779ms | GC後heap差 30,736 bytes |

採用後budgetは、代表入力p95をPython 25ms未満、Worker 15ms未満、最大complexity入力p95をPython 750ms未満、Worker 350ms未満とする。memory値はPythonの`tracemalloc` peakとNodeのGC後heap差で意味が異なるため相互比較せず、同じruntime・scriptで回帰を見る。

再測定コマンド:

```sh
python3 scripts/benchmark_practice_alignment.py
node --expose-gc scripts/benchmark_practice_alignment.mjs
```

### 21.1 すでに固定した共通事項

次は再びpolicy候補へ戻さない。

- `available`と`content_matched`の分離
- unassignedの`content_matched=null`
- zero-duration tokenの文字・owner保持と、zero-durationだけのtext-only
- `available=false`のraw words/segments不使用
- 正式transcriptionのみなら単一phraseはtext-only、複数phraseは推測分割しない
- attempt no-speechとreference/provider errorの分離
- `complete`を互換derived fieldに限定
- UI modeを共通playable phrase indexから決める
- `partial_phrase`表示とcanonical `audio_end`を目標にした再生
- content similarityをplayabilityへ使わない
- ambiguous caseを総合順位から除外
- segment数とphrase数の一致だけのfallbackを採用profileへ含めない

### 21.2 決定記録

各gapを閉じるときは、少なくとも次を評価記録またはdecision recordへ残し、決定本文をこのSPECへ反映する。

```text
gap_id:
status: closed
decision:
reason:
alternatives_considered:
evaluation_set_sha256:
improvements:
regressions:
affected_docs:
affected_schema:
affected_tests:
```

評価不要の命名判断等では`evaluation_set_sha256: not_applicable`とする。

## 22. 正式移行の完了記録

2026-07-16にcontract version 1への移行を完了した。

- P0、P1、P2の全gapを`closed`にした。
- splitter、content、schema、adapter、provider矛盾、input limitの専用fixtureを追加した。
- `partial_overlap_negative` 12件を独立判定し、曖昧な4件だけをscoreから除外した。
- `ownership.conservative`と`content.canonical_normalized`を採用し、未採用profileをproduction switchとして残していない。
- canonical evaluationはPython/Workerとも、raw 512件中ambiguous 10件を除く502/502で一致した。内訳はpilot 20/20、segment policy 12/12、round2 76/76、第1弾194/194、assignment 200/200である。
- [SPEC.md](SPEC.md)、schema、Python、Worker、fixture、test、UI、[LEARNING_ROADMAP.md](LEARNING_ROADMAP.md)を同じ変更単位で同期した。
- `python3 -m pytest`は917件、`npm test`は261件、Playwrightは1440px、1024px、390pxの99件が成功した。今回のalignment再評価では見えるUIを変更していないため、Playwrightの再実行は不要と判断した。
- Light／Darkのpartial result、whole fallback、no-speech、reference error、attempt errorを実画面で確認し、横overflow、clip、重なり、主要操作の不一致がないことを確認した。
- `npm run check:js`、`npm run check:web`、`git diff --check`を完了した。

既存fixture期待値とcanonical期待値を同じfieldで二重管理しない。UIだけは保存済み旧historyを再生するため、canonical `phrases`を優先し、存在しない場合だけlegacy `ranges`を読む移行fallbackを持つ。

今回のデータはすべて仕様統合または実装比較で確認済みであり、未使用評価setでの一般化精度は主張しない。次のpolicy／アルゴリズム変更では[18.5](#185-最終確認)の新規未使用set gateを適用する。
