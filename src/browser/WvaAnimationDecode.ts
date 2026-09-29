import {
  WVA_CHANNEL_STRIDE, WVA_CLIP_ANIMATION, WVA_CLIP_BLEND_TIME, WVA_CLIP_CHANNELS, WVA_CLIP_DURATION,
  WVA_CLIP_FIRST_CHANNEL, WVA_CLIP_FIRST_KEY, WVA_CLIP_MOVING_SPEED, WVA_CLIP_STRIDE,
  WVA_CLIP_VARIATION_INDEX, WVA_CLIP_VARIATION_NEXT, decodeWvaAnimationsPacked, type WvmSkeletonClip,
} from "./Wvm.js";
import type {
  WvaAnimationDecodeRequest, WvaAnimationDecodeResponse, WvaAnimationResidencyCost, WvaPackedAnimations,
} from "./WvaAnimationDecodeProtocol.js";

/**
 * WVA channels retain key times and values; shared backings are counted exactly once.
 *
 * A clip set built by `unpackWvaAnimations` answers from the number its worker measured, without
 * building a single clip: every one of its views lands on the one `keys` backing that number is.
 */
export function decodedAnimationResidencyCost(clips: readonly WvmSkeletonClip[]): Readonly<WvaAnimationResidencyCost> {
  const packed = packedClipSet(clips);
  if (packed) return packed.cost;
  const backings = new Set<ArrayBufferLike>();
  let typedBackingBytes = 0;
  for (const clip of clips) {
    for (const channel of clip.channels) {
      const times = channel.times.buffer;
      const values = channel.values.buffer;
      if (!backings.has(times)) {
        backings.add(times);
        typedBackingBytes += times.byteLength;
      }
      if (!backings.has(values)) {
        backings.add(values);
        typedBackingBytes += values.byteLength;
      }
    }
  }
  return Object.freeze({ typedBackingBytes, numericArrayElements: 0 });
}

/** The same decoder/preflight in a worker or in a Node caller; errors never ask for a main-thread retry. */
export function decodeWvaAnimationRequest(request: WvaAnimationDecodeRequest): {
  response: WvaAnimationDecodeResponse;
  transfer: ArrayBuffer[];
} {
  try {
    const digest = wvaContentDigest(request.data);
    // The caller already holds these exact bytes decoded for this rig: the decode is the answer
    // it has, so it is not repeated. Only digests of blocks that decoded for `bones` are sent.
    if (request.known?.includes(digest)) return { response: { id: request.id, duplicate: digest }, transfer: [] };
    const { clipTable, channelTable, keys, span } = decodeWvaAnimationsPacked(request.data, request.bones);
    const packed: WvaPackedAnimations = {
      clipTable, channelTable, keys, span, digest,
      cost: Object.freeze({ typedBackingBytes: keys.byteLength, numericArrayElements: 0 }),
    };
    return { response: { id: request.id, packed }, transfer: [clipTable.buffer, channelTable.buffer, keys.buffer] };
  } catch (error) {
    return {
      response: { id: request.id, error: error instanceof Error ? error.message : String(error) },
      transfer: [],
    };
  }
}

/**
 * Content identity of one WVA block: its length and two independent 32-bit lanes over its words.
 *
 * Not cryptographic, and it does not have to be: the bytes are the gateway's own artifacts, and two
 * different blocks would have to agree in length and in both lanes (64 bits) to be taken for one
 * another. It is computed where the block is decoded, off the browser thread.
 */
export function wvaContentDigest(data: ArrayBuffer): string {
  const length = data.byteLength;
  const wordCount = length >>> 2;
  const words = new Uint32Array(data, 0, wordCount);
  // Lane a is MurmurHash3's x86_32 body; lane b is xxHash32's round. Different operations and
  // constants, so one lane's collisions are not the other's.
  let a = 0x2f5a91c3 ^ length;
  let b = (0x165667b1 + length) | 0;
  for (let index = 0; index < wordCount; index++) {
    const word = words[index]!;
    let k = Math.imul(word, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    a ^= Math.imul(k, 0x1b873593);
    a = (a << 13) | (a >>> 19);
    a = (Math.imul(a, 5) + 0xe6546b64) | 0;
    b = (b + Math.imul(word, 0x85ebca77)) | 0;
    b = (b << 13) | (b >>> 19);
    b = Math.imul(b, 0x9e3779b1);
  }
  const tail = new Uint8Array(data, wordCount * 4);
  for (let index = 0; index < tail.length; index++) {
    const byte = tail[index]!;
    a = Math.imul(a ^ byte, 0x01000193);
    b = Math.imul((b + byte) | 0, 0x27d4eb2f);
  }
  return `${length.toString(36)}.${hex32(fmix32(a ^ length))}${hex32(fmix32(b ^ Math.imul(length, 0x9e3779b1)))}`;
}

function fmix32(value: number): number {
  let h = value;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function hex32(value: number): string {
  return value.toString(16).padStart(8, "0");
}

interface PackedClipSource {
  readonly clipTable: Float64Array;
  readonly channelTable: Uint32Array;
  readonly keys: Float32Array;
}

interface PackedClipSet {
  readonly clipCount: number;
  readonly span: number;
  readonly cost: Readonly<WvaAnimationResidencyCost>;
  readonly keys: Float32Array;
}

/** A clip whose channel list is not built yet, and the record it will be built from. */
const lazyClips = new WeakMap<object, { readonly source: PackedClipSource; readonly at: number }>();
const packedClipSets = new WeakMap<readonly WvmSkeletonClip[], PackedClipSet>();
const consumedClipSets = new WeakSet<readonly WvmSkeletonClip[]>();

const CHANNELS_ACCESSOR = {
  get(this: WvmSkeletonClip): WvmSkeletonClip["channels"] {
    return materializeChannels(this);
  },
  set(this: WvmSkeletonClip, channels: WvmSkeletonClip["channels"]): void {
    lazyClips.delete(this);
    Object.defineProperty(this, "channels", { value: channels, writable: true, enumerable: true, configurable: true });
  },
  enumerable: true,
  configurable: true,
} as const;

/**
 * The browser-thread half of the worker protocol: plain clip objects, each channel list built on
 * first read.
 *
 * Arrival therefore costs one small object per clip and touches no channel. Every clip is an
 * ordinary object with the decoder's own fields in the decoder's own order; its `channels` is an
 * own enumerable accessor that, on first read, builds exactly the list `decodeWvaAnimations` would
 * have (the same `{ bone, kind, times, values }` records, Float32Array views over one shared
 * backing) and replaces itself with it as a plain data property. Compilation reads a clip's
 * channels when it compiles that clip, which `mergeSkinnedClips` already slices across frames.
 */
export function unpackWvaAnimations(packed: WvaPackedAnimations): WvmSkeletonClip[] {
  const { clipTable } = packed;
  const source: PackedClipSource = { clipTable, channelTable: packed.channelTable, keys: packed.keys };
  const clips: WvmSkeletonClip[] = [];
  for (let at = 0; at + WVA_CLIP_STRIDE <= clipTable.length; at += WVA_CLIP_STRIDE) {
    const animationId = clipTable[at + WVA_CLIP_ANIMATION]!;
    const duration = clipTable[at + WVA_CLIP_DURATION]!;
    const blendTime = clipTable[at + WVA_CLIP_BLEND_TIME]!;
    // The decoder's literal order: animationId, duration, blendTime when authored, channels, then
    // the extras table's movingSpeed, variationNext and variationIndex.
    const clip = (Number.isNaN(blendTime)
      ? { animationId, duration }
      : { animationId, duration, blendTime }) as WvmSkeletonClip;
    Object.defineProperty(clip, "channels", CHANNELS_ACCESSOR);
    const movingSpeed = clipTable[at + WVA_CLIP_MOVING_SPEED]!;
    if (!Number.isNaN(movingSpeed)) clip.movingSpeed = movingSpeed;
    const variationNext = clipTable[at + WVA_CLIP_VARIATION_NEXT]!;
    if (!Number.isNaN(variationNext)) clip.variationNext = variationNext;
    const variationIndex = clipTable[at + WVA_CLIP_VARIATION_INDEX]!;
    if (!Number.isNaN(variationIndex)) clip.variationIndex = variationIndex;
    lazyClips.set(clip, { source, at });
    clips.push(clip);
  }
  // Structured clone does not carry `Object.freeze`; the received object is this set's own.
  const cost = Object.freeze(packed.cost);
  packedClipSets.set(clips, { clipCount: clips.length, span: packed.span, cost, keys: packed.keys });
  return clips;
}

function materializeChannels(clip: WvmSkeletonClip): WvmSkeletonClip["channels"] {
  const lazy = lazyClips.get(clip);
  if (!lazy) throw new TypeError("WVA clip channels were read through an object that does not own them");
  lazyClips.delete(clip);
  const { clipTable, channelTable, keys } = lazy.source;
  const first = clipTable[lazy.at + WVA_CLIP_FIRST_CHANNEL]!;
  const end = first + clipTable[lazy.at + WVA_CLIP_CHANNELS]!;
  let keyAt = clipTable[lazy.at + WVA_CLIP_FIRST_KEY]!;
  const channels: WvmSkeletonClip["channels"] = [];
  for (let channel = first; channel < end; channel++) {
    const word = channelTable[channel * WVA_CHANNEL_STRIDE]!;
    const count = channelTable[channel * WVA_CHANNEL_STRIDE + 1]!;
    const kind = (word >>> 16) as 0 | 1 | 2;
    const times = keys.subarray(keyAt, keyAt + count);
    keyAt += count;
    const valueCount = count * (kind === 1 ? 4 : 3);
    const values = keys.subarray(keyAt, keyAt + valueCount);
    keyAt += valueCount;
    channels.push({ bone: word & 0xffff, kind, times, values });
  }
  Object.defineProperty(clip, "channels", { value: channels, writable: true, enumerable: true, configurable: true });
  return channels;
}

function packedClipSet(clips: readonly WvmSkeletonClip[]): PackedClipSet | undefined {
  const packed = packedClipSets.get(clips);
  // A caller that grew or shrank the array has made it a different set.
  return packed?.clipCount === clips.length ? packed : undefined;
}

/** One past the highest bone the set poses, already known for a worker-decoded set. */
export function wvaClipSetSpan(clips: readonly WvmSkeletonClip[]): number | undefined {
  return packedClipSet(clips)?.span;
}

/** The single key backing of a worker-decoded set, for accounting that must not build its clips. */
export function wvaClipSetBacking(clips: readonly WvmSkeletonClip[]): Float32Array | undefined {
  return packedClipSet(clips)?.keys;
}

/**
 * Records that a skinned template compiled from this set and holds it for as long as it lives.
 *
 * The environment cache keeps a weak handle on such a set when it evicts it, so the next
 * appearance of that model gets the very same clip objects back — and with them every compiled
 * clip — instead of downloading, decoding and compiling the whole block again.
 */
export function markWvaClipSetConsumed(clips: readonly WvmSkeletonClip[]): void {
  consumedClipSets.add(clips);
}

export function wvaClipSetConsumed(clips: readonly WvmSkeletonClip[]): boolean {
  return consumedClipSets.has(clips);
}
