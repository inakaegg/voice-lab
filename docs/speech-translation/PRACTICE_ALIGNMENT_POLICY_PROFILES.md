# SpeakLoop フレーズ比較再生 policy profiles（提案）

更新日: 2026-07-16

状態: 比較・合意用の提案。採用profileは未決定であり、現行実装の設定値を表さない。

正のcore contract案: [PRACTICE_ALIGNMENT_CANONICAL_SPEC.md](PRACTICE_ALIGNMENT_CANONICAL_SPEC.md)

## 1. 目的

canonical contractの固定coreを複数版へ分岐させず、製品判断が未確定な次の2軸だけを同じデータで比較する。

- phrase ownershipをどこまで片側の構造証拠で認めるか
- content matchで文脈限定のASR表記等価を認めるか

profileは実装1用・実装2用の期待値ではない。どの実装も同じprofileへ正規化し、同じfixtureでcross-runする。

## 2. profileにかかわらず固定する条件

すべてのprofileはcanonical coreの次の条件を変更できない。

- `available`と`content_matched`を分離する。
- `available=false`のtimestamp payload内部dataをalignmentへ使わない。
- zero-duration wordを文字、所有関係、diagnosticsから削除しない。
- 実在しない時刻を作らない。
- 同じwordを複数phraseへ割り当てない。
- phrase rangeのtarget順、word index、時刻を単調に保つ。
- no-speech、provider矛盾、reference errorを混同しない。
- content mismatchだけを理由に、構造上位置が決まるrangeをunavailableにしない。
- 構造根拠のない無関係発話を、空きslotだけで割り当てない。
- UIは両音声で共通するplayable phrase indexを使用する。
- 表示ラベルと再生方式を同じplayback planから導く。

profileがこれらへ違反した場合、fixtureの成功数にかかわらず採用候補から外す。

## 3. ownership evidence

片側anchorを評価するとき、証拠を次の独立した群へ分ける。

### 3.1 文字根拠

- target phraseの実質部分との一致
- target phraseの明確なprefixまたはsuffixの試行
- 同じphrase内のfalse start、自己訂正、完全な言い直しとの関係
- ASR誤認識として説明できる連続した部分一致

genericな接続語、機能語、全targetに共通する短い語だけは文字根拠にしない。

### 3.2 境界根拠

- ASR segmentの開始・終了
- phrase境界として説明できるword間pause
- 有効な句読点補助情報

pauseがあるという事実だけで、前後のどちらへ所有させるかは決めない。録音端も単独では境界根拠として十分ではない。

### 3.3 近傍根拠

- 前後の別target phraseへ対応する高信頼anchor
- 片側の高信頼anchorと、そのrangeが所有するword端

前後anchorに挟まれていても、間に複数の未発話slotがある場合やpartitionが複数成立する場合は一意な根拠としない。

### 3.4 順序根拠

- target phrase順と発話時間順が矛盾しない
- 他target phraseへ強く一致しない
- 未使用slotと未割当発話の数が構造上対応する
- 既存rangeを重複・逆行させない

「一意な空きslot」と「target順に矛盾しない」は相関するため、それだけを独立した2根拠として数えない。

## 4. ownership共通の拒否条件

次のいずれかに該当する発話は、片側anchor profileの強さにかかわらず強制割当しない。

- `then`、`然后`等のgenericな接続語しかtargetとの関係がない
- 録音の文頭・文末にあるという理由しかない
- pauseがあるという理由しかない
- target側に空きslotがあるという理由しかない
- 別target phraseへより強く一致する
- target順へ割り当てると、既存rangeのword indexまたは時刻が逆行・重複する
- 全target phraseが既に割り当て済みで、直前phraseの訂正・継続を示す根拠がない
- 長いpause後の新しい話題、別の相手への発話、独立した会話と判断できる
- 矛盾timestamp payload内部のraw word/segmentしか根拠がない

拒否した発話は削除せず、canonicalな理由付きで `unassigned_tokens`へ残す。

## 5. `ownership.conservative`

### 5.1 目的

無関係発話をtarget phraseの試行として再生するfalse positiveを強く避ける。canonical採用の初期推奨profileとする。

### 5.2 前後anchor

前後の一意な高信頼anchorに挟まれた発話は、次をすべて満たす場合に中間phraseへ割り当てられる。

- 間の未発話target slotが1つに定まる
- 発話wordが時間上その2anchor間にある
- 他target phraseへ強く一致しない
- 別話題または独立発話の拒否条件がない
- rangeを作ってもword indexと時刻が単調で重複しない

内容一致が低い場合も `available=true`、`content_matched=false`、`alignment_confidence=low`を許可する。

### 5.3 片側anchor

片側anchorに加え、近傍根拠以外の異なる証拠群から少なくとも2群の整合を要求する。

- 少なくとも1群は文字根拠または境界根拠であること
- 順序と空きslotだけで2群と数えないこと
- 競合する別解がないこと
- 共通の拒否条件に該当しないこと

例:

- 片側anchor + segment境界 + 部分的な文字根拠: 割当候補
- 片側anchor + 明確なpause + 一意なslot: 境界と順序が独立しており、別話題でなければ割当候補
- 片側anchor + 録音末尾 + 空きslot: 不十分
- 片側anchor + `then` + target順: 不十分

### 5.4 録音端

録音端の低一致発話は、録音端であることを正の証拠へ数えない。文字または明確なsegment/pause境界と、順序上の一意性が必要である。

### 5.5 採用条件

pilotと小規模試行で、既知の関連発話を構造上説明可能な範囲へ保持し、confirmed unrelated speechを新たに割り当てないこと。

## 6. `ownership.balanced`

### 6.1 目的

片側しかanchorがない途中終了、最終phraseの大きな言い間違い、ASR誤認識を比較区間から落とすfalse negativeを減らす。

### 6.2 前後anchor

`ownership.conservative`と同じ条件を使う。

### 6.3 片側anchor

片側anchorに加え、次のどちらか1つの強い根拠を要求する。

- target phraseの実質部分との文字根拠
- phrase所有境界を一意にするASR segmentまたは明確なpause

さらに、次をguardとしてすべて要求する。

- target順と矛盾しない
- 他target phraseへ強く一致しない
- 共通の拒否条件に該当しない
- word indexと時刻を重複・逆行させない

順序guardは独立した正の根拠として数えない。

### 6.4 録音端

最後の未使用slotに続く録音末尾発話は、強い文字根拠または明確なsegment/pause境界があり、別話題の拒否条件がない場合に限り割当候補にできる。

### 6.5 採用条件

次をすべて満たす場合だけ `conservative`より優先できる。

- 複数の独立作成ケースで、実際のtarget試行を追加で回収する
- pilotと小規模試行で、confirmed unrelated speechの新規false positiveが0件
- 既存の順序、zero-duration、境界フィラー回帰を悪化させない
- 追加規則を個別語や個別case名へ依存させない

新しいconfirmed unrelated false positiveが1件でも出た場合は、条件を狭めてpilotからやり直すか、`conservative`を採用する。

## 7. ownership profileで変えてはいけない特殊状態

### 7.1 単一phrase

両profileとも、明確な録音端フィラーを除いた正時間発話全体をその一回の試行として扱う。内容差はownershipでなく`content_matched`へ反映する。

### 7.2 zero-duration

両profileとも、所有先が一意なzero-duration wordを文字列から削除しない。正時間rangeがなければtext-onlyとする。

### 7.3 no-speechと矛盾payload

両profileとも、no-speechや矛盾payloadからphrase rangeを作らない。

### 7.4 戻り発話

両profileとも、後続targetへ進んだ後の戻り発話を、時間を逆行させて先行rangeへ追加しない。

## 8. `content.literal_normalized`

### 8.1 正規化

- Unicode互換上の全角・半角差
- 大文字・小文字
- 発音対象でない句読点、記号、空白
- 中国語の簡体字・繁体字の字形差

英数字の表記と読み上げ候補は追加しない。

### 8.2 目的

独自の等価変換を最小化し、正規化規則によるfalse positiveを避けるbaseline profileとする。

### 8.3 想定する弱点

ASRがidentifierを文字・数字列ではなく英単語列として返した場合、内容が同じでもfalse negativeになり得る。

## 9. `content.asr_equivalent_normalized`

### 9.1 正規化

`content.literal_normalized`に加え、英数字identifierの文脈で表記候補と読み上げ候補を比較する。

例:

```text
A17
A seventeen
A one seven
```

### 9.2 適用条件

次のいずれかによりidentifier文脈が分かる場合に限定する。

- target tokenが英字と数字を連続して含む
- ID、request ID、code、model名等の明示的なidentifier文脈がある
- target内で英字列と数字列が一つの固有識別子として提示されている

一般数値は通常の数詞読みを基本とする。digit-by-digit候補をすべての数値へ無条件に追加しない。

### 9.3 適用しないもの

- 固有名詞の別名推定
- paraphrase
- 類義語
- 中国語の同音字・近音字
- 数量、否定、核心語の意味を変える置換
- targetに存在しないidentifierの追加

### 9.4 採用条件

人手ラベル付きcontent pilotでidentifierのfalse negativeを減らし、数量・固有名詞・核心語置換のfalse positiveを新たに生まないこと。

新しいcontent false positiveが出た場合は、等価候補の適用文脈を狭めるか `literal_normalized`を採用する。

## 10. `content_matched`方式の評価

2つのcontent profileは文字正規化の範囲だけを定義する。`content_similarity`の計算方式と`content_matched`の数値閾値は、次の候補を同じ人手ラベルで比較して決める。

- 現状維持
- 既存の別方式
- 採用content profileで正規化した上での単純な文字列方式
- 現実的な閾値の組み合わせ

候補名はcanonical contractへ埋め込まず、評価記録へ残す。

評価では少なくとも次を別々に数える。

- true positive
- true negative
- false positive
- false negative
- 核心語、数量、否定、固有名詞の誤判定
- identifier表記差の誤判定
- Python/Workerで同じ方式を再現する複雑さ
- 処理時間

playback availabilityをcontent thresholdで変更しない。

## 11. pilot設計

期待値を実装出力へ合わせないため、各pilotは入力、期待値、除外条件、SHA-256を実行前に固定する。

### 11.1 ownership pilot

10〜20件で、英語と中国語を均等に含める。

- 前後anchorに挟まれた低一致発話
- 片側anchorで実際のtarget試行である発話
- 長いpause後の無関係な別話題
- genericな接続語だけが共通する発話
- 最終phraseの言い間違いとtarget完了後の追加会話
- phrase抜け、逆順、戻り発話
- zero-durationと境界フィラーを含む複合例

各caseは `relevant_attempt`、`unrelated_speech`、`ambiguous` の人手分類を持つ。`ambiguous`はprofile順位の得点から外す。

### 11.2 content pilot

10〜20件で、次を均等に含める。

- 正規化後の完全一致
- 句読点、空白、全半角、簡繁体差
- `A17` / `A seventeen` / `A one seven`
- 一般数値とidentifier読みの区別
- 核心語置換
- 数量、否定、固有名詞の置換
- 中国語の同音字、近音字、声調由来の別漢字
- paraphrase、類義語

人手の `expected_content_matched`を実行前に固定する。

## 12. 小規模試行へ進む条件

pilot後、次を満たす軸だけ50〜100件の小規模試行へ進める。

- canonical core違反がない
- 入力・期待値schemaが両実装を同じ意味で評価できる
- Python/Worker adapterが挙動差を隠していない
- profile間に測定可能な差がある
- 新しい判定が個別case名や個別語blacklistへ依存していない

profile間の差がなく、複雑さだけが増える場合は追加データ作成へ進まず、単純なprofileを選ぶ。

## 13. 停止条件

次のいずれかで試行を止め、残件へ自動的に進まない。

- `ownership.balanced`がconfirmed unrelated speechを新たに割り当てる
- ASR等価正規化が数量、否定、核心語、固有名詞のfalse positiveを生む
- 既存の正常例、順序、zero-duration、境界フィラーを悪化させる
- 同じprofileの大きな成立条件変更が2回に達する
- 見積り件数または作業量が2倍を超える
- 製品上の改善が横ばいまたは悪化する

停止時は、改善数、悪化数、false positive、false negative、未解決条件、安全な暫定profileを報告する。

## 14. 比較結果の報告

総成功数だけで順位を決めず、次を分けて報告する。

- ownership exact range一致
- relevant attemptの回収数
- unrelated speechの誤割当数
- ambiguous件数
- content false positive / false negative
- 言語別、カテゴリ別結果
- legacy fixtureとの衝突
- canonical core違反
- Python/Worker parity
- 処理時間と実装複雑さ

実装由来challenge setは、由来実装だけでなく全実装へcross-runする。実装ごとに別の期待値を使わない。

## 15. profile選定規則

- ownershipで同程度なら `ownership.conservative`を選ぶ。
- `ownership.balanced`は、複数の関連発話を追加回収し、confirmed unrelated speechの新規誤割当が0件の場合だけ選べる。
- contentで同程度なら、規則が少ない `content.literal_normalized`を選ぶ。
- `content.asr_equivalent_normalized`は、identifier false negativeを減らし、新しいcontent false positiveが0件の場合だけ選べる。
- 採用後はprofileをcanonical coreへ統合し、不採用profileを実行時の隠れた切替として残さない。
- 製品として利用者が選択する明確な価値がない限り、複数profileを公開設定にしない。

## 16. 提案段階での推奨

pilot開始候補は次とする。

- ownership baseline: `ownership.conservative`
- ownership challenger: `ownership.balanced`
- content baseline: `content.literal_normalized`
- content challenger: `content.asr_equivalent_normalized`

これは採用決定ではない。固定済みpilotと小規模試行を通過したprofileだけを、canonical contractの最終案へ昇格する。
