// A7a: small facts: Spell.SpellMissileID census, EmotesText 171 (/mountspecial), missile motion functions.
import { openDbcFile } from "file:///F:/tswowRoot/WebClient/tools/dbc.mjs";
import { dbcDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";
import { openRaw } from "file:///C:/Users/ADMINI~1/AppData/Local/Temp/claude/F--tswowRoot-WebClient/8691de39-2c7d-46b9-bb55-f8d1b969e99a/scratchpad/impl/A7a/raw.mjs";

const dir = dbcDirectory();
const spell = await openDbcFile(dir, "Spell");
let withMissile = 0, withVisual = 0;
const missileIds = new Map();
for (const r of spell.rows()) {
  const m = spell.int(r, "SpellMissileID");
  if (m > 0) { withMissile++; missileIds.set(m, (missileIds.get(m) ?? 0) + 1); }
  if (spell.int(r, "SpellVisualID", 0) > 0) withVisual++;
}
console.log(`Spell rows=${spell.records} withVisual=${withVisual} withSpellMissileID=${withMissile} distinctMissiles=${missileIds.size}`);

// EmotesText row 171 (MOUNTSPECIAL): raw columns.
const et = openRaw("EmotesText");
for (let r = 0; r < et.records; r++) {
  if (et.int(r, 0) === 171) {
    const cols = [];
    for (let c = 0; c < Math.min(et.fields, 20); c++) cols.push(`${c}:${et.int(r, c)}${et.int(r, c) > 0 && et.int(r, c) < et.stringsSize ? `"${et.str(r, c).slice(0, 24)}"` : ""}`);
    console.log("EmotesText 171:", cols.join(" "));
  }
}
const em = openRaw("Emotes");
for (let r = 0; r < em.records; r++) if (em.int(r, 0) === 94 || em.int(r, 0) === 171) console.log("Emotes", em.int(r, 0), "anim", em.int(r, 2), "flags", em.int(r, 3), "specProc", em.int(r, 4));

// Functions and constructs used by missile motion scripts.
const m = openRaw("SpellMissileMotion");
const fns = new Map();
let withFor = 0;
for (let r = 0; r < m.records; r++) {
  const body = m.str(r, 2);
  for (const f of body.matchAll(/([A-Za-z_][A-Za-z_0-9]*)\s*\(/g)) fns.set(f[1], (fns.get(f[1]) ?? 0) + 1);
  if (/\bfor\b/.test(body)) withFor++;
}
console.log("functions called in motion scripts:", [...fns.entries()].map(([k, v]) => `${k}x${v}`).join(" "), "| scripts with for:", withFor);
