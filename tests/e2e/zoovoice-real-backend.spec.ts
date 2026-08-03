import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

import { assertNoHorizontalOverflow } from "./fixtures";

const runRealBackend = process.env.ZOOVOICE_REAL_BACKEND === "1";
const audioFixture = resolve(
  process.env.ZOOVOICE_REAL_AUDIO_FIXTURE || "services/zoovoice/testdata/compose-input.wav",
);

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${audioFixture}`,
    ],
  },
});

test("MediaRecorder output can be composed through local Wrangler and the real Go backend", async ({ page }, testInfo) => {
  test.skip(!runRealBackend, "Zoovoice用のローカルWranglerとGo backendを明示起動した場合だけ実行する");

  await page.goto("/zoovoice");
  await expect(page.getByRole("button", { name: "録音する" })).toBeEnabled();

  await page.getByRole("button", { name: "録音する" }).click();
  await expect(page.getByText("REC", { exact: true })).toBeVisible();
  await page.waitForTimeout(4_900);
  await page.getByRole("button", { name: "録音を止める" }).click();
  await expect(page.getByText("録音できました。不正利用防止の確認後に生成できます。")).toBeVisible();

  await page.getByRole("button", { name: "生成する" }).click();

  await expect(page.getByText("できあがりました。再生して確認できます。")).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByText("選ばれた動物", { exact: true })).toBeVisible();
  await expect(page.getByText("聞き取った言葉", { exact: true })).toBeVisible();
  await expect(page.getByText("根拠語", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "結果を再生" }).click();
  await expect(page.getByRole("button", { name: "結果を一時停止" })).toBeVisible();
  await page.getByRole("button", { name: "結果を一時停止" }).click();
  const downloadLink = page.getByRole("link", { name: "WAVを保存" });
  await expect(downloadLink).toHaveAttribute(
    "download",
    "zoovoice.wav",
  );
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("zoovoice.wav");
  await download.saveAs(testInfo.outputPath("zoovoice.wav"));
  await assertNoHorizontalOverflow(page);
});
