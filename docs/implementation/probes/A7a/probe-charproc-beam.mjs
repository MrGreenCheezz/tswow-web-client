// A7a 6.13 census (05.10): CharProc 0 and 13 slots of SpellVisualKit — do their params name SpellChainEffects rows?
import { openRaw } from "./raw.mjs";
const kit = openRaw("SpellVisualKit"), ce = openRaw("SpellChainEffects");
const tex = new Map(); for (let r = 0; r < ce.records; r++) tex.set(ce.int(r, 0), ce.str(r, 7).split("\\").pop());
for (const want of [0, 12, 13]) {
  let slots = 0, chainHit = 0; const p0 = new Map(), p1 = new Map(), texUse = new Map(); const ex = [];
  for (let r = 0; r < kit.records; r++) for (let s = 0; s < 4; s++) {
    if (kit.int(r, 17 + s) !== want) continue;
    slots++;
    const params = [0, 1, 2, 3].map((k) => +kit.float(r, 21 + 4 * k + s).toFixed(3));
    p0.set(params[0], (p0.get(params[0]) ?? 0) + 1); p1.set(params[1], (p1.get(params[1]) ?? 0) + 1);
    const t = Number.isInteger(params[0]) ? tex.get(params[0]) : undefined;
    if (t) { chainHit++; texUse.set(t, (texUse.get(t) ?? 0) + 1); }
    if ([11762, 11744, 430, 950, 321, 282].includes(kit.int(r, 0))) ex.push(`kit${kit.int(r, 0)}[slot${s}] params=[${params}] chain=${t ?? "-"}`);
  }
  const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}x${v}`).join(" ");
  console.log(`CharProc ${want}: slots ${slots}; param0 is a SpellChainEffects ID in ${chainHit}; param0 top: ${top(p0)}; param1 top: ${top(p1)}`);
  console.log(`  chain textures: ${top(texUse)}`);
  if (ex.length) console.log(`  beam-spell kits: ${ex.join(" | ")}`);
}
