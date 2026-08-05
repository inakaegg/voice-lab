import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJSON = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));

test("Zoovoice public animals are derived from the generated lexicon", async () => {
  const [lexicon, publicAnimals] = await Promise.all([
    readJSON("services/zoovoice/assets/animal-lexicon.json"),
    readJSON("apps/web/public/zoovoice-animals.json"),
  ]);
  assert.equal(lexicon.generated, true);
  assert.deepEqual(
    publicAnimals.animals,
    lexicon.animals.map(({ id, label_ja }) => ({ id, label_ja, variants: 1 })),
  );
  const pig = lexicon.animals.find(({ id }) => id === "pig");
  assert.ok(pig.terms.includes("豚肉"));
  assert.equal(pig.audio_file, "animal-sounds/pig.wav");
});
