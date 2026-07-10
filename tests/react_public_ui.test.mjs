import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [portal, speakloop, skitvoice, shared, worker, pkg] = await Promise.all([
  read("apps/web/src/portal/main.tsx"), read("apps/web/src/speakloop/main.tsx"),
  read("apps/web/src/skitvoice/main.tsx"), read("apps/web/src/shared/components.tsx"),
  read("cloudflare/worker.mjs"), read("package.json"),
]);

test("public portal SpeakLoop and SkitVoice are React TypeScript entries", () => {
  assert.match(portal, /mountPublicPage\(<Portal/);
  assert.match(speakloop, /mountPublicPage\(<SpeakLoop/);
  assert.match(skitvoice, /mountPublicPage\(<SkitVoice/);
  assert.match(shared, /function ProductHeader/);
  assert.match(shared, /activateLayoutVariant/);
  assert.match(shared, /"compact"/);
  assert.match(shared, /"guided"/);
  assert.match(shared, /"studio"/);
  assert.match(pkg, /"check:web"/);
});

test("React public UI preserves legacy controller and storage contracts", () => {
  assert.match(speakloop, /app_practice\.js/);
  assert.match(skitvoice, /app_vibevoice\.js/);
  assert.match(skitvoice, /id="vibevoice-form"/);
  assert.match(skitvoice, /name={`voice_file_\$\{slot\}`}/);
  assert.match(skitvoice, /id="vibevoice-job-progress"/);
  assert.match(worker, /assetUrl\.pathname = "\/react\/portal\.html"/);
  assert.match(worker, /assetUrl\.pathname = "\/react\/speakloop\.html"/);
  assert.match(worker, /assetUrl\.pathname = "\/react\/skitvoice\.html"/);
});

test("React pages expose the DOM ids required by legacy controllers", () => {
  for (const id of ["practice-target-language-select", "practice-native-record-button", "practice-prompt-panel", "practice-play-model-button", "practice-speed-slider", "practice-status", "practice-error"]) {
    assert.match(speakloop, new RegExp(`id=["']${id}["']`));
  }
  for (const id of ["vibevoice-form", "vibevoice-script", "vibevoice-generate-button", "vibevoice-job-progress", "vibevoice-result", "vibevoice-diagnostics"]) {
    assert.match(skitvoice, new RegExp(`id=["']${id}["']`));
  }
});

test("React layouts include responsive product and workflow structure", () => {
  assert.match(portal, /react-product-grid/);
  assert.match(speakloop, /react-practice-flow/);
  assert.match(skitvoice, /react-skit-grid/);
  assert.match(skitvoice, /日本語サンプル/);
  assert.match(skitvoice, /中国語サンプル/);
  assert.match(skitvoice, /英語サンプル/);
});

test("SpeakLoop and SkitVoice expose three comparable layout candidates", () => {
  assert.match(shared, /コンパクト/);
  assert.match(shared, /ガイド/);
  assert.match(shared, /スタジオ/);
  assert.match(shared, /URLSearchParams/);
});
