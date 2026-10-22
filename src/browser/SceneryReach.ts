import { lightingClassicLook } from "./LightingQuality.js";
import { ENVIRONMENT_FAR_RANGE, ENVIRONMENT_RESIDENT_HYSTERESIS, ENVIRONMENT_SHELL_RANGE } from "./Terrain.js";

/**
 * 22.10 (7.39): the far view's setting step for trees and other loose scenery.
 *
 * The stock «Детализация ландшафта» slider stops at 1.5, where the biggest trees reach the
 * 750-yard far tier. Past it (175 % and 200 % in the settings) the M2 leash keeps scaling and the
 * cap scales with it: 875 and 1,000 yards. It is a step rather than the default because it costs
 * measurably (the 1,100-yard trial for every model: +0.7 ms CPU in the city, +70 draws while
 * moving); the 1.5 default draws exactly what it did.
 */
export const ENVIRONMENT_DETAIL_STOCK_MAX = 1.5;
/** The furthest the setting reaches: 200 %. */
export const ENVIRONMENT_DETAIL_FAR_MAX = 2;

/** The cap on a loose M2's leash at this (already clamped) detail. */
export function sceneryFarCap(detail: number): number {
  return ENVIRONMENT_FAR_RANGE * Math.max(1, detail / ENVIRONMENT_DETAIL_STOCK_MAX);
}

/**
 * 22.10 (7.39): the big outdoor shells' leash. 1,100 yards while the enhanced fog stretch shows
 * them (DistanceFog.ts); the faithful levels (0 and the comparison level) keep 750, where their
 * 500-yard fog has already closed — drawing past it cost +0.3 ms in the city for nothing seen.
 */
export function environmentShellRange(lightingQuality: number): number {
  return lightingClassicLook(lightingQuality) ? ENVIRONMENT_FAR_RANGE : ENVIRONMENT_SHELL_RANGE;
}

/**
 * 22.10 (7.39): how far around the player placements are streamed and ranked: the longest leash
 * in force (the shells', the far tier's, or the step's scenery cap) plus the resident band. The
 * faithful levels at the stock detail get `ENVIRONMENT_STREAM_RANGE` exactly.
 */
export function environmentStreamRange(shellRange: number, detail: number): number {
  return Math.max(ENVIRONMENT_FAR_RANGE, shellRange, sceneryFarCap(detail)) + ENVIRONMENT_RESIDENT_HYSTERESIS;
}

/**
 * 22.10 (7.44): the enhanced path's leash for small outdoor WMOs — the houses, barns, mills and
 * towers whose wire box is under the 120-yard far-tier diagonal. Their outdoor shell groups were
 * held at 250 yards and the placement at 400, which the faithful levels' 500-yard fog hid; under the
 * enhanced fog (7.39) Goldshire's houses vanished a quarter mile out. Only the shell groups (the
 * `exterior || !indoor` ones) take it: rooms stay at 60 yards and doodads keep their own leashes.
 */
export const ENVIRONMENT_HOUSE_RANGE = 1100;

/** The house leash in force for this shell range: 0 (no change) on the faithful levels. */
export function environmentHouseRange(shellRange: number): number {
  return shellRange > ENVIRONMENT_FAR_RANGE ? Math.min(shellRange, ENVIRONMENT_HOUSE_RANGE) : 0;
}

/**
 * 22.10 (7.44): loose M2s at least this big (source radius × scale, in yards) that are not
 * vegetation — big rocks, ruins, statues, windmill sails — keep their size-scaled leash past the
 * scenery cap on the enhanced path, up to the shell range. Smaller ones are still capped as before.
 */
export const SCENERY_LANDMARK_MIN_RADIUS = 10;

/** The cap on a loose non-vegetation M2 of this size: the shell range for a landmark on the enhanced path. */
export function sceneryLandmarkCap(radius: number, detail: number, shellRange: number): number {
  const cap = sceneryFarCap(detail);
  return shellRange > ENVIRONMENT_FAR_RANGE && radius >= SCENERY_LANDMARK_MIN_RADIUS ? Math.max(cap, shellRange) : cap;
}
