import { readFile, writeFile } from "node:fs/promises";

const repositoryRoot = new URL("../", import.meta.url);
const generatedLicensesUrl = new URL(
  "src/mo_speech/web/react/assets/licenses.md",
  repositoryRoot,
);
const openccThirdPartyLicensesUrl = new URL(
  "node_modules/opencc-js/THIRD_PARTY_LICENSES.md",
  repositoryRoot,
);
const openccPackageJsonUrl = new URL(
  "node_modules/opencc-js/package.json",
  repositoryRoot,
);
const marker = "## opencc-js bundled third-party notices";

const generatedLicenses = await readFile(generatedLicensesUrl, "utf8");
const openccThirdPartyLicenses = await readFile(openccThirdPartyLicensesUrl, "utf8");
// 版はdependabotのbumpで動くのでinstall済みのpackage.jsonから取る。
// ライセンス表記の変更は人の確認を要する事象なので、こちらは固定して検査する。
const { version: openccVersion } = JSON.parse(
  await readFile(openccPackageJsonUrl, "utf8"),
);
const expectedOpenccNotice = `opencc-js - ${openccVersion} (MIT AND Apache-2.0)`;

if (!generatedLicenses.includes(expectedOpenccNotice)) {
  throw new Error(`Viteのライセンス出力に「${expectedOpenccNotice}」が見つかりません。`);
}
if (
  !openccThirdPartyLicenses.includes("## opencc-data") ||
  !openccThirdPartyLicenses.includes("Apache License, Version 2.0")
) {
  throw new Error("opencc-jsのopencc-data / Apache-2.0通知を確認できません。");
}

const markerIndex = generatedLicenses.indexOf(`\n${marker}\n`);
const generatedBase = (markerIndex >= 0
  ? generatedLicenses.slice(0, markerIndex)
  : generatedLicenses
).trimEnd();
const upstreamNotice = openccThirdPartyLicenses
  .replace(/^# Third-Party Licenses\s*/, "")
  .trim();

await writeFile(
  generatedLicensesUrl,
  `${generatedBase}\n\n${marker}\n\n${upstreamNotice}\n`,
  "utf8",
);
