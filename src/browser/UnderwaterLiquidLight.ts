// 05.10-A7b-5 review (7.10): what the selected liquid light says to the underwater overlay.
//
// Two answers, both read off the frame's light sample rather than a table of their own:
//
// * Under magma and slime the overlay used to draw nothing — there was no authored colour for the
//   inside of lava. There is one: `LiquidType.LightID` names `Light` rows 7 (magma) and 6 (slime,
//   green lava), and the light under them is their underwater set. Its fog colour is the colour of
//   that view, so the overlay takes it as its tint.
// * Depth darkens the ocean once. `LiquidType.MaxDarkenDepth` and the three intensities are
//   authored on the oceans only, and `LightClient.darkenUnderLiquid` already applies them to the
//   fog, the ambient and the direct light. The overlay's own depth curve (the wowee look) would
//   darken the same yards a second time, so where the light darkens, the overlay holds its surface
//   strength. Where the light does not (lakes, rivers, an old gateway's v4 body), it deepens as before.
//
// Allocation-free: the tint is written into one reused tuple.

import type { LightSample } from "./LightTypes.js";

/** The part of a light sample the overlay reads. */
export type UnderwaterLight = Readonly<Pick<LightSample, "colours" | "liquidLight" | "liquidDarkens">>;

const tint: [number, number, number] = [0, 0, 0];

/**
 * The tint for the inside of magma or slime: the fog colour of the liquid's own light, or
 * undefined when the frame's light is not that light (no v5 body, no `LightID`, eye not under).
 * The returned tuple is reused — read it before the next call.
 */
export function liquidLightTint(light: UnderwaterLight | undefined): readonly [number, number, number] | undefined {
  if (!light?.liquidLight) return undefined;
  const fog = light.colours.fog;
  if (!Number.isFinite(fog.r) || !Number.isFinite(fog.g) || !Number.isFinite(fog.b)) return undefined;
  tint[0] = fog.r;
  tint[1] = fog.g;
  tint[2] = fog.b;
  return tint;
}

/** Whether the light already darkens this liquid by the eye's depth. */
export function lightDarkensByDepth(light: UnderwaterLight | undefined): boolean {
  return light?.liquidDarkens === true;
}
