// A7a: shapes of the spell/effect tables the line needs, and how they are referenced. Read-only.
import { openRaw, head, dump } from "file:///C:/Users/ADMINI~1/AppData/Local/Temp/claude/F--tswowRoot-WebClient/8691de39-2c7d-46b9-bb55-f8d1b969e99a/scratchpad/impl/A7a/raw.mjs";

for (const name of ["SpellMissile", "SpellMissileMotion", "SpellChainEffects", "SpellEffectCameraShakes", "CameraShakes",
  "ItemVisuals", "ItemVisualEffects", "ParticleColor", "VehicleSeat", "SpellVisualKit", "SpellVisual", "SpellVisualEffectName"]) {
  const t = openRaw(name);
  console.log(head(t));
  for (let r = 0; r < Math.min(3, t.records); r++) console.log("   row", r, dump(t, r, Math.min(t.fields, 60)));
}

// SpellVisual.MissileMotion / MissilePathType / MissileFollowGround usage.
const sv = openRaw("SpellVisual");
const hist = (col, label) => {
  const m = new Map();
  for (let r = 0; r < sv.records; r++) { const v = sv.int(r, col); m.set(v, (m.get(v) ?? 0) + 1); }
  const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => `${v}x${n}`).join(" ");
  console.log(`SpellVisual.${label} (col ${col}): distinct=${m.size} top: ${top}`);
};
hist(7, "HasMissile"); hist(9, "MissilePathType"); hist(10, "MissileDestinationAttachment"); hist(16, "MissileAttachment");
hist(17, "MissileFollowGroundHeight(int view)"); hist(20, "MissileFollowGroundFlags"); hist(21, "MissileMotion"); hist(22, "MissileTargetingKit");
let withMotion = 0, withModel = 0, withOffsets = 0;
for (let r = 0; r < sv.records; r++) {
  if (sv.int(r, 21) > 0) withMotion++;
  if (sv.int(r, 8) > 0 || sv.str(r, 8)) withModel++;
  if (sv.float(r, 26) !== 0 || sv.float(r, 27) !== 0 || sv.float(r, 28) !== 0 || sv.float(r, 29) !== 0 || sv.float(r, 30) !== 0 || sv.float(r, 31) !== 0) withOffsets++;
}
console.log(`SpellVisual rows=${sv.records} withMissileMotion=${withMotion} withMissileModelString=${withModel} withCastOrImpactOffset=${withOffsets}`);

// SpellVisualKit.ShakeID (col 16) and CharProc[4] (cols 17..20).
const kit = openRaw("SpellVisualKit");
const shakeIds = new Map();
const procIds = new Map();
let kitsWithProc = 0;
for (let r = 0; r < kit.records; r++) {
  const s = kit.int(r, 16);
  if (s > 0) shakeIds.set(s, (shakeIds.get(s) ?? 0) + 1);
  let any = false;
  for (let c = 17; c <= 20; c++) { const p = kit.int(r, c); if (p > 0) { procIds.set(p, (procIds.get(p) ?? 0) + 1); any = true; } }
  if (any) kitsWithProc++;
}
console.log(`SpellVisualKit rows=${kit.records} kitsWithShake=${[...shakeIds.values()].reduce((a, b) => a + b, 0)} distinctShakeIds=${shakeIds.size}`);
console.log(`  kitsWithCharProc=${kitsWithProc} distinct procs: ${[...procIds.entries()].map(([k, v]) => `${k}x${v}`).join(" ")}`);
console.log(`  shake ids: ${[...shakeIds.entries()].slice(0, 30).map(([k, v]) => `${k}x${v}`).join(" ")}`);
