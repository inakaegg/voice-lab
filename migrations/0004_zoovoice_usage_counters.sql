CREATE TABLE IF NOT EXISTS zoovoice_usage_counters (
  feature TEXT PRIMARY KEY,
  usage_date TEXT NOT NULL,
  daily_count INTEGER NOT NULL DEFAULT 0 CHECK (daily_count >= 0),
  usage_month TEXT NOT NULL,
  monthly_count INTEGER NOT NULL DEFAULT 0 CHECK (monthly_count >= 0),
  updated_at TEXT NOT NULL
);
