// Read-only probe: how many classes each race may take (CharBaseInfo pairs), to see whether the
// stock glue's MAX_CLASSES_PER_RACE = 11 is ever exceeded now that the dataset has 12 classes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
const DIR = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const raw = readFileSync(join(DIR, "CharBaseInfo.dbc"));
const records = raw.readUInt32LE(4), size = raw.readUInt32LE(12);
const perRace = new Map();
for (let r = 0; r < records; r++) {
  const race = raw[20 + r * size], cls = raw[20 + r * size + 1];
  const set = perRace.get(race) ?? new Set();
  set.add(cls);
  perRace.set(race, set);
}
for (const [race, set] of [...perRace].sort((a, b) => a[0] - b[0])) {
  console.log(`race ${race}: ${set.size} classes [${[...set].sort((a, b) => a - b).join(",")}]`);
}
console.log("max classes per race:", Math.max(...[...perRace.values()].map((s) => s.size)));
