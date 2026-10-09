// A7a срез F2 (05.10): shader-program keys of M2 batch materials before and after 6.22/6.16е, over the
// F:/Circle corpus, through the real parser (`tools/m2.mjs`) and the real key builder
// (`src/browser/M2Combiners.ts`, via the test source hook). Also counts M2 lights (6.17).
// Usage (from WebClient): .runtime/node/node.exe --import ./tools/register-test-sources.mjs \
//   docs/implementation/probes/A7a/probe-f2-programs.mjs [sample=1]
import { walkM2, family } from "./corpus.mjs";
import { parseM2 } from "file:///F:/tswowRoot/WebClient/tools/m2.mjs";
import { combinerStep, combinerProgram, decodeShaderId } from "file:///F:/tswowRoot/WebClient/dist/code/browser/M2Combiners.js";

const sample = Number(process.argv[2] ?? 1);
const before = new Map();
const after = new Map();
const pairs = new Map();
const t = { models: 0, batches: 0, stepBefore: 0, stepAfter: 0, special: 0, fallback: 0, sphere0: 0, sphere1: 0,
  lightModels: 0, lights: 0, pointLights: 0 };
const inc = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

function authoredUv1(model, batch) {
  const submesh = model.submeshes[batch.submesh];
  if (!submesh) return false;
  for (let at = submesh.indexStart; at < submesh.indexStart + submesh.indexCount; at++) {
    const vertex = model.indices[at] * 2;
    if (model.uv1[vertex] !== 0 || model.uv1[vertex + 1] !== 0) return true;
  }
  return false;
}

const run = await walkM2((path, m2, skin) => {
  if (!skin || m2.readUInt32LE(4) !== 264) return;
  let model;
  try { model = parseM2(m2, skin); } catch { return; }
  t.models++;
  if (model.lights.length > 0) {
    t.lightModels++;
    t.lights += model.lights.length;
    t.pointLights += model.lights.filter((light) => light.type === 1).length;
  }
  for (const batch of model.batches) {
    t.batches++;
    const lit = (batch.materialFlags & 1) === 0 && batch.blendMode !== 3 && batch.blendMode !== 4;
    const second = batch.textures[1] ?? -1;
    const ownSecond = second >= 0 && model.textures[second]?.type === 0 && model.textures[second]?.filename;
    // Before: the legacy layer (UV set 1, authored, own slot), keyed by the raw id.
    if (ownSecond && batch.uvSets[1] === 1 && authoredUv1(model, batch)) {
      t.stepBefore++;
      inc(before, `wvm-layer2-${batch.shaderId}`);
    }
    // After: the resolved path, as `resolvedCombiner` decides it.
    const decoded = decodeShaderId(batch.resolvedShaderId);
    if (!decoded) {
      t.special++;
      if (ownSecond && batch.uvSets[1] === 1 && authoredUv1(model, batch)) { t.stepAfter++; inc(after, `wvm-layer2-${batch.resolvedShaderId}`); }
      continue;
    }
    const twoStage = ownSecond && (decoded.sphere1 || authoredUv1(model, batch));
    if (twoStage) {
      const step = combinerStep(2, decoded, lit);
      const program = combinerProgram(2, decoded.op0, decoded.op1);
      if (program.fallback) t.fallback++;
      if (decoded.sphere1) t.sphere1++;
      if (decoded.sphere0) t.sphere0++;
      inc(pairs, `${family(path)}:${program.name}${decoded.sphere1 ? "+env" : ""}`);
      t.stepAfter++;
      inc(after, step.key);
      continue;
    }
    const op = decoded.op0;
    const plain = op === 1 || op === 6 || op === 7 || (op === 0 && batch.blendMode === 0);
    if (plain && !decoded.sphere0) continue;
    if (decoded.sphere0) t.sphere0++;
    t.stepAfter++;
    inc(after, combinerStep(1, decoded, lit).key);
  }
}, { withSkin: true, sample });

const top = (map, n = 30) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}=${v}`).join(" ");
console.log("walk:", JSON.stringify(run));
console.log(JSON.stringify(t));
console.log(`program keys before: ${before.size} | ${top(before, 12)}`);
console.log(`program keys after: ${after.size} | ${top(after, 60)}`);
console.log(`two-stage programs by family: ${top(pairs, 40)}`);
