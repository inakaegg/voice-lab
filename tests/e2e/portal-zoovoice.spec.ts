import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

import { assertNoHorizontalOverflow } from "./fixtures";

const config = {
  enabled: true,
  turnstile_required: true,
  turnstile_site_key: "1x00000000000000000000AA",
  audio_max_bytes: 10_000_000,
  origin_timeout_seconds: 90,
};

test("portal renders two equal products without overflow", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("mo-speech-theme", "light"));
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "アプリを選ぶ" });
  await expect(nav).toHaveAttribute("data-zoovoice-state", "shown");
  await expect(page.getByRole("link", { name: /01.*SpeakLoop/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /02.*Zoovoice/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /02.*Zoovoice/ }).getByText("β版", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /01.*SpeakLoop/ }).getByText("β版", { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-tech-note]")).toBeVisible();
  await expect(page.locator("[data-tech-note]")).toContainText("Google Cloud Run");
  await assertNoHorizontalOverflow(page);
  if (testInfo.project.name !== "mobile") {
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(page.viewportSize()?.height || 0);
  }

  await mkdir("tmp/portal-zoovoice-link", { recursive: true });
  await page.screenshot({ path: `tmp/portal-zoovoice-link/${testInfo.project.name}-light.png`, fullPage: true });
  await page.locator("html").evaluate((element) => element.setAttribute("data-theme", "dark"));
  const darkForeground = await page.locator("main").evaluate((element) => getComputedStyle(element).color);
  await expect(page.locator(".portal-product-link h2")).toHaveCount(2);
  await expect.poll(() => page.locator(".portal-product-link h2").evaluateAll((elements) => (
    elements.map((element) => getComputedStyle(element).color)
  ))).toEqual([darkForeground, darkForeground]);
  await page.screenshot({ path: `tmp/portal-zoovoice-link/${testInfo.project.name}-dark.png`, fullPage: true });
});

test("Zoovoice product link is keyboard reachable and navigates", async ({ page }) => {
  await page.goto("/");
  const link = page.getByRole("link", { name: /02.*Zoovoice/ });
  await expect(link).toBeVisible();
  for (let attempts = 0; attempts < 6 && !await link.evaluate((element) => element === document.activeElement); attempts += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/zoovoice\/?$/);
});

for (const scenario of [
  { name: "disabled", status: 200, body: { ...config, enabled: false } },
  { name: "non-2xx", status: 503, body: { error: { code: "unavailable", message: "unavailable" } } },
  { name: "non-json", status: 200, body: "not-json", contentType: "text/plain" },
  { name: "invalid schema", status: 200, body: { enabled: true } },
]) {
  test(`portal hides Zoovoice for ${scenario.name} config`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await page.route("**/api/zoovoice/config", (route) => route.fulfill({
      status: scenario.status,
      contentType: scenario.contentType || "application/json",
      body: typeof scenario.body === "string" ? scenario.body : JSON.stringify(scenario.body),
    }));
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "アプリを選ぶ" })).toHaveAttribute("data-zoovoice-state", "hidden");
    await expect(page.getByRole("link", { name: /Zoovoice/ })).toHaveCount(0);
  });
}

test("portal accepts additional public config fields", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/zoovoice/config", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ...config, future_field: "allowed" }),
  }));
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "アプリを選ぶ" })).toHaveAttribute("data-zoovoice-state", "shown");
});

test("portal waits for config and mounts the final product list once", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  let releaseConfig = () => {};
  const configGate = new Promise<void>((resolve) => { releaseConfig = resolve; });
  await page.route("**/api/zoovoice/config", async (route) => {
    await configGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(config) });
  });
  await page.goto("/");
  await expect(page.locator("#root")).toBeEmpty();
  await page.locator("#root").evaluate((root) => {
    (window as typeof window & { portalRootMutations?: number }).portalRootMutations = 0;
    new MutationObserver((records) => {
      const state = window as typeof window & { portalRootMutations?: number };
      state.portalRootMutations = (state.portalRootMutations || 0) + records.filter((record) => record.type === "childList").length;
    }).observe(root, { childList: true });
  });
  releaseConfig();
  await expect(page.getByRole("navigation", { name: "アプリを選ぶ" })).toHaveAttribute("data-zoovoice-state", "shown");
  await expect.poll(() => page.evaluate(() => (window as typeof window & { portalRootMutations?: number }).portalRootMutations)).toBe(1);
});

test("portal fails closed after the config timeout", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/zoovoice/config", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(config) }).catch(() => {});
  });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "アプリを選ぶ" })).toHaveAttribute("data-zoovoice-state", "hidden", { timeout: 5_000 });
  await expect(page.getByRole("link", { name: /Zoovoice/ })).toHaveCount(0);
});
