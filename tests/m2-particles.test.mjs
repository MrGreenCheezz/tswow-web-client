import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  EMITTER_PLANE, EMITTER_SPHERE, PARTICLE_RECORD_SIZE, RIBBON_RECORD_SIZE,
  readGlobalSequences, readParticleEmitters, readRibbonEmitters, scoreParticleStride,
  scoreRibbonStride,
} from "../tools/m2-particles.mjs";
import { encodeParticleEmitter, encodeRibbonEmitter, encodeWvm9 } from "../tools/wvm.mjs";
import { decodeWvm9 } from "../dist/code/browser/Wvm.js";

const array = (buffer, at) => ({ count: buffer.readUInt32LE(at), offset: buffer.readUInt32LE(at + 4) });
const HEADER = { globalLoops: 0x14, ribbonEmitters: 0x120, particleEmitters: 0x128 };

/**
 * Models used to validate the particle stride. They are an unpacked patch rather than client
 * archives, which is why this reads the filesystem.
 */
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

async function samples() {
  const found = [];
  for await (const path of walk(SAMPLE_ROOT)) {
    const data = await readFile(path).catch(() => undefined);
    if (!data || data.length < 0x130 || data.subarray(0, 4).toString() !== "MD20") continue;
    if (data.readUInt32LE(4) !== 264) continue;
    const block = array(data, HEADER.particleEmitters);
    if (block.count > 0) found.push({ path, data, block });
  }
  return found;
}

test("the emitter record is 476 bytes and nothing else fits", withSamples, async () => {
  // The first record always decodes whatever the stride, because it starts where the header says.
  // The second one is where a wrong stride shows, and the study settled 476 exactly this way.
  const models = (await samples()).filter((entry) => entry.block.count >= 2);
  assert.ok(models.length >= 3, `expected several multi-emitter models, found ${models.length}`);
  for (const { path, data, block } of models) {
    const globals = readGlobalSequences(data, array(data, HEADER.globalLoops)).length;
    assert.equal(scoreParticleStride(data, block, PARTICLE_RECORD_SIZE, globals), 1,
      `${path}: every track of every emitter should decode at 476`);
    for (const wrong of [472, 480, 492]) {
      assert.ok(scoreParticleStride(data, block, wrong, globals) < 0.9,
        `${path}: stride ${wrong} should not decode cleanly`);
    }
  }
});

test("every emitter the header promises is read, and its numbers are sane", withSamples, async () => {
  const models = await samples();
  let total = 0;
  for (const { path, data, block } of models) {
    const emitters = readParticleEmitters(data, block);
    assert.equal(emitters.length, block.count, `${path}: the parser kept every record`);
    for (const emitter of emitters) {
      total++;
      assert.ok(emitter.blendType <= 7, `${path}: blend mode in range`);
      assert.ok(emitter.emitterType >= EMITTER_PLANE && emitter.emitterType <= 4, `${path}: known emitter type`);
      assert.ok(emitter.textureRows >= 1 && emitter.textureColumns >= 1, `${path}: a flipbook has at least one cell`);
      assert.ok(Number.isFinite(emitter.drag) && Number.isFinite(emitter.spin));
      // A ramp is keyed on the particle's own life, so every key sits in 0..1.
      for (const ramp of [emitter.color, emitter.opacity, emitter.scale]) {
        for (const time of ramp.times) assert.ok(time >= 0 && time <= 1, `${path}: ramp key inside a life`);
      }
    }
  }
  assert.ok(total >= 20, `expected a couple of dozen emitters, found ${total}`);
});

test("a spherical emitter and a planar one both turn up in real data", withSamples, async () => {
  const kinds = new Set();
  for (const { data, block } of await samples()) {
    for (const emitter of readParticleEmitters(data, block)) kinds.add(emitter.emitterType);
  }
  assert.ok(kinds.has(EMITTER_PLANE), "a plane generator");
  assert.ok(kinds.has(EMITTER_SPHERE), "a sphere generator");
});

test("an emitter survives the trip into the artifact and back", withSamples, async () => {
  const [first] = await samples();
  assert.ok(first, "at least one model with emitters");
  const emitters = readParticleEmitters(first.data, first.block);
  const ribbons = readRibbonEmitters(first.data, array(first.data, HEADER.ribbonEmitters));
  const globalSequences = readGlobalSequences(first.data, array(first.data, HEADER.globalLoops));

  // A minimal mesh, because this is about the emitter block and not about geometry.
  const model = {
    positions: new Float32Array([0, 0, 0]),
    normals: new Float32Array([0, 0, 1]),
    uv0: new Float32Array([0, 0]),
    uv1: new Float32Array([0, 0]),
    boneIndices: new Uint8Array(4),
    boneWeights: new Uint8Array(4),
    indices: new Uint16Array([0]),
    submeshes: [], batches: [], textures: [],
    bounds: { min: [0, 0, 0], max: [0, 0, 0], radius: 0 },
  };
  const encoded = encodeWvm9(model, undefined, undefined,
    { globalSequences, particleEmitters: emitters, ribbonEmitters: ribbons });
  const decoded = decodeWvm9(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));

  assert.equal(decoded.particleEmitters.length, emitters.length);
  assert.deepEqual([...decoded.globalSequences], [...globalSequences]);
  for (let index = 0; index < emitters.length; index++) {
    const before = emitters[index];
    const after = decoded.particleEmitters[index];
    assert.equal(after.id, before.id);
    assert.equal(after.flags, before.flags);
    assert.equal(after.blendType, before.blendType);
    assert.equal(after.emitterType, before.emitterType);
    assert.equal(after.textureRows, before.textureRows);
    assert.equal(after.headTail, before.headTail);
    assert.ok(Math.abs(after.drag - before.drag) < 1e-5);
    assert.ok(Math.abs(after.spin - before.spin) < 1e-5);
    assert.deepEqual([...after.color.times], [...before.color.times]);
    assert.deepEqual([...after.opacity.values], [...before.opacity.values]);
    // The tracks keep their global-sequence binding, which is what makes a torch flicker.
    assert.equal(after.lifespan.globalSequence, before.lifespan.globalSequence);
    assert.equal(after.emissionRate.tracks.length, before.emissionRate.tracks.length);
  }
});

test("an emitter record says its own length, so an old reader can step over a new one", () => {
  // The WVM6 header had no room left to grow into — every byte assigned, seven spare bits in one
  // flags byte. A self-describing record is what buys the next addition.
  const emitter = blankEmitter();
  const encoded = encodeParticleEmitter(emitter);
  assert.equal(encoded.readUInt16LE(0), encoded.length);
  const ribbon = encodeRibbonEmitter(blankRibbon());
  assert.equal(ribbon.readUInt16LE(0), ribbon.length);
  assert.equal(RIBBON_RECORD_SIZE, 0xb0, "the v264 ribbon is 176 bytes, not the 172 one client uses");
});

function blankTrack() {
  return { interpolation: 0, globalSequence: -1, tracks: [] };
}
function blankRamp() {
  return { times: new Float32Array(0), values: new Float32Array(0) };
}
function blankEmitter() {
  const emitter = {
    id: 1, flags: 0, position: [0, 0, 0], bone: 0, texture: 0, blendType: 4, emitterType: 1,
    particleColorIndex: 0, particleType: 0, headTail: 0, textureTileRotation: 0,
    textureRows: 1, textureColumns: 1, lifespanVary: 0, emissionRateVary: 0, scaleVary: [0, 0],
    tailLength: 0, twinkleSpeed: 0, twinklePercent: 0, twinkleScaleMin: 0, twinkleScaleMax: 0,
    burstMultiplier: 0, drag: 0, baseSpin: 0, baseSpinVary: 0, spin: 0, spinVary: 0,
    windVector: [0, 0, 0], windTime: 0, followSpeed1: 0, followScale1: 0, followSpeed2: 0,
    followScale2: 0, splinePoints: new Float32Array(0),
  };
  for (const name of ["emissionSpeed", "speedVariation", "verticalRange", "horizontalRange",
    "gravity", "lifespan", "emissionRate", "emissionAreaLength", "emissionAreaWidth", "zSource",
    "enabledIn"]) emitter[name] = blankTrack();
  for (const name of ["color", "opacity", "scale", "headCell", "tailCell"]) emitter[name] = blankRamp();
  return emitter;
}
function blankRibbon() {
  const ribbon = {
    id: 1, bone: 0, position: [0, 0, 0], textures: new Uint16Array(0), materials: new Uint16Array(0),
    edgesPerSecond: 0, edgeLifetime: 0, gravity: 0, textureRows: 1, textureColumns: 1,
    priorityPlane: 0, ribbonColorIndex: 0, textureTransformLookupIndex: 0,
  };
  for (const name of ["color", "alpha", "heightAbove", "heightBelow", "textureSlot", "visibility"]) {
    ribbon[name] = blankTrack();
  }
  return ribbon;
}

/* --- The ribbon stride, against the client that settles it ---------------------------------- */

let archives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
} catch {
  archives = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };

/** Models chosen for how many ribbons they carry: a wrong stride fails on the second record. */
const RIBBON_MODELS = [
  "Spells/Arthas_Souls_Attack.m2",
  "spells/icecrown_frostmourne_altar_effect.m2",
  "Creature/Wisp/Wisp.m2",
];
const clientPath = (name) => name.split("/").join(String.fromCharCode(92));

test("the v264 ribbon record is 176 bytes, which no local model could show", withClient, async () => {
  // Three sources say 176 and one popular reference client hardcodes 172; none of the thirty-nine
  // unpacked models carries a single ribbon emitter to decide it on. The client does. At 172 a
  // model's second ribbon is read fourteen bytes short and every track after it lands on noise.
  let models = 0;
  for (const name of RIBBON_MODELS) {
    const data = await archives.read(clientPath(name)).catch(() => undefined);
    if (!data || data.subarray(0, 4).toString() !== "MD20" || data.readUInt32LE(4) !== 264) continue;
    const block = array(data, HEADER.ribbonEmitters);
    if (block.count < 2) continue;
    models++;
    const globals = readGlobalSequences(data, array(data, HEADER.globalLoops)).length;
    assert.equal(scoreRibbonStride(data, block, RIBBON_RECORD_SIZE, globals), 1,
      `${name}: every track of every ribbon decodes at 176`);
    assert.ok(scoreRibbonStride(data, block, 0xac, globals) < 0.9, `${name}: and does not at 172`);
  }
  assert.ok(models >= 2, `at least two multi-ribbon models, found ${models}`);
});

test("a ribbon's texture index points straight at the model's texture table", withClient, async () => {
  // Two reference clients call this a texture-*lookup* index, which would need a step through the
  // combo table first. Across all 1,502 ribbon emitters in the client every raw value is in range
  // of the model's own texture table, and 742 of them are out of range of the combo table — 249
  // of those because the model has no combo table at all. A lookup reading is not merely wrong,
  // it is impossible.
  let checked = 0;
  for (const name of RIBBON_MODELS) {
    const data = await archives.read(clientPath(name)).catch(() => undefined);
    if (!data || data.subarray(0, 4).toString() !== "MD20") continue;
    const textureCount = array(data, 0x50).count;
    for (const ribbon of readRibbonEmitters(data, array(data, HEADER.ribbonEmitters))) {
      assert.equal(ribbon.textures.length, 1, "one texture, always");
      assert.ok(ribbon.textures[0] < textureCount, `${name}: ${ribbon.textures[0]} of ${textureCount}`);
      // And the material arrived as what it means rather than as an index into a table the
      // artifact does not carry. Every one of these is additive, two-sided and unlit: 0x17.
      assert.equal(ribbon.materials.length, 1);
      assert.ok(ribbon.materials[0].blendMode <= 7, "a blend mode, not an index");
      checked++;
    }
  }
  assert.ok(checked >= 100, `at least a hundred ribbons, saw ${checked}`);
});

test("a real ribbon survives the trip into the artifact and back", withClient, async () => {
  // The first time this path has ever been exercised on a real file. The unpacked patch has no
  // ribbon emitters at all, so until the client was brought in, `encodeRibbonEmitter` had only
  // ever been given a blank record — and a defect that ate every ribbon's material sat in it
  // undetected, because `Uint16Array.prototype.map` coerces an object back to a number.
  const data = await archives.read(clientPath("Creature/Wisp/Wisp.m2"));
  assert.ok(data, "the wisp is in the client");
  const ribbons = readRibbonEmitters(data, array(data, HEADER.ribbonEmitters));
  assert.equal(ribbons.length, 3, "the wisp trails three ribbons");

  const model = {
    positions: new Float32Array([0, 0, 0]), normals: new Float32Array([0, 0, 1]),
    uv0: new Float32Array([0, 0]), uv1: new Float32Array([0, 0]),
    boneIndices: new Uint8Array(4), boneWeights: new Uint8Array(4), indices: new Uint16Array([0]),
    submeshes: [], batches: [],
    textures: Array.from({ length: 8 }, () => ({ type: 0, flags: 0, filename: "star.blp" })),
    bounds: { min: [0, 0, 0], max: [0, 0, 0], radius: 0 },
  };
  const encoded = encodeWvm9(model, undefined, undefined,
    { globalSequences: new Uint32Array(0), particleEmitters: [], ribbonEmitters: ribbons });
  const decoded = decodeWvm9(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));

  assert.equal(decoded.ribbonEmitters.length, 3);
  for (let index = 0; index < ribbons.length; index++) {
    const before = ribbons[index];
    const after = decoded.ribbonEmitters[index];
    assert.equal(after.bone, before.bone);
    assert.deepEqual([...after.textures], [...before.textures]);
    // Additive, and unlit, unfogged, two-sided and depth-test-free: 0x17. That is what a trail is.
    assert.deepEqual(after.materials, [{ blendMode: 4, flags: 23 }]);
    assert.ok(Math.abs(after.edgesPerSecond - before.edgesPerSecond) < 1e-5);
    assert.ok(Math.abs(after.edgeLifetime - before.edgeLifetime) < 1e-5);
    // A `uint8` track read as float32 would make these 1.4e-45 and 0 instead of 1 and 0.
    assert.deepEqual([...after.visibility.tracks[0].values], [1, 0]);
    assert.ok(after.heightAbove.tracks[0].values[0] > 0, "and the strip has a width");
  }
});
