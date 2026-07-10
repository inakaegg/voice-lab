import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [pkgText, pyproject, api, viteConfig, ci, portalHtml, speakloopHtml, skitvoiceHtml, legacyPortalHtml, legacySpeakloopHtml, legacySkitvoiceHtml, adminHtml, practiceAdminHtml, skitvoiceAdminHtml, funHtml, seedVcHtml] = await Promise.all([
  read("package.json"),
  read("pyproject.toml"),
  read("src/mo_speech/api.py"),
  read("apps/web/vite.config.ts"),
  read(".github/workflows/ci.yml"),
  read("apps/web/portal.html"),
  read("apps/web/speakloop.html"),
  read("apps/web/skitvoice.html"),
  read("src/mo_speech/web/portal.html"),
  read("src/mo_speech/web/practice.html"),
  read("src/mo_speech/web/vibevoice_simple.html"),
  read("src/mo_speech/web/index.html"),
  read("src/mo_speech/web/practice_admin.html"),
  read("src/mo_speech/web/vibevoice.html"),
  read("src/mo_speech/web/user.html"),
  read("src/mo_speech/web/seed_vc.html"),
]);

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
  for (const html of [speakloopHtml, skitvoiceHtml, legacyPortalHtml, legacySpeakloopHtml, legacySkitvoiceHtml, adminHtml, practiceAdminHtml, skitvoiceAdminHtml, funHtml, seedVcHtml]) {
    assert.doesNotMatch(html, /\/static\/styles\.css/);
  }
  assert.match(viteConfig, /appStyles/);
  assert.match(speakloopHtml, /src\/styles\/app\.css/);
  assert.match(skitvoiceHtml, /src\/styles\/app\.css/);
  for (const html of [legacyPortalHtml, legacySpeakloopHtml, legacySkitvoiceHtml, adminHtml, practiceAdminHtml, skitvoiceAdminHtml, funHtml, seedVcHtml]) {
    assert.match(html, /\/react\/assets\/app\.css/);
  }
  assert.match(legacySpeakloopHtml, /Voice Lab<\/title>/);
  assert.match(legacySkitvoiceHtml, /Voice Lab<\/title>/);
});

test("all admin pages expose a consistent Voice Lab admin shell and navigation", () => {
  for (const html of [adminHtml, practiceAdminHtml, skitvoiceAdminHtml]) {
    assert.match(html, /Voice Lab/);
    assert.match(html, /voice-lab-admin-body/);
    assert.match(html, /admin-nav/);
    assert.match(html, /href="\/admin"/);
    assert.match(html, /href="\/speakloop\/admin"/);
    assert.match(html, /href="\/skitvoice\/admin"/);
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
