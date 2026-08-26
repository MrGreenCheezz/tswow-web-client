// WVM9: one model, one file, no appearance baked in.
//
// WVM2 and WVM3 carried positions, one UV set, an index list rewritten into per-texture runs, and
// a list of resolved texture URLs. That last part is what made the format a dead end: the URLs
// were per-appearance, so one HumanMale.m2 became one artifact per skin and hair combination —
// 24,263 creature displays over 1,105 distinct models produced 17,217 cache keys, and adding
// geoset selection would have multiplied that again.
//
// WVM4 shipped the model as the file describes it. Texture *slots* are declared by type; which
// file fills a slot, and which geosets a particular character shows, are resolved in the browser
// from data it already fetches. So the artifact is keyed on the model path alone and every
// appearance shares it. WVM5 added the one thing that was still missing to dress a character: the
// attachment points, so a helm, a pauldron or a sword can hang off a bone and follow it.
//
// WVM6 is about what the model can *do*. Up to v5 the artifact carried a hand-picked list of
// animations and said nothing about the rest, so a model that could swim was indistinguishable
// from one that could not. Now it carries every animation the model has as a plain list of ids,
// and the keyframes of the locomotion set (tools/animations.mjs); the rest are published beside it
// as a WVA1 block and fetched the first time something asks to play one. A character model holds
// around 1.5 MiB of keyframes and a tenth of that is locomotion.
//
// WVM7 is about what the model *emits*. Up to v6 the artifact said nothing at all about particles:
// the header slot at 0x128 was counted and thrown away, so a bonfire shipped as an unlit log and a
// spell effect as empty air — in this game the effect very often *is* the particle system. Now the
// emitters travel with the model, along with the ribbons and the global sequences their tracks run
// on. Nothing here is simulated; this is the file's own description, in the file's own units.
//
// WVM8 is about what colour a batch is and whether it is drawn at all. Up to v7 the artifact
// carried each batch's `colorIndex` and `textureWeight` — the indices — and neither of the two
// tables they index, so every batch in the game was drawn at colour (1, 1, 1) and opacity 1.
// Measured over the 61,190 batches of the 22,112 models the drawing tables name: 4,415 are tinted
// by a colour the pipeline threw away, 7,126 are drawn dimmer than full, 6,207 are drawn at full
// strength when their own first key says invisible, and 2,198 in 552 models are not to be drawn at
// all — 405,910 triangles. It also carries the type-0 `M2Camera`, which is the frame the original
// client puts a portrait in: 24,033 of the 24,262 `CreatureDisplayInfo` rows resolve one.
//
// WVM9 is about UVs that move. `M2TextureTransform` — header slot 0x60 — was counted and dropped
// like the emitters before it, so every batch that names one drew its texture pinned in place:
// 517 batches in 174 models under `spells\` alone, which is a death-and-decay circle whose runes
// do not turn and a beam whose flow does not travel. Byte 70 of the header stops being reserved
// and becomes the record count; the block sits after the texture weights and before the portrait
// camera, and each record is the file's own three tracks — translation, rotation, scaling.
//
//   0  char[4] "WVM9"
//   4  u32   vertexCount
//   8  u32   indexCount
//  12  u8    bytes per index (2 or 4)
//  13  u8    flags: 1 skinned, 2 carries a portrait camera
//  14  u16   submeshCount
//  16  u16   batchCount
//  18  u16   textureCount
//  20  u32   offset of the skeleton block, 0 when absent
//  24  u32   total length, so a truncated response is caught before it is decoded
//  28  f32[7] bounding box min, max and sphere radius
//  56  u16   attachmentCount
//  58  u16   animationCount: every animation the model has, shipped here or not
//  60  u16   globalSequenceCount
//  62  u16   particleEmitterCount
//  64  u16   ribbonEmitterCount
//  66  u16   colourCount
//  68  u16   textureWeightCount
//  70  u16   textureTransformCount
//  72  body
//
// The body is positions, normals, uv0, uv1, then bone indices and weights when skinned, then the
// index list, submeshes, batches, the texture table, the attachment table, the animation list, the
// global sequence durations, the particle emitters, the ribbon emitters, the colours, the texture
// weights, the texture transforms and — last, when the flag says so — the portrait camera.
//
// Every emitter record leads with its own byte length, so a reader that does not understand a
// later addition can step over one instead of losing the rest of the file. That is the thing the
// WVM6 header could not do: bytes 0 to 59 were all assigned, with only seven spare bits in the
// flags byte, and there was nowhere to grow. The tracks below need no such length word: a track
// says how many sub-tracks it has and each says how many keys, so the reader that walks it knows
// where it ends without being told.

const encoder = new TextEncoder();

export const WVM9_MAGIC = "WVM9";
export const WVM9_HEADER_SIZE = 72;
export const WVM9_SKINNED = 0x01;
/** The model carries a type-0 `M2Camera`, written as 36 bytes at the very end of the body. */
export const WVM9_PORTRAIT_CAMERA = 0x02;
/** f32 fov (radians), f32 near, f32 far, f32 position[3], f32 target[3]. */
export const WVM9_CAMERA_SIZE = 36;
/** A submesh entry: geoset id, then where its triangles live in the shared index list. */
export const WVM9_SUBMESH_SIZE = 12;
/** A batch entry: everything needed to build one material and know when to draw it. */
export const WVM9_BATCH_SIZE = 20;
/**
 * An attachment entry: which point it is, which bone carries it, and where it sits.
 *
 * The position is stored even though it equals that bone's pivot in every one of the 20,155
 * attachment records in this client — measured to the bit, no float noise. Twelve bytes a record
 * is 468 on a 429 KiB HumanMale, and carrying it means the browser applies a general offset
 * rather than trusting an invariant that has to keep holding forever.
 */
export const WVM9_ATTACHMENT_SIZE = 16;

const TRACK_ROTATION = 1;
/** A clip header: which animation, reserved flags, how long, how many channels. */
const CLIP_HEADER_SIZE = 12;
export const WVA1_MAGIC = "WVA1";
export const WVA1_HEADER_SIZE = 12;

/**
 * @param model result of parseM2
 * @param skeleton result of parseM2Skeleton, or undefined for a static mesh
 * @param animations every animation id the model has, from m2Animations; defaults to the shipped
 *   clips, which is right for a model whose whole set travels with it
 */
export function encodeWvm9(model, skeleton, animations = undefined, effects = undefined) {
  const vertexCount = model.positions.length / 3;
  // Zero is allowed: a pure-emitter model has no geometry and is still a model. See tools/m2.mjs.
  if (!Number.isInteger(vertexCount)) throw new Error("WVM9 vertex count is not a whole number");
  if (model.normals.length !== vertexCount * 3 || model.uv0.length !== vertexCount * 2 || model.uv1.length !== vertexCount * 2) {
    throw new Error("WVM9 vertex streams disagree on the vertex count");
  }
  if (model.submeshes.length > 65_535 || model.batches.length > 65_535 || model.textures.length > 65_535) {
    throw new Error("WVM9 submesh, batch or texture table is too large");
  }
  const skinned = Boolean(skeleton);
  if (skinned && (model.boneIndices.length !== vertexCount * 4 || model.boneWeights.length !== vertexCount * 4)) {
    throw new Error("WVM9 skin weights do not match the vertex table");
  }

  const indexBytes = vertexCount > 65_535 ? 4 : 2;
  const names = model.textures.map((texture) => encoder.encode(texture.filename ?? ""));
  if (names.some((name) => name.length > 1000)) throw new Error("WVM9 texture path is too long");

  // An attachment names a bone, so it is only carried alongside the skeleton that gives it one.
  const attachments = (skinned ? skeleton.attachments ?? [] : [])
    .filter((attachment) => attachment.id < 65_536 && attachment.bone < skeleton.bones.length);
  if (attachments.length > 65_535) throw new Error("WVM9 attachment table is too large");

  // What the model can play, whether or not its keyframes are in this file. The browser needs it
  // to know that asking for the rest is worth a request — and to know when it is not.
  const available = [...new Set(skinned ? animations ?? skeleton.clips.map((clip) => clip.animationId) : [])]
    .filter((id) => Number.isInteger(id) && id >= 0 && id < 65_536)
    .sort((left, right) => left - right);
  if (available.length > 65_535) throw new Error("WVM9 animation list is too large");

  // The emitters, encoded before the size is worked out: each record is variable length and
  // leads with its own length, so the only way to know the total is to build them.
  const globalSequences = (effects?.globalSequences ?? []).slice(0, 65_535);
  const particleBlocks = (effects?.particleEmitters ?? []).slice(0, 65_535).map(encodeParticleEmitter);
  const ribbonBlocks = (effects?.ribbonEmitters ?? []).slice(0, 65_535).map(encodeRibbonEmitter);

  // The same shape for the same reason: a track's length is the sum of its sub-tracks' keys.
  const colourBlocks = (model.colours ?? []).slice(0, 65_535)
    .flatMap((colour) => [encodeTrack(colour.rgb, 3), encodeTrack(colour.alpha, 1)]);
  const weightBlocks = (model.textureWeights ?? []).slice(0, 65_535).map((weight) => encodeTrack(weight, 1));
  // Three tracks a record, and the reader walks them in threes. The rotation is a plain
  // `Quaternion` — four floats, not the packed `M2CompQuat` a bone track uses. See
  // `readTextureTransforms` in tools/m2.mjs for how that was settled.
  const transformBlocks = (model.textureTransforms ?? []).slice(0, 65_535)
    .flatMap((transform) => [
      encodeTrack(transform.translation, 3), encodeTrack(transform.rotation, 4), encodeTrack(transform.scaling, 3),
    ]);
  const camera = model.portraitCamera;

  const bodySize =
    vertexCount * (12 + 12 + 8 + 8)
    + (skinned ? vertexCount * 8 : 0)
    + model.indices.length * indexBytes
    + model.submeshes.length * WVM9_SUBMESH_SIZE
    + model.batches.length * WVM9_BATCH_SIZE
    + names.reduce((total, name) => total + 6 + name.length, 0)
    + attachments.length * WVM9_ATTACHMENT_SIZE
    + available.length * 2
    + globalSequences.length * 4
    + particleBlocks.reduce((total, block) => total + block.length, 0)
    + ribbonBlocks.reduce((total, block) => total + block.length, 0)
    + colourBlocks.reduce((total, block) => total + block.length, 0)
    + weightBlocks.reduce((total, block) => total + block.length, 0)
    + transformBlocks.reduce((total, block) => total + block.length, 0)
    + (camera ? WVM9_CAMERA_SIZE : 0);
  const skeletonBlock = skeleton ? encodeSkeleton(skeleton) : undefined;
  const total = WVM9_HEADER_SIZE + bodySize + (skeletonBlock?.length ?? 0);

  const data = Buffer.alloc(total);
  data.write(WVM9_MAGIC, 0, "ascii");
  data.writeUInt32LE(vertexCount, 4);
  data.writeUInt32LE(model.indices.length, 8);
  data.writeUInt8(indexBytes, 12);
  data.writeUInt8((skinned ? WVM9_SKINNED : 0) | (camera ? WVM9_PORTRAIT_CAMERA : 0), 13);
  data.writeUInt16LE(model.submeshes.length, 14);
  data.writeUInt16LE(model.batches.length, 16);
  data.writeUInt16LE(model.textures.length, 18);
  data.writeUInt32LE(skeletonBlock ? WVM9_HEADER_SIZE + bodySize : 0, 20);
  data.writeUInt32LE(total, 24);
  const bounds = model.bounds ?? { min: [0, 0, 0], max: [0, 0, 0], radius: 0 };
  for (let axis = 0; axis < 3; axis++) {
    data.writeFloatLE(bounds.min[axis], 28 + axis * 4);
    data.writeFloatLE(bounds.max[axis], 40 + axis * 4);
  }
  data.writeFloatLE(bounds.radius, 52);
  data.writeUInt16LE(attachments.length, 56);
  data.writeUInt16LE(available.length, 58);
  data.writeUInt16LE(globalSequences.length, 60);
  data.writeUInt16LE(particleBlocks.length, 62);
  data.writeUInt16LE(ribbonBlocks.length, 64);
  // Colours, not colour blocks: each colour is two tracks and the reader walks them in pairs.
  data.writeUInt16LE(colourBlocks.length / 2, 66);
  data.writeUInt16LE(weightBlocks.length, 68);
  // Transforms, not transform blocks: each one is three tracks, as colours are two.
  data.writeUInt16LE(transformBlocks.length / 3, 70);

  let offset = WVM9_HEADER_SIZE;
  for (const value of model.positions) data.writeFloatLE(value, offset), offset += 4;
  for (const value of model.normals) data.writeFloatLE(value, offset), offset += 4;
  for (const value of model.uv0) data.writeFloatLE(value, offset), offset += 4;
  for (const value of model.uv1) data.writeFloatLE(value, offset), offset += 4;
  if (skinned) {
    data.set(model.boneIndices, offset);
    offset += model.boneIndices.length;
    data.set(model.boneWeights, offset);
    offset += model.boneWeights.length;
  }
  for (const index of model.indices) {
    if (indexBytes === 2) data.writeUInt16LE(index, offset);
    else data.writeUInt32LE(index, offset);
    offset += indexBytes;
  }
  for (const submesh of model.submeshes) {
    data.writeUInt16LE(submesh.geosetId, offset);
    data.writeUInt16LE(0, offset + 2);
    data.writeUInt32LE(submesh.indexStart, offset + 4);
    data.writeUInt32LE(submesh.indexCount, offset + 8);
    offset += WVM9_SUBMESH_SIZE;
  }
  for (const batch of model.batches) {
    data.writeUInt16LE(batch.submesh, offset);
    data.writeUInt8(Math.min(255, batch.blendMode), offset + 2);
    data.writeUInt8(batch.materialFlags & 0xff, offset + 3);
    data.writeInt8(Math.max(-128, Math.min(127, batch.priorityPlane)), offset + 4);
    data.writeUInt8(Math.min(255, batch.materialLayer), offset + 5);
    data.writeUInt8(batch.textures.length, offset + 6);
    // One bit per texture unit saying which UV set it samples.
    data.writeUInt8(batch.uvSets.reduce((mask, set, unit) => set === 1 ? mask | (1 << unit) : mask, 0), offset + 7);
    data.writeInt16LE(batch.textures[0] ?? -1, offset + 8);
    data.writeInt16LE(batch.textures[1] ?? -1, offset + 10);
    data.writeInt16LE(batch.textureWeight ?? -1, offset + 12);
    data.writeInt16LE(batch.textureTransform ?? -1, offset + 14);
    data.writeUInt16LE(batch.shaderId & 0xffff, offset + 16);
    data.writeUInt16LE(batch.colorIndex & 0xffff, offset + 18);
    offset += WVM9_BATCH_SIZE;
  }
  for (let index = 0; index < model.textures.length; index++) {
    const texture = model.textures[index];
    data.writeUInt16LE(texture.type, offset);
    data.writeUInt16LE(texture.flags & 0xffff, offset + 2);
    data.writeUInt16LE(names[index].length, offset + 4);
    data.set(names[index], offset + 6);
    offset += 6 + names[index].length;
  }
  for (const attachment of attachments) {
    data.writeUInt16LE(attachment.id, offset);
    data.writeUInt16LE(attachment.bone, offset + 2);
    for (let axis = 0; axis < 3; axis++) data.writeFloatLE(attachment.position[axis], offset + 4 + axis * 4);
    offset += WVM9_ATTACHMENT_SIZE;
  }
  for (const id of available) {
    data.writeUInt16LE(id, offset);
    offset += 2;
  }
  for (const duration of globalSequences) {
    data.writeUInt32LE(duration, offset);
    offset += 4;
  }
  for (const block of [...particleBlocks, ...ribbonBlocks, ...colourBlocks, ...weightBlocks, ...transformBlocks]) {
    data.set(block, offset);
    offset += block.length;
  }
  if (camera) {
    // Radians, as the file stores it. Whether the angle is vertical or diagonal is the one thing
    // about this record that cannot be settled without looking at a screen, so it is carried as
    // the number the file holds and interpreted by whoever frames with it.
    data.writeFloatLE(camera.fov, offset);
    data.writeFloatLE(camera.near, offset + 4);
    data.writeFloatLE(camera.far, offset + 8);
    for (let axis = 0; axis < 3; axis++) {
      data.writeFloatLE(camera.position[axis], offset + 12 + axis * 4);
      data.writeFloatLE(camera.target[axis], offset + 24 + axis * 4);
    }
    offset += WVM9_CAMERA_SIZE;
  }
  if (offset !== WVM9_HEADER_SIZE + bodySize) throw new Error("WVM9 body size mismatch");
  if (skeletonBlock) data.set(skeletonBlock, offset);
  return data;
}

/* --- Emitters -------------------------------------------------------------------------------
   Two shapes travel here, and they are not the same shape in the M2 either. An `M2Track` is keyed
   on the animation timeline and nests one sub-array per sequence; an `FBlock` is keyed on one
   particle's own life, from birth to death, and has no nesting at all. Confusing the two is the
   classic way to read this block wrong, so they are encoded differently on purpose. */

/** A track: interpolation, the global sequence it may be bound to, and its per-sequence keys. */
function encodeTrack(track, components) {
  const subTracks = (track?.tracks ?? []).filter((sub) => sub.times.length > 0).slice(0, 255);
  const size = 4 + subTracks.reduce((total, sub) => total + 4 + sub.times.length * (4 + components * 4), 0);
  const data = Buffer.alloc(size);
  data.writeUInt8(Math.min(255, track?.interpolation ?? 0), 0);
  // −1 means "runs on the model's own animation". Anything else names a global loop.
  data.writeInt8(Math.max(-1, Math.min(127, track?.globalSequence ?? -1)), 1);
  data.writeUInt8(components, 2);
  data.writeUInt8(subTracks.length, 3);
  let offset = 4;
  for (const sub of subTracks) {
    data.writeUInt16LE(sub.sequence, offset);
    data.writeUInt16LE(sub.times.length, offset + 2);
    offset += 4;
    for (const time of sub.times) {
      data.writeUInt32LE(time, offset);
      offset += 4;
    }
    for (const value of sub.values) {
      data.writeFloatLE(value, offset);
      offset += 4;
    }
  }
  return data;
}

/** A ramp over one particle's life. Times are already normalised to 0..1 by the reader. */
function encodeRamp(ramp, components) {
  const keys = Math.min(ramp?.times.length ?? 0, 65_535);
  const data = Buffer.alloc(4 + keys * (4 + components * 4));
  data.writeUInt8(components, 0);
  data.writeUInt8(0, 1);
  data.writeUInt16LE(keys, 2);
  let offset = 4;
  for (let key = 0; key < keys; key++) {
    data.writeFloatLE(ramp.times[key], offset);
    offset += 4;
  }
  for (let key = 0; key < keys; key++) {
    for (let part = 0; part < components; part++) {
      data.writeFloatLE(ramp.values[key * components + part], offset);
      offset += 4;
    }
  }
  return data;
}

/** The eleven tracks of a particle emitter, in the order the record itself lists them. */
const PARTICLE_TRACKS = [
  "emissionSpeed", "speedVariation", "verticalRange", "horizontalRange", "gravity", "lifespan",
  "emissionRate", "emissionAreaLength", "emissionAreaWidth", "zSource", "enabledIn",
];
/** The five ramps, with how many components each key carries. */
const PARTICLE_RAMPS = [["color", 3], ["opacity", 1], ["scale", 2], ["headCell", 1], ["tailCell", 1]];

export function encodeParticleEmitter(emitter) {
  const tracks = PARTICLE_TRACKS.map((name) => encodeTrack(emitter[name], 1));
  const ramps = PARTICLE_RAMPS.map(([name, components]) => encodeRamp(emitter[name], components));
  const splinePoints = Math.min(emitter.splinePoints.length / 3, 4095);
  // 40 bytes of header up to and including the spline count, then twenty-three floats.
  const fixed = 40 + 23 * 4;
  const size = fixed + splinePoints * 12
    + tracks.reduce((total, block) => total + block.length, 0)
    + ramps.reduce((total, block) => total + block.length, 0);
  const data = Buffer.alloc(size);

  // Its own length first, so a reader from an older build can step over a record it cannot use.
  data.writeUInt16LE(size, 0);
  data.writeInt32LE(emitter.id, 2);
  data.writeUInt32LE(emitter.flags, 6);
  for (let axis = 0; axis < 3; axis++) data.writeFloatLE(emitter.position[axis], 10 + axis * 4);
  data.writeUInt16LE(emitter.bone, 22);
  data.writeUInt16LE(emitter.texture, 24);
  data.writeUInt8(emitter.blendType, 26);
  data.writeUInt8(emitter.emitterType, 27);
  data.writeUInt8(emitter.particleType, 28);
  data.writeUInt8(emitter.headTail, 29);
  data.writeUInt16LE(emitter.particleColorIndex, 30);
  data.writeInt16LE(emitter.textureTileRotation, 32);
  data.writeUInt16LE(emitter.textureRows, 34);
  data.writeUInt16LE(emitter.textureColumns, 36);
  data.writeUInt16LE(splinePoints, 38);
  let offset = 40;
  const floats = [
    emitter.lifespanVary, emitter.emissionRateVary,
    emitter.scaleVary[0], emitter.scaleVary[1],
    emitter.tailLength, emitter.twinkleSpeed, emitter.twinklePercent,
    emitter.twinkleScaleMin, emitter.twinkleScaleMax,
    emitter.burstMultiplier, emitter.drag,
    emitter.baseSpin, emitter.baseSpinVary, emitter.spin, emitter.spinVary,
    emitter.windVector[0], emitter.windVector[1], emitter.windVector[2], emitter.windTime,
    emitter.followSpeed1, emitter.followScale1, emitter.followSpeed2, emitter.followScale2,
  ];
  for (const value of floats) {
    data.writeFloatLE(Number.isFinite(value) ? value : 0, offset);
    offset += 4;
  }
  for (let point = 0; point < splinePoints * 3; point++) {
    data.writeFloatLE(emitter.splinePoints[point], offset);
    offset += 4;
  }
  for (const block of [...tracks, ...ramps]) {
    data.set(block, offset);
    offset += block.length;
  }
  if (offset !== size) throw new Error("WVM9 particle emitter size mismatch");
  return data;
}

/** The six tracks of a ribbon, in record order. Colour is the only one with three components. */
const RIBBON_TRACKS = [["color", 3], ["alpha", 1], ["heightAbove", 1], ["heightBelow", 1],
  ["textureSlot", 1], ["visibility", 1]];

export function encodeRibbonEmitter(ribbon) {
  const tracks = RIBBON_TRACKS.map(([name, components]) => encodeTrack(ribbon[name], components));
  const textures = Math.min(ribbon.textures.length, 255);
  const materials = Math.min(ribbon.materials.length, 255);
  // 44 bytes up to and including the two lookup indices, then the two index arrays.
  const fixed = 44;
  const size = fixed + textures * 2 + materials * 2
    + tracks.reduce((total, block) => total + block.length, 0);
  const data = Buffer.alloc(size);

  data.writeUInt16LE(size, 0);
  data.writeInt32LE(ribbon.id, 2);
  data.writeUInt32LE(ribbon.bone, 6);
  for (let axis = 0; axis < 3; axis++) data.writeFloatLE(ribbon.position[axis], 10 + axis * 4);
  data.writeUInt8(textures, 22);
  data.writeUInt8(materials, 23);
  data.writeFloatLE(ribbon.edgesPerSecond, 24);
  data.writeFloatLE(ribbon.edgeLifetime, 28);
  data.writeFloatLE(ribbon.gravity, 32);
  data.writeUInt16LE(ribbon.textureRows, 36);
  data.writeUInt16LE(ribbon.textureColumns, 38);
  data.writeInt16LE(ribbon.priorityPlane, 40);
  data.writeInt8(ribbon.ribbonColorIndex, 42);
  data.writeInt8(ribbon.textureTransformLookupIndex, 43);
  let offset = 44;
  for (let index = 0; index < textures; index++) {
    data.writeUInt16LE(ribbon.textures[index], offset);
    offset += 2;
  }
  // A blend mode and a flag byte, not an index: what the ribbon's material meant, resolved by the
  // reader that could still see the table it came from.
  for (let index = 0; index < materials; index++) {
    data.writeUInt8(Math.min(255, ribbon.materials[index]?.blendMode ?? 0), offset);
    data.writeUInt8(Math.min(255, ribbon.materials[index]?.flags ?? 0), offset + 1);
    offset += 2;
  }
  for (const block of tracks) {
    data.set(block, offset);
    offset += block.length;
  }
  if (offset !== size) throw new Error("WVM9 ribbon emitter size mismatch");
  return data;
}

/**
 * Bones, their flags and the keyframes of whatever clips travel inside the model.
 *
 * There is no "looping" word any more. Nothing in the M2 says an animation repeats — `replay` is
 * 0..0 on Stand, Walk and Run alike, and AnimationData's flags mark the fallback relationship, not
 * the loop — so up to v5 the answer was three ids written into the exporter by hand. Whether a
 * pose repeats is a property of the state playing it: locomotion loops, a jump landing does not.
 * The browser decides, and the slot is left reserved rather than filled with a guess.
 */
function encodeSkeleton(skeleton) {
  if (skeleton.bones.length === 0 || skeleton.bones.length > 1024) throw new Error("WVM9 skeleton is out of range");
  const clips = encodeClips(skeleton.clips);
  const block = Buffer.alloc(4 + skeleton.bones.length * 16 + clips.length);
  block.writeUInt16LE(skeleton.bones.length, 0);
  block.writeUInt16LE(skeleton.clips.length, 2);
  let offset = 4;
  for (const bone of skeleton.bones) {
    block.writeInt16LE(bone.parent, offset);
    block.writeUInt16LE(bone.flags & 0xffff, offset + 2);
    for (let axis = 0; axis < 3; axis++) block.writeFloatLE(bone.pivot[axis], offset + 4 + axis * 4);
    offset += 16;
  }
  block.set(clips, offset);
  return block;
}

/**
 * The animations that did not travel with the model, in their own artifact.
 *
 * Same clip encoding as the skeleton block, so one reader serves both. The bone count is carried
 * to catch the one mistake this arrangement makes possible: pairing a block of clips with a
 * different model's rig, which would pose bones that mean something else.
 *
 *   0  char[4] "WVA1"
 *   4  u32   total length
 *   8  u16   boneCount of the rig these clips belong to
 *  10  u16   clipCount
 *  12  clips
 */
export function encodeWvaAnimations(boneCount, clips) {
  if (boneCount === 0 || boneCount > 1024) throw new Error("WVA1 bone count is out of range");
  const body = encodeClips(clips);
  const data = Buffer.alloc(WVA1_HEADER_SIZE + body.length);
  data.write(WVA1_MAGIC, 0, "ascii");
  data.writeUInt32LE(data.length, 4);
  data.writeUInt16LE(boneCount, 8);
  data.writeUInt16LE(clips.length, 10);
  data.set(body, WVA1_HEADER_SIZE);
  return data;
}

function encodeClips(clips) {
  if (clips.length > 1024) throw new Error("WVM9 clip count is out of range");
  let size = 0;
  for (const clip of clips) {
    size += CLIP_HEADER_SIZE;
    for (const channel of clip.channels) {
      size += 8 + channel.times.length * 4 + channel.values.length * (channel.kind === TRACK_ROTATION ? 2 : 4);
    }
  }

  const block = Buffer.alloc(size);
  let offset = 0;
  for (const clip of clips) {
    block.writeUInt16LE(clip.animationId, offset);
    block.writeUInt16LE(0, offset + 2);
    block.writeUInt32LE(clip.duration, offset + 4);
    block.writeUInt32LE(clip.channels.length, offset + 8);
    offset += CLIP_HEADER_SIZE;
    for (const channel of clip.channels) {
      block.writeUInt16LE(channel.bone, offset);
      block.writeUInt8(channel.kind, offset + 2);
      block.writeUInt8(Math.min(255, channel.interpolation), offset + 3);
      block.writeUInt32LE(channel.times.length, offset + 4);
      offset += 8;
      for (const time of channel.times) {
        block.writeUInt32LE(time, offset);
        offset += 4;
      }
      for (const value of channel.values) {
        if (channel.kind === TRACK_ROTATION) block.writeInt16LE(value, offset), offset += 2;
        else block.writeFloatLE(value, offset), offset += 4;
      }
    }
  }
  if (offset !== size) throw new Error("WVM9 clip block size mismatch");
  return block;
}
