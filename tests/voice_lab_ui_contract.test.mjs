import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [pkgText, pyproject, api, viteConfig, ci, portalHtml, privacyHtml, speakloopHtml, skitvoiceHtml, adminHtml, practiceAdminHtml, skitvoiceAdminHtml, funHtml] = await Promise.all([
  read("package.json"),
  read("pyproject.toml"),
  read("src/mo_speech/api.py"),
  read("apps/web/vite.config.ts"),
  read(".github/workflows/ci.yml"),
  read("apps/web/portal.html"),
  read("apps/web/privacy.html"),
  read("apps/web/speakloop.html"),
  read("apps/web/skitvoice.html"),
  read("src/mo_speech/web/index.html"),
  read("src/mo_speech/web/practice_admin.html"),
  read("src/mo_speech/web/vibevoice.html"),
  read("src/mo_speech/web/user.html"),
]);
const portalStyles = await read("apps/web/src/portal/styles.css");

test("Voice Lab is the application and package brand without renaming the Python namespace", () => {
  assert.equal(JSON.parse(pkgText).name, "voice-lab");
  assert.match(pyproject, /^name = "voice-lab"$/m);
  assert.match(pyproject, /description = "Voice Lab/);
  assert.match(api, /FastAPI\(title="Voice Lab"\)/);
  assert.match(pyproject, /\[tool\.setuptools\.package-data\]\s+mo_speech\s*=/);
  assert.match(pyproject, /"web\/react\/\*\.html"/);
  assert.match(pyproject, /"web\/react\/assets\/\*\.css"/);
  assert.match(pyproject, /"web\/react\/assets\/\*\.js"/);
  assert.match(api, /logging\.getLogger\("mo_speech"\)/);
});

test("all active pages use the built Voice Lab style assets instead of direct legacy CSS", () => {
  assert.doesNotMatch(portalHtml, /\/static\/styles\.css/);
  for (const html of [speakloopHtml, skitvoiceHtml, adminHtml, practiceAdminHtml, skitvoiceAdminHtml, funHtml]) {
    assert.doesNotMatch(html, /\/static\/styles\.css/);
  }
  assert.match(viteConfig, /appStyles/);
  assert.match(speakloopHtml, /src\/styles\/app\.css/);
  assert.match(skitvoiceHtml, /src\/styles\/app\.css/);
  for (const html of [adminHtml, practiceAdminHtml, skitvoiceAdminHtml, funHtml]) {
    assert.match(html, /\/react\/assets\/app\.css/);
  }
});

test("all active pages use the shared multi-size Voice Lab favicon", async () => {
  for (const html of [
    portalHtml,
    privacyHtml,
    speakloopHtml,
    skitvoiceHtml,
    adminHtml,
    practiceAdminHtml,
    skitvoiceAdminHtml,
    funHtml,
  ]) {
    assert.match(html, /<link rel="icon" href="\/react\/favicon\.ico" sizes="any" \/>/);
  }

  const favicon = await readFile(new URL("../apps/web/public/favicon.ico", import.meta.url));
  assert.equal(favicon.readUInt16LE(0), 0);
  assert.equal(favicon.readUInt16LE(2), 1);
  const imageCount = favicon.readUInt16LE(4);
  const sizes = new Set();
  for (let index = 0; index < imageCount; index += 1) {
    const entryOffset = 6 + index * 16;
    const width = favicon[entryOffset] || 256;
    const height = favicon[entryOffset + 1] || 256;
    assert.equal(width, height);
    sizes.add(width);
  }
  for (const expectedSize of [16, 32, 48, 256]) {
    assert.ok(sizes.has(expectedSize), `favicon must include ${expectedSize}x${expectedSize}`);
  }

  const builtFavicon = await readFile(new URL("../src/mo_speech/web/react/favicon.ico", import.meta.url));
  assert.deepEqual(builtFavicon, favicon);
});

test("all admin pages expose a consistent Voice Lab admin shell and navigation", () => {
  for (const html of [adminHtml, practiceAdminHtml, skitvoiceAdminHtml]) {
    assert.match(html, /Voice Lab/);
    assert.match(html, /voice-lab-admin-body/);
    assert.match(html, /admin-nav/);
    assert.match(html, /href="\/admin"/);
    assert.match(html, /href="\/speakloop\/admin"/);
    assert.match(html, /href="\/skitvoice\/admin"/);
    assert.match(html, /href="\/fun">実験画面<\/a>/);
  }
});

test("Playwright layout tests are wired into npm and CI", () => {
  const pkg = JSON.parse(pkgText);
  assert.ok(pkg.devDependencies?.["@playwright/test"]);
  assert.equal(pkg.scripts?.["test:e2e"], "playwright test");
  assert.match(ci, /ui-e2e:/);
  assert.match(ci, /playwright install --with-deps chromium/);
  assert.match(ci, /npm run test:e2e/);
  assert.match(ci, /pip wheel \. --no-deps/);
  assert.match(ci, /scripts\/verify_wheel_assets\.py/);
});

test("portal product accents distinguish creation from learning", () => {
  assert.match(portalStyles, /\.portal-product-link-skit\s*\{[^}]*--product-accent:\s*#a85d2d/s);
  assert.match(portalStyles, /\.portal-product-link-speak\s*\{[^}]*--product-accent:\s*#3e68ad/s);
});
