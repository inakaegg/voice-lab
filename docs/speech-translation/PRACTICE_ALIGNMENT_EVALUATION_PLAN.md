# SpeakLoop フレーズ比較アラインメント 評価・移行計画

更新日: 2026-07-16

> **Status: Proposal**
> 本文書は、canonical SPEC統合最終案とpolicy profile候補を、公平なデータで評価して正式採用するための計画である。既存実装の成功数や既存fixture期待値を正解として固定しない。

関連文書:

- [canonical SPEC統合最終案](PRACTICE_ALIGNMENT_CANONICAL_SPEC_FINAL_PROPOSAL.md)
- [policy profile統合最終案](PRACTICE_ALIGNMENT_POLICY_PROFILES_FINAL_PROPOSAL.md)
- [現行全体仕様](SPEC.md)
- [学習機能ロードマップ](LEARNING_ROADMAP.md)

## 1. 目的

次を混同せずに測定し、最も単純で再現可能な方式を選ぶ。

- phrase ownershipの正しさ
- content matchの正しさ
- target phrase splitterの正しさ
- Python / Cloudflare Worker parity
- UI playback planの整合
- 処理時間と実装・保守の複雑さ

総成功数だけで方式を選ばず、false positiveとfalse negativeを別々に扱う。説明可能な未割当より、無関係発話をphraseへ誤割当するfalse positiveを重大に扱う。

## 2. fixtureの役割

### 2.1 legacy fixture

過去の不具合と旧契約を保持する履歴資料。

- 削除せず回帰履歴として残す。
- 旧single-gate、旧`complete`、旧field名を含み得る。
- canonical schemaへ再ラベルするまで総合順位へ加算しない。
- 旧期待値とcanonical期待値を同じfieldで二重管理しない。

### 2.2 implementation-origin challenge set

各実装の開発中に見つかった強み・弱みを集める。

- 期待値を発見元実装の出力からコピーしない。
- canonical coreと指定profileから人手で決める。
- 発見元と異なる実装にもcross-runする。
- 発見元実装の回帰成功を独立評価と呼ばない。

### 2.3 canonical evaluation set

候補選定後まで未使用にする最終確認データ。

- 実行前に入力、期待値、対象profile、schema、除外条件、SHA-256を固定する。
- ownership、content、splitterを別fieldまたは別fixtureへ分離する。
- 実行後に期待値を変更したデータはtraining/challenge setへ移す。
- 合格件数だけでなくfalse positive、false negative、ambiguousを報告する。

### 2.4 ambiguous / adjudication-required

文字列とtimestampだけでは発話意図や所有先を一意に決められないケース。

- 総合スコアから分離する。
- 判断候補と追加で必要な証拠を記録する。
- 実装出力へ合わせて期待値を決めない。
- profileごとに期待が異なる場合はprofile名を明記する。

## 3. 既存fixtureの暫定分類

| fixture | 暫定役割 | 注意点 |
| --- | --- | --- |
| `practice_alignment_cases.json` | legacy | 旧集計field中心 |
| `practice_alignment_golden_cases.json` | legacy / challenge | 実装調整に使用済み |
| `practice_alignment_boundary_cases.json` | implementation-origin challenge | どもり、言い直し、フィラー、抜け |
| `practice_alignment_holdout_cases.json` | training / challenge | 結果確認・調整済みなら今後holdoutと呼ばない |
| `practice_alignment_validation_cases.json` | training / challenge | 結果確認済み |
| `practice_alignment_playback_contract_cases.json` | implementation-origin challenge | core分離の回帰。profile依存期待を再審査 |
| 第1弾手作業200件 | training / challenge | 方式比較・調整に使用済み |
| 第2弾100件 | training / adjudication source | 初回実行後に内容確認済み |

## 4. 確認済み手作業データ

統合案の作成前に読み取り確認したデータは次である。

| データ | 件数 | SHA-256 |
| --- | ---: | --- |
| 第1弾手作業 | 200 | `7967010c9b10fb9128a8da2c1f128cbd9671629c0ca9045bbf4972fd17f84da5` |
| 第2弾pilot | 20 | `f9a8341e8fcab48efb373627af6f9c946a172820f719624ef5e7c5390fe73cea` |
| 第2弾holdout | 80 | `3a2bc2d080acfd130b822686cdcdd412e11b6d8472a0345919ac3855851ee152` |

これらの既存expected schemaは主に次を持つ。

- `available`
- `complete`
- `range_count`
- `source`
- `matched_text`
- `audio_start`
- `audio_end`

次は期待値に含まれていない。

- `content_matched`
- `assignment_status`
- word index
- `alignment_confidence`
- `boundary_sources`
- unassigned tokenとreason
- zero-duration tokenのowner

したがって、既存の成功件数をcanonical contract適合率として使わない。

## 5. 既知の再ラベル対象

### 5.1 coreと衝突する期待値

- `manual_eval_zh_100_first_phrase_partial_second_exact`
- `manual_eval_en_100_first_phrase_partial_second_exact`

先頭の誤発話spanは録音端と正確な後続anchorの間で一意に位置が決まる。旧`unavailable`ではなく、playableかつ`content_matched=false`とする。

### 5.2 第2弾`partial_overlap_negative` 12件

これらは次を持つ。

- 正確な第1phrase anchor
- 0.36〜0.41秒のpause
- 一意な末尾slot
- 正時間token

neighboring anchor、boundary、sequence/slotの複数根拠があるため、統合案の両ownership profileでは末尾phraseをplayableかつ`content_matched=false`とする候補である。旧unavailable期待はcanonical ownership期待として使わない。

### 5.3 矛盾timestamp 2件

- `manual_r2_zh_030_available_false_ignores_words`
- `manual_r2_en_040_available_false_ignores_words`

raw wordsをalignmentへ使用しない点は正しいが、通常のevaluated/unavailable resultではなく`contradictory_timestamp_payload` provider errorへ再分類する。

### 5.4 point timestamp 16件

zero-duration tokenを`matched_text`へ保持し、同じphrase内の隣接する正時間tokenからrangeを作る点はcanonical coreと一致する。ただしcanonical schemaへ次を追加ラベルする必要がある。

- zero-duration token owner
- token index範囲
- `assignment_status`
- `boundary_sources`
- `alignment_confidence`

3データセットにはzero-duration tokenだけで構成されるtext-only phraseがない。別challenge caseを追加する。

## 6. splitter、ownership、contentの分離

### 6.1 splitter

少なくとも次を専用fixtureで検証する。

- email
- URL
- 小数
- version番号
- `Ms.`、`Mr.`、`Dr.`等の略語
- protected pattern後の本当の文末記号
- 英語と中国語の句読点混在

既存の例:

- `manual_eval_zh_055_email_and_version_number`
- `manual_eval_en_046_email_version_digits`

splitterが誤ってphrase数を変えた場合、そのcaseをalignment方式の失敗へ数えない。

### 6.2 ownership

content閾値と独立して、次を期待値に持つ。

- `assignment_status`
- `matched_text`
- `word_start_index` / `word_end_index`
- `audio_start` / `audio_end`
- confidenceの許容範囲
- `boundary_sources`
- unassigned tokenとreason
- zero-duration owner

### 6.3 content

正しいownership spanを固定した上で、次を人手ラベルする。

- `content_matched`
- 常時正規化で同一視する表記差
- profile依存の英数字ID表記差
- 同一視しない核心語、数量、否定、固有名詞
- 中国語の同音・近音・声調由来別漢字
- ambiguous

contraction、一般数値と漢数字、英数字ID、簡体字・繁体字をcontent challengeへ分離し、既存`available`期待からcontent正解を逆算しない。

## 7. canonical schema adapter

各実装の既存field名やenumが違う場合、評価runnerでadapterを使える。

adapterが行ってよいこと:

- field名の機械的変換
- `anchor`等の既存enumを、事前に決めたcanonical confidence/boundary fieldへ写す
- inclusive/exclusive index表現の機械的変換
- derived countと`complete`の計算
- canonical順への配列整列

adapterが行ってはいけないこと:

- phrase ownershipの変更
- `matched_text`の補正
- tokenの追加・削除
- audio rangeの変更
- unavailableをavailableにすること
- 実装差を隠すfallback
- content labelの書き換え

adapter自体にもfixtureとparity testを用意する。

## 8. 評価段階

### 8.1 事前pilot

ownershipとcontentを別々に10〜20件で確認する。

ownership pilotに含めるもの:

- 前後anchor間の低一致発話
- 片側anchorの実target試行
- 長いpause後の無関係な別話題
- generic connectorだけが共通する発話
- 最終phraseの言い間違いとtarget完了後の追加会話
- phrase抜け、逆順、戻り発話
- zero-duration、境界フィラー、text-only
- segment数とphrase数が一致するが文字anchorがないケース

content pilotに含めるもの:

- 正規化後完全一致
- 句読点、空白、全半角、簡繁体差
- `A17` / `A seventeen` / `A one seven`
- 一般数値とID読みの区別
- 核心語、数量、否定、固有名詞の置換
- 中国語の同音字、近音字、声調由来別漢字
- paraphrase、類義語

### 8.2 小規模試行

pilotで次を満たした軸だけ、50〜100件へ進む。

- canonical core違反がない
- 両実装を同じschemaで評価できる
- adapterが挙動差を隠していない
- profile間に測定可能な差がある
- 個別case名や個別語blacklistへ依存しない

profile差がなく複雑さだけ増える場合は、追加データ作成へ進まず単純なprofileを選ぶ。

### 8.3 integration challenge

各軸の採用候補だけを組み合わせ、ownership、content、API、UIの境界で回帰がないか確認する。

### 8.4 canonical evaluation

候補選定後まで未使用の評価データを使用する。

- 期待値とSHAを実行前に固定
- 実装を見た後の再ラベル禁止
- Python/Workerを同じprofileで実行
- ownership/content/splitter/UI/performanceを別集計
- 明白な悪化があれば採用しない

## 9. 指標

### 9.1 ownership

- phrase assignment exact match
- token ownership exact match
- false-positive assigned phrase数
- false-negative unassigned phrase数
- boundary tokenの過不足
- audio range差
- unassigned reason一致
- relevant attempt回収数
- unrelated speech誤割当数

false positiveとfalse negativeを相殺しない。

### 9.2 content

- true positive
- true negative
- false positive
- false negative
- identifier表記差
- 核心語、数量、否定、固有名詞の誤判定
- 中国語字形・同音・声調由来別漢字
- 短文 / 長文

### 9.3 parity

- canonical phrase field完全一致
- derived count一致
- canonical diagnostics一致
- content方式採用後の`content_matched`一致

parityは正しさの得点ではなく、同じ契約を両runtimeが再現したことの検証とする。

### 9.4 UI

- attempt/referenceの共通phrase index
- `phrase` / `partial_phrase` / `whole` / `model`
- 表示ラベルと実再生経路の一致
- `audio_end`ちょうどで停止
- no-speechとreference errorの表示

### 9.5 performanceと複雑さ

- median / p95処理時間
- 最大入力での処理時間
- memory使用量
- 候補数、探索上限
- 追加規則数、状態数、依存数
- Python/Workerで重複する実装量

小さな正解数改善だけを理由に大幅な複雑化を選ばない。

## 10. 停止条件

次のいずれかで試行を止め、残件へ自動的に進まない。

- `ownership.balanced`がconfirmed unrelated speechを新たに割り当てる
- ASR等価正規化が数量、否定、核心語、固有名詞のfalse positiveを生む
- 既存の正常例、順序、zero-duration、境界フィラーを悪化させる
- 同じprofileの大きな成立条件変更が2回に達する
- 見積り件数または作業量が2倍を超える
- 製品上の改善が横ばいまたは悪化する

停止時は、改善数、悪化数、false positive、false negative、未解決条件、安全な暫定profileを報告する。

## 11. 報告形式

各profileは少なくとも次の形式で報告する。

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

加えて言語別、カテゴリ別、代表的な改善例・悪化例を提示する。実装由来challenge setは全実装へcross-runし、実装ごとに別の期待値を使わない。

## 12. 正式移行

profileと方式を採用した後、次を同じ変更単位で更新する。

1. [canonical SPEC統合最終案](PRACTICE_ALIGNMENT_CANONICAL_SPEC_FINAL_PROPOSAL.md)から「未採用」を外し、採用profileと方式範囲を明記する。
2. 既存の[全体SPEC](SPEC.md)へ正式契約を反映する。
3. canonical schema adapterまたは実装schemaを確定する。
4. PythonとCloudflare Workerを同期する。
5. fixture期待値とparity testをcanonical schemaへ更新する。
6. UI playback planと表示を同期する。
7. [LEARNING_ROADMAP.md](LEARNING_ROADMAP.md)へ評価結果と未確認範囲を反映する。
8. 全テスト、実ブラウザ確認、`git diff --check`を完了する。

評価中の候補や未確定閾値を、隠れたproduction設定として残さない。
