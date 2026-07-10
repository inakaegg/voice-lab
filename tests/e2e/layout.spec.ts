import { expect, test, type Page } from "@playwright/test";

import { assertNoHorizontalOverflow, assertVisibleControlsInsideViewport, installUiApiFixtures } from "./fixtures";

const publicRoutes = [
  { path: "/", heading: "声から、", action: "スキットをつくる", actionRole: "link" },
  { path: "/speakloop", heading: "言いたいことで発音練習", action: "言いたいことを録音", actionRole: "button" },
  { path: "/skitvoice", heading: "声を選んで、会話をつくる", action: "音声を生成", actionRole: "button" },
] as const;

const adminRoutes = ["/admin", "/speakloop/admin", "/skitvoice/admin"];
const utilityRoutes = [
  { path: "/fun", heading: "はなしてください", action: "ろくおん" },
  { path: "/seed-vc", heading: "Seed-VC単体変換", action: "変換" },
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
      const themeControl = page.getByLabel("配色設定");
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

test("portal keeps both product actions within the initial viewport", async ({ page }) => {
  await page.goto("/");
  const viewportHeight = await page.evaluate(() => innerHeight);
  for (const label of ["スキットをつくる", "練習をはじめる"]) {
    const box = await page.getByText(label, { exact: false }).first().boundingBox();
    expect(box).not.toBeNull();
    expect((box?.y || 0) + (box?.height || 0)).toBeLessThanOrEqual(viewportHeight + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(viewportHeight + 1);
});

test("public theme menu is keyboard reachable and persists dark mode", async ({ page }) => {
  await page.goto("/speakloop");
  const settings = page.getByLabel("配色設定");
  await settings.focus();
  await expect(settings).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByRole("radio", { name: "暗色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
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

test("SpeakLoop switches from one task card to a responsive two-step flow", async ({ page }) => {
  await page.goto("/speakloop");
  const nativePanel = page.locator("#practice-native-panel");
  const promptPanel = page.locator("#practice-prompt-panel");
  const flow = page.locator(".react-practice-flow");
  await expect(promptPanel).toBeHidden();

  const [idleCard, flowBox] = await Promise.all([nativePanel.boundingBox(), flow.boundingBox()]);
  expect(idleCard).not.toBeNull();
  expect(flowBox).not.toBeNull();
  expect(idleCard?.width || 0).toBeGreaterThanOrEqual(Math.min((flowBox?.width || 0) * 0.7, 960));
  expect(Math.abs(((idleCard?.x || 0) + (idleCard?.width || 0) / 2) - ((flowBox?.x || 0) + (flowBox?.width || 0) / 2))).toBeLessThanOrEqual(4);

  await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("#practice-prompt-panel");
    const target = document.querySelector<HTMLElement>("#practice-target-text");
    if (panel) panel.hidden = false;
    if (target) target.textContent = "会議が終わったら、駅の近くにある静かな喫茶店で今後の予定を相談したいです。";
  });
  await expect(promptPanel).toBeVisible();
  const [nativeBox, promptBox] = await Promise.all([nativePanel.boundingBox(), promptPanel.boundingBox()]);
  const viewportWidth = page.viewportSize()?.width || 0;
  if (viewportWidth <= 820) {
    expect((promptBox?.y || 0)).toBeGreaterThan((nativeBox?.y || 0) + (nativeBox?.height || 0) - 2);
  } else {
    expect(Math.abs((nativeBox?.y || 0) - (promptBox?.y || 0))).toBeLessThanOrEqual(8);
  }
  await assertNoHorizontalOverflow(page);
});

test("SkitVoice follows the documented three, two, and one-column task order", async ({ page }) => {
  await page.goto("/skitvoice");
  const script = page.locator('[aria-label="台本"]');
  const voices = page.locator('[aria-label="参照音声"]');
  const generate = page.locator('[aria-label="生成"]');
  const [scriptBox, voicesBox, generateBox] = await Promise.all([
    script.boundingBox(),
    voices.boundingBox(),
    generate.boundingBox(),
  ]);
  for (const box of [scriptBox, voicesBox, generateBox]) expect(box).not.toBeNull();

  const viewportWidth = page.viewportSize()?.width || 0;
  if (viewportWidth >= 1120) {
    expect(Math.abs((scriptBox?.y || 0) - (voicesBox?.y || 0))).toBeLessThanOrEqual(8);
    expect(Math.abs((scriptBox?.y || 0) - (generateBox?.y || 0))).toBeLessThanOrEqual(8);
    expect(scriptBox?.x || 0).toBeLessThan(voicesBox?.x || 0);
    expect(voicesBox?.x || 0).toBeLessThan(generateBox?.x || 0);
  } else if (viewportWidth > 820) {
    expect(Math.abs((scriptBox?.y || 0) - (generateBox?.y || 0))).toBeLessThanOrEqual(8);
    expect(voicesBox?.y || 0).toBeGreaterThan((scriptBox?.y || 0) + (scriptBox?.height || 0) - 2);
  } else {
    expect(generateBox?.y || 0).toBeGreaterThan((scriptBox?.y || 0) + (scriptBox?.height || 0) - 2);
    expect(voicesBox?.y || 0).toBeGreaterThan((generateBox?.y || 0) + (generateBox?.height || 0) - 2);
  }
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

  await page.goto("/skitvoice/admin");
  const [adminScript, adminControls] = await Promise.all([
    page.getByRole("region", { name: "台本" }).boundingBox(),
    page.locator(".vibevoice-control-stack").boundingBox(),
  ]);
  if (viewportWidth > 820) {
    expect(Math.abs((adminScript?.y || 0) - (adminControls?.y || 0))).toBeLessThanOrEqual(8);
  } else {
    expect(adminControls?.y || 0).toBeGreaterThan((adminScript?.y || 0) + (adminScript?.height || 0) - 2);
  }
});

test("advanced admin settings stay optional and never hide the primary action", async ({ page }) => {
  await page.goto("/admin");
  const workbenchAdvanced = page.locator(".control-panel > .admin-advanced-group");
  await expect(workbenchAdvanced).not.toHaveAttribute("open", "");
  await expect(page.locator("#submit-button")).toBeVisible();

  await page.goto("/skitvoice/admin");
  const generationAdvanced = page.locator(".vibevoice-settings-panel.admin-advanced-group");
  const generateButton = page.locator("#vibevoice-generate-button");
  await expect(generationAdvanced).not.toHaveAttribute("open", "");
  await expect(generateButton).toBeVisible();
  if ((page.viewportSize()?.width || 0) > 820) {
    const initialGenerateBox = await generateButton.boundingBox();
    expect((initialGenerateBox?.y || 0) + (initialGenerateBox?.height || 0)).toBeLessThanOrEqual((page.viewportSize()?.height || 0) + 1);
  }

  await generationAdvanced.locator("summary").click();
  const [advancedBox, generateBox] = await Promise.all([
    generationAdvanced.boundingBox(),
    generateButton.boundingBox(),
  ]);
  expect(generateBox?.y || 0).toBeGreaterThanOrEqual((advancedBox?.y || 0) + (advancedBox?.height || 0) - 2);
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

for (const route of utilityRoutes) {
  test(`${route.path} keeps compatibility controls inside the Voice Lab layout`, async ({ page }) => {
    await page.goto(route.path);
    await expect(page.getByRole("link", { name: /Voice Lab/ }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: route.heading, level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: route.action, exact: true }).first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertVisibleControlsInsideViewport(page);
    if (route.path === "/seed-vc") {
      const details = page.locator(".utility-details");
      await expect(details).not.toHaveAttribute("open", "");
      await details.locator("summary").click();
      await assertNoHorizontalOverflow(page);
      await assertVisibleControlsInsideViewport(page);
    }
  });
}
