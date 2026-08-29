import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as THREE from "three";
import { readGlobalSequences, readParticleEmitters, readRibbonEmitters } from "../tools/m2-particles.mjs";
import { encodeWvm9 } from "../tools/wvm.mjs";
import { decodeWvm9 } from "../dist/code/browser/Wvm.js";
import {
  EMITTER_SPHERE, PARTICLE_FLAG_DO_NOT_TRAIL, PARTICLE_FLAG_MODEL_SPACE, PARTICLE_FLAG_PINNED,
  PARTICLE_FLAG_XY_QUAD,
  createParticleSystem, createQuadBuffers, createRibbonSystem,
  particleAppearance, primeParticleSystem, sampleRamp, sampleTrack, seededRandom,
  stepParticles, stepParticlesCatchUp, stepRibbon,
  writeParticleQuads, writeRibbonStrip,
} from "../dist/code/browser/Particles.js";
import {
  buildModelEffects, disposeModelEffects, setModelEffectsFantasyGlow, updateModelEffects,
} from "../dist/code/browser/ParticleRender.js";
import { spellEffectPrimeSeconds } from "../dist/code/browser/WorldRenderer3D.js";
import { applyBillboardBones, buildSkinnedTemplateFrom, instantiateSkinned } from "../dist/code/browser/AnimatedModel.js";
import { BONE_CYLINDRICAL_BILLBOARD_Z, BONE_SPHERICAL_BILLBOARD } from "../dist/code/browser/Wvm.js";

const array = (buffer, at) => ({ count: buffer.readUInt32LE(at), offset: buffer.readUInt32LE(at + 4) });
const HEADER = { globalLoops: 0x14, ribbonEmitters: 0x120, particleEmitters: 0x128 };

const SAMPLE_ROOT = process.env.M2_SAMPLE_ROOT ?? "";
const withSamples = { skip: existsSync(SAMPLE_ROOT) ? false : "no unpacked v264 models on this machine" };

async function* walk(path) {
  const info = await stat(path).catch(() => undefined);
  if (!info) return;
  if (info.isFile()) {
    if (path.toLowerCase().endsWith(".m2")) yield path;
    return;
  }
  for (const entry of await readdir(path, { withFileTypes: true })) yield* walk(join(path, entry.name));
}

/** Every local v264 model that carries emitters, by file name. */
async function samples() {
  const found = new Map();
  for await (const path of walk(SAMPLE_ROOT)) {
    const data = await readFile(path).catch(() => undefined);
    if (!data || data.length < 0x130 || data.subarray(0, 4).toString() !== "MD20") continue;
    if (data.readUInt32LE(4) !== 264) continue;
    const block = array(data, HEADER.particleEmitters);
    if (block.count === 0) continue;
    found.set(path.slice(path.lastIndexOf("\\") + 1).toLowerCase(), { path, data, block });
  }
  return found;
}

/** One real model, decoded the way the browser decodes it. */
function throughArtifact(sample) {
  const emitters = readParticleEmitters(sample.data, sample.block);
  const ribbons = readRibbonEmitters(sample.data, array(sample.data, HEADER.ribbonEmitters));
  const globalSequences = readGlobalSequences(sample.data, array(sample.data, HEADER.globalLoops));
  const model = {
    positions: new Float32Array([0, 0, 0]),
    normals: new Float32Array([0, 0, 1]),
    uv0: new Float32Array([0, 0]),
    uv1: new Float32Array([0, 0]),
    boneIndices: new Uint8Array(4),
    boneWeights: new Uint8Array(4),
    indices: new Uint16Array([0]),
    submeshes: [], batches: [],
    // One slot per index the real emitters name, all pointing at the same file, so the dedup
    // that gives five emitters one upload is still what is being measured.
    textures: Array.from({ length: 16 }, () => ({ type: 0, flags: 0, filename: "spells\\fire.blp" })),
    bounds: { min: [0, 0, 0], max: [0, 0, 0], radius: 0 },
  };
  const encoded = encodeWvm9(model, undefined, undefined,
    { globalSequences, particleEmitters: emitters, ribbonEmitters: ribbons });
  return decodeWvm9(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
}

const IDENTITY = new THREE.Matrix4().elements;
const VIEW = { rightX: 1, rightY: 0, rightZ: 0, upX: 0, upY: 1, upZ: 0 };

function track(values, times, options = {}) {
  return {
    interpolation: options.interpolation ?? 1,
    globalSequence: options.globalSequence ?? -1,
    components: options.components ?? 1,
    tracks: [{ sequence: 0, times: Uint32Array.from(times), values: Float32Array.from(values) }],
  };
}

function ramp(values, times, components = 1) {
  return { components, times: Float32Array.from(times), values: Float32Array.from(values) };
}

function emitter(overrides = {}) {
  const blank = {
    id: 1, flags: 0, position: [0, 0, 0], bone: 0, texture: 0, blendType: 4, emitterType: 1,
    particleType: 0, headTail: 0, particleColorIndex: 0, textureTileRotation: 0,
    textureRows: 1, textureColumns: 1, lifespanVary: 0, emissionRateVary: 0, scaleVary: [0, 0],
    tailLength: 0, twinkleSpeed: 0, twinklePercent: 0, twinkleScaleMin: 0, twinkleScaleMax: 0,
    burstMultiplier: 0, drag: 0, baseSpin: 0, baseSpinVary: 0, spin: 0, spinVary: 0,
    windVector: [0, 0, 0], windTime: 0, followSpeed1: 0, followScale1: 0, followSpeed2: 0,
    followScale2: 0, splinePoints: new Float32Array(0),
  };
  for (const name of ["emissionSpeed", "speedVariation", "verticalRange", "horizontalRange",
    "gravity", "lifespan", "emissionRate", "emissionAreaLength", "emissionAreaWidth", "zSource",
    "enabledIn"]) blank[name] = { interpolation: 0, globalSequence: -1, components: 1, tracks: [] };
  for (const name of ["color", "opacity", "scale", "headCell", "tailCell"]) {
    blank[name] = { components: name === "color" ? 3 : name === "scale" ? 2 : 1, times: new Float32Array(0), values: new Float32Array(0) };
  }
  return { ...blank, ...overrides };
}

/* --- What the file says ---------------------------------------------------------------------- */

test("a track whose keys are bytes decodes to its own values, not to denormals", withSamples, async () => {
  // Under `visual-v10` every M2Track was read as float32 whatever the field's declared width.
  // `enabledIn` is `M2Track<uint8>`, so a stored 1 came back as the float built from the byte
  // 0x01 and three bytes of whatever followed: 1.401298464324817e-45. Both emitters of
  // sunwell_beamfx.m2 and both of sunwell_beamfx_3s.m2 key it, and all four decoded to exactly
  // that number — a value greater than zero and smaller than any threshold, which is to say every
  // one of those emitters was permanently switched off.
  const found = await samples();
  const sample = found.get("sunwell_beamfx.m2");
  assert.ok(sample, "sunwell_beamfx.m2 is in the sample set");
  const emitters = readParticleEmitters(sample.data, sample.block);
  const keyed = emitters.filter((one) => one.enabledIn.tracks.length > 0);
  assert.equal(keyed.length, 2, "both emitters key enabledIn");
  for (const one of keyed) {
    assert.deepEqual([...one.enabledIn.tracks[0].values], [1, 0]);
  }
});

test("a cell ramp holds a flip-book cell, not a fraction of one", withSamples, async () => {
  // headCell and tailCell are `FBlock<uint16>` and the number in them is a cell index. Reading
  // them as fixed16 divided by 32767, so 8fx_generic_shadow_debuff.m2's third emitter — a 2 by 4
  // atlas — reported cells 0, 0, 0.000183 and 0.000214 where the file says 0, 0, 6 and 7.
  const found = await samples();
  const sample = found.get("8fx_generic_shadow_debuff.m2");
  assert.ok(sample, "8fx_generic_shadow_debuff.m2 is in the sample set");
  const emitters = readParticleEmitters(sample.data, sample.block);
  const tiled = emitters[2];
  assert.equal(tiled.textureRows * tiled.textureColumns, 8, "a 2 by 4 atlas");
  assert.deepEqual([...tiled.headCell.values], [0, 0, 6, 7]);
  for (const one of emitters) {
    for (const cell of one.headCell.values) {
      assert.ok(Number.isInteger(cell), "a cell index is a whole number");
      // Not necessarily one this atlas has: the first emitter of this very model asks for cell 1
      // of a one-by-one sheet. The grid is wrapped rather than the frame dropped, which is why
      // `particleAppearance` takes the index modulo the cell count.
      assert.ok(cell >= 0 && cell < 4096, "and a plausible one");
    }
  }
});

test("a colour ramp arrives on the same scale as the opacity beside it", withSamples, async () => {
  // The colour FBlock stores floats on 0..255 while its sibling opacity stores fixed16 on
  // 0..32767. Measured across all 264 colour keys of the nine local models the range is exactly
  // 0 to 255, and 6fx_bonfire.m2's flame starts at 255, 255, 255 — white — and ends at black.
  const found = await samples();
  let seen = 0;
  for (const sample of found.values()) {
    for (const one of readParticleEmitters(sample.data, sample.block)) {
      for (const value of one.color.values) {
        assert.ok(value >= 0 && value <= 1, `colour key ${value} is on 0..1`);
        seen++;
      }
    }
  }
  assert.ok(seen >= 200, `at least 200 colour keys, saw ${seen}`);
  const bonfire = readParticleEmitters(found.get("6fx_bonfire.m2").data, found.get("6fx_bonfire.m2").block);
  const flame = bonfire[0].color;
  assert.ok(Math.abs(flame.values[0] - 1) < 1e-5 && Math.abs(flame.values[1] - 1) < 1e-5, "born white");
  const last = flame.values.length - 3;
  assert.ok(flame.values[last] < 0.05 && flame.values[last + 1] < 0.05, "and dies black");
});

/* --- Sampling ---------------------------------------------------------------------------------- */

test("a track steps or interpolates by the word in front of it", () => {
  const linear = track([0, 10], [0, 1000]);
  assert.ok(Math.abs(sampleTrack(linear, 500, 0, new Uint32Array(0), -1) - 5) < 1e-6);
  const stepped = track([0, 10], [0, 1000], { interpolation: 0 });
  assert.equal(sampleTrack(stepped, 500, 0, new Uint32Array(0), -1), 0);
  // Off both ends it holds rather than extrapolating: a rate that ran negative before its first
  // key would spawn nothing, and one that ran away after its last would spawn everything. An
  // animation track wraps before it can run off the end, so the clamp is reached through a global
  // sequence whose loop outlasts its own keys — 1500 ms into a 2000 ms loop keyed only to 1000.
  assert.equal(sampleTrack(linear, 0, 0, new Uint32Array(0), -1), 0);
  const looping = track([0, 10], [0, 1000], { globalSequence: 0 });
  assert.equal(sampleTrack(looping, 0, 1500, Uint32Array.from([2000]), -1), 10);
  assert.equal(sampleTrack(looping, 0, 2000, Uint32Array.from([2000]), -1), 0, "and starts over");
  assert.equal(sampleTrack(undefined, 0, 0, new Uint32Array(0), 42), 42, "no track is the fallback");
});

test("a track bound to a global sequence runs on the world's clock and wraps on its own loop", () => {
  // This is what makes a brazier flicker while nobody moves: the emitter is not animating, and
  // the model's own clock never advances.
  const flicker = track([0, 4], [0, 800], { globalSequence: 0 });
  const loops = Uint32Array.from([1000]);
  assert.ok(Math.abs(sampleTrack(flicker, 0, 400, loops, -1) - 2) < 1e-6);
  // 1400 into a 1000 ms loop is 400 into it, and the model's own time is ignored entirely.
  assert.ok(Math.abs(sampleTrack(flicker, 999_999, 1400, loops, -1) - 2) < 1e-6);
});

test("a track with no clip driving it wraps on the span of its own keys rather than freezing", () => {
  // Priest_phantasm_base_state.m2 writes its emission rate as 0, 0, 50, 0, 0 across the sequence.
  // A doodad has no clip to follow, and a frozen clock would leave that emitter on the first key
  // for ever — which is zero, so it would never fire at all.
  const pulse = track([0, 50, 0], [0, 500, 1000]);
  assert.ok(Math.abs(sampleTrack(pulse, 500, 0, new Uint32Array(0), -1) - 50) < 1e-6);
  assert.ok(Math.abs(sampleTrack(pulse, 1500, 0, new Uint32Array(0), -1) - 50) < 1e-6, "and again a loop later");
});

test("a ramp reads a particle's own life and holds at both ends", () => {
  const fade = ramp([1, 0.5, 0], [0, 0.5, 1]);
  const out = [0];
  assert.ok(Math.abs(sampleRamp(fade, 0.25, out, 1)[0] - 0.75) < 1e-6);
  assert.ok(Math.abs(sampleRamp(fade, -1, out, 1)[0] - 1) < 1e-6);
  assert.ok(Math.abs(sampleRamp(fade, 2, out, 1)[0] - 0) < 1e-6);
  // Key counts are not three. The local files carry 7, 6, 5, 4 and 2, and an implementation that
  // assumed {start, middle, end} would lose the shape of every curve longer than that.
  const seven = ramp([0, 1, 2, 3, 4, 5, 6], [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1]);
  assert.ok(Math.abs(sampleRamp(seven, 0.5, out, 0)[0] - 3) < 1e-6);
});

/* --- The simulation ------------------------------------------------------------------------- */

test("gravity gives the same arc however many steps it is cut into", () => {
  // The drop is taken exactly — half of it into the position, all of it into the velocity — so
  // the closed form v0*t - g*t*t/2 falls out whatever the frame rate. Accumulating it instead
  // makes a spark thrown at thirty frames a second land somewhere else than at a hundred and
  // forty, which is the kind of difference nobody notices until two machines disagree.
  const rising = emitter({
    emissionSpeed: track([10], [0]),
    lifespan: track([100], [0]),
    emissionRate: track([600], [0]),
    gravity: track([9.8], [0]),
    verticalRange: track([0], [0]),
  });
  const height = (steps) => {
    const system = createParticleSystem(rising, new Uint32Array(0), 7);
    stepParticles(system, 1 / 240, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
    system.pending = 0;
    const particle = system.particles[0];
    assert.ok(particle, "one particle was born");
    const start = particle.z;
    for (let index = 0; index < steps; index++) {
      stepParticles(system, 0.5 / steps, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
    }
    return particle.z - start;
  };
  const coarse = height(6);
  const fine = height(60);
  assert.ok(Math.abs(coarse - fine) < 1e-6, `${coarse} against ${fine}`);
  // v0*t - g*t*t/2 with v0 = 10, t = 0.5 and g = 9.8, less the first 1/240 step already taken.
  assert.ok(Math.abs(coarse - (10 * 0.5 - 9.8 * 0.25 / 2)) < 0.05, `${coarse} is the closed form`);
});

test("a fractional emission rate still spawns, and never all at once", () => {
  // Eight particles a second at sixty frames is 0.133 of a particle a frame. Rounding that down
  // every frame — which is what dropping the accumulator does — is a campfire with no fire.
  const slow = emitter({ emissionRate: track([8], [0]), lifespan: track([100], [0]) });
  const system = createParticleSystem(slow, new Uint32Array(0), 11);
  for (let frame = 0; frame < 60; frame++) {
    stepParticles(system, 1 / 60, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
    assert.ok(system.particles.length <= 9, "and never a burst");
  }
  // Eight a second for a second, give or take the last accumulation landing at 7.9999999.
  assert.ok(system.particles.length >= 7 && system.particles.length <= 8, `${system.particles.length}`);
});

test("async effect catch-up advances bounded substeps so a low-rate emitter is not born empty", () => {
  const late = emitter({
    emissionRate: track([2], [0]),
    lifespan: track([2], [0]),
  });
  const system = createParticleSystem(late, new Uint32Array(0), 17);
  // A single old 100 ms clamp would bank only 0.2 particles. The 700 ms local age needs seven
  // bounded integration steps and must produce the first authored burst deterministically.
  stepParticlesCatchUp(system, 0.7, { matrix: IDENTITY, animationMs: 0, worldMs: 0,
    animationStartMs: 0, worldStartMs: 0 });
  assert.ok(system.particles.length > 0, "the newly loaded effect has a live particle");
  assert.ok(system.particles.every((particle) => particle.age <= 0.7), "catch-up stays within age");
});

test("ordinary frame stepping keeps the anti-hitch clamp", () => {
  const late = emitter({ emissionRate: track([2], [0]), lifespan: track([2], [0]) });
  const system = createParticleSystem(late, new Uint32Array(0), 23);
  stepParticles(system, 0.7, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  assert.equal(system.particles.length, 0, "ordinary frames simulate only their capped 100 ms");
  assert.ok(system.pending > 0 && system.pending < 1);
});

test("finite cold-load first-burst prime gives a quiet two-per-second emitter its first burst", () => {
  const late = emitter({
    emissionRate: track([2], [0]),
    lifespan: track([2], [0]),
  });
  const system = createParticleSystem(late, new Uint32Array(0), 19);
  assert.equal(spellEffectPrimeSeconds({ fitToModel: true, flight: undefined, modelPlayback: "once" }, 0), 0);
  assert.equal(primeParticleSystem(system, { matrix: IDENTITY, animationMs: 0, worldMs: 0 }), true);
  assert.equal(system.particles.length, 1, "the active emitter gets one authored first burst");
});

test("finite first-burst prime does not consume a short enabled/lifespan window or wake an off emitter", () => {
  const brief = emitter({
    emissionRate: track([2], [0]),
    lifespan: track([0.05], [0]),
    enabledIn: track([1, 0], [0, 0.02]),
  });
  const primed = createParticleSystem(brief, new Uint32Array(0), 29);
  assert.equal(primeParticleSystem(primed, { matrix: IDENTITY, animationMs: 0, worldMs: 0 }), true);
  assert.equal(primed.particles.length, 1);
  assert.equal(primed.particles[0].age, 0, "first burst starts at the authored local time");
  assert.ok(Math.abs(primed.particles[0].life - 0.05) < 1e-6,
    "the short authored lifespan is retained");

  const off = emitter({
    emissionRate: track([2], [0]),
    enabledIn: track([0], [0]),
  });
  const unprimed = createParticleSystem(off, new Uint32Array(0), 31);
  assert.equal(primeParticleSystem(unprimed, { matrix: IDENTITY, animationMs: 0, worldMs: 0 }), false);
  assert.equal(unprimed.particles.length, 0, "an emitter disabled by enabledIn stays empty");
});

test("preloaded finite first burst samples the authored local clock, not the late RAF clock", () => {
  const short = emitter({
    texture: 0,
    emissionRate: track([2], [0]),
    lifespan: track([0.05], [0]),
    enabledIn: track([1, 0], [0, 0.02]),
  });
  const effects = buildModelEffects({
    globalSequences: new Uint32Array(0), particleEmitters: [short], ribbonEmitters: [],
    textures: [{ type: 0, path: "spells\\prime.blp" }],
  }, { baseUrl: "http://gateway", loadTexture: () => new THREE.Texture() });
  assert.ok(effects, "the short emitter builds");
  updateModelEffects(effects, 0, {
    matrixFor: () => IDENTITY, animationMs: 25, worldMs: 25,
  }, VIEW, { firstBurst: true, firstBurstAnimationMs: 0 });
  const system = effects.emitters[0].particles;
  assert.ok(system, "the model carries a particle system");
  assert.equal(system.particles.length, 1,
    "a positive first-RAF age does not sample the already-disabled enabledIn key");
  assert.equal(system.particles[0].age, 0, "the first burst starts at authored local time");
  disposeModelEffects(effects);
});

test("an emitter switched off by its own track emits nothing", () => {
  const gated = emitter({
    emissionRate: track([100], [0]),
    lifespan: track([100], [0]),
    enabledIn: track([1, 0], [0, 500]),
  });
  const on = createParticleSystem(gated, new Uint32Array(0), 3);
  stepParticles(on, 0.1, { matrix: IDENTITY, animationMs: 100, worldMs: 0 });
  assert.ok(on.particles.length > 0, "on at 100 ms");
  const off = createParticleSystem(gated, new Uint32Array(0), 3);
  stepParticles(off, 0.1, { matrix: IDENTITY, animationMs: 400, worldMs: 0 });
  assert.equal(off.particles.length, 0, "off at 400 ms");
});

test("a sphere with no vertical range is a ring, not a point", withSamples, async () => {
  // 6fx_bonfire.m2's first emitter is a sphere with verticalRange 0 and a radius of 2.36. Read
  // the way a plane's angles are read — a polar angle off +Z — every particle would be born at
  // the single point 2.36 above the fire. Read as a latitude band around the emitter's own
  // equator, they are born in the ring a campfire's flames stand in.
  const found = await samples();
  const model = throughArtifact(found.get("6fx_bonfire.m2"));
  const flame = model.particleEmitters[0];
  assert.equal(flame.emitterType, EMITTER_SPHERE);
  const system = createParticleSystem(flame, model.globalSequences, 5);
  for (let frame = 0; frame < 120; frame++) {
    stepParticles(system, 1 / 60, { matrix: IDENTITY, animationMs: frame * 16, worldMs: frame * 16 });
  }
  assert.ok(system.particles.length >= 4, `${system.particles.length} flames alive`);
  let spread = 0;
  for (const particle of system.particles) {
    spread = Math.max(spread, Math.hypot(particle.x - flame.position[0], particle.y - flame.position[1]));
  }
  assert.ok(spread > 1, `the flames stand in a ring ${spread.toFixed(2)} across, not on a point`);
});

test("a z-source sends a bonfire's flames up rather than into the ground", withSamples, async () => {
  // The wiki gives the initial velocity as (position - (0, 0, zSource)).Normalize(). All five
  // emitters of 6fx_bonfire.m2 set zSource to 255, and 255 is so far above a spawn ring 2.4
  // across that the formula as written is very nearly (0, 0, -1). Taken literally, every flame of
  // every campfire in the world burns downwards.
  const found = await samples();
  const model = throughArtifact(found.get("6fx_bonfire.m2"));
  const flame = model.particleEmitters[0];
  assert.ok(sampleTrack(flame.zSource, 0, 0, model.globalSequences, 0) > 0, "the emitter has a z-source");
  const system = createParticleSystem(flame, model.globalSequences, 9);
  for (let frame = 0; frame < 60; frame++) {
    stepParticles(system, 1 / 60, { matrix: IDENTITY, animationMs: frame * 16, worldMs: frame * 16 });
  }
  const rising = system.particles.filter((particle) => particle.vz > 0).length;
  assert.ok(rising === system.particles.length && rising > 0, `${rising} of ${system.particles.length} rise`);
});

test("a particle is drawn as a quad centred on itself, in the cell the ramp names", () => {
  // A 2 by 4 atlas is the shape 8fx_generic_shadow_debuff.m2 and 6fx_bonfire.m2 both use, and
  // cell 6 of it is the third column of the second row. Reading the rows the other way up puts
  // every flip-book frame in the wrong half of its sheet.
  const tiled = emitter({
    textureRows: 2, textureColumns: 4,
    emissionRate: track([60], [0]),
    lifespan: track([100], [0]),
    scale: ramp([2, 2], [0], 2),
    headCell: ramp([6], [0]),
  });
  const system = createParticleSystem(tiled, new Uint32Array(0), 13);
  stepParticles(system, 1 / 60, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  const particle = system.particles[0];
  assert.ok(particle, "one particle");
  const buffers = createQuadBuffers(4);
  assert.equal(writeParticleQuads(system, VIEW, buffers), 1);

  let centreX = 0;
  let centreY = 0;
  let centreZ = 0;
  for (let corner = 0; corner < 4; corner++) {
    centreX += buffers.positions[corner * 3] / 4;
    centreY += buffers.positions[corner * 3 + 1] / 4;
    centreZ += buffers.positions[corner * 3 + 2] / 4;
  }
  assert.ok(Math.abs(centreX - particle.x) < 1e-5 && Math.abs(centreY - particle.y) < 1e-5
    && Math.abs(centreZ - particle.z) < 1e-5, "the quad is centred on the particle");
  const width = Math.abs(buffers.positions[3] - buffers.positions[0]);
  assert.ok(Math.abs(width - 2) < 1e-5, `a scale of 2 is 2 across, not ${width}`);

  const us = [buffers.uvs[0], buffers.uvs[2], buffers.uvs[4], buffers.uvs[6]];
  const vs = [buffers.uvs[1], buffers.uvs[3], buffers.uvs[5], buffers.uvs[7]];
  assert.ok(Math.abs(Math.min(...us) - 2 / 4) < 1e-6, "column 2 of 4");
  assert.ok(Math.abs(Math.max(...us) - 3 / 4) < 1e-6);
  assert.ok(Math.abs(Math.min(...vs) - 0) < 1e-6, "row 1 of 2, counted from the top of the sheet");
  assert.ok(Math.abs(Math.max(...vs) - 0.5) < 1e-6);
});

test("model-space spell particles inherit the attached model scale", () => {
  // The hand emitter in the real `spells\\shaman_thunder.m2` is MODEL_SPACE (0x80). Its local
  // particle quad must be transformed by the same bone/effect matrix as its centre; transforming
  // only the centre leaves a scaled hand spark visibly too small and makes the scale seam look
  // like a flat card. This is deliberately a writer-level test: no renderer or texture is needed.
  const local = emitter({
    flags: PARTICLE_FLAG_MODEL_SPACE,
    scale: ramp([1, 1], [0], 2),
  });
  const system = createParticleSystem(local, new Uint32Array(0), 37);
  system.particles.push({
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, bx: 0, by: 0, bz: 0,
    age: 0, life: 2, scaleX: 1, scaleY: 1, spin: 0, spinRate: 0, cellOffset: 0,
  });
  const buffers = createQuadBuffers(1);
  const scale = new THREE.Matrix4().makeScale(2, 2, 2);
  system.matrix.set(scale.elements);
  assert.equal(writeParticleQuads(system, VIEW, buffers), 1);
  const width = Math.abs(buffers.positions[3] - buffers.positions[0]);
  const height = Math.abs(buffers.positions[6 + 1] - buffers.positions[0 + 1]);
  assert.ok(Math.abs(width - 2) < 1e-5, `model scale reaches particle width: ${width}`);
  assert.ok(Math.abs(height - 2) < 1e-5, `model scale reaches particle height: ${height}`);
});

test("Э1 a pinned streak is as long as tailLength allows, and its far end is on the particle", () => {
  // `spells\forceshield_andxplosion.m2`, which is the worst case in the client: 27.8 yards/s for
  // 3.0 s is an 83.3-yard flight — the maximum over the 881 pinned emitters under `spells\`,
  // against a median spread of 0.6 and 6.7 at p90 — and the quad ran the whole of it, because
  // `tailLength` was authored on 5,427 of the 5,445 emitters there and read by nobody.
  const streak = emitter({ flags: PARTICLE_FLAG_PINNED, tailLength: 0.1, scale: ramp([1, 1], [0], 2) });
  const system = createParticleSystem(streak, new Uint32Array(0), 7);
  // Placed by hand rather than simulated: what is under test is the quad, and a spawn that put the
  // particle somewhere else would be testing the emitter instead. It flies along +Y, which is
  // `VIEW`'s up: a streak exactly along the camera's right has no width left to face the eye with
  // and stays a billboard, which is a different branch and the one the next test does not want.
  system.particles.push({
    x: 0, y: 83.3, z: 0, vx: 0, vy: 27.8, vz: 0, bx: 0, by: 0, bz: 0,
    age: 3, life: 3, scaleX: 1, scaleY: 1, spin: 0, spinRate: 0, cellOffset: 0,
  });
  const buffers = createQuadBuffers(4);
  assert.equal(writeParticleQuads(system, VIEW, buffers), 1);

  const ys = [0, 1, 2, 3].map((corner) => buffers.positions[corner * 3 + 1]);
  const length = Math.max(...ys) - Math.min(...ys);
  assert.ok(Math.abs(length - 2.78) < 1e-3, `27.8 yards/s for 0.1 s is 2.78 yards, not ${length}`);
  assert.ok(Math.abs(Math.max(...ys) - 83.3) < 1e-3,
    `the far end stays on the particle at 83.3, not at ${Math.max(...ys)}`);
});

test("Э1 a streak shorter than its own allowance is still drawn whole", () => {
  // The limit is a ceiling, not a length: a spark 0.5 yards old must not be stretched to the
  // 2.78 the allowance would permit, or every emitter would fire fully-grown streaks.
  const streak = emitter({ flags: PARTICLE_FLAG_PINNED, tailLength: 0.1, scale: ramp([1, 1], [0], 2) });
  const system = createParticleSystem(streak, new Uint32Array(0), 7);
  system.particles.push({
    x: 0, y: 0.5, z: 0, vx: 0, vy: 27.8, vz: 0, bx: 0, by: 0, bz: 0,
    age: 0.018, life: 3, scaleX: 1, scaleY: 1, spin: 0, spinRate: 0, cellOffset: 0,
  });
  const buffers = createQuadBuffers(4);
  assert.equal(writeParticleQuads(system, VIEW, buffers), 1);
  const ys = [0, 1, 2, 3].map((corner) => buffers.positions[corner * 3 + 1]);
  assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 0.5) < 1e-3, "the whole of a short streak");
  assert.ok(Math.abs(Math.min(...ys)) < 1e-3, "and it still starts where the particle was born");
});

test("Э1 an emitter with no tailLength keeps the streak it always had", () => {
  // 18 of the 5,445 emitters under `spells\` leave it at zero, and zero is "no limit" rather than
  // "no tail": the quad goes on running from the birthplace to wherever the particle is.
  const streak = emitter({ flags: PARTICLE_FLAG_PINNED, tailLength: 0, scale: ramp([1, 1], [0], 2) });
  const system = createParticleSystem(streak, new Uint32Array(0), 7);
  system.particles.push({
    x: 0, y: 12, z: 0, vx: 0, vy: 4, vz: 0, bx: 0, by: 0, bz: 0,
    age: 3, life: 3, scaleX: 1, scaleY: 1, spin: 0, spinRate: 0, cellOffset: 0,
  });
  const buffers = createQuadBuffers(4);
  assert.equal(writeParticleQuads(system, VIEW, buffers), 1);
  const ys = [0, 1, 2, 3].map((corner) => buffers.positions[corner * 3 + 1]);
  assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 12) < 1e-3, "the whole flight");
});

test("DO_NOT_TRAIL keeps a pinned spell particle as a head instead of a false streak", () => {
  const head = emitter({
    flags: PARTICLE_FLAG_PINNED | PARTICLE_FLAG_DO_NOT_TRAIL,
    tailLength: 1,
    scale: ramp([1, 1], [0], 2),
  });
  const system = createParticleSystem(head, new Uint32Array(0), 7);
  system.particles.push({
    x: 0, y: 12, z: 0, vx: 0, vy: 12, vz: 0, bx: 0, by: 0, bz: 0,
    age: 1, life: 2, scaleX: 1, scaleY: 1, spin: 0, spinRate: 0, cellOffset: 0,
  });
  const buffers = createQuadBuffers(1);
  assert.equal(writeParticleQuads(system, VIEW, buffers), 1);
  const ys = [0, 1, 2, 3].map((corner) => buffers.positions[corner * 3 + 1]);
  assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 1) < 1e-5,
    "the quad keeps its one-yard authored height rather than spanning its twelve-yard flight");
});

test("XY_QUAD stays in the emitter plane when the camera axes turn", () => {
  const planar = emitter({ flags: PARTICLE_FLAG_XY_QUAD, scale: ramp([2, 2], [0], 2) });
  const system = createParticleSystem(planar, new Uint32Array(0), 7);
  system.particles.push({
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, bx: 0, by: 0, bz: 0,
    age: 0, life: 2, scaleX: 1, scaleY: 1, spin: 0, spinRate: 0, cellOffset: 0,
  });
  const buffers = createQuadBuffers(1);
  const turnedView = { rightX: 0, rightY: 0, rightZ: 1, upX: 0, upY: 1, upZ: 0 };
  assert.equal(writeParticleQuads(system, turnedView, buffers), 1);
  const xs = [0, 1, 2, 3].map((corner) => buffers.positions[corner * 3]);
  const zs = [0, 1, 2, 3].map((corner) => buffers.positions[corner * 3 + 2]);
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 2) < 1e-5);
  assert.ok(zs.every((z) => Math.abs(z) < 1e-6), "camera rotation cannot tip an XY quad out of plane");
});

test("PINNED deliberately owns the tail shape when an emitter also sets XY_QUAD", () => {
  const combined = emitter({
    flags: PARTICLE_FLAG_PINNED | PARTICLE_FLAG_XY_QUAD,
    tailLength: 0,
    scale: ramp([1, 1], [0], 2),
  });
  const system = createParticleSystem(combined, new Uint32Array(0), 7);
  system.particles.push({
    x: 0, y: 2, z: 0, vx: 0, vy: 2, vz: 0, bx: 0, by: 0, bz: 0,
    age: 1, life: 2, scaleX: 1, scaleY: 1, spin: 0, spinRate: 0, cellOffset: 0,
  });
  const buffers = createQuadBuffers(1);
  const turnedView = { rightX: 0, rightY: 0, rightZ: 1, upX: 1, upY: 0, upZ: 0 };
  assert.equal(writeParticleQuads(system, turnedView, buffers), 1);
  const ys = [0, 1, 2, 3].map((corner) => buffers.positions[corner * 3 + 1]);
  const zs = [0, 1, 2, 3].map((corner) => buffers.positions[corner * 3 + 2]);
  assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 2) < 1e-5,
    "the pinned birth-to-head tail remains two yards long");
  assert.ok(Math.max(...zs) - Math.min(...zs) > 0.9,
    "the tail keeps a camera-facing width instead of being flattened into emitter XY");
});

test("a particle's colour and size come off the ramps at its own age", () => {
  const fading = emitter({
    color: ramp([1, 1, 1, 0, 0, 0], [0, 1], 3),
    opacity: ramp([1, 0], [0, 1]),
    scale: ramp([1, 1, 3, 3], [0, 1], 2),
  });
  const particle = { age: 0.5, life: 1, scaleX: 1, scaleY: 1, cellOffset: 0 };
  const look = particleAppearance(fading, particle, {});
  assert.ok(Math.abs(look.red - 0.5) < 1e-6 && Math.abs(look.alpha - 0.5) < 1e-6);
  assert.ok(Math.abs(look.width - 2) < 1e-6 && Math.abs(look.height - 2) < 1e-6);
});

test("twinkle is left out rather than guessed at", () => {
  // twinkleSpeed is authored on 8,564 of the client's 8,575 emitters and no source anywhere gives
  // a formula for how twinkleScale enters the size. The range reaches 47.7 on native content, so
  // every guess that flatters one emitter draws another one forty times life size. This pins the
  // omission: a particle is the size its scale ramp says, whatever the twinkle fields hold.
  const loud = emitter({
    scale: ramp([1, 1], [0], 2), twinkleSpeed: 15, twinklePercent: 1,
    twinkleScaleMin: 0.1, twinkleScaleMax: 47.7, emissionRate: track([60], [0]), lifespan: track([9], [0]),
  });
  const system = createParticleSystem(loud, new Uint32Array(0), 21);
  for (let frame = 0; frame < 20; frame++) {
    stepParticles(system, 1 / 60, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
    for (const particle of system.particles) {
      const look = particleAppearance(loud, particle, {});
      assert.ok(Math.abs(look.width - 1) < 1e-6, `${look.width} is life size`);
    }
  }
});

test("the same seed replays the same sparks", () => {
  // A particle system is the one part of the renderer where running it again and looking is not a
  // test. Every number a spawn draws comes from a generator the caller supplies.
  const random = seededRandom(1234);
  const first = [random(), random(), random()];
  const again = seededRandom(1234);
  assert.deepEqual(first, [again(), again(), again()]);
});

/* --- Ribbons ----------------------------------------------------------------------------------- */

function ribbon(overrides = {}) {
  const blank = {
    id: 1, bone: 0, position: [0, 0, 0], textures: Uint16Array.from([0]),
    materials: [{ blendMode: 4, flags: 0 }],
    edgesPerSecond: 10, edgeLifetime: 1, gravity: 0, textureRows: 1, textureColumns: 1,
    priorityPlane: 0, ribbonColorIndex: 0, textureTransformLookupIndex: 0,
  };
  for (const name of ["color", "alpha", "heightAbove", "heightBelow", "textureSlot", "visibility"]) {
    blank[name] = { interpolation: 0, globalSequence: -1, components: name === "color" ? 3 : 1, tracks: [] };
  }
  return { ...blank, ...overrides };
}

test("a ribbon lays edges down where the bone was and retires them by age", () => {
  const trail = createRibbonSystem(ribbon({ edgesPerSecond: 10, edgeLifetime: 0.5 }), new Uint32Array(0));
  const move = new THREE.Matrix4();
  for (let frame = 0; frame < 30; frame++) {
    move.makeTranslation(frame * 0.1, 0, 0);
    stepRibbon(trail, 1 / 30, { matrix: move.elements, animationMs: 0, worldMs: 0 });
  }
  // Ten a second for half a second: five edges alive, and the oldest is the one furthest back
  // along the path rather than the one at the bone.
  assert.ok(trail.edges.length >= 4 && trail.edges.length <= 6, `${trail.edges.length} edges`);
  assert.ok(trail.edges[0].x < trail.edges[trail.edges.length - 1].x, "the trail is left behind");
  for (const edge of trail.edges) assert.ok(edge.age < 0.5, "and nothing outlives its lifetime");
});

test("a ribbon's texture runs by age, so it does not crawl while the trail is filling", () => {
  // Indexing the strip instead — u = i / (n - 1) — renormalises every frame, and the pattern
  // visibly slides backwards along a ribbon that is still growing.
  const trail = createRibbonSystem(ribbon({ edgesPerSecond: 20, edgeLifetime: 1, heightAbove: track([1], [0]), heightBelow: track([1], [0]) }), new Uint32Array(0));
  const buffers = createQuadBuffers(64);
  const sample = () => {
    const quads = writeRibbonStrip(trail, buffers);
    return quads > 0 ? buffers.uvs[0] : undefined;
  };
  for (let frame = 0; frame < 6; frame++) stepRibbon(trail, 1 / 30, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  const early = sample();
  for (let frame = 0; frame < 6; frame++) stepRibbon(trail, 1 / 30, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  const later = sample();
  assert.ok(early !== undefined && later !== undefined, "the strip has quads at both moments");
  assert.ok(later < early, `the oldest edge's u fell from ${early} to ${later} as it aged`);
});

test("a ribbon's material travels as a blend mode, because the table it came from does not", () => {
  // `materials` in the file indexes the M2's render-flag array, and the artifact has never
  // carried that array — batches fold theirs into a blend mode on the way out and a ribbon has no
  // batch to fold into. Shipping the raw index would ship a number pointing at nothing.
  const model = {
    positions: new Float32Array([0, 0, 0]), normals: new Float32Array([0, 0, 1]),
    uv0: new Float32Array([0, 0]), uv1: new Float32Array([0, 0]),
    boneIndices: new Uint8Array(4), boneWeights: new Uint8Array(4), indices: new Uint16Array([0]),
    submeshes: [], batches: [], textures: [],
    bounds: { min: [0, 0, 0], max: [0, 0, 0], radius: 0 },
  };
  const source = ribbon({ materials: [{ blendMode: 4, flags: 5 }], textures: Uint16Array.from([3]) });
  const encoded = encodeWvm9(model, undefined, undefined,
    { globalSequences: new Uint32Array(0), particleEmitters: [], ribbonEmitters: [source] });
  const decoded = decodeWvm9(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
  assert.equal(decoded.ribbonEmitters.length, 1);
  assert.deepEqual(decoded.ribbonEmitters[0].materials, [{ blendMode: 4, flags: 5 }]);
  assert.deepEqual([...decoded.ribbonEmitters[0].textures], [3]);
});

/* --- On the scene graph ------------------------------------------------------------------------ */

test("a model's emitters become one mesh each, drawn additively and writing no depth", withSamples, async () => {
  // A particle that wrote depth would punch a hole in every particle behind it, and a cloud of
  // them is drawn in whatever order they happened to be born in.
  const found = await samples();
  const model = throughArtifact(found.get("6fx_bonfire.m2"));
  const loaded = [];
  const effects = buildModelEffects(model, {
    baseUrl: "http://gateway",
    loadTexture: (url) => {
      loaded.push(url);
      return new THREE.Texture();
    },
  });
  assert.ok(effects, "the bonfire emits");
  assert.equal(effects.emitters.length, model.particleEmitters.length);
  // One texture, one download: all five emitters name the same slot in this stub model.
  assert.equal(loaded.length, 1, `one upload for five emitters, saw ${loaded.length}`);
  assert.ok(loaded[0].includes("spells%5Cfire.blp"), loaded[0]);
  for (const drawn of effects.emitters) {
    assert.equal(drawn.material.depthWrite, false);
    assert.equal(drawn.material.transparent, true);
    assert.equal(drawn.material.blendDst, THREE.OneFactor, "additive");
    assert.equal(drawn.mesh.frustumCulled, false);
    assert.equal(drawn.geometry.drawRange.count, 0, "nothing is drawn before anything is stepped");
  }

  const view = { rightX: 1, rightY: 0, rightZ: 0, upX: 0, upY: 1, upZ: 0 };
  for (let frame = 0; frame < 60; frame++) {
    updateModelEffects(effects, 1 / 60, { matrixFor: () => IDENTITY, animationMs: frame * 16, worldMs: frame * 16 }, view);
  }
  const drawn = effects.emitters.reduce((total, one) => total + one.geometry.drawRange.count, 0);
  assert.ok(drawn > 0, "and something is drawn after a second of it");
  disposeModelEffects(effects);
  assert.equal(effects.group.children.length, 0, "and it all goes away again");
});

test("Э1 a ribbon's material flags reach its material, not only its blend mode", () => {
  // `buildModelEffects` passed `material?.blendMode ?? 2` and dropped `material.flags` on the
  // floor, so `MATERIAL_UNFOGGED` never arrived and `MeshBasicMaterial.fog` stayed at its default
  // of `true`. 827 of the 854 ribbons under `spells\` carry that bit.
  const bare = {
    positions: new Float32Array(0), normals: new Float32Array(0),
    uv0: new Float32Array(0), uv1: new Float32Array(0), indices: new Uint16Array(0),
    submeshes: [], batches: [], textures: [{ type: 0, flags: 0, path: "spells\\fire.blp" }],
    attachments: [], bounds: { min: [0, 0, 0], max: [0, 0, 0], radius: 0 },
    globalSequences: new Uint32Array(0), particleEmitters: [], colours: [], textureWeights: [],
    textureTransforms: [],
  };
  const build = (flags) => {
    const effects = buildModelEffects(
      { ...bare, ribbonEmitters: [ribbon({ materials: [{ blendMode: 4, flags }] })] },
      { baseUrl: "http://gateway", loadTexture: () => new THREE.Texture() });
    assert.ok(effects, "the ribbon builds");
    return effects.emitters[0].material;
  };
  assert.equal(build(0x02).fog, false, "MATERIAL_UNFOGGED means distance may not touch it");
  assert.equal(build(0).fog, true, "and a ribbon that says nothing is fogged like everything else");
});

test("fantasy glow is local, reversible on active spell particles, and fails closed", () => {
  const model = {
    globalSequences: new Uint32Array(0),
    particleEmitters: [emitter({ blendType: 4 })],
    ribbonEmitters: [],
    textures: [{ type: 0, flags: 0, path: "spells\\glow.blp" }],
  };
  const build = (fantasyGlow) => buildModelEffects(model, {
    baseUrl: "http://gateway", loadTexture: () => new THREE.Texture(), fantasyGlow,
  });
  const baseline = build(false);
  const fantasy = build(true);
  assert.ok(baseline && fantasy);
  const compile = (effect) => {
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    };
    effect.emitters[0].material.onBeforeCompile(shader);
    return shader.fragmentShader;
  };
  assert.doesNotMatch(compile(baseline), /particle-fantasy-glow-v1/);
  assert.match(compile(fantasy), /particle-fantasy-glow-v1/);
  assert.match(fantasy.emitters[0].material.customProgramCacheKey(), /particle-fantasy-glow-v1/);
  const baselineKey = baseline.emitters[0].material.customProgramCacheKey();
  setModelEffectsFantasyGlow(baseline, true);
  assert.match(compile(baseline), /particle-fantasy-glow-v1/);
  setModelEffectsFantasyGlow(baseline, false);
  assert.doesNotMatch(compile(baseline), /particle-fantasy-glow-v1/);
  assert.equal(baseline.emitters[0].material.customProgramCacheKey(), baselineKey);
  setModelEffectsFantasyGlow(baseline, true);
  assert.throws(() => baseline.emitters[0].material.onBeforeCompile({
    uniforms: {}, vertexShader: "", fragmentShader: "void main() {}",
  }), /exactly one MeshBasic color marker/);
  disposeModelEffects(baseline);
  disposeModelEffects(fantasy);
});

test("a model with no emitters builds nothing rather than an empty group", withSamples, async () => {
  const found = await samples();
  const model = throughArtifact(found.get("6fx_bonfire.m2"));
  const bare = { ...model, particleEmitters: [], ribbonEmitters: [] };
  assert.equal(buildModelEffects(bare, { baseUrl: "http://gateway", loadTexture: () => new THREE.Texture() }), undefined);
});

/* --- Billboard bones ----------------------------------------------------------------------- */

function rig(flags) {
  return {
    parents: Int16Array.from([-1]),
    flags: Uint16Array.from([flags]),
    pivots: Float32Array.from([0, 0, 0]),
    clips: [{
      animationId: 0, duration: 1,
      channels: [{ bone: 0, kind: 1, times: Float32Array.from([0]), values: Float32Array.from([0, 0, 0, 1]) }],
    }],
    animations: [0],
  };
}

function lookingCamera(x, y, z) {
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
  camera.position.set(x, y, z);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

test("a bone flagged as a billboard faces the camera instead of its animation", () => {
  // The flags were decoded in Wvm.ts, four constants were named for them, and nothing in src ever
  // read one — while the doc comment on buildSkinnedTemplateFrom had claimed since slice U4 that
  // "bone flags come through too". A card on such a bone renders edge-on from half the angles it
  // is seen from, which is what a lantern glow and a spell flare are hung on.
  const template = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), rig(BONE_SPHERICAL_BILLBOARD), 2);
  assert.ok(template, "the rig builds");
  assert.deepEqual(template.billboards, [0], "and it knows which bone billboards");
  const instance = instantiateSkinned(template, new THREE.MeshBasicMaterial());
  const camera = lookingCamera(7, 3, -5);
  applyBillboardBones(instance, template, camera);
  instance.root.updateMatrixWorld(true);

  const bone = instance.skeleton.bones[0].matrixWorld.elements;
  const view = camera.matrixWorld.elements;
  const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-5, `${what}: ${a} against ${b}`);
  near(bone[4], view[4], "the bone's up is the camera's up (x)");
  near(bone[5], view[5], "the bone's up is the camera's up (y)");
  near(bone[6], view[6], "the bone's up is the camera's up (z)");
  near(bone[8], -view[0], "and its depth axis is the camera's right, negated (x)");
  near(bone[9], -view[1], "and its depth axis is the camera's right, negated (y)");
  near(bone[10], -view[2], "and its depth axis is the camera's right, negated (z)");
});

test("a cylindrical billboard keeps the axis it is pinned to", () => {
  // A torch flame turns to follow the eye but stays upright; a spherical one would lie down as
  // the camera rose above it.
  const template = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), rig(BONE_CYLINDRICAL_BILLBOARD_Z), 2);
  const instance = instantiateSkinned(template, new THREE.MeshBasicMaterial());
  // Read after the world matrices exist, not before: an un-updated bone reports the identity, and
  // the pinned axis is only itself once the root's own quarter turn has been applied to it.
  instance.root.updateMatrixWorld(true);
  const before = new THREE.Vector3().setFromMatrixColumn(instance.skeleton.bones[0].matrixWorld, 2).normalize();
  applyBillboardBones(instance, template, lookingCamera(7, 9, -5));
  instance.root.updateMatrixWorld(true);
  const after = new THREE.Vector3().setFromMatrixColumn(instance.skeleton.bones[0].matrixWorld, 2).normalize();
  assert.ok(after.dot(before) > 0.999, `the pinned axis moved: ${after.toArray()} against ${before.toArray()}`);
});

test("a model with no billboard bones costs nothing to leave alone", () => {
  const template = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), rig(0), 2);
  assert.deepEqual(template.billboards, []);
  const instance = instantiateSkinned(template, new THREE.MeshBasicMaterial());
  const before = instance.skeleton.bones[0].quaternion.clone();
  applyBillboardBones(instance, template, lookingCamera(1, 1, 1));
  assert.ok(before.equals(instance.skeleton.bones[0].quaternion), "the bone is untouched");
});

/* --- What the review found ------------------------------------------------------------------ */

test("wind blows in the frame the file wrote it in", () => {
  // `windVector` is a C3Vector at 0x1A0 of the record, in the same space as the emitter's own
  // position — and it was the one spatial term the matrix was never applied to. Read raw, a wind
  // blowing straight down in the model's frame came out horizontal in the scene, and it did not
  // turn with the doodad's yaw either. Fourteen of the client's 25,201 emitters carry one, and
  // they are exactly the ones it shows on: waterfall-long.m2, blacksmith_smoke.m2, smokestack.m2.
  const blown = emitter({
    windVector: [0, 0, -10],
    emissionRate: track([600], [0]),
    lifespan: track([100], [0]),
  });
  // The rotation a doodad's mesh carries: model (x, y, z) becomes scene (-x, z, y).
  const toScene = new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
  const system = createParticleSystem(blown, new Uint32Array(0), 31);
  stepParticles(system, 1 / 60, { matrix: toScene.elements, animationMs: 0, worldMs: 0 });
  const particle = system.particles[0];
  assert.ok(particle, "one particle");
  const before = { x: particle.vx, y: particle.vy, z: particle.vz };
  for (let frame = 0; frame < 60; frame++) {
    stepParticles(system, 1 / 60, { matrix: toScene.elements, animationMs: 0, worldMs: 0 });
  }
  // Model −Z is scene −Y: a second of it takes ten off the vertical, not off the depth axis.
  assert.ok(Math.abs((particle.vy - before.y) + 10) < 0.2, `vertical: ${particle.vy - before.y}`);
  assert.ok(Math.abs(particle.vz - before.z) < 0.2, `and nothing along depth: ${particle.vz - before.z}`);
});

test("a quiet step does not throw away what the emitter has banked", () => {
  // The variance is redrawn every step, and a draw at or below zero used to clear the whole
  // fractional accumulator rather than merely contribute nothing. That loses every fraction of a
  // particle banked since the last spawn — and loses more of it the higher the frame rate, which
  // is the exact frame-rate dependence the gravity and drag terms go out of their way to avoid.
  // 82 of the client's emitters carry a variance and 53 have one large enough to go negative.
  const jittery = emitter({
    emissionRate: track([2], [0]),
    emissionRateVary: 4,
    lifespan: track([100], [0]),
  });
  const spawned = (steps) => {
    const system = createParticleSystem(jittery, new Uint32Array(0), 77);
    for (let frame = 0; frame < steps; frame++) {
      stepParticles(system, 2 / steps, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
    }
    return system.particles.length;
  };
  const slow = spawned(60);
  const fast = spawned(288);
  // Two seconds at a mean rate of 2 a second is about four, whichever clock is counting.
  assert.ok(slow >= 2, `${slow} at 30 frames a second`);
  assert.ok(fast >= 2, `${fast} at 144 frames a second`);
  assert.ok(Math.abs(slow - fast) <= 3, `${slow} against ${fast}: the two clocks agree`);
});

test("an emitter switched off owes nothing when it comes back", () => {
  // The other half of the same decision: a rate track that really has stopped clears the
  // accumulator, so a cast's sparks do not fire a backlog the moment the cast resumes.
  const pulsing = emitter({ emissionRate: track([0, 50, 0], [0, 500, 1000]), lifespan: track([100], [0]) });
  const system = createParticleSystem(pulsing, new Uint32Array(0), 5);
  // A step short enough that it banks a fraction rather than spending it all at once.
  stepParticles(system, 0.01, { matrix: IDENTITY, animationMs: 400, worldMs: 0 });
  assert.ok(system.pending > 0, `banked while it was running: ${system.pending}`);
  stepParticles(system, 0.01, { matrix: IDENTITY, animationMs: 0, worldMs: 0 });
  assert.equal(system.pending, 0, "and dropped when it stopped");
});

test("a particle is never an alpha-keyed cut-out", withSamples, async () => {
  // `applyBlendMode` sets a 224/255 alpha gate for blend mode 1, which is right for hair cards
  // and foliage and fatal here: a particle's alpha is its texture's times its opacity ramp, and a
  // ramp that fades in from zero fails that gate for most of its life. Ten of the client's
  // emitters use mode 1 and every one of them would have drawn nothing at all.
  const found = await samples();
  const model = throughArtifact(found.get("6fx_bonfire.m2"));
  const keyed = { ...model, particleEmitters: model.particleEmitters.map((one) => ({ ...one, blendType: 1 })) };
  const effects = buildModelEffects(keyed, {
    baseUrl: "http://gateway",
    loadTexture: () => new THREE.Texture(),
  });
  assert.ok(effects);
  for (const drawn of effects.emitters) assert.equal(drawn.material.alphaTest, 0);
  disposeModelEffects(effects);
});

test("a billboard bone is turned against where its unit stands now, not where it stood", () => {
  // `updateMatrixWorld` composes against the parent's world matrix exactly as it stands and only
  // ever walks downwards, and nothing recomposes a unit's own node until the render call at the
  // end of the frame. Turning the bones with it aimed them at where the camera was relative to
  // last frame's placement — visible on anything that moves or spins on the spot.
  const template = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), rig(BONE_SPHERICAL_BILLBOARD), 2);
  const instance = instantiateSkinned(template, new THREE.MeshBasicMaterial());
  const node = new THREE.Group();
  node.add(instance.root);
  node.updateMatrixWorld(true);
  // The unit turns and walks, and nothing has recomposed its world matrix since.
  node.position.set(10, 0, -4);
  node.rotation.y = 1.1;

  const camera = lookingCamera(3, 6, 9);
  applyBillboardBones(instance, template, camera);
  node.updateMatrixWorld(true);
  const bone = instance.skeleton.bones[0].matrixWorld.elements;
  const view = camera.matrixWorld.elements;
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(bone[4 + axis] - view[4 + axis]) < 1e-5,
      `up ${axis}: ${bone[4 + axis]} against ${view[4 + axis]}`);
  }
});

test("a model with no geometry is a model, and it is most of the spell effects there are", withSamples, async () => {
  // 434 of the 1,462 models the spell visual tables name — 29.7% — have exactly zero vertices,
  // and every one of them carries emitters: they are the effect, and the quad they do not have is
  // the point. Three separate guards used to reject them, so the publisher wrote nothing at all
  // and a mage's hands stayed empty.
  const bare = {
    positions: new Float32Array(0), normals: new Float32Array(0),
    uv0: new Float32Array(0), uv1: new Float32Array(0),
    indices: new Uint16Array(0), submeshes: [], batches: [],
    textures: [{ type: 0, flags: 0, filename: "spells\glow.blp" }],
    bounds: { min: [0, 0, 0], max: [0, 0, 0], radius: 0 },
  };
  const found = await samples();
  const donor = throughArtifact(found.get("6fx_bonfire.m2"));
  const encoded = encodeWvm9(bare, undefined, undefined, {
    globalSequences: donor.globalSequences,
    particleEmitters: [donor.particleEmitters[0]],
    ribbonEmitters: [],
  });
  const decoded = decodeWvm9(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
  assert.equal(decoded.positions.length, 0, "no geometry");
  assert.equal(decoded.particleEmitters.length, 1, "and an emitter all the same");

  const effects = buildModelEffects(decoded, {
    baseUrl: "http://gateway",
    loadTexture: () => new THREE.Texture(),
  });
  assert.ok(effects, "which builds");
  const view = { rightX: 1, rightY: 0, rightZ: 0, upX: 0, upY: 1, upZ: 0 };
  for (let frame = 0; frame < 60; frame++) {
    updateModelEffects(effects, 1 / 60, { matrixFor: () => IDENTITY, animationMs: frame * 16, worldMs: frame * 16 }, view);
  }
  const drawn = effects.emitters.reduce((total, one) => total + one.geometry.drawRange.count, 0);
  assert.ok(drawn > 0, "and draws");
  disposeModelEffects(effects);
});
