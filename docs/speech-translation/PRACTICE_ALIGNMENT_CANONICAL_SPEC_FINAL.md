# SpeakLoop フレーズ比較再生 canonical SPEC 統合最終案

更新日: 2026-07-16

> **Status: Final proposal**
> 本文書は、独立に作成した2つのcanonical SPEC案を比較し、固定core、schema、未決定policyの評価方法を統合した最終案である。採用手続きが完了するまでは既存の [SPEC.md](SPEC.md) を置き換えず、現行実装や既存fixtureの挙動を正当化する文書として使用しない。

関連文書:

- [最初のcanonical contract案](PRACTICE_ALIGNMENT_CANONICAL_SPEC.md)
- [最初のpolicy profiles案](PRACTICE_ALIGNMENT_POLICY_PROFILES.md)
- [現行SPEC](SPEC.md)
- [学習ロードマップ](LEARNING_ROADMAP.md)

## 1. 位置付け

本文書を、次のpilotと小規模試行で使用する唯一のcanonical候補とする。実装ごとに異なるcanonical SPECや期待値を作らない。

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

## 4. target phrase splitter

target phrase splitterはalignment方式から分離したcanonical部品とする。

- target textの文末記号、読点、カンマ、セミコロン等をphrase境界の基準にする。
- email address、URL内部のperiodをphrase境界にしない。
- 小数、version番号の内部periodをphrase境界にしない。
- `Ms.`、`Mr.`、`Dr.`等、文中の略語終端を無条件にphrase境界にしない。
- protected patternの後に本当の文末記号が続く場合は、文末として分割する。
- ASR transcriptionの句読点はtarget phraseの正にしない。

splitterは専用fixtureで検証する。splitter不一致によってtarget phrase数が変わったケースをalignment方式の品質スコアへ混ぜない。

## 5. timestampの妥当性

wordまたはsegmentのtimestamp unitは、次を満たす場合だけalignment入力として有効とする。

- `asr_timestamps.available=true`
- `start`と`end`が有限値
- `end >= start`

`start == end`は有効なtext-only候補であり、入力から削除しない。ただし、正時間の再生rangeを単独では作れない。

`available=true`のphrase rangeは、さらに次を満たす。

- `audio_start`と`audio_end`が実timestamp由来
- `audio_end > audio_start`
- 所有するwordまたはsegmentの実時間を越えない
- 他phraseのrangeと重複せず、target順と時刻順が一致する

文字数比、録音全長比、固定padding、隣接phraseの時刻を借りてrangeを作ってはならない。

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

## 7. canonical result schema

### 7.1 top-level result

```json
{
  "alignment_contract_version": "practice_alignment_v1",
  "outcome": "evaluated",
  "target_language": "en-US",
  "available": true,
  "target_phrase_count": 2,
  "playable_phrase_count": 1,
  "all_phrases_playable": false,
  "unassigned_non_filler_count": 1,
  "complete": false,
  "ranges": [],
  "diagnostics": {}
}
```

| field | 型 | 意味 |
| --- | --- | --- |
| `alignment_contract_version` | string | provider契約と分離したalignment schema version |
| `outcome` | `evaluated \| no_speech` | 学習者attemptの結果種別 |
| `target_language` | string | normalizationとsplitterに使用したtarget language |
| `available` | boolean | `playable_phrase_count > 0`のderived互換field |
| `target_phrase_count` | integer | splitterが返したtarget phrase数 |
| `playable_phrase_count` | integer | phraseの`available=true`件数 |
| `all_phrases_playable` | boolean | target phraseが1件以上あり、すべてplayableか |
| `unassigned_non_filler_count` | integer | boundary filler以外の未割当token数 |
| `complete` | boolean | 既存互換のderived field |
| `ranges` | array | target phrase順のphrase alignment result |
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

`outcome=no_speech`では`ranges=[]`、`available=false`、`playable_phrase_count=0`、`unassigned_non_filler_count=0`、`all_phrases_playable=false`、`complete=false`とする。`target_phrase_count`は保持する。

### 7.2 phrase range

```json
{
  "index": 0,
  "source_index": 0,
  "target": "Open the API console.",
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
| `target` | string | target phrase原文 |
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

### 10.4 片側anchorの固定baseline

canonical評価のownership baselineは`ownership.conservative`とする。

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

segment数とtarget phrase数が一致するという事実だけを、固定coreまたは`conservative`の自動割当条件にしない。segment-only割当は、文字・境界・順序の独立根拠をfixtureで評価する。

### 10.5 `ownership.balanced` challenger

`ownership.balanced`は、片側anchorに加え、強い文字根拠または明確な境界根拠のどちらか1つと、順序guardによって位置が一意な発話を追加回収する候補とする。

次はbalancedでも割り当てない。

- 順序と空きslotだけ
- generic connectorとutterance edgeだけ
- 全target phrase割当後の無関係発話
- 複数targetへ同程度に対応するspan
- 完全に無関係で境界以外の根拠がない発話

balancedは、複数の関連発話を追加回収し、confirmed unrelated speechの新規false positiveが0件の場合だけ採用できる。

### 10.6 抜け、逆順、戻り発話

- 発話されていないphraseへtimestampを作らない。
- target順と逆の発話を、全phraseが揃うように並べ替えない。
- 戻り発話を時間順に反して先行rangeへ結合しない。
- 戻り発話は`out_of_order_speech`として未割当にするか、直前phraseの自己訂正である明確な根拠がある場合だけ直前rangeへ含める。

### 10.7 target完了後の追加発話

全target phraseが割当済みの後に続く発話は、録音末尾にあるだけでは最後のphraseへ含めない。

最後のphraseの自己訂正、言い直し、直前内容の継続である明確な根拠がある場合だけ同じrangeへ含める。長いpause後の新しい話題、別の相手への発話、無関係な会話は`unrelated_speech`として未割当にする。

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

### 13.2 content policy

`content.literal_normalized`を評価baselineとする。常時正規化だけを適用し、英数字表記と読み上げ候補を追加しない。

`content.asr_equivalent_normalized`をchallengerとする。明確な英数字identifier文脈に限り、次を同じ内容候補として扱う。

```text
A17
A seventeen
A one seven
```

identifier文脈は、target tokenが英字と数字を連続して含む、またはID、request ID、code、model名等の明示的な文脈がある場合に限定する。

一般数値では通常の数詞読みを基本とし、digit-by-digit候補をすべての数値へ追加しない。paraphrase、同音語、数量変更、否定、固有名詞、核心語置換は候補へ追加しない。

challengerはidentifier由来のfalse negativeを減らし、数量、否定、固有名詞、核心語の新規content false positiveが0件の場合だけ採用できる。

### 13.3 未固定の計算方式

`content_matched`の意味と人手期待値は本文書で固定する。`content_similarity`の方式、数値閾値、長さ別閾値、重大tokenの重みは、人手ラベル付きcontent評価で比較してから採用する。

方式選定中は次を守る。

- 同じownership spanを各content候補へ入力する。
- playback availabilityをcontent thresholdで変更しない。
- 実装出力のsimilarity値をfixture期待値へコピーしない。
- 個別case名や個別語blacklistで期待値へ合わせない。
- 未採用の`content_similarity`を実装横断順位やcanonical parity必須fieldにしない。

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
  "diagnostic_flags": [],
  "raw_timestamp_word_count": 0,
  "raw_timestamp_segment_count": 0
}
```

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

## 17. fixtureとadjudication

### 17.1 fixtureの役割

- legacy fixture: 過去の不具合と旧契約の履歴。canonical変換前は総合順位へ加算しない。
- implementation-origin challenge set: 各実装が発見した問題領域。canonical期待値を人手で付け、両実装へcross-runする。
- canonical evaluation set: 候補選定後まで未使用にし、実行前に入力、期待値、対象policy、除外条件、SHA-256を固定する。
- ambiguous/adjudication-required set: 発話意図を入力だけから一意に決められないケース。総合順位から除外する。

実装ごとに異なる期待値を作らない。実装結果を見た後に期待値を変更したケースは、そのroundの独立評価から外してchallenge setへ移す。

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

### 17.3 部分重複negative

既存第2弾データの`partial_overlap_negative` 12件は、旧期待値を自動的に維持せず、また両profileで自動的にplayableへ変更しない。

これらは、次のどちらかをtimestampと文字列だけから確定できない。

- target phraseを大きく言い間違えた実際の試行
- targetと一部だけ重なる無関係な追加発話

各caseへ人手で次の`attempt_intent`を付ける。

- `relevant_attempt`
- `unrelated_speech`
- `ambiguous`

`ambiguous`はprofile順位から除外する。人手ラベルがない間は`adjudication_required`として扱い、canonical pass/failを付けない。

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
- zero-durationと境界フィラー

content pilotには少なくとも次を含める。

- 常時正規化後の一致
- `A17`、`A seventeen`、`A one seven`
- 一般数値とidentifierの区別
- 核心語、数量、否定、固有名詞の置換
- 中国語の同音字、近音字、声調由来の別漢字
- paraphraseと類義語

### 18.3 小規模試行

pilotで次を満たした軸だけ、50〜100件の小規模試行へ進める。

- canonical core違反がない。
- 両実装を同じ意味で評価できるschemaがある。
- adapterがownership、文字、時刻等の挙動差を隠していない。
- profile間に測定可能な差がある。
- 個別case名や個別語blacklistへ依存しない。

差がなく複雑さだけが増える場合は、単純なbaselineを採用する。

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

各軸の採用候補だけを結合し、integration challenge setで確認する。その後、最後まで未使用のcanonical evaluation setで最終確認する。

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

## 19. policy選定規則

- ownershipで同程度なら`ownership.conservative`を採用する。
- balancedは複数の関連発話を追加回収し、confirmed unrelated speechの新規false positiveが0件の場合だけ採用できる。
- contentで同程度なら`content.literal_normalized`を採用する。
- ASR等価profileはidentifier false negativeを減らし、新しい重要content false positiveが0件の場合だけ採用できる。
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

現行APIの`ranges`を維持するため、配列名だけの破壊的変更は行わない。旧`source=words|segments|none`は、意味を確認した上で`text_source`と`timestamp_source`へ分離する。

## 21. 採用完了条件

本文書を既存SPECの正へ昇格し、実装変更へ進む前に次を完了する。

1. 固定coreとschemaの人手確認。
2. target phrase splitter専用fixtureの作成。
3. canonical schema adapterの検証。
4. `partial_overlap_negative`のattempt intent adjudication。
5. ownership pilotと必要な小規模試行。
6. content人手ラベルpilotと必要な小規模試行。
7. 採用policyの決定。
8. 未使用canonical evaluation setの期待値とSHA-256固定。
9. 採用候補のPython/Worker parity確認。
10. 既存SPEC、schema、実装、fixture、UIを同じ変更単位で同期する移行計画。

採用手続きが完了するまで、既存fixtureを本文書へ合わせて一括更新せず、実装も本文書へ適合済みとは報告しない。
