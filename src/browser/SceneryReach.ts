import { WOW_FAR_CLIP } from "./DistanceFog.js";
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
export function environmentShellRange(lightingQuality: number, reach = ENVIRONMENT_FAR_RANGE): number {
  // 15.11 (7.66 tail): the faithful levels take `faithfulReach` — the far clip where the fog reaches it.
  return lightingClassicLook(lightingQuality) ? reach : ENVIRONMENT_SHELL_RANGE;
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

/**
 * The house leash in force for this shell range: 0 (no change) on the faithful levels at their 750-yard floor.
 * 15.11 (7.66 tail): with `faithful`, the faithful reach itself — Wow.exe has no house leash, every map object is
 * held to the far clip (`faithfulReach`).
 */
export function environmentHouseRange(shellRange: number, faithful = false): number {
  if (faithful) return shellRange > ENVIRONMENT_FAR_RANGE ? shellRange : 0;
  return shellRange > ENVIRONMENT_FAR_RANGE ? Math.min(shellRange, ENVIRONMENT_HOUSE_RANGE) : 0;
}

/**
 * 15.11 (7.66 tail): how far the faithful levels draw the world's objects — Wow.exe's far clip, where the fog
 * has not closed before it.
 *
 * - Map objects: 0x00780860 boxes the camera ±far clip and 0x007b6110 keeps every placement whose box meets that
 *   box (then the frustum), whatever its size. The Netherstorm stand frame drew 14-yard wall pieces at 1,321 yards and
 *   the manaforges at 750–1,100.
 * - Doodads: each by its size class (DoodadReach.ts), none past 1,250 yards.
 * - Wow.exe draws to the far clip whatever the fog. A fogged object draws as the fog colour, so the reach stops where
 *   the frame's fog (`fogFar`) has closed — and the fog closes on view depth, so at the corner of the screen an object
 *   `FAITHFUL_FOG_EDGE` times the fog end away is still short of it. The reach never comes under the 750 yards these
 *   levels drew before. On maps from 530 up the fog ends at the far clip (7.66), so there it is the far clip; the
 *   stand ran at the slider's maximum, 1277, and that is the far clip taken here (DistanceFog.ts `WOW_FAR_CLIP`).
 * - Stepped by 50 yards, so a fog fading between two lights does not re-rank the placements every frame.
 */
export const FAITHFUL_REACH_STEP = 50;
/**
 * Distance over view depth at the screen's corner: the stand's frustum (K line: 90°, 16:9; VS c2.x 1.104, c3.y 1.963)
 * reaches 46° off the view axis there, 1/cos 46° = 1.44.
 */
export const FAITHFUL_FOG_EDGE = 1.45;
export function faithfulReach(fogFar: number, farClip = WOW_FAR_CLIP): number {
  const far = Number.isFinite(fogFar) && fogFar > 0
    ? Math.ceil(fogFar * FAITHFUL_FOG_EDGE / FAITHFUL_REACH_STEP) * FAITHFUL_REACH_STEP : 0;
  return Math.min(farClip, Math.max(ENVIRONMENT_FAR_RANGE, far));
}

/*
 * 22.10 (7.44): a landmark step — non-vegetation M2s of radius 10+ keeping their size-scaled leash
 * past the 750-yard cap up to the shell range — was measured and left out: +30 draws and +0.3 ms
 * CPU in the city bench (Stormwind harbour's dock pylons and cranes), against 26 cliff rocks
 * around Goldshire. The minimap detail (HorizonDetail.ts) already shows those rocks past 750.
 */
