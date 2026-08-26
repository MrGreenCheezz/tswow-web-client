import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { UNIT_FLAGS_UNTARGETABLE } from "./FactionRules.js";
import { isLootable } from "./Fields.js";
import { isWorldObjectDead, type WorldObjectState, type WorldPosition } from "./WorldState.js";

/**
 * How far Tab looks.
 *
 * Forty yards is the longest range any of this client's actions has — the far end of a caster's
 * spell — so nothing beyond it could be acted on without walking first. Picking a target out at a
 * hundred yards would only mean the cycle never reaches the creature in front of you.
 */
export const TARGET_SEARCH_RANGE = 40;

export interface TargetCandidate {
  guid: bigint;
  distance: number;
  /** Whether the character is looking at it. True for everything when no facing was given. */
  ahead: boolean;
  /** A body the server is still showing loot on. Sorted after everything alive, never before. */
  lootable: boolean;
}

/**
 * Enemies in range, nearest first, and lootable corpses after all of them.
 *
 * `hostile` is handed in rather than computed here because the answer lives in
 * `FactionTemplate.dbc`, which only the browser has fetched; keeping the walk over the world
 * separate from the reaction rule is what lets both be tested without the other.
 *
 * Excluded, and each for its own reason: the player, because Tab is for other people; a corpse
 * with no loot left on it, because there is nothing to do with it; anything the server has flagged
 * unattackable or uninteractible, because the swing would be refused; and anything out of range.
 *
 * A corpse the server still marks `UNIT_DYNFLAG_LOOTABLE` stays, because dropping it left the
 * keyboard with no way at all to reach a kill — the loot button lives on the target frame, and
 * only the mouse could put a body in it. It is exempt from `hostile` for the same reason the
 * reference client's `isValidTabTarget` never asks about the faction of a corpse
 * (`wowee/src/game/combat_handler.cpp:1589-1593`): the bit is already the server saying this body
 * is yours.
 *
 * `inCombat` drops those bodies again for as long as the fight lasts, which is a filter and not an
 * order — the sort below cannot stand in for it, because the cycle wraps. Two live enemies and a
 * body two yards away give `[C, D, B†]`, and `nextTarget([C, D, B†], D)` is `B†`: one press of Tab
 * in the middle of a fight puts a corpse in the target frame, where no swing can land. The
 * reference refuses the same body in the same state and one step earlier, before its `sortable`
 * list is built at all (`combat_handler.cpp:1590`).
 */
/**
 * Half the arc Tab looks through, in radians.
 *
 * The original client's Tab does not take the nearest unit on the map, it takes the nearest one the
 * character is looking at — which is why turning changes what Tab gives you and why a mob behind
 * you is never picked by accident. Ninety degrees each way is the arc that feels like "in front"
 * without making the player aim.
 */
export const TARGET_FACING_ARC = Math.PI / 2;

export function enemiesAround(
  objects: Iterable<WorldObjectState>,
  self: WorldPosition,
  selfGuid: bigint | undefined,
  hostile: (object: WorldObjectState) => boolean,
  range = TARGET_SEARCH_RANGE,
  facing?: number,
  /** Whether the character is fighting. While it is, no corpse is a Tab target. */
  inCombat = false,
): TargetCandidate[] {
  const candidates: TargetCandidate[] = [];
  for (const object of objects) {
    if (object.guid === selfGuid) continue;
    if (object.typeId !== 3 && object.typeId !== 4) continue;
    const position = object.position;
    if (!position) continue;
    const dead = isWorldObjectDead(object);
    const lootable = dead && isLootable(object);
    if (dead && (inCombat || !lootable)) continue;
    const flags = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset) ?? 0;
    if ((flags & UNIT_FLAGS_UNTARGETABLE) !== 0) continue;
    if (!lootable && !hostile(object)) continue;
    const distance = Math.hypot(position.x - self.x, position.y - self.y, position.z - self.z);
    if (distance > range) continue;
    candidates.push({ guid: object.guid, distance, ahead: withinArc(self, position, facing), lootable });
  }
  // Ties broken by guid so the order is the same on every press: two spawns at the same spot
  // would otherwise swap places between frames and the cycle would never leave them.
  //
  // The dead sort after the living before anything else is compared — «live enemies cycle first
  // (nearest to farthest); lootable corpses last», `wowee/src/game/combat_handler.cpp:1634-1639`.
  // What the character faces comes next, and only then distance. Everything behind stays in the
  // list rather than being dropped: a player who has cleared what is in front should keep cycling
  // rather than press Tab at an empty screen, and the moment they turn, the order turns with them.
  candidates.sort((a, b) =>
    Number(a.lootable) - Number(b.lootable)
    || Number(b.ahead) - Number(a.ahead)
    || a.distance - b.distance
    || (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0));
  return candidates;
}

/**
 * Whether a point lies inside the arc the character is looking through.
 *
 * With no facing given every candidate counts as ahead, which leaves the order exactly what it was
 * before there was an arc at all.
 */
function withinArc(self: WorldPosition, target: WorldPosition, facing: number | undefined): boolean {
  if (facing === undefined) return true;
  const bearing = Math.atan2(target.y - self.y, target.x - self.x);
  let delta = bearing - facing;
  // Wrapped into (-pi, pi] so that the comparison is an angle and not a winding number.
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta <= -Math.PI) delta += 2 * Math.PI;
  return Math.abs(delta) <= TARGET_FACING_ARC;
}

/**
 * The next one along from what is targeted now, wrapping at both ends.
 *
 * A target that is no longer a candidate — it was looted empty, walked away, or was never an
 * enemy — starts the cycle again at the nearest rather than ending it, which is what makes Tab
 * usable while fighting. The thing you just killed no longer leaves the list the instant it dies;
 * it moves to the end of it, so the press after the kill still lands on the next live enemy and
 * the press after that comes back to the body.
 */
export function nextTarget(
  candidates: readonly TargetCandidate[],
  current: bigint | undefined,
  step: 1 | -1 = 1,
): bigint | undefined {
  if (candidates.length === 0) return undefined;
  const index = current === undefined ? -1 : candidates.findIndex((candidate) => candidate.guid === current);
  if (index < 0) return candidates[step === 1 ? 0 : candidates.length - 1]!.guid;
  return candidates[(index + step + candidates.length) % candidates.length]!.guid;
}
