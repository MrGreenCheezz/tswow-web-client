// A7b probe (read-only): compare the tree stand-in regex with the token classifier VegetationWind.ts
// already uses (replicated verbatim from src/browser/VegetationWind.ts isBotanicalModelPath).
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const WIND_POSITIVE_TOKENS = new Set(["branch", "branches", "bush", "bushes", "canopy", "cactus", "catus", "coral", "fern",
  "flower", "flowers", "foliage", "frond", "fronds", "grass", "herb", "herbs", "kelp", "leaf", "leaves", "moss", "needle", "needles", "palm", "plant", "plants", "reed", "reeds", "rush",
  "rushes", "sapling", "saplings", "seaweed", "shrub", "shrubs", "tree", "trees", "vine", "underbrush", "vines", "vineyard", "weed", "weeds"]);
const WIND_REJECTED_TOKENS = new Set(["armor", "bark", "banner", "barrier", "box", "cage", "cloth", "curtain",
  "facade", "fur", "hair", "handle", "hollow", "house", "hut", "huts", "ice", "lamp",
  "log", "pole", "rock", "roof", "root", "roots", "rope", "sack", "sign", "skull", "smoke",
  "snow", "spell", "stand", "stick", "sticks", "stone", "stump", "trunk", "wall", "weapon", "web"]);
const DIRS = new Set(["bush", "bushes", "coral", "ferns", "flowers", "foliage", "grass", "plants", "seaplants", "shrubs", "trees", "vines", "vineyard"]);
const tokens = (p) => p.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter(Boolean);
const baseTokens = (p) => { const s = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")); return tokens(p.slice(s + 1).replace(/\.(?:blp|m2)$/i, "")); };
const hasStem = (t) => t.some((x) => WIND_POSITIVE_TOKENS.has(x)) || t.some((x) =>
  /(?:branches?|bush(?:es)?|canopy|cactus|catus|coral|fern|flowers?|foliage|fronds?|grass|herbs?|kelp|leaf|leaves|moss|needles?|palm|plants?[a-z]?|reeds?|saplings?|seaweed|shrubs?|trees?|underbrush|vines?|vineyard|weeds?)$/.test(x)
  || (/rush(?:es)?$/.test(x) && !/brush(?:es)?$/.test(x)));
const rejected = (t) => {
  if (t.some((x) => WIND_REJECTED_TOKENS.has(x))) return true;
  const c = t.join("");
  return /(?:armor|bark|banner|barrier|cage|cloth|curtain|hollow|rock|roof|roots?|rope|skull|sticks?|stone|stump|trunk|wall|weapon|web)/.test(c)
    || /(?:box|facade|handle|house|huts?|log|pole|sack|smoke|snow|stand)(?:skin|copy)?$/.test(c) || c.startsWith("sack") || c.endsWith("wood");
};
const botanical = (path) => {
  if (!/\.m2$/i.test(path)) return false;
  const b = baseTokens(path);
  if (rejected(b)) return false;
  if (hasStem(b)) return true;
  return path.split(/[\\/]/).slice(0, -1).flatMap((s) => tokens(s)).some((t) => DIRS.has(t));
};
const regex = /tree|oak|pine|willow|bush|shrub/i;

const root = "F:/tswowRoot/WebClient/data/visual-tiles";
const counts = new Map();
for (const map of await readdir(root)) {
  const dir = join(root, map);
  if (!(await stat(dir)).isDirectory()) continue;
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".json")) continue;
    for (const o of JSON.parse(await readFile(join(dir, file), "utf8"))) {
      if (o.kind !== "m2" || o.interior) continue;
      counts.set(o.name, (counts.get(o.name) ?? 0) + 1);
    }
  }
}
let both = 0, onlyRegex = 0, onlyBot = 0; const A = [], B = [];
for (const [name, c] of counts) {
  const r = regex.test(name), b = botanical(name);
  if (r && b) both += c; else if (r) { onlyRegex += c; A.push([name, c]); } else if (b) { onlyBot += c; B.push([name, c]); }
}
console.log(`both ${both}; regex-only ${onlyRegex} (${A.length} names); botanical-only ${onlyBot} (${B.length} names)`);
console.log("-- regex-only (what a botanical rule would stop calling a tree), top 60");
for (const [n, c] of A.sort((x, y) => y[1] - x[1]).slice(0, 60)) console.log(`  ${c}\t${n.split("\\").slice(-3).join("\\")}`);
console.log("-- botanical-only (would become new), top 25");
for (const [n, c] of B.sort((x, y) => y[1] - x[1]).slice(0, 25)) console.log(`  ${c}\t${n.split("\\").slice(-3).join("\\")}`);
// Which of the regex-only are real trees/bushes per a name that contains 'tree' or 'bush' as its last token part?
const trueTreeLike = A.filter(([n]) => /(?:tree|trees|bush|bushes|shrub|oak|pine|willow)\d*\.m2$/i.test(n.split("\\").pop()));
console.log(`-- regex-only names ending in a plant word: ${trueTreeLike.length}`);
for (const [n, c] of trueTreeLike.sort((x, y) => y[1] - x[1]).slice(0, 30)) console.log(`  ${c}\t${n.split("\\").slice(-3).join("\\")}`);
