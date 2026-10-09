// A7a 6.13 census (05.10): SpellChainEffects layout ranges over all rows (177-byte record = 39 dwords,
// 5 bytes, 4 unaligned dwords), and where the Drain Life / Mind Flay / Drain Mana / Drain Soul /
// Chain Lightning beam comes from (kits, CharProc, SpellVisualKitModelAttach, funnel models).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDbcFile } from "file:///F:/tswowRoot/WebClient/tools/dbc.mjs";
import { dbcDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";
import { openRaw, DBC_DIR } from "./raw.mjs";
import { archives } from "./corpus.mjs";

// --- Layout check.
const NAMES = ["ID", "AvgSegLen", "Width", "NoiseScale", "TexCoordScale", "SegDuration", "SegDelay", "Texture", "Flags",
  "JointCount", "JointOffsetRadius", "JointsPerMinorJoint", "MinorJointsPerMajorJoint", "MinorJointScale", "MajorJointScale",
  "JointMoveSpeed", "JointSmoothness", "MinDurationBetweenJoints", "MaxDurationBetweenJoints", "WaveHeight", "WaveFreq",
  "WaveSpeed", "MinWaveAngle", "MaxWaveAngle", "MinWaveSpin", "MaxWaveSpin", "ArcHeight", "MinArcAngle", "MaxArcAngle",
  "MinArcSpin", "MaxArcSpin", "DelayBetweenEffects", "MinFlickerOnDuration", "MaxFlickerOnDuration", "MinFlickerOffDuration",
  "MaxFlickerOffDuration", "PulseSpeed", "PulseOnLength", "PulseFadeLength"];
const data = readFileSync(join(DBC_DIR, "SpellChainEffects.dbc"));
const records = data.readUInt32LE(4), fields = data.readUInt32LE(8), recordSize = data.readUInt32LE(12), stringsSize = data.readUInt32LE(16);
const strings = 20 + records * recordSize;
console.log(`SpellChainEffects records=${records} fields=${fields} recordSize=${recordSize} strings=${stringsSize}`);
const columns = [];
for (let c = 0; c < 39; c++) columns.push({ name: NAMES[c], at: c * 4, size: 4 });
for (const [i, n] of ["Alpha", "Red", "Green", "Blue", "BlendMode"].entries()) columns.push({ name: n, at: 156 + i, size: 1 });
for (const [i, n] of ["Combo(161)", "RenderLayer(165)", "TextureLength(169)", "WavePhase(173)"].entries()) columns.push({ name: n, at: 161 + i * 4, size: 4 });
const isString = (v) => v > 0 && v < stringsSize && (v === 0 || data[strings + v - 1] === 0);
for (const col of columns) {
  let nz = 0, iMin = Infinity, iMax = -Infinity, fMin = Infinity, fMax = -Infinity, strs = 0, floaty = 0;
  const vals = new Map();
  for (let r = 0; r < records; r++) {
    const at = 20 + r * recordSize + col.at;
    const i = col.size === 1 ? data.readUInt8(at) : data.readInt32LE(at);
    if (i !== 0) nz++;
    iMin = Math.min(iMin, i); iMax = Math.max(iMax, i);
    vals.set(i, (vals.get(i) ?? 0) + 1);
    if (col.size === 4) {
      const f = data.readFloatLE(at);
      if (i !== 0) { fMin = Math.min(fMin, f); fMax = Math.max(fMax, f); if (Math.abs(f) > 1e-6 && Math.abs(f) < 1e6 && Math.abs(i) > 0xffffff) floaty++; }
      if (i !== 0 && isString(i)) strs++;
    }
  }
  const topVals = [...vals].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => {
    if (col.size === 4 && Math.abs(k) > 0xffffff) { const b = Buffer.alloc(4); b.writeInt32LE(k); return `${+b.readFloatLE(0).toFixed(3)}fx${v}`; }
    return `${k}x${v}`;
  }).join(" ");
  const kind = col.size === 1 ? "u8" : floaty > nz / 2 ? "float" : strs === nz && nz > 0 ? "string" : "int";
  console.log(`${col.name.padEnd(26)} ${kind.padEnd(6)} nonzero=${String(nz).padStart(3)} ${kind === "float" ? `f[${fMin.toFixed(3)}..${fMax.toFixed(3)}]` : `i[${iMin}..${iMax}]`} top: ${topVals}`);
}
const blend = new Map(), comboStr = new Map();
for (let r = 0; r < records; r++) {
  const b = data.readUInt8(20 + r * recordSize + 160); blend.set(b, (blend.get(b) ?? 0) + 1);
  const s = data.readInt32LE(20 + r * recordSize + 161);
  if (s > 0 && s < stringsSize) { const t = data.subarray(strings + s, data.indexOf(0, strings + s)).toString("latin1"); comboStr.set(t, (comboStr.get(t) ?? 0) + 1); }
}
console.log("BlendMode histogram:", [...blend].map(([k, v]) => `${k}x${v}`).join(" "));
console.log("dword@161 read as string:", [...comboStr].slice(0, 6).map(([k, v]) => `"${k}"x${v}`).join(" ") || "(none)");

// --- Beam origin.
const dir = dbcDirectory();
const spell = await openDbcFile(dir, "Spell");
const sv = openRaw("SpellVisual"), kit = openRaw("SpellVisualKit"), ve = openRaw("SpellVisualEffectName"), ma = openRaw("SpellVisualKitModelAttach");
const svRow = new Map(); for (let r = 0; r < sv.records; r++) svRow.set(sv.int(r, 0), r);
const kitRow = new Map(); for (let r = 0; r < kit.records; r++) kitRow.set(kit.int(r, 0), r);
const veRow = new Map(); for (let r = 0; r < ve.records; r++) veRow.set(ve.int(r, 0), r);
const attachByKit = new Map();
for (let r = 0; r < ma.records; r++) { const k = ma.int(r, 1); const l = attachByKit.get(k) ?? []; l.push(r); attachByKit.set(k, l); }
const KIT_COLS = { 1: "pre", 2: "cast", 3: "imp", 4: "state", 5: "done", 6: "chan", 14: "casterImp", 15: "targetImp", 22: "missileTarget", 23: "instantArea", 24: "impactArea", 25: "persistArea" };
const EFFECT_COLS = ["head", "chest", "base", "lhand", "rhand", "breath", "lweapon", "rweapon", "sp0", "sp1", "sp2", "world"];
const effectName = (id) => { const r = veRow.get(id); return r === undefined ? `${id}?` : `${ve.str(r, 1)}|${ve.str(r, 2).split("\\").pop()}`; };
const funnelFiles = new Set();
const spellRow = new Map(); for (const r of spell.rows()) spellRow.set(spell.id(r), r);
for (const id of [689, 15407, 5138, 1120, 421]) {
  const r = spellRow.get(id);
  const vis = [0, 1].map((i) => spell.int(r, "SpellVisualID", i));
  console.log(`\nspell ${id} "${spell.string(r, "Name_lang")}" visuals ${vis.join(",")}`);
  for (const v of vis) {
    const vr = svRow.get(v); if (!v || vr === undefined) continue;
    for (const [c, label] of Object.entries(KIT_COLS)) {
      const k = sv.int(vr, Number(c)); if (k <= 0) continue;
      const kr = kitRow.get(k); if (kr === undefined) { console.log(`  ${label}:${k} (missing)`); continue; }
      const effects = EFFECT_COLS.map((n, i) => [n, kit.int(kr, 3 + i)]).filter(([, e]) => e > 0).map(([n, e]) => { const er = veRow.get(e); if (er !== undefined) funnelFiles.add(ve.str(er, 2)); return `${n}=${effectName(e)}`; });
      const procs = [0, 1, 2, 3].map((s) => kit.int(kr, 17 + s)).filter((p) => p >= 0);
      const attach = (attachByKit.get(k) ?? []).map((ar) => { const er = veRow.get(ma.int(ar, 2)); if (er !== undefined) funnelFiles.add(ve.str(er, 2)); return `attach${ma.int(ar, 3)}:${effectName(ma.int(ar, 2))} off(${[4, 5, 6].map((x) => +ma.float(ar, x).toFixed(2)).join(",")})`; });
      console.log(`  ${label}:${k} effects[${effects.join("; ")}] procs[${procs.join(",")}] modelAttach[${attach.join("; ")}]`);
    }
  }
}
// What the named models carry: ribbons/particles, bounds extent along the axes.
const chain = await archives();
console.log("\nmodels of those kits:");
for (const f of funnelFiles) {
  const path = f.replace(/\.(mdx|mdl)$/i, ".m2");
  try {
    const m = await chain.read(path);
    const n = (at) => m.readUInt32LE(at);
    const box = [0, 1, 2, 3, 4, 5].map((i) => m.readFloatLE(0xa0 + i * 4));
    console.log(`  ${path}: vertices ${n(0x3c)} ribbons ${n(0x120)} particles ${n(0x128)} bones ${n(0x2c)} box x[${box[0].toFixed(1)}..${box[3].toFixed(1)}] y[${box[1].toFixed(1)}..${box[4].toFixed(1)}] z[${box[2].toFixed(1)}..${box[5].toFixed(1)}]`);
  } catch { console.log(`  ${path}: not readable`); }
}
// Any kit at all with CharProc 12 among the visuals of spells whose name says drain/flay/funnel?
const ce = openRaw("SpellChainEffects");
const beamTex = new Map(); for (let r = 0; r < ce.records; r++) beamTex.set(ce.int(r, 0), ce.str(r, 7).split("\\").pop());
let proc12Kits = 0; const texUse = new Map();
for (let r = 0; r < kit.records; r++) for (let s = 0; s < 4; s++) if (kit.int(r, 17 + s) === 12) { proc12Kits++; const t = beamTex.get(Math.round(kit.float(r, 21 + s))) ?? "?"; texUse.set(t, (texUse.get(t) ?? 0) + 1); }
console.log(`\nCharProc 12 slots: ${proc12Kits}; their chain textures: ${[...texUse].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join(" ")}`);
