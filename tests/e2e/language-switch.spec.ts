import { expect, test } from "@playwright/test";

import { installUiApiFixtures } from "./fixtures";

const zoovoiceConfig = {
  enabled: true,
  turnstile_required: false,
  turnstile_site_key: "",
  audio_max_bytes: 10_000_000,
  origin_timeout_seconds: 90,
};

// 表示言語の初期値は navigator.language から決める。playwright.config.ts は既存テストの
// 前提を守るため ja-JP に固定しているので、英語判定の経路はこのspecだけロケールを上書きして確かめる。
test.describe("English display language", () => {
  test.use({ locale: "en-US" });

  test.beforeEach(async ({ page }) => {
    await installUiApiFixtures(page);
    await page.route("**/api/zoovoice/config", (route) => route.fulfill({ json: zoovoiceConfig }));
  });

  test("an English browser gets the English shell and can switch back to Japanese", async ({ page }) => {
    await page.goto("/zoovoice");

    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByText("Built with")).toBeVisible();
    await expect(page.getByRole("link", { name: "Privacy policy" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to Voice Lab" })).toBeVisible();

    await page.getByLabel("Display language settings").click();
    await page.getByRole("radio", { name: "日本語" }).click();

    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page.getByText("使用技術")).toBeVisible();
    await expect(page.getByRole("link", { name: "プライバシーポリシー" })).toBeVisible();

    // 選択はlocalStorageに残るので、英語ブラウザでも再読み込み後は日本語のままになる。
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page.getByText("使用技術")).toBeVisible();
  });
});
