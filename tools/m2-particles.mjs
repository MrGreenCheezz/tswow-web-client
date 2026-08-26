// Particle and ribbon emitters out of an MD20 v264, and the global sequences they run on.
//
// The layout below is not guessed and not copied. It was established from four independent
// sources and then checked on six real 3.3.5a files: at a stride of 476
// bytes all eleven M2Tracks and all five FBlocks of every emitter decode to sane values, while
// 472, 480 and 492 all fail on the second emitter. The ribbon stride is 176 rather than the 172
// one popular reference client uses — that constant fails against real v264 files.
//
// Two shapes matter and are easy to confuse:
//
//   M2Track  = 20 bytes {u16 interpolation, i16 globalSequence, M2Array times, M2Array values},
//              and the two arrays are arrays *of arrays* — one sub-array per animation sequence.
//   FBlock   = 16 bytes {M2Array times, M2Array keys}, flat, with no interpolation word in front
//              and no per-sequence nesting. Its timeline is the particle's own life, 0 to 32767.
//
// Reading an FBlock as an M2Track shifts every field after it, which is exactly the failure the
// stride check above catches.

const PARTICLE_SIZE = 0x1dc;
const RIBBON_SIZE = 0xb0;
const TRACK_SIZE = 0x14;
const FBLOCK_SIZE = 0x10;

/**
 * `M2Particle.flags`, cross-checked against the v264 client corpus.
 *
 * Six of these were one bit off when they were first written down, and all six were wrong in the
 * same direction — a later bit's name given to an earlier bit. Nothing had read them yet, so
 * nothing complained; the first reader would have found every emitter in the world lit,
 * world-space and outward-flying at once.
 */
export const PARTICLE_FLAG_LIT = 0x00000001;
/** Particles rise along world up rather than along the model's own. */
export const PARTICLE_FLAG_WORLD_UP = 0x00000008;
export const PARTICLE_FLAG_DONT_TRAIL = 0x00000010;
export const PARTICLE_FLAG_BURST = 0x00000040;
/** Particles stay in the model's frame, so posing the emitter carries them with it. */
export const PARTICLE_FLAG_MODEL_SPACE = 0x00000080;
export const PARTICLE_FLAG_RANDOM_SPAWN = 0x00000200;
/** The quad stretches from where the particle was born to where it is now. */
export const PARTICLE_FLAG_PINNED = 0x00000400;
/** Axis-aligned in XY and facing up, rather than facing the camera. */
export const PARTICLE_FLAG_XY_QUAD = 0x00001000;
export const PARTICLE_FLAG_GROUND_CLAMP = 0x00002000;
export const PARTICLE_FLAG_RANDOM_TEXTURE = 0x00010000;
export const PARTICLE_FLAG_OUTWARD = 0x00020000;
export const PARTICLE_FLAG_INWARD = 0x00040000;
export const PARTICLE_FLAG_SCALE_VARY_INDEPENDENT = 0x00080000;
export const PARTICLE_FLAG_RANDOM_FLIPBOOK = 0x00200000;
/** With this set the gravity track holds a packed direction and strength, not a plain scalar. */
export const PARTICLE_FLAG_COMPRESSED_GRAVITY = 0x00800000;
export const PARTICLE_FLAG_BONE_GENERATOR = 0x01000000;

/** `M2Particle.emitterType`. */
export const EMITTER_PLANE = 1;
export const EMITTER_SPHERE = 2;
export const EMITTER_SPLINE = 3;
export const EMITTER_BONE = 4;

function array(buffer, at) {
  return { count: buffer.readUInt32LE(at), offset: buffer.readUInt32LE(at + 4) };
}

function fits(buffer, block, stride) {
  return block.count === 0
    || (block.offset > 0 && block.offset + block.count * stride <= buffer.length);
}

/** How many components one M2Track value has, by the reader that asked for it. */
const SCALAR = 1;

/** Bytes one key of each M2Track payload occupies on disk. */
const KEY_WIDTH = { float: 4, fixed16: 2, uint16: 2, uint8: 1 };

/**
 * One key of an M2Track, in whatever width the field is declared with.
 *
 * Not every track holds floats, and the ones that do not are the ones that decide whether
 * anything is drawn at all. `enabledIn` is `M2Track<uint8>`: read four bytes where the file
 * wrote one and a stored 1 arrives as 1.4e-45, a denormal that is greater than zero and fails
 * every threshold anyone would compare it against. Measured on the two local models that carry
 * the track — sunwell_beamfx.m2 and sunwell_beamfx_3s.m2, two emitters each — all four decoded
 * to exactly that number, which is to say every one of those emitters read as switched off
 * forever. A ribbon's `alpha`, `textureSlot` and `visibility` are the same trap in the same
 * shape; there is no local ribbon model to measure, so they are fixed by declaration.
 */
function readKey(buffer, at, kind) {
  switch (kind) {
    case "fixed16": return buffer.readUInt16LE(at) / 32767;
    case "uint16": return buffer.readUInt16LE(at);
    case "uint8": return buffer.readUInt8(at);
    default: return buffer.readFloatLE(at);
  }
}

/**
 * One `M2Track`, flattened to the sub-tracks that actually carry keys.
 *
 * The nesting is per animation sequence, and almost every emitter fills one of them or none at
 * all — so an empty sub-track is dropped rather than stored, and a track bound to a global
 * sequence keeps that binding instead of pretending to belong to sequence zero.
 *
 * Exported because `tools/m2.mjs` reads the same shape for `M2Color` and `M2TextureWeight`. A
 * second copy of the nesting rule in the file next door is exactly the drift that put the
 * `FBlock`/`M2Track` confusion into this pipeline in the first place.
 */
export function readTrack(buffer, at, components = SCALAR, kind = "float") {
  if (at + TRACK_SIZE > buffer.length) return { interpolation: 0, globalSequence: -1, tracks: [] };
  const interpolation = buffer.readUInt16LE(at);
  const globalSequence = buffer.readInt16LE(at + 2);
  const times = array(buffer, at + 4);
  const values = array(buffer, at + 12);
  const tracks = [];
  const sequences = Math.min(times.count, values.count);
  if (sequences > 0 && sequences <= 1024 && fits(buffer, times, 8) && fits(buffer, values, 8)) {
    for (let sequence = 0; sequence < sequences; sequence++) {
      const timeBlock = array(buffer, times.offset + sequence * 8);
      const valueBlock = array(buffer, values.offset + sequence * 8);
      if (timeBlock.count === 0 || timeBlock.count !== valueBlock.count || timeBlock.count > 20_000) continue;
      const width = KEY_WIDTH[kind] ?? 4;
      if (!fits(buffer, timeBlock, 4) || !fits(buffer, valueBlock, components * width)) continue;
      const keyTimes = new Uint32Array(timeBlock.count);
      const keyValues = new Float32Array(timeBlock.count * components);
      for (let key = 0; key < timeBlock.count; key++) {
        keyTimes[key] = buffer.readUInt32LE(timeBlock.offset + key * 4);
        for (let part = 0; part < components; part++) {
          keyValues[key * components + part] = readKey(buffer, valueBlock.offset + (key * components + part) * width, kind);
        }
      }
      tracks.push({ sequence, times: keyTimes, values: keyValues });
    }
  }
  return { interpolation, globalSequence, tracks };
}

/**
 * How one FBlock key is stored, and what it has to be multiplied by to mean something.
 *
 * Four ramps, four different answers, and only one of them is a plain float. Colour keys are
 * floats but on 0..255 — measured across all 264 colour keys in the nine local models with
 * emitters, the range is exactly 0 to 255. Opacity is `uint16` over 0..32767. And the two cell
 * ramps are `uint16` holding a flipbook *cell number*: scaling those by 1/32767 turns cell 1 into
 * 0.0000305, which is what `8fx_generic_shadow_debuff.m2` was reporting for a 2x4 atlas.
 */
const FBLOCK_KINDS = {
  float: { width: 4, read: (buffer, at) => buffer.readFloatLE(at) },
  color: { width: 4, read: (buffer, at) => buffer.readFloatLE(at) / 255 },
  fixed16: { width: 2, read: (buffer, at) => buffer.readUInt16LE(at) / 32767 },
  uint16: { width: 2, read: (buffer, at) => buffer.readUInt16LE(at) },
};

/**
 * One `FBlock`: a ramp over a particle's own life rather than over an animation.
 *
 * The timestamps are `uint16` on a 0..32767 scale, which is where the odd-looking division comes
 * from — a key at 16384 is halfway through whatever lifespan that particle was given.
 */
function readFBlock(buffer, at, components, kind) {
  if (at + FBLOCK_SIZE > buffer.length) return { times: new Float32Array(0), values: new Float32Array(0) };
  const times = array(buffer, at);
  const keys = array(buffer, at + 8);
  const count = Math.min(times.count, keys.count);
  const shape = FBLOCK_KINDS[kind] ?? FBLOCK_KINDS.float;
  const valueStride = components * shape.width;
  if (count === 0 || count > 20_000 || !fits(buffer, times, 2) || !fits(buffer, keys, valueStride)) {
    return { times: new Float32Array(0), values: new Float32Array(0) };
  }
  const keyTimes = new Float32Array(count);
  const keyValues = new Float32Array(count * components);
  for (let key = 0; key < count; key++) {
    keyTimes[key] = buffer.readUInt16LE(times.offset + key * 2) / 32767;
    for (let part = 0; part < components; part++) {
      keyValues[key * components + part] = shape.read(buffer, keys.offset + key * valueStride + part * shape.width);
    }
  }
  return { times: keyTimes, values: keyValues };
}

/**
 * Every particle emitter in the model.
 *
 * Nothing is resolved and nothing is simulated: this is the file's own description, in the file's
 * own units, for whoever draws it. An emitter whose record runs past the end of the file is
 * dropped rather than read as noise — a truncated or repacked model should lose its sparks, not
 * its geometry.
 */
export function readParticleEmitters(model, block) {
  if (block.count === 0 || block.count > 512 || !fits(model, block, PARTICLE_SIZE)) return [];
  const emitters = [];
  for (let index = 0; index < block.count; index++) {
    const at = block.offset + index * PARTICLE_SIZE;
    const flags = model.readUInt32LE(at + 0x04);
    emitters.push({
      id: model.readInt32LE(at + 0x00),
      flags,
      position: [model.readFloatLE(at + 0x08), model.readFloatLE(at + 0x0c), model.readFloatLE(at + 0x10)],
      bone: model.readUInt16LE(at + 0x14),
      texture: model.readUInt16LE(at + 0x16),
      blendType: model.readUInt8(at + 0x28),
      emitterType: model.readUInt8(at + 0x29),
      particleColorIndex: model.readUInt16LE(at + 0x2a),
      // The two bytes the WotLK layout calls `particleType` and `headorTail` do not hold the
      // 0/1/2 enum the layout says they do. On the stock client they hold nothing at all: both
      // are zero on every one of the 25,201 emitters in its 22,071 v264 models. Where they are
      // not zero — in downported models from later expansions — they take the values 4, 6, 8, 9,
      // 16, 19, 24 and 32, which as the `fp_2_5` fixed point that sits at this offset from
      // Burning Crusade onwards read as 1/8, 3/16, 1/4, 9/32, 1/2, 19/32, 3/4 and 1. An enum of
      // three does not produce 24. They travel because they are in the record; nothing reads
      // them as a mode.
      particleType: model.readUInt8(at + 0x2c),
      headTail: model.readUInt8(at + 0x2d),
      textureTileRotation: model.readInt16LE(at + 0x2e),
      textureRows: model.readUInt16LE(at + 0x30),
      textureColumns: model.readUInt16LE(at + 0x32),

      emissionSpeed: readTrack(model, at + 0x034),
      speedVariation: readTrack(model, at + 0x048),
      verticalRange: readTrack(model, at + 0x05c),
      horizontalRange: readTrack(model, at + 0x070),
      // With `COMPRESSED_GRAVITY` the value is a packed direction plus strength rather than a
      // scalar, and reading it as a float gives a plausible-looking number pointing nowhere.
      gravity: readTrack(model, at + 0x084),
      lifespan: readTrack(model, at + 0x098),
      lifespanVary: model.readFloatLE(at + 0x0ac),
      emissionRate: readTrack(model, at + 0x0b0),
      emissionRateVary: model.readFloatLE(at + 0x0c4),
      emissionAreaLength: readTrack(model, at + 0x0c8),
      emissionAreaWidth: readTrack(model, at + 0x0dc),
      zSource: readTrack(model, at + 0x0f0),

      color: readFBlock(model, at + 0x104, 3, "color"),
      opacity: readFBlock(model, at + 0x114, 1, "fixed16"),
      scale: readFBlock(model, at + 0x124, 2, "float"),
      scaleVary: [model.readFloatLE(at + 0x134), model.readFloatLE(at + 0x138)],
      headCell: readFBlock(model, at + 0x13c, 1, "uint16"),
      tailCell: readFBlock(model, at + 0x14c, 1, "uint16"),

      tailLength: model.readFloatLE(at + 0x15c),
      twinkleSpeed: model.readFloatLE(at + 0x160),
      twinklePercent: model.readFloatLE(at + 0x164),
      twinkleScaleMin: model.readFloatLE(at + 0x168),
      twinkleScaleMax: model.readFloatLE(at + 0x16c),
      burstMultiplier: model.readFloatLE(at + 0x170),
      drag: model.readFloatLE(at + 0x174),
      baseSpin: model.readFloatLE(at + 0x178),
      baseSpinVary: model.readFloatLE(at + 0x17c),
      spin: model.readFloatLE(at + 0x180),
      spinVary: model.readFloatLE(at + 0x184),
      windVector: [model.readFloatLE(at + 0x1a0), model.readFloatLE(at + 0x1a4), model.readFloatLE(at + 0x1a8)],
      windTime: model.readFloatLE(at + 0x1ac),
      followSpeed1: model.readFloatLE(at + 0x1b0),
      followScale1: model.readFloatLE(at + 0x1b4),
      followSpeed2: model.readFloatLE(at + 0x1b8),
      followScale2: model.readFloatLE(at + 0x1bc),
      splinePoints: readVectorArray(model, array(model, at + 0x1c0)),
      // A `uint8` track, one byte a key: zero means the emitter is off for that stretch of the
      // animation, which is how a cast's sparks know to stop.
      enabledIn: readTrack(model, at + 0x1c8, SCALAR, "uint8"),
    });
  }
  return emitters;
}

function readVectorArray(model, block) {
  if (block.count === 0 || block.count > 4096 || !fits(model, block, 12)) return new Float32Array(0);
  const points = new Float32Array(block.count * 3);
  for (let index = 0; index < block.count; index++) {
    for (let part = 0; part < 3; part++) points[index * 3 + part] = model.readFloatLE(block.offset + index * 12 + part * 4);
  }
  return points;
}

/** The header slot this reader resolves a ribbon's material index against. */
const HEADER_MATERIALS = 0x70;
const MATERIAL_SIZE = 4;

/**
 * The render-flag table a ribbon's `materials` array points into.
 *
 * That table is the one thing here the artifact does not carry and never will: a batch folds its
 * material into a blend mode and a flag byte on the way out, and a ribbon has no batch to fold
 * into. Resolving it here is what makes the record self-contained — shipping the raw index would
 * ship a number pointing at a table the browser cannot see.
 *
 * Its neighbour `textures` needs no such help, and it took a measurement to be sure: two of the
 * reference clients call it a texture-*lookup* index, which would need a step through the combo
 * table first. Across all 1,502 ribbon emitters in the 22,071 v264 models of the client, every
 * raw value is in range of the model's own texture table and 742 of them — 49% — are out of range
 * of the combo table, 249 because the model has no combo table at all. A lookup reading is not
 * merely wrong, it is impossible. Both arrays are length 1 on all 1,502.
 */
function ribbonLookups(model) {
  const block = array(model, HEADER_MATERIALS);
  const materials = fits(model, block, MATERIAL_SIZE) && block.count <= 10_000
    ? Array.from({ length: block.count }, (_, index) => ({
      flags: model.readUInt16LE(block.offset + index * MATERIAL_SIZE),
      blendMode: model.readUInt16LE(block.offset + index * MATERIAL_SIZE + 2),
    }))
    : [];
  return { materials };
}

/** Every ribbon emitter. The stride is 176 for v264; 172 is the pre-WotLK record. */
export function readRibbonEmitters(model, block) {
  if (block.count === 0 || block.count > 256 || !fits(model, block, RIBBON_SIZE)) return [];
  const { materials } = ribbonLookups(model);
  const ribbons = [];
  for (let index = 0; index < block.count; index++) {
    const at = block.offset + index * RIBBON_SIZE;
    const flags = readIndexArray(model, array(model, at + 0x1c));
    ribbons.push({
      id: model.readInt32LE(at + 0x00),
      bone: model.readUInt32LE(at + 0x04),
      position: [model.readFloatLE(at + 0x08), model.readFloatLE(at + 0x0c), model.readFloatLE(at + 0x10)],
      textures: readIndexArray(model, array(model, at + 0x14)),
      // `Array.from`, not `.map`: `flags` is a `Uint16Array`, and its `map` coerces whatever the
      // callback returns back to a number — so every resolved material became the integer 0.
      materials: Array.from(flags, (slot) => materials[slot] ?? { flags: 0, blendMode: 0 }),
      color: readTrack(model, at + 0x24, 3),
      alpha: readTrack(model, at + 0x38, SCALAR, "fixed16"),
      heightAbove: readTrack(model, at + 0x4c),
      heightBelow: readTrack(model, at + 0x60),
      edgesPerSecond: model.readFloatLE(at + 0x74),
      edgeLifetime: model.readFloatLE(at + 0x78),
      gravity: model.readFloatLE(at + 0x7c),
      textureRows: model.readUInt16LE(at + 0x80),
      textureColumns: model.readUInt16LE(at + 0x82),
      textureSlot: readTrack(model, at + 0x84, SCALAR, "uint16"),
      visibility: readTrack(model, at + 0x98, SCALAR, "uint8"),
      priorityPlane: model.readInt16LE(at + 0xac),
      ribbonColorIndex: model.readInt8(at + 0xae),
      textureTransformLookupIndex: model.readInt8(at + 0xaf),
    });
  }
  return ribbons;
}

function readIndexArray(model, block) {
  if (block.count === 0 || block.count > 256 || !fits(model, block, 2)) return new Uint16Array(0);
  const values = new Uint16Array(block.count);
  for (let index = 0; index < block.count; index++) values[index] = model.readUInt16LE(block.offset + index * 2);
  return values;
}

/**
 * The global sequences: a flat list of loop durations in milliseconds.
 *
 * A track bound to one of these runs on the world's clock rather than on the model's current
 * animation — which is what makes a torch flicker while its owner stands still.
 */
export function readGlobalSequences(model, block) {
  if (block.count === 0 || block.count > 1024 || !fits(model, block, 4)) return new Uint32Array(0);
  const durations = new Uint32Array(block.count);
  for (let index = 0; index < block.count; index++) durations[index] = model.readUInt32LE(block.offset + index * 4);
  return durations;
}

/**
 * A sanity score for one stride hypothesis, kept because it is how the stride was settled.
 *
 * Every emitter's eleven tracks and five ramps must have a plausible interpolation word, a global
 * sequence inside the model's own list, and array offsets that land inside the file. A wrong
 * stride fails this on the second record — the first one always decodes, whatever the stride,
 * because it starts where the header says it does.
 */
export function scoreParticleStride(model, block, stride, globalSequenceCount) {
  if (block.count < 2 || block.offset + block.count * stride > model.length) return 0;
  let good = 0;
  let total = 0;
  for (let index = 0; index < block.count; index++) {
    const at = block.offset + index * stride;
    for (const offset of [0x034, 0x048, 0x05c, 0x070, 0x084, 0x098, 0x0b0, 0x0c8, 0x0dc, 0x0f0, 0x1c8]) {
      total++;
      const interpolation = model.readUInt16LE(at + offset);
      const globalSequence = model.readInt16LE(at + offset + 2);
      const times = array(model, at + offset + 4);
      const values = array(model, at + offset + 12);
      const sane = interpolation <= 3
        && globalSequence >= -1 && globalSequence < globalSequenceCount
        && times.count === values.count && times.count <= 1024
        && fits(model, times, 8) && fits(model, values, 8);
      if (sane) good++;
    }
  }
  return total === 0 ? 0 : good / total;
}

/**
 * The same sanity score for one ribbon stride hypothesis.
 *
 * This existed as a question rather than a test: the study settled the particle stride on real
 * files and could not settle the ribbon's, because none of the thirty-nine local models carries a
 * ribbon at all, and one popular reference client uses 172 where three other sources say 176.
 * The client itself answers it — 305 of its 22,071 v264 models carry ribbons, 240 of them carry
 * two or more, and at 176 all 8,622 tracks of those 240 models decode sanely while at 172 only
 * 2,096 do and not one model is clean.
 */
export function scoreRibbonStride(model, block, stride, globalSequenceCount) {
  if (block.count < 2 || block.offset + block.count * stride > model.length) return 0;
  let good = 0;
  let total = 0;
  for (let index = 0; index < block.count; index++) {
    const at = block.offset + index * stride;
    for (const offset of [0x24, 0x38, 0x4c, 0x60, 0x84, 0x98]) {
      total++;
      const interpolation = model.readUInt16LE(at + offset);
      const globalSequence = model.readInt16LE(at + offset + 2);
      const times = array(model, at + offset + 4);
      const values = array(model, at + offset + 12);
      const sane = interpolation <= 3
        && globalSequence >= -1 && globalSequence < globalSequenceCount
        && times.count === values.count && times.count <= 1024
        && fits(model, times, 8) && fits(model, values, 8);
      if (sane) good++;
    }
  }
  return total === 0 ? 0 : good / total;
}

export const PARTICLE_RECORD_SIZE = PARTICLE_SIZE;
export const RIBBON_RECORD_SIZE = RIBBON_SIZE;
