# Cloudflare保存層の分離

## 目的

公開デモで扱う設定、quota、監査イベント、job metadata、音声blobを、データ特性に合うCloudflareサービスへ段階的に分ける。技術導入自体を目的にせず、既存API互換とKV fallbackを保ちながら移行する。

## 現在の実装

| データ | 現在の保存先 | 状態 |
| --- | --- | --- |
| ユーザー設定、公開アクセス設定 | Workers KV | 実装済み |
| 短期job snapshot、warmup ready | Workers KV | 実装済み。TTL付き |
| 音声履歴metadata/index | Workers KV | 実装済み |
| 音声履歴blob | R2（bindingあり）/ KV fallback | R2 pilot実装済み |
| 公開サンプル音声metadata/blob | Workers KV | 実装済み。R2移行前 |
| quota使用数、簡易audit log | Workers KV | 実装済み。D1移行前 |

`MO_SPEECH_AUDIO_R2` bindingがある場合、新しく保存する音声履歴blobはR2へ置き、metadataとindexだけを `MO_SPEECH_KV` に置く。bindingがない場合は従来どおりKVへ保存する。

保存済みindexには各entryの `audio_storage` を `kv` または `r2` として記録する。移行期間はKV entryとR2 entryの混在を許容し、取得・削除・上限超過削除はentryごとの保存先を参照する。旧entryは `audio_storage` がないため `kv` として読む。この方式により一括コピーをせず段階移行できる。

## R2 binding

実Cloudflare環境でbucketを作る操作は外部リソース変更なので、リポジトリの設定だけでは完了しない。bucket作成後、`wrangler.toml` に次を追加する。

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

## D1へ移す対象

D1は次の段階で導入する。現在の公開デモquotaはWorkers KVのeventual consistencyを許容する過剰利用防止であり、課金台帳ではない。

```sql
CREATE TABLE public_users (
  email_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE quota_usage (
  email_hash TEXT NOT NULL,
  feature TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  daily_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (email_hash, feature, usage_date)
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

1. 音声履歴blobをR2へ保存するpilotを有効化する（コード実装済み、実binding待ち）。
2. 公開サンプル音声blobをR2へ移し、KVにはmetadataとR2 keyだけを置く。
3. D1 migrationとrepository層を追加し、audit logをKVからD1へ移す。
4. quota更新をD1 transactionまたはDurable Objectへ移す。同時更新の必要精度を先に負荷テストで決める。
5. retention jobとユーザー/管理者向け削除手順を追加する。

各段階で既存JSON responseを変えず、旧保存データを読める期間を設ける。読み書きの切替はbindingの有無で暗黙に行う範囲を最小化し、管理APIのruntime表示またはログから実保存先を確認できるようにする。
