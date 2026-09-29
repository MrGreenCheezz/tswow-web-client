// Decoding WVM9: the model as the M2 describes it, with nothing resolved.
//
// Everything appearance-specific — which file fills a texture slot, which geosets a character
// shows — is decided here, in the browser, against the one artifact every appearance shares.
//
// v6 also stops pretending the artifact holds every pose. It lists every animation the model can
// play and carries the keyframes of the locomotion set; the rest arrive as a WVA1 block the first
// time something asks for one.
//
// v7 carries the emitters. A particle system in this game is very often the whole effect — a
// bonfire without one is an unlit log — and until now the header slot they live in was counted
// and dropped. Nothing here simulates anything: these are the file's own numbers, in the file's
// own units, for whoever draws them. Every emitter record leads with its own length so a reader
// can step over one it does not understand.
//
// v8 carries what colour a batch is and whether it is drawn at all. Up to v7 each batch's
// `colorIndex` and `textureWeight` were decoded here and read by nothing, because the two tables
// they index were not in the file — so every batch in the game drew at (1, 1, 1) and opacity 1.
// That is why the ZZZZ over a sleeping unit is a blazing white glyph that never fades instead of
// three green letters at 15% strength rising one after another. It also carries the type-0
// `M2Camera`: the frame the original client puts a portrait in.
//
// v9 carries `M2TextureTransform`, the matrix a batch's UVs are run through. Up to v8 each batch's
// `textureTransform` index was decoded here — it has been on line 421 since v4 — and the table it
// points at was not in the file, so 517 batches in 174 models under `spells\` drew a texture that
// should be turning, flowing or breathing as one pinned in place.

/** M2Material.blending_mode, in the file's own order. */
export const BLEND_OPAQUE = 0;
export const BLEND_ALPHA_KEY = 1;
export const BLEND_ALPHA = 2;
export const BLEND_NO_ALPHA_ADD = 3;
export const BLEND_ADD = 4;
export const BLEND_MOD = 5;
export const BLEND_MOD2X = 6;
export const BLEND_BLEND_ADD = 7;

export const MATERIAL_UNLIT = 0x01;
export const MATERIAL_UNFOGGED = 0x02;
export const MATERIAL_TWO_SIDED = 0x04;
export const MATERIAL_BILLBOARD = 0x08;
export const MATERIAL_NO_DEPTH_TEST = 0x10;
export const MATERIAL_NO_DEPTH_WRITE = 0x20;

export const TEXTURE_WRAP_X = 0x01;
export const TEXTURE_WRAP_Y = 0x02;

/** M2Texture.type. 0 names its own file; the rest are filled per appearance. */
export const TEXTURE_TYPE_OWN = 0;
export const TEXTURE_TYPE_BODY = 1;
export const TEXTURE_TYPE_OBJECT_SKIN = 2;
export const TEXTURE_TYPE_HAIR = 6;
export const TEXTURE_TYPE_SKIN_EXTRA = 8;

export const BONE_SPHERICAL_BILLBOARD = 0x08;
export const BONE_CYLINDRICAL_BILLBOARD_X = 0x10;
export const BONE_CYLINDRICAL_BILLBOARD_Y = 0x20;
export const BONE_CYLINDRICAL_BILLBOARD_Z = 0x40;
export const BONE_ANY_BILLBOARD =
  BONE_SPHERICAL_BILLBOARD | BONE_CYLINDRICAL_BILLBOARD_X | BONE_CYLINDRICAL_BILLBOARD_Y | BONE_CYLINDRICAL_BILLBOARD_Z;

export interface WvmTextureSlot {
  /** M2Texture.type: 0 self-named, otherwise the client supplies the file. */
  type: number;
  flags: number;
  /** MPQ path, for type 0 only. */
  path: string;
}

export interface WvmSubmesh {
  /**
   * Geoset number, as `family * 100 + variant`, with one variant of each family visible.
   *
   * Read off the twenty playable character models: family 0 (ids 0 to 25) is the hairstyle, 1 to 3 the
   * facial hair, 4 gloves, 5 boots, 7 ears, 8 sleeves, 9 kneepads, 10 the shirt hem, 11 trousers,
   * 12 the tabard, 13 the legs, 15 the cloak, 17 the eye glow, 18 the belt. Families 6, 14 and 16
   * do not exist.
   */
  geosetId: number;
  indexStart: number;
  indexCount: number;
}

export interface WvmBatch {
  submesh: number;
  blendMode: number;
  materialFlags: number;
  /** Draw order, most negative first, then materialLayer, then file order. */
  priorityPlane: number;
  materialLayer: number;
  /** Indices into the texture table, one per texture unit; -1 when the unit is unused. */
  textures: number[];
  /** Which UV set each unit samples. */
  uvSets: number[];
  shaderId: number;
  colorIndex: number;
  textureWeight: number;
  textureTransform: number;
}

export interface WvmSkeletonClip {
  animationId: number;
  /** Seconds. */
  duration: number;
  /**
   * `M2Sequence.blendTime` in seconds: how long the original client takes to blend into this pose.
   *
   * Undefined when the artifact does not carry one — either because it was written before the
   * clip header's reserved u16 became this field, or because the sequence itself authored a zero
   * (26 of HumanMale's 241 do). Both cases mean the same thing to a caller: there is no authored
   * number here, use the blend the renderer would have used anyway.
   */
  blendTime?: number;
  /**
   * `M2Sequence.movingSpeed`: the ground speed this stride was authored for, in yards a second.
   *
   * Signed, because the file is — RidingHorse's Walkbackwards is −2.5 and travels backwards. Only
   * a locomotion sequence carries one; 40 of RidingHorse's 43 authored a zero, which reads back
   * here as `undefined` for the same reason a zero blend time does: it is the absence of a number,
   * not the number zero, and dividing by it would be meaningless.
   */
  movingSpeed?: number;
  /** The sequence-table slot this clip occupies — what another clip's `variationNext` names. */
  variationIndex?: number;
  /** The sequence the file says follows this one, as a table slot, or −1 for none. */
  variationNext?: number;
  channels: Array<{ bone: number; kind: 0 | 1 | 2; times: Float32Array; values: Float32Array }>;
}

/** A bone channel driven by one of the model's independent global-sequence clocks. */
export interface WvmSkeletonGlobalChannel {
  bone: number;
  kind: 0 | 1 | 2;
  interpolation: number;
  globalSequence: number;
  /** Seconds, matching ordinary skeleton channels after decode. */
  times: Float32Array;
  values: Float32Array;
}

export interface WvmSkeleton {
  parents: Int16Array;
  flags: Uint16Array;
  pivots: Float32Array;
  /** The clips that travelled with the model — locomotion, and nothing else. */
  clips: WvmSkeletonClip[];
  /** Bone tracks that keep running on the model's global clocks, even when no clip has keys. */
  globalChannels: WvmSkeletonGlobalChannel[];
  /**
   * Every animation the model can play, shipped here or not.
   *
   * Whether a wolf can swim is a fact about the wolf, and up to v5 the artifact could not say it:
   * a missing clip meant either "this model cannot" or "the exporter did not pick that one".
   */
  animations: number[];
}

/**
 * A place on a bone where another model hangs: a helm on the head, a sword in the right hand.
 *
 * `position` is in model space, not the bone's, so what a mesh parented to that bone needs is
 * `position - pivot`. That difference is exactly zero in every one of the 20,155 attachment
 * records this client ships; it is carried anyway rather than assumed.
 */
export interface WvmAttachment {
  id: number;
  bone: number;
  position: [number, number, number];
}

/** M2Attachment ids, named from where they sit on the twenty playable models. */
export const ATTACHMENT_SHIELD = 0;
/**
 * The same number on the other kind of model: on a horse, point 0 is "MountMain", the saddle.
 *
 * Two names for one id because the table is per model and the meaning is per model with it —
 * a character hangs a shield off point 0 and a mount seats its rider there, and no model is ever
 * asked for both. Named rather than written as a bare `0` at the two call sites, because a
 * `boneOf(mountWvm, …, ATTACHMENT_SHIELD)` would read as a bug that it is not.
 */
export const ATTACHMENT_MOUNT_SEAT = 0;
export const ATTACHMENT_HAND_RIGHT = 1;
export const ATTACHMENT_HAND_LEFT = 2;
export const ATTACHMENT_SHOULDER_RIGHT = 5;
export const ATTACHMENT_SHOULDER_LEFT = 6;
export const ATTACHMENT_HELM = 11;
export const ATTACHMENT_BACK = 12;
/**
 * The hip sheath points, right and left.
 *
 * Read off the playable models' own attachment tables (HumanMale carries 9 at z 1.19 on the
 * right side and 10 mirrored on the left, Orc and Tauren the same pair) and confirmed by the
 * reference client's sheath mapping, which hangs stowed one-handers there.
 */
export const ATTACHMENT_HIP_RIGHT = 9;
export const ATTACHMENT_HIP_LEFT = 10;

/**
 * One `M2Track`: keyed on the animation timeline, with one sub-track per sequence.
 *
 * `globalSequence` of −1 means it runs on whatever the model is currently playing; anything else
 * names a loop in `globalSequences` that runs on the world's clock — which is what makes a torch
 * flicker while nobody moves.
 */
export interface WvmTrack {
  interpolation: number;
  globalSequence: number;
  components: number;
  tracks: Array<{ sequence: number; times: Uint32Array; values: Float32Array }>;
}

/** One `FBlock`: keyed on a single particle's life, 0 at birth and 1 at death. */
export interface WvmRamp {
  components: number;
  times: Float32Array;
  values: Float32Array;
}

export interface WvmParticleEmitter {
  id: number;
  flags: number;
  position: [number, number, number];
  bone: number;
  texture: number;
  blendType: number;
  emitterType: number;
  /**
   * The two bytes at 0x2C and 0x2D of the record, under the names the layout gives them.
   *
   * They do not hold what those names promise. `headorTail` is documented as an enum of 0, 1 and
   * 2, and across the twenty-six emitters of the local models the byte takes the values 0, 4, 6,
   * 8, 9, 16, 19, 24 and 32 — as `fp_2_5` fixed point those are 0, 1/8, 3/16, 1/4, 9/32, 1/2,
   * 19/32, 3/4 and 1, which is the `multiTextureParamX` pair that sits at this offset from
   * Burning Crusade onwards. They travel because they are in the record; nothing reads them as a
   * mode, and every emitter draws a head.
   */
  particleType: number;
  headTail: number;
  particleColorIndex: number;
  textureTileRotation: number;
  textureRows: number;
  textureColumns: number;
  lifespanVary: number;
  emissionRateVary: number;
  scaleVary: [number, number];
  tailLength: number;
  twinkleSpeed: number;
  twinklePercent: number;
  twinkleScaleMin: number;
  twinkleScaleMax: number;
  burstMultiplier: number;
  drag: number;
  baseSpin: number;
  baseSpinVary: number;
  spin: number;
  spinVary: number;
  windVector: [number, number, number];
  windTime: number;
  followSpeed1: number;
  followScale1: number;
  followSpeed2: number;
  followScale2: number;
  splinePoints: Float32Array;
  emissionSpeed: WvmTrack;
  speedVariation: WvmTrack;
  verticalRange: WvmTrack;
  horizontalRange: WvmTrack;
  gravity: WvmTrack;
  lifespan: WvmTrack;
  emissionRate: WvmTrack;
  emissionAreaLength: WvmTrack;
  emissionAreaWidth: WvmTrack;
  zSource: WvmTrack;
  enabledIn: WvmTrack;
  color: WvmRamp;
  opacity: WvmRamp;
  scale: WvmRamp;
  headCell: WvmRamp;
  tailCell: WvmRamp;
}

/** What a ribbon's material said, resolved by the tool: the M2's own table is not in the artifact. */
export interface WvmRibbonMaterial {
  blendMode: number;
  flags: number;
}

export interface WvmRibbonEmitter {
  id: number;
  bone: number;
  position: [number, number, number];
  /**
   * Indices into `WvmModel.textures`, used directly.
   *
   * Two reference clients call this a texture-*lookup* index, which would need a step through the
   * model's combo table first. It does not: across all 1,502 ribbon emitters in the client every
   * raw value is in range of the texture table, and 742 of them are out of range of the combo
   * table — 249 because the model has no combo table at all.
   */
  textures: Uint16Array;
  materials: WvmRibbonMaterial[];
  edgesPerSecond: number;
  edgeLifetime: number;
  gravity: number;
  textureRows: number;
  textureColumns: number;
  priorityPlane: number;
  ribbonColorIndex: number;
  textureTransformLookupIndex: number;
  color: WvmTrack;
  alpha: WvmTrack;
  heightAbove: WvmTrack;
  heightBelow: WvmTrack;
  textureSlot: WvmTrack;
  visibility: WvmTrack;
}

/**
 * One `M2Color`: what a batch is painted and how opaque that paint is, over the animation.
 *
 * Two tracks rather than four components, because the file stores them apart and in different
 * widths — the colour as three floats, the alpha as fixed16 — and because a great many batches
 * carry a white colour with a fading alpha, which is a fade and not a tint.
 */
export interface WvmColour {
  rgb: WvmTrack;
  alpha: WvmTrack;
}

/**
 * One `M2TextureTransform`: where a batch's texture is, which way round and how big, over the
 * animation.
 *
 * Three tracks rather than one matrix, because the file stores three and because they move on
 * different clocks — a rune circle whose translation runs on the model's animation and whose
 * rotation is bound to a global loop is one record with two timelines in it. The rotation is a
 * plain quaternion, four floats; see `readTextureTransforms` in tools/m2.mjs for the measurement
 * that settled that against the packed form a bone track uses.
 */
export interface WvmTextureTransform {
  translation: WvmTrack;
  rotation: WvmTrack;
  scaling: WvmTrack;
}

/**
 * The camera the original client frames a portrait with, when the model carries one.
 *
 * `fov` is the file's own number in radians. Whether the angle is the vertical or the diagonal
 * one is the single thing about this record that cannot be settled without looking at a screen —
 * for HumanMale it is the difference between a bust and a face — so it travels as stored.
 */
export interface WvmCamera {
  fov: number;
  near: number;
  far: number;
  position: [number, number, number];
  target: [number, number, number];
}

export interface WvmModel {
  positions: Float32Array;
  normals: Float32Array;
  uv0: Float32Array;
  uv1: Float32Array;
  boneIndices?: Uint8Array;
  boneWeights?: Float32Array;
  indices: Uint16Array | Uint32Array;
  submeshes: WvmSubmesh[];
  batches: WvmBatch[];
  textures: WvmTextureSlot[];
  attachments: WvmAttachment[];
  bounds: { min: [number, number, number]; max: [number, number, number]; radius: number };
  skeleton?: WvmSkeleton;
  /** Loop durations in milliseconds. A track bound to one runs on this rather than on an animation. */
  globalSequences: Uint32Array;
  particleEmitters: WvmParticleEmitter[];
  ribbonEmitters: WvmRibbonEmitter[];
  /** Indexed by `WvmBatch.colorIndex`; 0xFFFF and anything past the end mean "no colour". */
  colours: WvmColour[];
  /** Indexed by `WvmBatch.textureWeight`, which the tool has already resolved through the combo table. */
  textureWeights: WvmTrack[];
  /** Indexed by `WvmBatch.textureTransform`, resolved through the combo table by the tool as well. */
  textureTransforms: WvmTextureTransform[];
  /** Absent on 193 of the 1,323 readable creature models, and on most scenery. */
  portraitCamera?: WvmCamera;
  /**
   * The shot a model that is a *scene* was authored to be looked at through — `cameras[0]`,
   * whatever its type says.
   *
   * The same record and the same 36 bytes as the field above, distinguished only by which flag the
   * artifact set, because the two answer different questions. A unit's type-0 camera frames its
   * face for a portrait frame; a glue set's camera is the composition itself. Measured over the 19
   * models under `Interface\Glues\Models\`: 13 carry exactly one camera, every one of them type
   * −1, and not one type-0 record exists in the directory — so before G1 every login-screen model
   * arrived with no camera at all and its authored framing had to be guessed at.
   *
   * Never set at the same time as `portraitCamera`; the artifact cannot spell both.
   */
  sceneCamera?: WvmCamera;
}

const HEADER_SIZE = 72;
const SUBMESH_SIZE = 12;
const BATCH_SIZE = 20;
const ATTACHMENT_SIZE = 16;
const SKINNED = 0x01;
const PORTRAIT_CAMERA = 0x02;
/** The same 36-byte slot, holding a scene camera rather than a portrait one. See `sceneCamera`. */
const SCENE_CAMERA = 0x04;
const CAMERA_SIZE = 36;
const WVA1_HEADER_SIZE = 12;
const SKELETON_HEADER_SIZE = 4;
const BONE_SIZE = 16;
const CLIP_HEADER_SIZE = 12;
const CHANNEL_HEADER_SIZE = 8;
/**
 * The optional per-clip extras table that may follow the clips inside either container.
 *
 * Both containers end where their buffer does, so "anything left after the last clip" is the whole
 * presence test — and an artifact written before slice A2 has nothing left, which is why it
 * decodes exactly as it did. `CLIP_EXTRAS_RECORD_SIZE` is the size this build understands; the
 * block carries its own, so a record grown by a later slice is stepped over rather than misread.
 */
/** Float64 slots per clip in a packed clip table (`decodeWvaAnimationsPacked`). */
export const WVA_CLIP_STRIDE = 9;
/** Slot offsets inside one packed clip record; an optional field the object form omits is NaN. */
export const WVA_CLIP_ANIMATION = 0;
export const WVA_CLIP_DURATION = 1;
export const WVA_CLIP_BLEND_TIME = 2;
export const WVA_CLIP_MOVING_SPEED = 3;
export const WVA_CLIP_VARIATION_INDEX = 4;
export const WVA_CLIP_VARIATION_NEXT = 5;
export const WVA_CLIP_FIRST_CHANNEL = 6;
export const WVA_CLIP_CHANNELS = 7;
export const WVA_CLIP_FIRST_KEY = 8;
/** Uint32 words per packed channel: `bone | kind << 16`, then the key count. */
export const WVA_CHANNEL_STRIDE = 2;
const CLIP_EXTRAS_MAGIC = "WVX1";
const CLIP_EXTRAS_HEADER_SIZE = 8;
const CLIP_EXTRAS_RECORD_SIZE = 8;
const GLOBAL_BONE_CHANNELS_MAGIC = "WVG1";
const GLOBAL_BONE_CHANNELS_HEADER_SIZE = 8;
const GLOBAL_BONE_CHANNEL_HEADER_SIZE = 12;
const decoder = new TextDecoder();

function checkedBytes(count: number, stride: number, label: string): number {
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(stride) || stride < 0
    || count > Math.floor(Number.MAX_SAFE_INTEGER / stride)) {
    throw new Error(`${label} size is out of range`);
  }
  return count * stride;
}

function checkedEnd(start: number, length: number, limit: number, label: string): number {
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 0
    || start > limit || length > limit - start) {
    throw new Error(`${label} runs past the end of the block`);
  }
  return start + length;
}

function checkedCountEnd(start: number, count: number, stride: number, limit: number, label: string): number {
  return checkedEnd(start, checkedBytes(count, stride, label), limit, label);
}

export function isWvm9(data: ArrayBuffer): boolean {
  return data.byteLength >= 4 && decoder.decode(new Uint8Array(data, 0, 4)) === "WVM9";
}

export function decodeWvm9(data: ArrayBuffer): WvmModel {
  if (!isWvm9(data)) throw new Error("Not a WVM9 model");
  if (data.byteLength < HEADER_SIZE) throw new Error("WVM9 header is truncated");
  const view = new DataView(data);
  const vertexCount = view.getUint32(4, true);
  const indexCount = view.getUint32(8, true);
  const indexBytes = view.getUint8(12);
  const skinned = (view.getUint8(13) & SKINNED) !== 0;
  const submeshCount = view.getUint16(14, true);
  const batchCount = view.getUint16(16, true);
  const textureCount = view.getUint16(18, true);
  const skeletonOffset = view.getUint32(20, true);
  const total = view.getUint32(24, true);
  const attachmentCount = view.getUint16(56, true);
  const animationCount = view.getUint16(58, true);
  const globalSequenceCount = view.getUint16(60, true);
  const particleCount = view.getUint16(62, true);
  const ribbonCount = view.getUint16(64, true);
  const colourCount = view.getUint16(66, true);
  const weightCount = view.getUint16(68, true);
  const transformCount = view.getUint16(70, true);
  // One slot, and the flag says which of the two things it is. Both set is not a later addition a
  // reader could step over — it is an artifact claiming one 36-byte record is two different
  // records, so it is refused here rather than resolved by whichever branch happens to run first.
  const cameraFlags = view.getUint8(13) & (PORTRAIT_CAMERA | SCENE_CAMERA);
  if (cameraFlags === (PORTRAIT_CAMERA | SCENE_CAMERA)) {
    throw new Error("WVM9 claims both a portrait and a scene camera in one slot");
  }
  const hasCamera = cameraFlags !== 0;
  const sceneFramed = cameraFlags === SCENE_CAMERA;

  if (total !== data.byteLength) throw new Error(`WVM9 says it is ${total} bytes but ${data.byteLength} arrived`);
  if (indexBytes !== 2 && indexBytes !== 4) throw new Error("WVM9 index width is invalid");
  // Zero is a real answer here: nearly a third of the models a spell names have no geometry at
  // all and are nothing but emitters.
  if (vertexCount > 4_000_000) throw new Error("WVM9 vertex count is out of range");
  preflightWvm9(view, data.byteLength, {
    vertexCount, indexCount, indexBytes, skinned, submeshCount, batchCount, textureCount,
    skeletonOffset, attachmentCount, animationCount, globalSequenceCount, particleCount,
    ribbonCount, colourCount, weightCount, transformCount, hasCamera,
  });

  const bounds = {
    min: [view.getFloat32(28, true), view.getFloat32(32, true), view.getFloat32(36, true)] as [number, number, number],
    max: [view.getFloat32(40, true), view.getFloat32(44, true), view.getFloat32(48, true)] as [number, number, number],
    radius: view.getFloat32(52, true),
  };

  let offset = HEADER_SIZE;
  const take = (count: number): Float32Array => {
    const values = new Float32Array(count);
    for (let index = 0; index < count; index++) values[index] = view.getFloat32(offset + index * 4, true);
    offset += count * 4;
    return values;
  };
  const positions = take(vertexCount * 3);
  const normals = take(vertexCount * 3);
  const uv0 = take(vertexCount * 2);
  const uv1 = take(vertexCount * 2);

  let boneIndices: Uint8Array | undefined;
  let boneWeights: Float32Array | undefined;
  if (skinned) {
    boneIndices = new Uint8Array(data.slice(offset, offset + vertexCount * 4));
    offset += vertexCount * 4;
    const raw = new Uint8Array(data, offset, vertexCount * 4);
    // three.js wants normalised weights; the file stores them as a byte each summing to 255.
    boneWeights = new Float32Array(vertexCount * 4);
    for (let index = 0; index < raw.length; index++) boneWeights[index] = raw[index]! / 255;
    offset += vertexCount * 4;
  }

  const indices = indexBytes === 2 ? new Uint16Array(indexCount) : new Uint32Array(indexCount);
  for (let index = 0; index < indexCount; index++) {
    indices[index] = indexBytes === 2 ? view.getUint16(offset + index * 2, true) : view.getUint32(offset + index * 4, true);
  }
  offset += indexCount * indexBytes;

  const submeshes: WvmSubmesh[] = [];
  for (let index = 0; index < submeshCount; index++) {
    const at = offset + index * SUBMESH_SIZE;
    submeshes.push({
      geosetId: view.getUint16(at, true),
      indexStart: view.getUint32(at + 4, true),
      indexCount: view.getUint32(at + 8, true),
    });
  }
  offset += submeshCount * SUBMESH_SIZE;

  const batches: WvmBatch[] = [];
  for (let index = 0; index < batchCount; index++) {
    const at = offset + index * BATCH_SIZE;
    const units = view.getUint8(at + 6);
    const uvMask = view.getUint8(at + 7);
    const textures: number[] = [];
    const uvSets: number[] = [];
    for (let unit = 0; unit < Math.min(2, units); unit++) {
      textures.push(view.getInt16(at + 8 + unit * 2, true));
      uvSets.push((uvMask >> unit) & 1);
    }
    batches.push({
      submesh: view.getUint16(at, true),
      blendMode: view.getUint8(at + 2),
      materialFlags: view.getUint8(at + 3),
      priorityPlane: view.getInt8(at + 4),
      materialLayer: view.getUint8(at + 5),
      textures,
      uvSets,
      textureWeight: view.getInt16(at + 12, true),
      textureTransform: view.getInt16(at + 14, true),
      shaderId: view.getUint16(at + 16, true),
      colorIndex: view.getUint16(at + 18, true),
    });
  }
  offset += batchCount * BATCH_SIZE;

  const textures: WvmTextureSlot[] = [];
  for (let index = 0; index < textureCount; index++) {
    const type = view.getUint16(offset, true);
    const flags = view.getUint16(offset + 2, true);
    const length = view.getUint16(offset + 4, true);
    const path = length === 0 ? "" : decoder.decode(new Uint8Array(data, offset + 6, length));
    textures.push({ type, flags, path });
    offset += 6 + length;
  }

  const attachments: WvmAttachment[] = [];
  for (let index = 0; index < attachmentCount; index++) {
    const at = offset + index * ATTACHMENT_SIZE;
    attachments.push({
      id: view.getUint16(at, true),
      bone: view.getUint16(at + 2, true),
      position: [view.getFloat32(at + 4, true), view.getFloat32(at + 8, true), view.getFloat32(at + 12, true)],
    });
  }
  offset += attachmentCount * ATTACHMENT_SIZE;

  const animations: number[] = [];
  for (let index = 0; index < animationCount; index++) animations.push(view.getUint16(offset + index * 2, true));
  offset += animationCount * 2;

  const globalSequences = new Uint32Array(globalSequenceCount);
  for (let index = 0; index < globalSequenceCount; index++) globalSequences[index] = view.getUint32(offset + index * 4, true);
  offset += globalSequenceCount * 4;

  const particleEmitters: WvmParticleEmitter[] = [];
  for (let index = 0; index < particleCount; index++) {
    const size = view.getUint16(offset, true);
    if (size < 4 || offset + size > data.byteLength) break;
    particleEmitters.push(decodeParticleEmitter(view, offset));
    offset += size;
  }
  const ribbonEmitters: WvmRibbonEmitter[] = [];
  for (let index = 0; index < ribbonCount; index++) {
    const size = view.getUint16(offset, true);
    if (size < 4 || offset + size > data.byteLength) break;
    ribbonEmitters.push(decodeRibbonEmitter(view, offset));
    offset += size;
  }

  const colours: WvmColour[] = [];
  for (let index = 0; index < colourCount; index++) {
    const rgb = decodeTrack(view, offset);
    offset += rgb.size;
    const alpha = decodeTrack(view, offset);
    offset += alpha.size;
    colours.push({ rgb: rgb.track, alpha: alpha.track });
  }
  const textureWeights: WvmTrack[] = [];
  for (let index = 0; index < weightCount; index++) {
    const weight = decodeTrack(view, offset);
    offset += weight.size;
    textureWeights.push(weight.track);
  }
  const textureTransforms: WvmTextureTransform[] = [];
  for (let index = 0; index < transformCount; index++) {
    const translation = decodeTrack(view, offset);
    offset += translation.size;
    const rotation = decodeTrack(view, offset);
    offset += rotation.size;
    const scaling = decodeTrack(view, offset);
    offset += scaling.size;
    textureTransforms.push({ translation: translation.track, rotation: rotation.track, scaling: scaling.track });
  }

  const model: WvmModel = {
    positions, normals, uv0, uv1, indices, submeshes, batches, textures, attachments, bounds,
    globalSequences, particleEmitters, ribbonEmitters, colours, textureWeights, textureTransforms,
  };
  if (hasCamera && offset + CAMERA_SIZE <= data.byteLength) {
    const camera: WvmCamera = {
      fov: view.getFloat32(offset, true),
      near: view.getFloat32(offset + 4, true),
      far: view.getFloat32(offset + 8, true),
      position: [view.getFloat32(offset + 12, true), view.getFloat32(offset + 16, true), view.getFloat32(offset + 20, true)],
      target: [view.getFloat32(offset + 24, true), view.getFloat32(offset + 28, true), view.getFloat32(offset + 32, true)],
    };
    // Which field it lands in is the whole difference between the two flags. `portraitCamera` keeps
    // meaning «a unit's type-0 record», so `PortraitRenderer` and `portraitCameraSpec` see exactly
    // what they saw before a scene camera could exist.
    if (sceneFramed) model.sceneCamera = camera;
    else model.portraitCamera = camera;
  }
  if (boneIndices) model.boneIndices = boneIndices;
  if (boneWeights) model.boneWeights = boneWeights;
  if (skeletonOffset > 0) {
    model.skeleton = { ...decodeSkeleton(data, skeletonOffset, data.byteLength), animations };
  }
  return model;
}

/**
 * The animations that did not travel with the model, decoded against the rig that did.
 *
 * `bones` is what the caller already has; a block built for a different model would pose bones
 * that mean something else there, so the counts have to agree before a single key is read.
 */
export function decodeWvaAnimations(data: ArrayBuffer, bones: number): WvmSkeletonClip[] {
  const { view, clipCount, boneCount } = preflightWvaAnimations(data, bones);
  return readClips(view, data, WVA1_HEADER_SIZE, clipCount, boneCount, data.byteLength);
}

/** Every clip of one WVA block in three flat arrays; the layout is `WvaPackedAnimations`'. */
export interface WvaPackedClips {
  readonly clipTable: Float64Array<ArrayBuffer>;
  readonly channelTable: Uint32Array<ArrayBuffer>;
  readonly keys: Float32Array<ArrayBuffer>;
  /** One past the highest bone any channel poses. */
  readonly span: number;
}

/**
 * `decodeWvaAnimations` into three flat arrays, for the decode worker to transfer.
 *
 * Same preflight, same per-key arithmetic, the same values in the same order — only the containers
 * differ: one key backing and two index tables instead of a backing per clip, an object per channel
 * and two views each (HumanMale: 182 backings, ~38k objects, ~76k views, all built only to be
 * flattened again). `tests/wva-packed-sidecars.test.mjs` holds the two to the same bits.
 */
export function decodeWvaAnimationsPacked(data: ArrayBuffer, bones: number): WvaPackedClips {
  const { view, clipCount, boneCount } = preflightWvaAnimations(data, bones);
  return readClipsPacked(view, WVA1_HEADER_SIZE, clipCount, boneCount, data.byteLength);
}

function preflightWvaAnimations(data: ArrayBuffer, bones: number): {
  view: DataView; clipCount: number; boneCount: number;
} {
  if (data.byteLength < WVA1_HEADER_SIZE || decoder.decode(new Uint8Array(data, 0, 4)) !== "WVA1") {
    throw new Error("Not a WVA1 animation block");
  }
  const view = new DataView(data);
  if (view.getUint32(4, true) !== data.byteLength) throw new Error("WVA1 length disagrees with the response");
  const boneCount = view.getUint16(8, true);
  if (boneCount === 0 || boneCount > 1024) throw new Error("WVA1 bone count is out of range");
  if (boneCount !== bones) throw new Error(`WVA1 is rigged for ${boneCount} bones, the model has ${bones}`);
  const clipCount = view.getUint16(10, true);
  const end = preflightClips(view, WVA1_HEADER_SIZE, clipCount, boneCount, data.byteLength);
  const extrasEnd = preflightClipExtras(view, end, clipCount, data.byteLength);
  if (extrasEnd !== data.byteLength) throw new Error("WVA1 has trailing bytes after its clips");
  return { view, clipCount, boneCount };
}

function decodeSkeleton(data: ArrayBuffer, start: number, limit: number): Omit<WvmSkeleton, "animations"> {
  const view = new DataView(data);
  const boneCount = view.getUint16(start, true);
  const clipCount = view.getUint16(start + 2, true);
  if (boneCount === 0 || boneCount > 1024 || clipCount > 1024) {
    throw new Error("WVM6 skeleton header is out of range");
  }

  let offset = start + 4;
  const parents = new Int16Array(boneCount);
  const flags = new Uint16Array(boneCount);
  const pivots = new Float32Array(boneCount * 3);
  for (let bone = 0; bone < boneCount; bone++) {
    parents[bone] = view.getInt16(offset, true);
    flags[bone] = view.getUint16(offset + 2, true);
    for (let axis = 0; axis < 3; axis++) pivots[bone * 3 + axis] = view.getFloat32(offset + 4 + axis * 4, true);
    // A forward reference would pose a child before its parent; root it instead.
    if (parents[bone]! >= bone) parents[bone] = -1;
    offset += 16;
  }

  const clipsEnd = preflightClips(view, offset, clipCount, boneCount, limit);
  const extrasEnd = preflightClipExtras(view, clipsEnd, clipCount, limit, true);
  // `readClips` must stop before WVG1: otherwise its optional WVX1 reader would interpret the
  // global-channel header as per-clip metadata. Old artifacts have extrasEnd === limit and decode
  // to the same empty array they always implied.
  return {
    parents,
    flags,
    pivots,
    clips: readClips(view, data, offset, clipCount, boneCount, extrasEnd),
    globalChannels: extrasEnd < limit
      ? readGlobalBoneChannels(view, extrasEnd, boneCount)
      : [],
  };
}

interface Wvm9Layout {
  vertexCount: number;
  indexCount: number;
  indexBytes: number;
  skinned: boolean;
  submeshCount: number;
  batchCount: number;
  textureCount: number;
  skeletonOffset: number;
  attachmentCount: number;
  animationCount: number;
  globalSequenceCount: number;
  particleCount: number;
  ribbonCount: number;
  colourCount: number;
  weightCount: number;
  transformCount: number;
  hasCamera: boolean;
}

function preflightWvm9(view: DataView, length: number, layout: Wvm9Layout): void {
  let offset = HEADER_SIZE;
  offset = checkedCountEnd(offset, layout.vertexCount, 40, length, "WVM9 vertex streams");
  if (layout.skinned) offset = checkedCountEnd(offset, layout.vertexCount, 8, length, "WVM9 skin streams");
  offset = checkedCountEnd(offset, layout.indexCount, layout.indexBytes, length, "WVM9 index stream");
  offset = checkedCountEnd(offset, layout.submeshCount, SUBMESH_SIZE, length, "WVM9 submesh table");
  offset = checkedCountEnd(offset, layout.batchCount, BATCH_SIZE, length, "WVM9 batch table");

  checkedCountEnd(offset, layout.textureCount, 6, length, "WVM9 texture table headers");
  for (let index = 0; index < layout.textureCount; index++) {
    checkedEnd(offset, 6, length, "WVM9 texture header");
    const pathLength = view.getUint16(offset + 4, true);
    offset = checkedEnd(offset + 6, pathLength, length, "WVM9 texture path");
  }

  offset = checkedCountEnd(offset, layout.attachmentCount, ATTACHMENT_SIZE, length, "WVM9 attachment table");
  offset = checkedCountEnd(offset, layout.animationCount, 2, length, "WVM9 animation table");
  offset = checkedCountEnd(offset, layout.globalSequenceCount, 4, length, "WVM9 global sequence table");

  checkedCountEnd(offset, layout.particleCount, 2, length, "WVM9 particle emitter headers");
  for (let index = 0; index < layout.particleCount; index++) {
    checkedEnd(offset, 2, length, "WVM9 particle emitter header");
    const size = view.getUint16(offset, true);
    if (size < 4) throw new Error("WVM9 particle emitter size is out of range");
    const end = checkedEnd(offset, size, length, "WVM9 particle emitter");
    preflightParticleEmitter(view, offset, end);
    offset = end;
  }

  checkedCountEnd(offset, layout.ribbonCount, 2, length, "WVM9 ribbon emitter headers");
  for (let index = 0; index < layout.ribbonCount; index++) {
    checkedEnd(offset, 2, length, "WVM9 ribbon emitter header");
    const size = view.getUint16(offset, true);
    if (size < 4) throw new Error("WVM9 ribbon emitter size is out of range");
    const end = checkedEnd(offset, size, length, "WVM9 ribbon emitter");
    preflightRibbonEmitter(view, offset, end);
    offset = end;
  }

  for (let index = 0; index < layout.colourCount; index++) {
    offset = preflightTrack(view, offset, length, 3);
    offset = preflightTrack(view, offset, length, 1);
  }
  for (let index = 0; index < layout.weightCount; index++) offset = preflightTrack(view, offset, length, 1);
  for (let index = 0; index < layout.transformCount; index++) {
    offset = preflightTrack(view, offset, length, 3);
    offset = preflightTrack(view, offset, length, 4);
    offset = preflightTrack(view, offset, length, 3);
  }
  // One slot whichever flag named it, so the preflight neither knows nor needs to know which.
  if (layout.hasCamera) offset = checkedEnd(offset, CAMERA_SIZE, length, "WVM9 camera");

  if ((layout.skeletonOffset !== 0) !== layout.skinned) {
    throw new Error("WVM9 skin flag and skeleton offset disagree");
  }
  if (layout.skeletonOffset === 0) {
    if (offset !== length) throw new Error("WVM9 has trailing bytes after its body");
    return;
  }
  if (layout.skeletonOffset !== offset) throw new Error("WVM9 skeleton offset disagrees with the body");
  const skeletonEnd = preflightSkeleton(view, layout.skeletonOffset, length);
  if (skeletonEnd !== length) throw new Error("WVM9 has trailing bytes after its skeleton");
}

function preflightSkeleton(view: DataView, start: number, limit: number): number {
  checkedEnd(start, SKELETON_HEADER_SIZE, limit, "WVM9 skeleton header");
  const boneCount = view.getUint16(start, true);
  const clipCount = view.getUint16(start + 2, true);
  if (boneCount === 0 || boneCount > 1024 || clipCount > 1024) {
    throw new Error("WVM9 skeleton header is out of range");
  }
  const clipsAt = checkedCountEnd(start + SKELETON_HEADER_SIZE, boneCount, BONE_SIZE, limit, "WVM9 bone table");
  const clipsEnd = preflightClips(view, clipsAt, clipCount, boneCount, limit);
  const extrasEnd = preflightClipExtras(view, clipsEnd, clipCount, limit, true);
  return extrasEnd < limit
    ? preflightGlobalBoneChannels(view, extrasEnd, boneCount, limit)
    : extrasEnd;
}

/**
 * Walks the optional extras table, and answers where the clip block really ends.
 *
 * Three answers, and the first is the one every artifact written before slice A2 gets: nothing
 * follows the clips, so the clips are the end. Otherwise the magic has to be there — a container
 * with unexplained trailing bytes is a container this reader does not understand, and saying so is
 * better than posing a model with half a file. The record count must equal the clip count because
 * the table is dense and positional: a mismatch would pair a stride with another clip's keyframes.
 */
function preflightClipExtras(
  view: DataView,
  start: number,
  clipCount: number,
  limit: number,
  allowGlobalChannels = false,
): number {
  if (start === limit) return start;
  checkedEnd(start, CLIP_EXTRAS_HEADER_SIZE, limit, "Animation clip extras header");
  const magic = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + start, 4));
  if (allowGlobalChannels && magic === GLOBAL_BONE_CHANNELS_MAGIC) return start;
  if (magic !== CLIP_EXTRAS_MAGIC) throw new Error("Animation clips are followed by an unknown block");
  const recordSize = view.getUint16(start + 4, true);
  const count = view.getUint16(start + 6, true);
  if (recordSize < CLIP_EXTRAS_RECORD_SIZE) throw new Error("Animation clip extras record is too small");
  if (count !== clipCount) throw new Error("Animation clip extras count disagrees with the clips");
  return checkedCountEnd(start + CLIP_EXTRAS_HEADER_SIZE, count, recordSize, limit,
    "Animation clip extras");
}

function preflightGlobalBoneChannels(view: DataView, start: number, boneCount: number, limit: number): number {
  checkedEnd(start, GLOBAL_BONE_CHANNELS_HEADER_SIZE, limit, "WVM9 global bone header");
  const magic = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + start, 4));
  if (magic !== GLOBAL_BONE_CHANNELS_MAGIC) throw new Error("WVM9 skeleton has an unknown trailing block");
  const count = view.getUint16(start + 4, true);
  let offset = start + GLOBAL_BONE_CHANNELS_HEADER_SIZE;
  checkedCountEnd(offset, count, GLOBAL_BONE_CHANNEL_HEADER_SIZE, limit, "WVM9 global bone channel headers");
  for (let index = 0; index < count; index++) {
    checkedEnd(offset, GLOBAL_BONE_CHANNEL_HEADER_SIZE, limit, "WVM9 global bone channel header");
    const bone = view.getUint16(offset, true);
    const kind = view.getUint8(offset + 2);
    const keys = view.getUint32(offset + 8, true);
    if (bone >= boneCount) throw new Error("WVM9 global bone channel bone is out of range");
    if (kind !== 0 && kind !== 1 && kind !== 2) throw new Error("WVM9 global bone channel kind is invalid");
    offset += GLOBAL_BONE_CHANNEL_HEADER_SIZE;
    offset = checkedCountEnd(offset, keys, 4, limit, "WVM9 global bone key times");
    const components = kind === 1 ? 4 : 3;
    offset = checkedCountEnd(offset, keys,
      checkedBytes(components, kind === 1 ? 2 : 4, "WVM9 global bone key values"), limit,
      "WVM9 global bone key values");
  }
  return offset;
}

function readGlobalBoneChannels(
  view: DataView,
  start: number,
  boneCount: number,
): WvmSkeletonGlobalChannel[] {
  const count = view.getUint16(start + 4, true);
  const channels: WvmSkeletonGlobalChannel[] = [];
  let offset = start + GLOBAL_BONE_CHANNELS_HEADER_SIZE;
  for (let index = 0; index < count; index++) {
    const bone = view.getUint16(offset, true);
    const kind = view.getUint8(offset + 2) as 0 | 1 | 2;
    const interpolation = view.getUint8(offset + 3);
    const globalSequence = view.getUint16(offset + 4, true);
    const keys = view.getUint32(offset + 8, true);
    offset += GLOBAL_BONE_CHANNEL_HEADER_SIZE;
    const times = new Float32Array(keys);
    for (let key = 0; key < keys; key++) times[key] = view.getUint32(offset + key * 4, true) / 1000;
    offset += keys * 4;
    const components = kind === 1 ? 4 : 3;
    const values = new Float32Array(keys * components);
    for (let key = 0; key < keys; key++) {
      for (let part = 0; part < components; part++) {
        if (kind === 1) {
          const raw = view.getInt16(offset + (key * 4 + part) * 2, true);
          values[key * 4 + part] = (raw < 0 ? raw + 32768 : raw - 32767) / 32767;
        } else {
          values[key * components + part] = view.getFloat32(
            offset + (key * components + part) * 4, true);
        }
      }
    }
    offset += keys * components * (kind === 1 ? 2 : 4);
    if (bone < boneCount) channels.push({
      bone, kind, interpolation, globalSequence, times, values,
    });
  }
  return channels;
}

function preflightClips(view: DataView, start: number, clipCount: number, boneCount: number, limit: number): number {
  if (clipCount > 1024) throw new Error("Animation clip count is out of range");
  checkedCountEnd(start, clipCount, CLIP_HEADER_SIZE, limit, "Animation clip headers");
  let offset = start;
  for (let clip = 0; clip < clipCount; clip++) {
    checkedEnd(offset, CLIP_HEADER_SIZE, limit, "Animation clip header");
    const channelCount = view.getUint32(offset + 8, true);
    offset += CLIP_HEADER_SIZE;
    checkedCountEnd(offset, channelCount, CHANNEL_HEADER_SIZE, limit, "Animation channel headers");
    for (let channel = 0; channel < channelCount; channel++) {
      checkedEnd(offset, CHANNEL_HEADER_SIZE, limit, "Animation channel header");
      const bone = view.getUint16(offset, true);
      const kind = view.getUint8(offset + 2);
      const keys = view.getUint32(offset + 4, true);
      if (bone >= boneCount) throw new Error("Animation channel bone is out of range");
      if (kind !== 0 && kind !== 1 && kind !== 2) throw new Error("Animation channel kind is invalid");
      offset += CHANNEL_HEADER_SIZE;
      offset = checkedCountEnd(offset, keys, 4, limit, "Animation key times");
      const components = kind === 1 ? 4 : 3;
      offset = checkedCountEnd(offset, keys, checkedBytes(components, kind === 1 ? 2 : 4, "Animation key values"), limit,
        "Animation key values");
    }
  }
  return offset;
}

function preflightTrack(view: DataView, at: number, limit: number, expectedComponents: number): number {
  checkedEnd(at, 4, limit, "WVM9 track header");
  const components = view.getUint8(at + 2);
  const subCount = view.getUint8(at + 3);
  if (components !== expectedComponents) throw new Error("WVM9 track component count is invalid");
  let offset = at + 4;
  checkedCountEnd(offset, subCount, 4, limit, "WVM9 sub-track headers");
  for (let index = 0; index < subCount; index++) {
    checkedEnd(offset, 4, limit, "WVM9 sub-track header");
    const keys = view.getUint16(offset + 2, true);
    offset += 4;
    offset = checkedCountEnd(offset, keys, 4, limit, "WVM9 track times");
    offset = checkedCountEnd(offset, keys, checkedBytes(components, 4, "WVM9 track values"), limit, "WVM9 track values");
  }
  return offset;
}

function preflightRamp(view: DataView, at: number, limit: number, expectedComponents: number): number {
  checkedEnd(at, 4, limit, "WVM9 ramp header");
  const components = view.getUint8(at);
  const keys = view.getUint16(at + 2, true);
  if (components !== expectedComponents) throw new Error("WVM9 ramp component count is invalid");
  let offset = checkedCountEnd(at + 4, keys, 4, limit, "WVM9 ramp times");
  offset = checkedCountEnd(offset, keys, checkedBytes(components, 4, "WVM9 ramp values"), limit, "WVM9 ramp values");
  return offset;
}

function preflightParticleEmitter(view: DataView, at: number, limit: number): void {
  checkedEnd(at, 40 + 23 * 4, limit, "WVM9 particle emitter fixed fields");
  const splinePointCount = view.getUint16(at + 38, true);
  if (splinePointCount > 4095) throw new Error("WVM9 particle spline count is out of range");
  let offset = checkedCountEnd(at + 40 + 23 * 4, splinePointCount, 12, limit, "WVM9 particle spline");
  for (let index = 0; index < PARTICLE_TRACK_NAMES.length; index++) offset = preflightTrack(view, offset, limit, 1);
  const components = [3, 1, 2, 1, 1];
  for (const count of components) offset = preflightRamp(view, offset, limit, count);
}

function preflightRibbonEmitter(view: DataView, at: number, limit: number): void {
  checkedEnd(at, 44, limit, "WVM9 ribbon emitter fixed fields");
  const textureCount = view.getUint8(at + 22);
  const materialCount = view.getUint8(at + 23);
  let offset = checkedCountEnd(at + 44, textureCount, 2, limit, "WVM9 ribbon textures");
  offset = checkedCountEnd(offset, materialCount, 2, limit, "WVM9 ribbon materials");
  const components = [3, 1, 1, 1, 1, 1];
  for (const count of components) offset = preflightTrack(view, offset, limit, count);
}

/** The clip encoding, which the model artifact and the animation block share byte for byte. */
function readClips(view: DataView, data: ArrayBuffer, start: number, clipCount: number, boneCount: number,
  limit: number): WvmSkeletonClip[] {
  let offset = start;
  const clips: WvmSkeletonClip[] = [];
  for (let clip = 0; clip < clipCount; clip++) {
    const animationId = view.getUint16(offset, true);
    // Reserved and written as zero from WVM6 until slice A1, `M2Sequence.blendTime` since. Zero is
    // kept as "the artifact says nothing", not as an instant blend: an old cached artifact and a
    // sequence that authored no blend time are the same byte here, and both want the fallback.
    const blendTimeMs = view.getUint16(offset + 2, true);
    const duration = view.getUint32(offset + 4, true);
    const channelCount = view.getUint32(offset + 8, true);
    offset += 12;
    const channels: WvmSkeletonClip["channels"] = [];
    // A clip is retained as a whole. Store its key data in one exact-sized backing instead of
    // allocating two ArrayBuffers for every channel (tens of thousands per character sidecar).
    // The preflight has already checked every channel and byte range before this allocation.
    let keyFloats = 0;
    let channelAt = offset;
    for (let index = 0; index < channelCount; index++) {
      const rotation = view.getUint8(channelAt + 2) === 1;
      const keys = view.getUint32(channelAt + 4, true);
      keyFloats += keys * (rotation ? 5 : 4);
      channelAt += CHANNEL_HEADER_SIZE + keys * (rotation ? 12 : 16);
    }
    const keyData = new Float32Array(keyFloats);
    let keyAt = 0;
    for (let index = 0; index < channelCount; index++) {
      const bone = view.getUint16(offset, true);
      const kind = view.getUint8(offset + 2) as 0 | 1 | 2;
      const keys = view.getUint32(offset + 4, true);
      offset += 8;
      const times = keyData.subarray(keyAt, keyAt + keys);
      keyAt += keys;
      for (let key = 0; key < keys; key++) {
        times[key] = view.getUint32(offset + key * 4, true) / 1000;
      }
      offset += keys * 4;
      const components = kind === 1 ? 4 : 3;
      const values = keyData.subarray(keyAt, keyAt + keys * components);
      keyAt += keys * components;
      for (let key = 0; key < keys; key++) {
        for (let part = 0; part < components; part++) {
          if (kind === 1) {
            // M2CompQuat: int16 per component, x y z w, mapped back onto [-1, 1].
            const raw = view.getInt16(offset + (key * 4 + part) * 2, true);
            values[key * 4 + part] = (raw < 0 ? raw + 32768 : raw - 32767) / 32767;
          } else {
            values[key * components + part] = view.getFloat32(offset + (key * components + part) * 4, true);
          }
        }
      }
      offset += keys * components * (kind === 1 ? 2 : 4);
      if (bone < boneCount) channels.push({ bone, kind, times, values });
    }
    clips.push({
      animationId,
      duration: duration / 1000,
      ...(blendTimeMs > 0 ? { blendTime: blendTimeMs / 1000 } : {}),
      channels,
    });
  }
  if (offset > data.byteLength) throw new Error("Animation clips run past the end of the block");
  readClipExtras(view, offset, limit, clips);
  return clips;
}

/**
 * Pours the optional extras table onto the clips it belongs to, by position.
 *
 * A zero `movingSpeed` becomes `undefined` deliberately: the sequence table writes a real 0.0 on
 * everything that does not travel — 40 of RidingHorse's 43 sequences — and «the stride was
 * authored for no speed» and «the artifact does not carry a speed» want the same answer from every
 * caller, which is "do not scale this clip". A `variationNext` of −1 is the file's own "nothing
 * follows" and is dropped for the same reason.
 */
function readClipExtras(view: DataView, start: number, limit: number, clips: WvmSkeletonClip[]): void {
  if (start >= limit) return;
  const recordSize = view.getUint16(start + 4, true);
  let offset = start + CLIP_EXTRAS_HEADER_SIZE;
  for (const clip of clips) {
    const movingSpeed = view.getFloat32(offset, true);
    const variationNext = view.getInt16(offset + 4, true);
    const variationIndex = view.getUint16(offset + 6, true);
    if (Number.isFinite(movingSpeed) && movingSpeed !== 0) clip.movingSpeed = movingSpeed;
    if (variationNext >= 0) clip.variationNext = variationNext;
    clip.variationIndex = variationIndex;
    // By the block's own record size, not this build's: a longer record is a later slice's, and
    // stepping over the part we do not understand is the whole point of carrying the width.
    offset += recordSize;
  }
}

/**
 * `readClips` and `readClipExtras` into flat tables. Every key goes through the same expression
 * as there; an optional clip field the object form would omit is NaN here.
 */
function readClipsPacked(view: DataView, start: number, clipCount: number, boneCount: number,
  limit: number): WvaPackedClips {
  // Sizes first. The preflight has already checked every count and byte range walked here.
  let offset = start;
  let channelTotal = 0;
  let keyFloats = 0;
  for (let clip = 0; clip < clipCount; clip++) {
    const channelCount = view.getUint32(offset + 8, true);
    offset += CLIP_HEADER_SIZE;
    for (let index = 0; index < channelCount; index++) {
      const rotation = view.getUint8(offset + 2) === 1;
      const keys = view.getUint32(offset + 4, true);
      if (view.getUint16(offset, true) < boneCount) {
        channelTotal++;
        keyFloats += keys * (rotation ? 5 : 4);
      }
      offset += CHANNEL_HEADER_SIZE + keys * (rotation ? 12 : 16);
    }
  }
  const clipTable = new Float64Array(clipCount * WVA_CLIP_STRIDE);
  const channelTable = new Uint32Array(channelTotal * WVA_CHANNEL_STRIDE);
  const keyData = new Float32Array(keyFloats);
  let span = 0;
  let channelAt = 0;
  let keyAt = 0;
  offset = start;
  for (let clip = 0; clip < clipCount; clip++) {
    const record = clip * WVA_CLIP_STRIDE;
    const blendTimeMs = view.getUint16(offset + 2, true);
    const channelCount = view.getUint32(offset + 8, true);
    clipTable[record + WVA_CLIP_ANIMATION] = view.getUint16(offset, true);
    clipTable[record + WVA_CLIP_DURATION] = view.getUint32(offset + 4, true) / 1000;
    clipTable[record + WVA_CLIP_BLEND_TIME] = blendTimeMs > 0 ? blendTimeMs / 1000 : Number.NaN;
    clipTable[record + WVA_CLIP_MOVING_SPEED] = Number.NaN;
    clipTable[record + WVA_CLIP_VARIATION_INDEX] = Number.NaN;
    clipTable[record + WVA_CLIP_VARIATION_NEXT] = Number.NaN;
    clipTable[record + WVA_CLIP_FIRST_CHANNEL] = channelAt;
    clipTable[record + WVA_CLIP_FIRST_KEY] = keyAt;
    const firstChannel = channelAt;
    offset += CLIP_HEADER_SIZE;
    for (let index = 0; index < channelCount; index++) {
      const bone = view.getUint16(offset, true);
      const kind = view.getUint8(offset + 2);
      const keys = view.getUint32(offset + 4, true);
      offset += CHANNEL_HEADER_SIZE;
      const components = kind === 1 ? 4 : 3;
      const bytes = keys * 4 + keys * components * (kind === 1 ? 2 : 4);
      if (bone >= boneCount) {
        offset += bytes;
        continue;
      }
      channelTable[channelAt * WVA_CHANNEL_STRIDE] = bone | (kind << 16);
      channelTable[channelAt * WVA_CHANNEL_STRIDE + 1] = keys;
      channelAt++;
      if (bone >= span) span = bone + 1;
      for (let key = 0; key < keys; key++) keyData[keyAt + key] = view.getUint32(offset + key * 4, true) / 1000;
      keyAt += keys;
      const values = offset + keys * 4;
      const count = keys * components;
      if (kind === 1) {
        // M2CompQuat: int16 per component, x y z w, mapped back onto [-1, 1].
        for (let at = 0; at < count; at++) {
          const raw = view.getInt16(values + at * 2, true);
          keyData[keyAt + at] = (raw < 0 ? raw + 32768 : raw - 32767) / 32767;
        }
      } else {
        for (let at = 0; at < count; at++) keyData[keyAt + at] = view.getFloat32(values + at * 4, true);
      }
      keyAt += count;
      offset += bytes;
    }
    clipTable[record + WVA_CLIP_CHANNELS] = channelAt - firstChannel;
  }
  if (offset > view.byteLength) throw new Error("Animation clips run past the end of the block");
  if (offset < limit) {
    const recordSize = view.getUint16(offset + 4, true);
    let at = offset + CLIP_EXTRAS_HEADER_SIZE;
    for (let clip = 0; clip < clipCount; clip++, at += recordSize) {
      const record = clip * WVA_CLIP_STRIDE;
      const movingSpeed = view.getFloat32(at, true);
      const variationNext = view.getInt16(at + 4, true);
      if (Number.isFinite(movingSpeed) && movingSpeed !== 0) clipTable[record + WVA_CLIP_MOVING_SPEED] = movingSpeed;
      if (variationNext >= 0) clipTable[record + WVA_CLIP_VARIATION_NEXT] = variationNext;
      clipTable[record + WVA_CLIP_VARIATION_INDEX] = view.getUint16(at + 6, true);
    }
  }
  return { clipTable, channelTable, keys: keyData, span };
}

/**
 * The version of the coordinated character/item texture route.
 *
 * The gateway deliberately marks texture responses immutable for a week. Bumping this value when
 * a visual patch is republished makes a browser leave an old URL behind immediately, while equal
 * paths in the same visual generation still share one download and one GPU texture.
 */
export const TEXTURE_ROUTE_VERSION = "2";

/**
 * Browser-cache generation shared by visual models, animation sidecars and embedded WMO PNGs.
 *
 * Generation 2 is the one-time rollover from the former 24-hour WMO texture response to the
 * revalidated ETag contract. Without a new URL, a response cached before that header change could
 * remain fresh for the rest of its original day even though the gateway itself was already fixed.
 */
export const VISUAL_MODEL_ROUTE_VERSION = "3";

const COORDINATED_VISUAL_TEXTURE_PREFIXES = [
  "character\\", "creature\\", "item\\objectcomponents\\", "item\\texturecomponents\\",
  "textures\\bakednpctextures\\",
] as const;

/** The paths whose bytes arrive together with the coordinated visual M2/DBC overlay. */
export function isCoordinatedVisualTexturePath(path: string): boolean {
  const normalised = path.replaceAll("/", "\\").toLowerCase();
  return COORDINATED_VISUAL_TEXTURE_PREFIXES.some((prefix) => normalised.startsWith(prefix));
}

/** The URL the gateway serves one client texture from. Content is keyed on the path, so every
 * model that uses the same file shares one download and one GPU texture. The bounded version is
 * added only to visual paths because the gateway's seven-day immutable response otherwise keeps
 * an old HD/stock choice alive after the visual pack changes. */
export function textureUrl(baseUrl: string, mpqPath: string): string {
  const path = mpqPath.replaceAll("/", "\\");
  const version = isCoordinatedVisualTexturePath(path) ? `v=${TEXTURE_ROUTE_VERSION}&` : "";
  return `${baseUrl}/texture?${version}path=${encodeURIComponent(path)}`;
}

/** Versioned URL for one visual model or one streamed WMO group. */
export function visualModelUrl(baseUrl: string, mpqPath: string, group?: number): string {
  const path = mpqPath.replaceAll("/", "\\");
  const groupQuery = group === undefined ? "" : `&group=${group}`;
  return `${baseUrl}/visual/model?path=${encodeURIComponent(path)}${groupQuery}&v=${VISUAL_MODEL_ROUTE_VERSION}`;
}

/** Versioned URL for the held-back animation sidecar paired with a visual model. */
export function visualAnimationsUrl(baseUrl: string, mpqPath: string): string {
  const path = mpqPath.replaceAll("/", "\\");
  return `${baseUrl}/visual/animations?path=${encodeURIComponent(path)}&v=${VISUAL_MODEL_ROUTE_VERSION}`;
}

/**
 * Every client-owned texture a model can draw, including its mesh, particle and ribbon paths.
 *
 * Spell effects are admitted as a composite phase, so waiting only for the WVM bytes is not
 * enough: the model can be present while one of its alpha-keyed particle maps is still a
 * transparent three.js placeholder.  Keep this resolver next to the WVM shape so the renderer
 * and the effect builder share the exact same slot rules.  Unused texture-table entries are not
 * fetched; only slots referenced by a mesh batch or an emitter participate in readiness.
 */
export function modelOwnTexturePaths(model: WvmModel): string[] {
  const indices = new Set<number>();
  for (const batch of model.batches) {
    for (const index of batch.textures) if (index >= 0) indices.add(index);
  }
  for (const emitter of model.particleEmitters) {
    if (emitter.texture >= 0) indices.add(emitter.texture);
  }
  for (const ribbon of model.ribbonEmitters) {
    for (const index of ribbon.textures) if (index >= 0) indices.add(index);
  }
  const paths: string[] = [];
  for (const index of indices) {
    const slot = model.textures[index];
    if (!slot || slot.type !== TEXTURE_TYPE_OWN || !slot.path) continue;
    paths.push(slot.path);
  }
  return [...new Set(paths)];
}

/* --- Emitters -------------------------------------------------------------------------------
   The mirror of what `tools/wvm.mjs` wrote. Two shapes, kept apart on purpose: a track is keyed
   on the animation and nests per sequence, a ramp is keyed on one particle's own life and does
   not nest at all. */

function decodeTrack(view: DataView, at: number): { track: WvmTrack; size: number } {
  const interpolation = view.getUint8(at);
  const globalSequence = view.getInt8(at + 1);
  const components = view.getUint8(at + 2);
  const subCount = view.getUint8(at + 3);
  const tracks: WvmTrack["tracks"] = [];
  let offset = at + 4;
  for (let index = 0; index < subCount; index++) {
    const sequence = view.getUint16(offset, true);
    const keys = view.getUint16(offset + 2, true);
    offset += 4;
    const times = new Uint32Array(keys);
    for (let key = 0; key < keys; key++) times[key] = view.getUint32(offset + key * 4, true);
    offset += keys * 4;
    const values = new Float32Array(keys * components);
    for (let value = 0; value < keys * components; value++) values[value] = view.getFloat32(offset + value * 4, true);
    offset += keys * components * 4;
    tracks.push({ sequence, times, values });
  }
  return { track: { interpolation, globalSequence, components, tracks }, size: offset - at };
}

function decodeRamp(view: DataView, at: number): { ramp: WvmRamp; size: number } {
  const components = view.getUint8(at);
  const keys = view.getUint16(at + 2, true);
  const times = new Float32Array(keys);
  for (let key = 0; key < keys; key++) times[key] = view.getFloat32(at + 4 + key * 4, true);
  const valuesAt = at + 4 + keys * 4;
  const values = new Float32Array(keys * components);
  for (let value = 0; value < keys * components; value++) values[value] = view.getFloat32(valuesAt + value * 4, true);
  return { ramp: { components, times, values }, size: 4 + keys * 4 + keys * components * 4 };
}

const PARTICLE_TRACK_NAMES = [
  "emissionSpeed", "speedVariation", "verticalRange", "horizontalRange", "gravity", "lifespan",
  "emissionRate", "emissionAreaLength", "emissionAreaWidth", "zSource", "enabledIn",
] as const;
const PARTICLE_RAMP_NAMES = ["color", "opacity", "scale", "headCell", "tailCell"] as const;

function decodeParticleEmitter(view: DataView, at: number): WvmParticleEmitter {
  const splinePointCount = view.getUint16(at + 38, true);
  let offset = at + 40;
  const float = (): number => {
    const value = view.getFloat32(offset, true);
    offset += 4;
    return value;
  };
  const lifespanVary = float();
  const emissionRateVary = float();
  const scaleVary: [number, number] = [float(), float()];
  const tailLength = float();
  const twinkleSpeed = float();
  const twinklePercent = float();
  const twinkleScaleMin = float();
  const twinkleScaleMax = float();
  const burstMultiplier = float();
  const drag = float();
  const baseSpin = float();
  const baseSpinVary = float();
  const spin = float();
  const spinVary = float();
  const windVector: [number, number, number] = [float(), float(), float()];
  const windTime = float();
  const followSpeed1 = float();
  const followScale1 = float();
  const followSpeed2 = float();
  const followScale2 = float();

  const splinePoints = new Float32Array(splinePointCount * 3);
  for (let value = 0; value < splinePoints.length; value++) splinePoints[value] = view.getFloat32(offset + value * 4, true);
  offset += splinePoints.length * 4;

  const tracks: Record<string, WvmTrack> = {};
  for (const name of PARTICLE_TRACK_NAMES) {
    const decoded = decodeTrack(view, offset);
    tracks[name] = decoded.track;
    offset += decoded.size;
  }
  const ramps: Record<string, WvmRamp> = {};
  for (const name of PARTICLE_RAMP_NAMES) {
    const decoded = decodeRamp(view, offset);
    ramps[name] = decoded.ramp;
    offset += decoded.size;
  }

  return {
    id: view.getInt32(at + 2, true),
    flags: view.getUint32(at + 6, true),
    position: [view.getFloat32(at + 10, true), view.getFloat32(at + 14, true), view.getFloat32(at + 18, true)],
    bone: view.getUint16(at + 22, true),
    texture: view.getUint16(at + 24, true),
    blendType: view.getUint8(at + 26),
    emitterType: view.getUint8(at + 27),
    particleType: view.getUint8(at + 28),
    headTail: view.getUint8(at + 29),
    particleColorIndex: view.getUint16(at + 30, true),
    textureTileRotation: view.getInt16(at + 32, true),
    textureRows: view.getUint16(at + 34, true),
    textureColumns: view.getUint16(at + 36, true),
    lifespanVary, emissionRateVary, scaleVary, tailLength,
    twinkleSpeed, twinklePercent, twinkleScaleMin, twinkleScaleMax,
    burstMultiplier, drag, baseSpin, baseSpinVary, spin, spinVary,
    windVector, windTime, followSpeed1, followScale1, followSpeed2, followScale2,
    splinePoints,
    emissionSpeed: tracks["emissionSpeed"]!, speedVariation: tracks["speedVariation"]!,
    verticalRange: tracks["verticalRange"]!, horizontalRange: tracks["horizontalRange"]!,
    gravity: tracks["gravity"]!, lifespan: tracks["lifespan"]!, emissionRate: tracks["emissionRate"]!,
    emissionAreaLength: tracks["emissionAreaLength"]!, emissionAreaWidth: tracks["emissionAreaWidth"]!,
    zSource: tracks["zSource"]!, enabledIn: tracks["enabledIn"]!,
    color: ramps["color"]!, opacity: ramps["opacity"]!, scale: ramps["scale"]!,
    headCell: ramps["headCell"]!, tailCell: ramps["tailCell"]!,
  };
}

const RIBBON_TRACK_NAMES = ["color", "alpha", "heightAbove", "heightBelow", "textureSlot", "visibility"] as const;

function decodeRibbonEmitter(view: DataView, at: number): WvmRibbonEmitter {
  const textureCount = view.getUint8(at + 22);
  const materialCount = view.getUint8(at + 23);
  let offset = at + 44;
  const textures = new Uint16Array(textureCount);
  for (let index = 0; index < textureCount; index++) textures[index] = view.getUint16(offset + index * 2, true);
  offset += textureCount * 2;
  const materials: WvmRibbonMaterial[] = [];
  for (let index = 0; index < materialCount; index++) {
    materials.push({ blendMode: view.getUint8(offset + index * 2), flags: view.getUint8(offset + index * 2 + 1) });
  }
  offset += materialCount * 2;

  const tracks: Record<string, WvmTrack> = {};
  for (const name of RIBBON_TRACK_NAMES) {
    const decoded = decodeTrack(view, offset);
    tracks[name] = decoded.track;
    offset += decoded.size;
  }

  return {
    id: view.getInt32(at + 2, true),
    bone: view.getUint32(at + 6, true),
    position: [view.getFloat32(at + 10, true), view.getFloat32(at + 14, true), view.getFloat32(at + 18, true)],
    textures, materials,
    edgesPerSecond: view.getFloat32(at + 24, true),
    edgeLifetime: view.getFloat32(at + 28, true),
    gravity: view.getFloat32(at + 32, true),
    textureRows: view.getUint16(at + 36, true),
    textureColumns: view.getUint16(at + 38, true),
    priorityPlane: view.getInt16(at + 40, true),
    ribbonColorIndex: view.getInt8(at + 42),
    textureTransformLookupIndex: view.getInt8(at + 43),
    color: tracks["color"]!, alpha: tracks["alpha"]!,
    heightAbove: tracks["heightAbove"]!, heightBelow: tracks["heightBelow"]!,
    textureSlot: tracks["textureSlot"]!, visibility: tracks["visibility"]!,
  };
}
