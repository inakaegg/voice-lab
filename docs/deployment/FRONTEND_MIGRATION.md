# 公開フロントエンドの段階移行

## 判断

公開画面の状態管理が大きくなっているため、Vite + React + TypeScriptへの移行は有効。ただし既存画面を一括移行しない。現行のvanilla JavaScriptは実運用されており、録音、IndexedDB、比較再生、job pollingを同時に書き換えると回帰原因を切り分けにくい。

移行対象は公開ポータル、SpeakLoop、SkitVoiceに限定する。管理画面、内部検証画面、旧互換画面は対象外とし、Worker/FastAPIのAPI互換を維持する。

## 実装状況（2026-07-10）

- 公開ポータル、SpeakLoop、SkitVoiceをVite + React + TypeScriptのmulti-page buildへ切り替えた。
- Reactは公開画面の構造、共通ヘッダー、サンプル表示枠、レスポンシブレイアウトを担当する。
- 録音、比較再生、IndexedDB、URL参照、RunPod job pollingは、回帰を抑えるため既存controllerをReact mount後に読み込む移行アダプタを使う。
- WorkerとFastAPIは公開3routeだけReact buildを返す。管理画面と旧互換画面は従来HTML/JavaScriptのまま維持する。
- 次段階では、既存controller内の状態遷移をreducer/hooksへ小単位で移し、移行済み部分から旧controllerを縮小する。

### レイアウト比較

SpeakLoopとSkitVoiceは同じ機能・文言のまま、クエリで3案を比較できる。

- `?layout=compact`: 推奨。説明を圧縮し、PCでは主要操作を横並び、スマホでは生成操作を台本直後へ置く。
- `?layout=guided`: 手順と説明を残した段階型。初回利用者向け。
- `?layout=studio`: 暗色の制作画面。PCで台本・参照音声・生成設定を横並びにする。

各画面上部の切替から移動できる。既定は `compact` とし、PC/スマホとも初回操作までのスクロール量を抑える。

## 現在の境界

```text
src/mo_speech/web/
  portal.html                 公開ポータル
  practice.html               SpeakLoop
  app_practice.js             録音・prompt・比較再生・表示状態
  vibevoice_simple.html       SkitVoice
  app_vibevoice.js            draft・参照音声・job・結果状態
  app_public_session.js       公開ログイン状態
  app_public_sample_audio.js  公開サンプル
cloudflare/worker.mjs         route・auth・quota・API gateway
```

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

別の状態として、ログイン、quota表示、参照音声slot、マイク/タブ録音、IndexedDB復元、比較再生を持つ。1つの巨大なcomponentへまとめず、非同期処理の所有者を明確にする。

## 目標構成

```text
apps/web/
  package.json
  vite.config.ts
  src/
    portal/
    speakloop/
      state.ts
      api.ts
      recording.ts
      playback.ts
    skitvoice/
      state.ts
      api.ts
      referenceAudio.ts
      jobPolling.ts
    shared/
      auth.ts
      errors.ts
      audio.ts
```

Viteのbuild出力はWorker Static Assetsから配信する。移行中はroute単位で旧HTMLと新buildを切り替え、同一画面の二重mountはしない。

## 実施順

1. 現行API request/responseをfixture化し、録音状態、polling、キャンセル、比較再生の状態遷移テストを追加する。
2. `app_public_session.js` 相当の認証表示とAPI clientをTypeScript化する。
3. ~~ポータルをReact化し、build/deploy経路とCSS共存を確認する。~~ 完了。
4. SpeakLoopの録音処理と状態reducerを移し、旧DOM版と同じAPI contractで動かす。
5. SpeakLoopの表示はReactへ切替済み。デスクトップ/モバイル/権限拒否/録音形式差分の実ブラウザ確認を行う。
6. SkitVoiceの参照音声slotとjob pollingを移し、IndexedDBに保存済みの旧データを読めるmigrationを用意する。
7. SkitVoice表示はReactへ切替済み。状態移行完了後に旧公開controllerを削除する。

## 完了条件

- API path、FormData field、job snapshot、error messageのAPI互換を維持する。
- 通常時だけでなく、権限拒否、録音中断、quota超過、job失敗、キャンセル、ページ再読込の状態遷移をテストする。
- IndexedDB/localStorageのkeyを変える場合は旧draftを移行する。
- デスクトップ幅とモバイル幅で、録音、タブ音声共有、比較再生、job進捗を実ブラウザで確認する。
- 新旧コードを長期間二重保守しない。route切替後は対応する旧公開scriptを削除する。

全面移行の完了を今回の保存層・docs・CI改善と同じ変更へ混ぜない。まず状態とAPI契約をテストで固定し、route単位の小さい変更として実施する。
