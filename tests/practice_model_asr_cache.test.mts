import assert from "node:assert/strict";
import test from "node:test";

import {
  lookupPracticeModelAsrCache,
  practiceAsrHasSpeech,
  practiceModelAsrCacheKey,
  serializeAsrTimestamps,
  storePracticeModelAsrCache,
} from "../cloudflare/src/practice-model-asr-cache.ts";

function fakeKv(initialEntries = []) {
  const values = new Map(initialEntries);
  const puts = [];
  return {
    puts,
    async get(key) {
      return values.get(key) ?? null;
    },
    async put(key, value, options) {
      values.set(key, value);
      puts.push({ key, value, options });
    },
  };
}

test("practice model ASR cache key preserves the existing KV format", () => {
  assert.equal(
    practiceModelAsrCacheKey("012345abcdef", "gpt-4o-transcribe", "en-US"),
    "practice-model-asr:gpt-4o-transcribe:en-US:012345abcdef",
  );
});

test("practice model ASR cache uses the default TTL and accepts an env override", async () => {
  const defaultKv = fakeKv();
  await storePracticeModelAsrCache(
    { MO_SPEECH_KV: defaultKv },
    "default-key",
    { text: "hello" },
  );
  assert.equal(defaultKv.puts[0].options.expirationTtl, 3600);

  const overriddenKv = fakeKv();
  await storePracticeModelAsrCache(
    {
      MO_SPEECH_KV: overriddenKv,
      CLOUDFLARE_PRACTICE_MODEL_ASR_CACHE_TTL_SECONDS: "7200",
    },
    "override-key",
    { text: "hello" },
  );
  assert.equal(overriddenKv.puts[0].options.expirationTtl, 7200);
});

test("practice model ASR cache rejects empty speech on store and lookup", async () => {
  const kv = fakeKv([
    ["empty-key", JSON.stringify({ text: " ", words: [], segments: [] })],
  ]);

  await storePracticeModelAsrCache(
    { MO_SPEECH_KV: kv },
    "not-stored",
    { text: "", words: [], segments: [] },
  );

  assert.equal(kv.puts.length, 0);
  assert.equal(
    await lookupPracticeModelAsrCache({ MO_SPEECH_KV: kv }, "empty-key"),
    null,
  );
  assert.equal(practiceAsrHasSpeech({ text: "", words: [], segments: [] }), false);
  assert.equal(practiceAsrHasSpeech({ text: "", words: [{ word: "声" }] }), true);
  assert.equal(practiceAsrHasSpeech({ text: "", segments: [{ text: "声" }] }), true);
});

test("ASR timestamp serialization preserves empty input compatibility", () => {
  assert.deepEqual(serializeAsrTimestamps(null), {
    available: false,
    model: "",
    timestamp_granularities: [],
    words: [],
    segments: [],
    raw_timestamp_word_count: 0,
    raw_timestamp_segment_count: 0,
  });
});

test("practice model ASR cache falls back to ephemeral memory without a KV binding", async () => {
  const key = "ephemeral-contract-key";
  const transcription = { text: "cached speech" };

  await storePracticeModelAsrCache({}, key, transcription);

  assert.deepEqual(await lookupPracticeModelAsrCache({}, key), transcription);
});
