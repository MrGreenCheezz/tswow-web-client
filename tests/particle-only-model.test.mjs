// 12.10 7.33 — «порталы (вход в подземелье) иногда не видны». An old-world instance portal is its
// particles (its slab sits on a texture weight of 0), and the emitter pass dropped it past 90 yards and
// whenever 32 nearer emitter sets — torches — filled the budget. A model that is nothing but its emitters
// is ranked apart, within its placement's own leash (src/browser/ParticleOnlyModel.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { particleOnlyModel } from "../dist/code/browser/ParticleOnlyModel.js";
import { decodeWvm9 } from "../dist/code/browser/Wvm.js";
import { parseM2, parseM2Skeleton } from "../tools/m2.mjs";
import { readParticleEmitters, readRibbonEmitters, readGlobalSequences } from "../tools/m2-particles.mjs";
import { encodeWvm9 } from "../tools/wvm.mjs";

let archives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
} catch {
  archives = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };

const track = (...values) => ({ interpolation: 0, globalSequence: -1, components: 1,
  tracks: [{ sequence: 0, times: Uint32Array.from(values.map((_, index) => index * 100)), values: Float32Array.from(values) }] });
function model({ emitters = 1, vertices = 3, batches = [{ textureWeight: 0, colorIndex: 0xffff }], weights = [track(0)], colours = [] } = {}) {
  return {
    positions: new Float32Array(vertices * 3), indices: new Uint16Array(vertices), batches,
    textureWeights: weights, colours,
    particleEmitters: Array.from({ length: emitters }, () => ({})), ribbonEmitters: [],
  };
}

test("a model whose mesh draws nothing is particle-only; a mesh that draws, or no emitter, is not", () => {
  assert.equal(particleOnlyModel(model()), true, "the portal's slab: one batch on a weight of 0");
  assert.equal(particleOnlyModel(model({ vertices: 0, batches: [] })), true, "Temporal_Displacement: no vertices at all");
  assert.equal(particleOnlyModel(model({ weights: [track(0, 1)] })), false, "a weight that rises is drawn");
  assert.equal(particleOnlyModel(model({ weights: [track(1)] })), false, "a torch: its mesh draws");
  assert.equal(particleOnlyModel(model({ batches: [{ textureWeight: -1, colorIndex: 0xffff }] })), false, "no weight track: drawn");
  assert.equal(particleOnlyModel(model({
    batches: [{ textureWeight: -1, colorIndex: 0 }], colours: [{ rgb: track(1), alpha: track(0, 0) }],
  })), true, "a colour whose alpha never leaves 0 hides its batch too");
  assert.equal(particleOnlyModel(model({
    batches: [{ textureWeight: 0, colorIndex: 0xffff }, { textureWeight: -1, colorIndex: 0xffff }],
  })), false, "one visible batch is a mesh");
  assert.equal(particleOnlyModel(model({ emitters: 0 })), false, "no emitters: nothing to rank");
});

test("the renderer ranks particle-only sets apart, past EFFECT_RANGE, under their own allowance", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const pass = source.slice(source.indexOf("  #updateEffects("), source.indexOf("  #markExpiredSpellEffectPhases("));
  const env = pass.slice(pass.indexOf("this.#environment.forEach"), pass.indexOf("this.#gameObjects.forEach"));
  const objects = pass.slice(pass.indexOf("this.#gameObjects.forEach"), pass.indexOf("this.#units.forEach"));
  for (const [label, loop] of [["placements", env], ["game objects", objects]]) {
    assert.match(loop, /const only = particleOnlyModel\(rendered\.wvm\);/, label);
    assert.match(loop, /if \(!only && distance > EFFECT_RANGE_SQUARED\) return;/, label);
    assert.match(loop, /\(only \? particleOnly : wanted\)\.push\(entry\);/, label);
  }
  assert.match(pass, /if \(particleOnly\.length > PARTICLE_ONLY_EFFECT_BUDGET\) particleOnly\.length = PARTICLE_ONLY_EFFECT_BUDGET;/);
  // Appended after the shared budget has been cut, so a torch cannot spend a portal's slot.
  assert.ok(pass.indexOf("wanted.length = EFFECT_BUDGET") < pass.indexOf("wanted.push(particleOnly[index]!)"));
});

async function decoded(path) {
  const m2 = await archives.read(path);
  const skin = await archives.read(path.replace(/\.m2$/i, "00.skin"));
  if (!m2 || !skin) return undefined;
  const parsed = parseM2(m2, skin); // colours and texture weights included, as the generator encodes them
  const effects = {
    globalSequences: readGlobalSequences(m2, { count: m2.readUInt32LE(0x14), offset: m2.readUInt32LE(0x18) }),
    particleEmitters: readParticleEmitters(m2, { count: m2.readUInt32LE(0x128), offset: m2.readUInt32LE(0x12c) }),
    ribbonEmitters: readRibbonEmitters(m2, { count: m2.readUInt32LE(0x120), offset: m2.readUInt32LE(0x124) }),
  };
  const encoded = encodeWvm9(parsed, parseM2Skeleton(m2), undefined, effects, { extensions: true });
  return decodeWvm9(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
}

test("the client's own portals are particle-only, a brazier is not", withClient, async () => {
  for (const path of [
    "World\\Generic\\ActiveDoodads\\InstancePortal\\InstancePortal.m2",
    "World\\Generic\\ActiveDoodads\\InstancePortal\\InstancePortal_Green.m2",
  ]) {
    const wvm = await decoded(path);
    if (!wvm) continue;
    assert.ok(wvm.particleEmitters.length > 0, `${path}: emitters`);
    assert.equal(particleOnlyModel(wvm), true, path);
  }
  const brazier = await decoded("World\\Generic\\Orc\\Passive Doodads\\Braziers\\MediumBrazierNoOmni01.m2");
  if (brazier) {
    assert.ok(brazier.particleEmitters.length > 0, "the brazier's flame");
    assert.equal(particleOnlyModel(brazier), false, "the brazier's bowl is drawn");
  }
});
