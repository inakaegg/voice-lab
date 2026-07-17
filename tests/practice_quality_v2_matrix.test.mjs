import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluatePracticeAttempt,
  practiceComparisonAlignmentCanonical,
  practiceContentMatches,
} from "../cloudflare/worker.mjs";

const FIXTURE = JSON.parse(
  readFileSync("tests/fixtures/practice_quality_v2_matrix_cases.json", "utf8"),
);
const PYTHON = JSON.parse(execFileSync(
  "python3",
  ["scripts/evaluate_practice_quality_v2_matrix.py"],
  {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: "src" },
  },
));

test("Python and Worker keep the same 60-case alignment matrix contract", () => {
  FIXTURE.alignment_cases.forEach((fixture, index) => {
    const worker = practiceComparisonAlignmentCanonical(alignmentInputs(fixture));
    assert.deepEqual(canonicalContract(worker), canonicalContract(PYTHON.alignment[index]), fixture.name);
  });
});

for (const fixture of FIXTURE.alignment_cases) {
  test(`Worker alignment matrix expectation: ${fixture.name}`, () => {
    const worker = practiceComparisonAlignmentCanonical(alignmentInputs(fixture));
    assert.deepEqual(
      worker.phrases.filter((phrase) => phrase.available).map((phrase) => phrase.index),
      fixture.expected_playable_phrase_indexes,
      fixture.name,
    );
  });
}

test("Python and Worker keep the same 32-case Chinese spoken-form matrix contract", () => {
  FIXTURE.spoken_form_cases.forEach((fixture, index) => {
    const worker = practiceContentMatches(fixture.target, fixture.recognized, "zh-CN");
    assert.equal(worker, PYTHON.spoken_forms[index], fixture.name);
  });
});

for (const fixture of FIXTURE.spoken_form_cases) {
  test(`Worker spoken-form matrix expectation: ${fixture.name}`, () => {
    assert.equal(
      practiceContentMatches(fixture.target, fixture.recognized, "zh-CN"),
      fixture.expected,
      fixture.name,
    );
  });
}

test("Python and Worker keep the same 30-case conservative score matrix contract", () => {
  FIXTURE.score_cases.forEach((fixture, index) => {
    const worker = evaluatePracticeAttempt(
      fixture.target_text,
      fixture.recognized_text,
      fixture.target_language,
    );
    assert.deepEqual(scoreContract(worker), scoreContract(PYTHON.scores[index]), fixture.name);
    assert.equal(
      worker.similarity,
      Math.min(worker.global_similarity, worker.phrase_macro_similarity),
      fixture.name,
    );
  });
});

for (const fixture of FIXTURE.score_cases) {
  test(`Worker score matrix expectation: ${fixture.name}`, () => {
    const worker = evaluatePracticeAttempt(
      fixture.target_text,
      fixture.recognized_text,
      fixture.target_language,
    );
    assert.equal(
      worker.similarity,
      Math.min(worker.global_similarity, worker.phrase_macro_similarity),
      fixture.name,
    );
    if (Object.hasOwn(fixture, "expected_unconsumed")) {
      assert.deepEqual(
        worker.unconsumed_recognized.map((entry) => entry.normalized_text),
        fixture.expected_unconsumed,
        fixture.name,
      );
    }
    if (Object.hasOwn(fixture, "expected_similarity")) {
      assert.equal(worker.similarity, fixture.expected_similarity, fixture.name);
    }
    if (Object.hasOwn(fixture, "expected_phrase_recognized")) {
      assert.deepEqual(
        worker.phrase_matches.map((match) => match.normalized_recognized),
        fixture.expected_phrase_recognized,
        fixture.name,
      );
    }
    for (const [phraseIndex, expectedText] of Object.entries(
      fixture.expected_phrase_recognized_by_index || {},
    )) {
      assert.equal(
        worker.phrase_matches[Number(phraseIndex)].normalized_recognized,
        expectedText,
        fixture.name,
      );
    }
    if (fixture.expect_below_one) {
      assert.ok(worker.similarity < 1, fixture.name);
    }
    if (fixture.expect_below_weighted_phrase) {
      assert.ok(worker.similarity < worker.phrase_similarity, fixture.name);
    }
  });
}

function alignmentInputs(fixture) {
  const words = (fixture.words || (fixture.word_texts || []).map((word, index) => [
    word,
    Number((index * 0.3).toFixed(3)),
    Number((index * 0.3 + 0.2).toFixed(3)),
  ])).map(([text, start, end]) => ({ text, start, end }));
  const segments = (fixture.segments || []).map(([text, start, end]) => ({ text, start, end }));
  const recognizedText = Object.hasOwn(fixture, "recognized_text")
    ? fixture.recognized_text
    : fixture.target_language === "zh-CN"
      ? words.map((word) => word.text).join("")
      : words.map((word) => word.text).join(" ");
  return {
    targetText: fixture.target_language === "zh-CN"
      ? fixture.target_phrases.join("")
      : fixture.target_phrases.join(" "),
    recognizedText,
    targetLanguage: fixture.target_language,
    asrTimestamps: {
      available: fixture.available ?? true,
      words,
      segments,
    },
  };
}

function canonicalContract(result) {
  return {
    ...result,
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
