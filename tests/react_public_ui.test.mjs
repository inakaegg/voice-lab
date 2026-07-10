import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [portal, speakloop, skitvoice, shared, styles, worker, pkg] = await Promise.all([
  read("apps/web/src/portal/main.tsx"), read("apps/web/src/speakloop/main.tsx"),
  read("apps/web/src/skitvoice/main.tsx"), read("apps/web/src/shared/components.tsx"),
  read("src/mo_speech/web/styles.css"),
  read("cloudflare/worker.mjs"), read("package.json"),
]);

test("public portal SpeakLoop and SkitVoice are React TypeScript entries", () => {
  assert.match(portal, /mountPublicPage\(<Portal/);
  assert.match(speakloop, /mountPublicPage\(<SpeakLoop/);
  assert.match(skitvoice, /mountPublicPage\(<SkitVoice/);
  assert.match(shared, /function ProductHeader/);
  assert.match(shared, /activateCompactLayout/);
  assert.match(shared, /"compact"/);
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

test("public UI finalizes the compact layout and exposes theme settings", () => {
  assert.match(shared, /function ThemeSettings/);
  assert.match(shared, /明色/);
  assert.match(shared, /暗色/);
  assert.match(shared, /システム/);
  assert.match(shared, /mo-speech-theme/);
  assert.match(shared, /stroke="currentColor"/);
  assert.match(shared, /strokeLinecap="round"/);
  assert.doesNotMatch(shared, /react-layout-switcher/);
});

test("SkitVoice output languages include flags", () => {
  assert.match(skitvoice, /🇺🇸 英語/);
  assert.match(skitvoice, /🇨🇳 中国語/);
  assert.match(skitvoice, /🇯🇵 日本語（低品質）/);
});

test("public workbench keeps settings at the mobile top right and avoids cramped columns", () => {
  assert.match(styles, /\.react-theme-settings summary svg\s*\{[^}]*fill:\s*none;/s);
  assert.match(styles, /grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  assert.match(styles, /@media \(min-width:\s*1120px\)/);
  assert.match(styles, /\.react-practice-flow:has\(#practice-prompt-panel\[hidden\]\)/);
});
