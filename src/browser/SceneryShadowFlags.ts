/**
 * P2-02a: the sun-shadow flags of one scenery mesh, as a pure function.
 *
 * The renderer used to recompute these for every retained placement on every thirtieth light push
 * (a walk of 1,364 placements cost 1.6 ms in the Stormwind bench, 0.5 ms on the movement route).
 * Now it asks this where a mesh joins the scene — a placement built, a tree settled, an instance
 * bucket made — and walks everything only when the answer can change for all of them at once.
 */

/**
 * Yards of bounding radius below which a scenery mesh receives but does not cast the sun shadow.
 * In the Stormwind trade district this halves the extra shadow-pass draws of the scenery leaf.
 */
export const SCENERY_SHADOW_MIN_RADIUS = 1.5;

/**
 * Yards of bounding radius from which a scenery mesh also casts into the cached outermost cascade:
 * trees, large rocks, statues. Smaller casters reach only the cascades rendered every frame, which
 * cover them for as far as their shadow still reads.
 */
export const SCENERY_FAR_SHADOW_MIN_RADIUS = 3;

/** Bits of the answer: the mesh casts, receives, and casts into the cached cascade. */
export const SCENERY_SHADOW_CAST = 1;
export const SCENERY_SHADOW_RECEIVE = 2;
export const SCENERY_SHADOW_FAR = 4;

export interface SceneryShadowTraits {
  /** Every material of the mesh may take part (`shadowMaterialEligible`), and it has one at all. */
  eligible: boolean;
  /** World bounding radius in yards; read only when the mesh is eligible. */
  radius: number;
  /**
   * P2-02b: the radius the cached-cascade test reads, when it differs from `radius`. A placement that
   * can be drawn through an instance bucket passes its model's unscaled radius — the one the bucket's
   * `InstancedMesh` is flagged with — so whether a copy reaches the cached map does not depend on
   * which of the two draws it this frame.
   */
  farRadius?: number | undefined;
}

/**
 * `wanted` — the scenery leaf is on and has a map; `include` — the owner may cast itself (a WMO
 * placement may not: its rooms cast through stand-ins); `cascades` — the cached cascade exists.
 * A bit field rather than an object: the full walk asks this for every scenery mesh.
 */
export function sceneryShadowFlags(
  traits: Readonly<SceneryShadowTraits>,
  wanted: boolean,
  include: boolean,
  cascades: boolean,
): number {
  if (!wanted || !include || !traits.eligible) return 0;
  // Small props (crates, flowers, bottles) cost a shadow-pass draw each and barely read in a
  // 1024-texel map over 92 yards; trees, statues, lamp posts and awnings are what cast.
  if (!(traits.radius >= SCENERY_SHADOW_MIN_RADIUS)) return SCENERY_SHADOW_RECEIVE;
  const far = traits.farRadius ?? traits.radius;
  return SCENERY_SHADOW_RECEIVE | SCENERY_SHADOW_CAST
    | (cascades && far >= SCENERY_FAR_SHADOW_MIN_RADIUS ? SCENERY_SHADOW_FAR : 0);
}

/**
 * 11.10: whether the world (terrain, horizon, scenery, WMO stand-ins) casts into the sun's map at
 * all. `requested` is the account's «тени от окружения» leaf, `effective` the cinematic profile's
 * copy of it, which every classic-look level clears. The comparison level keeps the account's
 * answer: it runs quality 1's shadow pass for the reference's `extShadowQuality 5` — real-time
 * shadows from the world, not only from characters. Taking the cleared copy there left the live
 * recording of 11.10 with the cached cascade rendered 333 times without a single draw and the near
 * ones drawing units only. A map is needed, and no interior-only room: there the sun's term is
 * suppressed for every receiver, so casters would only cost shadow-pass draws.
 */
export function sceneryShadowsWanted(
  comparisonLevel: boolean,
  requested: boolean,
  effective: boolean,
  shadowMapSize: number,
  interior: boolean,
): boolean {
  // Positional: the renderer asks on every light push.
  return (comparisonLevel ? requested : effective) && shadowMapSize > 0 && !interior;
}
