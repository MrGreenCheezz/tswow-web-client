/**
 * 22.10 (7.36): cinematic fixture light — the enhanced profile's answer to «источники света должны
 * освещать окрестности далеко и тепло, не просто маленькое пятно рядом» (owner, 22.10).
 *
 * Wow.exe's own M2 light (6.17, `m2LightFalloff`) falls to a quarter of its colour by five yards,
 * and with the outdoor shader's `pow( light, 2.2 )` that is barely a lift on night cobbles. The
 * enhanced path keeps that curve near the source (so the hot spot stays the client's) and lays a
 * wide, soft, warm pool under it: `max( client, pool )`, where the pool is
 * `CINEMATIC_POOL_PEAK · (1 − (d / reach)²)²` — flat near the lamp, still a third of its peak at
 * half the reach, and exactly zero at the reach, with no edge. It is mostly a night term
 * (`cinematicPoolNightWeight`), so sunlit frames hardly move.
 *
 * Nothing here adds a light, a pass or a shader variant: the pool is a few ALU in the existing
 * fixture loop behind the `wowLocalLightPool` uniform, which is 0 on every profile but the high one
 * (`LightingProfile.cinematicLights`). Quality 0 never reaches the loop at all (no lights).
 */

/** Pool brightness at the source, in the display-space light units of `WORLD_LIGHT_BODY`. */
export const CINEMATIC_POOL_PEAK = 0.8;
/** Reach of a heuristic (glow-card or flame) fixture's pool; an M2 light keeps its 20 yd × scale. */
export const CINEMATIC_POOL_REACH = 18;
/** Share of the pool that remains in full daylight; the rest follows the night. */
export const CINEMATIC_POOL_DAY_SHARE = 0.15;
/**
 * Warm tint on a warm (red ≥ blue) light's pool at full strength: torch and lantern light reads
 * amber on the stone. Blue, green and violet lights keep their authored colour.
 */
export const CINEMATIC_POOL_WARMTH: readonly [number, number, number] = Object.freeze([1, 0.86, 0.66]);
/** The pool's N·L wrap, `clamp( a + b · N·L, 0, 1 )`. */
export const CINEMATIC_POOL_WRAP: readonly [number, number] = Object.freeze([0.4, 0.6]);
/**
 * Yards over which a selected light fades out before it is replaced (`localLightSelectionFade`).
 */
export const LOCAL_LIGHT_FADE_BAND = 6;

/**
 * Yards ahead of the camera, along its view, that the cinematic profile ranks lights from: the
 * third-person camera stands well behind what it looks at, and lights behind it were taking slots
 * from the lamps in the frame.
 */
export const LOCAL_LIGHT_FOCUS_AHEAD = 12;
/**
 * A WMO lamp (`WmoFixtureLights.ts`) ranks as if this much farther than it is: a doodad lamp or a
 * campfire keeps its slot before a window light of the building behind it.
 */
export const WMO_LIGHT_RANK_SCALE = 1.5;

/** CPU twin of the shader's pool for a light `distance` yards away, before colour and N·L. */
export function cinematicPoolFalloff(distance: number, reach: number, strength = 1): number {
  if (!Number.isFinite(distance) || distance < 0 || !(reach > 0) || !(strength > 0)) return 0;
  const x = Math.min(1, distance / reach);
  const window = 1 - x * x;
  return CINEMATIC_POOL_PEAK * Math.min(1, strength) * window * window;
}

/** CPU twin of the pool's day/night weight, `wowDaylight` 1 at noon and 0 at night. */
export function cinematicPoolNightWeight(daylight: number): number {
  const day = Math.max(0, Math.min(1, Number.isFinite(daylight) ? daylight : 1));
  return CINEMATIC_POOL_DAY_SHARE + (1 - CINEMATIC_POOL_DAY_SHARE) * (1 - day);
}

/**
 * The weight of a selected light `distance` yards from the camera when the nearest light left out
 * stands `cut` yards away (or the selection's range when none was). Two lights trade places
 * exactly when their distances meet, and there both weigh zero, so the nearest-N set can reshuffle
 * as the camera moves without a pool switching on or off (owner, 06.10: «мебель любит менять цвет»).
 */
export function localLightSelectionFade(distance: number, cut: number, band = LOCAL_LIGHT_FADE_BAND): number {
  if (!Number.isFinite(distance) || !Number.isFinite(cut) || !(band > 0)) return 0;
  const t = Math.max(0, Math.min(1, (cut - distance) / band));
  return t * t * (3 - 2 * t);
}

/**
 * GLSL for one fixture inside `WORLD_LIGHT_BODY`'s loop: lifts `wowLampTerm` (the light's scalar
 * contribution before colour) to the pool and warms `wowLampTint`. Reads `wowLampDistance`,
 * `wowPoolReach`, `wowLampFacing`, `wowLampColour`, `wowDaylight` and `wowLocalLightPool`.
 */
export const CINEMATIC_POOL_GLSL = /* glsl */ `
      if ( wowLocalLightPool > 0.0 ) {
        // 22.10 (7.36): CinematicLights.ts — the client's curve near the lamp, a wide soft pool past it.
        float wowPoolX = clamp( wowLampDistance / wowPoolReach, 0.0, 1.0 );
        float wowPoolWindow = 1.0 - wowPoolX * wowPoolX;
        // Softer than Lambert, so ground the lamp only grazes still takes the pool; a face turned
        // well away from the lamp (N·L under -0.67) takes none, so it does not leak through a wall.
        float wowPoolWrap = clamp( ${CINEMATIC_POOL_WRAP[0].toFixed(2)} + ${CINEMATIC_POOL_WRAP[1].toFixed(2)} * wowLampFacing, 0.0, 1.0 );
        float wowPool = ${CINEMATIC_POOL_PEAK.toFixed(3)} * wowPoolWindow * wowPoolWindow * wowPoolWrap
          * ( ${CINEMATIC_POOL_DAY_SHARE.toFixed(3)} + ${(1 - CINEMATIC_POOL_DAY_SHARE).toFixed(3)} * ( 1.0 - wowDaylight ) )
          * min( wowLocalLightPool, 1.0 );
        wowLampTerm = max( wowLampTerm, wowPool );
        if ( wowLampColour.r >= wowLampColour.b ) {
          wowLampTint = mix( vec3( 1.0 ), vec3( ${CINEMATIC_POOL_WARMTH.map((v) => v.toFixed(3)).join(", ")} ),
            min( wowLocalLightPool, 1.0 ) );
        }
      }`;
