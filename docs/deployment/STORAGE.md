# Cloudflare保存層の分離

## 目的

公開デモで扱う設定、quota、監査イベント、job metadata、音声blobを、データ特性に合うCloudflareサービスへ段階的に分ける。技術導入自体を目的にせず、既存API互換とKV fallbackを保ちながら移行する。

## 現在の実装

| データ | 現在の保存先 | 状態 |
| --- | --- | --- |
| ユーザー設定、公開アクセス設定 | Workers KV | 実装済み |
| 短期job snapshot、warmup ready | Workers KV | 実装済み。TTL付き |
| 音声履歴metadata/index | Workers KV | 実装済み |
| 音声履歴blob | R2（bindingあり）/ KV fallback | production/preview bucketとbinding作成済み |
| 公開サンプル音声metadata/blob | D1 / R2（bindingなしではKV fallback） | 日本語・中国語・英語を含む複数サンプルへ対応 |
| quota使用数、簡易audit log | D1（bindingなしではKV fallback） | emailはSHA-256 hashとして保存 |

`MO_SPEECH_AUDIO_R2` bindingがある場合、新しく保存する音声履歴blobはR2へ置き、metadataとindexだけを `MO_SPEECH_KV` に置く。bindingがない場合は従来どおりKVへ保存する。

保存済みindexには各entryの `audio_storage` を `kv` または `r2` として記録する。移行期間はKV entryとR2 entryの混在を許容し、取得・削除・上限超過削除はentryごとの保存先を参照する。旧entryは `audio_storage` がないため `kv` として読む。この方式により一括コピーをせず段階移行できる。

## R2 binding

実Cloudflare環境ではR2を有効化し、production bucket `mo-speech-audio`、preview bucket `mo-speech-audio-preview`、binding `MO_SPEECH_AUDIO_R2` を作成済み。設定は次のとおり。

```toml
[[r2_buckets]]
binding = "MO_SPEECH_AUDIO_R2"
bucket_name = "mo-speech-audio"
preview_bucket_name = "mo-speech-audio-preview"
```

ローカル/CIではfake R2 bindingを使い、R2保存、取得、削除、KV fallback、旧KV entry互換を検証する。bucket名やCloudflare account IDはコードへハードコードしない。

## R2 key

音声履歴は既存の論理keyを維持する。

```text
audio-history:{recordings|outputs}:{safe_filename}:audio
```

R2 objectには音声bytesを置き、content typeをHTTP metadataへ保存する。公開URLを直接発行せず、認証済みの既存 `/api/audio-history/{kind}/{filename}` からWorkerが返す。これによりbucketをpublicにせず、管理APIの認証境界を維持する。

## D1 resourceと移行対象

D1 database `mo-speech-demo-db` とbinding `MO_SPEECH_DB` は作成済みで、schemaは `migrations/` で管理する。bindingがある環境ではquotaと監査ログをD1へ保存し、公開サンプルmetadataをD1、音声blobをR2へ保存する。bindingがないローカル・テスト環境ではKV fallbackを維持する。

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

1. 音声履歴blobのR2保存: 完了。
2. 公開サンプル音声blobのR2保存とmetadataのD1保存: 完了。
3. audit logとquota台帳のD1移行: 完了。旧KV auditは初回アクセス時、旧quota値は対象ユーザーの初回利用時に引き継ぐ。
4. 課金水準の厳密な同時更新が必要になった場合のみDurable Objectsを検討する。現在は公開デモの過剰利用防止を目的とする。
5. retention jobとユーザー/管理者向け削除手順を追加する。

各段階で既存JSON responseを変えず、旧保存データを読める期間を設ける。読み書きの切替はbindingの有無で暗黙に行う範囲を最小化し、管理APIのruntime表示またはログから実保存先を確認できるようにする。
