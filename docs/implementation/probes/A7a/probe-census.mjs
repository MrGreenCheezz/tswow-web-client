import { openDbcFile } from "file:///F:/tswowRoot/WebClient/tools/dbc.mjs";
import { dbcDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";
const dir = dbcDirectory();
console.log("dbc dir", dir);
const extra = await openDbcFile(dir, "CreatureDisplayInfoExtra");
const disp = await openDbcFile(dir, "CreatureDisplayInfo");
const idi = await openDbcFile(dir, "ItemDisplayInfo");
const item = await openDbcFile(dir, "Item");
const emotes = await openDbcFile(dir, "Emotes");
// --- Extra rows: helm / shoulder / baked, and which are actually referenced by a display.
const usedExtra = new Map();
for (const r of disp.rows()) { const e = disp.int(r, "ExtendedDisplayInfoID"); if (e > 0) usedExtra.set(e, (usedExtra.get(e) ?? 0) + 1); }
let rows = 0, helm = 0, shoulder = 0, both = 0, baked = 0, helmUsed = 0, shoulderUsed = 0, helmBaked = 0, displaysWithHelm = 0, displaysWithShoulder = 0;
for (const r of extra.rows()) {
  rows++;
  const id = extra.id(r);
  const h = extra.int(r, "NPCItemDisplay", 0) > 0, s = extra.int(r, "NPCItemDisplay", 1) > 0;
  const b = extra.string(r, "BakeName") !== "";
  if (h) helm++; if (s) shoulder++; if (h && s) both++; if (b) baked++; if (h && b) helmBaked++;
  const uses = usedExtra.get(id) ?? 0;
  if (h && uses) { helmUsed++; displaysWithHelm += uses; }
  if (s && uses) { shoulderUsed++; displaysWithShoulder += uses; }
}
console.log(`Extra rows=${rows} withHelm=${helm} withShoulder=${shoulder} both=${both} baked=${baked} helmAndBaked=${helmBaked}; referenced by a display: helmRows=${helmUsed} (displays ${displaysWithHelm}) shoulderRows=${shoulderUsed} (displays ${displaysWithShoulder})`);
// --- Do helm/shoulder display ids resolve to models?
let helmModel = 0, helmNoModel = 0, shModel = 0, shNoModel = 0, helmVis = 0;
for (const r of extra.rows()) {
  const h = extra.int(r, "NPCItemDisplay", 0), s = extra.int(r, "NPCItemDisplay", 1);
  if (h > 0) { const row = idi.rowById?.(h); }
}
const idiRow = new Map(); for (const r of idi.rows()) idiRow.set(idi.id(r), r);
for (const r of extra.rows()) {
  const h = extra.int(r, "NPCItemDisplay", 0), s = extra.int(r, "NPCItemDisplay", 1);
  if (h > 0) { const ir = idiRow.get(h); if (ir !== undefined && idi.string(ir, "ModelName", 0)) helmModel++; else helmNoModel++; if (ir !== undefined && idi.int(ir, "HelmetGeosetVisID", 0) + idi.int(ir, "HelmetGeosetVisID", 1) > 0) helmVis++; }
  if (s > 0) { const ir = idiRow.get(s); if (ir !== undefined && (idi.string(ir, "ModelName", 0) || idi.string(ir, "ModelName", 1))) shModel++; else shNoModel++; }
}
console.log(`helm display resolves to a model: ${helmModel}, no model ${helmNoModel}, with helmet geoset-vis ${helmVis}; shoulder model ${shModel}, none ${shNoModel}`);
// --- CreatureDisplayInfo extra columns.
let alpha = 0, alphaZero = 0, geo = 0, part = 0, fx = 0, alphaVals = new Map(), geoVals = new Map();
for (const r of disp.rows()) {
  const a = disp.int(r, "CreatureModelAlpha");
  if (a !== 255) { alpha++; alphaVals.set(a, (alphaVals.get(a) ?? 0) + 1); }
  if (a === 0) alphaZero++;
  const g = disp.int(r, "CreatureGeosetData"); if (g !== 0) { geo++; geoVals.set(g, (geoVals.get(g) ?? 0) + 1); }
  if (disp.int(r, "ParticleColorID") > 0) part++;
  if (disp.int(r, "ObjectEffectPackageID") > 0) fx++;
}
console.log(`CreatureDisplayInfo rows=${disp.records} alpha!=255: ${alpha} (zero ${alphaZero}) top: ${[...alphaVals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}x${v}`).join(" ")}; geosetData!=0: ${geo} top: ${[...geoVals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}x${v}`).join(" ")}; particleColor>0: ${part}; objectEffectPackage>0: ${fx}`);
// --- ItemDisplayInfo.ItemVisual and ParticleColorID.
let iv = 0, ivIds = new Map(), pc = 0;
for (const r of idi.rows()) { const v = idi.int(r, "ItemVisual"); if (v > 0) { iv++; ivIds.set(v, (ivIds.get(v) ?? 0) + 1); } if (idi.int(r, "ParticleColorID") > 0) pc++; }
console.log(`ItemDisplayInfo rows=${idi.records} withItemVisual=${iv} distinct=${ivIds.size} withParticleColor=${pc}`);
// --- Item.dbc: ranged weapons by subclass x inventory type x sheathe type.
const hist = new Map();
for (const r of item.rows()) {
  if (item.int(r, "ClassID") !== 2) continue;
  const sub = item.int(r, "SubclassID"); if (![2, 3, 16, 18, 19].includes(sub)) continue;
  const key = `sub${sub}:inv${item.int(r, "InventoryType")}:sheathe${item.int(r, "SheatheType")}`;
  hist.set(key, (hist.get(key) ?? 0) + 1);
}
console.log("ranged weapon rows:", [...hist.entries()].sort().map(([k, v]) => `${k}x${v}`).join(" "));
// --- Emotes.dbc: rows whose AnimID is a loop-able state. Print count and a few.
const st = [];
for (const r of emotes.rows()) { if (emotes.int(r, "EmoteFlags") !== 0 || emotes.int(r, "EmoteSpecProc") !== 0) st.push(`${emotes.id(r)}:anim${emotes.int(r, "AnimID")}f${emotes.int(r, "EmoteFlags")}p${emotes.int(r, "EmoteSpecProc")}`); }
console.log(`Emotes rows=${emotes.records}; with flags/specProc=${st.length}:`, st.slice(0, 60).join(" "));
