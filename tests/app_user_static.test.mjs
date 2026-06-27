import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/mo_speech/web/app_user.js", import.meta.url), "utf8");
const userHtml = await readFile(new URL("../src/mo_speech/web/user.html", import.meta.url), "utf8");
const adminHtml = await readFile(new URL("../src/mo_speech/web/index.html", import.meta.url), "utf8");
const adminSource = await readFile(new URL("../src/mo_speech/web/app.js", import.meta.url), "utf8");

test("user page only shows warmup as a passive status dot", () => {
  assert.match(userHtml, /id="user-warmup-status"/);
  assert.doesNotMatch(userHtml, />じゅんび/);
  assert.match(source, /syncUserWarmupStatus\(seedVc\);/);
  assert.doesNotMatch(source, /maybeStartUserWarmup\(seedVc\)/);
  assert.doesNotMatch(source, /fetch\("\/api\/warmup"/);
  assert.match(source, /userWarmupStatus\.dataset\.state/);
  assert.doesNotMatch(source, /renderUserText\(userWarmupStatus/);
});

test("admin page can start RunPod warmup manually", () => {
  assert.match(adminHtml, /id="runpod-warmup-button"/);
  assert.match(adminHtml, /id="runpod-warmup-status"/);
  assert.match(adminSource, /runpodWarmupButton\.addEventListener\("click", startRunpodWarmup\)/);
  assert.match(adminSource, /fetch\("\/api\/warmup", \{ method: "POST" \}\)/);
  assert.match(adminSource, /fetch\(`\/api\/warmup\/\$\{encodeURIComponent\(jobId\)\}`\)/);
});
