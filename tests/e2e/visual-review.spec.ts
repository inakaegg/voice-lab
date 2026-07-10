import { mkdir } from "node:fs/promises";

import { test } from "@playwright/test";

import { installUiApiFixtures } from "./fixtures";

const routes = [
  { path: "/", slug: "portal" },
  { path: "/speakloop", slug: "speakloop" },
  { path: "/skitvoice", slug: "skitvoice" },
  { path: "/admin", slug: "admin" },
  { path: "/speakloop/admin", slug: "speakloop-admin" },
  { path: "/skitvoice/admin", slug: "skitvoice-admin" },
  { path: "/fun", slug: "fun" },
  { path: "/seed-vc", slug: "seed-vc" },
] as const;

test.beforeEach(async ({ page }) => {
  await installUiApiFixtures(page);
  await page.addInitScript(() => localStorage.setItem("mo-speech-theme", "light"));
});

for (const route of routes) {
  test(`capture ${route.path}`, async ({ page }, testInfo) => {
    await page.goto(route.path);
    await page.evaluate(() => document.fonts.ready);
    const outputDir = "tmp/playwright/visual-review";
    await mkdir(outputDir, { recursive: true });
    await page.screenshot({
      path: `${outputDir}/${testInfo.project.name}-${route.slug}.png`,
      fullPage: true,
    });
  });
}
