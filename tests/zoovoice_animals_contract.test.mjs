import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJSON = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));

test("Zoovoice public animals are derived from the sounds manifest", async () => {
  const [manifest, publicAnimals] = await Promise.all([
    readJSON("services/zoovoice/assets/animal-sounds/manifest.json"),
    readJSON("apps/web/public/zoovoice-animals.json"),
  ]);
  const expected = manifest.animals
    .map(({ id, label_ja }) => ({ id, label_ja, variants: 1 }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  assert.deepEqual(publicAnimals.animals, expected);
  const pig = manifest.animals.find(({ id }) => id === "pig");
  assert.equal(pig.file, "pig.wav");
  assert.ok(pig.license);
});
