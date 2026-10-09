import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/*
 * The TargetNearest* family's filters (WORK_PLAN 1.10/3.11, lane L2), as Wow.exe 3.3.5a (12340)
 * applies them. Every one of the seven Lua functions is 0x524fc0(reverse, mode) — the Tab cycle of
 * world/TargetSearch.ts with one list shared by all modes (a press in another mode rebuilds it) —
 * and differs only in the mode its filter 0x518e40 reads. Registration table (name → function):
 * TargetNearest 0xac82c8 → 0x525a90 (mode 0), TargetNearestEnemy → 0x525ad0 (1),
 * TargetNearestEnemyPlayer → 0x525b10 (2), TargetNearestFriend → 0x525b50 (3),
 * TargetNearestFriendPlayer → 0x525b90 (4), TargetNearestPartyMember → 0x525bd0 (5),
 * TargetNearestRaidMember → 0x525c00 (6). Notes: .runtime/re-2026-10-04/l2-targeting/g1.c and
 * .runtime/re-2026-10-01/a9-combat/e3.c (0x518e40, 0x524440).
 *
 * The filter, on the candidate:
 * - 0: anything 0x524440 lets in;
 * - 1: Tab's — CanAttack, not dead, no UNIT_DYNFLAG_DEAD, not lying dead (TargetSearch.isTabEnemy);
 * - 2: a player (OBJECT_FIELD_TYPE & TYPEMASK_PLAYER) that passes 1;
 * - 3: the player can assist it (0x7293d0 with immunities in force) and its health is at least 1;
 * - 4: a player that passes 3;
 * - 5: the player or one of the four party guids (0x52c680) — in a raid, the player's subgroup;
 * - 6: 5, or one of the raid roster's guids (0x512a00 = 0x52c680 || 0x5726f0).
 * 5 and 6 judge nothing else: a dead or hostile-flagged member is still taken.
 *
 * Every mode shares 0x524440's net: within ±30° of the mover's facing out to 41 yards, anywhere
 * within 10, never the mover itself, never a creature whose CreatureType has flag 1 (critters,
 * companion pets, gas clouds — for a friend search as much as for Tab).
 *
 * Modes 0–4 are gated in Wow.exe by a protected-call check (0x00beaf4c clear, or bit 0x20 of
 * 0x00beaf44 — read here as taint and the hardware-event flag, which the call consumes); 5, 6 and
 * the TargetLast* functions are not. This client has no taint model and runs them all.
 */

export const NEAREST_ANY = 0;
export const NEAREST_ENEMY = 1;
export const NEAREST_ENEMY_PLAYER = 2;
export const NEAREST_FRIEND = 3;
export const NEAREST_FRIEND_PLAYER = 4;
export const NEAREST_PARTY_MEMBER = 5;
export const NEAREST_RAID_MEMBER = 6;

export type NearestMode = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** What the filters ask of the world; the browser answers with its faction table and group. */
export interface NearestModeHost {
  /** Tab's own filter (mode 1), creature type included. */
  tabEnemy(object: WorldObjectState): boolean;
  /** 0x7293d0(player, unit, 0): the player can assist the unit. */
  canAssist(object: WorldObjectState): boolean;
  /** The player's guid. */
  readonly selfGuid: bigint | undefined;
  /** A party member (the player's subgroup in a raid) other than the player. */
  inParty(guid: bigint): boolean;
  /** A member of the player's group, party or raid, other than the player. */
  inGroup(guid: bigint): boolean;
}

const TYPEID_PLAYER = 4;
const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;

/** 0x518e40 for one mode; the candidate net (0x524440) is the caller's. */
export function nearestModeAccepts(mode: NearestMode, object: WorldObjectState, host: NearestModeHost): boolean {
  switch (mode) {
    case NEAREST_ANY:
      return true;
    case NEAREST_ENEMY_PLAYER:
      if (object.typeId !== TYPEID_PLAYER) return false;
    // falls through: 2 is 1 for players
    case NEAREST_ENEMY:
      return host.tabEnemy(object);
    case NEAREST_FRIEND_PLAYER:
      if (object.typeId !== TYPEID_PLAYER) return false;
    // falls through: 4 is 3 for players
    case NEAREST_FRIEND:
      return host.canAssist(object) && (object.fields.get(HEALTH) ?? 0) >= 1;
    case NEAREST_PARTY_MEMBER:
      return object.guid === host.selfGuid || host.inParty(object.guid);
    case NEAREST_RAID_MEMBER:
      return object.guid === host.selfGuid || host.inParty(object.guid) || host.inGroup(object.guid);
    default:
      return false;
  }
}

/**
 * A Lua argument as Wow.exe reads a boolean one (0x815500 with default false): nil false, a
 * boolean itself, a number non-zero after truncation, a string by 0x815400 — first letter 0 F N f n
 * false, 1–9 T Y t y true, else "off"/"disabled" false and "on"/"enabled" true (any case), anything
 * else (the empty string too) false. A table or a function is false.
 */
export function luaFlagArgument(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Math.trunc(value) !== 0;
  if (typeof value !== "string" || value.length === 0) return false;
  const first = value.charAt(0);
  if ("0FNfn".includes(first)) return false;
  if ("123456789TYty".includes(first)) return true;
  // 0x815400 answers "off"/"disabled" false before it looks for "on"/"enabled"; with the default
  // false that ordering changes nothing, so only the true words are named.
  const word = value.toLowerCase();
  return word === "on" || word === "enabled";
}
