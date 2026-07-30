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

const animals = [
  { id: "cat", label_ja: "猫", variants: 1 },
  { id: "cow", label_ja: "牛", variants: 1 },
  { id: "dog", label_ja: "犬", variants: 1 },
  { id: "rooster", label_ja: "おんどり", variants: 1 },
  { id: "duck", label_ja: "カモ・アヒル", variants: 1 },
  { id: "elephant", label_ja: "ゾウ", variants: 1 },
  { id: "frog", label_ja: "カエル", variants: 1 },
  { id: "goat", label_ja: "ヤギ", variants: 1 },
  { id: "horse", label_ja: "馬", variants: 1 },
  { id: "lion", label_ja: "ライオン", variants: 1 },
  { id: "sheep", label_ja: "羊", variants: 1 },
  { id: "cricket", label_ja: "とても長い日本語でも崩れないコオロギ", variants: 1 },
];

test("zoovoice records composes and exposes a custom result player", async ({ page }, testInfo) => {
  await installZoovoiceApi(page);
  await page.goto("/zoovoice");

  await expect(page.getByRole("heading", { name: "声のすき間を、動物たちで彩る。" })).toBeVisible();
  await expect(page.getByText("現在は12種類のCC0音源で動いています。")).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await assertVisibleControlsInsideViewport(page);
  await captureIfRequested(page, testInfo, "initial-light");

  await page.getByLabel("ひとつの動物で統一").selectOption("cricket");
  await expect(page.getByLabel("ひとつの動物で統一")).toHaveValue("cricket");
  await assertNoHorizontalOverflow(page);
  await captureIfRequested(page, testInfo, "long-label-light");

  await page.getByRole("button", { name: "録音する" }).click();
  await expect(page.getByText("REC", { exact: true })).toBeVisible();
  await captureIfRequested(page, testInfo, "recording-light");
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "録音を止める" }).click();
  await expect(page.getByText("録音できました。動物とアニマル度を確認してください。")).toBeVisible();

  await page.getByRole("button", { name: "にわとり牧場" }).click();
  await page.getByRole("button", { name: "合成する" }).click();
  await expect(page.getByText("合成中…")).toBeVisible();
  await captureIfRequested(page, testInfo, "processing-light");
  await expect(page.getByText("できあがりました。再生して確認できます。")).toBeVisible();
  await page.getByRole("button", { name: "結果を再生" }).click();
  await expect(page.getByRole("button", { name: "結果を一時停止" })).toBeVisible();
  await page.getByRole("button", { name: "結果を一時停止" }).click();
  await expect(page.getByRole("link", { name: "WAVを保存" })).toHaveAttribute("download", "zoovoice.wav");
  await captureIfRequested(page, testInfo, "success-light");

  await page.getByLabel("配色設定").click();
  await page.getByRole("radio", { name: "暗色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Escape");
  await assertNoHorizontalOverflow(page);
  await assertVisibleControlsInsideViewport(page);
  await captureIfRequested(page, testInfo, "success-dark");
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
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Escape");
  await captureIfRequested(page, testInfo, "error-dark");
});

test("zoovoice keeps the unified selector aligned with the lucky arrangement", async ({ page }, testInfo) => {
  await installZoovoiceApi(page);
  await page.goto("/zoovoice");

  const unifiedSelector = page.getByLabel("ひとつの動物で統一");
  await page.getByRole("button", { name: "feel lucky?" }).click();

  await expect(unifiedSelector).toHaveValue("lucky");
  await captureIfRequested(page, testInfo, "lucky-light");

  await page.getByText("3つの場所を個別に選ぶ").click();
  await expect(page.getByLabel("はじめ")).toHaveValue("lucky");
  await expect(page.getByLabel("合間")).toHaveValue("lucky");
  await expect(page.getByLabel("おわり")).toHaveValue("lucky");

  await unifiedSelector.selectOption("cat");
  await expect(page.getByLabel("はじめ")).toHaveValue("cat");
  await expect(page.getByLabel("合間")).toHaveValue("cat");
  await expect(page.getByLabel("おわり")).toHaveValue("cat");
});

async function installZoovoiceApi(page: Page) {
  await page.route("**/api/zoovoice/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/zoovoice/animals") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ animals }),
      });
    }
    if (path === "/api/zoovoice/compose") {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          audio: { format: "wav", base64: silentWav().toString("base64") },
          meta: {
            insertions: [
              { slot: "opening", species: "rooster", at_seconds: 0 },
              { slot: "gaps", species: "cow", at_seconds: 1.2 },
              { slot: "ending", species: "rooster", at_seconds: 2.4 },
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
  await page.screenshot({
    path: `${outputDir}/${testInfo.project.name}-${state}.png`,
    fullPage: true,
  });
}
