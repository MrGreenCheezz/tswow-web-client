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
 * вы должны подойти поближе.») — which of its range errors Wow.exe itself raises on such a click
 * was not read from the binary.
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

export function tooFarText(): string {
  return nativeString("ERR_TOO_FAR_TO_INTERACT", "Чтобы взаимодействовать с выбранной целью, вы должны подойти поближе.");
}

/** What the timed-out card says: too far when the positions say so, else that nobody answered. */
export function npcWaitVerdict(tooFar: boolean): string {
  return tooFar ? tooFarText() : "NPC не отвечает";
}
