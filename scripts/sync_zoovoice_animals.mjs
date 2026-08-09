import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("services/zoovoice/assets/animal-sounds/manifest.json", root), "utf8"));

if (!Array.isArray(manifest.animals) || manifest.animals.length === 0) {
  throw new Error("Zoovoice sounds manifest is invalid");
}

const animals = manifest.animals.map((animal) => {
  if (!animal.id || !animal.label_ja || !animal.file || !animal.normalized_sha256) {
    throw new Error(`Zoovoice sounds manifest entry is incomplete: ${animal.id || "unknown"}`);
  }
  return { id: animal.id, label_ja: animal.label_ja, variants: 1 };
});
animals.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

const output = `${JSON.stringify({ animals }, null, 2)}\n`;
await writeFile(new URL("apps/web/public/zoovoice-animals.json", root), output, "utf8");
