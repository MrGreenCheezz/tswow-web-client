// 06.10-shadow (7.20, owner's live report 06.10 on level 3 «сравнение»: «тени очень любят прыгать …
// пропадают и появляются резко»). Which units cast into the sun cascades, decided so that a shadow
// does not come and go while nothing about its caster changed.
//
// Below every lighting level with a shadow pass the only per-frame casters are units (the scenery
// leaf is off at level 3, and it is a cinematic leaf at 1 and 2). Until this file a unit cast
// exactly when, on this frame, it was admitted to the draw (that is: its *body* was in the view
// frustum), its admission rank was under `shadowCasters` and it stood within `shadowExtent` of the
// player. All three are hard edges, re-decided every frame:
//   * the frustum: a unit beside or behind the camera is not admitted, so its shadow — which at
//     level 3's key light (a fixed north-west bearing 20–37° above the horizon, ClassicSun.ts) is
//     2.7–1.3 times its height long — vanished from the ground it lies on as the camera turned;
//   * the rank: it is the order of the *visible* units, so turning the camera reshuffled it and the
//     12th–13th nearest units on screen swapped shadows;
//   * the distance: a unit pacing at 32 yards switched its shadow on and off.
// Offline, over the real creature spawns of the Stormwind trade district (a 60 s walk at run speed
// with the camera swinging ±60°): 192 caster switches a minute, 92 from the frustum, 69 from the
// rank, 31 at the distance edge.
//
// What changes: a unit within reach whose shadow footprint (`unitShadowFootprint`) lies in a
// view-fitted cascade and in the view counts as visible for admission, and a unit that casts keeps
// casting a few ranks and yards past the edges (`UnitShadowCasterSet`). The pass stays bounded: at
// most `shadowCasters + UNIT_SHADOW_RANK_SLACK` units cast at once. What is left is one switch per
// unit crossing the reach (32 yards on, 38 off) — no flicker. Tried and dropped: letting coverage of
// the view-fitted maps replace the 32 yards (so the cascade border's blend would fade the shadow
// out) — in a crowd the caster cap then binds and, ranked over a view-dependent admission, it
// popped more than before (simulated 231 vs 204 a minute at cap 24). Removing the last switch needs
// a per-caster fade in the depth pass (dithered depth material), which touches program warm-up.

import { unitCastsEnhancedShadow, type LightingProfile } from "./LightingQuality.js";

/** Ranks past `shadowCasters` a unit that already casts may slip before it stops. */
export const UNIT_SHADOW_RANK_SLACK = 4;
/** Yards past `shadowExtent` a unit that already casts may walk before it stops. */
export const UNIT_SHADOW_DISTANCE_SLACK = 6;
/**
 * The lowest sun the footprint is stretched for: under it (sin of ~6°) the footprint would be ten
 * times the unit's size and admit half the crowd for a shadow the cascade fade has already taken.
 */
const MIN_SUN_HEIGHT = 0.1;

export interface UnitShadowSphere {
  x: number;
  y: number;
  z: number;
  radius: number;
}

/**
 * The sphere that holds a unit and the shadow it throws on level ground, in scene space (y up).
 *
 * `(x, y, z)` and `radius` are the unit's own visibility sphere (centred at its feet, enclosing the
 * body). A point of the body at most `radius` above the feet lands, along the light, at most
 * `radius · horizontal / vertical` away, in the direction opposite the sun. `sun` points towards the
 * sun and need not be unit length. Returns false (and leaves `out` alone) when there is no sun to
 * cast with or the input is not finite. Allocation-free.
 */
export function unitShadowFootprint(
  x: number,
  y: number,
  z: number,
  radius: number,
  sun: Readonly<{ x: number; y: number; z: number }>,
  out: UnitShadowSphere,
): boolean {
  const length = Math.hypot(sun.x, sun.y, sun.z);
  if (!(length > 0) || !Number.isFinite(length) || !Number.isFinite(radius) || radius < 0
    || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  const height = sun.y / length;
  if (!(height > MIN_SUN_HEIGHT * 0.5)) return false;
  const horizontal = Math.hypot(sun.x, sun.z) / length;
  if (!(horizontal > 0)) {
    out.x = x; out.y = y; out.z = z; out.radius = radius;
    return true;
  }
  const reach = (radius * horizontal) / Math.max(height, MIN_SUN_HEIGHT);
  const half = reach / 2;
  out.x = x - (sun.x / length / horizontal) * half;
  out.y = y;
  out.z = z - (sun.z / length / horizontal) * half;
  out.radius = radius + half;
  return true;
}

/** Whether a unit at `distance` from the player could cast at all, slack included. */
export function unitShadowInReach(distance: number, profile: Pick<LightingProfile, "shadowMapSize" | "shadowExtent">): boolean {
  return profile.shadowMapSize > 0 && Number.isFinite(distance) && distance >= 0
    && distance <= profile.shadowExtent + UNIT_SHADOW_DISTANCE_SLACK;
}

/**
 * The casters of the current and the previous frame, by unit key (the GUID).
 *
 * Per frame: `begin()`, `decide()` for every admitted unit in rank order, `end()`. A key not decided
 * on a frame (not admitted, out of range, gone) is forgotten, so a unit that comes back enters by
 * the strict rule (`unitCastsEnhancedShadow`) again. A unit that already casts keeps casting for
 * `UNIT_SHADOW_RANK_SLACK` more ranks and `UNIT_SHADOW_DISTANCE_SLACK` more yards. Keys only; no
 * allocation per decision.
 */
export class UnitShadowCasterSet<K> {
  #current = new Set<K>();
  #previous = new Set<K>();

  begin(): void {
    const swap = this.#previous;
    this.#previous = this.#current;
    this.#current = swap;
    this.#current.clear();
  }

  decide(key: K, rank: number, distance: number, profile: LightingProfile): boolean {
    const casts = unitCastsEnhancedShadow(rank, distance, profile)
      || (this.#previous.has(key) && Number.isInteger(rank) && rank >= 0
        && rank < profile.shadowCasters + UNIT_SHADOW_RANK_SLACK && unitShadowInReach(distance, profile));
    if (casts) this.#current.add(key);
    return casts;
  }

  end(): void {
    this.#previous.clear();
  }

  /** Units casting after the last `decide`. */
  get size(): number {
    return this.#current.size;
  }
}
