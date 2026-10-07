/**
 * P1-05 (UNT-5): a conservative sphere for a skinned body or mount, used only by the shadow pass.
 *
 * Each view-fitted cascade is an orthographic box; a mesh whose sphere lies wholly outside that box
 * in the light plane cannot put a single fragment into the map, so `CascadedSunShadows` hides it
 * for that cascade's render only. The main pass never reads this sphere (bodies keep
 * `frustumCulled = false`), so an undersized radius can at worst drop the shadow of an outlying
 * limb at a cascade's edge, never a body.
 *
 * The radius is in the mesh's own space (M2 units, before the unit's scale); the caller applies
 * `matrixWorld` and its largest axis scale. No three.js here, so the arithmetic is testable alone.
 *
 * Status 07.10: the P1-05 wiring (`CascadedShadows.#hideBoundedOutside` sphere branch, `cullRadius`
 * on WVM bodies and mounts) was measured NO-GO — `shadowDraws["Group:units|skinned"]` 220 → 220 in
 * city and 156 → 156 in world-crowd-64, every caster lies inside cascade 0 — and reverted. Not wired
 * anywhere; kept for P2-01b (docs/implementation/line-P-P2.ru.md), which takes the unit spheres.
 * The 1.15 / +0.5 constants passed the extent probe (.runtime/perf-step22/probe-skinned-extent.mjs)
 * on the 12 bench unit models for every AnimationData-named clip (worst margin 1.30, HumanMalGuard).
 * Clips with ids ≥ 506 (not in AnimationData.dbc) break it: NightElfMale's 1056 reaches 10.5 yards.
 */

/** Multiplier over the farthest of the rest sphere, the header box and the header sphere. */
export const SKINNED_CULL_SCALE = 1.15;
/** Added after the multiplier, in mesh units (yards at scale 1). */
export const SKINNED_CULL_MARGIN = 0.5;

/** The `userData` key a mesh carries its cull radius under. */
export const SKINNED_CULL_RADIUS_KEY = "cullRadius";

export interface SkinnedCullBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly radius: number;
}

/**
 * The sphere radius, around the rest sphere's `center`, that encloses the rest pose, every corner
 * of the header box (`wvm.bounds`, the M2's animation extents where the file carries them) and the
 * header's origin-centred sphere; then `SKINNED_CULL_SCALE` and `SKINNED_CULL_MARGIN`. Undefined
 * for any non-finite, negative or inverted input: such a mesh is never culled.
 */
export function skinnedCullRadius(
  bounds: Readonly<SkinnedCullBounds>,
  center: Readonly<{ x: number; y: number; z: number }>,
  restRadius: number,
): number | undefined {
  const minX = bounds.min[0];
  const minY = bounds.min[1];
  const minZ = bounds.min[2];
  const maxX = bounds.max[0];
  const maxY = bounds.max[1];
  const maxZ = bounds.max[2];
  const headerRadius = bounds.radius;
  const cx = center.x;
  const cy = center.y;
  const cz = center.z;
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ)
    || !Number.isFinite(maxX) || !Number.isFinite(maxY) || !Number.isFinite(maxZ)
    || !Number.isFinite(headerRadius) || !Number.isFinite(restRadius)
    || !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)
    || minX > maxX || minY > maxY || minZ > maxZ || headerRadius < 0 || restRadius < 0) {
    return undefined;
  }
  // The farthest corner from the centre, axis by axis.
  const dx = Math.max(Math.abs(minX - cx), Math.abs(maxX - cx));
  const dy = Math.max(Math.abs(minY - cy), Math.abs(maxY - cy));
  const dz = Math.max(Math.abs(minZ - cz), Math.abs(maxZ - cz));
  const corner = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const origin = headerRadius + Math.sqrt(cx * cx + cy * cy + cz * cz);
  const radius = Math.max(restRadius, corner, origin) * SKINNED_CULL_SCALE + SKINNED_CULL_MARGIN;
  return Number.isFinite(radius) ? radius : undefined;
}

/**
 * Whether a sphere projected onto the light plane (`centreR`, `centreU` along the cascade's right
 * and up axes) lies wholly outside the cascade's square `cascadeR ± extent`, `cascadeU ± extent`.
 * A sphere that touches the square is kept; any NaN keeps it too. Depth is not tested: casters lie
 * within the cascade's reach.
 */
export function sphereMissesCascade(
  centreR: number,
  centreU: number,
  radius: number,
  cascadeR: number,
  cascadeU: number,
  extent: number,
): boolean {
  const reach = extent + radius;
  return Math.abs(centreR - cascadeR) > reach || Math.abs(centreU - cascadeU) > reach;
}

/** `?unitcull=0` turns the cull off for a live A/B; anything else leaves it on. */
export function unitCullingEnabled(search: string): boolean {
  try {
    return new URLSearchParams(search).get("unitcull") !== "0";
  } catch {
    return true;
  }
}
