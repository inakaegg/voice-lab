import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [portal, speakloop, privacy, shared, styles, worker, pkg, viteConfig, portalHtml, speakloopHtml, privacyHtml, githubMarkBlack, githubMarkWhite] = await Promise.all([
  read("apps/web/src/portal/main.tsx"), read("apps/web/src/speakloop/main.tsx"),
  read("apps/web/src/privacy/main.tsx"),
  read("apps/web/src/shared/components.tsx"),
  read("src/mo_speech/web/styles.css"),
  read("cloudflare/worker.mjs"), read("package.json"), read("apps/web/vite.config.ts"),
  read("apps/web/portal.html"), read("apps/web/speakloop.html"), read("apps/web/privacy.html"),
  read("apps/web/public/github-invertocat-black.svg"), read("apps/web/public/github-invertocat-white.svg"),
]);

test("public portal, SpeakLoop, and privacy policy are React TypeScript entries", () => {
  assert.match(portal, /mountPublicPage\(<Portal/);
  assert.match(speakloop, /mountPublicPage\(<SpeakLoop/);
  assert.match(privacy, /mountPublicPage\(<PrivacyPolicy/);
  assert.match(shared, /function ProductHeader/);
  assert.match(shared, /activateCompactLayout/);
  assert.match(shared, /"compact"/);
  assert.match(pkg, /"check:web"/);
});

test("React public UI preserves the SpeakLoop controller and worker asset mapping", () => {
  assert.match(speakloop, /app_practice\.js/);
  assert.match(worker, /assetUrl\.pathname = "\/react\/portal\.html"/);
  assert.match(worker, /assetUrl\.pathname = "\/react\/speakloop\.html"/);
  assert.doesNotMatch(worker, /react\/skitvoice\.html|assetUrl\.pathname = "\/vibevoice\.html"/);
});

test("React pages expose the DOM ids required by legacy controllers", () => {
  for (const id of ["practice-target-language-select", "practice-comparison-model-select", "practice-playback-padding-slider", "practice-playback-padding-value", "practice-chinese-script-setting", "practice-script-simplified", "practice-script-traditional", "practice-native-record-button", "practice-native-cancel-button", "practice-prompt-panel", "practice-repeat-cancel-button", "practice-play-model-button", "practice-speed-slider", "practice-overall-comment", "practice-phrase-feedback", "practice-status", "practice-error"]) {
    assert.match(speakloop, new RegExp(`id=["']${id}["']`));
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
  assert.doesNotMatch(portal, /href:\s*"\/skitvoice"|SkitVoice|VibeVoice/);
  assert.match(portal, /href:\s*"\/speakloop"/);
  assert.match(speakloop, /react-practice-flow/);
  assert.doesNotMatch(speakloop, /<SampleAudio/);
  assert.doesNotMatch(speakloop, /音声履歴を保存/);
});

test("portal links to the GitHub repository with hover and focus help", () => {
  assert.match(portal, /src="\/react\/github-invertocat-black\.svg"[\s\S]*src="\/react\/github-invertocat-white\.svg"/);
  assert.match(githubMarkBlack, /viewBox="0 0 98 96"[\s\S]*fill="black"/);
  assert.match(githubMarkWhite, /viewBox="0 0 98 96"[\s\S]*fill="white"/);
  assert.equal(createHash("sha256").update(githubMarkBlack).digest("hex"), "693d7abe6f899646cc2e96856723b45e95f71885a54910b2749f6decdf7e1ee1");
  assert.equal(createHash("sha256").update(githubMarkWhite).digest("hex"), "ccd84c89b1056345608fc3489357f8acc7397e49a3cdc2d418b6c8016911d47b");
  assert.match(portal, /href="https:\/\/github\.com\/inakaegg\/voice-lab"/);
  assert.match(portal, /target="_blank"/);
  assert.match(portal, /rel="noopener noreferrer"/);
  assert.match(portal, /aria-describedby="portal-github-tooltip"/);
  assert.match(portal, /id="portal-github-tooltip"[\s\S]*role="tooltip"[\s\S]*実際の動作を動画で確認できます/);
});

test("SpeakLoop places the shared privacy notice after its main workflow", () => {
  assert.match(shared, /export function PrivacyNotice[\s\S]*<footer className="react-workflow-privacy-note" data-public-privacy-notice>/);
  assert.match(shared, /音声は生成・評価のため外部サービスで処理され、Voice Labの履歴には保存されません。/);
  assert.match(shared, /href="\/privacy"[\s\S]*プライバシーポリシー/);
  assert.equal((speakloop.match(/<PrivacyNotice\s*\/>/g) || []).length, 1);
  assert.ok(speakloop.indexOf("react-practice-flow") < speakloop.indexOf("<PrivacyNotice"));
  assert.doesNotMatch(speakloop, /外部の音声処理サービスで一時処理/);
});

test("privacy policy explains external audio processing and retention in plain language", () => {
  for (const provider of ["Cloudflare", "OpenAI", "RunPod"]) {
    assert.match(privacy, new RegExp(provider));
  }
  assert.match(privacy, /音声と生成音声[\s\S]*履歴として保存しません/);
  assert.match(privacy, /処理結果の短期データ[\s\S]*1時間/);
  assert.match(privacy, /利用上限を管理するため、利用者ごとの利用回数を記録します。音声や入力内容はこの記録に含まれません。/);
  assert.match(privacy, /日ごとの利用回数[\s\S]*3日以内に削除/);
  assert.match(privacy, /操作ログ[\s\S]*約90日間保存/);
  assert.match(privacy, /累計利用回数[\s\S]*公開デモの運用中/);
  assert.match(privacy, /最終更新日: 2026年7月21日/);
  assert.match(privacy, /ログインしたメールアドレスと日時[\s\S]*利用状況の把握と不正利用の確認/);
  assert.match(privacy, /ログインしたメールアドレスと日時:[\s\S]*公開デモ終了時に削除/);
  assert.doesNotMatch(privacy, /最大3日|最大91日|72時間未満|91日未満/);
  assert.doesNotMatch(privacy, /外部処理事業者|Report a vulnerability|security\/advisories\/new/);
  assert.match(viteConfig, /privacy:\s*resolve\(rootDir,\s*"privacy\.html"\)/);
  assert.match(privacyHtml, /\/src\/privacy\/main\.tsx/);
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

test("SpeakLoop exposes an opt-in Seed-VC model voice control with hover and focus help", () => {
  assert.match(speakloop, /id="practice-own-voice-toggle"/);
  assert.match(speakloop, /自分の声/);
  assert.match(speakloop, /practice-own-voice-control/);
  assert.match(speakloop, /role="tooltip"/);
  assert.match(speakloop, /「自分の声」は、同じセッションであなたが最初に録音した音声からAI生成音声を作ります。/);
  assert.doesNotMatch(speakloop, /practice-own-voice-help-button|practice-own-voice-disclosure/);
  assert.doesNotMatch(speakloop, /CircleHelp|useState/);
  assert.doesNotMatch(speakloop, /通常のお手本音声で練習を続けられます/);
  assert.match(styles, /\.practice-own-voice-setting:hover[\s\S]*\.practice-own-voice-tooltip/);
  assert.match(styles, /\.practice-own-voice-setting:focus-within[\s\S]*\.practice-own-voice-tooltip/);
});

test("SpeakLoop keeps comparison playback simple without an auto-play preference control", () => {
  assert.doesNotMatch(speakloop, /practice-auto-play-comparison|練習終了後すぐ再生/);
  assert.match(speakloop, /practice-play-model-button/);
  assert.match(speakloop, /practice-play-model-only-button/);
  assert.match(speakloop, /お手本だけ再生/);
  assert.match(speakloop, /practice-speed-slider/);
});

test("SpeakLoop keeps local developer settings hidden until runtime capability is confirmed", () => {
  for (const model of ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini", "gpt-5.4-nano"]) {
    assert.match(speakloop, new RegExp(`<option value="${model}"`));
  }
  assert.match(speakloop, /id="practice-comparison-model-setting"[\s\S]*hidden/);
  assert.match(speakloop, /id="practice-playback-padding-setting"[\s\S]*hidden/);
  assert.match(speakloop, /id="practice-comparison-model-select"[\s\S]*defaultValue="gpt-5\.6-terra"/);
  assert.match(speakloop, /id="practice-playback-padding-slider"[\s\S]*min="0"[\s\S]*max="0\.5"[\s\S]*step="0\.05"[\s\S]*defaultValue="0\.3"/);
  assert.match(speakloop, /id="practice-history-preview"[\s\S]*hidden/);
  assert.match(speakloop, /過去の結果で表示確認/);
  assert.match(speakloop, /id="practice-saved-result-notice"/);
  assert.match(speakloop, /id="practice-history-preview-source-select"[\s\S]*defaultValue="saved"/);
  assert.match(speakloop, /<option value="recomputed">現行ロジックで再計算<\/option>/);
  assert.match(speakloop, /前後余白/);
  assert.match(speakloop, /LLM採点/);
  assert.doesNotMatch(speakloop, /99\.5%以上/);
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
  assert.doesNotMatch(speakloopHtml, /\/static\/styles\.css/);
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
  assert.match(styles, /\.react-public-body\.practice-body\s*\{[^}]*--react-accent:\s*#536da8/s);
  assert.match(styles, /\.record-orb\s*\{[^}]*background:\s*var\(--practice-record-ready\)/s);
  assert.match(styles, /--practice-record-ready:\s*#e65a43/);
  assert.match(styles, /--practice-recording:\s*#c7372f/);
});

test("public workbench keeps settings at the mobile top right and avoids cramped columns", () => {
  assert.match(styles, /\.react-theme-settings summary svg\s*\{[^}]*fill:\s*none;/s);
  assert.match(styles, /grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  assert.match(styles, /\.react-practice-flow:has\(#practice-prompt-panel\[hidden\]\)/);
});

const PUBLIC_ORIGIN = "https://voice-lab.inakaegg.workers.dev";

test("public pages declare share metadata (description, OGP, canonical, icons)", () => {
  const pages = [
    { name: "portal", html: portalHtml, url: `${PUBLIC_ORIGIN}/` },
    { name: "speakloop", html: speakloopHtml, url: `${PUBLIC_ORIGIN}/speakloop` },
    { name: "privacy", html: privacyHtml, url: `${PUBLIC_ORIGIN}/privacy` },
  ];
  for (const page of pages) {
    assert.match(page.html, /<meta name="description" content="[^"]+"/, `${page.name}: description`);
    assert.match(page.html, /<meta property="og:title" content="[^"]+"/, `${page.name}: og:title`);
    assert.match(page.html, /<meta property="og:description" content="[^"]+"/, `${page.name}: og:description`);
    assert.match(page.html, /<meta property="og:type" content="website"/, `${page.name}: og:type`);
    assert.match(page.html, /<meta property="og:site_name" content="Voice Lab"/, `${page.name}: og:site_name`);
    assert.match(page.html, /<meta property="og:locale" content="ja_JP"/, `${page.name}: og:locale`);
    assert.ok(page.html.includes(`<meta property="og:url" content="${page.url}"`), `${page.name}: og:url`);
    assert.ok(page.html.includes(`<meta property="og:image" content="${PUBLIC_ORIGIN}/react/og-voice-lab.png"`), `${page.name}: og:image`);
    assert.match(page.html, /<meta property="og:image:width" content="1200"/, `${page.name}: og:image:width`);
    assert.match(page.html, /<meta property="og:image:height" content="630"/, `${page.name}: og:image:height`);
    assert.match(page.html, /<meta name="twitter:card" content="summary_large_image"/, `${page.name}: twitter:card`);
    assert.ok(page.html.includes(`<link rel="canonical" href="${page.url}"`), `${page.name}: canonical`);
    assert.match(page.html, /<link rel="apple-touch-icon" href="\/react\/apple-touch-icon\.png"/, `${page.name}: apple-touch-icon`);
    assert.match(page.html, /<meta name="theme-color"/, `${page.name}: theme-color`);
  }
});

test("portal and SpeakLoop expose JSON-LD structured data", () => {
  assert.match(portalHtml, /<script type="application\/ld\+json">/);
  assert.match(portalHtml, /"@type":"WebSite"/);
  assert.match(speakloopHtml, /<script type="application\/ld\+json">/);
  assert.match(speakloopHtml, /"@type":"WebApplication"/);
});
