import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [portal, speakloop, skitvoice, shared, styles, worker, pkg, viteConfig, portalHtml, speakloopHtml, skitvoiceHtml] = await Promise.all([
  read("apps/web/src/portal/main.tsx"), read("apps/web/src/speakloop/main.tsx"),
  read("apps/web/src/skitvoice/main.tsx"), read("apps/web/src/shared/components.tsx"),
  read("src/mo_speech/web/styles.css"),
  read("cloudflare/worker.mjs"), read("package.json"), read("apps/web/vite.config.ts"),
  read("apps/web/portal.html"), read("apps/web/speakloop.html"), read("apps/web/skitvoice.html"),
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

test("SpeakLoop uses a contained microphone icon instead of oversized legacy pseudo-elements", () => {
  assert.match(speakloop, /className="record-microphone-icon"/);
  assert.match(speakloop, /viewBox="0 0 24 24"/);
  assert.match(styles, /\.practice-record-orb \.record-icon::before/);
  assert.match(styles, /\.practice-record-orb \.record-icon::after/);
});

test("React layouts include responsive product and workflow structure", () => {
  assert.match(portal, /aria-label="Voice Lab"/);
  assert.match(portal, /声から、[\s\S]*ことばの体験を[\s\S]*つくる。/);
  assert.match(portal, /href:\s*"\/skitvoice"/);
  assert.match(portal, /href:\s*"\/speakloop"/);
  assert.match(speakloop, /react-practice-flow/);
  assert.match(skitvoice, /react-skit-grid/);
  assert.match(skitvoice, /出力音声サンプル/);
  assert.match(skitvoice, /fixedTitle/);
  assert.match(skitvoice, /customControls/);
  assert.match(skitvoice, /app_sample_audio_controls\.js/);
  assert.ok(skitvoice.indexOf('label="英語"') < skitvoice.indexOf('label="中国語"'));
  assert.ok(skitvoice.indexOf('label="中国語"') < skitvoice.indexOf('label="日本語"'));
  assert.ok(skitvoice.indexOf("react-output-samples") < skitvoice.indexOf("vibevoice-form"));
  assert.ok(skitvoice.indexOf("vibevoice-form") < skitvoice.indexOf("参照音声と生成内容は外部の音声処理APIへ送信"));
});

test("SpeakLoop only exposes Chinese and English as learning languages", () => {
  assert.doesNotMatch(speakloop, /<option value="ja-JP">/);
  assert.match(speakloop, /defaultValue="en-US"/);
  assert.ok(speakloop.indexOf('<option value="en-US">🇺🇸 English<\/option>') < speakloop.indexOf('<option value="zh-CN">🇨🇳 中文<\/option>'));
});

test("public React routes use the staged Tailwind and shadcn migration boundary", () => {
  assert.match(pkg, /"tailwindcss"/);
  assert.match(pkg, /"@tailwindcss\/vite"/);
  assert.match(pkg, /"verify:web-styles"/);
  assert.match(viteConfig, /from "@tailwindcss\/vite"/);
  assert.match(viteConfig, /tailwindcss\(\)/);
  assert.match(viteConfig, /alias:/);
  assert.match(portal, /import "\.\/styles\.css"/);
  assert.match(portal, /@\/components\/ui\/card/);
  assert.doesNotMatch(portalHtml, /\/static\/styles\.css/);
  assert.match(speakloopHtml, /src\/styles\/app\.css/);
  assert.match(skitvoiceHtml, /src\/styles\/app\.css/);
  assert.doesNotMatch(speakloopHtml, /\/static\/styles\.css/);
  assert.doesNotMatch(skitvoiceHtml, /\/static\/styles\.css/);
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

test("Voice Lab gives each product a distinct accent and keeps recording red", () => {
  assert.match(styles, /\.react-public-body\.practice-body,\s*\n\.react-public-body\.vibevoice-body\s*\{[^}]*--react-accent:\s*#536da8/s);
  assert.match(styles, /\.react-public-body\.vibevoice-body\s*\{[^}]*--react-accent:\s*#9a5b36/s);
  assert.match(styles, /\.record-orb\s*\{[^}]*background:\s*var\(--user-record-ready\)/s);
  assert.match(styles, /--user-record-ready:\s*#e65a43/);
  assert.match(styles, /--user-recording:\s*#c7372f/);
});

test("SkitVoice output languages include flags", () => {
  assert.match(skitvoice, /id="vibevoice-output-language" defaultValue="en-US"/);
  assert.match(skitvoice, /🇺🇸 English/);
  assert.match(skitvoice, /🇨🇳 中文/);
  assert.match(skitvoice, /🇯🇵 日本語（低品質）/);
});

test("SkitVoice uses the Voice Lab player for references and generated audio", () => {
  assert.match(skitvoice, /data-voice-lab-audio-label={`Speaker \$\{slot\} 参照音声`}/);
  assert.match(skitvoice, /data-voice-lab-audio-label="生成結果"/);
  assert.doesNotMatch(skitvoice, /id="vibevoice-audio" controls/);
});

test("public workbench keeps settings at the mobile top right and avoids cramped columns", () => {
  assert.match(styles, /\.react-theme-settings summary svg\s*\{[^}]*fill:\s*none;/s);
  assert.match(styles, /grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  assert.match(styles, /@media \(min-width:\s*1120px\)/);
  assert.match(styles, /\.react-practice-flow:has\(#practice-prompt-panel\[hidden\]\)/);
});
