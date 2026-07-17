import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { installUiApiFixtures } from "./fixtures";

const routes = [
  { path: "/", slug: "portal" },
  { path: "/speakloop", slug: "speakloop" },
  { path: "/skitvoice", slug: "skitvoice" },
  { path: "/admin", slug: "admin" },
  { path: "/speakloop/admin", slug: "speakloop-admin" },
  { path: "/skitvoice/admin", slug: "skitvoice-admin" },
  { path: "/fun", slug: "fun" },
] as const;

test.beforeEach(async ({ page }) => {
  await installUiApiFixtures(page);
});

for (const theme of ["light", "dark"] as const) {
  for (const route of routes) {
    test(`capture ${route.path} in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript((selectedTheme) => localStorage.setItem("mo-speech-theme", selectedTheme), theme);
      await page.goto(route.path);
      await page.evaluate(() => document.fonts.ready);
      const outputDir = "tmp/playwright/visual-review";
      await mkdir(outputDir, { recursive: true });
      await page.screenshot({
        path: `${outputDir}/${testInfo.project.name}-${theme}-${route.slug}.png`,
        fullPage: true,
      });
    });
  }

  test(`capture SpeakLoop recording state in ${theme}`, async ({ page }, testInfo) => {
    await page.addInitScript((selectedTheme) => localStorage.setItem("mo-speech-theme", selectedTheme), theme);
    await page.goto("/speakloop");
    await page.locator("#practice-native-record-button").evaluate((element) => element.classList.add("is-recording"));
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#practice-native-record-button")!).backgroundColor === "rgb(199, 55, 47)");
    await page.evaluate(() => document.fonts.ready);
    const outputDir = "tmp/playwright/visual-review";
    await mkdir(outputDir, { recursive: true });
    await page.screenshot({
      path: `${outputDir}/${testInfo.project.name}-${theme}-speakloop-recording.png`,
      fullPage: true,
    });
  });

  test(`capture Cloudflare admin without local history in ${theme}`, async ({ page }, testInfo) => {
    await page.unroute("**/api/**");
    await installUiApiFixtures(page, { historyState: "disabled" });
    await page.goto("/speakloop/admin");
    await page.evaluate(() => document.fonts.ready);
    const outputDir = "tmp/playwright/visual-review";
    await mkdir(outputDir, { recursive: true });
    await page.screenshot({
      path: `${outputDir}/${testInfo.project.name}-${theme}-speakloop-admin-cloudflare.png`,
      fullPage: true,
    });
  });

  for (const state of ["authenticated", "api-error"] as const) {
    test(`capture public SkitVoice ${state} invariant in ${theme}`, async ({ page }, testInfo) => {
      await page.unroute("**/api/**");
      await page.route("**/api/**", async (route) => {
        if (state === "api-error") {
          return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "fixture error" }) });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ authenticated: true, is_admin: false, email: "viewer@example.com" }),
        });
      });
      await page.addInitScript((selectedTheme) => localStorage.setItem("mo-speech-theme", selectedTheme), theme);
      await page.goto("/skitvoice");
      await expect(page.getByRole("heading", { name: "研究機能は一般公開していません" })).toBeVisible();
      await expect(page.locator("#vibevoice-form, [data-public-sample-language]")).toHaveCount(0);
      const outputDir = "tmp/playwright/visual-review";
      await mkdir(outputDir, { recursive: true });
      await page.screenshot({
        path: `${outputDir}/${testInfo.project.name}-${theme}-skitvoice-${state}.png`,
        fullPage: true,
      });
    });
  }
}
