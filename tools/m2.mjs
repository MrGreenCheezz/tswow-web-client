// MD20 (version 264, 3.3.5a) and its .skin profile, read whole.
//
// The parser this replaces read five header slots and two fields of each batch. Everything that
// says *how* to draw a model was dropped on the floor: the geoset id that picks one hairstyle out
// of thirteen, the blend mode that makes an eye glow additive instead of an opaque blue rectangle,
// the two-sided flag, the texture wrap flags, the authored vertex normals, the second UV set. It
// also merged submeshes by texture name and rewrote the index buffer, which destroyed the
// information in the published file so the browser could never recover it.
//
// This produces the model as the file describes it and resolves nothing. Which texture fills a
// slot, and which geosets a particular character shows, are decisions about one *appearance* —
// they belong in the browser, not baked into a per-appearance artifact on disk.
//
// Header offsets are the standard MD20 v264 layout. The ones this file did not inherit were
// checked by decoding them and seeing whether the result was meaningful: materials at 0x70 give
// blend modes in 0..7 and flag bits inside the documented mask, where the neighbouring arrays
// give noise.

import { readTrack } from "./m2-particles.mjs";

const HEADER = {
  globalLoops: 0x14,
  sequences: 0x1c,
  bones: 0x2c,
  vertices: 0x3c,
  colors: 0x48,
  textures: 0x50,
  textureWeights: 0x58,
  textureTransforms: 0x60,
  materials: 0x70,
  textureCombos: 0x80,
  textureCoordCombos: 0x88,
  textureWeightCombos: 0x90,
  textureTransformCombos: 0x98,
  boundingBox: 0xa0,
  attachments: 0xf0,
  events: 0x100,
  cameras: 0x110,
  ribbonEmitters: 0x120,
  particleEmitters: 0x128,
};

const VERTEX_SIZE = 48;
const SUBMESH_SIZE = 48;
const BATCH_SIZE = 24;
const TEXTURE_SIZE = 16;
const MATERIAL_SIZE = 4;
const SEQUENCE_SIZE = 64;
const BONE_SIZE = 88;
const TRACK_SIZE = 20;
/** M2Color: an RGB `M2Track<C3Vector>` followed by an alpha `M2Track<fixed16>`. */
const COLOR_SIZE = TRACK_SIZE * 2;
/** M2TextureTransform: translation, rotation and scaling, one `M2Track` each. */
const TEXTURE_TRANSFORM_SIZE = TRACK_SIZE * 3;
/**
 * M2Camera, at the stride this client's files actually use.
 *
 * Scored the way the attachment stride below was scored, over the 1,844 camera records in the
 * 1,323 readable models `CreatureModelData` names: a record decodes when its type is −1..8, its
 * FOV is 0.05..3.2 radians, near ≥ 0, far > near, and both base vectors sit inside the header
 * bounding box grown by a half. The ≤WotLK 100-byte layout decodes **1,578**; 92, 116 — the
 * Cataclysm record, where the FOV became a trailing track — and 120 all decode 1,087, which is
 * the same 1,087: one per model, the first record, which decodes whatever the stride is because
 * it starts where the header says it does.
 *
 *   u32 type, f32 fov, f32 farClip, f32 nearClip,
 *   M2Track positions (20), C3Vector positionBase (12),
 *   M2Track target (20),    C3Vector targetBase (12),
 *   M2Track roll (20)
 */
const CAMERA_SIZE = 100;
const CAMERA_POSITION_BASE = 36;
const CAMERA_TARGET_BASE = 68;
/** M2Camera.type 0 is the portrait: the frame the original client puts inside a unit frame. */
export const CAMERA_TYPE_PORTRAIT = 0;
/**
 * M2Attachment: u32 id, u16 bone, u16 unused, C3Vector position, then a 20-byte M2Track<u8>.
 *
 * The stride is measured, not looked up. Scoring 32, 36, 40, 44 and 48 over 3,452 records in 348
 * models on "does every record decode to a sane id, a bone inside the skeleton and a position
 * inside the bounding box" gives 3,420 for 40 and at most 782 for anything else — and the only
 * 32 failures are one model whose header bounding box is degenerate. The file geometry agrees: in
 * every model the next referenced byte is either exactly `offset + count * 40` or eight past it,
 * and it is eight past exactly when that address is 8 modulo 16, which is alignment padding
 * rather than a field nobody read.
 */
const ATTACHMENT_SIZE = 40;

/**
 * Attachment ids, named from where they sit rather than from a wiki.
 *
 * Every one of these was pinned on the twenty playable race and sex models by geometry alone: HELM
 * is a direct child of the bone whose keyBoneId is 6, the head, and sits at 88 to 95 % of the
 * height of the name-plate bone; BACK hangs off the lower spine with a negative — rearward — X on
 * all twenty; the hand and shoulder pairs reach the left and right arm key bones and mirror in Y
 * to within 0.07 m of each other.
 *
 * SHIELD is the one this cannot settle. Ids 0 and 49 are both on the left forearm, parented to the
 * same bone's parent, and 49 sits exactly 0.1389 m further out in Y on every single race — the
 * identical constant each time, so it is an authored duplicate-with-offset. Id 0 is also the mount
 * seat on mount models. 0 is used here because it is the one every model carries.
 */
export const ATTACHMENT_SHIELD = 0;
export const ATTACHMENT_HAND_RIGHT = 1;
export const ATTACHMENT_HAND_LEFT = 2;
export const ATTACHMENT_SHOULDER_RIGHT = 5;
export const ATTACHMENT_SHOULDER_LEFT = 6;
export const ATTACHMENT_HELM = 11;
export const ATTACHMENT_BACK = 12;

/** M2Material.blending_mode. */
export const BLEND_MODES = ["opaque", "alphaKey", "alpha", "noAlphaAdd", "add", "mod", "mod2x", "blendAdd"];

/** M2Material.flags. */
export const MATERIAL_UNLIT = 0x01;
export const MATERIAL_UNFOGGED = 0x02;
export const MATERIAL_TWO_SIDED = 0x04;
export const MATERIAL_BILLBOARD = 0x08;
export const MATERIAL_NO_DEPTH_TEST = 0x10;
export const MATERIAL_NO_DEPTH_WRITE = 0x20;

/** M2Texture.flags. Without these a clamped atlas tiles and pulls in its opposite edge. */
export const TEXTURE_WRAP_X = 0x01;
export const TEXTURE_WRAP_Y = 0x02;

/**
 * M2Texture.type. 0 names its own file; every other value is a slot the client fills in, and a
 * character model is nothing but slots. 2 is the equipment skin, which nothing has ever filled.
 */
export const TEXTURE_TYPE_OWN = 0;
export const TEXTURE_TYPE_BODY = 1;
export const TEXTURE_TYPE_OBJECT_SKIN = 2;
export const TEXTURE_TYPE_HAIR = 6;
export const TEXTURE_TYPE_SKIN_EXTRA = 8;
export const TEXTURE_TYPE_MONSTER_SKIN = [11, 12, 13];

/** M2CompBone.flags: the billboard bits three.js will never apply on its own. */
export const BONE_SPHERICAL_BILLBOARD = 0x08;
export const BONE_CYLINDRICAL_BILLBOARD = 0x10 | 0x20 | 0x40;
export const BONE_TRANSFORMED = 0x200;

export const TRACK_KINDS = { translation: 0, rotation: 1, scale: 2 };

/** M2Sequence.flags bit 0x20: the keyframes live in the .m2 rather than an external .anim. */
const SEQUENCE_DATA_INSIDE_M2 = 0x20;
/** Bit 0x40: this sequence has no data of its own and `aliasNext` names the one that does. */
const SEQUENCE_IS_ALIAS = 0x40;
const SEQUENCE_LOOPS = 0x01;
/** An alias chain longer than this is a file lying about itself; none in the client exceeds two. */
const MAX_ALIAS_HOPS = 8;

function array(buffer, at) {
  return { count: buffer.readUInt32LE(at), offset: buffer.readUInt32LE(at + 4) };
}

function fits(buffer, block, stride) {
  return block.offset + block.count * stride <= buffer.length;
}

function stringAt(buffer, offset, length) {
  if (length === 0 || offset + length > buffer.length) return "";
  return buffer.subarray(offset, offset + length).toString("utf8").replace(/\0+$/, "").replaceAll("/", "\\");
}

/**
 * The mesh, its materials and everything needed to decide what to draw — with nothing resolved.
 *
 * `indices` keeps the file's own order, because that order is the draw order: an M2's alpha and
 * additive batches only composite correctly when drawn as authored.
 */
export function parseM2(model, skin) {
  if (model.subarray(0, 4).toString() !== "MD20") throw new Error("Not an MD20 model");
  if (skin.subarray(0, 4).toString() !== "SKIN") throw new Error("Not a SKIN profile");
  const version = model.readUInt32LE(4);

  // A model with no vertices is not a broken model, it is an effect. 434 of the 1,462 models the
  // spell visual tables name — 29.7% — have exactly zero, and every one of them carries particle
  // or ribbon emitters: they *are* the effect, and the quad they do not have is the point. This
  // used to throw, so the publisher exited without writing anything and the most characteristic
  // spell effects in the game could never be loaded at all.
  const vertexBlock = array(model, HEADER.vertices);
  if (vertexBlock.count > 1_000_000 || !fits(model, vertexBlock, VERTEX_SIZE)) {
    throw new Error("M2 vertex table is invalid");
  }

  // The skin holds its own vertex list as indices into the model's, so a profile can carry a
  // subset. Triangles index that local list.
  const lookup = array(skin, 0x04);
  const triangles = array(skin, 0x0c);
  if (lookup.count > 1_000_000 || triangles.count > 6_000_000 || triangles.count % 3 !== 0
    || !fits(skin, lookup, 2) || !fits(skin, triangles, 2)) {
    throw new Error("M2 skin index tables are invalid");
  }

  const localToGlobal = new Uint32Array(lookup.count);
  for (let index = 0; index < lookup.count; index++) {
    const vertex = skin.readUInt16LE(lookup.offset + index * 2);
    if (vertex >= vertexBlock.count) throw new Error("M2 skin references a vertex outside the model");
    localToGlobal[index] = vertex;
  }

  // Vertices are re-emitted in the skin's own order so the index buffer needs no indirection and
  // an unused vertex costs nothing.
  const count = lookup.count;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uv0 = new Float32Array(count * 2);
  const uv1 = new Float32Array(count * 2);
  const boneIndices = new Uint8Array(count * 4);
  const boneWeights = new Uint8Array(count * 4);
  const boneCount = array(model, HEADER.bones).count;
  for (let index = 0; index < count; index++) {
    const at = vertexBlock.offset + localToGlobal[index] * VERTEX_SIZE;
    positions[index * 3] = model.readFloatLE(at);
    positions[index * 3 + 1] = model.readFloatLE(at + 4);
    positions[index * 3 + 2] = model.readFloatLE(at + 8);
    for (let slot = 0; slot < 4; slot++) {
      const weight = model.readUInt8(at + 12 + slot);
      const bone = model.readUInt8(at + 16 + slot);
      const usable = weight !== 0 && bone < boneCount;
      boneIndices[index * 4 + slot] = usable ? bone : 0;
      boneWeights[index * 4 + slot] = usable ? weight : 0;
    }
    // Authored normals. Recomputing them from the triangles loses the smoothing the artist set,
    // and M2 splits vertices at hard edges precisely so the two normals can differ.
    normals[index * 3] = model.readFloatLE(at + 20);
    normals[index * 3 + 1] = model.readFloatLE(at + 24);
    normals[index * 3 + 2] = model.readFloatLE(at + 28);
    uv0[index * 2] = model.readFloatLE(at + 32);
    uv0[index * 2 + 1] = model.readFloatLE(at + 36);
    uv1[index * 2] = model.readFloatLE(at + 40);
    uv1[index * 2 + 1] = model.readFloatLE(at + 44);
  }

  const indices = count > 65_535 ? new Uint32Array(triangles.count) : new Uint16Array(triangles.count);
  for (let index = 0; index < triangles.count; index++) {
    const local = skin.readUInt16LE(triangles.offset + index * 2);
    if (local >= count) throw new Error("M2 skin triangle references an invalid vertex");
    indices[index] = local;
  }

  const textures = readTextures(model);
  const materials = readMaterials(model);
  const textureCombos = readLookup(model, HEADER.textureCombos);
  const textureCoordCombos = readLookup(model, HEADER.textureCoordCombos);
  const textureWeightCombos = readLookup(model, HEADER.textureWeightCombos);
  const textureTransformCombos = readLookup(model, HEADER.textureTransformCombos);

  const submeshBlock = array(skin, 0x1c);
  const batchBlock = array(skin, 0x24);
  if (!fits(skin, submeshBlock, SUBMESH_SIZE) || !fits(skin, batchBlock, BATCH_SIZE)) {
    throw new Error("M2 skin submesh or batch table is invalid");
  }

  const submeshes = [];
  for (let index = 0; index < submeshBlock.count; index++) {
    const at = submeshBlock.offset + index * SUBMESH_SIZE;
    // `Level` supplies the high sixteen bits of indexStart, so a model with more than 65,535
    // indices does not silently slice from the wrong place.
    const level = skin.readUInt16LE(at + 2);
    submeshes.push({
      geosetId: skin.readUInt16LE(at),
      vertexStart: skin.readUInt16LE(at + 4) + (level << 16),
      vertexCount: skin.readUInt16LE(at + 6),
      indexStart: skin.readUInt16LE(at + 8) + (level << 16),
      indexCount: skin.readUInt16LE(at + 10),
      centre: [skin.readFloatLE(at + 20), skin.readFloatLE(at + 24), skin.readFloatLE(at + 28)],
      sortRadius: skin.readFloatLE(at + 44),
    });
  }

  const batches = [];
  for (let index = 0; index < batchBlock.count; index++) {
    const at = batchBlock.offset + index * BATCH_SIZE;
    const submesh = skin.readUInt16LE(at + 4);
    const materialIndex = skin.readUInt16LE(at + 10);
    if (submesh >= submeshes.length) continue;
    const textureCount = Math.max(1, Math.min(4, skin.readUInt16LE(at + 14)));
    const comboIndex = skin.readUInt16LE(at + 16);
    const used = [];
    for (let unit = 0; unit < textureCount; unit++) {
      const slot = textureCombos[comboIndex + unit];
      used.push(slot !== undefined && slot < textures.length ? slot : -1);
    }
    const material = materials[materialIndex] ?? { flags: 0, blendMode: 0 };
    batches.push({
      submesh,
      // Draw order. The client sorts on these before it sorts on anything else, and without them
      // a transparent batch lands wherever the file happened to list it.
      priorityPlane: skin.readInt8(at + 1),
      materialLayer: skin.readUInt16LE(at + 12),
      shaderId: skin.readUInt16LE(at + 2),
      flags: skin.readUInt8(at),
      blendMode: material.blendMode,
      materialFlags: material.flags,
      textures: used,
      // UV set per texture unit: 0 or 1. Everything env-mapped uses the second.
      uvSets: used.map((_, unit) => (textureCoordCombos[skin.readUInt16LE(at + 18) + unit] ?? 0) === 1 ? 1 : 0),
      colorIndex: skin.readUInt16LE(at + 8),
      // The combo tables use 0xFFFF for "none", not a missing entry.
      textureWeight: optional(textureWeightCombos[skin.readUInt16LE(at + 20)]),
      textureTransform: optional(textureTransformCombos[skin.readUInt16LE(at + 22)]),
    });
  }

  return {
    version,
    positions, normals, uv0, uv1, boneIndices, boneWeights, indices,
    submeshes, batches, textures,
    bounds: readBounds(model),
    colours: readColours(model),
    textureWeights: readTextureWeights(model),
    textureTransforms: readTextureTransforms(model),
    portraitCamera: readPortraitCamera(model),
    // Mutually exclusive with the one above by construction — see `readSceneCamera`.
    sceneCamera: readSceneCamera(model),
    // Counted, not parsed: what a model asks for that this pipeline still cannot draw.
    unsupported: {
      globalLoops: array(model, HEADER.globalLoops).count,
      particleEmitters: array(model, HEADER.particleEmitters).count,
      ribbonEmitters: array(model, HEADER.ribbonEmitters).count,
      events: array(model, HEADER.events).count,
    },
  };
}

/**
 * Which sequences keep their keyframes inside the .m2, by sequence index.
 *
 * The `false` entries are the trap: their track offsets address the `Model####-##.anim` beside the
 * file, and reading them out of the .m2 gives numbers that look like values and are not — the same
 * thing `readChannel` guards against for bone tracks, where every one of HumanMale's 51 EmoteBow
 * tracks also lands inside the .m2 by offset and decodes there into non-unit quaternions.
 */
function sequenceStorage(model) {
  const block = array(model, HEADER.sequences);
  const inside = [];
  if (block.count === 0 || block.count > 4096 || !fits(model, block, SEQUENCE_SIZE)) return inside;
  for (let index = 0; index < block.count; index++) {
    inside.push((model.readUInt32LE(block.offset + index * SEQUENCE_SIZE + 12) & SEQUENCE_DATA_INSIDE_M2) !== 0);
  }
  return inside;
}

/**
 * A track with the sub-tracks whose keyframes are not in this file removed.
 *
 * Measured over the 22,112 models of the drawing corpus: 845 of the colour sub-tracks and 31 of
 * the weight ones name a sequence that keeps its keys in a `.anim`. Only **5** colour tracks and
 * **no** weight track lose their *first* sub-track that way, and the first is the one the browser
 * samples — so those five fall back to white at full strength, which is exactly what they draw
 * today, and nothing else changes. Carrying them would mean shipping keys nothing samples: the
 * browser picks the first sub-track rather than the one for the sequence it is playing, the same
 * rule `Particles.sampleTrack` has followed since the emitters arrived.
 */
function ownedTrack(track, inside) {
  if (track.tracks.length === 0) return track;
  return { ...track, tracks: track.tracks.filter((sub) => inside[sub.sequence] !== false) };
}

/**
 * `M2Color`: what colour a batch is painted and how opaque it is, over the animation.
 *
 * Counted and dropped until now, and it is most of why a spell effect draws as a white rectangle.
 * Measured over 61,190 batches in 22,112 models: 4,415 are drawn white that the file tints, 7,126
 * are drawn at full strength that the file dims, and **6,207 are drawn at full strength when their
 * own first key says invisible**. `Spells\Sleep_State_Head.m2` — the ZZZZ over a sleeping unit —
 * is three additive `WHITE8X8.BLP` cards the file paints (0, 0.898, 0) at weight 0.15.
 */
export function readColours(model) {
  const block = array(model, HEADER.colors);
  if (block.count === 0 || block.count > 4096 || !fits(model, block, COLOR_SIZE)) return [];
  const inside = sequenceStorage(model);
  const colours = [];
  for (let index = 0; index < block.count; index++) {
    const at = block.offset + index * COLOR_SIZE;
    colours.push({
      rgb: ownedTrack(readTrack(model, at, 3, "float"), inside),
      // fixed16 over 0..32767, not a float: read as four bytes a stored 1 arrives as a denormal.
      alpha: ownedTrack(readTrack(model, at + TRACK_SIZE, 1, "fixed16"), inside),
    });
  }
  return colours;
}

/**
 * `M2TextureWeight`: the second multiplier on a batch's opacity, and the one the artists dim with.
 *
 * A batch reaches it through the texture-weight combo table, which `parseM2` already resolves into
 * `batch.textureWeight` — so these are indexed directly and there is no second hop.
 */
export function readTextureWeights(model) {
  const block = array(model, HEADER.textureWeights);
  if (block.count === 0 || block.count > 4096 || !fits(model, block, TRACK_SIZE)) return [];
  const inside = sequenceStorage(model);
  const weights = [];
  for (let index = 0; index < block.count; index++) {
    weights.push(ownedTrack(readTrack(model, block.offset + index * TRACK_SIZE, 1, "fixed16"), inside));
  }
  return weights;
}

/**
 * `M2TextureTransform`: the matrix a batch's UVs are run through, over the animation.
 *
 * Counted at header 0x60 and dropped until now, which is why a runic circle does not turn and a
 * beam does not flow. Measured over the 1,565 readable models under `spells\`: 418 records in 177
 * models, and **517 batches in 174 models** reach one through the transform combo table. Every one
 * of the 418 decodes cleanly at this 60-byte stride — three `M2Track`s, no padding — and every one
 * of them moves: 1,107 translation keys, 84 rotation keys and 28 scaling keys, not a single record
 * with one key on all three tracks.
 *
 * The rotation is a plain `Quaternion` and not the `M2CompQuat` a bone track uses. That is
 * measured rather than looked up: all 84 rotation keys are unit length read as four floats and
 * none of them is unit length read as four int16 — the difference between a turning rune and one
 * frozen at a nonsense angle. Interpolation is 0 (828) or 1 (426) and nothing else, and 945 of the
 * 1,254 tracks run on the model's own animation while the rest name a global loop, which is what
 * makes a portal swirl while nobody is casting.
 */
export function readTextureTransforms(model) {
  const block = array(model, HEADER.textureTransforms);
  if (block.count === 0 || block.count > 4096 || !fits(model, block, TEXTURE_TRANSFORM_SIZE)) return [];
  const inside = sequenceStorage(model);
  const transforms = [];
  for (let index = 0; index < block.count; index++) {
    const at = block.offset + index * TEXTURE_TRANSFORM_SIZE;
    transforms.push({
      translation: ownedTrack(readTrack(model, at, 3, "float"), inside),
      rotation: ownedTrack(readTrack(model, at + TRACK_SIZE, 4, "float"), inside),
      scaling: ownedTrack(readTrack(model, at + TRACK_SIZE * 2, 3, "float"), inside),
    });
  }
  return transforms;
}

/**
 * The camera the original client frames a portrait with, if the model carries one.
 *
 * Only the type-0 record and only its still frame: the position and target tracks animate it for
 * the cinematics the login screen plays, and a portrait is one held pose. 1,130 of the 1,323
 * readable creature models carry one, which is **24,033 of the 24,262 `CreatureDisplayInfo` rows
 * (99.06%)** — all twenty playable models among them. HumanMale: FOV 45.0000°, camera
 * (0.633485, −0.387865, 1.886737), target (0.062668, 0.034265, 1.863569), 0.7103 yards apart.
 *
 * The artifact's own `bounds` cannot stand in for it: that box is the M2 header's, animation
 * extents and all, and it overstates the drawn mesh by more than a quarter on 704 of 1,077 models.
 */
export function readPortraitCamera(model) {
  const block = array(model, HEADER.cameras);
  if (block.count === 0 || block.count > 64 || !fits(model, block, CAMERA_SIZE)) return undefined;
  for (let index = 0; index < block.count; index++) {
    const at = block.offset + index * CAMERA_SIZE;
    if (model.readInt32LE(at) !== CAMERA_TYPE_PORTRAIT) continue;
    const camera = decodeCamera(model, at);
    // A record that fails the score is a record from another layout, and a camera pointing
    // nowhere frames a portrait of nothing. Refusing is what leaves the fallback chain to run.
    if (camera) return camera;
  }
  return undefined;
}

/**
 * The camera a model that is a *scene* rather than a unit is meant to be looked at through.
 *
 * `readPortraitCamera` keeps only type 0, and that is right for a unit: the type says which of a
 * creature's several cameras frames its face. A glue model has no face to frame — it is a set, and
 * the one camera it carries is the shot the artist composed. Measured over the 19 models under
 * `Interface\Glues\Models\` in this client: **13 carry exactly one camera and every one of the 13
 * is type −1**; the six `UI_RS_*` recruit-a-friend sets carry none at all. Not one type-0 record in
 * the whole directory, so the portrait reader returns `undefined` for all 19 and the login screen
 * would have had to invent a framing for a shot that is already authored. The C++ reference client
 * takes `cameras[0]` and never looks at the type (`character_preview.cpp:1268-1275`).
 *
 * Index 0 and not "the first non-portrait one": a model's camera order is the author's order, and
 * the first record is the one the reference reads. A model that *does* carry a portrait is left to
 * `readPortraitCamera` — this returns `undefined` for it — so exactly one of the two can be set on
 * any model and a unit's published artifact is byte-identical to what it was before this existed.
 *
 * The cost to everything that already worked is measured rather than argued: over the 1,114 distinct
 * `CreatureModelData` models this client actually holds, 930 carry a portrait and are untouched,
 * and of the other 184 **not one gains a scene camera** — a creature with no type-0 record has no
 * camera block at all. So the whole reach of this function on this client is the 13 glue sets it
 * was written for.
 */
export function readSceneCamera(model) {
  const block = array(model, HEADER.cameras);
  if (block.count === 0 || block.count > 64 || !fits(model, block, CAMERA_SIZE)) return undefined;
  // A model with a portrait is a unit, and the portrait is the answer for it. Checking the whole
  // block rather than record 0 alone is what keeps the two mutually exclusive: a creature whose
  // first camera is a cinematic and whose second is its portrait must not gain both.
  for (let index = 0; index < block.count; index++) {
    if (model.readInt32LE(block.offset + index * CAMERA_SIZE) === CAMERA_TYPE_PORTRAIT) return undefined;
  }
  return decodeCamera(model, block.offset);
}

/**
 * One `M2Camera` record's still frame, or `undefined` when it does not score as one.
 *
 * The score is the stride's own — FOV inside the range a lens can have, a near plane at or in front
 * of the eye, a far plane beyond it, finite base vectors — and it is what tells a record apart from
 * bytes belonging to another layout. The animated position and target tracks are deliberately not
 * read: a still frame is what both callers want, and the tracks are the cinematics.
 */
function decodeCamera(model, at) {
  const fov = model.readFloatLE(at + 4);
  const far = model.readFloatLE(at + 8);
  const near = model.readFloatLE(at + 12);
  if (!(fov >= 0.05 && fov <= 3.2 && near >= 0 && far > near)) return undefined;
  const vector = (offset) => [0, 1, 2].map((axis) => model.readFloatLE(at + offset + axis * 4));
  const position = vector(CAMERA_POSITION_BASE);
  const target = vector(CAMERA_TARGET_BASE);
  if ([...position, ...target].some((value) => !Number.isFinite(value))) return undefined;
  return { fov, near, far, position, target };
}

/** A combo-table entry, with the file's 0xFFFF sentinel turned into a plain -1. */
function optional(value) {
  return value === undefined || value === 0xffff ? -1 : value;
}

function readLookup(model, header) {
  const block = array(model, header);
  if (block.count > 100_000 || !fits(model, block, 2)) return new Uint16Array(0);
  const values = new Uint16Array(block.count);
  for (let index = 0; index < block.count; index++) values[index] = model.readUInt16LE(block.offset + index * 2);
  return values;
}

function readTextures(model) {
  const block = array(model, HEADER.textures);
  if (block.count > 1000 || !fits(model, block, TEXTURE_SIZE)) throw new Error("M2 texture table is invalid");
  const result = [];
  for (let index = 0; index < block.count; index++) {
    const at = block.offset + index * TEXTURE_SIZE;
    const type = model.readUInt32LE(at);
    result.push({
      type,
      flags: model.readUInt32LE(at + 4),
      // Only a type 0 slot names a file; the rest are filled from the outside per appearance.
      filename: type === TEXTURE_TYPE_OWN
        ? stringAt(model, model.readUInt32LE(at + 12), model.readUInt32LE(at + 8))
        : "",
    });
  }
  return result;
}

function readMaterials(model) {
  const block = array(model, HEADER.materials);
  if (block.count > 10_000 || !fits(model, block, MATERIAL_SIZE)) return [];
  const result = [];
  for (let index = 0; index < block.count; index++) {
    const at = block.offset + index * MATERIAL_SIZE;
    result.push({ flags: model.readUInt16LE(at), blendMode: model.readUInt16LE(at + 2) });
  }
  return result;
}

function readBounds(model) {
  const at = HEADER.boundingBox;
  if (at + 28 > model.length) return undefined;
  return {
    min: [model.readFloatLE(at), model.readFloatLE(at + 4), model.readFloatLE(at + 8)],
    max: [model.readFloatLE(at + 12), model.readFloatLE(at + 16), model.readFloatLE(at + 20)],
    radius: model.readFloatLE(at + 24),
  };
}

/**
 * Origin-centred radius for a scenery M2 that the current visual publisher draws without a rig
 * or emitters. The MD20 header's bounding radius is centred on its own box, not on the placement
 * origin (ElwynnTreeMid01 reaches z=11.7 while its header radius is 6.3). Scan every source vertex
 * instead: the SKIN can only select a subset, and model-to-scene/ADT placement rotations preserve
 * distance from the origin. Unknown, animated or malformed models must remain unculled.
 */
export function staticM2AdmissionRadius(model) {
  const headerEnd = HEADER.particleEmitters + 8;
  if (!Buffer.isBuffer(model) || model.length < headerEnd
    || model.subarray(0, 4).toString() !== "MD20" || model.readUInt32LE(4) !== 264) return undefined;
  if (array(model, HEADER.ribbonEmitters).count > 0
    || array(model, HEADER.particleEmitters).count > 0) return undefined;

  const bones = array(model, HEADER.bones);
  const sequences = array(model, HEADER.sequences);
  const vertices = array(model, HEADER.vertices);
  if (bones.count > 1024 || (bones.count > 0 && (bones.offset < headerEnd || !fits(model, bones, BONE_SIZE)))
    || sequences.count > 4096 || (sequences.count > 0 && (sequences.offset < headerEnd || !fits(model, sequences, SEQUENCE_SIZE)))
    || vertices.count === 0 || vertices.count > 1_000_000
    || vertices.offset < headerEnd || !fits(model, vertices, VERTEX_SIZE)) {
    return undefined;
  }
  try {
    // An external .anim can move bones even when its keyframes are absent from this M2 buffer.
    if (m2Animations(model).some((animation) => animation.external !== undefined)
      || parseM2Skeleton(model) !== undefined) return undefined;
  } catch {
    return undefined;
  }

  let radius = 0;
  for (let index = 0; index < vertices.count; index++) {
    const at = vertices.offset + index * VERTEX_SIZE;
    const x = model.readFloatLE(at);
    const y = model.readFloatLE(at + 4);
    const z = model.readFloatLE(at + 8);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
    radius = Math.max(radius, Math.hypot(x, y, z));
  }
  return Number.isFinite(radius) ? radius : undefined;
}

/**
 * The points a model hangs other models from: a helm on the head, a sword in the right hand.
 *
 * Read here rather than in parseM2 because an attachment is nothing but a bone and a place on it,
 * so it only means anything alongside the skeleton it indexes. Records naming a bone the model
 * does not have are dropped — none of the 20,155 in the client does, but a bad file should move a
 * sword rather than corrupt a pose.
 */
function readAttachments(model, boneCount) {
  const block = array(model, HEADER.attachments);
  if (block.count === 0 || block.count > 256 || !fits(model, block, ATTACHMENT_SIZE)) return [];
  const result = [];
  for (let index = 0; index < block.count; index++) {
    const at = block.offset + index * ATTACHMENT_SIZE;
    const bone = model.readUInt16LE(at + 4);
    if (bone >= boneCount) continue;
    result.push({
      id: model.readUInt32LE(at),
      bone,
      position: [model.readFloatLE(at + 8), model.readFloatLE(at + 12), model.readFloatLE(at + 16)],
    });
  }
  return result;
}

/**
 * Every animation the model can play, and where each one's keyframes live.
 *
 * Three things decide that, and none of them is the sequence's own position in the table:
 *
 * * **Flag 0x20** — the keyframes are in the .m2. Without it they are in a `Model####-##.anim`
 *   beside it, named for the animation id and the variation.
 * * **Flag 0x40** — the sequence is an alias and owns nothing; `aliasNext` names the sequence that
 *   holds the data, and it chains (HumanMale's EmoteUseStanding points at
 *   EmoteUseStandingNoSheathe, which points at UseStandingLoop).
 * * **Variation** — the file may hold several takes of one animation; the client picks among them
 *   at random for idles. Only variation 0 is published, so one animation is one clip.
 *
 * Three fields beside the ones that pick the data describe how a pose is *entered and travelled*,
 * and all three were read past until now (the 64-byte `M2SequenceDisk` layout is spelled out in
 * CPPClientExample/wowee/src/pipeline/m2_loader.cpp:229-248):
 *
 * * **blendTime (0x1C)** — how long the original client takes to blend into this sequence, in
 *   milliseconds. It is authored per clip and it is not one number: HumanMale carries 150 ms on
 *   210 of its 241 sequences and 250 ms on five, NightElfFemale stands up over 300 ms, Murloc
 *   reaches 350, Wolf and Horse each carry a 50. The browser used to answer all of that with two
 *   constants.
 * * **movingSpeed (0x08)** — the ground speed the stride was authored for, so a gait can be
 *   time-scaled to the speed the unit is actually travelling instead of skating. Measured on
 *   RidingHorse: Walk 2.5, Run 6.9444, Walkbackwards −2.5 (it is signed — a backwards stride
 *   travels backwards), and 0 on all 40 of its other sequences.
 * * **variationNext (0x3C)** — the sequence to play after this one, which is how a multi-part idle
 *   or a mount's fidget chain is authored (HumanMale's Stand names 25, Mount names 137). It is an
 *   index into the *sequence table*, not an animation id, which is why `variationIndex` below has
 *   to travel with it: without the clip's own slot number a reader holding only animation ids
 *   cannot tell which clip a `variationNext` points at.
 *
 * Slice A2 gives all three a wire format. `blendTime` still rides the reserved u16 the clip header
 * already had; `movingSpeed`, `variationNext` and `variationIndex` ride the optional extras table
 * appended after the clips (`tools/wvm.mjs`, "WVX1").
 */
export function m2Animations(model) {
  const sequences = array(model, HEADER.sequences);
  if (sequences.count === 0 || sequences.count > 4096 || !fits(model, sequences, SEQUENCE_SIZE)) return [];
  const records = [];
  for (let index = 0; index < sequences.count; index++) {
    const at = sequences.offset + index * SEQUENCE_SIZE;
    records.push({
      index,
      animationId: model.readUInt16LE(at),
      variation: model.readUInt16LE(at + 2),
      duration: model.readUInt32LE(at + 4),
      movingSpeed: model.readFloatLE(at + 8),
      flags: model.readUInt32LE(at + 12),
      blendTime: model.readUInt32LE(at + 0x1c),
      variationNext: model.readInt16LE(at + 0x3c),
      aliasNext: model.readUInt16LE(at + 0x3e),
    });
  }

  const result = [];
  const seen = new Set();
  for (const record of records) {
    if (record.variation !== 0 || seen.has(record.animationId)) continue;
    let data = record;
    for (let hop = 0; (data.flags & SEQUENCE_IS_ALIAS) !== 0 && hop < MAX_ALIAS_HOPS; hop++) {
      const next = records[data.aliasNext];
      if (!next || next === data) break;
      data = next;
    }
    if ((data.flags & SEQUENCE_IS_ALIAS) !== 0) continue;
    if (data.duration === 0 || data.duration > 600_000) continue;
    seen.add(record.animationId);
    result.push({
      animationId: record.animationId,
      /** The slot the tracks are indexed by, which is the alias target's when there is one. */
      sequenceIndex: data.index,
      duration: data.duration,
      // Taken from the record the caller asked for rather than from the alias target, because it
      // describes entering *this* animation and not the one that happens to store its keys. The
      // distinction is invisible on this client: all 17 of HumanMale's alias records carry a
      // blendTime equal to their target's, to the millisecond.
      blendTime: record.blendTime,
      /** Authored ground speed of the stride; 0 for everything that does not travel. */
      movingSpeed: record.movingSpeed,
      /** The sequence the file says follows this one, or -1. A sequence-table index, not an id. */
      variationNext: record.variationNext,
      /**
       * This animation's own slot in the sequence table — what a `variationNext` names.
       *
       * The record's index and not the alias target's (`sequenceIndex` above is the target,
       * because that is where the keyframes are). A chain is authored between records, so the
       * identity a follower points at is the record that was asked for.
       */
      variationIndex: record.index,
      /** Undefined when the keyframes are inside the .m2. */
      external: (data.flags & SEQUENCE_DATA_INSIDE_M2) !== 0
        ? undefined
        : animationFileSuffix(data.animationId, data.variation),
    });
  }
  return result;
}

/** The `####-##` an external sequence's file is named for: `HumanMale` + this + `.anim`. */
export function animationFileSuffix(animationId, variation) {
  return `${String(animationId).padStart(4, "0")}-${String(variation).padStart(2, "0")}`;
}

/**
 * Bones, the keyframes of the animations asked for, and the attachment points.
 *
 * `wanted` is a set of AnimationData.dbc ids, or undefined for everything the model has. The
 * numbers come from the table (tools/animations.mjs) rather than from a literal list here: the
 * seven ids this used to ship were chosen by hand and four of the eighteen it grew into named the
 * wrong pose entirely.
 *
 * `animations` maps the suffix from {@link animationFileSuffix} to the contents of that `.anim`.
 * The track descriptors stay in the .m2 either way — only the keyframe blocks move — and the
 * offsets they hold are into the .anim, not into the model. That distinction is not cosmetic:
 * every one of HumanMale's 51 EmoteBow tracks also lands inside the 1.5 MiB .m2 by offset, and
 * every one of them decodes there into quaternions that are not unit length. A bounds check alone
 * would have published 51 tracks of noise per external animation and called it a bow.
 *
 * Bone flags come through too: three.js will not billboard a bone on its own, and without that
 * the eye glows, glow cards and flat foliage of a hundred models point in a fixed direction.
 */
export function parseM2Skeleton(model, options = {}) {
  if (model.subarray(0, 4).toString() !== "MD20") throw new Error("Not an MD20 model");
  const bones = array(model, HEADER.bones);
  const sequences = array(model, HEADER.sequences);
  if (bones.count === 0 || bones.count > 1024 || sequences.count > 4096) return undefined;
  if (!fits(model, bones, BONE_SIZE)
    || (sequences.count > 0 && !fits(model, sequences, SEQUENCE_SIZE))) return undefined;

  const globalLoopBlock = array(model, HEADER.globalLoops);
  const globalDurations = globalLoopBlock.count <= 65_535 && fits(model, globalLoopBlock, 4)
    ? Array.from({ length: globalLoopBlock.count }, (_, index) =>
      model.readUInt32LE(globalLoopBlock.offset + index * 4))
    : [];

  const skeleton = [];
  const globalChannels = [];
  for (let index = 0; index < bones.count; index++) {
    const at = bones.offset + index * BONE_SIZE;
    const parent = model.readInt16LE(at + 8);
    skeleton.push({
      // A forward reference would mean a child is posed before its parent. None of the 14,945
      // bones measured across 198 client models has one, but a bad file should not corrupt the
      // pose silently.
      parent: parent >= 0 && parent < index ? parent : -1,
      flags: model.readUInt32LE(at + 4),
      pivot: [model.readFloatLE(at + 0x4c), model.readFloatLE(at + 0x50), model.readFloatLE(at + 0x54)],
    });
    for (const [offset, kind, components] of [
      [0x10, TRACK_KINDS.translation, 3],
      [0x24, TRACK_KINDS.rotation, 4],
      [0x38, TRACK_KINDS.scale, 3],
    ]) {
      const channel = readGlobalChannel(model, at + offset, kind, components, globalDurations);
      if (channel) globalChannels.push({ bone: index, kind, ...channel });
    }
  }

  const wanted = options.wanted;
  const files = options.animations ?? new Map();
  const clips = [];
  let missing = 0;
  for (const animation of m2Animations(model)) {
    if (wanted && !wanted.has(animation.animationId)) continue;
    // An external animation reads from its own file and never from the model: the offsets belong
    // to that file's address space and mean something else entirely inside the .m2.
    const source = animation.external === undefined ? model : files.get(animation.external);
    if (!source) {
      missing++;
      continue;
    }
    const channels = [];
    for (let bone = 0; bone < bones.count; bone++) {
      const at = bones.offset + bone * BONE_SIZE;
      for (const [offset, kind, components] of [
        [0x10, TRACK_KINDS.translation, 3],
        [0x24, TRACK_KINDS.rotation, 4],
        [0x38, TRACK_KINDS.scale, 3],
      ]) {
        const channel = readChannel(model, source, at + offset, animation.sequenceIndex, kind, components, animation.duration);
        if (channel) channels.push({ bone, kind, ...channel });
      }
    }
    if (channels.length === 0) continue;
    // The sequence's own transition metadata travels with its keyframes, so the encoder never has
    // to consult the sequence table a second time — and a clip that ends up in the sidecar carries
    // exactly what the same clip would have carried inside the model.
    clips.push({
      animationId: animation.animationId,
      duration: animation.duration,
      blendTime: animation.blendTime,
      movingSpeed: animation.movingSpeed,
      variationNext: animation.variationNext,
      variationIndex: animation.variationIndex,
      channels,
    });
  }
  if (clips.length === 0 && globalChannels.length === 0) return undefined;
  clips.sort((left, right) => left.animationId - right.animationId);
  return {
    bones: skeleton,
    clips,
    globalChannels,
    /** Animations whose `.anim` the caller did not hand over. Zero on a complete client. */
    missingAnimations: missing,
    attachments: readAttachments(model, bones.count),
  };
}

/**
 * One track of one sequence.
 *
 * `model` supplies the descriptors — how many keys, where they claim to be — and `source` is where
 * those offsets point, which is a `.anim` for an external sequence and the model itself otherwise.
 */
function readChannel(model, source, at, sequenceIndex, kind, components, duration) {
  // A track bound to a global loop runs on its own timeline and is not indexed by sequence, so
  // reading it as if it were would bind the wrong keys to the first animation.
  if (model.readUInt16LE(at + 2) !== 0xffff) return undefined;
  const timestamps = array(model, at + 4);
  const values = array(model, at + 12);
  if (sequenceIndex >= timestamps.count || sequenceIndex >= values.count) return undefined;
  const timesEntry = timestamps.offset + sequenceIndex * 8;
  const valuesEntry = values.offset + sequenceIndex * 8;
  if (timesEntry + 8 > model.length || valuesEntry + 8 > model.length) return undefined;
  const times = array(model, timesEntry);
  const data = array(model, valuesEntry);
  if (times.count === 0 || times.count !== data.count || times.count > 20_000) return undefined;
  const stride = kind === TRACK_KINDS.rotation ? 8 : components * 4;
  // The keyframe blocks are addressed in the source file, which is the only place they exist.
  if (!fits(source, times, 4) || !fits(source, data, stride)) return undefined;

  const keyTimes = new Uint32Array(times.count);
  for (let key = 0; key < times.count; key++) keyTimes[key] = Math.min(duration, source.readUInt32LE(times.offset + key * 4));
  const keyValues = kind === TRACK_KINDS.rotation
    ? new Int16Array(times.count * 4)
    : new Float32Array(times.count * components);
  for (let key = 0; key < times.count; key++) {
    const entry = data.offset + key * stride;
    if (kind === TRACK_KINDS.rotation) {
      for (let part = 0; part < 4; part++) keyValues[key * 4 + part] = source.readInt16LE(entry + part * 2);
    } else {
      for (let part = 0; part < components; part++) keyValues[key * components + part] = source.readFloatLE(entry + part * 4);
    }
  }
  return { interpolation: model.readUInt16LE(at), times: keyTimes, values: keyValues };
}

/**
 * One bone channel bound to an M2 global sequence rather than to an animation clip.
 *
 * These channels are the whole animation of several spell models. Holy Light's two hand models
 * have fourteen/sixteen bones and three ribbons, but not one animation-local bone key: dropping
 * global channels therefore turns their moving trails into a static pair of flat glow cards.
 */
function readGlobalChannel(model, at, kind, components, globalDurations) {
  const globalSequence = model.readUInt16LE(at + 2);
  if (globalSequence === 0xffff || globalSequence >= globalDurations.length) return undefined;
  const timestamps = array(model, at + 4);
  const values = array(model, at + 12);
  // A global track has one nested key array. Accept the first when a malformed/custom model writes
  // more, but never read a header that is not wholly inside the model.
  if (timestamps.count === 0 || values.count === 0
    || !fits(model, timestamps, 8) || !fits(model, values, 8)) return undefined;
  const times = array(model, timestamps.offset);
  const data = array(model, values.offset);
  if (times.count === 0 || times.count !== data.count || times.count > 20_000) return undefined;
  const stride = kind === TRACK_KINDS.rotation ? 8 : components * 4;
  if (!fits(model, times, 4) || !fits(model, data, stride)) return undefined;

  const duration = globalDurations[globalSequence] ?? 0;
  const keyTimes = new Uint32Array(times.count);
  for (let key = 0; key < times.count; key++) {
    const time = model.readUInt32LE(times.offset + key * 4);
    keyTimes[key] = duration > 0 ? Math.min(duration, time) : time;
  }
  const keyValues = kind === TRACK_KINDS.rotation
    ? new Int16Array(times.count * 4)
    : new Float32Array(times.count * components);
  for (let key = 0; key < times.count; key++) {
    const entry = data.offset + key * stride;
    if (kind === TRACK_KINDS.rotation) {
      for (let part = 0; part < 4; part++) keyValues[key * 4 + part] = model.readInt16LE(entry + part * 2);
    } else {
      for (let part = 0; part < components; part++) {
        keyValues[key * components + part] = model.readFloatLE(entry + part * 4);
      }
    }
  }
  return {
    globalSequence,
    interpolation: model.readUInt16LE(at),
    times: keyTimes,
    values: keyValues,
  };
}
