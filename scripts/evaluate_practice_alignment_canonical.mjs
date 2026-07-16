import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { practiceComparisonAlignment } from "../cloudflare/worker.mjs";


function sameTimestamp(actual, expected) {
  if (actual === null || actual === undefined || expected === null || expected === undefined) {
    return (actual === null || actual === undefined) && (expected === null || expected === undefined);
  }
  return Math.abs(Number(actual) - Number(expected)) < 1e-6;
}


function compareCase(sourceCase, overlayCase) {
  let actual;
  try {
    actual = practiceComparisonAlignment({
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
  const actualPlayable = actual.ranges.filter((phrase) => phrase.available).length;
  const actualUnassignedNonFiller = actual.diagnostics.unassigned_tokens
    .filter((token) => token.reason !== "edge_or_boundary_filler").length;
  const topLevel = {
    target_phrase_count: actual.target_phrase_count,
    playable_phrase_count: actualPlayable,
    all_phrases_playable: actual.target_phrase_count > 0 && actualPlayable === actual.target_phrase_count,
    unassigned_non_filler_count: actualUnassignedNonFiller,
    complete: actual.complete,
  };
  for (const [key, value] of Object.entries(topLevel)) {
    if (value !== expected[key]) {
      mismatches.push({ field: key, expected: expected[key], actual: value });
    }
  }

  if (actual.ranges.length !== expected.phrases.length) {
    mismatches.push({ field: "phrase_count", expected: expected.phrases.length, actual: actual.ranges.length });
  }
  for (let index = 0; index < Math.min(actual.ranges.length, expected.phrases.length); index += 1) {
    const actualPhrase = actual.ranges[index];
    const expectedPhrase = expected.phrases[index];
    const assignmentStatus = actualPhrase.available ? "assigned" : (actualPhrase.matched_text ? "text_only" : "unassigned");
    const textSource = actualPhrase.matched_text ? actualPhrase.source : "none";
    const timestampSource = actualPhrase.available ? actualPhrase.source : "none";
    const fields = {
      index: actualPhrase.index,
      source_index: actualPhrase.source_index,
      target_text: actualPhrase.target,
      assignment_status: assignmentStatus,
      available: actualPhrase.available,
      matched_text: actualPhrase.matched_text,
      text_source: textSource,
      timestamp_source: timestampSource,
      word_start_index: actualPhrase.token_start_index,
      word_end_index: actualPhrase.token_end_index,
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
