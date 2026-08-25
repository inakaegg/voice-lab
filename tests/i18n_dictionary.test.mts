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
    read("apps/web/src/speakloop/main.tsx"),
    // React外のスクリプトも同じ辞書を引く。取りこぼすと生のキーが画面へ出るので同じ検査にかける。
    read("src/mo_speech/web/app_practice.js"),
    read("src/mo_speech/web/practice_playback.js"),
    read("src/mo_speech/web/app_public_session.js"),
    read("src/mo_speech/web/app_public_sample_audio.js"),
  ]);
  // 呼び出しの形ではなく「辞書の名前空間で始まる文字列リテラル」を拾う。t( の直後だけを見る形や
  // セグメント数で絞る形は、三項式の中のキーのように隙間が残るため採らない。
  const keyPattern = /"((?:shared|zoovoice|speakloop)\.[A-Za-z][A-Za-z0-9.]*)"/g;
  // 名前空間と同じ綴りで始まるが辞書キーではない文字列。増えたらここへ足す。
  const notDictionaryKeys = new Set(["zoovoice.wav"]);
  const used = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(keyPattern)) {
      if (!notDictionaryKeys.has(match[1])) used.add(match[1]);
    }
  }
  assert.ok(used.size > 90, `only ${used.size} keys were found in the sources`);
  for (const key of used) {
    for (const locale of locales) {
      assert.ok(dictionaries[locale][key], `${locale} is missing ${key}`);
    }
  }
});

test("keys that contain digits are covered by the source scan", async () => {
  const speakloopSource = await read("apps/web/src/speakloop/main.tsx");
  const digitKeys = [...new Set(locales.flatMap((locale) => Object.keys(dictionaries[locale])))]
    .filter((key) => /\d/.test(key));
  assert.ok(digitKeys.length > 0, "the dictionary no longer has a key with a digit; drop this test");
  for (const key of digitKeys) {
    assert.ok(
      speakloopSource.includes(`t("${key}")`),
      `${key} is in the dictionary but no source calls it`,
    );
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
