import { ENVIRONMENT_FAR_RANGE } from "./Terrain.js";

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
