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

test("public portal, SpeakLoop, and the SkitVoice closed page are React TypeScript entries", () => {
  assert.match(portal, /mountPublicPage\(<Portal/);
  assert.match(speakloop, /mountPublicPage\(<SpeakLoop/);
  assert.match(skitvoice, /mountPublicPage\(<SkitVoice/);
  assert.match(shared, /function ProductHeader/);
  assert.match(shared, /activateCompactLayout/);
  assert.match(shared, /"compact"/);
  assert.match(pkg, /"check:web"/);
});

test("React public UI preserves SpeakLoop controller while the SkitVoice public page has no generation controller", () => {
  assert.match(speakloop, /app_practice\.js/);
  assert.doesNotMatch(skitvoice, /app_vibevoice\.js/);
  assert.doesNotMatch(skitvoice, /id="vibevoice-form"|voice_file_|vibevoice-job-progress/);
  assert.match(worker, /assetUrl\.pathname = "\/react\/portal\.html"/);
  assert.match(worker, /assetUrl\.pathname = "\/react\/speakloop\.html"/);
  assert.match(worker, /assetUrl\.pathname = "\/react\/skitvoice\.html"/);
});

test("React pages expose the DOM ids required by legacy controllers", () => {
  for (const id of ["practice-target-language-select", "practice-chinese-script-setting", "practice-script-simplified", "practice-script-traditional", "practice-native-record-button", "practice-native-cancel-button", "practice-prompt-panel", "practice-repeat-cancel-button", "practice-play-model-button", "practice-speed-slider", "practice-status", "practice-error"]) {
    assert.match(speakloop, new RegExp(`id=["']${id}["']`));
  }
  assert.doesNotMatch(skitvoice, /vibevoice-form|vibevoice-script|vibevoice-generate-button|vibevoice-result|vibevoice-diagnostics/);
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
  assert.doesNotMatch(portal, /href:\s*"\/skitvoice"|SkitVoice|VibeVoice/);
  assert.match(portal, /href:\s*"\/speakloop"/);
  assert.match(speakloop, /react-practice-flow/);
  assert.match(skitvoice, /研究機能は一般公開していません/);
  assert.match(skitvoice, /href="\/speakloop"[\s\S]*SpeakLoopで練習する/);
  assert.doesNotMatch(skitvoice, /出力音声サンプル|SampleAudio|app_sample_audio_controls\.js/);
  assert.doesNotMatch(speakloop, /<SampleAudio/);
  assert.doesNotMatch(speakloop, /音声履歴を保存/);
  assert.doesNotMatch(skitvoice, /履歴を保存/);
});

test("SpeakLoop places the shared privacy notice after its main workflow", () => {
  assert.match(shared, /export function PrivacyNotice[\s\S]*<footer className="react-workflow-privacy-note" data-public-privacy-notice>/);
  assert.equal((speakloop.match(/<PrivacyNotice\s*\/>/g) || []).length, 1);
  assert.ok(speakloop.indexOf("react-practice-flow") < speakloop.indexOf("<PrivacyNotice"));
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
  assert.match(speakloop, /同じセッションであなたが最初に録音した音声だけ/);
  assert.match(speakloop, /外部の音声処理サービスへ一時的に送信/);
  assert.match(speakloop, /声質に近づけたAI生成音声/);
  assert.match(speakloop, /Voice Labの履歴には保存しません/);
  assert.match(speakloop, /通常のお手本音声で練習を続けられます/);
});

test("SkitVoice public page exposes no interactive generation or samples", () => {
  assert.doesNotMatch(skitvoice, /<form|<input|<textarea|<audio|fetch\(|RunPod|aoi-ot|vibevoice-large/);
  assert.match(skitvoice, /一般公開していません/);
  assert.match(skitvoice, /bg-foreground[\s\S]*text-background/);
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

test("public workbench keeps settings at the mobile top right and avoids cramped columns", () => {
  assert.match(styles, /\.react-theme-settings summary svg\s*\{[^}]*fill:\s*none;/s);
  assert.match(styles, /grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  assert.match(styles, /@media \(min-width:\s*1120px\)/);
  assert.match(styles, /\.react-practice-flow:has\(#practice-prompt-panel\[hidden\]\)/);
});
