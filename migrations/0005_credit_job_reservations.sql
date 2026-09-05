-- credit-base の予約と、voice-lab 側の処理・RunPodジョブの対応表。
--
-- 予約キーはジョブ投入より前に決まり、RunPodのjobIdは投入後にしか分からない。
-- 対応を残さないと、あとから照会も精算もできない。
--
-- job_status と execution_time_ms は「観測できたジョブの終了状態」を保つ。
-- RunPodは完了から30分で /status の結果を捨てるため、観測した時点でこちらへ写しておかないと
-- 取り戻せない。精算額もこの記録値から算出する（再試行のたびに額が変わると
-- credit-base 側で冪等キーの衝突になる）。
CREATE TABLE IF NOT EXISTS credit_job_reservations (
  reserve_key TEXT PRIMARY KEY,
  job_id TEXT,
  subject_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sync', 'job')),

  reserved_amount INTEGER NOT NULL CHECK (reserved_amount > 0),

  -- 精算の状態。resolved_elsewhere は cron など別の経路が先に精算した場合
  status TEXT NOT NULL CHECK (status IN ('in_flight', 'settled', 'released', 'resolved_elsewhere')),

  -- 観測したジョブの終了状態。NULL は「まだ誰も終了を見ていない」
  job_status TEXT CHECK (job_status IS NULL OR job_status IN ('succeeded', 'failed')),
  execution_time_ms INTEGER CHECK (execution_time_ms IS NULL OR execution_time_ms >= 0),

  settled_amount INTEGER CHECK (settled_amount IS NULL OR settled_amount >= 0),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- ポーリングはjobIdから予約を引く
CREATE INDEX IF NOT EXISTS idx_credit_job_reservations_job_id
  ON credit_job_reservations (job_id);
