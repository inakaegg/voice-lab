CREATE TABLE IF NOT EXISTS public_sample_audios (
  feature TEXT NOT NULL,
  language TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL,
  audio_mime_type TEXT NOT NULL,
  audio_r2_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (feature, language)
);

CREATE INDEX IF NOT EXISTS public_sample_audios_updated_at_idx
  ON public_sample_audios (updated_at DESC);
