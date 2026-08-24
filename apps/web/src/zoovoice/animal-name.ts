import type { Locale } from "../shared/i18n";

// 英語表示のときだけ使う動物名。APIが返すのは label_ja だけで、gatewayのschema
// (cloudflare/zoovoice-gateway.mjs) が label_ja を必須にしているため、label_en を足すには
// gatewayとoriginの変更が必要になる。表示だけの都合なので id→英語名はフロントで持つ。
// idは animal-emoji.ts と同じ空間。辞書に無いidは label_ja をそのまま出すので、
// 鳴き声セットへ動物を追加しても英語表示が壊れることはない。
const animalNameEnById: Record<string, string> = {
  "aburazemi": "Large Brown Cicada",
  "black-kite": "Black Kite",
  "blue-rock-thrush": "Blue Rock Thrush",
  "brown-bear": "Brown Bear",
  "bullfrog": "Bullfrog",
  "bush-warbler": "Japanese Bush Warbler",
  "buzzard": "Eastern Buzzard",
  "cat": "Cat",
  "chick": "Chick",
  "chimpanzee": "Chimpanzee",
  "cow": "Cow",
  "cricket": "Cricket",
  "crow": "Crow",
  "cuckoo": "Cuckoo",
  "dog": "Dog",
  "dolphin": "Dolphin",
  "donkey": "Donkey",
  "duck": "Duck",
  "elephant": "Elephant",
  "flamingo": "Flamingo",
  "fox": "Fox",
  "frog": "Frog",
  "goat": "Goat",
  "goose": "Goose",
  "gorilla": "Gorilla",
  "heron": "Heron",
  "higurashi": "Evening Cicada",
  "horse": "Horse",
  "hyena": "Hyena",
  "lion": "Lion",
  "little-grebe": "Little Grebe",
  "macaque": "Japanese Macaque",
  "magpie": "Magpie",
  "mallard": "Mallard",
  "minminzemi": "Robust Cicada",
  "orca": "Orca",
  "owl": "Owl",
  "peacock": "Peacock",
  "penguin": "Penguin",
  "pig": "Pig",
  "pigeon": "Pigeon",
  "rooster": "Rooster",
  "sea-lion": "Sea Lion",
  "sheep": "Sheep",
  "sika-deer": "Sika Deer",
  "sparrow": "Sparrow",
  "suzumushi": "Bell Cricket",
  "swallow": "Swallow",
  "tiger": "Tiger",
  "tree-frog": "Japanese Tree Frog",
  "tsukutsukuboushi": "Kaempfer Cicada",
  "turkey": "Turkey",
  "wagtail": "Wagtail",
  "whale": "Whale",
  "wolf": "Wolf",
};

export const animalNameEnIds = Object.keys(animalNameEnById);

export function animalName(animalId: string, labelJa: string, locale: Locale): string {
  if (locale !== "en") return labelJa;
  return animalNameEnById[animalId] || labelJa;
}
