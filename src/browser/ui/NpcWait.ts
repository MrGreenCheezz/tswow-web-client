/**
 * When a click on an NPC or an object is met by silence (WORK_PLAN 4.15), DOM-free.
 *
 * The server answers an NPC it will not serve with nothing at all: `Player::GetNPCIfCanInteractWith`
 * (Player.cpp:2283-2312) returns null — too far, dead, the wrong side, under control — and every
 * handler simply returns. Range is 3D, INTERACTION_DISTANCE (5 yards, ObjectDefines.h:24) plus both
 * combat reaches (`WorldObject::_IsWithinDist`, Object.cpp:1153-1158). The native «waiting» card
 * gives up after {@link PENDING_NPC_TIMEOUT_MS} and says which of the two it most likely was.
 *
 * The words: the client's `ERR_TOO_FAR_TO_INTERACT` («Чтобы взаимодействовать с выбранной целью,
 * вы должны подойти поближе.»).
 *
 * 4.15 (11.11): Wow.exe never sends the click of a unit out of its own reach. A right click on a live unit
 * it may talk to (0x00731260 → 0x00729530 → 0x006DDBB0, `.runtime/re-2026-10-03/l1102bcd/r2.c`) measures the
 * 3D distance from the player and, with click-to-move off, refuses beyond the unit's UNIT_FIELD_COMBATREACH
 * + 4 yards (0x009E8D2C) with game error 0x2C9 — ERR_TOO_FAR_TO_INTERACT by the error table 0x00AC8AF0
 * (`.runtime/re-2026-11-11/moves/errs.txt`); no gossip, vendor or other service packet goes out. ERR_OUT_OF_RANGE
 * (0x86) is the attack and spell-target error (0x006E4950, 0x0072BDB0), ERR_AUTOFOLLOW_TOO_FAR (0x139) the
 * click-to-move start (0x00715C70). {@link beyondClientReach} is that test.
 */

import { nativeString } from "./Strings.js";

export const PENDING_NPC_TIMEOUT_MS = 4000;
/** INTERACTION_DISTANCE, ObjectDefines.h:24. */
export const INTERACTION_DISTANCE = 5;
/** DEFAULT_PLAYER_COMBAT_REACH / DEFAULT_COMBAT_REACH (ObjectDefines.h), for a field not sent. */
export const DEFAULT_COMBAT_REACH = 1.5;

export interface ReachPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Whether `a` and `b` are further apart than the server lets an NPC be used from. */
export function beyondInteraction(a: ReachPoint, b: ReachPoint, reachA: number, reachB: number): boolean {
  const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  return distance > INTERACTION_DISTANCE + Math.max(0, reachA) + Math.max(0, reachB);
}

/** 0x009E8D2C: the yards 0x006DDBB0 adds to the clicked unit's combat reach. */
export const CLIENT_INTERACTION_SLACK = 4;

/**
 * 4.15 (11.11): Wow.exe 0x006DDBB0 — the clicked unit is beyond the client's own reach: 3D distance² over
 * (its combat reach + 4)², the player's reach not counted.
 */
export function beyondClientReach(player: ReachPoint, unit: ReachPoint, unitReach: number): boolean {
  const dx = unit.x - player.x;
  const dy = unit.y - player.y;
  const dz = unit.z - player.z;
  const limit = unitReach + CLIENT_INTERACTION_SLACK;
  return dx * dx + dy * dy + dz * dz > limit * limit;
}

export function tooFarText(): string {
  return nativeString("ERR_TOO_FAR_TO_INTERACT", "Чтобы взаимодействовать с выбранной целью, вы должны подойти поближе.");
}

/** What the timed-out card says: too far when the positions say so, else that nobody answered. */
export function npcWaitVerdict(tooFar: boolean): string {
  return tooFar ? tooFarText() : "NPC не отвечает";
}
