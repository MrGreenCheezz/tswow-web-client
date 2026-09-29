import { openRaw } from "file:///C:/Users/ADMINI~1/AppData/Local/Temp/claude/F--tswowRoot-WebClient/8691de39-2c7d-46b9-bb55-f8d1b969e99a/scratchpad/impl/A7a/raw.mjs";
import { openDbcFile } from "file:///F:/tswowRoot/WebClient/tools/dbc.mjs";
import { dbcDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";
const dir = dbcDirectory();
const kit = openRaw("SpellVisualKit");
// Per-proc parameter census: params are col 21..36 (Zero 21..24, One 25..28, Two 29..32, Three 33..36); slot i uses [21+i, 25+i, 29+i, 33+i].
const byProc = new Map();
for (let r = 0; r < kit.records; r++) {
  for (let slot = 0; slot < 4; slot++) {
    const p = kit.int(r, 17 + slot);
    if (p <= 0) continue;
    const params = [0, 1, 2, 3].map((k) => kit.float(r, 21 + 4 * k + slot));
    const e = byProc.get(p) ?? { n: 0, samples: [], ranges: [[1e9, -1e9], [1e9, -1e9], [1e9, -1e9], [1e9, -1e9]] };
    e.n++;
    params.forEach((v, k) => { e.ranges[k][0] = Math.min(e.ranges[k][0], v); e.ranges[k][1] = Math.max(e.ranges[k][1], v); });
    if (e.samples.length < 3) e.samples.push(`kit${kit.int(r, 0)}s${slot}:[${params.map((v) => +v.toFixed(3)).join(",")}]`);
    byProc.set(p, e);
  }
}
for (const [p, e] of [...byProc.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`CharProc ${p}: uses=${e.n} ranges=${e.ranges.map((r) => `${+r[0].toFixed(2)}..${+r[1].toFixed(2)}`).join(" ")} e.g. ${e.samples.join(" ")}`);
}
// Known channel/chain spells: Drain Life 689, Mind Flay 15407, Chain Lightning 421, Drain Mana 5138, Drain Soul 1120, Life Tap 1454, Siphon Life 63106.
const spell = await openDbcFile(dir, "Spell");
const sv = openRaw("SpellVisual");
const svRow = new Map(); for (let r = 0; r < sv.records; r++) svRow.set(sv.int(r, 0), r);
const kitRow = new Map(); for (let r = 0; r < kit.records; r++) kitRow.set(kit.int(r, 0), r);
const ve = openRaw("SpellVisualEffectName");
const veRow = new Map(); for (let r = 0; r < ve.records; r++) veRow.set(ve.int(r, 0), r);
const kitDesc = (id) => {
  const r = kitRow.get(id); if (r === undefined) return `kit${id}?`;
  const eff = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((c) => kit.int(r, c)).map((e, i) => e > 0 ? `${["head", "chest", "base", "lhand", "rhand", "breath", "lweap", "rweap", "sp0", "sp1", "sp2", "world"][i]}=${e}(${(ve.str(veRow.get(e) ?? 0, 2) || "").split("\\").pop()})` : "").filter(Boolean).join(" ");
  const procs = [0, 1, 2, 3].map((s) => kit.int(r, 17 + s)).map((p, s) => p > 0 ? `proc${p}[${[0, 1, 2, 3].map((k) => +kit.float(r, 21 + 4 * k + s).toFixed(2)).join(",")}]` : "").filter(Boolean).join(" ");
  return `kit${id}: anim(${kit.int(r, 1)},${kit.int(r, 2)}) ${eff} shake=${kit.int(r, 16)} ${procs}`;
};
for (const [name, id] of [["Drain Life", 689], ["Mind Flay", 15407], ["Chain Lightning", 421], ["Drain Mana", 5138], ["Drain Soul", 1120], ["Siphon Life", 63106], ["Health Funnel", 755]]) {
  let row;
  for (const r of spell.rows()) if (spell.id(r) === id) { row = r; break; }
  if (row === undefined) { console.log(name, "no row"); continue; }
  const vis = spell.int(row, "SpellVisualID", 0);
  const v = svRow.get(vis);
  console.log(`${name} (${id}): SpellVisualID=${vis} missileID=${spell.int(row, "SpellMissileID")}`);
  if (v === undefined) continue;
  const labels = ["Precast", "Cast", "Impact", "State", "StateDone", "Channel"];
  for (let i = 0; i < 6; i++) { const k = sv.int(v, 1 + i); if (k > 0) console.log("   ", labels[i], kitDesc(k)); }
  console.log(`    missileModel=${sv.str(v, 8)} motion=${sv.int(v, 21)} path=${sv.int(v, 9)} destAttach=${sv.int(v, 10)} attach=${sv.int(v, 16)} flags=${sv.int(v, 13)}`);
}
