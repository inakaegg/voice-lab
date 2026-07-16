# SpeakLoop フレーズ比較再生 canonical contract（提案）

更新日: 2026-07-16

状態: 比較・合意用の提案。現時点では既存の [SPEC.md](SPEC.md) を置き換えず、実装と既存fixtureの正ともみなさない。

関連文書:

- [PRACTICE_ALIGNMENT_POLICY_PROFILES.md](PRACTICE_ALIGNMENT_POLICY_PROFILES.md)
- [SPEC.md](SPEC.md)
- [LEARNING_ROADMAP.md](LEARNING_ROADMAP.md)

## 1. 目的

この文書は、SpeakLoopのお手本音声と学習者の復唱音声をtarget phrase単位で比較再生するために、「何を正しい結果とするか」を実装方式から独立して定義する。

Python版とCloudflare Worker版、または異なるalignment方式を比較するときは、各実装の現在の出力や既存テストを正解にせず、この契約へ正規化した結果を同じfixtureで評価する。

この契約が固定するのは次である。

- 入力状態の解釈
- target phraseとASR timestamp単位の所有関係
- 再生可能性、内容一致、位置の信頼度、境界根拠の意味
- zero-duration、無音、矛盾payload、未割当発話の扱い
- API、UI、diagnostics、Python/Worker parityの不変条件
- legacy fixture、実装由来challenge set、canonical評価データの役割

## 2. この文書で固定しないもの

次はcanonicalな正解そのものではなく、実装設計または評価後の採用判断として別に扱う。

- SequenceMatcher、LCS、Levenshteinなどの文字列類似度アルゴリズム
- DP、anchor partition、forced alignmentなどの探索方式
- 候補生成、score cache、枝刈り、上限値
- pause、文字類似度、coverageの数値閾値
- `content_similarity`の計算式と丸め
- 内部クラス、関数、fieldの実装上の命名
- 性能最適化の具体的手段

性能、改善数、悪化数、false positive、false negative、複雑さを比較した後に採用した方式は、設計判断または評価記録へ残す。canonical contractへ採用実装の内部構造を書き戻さない。

## 3. 用語

### 3.1 target phrase

target textをcanonical target phrase splitterで分割した、比較再生の最小slot。phrase indexはtarget順の0始まりとする。

### 3.2 transcription

ASR providerが正式な認識本文として返した文字列。timestamp payload内部のword/segment textとは区別する。

### 3.3 timestamp unit

ASRが返した `words[]` の1要素。英語のwordだけでなく、中国語の文字または複数文字単位を含み得るが、この文書ではAPI上の配列名に合わせてwordと呼ぶ。

### 3.4 assignment

有効なwordまたはsegment textが、どのtarget phraseの試行として発話されたかという所有関係。内容が正しいか、音声を再生できるかとは別概念である。

### 3.5 playable / `available`

実在する正の長さのtimestamp rangeを使って、そのphraseに対応する音声を比較再生できること。

### 3.6 content match / `content_matched`

canonicalな文字正規化後に、発音対象の文字内容がtarget phraseへ十分一致していること。意味が近いこと、phrase位置が分かること、音声を再生できることとは別概念である。

### 3.7 alignment confidence

対象音声またはtext-only tokenが、該当target phraseの試行であるという位置・所有判断の信頼度。発音内容の正確さではない。

### 3.8 boundary source

phrase rangeの開始・終了または所有位置を決めた根拠。confidenceとは別fieldにする。

## 4. 入力と責任境界

alignment coreは少なくとも次を受け取る。

- `target_text`
- `target_language`
- `recognized_text`: 正式transcription
- `asr_timestamps.available`
- `asr_timestamps.words[]`
- `asr_timestamps.segments[]`
- 入力が学習者attemptかreference音声かを表すrole

target phrase splitterはalignment coreの前段にあり、ASR側の句読点をtarget phraseの正として使用しない。word/segment timestampは実音声位置の証拠であり、target phrase数を変更しない。

## 5. target phrase splitter

target phrase splitterはalignment方式と分離したcanonical部品として扱う。

- target textの文末記号、読点、カンマ、セミコロン等をphrase境界の基準にする。
- email address内のperiodをphrase境界にしない。
- 小数、version番号、URL等の内部periodをphrase境界にしない。
- `Ms.`、`Mr.`、`Dr.`等、文中の略語終端を無条件にphrase境界にしない。
- protected patternの後に本当の文末記号が続く場合は、文末として分割する。
- ASR transcriptionの句読点は、word間pauseやsegmentと同様に境界の補助証拠として使用できるが、target phrase一覧を作り直さない。

splitterの期待結果は専用fixtureで検証する。splitter不一致によってtarget phrase数が変わったケースを、alignment方式の品質スコアへ混ぜない。

## 6. 入力状態の判定

### 6.1 正常なevaluated attempt

正式transcription、または有効なword/segment timestampに発話内容があり、provider応答が矛盾していないattemptは `outcome=evaluated` とする。

### 6.2 no-speech attempt

次をすべて満たす学習者attemptは `outcome=no_speech` とする。

- 正規化後の正式transcriptionが空
- 有効なword timestampが空
- 有効なsegment timestampが空
- 矛盾したprovider payloadではない

no-speechでは次を行わない。

- score、grade、diff、phrase matchの通常結果生成
- 学習者音声とのphrase比較または全体比較の自動開始
- 空発話を0点の通常attemptとして保存・表示

UIは再録音を案内し、お手本単独の再生だけを許可する。

### 6.3 reference側の空ASR

reference音声の正式transcriptionと有効timestampが空の場合は、学習者attemptの `no_speech` として扱わない。お手本生成、音声読込、ASRまたはproviderのエラーとして処理し、比較成功に見せない。

### 6.4 `available=false`と内包dataの矛盾

`asr_timestamps.available=false` は、timestampを再生境界へ使えるかについて正とする。

内部にwordsまたはsegmentsが残っていても、次には使用しない。

- `matched_text`
- content normalization、`content_matched`、類似度
- phraseへのword/segment割当
- `audio_start`、`audio_end`

内部dataはprovider応答の調査用raw diagnosticsとしてだけ扱い、canonical alignment resultでは件数と `contradictory_timestamp_payload` flagを記録する。Cloudflare公開版は、この契約を理由にraw音声や個人情報を新たに永続保存しない。

正式transcriptionが空で、`available=false`かつ内部words/segmentsだけが存在する場合は `no_speech` ではない。矛盾したprovider応答として処理エラーにする。

正式transcriptionが非空で `available=false` の場合、内容評価は正式transcriptionを使えるが、phrase別の再生rangeは作らない。timestamp内部textを正式transcriptionの代用にしない。

## 7. canonical result schema

canonical contract versionは、提案採用時に固定する。提案中の仮称は `practice_alignment_canonical_v1` とする。

### 7.1 top-level result

```json
{
  "contract_version": "practice_alignment_canonical_v1",
  "outcome": "evaluated",
  "target_language": "en-US",
  "target_phrase_count": 2,
  "playable_phrase_count": 1,
  "all_phrases_playable": false,
  "unassigned_non_filler_count": 0,
  "complete": false,
  "ranges": [],
  "diagnostics": {}
}
```

`outcome`は通常attemptの `evaluated` または無音attemptの `no_speech` とする。provider errorは成功resultのoutcomeへ押し込めず、API/jobのエラーとして扱う。

`no_speech`では `ranges=[]` とし、`target_phrase_count`だけを保持する。通常alignmentと同じ形のunavailable rangeを生成して、0点attemptに見せない。

### 7.2 phrase range

```json
{
  "index": 0,
  "target": "Open the API console.",
  "normalized_target": "open the api console",
  "assignment_status": "assigned",
  "available": true,
  "matched_text": "Open the A P I console",
  "content_matched": true,
  "alignment_confidence": "high",
  "boundary_sources": ["text_anchor", "utterance_edge"],
  "timestamp_source": "words",
  "word_start_index": 0,
  "word_end_index": 5,
  "audio_start": 0.12,
  "audio_end": 1.36
}
```

### 7.3 `assignment_status`

- `assigned`: phrase所有が決まり、正の長さの実音声rangeもある。
- `text_only`: phrase所有は決まるが、安全な正の長さの実音声rangeがない。
- `unassigned`: phraseへ割り当てる十分な根拠がない、またはphrase自体が発話されていない。

`assignment_status=text_only`は `available=false` とするが、所有位置が一意なら `alignment_confidence`を持てる。

### 7.4 `available`

`available=true`は、次をすべて満たす場合だけ許可する。

- `assignment_status=assigned`
- `audio_start`と`audio_end`が実timestamp由来
- `audio_start < audio_end`
- rangeが該当phrase所有word/segmentの実時間を超えない
- 他phraseのrangeと重複しない

`available=false`では `audio_start=null`、`audio_end=null` とする。

### 7.5 `matched_text`

phraseが所有する有効wordまたはsegment textを入力順に連結する。

- zero-duration wordも所有していれば含める。
- phrase内部の言い淀み、どもり、言い直し、自己訂正を理由なく削除しない。
- 未割当token、明確な境界フィラー、矛盾payload内部のraw wordを含めない。
- `text_only`でも所有する文字列を保持する。
- `unassigned`では空文字列とする。

### 7.6 `content_matched`

`assigned`または`text_only`で、canonical content contractに照らして発音対象の文字内容が一致したかを表す。`unassigned`では `null` とする。

具体的な数値類似度方式と閾値は、policy評価完了までcanonicalへ固定しない。この期間は人手で固定した `expected_content_matched` を正とし、実装が返す `content_similarity`値は比較候補diagnosticとして扱う。

### 7.7 `alignment_confidence`

値は `high`、`medium`、`low`、または `null` とする。

- `high`: phrase所有位置が一意で、競合する説明がない。
- `medium`:複数の独立根拠が整合するが、一部に弱い証拠がある。
- `low`: 構造上の所有先は選べるが、文字一致または片側境界が弱い。
- `null`: phraseが発話されていない、または所有先を決められない。

contentの正誤をconfidenceへ混ぜない。`text_only`でも所有位置が一意なら `high` を許可する。

### 7.8 `boundary_sources`

根拠を配列として保持し、confidenceの代わりに使用しない。canonical値は次とする。

- `text_anchor`
- `neighbor_anchors`
- `pause`
- `asr_segment`
- `single_phrase`
- `utterance_edge`

複数の根拠を使用した場合は、出力順を上記のcanonical順へ揃える。

### 7.9 word index

`word_start_index`は含み、`word_end_index`は含まない半開区間 `[word_start_index, word_end_index)` とする。

- `assigned`またはword所有が分かる `text_only`で設定する。
- segmentだけを使う場合は両方 `null` とし、segment indexを別diagnosticで保持できる。
- `unassigned`では両方 `null` とする。
- 同じword indexを複数phraseへ割り当てない。

### 7.10 `complete`

`complete`は既存互換のderived fieldとして次で定義する。

```text
complete = all_phrases_playable && unassigned_non_filler_count == 0
```

各fieldは次の意味を持つ。

- `playable_phrase_count`: `available=true`のtarget phrase数
- `target_phrase_count`: target phrase総数
- `all_phrases_playable`: 両者が等しいか
- `unassigned_non_filler_count`: 説明可能な境界フィラー以外の未割当word数

UIは `complete` だけから再生modeを決めない。

## 8. phrase所有の不変条件

実装方式とpolicy profileにかかわらず、次を守る。

- phrase rangeはtarget phrase順に並ぶ。
- available rangeのword indexとaudio timeは単調増加する。
- 同じword、zero-duration word、segmentを複数phraseへ重複割当しない。
- 実在しないtimestampを文字数比、固定padding、推測で作らない。
- 高信頼range間の非フィラーwordを説明なく落とさない。
- 完全に無関係で構造根拠のない発話を、空きslotだけを理由に強制割当しない。
- target phraseに強く一致するwordを、別phraseのgap埋めへ使わない。
- 後続targetへ進んだ後の戻り発話を、時間を逆行させて先行rangeへ追加しない。
- `complete=true`で説明不能な内部の非フィラー未割当wordを残さない。

## 9. assignmentの基本規則

### 9.1 単一phrase

録音全体が一回のtarget試行と判断できるため、明確な録音端フィラーを除いた正時間の発話全体をplayableにする。

- 内容がtargetと大きく違っても `available=true`を許可する。
- 内容差は `content_matched=false` として表す。
- 矛盾payloadやno-speechからrangeを作らない。

### 9.2 前後anchorに挟まれた発話

前後の高信頼phrase rangeに挟まれ、target順と矛盾せず、他targetへ強く一致しない発話は、文字内容が異なっても中央slotの構造的な試行として割り当てられる。

前後anchorだけで常に割り当てるのではなく、間に複数の未発話slotがある場合、別話題を示す証拠がある場合、または一意なpartitionを決められない場合は `unassigned` とする。

### 9.3 片側anchor

片側anchorだけの低一致発話は、録音端、pause、空きslot、genericな接続語のいずれか1つだけで割り当てない。

根拠は次の群へ分ける。

- 文字根拠: targetの実質部分との一致、訂正・言い直し対象との関係
- 境界根拠: ASR segment、明確なphrase間pause
- 近傍根拠: 前後または片側の高信頼anchor
- 順序根拠: target順、slot占有、他targetとの非競合

採用profileは [PRACTICE_ALIGNMENT_POLICY_PROFILES.md](PRACTICE_ALIGNMENT_POLICY_PROFILES.md) で比較する。どのprofileでも、順序と空きslotだけを独立根拠2つとは数えず、少なくとも文字根拠または境界根拠を要求する。

### 9.4 target完了後の追加発話

全target phraseが割り当て済みの後に続く発話は、録音末尾にあるだけでは最後のphraseへ含めない。

最後のphraseの言い直し、自己訂正、直前内容の継続である構造的根拠がある場合だけ同じrangeへ含める。長いpause後の新しい話題、別の相手への発話、targetと関係しない会話は `unrelated_speech` として未割当にする。

### 9.5 抜け、逆順、戻り発話

- 発話されていないtarget phraseへtimestampを捏造しない。
- target順と逆の発話を、全phraseが揃うように並べ替えて割り当てない。
- 後続phraseへ進んだ後に先行phraseを再発話した場合、時間順を破って先行rangeへ結合しない。
- 戻り発話は `out_of_order_speech` として未割当にするか、後続phraseの言い直しである明確な根拠がある場合だけ後続rangeへ含める。

## 10. filler、どもり、言い直し

- 文頭、文末、phrase境界の明確なフィラーは再生rangeから除外できる。
- 除外したフィラーもdiagnosticsから削除しない。
- target phrase自体に含まれる語を、表面的にフィラー語と同じという理由だけで削除しない。
- phrase内部の言い淀み、どもり、語の反復、false start、自己訂正、完全な言い直しは、そのphraseの試行として位置が決まる限りrangeへ含める。
- 単なる反復を境界フィラー扱いしない。
- genericな `then`、`然后` 等は、単独ではphrase ownershipの根拠にしない。

fillerの言語別集合と判定条件は、個別語の無制限なblacklistではなく、位置と周辺構造を含む設計判断として管理する。

## 11. zero-duration word

`start == end` のwordは文字列alignmentと所有判断から削除しない。

### 11.1 同じphraseに正時間wordがある場合

- zero-duration wordを `matched_text`へ含める。
- `word_start_index` / `word_end_index`の所有範囲へ含める。
- `zero_duration_tokens`へ記録する。
- `audio_start` / `audio_end`は、同じ所有範囲内の正時間wordだけから決める。

### 11.2 phraseがzero-duration wordだけの場合

- `assignment_status=text_only`
- `available=false`
- `matched_text`へ所有文字列を保持
- `audio_start=null`
- `audio_end=null`
- 所有位置が一意なら `alignment_confidence`を保持

前後phraseの音声を借りて正時間rangeを作らない。zero-duration wordを前後phraseへ重複割当しない。

## 12. content contract

### 12.1 常に行う正規化

- Unicode互換上の全角・半角差
- 英字の大文字・小文字
- 発音対象でない句読点、記号、空白
- 中国語の簡体字・繁体字の字形差

簡体字・繁体字は字形変換に限定し、台湾語彙を中国大陸語彙へ言い換える等の地域語彙変換を行わない。

### 12.2 ASR等価候補

英数字identifierの文脈では、表記と読み上げ候補を同じ内容として許容できる。

例:

```text
A17
A seventeen
A one seven
```

targetに英字と数字が連続するidentifierがある、またはID、code、request ID等の文脈でidentifierと明確に判断できる場合に限定する。一般数値は通常の数詞読みを基本とし、digit-by-digit展開を全入力へ無条件に適用しない。

### 12.3 一致扱いしないもの

- paraphrase
- 類義語への置換
- 中国語の同音字、近音字
- 声調差により別漢字として認識されたもの
- 核心語の置換
- 数量、否定、固有名詞等、内容を変える置換

これらがあっても構造上のphrase ownershipと再生可能性は失わせない。`content_matched=false` として比較再生できる場合がある。

### 12.4 計算方式の選定前契約

`content_matched`の意味と人手期待値はcanonicalとして固定する。一方、`content_similarity`のアルゴリズム、閾値、丸めは、人手ラベル付き専用評価で比較するまで固定しない。

方式未選定中は次を守る。

- `content_similarity`をPython/Worker canonical parityの必須fieldにしない。
- 実装ごとの値をfixture期待値へ写して正解にしない。
- playback availabilityの判定へcontent thresholdを流用しない。
- 核心語等の個別blacklistだけで人手期待値へ合わせない。

## 13. diagnostics

canonical diagnosticsは、少なくとも次を持つ。

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

未割当tokenのcanonical理由は次を含む。

- `boundary_filler`
- `unrelated_speech`
- `ambiguous_assignment`
- `out_of_order_speech`
- `no_positive_duration`

`contradictory_timestamp_payload`ではraw words/segmentsをcanonical token ownershipへ入れず、件数とflagを記録する。個々のraw内容を保存する場合も既存のローカル診断境界内に限定し、Cloudflare公開版の永続保存を増やさない。

候補数、score計算数、anchor数、内部探索理由、処理時間は実装評価に有用だが、アルゴリズム非依存のcanonical parity fieldではない。両runtimeが同じ方式を実装する段階では、決定的な内部diagnosticだけを追加のparity対象にできる。wall-clock時間はparity対象にしない。

## 14. Python / Cloudflare Worker parity

同じcanonical profileを実装するPython版とWorker版は、同じ入力に対して次を一致させる。

- `outcome`
- target phrase数と順序
- `assignment_status`
- `available`
- `matched_text`
- `content_matched`（方式採用後）
- `alignment_confidence`
- `boundary_sources`
- `timestamp_source`
- word index範囲
- `audio_start` / `audio_end`
- derived countと`complete`
- canonicalな未割当理由とzero-duration診断
- deterministicなdiagnostic flags

処理時間、provider固有metadata、任意の内部候補score、方式選定前の `content_similarity` はcanonical parity対象から除外する。

## 15. UI playback contract

UIは、お手本側と学習者側の両方で `available=true` の同じphrase indexだけをpaired rangeとして使用する。

- 全target phrase indexがpaired: `phrase` / `フレーズごと比較再生`
- 一部だけpaired: `partial_phrase` / `一部フレーズ比較再生`
- paired rangeなしで両音声あり: `whole` / `全体比較再生`
- no-speech、復唱音声なし、結果未表示: お手本単独の `model` / `再生`

表示ラベルと実際の再生経路は同じplayback planから導く。`complete`だけでmodeを決めない。

区間再生はcanonical `audio_end`ちょうどで停止し、固定の早止めやpaddingを加えない。隣接区間の時刻を越えない。

## 16. fixtureと評価の契約

### 16.1 legacy fixture

過去の実装契約と回帰履歴を保存する。旧single-gate等、現在のcanonical contractと衝突する期待値を含み得るため、無条件に総合順位へ加えない。

### 16.2 implementation-origin challenge set

各実装の失敗・得意領域から発見した入力を集める。期待値はその実装の出力から作らず、canonical contractから決める。すべての実装へcross-runする。

### 16.3 canonical evaluation set

- 入力、期待値、schema、除外条件を実行前に固定する。
- SHA-256を記録する。
- 実装結果を見た後に期待値を変更したケースは、同じroundの独立評価から外す。
- ownership、content match、splitter、API/UI、性能を一つの総合点へ混ぜず、別軸で報告する。
- Python/Worker parityは正しさの得点ではなく、同じ実装契約を再現したことの検証として分離する。

### 16.4 ambiguous case

canonical contractだけで所有先を一意に決められないケースは `adjudication_required` とし、実装比較の総合点から分ける。曖昧な期待値を各実装に合わせて別々に作らない。

## 17. policy profileの選定

固定core以外の候補は [PRACTICE_ALIGNMENT_POLICY_PROFILES.md](PRACTICE_ALIGNMENT_POLICY_PROFILES.md) で定義する。

- ownershipは `conservative` と `balanced` を同じownership評価データで比較する。
- contentは `literal_normalized` と `asr_equivalent_normalized` を同じ人手ラベルで比較する。
- ownershipとcontentは別fieldなので、各軸を独立に評価する。
- 結果が同程度なら、規則が少なくfalse positiveを抑える候補を採用する。
- profile採用後、この提案を更新し、採用profileだけをcanonical contractの正にする。

## 18. 既存実装との接続

既存実装のfield名や値体系がcanonical schemaと異なる場合、比較runnerでadapterを使用できる。adapterは名前、enum、半開index、derived fieldを機械的に正規化するだけとし、phrase ownership、文字列、時刻、availability等の挙動差を補正しない。

実装固有の出力にcanonical期待値を合わせず、canonical contractに適合しない挙動は差分として報告する。

## 19. 提案の完了条件

この文書をcanonicalな正へ昇格する前に、次を完了する。

- 別実装から独立に作成したcontract案との差分確認
- 固定coreの合意
- ownership profileのpilot比較
- content人手ラベルpilotと正規化profile比較
- target phrase splitter専用fixtureの作成
- canonical schema adapterの検証
- canonical evaluation setの期待値固定とSHA記録
- 採用profileと未解決範囲の明記
