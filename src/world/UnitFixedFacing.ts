/**
 * 15.11 (5.32): the facing a unit keeps after its melee victim died — Wow.exe's +0xa30 bit 0 with the angle at +0xab8.
 *
 * Read (`.runtime/re-2026-11-11/combat4/c1.c`): SMSG_ATTACK_STOP's worker 0x00756770 (0x00756800 case 0x144, also
 * 0x261) — when the packet names a victim, its last word (TrinityCore's `NowDead`, CombatPackets.cpp) is not zero and
 * the victim is in view — raises the bit and stores the angle from the attacker to the victim at that moment. The only
 * clear is 0x0073d530, the unit's own revival: the health handler 0x0073f330 (health ≤ 0 → > 0) and the dynamic-flags
 * handler 0x00740570 (UNIT_DYNFLAG_DEAD now clear); the object's constructor starts without it. 0x00735f60 draws the
 * angle whenever the unit stands still and may turn (UnitFacing.ts), before its target, its cast and the window the
 * player has open on it.
 *
 * Measured on the Wow.exe stand 15.11 (F:\WowOracle\tools\face6-session.mjs, runs\face6-q1-flag.bones against
 * face6-q1-noflag.bones, read by face6-yaw.mjs): a creature that turned to its victim and got SMSG_ATTACK_STOP with
 * NowDead 1 kept the victim's angle with its target cleared, through a SetFacingTo spline (one frame away, then back),
 * a new UNIT_FIELD_TARGET (the player, never faced), a walk along a spline (faced the way it walked, then back to the
 * kill angle when it stopped), a second fight whose SMSG_ATTACK_STOP had NowDead 0; its own death and revival ended it
 * (back to its movement facing). The control with NowDead 0 followed each of those at once. So the reading is what
 * the original draws: a creature that killed in melee and evades home stands there facing where its victim fell.
 *
 * Kept by guid with the object it was set on: a unit destroyed and created again starts without it, as the constructor
 * does. The revival edge is seen once a frame (`current`), so a death and a revival inside one frame go unseen.
 */

import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { WorldObjectState } from "./WorldState.js";

/** `UNIT_DYNFLAG_DEAD` (UnitDefines.h): the flag 0x00740570 watches. */
const UNIT_DYNFLAG_DEAD = 0x20;
const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
const DYNAMIC_FLAGS = UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset;

interface FixedFacing {
  readonly object: WorldObjectState;
  readonly angle: number;
  /** Seen dead since the facing was fixed: the next frame alive is the revival that clears it. */
  down: boolean;
}

const isDown = (object: WorldObjectState): boolean =>
  (object.fields.get(HEALTH) ?? 1) <= 0 || ((object.fields.get(DYNAMIC_FLAGS) ?? 0) & UNIT_DYNFLAG_DEAD) !== 0;

export class UnitFixedFacings {
  readonly #fixed = new Map<bigint, FixedFacing>();
  readonly #shown = new Map<bigint, number>();

  /** SMSG_ATTACK_STOP (0x00756770): the attacker keeps the angle to a victim that died, when both are in view. */
  attackStopped(attacker: bigint, victim: bigint, victimDied: boolean, objects: ReadonlyMap<bigint, WorldObjectState>): void {
    if (!victimDied || victim === 0n) return;
    const from = objects.get(attacker);
    const to = objects.get(victim);
    if (from?.position === undefined || to?.position === undefined) return;
    const angle = Math.atan2(to.position.y - from.position.y, to.position.x - from.position.x);
    this.#fixed.set(attacker, { object: from, angle, down: isDown(from) });
  }

  /**
   * The fixed facings this frame, by unit. Drops a unit that left view or was created again, and a unit revived
   * since (0x0073d530: health back above 0, or UNIT_DYNFLAG_DEAD cleared). One map, refilled in place.
   */
  current(objects: ReadonlyMap<bigint, WorldObjectState>): ReadonlyMap<bigint, number> {
    const shown = this.#shown;
    shown.clear();
    for (const [guid, fixed] of this.#fixed) {
      if (objects.get(guid) !== fixed.object) {
        this.#fixed.delete(guid);
        continue;
      }
      if (isDown(fixed.object)) fixed.down = true;
      else if (fixed.down) {
        this.#fixed.delete(guid);
        continue;
      }
      shown.set(guid, fixed.angle);
    }
    return shown;
  }
}
