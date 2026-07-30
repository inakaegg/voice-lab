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
