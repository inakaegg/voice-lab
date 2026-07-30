import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

import { assertNoHorizontalOverflow } from "./fixtures";

const runRealBackend = process.env.ZOOVOICE_REAL_BACKEND === "1";
const audioFixture = resolve("services/zoovoice/testdata/compose-input.wav");

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

test("MediaRecorder output can be composed by the real Go backend", async ({ page }) => {
  test.skip(!runRealBackend, "ローカルの Zoovoice Go backend を明示起動した場合だけ実行する");

  await page.goto("/zoovoice");
  await expect(page.getByRole("button", { name: "録音する" })).toBeEnabled();

  await page.getByRole("button", { name: "録音する" }).click();
  await expect(page.getByText("REC", { exact: true })).toBeVisible();
  await page.waitForTimeout(4_900);
  await page.getByRole("button", { name: "録音を止める" }).click();
  await expect(page.getByText("録音できました。動物とアニマル度を確認してください。")).toBeVisible();

  await page.getByRole("button", { name: "にわとり牧場" }).click();
  await page.getByRole("button", { name: "合成する" }).click();

  await expect(page.getByText("できあがりました。再生して確認できます。")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "結果を再生" }).click();
  await expect(page.getByRole("button", { name: "結果を一時停止" })).toBeVisible();
  await page.getByRole("button", { name: "結果を一時停止" }).click();
  await expect(page.getByRole("link", { name: "WAVを保存" })).toHaveAttribute(
    "download",
    "zoovoice.wav",
  );
  await assertNoHorizontalOverflow(page);
});
