import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluatePracticeAttempt,
  practiceComparisonAlignmentCanonical,
  practiceContentMatches,
} from "../cloudflare/worker.mjs";

const FIXTURE = JSON.parse(readFileSync("tests/fixtures/practice_quality_v2_cases.json", "utf8"));
const PYTHON = JSON.parse(execFileSync(
  "python3",
  ["scripts/evaluate_practice_quality_v2.py"],
  {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: "src" },
  },
));

test("Python and Worker keep the same real-audio challenge alignment contract", () => {
  FIXTURE.alignment_cases.forEach((fixture, index) => {
    const worker = practiceComparisonAlignmentCanonical({
      targetText: fixture.target_text,
      recognizedText: fixture.recognized_text,
      targetLanguage: fixture.target_language,
      asrTimestamps: fixture.asr_timestamps,
    });
    assert.deepEqual(canonicalContract(worker), canonicalContract(PYTHON.alignment[index]), fixture.name);
  });
});

test("Python and Worker keep the same Chinese spoken-form contract", () => {
  FIXTURE.spoken_form_cases.forEach((fixture, index) => {
    const worker = practiceContentMatches(fixture.target, fixture.recognized, "zh-CN");
    assert.equal(worker, fixture.expected, fixture.name);
    assert.equal(worker, PYTHON.spoken_forms[index], fixture.name);
  });
});

test("Python and Worker keep the same conservative score contract", () => {
  FIXTURE.score_cases.forEach((fixture, index) => {
    const worker = evaluatePracticeAttempt(
      fixture.target_text,
      fixture.recognized_text,
      fixture.target_language,
    );
    assert.deepEqual(scoreContract(worker), scoreContract(PYTHON.scores[index]), fixture.name);
    assert.equal(worker.similarity, Math.min(worker.global_similarity, worker.phrase_macro_similarity), fixture.name);
    assert.deepEqual(
      worker.unconsumed_recognized.map((entry) => entry.normalized_text),
      fixture.expected_unconsumed,
      fixture.name,
    );
  });
});

function canonicalContract(result) {
  return {
    outcome: result.outcome,
    available: result.available,
    complete: result.complete,
    target_language: result.target_language,
    target_phrase_count: result.target_phrase_count,
    playable_phrase_count: result.playable_phrase_count,
    all_phrases_playable: result.all_phrases_playable,
    unassigned_non_filler_count: result.unassigned_non_filler_count,
    phrases: result.phrases,
    diagnostics: {
      ...result.diagnostics,
      alignment_elapsed_ms: 0,
    },
  };
}

function scoreContract(result) {
  return {
    normalized_target: result.normalized_target,
    normalized_recognized: result.normalized_recognized,
    global_similarity: result.global_similarity,
    phrase_similarity: result.phrase_similarity,
    phrase_macro_similarity: result.phrase_macro_similarity,
    lowest_phrase_similarity: result.lowest_phrase_similarity,
    similarity: result.similarity,
    grade: result.grade,
    phrase_matches: result.phrase_matches,
    unconsumed_recognized: result.unconsumed_recognized,
  };
}
