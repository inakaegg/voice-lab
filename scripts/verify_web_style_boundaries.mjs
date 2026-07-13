import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (name) => readFile(new URL(`../src/mo_speech/web/react/${name}.html`, import.meta.url), "utf8");
const readStatic = (name) => readFile(new URL(`../src/mo_speech/web/${name}`, import.meta.url), "utf8");
const [portal, speakloop, skitvoice, appCss, ...staticPages] = await Promise.all([
  read("portal"),
  read("speakloop"),
  read("skitvoice"),
  readFile(new URL("../src/mo_speech/web/react/assets/app.css", import.meta.url), "utf8"),
  ...[
    "index.html",
    "practice_admin.html",
    "vibevoice.html",
    "user.html",
  ].map(readStatic),
]);

assert.doesNotMatch(portal, /\/static\/styles\.css/, "portal must not load the legacy stylesheet");
assert.match(portal, /\/react\/assets\/portal\.css/, "portal must load its Tailwind build");

for (const [route, html] of [["speakloop", speakloop], ["skitvoice", skitvoice]]) {
  assert.doesNotMatch(html, /\/static\/styles\.css/, `${route} must not load the legacy stylesheet directly`);
  assert.match(html, /\/react\/assets\/app\.css/, `${route} must load the shared Tailwind compatibility build`);
  assert.doesNotMatch(html, /\/react\/assets\/portal\.css/, `${route} must not load portal Tailwind CSS`);
}

assert.match(appCss, /voice-lab-admin-body/, "shared app CSS must include the admin design system");
for (const html of staticPages) {
  assert.doesNotMatch(html, /\/static\/styles\.css/, "active static pages must not load legacy CSS directly");
  assert.match(html, /\/react\/assets\/app\.css/, "active static pages must load the shared app CSS");
}

console.log("web style boundaries: React portal=isolated Tailwind, app/admin/compatibility pages=shared Tailwind build");
