import { expect, test } from "@playwright/test";

import { installUiApiFixtures } from "./fixtures";

// portal と privacy も辞書へ移し終えたので、表示言語が効く。どちらもReactで完結するため
// 切り替えでページを読み直さない(speakloopとの違い)。
test.describe("portal and privacy follow the display language", () => {
  test.use({ locale: "en-US" });

  test.beforeEach(async ({ page }) => {
    await installUiApiFixtures(page);
  });

  test("an English browser gets the English portal and can switch to Japanese", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page).toHaveTitle(/experiences of language, from your voice/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("From your voice,");
    await expect(page.getByRole("link", { name: /Start practicing/ })).toBeVisible();

    await page.getByLabel("Display settings").click();
    await expect(page.getByRole("radiogroup", { name: "Display language" })).toBeVisible();
    await page.getByRole("radio", { name: "日本語" }).click();

    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page).toHaveTitle(/声から、ことばの体験をつくる。/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("声から、");
    await expect(page.getByRole("link", { name: /練習をはじめる/ })).toBeVisible();
  });

  test("the privacy policy shows the source-of-record notice in English only", async ({ page }) => {
    await page.goto("/privacy");

    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page).toHaveTitle(/Privacy policy/);
    await expect(page.getByRole("heading", { name: "Privacy policy", level: 1 })).toBeVisible();
    // 正本は日本語。英語で読む人にだけ、これが翻訳であることを伝える。
    const notice = page.getByText("This is an English translation of the Japanese privacy policy.");
    await expect(notice).toBeVisible();
    await expect(page.getByText("Operation logs are kept for about 90 days.")).toBeVisible();

    await page.getByLabel("Display settings").click();
    await page.getByRole("radio", { name: "日本語" }).click();

    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page.getByRole("heading", { name: "プライバシーポリシー", level: 1 })).toBeVisible();
    // 日本語ページは正本そのものなので、翻訳の断り書きは出さない。
    await expect(notice).toHaveCount(0);
    await expect(page.getByText("操作ログは、約90日間保存します。")).toBeVisible();
  });
});
