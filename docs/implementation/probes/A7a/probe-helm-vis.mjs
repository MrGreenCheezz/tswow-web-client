// A7a 6.01 census (05.10): NPC helm displays without a model — do they still carry HelmetGeosetVisID?
// Reads the dataset DBCs and lists Item\ObjectComponents\Head in the F:/Circle MPQ chain. No servers.
import { openDbcFile } from "file:///F:/tswowRoot/WebClient/tools/dbc.mjs";
import { dbcDirectory, clientDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";
import { clientArchives } from "file:///F:/tswowRoot/WebClient/tools/mpq.mjs";

const dir = dbcDirectory();
const extra = await openDbcFile(dir, "CreatureDisplayInfoExtra");
const disp = await openDbcFile(dir, "CreatureDisplayInfo");
const idi = await openDbcFile(dir, "ItemDisplayInfo");
const races = await openDbcFile(dir, "ChrRaces");
const vis = await openDbcFile(dir, "HelmetGeosetVisData");

const prefix = new Map();
for (const r of races.rows()) prefix.set(races.id(r), races.string(r, "ClientPrefix"));
const visRow = new Map();
for (const r of vis.rows()) visRow.set(vis.id(r), [0, 1, 2, 3, 4, 5, 6].map((c) => vis.int(r, "HideGeoset", c)));
const idiRow = new Map();
for (const r of idi.rows()) idiRow.set(idi.id(r), r);
const uses = new Map();
for (const r of disp.rows()) { const e = disp.int(r, "ExtendedDisplayInfoID"); if (e > 0) uses.set(e, (uses.get(e) ?? 0) + 1); }

const archives = await clientArchives(clientDirectory());
const headFiles = new Set([...(await archives.list("Item\\ObjectComponents\\Head\\"))].map((p) => p.toLowerCase().replaceAll("/", "\\")));
console.log("Head files in MPQ:", headFiles.size);

const c = {
  helmRows: 0, noName: 0, noNameDangling: 0, noNameVis: 0, noNameVisHides: 0, noNameVisHidesUsed: 0, noNameVisDisplays: 0,
  named: 0, namedFileFound: 0, namedFileMissing: 0, namedMissingVisHides: 0,
};
const missingExamples = [];
const noNameVisValues = new Map();
for (const r of extra.rows()) {
  const helm = extra.int(r, "NPCItemDisplay", 0);
  if (helm <= 0) continue;
  c.helmRows++;
  const race = extra.int(r, "DisplayRaceID"), sex = extra.int(r, "DisplaySexID");
  const ir = idiRow.get(helm);
  const name = ir === undefined ? "" : idi.string(ir, "ModelName", 0);
  const visId = ir === undefined ? 0 : idi.int(ir, "HelmetGeosetVisID", sex === 1 ? 1 : 0);
  const row = visRow.get(visId);
  const hides = row !== undefined && row.some((mask) => (mask & (1 << race)) !== 0);
  const used = uses.get(extra.id(r)) ?? 0;
  if (!name) {
    c.noName++;
    if (ir === undefined) c.noNameDangling++;
    if (visId !== 0) { c.noNameVis++; noNameVisValues.set(visId, (noNameVisValues.get(visId) ?? 0) + 1); }
    if (hides) { c.noNameVisHides++; if (used) { c.noNameVisHidesUsed++; c.noNameVisDisplays += used; } }
    continue;
  }
  c.named++;
  const stem = name.replace(/\.(mdx|m2)$/i, "");
  const path = `item\\objectcomponents\\head\\${stem}_${prefix.get(race) ?? "Hu"}${sex === 1 ? "F" : "M"}.m2`.toLowerCase();
  if (headFiles.has(path)) c.namedFileFound++;
  else { c.namedFileMissing++; if (hides) c.namedMissingVisHides++; if (missingExamples.length < 8) missingExamples.push(`${extra.id(r)}:${path.split("\\").pop()}`); }
}
console.log(JSON.stringify(c));
console.log("no-name helm rows by HelmetGeosetVisID:", [...noNameVisValues].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join(" "));
console.log("named helms whose race/sex file is missing (examples):", missingExamples.join(" "));
