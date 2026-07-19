import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  PRACTICE_LLM_COMPARISON_MODELS,
  PRACTICE_LLM_PROMPT,
  PracticeLlmError,
  buildPracticeLlmInput,
  callPracticeLlmService,
  comparisonAlignmentsFromLlmResult,
  supportedPracticeComparisonModel,
  validatePlaybackPaddingSeconds,
  validatePracticeLlmResult,
} from "../cloudflare/worker.mjs";

// This mirrors tests/test_practice_llm.py so the Cloudflare Worker port of
// src/mo_speech/practice_llm.py stays behaviorally identical to the local
// FastAPI version. Keep both files in sync when either side changes.

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "practice_llm_comparison",
  "zh_real_20260718_75a32d86.json",
);

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertDeepClose(actual, expected, path = "") {
  if (typeof expected === "number") {
    assert.ok(
      Math.abs(actual - expected) <= 1e-6,
      `${path || "value"}: expected ${actual} to be close to ${expected}`,
    );
    return;
  }
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    assert.ok(actual && typeof actual === "object", `${path}: expected an object`);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path}: keys differ`);
    for (const key of Object.keys(expected)) {
      assertDeepClose(actual[key], expected[key], `${path}.${key}`);
    }
    return;
  }
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${path}: length differs`);
    expected.forEach((item, index) => assertDeepClose(actual[index], item, `${path}[${index}]`));
    return;
  }
  assert.equal(actual, expected, path);
}

// Shape a fixture's evidence response like what the model now returns. The
// fixture records a real, reviewed request/response pair from before this
// change, when the LLM still echoed matched_text/start/end/playback_start/
// playback_end. The app now computes those from word_start_index/word_end_index
// instead, so tests that simulate a model response strip them here.
function stripLlmSuppliedTimestamps(response) {
  const stripped = deepClone(response);
  for (const phrase of stripped.phrases) {
    for (const side of ["reference", "attempt"]) {
      const range = phrase[side];
      delete range.matched_text;
      delete range.start;
      delete range.end;
      delete range.playback_start;
      delete range.playback_end;
    }
  }
  return stripped;
}

test("practice LLM prompt requires the complete wrong utterance and delegates timestamps to the app", () => {
  assert.ok(PRACTICE_LLM_PROMPT.includes("誤って発話した語を含む対応発話全体"));
  assert.ok(PRACTICE_LLM_PROMPT.includes("一致した末尾だけへ狭めない"));
  assert.ok(PRACTICE_LLM_PROMPT.includes("word_start_index"));
  assert.ok(PRACTICE_LLM_PROMPT.includes("返す必要はない"));
  assert.ok(!PRACTICE_LLM_PROMPT.includes("playback_start"));
  assert.ok(PRACTICE_LLM_PROMPT.includes("アプリ側で意味判断や採点を作り直す必要がない完成結果"));
});

test("practice LLM model and padding settings are restricted", () => {
  assert.deepEqual(PRACTICE_LLM_COMPARISON_MODELS, ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini", "gpt-5.4-nano"]);
  assert.equal(supportedPracticeComparisonModel(""), "gpt-5.6-terra");
  assert.equal(supportedPracticeComparisonModel("gpt-5.4-nano"), "gpt-5.4-nano");
  assert.throws(() => supportedPracticeComparisonModel("gpt-4o"));

  assert.equal(validatePlaybackPaddingSeconds("0.1"), 0.1);
  assert.equal(validatePlaybackPaddingSeconds("0.50"), 0.5);
  for (const value of ["-0.05", "0.03", "0.55", "not-a-number"]) {
    assert.throws(() => validatePlaybackPaddingSeconds(value));
  }
});

test("reviewed real ASR pair computes timestamps from word indexes", () => {
  const fixture = loadFixture();
  const modelOutput = stripLlmSuppliedTimestamps(fixture.llm_response);

  const validated = validatePracticeLlmResult(modelOutput, fixture.input);

  assert.equal(validated.overall_score, 59);
  // Recomputed purely from word_start_index/word_end_index must reproduce the
  // same numbers that were previously observed as correct in the real session.
  assertDeepClose(validated.phrases[3].attempt, fixture.llm_response.phrases[3].attempt);
  assertDeepClose(validated.phrases[3].attempt, {
    status: "partial",
    word_start_index: 17,
    word_end_index: 24,
    matched_text: "你就像咱妈样呢",
    start: 8.459,
    end: 10.289,
    playback_start: 8.359,
    playback_end: 10.26,
  });
});

test("matched_text from the model is ignored even if present", () => {
  const fixture = loadFixture();
  const modelOutput = stripLlmSuppliedTimestamps(fixture.llm_response);
  modelOutput.phrases[0].reference.matched_text = "位置番号と無関係な文字列";

  const validated = validatePracticeLlmResult(modelOutput, fixture.input);

  assert.equal(validated.phrases[0].reference.matched_text, "你好");
});

test("missing range computes empty matched_text and null timestamps", () => {
  const fixture = loadFixture();
  const modelOutput = stripLlmSuppliedTimestamps(fixture.llm_response);
  Object.assign(modelOutput.phrases[0].reference, {
    status: "missing",
    word_start_index: null,
    word_end_index: null,
    // Stray fields the model has no schema slot for anymore; must be ignored.
    matched_text: "位置番号がない場合の誤った文字列",
    start: 1.0,
  });

  const validated = validatePracticeLlmResult(modelOutput, fixture.input);

  assert.deepEqual(validated.phrases[0].reference, {
    status: "missing",
    word_start_index: null,
    word_end_index: null,
    matched_text: "",
    start: null,
    end: null,
    playback_start: null,
    playback_end: null,
  });
});

const INVALID_RESULT_CASES = [
  { path: ["phrases", 0, "reference", "word_start_index"], value: -1 },
  { path: ["phrases", 3, "reference", "word_end_index"], value: 24 },
  { path: ["phrases", 2, "attempt", "word_end_index"], value: 9 },
  { path: ["phrases", 3, "phrase_index"], value: 2 },
  { path: ["phrases", 1, "target_text"], value: "花了三个多小时" },
  { path: ["phrases", 0, "reference", "status"], value: "unknown" },
];

for (const { path: fieldPath, value } of INVALID_RESULT_CASES) {
  test(`invalid LLM result is rejected without legacy fallback: ${fieldPath.join(".")}`, () => {
    const fixture = loadFixture();
    const modelOutput = stripLlmSuppliedTimestamps(fixture.llm_response);
    let target = modelOutput;
    for (const part of fieldPath.slice(0, -1)) {
      target = target[part];
    }
    target[fieldPath[fieldPath.length - 1]] = value;

    assert.throws(
      () => validatePracticeLlmResult(modelOutput, fixture.input),
      (error) => {
        assert.ok(error instanceof PracticeLlmError);
        assert.equal(error.stage, "validate_response");
        assert.equal(error.fallback_to_legacy, false);
        return true;
      },
    );
  });
}

test("LLM result is exposed to existing phrase playback without changing times", () => {
  const fixture = loadFixture();
  const validated = validatePracticeLlmResult(stripLlmSuppliedTimestamps(fixture.llm_response), fixture.input);

  const [attempt, reference] = comparisonAlignmentsFromLlmResult(validated);

  assert.equal(attempt.target_phrase_count, 4);
  assert.equal(attempt.all_phrases_playable, true);
  assert.ok(Math.abs(attempt.phrases[3].audio_start - 8.359) <= 1e-6);
  assert.ok(Math.abs(attempt.phrases[3].audio_end - 10.26) <= 1e-6);
  assert.ok(Math.abs(reference.phrases[3].audio_start - 6.13675) <= 1e-6);
  assert.ok(Math.abs(reference.phrases[3].audio_end - 7.413083) <= 1e-6);
});

function fakeOpenAiResponsesEnv(modelOutput) {
  const calls = [];
  const env = {
    OPENAI_API_KEY: "openai-secret",
    __fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ output_text: JSON.stringify(modelOutput) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
  return { env, calls };
}

test("practice LLM service sends the strict schema and reconstructs the full result", async () => {
  const fixture = loadFixture();
  const modelOutput = stripLlmSuppliedTimestamps(fixture.llm_response);
  const { env, calls } = fakeOpenAiResponsesEnv(modelOutput);

  const { result } = await callPracticeLlmService(env, {
    model: "gpt-5.6-terra",
    inputPayload: fixture.input,
  });

  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].body.model, "gpt-5.6-terra");
  assert.equal(calls[0].body.instructions, PRACTICE_LLM_PROMPT);
  assert.equal(calls[0].body.text.format.type, "json_schema");
  assert.equal(calls[0].body.text.format.strict, true);
  // The service reconstructs matched_text/start/end/playback_* from word
  // indexes, so the final result matches the full (pre-strip) fixture even
  // though the simulated model only returned status/word_start_index/word_end_index.
  assertDeepClose(result, fixture.llm_response);
});

test("practice LLM service raises a validate_response PracticeLlmError on invalid word indexes", async () => {
  const fixture = loadFixture();
  const invalid = stripLlmSuppliedTimestamps(fixture.llm_response);
  invalid.phrases[0].attempt.word_start_index = 999;
  const { env } = fakeOpenAiResponsesEnv(invalid);

  await assert.rejects(
    () => callPracticeLlmService(env, { model: "gpt-5.6-terra", inputPayload: fixture.input }),
    (error) => {
      assert.ok(error instanceof PracticeLlmError);
      assert.equal(error.stage, "validate_response");
      return true;
    },
  );
});

test("practice LLM service wraps a non-ok OpenAI response as a call_api PracticeLlmError", async () => {
  const fixture = loadFixture();
  const env = {
    OPENAI_API_KEY: "openai-secret",
    __fetch: async () =>
      new Response(JSON.stringify({ error: { message: "insufficient_quota" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
  };

  await assert.rejects(
    () => callPracticeLlmService(env, { model: "gpt-5.6-terra", inputPayload: fixture.input }),
    (error) => {
      assert.ok(error instanceof PracticeLlmError);
      assert.equal(error.stage, "call_api");
      return true;
    },
  );
});

test("buildPracticeLlmInput mirrors the local FastAPI input shape", () => {
  const input = buildPracticeLlmInput({
    targetLanguage: "en-US",
    targetText: "Hello world.",
    paddingSeconds: 0.15,
    referenceAudioDuration: 1.2,
    attemptAudioDuration: 1.4,
    referenceAsr: { recognized_text: "Hello world", model: "whisper-1", words: [] },
    attemptAsr: { recognized_text: "Hello word", model: "whisper-1", words: [] },
  });

  assert.deepEqual(input, {
    target_language: "en-US",
    target_text: "Hello world.",
    padding_seconds: 0.15,
    reference_audio_duration: 1.2,
    attempt_audio_duration: 1.4,
    reference_asr: { recognized_text: "Hello world", model: "whisper-1", words: [] },
    attempt_asr: { recognized_text: "Hello word", model: "whisper-1", words: [] },
  });
});
