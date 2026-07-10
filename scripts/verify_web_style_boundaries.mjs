import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (name) => readFile(new URL(`../src/mo_speech/web/react/${name}.html`, import.meta.url), "utf8");
const [portal, speakloop, skitvoice] = await Promise.all([
  read("portal"),
  read("speakloop"),
  read("skitvoice"),
]);

assert.doesNotMatch(portal, /\/static\/styles\.css/, "portal must not load the legacy stylesheet");
assert.match(portal, /\/react\/assets\/portal\.css/, "portal must load its Tailwind build");

for (const [route, html] of [["speakloop", speakloop], ["skitvoice", skitvoice]]) {
  assert.match(html, /\/static\/styles\.css/, `${route} must keep the legacy stylesheet until route migration`);
  assert.doesNotMatch(html, /\/react\/assets\/portal\.css/, `${route} must not load portal Tailwind CSS`);
}

console.log("web style boundaries: portal=Tailwind, speakloop/skitvoice=legacy");
