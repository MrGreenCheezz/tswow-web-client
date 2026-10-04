import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { unit } from "../../world/Fields.js";
import { isWorldObjectDead, type WorldObjectState } from "../../world/WorldState.js";

/**
 * Follow (5.18): `FollowUnit` and the FOLLOWTARGET key, the way Wow.exe runs it. Entirely the
 * client's: the character faces the target and runs on its own movement, and the realm sees the
 * ordinary MSG_MOVE_* of a player holding forward.
 *
 * * **Starting** (`FollowUnit` 0x005224C0 → 0x0072B4A0 with interaction type 3): the target must be
 *   a player that is not the character, not charmed, of the same faction group (or either group
 *   unknown) and not attackable (0x00729BD0, else ERR_INVALID_FOLLOW_TARGET); the character must be
 *   alive (ERR_PLAYER_DEAD), not stunned (ERR_GENERIC_STUNNED) and not channelling
 *   (ERR_TOOBUSYTOFOLLOW). Then 0x00727400 ends whatever the character was following first — with
 *   its AUTOFOLLOW_END — and refuses a target 30 yards away or more (type 3's 900 = 30² in the
 *   interaction table 0x00ADAAB8; ERR_AUTOFOLLOW_TOO_FAR). AUTOFOLLOW_BEGIN carries the name.
 * * **Each frame** (0x007317A0): a target gone, on a taxi or dead ends it; so does one 30 yards
 *   away (along the ground, or in three dimensions while swimming or flying). Inside 3 yards (type
 *   3's stop distance 9 = 3² at 0x00ADAAA0) the character stops and keeps following; outside it
 *   faces the target and runs.
 * * **Ending** (0x007272C0, AUTOFOLLOW_END = event 0x166): a movement key — forward, back, strafe,
 *   turn, pitch, or a rise or dive in water or air (0x005FAE70, 0x005FAFB0, 0x005FB0B0, 0x005FACE0,
 *   0x005FB1A0, each through its 0x0072E5xx–0x0072E9xx start that ends an interaction the player did
 *   not drive) — or the mouse turning the character (0x005FB260 → 0x0072EA50), both buttons, a
 *   knock back (0x0072D1B0), a teleport, a stun, a taxi (0x00728F70), another mover (0x00729010)
 *   or the world going away.
 *
 * DOM-free: the caller supplies the rules that need factions and shows the messages.
 */

/** Type 3's start limit in the interaction table (0x00ADAABC + 3·12 = 900 yards²). */
export const FOLLOW_START_DISTANCE = 30;
/** Type 3's stop distance (0x00ADAAA0 = 9 yards²): inside it the character stands. */
export const FOLLOW_STOP_DISTANCE = 3;

const TYPEID_PLAYER = 4;
/** UnitDefines.h. */
const UNIT_FLAG_STUNNED = 0x40000;
const UNIT_FLAG_ON_TAXI = 0x100000;

/** The GlobalStrings key a refused start shows (UIErrorsFrame), Wow.exe's own codes. */
export type FollowRefusal =
  | "ERR_GENERIC_NO_TARGET" | "ERR_UNIT_NOT_FOUND" | "ERR_INVALID_FOLLOW_TARGET" | "ERR_PLAYER_DEAD"
  | "ERR_GENERIC_STUNNED" | "ERR_TOOBUSYTOFOLLOW" | "ERR_AUTOFOLLOW_TOO_FAR";

/** What following reads of the world. */
export interface FollowWorld {
  readonly state: { readonly selfGuid?: bigint | undefined; readonly objects: { get(guid: bigint): WorldObjectState | undefined } };
}

export interface FollowRules {
  /** UnitCanAttack: an attackable player is not followed. */
  canAttack(object: WorldObjectState): boolean;
  /** FactionTemplate.FactionGroup of a template, or undefined when unknown. */
  factionGroup(templateId: number): number | undefined;
  /** The name AUTOFOLLOW_BEGIN carries. */
  name(object: WorldObjectState): string;
}

export type FollowChange = { readonly kind: "begin"; readonly name: string } | { readonly kind: "end" };

let following: { readonly world: object; readonly guid: bigint; readonly name: string } | undefined;
/** Whether the last frame had the character running after the target. */
let running = false;
const listeners = new Set<(change: FollowChange) => void>();
const BEGIN_SCRATCH: { kind: "begin"; name: string } = { kind: "begin", name: "" };
const END: FollowChange = Object.freeze({ kind: "end" });

/** AUTOFOLLOW_BEGIN/END for the stock UI and the native notice; returns the unsubscribe. */
export function onFollowChange(listener: (change: FollowChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function emit(change: FollowChange): void {
  for (const listener of listeners) listener(change);
}

/** The followed unit's guid, or undefined. */
export function followTargetGuid(world?: object): bigint | undefined {
  if (!following) return undefined;
  if (world !== undefined && following.world !== world) return undefined;
  return following.guid;
}

/** Whether follow is running the character forward this frame (an axis beside the forward key). */
export function followRunning(): boolean {
  return following !== undefined && running;
}

/** 0x007272C0: stop following. True when something was being followed (AUTOFOLLOW_END went out). */
export function cancelFollow(): boolean {
  if (!following) return false;
  following = undefined;
  running = false;
  emit(END);
  return true;
}

function guidAt(object: WorldObjectState, index: number): bigint {
  const low = object.fields.get(index) ?? 0;
  const high = object.fields.get(index + 1) ?? 0;
  return (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
}

/** 0x00729BD0: a player that is not the character, not charmed, of one faction group, not an enemy. */
function validTarget(self: WorldObjectState, target: WorldObjectState, rules: FollowRules): boolean {
  if (target === self || target.guid === self.guid || target.typeId !== TYPEID_PLAYER) return false;
  if (guidAt(target, UPDATE_FIELDS.UNIT_FIELD_CHARMEDBY.offset) !== 0n) return false;
  const mine = rules.factionGroup(unit.factionTemplate(self) ?? 0);
  const theirs = rules.factionGroup(unit.factionTemplate(target) ?? 0);
  if (mine !== undefined && theirs !== undefined && mine !== theirs) return false;
  return !rules.canAttack(target);
}

function distanceSq(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, threeD: boolean): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = threeD ? a.z - b.z : 0;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * `FollowUnit` / FOLLOWTARGET: start following `target` (undefined = nothing by that token or name;
 * `named` says the caller gave a name rather than a token, which picks the error). Returns the
 * refusal, or undefined when following began.
 */
export function startFollow(
  world: FollowWorld, target: WorldObjectState | undefined, rules: FollowRules, named = false,
): FollowRefusal | undefined {
  const selfGuid = world.state.selfGuid;
  const self = selfGuid === undefined ? undefined : world.state.objects.get(selfGuid);
  if (!self) return "ERR_GENERIC_NO_TARGET";
  // 0x005224C0: nothing under the token — a name that found nobody is ERR_UNIT_NOT_FOUND.
  if (!target) return named ? "ERR_UNIT_NOT_FOUND" : "ERR_GENERIC_NO_TARGET";
  if (!validTarget(self, target, rules)) return "ERR_INVALID_FOLLOW_TARGET";
  if (isWorldObjectDead(self)) return "ERR_PLAYER_DEAD";
  if (((unit.flags(self) ?? 0) & UNIT_FLAG_STUNNED) !== 0) return "ERR_GENERIC_STUNNED";
  if ((self.fields.get(UPDATE_FIELDS.UNIT_CHANNEL_SPELL.offset) ?? 0) !== 0) return "ERR_TOOBUSYTOFOLLOW";
  // 0x00727400: the interaction in progress ends first, whatever the range check says next.
  cancelFollow();
  const from = self.position;
  const to = target.position;
  if (!from || !to || distanceSq(from, to, true) >= FOLLOW_START_DISTANCE * FOLLOW_START_DISTANCE) return "ERR_AUTOFOLLOW_TOO_FAR";
  const name = rules.name(target);
  following = { world, guid: target.guid, name };
  running = false;
  BEGIN_SCRATCH.name = name;
  emit(BEGIN_SCRATCH);
  return undefined;
}

/**
 * One frame of following (0x007317A0), before the character's input is read: ends it where the
 * client ends it, faces the target and says whether to run. `threeD` is swimming or flying, where
 * the distance is measured through the air. Writes `self.position.orientation` and answers whether
 * the facing changed (for the facing packet). No allocation.
 */
export function advanceFollow(world: object & FollowWorld, self: WorldObjectState, threeD: boolean): boolean {
  const current = following;
  if (!current) return false;
  if (current.world !== world) {
    cancelFollow();
    return false;
  }
  const target = world.state.objects.get(current.guid);
  const from = self.position;
  const to = target?.position;
  if (!target || !from || !to || isWorldObjectDead(target) || ((unit.flags(target) ?? 0) & UNIT_FLAG_ON_TAXI) !== 0) {
    cancelFollow();
    return false;
  }
  const distSq = distanceSq(from, to, threeD);
  if (distSq >= FOLLOW_START_DISTANCE * FOLLOW_START_DISTANCE) {
    cancelFollow();
    return false;
  }
  running = distSq > FOLLOW_STOP_DISTANCE * FOLLOW_STOP_DISTANCE;
  const facing = Math.atan2(to.y - from.y, to.x - from.x);
  const changed = Math.abs(facing - from.orientation) > 1e-6;
  if (changed) from.orientation = facing;
  return changed;
}

/** Tests and world changes: forget the follow without an event (the world is gone). */
export function forgetFollow(): void {
  following = undefined;
  running = false;
}
