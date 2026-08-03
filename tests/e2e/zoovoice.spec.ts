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
    onCompose: (body) => {
      composeBody = body;
    },
    transcript: "猫が窓辺でゆっくり眠っています。とても長い日本語でも結果欄からはみ出しません。",
  });
  await page.goto("/zoovoice");

  await expect(page.getByRole("heading", { name: "話すだけで、ぴったりの動物を。" })).toBeVisible();
  await expect(page.locator("select")).toHaveCount(0);
  await expect(page.getByText("feel lucky?", { exact: true })).toHaveCount(0);
  await page.locator("#zoovoice-intensity").fill("72");
  await page.getByRole("button", { name: "録音する" }).click();
  await expect(page.getByText("REC", { exact: true })).toBeVisible();
  await captureIfRequested(page, testInfo, "recording-light");
  await page.waitForTimeout(250);
  await page.getByRole("button", { name: "録音を止める" }).click();
  await expect(page.getByText("録音できました。生成できます。")).toBeVisible();

  await page.getByRole("button", { name: "生成する" }).click();
  await expect(page.getByText("連想・合成中…")).toBeVisible();
  await expect(page.getByText("声を聞き取り、動物を連想して合成しています。")).toBeVisible();
  await captureIfRequested(page, testInfo, "processing-light");
  await expect(page.getByText("できあがりました。再生して確認できます。")).toBeVisible();

  assertMultipartField(composeBody, "settings", JSON.stringify({ intensity: 72 }));
  expect(composeBody).not.toContain("arrangement");
  await expect(page.getByText("猫", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("猫が窓辺でゆっくり眠っています。とても長い日本語でも結果欄からはみ出しません。")).toBeVisible();
  await expect(page.getByText("動物名・鳴き声の直接言及")).toBeVisible();
  await page.getByRole("button", { name: "結果を再生" }).click();
  await expect(page.getByRole("button", { name: "結果を一時停止" })).toBeVisible();
  await page.getByRole("button", { name: "結果を一時停止" }).click();
  await expect(page.getByRole("link", { name: "WAVを保存" })).toHaveAttribute("download", "zoovoice.wav");
  await assertNoHorizontalOverflow(page);
  await captureIfRequested(page, testInfo, "success-light");

  await page.getByLabel("配色設定").click();
  await page.getByRole("radio", { name: "暗色" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await assertNoHorizontalOverflow(page);
  await captureIfRequested(page, testInfo, "success-dark");
});

test("zoovoice explains random fallback without inventing an evidence term", async ({ page }, testInfo) => {
  await installZoovoiceApi(page, {
    strategy: "random_fallback",
    selectedAnimal: { id: "frog", label_ja: "カエル" },
    evidenceTerm: null,
    fallbackReason: "no_direct_or_conceptnet_match",
  });
  await page.goto("/zoovoice");
  await recordOnce(page);
  await page.getByRole("button", { name: "生成する" }).click();

  await expect(page.getByText("関連する動物が見つからなかったため、ランダムに選びました。")).toBeVisible();
  await expect(page.getByText("該当なし", { exact: true })).toBeVisible();
  await expect(page.getByText("ランダム選択", { exact: true })).toBeVisible();
  await expect(page.getByText("カエル", { exact: true })).toBeVisible();
  await captureIfRequested(page, testInfo, "fallback-light");
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
    await expect(page.getByText("不正利用防止の確認が完了しました。")).toBeVisible();
    await expect(page.getByRole("button", { name: "生成する" })).toBeEnabled();
    await assertWorkspaceInsideViewport(page, viewport.height);
    await assertVisibleControlsInsideViewport(page);
    await captureIfRequested(page, testInfo, `turnstile-${viewport.width}-light`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/zoovoice");
  await assertNoHorizontalOverflow(page);
  await recordOnce(page);
  await expect(page.getByText("不正利用防止の確認が完了しました。")).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await captureIfRequested(page, testInfo, "turnstile-390-light");
});

async function recordOnce(page: Page) {
  await page.getByRole("button", { name: "録音する" }).click();
  await page.waitForTimeout(120);
  await page.getByRole("button", { name: "録音を止める" }).click();
}

async function assertWorkspaceInsideViewport(page: Page, viewportHeight: number) {
  const bounds = await page.getByTestId("zoovoice-workspace").boundingBox();
  expect(bounds).not.toBeNull();
  expect((bounds?.y || 0) + (bounds?.height || 0)).toBeLessThanOrEqual(viewportHeight);
}

async function installTurnstileStub(page: Page) {
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", async (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: `window.turnstile={
      render(element, options) {
        element.textContent = "Turnstile test widget";
        queueMicrotask(() => options.callback("browser-turnstile-token"));
        return "test-widget";
      },
      reset() {},
      remove() {}
    };`,
  }));
}

async function installZoovoiceApi(
  page: Page,
  options: {
    turnstileRequired?: boolean;
    onCompose?: (body: string) => void;
    transcript?: string;
    strategy?: "direct" | "conceptnet" | "random_fallback";
    selectedAnimal?: { id: string; label_ja: string };
    evidenceTerm?: string | null;
    fallbackReason?: "no_direct_or_conceptnet_match" | null;
  } = {},
) {
  await page.route("**/api/zoovoice/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/zoovoice/config") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          enabled: true,
          turnstile_required: options.turnstileRequired === true,
          turnstile_site_key: options.turnstileRequired ? "1x00000000000000000000AA" : "",
          audio_max_bytes: 10_000_000,
          origin_timeout_seconds: options.turnstileRequired ? 90 : 30,
        }),
      });
    }
    if (path === "/api/zoovoice/compose") {
      options.onCompose?.(route.request().postData() || "");
      await new Promise((resolve) => setTimeout(resolve, 120));
      const strategy = options.strategy || "direct";
      const selectedAnimal = options.selectedAnimal || { id: "cat", label_ja: "猫" };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          audio: { format: "wav", base64: silentWav().toString("base64") },
          meta: {
            transcript: options.transcript || "猫が窓辺で眠っています",
            selected_animal: selectedAnimal,
            evidence_term: options.evidenceTerm === undefined ? "猫" : options.evidenceTerm,
            selection_strategy: strategy,
            fallback_reason: options.fallbackReason === undefined ? null : options.fallbackReason,
            insertions: [
              { slot: "opening", species: selectedAnimal.id, at_seconds: 0 },
              { slot: "gaps", species: selectedAnimal.id, at_seconds: 1.2 },
              { slot: "ending", species: selectedAnimal.id, at_seconds: 2.4 },
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
