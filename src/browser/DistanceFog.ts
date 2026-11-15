import { HORIZON_RANGE } from "./Horizon.js";
import { lightingClassicLook } from "./LightingQuality.js";
import { TERRAIN_GRID_SIZE } from "./Terrain.js";

/**
 * 22.10 (7.39): the far view of the enhanced path — aerial perspective instead of a fog wall.
 *
 * Light.dbc closes the outdoor fog at 444–500 yards in Westfall and Elwynn (fog start 0 and 125),
 * measured in the bench at noon. Everything past that is pure fog colour, so the WDL horizon and
 * the far tier of buildings were being drawn and then painted over. Here the authored fog keeps
 * its colour and the aerial leaf's height and sun terms, and is stretched: its start by
 * {@link DISTANCE_FOG_NEAR_SCALE}, its end by {@link DISTANCE_FOG_FAR_SCALE}, never past
 * {@link DISTANCE_FOG_REACH}. The wider gap is the aerial perspective: haze builds slowly over
 * a long band instead of closing in a short one, so a ridge two kilometres out is a pale shape
 * rather than nothing. The fog still closes before the horizon mesh runs out, so the ground never
 * ends against the sky with a hard edge.
 *
 * The faithful levels (lightingClassicLook) keep the client's own fog and four-tile horizon
 * untouched, and so does water: the underwater fog is the client's murk, not distance.
 */

/** How many times further the haze starts on the enhanced path. */
export const DISTANCE_FOG_NEAR_SCALE = 3;
/** How many times further the fog closes on the enhanced path. */
export const DISTANCE_FOG_FAR_SCALE = 5;
/**
 * The enhanced path's horizon: six tiles past the centre tile instead of four. 160 WDL tiles,
 * about 164,000 triangles in one draw, rebuilt only when the player crosses a tile.
 */
export const DISTANCE_HORIZON_RANGE = 6 * TERRAIN_GRID_SIZE;
/**
 * The furthest the stretched fog may close: nine tenths of the horizon's guaranteed reach. The
 * horizon spans {@link DISTANCE_HORIZON_RANGE} past the centre tile, so its nearest outer edge is
 * at least that far from the player; the last tenth is the margin that hides it.
 */
export const DISTANCE_FOG_REACH = Math.round(DISTANCE_HORIZON_RANGE * 0.9);

export interface DistanceFogRange {
  near: number;
  far: number;
}

/** The horizon's range for this lighting level: the client's four tiles on the faithful levels. */
export function distanceHorizonRange(lightingQuality: number): number {
  return lightingClassicLook(lightingQuality) ? HORIZON_RANGE : DISTANCE_HORIZON_RANGE;
}

/**
 * The fog range a frame draws with. `veil` (0..1) is the rain veil of the frame before: the
 * stretch gives way to it, so a downpour still closes the distance the way the client's does.
 * Writes into `out` and returns it; allocation-free for the per-frame restore.
 */
export function distanceFogRange(
  near: number, far: number, lightingQuality: number, underwater: boolean, veil: number,
  out: DistanceFogRange = { near: 0, far: 0 },
): DistanceFogRange {
  out.near = near;
  out.far = far;
  if (lightingClassicLook(lightingQuality) || underwater) return out;
  if (!Number.isFinite(near) || !Number.isFinite(far) || far <= 0 || far >= DISTANCE_FOG_REACH) return out;
  const clear = 1 - Math.max(0, Math.min(1, Number.isFinite(veil) ? veil : 0));
  const farScale = 1 + (DISTANCE_FOG_FAR_SCALE - 1) * clear;
  const nearScale = 1 + (DISTANCE_FOG_NEAR_SCALE - 1) * clear;
  out.far = Math.min(DISTANCE_FOG_REACH, far * farScale);
  // The start keeps its own scale but never passes half the new end: a zone whose authored start
  // is already deep (a fogScale near 1) still gets a band of haze, not a wall at the end.
  out.near = Math.min(Math.max(0, near) * nearScale, out.far * 0.5);
  return out;
}

/*
 * 15.11 (7.66): the shaped fog of maps from 530 up.
 *
 * Wow.exe sets fog mode 1 (0x00d38acc, 0x007ecc90) in 0x007816f0 when the map id (`DAT_00adfbc4`, written by the WDT
 * load 0x007bfce0) is 0x212 = 530 or more and the device's vertex-shader profile (device +0x214 +0xb4, the index into
 * "none", "vs_1_1", "vs_2_0"… at 0x00ad8834, 0x0068a9a0) is neither none nor vs_1_1 — every card WebClient runs on.
 * In that mode 0x007ecd80 (zone) and 0x007ed1b0 (WMO room) move the fog's end to the far clip and hand the shader a
 * density, and the vertex shader draws fog = clamp(pow(max(c30.x·d + c30.y, 0), c30.z)), the linear visibility raised
 * to it. Mode 0 sends 1: linear. Stand frames (WowOracle `runs/fog6-*`, VS c30): Northrend (Borean Tundra, Dragonblight,
 * Storm Peaks, Icecrown, Dalaran outside and in three rooms), Outland (Hellfire, Nagrand, Netherstorm, Zangarmarsh),
 * Hellfire Ramparts and Black Temple all end at 1277 with the density these functions compute to four places; the
 * Black Morass (269, a TBC instance under 530) is linear, as are Stormwind, the Stockade and Onyxia's Lair.
 */

/** The original's far clip at its longest view distance (VideoOptionsPanels.lua `OPTIONS_FARCLIP_MAX`; 177 is the least). */
export const WOW_FAR_CLIP = 1277;
/** 0x007ecd80: a zone fog ending this near (1000/36 yards, 0x00a41b20) is not shaped. */
const SHAPED_FOG_MIN_END = 1000 / 36;

/** Whether Wow.exe draws this map's fog shaped (0x007816f0: map id ≥ 0x212). */
export function shapedFogMap(map: number | undefined): boolean {
  return map !== undefined && map >= 530;
}

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

export interface ShapedFog {
  near: number;
  far: number;
  /** The exponent of the linear visibility; 1 is linear. */
  density: number;
}

/**
 * 0x007ecd80 then 0x007f16f0: the zone's fog of a shaped map from its Light end and start share. The density is taken
 * from the authored start and end, the end then becomes the far clip and the start the far clip × the share, never
 * below 0. Netherstorm 666.7 × 0.5 → 638.5 to 1277, 3.333; Nagrand 1527.8 × 0.8 → 1021.6, 3.639; Black Temple 388.9 × 0
 * → 0, 2.722 (`fog6-o-netherstorm`, `fog6-o-nagrand`, `fog6-bt-air-out`).
 */
export function shapedZoneFog(end: number, share: number, farClip: number, out: ShapedFog): ShapedFog {
  if (!(end > SHAPED_FOG_MIN_END)) {
    out.near = end * share;
    out.far = end;
    out.density = 1;
    return out;
  }
  out.density = shapedFogDensity(share * end, end, farClip);
  out.far = farClip;
  out.near = farClip * Math.max(0, share);
  return out;
}

/**
 * The end WebClient draws a shaped fog to. The original's is its far clip, out to which it draws the world; here the
 * ground is drawn to the WDL horizon, at least four tiles (2,133 yards) from the player, and where a map has no WDL
 * only to the near ring, at least one tile (533 yards). The fog closes a tenth inside that, never past the far clip,
 * so it never uncovers the edge of the loaded ground.
 */
export function shapedFogEnd(horizonDrawn: boolean): number {
  return Math.min(WOW_FAR_CLIP, Math.floor((horizonDrawn ? HORIZON_RANGE : TERRAIN_GRID_SIZE) * 0.9));
}

/**
 * The fog's far distance as the shaders read a shaped fog: negative, the end in whole yards and the density in its
 * fraction (density / 16, below 16). Three's fog uniforms carry two numbers per material and no third, and a negative
 * end is never a linear fog, so the linear path (`fogFar` ≥ 0) is the stock one unchanged.
 */
export function encodeShapedFogFar(far: number, density: number): number {
  const d = Math.min(15.99, Math.max(0.0625, density));
  return -(Math.max(1, Math.round(far)) + d / 16);
}

// The shader side (the chunk patch and its GLSL) lives in ShapedFogChunk.ts, which installs itself on import.
export { SHAPED_FOG_GLSL, installShapedFogChunks } from "./ShapedFogChunk.js";
