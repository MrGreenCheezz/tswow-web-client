/**
 * The strength the cinematic chain's sun-shaft march is asked for: the lighting quality's share of the full
 * (quality 2) strength, held to 1, times the account's shaft multiplier («Сила солнечных лучей», 0–3 after
 * `godRayStrengthScale`) and (15.11, 7.40) the zone atmosphere's canopy boost, which scales the strength only.
 * CinematicPost bounds the product the way `godRayVisibility` bounds the classic path's. 13.09: out of the renderer.
 */
export function cinematicShaftStrength(
  qualityStrength: number,
  fullStrength: number,
  scale: number,
  canopyBoost: number,
): number {
  return Math.min(1, qualityStrength / fullStrength) * scale * canopyBoost;
}
