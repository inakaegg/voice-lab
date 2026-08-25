import { expect, test } from "@playwright/test";

import { installUiApiFixtures } from "./fixtures";

// 表示言語を効かせるのは辞書化を終えた画面だけ。まだ移していない画面で共通部分だけ英語になると
// 利用者には壊れて見えるため、日本語へ固定している。その固定が効いていることを押さえる。
test.describe("pages that are not localized yet stay Japanese", () => {
  test.use({ locale: "en-US" });

  test.beforeEach(async ({ page }) => {
    await installUiApiFixtures(page);
  });

  test("an English browser still gets Japanese on the portal", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    // 辞書化していない画面の設定メニューには、表示言語のセクションを出さない。
    await page.getByLabel("表示設定").click();
    await expect(page.getByRole("radiogroup", { name: "表示言語" })).toHaveCount(0);
    await expect(page.getByRole("radiogroup", { name: "配色" })).toBeVisible();
  });

  test("an English choice saved on another page does not leak into the portal", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("voice-lab-locale", "en"));
    await page.goto("/");

    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  });

  test("the privacy page stays Japanese for an English browser", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("voice-lab-locale", "en"));
    await page.goto("/privacy");

    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    // portal と同じ契約で見る。設定メニュー自体は残り、言語セクションだけが出ない。
    await page.getByLabel("表示設定").click();
    await expect(page.getByRole("radiogroup", { name: "表示言語" })).toHaveCount(0);
    await expect(page.getByRole("radiogroup", { name: "配色" })).toBeVisible();
  });
});
