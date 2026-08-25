// 連想された動物を絵で示すための対応表。
// 画像ファイルは配布ライセンスの確認が要るため、まずはライセンス不要の絵文字を使う。
// 鳴き声セットに載っている動物のidを網羅し、載っていないidは足跡へ落とす。
const animalEmojiById: Record<string, string> = {
  "aburazemi": "🦗",
  "black-kite": "🦅",
  "blue-rock-thrush": "🐦",
  "brown-bear": "🐻",
  "bullfrog": "🐸",
  "bush-warbler": "🐦",
  "buzzard": "🦅",
  "cat": "🐱",
  "chick": "🐤",
  "chimpanzee": "🐵",
  "cow": "🐮",
  "cricket": "🦗",
  "crow": "🐦‍⬛",
  "cuckoo": "🐦",
  "dog": "🐶",
  "dolphin": "🐬",
  "donkey": "🫏",
  "duck": "🦆",
  "elephant": "🐘",
  "flamingo": "🦩",
  "fox": "🦊",
  "frog": "🐸",
  "goat": "🐐",
  "goose": "🦢",
  "gorilla": "🦍",
  "heron": "🐦",
  "higurashi": "🦗",
  "horse": "🐴",
  "hyena": "🐆",
  "lion": "🦁",
  "little-grebe": "🐦",
  "macaque": "🐒",
  "magpie": "🐦",
  "mallard": "🦆",
  "minminzemi": "🦗",
  "orca": "🐳",
  "owl": "🦉",
  "peacock": "🦚",
  "penguin": "🐧",
  "pig": "🐷",
  "pigeon": "🕊️",
  "rooster": "🐓",
  "sea-lion": "🦭",
  "sheep": "🐑",
  "sika-deer": "🦌",
  "sparrow": "🐦",
  "suzumushi": "🦗",
  "swallow": "🐦",
  "tiger": "🐯",
  "tree-frog": "🐸",
  "tsukutsukuboushi": "🦗",
  "turkey": "🦃",
  "wagtail": "🐦",
  "whale": "🐋",
  "wolf": "🐺",
};

// 英語名の辞書と同じidを覆っているかをテストで固定するために公開する。
export const animalEmojiIds = Object.keys(animalEmojiById);

const fallbackAnimalEmoji = "🐾";

export function animalEmoji(animalId: string): string {
  return animalEmojiById[animalId] || fallbackAnimalEmoji;
}
