# SpeakLoop フレーズ比較アラインメント canonical SPEC 統合最終案

更新日: 2026-07-16

> **Status: Final Proposal / 未採用**
> 本文書は、独立に作成した2つのcanonical SPEC案を比較・統合した最終提案である。合意と評価が完了するまでは、既存の [SPEC.md](SPEC.md)、実装、fixtureの正を置き換えない。

関連文書:

- [policy profile統合最終案](PRACTICE_ALIGNMENT_POLICY_PROFILES_FINAL_PROPOSAL.md)
- [評価・移行計画](PRACTICE_ALIGNMENT_EVALUATION_PLAN.md)
- 比較元: [canonical contract案](PRACTICE_ALIGNMENT_CANONICAL_SPEC.md)
- 現行全体仕様: [SPEC.md](SPEC.md)

## 1. 目的

SpeakLoopでは、お手本音声と学習者の復唱音声を、目標文から得た同じtarget phrase単位で比較再生する。本書は、異なるalignment実装を同じ製品契約で比較できるように、次を実装方式から独立して固定する。

- target phraseとASR tokenの所有関係
- phraseに対応する実音声を安全に再生できるか
- 発音対象の文字内容がtarget phraseと一致するか
- text-only、未割当、zero-duration、無音、provider応答矛盾の扱い
- canonicalな出力schemaとdiagnostics
- Python版とCloudflare Worker版のparity範囲
- UIの表示modeと実再生経路の契約

実装の現在値、既存fixtureの期待値、テスト成功数を、製品として正しい出力の根拠にはしない。

## 2. canonicalへ固定しないもの

次は実装設計または評価後の採用判断であり、本書では正解として固定しない。

- SequenceMatcher、LCS、Levenshtein等の文字列比較方式
- DP、anchor partition、forced alignment等の探索方式
- 候補生成、cache、枝刈り、探索上限
- pause、coverage、文字類似度の数値閾値
- `content_similarity`の計算式、閾値、丸め
- ASR provider固有の内部metadata
- 内部関数、クラス、候補scoreの命名
- 性能最適化の具体的手段

これらは同じデータで改善数、悪化数、false positive、false negative、処理時間、資源消費、複雑さを比較してから選ぶ。

## 3. 用語

### 3.1 target phrase

target textをcanonical target phrase splitterが分割した、比較再生の最小slot。phrase順と`source_index`はtarget側を正とし、ASR側の句読点から作り直さない。

### 3.2 transcription

ASR providerが正式な認識本文として返した文字列。timestamp payload内部のword/segment textとは区別する。

### 3.3 ASR token

`asr_timestamps.words[]`の1要素。英語のwordだけでなく、中国語の文字または複数文字単位を含み得る。

### 3.4 assignment

ASR tokenの連続した半開区間を、1つのtarget phraseへ所有させること。内容の正しさ、音声再生可否とは別概念である。

### 3.5 playable / `available`

実在する正の長さのtimestamp rangeにより、そのphraseの音声を安全に比較再生できること。

### 3.6 `content_matched`

canonicalな正規化後に、所有文字列の発音対象内容がtarget phraseと一致していること。意味類似、phrase位置、再生可否、音響的な発音品質は表さない。

### 3.7 text-only

target phraseへの文字上の所有位置は一意だが、安全な正時間rangeを作れない状態。文字と所有関係は保持するが比較再生には使わない。

### 3.8 alignment confidence

tokenまたはtext-only文字列が該当target phraseの試行であるという、位置・所有判断の信頼度。発音内容の正確さではない。

### 3.9 boundary source

phraseの所有位置または再生境界を決めた根拠。confidenceとは別fieldにする。

## 4. 責任境界

処理責任は次のように分ける。

1. target phrase splitterがtarget textを順序付き`target_phrases`へ分割する。
2. ASR adapterが正式transcriptionとtimestamp payloadをcanonical入力へ正規化する。
3. alignment coreがtarget phraseとASR tokenの所有関係を決める。
4. content evaluatorが所有済み文字列の内容一致を判定する。
5. APIがattempt、reference、provider error、no-speechを製品状態へ変換する。
6. UIがattempt/referenceのcanonical resultからplayback planを作る。

alignment coreはASRの句読点でtarget phrase数を変更せず、content thresholdで再生可否を変更しない。

## 5. target phrase splitter

splitterはalignment方式から分離したcanonical部品とする。

- target textの文末記号、読点、カンマ、セミコロン等を境界の基準にする。
- email address内のperiodをphrase境界にしない。
- 小数、version番号、URL内のperiodをphrase境界にしない。
- `Ms.`、`Mr.`、`Dr.`等の略語終端を無条件にphrase境界にしない。
- protected pattern後の本当の文末記号は文末として扱う。
- ASR句読点はpauseやsegmentと同様に境界の補助証拠にできるが、target phrase一覧を作り直さない。

splitterは専用fixtureで検証する。splitter不一致によりtarget phrase数が違うケースを、alignment方式の品質スコアへ混ぜない。

## 6. ASR入力と状態判定

概念上の入力は少なくとも次を持つ。

```json
{
  "role": "attempt",
  "target_phrases": ["Good morning.", "How are you?"],
  "transcription": "Good morning. How are you?",
  "asr_timestamps": {
    "available": true,
    "words": [
      { "text": "Good", "start": 0.1, "end": 0.4 },
      { "text": "morning", "start": 0.4, "end": 0.8 }
    ],
    "segments": []
  }
}
```

実再生時刻は次を満たすtimestampだけから作る。

- `asr_timestamps.available=true`
- startとendが有限値
- `end >= start`
- 再生range全体で`audio_end > audio_start`

文字数比、録音全長比、固定padding、隣接phraseの時刻から再生rangeを捏造しない。

### 6.1 evaluated attempt

正式transcriptionまたは利用可能なtimestampに発話内容があり、provider応答が矛盾していないattemptは`outcome=evaluated`とする。

### 6.2 no-speech attempt

次がすべて空のattemptは`outcome=no_speech`とする。

- 正規化後の正式transcription
- 利用可能なwords
- 利用可能なsegments

no-speechではscore、grade、diff、通常のphrase result、学習者音声との比較再生を生成しない。UIは再録音を案内し、お手本単独再生だけを許可する。

### 6.3 reference側の空ASR

reference側の正式transcription、利用可能なwords、segmentsがすべて空の場合は、attemptのno-speechにしない。お手本生成、音声読込、ASRまたはprovider errorとして扱い、比較成功に見せない。

### 6.4 `available=false`との矛盾

`asr_timestamps.available=false`は再生境界について正とする。内包words/segmentsはraw diagnosticsにのみ保持でき、次には使わない。

- `matched_text`
- content normalization、類似度、`content_matched`
- phraseへのtoken割当
- `audio_start`、`audio_end`

正式transcriptionが空で、`available=false`なのにraw words/segmentsだけが存在する場合は、no-speechではなく`contradictory_timestamp_payload` provider errorにする。

正式transcriptionが非空で`available=false`の場合:

- 単一phraseでは、正式transcription全体の所有先が一意なため`text_only`にできる。
- 複数phraseでは、正式transcriptionだけからphrase別所有位置や時刻を推測しない。各phraseは`unassigned`、`content_matched=null`とし、全体transcriptionはalignment外の通常認識結果として保持できる。
- providerが別途canonicalなphrase-level text境界を返す将来契約は、versionを上げて扱う。

## 7. canonical core contract

### 7.1 replayabilityと内容一致

- `available`は正時間の実timestamp rangeを比較再生できるかだけを表す。
- `content_matched`は発音対象文字内容の一致だけを表す。
- `content_matched=false`でも、所有位置が構造的に決まるphraseは`available=true`にできる。
- content thresholdを`available`のgateにしない。
- `alignment_confidence`をcontent評価の代用にしない。

### 7.2 単一phrase

target phraseが1件の場合、明確な録音端フィラーを除いた正時間発話全体をその試行のrangeとする。

- 内容が完全に異なっても`available=true`にできる。
- 内容差は`content_matched=false`で表す。
- 所有文字がzero-durationだけなら`text_only`とする。
- 明確なフィラーしか残らない場合は`unassigned`とする。
- 矛盾payloadやno-speechからrangeを作らない。

### 7.3 複数phrase

- phraseとtokenの順序を単調に保つ。
- 各tokenを最大1つのphraseだけへ所有させる。
- 抜けたphraseのために、別phraseへ強く一致するtokenを奪わない。
- 高信頼range間の非フィラーtokenを理由なく落とさない。
- 内部の言い淀み、どもり、自己訂正、完全な言い直しは、所有phraseが一意なら同じrangeへ保持する。
- 文頭、文末、phrase境界の明確なフィラーは未割当にできるが、diagnosticsから削除しない。
- genericな`then` / `然后`、録音端、pause、空きslotのいずれか1つだけを根拠に割り当てない。
- 全target phraseが割当済みなら、後続の無関係発話を最後のphraseへ吸収しない。

### 7.4 前後anchorに挟まれた発話

前後の一意な高信頼anchorに挟まれ、間に1つの未発話phraseと1つの連続token spanだけが残る場合、そのspanは中央phraseの試行として所有できる。

内容が異なっても`available=true`、`content_matched=false`にできる。複数slot、複数partition、別話題、他targetへの強一致がある場合は強制割当しない。

### 7.5 片側anchor

片側anchorに隣接する低一致発話は、文字、境界、近傍、順序の異なる根拠群から複数の独立根拠を要求する。少なくとも1つは文字根拠または境界根拠とし、順序と空きslotだけでは割り当てない。

必要な根拠強度は[policy profile統合最終案](PRACTICE_ALIGNMENT_POLICY_PROFILES_FINAL_PROPOSAL.md)で比較する。

### 7.6 target完了後の追加発話

全target phrase割当後の発話は、録音末尾にあるだけでは最後のphraseへ含めない。最後のphraseの言い直し、自己訂正、直前内容の継続を示す根拠がある場合だけ同じrangeへ含める。

長いpause後の新しい話題、別の相手への発話、独立した会話は`unrelated_speech`として未割当にする。

### 7.7 抜け、逆順、戻り発話

- 発話されていないphraseへtimestampを作らない。
- 逆順発話をtarget順へ並べ替えない。
- 後続phraseへ進んだ後の戻り発話を、時刻を逆行させて先行rangeへ結合しない。
- 戻り発話は`out_of_order_speech`として未割当にするか、後続phraseの言い直しである明確な根拠がある場合だけ後続rangeへ含める。

### 7.8 filler、どもり、言い直し

- 文頭、文末、phrase境界の明確なフィラーはrangeから除外できる。
- 除外フィラーもdiagnosticsから消さない。
- target自体に含まれる語を、表面的にフィラー語と同じという理由だけで削除しない。
- phrase内部の言い淀み、反復、false start、自己訂正、完全な言い直しを理由なく削除しない。
- generic connectorをownershipの単独根拠にしない。

fillerは無制限な単語blacklistではなく、位置と周辺構造を含めて判定する。

### 7.9 zero-duration token

`start == end`のtokenを文字、所有関係、diagnosticsから削除しない。

同じphraseに正時間tokenがある場合:

- `matched_text`とtoken index範囲へ含める。
- `zero_duration_tokens`へowner付きで記録する。
- `audio_start` / `audio_end`は同じ所有範囲の正時間tokenだけから決める。

zero-duration tokenだけの場合:

- `assignment_status=text_only`
- `available=false`
- `matched_text`とownerを保持
- `audio_start=null`、`audio_end=null`
- 所有位置が一意なら`alignment_confidence`と`boundary_sources`を保持

前後phraseの音声を借りて正時間rangeを作らない。

## 8. content contract

### 8.1 常時正規化

- Unicode互換表現と全角・半角
- 英字の大文字・小文字
- 発音対象ではない句読点、記号、空白
- 中国語の簡体字・繁体字の字形差

簡体字・繁体字変換は字形差に限定し、台湾語彙を中国大陸語彙へ言い換える等の地域語彙変換を行わない。

### 8.2 一致扱いしないもの

- paraphrase
- 類義語
- 中国語の同音字、近音字
- 声調差により別漢字として認識されたもの
- 核心語、数量、否定、固有名詞等、内容を変える置換

これらがあっても、ownershipとplayabilityは独立して判定する。

### 8.3 英数字identifier

英数字IDと明確に判断できる文脈では、次を同じ内容候補として許容できる。

```text
A17
A seventeen
A one seven
```

一般数値では通常の数詞読みを基本とし、digit-by-digit候補を全入力へ無条件に適用しない。適用範囲はcontent profileで比較する。

### 8.4 未固定の計算方式

`content_matched`の意味と人手期待値はcanonicalにするが、`content_similarity`方式と数値閾値は人手ラベル付き評価後に選ぶ。

- playback availabilityへcontent thresholdを流用しない。
- 実装出力値をfixture期待値へコピーしない。
- 方式選定前の`content_similarity`を実装横断canonical parityの必須fieldにしない。
- 個別の核心語blacklistだけで期待値へ合わせない。

## 9. canonical schema

### 9.1 evaluated result

```json
{
  "alignment_contract_version": 1,
  "outcome": "evaluated",
  "available": true,
  "target_phrase_count": 2,
  "playable_phrase_count": 1,
  "all_phrases_playable": false,
  "unassigned_non_filler_count": 0,
  "complete": false,
  "phrases": [
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
      "word_start_index": 0,
      "word_end_index": 5,
      "audio_start": 0.12,
      "audio_end": 1.36
    }
  ],
  "diagnostics": {
    "unassigned_tokens": [],
    "zero_duration_tokens": [],
    "diagnostic_flags": []
  }
}
```

### 9.2 top-level fields

| field | 型 | 意味 |
| --- | --- | --- |
| `alignment_contract_version` | integer | alignment schema version。provider契約versionとは分ける |
| `outcome` | `evaluated \| no_speech` | attempt alignmentの結果種別 |
| `available` | boolean | `playable_phrase_count > 0`の既存互換derived field |
| `target_phrase_count` | integer | splitterが返したphrase数 |
| `playable_phrase_count` | integer | phraseの`available=true`件数 |
| `all_phrases_playable` | boolean | phraseが1件以上あり、すべてplayableか |
| `unassigned_non_filler_count` | integer | boundary filler以外の未割当token数 |
| `complete` | boolean | 既存互換derived field |
| `phrases` | array | target phrase順の結果。rangeがないphraseも含む |
| `diagnostics` | object | 未割当、zero-duration、矛盾、判定情報 |

top-level `available`と`complete`は互換fieldであり、UI modeや内容一致を決める正にはしない。

### 9.3 phrase fields

| field | 型 | 意味 |
| --- | --- | --- |
| `index` | integer | alignment対象phraseの0始まりindex |
| `source_index` | integer | splitter出力上の元index |
| `target_text` | string | target phrase原文 |
| `assignment_status` | `assigned \| text_only \| unassigned` | 所有状態 |
| `available` | boolean | 正時間rangeを再生できるか |
| `matched_text` | string | 所有tokenまたは単一phrase正式transcriptionの元文字列 |
| `content_matched` | booleanまたはnull | 内容一致。未割当では`null` |
| `alignment_confidence` | `high \| medium \| low \| null` | 所有位置判断の信頼度 |
| `boundary_sources` | array | 所有・境界判断の根拠 |
| `word_start_index` | integerまたはnull | 所有tokenの先頭index。含む |
| `word_end_index` | integerまたはnull | 所有token末尾の次のindex。含まない |
| `audio_start` | numberまたはnull | 実timestamp由来の開始秒 |
| `audio_end` | numberまたはnull | 実timestamp由来の終了秒 |

状態制約:

| status | `available` | text/index | audio |
| --- | --- | --- | --- |
| `assigned` | `true` | `matched_text`を保持。word所有ならindex必須 | `audio_end > audio_start` |
| `text_only` | `false` | `matched_text`と判明しているowner/indexを保持 | 両方`null` |
| `unassigned` | `false` | `matched_text=""`、indexは`null` | 両方`null` |

`content_matched`は`assigned`または`text_only`でboolean、`unassigned`で`null`とする。未評価と内容不一致を混同しない。

segmentだけを再生境界に使った場合、word indexは`null`とし、segment indexとtimestamp sourceはdiagnosticsに保持できる。

### 9.4 alignment confidence

- `high`: 強い文字anchorまたは一意な前後anchorがあり、競合する所有先がない。
- `medium`: 異なる複数の根拠が整合し、位置は一意だが強い全文字anchorではない。
- `low`: 構造上の所有先は一意だが、文字または片側境界の根拠が弱い。
- `null`: 所有先を決めていない。

contentの正誤をconfidenceへ混ぜない。text-onlyでも所有位置が一意なら`high`を許可する。

### 9.5 boundary sources

canonical値と出力順は次とする。

1. `text_anchor`
2. `neighbor_anchors`
3. `pause`
4. `asr_segment`
5. `single_phrase`
6. `utterance_edge`

複数値を並べること自体を、独立根拠の成立証明にしてはならない。

### 9.6 word indexとaudio range

- `word_start_index`は含み、`word_end_index`は含まない半開区間とする。
- 同じtoken indexを複数phraseへ割り当てない。
- assigned phraseのindexとaudio timeは単調増加し、重複しない。
- `available=true`なら`audio_start < audio_end`である。
- `available=false`なら`audio_start`、`audio_end`は`null`である。

### 9.7 `complete`

`complete`は次の既存互換derived fieldとする。

```text
complete = all_phrases_playable && unassigned_non_filler_count == 0
```

UIは`complete`だけからplayback modeを決めない。

### 9.8 diagnostics

canonical diagnosticsは少なくとも次を持つ。

```json
{
  "valid_word_count": 0,
  "assigned_word_count": 0,
  "playable_word_count": 0,
  "unassigned_non_filler_count": 0,
  "unassigned_tokens": [],
  "zero_duration_tokens": [],
  "diagnostic_flags": [],
  "raw_timestamp_word_count": 0,
  "raw_timestamp_segment_count": 0
}
```

`unassigned_tokens`はindex、元文字、start、end、reasonを持つ。canonical reasonは次とする。

- `boundary_filler`
- `unrelated_speech`
- `ambiguous_assignment`
- `out_of_order_speech`
- `no_positive_duration`

`contradictory_timestamp_payload`は通常の成功result内の未割当理由ではなく、provider error codeとdiagnostic flagにする。raw tokenの件数は記録できるが、canonical ownershipへ入れない。

候補数、score計算数、探索時間、provider metadata、timestamp sourceは実装diagnosticsに追加できるが、別実装のcanonical正しさを決めるfieldにしない。

### 9.9 no-speech result

```json
{
  "alignment_contract_version": 1,
  "outcome": "no_speech",
  "available": false,
  "target_phrase_count": 2,
  "playable_phrase_count": 0,
  "all_phrases_playable": false,
  "unassigned_non_filler_count": 0,
  "complete": false,
  "phrases": [],
  "diagnostics": {
    "unassigned_tokens": [],
    "zero_duration_tokens": [],
    "diagnostic_flags": ["no_speech_detected"]
  }
}
```

provider errorは`outcome`へ追加せず、job/API errorとして扱う。

## 10. canonical invariants

profileと実装方式にかかわらず、次を守る。

1. target phrase順を変えない。
2. token indexとaudio timeは単調で、phrase間で重複しない。
3. 1つのtokenを複数phraseへ所有させない。
4. 実在しない時刻を作らない。
5. zero-duration tokenを文字、owner、diagnosticsから消さない。
6. false positiveを隠すために未割当tokenを削除しない。
7. 他phraseへ強く一致するtokenをgap埋めに使わない。
8. `complete=true`で説明不能な内部非フィラーtokenを残さない。
9. `playable_phrase_count`はphraseの`available=true`件数と一致する。
10. `content_matched`をplayabilityのgateにしない。
11. PythonとCloudflare Workerは採用済みcanonical fieldと決定的diagnosticsで一致する。

## 11. Python / Cloudflare Worker parity

同じprofileと方式を実装するPython版とWorker版は、同じ入力に対して次を一致させる。

- `outcome`
- phrase数、順序、target text
- `assignment_status`
- `available`と集計値
- `matched_text`
- 採用方式の`content_matched`
- `alignment_confidence`
- `boundary_sources`
- token index
- audio range
- `complete`
- canonicalな未割当理由、zero-duration owner、diagnostic flags

処理時間、provider metadata、任意の内部候補score、方式選定前の`content_similarity`は実装横断canonical parityから除外する。同じアルゴリズムを両runtimeへ移植した後は、その方式内の回帰fieldとして追加比較できる。

## 12. UI playback contract

UIはattemptとreference双方で`available=true`の共通phrase indexを昇順に求める。表示ラベルと実再生経路は同じplayback planから導く。

| 条件 | mode | 表示 |
| --- | --- | --- |
| attemptがno-speech、復唱音声なし、結果未表示 | `model` | `再生` |
| 共通indexが全target phrase | `phrase` | `フレーズごと比較再生` |
| 共通indexが1件以上、全件未満 | `partial_phrase` | `一部フレーズ比較再生` |
| 共通indexが0件で両音声あり | `whole` | `全体比較再生` |

- `complete`、`content_matched`、認識言語の推測でmodeを変更しない。
- phrase playbackはreference phrase、attempt phraseの順で交互再生する。
- `audio_start`から`audio_end`ちょうどまで再生する。
- 固定の早止め、padding、文字数比rangeを加えない。
- reference/provider error時は比較modeへ進まない。

## 13. fixtureと評価

fixtureの役割、既存データの再分類、pilot、SHA固定、停止条件は[評価・移行計画](PRACTICE_ALIGNMENT_EVALUATION_PLAN.md)を正とする。

原則:

- legacy fixtureを無条件に総合順位へ使わない。
- implementation-origin challenge setは全実装へcross-runする。
- canonical evaluation setは実行前に期待値とSHA-256を固定する。
- ambiguous caseは総合スコアから分離する。
- ownership、content、splitter、parity、UI、performanceを別々に測る。
- 実装結果を見て期待値を変更したデータを未使用評価と呼ばない。

## 14. 採用までに残る判断

本書で固定coreとschemaの統合案は確定したが、次は評価後に決める。

- `ownership.conservative`と`ownership.balanced`の採用
- `content.literal_normalized`と`content.asr_equivalent_normalized`の採用
- `content_similarity`方式と`content_matched`閾値
- strong textual evidence、明確なpause等を実装へ落とす数値条件
- segment数とphrase数の一致だけを使うfallbackを採用するか

## 15. canonical昇格条件

次を完了した時点で、本書を未採用proposalから正式な正へ昇格できる。

1. 固定coreとschemaを人手で合意する。
2. ownership/content profileを独立した評価で選ぶ。
3. splitter専用fixtureを固定する。
4. legacy/challenge fixtureをcanonical schemaへ再ラベルする。
5. ambiguous caseを分離する。
6. 未使用canonical evaluation setの期待値とSHAを固定する。
7. 同じprofileで各実装をcross-runする。
8. Python/Worker parityとUI playback planを確認する。
9. 採用方式決定後、既存SPEC、実装、fixture、テスト、UIを同じ変更単位で同期する。
