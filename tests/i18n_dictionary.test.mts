import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { animalEmojiIds } from "../apps/web/src/zoovoice/animal-emoji.ts";
import { animalName, animalNameEnIds } from "../apps/web/src/zoovoice/animal-name.ts";
import { dictionaries, locales, translateWith } from "../apps/web/src/shared/i18n-messages.ts";
import { zoovoiceStatusMessageKeys } from "../apps/web/src/zoovoice/state.ts";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("every locale carries the same keys with the same shape", () => {
  const jaKeys = Object.keys(dictionaries.ja).sort();
  assert.ok(jaKeys.length > 50);
  for (const locale of locales) {
    assert.deepEqual(Object.keys(dictionaries[locale]).sort(), jaKeys, locale);
    for (const key of jaKeys) {
      assert.equal(
        typeof dictionaries[locale][key],
        typeof dictionaries.ja[key],
        `${locale} / ${key} changes between a string and a function`,
      );
    }
  }
});

test("no message is left empty", () => {
  for (const locale of locales) {
    for (const [key, message] of Object.entries(dictionaries[locale])) {
      if (typeof message === "string") assert.ok(message.trim().length > 0, `${locale} / ${key}`);
    }
  }
});

test("every status key the reducer can return exists in both dictionaries", () => {
  for (const key of zoovoiceStatusMessageKeys) {
    for (const locale of locales) {
      assert.ok(dictionaries[locale][key], `${locale} is missing ${key}`);
    }
  }
});

// 辞書へ登録し忘れると、翻訳の代わりに生のキーが画面へ出る。ソース側が使うキーを
// 拾って突き合わせ、その取りこぼしを機械的に止める。
test("every message key the sources use exists in both dictionaries", async () => {
  const sources = await Promise.all([
    read("apps/web/src/shared/components.tsx"),
    read("apps/web/src/shared/bootstrap.tsx"),
    read("apps/web/src/zoovoice/main.tsx"),
    read("apps/web/src/zoovoice/state.ts"),
    read("apps/web/src/zoovoice/api.ts"),
    read("apps/web/src/zoovoice/record-orb.tsx"),
    read("apps/web/src/zoovoice/result-player.tsx"),
    read("apps/web/src/zoovoice/turnstile-widget.tsx"),
  ]);
  // t("...") の呼び出しと、キーを変数へ置く箇所(status / error / api / turnstile)を拾う。
  // ファイル名のような "zoovoice.wav" を巻き込まないよう、後者は3セグメント以上に限る。
  const keyPatterns = [
    /\bt\(\s*"((?:shared|zoovoice)\.[A-Za-z][A-Za-z.]*)"/g,
    /"(zoovoice\.[a-z]+\.[A-Za-z]+)"/g,
  ];
  const used = new Set<string>();
  for (const source of sources) {
    for (const pattern of keyPatterns) {
      for (const match of source.matchAll(pattern)) used.add(match[1]);
    }
  }
  assert.ok(used.size > 40, `only ${used.size} keys were found in the sources`);
  for (const key of used) {
    for (const locale of locales) {
      assert.ok(dictionaries[locale][key], `${locale} is missing ${key}`);
    }
  }
});

test("the English animal names cover exactly the same ids as the emoji table", () => {
  assert.deepEqual([...animalNameEnIds].sort(), [...animalEmojiIds].sort());
});

test("an unknown animal id falls back to the Japanese label", () => {
  assert.equal(animalName("unlisted-animal", "未収録の動物", "en"), "未収録の動物");
  assert.equal(animalName("cat", "猫", "en"), "Cat");
  assert.equal(animalName("cat", "猫", "ja"), "猫");
});

test("the insertion summary changes form for a single spot in English", () => {
  assert.equal(
    translateWith("zoovoice.insertionSummary", "en", { count: 1, animal: "Cat" }),
    "Added one Cat call in a single spot.",
  );
  assert.match(translateWith("zoovoice.insertionSummary", "en", { count: 3, animal: "Cat" }), /3 spots/);
  assert.match(translateWith("zoovoice.insertionSummary", "ja", { count: 3, animal: "猫" }), /3か所/);
});

test("a missing key falls back to Japanese and then to the key itself", () => {
  assert.equal(translateWith("shared.techStack", "en"), "Built with");
  assert.equal(translateWith("nowhere.at.all", "en"), "nowhere.at.all");
});
