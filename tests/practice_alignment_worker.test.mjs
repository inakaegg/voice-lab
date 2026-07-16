import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { practiceComparisonAlignment } from "../cloudflare/worker.mjs";

const FIXTURE_FILES = [
  "practice_alignment_golden_cases.json",
  "practice_alignment_boundary_cases.json",
  "practice_alignment_holdout_cases.json",
  "practice_alignment_validation_cases.json",
  "practice_alignment_regression_cases.json",
];

const CASES = FIXTURE_FILES.flatMap((filename) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${filename}`, import.meta.url), "utf8")),
);

test("Cloudflare practice alignment matches the shared Python contract fixtures", async (context) => {
  for (const fixture of CASES) {
    await context.test(fixture.name, () => {
      const result = practiceComparisonAlignment({
        targetText: fixture.target_text,
        recognizedText: fixture.recognized_text,
        targetLanguage: fixture.target_language,
        asrTimestamps: fixture.asr_timestamps,
      });
      const expected = fixture.expected;

      assert.equal(result.available, expected.available);
      assert.equal(result.complete, expected.complete);
      assert.equal(result.ranges.length, expected.ranges.length);
      for (const [index, expectedRange] of expected.ranges.entries()) {
        const actualRange = result.ranges[index];
        assert.equal(actualRange.index, expectedRange.index);
        assert.equal(actualRange.source, expectedRange.source);
        assert.equal(actualRange.available, expectedRange.available);
        assert.equal(actualRange.matched_text, expectedRange.matched_text);
        assertTimestamp(actualRange.audio_start, expectedRange.audio_start);
        assertTimestamp(actualRange.audio_end, expectedRange.audio_end);
      }
      if (fixture.category === "zero_duration") {
        const expectedZeroText = fixture.asr_timestamps.words
          .filter((word) => word.start === word.end)
          .map((word) => word.text)
          .join("");
        assert.equal(result.diagnostics.zero_duration_tokens.map((token) => token.text).join(""), expectedZeroText);
      }
    });
  }
});

function assertTimestamp(actual, expected) {
  if (expected === null) {
    assert.equal(actual, null);
    return;
  }
  assert.ok(Math.abs(actual - expected) < 1e-6, `expected ${expected}, got ${actual}`);
}
