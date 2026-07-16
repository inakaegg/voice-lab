import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "practice_alignment_canonical");
const evaluator = path.join(repoRoot, "scripts", "evaluate_practice_alignment_canonical.mjs");
const overlays = [
  ["pilot_expectations.json", 20, 20, 0],
  ["segment_policy_pilot_expectations.json", 12, 12, 0],
  ["round2_challenge_expectations.json", 80, 76, 4],
  ["manual_evaluation_expectations.json", 200, 194, 6],
  ["assignment_expectations.json", 200, 200, 0],
];

for (const [filename, total, evaluated, excluded] of overlays) {
  test(`Worker matches every fixed canonical expectation: ${filename}`, () => {
    const fixturePath = path.join(fixtureDir, filename);
    assert.ok(fs.existsSync(fixturePath));
    const output = execFileSync(
      process.execPath,
      [evaluator, fixturePath, "--summary-only"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const summary = JSON.parse(output);
    assert.deepEqual(summary, {
      runtime: "cloudflare-worker",
      total,
      evaluated,
      excluded,
      passed: evaluated,
      failed: 0,
    });
  });
}
