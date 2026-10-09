// A7a 6.10 / 6.11а census (05.10): which Character\* models carry geoset 1703 (and 1702, 701/702);
// CreatureGeosetData of the 39 displays decoded by nibbles — do the resulting geosets exist in the model?
import { openDbcFile } from "file:///F:/tswowRoot/WebClient/tools/dbc.mjs";
import { dbcDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";
import { walkM2, archives, geosets } from "./corpus.mjs";

// --- 6.10: playable character models.
const rows = [];
const run = await walkM2((path, model, skin) => {
  if (!skin) return;
  const g = geosets(skin);
  rows.push({ path, has1703: g.has(1703), has1702: g.has(1702), has1701: g.has(1701), has701: g.has(701), has702: g.has(702), eyeGlow: [...g].filter((x) => x >= 1700 && x < 1800).sort() });
}, { roots: ["Character\\"], withSkin: true });
console.log("Character walk:", JSON.stringify(run));
const bodies = rows.filter((r) => /^character\\[a-z]+\\(male|female)\\[a-z]+(male|female)\.m2$/i.test(r.path));
console.log(`playable body models: ${bodies.length}`);
for (const r of bodies) console.log(`  ${r.path.split("\\").pop()} 17xx=[${r.eyeGlow.join(",")}] 701=${r.has701} 702=${r.has702}`);
console.log("all Character models with 1703:", rows.filter((r) => r.has1703).map((r) => r.path.split("\\").pop()).join(" ") || "none");

// --- 6.11а: CreatureGeosetData.
const dir = dbcDirectory();
const disp = await openDbcFile(dir, "CreatureDisplayInfo");
const cmd = await openDbcFile(dir, "CreatureModelData");
const modelName = new Map();
for (const r of cmd.rows()) modelName.set(cmd.id(r), cmd.string(r, "ModelName"));
const chain = await archives();
const byModel = new Map();
for (const r of disp.rows()) {
  const data = disp.int(r, "CreatureGeosetData");
  if (data === 0) continue;
  const name = (modelName.get(disp.int(r, "ModelID")) ?? "").replace(/\.(mdx|mdl)$/i, ".m2");
  const list = byModel.get(name) ?? []; byModel.set(name, list);
  list.push({ display: disp.id(r), data, extra: disp.int(r, "ExtendedDisplayInfoID") });
}
let displays = 0, lowFirstAll = 0, highFirstAll = 0;
for (const [name, list] of byModel) {
  let present = new Set();
  try {
    const skin = await chain.read(`${name.slice(0, -3)}00.skin`);
    present = geosets(skin);
  } catch { /* missing */ }
  const ids = [...present].sort((a, b) => a - b);
  console.log(`model ${name} (${list.length} displays, extra ${[...new Set(list.map((d) => d.extra))].join(",")}): geosets ${ids.join(",")}`);
  for (const d of list) {
    displays++;
    // Hypothesis: one nibble per group 1..4 (and up to 8), low nibble = group 1; geoset = group*100 + value.
    const low = [], high = [];
    for (let g = 0; g < 8; g++) { const v = (d.data >>> (g * 4)) & 0xf; if (v) low.push((g + 1) * 100 + v); }
    const nibbles = []; for (let g = 0; g < 8; g++) nibbles.push((d.data >>> (g * 4)) & 0xf);
    const used = nibbles.findLastIndex((v) => v !== 0) + 1;
    for (let g = 0; g < used; g++) { const v = nibbles[used - 1 - g]; if (v) high.push((g + 1) * 100 + v); }
    const lowOk = low.every((x) => present.has(x)), highOk = high.every((x) => present.has(x));
    if (lowOk) lowFirstAll++; if (highOk) highFirstAll++;
    console.log(`   display ${d.display} data 0x${d.data.toString(16)} low-first [${low.join(",")}] ${lowOk ? "all present" : "missing " + low.filter((x) => !present.has(x)).join(",")}; high-first [${high.join(",")}] ${highOk ? "all present" : "missing " + high.filter((x) => !present.has(x)).join(",")}`);
  }
}
console.log(`CreatureGeosetData displays ${displays}: low-nibble-first all present ${lowFirstAll}, high-nibble-first all present ${highFirstAll}`);
