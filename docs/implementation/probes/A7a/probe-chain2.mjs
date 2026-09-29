import { openRaw } from "file:///C:/Users/ADMINI~1/AppData/Local/Temp/claude/F--tswowRoot-WebClient/8691de39-2c7d-46b9-bb55-f8d1b969e99a/scratchpad/impl/A7a/raw.mjs";
import { readdirSync } from "node:fs";
import { DBC_DIR } from "file:///C:/Users/ADMINI~1/AppData/Local/Temp/claude/F--tswowRoot-WebClient/8691de39-2c7d-46b9-bb55-f8d1b969e99a/scratchpad/impl/A7a/raw.mjs";
const ce = openRaw("SpellChainEffects");
const chainIds = new Set(); for (let r = 0; r < ce.records; r++) chainIds.add(ce.int(r, 0));
const tex = new Map(); for (let r = 0; r < ce.records; r++) tex.set(ce.int(r, 0), ce.str(r, 7).split("\\").pop());
// Brute force: for every DBC, every int column whose nonzero values are all chain ids and that has >= 5 nonzero rows.
const out = [];
for (const f of readdirSync(DBC_DIR).filter((n) => n.endsWith(".dbc"))) {
  const name = f.slice(0, -4);
  if (name === "SpellChainEffects") continue;
  let t; try { t = openRaw(name); } catch { continue; }
  if (t.records < 5 || t.recordSize % 4 !== 0 || t.records > 200000) continue;
  for (let c = 1; c * 4 + 4 <= t.recordSize; c++) {
    let nz = 0, hit = 0, big = 0;
    for (let r = 0; r < t.records; r++) {
      const v = t.int(r, c);
      if (v === 0) continue;
      nz++;
      if (chainIds.has(v)) hit++; else big++;
      if (big > 0 && nz > 8 && hit / nz < 0.9) break;
    }
    if (nz >= 5 && hit === nz && hit >= 5) out.push(`${name}.col${c}: nonzero=${nz} allChainIds`);
  }
}
console.log(out.join("\n") || "no table has a column whose nonzero values are all chain ids");
// Candidate: the chain textures of Drain-like rows.
const want = [];
for (const [id, tx] of tex) if (/drain|life|soul|mana|heal|beam/i.test(tx) && want.length < 30) want.push(`${id}:${tx}`);
console.log("candidates:", want.join(" "));
