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
    const playbackWindow = window as typeof window & {
      __modelPlayCalls?: number;
      __submittedModelAudioBytes?: number[];
    };
    playbackWindow.__modelPlayCalls = 0;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const requestUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (requestUrl.includes("/api/practice/attempt-jobs") && init?.body instanceof FormData) {
        const modelAudio = init.body.get("model_audio");
        if (modelAudio instanceof Blob) {
          playbackWindow.__submittedModelAudioBytes = Array.from(
            new Uint8Array(await modelAudio.arrayBuffer()),
          );
        }
      }
      return nativeFetch(input, init);
    };
    HTMLMediaElement.prototype.play = function () {
      if (this.id === "practice-model-audio") playbackWindow.__modelPlayCalls = (playbackWindow.__modelPlayCalls || 0) + 1;
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
  });
  let ownVoiceRequested = false;
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
  const submittedModelAudioBytes = await page.evaluate(() =>
    (window as typeof window & { __submittedModelAudioBytes?: number[] }).__submittedModelAudioBytes || []
  );
  expect(submittedModelAudioBytes).toEqual([66, 65, 83, 69]);
  expect(submittedModelAudioBytes).not.toEqual([82, 73, 70, 70]);
  expect(polls).toBeGreaterThanOrEqual(2);
  await assertNoHorizontalOverflow(page);
  await page.reload();
  await expect(page.locator("#practice-own-voice-toggle")).toBeChecked();
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
