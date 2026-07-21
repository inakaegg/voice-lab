# 公開フロントエンドの段階移行

更新日: 2026-07-20

## 判断

公開画面の状態管理が大きくなっているため、Vite + React + TypeScriptへの移行は有効。ただし既存画面を一括移行しない。現行のvanilla JavaScriptは実運用されている。録音、IndexedDB、比較再生、job pollingを同時に書き換えると回帰原因を切り分けにくい。

表示基盤の移行対象は公開ポータル、SpeakLoop、SkitVoice、管理3画面とする。管理画面の状態制御は既存classic JavaScriptを維持し、まずCSS build、共通shell、レスポンシブを移す。内部検証・旧互換画面は最小限の共通shellだけを適用し、Worker/FastAPIのAPI互換を維持する。

## 実装状況

- 公開ポータル、SpeakLoop、SkitVoiceをVite + React + TypeScriptのmulti-page buildへ切り替えた。
- Reactは公開画面の構造、共通ヘッダー、サンプル表示枠、レスポンシブレイアウトを担当する。
- 対象は録音・比較再生・IndexedDB・URL参照・RunPod job pollingである。回帰を抑えるため既存controllerをReact mount後に読み込む移行アダプタを使う。
- WorkerとFastAPIは公開3routeにReact buildを返す。管理画面は従来HTML/JavaScriptのDOM契約を維持しつつ、Viteが生成する共通CSS assetを使う。
- 次段階では、既存controller内の状態遷移をreducer/hooksへ小単位で移し、移行済み部分から旧controllerを縮小する。

### 採用レイアウト

比較の結果、SpeakLoopとSkitVoiceはコンパクト作業台を正式採用した。説明文は消さず、主要操作までのスクロール量を抑える構成とする。

視覚階層、共通部品、必須状態、レスポンシブ境界、テーマ、実画面検証条件は [公開UIスタイル方針](../UI_STYLE.md) を正とする。この文書ではレイアウト仕様を重複管理しない。

### CSS/UI基盤の段階移行

2026-07-10以降、新規または移行済みのReact routeはTailwind CSS v4とshadcn/uiを正とする。shadcn/uiは依存先の完成画面を埋め込むライブラリではなく、必要なcomponent sourceをrepoへ追加し、Voice Labのtokenとvariantで管理するために使う。

公開ポータル`/`は専用の軽量Tailwind assetを使う。SpeakLoop・SkitVoice・管理画面・実験画面は共通Tailwind assetへ既存selector compatibility layerを取り込み、HTMLから`/static/styles.css`の直接参照を外す。これにより、既存controller契約を維持したままtoken・focus・responsive・管理shellを一つのbuild経路で管理する。

| route | 現在のスタイル基盤 | 旧`styles.css` | Tailwind CSS |
| --- | --- | --- | --- |
| `/` | Tailwind CSS v4 + repo所有shadcn/ui | 読み込まない | portal entryだけで読む |
| `/speakloop` | React + 共通Tailwind compatibility asset | 読み込まない | 読む |
| `/skitvoice` | React + 共通Tailwind compatibility asset | 読み込まない | 読む |
| `/admin` | static DOM + 共通Tailwind compatibility asset | 読み込まない | 読む |
| `/speakloop/admin` | static DOM + 共通Tailwind compatibility asset | 読み込まない | 読む |
| `/skitvoice/admin` | static DOM + 共通Tailwind compatibility asset | 読み込まない | 読む |
| `/fun` | 管理者専用DOM + 共通Tailwind compatibility asset | 読み込まない | 読む |

同じrouteで旧stylesheetとTailwindを二重ロードしない。production build後に、ポータル専用assetと共通compatibility assetの境界、全active HTMLから旧stylesheet参照が消えていることを検査する。

## 現在の境界

React buildは `web/react/` 配下、移行前のcontrollerと管理画面HTMLは `web/` 直下に置く。

```text
src/mo_speech/web/
  react/portal.html           公開ポータル（/）
  react/speakloop.html        SpeakLoop（/speakloop）
  react/skitvoice.html        SkitVoice非公開案内（/skitvoice）
  react/privacy.html          プライバシーポリシー（/privacy）
  index.html                  総合管理（/admin）
  practice_admin.html         SpeakLoop管理（/speakloop/admin）
  vibevoice.html              SkitVoice管理（/skitvoice/admin）
  user.html                   実験画面（/fun・管理者専用）
  app_practice.js             録音・prompt・比較再生・表示状態
  app_vibevoice.js            draft・参照音声・job・結果状態
  app_public_session.js       公開ログイン状態
  app_public_sample_audio.js  公開サンプル
cloudflare/worker.mjs         route・auth・quota・API gateway
```

退役したrouteはWorkerが404を返す。対象は `/user`、`/vibevoice*`、`/seed-vc` とその直接配信用HTMLである。

最初にAPI clientと純粋な状態遷移をUIから分離し、その後に表示部品をReactへ置き換える。

## 状態遷移

SpeakLoop:

```text
idle -> recording_native -> creating_prompt -> prompt_ready
prompt_ready -> recording_repeat -> evaluating -> result_ready
任意状態 -> error -> 直前に安全な状態
```

SkitVoice:

```text
editing -> validating -> uploading -> queued -> running -> succeeded
                                      \-> failed
                                      \-> cancelling -> cancelled
```

別の状態として、ログイン、quota表示、参照音声slotを持つ。マイク/タブ録音、IndexedDB復元、比較再生も別の状態として持つ。これらを1つの巨大なcomponentへまとめず、非同期処理の所有者を明確にする。

## 目標構成

```text
apps/web/
  package.json
  vite.config.ts
  src/
    portal/        公開ポータル
    speakloop/     SpeakLoop
    skitvoice/     SkitVoice非公開案内
    privacy/       プライバシーポリシー
    components/ui/ repo所有shadcn/ui
    shared/        共通ヘッダー、サンプル表示枠など
    lib/           共通ユーティリティ
    styles/        Tailwind entryとcompatibility layer
```

Viteのbuild出力はWorker Static Assetsから配信する。移行中はroute単位で旧HTMLと新buildを切り替え、同一画面の二重mountはしない。

## 残りの移行手順

公開4routeの表示層はReactへ切替済みである。残るのは状態管理の移行とする。

1. 現行API request/responseをfixture化する。録音状態、polling、キャンセル、比較再生の状態遷移テストを追加する。
2. `app_public_session.js` 相当の認証表示とAPI clientをTypeScript化する。
3. SpeakLoopの録音処理と状態reducerを移し、旧DOM版と同じAPI contractで動かす。
4. SkitVoiceの参照音声slotとjob pollingを移す。IndexedDBに保存済みの旧データを読めるmigrationを用意する。
5. 状態移行の完了後に、対応する旧公開controllerを削除する。

各段階でデスクトップ幅とモバイル幅の実ブラウザ確認を行う。確認対象には権限拒否と録音形式の差分を含める。

## 完了条件

- API path、FormData field、job snapshot、error messageのAPI互換を維持する。
- 通常時だけでなく、状態遷移をテストする。対象は権限拒否・録音中断・quota超過・job失敗・キャンセル・ページ再読込である。
- IndexedDB/localStorageのkeyを変える場合は旧draftを移行する。
- デスクトップ幅とモバイル幅で実ブラウザ確認する。確認対象は録音、タブ音声共有、比較再生、job進捗である。
- 新旧コードを長期間二重保守しない。route切替後は対応する旧公開scriptを削除する。

全面移行の完了を今回の保存層・docs・CI改善と同じ変更へ混ぜない。まず状態とAPI契約をテストで固定し、route単位の小さい変更として実施する。
