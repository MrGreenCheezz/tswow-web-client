import { openRaw } from "file:///C:/Users/ADMINI~1/AppData/Local/Temp/claude/F--tswowRoot-WebClient/8691de39-2c7d-46b9-bb55-f8d1b969e99a/scratchpad/impl/A7a/raw.mjs";
import { openDbcFile } from "file:///F:/tswowRoot/WebClient/tools/dbc.mjs";
import { dbcDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";
const dir = dbcDirectory();
const kit = openRaw("SpellVisualKit"), sv = openRaw("SpellVisual"), ce = openRaw("SpellChainEffects");
const spell = await openDbcFile(dir, "Spell");
const chainTex = new Map(); for (let r = 0; r < ce.records; r++) chainTex.set(ce.int(r, 0), ce.str(r, 7).split("\\").pop());
const wantProc = Number(process.argv[2] ?? 12);
const kitsWith = new Map();
for (let r = 0; r < kit.records; r++) for (let s = 0; s < 4; s++) if (kit.int(r, 17 + s) === wantProc) kitsWith.set(kit.int(r, 0), [0, 1, 2, 3].map((k) => +kit.float(r, 21 + 4 * k + s).toFixed(2)));
// SpellVisual rows referencing those kits (cols 1..6, 14, 15, 23, 24, 25)
const visToKits = new Map();
for (let r = 0; r < sv.records; r++) for (const c of [1, 2, 3, 4, 5, 6, 14, 15, 22, 23, 24, 25]) { const k = sv.int(r, c); if (kitsWith.has(k)) { const e = visToKits.get(sv.int(r, 0)) ?? []; e.push(`${["", "precast", "cast", "impact", "state", "done", "channel"][c] || "c" + c}:${k}`); visToKits.set(sv.int(r, 0), e); } }
const rows = [];
for (const r of spell.rows()) {
  for (let i = 0; i < 2; i++) {
    const v = spell.int(r, "SpellVisualID", i);
    if (visToKits.has(v)) { rows.push(`${spell.id(r)} "${spell.string(r, "Name_lang")}" vis${v}[${i}] ${visToKits.get(v).join(",")}`); break; }
  }
}
console.log(`proc ${wantProc}: kits=${kitsWith.size} visuals=${visToKits.size} spells=${rows.length}`);
for (const line of rows.slice(0, 40)) {
  const m = / (channel|state|cast|precast|impact|done):(\d+)/.exec(line); const p = m ? kitsWith.get(Number(m[2])) : undefined;
  console.log(line, p ? `params=[${p}] chainTex=${chainTex.get(Math.round(p[0])) ?? "?"}` : "");
}
