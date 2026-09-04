import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

import { assertNoHorizontalOverflow, assertVisibleControlsInsideViewport, installUiApiFixtures } from "./fixtures";

const publicRoutes = [
  { path: "/", heading: "声から、", action: "練習をはじめる", actionRole: "link" },
  { path: "/speakloop", heading: "言いたいことで発音練習", action: "言いたいことを録音", actionRole: "button" },
] as const;

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

for (const route of publicRoutes) {
  test(`${route.path} keeps the primary task inside a stable responsive layout`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("mo-speech-theme", "light"));
    await page.goto(route.path);
    await expect(page.getByRole("heading", { name: new RegExp(route.heading), level: 1 })).toBeVisible();
    await expect(page.getByRole(route.actionRole, { name: new RegExp(route.action) }).first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertVisibleControlsInsideViewport(page);
    if ((page.viewportSize()?.width || 0) <= 820) {
      const themeControl = page.getByLabel("表示設定");
      const themeBox = await themeControl.boundingBox();
      expect(themeBox?.width || 0).toBeGreaterThanOrEqual(40);
      expect((themeBox?.x || 0) + (themeBox?.width || 0)).toBeGreaterThanOrEqual((page.viewportSize()?.width || 0) - 24);
      if (route.path !== "/") {
        const backBox = await page.locator(".react-back-link").boundingBox();
        expect(backBox?.width || 0).toBeGreaterThanOrEqual(40);
        expect(backBox?.height || 0).toBeGreaterThanOrEqual(40);
      }
    }
  });
}

test("SpeakLoop keeps the own-voice tooltip inside the viewport for zh-CN", async ({ page }) => {
  await page.goto("/speakloop");
  await page.locator("#practice-target-language-select").selectOption("zh-CN");
  await expect(page.locator("#practice-chinese-script-setting")).toBeVisible();
  await page.locator("#practice-own-voice-toggle").focus();
  const tooltip = page.locator("#practice-own-voice-tooltip");
  await expect(tooltip).toBeVisible();
  const tooltipBox = await tooltip.boundingBox();
  const viewportWidth = page.viewportSize()?.width || 0;
  expect(tooltipBox).not.toBeNull();
  expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
  expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(viewportWidth + 1);
});

test("SpeakLoop keeps the shared privacy notice at the workflow bottom left", async ({ page }) => {
  await page.goto("/speakloop");
  const [contentBox, workflowBox, privacyBox] = await Promise.all([
    page.locator(".react-intro-grid").boundingBox(),
    page.locator(".react-practice-flow").boundingBox(),
    page.locator("[data-public-privacy-notice]").boundingBox(),
  ]);

  expect(contentBox).not.toBeNull();
  expect(workflowBox).not.toBeNull();
  expect(privacyBox).not.toBeNull();
  expect(privacyBox?.y || 0).toBeGreaterThanOrEqual((workflowBox?.y || 0) + (workflowBox?.height || 0) - 1);
  expect(Math.abs((privacyBox?.x || 0) - (contentBox?.x || 0))).toBeLessThanOrEqual(1);

  const { viewportHeight, documentHeight } = await page.evaluate(() => ({
    viewportHeight: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
  }));
  if (documentHeight <= viewportHeight + 1) {
    expect((privacyBox?.y || 0) + (privacyBox?.height || 0)).toBeGreaterThanOrEqual(viewportHeight - 40);
  }
});

test("privacy policy stays readable and links back to Voice Lab", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "プライバシーポリシー", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /Voice Lab/ })).toHaveAttribute("href", "/");
  await expect(page.getByRole("heading", { name: "保持期間" })).toBeVisible();
  await expect(page.getByText(/日ごとの利用回数は、利用日から3日以内に削除/)).toBeVisible();
  await expect(page.getByText(/操作ログは、約90日間保存/)).toBeVisible();
  await expect(page.locator('a[href*="security/advisories/new"]')).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
  await assertVisibleControlsInsideViewport(page);
});

test("SpeakLoop shows own-voice details from the control hover and focus without duplicate disclosure", async ({ page }, testInfo) => {
  await page.goto("/speakloop");
  const setting = page.locator(".practice-own-voice-setting");
  const toggle = page.locator("#practice-own-voice-toggle");
  const tooltip = page.locator("#practice-own-voice-tooltip");
  const workflowBoxBefore = await page.locator(".react-practice-flow").boundingBox();

  await expect(tooltip).toBeHidden();
  await expect(page.locator(".practice-own-voice-disclosure")).toHaveCount(0);
  await expect(page.getByText(/外部サービスで処理され、Voice Labの履歴には保存されません/)).toHaveCount(1);
  if ((page.viewportSize()?.width || 0) > 820) {
    await setting.hover();
    await expect(tooltip).toBeVisible();
    await page.locator(".practice-card-copy").first().hover();
    await expect(tooltip).toBeHidden();
  }

  await toggle.focus();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText("「自分の声」は、同じセッションであなたが最初に録音した音声からAI生成音声を作ります。");
  await assertNoHorizontalOverflow(page);
  expect(await page.locator(".react-practice-flow").boundingBox()).toEqual(workflowBoxBefore);
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-speakloop-own-voice-help.png`, fullPage: true });
    await page.locator("html").evaluate((element) => element.setAttribute("data-theme", "dark"));
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-dark-speakloop-own-voice-help.png`, fullPage: true });
    await page.locator("html").evaluate((element) => element.setAttribute("data-theme", "light"));
  }

  await page.getByRole("heading", { name: "言いたいことで発音練習" }).click();
  await expect(tooltip).toBeHidden();
  await toggle.focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(tooltip).toBeHidden();
});

test("portal keeps the SpeakLoop action within the initial viewport", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "アプリを選ぶ" })).toHaveAttribute("data-zoovoice-state", "hidden");
  const viewportHeight = await page.evaluate(() => innerHeight);
  const box = await page.getByText("練習をはじめる", { exact: false }).first().boundingBox();
  expect(box).not.toBeNull();
  expect((box?.y || 0) + (box?.height || 0)).toBeLessThanOrEqual(viewportHeight + 1);
  await expect(page.getByText("SkitVoice", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Zoovoice", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(viewportHeight + 1);
});

test("portal GitHub link reveals its video guidance on hover and keyboard focus", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("mo-speech-theme")) localStorage.setItem("mo-speech-theme", "light");
  });
  await page.goto("/");
  const link = page.getByRole("link", { name: "GitHubリポジトリ" });
  const tooltip = page.locator("#portal-github-tooltip");
  const marks = link.locator("img.portal-github-mark");

  await expect(link).toHaveAttribute("href", "https://github.com/inakaegg/voice-lab");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(marks).toHaveCount(2);
  expect(await marks.evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth === 98))).toBe(true);
  await expect(tooltip).toBeHidden();

  if ((page.viewportSize()?.width || 0) > 820) {
    await link.hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText("実際の動作を動画で確認できます");
    await page.getByRole("heading", { name: /声から/ }).hover();
    await expect(tooltip).toBeHidden();
  }

  await link.focus();
  await expect(link).toBeFocused();
  await expect(tooltip).toBeVisible();
  const tooltipBox = await tooltip.boundingBox();
  expect(tooltipBox).not.toBeNull();
  expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
  expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual((page.viewportSize()?.width || 0) + 1);
  await assertNoHorizontalOverflow(page);
  await assertVisibleControlsInsideViewport(page);

  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    const outputDir = "tmp/playwright/portal-github-link";
    await mkdir(outputDir, { recursive: true });
    await expect(tooltip).toHaveCSS("opacity", "1");
    await page.screenshot({ path: `${outputDir}/${testInfo.project.name}-light-focus.png`, fullPage: true });
    await page.evaluate(() => localStorage.setItem("mo-speech-theme", "dark"));
    await page.reload();
    await link.focus();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveCSS("opacity", "1");
    await page.screenshot({ path: `${outputDir}/${testInfo.project.name}-dark-focus.png`, fullPage: true });
  }
});

// SpeakLoopのGitHub linkはデモ動画へ寄せた変種で、吹き出しを常時表示にする。
test("SpeakLoop GitHub link shows its note at all times and opens the demo videos", async ({ context, page }, testInfo) => {
  await context.route(/README\.ja\.md/, async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<title>Voice Lab demo videos</title>" });
  });
  await page.addInitScript(() => {
    if (!localStorage.getItem("mo-speech-theme")) localStorage.setItem("mo-speech-theme", "light");
  });
  await page.goto("/speakloop");
  const link = page.getByRole("link", { name: "GitHubのデモ動画" });
  const tooltip = page.locator("#speakloop-github-tooltip");
  const marks = link.locator("img.portal-github-mark");

  await expect(link).toHaveAttribute("href", "https://github.com/inakaegg/voice-lab/blob/main/README.ja.md#デモ動画");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(marks).toHaveCount(2);
  // hoverもfocusもしていない初期状態から見えていることが、この画面の契約である。
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText("実際の動作をデモ動画で確認できます");

  await link.focus();
  await expect(link).toBeFocused();
  await expect(tooltip).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await assertVisibleControlsInsideViewport(page);

  const [popup] = await Promise.all([context.waitForEvent("page"), link.click()]);
  await expect(popup).toHaveTitle("Voice Lab demo videos");
  await popup.close();

  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    const outputDir = "tmp/playwright/speakloop-github-link";
    await mkdir(outputDir, { recursive: true });
    await link.focus();
    await page.screenshot({ path: `${outputDir}/${testInfo.project.name}-light-focus.png`, fullPage: true });
    await page.evaluate(() => localStorage.setItem("mo-speech-theme", "dark"));
    await page.reload();
    await link.focus();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(tooltip).toBeVisible();
    await page.screenshot({ path: `${outputDir}/${testInfo.project.name}-dark-focus.png`, fullPage: true });
  }
});

test("public theme menu is keyboard reachable and persists dark mode", async ({ page }) => {
  await page.goto("/speakloop");
  const settings = page.getByLabel("表示設定");
  await settings.focus();
  await expect(settings).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByRole("radio", { name: "暗色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("public theme menu closes on outside click and Escape", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("mo-speech-theme", "light"));
  await page.goto("/speakloop");
  const settings = page.locator(".react-theme-settings");
  const summary = page.getByLabel("表示設定");

  await summary.click();
  await expect(settings).toHaveAttribute("open", "");
  if (process.env.PLAYWRIGHT_VISUAL_REVIEW === "1") {
    await mkdir("tmp/playwright/visual-review", { recursive: true });
    await page.screenshot({ path: `tmp/playwright/visual-review/${testInfo.project.name}-light-theme-menu-open.png`, fullPage: true });
  }
  await page.getByRole("heading", { name: "言いたいことで発音練習" }).click();
  await expect(settings).not.toHaveAttribute("open", "");

  await summary.click();
  await expect(settings).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(settings).not.toHaveAttribute("open", "");
  await expect(summary).toBeFocused();
});

test("system theme follows the browser color scheme on every public route", async ({ page }) => {
  for (const route of publicRoutes) {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => localStorage.setItem("mo-speech-theme", "system"));
    await page.goto(route.path);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  }
});

test("SpeakLoop defaults to English and normalizes a saved Japanese target", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mo:practice-settings", JSON.stringify({ target_language: "ja-JP" }));
  });
  await page.goto("/speakloop");
  const language = page.locator("#practice-target-language-select");
  await expect(language.locator("option")).toHaveCount(2);
  await expect(language.locator("option").nth(0)).toHaveAttribute("value", "en-US");
  await expect(language.locator("option").nth(1)).toHaveAttribute("value", "zh-CN");
  await expect(language).toHaveValue("en-US");
});
