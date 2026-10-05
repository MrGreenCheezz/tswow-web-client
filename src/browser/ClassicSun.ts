// 05.10-sun (7.04, 7.07; owner decision 05.10): on the classic preset (lighting quality 0) the key
// light, and the visible sun the shafts would use, follow the 3.3.5a client (Wow.exe 12340) instead
// of the renderer's east-to-west arc, so the disc `SkyCelestials` draws matches the shading.
//
// From the client (read-only Ghidra and the executable's constants; notes and probes in
// `.runtime/re-2026-10-05/A7b-6/b5.txt` and `.runtime/re-2026-10-05/A7b-sun/`; behaviour described
// in our own words):
//   * 0x7eea90 runs every frame after the sky colours (called from 0x7f3920 with the bodies at
//     0x7eecc0). On first use it fills two four-key tables over the fraction of the day and reads
//     both through the sky's key interpolator (0x7ed3b0, `skyKeyCurve`): a polar angle from the
//     zenith — 127° (0xa41c4c) at 00:00 and 12:00, 110° (0xa41c48) at 06:00 and 18:00, linear in
//     between — and an azimuth of a constant 225° (0xa41c44). The world-axis vector it stores
//     (0xd38c9c…0xd38ca4) is spherical like the bodies' and points down: the way the light travels.
//   * So the light comes from azimuth 45° — north-west, the bearing the sun and moon use — at 37°
//     above the horizon around midnight and noon and 20° around 06:00 and 18:00. There is no day /
//     night switch and nothing turns towards the moon: one continuous triangle, never below 20°.
//
// Enhanced and cinematic keep `sunDirection` / `godRaySunDirection` (WorldRenderer3D) unchanged.

import {
  SUN_AZIMUTH, SUN_POLAR, celestialDirection, skyDayFraction, skyKeyCurve,
  type SkyKeys, type SkyVector,
} from "./SkyCelestials.js";

/** 0xd390e4 (four keys): the key light's polar angle from the zenith, in radians. */
export const KEY_LIGHT_POLAR: SkyKeys = [
  0, 2.2165682315826416, 0.25, 1.9198622703552246, 0.5, 2.2165682315826416, 0.75, 1.9198622703552246,
];
/** 0xd390c4 (four keys): the key light's azimuth, a constant 225° — light travelling south-east. */
export const KEY_LIGHT_AZIMUTH: SkyKeys = [
  0, 3.9269909858703613, 0.25, 3.9269909858703613, 0.5, 3.9269909858703613, 0.75, 3.9269909858703613,
];

/**
 * The classic key light as the renderer's `wowSunDirection`: a scene-space unit vector towards the
 * light (the client's stored vector negated). `time` is the Light.dbc clock in half-minutes.
 * Fills and returns `target`; no allocation.
 */
export function classicKeyLightDirection<T extends SkyVector>(time: number, target: T): T {
  const fraction = skyDayFraction(time);
  celestialDirection(skyKeyCurve(KEY_LIGHT_POLAR, fraction), skyKeyCurve(KEY_LIGHT_AZIMUTH, fraction), target);
  target.x = -target.x;
  target.y = -target.y;
  target.z = -target.z;
  return target;
}

/**
 * The classic visible sun: the very body `SkyCelestials` draws (0x7eecc0's sun tables), allowed to
 * set — under the horizon from ~20:30 to ~06:10. Fills and returns `target`; no allocation.
 */
export function classicSunDirection<T extends SkyVector>(time: number, target: T): T {
  const fraction = skyDayFraction(time);
  return celestialDirection(skyKeyCurve(SUN_POLAR, fraction), skyKeyCurve(SUN_AZIMUTH, fraction), target);
}
