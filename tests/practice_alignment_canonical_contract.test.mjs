import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PracticeAlignmentError,
  PracticeAlignmentInputError,
  practiceComparisonAlignmentCanonical,
  practiceContentMatches,
  splitPracticePhrases,
} from "../cloudflare/worker.mjs";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "practice_alignment_canonical",
);

function cases(name) {
  const payload = JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8"));
  assert.equal(payload.fixture_contract_version, 1);
  assert.equal(payload.alignment_contract_version, 1);
  return payload.cases;
}

test("invalid timestamp payload is not misclassified as no speech", () => {
  assert.throws(
    () => practiceComparisonAlignmentCanonical({
      targetText: "Open it.",
      recognizedText: "",
      targetLanguage: "en-US",
      asrTimestamps: {
        available: true,
        words: [],
        segments: [],
        raw_timestamp_word_count: 1,
      },
    }),
    (error) => {
      assert.ok(error instanceof PracticeAlignmentError);
      assert.equal(error.error_code, "practice_alignment_provider_contract_error");
      assert.equal(error.reason, "invalid_timestamp_payload");
      assert.equal(error.stage, "attempt_asr");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

for (const fixture of [
  { targetText: "...", asrTimestamps: {}, reason: "empty_target" },
  {
    targetText: Array.from({ length: 17 }, (_, index) => `phrase ${index}.`).join(" "),
    asrTimestamps: {},
    reason: "alignment_input_too_large",
  },
  {
    targetText: "Open it.",
    asrTimestamps: { raw_timestamp_word_count: 257 },
    reason: "alignment_input_too_large",
  },
  {
    targetText: Array.from({ length: 16 }, (_, index) => `phrase ${index}.`).join(" "),
    asrTimestamps: { raw_timestamp_word_count: 65 },
    reason: "alignment_input_too_large",
  },
]) {
  test(`canonical input limit: ${fixture.reason} ${fixture.targetText.slice(0, 12)}`, () => {
    assert.throws(
      () => practiceComparisonAlignmentCanonical({
        ...fixture,
        recognizedText: "",
        targetLanguage: "en-US",
      }),
      (error) => {
        assert.ok(error instanceof PracticeAlignmentInputError);
        assert.equal(error.error_code, "practice_alignment_invalid_input");
        assert.equal(error.reason, fixture.reason);
        assert.equal(error.stage, "input");
        assert.equal(error.retryable, false);
        return true;
      },
    );
  });
}

for (const rawCount of ["not-a-number", -1]) {
  test(`invalid raw count falls back to sanitized rows: ${rawCount}`, () => {
    const result = practiceComparisonAlignmentCanonical({
      targetText: "Open it.",
      recognizedText: "Open",
      targetLanguage: "en-US",
      asrTimestamps: {
        available: true,
        raw_timestamp_word_count: rawCount,
        words: [{ text: "Open", start: 0, end: 0.2 }],
      },
    });

    assert.equal(result.diagnostics.raw_timestamp_word_count, 1);
  });
}

for (const fixture of [
  { timestamp: { start: "not-a-number", end: 0.2 }, reason: "non_numeric", expectedStart: null, expectedEnd: 0.2 },
  { timestamp: { start: 0, end: Infinity }, reason: "non_finite", expectedStart: 0, expectedEnd: null },
  { timestamp: { start: -0.1, end: 0.2 }, reason: "negative_start", expectedStart: -0.1, expectedEnd: 0.2 },
  { timestamp: { start: 0.2, end: 0.1 }, reason: "end_before_start", expectedStart: 0.2, expectedEnd: 0.1 },
]) {
  test(`invalid word unit is diagnosed: ${fixture.reason}`, () => {
    const result = practiceComparisonAlignmentCanonical({
      targetText: "Open it.",
      recognizedText: "Open it",
      targetLanguage: "en-US",
      asrTimestamps: {
        available: true,
        words: [{ text: "Open it", ...fixture.timestamp }],
      },
    });

    assert.equal(result.phrases[0].assignment_status, "text_only");
    assert.equal(result.phrases[0].available, false);
    assert.deepEqual(result.diagnostics.invalid_timestamp_units, [{
      source: "words",
      source_index: 0,
      text: "Open it",
      start: fixture.expectedStart,
      end: fixture.expectedEnd,
      reason: fixture.reason,
    }]);
  });
}

test("invalid word source falls back to a safe exact segment", () => {
  const result = practiceComparisonAlignmentCanonical({
    targetText: "Open it.",
    recognizedText: "Open it",
    targetLanguage: "en-US",
    asrTimestamps: {
      available: true,
      words: [
        { text: "it", start: 0.3, end: 0.5 },
        { text: "Open", start: 0, end: 0.2 },
      ],
      segments: [{ text: "Open it.", start: 0, end: 0.5 }],
    },
  });

  assert.equal(result.phrases[0].timestamp_source, "segments");
  assert.equal(result.phrases[0].available, true);
  assert.deepEqual(result.diagnostics.diagnostic_flags, [
    "non_monotonic_timestamp_source",
    "overlapping_timestamp_units",
  ]);
  assert.equal(result.diagnostics.raw_timestamp_word_count, 2);
  assert.deepEqual(result.diagnostics.invalid_timestamp_units.map((unit) => unit.source_index), [0, 1]);
  assert.deepEqual(new Set(result.diagnostics.invalid_timestamp_units.map((unit) => unit.reason)), new Set([
    "non_monotonic_timestamp_source",
  ]));
});

test("safe words remain primary while invalid segments are diagnosed", () => {
  const result = practiceComparisonAlignmentCanonical({
    targetText: "Open it.",
    recognizedText: "Open it",
    targetLanguage: "en-US",
    asrTimestamps: {
      available: true,
      words: [
        { text: "Open", start: 0, end: 0.2 },
        { text: "it", start: 0.2, end: 0.4 },
      ],
      segments: [{ text: "Open it.", start: 0, end: Infinity }],
    },
  });

  assert.equal(result.phrases[0].timestamp_source, "words");
  assert.equal(result.diagnostics.raw_timestamp_segment_count, 1);
  assert.equal(result.diagnostics.valid_segment_count, 0);
  assert.deepEqual(result.diagnostics.invalid_timestamp_units, [{
    source: "segments",
    source_index: 0,
    text: "Open it.",
    start: 0,
    end: null,
    reason: "non_finite",
  }]);
});

test("disjoint word and segment sources keep words and flag the conflict", () => {
  const result = practiceComparisonAlignmentCanonical({
    targetText: "Open it.",
    recognizedText: "Open it",
    targetLanguage: "en-US",
    asrTimestamps: {
      available: true,
      words: [
        { text: "Open", start: 0, end: 0.2 },
        { text: "it", start: 0.2, end: 0.4 },
      ],
      segments: [{ text: "Open it.", start: 2, end: 2.4 }],
    },
  });

  assert.equal(result.phrases[0].timestamp_source, "words");
  assert.deepEqual(result.diagnostics.diagnostic_flags, ["word_segment_boundary_conflict"]);
  assert.deepEqual(result.diagnostics.invalid_timestamp_units, [{
    source: "segments",
    source_index: 0,
    text: "Open it.",
    start: 2,
    end: 2.4,
    reason: "word_segment_boundary_conflict",
  }]);
});

for (const fixture of cases("splitter_contract.json")) {
  test(`canonical splitter: ${fixture.name}`, () => {
    assert.deepEqual(splitPracticePhrases(fixture.text), fixture.expected_phrases);
  });
}

for (const fixture of cases("content_contract.json")) {
  test(`canonical content: ${fixture.name}`, () => {
    assert.equal(
      practiceContentMatches(fixture.target_text, fixture.matched_text, fixture.target_language),
      fixture.expected_content_matched,
    );
  });
}
