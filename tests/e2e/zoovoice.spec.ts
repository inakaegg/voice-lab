import { mkdir } from "node:fs/promises";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { assertNoHorizontalOverflow, assertVisibleControlsInsideViewport } from "./fixtures";

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

test("zoovoice records, sends only intensity, and explains the selected animal", async ({ page }, testInfo) => {
  let composeBody = "";
  await installZoovoiceApi(page, {
    turnstileRequired: true,
    onCompose: (body) => {
      composeBody = body;
    },
    transcript: "猫が窓辺でゆっくり眠っています。とても長い日本語でも結果欄からはみ出しません。",
  });
  await installTurnstileStub(page);
  await installAutoplayObserver(page);
  await page.goto("/zoovoice");

  await expect(page.getByRole("heading", { name: "話すだけで、ぴったりの動物を。" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /声から動物を連想する/ }).getByText("β版", { exact: true })).toBeVisible();
  await expect(page.locator("[data-tech-note]")).toContainText("Google Cloud Run");
  await expect(page.getByRole("button", { name: "録音する" })).toBeEnabled();
  await expect(page.getByText("不正利用防止の確認が完了しました。")).toHaveCount(0);
  await expect.poll(() => page.getByRole("button", { name: "録音する" }).evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    borderRadius: getComputedStyle(element).borderRadius,
  }))).toEqual({ background: "rgb(239, 68, 68)", borderRadius: "9999px" });
  await captureIfRequested(page, testInfo, "initial-light");
  if (process.env.ZOOVOICE_CAPTURE_VISUALS === "1") {
    await setTheme(page, "暗色");
    await captureIfRequested(page, testInfo, "initial-dark");
    await setTheme(page, "明色");
  }
  await expect(page.locator("select")).toHaveCount(0);
  await expect(page.getByText("feel lucky?", { exact: true })).toHaveCount(0);
  await page.locator("#zoovoice-intensity").fill("75");
  await page.getByRole("button", { name: "録音する" }).click();
  await expect(page.getByText("REC", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "録音をキャンセル" })).toBeVisible();
  await captureIfRequested(page, testInfo, "recording-light");
  await page.waitForTimeout(650);
  await expect.poll(() => turnstileState(page, "renderCount")).toBe(1);
  await page.getByRole("button", { name: "録音を止める" }).click();
  await expect(page.getByRole("button", { name: "録音をキャンセル" })).toHaveCount(0);
  await expect(page.getByText("声を聞き取り、動物を連想して合成しています。")).toBeVisible();
  await captureIfRequested(page, testInfo, "processing-light");
  await expect(page.getByText("できあがりました。自動再生を開始します。")).toBeVisible();

  assertMultipartField(composeBody, "settings", JSON.stringify({ intensity: 75 }));
  assertMultipartField(composeBody, "turnstile_token", "browser-turnstile-token-1");
  expect(composeBody).not.toContain("arrangement");
  await expect.poll(() => page.evaluate(() => Number((window as typeof window & { __zoovoicePlayAttempts?: number }).__zoovoicePlayAttempts || 0))).toBe(1);
  await expect(page.getByText("猫", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("猫が窓辺でゆっくり眠っています。とても長い日本語でも結果欄からはみ出しません。")).toBeVisible();
  await expect(page.getByTestId("zoovoice-animal-figure")).toContainText("猫");
  await expect(page.getByRole("button", { name: "結果を一時停止" })).toBeVisible();
  await page.getByRole("button", { name: "結果を一時停止" }).click();
  await expect(page.getByRole("button", { name: "結果を再生" })).toBeVisible();
  await expect(page.getByRole("link", { name: "WAVを保存" })).toHaveAttribute("download", "zoovoice.wav");
  await assertNoHorizontalOverflow(page);
  await captureIfRequested(page, testInfo, "success-light");

  await setTheme(page, "暗色");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await assertNoHorizontalOverflow(page);
  await captureIfRequested(page, testInfo, "success-dark");
  if (process.env.ZOOVOICE_CAPTURE_VISUALS === "1") {
    await page.getByRole("button", { name: "録音する" }).click();
    await expect(page.getByText("REC", { exact: true })).toBeVisible();
    await captureIfRequested(page, testInfo, "second-recording-dark");
    await page.waitForTimeout(650);
    await page.getByRole("button", { name: "録音を止める" }).click();
    await expect(page.getByText("声を聞き取り、動物を連想して合成しています。")).toBeVisible();
    await captureIfRequested(page, testInfo, "second-processing-dark");
    await expect(page.getByText("できあがりました。自動再生を開始します。")).toBeVisible();
  }
});

test("zoovoice counts up the elapsed seconds while composing", async ({ page }) => {
  await installZoovoiceApi(page, { composeDelayMilliseconds: 3_000 });
  await page.goto("/zoovoice");

  await page.getByRole("button", { name: "録音する" }).click();
  await expect(page.getByText("REC", { exact: true })).toBeVisible();
  await page.waitForTimeout(1_200);
  await page.getByRole("button", { name: "録音を止める" }).click();

  await expect(page.getByText("生成中", { exact: true })).toBeVisible();
  await expect(page.getByTestId("zoovoice-orb-time")).toHaveText("0:00");
  await expect(page.getByTestId("zoovoice-orb-time")).toHaveText("0:02", { timeout: 4_000 });
  await expect(page.getByText("できあがりました。自動再生を開始します。")).toBeVisible();
});

test("zoovoice shows the association reason for a far-fetched pick", async ({ page }, testInfo) => {
  await installZoovoiceApi(page, {
    transcript: "眠れない夜だった",
    selectedAnimal: { id: "sheep", label_ja: "羊" },
    associationReason: "眠れない夜は羊を数えるため",
  });
  await page.goto("/zoovoice");
  await recordOnce(page);

  await expect(page.getByText("眠れない夜は羊を数えるため", { exact: true })).toBeVisible();
  await expect(page.getByText("羊", { exact: true }).first()).toBeVisible();
  await captureIfRequested(page, testInfo, "reason-light");
});

test("zoovoice shows the sound credits with the modification notice", async ({ page }, testInfo) => {
  await installZoovoiceApi(page, {
    soundCredits: [
      { license: "CC BY 4.0", creator: "dobroide", source_url: "https://freesound.org/people/dobroide/sounds/17353" },
      { license: "CC0 1.0" },
    ],
  });
  await page.goto("/zoovoice");
  await recordOnce(page);

  const credits = page.getByTestId("zoovoice-sound-credits");
  await expect(credits).toContainText("無音除去・トリム・音量調整を実施");
  await expect(credits).toContainText("CC BY 4.0 / dobroide");
  await expect(credits).toContainText("CC0 1.0");
  await expect(credits.getByRole("link", { name: "出典" })).toHaveAttribute(
    "href",
    "https://freesound.org/people/dobroide/sounds/17353",
  );
  await assertNoHorizontalOverflow(page);
  await captureIfRequested(page, testInfo, "sound-credits-light");
});

test("zoovoice shows the association reason for a literal mention", async ({ page }, testInfo) => {
  await installZoovoiceApi(page, {
    transcript: "ぞうきんを絞る",
    selectedAnimal: { id: "elephant", label_ja: "象" },
    associationReason: "「ぞうきん」の語呂合わせでゾウを連想",
  });
  await page.goto("/zoovoice");
  await recordOnce(page);

  await expect(page.getByText("「ぞうきん」の語呂合わせでゾウを連想", { exact: true })).toBeVisible();
  await expect(page.getByText("象", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "結果を一時停止" })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await captureIfRequested(page, testInfo, "pun-success-light");

  await setTheme(page, "暗色");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByText("「ぞうきん」の語呂合わせでゾウを連想", { exact: true })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await captureIfRequested(page, testInfo, "pun-success-dark");
});

test("zoovoice cancels without compose and the following recording succeeds", async ({ page }) => {
  const composeBodies: string[] = [];
  await installZoovoiceApi(page, {
    turnstileRequired: true,
    onCompose: (body) => composeBodies.push(body),
  });
  await installTurnstileStub(page);
  await page.goto("/zoovoice");

  await page.getByRole("button", { name: "録音する" }).click();
  await expect(page.getByRole("button", { name: "録音をキャンセル" })).toBeVisible();
  await page.getByRole("button", { name: "録音をキャンセル" }).click();
  await expect(page.getByText("録音をキャンセルしました。音声は送信していません。")).toBeVisible();
  await expect(page.getByRole("button", { name: "録音する" })).toBeEnabled();
  expect(composeBodies).toHaveLength(0);

  await recordOnce(page);
  await expect(page.getByText("できあがりました。自動再生を開始します。")).toBeVisible();
  expect(composeBodies).toHaveLength(1);
  assertMultipartField(composeBodies[0], "turnstile_token", "browser-turnstile-token-1");
});

test("zoovoice resets Turnstile and uses a new token for the second recording", async ({ page }) => {
  const composeBodies: string[] = [];
  await installZoovoiceApi(page, {
    turnstileRequired: true,
    onCompose: (body) => composeBodies.push(body),
  });
  await installTurnstileStub(page);
  await page.goto("/zoovoice");

  await recordOnce(page);
  await expect.poll(() => composeBodies.length).toBe(1);
  await expect(page.getByRole("button", { name: "録音する" })).toBeEnabled();
  await recordOnce(page);
  await expect.poll(() => composeBodies.length).toBe(2);

  assertMultipartField(composeBodies[0], "turnstile_token", "browser-turnstile-token-1");
  assertMultipartField(composeBodies[1], "turnstile_token", "browser-turnstile-token-2");
});

test("zoovoice refreshes an expired Turnstile token before one automatic compose", async ({ page }) => {
  const composeBodies: string[] = [];
  await installZoovoiceApi(page, {
    turnstileRequired: true,
    onCompose: (body) => composeBodies.push(body),
  });
  await installTurnstileStub(page);
  await page.goto("/zoovoice");
  await expect(page.getByRole("button", { name: "録音する" })).toBeEnabled();

  await page.evaluate(() => {
    const state = (window as typeof window & { __zoovoiceTurnstileTest: { expire: () => void } }).__zoovoiceTurnstileTest;
    state.expire();
  });
  await expect(page.getByRole("button", { name: "録音する" })).toBeEnabled();
  await recordOnce(page);
  await expect.poll(() => composeBodies.length).toBe(1);
  assertMultipartField(composeBodies[0], "turnstile_token", "browser-turnstile-token-2");
});

test("zoovoice keeps the orb disabled while waiting for a Turnstile token", async ({ page }, testInfo) => {
  await installZoovoiceApi(page, { turnstileRequired: true });
  await installTurnstileStub(page, { autoSolve: false });
  await page.goto("/zoovoice");
  await recordOnce(page);

  await expect(page.getByTestId("zoovoice-status")).toHaveText("不正利用防止の確認を待っています。");
  await expect(page.getByRole("button", { name: "録音する" })).toBeDisabled();
  await captureIfRequested(page, testInfo, "token-waiting-light");
  await setTheme(page, "暗色");
  await captureIfRequested(page, testInfo, "token-waiting-dark");
});

test("zoovoice does not send a recording shorter than 500ms", async ({ page }) => {
  const composeBodies: string[] = [];
  await installZoovoiceApi(page, { onCompose: (body) => composeBodies.push(body) });
  await page.goto("/zoovoice");

  await page.getByRole("button", { name: "録音する" }).click();
  await page.waitForTimeout(100);
  await page.getByRole("button", { name: "録音を止める" }).click();

  await expect(page.getByText("録音が短すぎました。0.5秒以上話してください。")).toBeVisible();
  await expect(page.getByRole("button", { name: "録音する" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "もう一度生成" })).toHaveCount(0);
  expect(composeBodies).toHaveLength(0);
});

test("zoovoice retries a transient compose failure only after explicit retry", async ({ page }) => {
  const composeBodies: string[] = [];
  await installZoovoiceApi(page, {
    turnstileRequired: true,
    composeFailures: [{ status: 502, code: "zoovoice_backend_unavailable", message: "一時的に利用できません。" }],
    onCompose: (body) => composeBodies.push(body),
  });
  await installTurnstileStub(page);
  await page.goto("/zoovoice");
  await recordOnce(page);

  await expect(page.getByText("一時的に利用できません。")).toBeVisible();
  await expect(page.getByRole("button", { name: "もう一度生成" })).toBeVisible();
  await page.waitForTimeout(250);
  expect(composeBodies).toHaveLength(1);
  await page.locator("#zoovoice-intensity").fill("100");
  await page.getByRole("button", { name: "もう一度生成" }).click();
  await expect(page.getByText("できあがりました。自動再生を開始します。")).toBeVisible();
  expect(composeBodies).toHaveLength(2);
  assertMultipartField(composeBodies[0], "turnstile_token", "browser-turnstile-token-1");
  assertMultipartField(composeBodies[1], "turnstile_token", "browser-turnstile-token-2");
  assertMultipartField(composeBodies[1], "settings", JSON.stringify({ intensity: 100 }));
});

test("zoovoice keeps manual playback available when autoplay is rejected", async ({ page }) => {
  await installZoovoiceApi(page);
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = async () => {
      throw new DOMException("Autoplay blocked", "NotAllowedError");
    };
  });
  await page.goto("/zoovoice");
  await recordOnce(page);

  await expect(page.getByText("できあがりました。自動再生を開始します。")).toBeVisible();
  await expect(page.getByRole("button", { name: "結果を再生" })).toBeVisible();
  await expect(page.getByTestId("zoovoice-status")).not.toHaveClass(/text-red/);
});

test("zoovoice explains how to recover from microphone permission failure", async ({ page }, testInfo) => {
  await installZoovoiceApi(page);
  await page.goto("/zoovoice");
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    };
  });

  await page.getByRole("button", { name: "録音する" }).click();
  await expect(page.getByText("マイクを使用できません。ブラウザの権限を確認してください。")).toBeVisible();
  await expect(page.getByRole("button", { name: "録音する" })).toBeEnabled();
  await captureIfRequested(page, testInfo, "error-light");

  await page.getByLabel("配色設定").click();
  await page.getByRole("radio", { name: "暗色" }).click();
  await page.keyboard.press("Escape");
  await captureIfRequested(page, testInfo, "error-dark");
});

test("zoovoice requests one media stream while getUserMedia is pending", async ({ page }) => {
  await installZoovoiceApi(page);
  await page.goto("/zoovoice");
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __zoovoiceMediaRequests?: number;
      __zoovoiceRejectMedia?: () => void;
    };
    testWindow.__zoovoiceMediaRequests = 0;
    navigator.mediaDevices.getUserMedia = () => {
      testWindow.__zoovoiceMediaRequests = Number(testWindow.__zoovoiceMediaRequests || 0) + 1;
      return new Promise<MediaStream>((_resolve, reject) => {
        testWindow.__zoovoiceRejectMedia = () => reject(new DOMException("Permission denied", "NotAllowedError"));
      });
    };
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="録音する"]');
    button?.click();
    button?.click();
  });

  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __zoovoiceMediaRequests?: number }
  ).__zoovoiceMediaRequests)).toBe(1);
  await expect(page.getByRole("button", { name: "録音する" })).toBeDisabled();
  await page.evaluate(() => (
    window as typeof window & { __zoovoiceRejectMedia?: () => void }
  ).__zoovoiceRejectMedia?.());
  await expect(page.getByText("マイクを使用できません。ブラウザの権限を確認してください。")).toBeVisible();
  await expect(page.getByRole("button", { name: "録音する" })).toBeEnabled();
});

test("zoovoice releases a failed MediaRecorder setup before the next attempt", async ({ page }) => {
  await installZoovoiceApi(page);
  await page.goto("/zoovoice");
  await page.evaluate(() => {
    const testWindow = window as typeof window & { __zoovoiceMediaRequests?: number };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    testWindow.__zoovoiceMediaRequests = 0;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      testWindow.__zoovoiceMediaRequests = Number(testWindow.__zoovoiceMediaRequests || 0) + 1;
      return getUserMedia(constraints);
    };
    class FailingMediaRecorder {
      static isTypeSupported() { return true; }
      constructor() { throw new Error("recorder setup failed"); }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: FailingMediaRecorder });
  });

  await page.getByRole("button", { name: "録音する" }).click();
  await expect(page.getByText("マイクを使用できません。ブラウザの設定を確認してください。")).toBeVisible();
  await expect(page.getByRole("button", { name: "録音する" })).toBeEnabled();
  await page.getByRole("button", { name: "録音する" }).click();
  await expect.poll(() => page.evaluate(() => Number((
    window as typeof window & { __zoovoiceMediaRequests?: number }
  ).__zoovoiceMediaRequests || 0))).toBe(2);
});

test("zoovoice keeps the orb disabled while config is loading", async ({ page }) => {
  let releaseConfig = () => {};
  const configGate = new Promise<void>((resolve) => { releaseConfig = resolve; });
  await page.route("**/api/zoovoice/config", async (route) => {
    await configGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: true,
        turnstile_required: false,
        turnstile_site_key: "",
        audio_max_bytes: 10_000_000,
        origin_timeout_seconds: 30,
      }),
    });
  });
  await page.goto("/zoovoice");
  await expect(page.getByRole("button", { name: "録音する" })).toBeDisabled();
  releaseConfig();
  await expect(page.getByRole("button", { name: "録音する" })).toBeEnabled();
});

for (const preparationFailure of [
  { name: "disabled config", config: { enabled: false } },
  { name: "missing Turnstile site key", config: { turnstileRequired: true, siteKey: "" } },
]) {
  test(`zoovoice disables recording for ${preparationFailure.name}`, async ({ page }) => {
    await installZoovoiceApi(page, preparationFailure.config);
    await page.goto("/zoovoice");
    await expect(page.getByRole("button", { name: "録音する" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "もう一度生成" })).toHaveCount(0);
  });
}

test("zoovoice disables recording when the Turnstile script cannot load", async ({ page }) => {
  await installZoovoiceApi(page, { turnstileRequired: true });
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", (route) => route.abort());
  await page.goto("/zoovoice");
  await expect(page.getByText("不正利用防止の確認を準備できませんでした。ページを再読み込みしてください。").last()).toBeVisible();
  await expect(page.getByRole("button", { name: "録音する" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "もう一度生成" })).toHaveCount(0);
});

test("zoovoice auto-stops at 60 seconds and composes once", async ({ page }) => {
  const composeBodies: string[] = [];
  await installDeterministicRecorder(page);
  await page.clock.install({ time: new Date("2026-08-04T00:00:00Z") });
  await installZoovoiceApi(page, { onCompose: (body) => composeBodies.push(body) });
  await page.goto("/zoovoice");
  await page.getByRole("button", { name: "録音する" }).click();
  await expect(page.getByText("REC", { exact: true })).toBeVisible();
  await page.clock.runFor(650);
  await page.clock.runFor(59_350);

  await expect(page.getByRole("button", { name: "録音をキャンセル" })).toHaveCount(0);
  await expect(page.getByText("できあがりました。自動再生を開始します。")).toBeVisible();
  expect(composeBodies).toHaveLength(1);
});

test("zoovoice times out after 30 non-interactive verification seconds", async ({ page }) => {
  await installDeterministicRecorder(page);
  await page.clock.install({ time: new Date("2026-08-04T00:00:00Z") });
  await installZoovoiceApi(page, { turnstileRequired: true });
  await installTurnstileStub(page, { autoSolve: false });
  await page.goto("/zoovoice");
  await recordWithClock(page);
  await expect(page.getByTestId("zoovoice-status")).toHaveText("不正利用防止の確認を待っています。");
  await page.clock.runFor(1);
  await page.clock.runFor(30_000);

  await expect(page.getByText("不正利用防止の確認を完了できませんでした。ページを再読み込みするか、もう一度録音してください。")).toBeVisible();
  await expect(page.getByRole("button", { name: "録音する" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "もう一度生成" })).toBeVisible();
});

test("zoovoice pauses the 30 second budget during an interactive challenge", async ({ page }) => {
  await installDeterministicRecorder(page);
  await page.clock.install({ time: new Date("2026-08-04T00:00:00Z") });
  await installZoovoiceApi(page, { turnstileRequired: true });
  await installTurnstileStub(page, { autoSolve: false });
  await page.goto("/zoovoice");
  await recordWithClock(page);
  await turnstileAction(page, "beginInteractive");
  await page.clock.runFor(30_000);
  await expect(page.getByRole("button", { name: "もう一度生成" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "録音する" })).toBeDisabled();

  await turnstileAction(page, "endInteractive");
  await page.clock.runFor(30_000);
  await expect(page.getByText("不正利用防止の確認を完了できませんでした。ページを再読み込みするか、もう一度録音してください。")).toBeVisible();
});

test("zoovoice enforces a 120 second absolute interactive challenge limit", async ({ page }) => {
  await installDeterministicRecorder(page);
  await page.clock.install({ time: new Date("2026-08-04T00:00:00Z") });
  await installZoovoiceApi(page, { turnstileRequired: true });
  await installTurnstileStub(page, { autoSolve: false });
  await page.goto("/zoovoice");
  await recordWithClock(page);
  await turnstileAction(page, "beginInteractive");
  await page.clock.runFor(120_000);

  await expect(page.getByText("不正利用防止の確認を完了できませんでした。ページを再読み込みするか、もう一度録音してください。")).toBeVisible();
  await expect(page.getByRole("button", { name: "録音する" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "もう一度生成" })).toBeVisible();
});

test("zoovoice keeps initial and recorded Turnstile states in one desktop viewport", async ({ page }, testInfo) => {
  await installZoovoiceApi(page, { turnstileRequired: true });
  await installTurnstileStub(page);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/zoovoice");
    await assertWorkspaceInsideViewport(page, viewport.height);
    await assertNoHorizontalOverflow(page);
    await captureIfRequested(page, testInfo, `initial-${viewport.width}-light`);

    await recordOnce(page);
    await expect(page.getByText("できあがりました。自動再生を開始します。")).toBeVisible();
    await expect(page.getByRole("button", { name: "録音する" })).toBeEnabled();
    await assertWorkspaceInsideViewport(page, viewport.height);
    await assertVisibleControlsInsideViewport(page);
    await captureIfRequested(page, testInfo, `turnstile-${viewport.width}-light`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/zoovoice");
  await assertNoHorizontalOverflow(page);
  await recordOnce(page);
  await expect(page.getByText("できあがりました。自動再生を開始します。")).toBeVisible();
  await expect(page.getByRole("button", { name: "録音する" })).toBeEnabled();
  await assertNoHorizontalOverflow(page);
  await captureIfRequested(page, testInfo, "turnstile-390-light");
});

async function recordOnce(page: Page) {
  await page.getByRole("button", { name: "録音する" }).click();
  await page.waitForTimeout(650);
  await page.getByRole("button", { name: "録音を止める" }).click();
}

async function recordWithClock(page: Page) {
  await page.getByRole("button", { name: "録音する" }).click();
  await expect(page.getByText("REC", { exact: true })).toBeVisible();
  await page.clock.runFor(650);
  await page.getByRole("button", { name: "録音を止める" }).click();
}

async function installDeterministicRecorder(page: Page) {
  await page.addInitScript(() => {
    class TestMediaRecorder extends EventTarget {
      static isTypeSupported() { return true; }
      mimeType = "audio/webm";
      state: "inactive" | "recording" = "inactive";

      constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {
        super();
      }

      start() {
        this.state = "recording";
      }

      stop() {
        if (this.state !== "recording") return;
        this.state = "inactive";
        queueMicrotask(() => {
          this.dispatchEvent(new BlobEvent("dataavailable", {
            data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }),
          }));
          this.dispatchEvent(new Event("stop"));
        });
      }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: TestMediaRecorder });
    Object.defineProperty(window, "AudioContext", { configurable: true, value: undefined });
    Object.defineProperty(window, "webkitAudioContext", { configurable: true, value: undefined });
  });
}

async function turnstileAction(page: Page, action: "beginInteractive" | "endInteractive") {
  await page.evaluate((method) => {
    const state = (window as typeof window & {
      __zoovoiceTurnstileTest: {
        beginInteractive: () => void;
        endInteractive: () => void;
      };
    }).__zoovoiceTurnstileTest;
    state[method]();
  }, action);
}

async function assertWorkspaceInsideViewport(page: Page, viewportHeight: number) {
  const bounds = await page.getByTestId("zoovoice-workspace").boundingBox();
  expect(bounds).not.toBeNull();
  expect((bounds?.y || 0) + (bounds?.height || 0)).toBeLessThanOrEqual(viewportHeight);
}

async function installTurnstileStub(page: Page, options: { autoSolve?: boolean } = {}) {
  const autoSolve = options.autoSolve !== false;
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", async (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: `(() => {
      const autoSolve = ${JSON.stringify(autoSolve)};
      let tokenNumber = 0;
      let currentOptions;
      const solve = () => queueMicrotask(() => currentOptions.callback("browser-turnstile-token-" + (++tokenNumber)));
      window.__zoovoiceTurnstileTest = {
        renderCount: 0,
        resetCount: 0,
        expire() {
          currentOptions["expired-callback"]();
          solve();
        },
        beginInteractive() { currentOptions["before-interactive-callback"](); },
        endInteractive() { currentOptions["after-interactive-callback"](); },
        solve
      };
      window.turnstile={
      render(element, options) {
        currentOptions = options;
        window.__zoovoiceTurnstileTest.renderCount += 1;
        element.textContent = "Turnstile test widget";
        if (autoSolve) solve();
        return "test-widget";
      },
      reset() {
        window.__zoovoiceTurnstileTest.resetCount += 1;
        if (autoSolve) solve();
      },
      remove() {}
    };
    })();`,
  }));
}

async function turnstileState(page: Page, key: "renderCount" | "resetCount") {
  return page.evaluate((property) => {
    const state = (window as typeof window & {
      __zoovoiceTurnstileTest: { renderCount: number; resetCount: number };
    }).__zoovoiceTurnstileTest;
    return state[property];
  }, key);
}

async function installAutoplayObserver(page: Page) {
  await page.addInitScript(() => {
    const playingMedia = new WeakSet<HTMLMediaElement>();
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true,
      get() { return !playingMedia.has(this); },
    });
    (window as typeof window & { __zoovoicePlayAttempts?: number }).__zoovoicePlayAttempts = 0;
    HTMLMediaElement.prototype.play = async function play() {
      (window as typeof window & { __zoovoicePlayAttempts?: number }).__zoovoicePlayAttempts =
        Number((window as typeof window & { __zoovoicePlayAttempts?: number }).__zoovoicePlayAttempts || 0) + 1;
      playingMedia.add(this);
      this.dispatchEvent(new Event("play"));
    };
    HTMLMediaElement.prototype.pause = function pause() {
      playingMedia.delete(this);
      this.dispatchEvent(new Event("pause"));
    };
  });
}

async function installZoovoiceApi(
  page: Page,
  options: {
    turnstileRequired?: boolean;
    onCompose?: (body: string) => void;
    transcript?: string;
    selectedAnimal?: { id: string; label_ja: string };
    associationReason?: string;
    enabled?: boolean;
    siteKey?: string;
    composeFailures?: Array<{ status: number; code: string; message: string }>;
    composeDelayMilliseconds?: number;
    soundCredits?: Array<{ license: string; creator?: string; source_url?: string }>;
  } = {},
) {
  let composeRequest = 0;
  await page.route("**/api/zoovoice/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/zoovoice/config") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          enabled: options.enabled !== false,
          turnstile_required: options.turnstileRequired === true,
          turnstile_site_key: options.siteKey ?? (options.turnstileRequired ? "1x00000000000000000000AA" : ""),
          audio_max_bytes: 10_000_000,
          origin_timeout_seconds: options.turnstileRequired ? 90 : 30,
        }),
      });
    }
    if (path === "/api/zoovoice/compose") {
      options.onCompose?.(route.request().postData() || "");
      const failure = options.composeFailures?.[composeRequest];
      composeRequest += 1;
      if (failure) {
        return route.fulfill({
          status: failure.status,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: failure.code, message: failure.message } }),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, options.composeDelayMilliseconds ?? 120));
      const selectedAnimal = options.selectedAnimal || { id: "cat", label_ja: "猫" };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          audio: { format: "wav", base64: silentWav().toString("base64") },
          meta: {
            transcript: options.transcript || "猫が窓辺で眠っています",
            selected_animal: selectedAnimal,
            association_reason: options.associationReason || "猫が出てくるため",
            insertions: [
              { slot: "opening", species: selectedAnimal.id, at_seconds: 0 },
              { slot: "gaps", species: selectedAnimal.id, at_seconds: 1.2 },
              { slot: "ending", species: selectedAnimal.id, at_seconds: 2.4 },
            ],
            sound_credits: options.soundCredits ?? [
              { license: "CC BY 4.0", creator: "dobroide", source_url: "https://freesound.org/people/dobroide/sounds/17353" },
            ],
            input_duration_seconds: 2.4,
            output_duration_seconds: 4.7,
          },
        }),
      });
    }
    return route.continue();
  });
}

function assertMultipartField(body: string, name: string, value: string) {
  expect(body).toContain(`name="${name}"`);
  expect(body).toContain(value);
}

function silentWav(): Buffer {
  const sampleRate = 8000;
  const samples = sampleRate * 5;
  const buffer = Buffer.alloc(44 + samples);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples, 40);
  buffer.fill(128, 44);
  return buffer;
}

async function setTheme(page: Page, theme: "明色" | "暗色") {
  await page.getByLabel("配色設定").click();
  await page.getByRole("radio", { name: theme }).click();
  await page.keyboard.press("Escape");
}

async function captureIfRequested(page: Page, testInfo: TestInfo, state: string) {
  if (process.env.ZOOVOICE_CAPTURE_VISUALS !== "1") return;
  const outputDir = "tmp/playwright/zoovoice-visual";
  await mkdir(outputDir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  if (state.endsWith("-dark")) await page.waitForTimeout(200);
  await page.screenshot({
    path: `${outputDir}/${testInfo.project.name}-${state}.png`,
    fullPage: true,
  });
}
