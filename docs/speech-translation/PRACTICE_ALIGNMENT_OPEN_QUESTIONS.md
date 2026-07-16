# SpeakLoop フレーズ比較アラインメント 未決定事項・仕様ギャップ

更新日: 2026-07-16

> **Status: Open Issues**
> 本文書は、独立に作成した2案と統合最終案を比較した後にも残る曖昧さ、仕様の穴、評価待ち事項を一か所で追跡する。ここにある候補を実装の都合だけで決定せず、各項目の完了条件を満たしてからcanonical SPECへ反映する。

関連文書:

- [canonical SPEC統合最終案](PRACTICE_ALIGNMENT_CANONICAL_SPEC_FINAL.md)
- [canonical SPEC統合最終提案](PRACTICE_ALIGNMENT_CANONICAL_SPEC_FINAL_PROPOSAL.md)
- [policy profiles統合最終提案](PRACTICE_ALIGNMENT_POLICY_PROFILES_FINAL_PROPOSAL.md)
- [評価・移行計画](PRACTICE_ALIGNMENT_EVALUATION_PLAN.md)

## 1. この文書が必要な理由

未決定事項の一部は、canonical SPECの採用完了条件、policy profile、評価計画に既に記載されている。しかし、次が分散していた。

- 2つの統合文書間に残るschema・policy差
- 評価で決める事項と、人手で先に決めるべき製品契約の区別
- 不正timestampやprovider error等、通常fixtureだけでは見落としやすい入力契約
- 各未決定事項を閉じるために必要なfixture、判断、反映先

本書はcanonical SPECの代わりではない。決定済み項目は本書から削除せず、決定内容と反映先を記録して`closed`へ移す。

## 2. 優先度

- `P0`: schemaまたは製品挙動を変える。実装適合を始める前に決定する。
- `P1`: policy選定やcanonical evaluation set作成前に決定する。
- `P2`: 実装・運用・診断品質に影響する。正式公開前に決定する。

状態は`open`、`evaluation_required`、`adjudication_required`、`closed`を使用する。

## 3. P0: canonical採用前に決める事項

### GAP-P0-01 canonical文書とschemaの正

状態: `open`

現在、次の2つの統合文書が存在し、どちらも未採用である。

- `PRACTICE_ALIGNMENT_CANONICAL_SPEC_FINAL.md`
- `PRACTICE_ALIGNMENT_CANONICAL_SPEC_FINAL_PROPOSAL.md`

主な差:

| 論点 | `FINAL.md` | `FINAL_PROPOSAL.md` |
| --- | --- | --- |
| phrase配列 | `ranges` | `phrases` |
| contract version | string | integer |
| phrase target field | `target` | `target_text` |
| text/timestamp source | canonical phrase field | 実装diagnostics候補 |
| conservative片側anchor | boundary evidence必須 | textualまたはboundaryを含む複数群 |

決めること:

- 正式なcanonical文書を1つにする。
- 公開API schemaのfield名とversion形式を固定する。
- 互換fieldと新規canonical fieldを区別する。
- 不採用文書へ「履歴案」「superseded」等の状態を明記する。

完了条件:

- 正の文書が1つだけ示されている。
- schema fixtureが同じfield名、型、nullabilityを検査する。
- Python、Worker、UIの移行対象fieldが一覧化されている。

### GAP-P0-02 provider errorのAPI/job契約

状態: `open`

coreでは次をprovider errorとして扱うことは決まっている。

- 正式transcriptionが空で、`available=false`なのにraw words/segmentsだけ存在する
- reference側の正式transcriptionと有効timestampがすべて空

未決定:

- HTTP status、job status、error code、response body
- 同期APIと非同期job APIで同じerror codeを使うか
- retry可能か、入力変更が必要か
- 利用者向け短文と開発者向けdiagnosticsの分離
- raw provider dataをローカル診断へどこまで残すか
- Cloudflare公開版で永続保存しない範囲

完了条件:

- API schemaとUI表示fixtureがある。
- `no_speech`、attempt provider error、reference provider errorを別々に検証する。
- raw dataの保存範囲と保持期間が既存の公開・ローカル方針と一致する。

### GAP-P0-03 不正timestampの扱い

状態: `open`

`available=false`とzero-durationは定義済みだが、次の入力の扱いは十分に固定されていない。

- `start < 0`
- `end < start`
- `NaN`、Infinity、文字列等の非数値
- 音声長を超える`end`
- 入力順が時刻順でないtoken
- 重複・交差するtoken range
- wordsとsegmentsで互いに矛盾する境界
- 同じtokenの重複

決める候補:

1. provider errorとして全体を失敗させる。
2. 明確に安全な範囲だけ正規化し、diagnostic flagを残す。
3. 該当tokenだけ無効化し、残りを評価する。

原則として、時刻clampや並べ替えが元発話の意味を変え得る場合は黙って補正しない。

完了条件:

- 不正timestamp専用fixtureがある。
- 各異常のerror / warning / token除外が決まっている。
- PythonとWorkerで同じ判定になる。
- `audio_start` / `audio_end`が音声実長を越えない。

### GAP-P0-04 空targetとsplitter結果0件

状態: `open`

`no_speech`はattempt側の無音状態だが、次は入力不正であり、同じ状態にしてよいか未定である。

- target textが空
- target textが句読点・空白だけ
- splitterが0 phraseを返す
- target languageが未対応または不明

推奨方向:

- `no_speech`にせずvalidation errorとして扱う。
- target入力の問題とASR結果の問題を分ける。

完了条件:

- API validation、alignment core、UIの各責任が明記される。
- 空targetとattempt無音を別fixtureで検証する。

## 4. P1: policy評価前に決める事項

### GAP-P1-01 conservative片側anchorの根拠要件

状態: `evaluation_required`

統合文書間で次が異なる。

- boundary evidenceを必須にする厳格案
- strong textual evidenceと一意なslotでも許可する案

これは単なるfield名差ではなく、partial leading/trailing utteranceのplayabilityを変える。

必要な評価:

- strong textual + slot、boundaryなし
- boundary + slot、文字一致が低い
- text + boundary
- generic connector + slot
- unrelated speech + pause + slot
- 英語・中国語、先頭・末尾、短文・長文

完了条件:

- false positiveとfalse negativeを別集計する。
- confirmed unrelated speechの新規誤割当を確認する。
- 採用条件をcanonical文書へ1つだけ残す。

### GAP-P1-02 evidence用語の実装可能な定義

状態: `evaluation_required`

次は意味としては妥当だが、まだ実装可能な決定規則になっていない。

- strong textual evidence
- high-confidence anchor
- 明確なpause
- 長いpause
- 独立したASR segment
- 競合する別解
- 別話題、独立した会話

数値閾値を先に固定せず、ラベル付きfixture上で候補を比較する。個別caseを通すための語句blacklistや単発閾値を追加しない。

完了条件:

- 各用語に正例、反例、境界例がある。
- Python/Workerで決定的に再現できる。
- 閾値を変更した場合の改善数・悪化数を測定できる。

### GAP-P1-03 `partial_overlap_negative`のattempt intent

状態: `adjudication_required`

第2弾の12件は、timestampと文字列だけでは次のどちらかを確定できない。

- target phraseを大きく言い間違えた実際の試行
- targetと一部だけ重なる無関係な追加発話

各caseへ次を人手で付与する。

- `relevant_attempt`
- `unrelated_speech`
- `ambiguous`

`ambiguous`はprofile順位から除外する。ラベル前に、全件を一律playableまたはunavailableへ変更しない。

完了条件:

- 12件のintentラベルと判断理由が記録される。
- 判断者が発話意図を確定できないcaseはambiguousのまま残す。
- 同じラベルを両実装へ適用する。

### GAP-P1-04 segment-only alignment

状態: `evaluation_required`

未決定:

- word timestampがなくsegmentだけある場合のownership条件
- segment数とtarget phrase数の一致をどの程度の根拠とするか
- segment textを`matched_text`へ使用する条件
- segmentを境界補助に使った場合と、所有単位に使った場合のdiagnostics
- wordsとsegmentsが同時にある場合の優先順位

segment数とphrase数の一致だけでは自動割当しない。文字、境界、順序の独立根拠を同じfixtureで評価する。

完了条件:

- segment-only、words-only、両方あり、両者矛盾のfixtureがある。
- `text_source`、`timestamp_source`、token index、assigned countの意味が決まる。
- 同じ発話をwordsとsegmentsで二重計上しない。

### GAP-P1-05 content similarity方式と閾値

状態: `evaluation_required`

未決定:

- similarity metric
- `content_matched`閾値
- 短文・長文で閾値を分けるか
- 核心語、数量、否定、固有名詞へ重みを付けるか
- ASR confidenceを利用するか

ownership spanを固定し、人手ラベル付きcontent setで比較する。playabilityへcontent thresholdを流用しない。

完了条件:

- true/false positive、true/false negativeを言語・カテゴリ別に報告する。
- 個別語blacklistに依存しない。
- Python/Workerで同じ判定になる。

### GAP-P1-06 英数字identifierの文脈判定

状態: `evaluation_required`

`A17`、`A seventeen`、`A one seven`を同一候補にできることは合意されているが、identifier文脈の境界が未決定である。

必要な反例:

- 一般数値の17
- 数量を表す`A 17`相当の文章
- version番号
- 電話番号、日付、時刻
- model名、request ID、code
- 数字をdigit-by-digitで読むことが自然な固有表現

完了条件:

- identifier判定規則と反例fixtureがある。
- 数量、否定、固有名詞、核心語の新規false positiveがない。

### GAP-P1-07 target phrase splitterの完全な契約

状態: `evaluation_required`

保護対象としてemail、小数、version、URL、`Ms.`等は挙がっているが、次が未決定である。

- abbreviation一覧を固定するか、一般規則にするか
- 引用符、括弧、ellipsis、連続句読点
- 中国語・英語句読点の混在
- emojiと記号
- 改行、箇条書き、話者番号
- protected pattern直後の本当の文末

完了条件:

- splitter専用fixtureをalignment fixtureから分離する。
- phrase text、source index、空phrase除外規則を固定する。
- PythonとWorkerが同じphrase列を返す。

### GAP-P1-08 filler判定

状態: `evaluation_required`

文頭・文末・phrase境界の明確なフィラーを除外できることは決まっているが、言語別語彙と構造条件は未決定である。

未決定:

- filler候補語
- target本文に同じ語がある場合の保護
- どもり・反復・false startとの区別
- phrase内部と録音端での扱い
- 中国語の`嗯`、`那个`等と、target本文中の実語の区別

完了条件:

- 単語blacklistだけに依存しない。
- 正常語を削除しない反例fixtureがある。
- 除外tokenをdiagnosticsに保持する。

## 5. P2: 実装・公開前に閉じる穴

### GAP-P2-01 diagnosticsの完全schema

状態: `open`

未決定:

- `unassigned_tokens`各要素の正式schema
- `zero_duration_tokens`のowner、index、時刻表現
- flagのcanonical順と重複除去
- raw provider diagnosticsとcanonical diagnosticsの境界
- profile名、contract version、provider versionの記録位置

完了条件:

- JSON schemaまたは同等fixtureを作る。
- fieldのnullabilityと順序を固定する。
- 個人情報やraw音声の保存範囲を増やさない。

### GAP-P2-02 canonical adapterの限界

状態: `open`

adapterがfield名、enum、index表現、derived fieldだけを変換できることは決まっている。次の境界をfixtureで固定する必要がある。

- 旧`source`から`text_source` / `timestamp_source`への変換
- `anchor` / `structural`からconfidenceとboundary sourceへの変換可否
- 旧rangeにowner情報がない場合の扱い
- 欠落fieldを`null`で補える場合と、比較不能にする場合

adapterがownership、文字、時刻、availabilityを補正してはならない。

完了条件:

- adapter fixtureがある。
- lossless変換と比較不能を区別する。
- 実装差をadapterが隠していないことをレビューできる。

### GAP-P2-03 時刻比較の許容誤差

状態: `open`

runtimeやJSON変換による浮動小数差に対し、次が未決定である。

- Python/Worker parityを完全一致にするか許容誤差を設けるか
- fixtureの`audio_start` / `audio_end`許容差
- provider時刻の丸め桁
- UIの停止判定で許容するframe/timeupdate差

canonical range自体へ固定paddingや30ms早止めを加えない。

完了条件:

- schema値の丸めとテスト比較方法を分けて定義する。
- UIはcanonical `audio_end`を目標に停止する。
- 許容差が隣接phrase音声の混入を正当化しない。

### GAP-P2-04 UIのエラー・部分結果表示

状態: `open`

playback modeは定義済みだが、次の文言と操作は未決定である。

- provider error時の主要メッセージと詳細diagnostics
- `partial_phrase`で再生できないphraseの示し方
- text-only phraseの表示
- ambiguous/unassignedを利用者へどこまで説明するか
- no-speech後の再録音導線

完了条件:

- 通常、partial、whole、text-only、no-speech、reference error、attempt errorを実ブラウザで確認する。
- 主要メッセージへ不要なprovider固有名を出さず、詳細欄では原因を確認できる。
- 表示ラベルと実再生planが一致する。

### GAP-P2-05 性能budget

状態: `open`

correctnessと別に、採用可能な性能上限を決める必要がある。

- phrase数、token数の最大入力
- median / p95処理時間
- Python / WorkerのCPU・memory上限
- 候補数と探索上限
- 長文でfallbackするか、明示errorにするか

完了条件:

- 代表入力と最大入力でBefore/Afterを計測する。
- correctnessを落とすsilent fallbackを入れない。
- 同程度の精度なら規則・状態・依存が少ない方式を選ぶ。

## 6. すでに統合案で閉じた事項

次は両案比較時には差または曖昧さがあったが、統合案で共通方針が定義されている。

- `available`と`content_matched`の分離
- unassignedの`content_matched=null`
- zero-duration tokenの文字・owner保持
- zero-durationだけならtext-only
- `available=false`のraw words/segments不使用
- 正式transcriptionのみの場合、単一phraseはtext-only、複数phraseは推測分割しない
- attempt no-speechとreference/provider errorの分離
- `complete`を互換derived fieldに限定
- UI modeを共通playable phrase indexから決める
- `partial_phrase`表示
- `audio_end`ちょうどまで再生し、固定早止めをしない
- content similarityをplayabilityへ使用しない
- ambiguous caseを総合順位から除外

これらは正式canonical文書を1つへ決めた後、schema fixtureで回帰を固定する。

## 7. 決定記録の形式

各項目を閉じるときは、少なくとも次を記録する。

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

評価不要なschema命名等では`evaluation_set_sha256: not_applicable`とし、人手判断の理由を残す。

## 8. 全体完了条件

次を満たすまで、alignmentをcanonical SPECへ完全適合済みと報告しない。

1. P0がすべて`closed`である。
2. 採用policyに関係するP1が`closed`である。
3. canonical evaluationを妨げるP2が`closed`である。
4. 正のcanonical文書が1つだけ指定されている。
5. ownership、content、splitter、provider error、adapter、UIのfixtureが分離されている。
6. 未使用canonical evaluation setの期待値とSHA-256が実行前に固定されている。
7. Python / Cloudflare Worker parityが採用schemaで確認されている。
8. UIの主要状態を実ブラウザで確認している。
9. 既存SPEC、実装、fixture、テスト、UI、ロードマップが同じ変更単位で同期されている。
