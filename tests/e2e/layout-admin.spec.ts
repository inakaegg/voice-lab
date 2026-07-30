import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

import { assertNoHorizontalOverflow, assertVisibleControlsInsideViewport, installUiApiFixtures } from "./fixtures";

const adminRoutes = ["/admin", "/speakloop/admin"];
const pageErrors = new WeakMap<Page, Error[]>();

test.beforeEach(async ({ page }) => {
  const errors: Error[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error));
  await installUiApiFixtures(page);
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) || [], "browser page errors").toEqual([]);
});

for (const route of adminRoutes) {
  test(`${route} exposes the Voice Lab admin hierarchy without clipped controls`, async ({ page }) => {
    await page.goto(route);
    await expect(page.getByText("Voice Lab", { exact: false }).first()).toBeVisible();
    await expect(page.locator(".admin-nav")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertVisibleControlsInsideViewport(page);
    const firstControl = page.locator("summary:visible, button:visible:not([disabled])").first();
    await firstControl.focus();
    await expect(firstControl).toBeFocused();
    const settings = page.locator(".admin-config-group");
    await settings.locator("summary").click();
    await expect(settings).toHaveAttribute("open", "");
    await assertNoHorizontalOverflow(page);
    await assertVisibleControlsInsideViewport(page);
  });
}

test("admin loads the public user list only after operations settings open", async ({ page }, testInfo) => {
  let publicUserRequests = 0;
  await page.route("**/api/public-users*", async (route) => {
    publicUserRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        users: [
          {
            email: "portfolio-owner@example.com",
            created_at: "2026-07-20T09:00:00.000Z",
            last_login_at: "2026-07-22T08:30:00.000Z",
            last_seen_at: "2026-07-22T08:35:00.000Z",
            is_admin: true,
            usage: { speakloop: 18, voice_conversion: 2 },
          },
          {
            email: "long-public-demo-user-address@example.com",
            created_at: "2026-07-21T10:00:00.000Z",
            last_login_at: "2026-07-22T07:45:00.000Z",
            last_seen_at: "",
            is_admin: false,
            usage: {},
          },
        ],
        limit: 2000,
        stored: 2,
      }),
    });
  });

  await page.goto("/admin");
  await expect.poll(() => publicUserRequests).toBe(0);

  const settings = page.locator(".admin-config-group");
  await settings.locator("summary").click();
  await expect(page.locator("[data-public-users-status]")).toHaveText("2件を表示しています。");
  await expect(page.locator("[data-public-users-body] > li")).toHaveCount(2);
  await expect.poll(() => publicUserRequests).toBe(1);

  await settings.locator("summary").click();
  await settings.locator("summary").click();
  await expect.poll(() => publicUserRequests).toBe(1);
  await assertNoHorizontalOverflow(page);
  await assertVisibleControlsInsideViewport(page);

  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({
      path: `tmp/playwright/visual-review/${testInfo.project.name}-public-users-lazy-load.png`,
      fullPage: true,
    });
  }
});

test("admin work areas use side-by-side desktop layouts and stack on mobile", async ({ page }) => {
  const viewportWidth = page.viewportSize()?.width || 0;

  await page.goto("/admin");
  const [control, result] = await Promise.all([
    page.locator(".control-panel").boundingBox(),
    page.locator(".result-panel").boundingBox(),
  ]);
  if (viewportWidth > 820) {
    expect(Math.abs((control?.y || 0) - (result?.y || 0))).toBeLessThanOrEqual(8);
    expect(control?.x || 0).toBeLessThan(result?.x || 0);
  } else {
    expect(result?.y || 0).toBeGreaterThan((control?.y || 0) + (control?.height || 0) - 2);
  }

  await page.goto("/speakloop/admin");
  const recording = page.getByRole("region", { name: "練習入力" });
  const model = page.getByRole("region", { name: "お手本音声" });
  const [recordingBox, modelBox] = await Promise.all([recording.boundingBox(), model.boundingBox()]);
  if (viewportWidth > 820) {
    expect(Math.abs((recordingBox?.y || 0) - (modelBox?.y || 0))).toBeLessThanOrEqual(8);
  } else {
    expect(modelBox?.y || 0).toBeGreaterThan((recordingBox?.y || 0) + (recordingBox?.height || 0) - 2);
  }

});

test("advanced admin settings stay optional and never hide the primary action", async ({ page }) => {
  await page.goto("/admin");
  const workbenchAdvanced = page.locator(".control-panel > .admin-advanced-group");
  await expect(workbenchAdvanced).not.toHaveAttribute("open", "");
  await expect(page.locator("#submit-button")).toBeVisible();
  await assertNoHorizontalOverflow(page);
});

test("long audio and practice histories wrap without breaking the admin viewport", async ({ page }) => {
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, { historyState: "long" });

  await page.goto("/admin");
  await expect(page.locator(".history-item").first()).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await assertVisibleControlsInsideViewport(page);

  await page.goto("/speakloop/admin");
  await expect(page.locator(".practice-history-item").first()).toBeVisible();
  await page.locator(".practice-history-diagnostics summary").click();
  await assertNoHorizontalOverflow(page);
  await assertVisibleControlsInsideViewport(page);
});

test("practice history API errors remain readable inside the admin layout", async ({ page }) => {
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, { historyState: "error" });
  await page.goto("/speakloop/admin");
  await expect(page.locator("#practice-history-status")).toContainText("履歴fixtureの読み込みに失敗しました");
  await assertNoHorizontalOverflow(page);
});

test("Cloudflare mode hides local-only history panels from shared admin pages", async ({ page }) => {
  await page.unroute("**/api/**");
  await installUiApiFixtures(page, { historyState: "disabled" });

  await page.goto("/admin");
  await expect(page.locator("[data-audio-history-panel]")).toBeHidden();

  await page.goto("/speakloop/admin");
  await expect(page.locator(".admin-config-group")).toHaveAttribute("open", "");
  await expect(page.locator("[data-practice-history-panel]")).toHaveCount(3);
  for (const panel of await page.locator("[data-practice-history-panel]").all()) {
    await expect(panel).toBeHidden();
  }
  await assertNoHorizontalOverflow(page);
});
