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
