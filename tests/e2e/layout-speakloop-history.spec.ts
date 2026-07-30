import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

import { assertNoHorizontalOverflow, assertVisibleControlsInsideViewport, installUiApiFixtures } from "./fixtures";

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

test("SpeakLoop drops an in-flight recomputation once recording starts", async ({ page }) => {
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
  await installUiApiFixtures(page, {
    historyState: "practice-preview",
    practiceUiMode: "local",
    practicePreviewRecomputeDelayMs: 1500,
  });
  await page.goto("/speakloop");
  await page.locator("#practice-history-preview summary").click();
  await page.locator("#practice-history-preview-button").click();
  const source = page.locator("#practice-history-preview-source-select");
  const recomputeResponse = page.waitForResponse((response) => response.url().includes("/recomputed-comparison"));
  await source.selectOption("recomputed");
  await page.locator("#practice-native-record-button").click();

  await expect(page.locator("#practice-native-record-button")).toHaveAttribute("aria-label", "録音中");
  await recomputeResponse;
  await expect(source).toHaveValue("saved");
  await expect(page.locator("#practice-history-preview-status")).toContainText("保存時の比較区間");
  await expect(page.locator("#practice-comparison-note")).toContainText("2/2フレーズを順番に比較できます");
  await page.locator("#practice-native-cancel-button").click();
});

test("SpeakLoop refuses recomputation when the prompt audio failed to load", async ({ page }) => {
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, {
    historyState: "practice-preview",
    practiceUiMode: "local",
    practicePreviewModelAudioMissing: true,
    practicePreviewModelAudioDelayMs: 350,
    practicePreviewRecomputeDelayMs: 1200,
  });
  await page.goto("/speakloop");
  await page.locator("#practice-history-preview summary").click();
  await page.locator("#practice-history-preview-button").click();
  const source = page.locator("#practice-history-preview-source-select");
  const recomputeResponse = page.waitForResponse((response) => response.url().includes("/recomputed-comparison"));
  await source.selectOption("recomputed");

  await expect(page.locator("#practice-history-preview-status")).toContainText("お手本音声を読み込めなかった");
  await recomputeResponse;
  await expect(source).toHaveValue("saved");
  await expect(page.locator("#practice-comparison-note")).toContainText("比較再生は利用できません");
});

test("SpeakLoop reports an unrecorded saved padding as missing instead of zero", async ({ page }) => {
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, {
    historyState: "practice-preview",
    practiceUiMode: "local",
    practicePreviewSavedPaddingMissing: true,
  });
  await page.goto("/speakloop");
  await page.locator("#practice-history-preview summary").click();
  await page.locator("#practice-history-preview-button").click();

  const status = page.locator("#practice-history-preview-status");
  await page.locator("#practice-history-preview-source-select").selectOption("recomputed");
  // 0.00秒は有効な設定値なので、未記録と区別できなければならない。
  await expect(status).toContainText("保存時は記録なしです");
  await expect(status).not.toContainText("保存時は0.00秒");

  await page.locator("#practice-history-preview-source-select").selectOption("saved");
  await expect(status).toContainText("保存時の余白は記録なしです");
});

test("SpeakLoop restores the saved ranges when recomputation becomes unavailable", async ({ page }) => {
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, {
    historyState: "practice-preview",
    practiceUiMode: "local",
    practicePreviewRecomputeUnavailableAtMaxPadding: true,
  });
  await page.goto("/speakloop");
  await page.locator("#practice-history-preview summary").click();
  await page.locator("#practice-history-preview-button").click();
  await page.locator("#practice-history-preview-source-select").selectOption("recomputed");
  await expect(page.locator("#practice-comparison-note")).toContainText("3/3フレーズ");

  // 再計算に成功した後で不可になっても、区間まで保存値へ戻す。
  await page.locator("#practice-playback-padding-slider").fill("0.5");

  await expect(page.locator("#practice-history-preview-status")).toContainText("再計算できません");
  await expect(page.locator("#practice-history-preview-source-select")).toHaveValue("saved");
  await expect(page.locator("#practice-comparison-note")).toContainText("2/2フレーズ");
});

test("SpeakLoop locks the comparison-range selector while recording", async ({ page }) => {
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
  await page.goto("/speakloop");
  const source = page.locator("#practice-history-preview-source-select");
  await expect(source).toBeEnabled();

  await page.locator("#practice-native-record-button").click();

  await expect(source).toBeDisabled();
  await page.locator("#practice-native-cancel-button").click();
  await expect(source).toBeEnabled();
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

test("SpeakLoop falls back to repeat-only playback when the saved prompt audio cannot be loaded", async ({ page }) => {
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, {
    historyState: "practice-preview",
    practiceUiMode: "local",
    practicePreviewModelAudioMissing: true,
  });
  await page.goto("/speakloop");
  await page.locator("#practice-history-preview summary").click();
  await page.locator("#practice-history-preview-button").click();

  await expect(page.locator("#practice-saved-result-notice")).toBeVisible();
  // 履歴一覧はURLを返すが、実際の取得は404。読み込み失敗を検知して復唱音声だけにする。
  await expect(page.locator("#practice-history-preview-status")).toContainText("お手本音声を読み込めなかった");
  await expect(page.locator("#practice-comparison-note")).toContainText("比較再生は利用できません");
  await expect(page.locator("#practice-play-model-button")).toContainText("復唱音声を再生");
  await expect(page.locator("#practice-play-model-only-button")).toBeHidden();
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
