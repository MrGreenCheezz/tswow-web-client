import { UNIT_FLAG_IN_COMBAT } from "../../world/FactionRules.js";
import type { GroupState } from "../../world/GroupProtocol.js";
import type { FrameXmlSeamBinding } from "./FrameXmlWorldSeam.js";

/**
 * The unit questions the neutral floor answered «no» while the world held the answer: combat, the
 * group and cooperation. Measured call sites in the 3.3.5 corpus, and what each answer is made of:
 *
 * * `UnitCanCooperate("player", unit)` — UnitPopup.lua:484 decides with it whether the unit menu
 *   offers TRADE and INVITE, FriendsFrame.lua:1302 whether «Add friend» takes the target. The
 *   neutral `false` hid both menu entries on every player. Two players the realm counts as friendly
 *   to each other (the seam's own FactionTemplate reaction) cooperate.
 * * `UnitCanAssist("player", unit)` — SecureTemplates.lua:493 and RestrictedEnvironment.lua:193-217,
 *   the «help» side of a click-cast and of a `[help]` condition: a friendly reaction.
 * * `UnitIsDeadOrGhost("player")` — UnitPopup.lua:1048-1092 and StaticPopup.lua:2949 keep a corpse
 *   from summoning, inviting or accepting; composed from the seam's UnitIsDead and UnitIsGhost.
 * * `UnitAffectingCombat(unit)` — PaperDollFrame.lua:2074-2081 and EquipmentManager.lua:306 refuse
 *   gear swaps in combat, StaticPopup.lua:2548 a ready check: `UNIT_FLAG_IN_COMBAT` on the unit, the
 *   only thing on the wire that says so (UnitDefines.h:154). `InCombatLockdown()` is the player's
 *   own flag (SecureHandlers.lua:528, UnitPopup.lua:593).
 * * `UnitInParty`, `UnitInRaid`, `UnitIsPartyLeader`, `UnitIsRaidOfficer` — TargetFrame.lua:117 and
 *   :190 (the leader crown), :659-664 (the unit menu's RAID_PLAYER/PARTY choice, which reads
 *   `GetRaidRosterInfo(UnitInRaid(unit) + 1)`: the index is 0-based), UnitPopup.lua:503-764
 *   (promote, demote, uninvite), the calendar's invite list by *name* (Blizzard_Calendar.lua:958).
 *   From `SMSG_GROUP_LIST`, which leaves the receiver out: the seam's raid order is the listed
 *   members, then the player (FrameXmlRaid.ts), and `UnitInRaid` counts in that order.
 */

/** `GROUPTYPE_RAID` and `MEMBER_FLAG_ASSISTANT` (Group.h). */
const GROUPTYPE_RAID = 0x02;
const MEMBER_FLAG_ASSISTANT = 0x01;

type RelationGroup = Pick<GroupState, "groupType" | "leaderGuid" | "members" | "ownFlags">;

/** Whether a unit's UNIT_FIELD_FLAGS carries `UNIT_FLAG_IN_COMBAT`. */
export function frameXmlUnitFlagsInCombat(flags: number | undefined): boolean {
  return ((flags ?? 0) & UNIT_FLAG_IN_COMBAT) !== 0;
}

/** Whether `guid` is in the player's group — the player included, once there is one. */
export function frameXmlGroupHas(group: RelationGroup | undefined, selfGuid: bigint | undefined, guid: bigint | undefined): boolean {
  if (!group || guid === undefined || guid === 0n) return false;
  return guid === selfGuid || group.members.some((member) => member.guid === guid);
}

/**
 * `UnitInRaid`'s 0-based index in the seam's raid order (listed members, then the player), or
 * undefined outside a raid or for a unit not in it.
 */
export function frameXmlRaidIndex(group: RelationGroup | undefined, selfGuid: bigint | undefined, guid: bigint | undefined): number | undefined {
  if (!group || (group.groupType & GROUPTYPE_RAID) === 0 || guid === undefined || guid === 0n) return undefined;
  const listed = group.members.findIndex((member) => member.guid === guid);
  if (listed >= 0) return listed;
  if (guid !== selfGuid) return undefined;
  // SMSG_GROUP_LIST never lists its receiver; if a list ever did, the loop above found them.
  return group.members.length;
}

export function frameXmlGroupLeader(group: RelationGroup | undefined, guid: bigint | undefined): boolean {
  return group !== undefined && guid !== undefined && guid !== 0n && group.leaderGuid === guid;
}

/** A raid's leader or one of its assistants; the player's own flag is the header's `ownFlags`. */
export function frameXmlRaidOfficer(group: RelationGroup | undefined, selfGuid: bigint | undefined, guid: bigint | undefined): boolean {
  if (!group || (group.groupType & GROUPTYPE_RAID) === 0 || guid === undefined || guid === 0n) return false;
  if (group.leaderGuid === guid) return true;
  if (guid === selfGuid) return (group.ownFlags & MEMBER_FLAG_ASSISTANT) !== 0;
  const member = group.members.find((candidate) => candidate.guid === guid);
  return member !== undefined && (member.flags & MEMBER_FLAG_ASSISTANT) !== 0;
}

/** What a seam answers for the group and combat members; each is optional and absent means «no». */
export interface FrameXmlUnitRelations {
  /** `UNIT_FLAG_IN_COMBAT` on the unit's object; a unit out of sight is not known to fight. */
  unitAffectingCombat?(unit: string): boolean;
  /** `InCombatLockdown()`: the player's own combat flag. */
  inCombatLockdown?(): boolean;
  /** A unit token or a player's name, in the player's group. */
  unitInParty?(unitOrName: string): boolean;
  /** The 0-based raid index of a unit token or a name. */
  unitInRaid?(unitOrName: string): number | undefined;
  unitIsPartyLeader?(unitOrName: string): boolean;
  unitIsRaidOfficer?(unitOrName: string): boolean;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

/** Unit tokens are case-insensitive; a name is kept as typed for the host's own match. */
function unitArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function token(value: unknown): string {
  return unitArg(value).toLowerCase();
}

export const FRAMEXML_UNIT_RELATION_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  UnitCanCooperate: (seam, args) => {
    const left = token(args[0]);
    const right = token(args[1]);
    return [left.length > 0 && right.length > 0 && seam.unitIsPlayer(left) && seam.unitIsPlayer(right)
      && seam.unitIsFriend(left, right)];
  },
  UnitCanAssist: (seam, args) => {
    const left = token(args[0]);
    const right = token(args[1]);
    return [left.length > 0 && right.length > 0 && seam.unitIsFriend(left, right)];
  },
  UnitIsDeadOrGhost: (seam, args) => {
    const unit = token(args[0]);
    return [unit.length > 0 && (seam.unitIsDead(unit) || seam.unitIsGhost(unit))];
  },
  UnitAffectingCombat: (seam, args) => [seam.unitAffectingCombat?.(token(args[0])) ?? false],
  InCombatLockdown: (seam) => [seam.inCombatLockdown?.() ?? false],
  UnitInParty: (seam, args) => [seam.unitInParty?.(unitArg(args[0])) ?? false],
  UnitInRaid: (seam, args) => {
    const index = seam.unitInRaid?.(unitArg(args[0]));
    return index === undefined ? NOTHING : [index];
  },
  UnitIsPartyLeader: (seam, args) => [seam.unitIsPartyLeader?.(unitArg(args[0])) ?? false],
  UnitIsRaidOfficer: (seam, args) => [seam.unitIsRaidOfficer?.(unitArg(args[0])) ?? false],
});
