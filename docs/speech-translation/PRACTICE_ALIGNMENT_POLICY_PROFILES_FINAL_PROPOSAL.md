# SpeakLoop フレーズ比較アラインメント policy profiles 統合最終案

更新日: 2026-07-16

> **Status: Final Proposal / 未採用**
> 本文書は、[canonical SPEC統合最終案](PRACTICE_ALIGNMENT_CANONICAL_SPEC_FINAL_PROPOSAL.md)で固定しない判断を、実装名に依存しないprofileとして比較するための最終提案である。profileの採用結果ではない。

関連文書:

- [canonical SPEC統合最終案](PRACTICE_ALIGNMENT_CANONICAL_SPEC_FINAL_PROPOSAL.md)
- [評価・移行計画](PRACTICE_ALIGNMENT_EVALUATION_PLAN.md)
- 比較元: [policy profiles案](PRACTICE_ALIGNMENT_POLICY_PROFILES.md)

## 1. 目的

canonical coreを実装ごとのSPECへ分岐させず、製品判断が未確定な次の2軸だけを同じデータで比較する。

1. ownership profile: tokenをtarget phraseへ所有させる条件
2. content profile: 発音対象文字列を同じ内容候補とする正規化範囲

profileは実装A用・実装B用ではない。どの実装も同じprofileを実装またはadapterで表現し、同じfixtureへcross-runする。

ownershipとcontentは別々に評価し、最初から2 × 2の全組み合わせを製品実装しない。

## 2. profileで変更できないcore

すべてのprofileは次を変更できない。

- `available`と`content_matched`を分離する。
- content mismatchだけでplayable rangeを失わせない。
- target phrase順、token非重複、時刻単調性を守る。
- 実在する正時間timestamp以外から再生rangeを作らない。
- zero-duration tokenを文字、所有関係、diagnosticsから削除しない。
- `available=false`のraw words/segmentsをalignmentへ使わない。
- no-speech、provider矛盾、reference errorを分離する。
- generic connector、録音端、pause、空きslotのいずれか1つだけでは割り当てない。
- 全target phrase割当後の無関係発話を最後のphraseへ吸収しない。
- 単一phrase契約と明確な前後anchor間の一意なslotをprofile差にしない。
- UIは両音声で共通するplayable phrase indexから同じplayback planを作る。

core違反があるprofileは、成功数にかかわらず採用候補から外す。

## 3. ownership evidence groups

片側anchorや低一致発話を評価するとき、根拠を次の独立groupへ分類する。

### 3.1 textual evidence

- target phraseとの非自明な文字重複
- target固有の語、文字列、英数字ID
- target phraseの明確なprefixまたはsuffixの試行
- false start、自己訂正、完全な言い直しとの文字上の関係
- 他target phraseより明確に高い対応

genericな`then` / `然后`、機能語、複数phraseに共通する短いprefixだけは強い文字根拠にしない。

### 3.2 boundary evidence

- ASRの独立segment境界
- phrase境界として説明できるtoken間pause
- target句読点と矛盾しないASR句読点補助情報

pauseだけで前後どちらの所有かを決めない。segmentとpauseが同じ音響的切れ目を表す場合は、独立した2根拠として数えない。

### 3.3 neighboring-anchor evidence

- 前後の高信頼anchor
- 片側の高信頼anchorと、その所有range端
- anchor間に残る一意な連続token span

前後anchor間でも、複数の未発話slotまたは複数partitionが成立する場合は一意な根拠にしない。

### 3.4 sequence/slot evidence

- target phrase順と発話時間順が矛盾しない
- 他target phraseへ強く一致しない
- 一意な未割当slot
- utterance edgeに接する
- rangeを作っても既存rangeと重複・逆行しない

順序、空きslot、utterance edgeは同じ構造系groupとして扱う。これらを複数並べても独立した複数根拠とは数えない。

## 4. ownership共通の拒否条件

次に該当する発話は、どちらのownership profileでも強制割当しない。

- generic connectorしかtargetとの関係がない
- 録音の文頭・文末にあるという理由しかない
- pauseがあるという理由しかない
- target側に空きslotがあるという理由しかない
- 別target phraseへより強く一致する
- 割り当てるとtoken indexまたは時刻が逆行・重複する
- 全target phraseが割当済みで、直前phraseの訂正・継続を示す根拠がない
- 長いpause後の新しい話題、別の相手への発話、独立した会話と判断できる
- 矛盾timestamp payload内部のraw dataしか根拠がない
- 複数slotへ同程度に対応し、一意な所有先を決められない

拒否したtokenは削除せず、canonical reason付きで`unassigned_tokens`へ残す。

## 5. `ownership.conservative`

### 5.1 目的

無関係発話をtarget phraseの試行として表示するfalse positiveを強く避ける。説明可能な未割当と全体比較fallbackを許容する。

### 5.2 前後anchor

前後の一意な高信頼anchorに挟まれた発話は、次をすべて満たす場合に中央phraseへ割り当てる。

- 間の未発話slotが1つ
- 連続した未割当spanが1つ
- spanが時間上2つのanchor間にある
- 他target phraseへ強く一致しない
- 別話題または共通拒否条件に該当しない
- rangeが単調で重複しない

内容が違っても`available=true`、`content_matched=false`にできる。

### 5.3 片側anchor

片側anchorに加え、neighboring-anchor以外の異なるevidence groupから2群以上の整合を要求する。

- 少なくとも1群はtextual evidenceまたはboundary evidence
- sequence/slot内の複数項目を別群として数えない
- 競合する別解がない
- 共通拒否条件に該当しない

例:

- 片側anchor + 強い部分文字一致 + 独立したsegment/pause境界: 割当候補
- 片側anchor + 強い部分文字一致 + 一意なslot: 割当候補
- 片側anchor + 明確なsegment/pause境界 + 一意なslot: 割当候補
- 片側anchor + 録音端 + 空きslot: 不十分
- 片側anchor + generic connector + 順序: 不十分
- 片側anchor + pauseだけ: 不十分

文字根拠とslotだけで割り当てる場合、文字根拠はtarget固有で非自明でなければならない。短い共通prefixや機能語では条件を満たさない。

### 5.4 録音端

録音端はsequence/slot evidenceの一部にすぎず、独立した強い正の証拠へ数えない。録音端の低一致発話には、強い文字根拠または明確な境界根拠と、一意な順序構造を要求する。

### 5.5 想定するtrade-off

- false positiveを抑えやすい。
- 大きく言い間違えた実際のtarget試行をunassignedにする可能性がある。
- 公開デモで誤った区間を断定的に見せるリスクが低い。

## 6. `ownership.balanced`

### 6.1 目的

target phraseとして行った実発話を比較区間から落とさず、言い間違い、途中終了、ASR誤認識によるfalse negativeを減らす。

### 6.2 前後anchor

`ownership.conservative`と同じ条件を使う。

### 6.3 片側anchor

片側anchorに加え、次のどちらか1つの強い根拠を要求する。

- target phraseの実質部分とのtextual evidence
- phrase所有境界を一意にするASR segmentまたは明確なpause

さらに次をすべてguardとして要求する。

- sequence/slot evidenceにより位置が一意
- target順と矛盾しない
- 他target phraseへ強く一致しない
- rangeが重複・逆行しない
- 共通拒否条件に該当しない

順序guardは独立した強い正の根拠として数えない。

### 6.4 録音端

最後の未使用slotに続く録音末尾発話は、強い文字根拠または明確なsegment/pause境界があり、別話題の拒否条件がない場合に限り割当候補にできる。

### 6.5 想定するtrade-off

- 実target試行の欠落を減らせる。
- trailing extra speechや別話題を隣接phraseへ含めるfalse positiveが増え得る。
- `content_matched=false`のplayable rangeを多く提供できる。

## 7. ownership profileで変えない特殊状態

### 7.1 単一phrase

明確な録音端フィラーを除いた正時間発話全体を試行として扱う。内容差はownershipでなく`content_matched`へ反映する。

### 7.2 一意な前後anchor

前後anchor間に1つの空きphraseと1つの連続spanだけが残る場合は両profileで割り当てる。

### 7.3 zero-duration

所有先が一意なzero-duration tokenを削除しない。正時間rangeがなければtext-onlyとする。

### 7.4 no-speechと矛盾payload

no-speechや矛盾payloadからphrase rangeを作らない。

### 7.5 戻り発話

後続targetへ進んだ後の戻り発話を、時刻を逆行させて先行rangeへ追加しない。

### 7.6 segment数一致fallback

文字anchorがなく、ASR segment数とtarget phrase数が一致するだけのfallbackは、どちらのprofileにも現時点では含めない。segment境界、順序、内容非競合が組み合わさる候補として[評価・移行計画](PRACTICE_ALIGNMENT_EVALUATION_PLAN.md)で別評価し、採用時にprofileへ明記する。

## 8. alignment confidenceの共通変換

profileの内部scoreや方式名を、そのままconfidence値にしない。

| 値 | canonicalな意味 |
| --- | --- |
| `high` | 強い文字anchorまたは一意な前後anchorがあり、競合説明がない |
| `medium` | 異なる複数根拠で一意だが、強い全文字anchorではない |
| `low` | 構造上は一意だが、文字または片側境界が弱い |
| `null` | ownerを決めていない |

- `content_matched=false`でもownershipが一意なら`high`または`medium`を許可する。
- text-onlyでもownerが一意ならconfidenceを保持する。
- `anchor`、`structural`、アルゴリズムscoreをcanonical enumへ直接流用しない。

## 9. `content.literal_normalized`

### 9.1 目的

常時適用して安全な正規化だけを使い、独自等価変換によるfalse positiveを避けるbaselineとする。

### 9.2 正規化

- Unicode互換表現
- 全角・半角
- 大文字・小文字
- 発音対象ではない句読点と記号
- 空白
- 簡体字・繁体字の字形差

英数字表記と読み上げ候補は追加しない。

### 9.3 trade-off

- 規則が少なくPython/Worker parityと保守性に優れる。
- ASRがidentifierを読み表記へ変換した場合、同じ発話でもfalse negativeになり得る。

## 10. `content.asr_equivalent_normalized`

### 10.1 目的

常時正規化に加え、ASRが同じ発話を別表記へ正規化しやすい英数字ID文脈だけに等価候補を追加する。

### 10.2 追加する候補

英数字identifierと判断できる場合、次を同じ内容候補として扱う。

```text
A17
A seventeen
A one seven
```

適用条件:

- target tokenが英字と数字を連続して含む
- ID、request ID、code、model名等の明示的文脈がある
- target内で英字列と数字列が1つの固有識別子として提示されている

### 10.3 追加しない候補

- 一般数値に対する無条件のdigit-by-digit展開
- paraphrase、類義語
- 固有名詞の別名推定
- 中国語の同音字・近音字・声調差の同一視
- 数量、否定、核心語を変える置換
- targetに存在しないidentifierの追加
- 任意の数字列に対する全読み方の総当たり

### 10.4 trade-off

- identifier表記差のfalse negativeを減らせる。
- 文脈判定を広げると数量やIDを誤って同一視し得る。
- 候補生成規則をPython/Workerで決定的に共有する必要がある。

## 11. content profileで未固定のもの

両profileとも次をまだ固定しない。

- similarity metric
- `content_matched`の数値閾値
- 長さ別閾値
- 重大tokenへの重み付け

これらは人手ラベル付きcontent evaluation setで比較する。同じownership spanを両profileへ入力し、boundary誤りをcontent誤りへ混ぜない。

## 12. 評価順

不要な4通りの製品実装を避けるため、次の順で評価する。

1. ownership専用fixtureで`conservative`と`balanced`を比較する。
2. content専用fixtureへ正しいspanを直接与え、2つのcontent profileを比較する。
3. 各軸で明白に劣るprofileを除外する。
4. 各軸の採用候補だけを結合し、integration challenge setで確認する。
5. 最後まで未使用のcanonical evaluation setで最終確認する。

## 13. profile選定規則

### 13.1 ownership

- baselineは`ownership.conservative`とする。
- `balanced`は複数の独立作成ケースで実target試行を追加回収した場合に限り優先できる。
- confirmed unrelated speechの新規false positiveが出た場合は、条件を狭めてpilotからやり直すか`conservative`を採用する。
- 同程度なら規則が少なくfalse positiveを抑える`conservative`を選ぶ。

### 13.2 content

- baselineは`content.literal_normalized`とする。
- `asr_equivalent_normalized`はidentifier false negativeを減らし、数量・否定・核心語・固有名詞の新規false positiveを生まない場合だけ優先できる。
- 同程度なら規則が少ない`literal_normalized`を選ぶ。

### 13.3 製品への反映

- 採用後はprofileをcanonical SPECへ統合する。
- 不採用profileを実行時の隠れた切替として残さない。
- 利用者が選択する明確な価値がない限り、複数profileを公開設定にしない。

## 14. 提案段階の比較候補

| 軸 | baseline | challenger |
| --- | --- | --- |
| ownership | `ownership.conservative` | `ownership.balanced` |
| content | `content.literal_normalized` | `content.asr_equivalent_normalized` |

これは採用決定ではない。[評価・移行計画](PRACTICE_ALIGNMENT_EVALUATION_PLAN.md)のpilot、小規模試行、未使用評価を通過したprofileだけをcanonicalへ昇格する。
