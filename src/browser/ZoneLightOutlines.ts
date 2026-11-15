// 15.11 (light7): how strongly each of Wow.exe's zone outlines lights a point.
//
// Northrend's zone lights (Borean Tundra, Dragonblight, Storm Peaks, Icecrown and seven more) are Light.dbc rows with
// radii of 5 to 23 yards; Wow.exe reaches them through eleven outlines of its own instead (the gateway reads them from
// the user's Wow.exe: `src/gateway/ZoneLightOutlines.ts`). Measured on the stand (WowOracle `fog6-n-*`, 15.11): the
// terrain's ambient and diffuse and the fog colour at Borean, Dragonblight, Storm Peaks and Icecrown are those
// outlines' lights to the byte, where the radius lookup alone gave Northrend's default at all four.
//
// Wow.exe 12340, per frame:
//  - 0x0077eed0 walks the eleven records in table order. A record counts when it names the current map and the point,
//    taken as (17066.67 - y, 17066.67 - x), lies in its bounds widened by 50 yards. 0x007f9c90 gives the distance to
//    the nearest edge (0x007f9bf0, point to segment) and whether the point is inside (a crossing count); inside, the
//    distance is negative. When distance - 50 < 0 (0x009f22ec), the record's light goes on the frame's list with
//    50 - distance (0x007ed150, at most five).
//  - 0x007f1360 then blends each listed light over the light built so far (0x007ee6b0): weight = (50 - distance) / 100
//    clamped to [0, 1] (0x009e8cc8 = 100, 0x009f1968 = 0.01), so 0.5 on the outline, 1 from 50 yards inside, 0 from
//    50 yards outside. That happens before the Light.dbc volumes are blended.

import type { ZoneLightOutline } from "./LightTypes.js";

/** Wow.exe 0x009f22ec: the half-width of the band across an outline's edge, yards. */
export const ZONE_OUTLINE_BAND_YARDS = 50;
/** Wow.exe 0x007ed150: the frame's list holds at most five outline lights. */
export const ZONE_OUTLINE_MAX = 5;
/** Wow.exe 0x009e2acc: the tile grid's centre, which 0x0077eed0 takes the point from. */
const ZERO_POINT = 17066.666;

export interface ZoneOutlineWeight {
  lightId: number;
  weight: number;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const boundsCache = new WeakMap<ZoneLightOutline, Bounds>();

function boundsOf(outline: ZoneLightOutline): Bounds {
  let bounds = boundsCache.get(outline);
  if (bounds) return bounds;
  bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const points = outline.points;
  for (let at = 0; at + 1 < points.length; at += 2) {
    // In 0x0077eed0's frame: (zp - y, zp - x).
    const u = ZERO_POINT - points[at + 1]!;
    const v = ZERO_POINT - points[at]!;
    if (u < bounds.minX) bounds.minX = u;
    if (v < bounds.minY) bounds.minY = v;
    if (u > bounds.maxX) bounds.maxX = u;
    if (v > bounds.maxY) bounds.maxY = v;
  }
  bounds.minX -= ZONE_OUTLINE_BAND_YARDS;
  bounds.minY -= ZONE_OUTLINE_BAND_YARDS;
  bounds.maxX += ZONE_OUTLINE_BAND_YARDS;
  bounds.maxY += ZONE_OUTLINE_BAND_YARDS;
  boundsCache.set(outline, bounds);
  return bounds;
}

/**
 * The distance from world (x, y) to the outline's edge, negative inside, as Wow.exe 0x007f9c90 computes it in
 * 0x0077eed0's frame (the crossing test keeps its half-open comparisons).
 */
export function zoneOutlineSignedDistance(outline: ZoneLightOutline, x: number, y: number): number {
  const qu = ZERO_POINT - y;
  const qv = ZERO_POINT - x;
  const points = outline.points;
  const count = points.length >> 1;
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const iu = ZERO_POINT - points[i * 2 + 1]!;
    const iv = ZERO_POINT - points[i * 2]!;
    const ju = ZERO_POINT - points[j * 2 + 1]!;
    const jv = ZERO_POINT - points[j * 2]!;
    // 0x007f9bf0: squared distance to the segment from point i to point j.
    const du = ju - iu;
    const dv = jv - iv;
    const length2 = du * du + dv * dv;
    const t = length2 > 0 ? ((qu - iu) * du + (qv - iv) * dv) / length2 : 0;
    let distance2: number;
    if (t < 0 || length2 === 0) distance2 = (qu - iu) ** 2 + (qv - iv) ** 2;
    else if (t > 1) distance2 = (qu - ju) ** 2 + (qv - jv) ** 2;
    else distance2 = (qu - (iu + du * t)) ** 2 + (qv - (iv + dv * t)) ** 2;
    if (distance2 < best) best = distance2;
    if (((iv < qv && qv <= jv) || (jv < qv && qv <= iv)) && (ju - iu) * ((qv - iv) / (jv - iv)) + iu < qu) {
      inside = !inside;
    }
  }
  const distance = Math.sqrt(best);
  return inside ? -distance : distance;
}

/** The outline lights at world (x, y) of `map`, in Wow.exe's order, with the weight 0x007ee6b0 blends each by. */
export function zoneOutlineWeights(outlines: readonly ZoneLightOutline[] | undefined, map: number | undefined,
  x: number, y: number): ZoneOutlineWeight[] {
  const result: ZoneOutlineWeight[] = [];
  if (!outlines) return result;
  const qu = ZERO_POINT - y;
  const qv = ZERO_POINT - x;
  for (const outline of outlines) {
    if (map !== undefined && outline.map !== map) continue;
    const bounds = boundsOf(outline);
    if (qu < bounds.minX || qv < bounds.minY || qu > bounds.maxX || qv > bounds.maxY) continue;
    const distance = zoneOutlineSignedDistance(outline, x, y);
    if (!(distance - ZONE_OUTLINE_BAND_YARDS < 0)) continue;
    const share = ZONE_OUTLINE_BAND_YARDS - distance;
    result.push({ lightId: outline.lightId, weight: Math.min(1, Math.max(0, share / 100)) });
    if (result.length >= ZONE_OUTLINE_MAX) break;
  }
  return result;
}
