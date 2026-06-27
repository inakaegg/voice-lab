import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/mo_speech/web/app_user.js", import.meta.url), "utf8");

test("user page starts warmup after loading runtime state", () => {
  assert.match(source, /syncUserWarmupStatus\(seedVc\);\s*maybeStartUserWarmup\(seedVc\);/);
  assert.match(source, /warmup\.auto_on_user_page_load === false/);
});

test("user page distinguishes warming status from cold status", () => {
  assert.match(source, /warm_warming:\s*\{/);
  assert.match(source, /hiragana:\s*"じゅんびちゅう"/);
  assert.match(source, /warmup\.pending \|\| userWarmupRequestInFlight \|\| userWarmupJobId/);
});
