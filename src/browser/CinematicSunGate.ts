/**
 * 22.10 (7.30): the cinematic chain's sun effects only where the client draws a sun. Owner, 22.10:
 * «в некоторых местах солнце лишнее». The beams (the radial shafts and the volume march), the sun's
 * glare and disc in the bloom and the sun's share of the haze (its warmth and glare) all follow
 * one factor, faded rather than switched.
 *
 * The client's own rule is the one `SkyCelestials` already ports (0x7f09b0): the sun, the moons,
 * the stars and the clouds are drawn only while the sky dome is (not in an interior-only room) and
 * no loaded LightSkybox model covers the sky — `skyboxCoversSky`, a model without `Flags & 2`
 * (Hellfire, Netherstorm, Shadowmoon, Zul'Drak, Icecrown, the death sky). Under a roof (`indoors`)
 * and under the horizon the chain already fades them (`#shelter`, `sunUp`, `daylight`).
 */

/** Seconds-scaled rate of the fade (as the roof's, `1 − e^(−dt·rate)` per frame). */
export const SUN_SHOWN_RATE = 2;

/**
 * Whether the client draws a sun this frame: the sky dome is drawn and no loaded LightSkybox model
 * covers it. `skyboxCovers` is `skyboxCoversSky(…)`.
 */
export function clientDrawsSun(skyDomeVisible: boolean, skyboxCovers: boolean): boolean {
  return skyDomeVisible && !skyboxCovers;
}

/** One frame of the fade toward `target` (0 or 1); snaps when within 1e-3. */
export function stepSunShown(current: number, target: number, seconds: number): number {
  const dt = Number.isFinite(seconds) ? Math.max(0, Math.min(0.25, seconds)) : 0;
  const next = current + (target - current) * (1 - Math.exp(-dt * SUN_SHOWN_RATE));
  return Math.abs(next - target) < 1e-3 ? target : next;
}
