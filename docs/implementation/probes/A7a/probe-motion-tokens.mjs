import { openRaw } from "file:///C:/Users/ADMINI~1/AppData/Local/Temp/claude/F--tswowRoot-WebClient/8691de39-2c7d-46b9-bb55-f8d1b969e99a/scratchpad/impl/A7a/raw.mjs";
import { readFileSync } from "node:fs";
const m = openRaw("SpellMissileMotion");
const idents = new Map(); const kw = new Map(); let maxLen = 0, lines = 0;
const assigned = new Map();
for (let r = 0; r < m.records; r++) {
  const body = m.str(r, 2); maxLen = Math.max(maxLen, body.length); lines += body.split(/\r?\n/).length;
  for (const tok of body.matchAll(/[A-Za-z_][A-Za-z_0-9]*/g)) {
    const t = tok[0];
    if (["local", "if", "then", "else", "elseif", "end", "for", "while", "do", "function", "return", "and", "or", "not"].includes(t)) kw.set(t, (kw.get(t) ?? 0) + 1);
    else idents.set(t, (idents.get(t) ?? 0) + 1);
  }
  for (const a of body.matchAll(/^\s*(?!local\b)([A-Za-z_][A-Za-z_0-9]*)\s*=/gm)) assigned.set(a[1], (assigned.get(a[1]) ?? 0) + 1);
}
console.log("scripts", m.records, "maxLen", maxLen, "totalLines", lines);
console.log("keywords", [...kw.entries()].map(([k, v]) => `${k}x${v}`).join(" "));
console.log("outputs (assigned, non-local):", [...assigned.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join(" "));
const std = new Set(["sin", "cos", "abs", "sqrt", "min", "max", "floor", "ceil", "random", "tan", "atan", "asin", "acos", "mod", "pow", "exp", "log", "atan2", "deg", "rad", "pi", "math", "fmod"]);
console.log("identifiers (all, count):", [...idents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([k, v]) => `${k}${std.has(k) ? "()" : ""}x${v}`).join(" "));
// Is there a Wow exe to grep the input variable names from?
for (const p of ["F:/Circle/Wow.exe.clean", "F:/Circle/Wow.exe", "F:/Circle/CleanWow.exe"]) {
  try {
    const exe = readFileSync(p).toString("latin1");
    const found = new Set();
    for (const mm of exe.matchAll(/[ -~]{5,120}/g)) {
      const s = mm[0];
      if (/startDistance|transMag|transAngle|missileIndex|missileCount|modelPitch|speedScalar|SpellChain|ChainEffect|CameraShake|CharProc|MissileMotion/i.test(s)) found.add(s);
    }
    console.log(p, "strings:", [...found].slice(0, 25).join(" || ") || "(none)");
    break;
  } catch { /* try next */ }
}
