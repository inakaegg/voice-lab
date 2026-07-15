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
  for (const id of ["practice-target-language-select", "practice-chinese-script-setting", "practice-script-simplified", "practice-script-traditional", "practice-native-record-button", "practice-native-cancel-button", "practice-prompt-panel", "practice-repeat-cancel-button", "practice-play-model-button", "practice-speed-slider", "practice-status", "practice-error"]) {
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
  assert.doesNotMatch(speakloop, /<SampleAudio/);
  assert.doesNotMatch(speakloop, /音声履歴を保存/);
  assert.doesNotMatch(skitvoice, /履歴を保存/);
});

test("SpeakLoop and SkitVoice place the shared privacy notice after their main workflow", () => {
  assert.match(shared, /export function PrivacyNotice[\s\S]*<footer className="react-workflow-privacy-note" data-public-privacy-notice>/);
  assert.equal((speakloop.match(/<PrivacyNotice\s*\/>/g) || []).length, 1);
  assert.equal((skitvoice.match(/<PrivacyNotice\s*\/>/g) || []).length, 1);
  assert.ok(speakloop.indexOf("react-practice-flow") < speakloop.indexOf("<PrivacyNotice"));
  assert.ok(skitvoice.indexOf("<ResultPanel") < skitvoice.indexOf("<PrivacyNotice"));
});

test("SpeakLoop only exposes Chinese and English as learning languages", () => {
  assert.doesNotMatch(speakloop, /<option value="ja-JP">/);
  assert.match(speakloop, /defaultValue="en-US"/);
  assert.ok(speakloop.indexOf('<option value="en-US">🇺🇸 English<\/option>') < speakloop.indexOf('<option value="zh-CN">🇨🇳 中文<\/option>'));
});

test("SpeakLoop provides a Chinese script segmented control backed by OpenCC", () => {
  assert.match(speakloop, /import\("opencc-js\/cn2t"\)/);
  assert.match(speakloop, /id="practice-chinese-script-setting"/);
  assert.match(speakloop, /id="practice-script-simplified"[\s\S]*简体/);
  assert.match(speakloop, /id="practice-script-traditional"[\s\S]*繁體/);
  assert.match(speakloop, /className="practice-script-indicator"/);
  assert.match(speakloop, /data-script="simplified"/);
  assert.match(pkg, /"opencc-js"/);
  assert.match(styles, /\.practice-script-toggle/);
  assert.match(styles, /\.practice-script-indicator[\s\S]*transition:/);
  assert.match(styles, /prefers-reduced-motion/);
});

test("SpeakLoop exposes an opt-in Seed-VC model voice control", () => {
  assert.match(speakloop, /id="practice-own-voice-toggle"/);
  assert.match(speakloop, /自分の声/);
  assert.match(speakloop, /practice-own-voice-control/);
});

test("SkitVoice exposes a shared toast viewport outside the generation settings", () => {
  assert.match(shared, /export function ToastViewport/);
  assert.match(skitvoice, /<ToastViewport\s*\/>/);
  assert.ok(skitvoice.indexOf("<ToastViewport") > skitvoice.indexOf("</form>"));
  assert.match(styles, /\.voice-lab-toast-viewport/);
});

test("SpeakLoop keeps comparison playback simple without an auto-play preference control", () => {
  assert.doesNotMatch(speakloop, /practice-auto-play-comparison|練習終了後すぐ再生/);
  assert.match(speakloop, /practice-play-model-button/);
  assert.match(speakloop, /practice-speed-slider/);
});

test("SpeakLoop exposes recording cancel controls for both recording actions", () => {
  assert.match(speakloop, /id="practice-native-cancel-button"/);
  assert.match(speakloop, /id="practice-repeat-cancel-button"/);
  assert.match(speakloop, /function CancelRecordingButton[\s\S]*aria-label="録音をキャンセル"/);
  assert.match(styles, /\.practice-record-cancel-button/);
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
