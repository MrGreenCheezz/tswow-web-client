/*
 * 15.11 (fx11, 7.66/7.67): one Light set's fog as Wow.exe converts it for a shaped map, before any blend.
 *
 * In fog mode 1 (maps from 530 up, DistanceFog.ts) 0x007ecd80 runs on every set it samples: a set whose end passes
 * 1000/36 yards gets the density of its own start and end (0x007ecd00) and the far clip as its end, and every set's
 * start share is clamped at 0. Only then does 0x007ed4c0 lerp the sets: end (+0x48), share (+0x4c) and density (+0x50)
 * alike. Clamping the blended share instead loses a positive share that a negative one dilutes: at the Borean Tundra |
 * Dragonblight border (WowOracle light11-nc-m25 / nc-0 / nc-p25) Wow.exe starts the fog at 74.2 / 33.7 / 8.8 yards,
 * and the density lerps between the sets (light11-nd-*: 3.639 → 3.007 / 2.474 / 1.939 → 1.5 across Crystalsong |
 * Dragonblight).
 */
import type { LightSample } from "./LightTypes.js";

/** The original's far clip at its longest view distance (VideoOptionsPanels.lua `OPTIONS_FARCLIP_MAX`; 177 is the least). */
export const WOW_FAR_CLIP = 1277;
/** 0x007ecd80: a zone fog ending this near (1000/36 yards, 0x00a41b20) is not shaped. */
export const SHAPED_FOG_MIN_END = 1000 / 36;

/**
 * 0x007ecd00: the density from a fog's own start and end. Over a gap of at most min(700, far clip) − 200 yards it
 * rises linearly to 7 for a gap of nothing; past that it is 1.5 (0x00a41b1c 700, 0x00a40538 200, 0x009edc60 5.5,
 * 0x00a41b18 1.5).
 */
export function shapedFogDensity(start: number, end: number, farClip = WOW_FAR_CLIP): number {
  const span = Math.min(700, farClip) - 200;
  const gap = end - start;
  return gap <= span ? (1 - gap / span) * 5.5 + 1.5 : 1.5;
}

/** A set's fog after 0x007ecd80 in mode 1: the values 0x007ed4c0 then blends. */
export interface ShapedFogSet {
  end: number;
  /** The start as a share of the end, never below 0. */
  share: number;
  /** The exponent of the linear visibility; 1 is linear. */
  density: number;
}

/**
 * A light sample's shaped fog: its blended shaped fields, or for a sample that carries none (one built outside
 * LightClient's sampling) its plain fog converted as one set.
 */
export function shapedFogOf(sample: LightSample, out: ShapedFogSet = { end: 0, share: 0, density: 1 }): ShapedFogSet {
  if (sample.shapedFogEnd !== undefined && sample.shapedFogShare !== undefined && sample.shapedFogDensity !== undefined) {
    out.end = sample.shapedFogEnd;
    out.share = sample.shapedFogShare;
    out.density = sample.shapedFogDensity;
    return out;
  }
  return shapedFogSet(sample.fogEnd, sample.fogEnd > 0 ? sample.fogStart / sample.fogEnd : 0, WOW_FAR_CLIP, out);
}

/** 0x007ecd80, mode 1, on one set's end and start share. Writes into `out` and returns it. */
export function shapedFogSet(end: number, share: number, farClip: number, out: ShapedFogSet): ShapedFogSet {
  if (end > SHAPED_FOG_MIN_END) {
    out.density = shapedFogDensity(share * end, end, farClip);
    out.end = farClip;
  } else {
    out.density = 1;
    out.end = end;
  }
  out.share = Math.max(0, share);
  return out;
}
