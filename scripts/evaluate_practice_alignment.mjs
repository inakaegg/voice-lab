import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { practiceComparisonAlignment } from "../cloudflare/worker.mjs";

function parseArgs(argv) {
  const fixtures = [];
  const excluded = new Set();
  let output = "";
  let summaryOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--exclude") {
      excluded.add(String(argv[index += 1] || ""));
    } else if (value === "--output") {
      output = String(argv[index += 1] || "");
    } else if (value === "--summary-only") {
      summaryOnly = true;
    } else {
      fixtures.push(value);
    }
  }
  if (!fixtures.length) {
    throw new Error("at least one fixture path is required");
  }
  return { fixtures, excluded, output, summaryOnly };
}

function sameTimestamp(actual, expected) {
  if (actual === null || actual === undefined || expected === null || expected === undefined) {
    return (actual === null || actual === undefined) && (expected === null || expected === undefined);
  }
  return Math.abs(Number(actual) - Number(expected)) < 1e-6;
}

function compareCase(fixture) {
  const actual = practiceComparisonAlignment({
    targetText: fixture.target_text,
    recognizedText: fixture.recognized_text,
    targetLanguage: fixture.target_language,
    asrTimestamps: fixture.asr_timestamps,
  });
  const expected = fixture.expected;
  const mismatches = [];
  for (const key of ["available", "complete"]) {
    if (actual[key] !== expected[key]) {
      mismatches.push({ field: key, expected: expected[key], actual: actual[key] });
    }
  }
  if (actual.ranges.length !== expected.ranges.length) {
    mismatches.push({ field: "range_count", expected: expected.ranges.length, actual: actual.ranges.length });
  }
  for (let index = 0; index < Math.min(actual.ranges.length, expected.ranges.length); index += 1) {
    const actualRange = actual.ranges[index];
    const expectedRange = expected.ranges[index];
    for (const key of ["index", "source", "available", "matched_text"]) {
      if (actualRange[key] !== expectedRange[key]) {
        mismatches.push({ field: `ranges[${index}].${key}`, expected: expectedRange[key], actual: actualRange[key] });
      }
    }
    for (const key of ["audio_start", "audio_end"]) {
      if (!sameTimestamp(actualRange[key], expectedRange[key])) {
        mismatches.push({ field: `ranges[${index}].${key}`, expected: expectedRange[key], actual: actualRange[key] });
      }
    }
  }
  return {
    name: fixture.name,
    target_language: fixture.target_language,
    category: fixture.category || "",
    passed: mismatches.length === 0,
    mismatches,
    actual,
  };
}

const args = parseArgs(process.argv.slice(2));
const fixtureHashes = {};
const cases = args.fixtures.flatMap((fixture) => {
  const source = readFileSync(fixture);
  fixtureHashes[fixture] = createHash("sha256").update(source).digest("hex");
  const loaded = JSON.parse(source.toString("utf8"));
  if (!Array.isArray(loaded)) {
    throw new Error(`fixture must contain a JSON array: ${fixture}`);
  }
  return loaded;
});
const results = cases.map(compareCase);
const evaluated = results.filter((result) => !args.excluded.has(result.name));
const payload = {
  runtime: "cloudflare-worker",
  fixtures: fixtureHashes,
  total: results.length,
  evaluated: evaluated.length,
  excluded: results.filter((result) => args.excluded.has(result.name)).map((result) => result.name),
  passed: evaluated.filter((result) => result.passed).length,
  failed: evaluated.filter((result) => !result.passed).length,
  results,
};
if (args.output) {
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
const summary = Object.fromEntries(["runtime", "total", "evaluated", "passed", "failed", "excluded"].map((key) => [key, payload[key]]));
process.stdout.write(`${JSON.stringify(args.summaryOnly ? summary : payload)}\n`);
