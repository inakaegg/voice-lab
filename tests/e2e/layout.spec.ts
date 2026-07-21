import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

import { assertNoHorizontalOverflow, assertVisibleControlsInsideViewport, installUiApiFixtures } from "./fixtures";

const publicRoutes = [
  { path: "/", heading: "声から、", action: "練習をはじめる", actionRole: "link" },
  { path: "/speakloop", heading: "言いたいことで発音練習", action: "言いたいことを録音", actionRole: "button" },
  { path: "/skitvoice", heading: "研究機能", action: "SpeakLoopで練習する", actionRole: "link" },
] as const;

const adminRoutes = ["/admin", "/speakloop/admin", "/skitvoice/admin"];
const utilityRoutes = [
  { path: "/fun", heading: "はなしてください", action: "ろくおん" },
] as const;
const pageErrors = new WeakMap<Page, Error[]>();

test.beforeEach(async ({ page }) => {
  const errors: Error[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error));
  await installUiApiFixtures(page);
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) || [], "browser page errors").toEqual([]);
});

for (const route of publicRoutes) {
  test(`${route.path} keeps the primary task inside a stable responsive layout`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("mo-speech-theme", "light"));
    await page.goto(route.path);
    await expect(page.getByRole("heading", { name: new RegExp(route.heading), level: 1 })).toBeVisible();
    await expect(page.getByRole(route.actionRole, { name: new RegExp(route.action) }).first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertVisibleControlsInsideViewport(page);
    if ((page.viewportSize()?.width || 0) <= 820) {
      const themeControl = page.getByLabel("配色設定");
      const themeBox = await themeControl.boundingBox();
      expect(themeBox?.width || 0).toBeGreaterThanOrEqual(40);
      expect((themeBox?.x || 0) + (themeBox?.width || 0)).toBeGreaterThanOrEqual((page.viewportSize()?.width || 0) - 24);
      if (route.path !== "/") {
        const backBox = await page.locator(".react-back-link").boundingBox();
        expect(backBox?.width || 0).toBeGreaterThanOrEqual(40);
        expect(backBox?.height || 0).toBeGreaterThanOrEqual(40);
      }
    }
  });
}

test("SpeakLoop keeps the shared privacy notice at the workflow bottom left", async ({ page }) => {
  await page.goto("/speakloop");
  const [contentBox, workflowBox, privacyBox] = await Promise.all([
    page.locator(".react-intro-grid").boundingBox(),
    page.locator(".react-practice-flow").boundingBox(),
    page.locator("[data-public-privacy-notice]").boundingBox(),
  ]);

  expect(contentBox).not.toBeNull();
  expect(workflowBox).not.toBeNull();
  expect(privacyBox).not.toBeNull();
  expect(privacyBox?.y || 0).toBeGreaterThanOrEqual((workflowBox?.y || 0) + (workflowBox?.height || 0) - 1);
  expect(Math.abs((privacyBox?.x || 0) - (contentBox?.x || 0))).toBeLessThanOrEqual(1);

  const { viewportHeight, documentHeight } = await page.evaluate(() => ({
    viewportHeight: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
  }));
  if (documentHeight <= viewportHeight + 1) {
    expect((privacyBox?.y || 0) + (privacyBox?.height || 0)).toBeGreaterThanOrEqual(viewportHeight - 40);
  }
});

test("privacy policy stays readable and links back to Voice Lab", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "プライバシーポリシー", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /Voice Lab/ })).toHaveAttribute("href", "/");
  await expect(page.getByRole("heading", { name: "保持期間" })).toBeVisible();
  await expect(page.getByText(/日ごとの利用回数は、利用日から3日以内に削除/)).toBeVisible();
  await expect(page.getByText(/操作ログは、約90日間保存/)).toBeVisible();
  await expect(page.locator('a[href*="security/advisories/new"]')).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
  await assertVisibleControlsInsideViewport(page);
});

test("SpeakLoop shows own-voice details from the control hover and focus without duplicate disclosure", async ({ page }, testInfo) => {
  await page.goto("/speakloop");
  const setting = page.locator(".practice-own-voice-setting");
  const toggle = page.locator("#practice-own-voice-toggle");
  const tooltip = page.locator("#practice-own-voice-tooltip");
  const workflowBoxBefore = await page.locator(".react-practice-flow").boundingBox();

  await expect(tooltip).toBeHidden();
  await expect(page.locator(".practice-own-voice-disclosure")).toHaveCount(0);
  await expect(page.getByText(/外部サービスで処理され、Voice Labの履歴には保存されません/)).toHaveCount(1);
  if (testInfo.project.name !== "mobile") {
    await setting.hover();
    await expect(tooltip).toBeVisible();
    await page.locator(".practice-card-copy").first().hover();
    await expect(tooltip).toBeHidden();
  }

  await toggle.focus();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText("「自分の声」は、同じセッションであなたが最初に録音した音声からAI生成音声を作ります。");
  await assertNoHorizontalOverflow(page);
  expect(await page.locator(".react-practice-flow").boundingBox()).toEqual(workflowBoxBefore);
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-speakloop-own-voice-help.png`, fullPage: true });
    await page.locator("html").evaluate((element) => element.setAttribute("data-theme", "dark"));
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-dark-speakloop-own-voice-help.png`, fullPage: true });
    await page.locator("html").evaluate((element) => element.setAttribute("data-theme", "light"));
  }

  await page.getByRole("heading", { name: "言いたいことで発音練習" }).click();
  await expect(tooltip).toBeHidden();
  await toggle.focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(tooltip).toBeHidden();
});

test("portal keeps the SpeakLoop action within the initial viewport", async ({ page }) => {
  await page.goto("/");
  const viewportHeight = await page.evaluate(() => innerHeight);
  const box = await page.getByText("練習をはじめる", { exact: false }).first().boundingBox();
  expect(box).not.toBeNull();
  expect((box?.y || 0) + (box?.height || 0)).toBeLessThanOrEqual(viewportHeight + 1);
  await expect(page.getByText("SkitVoice", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(viewportHeight + 1);
});

test("direct public SkitVoice access stays closed without generation or samples", async ({ page }) => {
  await page.goto("/skitvoice");
  await expect(page.getByRole("heading", { name: "研究機能は一般公開していません" })).toBeVisible();
  await expect(page.locator("#vibevoice-form")).toHaveCount(0);
  await expect(page.locator("#vibevoice-generate-button")).toHaveCount(0);
  await expect(page.locator("[data-public-sample-language]")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "SpeakLoopで練習する" })).toHaveAttribute("href", "/speakloop");
});

test("public theme menu is keyboard reachable and persists dark mode", async ({ page }) => {
  await page.goto("/speakloop");
  const settings = page.getByLabel("配色設定");
  await settings.focus();
  await expect(settings).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByRole("radio", { name: "暗色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("public theme menu closes on outside click and Escape", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("mo-speech-theme", "light"));
  await page.goto("/speakloop");
  const settings = page.locator(".react-theme-settings");
  const summary = page.getByLabel("配色設定");

  await summary.click();
  await expect(settings).toHaveAttribute("open", "");
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-theme-menu-open.png`, fullPage: true });
  }
  await page.getByRole("heading", { name: "言いたいことで発音練習" }).click();
  await expect(settings).not.toHaveAttribute("open", "");

  await summary.click();
  await expect(settings).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(settings).not.toHaveAttribute("open", "");
  await expect(summary).toBeFocused();
});

test("system theme follows the browser color scheme on every public route", async ({ page }) => {
  for (const route of publicRoutes) {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => localStorage.setItem("mo-speech-theme", "system"));
    await page.goto(route.path);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  }
});

test("SpeakLoop defaults to English and normalizes a saved Japanese target", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mo:practice-settings", JSON.stringify({ target_language: "ja-JP" }));
  });
  await page.goto("/speakloop");
  const language = page.locator("#practice-target-language-select");
  await expect(language.locator("option")).toHaveCount(2);
  await expect(language.locator("option").nth(0)).toHaveAttribute("value", "en-US");
  await expect(language.locator("option").nth(1)).toHaveAttribute("value", "zh-CN");
  await expect(language).toHaveValue("en-US");
});

test("SpeakLoop locally restores a saved result with comparison playback and no audio processing", async ({ page }, testInfo) => {
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, { historyState: "practice-preview", practiceUiMode: "local" });
  await page.goto("/speakloop");
  const preview = page.locator("#practice-history-preview");
  await expect(preview).toBeVisible();
  await preview.locator("summary").click();
  await expect(page.locator("#practice-history-preview-status")).toContainText("1件");

  const requestsAfterDisplay: Array<{ method: string; path: string }> = [];
  page.on("request", (request) => {
    requestsAfterDisplay.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
    });
  });
  await page.locator("#practice-history-preview-button").click();

  await expect(page.locator("#practice-saved-result-notice")).toBeVisible();
  await expect.poll(() => page.locator("#practice-target-text").evaluate((element) =>
    Array.from(element.childNodes).map((node) =>
      node.nodeName === "RUBY" ? node.firstChild?.textContent || "" : node.textContent || ""
    ).join("")
  )).toContain("银行周末也营业吗");
  await expect(page.locator("#practice-target-text ruby")).toHaveCount(8);
  await expect(page.locator("#practice-recognized-text .practice-diff-grid"))
    .toHaveAttribute("aria-label", /银杏周末也营业吗/);
  await expect(page.locator("#practice-score")).toHaveText("82点");
  await expect(page.locator("#practice-overall-comment")).toHaveText("最初の単語をもう一度確認しましょう。");
  await expect(page.locator("#practice-comparison-note")).toContainText("2/2フレーズを順番に比較できます");
  await expect(page.locator("#practice-repeat-record-button")).toBeDisabled();
  await expect(page.locator("#practice-play-model-button")).toBeEnabled();
  await expect(page.locator("#practice-play-model-button")).toContainText("フレーズごと比較再生");
  await expect(page.locator("#practice-play-model-only-button")).toBeVisible();
  const savedAudioPaths = new Set([
    "/api/audio-history/recordings/practice-preview.wav",
    "/api/audio-history/outputs/practice-preview-model.wav",
  ]);
  expect(requestsAfterDisplay.every((request) =>
    request.method === "GET" && savedAudioPaths.has(request.path)
  )).toBe(true);
  expect(requestsAfterDisplay.some((request) =>
    request.path === "/api/audio-history/outputs/practice-preview-model.wav"
  )).toBe(true);
  await assertNoHorizontalOverflow(page);

  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-speakloop-saved-result.png`, fullPage: true });
    await page.locator("html").evaluate((element) => {
      element.setAttribute("data-theme", "dark");
      element.setAttribute("data-theme-preference", "dark");
    });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-dark-speakloop-saved-result.png`, fullPage: true });
  }
});

test("SpeakLoop recomputes the saved comparison ranges with the current implementation", async ({ page }) => {
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, { historyState: "practice-preview", practiceUiMode: "local" });
  await page.goto("/speakloop");
  await page.locator("#practice-history-preview summary").click();
  await page.locator("#practice-history-preview-button").click();
  await expect(page.locator("#practice-saved-result-notice")).toBeVisible();

  const source = page.locator("#practice-history-preview-source-select");
  await expect(source).toHaveValue("saved");
  await source.selectOption("recomputed");

  await expect(page.locator("#practice-history-preview-status"))
    .toContainText("現在の実装で計算し直した比較区間");
  await expect(page.locator("#practice-history-preview-status")).toContainText("保存時は0.10秒");
  // 再計算結果は3フレーズ、保存値は2フレーズ。切り替えで実際に区間が入れ替わることを見る。
  await expect(page.locator("#practice-comparison-note")).toContainText("3/3フレーズを順番に比較できます");
  await expect(page.locator("#practice-play-model-button")).toContainText("フレーズごと比較再生");

  // 前後余白を変えたら、現在選んでいる余白で計算し直す。
  await page.locator("#practice-playback-padding-slider").fill("0.5");
  await expect(page.locator("#practice-history-preview-status")).toContainText("余白は0.50秒");

  await source.selectOption("saved");
  await expect(page.locator("#practice-history-preview-status")).toContainText("保存時の比較区間");
  await expect(page.locator("#practice-comparison-note")).toContainText("2/2フレーズを順番に比較できます");
});

test("SpeakLoop ignores a stale recomputation response after the padding changes", async ({ page }) => {
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, { historyState: "practice-preview", practiceUiMode: "local" });
  await page.goto("/speakloop");
  await page.locator("#practice-history-preview summary").click();
  await page.locator("#practice-history-preview-button").click();
  await expect(page.locator("#practice-saved-result-notice")).toBeVisible();

  // 0.30秒の要求(遅い)を出した直後に0.50秒(速い)へ変える。後着の古い応答を捨てること。
  await page.locator("#practice-history-preview-source-select").selectOption("recomputed");
  await page.locator("#practice-playback-padding-slider").fill("0.5");

  await expect(page.locator("#practice-history-preview-status")).toContainText("余白は0.50秒");
  await page.waitForTimeout(500);
  await expect(page.locator("#practice-history-preview-status")).toContainText("余白は0.50秒");
});

test("SpeakLoop returns to the saved ranges when recomputation is not possible", async ({ page }) => {
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, {
    historyState: "practice-preview",
    practiceUiMode: "local",
    practicePreviewRecompute: false,
  });
  await page.goto("/speakloop");
  await page.locator("#practice-history-preview summary").click();
  await page.locator("#practice-history-preview-button").click();
  await page.locator("#practice-history-preview-source-select").selectOption("recomputed");

  await expect(page.locator("#practice-history-preview-status")).toContainText("再計算できません");
  await expect(page.locator("#practice-history-preview-source-select")).toHaveValue("saved");
  await expect(page.locator("#practice-comparison-note")).toContainText("2/2フレーズを順番に比較できます");
});

test("SpeakLoop falls back to repeat-only playback when the saved prompt audio is gone", async ({ page }) => {
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, {
    historyState: "practice-preview",
    practiceUiMode: "local",
    practicePreviewModelAudio: false,
  });
  await page.goto("/speakloop");
  await page.locator("#practice-history-preview summary").click();
  await page.locator("#practice-history-preview-button").click();

  await expect(page.locator("#practice-saved-result-notice")).toBeVisible();
  await expect(page.locator("#practice-history-preview-status")).toContainText("比較再生はできません");
  await expect(page.locator("#practice-comparison-note")).toContainText("比較再生は利用できません");
  await expect(page.locator("#practice-play-model-button")).toContainText("復唱音声を再生");
  await expect(page.locator("#practice-play-model-only-button")).toBeHidden();
});

test("SpeakLoop prevents restoring saved history while recording or processing", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() { return true; }
      state = "inactive";
      mimeType = "audio/webm";
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        const event = new Event("dataavailable") as Event & { data: Blob };
        event.data = new Blob(["fake recording"], { type: this.mimeType });
        this.dispatchEvent(event);
        this.dispatchEvent(new Event("stop"));
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FakeMediaRecorder });
    Object.defineProperty(window, "AudioContext", { value: undefined, configurable: true });
    Object.defineProperty(window, "webkitAudioContext", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
      configurable: true,
    });
  });
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, { historyState: "practice-preview", practiceUiMode: "local" });
  let releasePromptResponse: (() => void) | undefined;
  const promptResponseGate = new Promise<void>((resolve) => {
    releasePromptResponse = resolve;
  });
  await page.route("**/api/practice/recordings", async (route) => {
    await promptResponseGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        recording_kind: "prompt",
        transcript: "今日は何をしますか",
        target_text: "What are you doing today?",
        target_language: "en-US",
        display_text: { primary_text: "What are you doing today?" },
        audio_base64: "UklGRg==",
        audio_mime_type: "audio/wav",
      }),
    });
  });
  await page.goto("/speakloop");
  const preview = page.locator("#practice-history-preview");
  await preview.locator("summary").click();
  await expect(page.locator("#practice-history-preview-status")).toContainText("1件");

  const historyPreviewButton = page.locator("#practice-history-preview-button");
  await expect(historyPreviewButton).toBeEnabled();
  await page.locator("#practice-native-record-button").click();
  await expect(historyPreviewButton).toBeDisabled();
  await expect(page.locator("#practice-saved-result-notice")).toBeHidden();
  await page.locator("#practice-native-cancel-button").click();
  await expect(historyPreviewButton).toBeEnabled();

  await page.locator("#practice-native-record-button").click();
  await page.locator("#practice-native-record-button").click();
  await expect(historyPreviewButton).toBeDisabled();
  releasePromptResponse?.();
  await expect(page.locator("#practice-prompt-panel")).toBeVisible();
  await expect(historyPreviewButton).toBeEnabled();
});

test("SpeakLoop Cloudflare mode hides developer controls and ignores stale saved values", async ({ page }, testInfo) => {
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, { practiceUiMode: "cloudflare" });
  await page.addInitScript(() => {
    localStorage.setItem("mo:practice-settings", JSON.stringify({
      comparison_model: "gpt-5.4-nano",
      playback_padding_seconds: 0.1,
    }));
  });

  await page.goto("/speakloop");

  await expect(page.locator("#practice-comparison-model-setting")).toBeHidden();
  await expect(page.locator("#practice-playback-padding-setting")).toBeHidden();
  await expect(page.locator("#practice-history-preview")).toBeHidden();
  await expect(page.locator("#practice-comparison-model-select")).toHaveValue("gpt-5.6-terra");
  await expect(page.locator("#practice-playback-padding-slider")).toHaveValue("0.3");
  await expect(page.locator("#practice-playback-padding-value")).toHaveText("0.30秒");
  await assertNoHorizontalOverflow(page);
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-speakloop-cloudflare-fixed-settings.png`, fullPage: true });
    await page.locator("html").evaluate((element) => {
      element.setAttribute("data-theme", "dark");
      element.setAttribute("data-theme-preference", "dark");
    });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-dark-speakloop-cloudflare-fixed-settings.png`, fullPage: true });
  }
});

test("SpeakLoop shows prompt ASR, translation, and speech generation stages", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() { return true; }
      state = "inactive";
      mimeType = "audio/webm";
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        const dataEvent = new Event("dataavailable") as Event & { data: Blob };
        dataEvent.data = new Blob(["fake recording"], { type: this.mimeType });
        this.dispatchEvent(dataEvent);
        this.dispatchEvent(new Event("stop"));
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FakeMediaRecorder });
    Object.defineProperty(window, "AudioContext", { value: undefined, configurable: true });
    Object.defineProperty(window, "webkitAudioContext", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
      configurable: true,
    });
  });
  await page.route("**/api/practice/recordings", async (route) => {
    const multipartBody = route.request().postDataBuffer()?.toString("latin1") || "";
    expect(multipartBody).toContain('name="progress_mode"');
    expect(multipartBody).toContain("job");
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        job_id: "prompt-progress-job",
        status: "queued",
        current_stage: {
          stage: "transcribing_prompt",
          label: "録音を文字にしています",
          provider: "OpenAI",
          model: "whisper-1",
        },
      }),
    });
  });
  let promptPolls = 0;
  await page.route("**/api/practice/prompt-jobs/prompt-progress-job", async (route) => {
    promptPolls += 1;
    if (promptPolls === 1) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          job_id: "prompt-progress-job",
          status: "running",
          current_stage: {
            stage: "translating_prompt",
            label: "学習言語へ翻訳しています",
            provider: "OpenAI",
            model: "gpt-5.6-terra",
          },
        }),
      });
      return;
    }
    if (promptPolls === 2) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          job_id: "prompt-progress-job",
          status: "running",
          current_stage: {
            stage: "synthesizing_prompt",
            label: "お手本音声を作っています",
            provider: "OpenAI",
            model: "gpt-4o-mini-tts",
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        job_id: "prompt-progress-job",
        status: "succeeded",
        current_stage: { stage: "complete", label: "完了しました", provider: "", model: "" },
        result: {
          recording_kind: "prompt",
          transcript: "今日はどこへ行きますか",
          target_text: "Where are you going today?",
          target_language: "en-US",
          display_text: { primary_text: "Where are you going today?" },
          audio_base64: "UklGRg==",
          audio_mime_type: "audio/wav",
        },
      }),
    });
  });

  await page.goto("/speakloop");
  const native = page.locator("#practice-native-record-button");
  await native.click();
  await native.click();
  await expect(page.locator("#practice-job-status-label")).toHaveText("録音を文字にしています");
  await expect(page.locator("#practice-job-status-model")).toHaveText("OpenAI / whisper-1");
  await expect(page.locator("#practice-job-status-label")).toHaveText("学習言語へ翻訳しています");
  await expect(page.locator("#practice-job-status-model")).toHaveText("OpenAI / gpt-5.6-terra");
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-speakloop-prompt-translation.png`, fullPage: true });
  }
  await expect(page.locator("#practice-job-status-label")).toHaveText("お手本音声を作っています");
  await expect(page.locator("#practice-job-status-model")).toHaveText("OpenAI / gpt-4o-mini-tts");
  await expect(page.locator("#practice-prompt-panel")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#practice-target-text")).toContainText("Where are you going today?");
});

test("SpeakLoop handles terminal initial prompt job snapshots", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() { return true; }
      state = "inactive";
      mimeType = "audio/webm";
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        const dataEvent = new Event("dataavailable") as Event & { data: Blob };
        dataEvent.data = new Blob(["fake recording"], { type: this.mimeType });
        this.dispatchEvent(dataEvent);
        this.dispatchEvent(new Event("stop"));
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FakeMediaRecorder });
    Object.defineProperty(window, "AudioContext", { value: undefined, configurable: true });
    Object.defineProperty(window, "webkitAudioContext", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
      configurable: true,
    });
  });
  await page.route("**/api/practice/recordings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        job_id: "prompt-already-finished",
        status: "succeeded",
        current_stage: { stage: "complete", label: "完了しました", provider: "", model: "" },
        result: {
          recording_kind: "prompt",
          transcript: "今日はどこへ行きますか",
          target_text: "Where are you going today?",
          target_language: "en-US",
          display_text: { primary_text: "Where are you going today?" },
          audio_base64: "UklGRg==",
          audio_mime_type: "audio/wav",
        },
      }),
    });
  });

  await page.goto("/speakloop");
  const native = page.locator("#practice-native-record-button");
  await native.click();
  await native.click();

  await expect(page.locator("#practice-prompt-panel")).toBeVisible();
  await expect(page.locator("#practice-target-text")).toContainText("Where are you going today?");
  await expect(page.locator("#practice-model-audio")).toHaveAttribute("src", /^blob:/);
  await assertNoHorizontalOverflow(page);
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({
      path: `tmp/playwright/visual-review/${testInfo.project.name}-light-speakloop-terminal-prompt.png`,
      fullPage: true,
    });
    await page.locator("html").evaluate((element) => element.setAttribute("data-theme", "dark"));
    await page.screenshot({
      path: `tmp/playwright/visual-review/${testInfo.project.name}-dark-speakloop-terminal-prompt.png`,
      fullPage: true,
    });
  }

  await page.unroute("**/api/practice/recordings");
  await page.route("**/api/practice/recordings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        job_id: "prompt-already-failed",
        status: "failed",
        current_stage: { stage: "failed", label: "お手本を作成できませんでした" },
        result: null,
        error: {
          code: "practice_prompt_failed",
          message: "お手本を作成できませんでした。もう一度お試しください。",
        },
      }),
    });
  });
  await page.reload();
  await native.click();
  await native.click();
  await expect(page.locator("#practice-prompt-panel")).toBeHidden();
  await expect(page.locator("#practice-error")).toHaveText(
    "お手本を作成できませんでした。もう一度お試しください。",
  );
});

test("SpeakLoop switches Chinese text display without resubmitting audio", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() { return true; }
      state = "inactive";
      mimeType = "audio/webm";
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        const dataEvent = new Event("dataavailable") as Event & { data: Blob };
        dataEvent.data = new Blob(["fake recording"], { type: this.mimeType });
        this.dispatchEvent(dataEvent);
        this.dispatchEvent(new Event("stop"));
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FakeMediaRecorder });
    Object.defineProperty(window, "AudioContext", { value: undefined, configurable: true });
    Object.defineProperty(window, "webkitAudioContext", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
      configurable: true,
    });
    Object.defineProperty(HTMLMediaElement.prototype, "duration", {
      configurable: true,
      get: () => 2.2,
    });
    HTMLMediaElement.prototype.play = function play() {
      const starts = ((window as any).__practicePlayStarts ||= []);
      starts.push({ id: this.id, currentTime: this.currentTime });
      this.currentTime = 2.2;
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function pause() {};
  });
  let recordingRequests = 0;
  await page.route("**/api/practice/recordings", async (route) => {
    recordingRequests += 1;
    const payload = {
      recording_kind: "prompt",
      transcript: "ソフトウェア開発者は人気があります",
      target_text: "软件开发者很受欢迎。",
      target_language: "zh-CN",
      display_text: {
        primary_text: "软件开发者很受欢迎。",
        pinyin_text: "ruǎn jiàn kāi fā zhě hěn shòu huān yíng",
        pinyin_status: "ready",
      },
      audio_base64: "UklGRg==",
      audio_mime_type: "audio/wav",
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.route("**/api/practice/attempt-jobs", async (route) => {
    recordingRequests += 1;
    const multipartBody = route.request().postDataBuffer()?.toString("latin1") || "";
    expect(multipartBody).toContain('name="model_audio"; filename="model.wav"');
    expect(multipartBody).toContain("Content-Type: audio/wav");
    expect(multipartBody).toContain('name="comparison_model"');
    expect(multipartBody).toContain("gpt-5.4-nano");
    expect(multipartBody).toContain('name="playback_padding_seconds"');
    expect(multipartBody).toContain("0.20");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        job_id: "browser-practice-job",
        status: "succeeded",
        current_stage: { stage: "complete", label: "比較準備が完了しました", model: "funasr/paraformer-zh" },
        result: {
          recording_kind: "attempt",
          target_language: "zh-CN",
          target_text: "软件开发者很受欢迎。",
          recognized_text: "软开发者很受欢迎。",
          model_recognized_text: "软件开发者很受欢迎。",
          overall_score: 93,
          overall_comment: "「件」の音を確認しましょう。",
          llm_comparison: {
            schema_version: 1,
            overall_score: 93,
            overall_comment: "「件」の音を確認しましょう。",
            phrases: [{
              phrase_index: 0,
              target_text: "软件开发者很受欢迎。",
              score: 93,
              comment: "「软件」の「件」が認識されませんでした。",
            }],
          },
          comparison_alignment: {
            available: true,
            complete: true,
            target_phrase_count: 1,
            all_phrases_playable: true,
            phrases: [{ index: 0, target_text: "软件开发者很受欢迎。", available: true, audio_start: 0.1, audio_end: 1.8 }],
          },
          model_comparison_alignment: {
            available: true,
            complete: true,
            target_phrase_count: 1,
            all_phrases_playable: true,
            phrases: [{ index: 0, target_text: "软件开发者很受欢迎。", available: true, audio_start: 0.1, audio_end: 1.9 }],
          },
        },
      }),
    });
  });

  await page.goto("/speakloop");
  await page.locator("#practice-target-language-select").selectOption("zh-CN");
  await page.locator("#practice-comparison-model-select").selectOption("gpt-5.4-nano");
  await page.locator("#practice-playback-padding-slider").fill("0.2");
  await expect(page.locator("#practice-playback-padding-value")).toHaveText("0.20秒");
  await expect(page.locator("#practice-chinese-script-setting")).toBeVisible();
  await expect(page.locator("#practice-script-simplified")).toHaveAttribute("aria-pressed", "true");

  const nativeRecord = page.locator("#practice-native-record-button");
  await nativeRecord.click();
  await nativeRecord.click();
  await expect.poll(() => page.locator("#practice-target-text").evaluate((element) =>
    Array.from(element.childNodes).map((node) =>
      node.nodeName === "RUBY" ? node.firstChild?.textContent || "" : node.textContent || ""
    ).join("")
  )).toContain("软件开发者很受欢迎");
  expect(recordingRequests).toBe(1);

  const repeatRecord = page.locator("#practice-repeat-record-button");
  await repeatRecord.click();
  await repeatRecord.click();
  await expect.poll(() => page.locator("#practice-recognized-text .practice-diff-heard").evaluateAll(
    (elements) => elements.map((element) => element.textContent || "").join(""),
  )).toBe("软_开发者很受欢迎");
  await expect(page.locator("#practice-recognized-text .practice-diff-correction", { hasText: "件" })).toHaveCount(1);
  await expect(page.locator("#practice-score")).toHaveText("93点");
  await expect(page.locator("#practice-overall-comment")).toHaveText("「件」の音を確認しましょう。");
  await expect(page.locator("#practice-phrase-feedback")).toContainText("「软件」の「件」が認識されませんでした。");
  await expect(page.locator("#practice-play-model-button")).toContainText("フレーズごと比較再生");
  await expect(page.locator("#practice-comparison-note")).toHaveText("1/1フレーズを順番に比較できます。");
  await page.evaluate(() => { (window as any).__practicePlayStarts = []; });
  await page.locator("#practice-play-model-button").click();
  await expect.poll(() => page.evaluate(() => (window as any).__practicePlayStarts)).toEqual([
    { id: "practice-model-audio", currentTime: 0.1 },
    { id: "practice-repeat-audio", currentTime: 0.1 },
  ]);
  expect(recordingRequests).toBe(2);

  const scriptIndicator = page.locator(".practice-script-indicator");
  const indicatorX = () => scriptIndicator.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m41);
  await expect(scriptIndicator).toHaveCSS("transition-duration", "0.32s, 0.22s, 0.22s");
  await scriptIndicator.evaluate((element) => {
    const markTransformTransition = (event: Event) => {
      const transitionEvent = event as TransitionEvent;
      if (transitionEvent.propertyName !== "transform") return;
      const phase = transitionEvent.type === "transitionstart" ? "started" : "ended";
      element.setAttribute(`data-transform-transition-${phase}`, "true");
    };
    element.addEventListener("transitionstart", markTransformTransition);
    element.addEventListener("transitionend", markTransformTransition);
  });
  const startX = await indicatorX();
  await page.locator("#practice-script-traditional").click();
  await expect(scriptIndicator).toHaveAttribute("data-transform-transition-started", "true");
  await expect(scriptIndicator).toHaveAttribute("data-transform-transition-ended", "true");
  const finalX = await indicatorX();
  expect(finalX).toBeGreaterThan(startX + 1);
  await expect(page.locator("#practice-script-traditional")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.locator("#practice-target-text").evaluate((element) =>
    Array.from(element.childNodes).map((node) =>
      node.nodeName === "RUBY" ? node.firstChild?.textContent || "" : node.textContent || ""
    ).join("")
  )).toContain("軟件開發者很受歡迎");
  await expect.poll(() => page.locator("#practice-recognized-text .practice-diff-heard").evaluateAll(
    (elements) => elements.map((element) => element.textContent || "").join(""),
  )).toBe("軟_開發者很受歡迎");
  await expect(page.locator("#practice-phrase-feedback")).toContainText("軟件開發者很受歡迎。");
  expect(recordingRequests).toBe(2);
  await assertNoHorizontalOverflow(page);

  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-speakloop-chinese-script-toggle.png`, fullPage: true });
    await page.locator("html").evaluate((element) => {
      element.setAttribute("data-theme", "dark");
      element.setAttribute("data-theme-preference", "dark");
    });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-dark-speakloop-chinese-script-toggle.png`, fullPage: true });
  }

  await page.reload();
  await expect(page.locator("#practice-target-language-select")).toHaveValue("zh-CN");
  await expect(page.locator("#practice-comparison-model-select")).toHaveValue("gpt-5.4-nano");
  await expect(page.locator("#practice-playback-padding-slider")).toHaveValue("0.2");
  await expect(page.locator("#practice-script-traditional")).toHaveAttribute("aria-pressed", "true");
});

test("SpeakLoop no-speech result hides scoring and clears stale comparison ranges on retry", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() { return true; }
      state = "inactive";
      mimeType = "audio/webm";
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        const event = new Event("dataavailable") as Event & { data: Blob };
        event.data = new Blob(["fake recording"], { type: this.mimeType });
        this.dispatchEvent(event);
        this.dispatchEvent(new Event("stop"));
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FakeMediaRecorder });
    Object.defineProperty(window, "AudioContext", { value: undefined, configurable: true });
    Object.defineProperty(window, "webkitAudioContext", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
      configurable: true,
    });
  });
  await page.route("**/api/practice/recordings", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      recording_kind: "prompt",
      transcript: "窓を閉めてください",
      target_text: "Please close the window.",
      target_language: "en-US",
      display_text: { primary_text: "Please close the window." },
      audio_base64: "UklGRg==",
      audio_mime_type: "audio/wav",
    }),
  }));
  await page.route("**/api/practice/attempt-jobs", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      job_id: "silent-browser-job",
      status: "succeeded",
      current_stage: { stage: "complete", label: "比較準備が完了しました" },
      result: {
        outcome: "no_speech",
        message: "音声を検出できませんでした。もう一度録音してください。",
        target_language: "en-US",
        target_text: "Please close the window.",
        recognized_text: "",
        similarity: null,
        global_similarity: null,
        phrase_similarity: null,
        grade: null,
        diff: [],
        comparison_alignment: { available: false, complete: false, target_phrase_count: 1, phrases: [] },
        model_comparison_alignment: {
          available: true,
          complete: true,
          target_phrase_count: 1,
          phrases: [{ index: 0, available: true, audio_start: 0.1, audio_end: 1.2 }],
        },
      },
    }),
  }));

  await page.goto("/speakloop");
  const nativeRecord = page.locator("#practice-native-record-button");
  await nativeRecord.click();
  await nativeRecord.click();
  await expect(page.locator("#practice-prompt-panel")).toBeVisible();
  const repeatRecord = page.locator("#practice-repeat-record-button");
  await repeatRecord.click();
  await repeatRecord.click();

  await expect(page.locator("#practice-result-panel")).toBeVisible();
  await expect(page.locator("#practice-recognized-text")).toHaveText("音声を検出できませんでした。もう一度録音してください。");
  await expect(page.locator("#practice-result-panel .practice-result-summary")).toBeHidden();
  await expect(page.locator("#practice-result-panel .practice-score-bar")).toBeHidden();
  await expect(page.locator("#practice-overall-comment")).toBeHidden();
  await expect(page.locator("#practice-phrase-feedback")).toBeHidden();
  await expect(page.locator("#practice-play-model-button")).toContainText("再生");
  await expect(repeatRecord).toBeEnabled();
  await assertNoHorizontalOverflow(page);

  await repeatRecord.click();
  await expect(page.locator("#practice-result-panel")).toBeHidden();
  await expect(page.locator("#practice-play-model-button")).toContainText("再生");
  await repeatRecord.click();
  await expect(page.locator("#practice-result-panel")).toBeVisible();

  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({
      path: `tmp/playwright/visual-review/${testInfo.project.name}-light-speakloop-no-speech.png`,
      fullPage: true,
    });
  }
});

test("SpeakLoop uses whole playback for missing LLM ranges and exposes LLM errors", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() { return true; }
      state = "inactive";
      mimeType = "audio/webm";
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        const event = new Event("dataavailable") as Event & { data: Blob };
        event.data = new Blob(["fake recording"], { type: this.mimeType });
        this.dispatchEvent(event);
        this.dispatchEvent(new Event("stop"));
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FakeMediaRecorder });
    Object.defineProperty(window, "AudioContext", { value: undefined, configurable: true });
    Object.defineProperty(window, "webkitAudioContext", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
      configurable: true,
    });
  });
  await page.route("**/api/practice/recordings", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      recording_kind: "prompt",
      transcript: "開いて、閉じて",
      target_text: "Open it. Close it.",
      target_language: "en-US",
      display_text: { primary_text: "Open it. Close it." },
      audio_base64: "UklGRg==",
      audio_mime_type: "audio/wav",
    }),
  }));
  let attempts = 0;
  await page.route("**/api/practice/attempt-jobs", (route) => {
    attempts += 1;
    const body = attempts === 1 ? {
      job_id: "text-only-browser-job",
      status: "succeeded",
      current_stage: { stage: "complete", label: "比較準備が完了しました" },
      result: {
        outcome: "evaluated",
        target_language: "en-US",
        target_text: "Open it. Close it.",
        recognized_text: "Open it",
        overall_score: 60,
        overall_comment: "後半をもう一度確認しましょう。",
        llm_comparison: {
          schema_version: 1,
          overall_score: 60,
          overall_comment: "後半をもう一度確認しましょう。",
          phrases: [
            { phrase_index: 0, target_text: "Open it.", score: 80, comment: "前半は認識できました。" },
            { phrase_index: 1, target_text: " Close it.", score: 0, comment: "後半は認識できませんでした。" },
          ],
        },
        comparison_alignment: {
          available: false,
          complete: false,
          all_phrases_playable: false,
          target_phrase_count: 2,
          phrases: [
            { index: 0, assignment_status: "text_only", available: false, audio_start: null, audio_end: null },
            { index: 1, assignment_status: "unassigned", available: false, audio_start: null, audio_end: null },
          ],
        },
        model_comparison_alignment: {
          available: true,
          complete: true,
          all_phrases_playable: true,
          target_phrase_count: 2,
          phrases: [
            { index: 0, available: true, audio_start: 0.1, audio_end: 0.8 },
            { index: 1, available: true, audio_start: 0.9, audio_end: 1.6 },
          ],
        },
      },
      error: null,
    } : {
      job_id: "empty-reference-browser-job",
      status: "failed",
      current_stage: {
        stage: "failed",
        label: "音声の解析結果を確認できませんでした",
        detail: "もう一度お試しください。",
      },
      result: null,
      error: {
        code: "practice_llm_failed",
        stage: "llm_request",
        retryable: true,
        fallback_to_legacy: false,
        message: "比較結果を作成できませんでした。もう一度お試しください。",
      },
    };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto("/speakloop");
  const nativeRecord = page.locator("#practice-native-record-button");
  await nativeRecord.click();
  await nativeRecord.click();
  const repeatRecord = page.locator("#practice-repeat-record-button");
  await repeatRecord.click();
  await repeatRecord.click();

  await expect(page.locator("#practice-result-panel")).toBeVisible();
  await expect(page.locator("#practice-play-model-button")).toContainText("全体比較再生");
  await expect(page.locator("#practice-comparison-note")).toHaveText("フレーズの区切りを確認できなかったため、全体を比較します。");
  await assertNoHorizontalOverflow(page);
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-speakloop-text-only-whole.png`, fullPage: true });
  }

  await repeatRecord.click();
  await repeatRecord.click();
  await expect(page.locator("#practice-result-panel")).toBeHidden();
  await expect(page.locator("#practice-error")).toHaveText("比較結果を作成できませんでした。もう一度お試しください。");
  await expect(page.locator("#practice-error")).not.toContainText(/llm_request|practice_llm_failed|provider/);
  await assertNoHorizontalOverflow(page);
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-speakloop-reference-error.png`, fullPage: true });
  }
});

test("SpeakLoop does not mark omitted English punctuation as a pronunciation error", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() { return true; }
      state = "inactive";
      mimeType = "audio/webm";
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        const dataEvent = new Event("dataavailable") as Event & { data: Blob };
        dataEvent.data = new Blob(["fake recording"], { type: this.mimeType });
        this.dispatchEvent(dataEvent);
        this.dispatchEvent(new Event("stop"));
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FakeMediaRecorder });
    Object.defineProperty(window, "AudioContext", { value: undefined, configurable: true });
    Object.defineProperty(window, "webkitAudioContext", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
      configurable: true,
    });
  });
  const targetText = "Hello. Can you hear me? The weather is cloudy today. Hokkaido is cool.";
  await page.route("**/api/practice/recordings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        recording_kind: "prompt",
        transcript: "テスト",
        target_text: targetText,
        target_language: "en-US",
        display_text: { primary_text: targetText },
        audio_base64: "UklGRg==",
        audio_mime_type: "audio/wav",
      }),
    });
  });
  await page.route("**/api/practice/attempt-jobs", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 180));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        job_id: "english-punctuation-job",
        status: "succeeded",
        current_stage: { stage: "complete", label: "比較準備が完了しました", model: "whisper-1" },
        result: {
          recording_kind: "attempt",
          target_language: "en-US",
          target_text: targetText,
          recognized_text: "hello can you hear me the weather is cloudy today Hokkaido is cool",
          model_recognized_text: targetText,
          overall_score: 100,
          overall_comment: "内容は正しく認識されています。",
          llm_comparison: {
            schema_version: 1,
            overall_score: 100,
            overall_comment: "内容は正しく認識されています。",
            phrases: [{
              phrase_index: 0,
              target_text: targetText,
              score: 100,
              comment: "句読点を除く内容が一致しています。",
            }],
          },
          comparison_alignment: { available: true, complete: true, phrases: [] },
          model_comparison_alignment: { available: true, complete: true, phrases: [] },
        },
      }),
    });
  });

  await page.goto("/speakloop");
  const nativeRecord = page.locator("#practice-native-record-button");
  await nativeRecord.click();
  await nativeRecord.click();
  await expect(page.locator("#practice-target-text")).toContainText("Hello.");

  const repeatRecord = page.locator("#practice-repeat-record-button");
  await repeatRecord.click();
  await repeatRecord.click();
  await expect(page.locator("#practice-status")).toHaveText("発音を確認しています。");
  await expect(page.locator("#practice-result-panel")).toBeVisible();
  await expect(page.locator("#practice-recognized-text")).toHaveText("hello can you hear me the weather is cloudy today Hokkaido is cool");
  await expect(page.locator("#practice-recognized-text")).not.toContainText("_");
  await expect(page.locator("#practice-score")).toHaveText("100点");
  const recognizedSize = await page.locator("#practice-recognized-text").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(recognizedSize.scrollWidth).toBeLessThanOrEqual(recognizedSize.clientWidth);
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-speakloop-english-punctuation.png`, fullPage: true });
  }
});

test("SpeakLoop plays the converted model audio but submits the original TTS for model ASR", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() { return true; }
      state = "inactive";
      mimeType = "audio/webm";
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        const dataEvent = new Event("dataavailable") as Event & { data: Blob };
        dataEvent.data = new Blob(["my reference voice"], { type: this.mimeType });
        this.dispatchEvent(dataEvent);
        this.dispatchEvent(new Event("stop"));
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FakeMediaRecorder });
    Object.defineProperty(window, "AudioContext", { value: undefined, configurable: true });
    Object.defineProperty(window, "webkitAudioContext", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
      configurable: true,
    });
    const playbackWindow = window as typeof window & { __modelPlayCalls?: number };
    playbackWindow.__modelPlayCalls = 0;
    HTMLMediaElement.prototype.play = function () {
      if (this.id === "practice-model-audio") playbackWindow.__modelPlayCalls = (playbackWindow.__modelPlayCalls || 0) + 1;
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
  });
  let ownVoiceRequested = false;
  let submittedOriginalTts = false;
  let submittedConvertedAudio = false;
  await page.route("**/api/practice/recordings", async (route) => {
    ownVoiceRequested = /name="use_own_voice"\r?\n\r?\ntrue/.test(route.request().postData() || "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        recording_kind: "prompt",
        transcript: "今日は何をしますか",
        target_text: "What are you doing today?",
        target_language: "en-US",
        display_text: { primary_text: "What are you doing today?" },
        audio_base64: "QkFTRQ==",
        audio_mime_type: "audio/wav",
        voice_conversion_job: {
          job_id: "practice-own-voice-job",
          status: "queued",
          current_stage: { stage: "gpu_wait", label: "利用可能なGPUを待っています", model: "Seed-VC" },
        },
      }),
    });
  });
  let polls = 0;
  await page.route("**/api/practice/voice-jobs/practice-own-voice-job", async (route) => {
    polls += 1;
    if (polls === 1) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          job_id: "practice-own-voice-job",
          status: "running",
          current_stage: { stage: "loading_seed_vc_model", label: "Seed-VCモデルを読み込んでいます", model: "Seed-VC" },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        job_id: "practice-own-voice-job",
        status: "succeeded",
        current_stage: { stage: "complete", label: "完了しました", model: "Seed-VC" },
        result: { audio_base64: "UklGRg==", audio_mime_type: "audio/wav" },
      }),
    });
  });
  await page.route("**/api/practice/attempt-jobs", async (route) => {
    const body = route.request().postDataBuffer() || Buffer.alloc(0);
    submittedOriginalTts = body.includes(Buffer.from("BASE"));
    submittedConvertedAudio = body.includes(Buffer.from("RIFF"));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        job_id: "practice-own-voice-attempt-job",
        status: "succeeded",
        current_stage: { stage: "complete", label: "比較準備が完了しました" },
        result: {
          recording_kind: "attempt",
          target_language: "en-US",
          target_text: "What are you doing today?",
          recognized_text: "What are you doing today?",
          model_recognized_text: "What are you doing today?",
          outcome: "evaluated",
          overall_score: 100,
          overall_comment: "完璧です。",
          llm_comparison: {
            schema_version: 1,
            overall_score: 100,
            overall_comment: "完璧です。",
            phrases: [{
              phrase_index: 0,
              target_text: "What are you doing today?",
              score: 100,
              comment: "正しく言えています。",
            }],
          },
          comparison_model: "gpt-5.6-terra",
          playback_padding_seconds: 0.1,
          comparison_alignment: {
            alignment_contract_version: 2,
            outcome: "evaluated",
            available: false,
            target_phrase_count: 1,
            playable_phrase_count: 0,
            all_phrases_playable: false,
            complete: false,
            phrases: [],
          },
          model_comparison_alignment: {
            alignment_contract_version: 2,
            outcome: "evaluated",
            available: false,
            target_phrase_count: 1,
            playable_phrase_count: 0,
            all_phrases_playable: false,
            complete: false,
            phrases: [],
          },
        },
      }),
    });
  });

  await page.goto("/speakloop");
  const ownVoice = page.locator("#practice-own-voice-toggle");
  await ownVoice.check();
  const record = page.locator("#practice-native-record-button");
  await record.click();
  await record.click();
  await expect(page.locator("#practice-prompt-panel")).toBeVisible();
  await expect(page.locator("#practice-job-status-label")).toContainText("GPUサーバーの準備を待っています");
  await expect(page.locator("#practice-play-model-button")).toBeDisabled();
  await expect(page.locator("#practice-job-status-label")).toContainText("お手本の声を調整する準備をしています", { timeout: 10_000 });
  await expect(page.locator("#practice-job-status-label")).not.toContainText("Seed-VC");
  await expect(page.locator("#practice-job-status-model")).toHaveText("Seed-VC");
  await expect(page.locator("#practice-job-status-detail")).toContainText("Seed-VCモデルを読み込んでいます");
  const ownVoiceStatusStyles = await page.locator("#practice-job-status").evaluate((status) => {
    const label = status.querySelector<HTMLElement>("#practice-job-status-label");
    const detail = status.querySelector<HTMLElement>("#practice-job-status-detail");
    if (!label || !detail) throw new Error("practice job status copy is missing");
    const labelStyle = getComputedStyle(label);
    const detailStyle = getComputedStyle(detail);
    return {
      labelColor: labelStyle.color,
      detailColor: detailStyle.color,
      labelSize: Number.parseFloat(labelStyle.fontSize),
      detailSize: Number.parseFloat(detailStyle.fontSize),
    };
  });
  expect(ownVoiceStatusStyles.detailColor).not.toBe(ownVoiceStatusStyles.labelColor);
  expect(ownVoiceStatusStyles.detailSize).toBeLessThan(ownVoiceStatusStyles.labelSize);
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-speakloop-own-voice-progress.png`, fullPage: true });
  }
  await expect(page.locator("#practice-play-model-button")).toBeEnabled({ timeout: 10_000 });
  const repeatRecord = page.locator("#practice-repeat-record-button");
  await repeatRecord.click();
  await repeatRecord.click();
  await expect(page.locator("#practice-result-panel")).toBeVisible();
  await expect(page.locator("#practice-score")).toHaveText("100点");
  await expect(page.locator("#practice-overall-comment")).toHaveText("完璧です。");
  await expect(page.locator("#practice-recognized-text")).toHaveText("What are you doing today");
  await expect(page.locator("#practice-phrase-feedback")).toContainText("正しく言えています。");
  const modelOnlyButton = page.locator("#practice-play-model-only-button");
  await expect(modelOnlyButton).toBeVisible();
  await expect(modelOnlyButton).toBeEnabled();
  await expect(modelOnlyButton).toContainText("お手本だけ再生");
  const modelPlayCallsBefore = await page.evaluate(() => (window as typeof window & { __modelPlayCalls?: number }).__modelPlayCalls || 0);
  await modelOnlyButton.click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __modelPlayCalls?: number }).__modelPlayCalls || 0))
    .toBeGreaterThan(modelPlayCallsBefore);
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await page.locator("html").evaluate((element) => {
      element.setAttribute("data-theme", "dark");
      element.setAttribute("data-theme-preference", "dark");
    });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-dark-speakloop-own-voice-complete.png`, fullPage: true });
  }
  expect(ownVoiceRequested).toBe(true);
  expect(submittedOriginalTts).toBe(true);
  expect(submittedConvertedAudio).toBe(false);
  expect(polls).toBeGreaterThanOrEqual(2);
  await assertNoHorizontalOverflow(page);
  await page.reload();
  await expect(page.locator("#practice-own-voice-toggle")).toBeChecked();
});

test("admin SkitVoice hides tab-audio capture when the browser does not support it", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: undefined, getDisplayMedia: undefined },
      configurable: true,
    });
  });
  await page.goto("/skitvoice/admin");
  await expect(page.locator("[data-tab-audio-slot]:visible")).toHaveCount(0);
  await expect(page.locator("[data-reference-source-help]")).toContainText("ファイル・録音");
  await expect(page.locator(".voice-lab-toast")).toHaveCount(0);
  await expect(page.locator("#vibevoice-message")).toBeEmpty();
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-skitvoice-tab-audio-hidden.png`, fullPage: true });
  }

  await page.locator('input[name="voice_file_1"]').setInputFiles({
    name: "voice.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("voice audio"),
  });
  const savedToast = page.locator(".voice-lab-toast", { hasText: "Speaker 1 の参照音声を保存しました" });
  await expect(savedToast).toBeVisible();
  await expect(savedToast).toHaveAttribute("role", "status");
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-skitvoice-toast.png`, fullPage: true });
    await page.locator("html").evaluate((element) => {
      element.setAttribute("data-theme", "dark");
      element.setAttribute("data-theme-preference", "dark");
    });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-dark-skitvoice-toast.png`, fullPage: true });
  }
  await assertNoHorizontalOverflow(page);
});

test("admin SkitVoice requires reference-audio rights confirmation before tab capture", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__tabAudioRequestCount", { value: 0, writable: true });
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() { return true; }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FakeMediaRecorder });
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getDisplayMedia: async () => {
          (window as typeof window & { __tabAudioRequestCount: number }).__tabAudioRequestCount += 1;
          throw new DOMException("capture is not supported", "NotSupportedError");
        },
      },
      configurable: true,
    });
  });

  await page.goto("/skitvoice/admin");
  const confirmation = page.locator("#vibevoice-rights-confirmed");
  const confirmationPanel = page.locator(".vibevoice-rights-confirmation");
  const actions = page.locator(".vibevoice-actions");
  const generateButton = page.locator("#vibevoice-generate-button");
  await expect(confirmation).not.toBeChecked();
  const [actionsBox, confirmationBox, generateBox] = await Promise.all([
    actions.boundingBox(),
    confirmationPanel.boundingBox(),
    generateButton.boundingBox(),
  ]);
  if ((page.viewportSize()?.width || 0) > 820) {
    expect((confirmationBox?.width || 0)).toBeGreaterThanOrEqual(
      (actionsBox?.width || 0) - (generateBox?.width || 0) - 40,
    );
    expect((generateBox?.x || 0)).toBeGreaterThanOrEqual(
      (confirmationBox?.x || 0) + (confirmationBox?.width || 0) - 2,
    );
    expect(Math.abs(
      ((confirmationBox?.y || 0) + (confirmationBox?.height || 0) / 2) -
      ((generateBox?.y || 0) + (generateBox?.height || 0) / 2),
    )).toBeLessThanOrEqual(8);
  } else {
    expect((confirmationBox?.width || 0)).toBeGreaterThanOrEqual((actionsBox?.width || 0) - 24);
    expect((generateBox?.y || 0)).toBeGreaterThanOrEqual(
      (confirmationBox?.y || 0) + (confirmationBox?.height || 0) - 2,
    );
  }
  await confirmation.check();
  await page.reload();
  await expect(confirmation).not.toBeChecked();

  await page.locator('[data-tab-audio-slot="1"]').click();
  await expect(confirmation).toBeFocused();
  await expect(page.locator("#vibevoice-message")).toContainText("本人から許諾");
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __tabAudioRequestCount: number }
  ).__tabAudioRequestCount)).toBe(0);

  await confirmation.check();
  await page.locator('[data-tab-audio-slot="1"]').click();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __tabAudioRequestCount: number }
  ).__tabAudioRequestCount)).toBe(1);
});

test("admin SkitVoice explains a runtime tab-audio incompatibility once and then hides the controls", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() { return true; }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FakeMediaRecorder });
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getDisplayMedia: async () => {
          throw new DOMException("capture is not supported", "NotSupportedError");
        },
      },
      configurable: true,
    });
  });
  await page.goto("/skitvoice/admin");
  await expect(page.locator('[data-tab-audio-slot="1"]')).toBeVisible();
  await page.locator("#vibevoice-rights-confirmed").check();
  await page.locator('[data-tab-audio-slot="1"]').click();
  const unsupportedToast = page.locator(".voice-lab-toast", { hasText: "このブラウザではタブ音声録音を使えません" });
  await expect(unsupportedToast).toBeVisible();
  await expect(unsupportedToast).toHaveAttribute("role", "alert");
  await expect(page.locator("[data-tab-audio-slot]:visible")).toHaveCount(0);
  await expect(page.locator("[data-reference-source-help]")).toContainText("ファイル・録音");
});

test("admin SkitVoice keeps its reference slots and generation action available", async ({ page }, testInfo) => {
  await page.goto("/skitvoice/admin");
  await expect(page.locator(".vibevoice-upload-slot")).toHaveCount(4);
  await expect(page.locator("#vibevoice-generate-button")).toBeVisible();
  await assertNoHorizontalOverflow(page);
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-skitvoice-admin-reference-slots.png`, fullPage: true });
  }
});

test("SpeakLoop keeps primary progress generic and shows subdued technical details", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const technicalLogs: unknown[][] = [];
    Object.defineProperty(window, "__voiceLabTechnicalLogs", { value: technicalLogs });
    const originalDebug = console.debug.bind(console);
    console.debug = (...args) => {
      technicalLogs.push(args);
      originalDebug(...args);
    };
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() { return true; }
      state = "inactive";
      mimeType = "audio/webm";
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        const dataEvent = new Event("dataavailable") as Event & { data: Blob };
        dataEvent.data = new Blob(["fake recording"], { type: this.mimeType });
        this.dispatchEvent(dataEvent);
        this.dispatchEvent(new Event("stop"));
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FakeMediaRecorder });
    Object.defineProperty(window, "AudioContext", { value: undefined, configurable: true });
    Object.defineProperty(window, "webkitAudioContext", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
      configurable: true,
    });
  });
  await page.route("**/api/practice/recordings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        recording_kind: "prompt",
        transcript: "今日はどこへ行きますか",
        target_text: "你好吗？你今天去哪里？",
        target_language: "zh-CN",
        display_text: { primary_text: "你好吗？你今天去哪里？", pinyin_text: "nǐ hǎo ma nǐ jīn tiān qù nǎ lǐ" },
        audio_base64: "UklGRg==",
        audio_mime_type: "audio/wav",
      }),
    });
  });
  let submissions = 0;
  await page.route("**/api/practice/attempt-jobs", async (route) => {
    submissions += 1;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        job_id: submissions === 1 ? "poll-job" : "failed-job",
        status: "queued",
        current_stage: { stage: "gpu_wait", label: "利用可能なGPUを待っています", provider: "RunPod Serverless", model: "funasr/paraformer-zh" },
      }),
    });
  });
  let polls = 0;
  await page.route("**/api/practice/attempt-jobs/poll-job", async (route) => {
    polls += 1;
    if (polls === 1) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          job_id: "poll-job",
          status: "running",
          current_stage: { stage: "loading_model", label: "FunASRモデルを読み込んでいます", provider: "RunPod Serverless", model: "funasr/paraformer-zh" },
          metrics: { delay_time_ms: 105, execution_time_ms: 220 },
        }),
      });
      return;
    }
    if (polls === 2) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          job_id: "poll-job",
          status: "running",
          current_stage: { stage: "evaluating_comparison", label: "比較結果を作っています", provider: "OpenAI", model: "gpt-5.6-terra" },
          metrics: { delay_time_ms: 105, execution_time_ms: 220 },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        job_id: "poll-job",
        status: "succeeded",
        current_stage: { stage: "complete", label: "比較準備が完了しました", provider: "RunPod Serverless", model: "funasr/paraformer-zh" },
        result: {
          target_language: "zh-CN",
          target_text: "你好吗？你今天去哪里？",
          recognized_text: "你好坏？色今天去哪里？",
          model_recognized_text: "你好吗？你今天去哪里？",
          overall_score: 80,
          overall_comment: "2つの語を確認しましょう。",
          llm_comparison: {
            schema_version: 1,
            overall_score: 80,
            overall_comment: "2つの語を確認しましょう。",
            phrases: [
              { phrase_index: 0, target_text: "你好吗？", score: 70, comment: "「好」を確認しましょう。" },
              { phrase_index: 1, target_text: "你今天去哪里？", score: 85, comment: "「去」を確認しましょう。" },
            ],
          },
          comparison_alignment: { available: true, complete: false, all_phrases_playable: false, target_phrase_count: 2, phrases: [{ index: 0, target_text: "你好吗？", available: false, audio_start: null, audio_end: null }, { index: 1, target_text: "你今天去哪里？", available: true, audio_start: 1, audio_end: 2 }] },
          model_comparison_alignment: { available: true, complete: true, all_phrases_playable: true, target_phrase_count: 2, phrases: [{ index: 0, target_text: "你好吗？", available: true, audio_start: 0.1, audio_end: 0.9 }, { index: 1, target_text: "你今天去哪里？", available: true, audio_start: 1, audio_end: 2.1 }] },
        },
      }),
    });
  });
  await page.route("**/api/practice/attempt-jobs/failed-job", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        job_id: "failed-job",
        status: "failed",
        current_stage: {
          stage: "failed",
          label: "処理に失敗しました",
          provider: "RunPod Serverless",
          model: "funasr/paraformer-zh",
          detail: "RunPodの残高不足でGPU処理を開始できません。RunPodのBillingを確認してください。",
        },
        result: null,
        error: {
          code: "practice_llm_failed",
          stage: "validate_response",
          retryable: true,
          message: "比較結果を作成できませんでした。もう一度お試しください。",
          fallback_to_legacy: false,
        },
      }),
    });
  });

  await page.goto("/speakloop");
  await page.locator("#practice-target-language-select").selectOption("zh-CN");
  const native = page.locator("#practice-native-record-button");
  await native.click();
  await native.click();
  await expect(page.locator("#practice-prompt-panel")).toBeVisible();
  const repeat = page.locator("#practice-repeat-record-button");
  await repeat.click();
  await repeat.click();
  await expect(page.locator("#practice-job-status-label")).toContainText("GPUサーバーの準備を待っています");
  await expect(page.locator("#practice-job-status-label")).toContainText("音声認識を準備しています");
  await expect(page.locator("#practice-job-status-label")).not.toContainText(/RunPod|FunASR|Whisper/);
  await expect(page.locator("#practice-job-status-model")).toContainText("RunPod Serverless");
  await expect(page.locator("#practice-job-status-model")).toContainText("funasr/paraformer-zh");
  await expect(page.locator("#practice-job-status-detail")).toContainText("FunASRモデルを読み込んでいます");
  await expect(page.locator("#practice-job-status-detail")).toContainText("待機 105ms / 処理 220ms");
  await expect(page.locator("#practice-job-status-label")).toHaveText("比較結果を作っています");
  await expect(page.locator("#practice-job-status-model")).toHaveText("OpenAI / gpt-5.6-terra");
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-speakloop-runpod-progress.png`, fullPage: true });
  }
  await expect(page.locator("#practice-result-panel")).toBeVisible({ timeout: 10_000 });
  const technicalLog = await page.evaluate(() => JSON.stringify((window as Window & { __voiceLabTechnicalLogs?: unknown[][] }).__voiceLabTechnicalLogs || []));
  expect(technicalLog).toContain("RunPod Serverless");
  expect(technicalLog).toContain("funasr/paraformer-zh");
  await expect.poll(() => page.locator("#practice-recognized-text .practice-diff-heard").evaluateAll(
    (elements) => elements.map((element) => element.textContent || "").join(""),
  )).toBe("你好坏色今天去哪里");
  await expect(page.locator("#practice-recognized-text .practice-diff-cell.is-substitute")).toHaveCount(2);
  await expect(page.locator("#practice-recognized-text button.practice-diff-cell.is-substitute")).toHaveCount(1);
  await expect(page.locator("#practice-recognized-text .practice-diff-correction").filter({ hasText: "吗" })).toHaveCount(1);
  await expect(page.locator("#practice-recognized-text .practice-diff-correction").filter({ hasText: "你" })).toHaveCount(1);
  await expect(page.locator("#practice-score")).toHaveText("80点");
  await expect(page.locator("#practice-phrase-feedback li")).toHaveCount(2);
  await expect(page.locator("#practice-play-model-button")).toContainText("一部フレーズ比較再生");
  await expect(page.locator("#practice-comparison-note")).toHaveText("確認できた1/2フレーズを順番に比較します。");
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-speakloop-runpod-result.png`, fullPage: true });
    await page.locator("html").evaluate((element) => {
      element.setAttribute("data-theme", "dark");
      element.setAttribute("data-theme-preference", "dark");
    });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-dark-speakloop-runpod-result.png`, fullPage: true });
    await page.locator("html").evaluate((element) => {
      element.setAttribute("data-theme", "light");
      element.setAttribute("data-theme-preference", "light");
    });
  }
  await repeat.click();
  await repeat.click();
  await expect(page.locator("#practice-job-status-label")).toContainText("処理に失敗しました");
  await expect(page.locator("#practice-job-status-detail")).toContainText("RunPodの残高不足");
  await expect(page.locator("#practice-job-status-detail")).toContainText("Billing");
  await expect(page.locator("#practice-error")).toHaveText("比較結果を作成できませんでした。もう一度お試しください。");
  await expect(page.locator("#practice-error")).not.toContainText(/RunPod|Billing|FunASR/);
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-speakloop-runpod-error.png`, fullPage: true });
    await page.locator("html").evaluate((element) => {
      element.setAttribute("data-theme", "dark");
      element.setAttribute("data-theme-preference", "dark");
    });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-dark-speakloop-runpod-error.png`, fullPage: true });
  }
  expect(polls).toBeGreaterThanOrEqual(2);
});

test("SpeakLoop cancels either recording without sending audio", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() { return true; }
      state = "inactive";
      mimeType = "audio/webm";
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        const dataEvent = new Event("dataavailable") as Event & { data: Blob };
        dataEvent.data = new Blob(["fake recording"], { type: this.mimeType });
        this.dispatchEvent(dataEvent);
        this.dispatchEvent(new Event("stop"));
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FakeMediaRecorder });
    Object.defineProperty(window, "AudioContext", { value: undefined, configurable: true });
    Object.defineProperty(window, "webkitAudioContext", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
      configurable: true,
    });
  });
  let recordingRequests = 0;
  const intents: string[] = [];
  await page.route("**/api/practice/recordings", async (route) => {
    recordingRequests += 1;
    const body = route.request().postData() || "";
    const intent = body.match(/name="recording_intent"\r?\n\r?\n([^\r\n]+)/)?.[1] || "";
    intents.push(intent);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        recording_kind: "prompt",
        transcript: "今日は何をしますか",
        target_text: "What are you doing today?",
        target_language: "en-US",
        display_text: { primary_text: "What are you doing today?" },
        audio_base64: "UklGRg==",
        audio_mime_type: "audio/wav",
      }),
    });
  });

  await page.goto("/speakloop");
  const nativeRecord = page.locator("#practice-native-record-button");
  const nativeCancel = page.locator("#practice-native-cancel-button");
  await nativeRecord.click();
  await expect(nativeCancel).toBeVisible();
  await expect(page.locator("#practice-repeat-record-button")).toBeDisabled();
  await nativeCancel.click();
  await expect(page.locator("#practice-status")).toContainText("録音をキャンセルしました");
  expect(recordingRequests).toBe(0);

  await nativeRecord.click();
  await nativeRecord.click();
  await expect(page.locator("#practice-prompt-panel")).toBeVisible();
  expect(recordingRequests).toBe(1);
  expect(intents).toEqual(["prompt"]);

  const repeatRecord = page.locator("#practice-repeat-record-button");
  const repeatCancel = page.locator("#practice-repeat-cancel-button");
  await repeatRecord.click();
  await expect(repeatCancel).toBeVisible();
  await expect(nativeRecord).toBeDisabled();
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-speakloop-recording-cancel.png`, fullPage: true });
    await page.locator("html").evaluate((element) => {
      element.setAttribute("data-theme", "dark");
      element.setAttribute("data-theme-preference", "dark");
    });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-dark-speakloop-recording-cancel.png`, fullPage: true });
  }
  await repeatCancel.click();
  await expect(page.locator("#practice-status")).toContainText("録音をキャンセルしました");
  expect(recordingRequests).toBe(1);

  await nativeRecord.click();
  await nativeRecord.click();
  await expect.poll(() => recordingRequests).toBe(2);
  expect(intents).toEqual(["prompt", "prompt"]);
});

test("SpeakLoop switches from one task card to a responsive two-step flow", async ({ page }) => {
  await page.goto("/speakloop");
  const nativePanel = page.locator("#practice-native-panel");
  const promptPanel = page.locator("#practice-prompt-panel");
  const flow = page.locator(".react-practice-flow");
  await expect(promptPanel).toBeHidden();
  await expect(page.locator("#practice-auto-play-comparison")).toHaveCount(0);
  await expect(page.getByText("練習終了後すぐ再生", { exact: true })).toHaveCount(0);

  const microphone = page.locator("#practice-native-record-button .record-icon");
  const recordButton = page.locator("#practice-native-record-button");
  const caption = page.locator("#practice-native-record-button + span");
  const [microphoneBox, recordButtonBox, captionBox] = await Promise.all([
    microphone.boundingBox(),
    recordButton.boundingBox(),
    caption.boundingBox(),
  ]);
  expect(microphoneBox).not.toBeNull();
  expect(recordButtonBox).not.toBeNull();
  expect(captionBox).not.toBeNull();
  expect((microphoneBox?.y || 0) + (microphoneBox?.height || 0)).toBeLessThanOrEqual((recordButtonBox?.y || 0) + (recordButtonBox?.height || 0));
  expect(captionBox?.y || 0).toBeGreaterThanOrEqual((recordButtonBox?.y || 0) + (recordButtonBox?.height || 0));
  await expect(microphone.locator("svg")).toBeVisible();
  await expect(recordButton).toHaveCSS("background-color", "rgb(230, 90, 67)");
  await recordButton.evaluate((element) => element.classList.add("is-recording"));
  await expect(recordButton).toHaveCSS("background-color", "rgb(199, 55, 47)");
  await recordButton.evaluate((element) => element.classList.remove("is-recording"));

  const [idleCard, flowBox] = await Promise.all([nativePanel.boundingBox(), flow.boundingBox()]);
  expect(idleCard).not.toBeNull();
  expect(flowBox).not.toBeNull();
  expect(idleCard?.width || 0).toBeGreaterThanOrEqual(Math.min((flowBox?.width || 0) * 0.7, 960));
  expect(Math.abs(((idleCard?.x || 0) + (idleCard?.width || 0) / 2) - ((flowBox?.x || 0) + (flowBox?.width || 0) / 2))).toBeLessThanOrEqual(4);

  await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("#practice-prompt-panel");
    const target = document.querySelector<HTMLElement>("#practice-target-text");
    if (panel) panel.hidden = false;
    if (target) target.textContent = "会議が終わったら、駅の近くにある静かな喫茶店で今後の予定を相談したいです。";
  });
  await expect(promptPanel).toBeVisible();
  await expect(page.locator("#practice-play-model-button")).toBeVisible();
  await expect(page.locator("#practice-speed-slider")).toBeVisible();
  const [nativeBox, promptBox] = await Promise.all([nativePanel.boundingBox(), promptPanel.boundingBox()]);
  const viewportWidth = page.viewportSize()?.width || 0;
  if (viewportWidth <= 820) {
    expect((promptBox?.y || 0)).toBeGreaterThan((nativeBox?.y || 0) + (nativeBox?.height || 0) - 2);
  } else {
    expect(Math.abs((nativeBox?.y || 0) - (promptBox?.y || 0))).toBeLessThanOrEqual(8);
  }
  await assertNoHorizontalOverflow(page);
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${test.info().project.name}-light-speakloop-prompt.png`, fullPage: true });
    await page.locator("html").evaluate((element) => {
      element.setAttribute("data-theme", "dark");
      element.setAttribute("data-theme-preference", "dark");
    });
    await page.screenshot({ path: `tmp/playwright/visual-review/${test.info().project.name}-dark-speakloop-prompt.png`, fullPage: true });
  }
});

test("admin SkitVoice keeps its research language and work areas available", async ({ page }) => {
  await page.goto("/skitvoice/admin");
  await expect(page.locator("#vibevoice-output-language")).toHaveValue("en-US");
  await expect(page.getByRole("region", { name: "台本" })).toBeVisible();
  await expect(page.getByRole("region", { name: "参照音声" })).toBeVisible();
  await expect(page.locator("#vibevoice-generate-button")).toBeVisible();
  await assertNoHorizontalOverflow(page);
});

test("admin SkitVoice keeps progress readable while retaining technical progress logs", async ({ page }) => {
  let statusCall = 0;
  await page.route("**/api/vibevoice/jobs**", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/vibevoice/jobs") {
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          job_id: "vv-ui-job",
          status: "queued",
          current_stage: {
            stage: "gpu_wait",
            label: "利用可能なGPUを待っています",
            provider: "RunPod Serverless",
            model: "vibevoice-large-aoi-pinned",
            detail: "RunPodのqueueでworkerの割り当てを待っています。",
          },
          progress_log: [],
        }),
      });
    }
    statusCall += 1;
    if (statusCall === 1) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          job_id: "vv-ui-job",
          status: "running",
          current_stage: {
            stage: "loading_vibevoice_model",
            label: "VibeVoice Largeモデルを読み込んでいます",
            provider: "RunPod Serverless",
            model: "vibevoice-large-aoi-pinned",
            detail: "初回起動時は数分かかる場合があります。",
          },
          progress_log: [],
        }),
      });
    }
    if (statusCall <= 4) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          job_id: "vv-ui-job",
          status: "running",
          current_stage: {
            stage: "loading_seed_vc_model",
            label: "Seed-VCモデルを読み込んでいます",
            provider: "RunPod Serverless",
            model: "Seed-VC",
            detail: "",
          },
          progress_log: [{
            stage: "loading_seed_vc_model",
            label: "Seed-VCモデルを読み込んでいます",
            model: "Seed-VC",
          }],
        }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        job_id: "vv-ui-job",
        status: "succeeded",
        current_stage: { stage: "complete", label: "完了", provider: "" },
        progress_log: [{ stage: "complete", label: "完了", provider: "" }],
        result: {
          audio_mime_type: "audio/wav",
          audio_base64: "UklGRg==",
          normalized_script: "Speaker 1: こんにちは。",
          diagnostics: {},
          providers: { vibevoice: "fake" },
          artifacts: [],
        },
      }),
    });
  });

  await page.goto("/skitvoice/admin");
  await page.locator("#vibevoice-script").fill("1 こんにちは。");
  await page.locator("#vibevoice-directed-line-mode").evaluate((element) => {
    const control = element as HTMLInputElement;
    control.checked = false;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.locator('input[name="voice_file_1"]').setInputFiles({
    name: "voice.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("RIFF voice"),
  });
  await page.locator("#vibevoice-rights-confirmed").check();
  await page.locator("#vibevoice-generate-button").click();

  await expect(page.locator("#vibevoice-message")).toContainText(/VibeVoice|Seed-VC|音声生成/);
  await expect(page.locator("#vibevoice-progress-log")).toContainText("Seed-VCモデルを読み込んでいます");
  await expect(page.locator("#vibevoice-progress-log")).not.toContainText("loading_seed_vc_model");
  await assertNoHorizontalOverflow(page);
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({
      path: `tmp/playwright/visual-review/${test.info().project.name}-skitvoice-runpod-progress.png`,
      fullPage: true,
    });
    await page.locator("html").evaluate((element) => {
      element.setAttribute("data-theme", "dark");
      element.setAttribute("data-theme-preference", "dark");
    });
    await page.screenshot({
      path: `tmp/playwright/visual-review/${test.info().project.name}-dark-skitvoice-runpod-progress.png`,
      fullPage: true,
    });
  }
  await expect(page.locator("#vibevoice-message")).toHaveText("生成しました。", { timeout: 5_000 });
});

test("SkitVoice uses Voice Lab audio controls for references and generated results", async ({ page }) => {
  for (const route of ["/skitvoice/admin"]) {
    await page.goto(route);
    const referenceInput = page.locator('input[name="voice_file_1"]');
    await referenceInput.setInputFiles({ name: "voice.wav", mimeType: "audio/wav", buffer: Buffer.from("RIFF reference") });
    const referenceAudio = page.locator('[data-saved-voice-preview-slot="1"]');
    const referenceControl = referenceAudio.locator("xpath=following-sibling::*[@data-sample-audio-control][1]");
    await expect(referenceAudio).toBeHidden();
    await expect(referenceControl).toBeVisible();
    const [voiceSlotBox, referenceControlBox] = await Promise.all([
      referenceInput.locator("xpath=..").boundingBox(),
      referenceControl.boundingBox(),
    ]);
    expect(voiceSlotBox).not.toBeNull();
    expect(referenceControlBox).not.toBeNull();
    expect(referenceControlBox?.width || 0).toBeGreaterThanOrEqual((voiceSlotBox?.width || 0) * 0.8);

    await page.evaluate(() => {
      const result = document.querySelector<HTMLElement>("#vibevoice-result");
      const audio = document.querySelector<HTMLAudioElement>("#vibevoice-audio");
      if (!result || !audio) return;
      result.hidden = false;
      audio.src = "data:audio/wav;base64,UklGRg==";
      window.ensureVoiceLabAudioControl?.(audio, "生成結果");
    });
    const resultAudio = page.locator("#vibevoice-audio");
    const resultControl = resultAudio.locator("xpath=following-sibling::*[@data-sample-audio-control][1]");
    await expect(resultAudio).toBeHidden();
    await expect(resultControl).toBeVisible();
    await expect(resultControl.locator(".sample-audio-play-button")).toHaveAttribute("aria-label", "生成結果を再生");
    await assertNoHorizontalOverflow(page);
    if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
      const slug = `${route.includes("admin") ? "admin-" : ""}voice-lab-players`;
      await page.screenshot({ path: `tmp/playwright/visual-review/${test.info().project.name}-${slug}.png`, fullPage: true });
    }
  }
});

test("SkitVoice sample save stays admin-only and does not appear on the public page", async ({ page }) => {
  await page.goto("/skitvoice/admin");
  await page.locator(".admin-config-group > summary").click();
  for (const [language] of [["en-US"], ["zh-CN"], ["ja-JP"]]) {
    const section = page.locator(`[data-public-sample-language="${language}"]`);
    await section.locator("[data-public-sample-file]").setInputFiles({
      name: `${language}.wav`,
      mimeType: "audio/wav",
      buffer: Buffer.from(`RIFF ${language} sample audio`),
    });
  }
  const saveButton = page.locator("[data-public-samples-save]");
  await saveButton.click();
  await expect(saveButton).toBeDisabled();
  await expect(saveButton).toHaveText("保存中…");
  await expect(saveButton).toHaveText("保存済み");
  await expect(page.locator("[data-public-samples-status]")).toContainText("一般画面には表示されません");
  await expect(page.getByText(/\.wav/)).toHaveCount(0);
  await expect(page.locator(".skitvoice-samples-admin .sample-audio-control")).toHaveCount(3);
  await expect(page.locator(".skitvoice-samples-admin audio[data-sample-audio-custom]").first()).toBeHidden();
  const adminSampleBoxes = await Promise.all(["en-US", "zh-CN", "ja-JP"].map((language) => page.locator(`[data-public-sample-language="${language}"]`).boundingBox()));
  if ((page.viewportSize()?.width || 0) > 820) {
    expect(Math.abs((adminSampleBoxes[0]?.y || 0) - (adminSampleBoxes[1]?.y || 0))).toBeLessThanOrEqual(8);
    expect(adminSampleBoxes[0]?.x || 0).toBeLessThan(adminSampleBoxes[1]?.x || 0);
    expect(adminSampleBoxes[1]?.x || 0).toBeLessThan(adminSampleBoxes[2]?.x || 0);
  }
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${test.info().project.name}-sample-save-success.png`, fullPage: true });
  }

  await page.goto("/skitvoice");
  await expect(page.getByRole("heading", { name: "研究機能は一般公開していません" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "出力音声サンプル" })).toHaveCount(0);
  await expect(page.locator("[data-public-sample-language]")).toHaveCount(0);
  await expect(page.locator("#vibevoice-form")).toHaveCount(0);
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await page.screenshot({ path: `tmp/playwright/visual-review/${test.info().project.name}-skitvoice-public-closed.png`, fullPage: true });
    await page.evaluate(() => localStorage.setItem("mo-speech-theme", "dark"));
    await page.reload();
    await expect(page.locator("[data-public-sample-language]")).toHaveCount(0);
    await page.screenshot({ path: `tmp/playwright/visual-review/${test.info().project.name}-skitvoice-public-closed-dark.png`, fullPage: true });
  }
});

test("sample save failure leaves a visible retry action", async ({ page }) => {
  await page.route("**/api/public-sample-audios", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "保存先へ書き込めませんでした" }) });
      return;
    }
    await route.fallback();
  });
  await page.goto("/skitvoice/admin");
  await page.locator(".admin-config-group > summary").click();
  const englishSection = page.locator('[data-public-sample-language="en-US"]');
  await englishSection.locator("[data-public-sample-file]").setInputFiles({
    name: "english-sample.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("RIFF sample audio"),
  });
  const saveButton = page.locator("[data-public-samples-save]");
  await saveButton.click();
  await expect(saveButton).toHaveText("再試行");
  await expect(page.locator("[data-public-samples-status]")).toHaveText("保存先へ書き込めませんでした");
  await expect(page.locator("[data-public-samples-status]")).toHaveAttribute("data-state", "error");
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${test.info().project.name}-sample-save-error.png`, fullPage: true });
  }
});

for (const route of adminRoutes) {
  test(`${route} exposes the Voice Lab admin hierarchy without clipped controls`, async ({ page }) => {
    await page.goto(route);
    await expect(page.getByText("Voice Lab", { exact: false }).first()).toBeVisible();
    await expect(page.locator(".admin-nav")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertVisibleControlsInsideViewport(page);
    const firstControl = page.locator("summary:visible, button:visible:not([disabled])").first();
    await firstControl.focus();
    await expect(firstControl).toBeFocused();
    const settings = page.locator(".admin-config-group");
    await settings.locator("summary").click();
    await expect(settings).toHaveAttribute("open", "");
    await assertNoHorizontalOverflow(page);
    await assertVisibleControlsInsideViewport(page);
  });
}

test("admin loads the public user list only after operations settings open", async ({ page }, testInfo) => {
  let publicUserRequests = 0;
  await page.route("**/api/public-users*", async (route) => {
    publicUserRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        users: [
          {
            email: "portfolio-owner@example.com",
            created_at: "2026-07-20T09:00:00.000Z",
            last_login_at: "2026-07-22T08:30:00.000Z",
            last_seen_at: "2026-07-22T08:35:00.000Z",
            is_admin: true,
            usage: { speakloop: 18, voice_conversion: 2 },
          },
          {
            email: "long-public-demo-user-address@example.com",
            created_at: "2026-07-21T10:00:00.000Z",
            last_login_at: "2026-07-22T07:45:00.000Z",
            last_seen_at: "",
            is_admin: false,
            usage: {},
          },
        ],
        limit: 2000,
        stored: 2,
      }),
    });
  });

  await page.goto("/admin");
  await expect.poll(() => publicUserRequests).toBe(0);

  const settings = page.locator(".admin-config-group");
  await settings.locator("summary").click();
  await expect(page.locator("[data-public-users-status]")).toHaveText("2件を表示しています。");
  await expect(page.locator("[data-public-users-body] > li")).toHaveCount(2);
  await expect.poll(() => publicUserRequests).toBe(1);

  await settings.locator("summary").click();
  await settings.locator("summary").click();
  await expect.poll(() => publicUserRequests).toBe(1);
  await assertNoHorizontalOverflow(page);
  await assertVisibleControlsInsideViewport(page);

  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({
      path: `tmp/playwright/visual-review/${testInfo.project.name}-public-users-lazy-load.png`,
      fullPage: true,
    });
  }
});

test("admin work areas use side-by-side desktop layouts and stack on mobile", async ({ page }) => {
  const viewportWidth = page.viewportSize()?.width || 0;

  await page.goto("/admin");
  const [control, result] = await Promise.all([
    page.locator(".control-panel").boundingBox(),
    page.locator(".result-panel").boundingBox(),
  ]);
  if (viewportWidth > 820) {
    expect(Math.abs((control?.y || 0) - (result?.y || 0))).toBeLessThanOrEqual(8);
    expect(control?.x || 0).toBeLessThan(result?.x || 0);
  } else {
    expect(result?.y || 0).toBeGreaterThan((control?.y || 0) + (control?.height || 0) - 2);
  }

  await page.goto("/speakloop/admin");
  const recording = page.getByRole("region", { name: "練習入力" });
  const model = page.getByRole("region", { name: "お手本音声" });
  const [recordingBox, modelBox] = await Promise.all([recording.boundingBox(), model.boundingBox()]);
  if (viewportWidth > 820) {
    expect(Math.abs((recordingBox?.y || 0) - (modelBox?.y || 0))).toBeLessThanOrEqual(8);
  } else {
    expect(modelBox?.y || 0).toBeGreaterThan((recordingBox?.y || 0) + (recordingBox?.height || 0) - 2);
  }

  await page.goto("/skitvoice/admin");
  const [adminScript, adminControls] = await Promise.all([
    page.getByRole("region", { name: "台本" }).boundingBox(),
    page.locator(".vibevoice-control-stack").boundingBox(),
  ]);
  if (viewportWidth > 820) {
    expect(Math.abs((adminScript?.y || 0) - (adminControls?.y || 0))).toBeLessThanOrEqual(8);
  } else {
    expect(adminControls?.y || 0).toBeGreaterThan((adminScript?.y || 0) + (adminScript?.height || 0) - 2);
  }
});

test("advanced admin settings stay optional and never hide the primary action", async ({ page }) => {
  await page.goto("/admin");
  const workbenchAdvanced = page.locator(".control-panel > .admin-advanced-group");
  await expect(workbenchAdvanced).not.toHaveAttribute("open", "");
  await expect(page.locator("#submit-button")).toBeVisible();

  await page.goto("/skitvoice/admin");
  const generationAdvanced = page.locator(".vibevoice-settings-panel.admin-advanced-group");
  const generateButton = page.locator("#vibevoice-generate-button");
  await expect(generationAdvanced).not.toHaveAttribute("open", "");
  await expect(generateButton).toBeVisible();
  if ((page.viewportSize()?.width || 0) > 820) {
    const initialGenerateBox = await generateButton.boundingBox();
    expect((initialGenerateBox?.y || 0) + (initialGenerateBox?.height || 0)).toBeLessThanOrEqual((page.viewportSize()?.height || 0) + 1);
  }

  await generationAdvanced.locator("summary").click();
  const [advancedBox, generateBox] = await Promise.all([
    generationAdvanced.boundingBox(),
    generateButton.boundingBox(),
  ]);
  expect(generateBox?.y || 0).toBeGreaterThanOrEqual((advancedBox?.y || 0) + (advancedBox?.height || 0) - 2);
  await assertNoHorizontalOverflow(page);
});

test("long audio and practice histories wrap without breaking the admin viewport", async ({ page }) => {
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, { historyState: "long" });

  await page.goto("/admin");
  await expect(page.locator(".history-item").first()).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await assertVisibleControlsInsideViewport(page);

  await page.goto("/speakloop/admin");
  await expect(page.locator(".practice-history-item").first()).toBeVisible();
  await page.locator(".practice-history-diagnostics summary").click();
  await assertNoHorizontalOverflow(page);
  await assertVisibleControlsInsideViewport(page);
});

test("practice history API errors remain readable inside the admin layout", async ({ page }) => {
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, { historyState: "error" });
  await page.goto("/speakloop/admin");
  await expect(page.locator("#practice-history-status")).toContainText("履歴fixtureの読み込みに失敗しました");
  await assertNoHorizontalOverflow(page);
});

test("Cloudflare mode hides local-only history panels from shared admin pages", async ({ page }) => {
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, { historyState: "disabled" });

  await page.goto("/admin");
  await expect(page.locator("[data-audio-history-panel]")).toBeHidden();

  await page.goto("/speakloop/admin");
  await expect(page.locator(".admin-config-group")).toHaveAttribute("open", "");
  await expect(page.locator("[data-practice-history-panel]")).toHaveCount(3);
  for (const panel of await page.locator("[data-practice-history-panel]").all()) {
    await expect(panel).toBeHidden();
  }
  await assertNoHorizontalOverflow(page);
});

for (const route of utilityRoutes) {
  test(`${route.path} keeps compatibility controls inside the Voice Lab layout`, async ({ page }) => {
    await page.goto(route.path);
    await expect(page.getByRole("link", { name: /Voice Lab/ }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: route.heading, level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: route.action, exact: true }).first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertVisibleControlsInsideViewport(page);
  });
}
