// A7a: settle SpellVisual.MissileDestinationAttachment against the kit column the impact effect sits in,
// and check Spell.SpellVisualID[1] for the channel/beam spells. Read-only.
import { openDbcFile } from "file:///F:/tswowRoot/WebClient/tools/dbc.mjs";
import { dbcDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";
import { openRaw } from "file:///C:/Users/ADMINI~1/AppData/Local/Temp/claude/F--tswowRoot-WebClient/8691de39-2c7d-46b9-bb55-f8d1b969e99a/scratchpad/impl/A7a/raw.mjs";

const sv = openRaw("SpellVisual");
const kit = openRaw("SpellVisualKit");
const kitRow = new Map();
for (let r = 0; r < kit.records; r++) kitRow.set(kit.int(r, 0), r);
// Kit effect columns: 3 head, 4 chest, 5 base, 6 lhand, 7 rhand, 8 breath, 9 lweapon, 10 rweapon, 11-13 special, 14 world.
const names = ["head", "chest", "base", "lhand", "rhand", "breath", "lweapon", "rweapon", "sp0", "sp1", "sp2", "world"];
const shape = (kitId) => {
  const r = kitRow.get(kitId);
  if (r === undefined) return "none";
  const used = names.filter((_, i) => kit.int(r, 3 + i) > 0);
  return used.length === 0 ? "none" : used.join("+");
};
const table = new Map();
for (let r = 0; r < sv.records; r++) {
  if (sv.int(r, 7) === 0) continue; // HasMissile
  const dest = sv.int(r, 10);
  const impact = sv.int(r, 3) > 0 ? shape(sv.int(r, 3)) : (sv.int(r, 15) > 0 ? `t:${shape(sv.int(r, 15))}` : "noimpact");
  const key = `${impact}`;
  const row = table.get(key) ?? new Map();
  row.set(dest, (row.get(dest) ?? 0) + 1);
  table.set(key, row);
}
const top = [...table.entries()].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0)).slice(0, 10);
console.log("missile visuals: impact-kit shape -> MissileDestinationAttachment histogram");
for (const [shapeName, hist] of top) console.log(`  ${shapeName}: ${[...hist.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => `dest${d}x${n}`).join(" ")}`);

const dir = dbcDirectory();
const spell = await openDbcFile(dir, "Spell");
for (const id of [689, 15407, 421, 5138, 1120, 755, 5740, 10, 42833, 133]) {
  for (const r of spell.rows()) {
    if (spell.id(r) !== id) continue;
    const v0 = spell.int(r, "SpellVisualID", 0), v1 = spell.int(r, "SpellVisualID", 1);
    const info = (v) => {
      if (!v) return "-";
      const row = [...Array(sv.records).keys()].find((i) => sv.int(i, 0) === v);
      if (row === undefined) return `${v}?`;
      const kits = [1, 2, 3, 4, 5, 6].map((c) => sv.int(row, c)).map((k, i) => k > 0 ? `${["pre", "cast", "imp", "state", "done", "chan"][i]}:${k}` : "").filter(Boolean).join(",");
      return `${v}[${kits}] missile=${sv.int(row, 7)} motion=${sv.int(row, 21)} dest=${sv.int(row, 10)} att=${sv.int(row, 16)}`;
    };
    console.log(`spell ${id}: vis0=${info(v0)} | vis1=${info(v1)} | speed=${spell.float(r, "Speed")} missileId=${spell.int(r, "SpellMissileID")}`);
    break;
  }
}
