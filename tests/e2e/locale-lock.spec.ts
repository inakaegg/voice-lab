import { expect, test } from "@playwright/test";

import { installUiApiFixtures } from "./fixtures";

// 表示言語を効かせるのは辞書化を終えた画面だけ。まだ移していない画面で共通部分だけ英語になると
// 利用者には壊れて見えるため、日本語へ固定している。その固定が効いていることを押さえる。
test.describe("pages that are not localized yet stay Japanese", () => {
  test.use({ locale: "en-US" });

  test.beforeEach(async ({ page }) => {
    await installUiApiFixtures(page);
  });

  test("an English browser still gets Japanese on SpeakLoop", async ({ page }) => {
    await page.goto("/speakloop");

    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page.getByText("使用技術")).toBeVisible();
    await expect(page.getByRole("link", { name: "プライバシーポリシー" })).toBeVisible();
    // 辞書化していない画面には切り替えの入口を出さない。
    await expect(page.getByLabel("表示言語の設定")).toHaveCount(0);
  });

  test("an English choice saved on another page does not leak in", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("voice-lab-locale", "en"));
    await page.goto("/speakloop");

    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page.getByText("使用技術")).toBeVisible();
  });

  test("the portal stays Japanese for an English browser", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("voice-lab-locale", "en"));
    await page.goto("/");

    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  });
});
