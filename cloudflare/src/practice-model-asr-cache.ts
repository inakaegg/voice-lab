const PRACTICE_MODEL_ASR_CACHE_KV_PREFIX = "practice-model-asr:";
const PRACTICE_MODEL_ASR_CACHE_DEFAULT_TTL_SECONDS = 3600;

type TimestampRow = Record<string, unknown>;

export interface AsrTranscription {
  text?: unknown;
  model?: unknown;
  timestamp_granularities?: unknown[];
  words?: TimestampRow[];
  segments?: TimestampRow[];
  raw_timestamp_word_count?: unknown;
  raw_timestamp_segment_count?: unknown;
  [key: string]: unknown;
}

interface CacheKv {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options: { expirationTtl: number },
  ): Promise<void>;
}

export interface PracticeModelAsrCacheEnv {
  MO_SPEECH_KV?: CacheKv;
  CLOUDFLARE_PRACTICE_MODEL_ASR_CACHE_TTL_SECONDS?: unknown;
}

export interface AsrTimestamps {
  available: boolean;
  model: unknown;
  timestamp_granularities: unknown[];
  words: TimestampRow[];
  segments: TimestampRow[];
  raw_timestamp_word_count: number;
  raw_timestamp_segment_count: number;
}

const ephemeralPracticeModelAsrCache = new Map<string, AsrTranscription>();

export function practiceModelAsrCacheKey(
  digest: string,
  model: string,
  sourceLanguage: string,
): string {
  return `${PRACTICE_MODEL_ASR_CACHE_KV_PREFIX}${model}:${sourceLanguage}:${digest}`;
}

export function serializeAsrTimestamps(
  transcription: AsrTranscription | null | undefined = {},
): AsrTimestamps {
  const source = transcription || {};
  const words = source.words || [];
  const segments = source.segments || [];
  const rawWordCount = Number(
    source.raw_timestamp_word_count ?? words.length,
  );
  const rawSegmentCount = Number(
    source.raw_timestamp_segment_count ?? segments.length,
  );
  return {
    available: Boolean(rawWordCount || rawSegmentCount),
    model: source.model || "",
    timestamp_granularities: source.timestamp_granularities || [],
    words,
    segments,
    raw_timestamp_word_count: rawWordCount,
    raw_timestamp_segment_count: rawSegmentCount,
  };
}

export function practiceAsrHasSpeech(
  transcription: AsrTranscription | null | undefined,
): boolean {
  const timestamps = serializeAsrTimestamps(transcription || {});
  return Boolean(
    String(transcription?.text || "").trim()
    || timestamps.words.length
    || timestamps.segments.length
  );
}

export async function lookupPracticeModelAsrCache(
  env: PracticeModelAsrCacheEnv,
  key: string,
): Promise<AsrTranscription | null> {
  const cached = env.MO_SPEECH_KV
    ? await kvGetJson(env.MO_SPEECH_KV, key)
    : ephemeralPracticeModelAsrCache.get(key) || null;
  return practiceAsrHasSpeech(cached) ? cached : null;
}

export async function storePracticeModelAsrCache(
  env: PracticeModelAsrCacheEnv,
  key: string,
  transcription: AsrTranscription,
): Promise<void> {
  if (!practiceAsrHasSpeech(transcription)) {
    return;
  }
  if (env.MO_SPEECH_KV) {
    await env.MO_SPEECH_KV.put(key, JSON.stringify(transcription), {
      expirationTtl: numberFromEnv(
        env.CLOUDFLARE_PRACTICE_MODEL_ASR_CACHE_TTL_SECONDS,
        PRACTICE_MODEL_ASR_CACHE_DEFAULT_TTL_SECONDS,
      ),
    });
    return;
  }
  ephemeralPracticeModelAsrCache.set(key, transcription);
}

async function kvGetJson(
  kv: CacheKv,
  key: string,
): Promise<AsrTranscription | null> {
  const raw = await kv.get(key);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as AsrTranscription;
  } catch {
    return null;
  }
}

function numberFromEnv(value: unknown, fallback: number): number {
  const number = Number.parseFloat(String(value || ""));
  return Number.isFinite(number) ? number : fallback;
}
