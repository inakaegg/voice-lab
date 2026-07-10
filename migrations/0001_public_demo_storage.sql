CREATE TABLE IF NOT EXISTS public_users (
  email_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quota_usage_daily (
  email_hash TEXT NOT NULL,
  feature TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (email_hash, feature, usage_date)
);

CREATE TABLE IF NOT EXISTS quota_usage_total (
  email_hash TEXT NOT NULL,
  feature TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (email_hash, feature)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor_email_hash TEXT,
  action TEXT NOT NULL,
  feature TEXT,
  path TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS audit_events_occurred_at_idx ON audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON audit_events (actor_email_hash, occurred_at DESC);

CREATE TABLE IF NOT EXISTS job_metadata (
  id TEXT PRIMARY KEY,
  feature TEXT NOT NULL,
  owner_email_hash TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS job_metadata_owner_idx ON job_metadata (owner_email_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS job_metadata_status_idx ON job_metadata (status, updated_at DESC);
