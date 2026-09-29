import type { WvmSkeletonClip } from "./Wvm.js";

export interface WvaAnimationResidencyCost {
  readonly typedBackingBytes: number;
  readonly numericArrayElements: number;
}

export interface WvaAnimationDecodeResult {
  readonly clips: WvmSkeletonClip[];
  readonly cost: Readonly<WvaAnimationResidencyCost>;
}

/** The packed layout lives beside the decoder that writes it; see `decodeWvaAnimationsPacked`. */
export {
  WVA_CHANNEL_STRIDE, WVA_CLIP_ANIMATION, WVA_CLIP_BLEND_TIME, WVA_CLIP_CHANNELS, WVA_CLIP_DURATION,
  WVA_CLIP_FIRST_CHANNEL, WVA_CLIP_FIRST_KEY, WVA_CLIP_MOVING_SPEED, WVA_CLIP_STRIDE,
  WVA_CLIP_VARIATION_INDEX, WVA_CLIP_VARIATION_NEXT,
} from "./Wvm.js";

/**
 * One decoded WVA block as the worker posts it: three flat typed arrays and numbers only.
 *
 * Posting the decoded object graph instead made the browser thread deserialize every clip, channel
 * and key view in one task (HumanMale: 182 clips, ~38k channels, ~76k views, tens of ms). These
 * three buffers are transferred, so the message clones in microseconds; `unpackWvaAnimations`
 * builds each clip's channel list on first read.
 */
export interface WvaPackedAnimations {
  readonly clipTable: Float64Array;
  readonly channelTable: Uint32Array;
  /** Each channel's times then its values, channel after channel, clip after clip. */
  readonly keys: Float32Array;
  /** One past the highest bone any channel poses: what a full channel walk would find. */
  readonly span: number;
  /** Content identity of the WVA bytes, for sharing byte-identical sidecars. */
  readonly digest: string;
  /** `keys` is the only backing a fully materialised clip set retains. */
  readonly cost: Readonly<WvaAnimationResidencyCost>;
}

export interface WvaAnimationDecodeRequest {
  readonly id: number;
  readonly data: ArrayBuffer;
  readonly bones: number;
  /** Digests of blocks the caller holds for this rig; bytes with one of these are not decoded. */
  readonly known?: readonly string[];
}

export type WvaAnimationDecodeResponse =
  | { readonly id: number; readonly packed: WvaPackedAnimations }
  | { readonly id: number; readonly duplicate: string }
  | { readonly id: number; readonly error: string };
