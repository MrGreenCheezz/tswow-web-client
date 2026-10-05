// A7a 6.16а census (05.10-A7a-F1): batch colour/alpha/weight tracks of creatures and characters by sequence.
// What the slice needs settled: (1) does any Death sub-track end a batch at zero (a corpse fade), and how
// much of the model is that batch; (2) how many models move a batch track inside Stand (the desync bucket);
// (3) how many models paint a batch differently per played sequence at all.
// Usage: node probe-batch-seq.mjs [Creature\,Character\]
import { walkM2, family, inc, top } from "./corpus.mjs";
import { parseM2, m2Animations } from "file:///F:/tswowRoot/WebClient/tools/m2.mjs";

const DEATH = 1, STAND = 0;
const roots = (process.argv[2] ?? "Creature\\,Character\\").split(",");
let models = 0, moving0Models = 0, perSeqModels = 0, deathFadeModels = 0, deathFadeBatches = 0;
const deathFadeShare = [], examples = [], fam = new Map(), standMovers = [];

function lastValue(sub, component, width) {
  if (!sub || sub.times.length === 0) return undefined;
  return sub.values[(sub.times.length - 1) * width + component];
}
function firstValue(sub, component, width) {
  if (!sub || sub.times.length === 0) return undefined;
  return sub.values[component];
}

const run = await walkM2((path, model, skin) => {
  if (!skin || model.readUInt32LE(4) !== 264) return;
  let parsed;
  try { parsed = parseM2(model, skin); } catch { return; }
  models++;
  const anims = m2Animations(model);
  const stand = anims.find((a) => a.animationId === STAND)?.sequenceIndex ?? 0;
  const death = anims.find((a) => a.animationId === DEATH)?.sequenceIndex;
  const totalIdx = parsed.batches.reduce((sum, b) => sum + (parsed.submeshes[b.submesh]?.indexCount ?? 0), 0) || 1;
  let moving0 = false, perSeq = false, fadeIdx = 0, fades = 0;
  for (const b of parsed.batches) {
    const colour = parsed.colours[b.colorIndex];
    const weight = b.textureWeight >= 0 ? parsed.textureWeights[b.textureWeight] : undefined;
    const alphaTracks = [colour?.alpha, weight].filter(Boolean);
    for (const track of [colour?.rgb, colour?.alpha, weight].filter(Boolean)) {
      if (track.globalSequence >= 0) continue;
      const s0 = track.tracks.find((s) => s.sequence === stand);
      if (s0 && s0.times.length > 1) {
        const width = s0.values.length / s0.times.length;
        for (let i = 1; i < s0.times.length && !moving0; i++) if (Math.abs(s0.values[i * width] - s0.values[0]) > 1e-3) moving0 = true;
      }
      const ref = firstValue(s0, 0, 1);
      for (const sub of track.tracks) {
        if (sub.sequence === stand || sub.times.length === 0) continue;
        if (ref === undefined || Math.abs(sub.values[0] - ref) > 1e-3 || sub.times.length > 1) { perSeq = true; break; }
      }
    }
    if (death !== undefined) {
      // Death sub-track's final opacity (alpha × weight) against Stand's first one.
      let endAlpha = 1, standAlpha = 1, any = false;
      for (const track of alphaTracks) {
        const sd = track.tracks.find((s) => s.sequence === death);
        const s0 = track.tracks.find((s) => s.sequence === stand);
        const e = lastValue(sd, 0, 1); const f = firstValue(s0, 0, 1);
        if (e !== undefined) { endAlpha *= e; any = true; }
        if (f !== undefined) standAlpha *= f;
      }
      if (any && endAlpha < 0.01 && standAlpha > 0.01) {
        fades++;
        fadeIdx += parsed.submeshes[b.submesh]?.indexCount ?? 0;
      }
    }
  }
  if (moving0) { moving0Models++; inc(fam, family(path)); if (standMovers.length < 12) standMovers.push(path.split("\\").pop()); }
  if (perSeq) perSeqModels++;
  if (fades > 0) {
    deathFadeModels++; deathFadeBatches += fades;
    deathFadeShare.push(fadeIdx / totalIdx);
    if (examples.length < 15) examples.push(`${path.split("\\").pop()} ${fades}b ${(100 * fadeIdx / totalIdx).toFixed(1)}%`);
  }
}, { roots, withSkin: true });

console.log("walk:", JSON.stringify(run));
console.log(`models ${models}; batch track moving inside Stand: ${moving0Models} (${top(fam)}); e.g. ${standMovers.join(", ")}`);
console.log(`models painting a batch differently in some non-Stand sequence: ${perSeqModels}`);
deathFadeShare.sort((a, b) => a - b);
const pct = (q) => deathFadeShare.length ? (100 * deathFadeShare[Math.min(deathFadeShare.length - 1, Math.floor(q * deathFadeShare.length))]).toFixed(1) : "-";
console.log(`Death sub-track ends a batch at < 0.01 (Stand > 0.01): ${deathFadeBatches} batches in ${deathFadeModels} models; share of model indices p50 ${pct(0.5)}% p90 ${pct(0.9)}% max ${pct(1)}%`);
console.log("  e.g.", examples.join("; "));
