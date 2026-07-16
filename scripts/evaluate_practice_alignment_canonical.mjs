import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { practiceComparisonAlignmentCanonical } from "../cloudflare/worker.mjs";


function sameTimestamp(actual, expected) {
  if (actual === null || actual === undefined || expected === null || expected === undefined) {
    return (actual === null || actual === undefined) && (expected === null || expected === undefined);
  }
  return Math.abs(Number(actual) - Number(expected)) < 1e-6;
}


function compareCase(sourceCase, overlayCase) {
  let actual;
  try {
    actual = practiceComparisonAlignmentCanonical({
      targetText: sourceCase.target_text,
      recognizedText: sourceCase.recognized_text,
      targetLanguage: sourceCase.target_language,
      asrTimestamps: sourceCase.asr_timestamps,
    });
  } catch (error) {
    const actualError = {
      error_code: error?.error_code ?? null,
      reason: error?.reason ?? null,
      retryable: error?.retryable ?? null,
      exception_type: error?.constructor?.name ?? "Error",
    };
    if (overlayCase.expected_error) {
      const mismatches = Object.entries(overlayCase.expected_error)
        .filter(([key, value]) => actualError[key] !== value)
        .map(([key, value]) => ({ field: key, expected: value, actual: actualError[key] }));
      return { name: overlayCase.name, passed: mismatches.length === 0, mismatches };
    }
    return {
      name: overlayCase.name,
      passed: false,
      mismatches: [{ field: "unexpected_error", expected: null, actual: actualError }],
    };
  }
  if (overlayCase.expected_error) {
    return {
      name: overlayCase.name,
      passed: false,
      mismatches: [{ field: "expected_error", expected: overlayCase.expected_error, actual: null }],
    };
  }
  const expected = overlayCase.expected;
  const mismatches = [];
  if (actual.outcome !== expected.outcome) {
    mismatches.push({ field: "outcome", expected: expected.outcome, actual: actual.outcome });
  }
  const topLevel = {
    target_phrase_count: actual.target_phrase_count,
    playable_phrase_count: actual.playable_phrase_count,
    all_phrases_playable: actual.all_phrases_playable,
    unassigned_non_filler_count: actual.unassigned_non_filler_count,
    complete: actual.complete,
  };
  for (const [key, value] of Object.entries(topLevel)) {
    if (value !== expected[key]) {
      mismatches.push({ field: key, expected: expected[key], actual: value });
    }
  }

  if (actual.phrases.length !== expected.phrases.length) {
    mismatches.push({ field: "phrase_count", expected: expected.phrases.length, actual: actual.phrases.length });
  }
  for (let index = 0; index < Math.min(actual.phrases.length, expected.phrases.length); index += 1) {
    const actualPhrase = actual.phrases[index];
    const expectedPhrase = expected.phrases[index];
    const fields = {
      index: actualPhrase.index,
      source_index: actualPhrase.source_index,
      target_text: actualPhrase.target_text,
      assignment_status: actualPhrase.assignment_status,
      available: actualPhrase.available,
      matched_text: actualPhrase.matched_text,
      text_source: actualPhrase.text_source,
      timestamp_source: actualPhrase.timestamp_source,
      word_start_index: actualPhrase.word_start_index,
      word_end_index: actualPhrase.word_end_index,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== expectedPhrase[key]) {
        mismatches.push({ field: `phrases[${index}].${key}`, expected: expectedPhrase[key], actual: value });
      }
    }
    for (const key of ["audio_start", "audio_end"]) {
      if (!sameTimestamp(actualPhrase[key], expectedPhrase[key])) {
        mismatches.push({ field: `phrases[${index}].${key}`, expected: expectedPhrase[key], actual: actualPhrase[key] });
      }
    }
  }
  const actualZeroDurationOwners = actual.diagnostics.zero_duration_tokens
    .filter((token) => token.source === "words")
    .map((token) => ({
      word_index: token.source_index,
      phrase_index: token.owner_phrase_index,
    }));
  if (JSON.stringify(actualZeroDurationOwners) !== JSON.stringify(expected.zero_duration_owners)) {
    mismatches.push({
      field: "zero_duration_owners",
      expected: expected.zero_duration_owners,
      actual: actualZeroDurationOwners,
    });
  }
  if (expected.unassigned_tokens) {
    const actualUnassignedTokens = actual.diagnostics.unassigned_tokens.map((token) => ({
      source: token.source,
      source_index: token.source_index,
      text: token.text,
      start: token.start,
      end: token.end,
      reason: token.reason,
    }));
    if (JSON.stringify(actualUnassignedTokens) !== JSON.stringify(expected.unassigned_tokens)) {
      mismatches.push({
        field: "unassigned_tokens",
        expected: expected.unassigned_tokens,
        actual: actualUnassignedTokens,
      });
    }
  }
  return { name: overlayCase.name, passed: mismatches.length === 0, mismatches };
}


const args = process.argv.slice(2);
const summaryOnlyIndex = args.indexOf("--summary-only");
const summaryOnly = summaryOnlyIndex >= 0;
if (summaryOnly) {
  args.splice(summaryOnlyIndex, 1);
}
if (args.length !== 1) {
  throw new Error("usage: node scripts/evaluate_practice_alignment_canonical.mjs OVERLAY [--summary-only]");
}
const overlayPath = resolve(args[0]);
const overlay = JSON.parse(readFileSync(overlayPath, "utf8"));
const sourcePath = resolve(dirname(overlayPath), overlay.source_fixture);
const sourceBytes = readFileSync(sourcePath);
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
if (sourceSha256 !== overlay.source_sha256) {
  throw new Error(`source fixture SHA mismatch: ${sourcePath}`);
}
const sourceByName = new Map(JSON.parse(sourceBytes.toString("utf8")).map((fixture) => [fixture.name, fixture]));
const fixedCases = overlay.cases.filter((fixture) => fixture.expectation_status === "fixed");
const results = fixedCases.map((fixture) => compareCase(sourceByName.get(fixture.name), fixture));
let payload = {
  runtime: "cloudflare-worker",
  overlay: overlayPath,
  source_sha256: sourceSha256,
  total: overlay.cases.length,
  evaluated: results.length,
  excluded: overlay.cases.length - results.length,
  passed: results.filter((result) => result.passed).length,
  failed: results.filter((result) => !result.passed).length,
  results,
};
if (summaryOnly) {
  payload = Object.fromEntries(["runtime", "total", "evaluated", "excluded", "passed", "failed"].map((key) => [key, payload[key]]));
}
process.stdout.write(`${JSON.stringify(payload)}\n`);
