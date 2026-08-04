import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [pkgText, pyproject, api, viteConfig, ci, portalHtml, privacyHtml, speakloopHtml, adminHtml, practiceAdminHtml] = await Promise.all([
  read("package.json"),
  read("pyproject.toml"),
  read("src/mo_speech/api.py"),
  read("apps/web/vite.config.ts"),
  read(".github/workflows/ci.yml"),
  read("apps/web/portal.html"),
  read("apps/web/privacy.html"),
  read("apps/web/speakloop.html"),
  read("src/mo_speech/web/index.html"),
  read("src/mo_speech/web/practice_admin.html"),
]);
const portalStyles = await read("apps/web/src/portal/styles.css");
const portalMain = await read("apps/web/src/portal/main.tsx");
const zoovoiceMain = await read("apps/web/src/zoovoice/main.tsx");
const zoovoiceOrb = await read("apps/web/src/zoovoice/record-orb.tsx");
const zoovoiceTurnstile = await read("apps/web/src/zoovoice/turnstile-widget.tsx");

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
  for (const html of [speakloopHtml, adminHtml, practiceAdminHtml]) {
    assert.doesNotMatch(html, /\/static\/styles\.css/);
  }
  assert.match(viteConfig, /appStyles/);
  assert.match(speakloopHtml, /src\/styles\/app\.css/);
  for (const html of [adminHtml, practiceAdminHtml]) {
    assert.match(html, /\/react\/assets\/app\.css/);
  }
});

test("all active pages use the shared multi-size Voice Lab favicon", async () => {
  for (const html of [
    portalHtml,
    privacyHtml,
    speakloopHtml,
    adminHtml,
    practiceAdminHtml,
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
  for (const html of [adminHtml, practiceAdminHtml]) {
    assert.match(html, /Voice Lab/);
    assert.match(html, /voice-lab-admin-body/);
    assert.match(html, /admin-nav/);
    assert.match(html, /href="\/admin"/);
    assert.match(html, /href="\/speakloop\/admin"/);
    assert.doesNotMatch(html, /href="\/fun"/);
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
  assert.match(portalStyles, /\.portal-product-link-speak\s*\{[^}]*--product-accent:\s*#3e68ad/s);
  assert.match(portalMain, /number:\s*"02"[\s\S]*name:\s*"Zoovoice"[\s\S]*href:\s*"\/zoovoice"/);
  assert.match(portalMain, /title:\s*"話すだけで、ぴったりの動物を。"/);
  assert.match(portalMain, /description:\s*"話した内容から動物を選び、声のすき間へ鳴き声を重ねます。"/);
  assert.match(portalMain, /action:\s*"声を変えてみる"/);
  assert.match(portalMain, /icon:\s*PawPrint/);
  assert.match(portalMain, /tone:\s*"portal-product-link-zoovoice"/);
  assert.match(portalStyles, /\.portal-product-link-zoovoice\s*\{[^}]*--product-accent:\s*#8a4a18;[^}]*--product-soft:\s*#f7e4d0;/s);
  assert.match(portalStyles, /html\[data-theme="dark"\]\s+\.portal-product-link-zoovoice\s*\{[^}]*--product-accent:\s*#f2b56b;[^}]*--product-soft:\s*#4b321f;/s);

  const lightBackground = cssColor(portalStyles, ":root", "--background");
  const lightMuted = cssColor(portalStyles, ":root", "--muted");
  const darkBackground = cssColor(portalStyles, 'html[data-theme="dark"]', "--background");
  const darkMuted = cssColor(portalStyles, 'html[data-theme="dark"]', "--muted");
  for (const [foreground, backgrounds] of [
    ["#8a4a18", [lightBackground, lightMuted, "#f7e4d0"]],
    ["#f2b56b", [darkBackground, darkMuted, "#4b321f"]],
  ]) {
    for (const background of backgrounds) {
      assert.ok(contrastRatio(parseCssColor(foreground), parseCssColor(background)) >= 4.5, `${foreground} on ${background}`);
    }
  }
});

test("Zoovoice keeps Turnstile mounted and stops recording into automatic compose", () => {
  assert.match(zoovoiceMain, /config\?\.turnstile_required && <TurnstileWidget/);
  assert.match(zoovoiceMain, /composeRecording\(attempt\.blob, attempt\.intensity/);
  assert.match(zoovoiceMain, /state\.phase !== "finalizing"/);
  assert.match(zoovoiceOrb, /aria-label="録音をキャンセル"/);
  assert.match(zoovoiceTurnstile, /"refresh-expired": "auto"/);
  assert.match(zoovoiceTurnstile, /"refresh-timeout": "auto"/);
  assert.match(zoovoiceTurnstile, /retry: "auto"/);
  assert.doesNotMatch(zoovoiceMain, />生成する</);
  assert.doesNotMatch(zoovoiceMain, /録り直す/);
  assert.doesNotMatch(zoovoiceMain, /styles\.css|record-orb\.css|practice-record-orb/);
  assert.match(zoovoiceMain, />\s*Powered by Stability AI\s*</);
});

function cssColor(css, selector, property) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"))?.[1] || "";
  return block.match(new RegExp(`${property}:\\s*([^;]+)`))?.[1].trim() || "";
}

function parseCssColor(value) {
  if (value.startsWith("#")) {
    return [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16) / 255);
  }
  const match = value.match(/^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  assert.ok(match, `unsupported color: ${value}`);
  const [, lightness, chroma, hue] = match.map(Number);
  const angle = hue * Math.PI / 180;
  const a = chroma * Math.cos(angle);
  const b = chroma * Math.sin(angle);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055)
    .map((channel) => Math.min(1, Math.max(0, channel)));
}

function contrastRatio(foreground, background) {
  const luminance = (rgb) => 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
  const linear = (channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("the overview admin page exposes the signed-in user list panel", () => {
  assert.match(adminHtml, /id="public-users-panel"/);
  assert.match(adminHtml, /data-public-users-body/);
  assert.match(adminHtml, /data-public-users-status/);
  assert.match(adminHtml, /\/static\/app_public_users\.js/);
});
