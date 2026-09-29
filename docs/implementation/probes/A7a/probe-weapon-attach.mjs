// A7a: weapon item models: which attachment ids do they carry (ItemVisuals has 5 slots), and how
// many ItemVisuals rows put different effects in different slots. Read-only.
import { clientArchives } from "file:///F:/tswowRoot/WebClient/tools/mpq.mjs";
import { clientDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";
import { openRaw } from "file:///C:/Users/ADMINI~1/AppData/Local/Temp/claude/F--tswowRoot-WebClient/8691de39-2c7d-46b9-bb55-f8d1b969e99a/scratchpad/impl/A7a/raw.mjs";

const archives = await clientArchives(clientDirectory());
const rd = (b, o) => b.readUInt32LE(o);
const idSets = new Map();
const counts = new Map();
let models = 0;
const examples = [];
for (const dir of ["Item\\ObjectComponents\\Weapon\\", "Item\\ObjectComponents\\Shield\\"]) {
  for (const path of await archives.list(dir)) {
    if (!/\.m2$/i.test(path)) continue;
    const b = await archives.read(path);
    if (!b || b.byteLength < 0x100 || b.toString("latin1", 0, 4) !== "MD20") continue;
    models++;
    const n = rd(b, 0xf0), o = rd(b, 0xf4);
    const ids = [];
    for (let i = 0; i < n && n < 64; i++) ids.push(rd(b, o + i * 40));
    ids.sort((x, y) => x - y);
    const key = ids.join(",");
    idSets.set(key, (idSets.get(key) ?? 0) + 1);
    counts.set(ids.length, (counts.get(ids.length) ?? 0) + 1);
    if (examples.length < 6 && ids.length >= 4) examples.push(`${path.split("\\").pop()}:[${key}]`);
  }
}
console.log(`weapon/shield models=${models}`);
console.log("attachment count histogram:", [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}x${v}`).join(" "));
console.log("top attachment id sets:", [...idSets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `[${k}]x${v}`).join(" "));
console.log("examples with >=4:", examples.join(" | "));

const iv = openRaw("ItemVisuals");
let distinct = 0, allSame = 0;
const slotUse = [0, 0, 0, 0, 0];
for (let r = 0; r < iv.records; r++) {
  const slots = [1, 2, 3, 4, 5].map((c) => iv.int(r, c));
  slots.forEach((s, i) => { if (s > 0) slotUse[i]++; });
  if (new Set(slots).size > 1) distinct++; else allSame++;
}
console.log(`ItemVisuals rows=${iv.records}: rows with different effects per slot=${distinct}, all-slots-identical=${allSame}; nonzero per slot: ${slotUse.join("/")}`);
archives.close?.();
