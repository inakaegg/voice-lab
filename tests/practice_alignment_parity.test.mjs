import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { practiceComparisonAlignment } from "../cloudflare/worker.mjs";

const FIXTURES = [
  "tests/fixtures/practice_alignment_golden_cases.json",
  "tests/fixtures/practice_alignment_boundary_cases.json",
  "tests/fixtures/practice_alignment_holdout_cases.json",
  "tests/fixtures/practice_alignment_validation_cases.json",
  "tests/fixtures/practice_alignment_regression_cases.json",
];

test("Python and Cloudflare alignment return the same playback and diagnostic contract", () => {
  const pythonPayload = JSON.parse(execFileSync(
    "python3",
    ["scripts/evaluate_practice_alignment.py", ...FIXTURES],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: "src" },
      maxBuffer: 16 * 1024 * 1024,
    },
  ));
  const cases = FIXTURES.flatMap((filename) => JSON.parse(readFileSync(filename, "utf8")));
  assert.equal(pythonPayload.results.length, cases.length);

  for (const [caseIndex, fixture] of cases.entries()) {
    const worker = practiceComparisonAlignment({
      targetText: fixture.target_text,
      recognizedText: fixture.recognized_text,
      targetLanguage: fixture.target_language,
      asrTimestamps: fixture.asr_timestamps,
    });
    const python = pythonPayload.results[caseIndex]?.actual;
    assert.ok(python, `missing Python result for ${fixture.name}`);
    assert.deepEqual(contract(worker), contract(python), fixture.name);
  }
});

function contract(result) {
  return {
    available: result.available,
    complete: result.complete,
    mode: result.mode,
    recognized_normalized: result.recognized_normalized,
    ranges: result.ranges.map((range) => ({
      index: range.index,
      source: range.source,
      available: range.available,
      matched: range.matched,
      content_matched: range.content_matched,
      matched_text: range.matched_text,
      audio_start: range.audio_start,
      audio_end: range.audio_end,
      similarity: range.similarity,
      content_similarity: range.content_similarity,
      coverage: range.coverage,
      alignment_confidence: range.alignment_confidence,
      boundary_source: range.boundary_source,
      token_start_index: range.token_start_index,
      token_end_index: range.token_end_index,
    })),
    diagnostics: result.diagnostics && {
      total_timestamp_token_count: result.diagnostics.total_timestamp_token_count,
      playable_token_count: result.diagnostics.playable_token_count,
      candidate_count: result.diagnostics.candidate_count,
      score_computation_count: result.diagnostics.score_computation_count,
      unassigned_tokens: result.diagnostics.unassigned_tokens,
      zero_duration_tokens: result.diagnostics.zero_duration_tokens,
    },
  };
}
