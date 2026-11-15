// 15.11 (11.02): SMSG_SET_PROJECTILE_POSITION on the drawn missiles, as Wow.exe 3.3.5a 12340 takes it (Ghidra
// read-only, .runtime/re-2026-11-11/vehicle2/v1.c, v2.c; .runtime/re-2026-11-15/fx5/r1/d.c):
//
// - The handler 0x008005a0 reads `u64 caster | u8 castCount | f32 xyz` and names every missile in flight whose
//   caster (Missile_C +0/+4) and cast count (+0x20, SPELL_GO's) match (0x006ff2c0 over the missile list, 0x006fc290
//   over the caster's own): +0x68 |= 0x400000 with the point (+0x14c). MissileFlight.ts `setProjectilePosition`.
// - 0x007015d0 then lands the missile where a step would take it further from that point than it was: +0x44 (its
//   target point) becomes that position and the target guid +0x10 is cleared, then the landing 0x00703410 plays.
// - The landing's impact 0x00700e20 plays the visual's ImpactAreaKit (SpellVisual +0x60) at 0x006fec10's point —
//   +0x44 without a target unit. So the impact area of a missile aimed at a point stands where it stopped, at the
//   moment it stopped. The kits on hit units are played on the units and do not move.
//
// This client plans those effects ahead on the packet's clock (SpellVisuals.ts): the plan tags the point target's
// impact area — and this client's own stand-in impact kits at that point — with the missile's `landing`, and the
// renderer moves and restarts them when the missile reports an early landing (`missileLandedAt`).

import type { MissileFlightPlan, MissilePoint } from "./MissileFlight.js";
import type { SpellCast, VisualInstance } from "./SpellVisuals.js";

/**
 * The landing token of a missile flying at `target` of `cast` (1-based target index), or undefined: only a cast with
 * a cast count can be named by the packet, and only a point target (guid 0) has an impact that stands at +0x44.
 */
export function missileLandingToken(cast: Pick<SpellCast, "caster" | "castCount">, target: bigint, index: number): number | undefined {
  if (cast.castCount === undefined || cast.caster === 0n || target !== 0n) return undefined;
  return index;
}

/** The flight's fields naming its cast (Missile_C +0/+4, +0x20) and its landing token. */
export function missileCastTag(cast: Pick<SpellCast, "caster" | "castCount">, landing: number | undefined):
  Pick<MissileFlightPlan, "cast" | "landing"> {
  if (cast.castCount === undefined || cast.caster === 0n) return {};
  return { cast: { caster: cast.caster, count: cast.castCount & 0xff }, ...(landing !== undefined ? { landing } : {}) };
}

/** Tags the instances from `from` on with the landing token. */
export function tagLanding(instances: VisualInstance[], from: number, landing: number | undefined): void {
  if (landing === undefined) return;
  for (let index = from; index < instances.length; index++) instances[index]!.landsWith = landing;
}

/** What the renderer keeps per drawn effect, as far as moving it goes. */
export interface LandingVisual {
  readonly instance: VisualInstance;
  readonly handle: unknown;
  authoredEndsAt?: number;
}

/**
 * Moves the effects of `handle` tagged with `landing` to `point` and, if they were still to come, starts them `now`
 * with their planned length. Returns how many it moved.
 */
export function landImpacts(visuals: readonly LandingVisual[], handle: unknown, landing: number,
  point: Readonly<MissilePoint>, now: number): number {
  let moved = 0;
  for (const visual of visuals) {
    const instance = visual.instance;
    if (visual.handle !== handle || instance.landsWith !== landing) continue;
    instance.position = { x: point.x, y: point.y, z: point.z };
    if (instance.startedAt > now) {
      const early = instance.startedAt - now;
      instance.startedAt = now;
      instance.endsAt -= early;
      if (visual.authoredEndsAt !== undefined) visual.authoredEndsAt -= early;
    }
    delete instance.landsWith;
    moved++;
  }
  return moved;
}
