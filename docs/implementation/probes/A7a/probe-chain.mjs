import { openRaw } from "file:///C:/Users/ADMINI~1/AppData/Local/Temp/claude/F--tswowRoot-WebClient/8691de39-2c7d-46b9-bb55-f8d1b969e99a/scratchpad/impl/A7a/raw.mjs";
const ve = openRaw("SpellVisualEffectName");
const ext = new Map();
const odd = [];
for (let r = 0; r < ve.records; r++) {
  const f = ve.str(r, 2); const m = /\.([A-Za-z0-9]+)$/.exec(f); const e = m ? m[1].toLowerCase() : "(none)";
  ext.set(e, (ext.get(e) ?? 0) + 1);
  if (!/\.(mdx|mdl|m2)$/i.test(f) && odd.length < 12) odd.push(`${ve.int(r, 0)}:${ve.str(r, 1)}|${f}`);
}
console.log("SpellVisualEffectName file extensions:", [...ext.entries()].map(([k, v]) => `${k}x${v}`).join(" "));
console.log("non-model rows:", odd.join(" ; "));
const names = [];
for (let r = 0; r < ve.records; r++) { const n = ve.str(r, 1); if (/chain|beam|lightning|drain|siphon|tether/i.test(n) && names.length < 25) names.push(`${ve.int(r, 0)}:${n}|${ve.str(r, 2)}`); }
console.log("named chain-ish:", names.join(" ; "));
// SpellChainEffects: list ids and the model names in the string columns 7, 40, 43, 44 (only printable ones).
const ce = openRaw("SpellChainEffects");
const rows = [];
for (let r = 0; r < Math.min(ce.records, 935); r++) {
  const id = ce.int(r, 0);
  const s7 = ce.str(r, 7);
  const w = ce.float(r, 2);
  if ([1, 2, 3, 4, 5, 20, 40, 100, 200, 300, 400, 500, 600, 700, 800, 900].includes(id) || rows.length < 0) rows.push(`${id}:w${w.toFixed(2)}|${s7.split("\\").pop()}`);
}
console.log("chain sample:", rows.join(" ; "));
const flags = new Map(); for (let r = 0; r < ce.records; r++) { const f = ce.int(r, 8); flags.set(f, (flags.get(f) ?? 0) + 1); }
console.log("chain col8 (flags?)", [...flags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}x${v}`).join(" "));
// Find which table refers to SpellChainEffects ids: look at SpellVisualKit special effects and SpellVisual missile model for numeric ids in range.
const ids = new Set(); for (let r = 0; r < ce.records; r++) ids.add(ce.int(r, 0));
console.log("chain id range", Math.min(...ids), Math.max(...ids), "count", ids.size);
const sk = openRaw("SpellVisualKit");
// SpellVisualEffectName.Name strings that look like "ChainEffect"? Print those whose filename is empty.
let empty = 0; const emptyNames = [];
for (let r = 0; r < ve.records; r++) if (!ve.str(r, 2)) { empty++; if (emptyNames.length < 10) emptyNames.push(`${ve.int(r, 0)}:${ve.str(r, 1)}`); }
console.log("effect names with empty file", empty, emptyNames.join(" ; "));
