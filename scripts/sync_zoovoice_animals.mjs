import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const lexicon = JSON.parse(await readFile(new URL("services/zoovoice/assets/animal-lexicon.json", root), "utf8"));

if (lexicon.schema_version !== 1 || lexicon.generated !== true || !Array.isArray(lexicon.animals) || lexicon.animals.length === 0) {
  throw new Error("Zoovoice animal lexicon is invalid");
}

const animals = lexicon.animals.map((animal) => {
  if (!animal.id || !animal.label_ja || !animal.audio_file || !animal.audio_sha256) {
    throw new Error(`Zoovoice animal lexicon entry is incomplete: ${animal.id || "unknown"}`);
  }
  return { id: animal.id, label_ja: animal.label_ja, variants: 1 };
});

const output = `${JSON.stringify({ animals }, null, 2)}\n`;
await writeFile(new URL("apps/web/public/zoovoice-animals.json", root), output, "utf8");
