import { openRaw } from "file:///C:/Users/ADMINI~1/AppData/Local/Temp/claude/F--tswowRoot-WebClient/8691de39-2c7d-46b9-bb55-f8d1b969e99a/scratchpad/impl/A7a/raw.mjs";
const m = openRaw("SpellMissileMotion");
const want = new Set([13, 224, 38, 361, 501, 23, 362, 19, 20]);
for (let r = 0; r < m.records; r++) {
  const id = m.int(r, 0);
  if (want.has(id)) console.log(id, JSON.stringify(m.str(r, 1)), "flags", m.int(r, 3), "count", m.int(r, 4), "\n   ", JSON.stringify(m.str(r, 2)).slice(0, 700));
}
const flags = new Map(); for (let r = 0; r < m.records; r++) { const f = m.int(r, 3); flags.set(f, (flags.get(f) ?? 0) + 1); }
console.log("motion flags", [...flags.entries()].map(([k, v]) => `${k}x${v}`).join(" "));
const counts = new Map(); for (let r = 0; r < m.records; r++) { const f = m.int(r, 4); counts.set(f, (counts.get(f) ?? 0) + 1); }
console.log("missileCount", [...counts.entries()].map(([k, v]) => `${k}x${v}`).join(" "));
