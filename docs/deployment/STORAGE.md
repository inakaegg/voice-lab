# Cloudflare保存層の境界

## 目的

公開デモで扱う設定、quota、監査イベント、job metadata、公開サンプル音声を、データ特性に合うCloudflareサービスへ分ける。ユーザーの入力音声と生成音声はCloudflare公開版で履歴保存せず、音声履歴はローカルFastAPI版だけの機能とする。

## 現在の実装

| データ | 現在の保存先 | 状態 |
| --- | --- | --- |
| ユーザー設定、公開アクセス設定 | Workers KV | 実装済み |
| 短期job snapshot、warmup ready | Workers KV | 実装済み。TTL付き |
| ユーザー音声履歴 | Cloudflare公開版では保存しない | ローカルFastAPI版だけで利用 |
| 公開サンプル音声metadata/blob | D1 / R2（bindingなしではKV fallback） | 日本語・中国語・英語を含む複数サンプルへ対応 |
| quota使用数、簡易audit log | D1（bindingなしではKV fallback） | emailはSHA-256 hashとして保存 |

`MO_SPEECH_AUDIO_R2` bindingは、管理者が公開用として明示的に登録したサンプル音声だけに使う。Cloudflare Workerは翻訳、VC、SpeakLoop、SkitVoice、TTSの入力・生成音声を履歴indexやblobとして書き込まない。

## R2 binding

実Cloudflare環境ではR2を有効化し、production bucket `mo-speech-audio`、preview bucket `mo-speech-audio-preview`、binding `MO_SPEECH_AUDIO_R2` を作成済み。設定は次のとおり。

```toml
[[r2_buckets]]
binding = "MO_SPEECH_AUDIO_R2"
bucket_name = "mo-speech-audio"
preview_bucket_name = "mo-speech-audio-preview"
```

ローカル/CIではfake R2 bindingを使い、公開サンプルのR2保存、取得、削除、KV fallbackを検証する。bucket名やCloudflare account IDはコードへハードコードしない。

## R2の用途

R2 objectには公開サンプル音声のbytesを置き、content typeをHTTP metadataへ保存する。bucketをpublicにはせず、Workerの公開サンプルAPIから配信する。ユーザー音声履歴用の `audio-history:*` keyは新規作成しない。

以前の実装が作成した `audio-history:*` objectやKV indexが既存環境に残っている場合、新しいWorkerは読み書きしない。production dataの削除はdeployと分離した一回限りの運用作業とし、対象件数とkey prefixを確認してから実施する。

## D1 resourceと移行対象

D1 database `mo-speech-demo-db` とbinding `MO_SPEECH_DB` は作成済みで、schemaは `migrations/` で管理する。bindingがある環境ではquotaと監査ログをD1へ保存し、公開サンプルmetadataをD1、公開サンプル音声blobをR2へ保存する。bindingがないローカル・テスト環境ではKV fallbackを維持する。

```sql
CREATE TABLE public_users (
  email_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE quota_usage_daily (
  email_hash TEXT NOT NULL,
  feature TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (email_hash, feature, usage_date)
);

CREATE TABLE quota_usage_total (
  email_hash TEXT NOT NULL,
  feature TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (email_hash, feature)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor_email_hash TEXT,
  action TEXT NOT NULL,
  feature TEXT,
  path TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX audit_events_occurred_at_idx ON audit_events (occurred_at DESC);
```

音声、台本、入力本文、OAuth token、raw IP addressはauditへ保存しない。emailを保存する必要がある場合も用途と保持期間を決め、表示用情報と台帳用識別子を分ける。

## 移行順

1. 公開サンプル音声blobのR2保存とmetadataのD1保存: 完了。
2. audit logとquota台帳のD1移行: 完了。旧KV auditは初回アクセス時、旧quota値は対象ユーザーの初回利用時に引き継ぐ。
3. Cloudflare版のユーザー音声履歴保存を廃止: 完了。空のread contractだけを共有管理UIの機能判定用に維持する。
4. 旧 `audio-history:*` dataが実環境に残る場合は、件数とprefixを確認して一回限りの削除を行う。
5. 課金水準の厳密な同時更新が必要になった場合のみDurable Objectsを検討する。現在は公開デモの過剰利用防止を目的とする。

保存先の切替はbindingの有無で暗黙に行う範囲を最小化し、管理APIのruntime表示またはログから実保存先を確認できるようにする。音声履歴をCloudflareへ再導入する場合は、保持期間、削除手段、利用者への表示を先に仕様化する。
