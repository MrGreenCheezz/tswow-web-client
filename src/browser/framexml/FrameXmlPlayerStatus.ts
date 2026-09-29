/**
 * The player-status C API stock PlayerFrame, MainMenuBar, PartyMemberFrame, TargetFrame and
 * UnitPopup read, and the neutral floor answered with nothing or a constant: the inn's «zzz»
 * (`IsResting`, PlayerFrame.lua:441), the rested part of the experience bar (`GetXPExhaustion`,
 * MainMenuBar.lua:314), «<AFK>»/«<DND>» after a name (`UnitIsAFK`/`UnitIsDND`), the leader crown
 * on a party row (`GetPartyLeaderIndex`, PartyMemberFrame.lua:189), the dungeon-finder role icons
 * (`UnitGroupRolesAssigned`, PartyMemberFrame.lua:223), the loot pass switch of the unit menu
 * (`GetOptOutOfLoot`/`SetOptOutOfLoot`, UnitPopup.lua:238, 1305) and the raid mark over a frame
 * (`GetRaidTargetIndex`, TargetFrame.lua:683).
 *
 * The answers are pure functions of the world's own words — `PLAYER_FLAGS`, the rested-experience
 * field, the group list, the raid-mark map — so they are here as data transforms, with the seam
 * supplying the words. A seam without the member (the canned fixture) gets the empty world's
 * answer, which for every one of these is «no»: not resting, no rested experience, nobody away,
 * no leader, no role, not passing, no mark.
 */
import {
  PLAYER_FLAGS_AFK, PLAYER_FLAGS_DND, PLAYER_FLAGS_RESTING,
} from "../../world/Fields.js";
import type { GroupState } from "../../world/GroupProtocol.js";
import { LFG_ROLE_DAMAGE, LFG_ROLE_HEALER, LFG_ROLE_TANK } from "../../world/LfgProtocol.js";
import type { FrameXmlSeamBinding } from "./FrameXmlWorldSeam.js";

/** `UnitGroupRolesAssigned`'s triple: tank, healer, damage. */
export type FrameXmlGroupRoles = readonly [isTank: boolean, isHealer: boolean, isDamage: boolean];

export const FRAMEXML_NO_GROUP_ROLES: FrameXmlGroupRoles = Object.freeze([false, false, false]) as FrameXmlGroupRoles;

/** What a seam answers for these names; every member is optional and absent means «no». */
export interface FrameXmlPlayerStatus {
  /** `PLAYER_FLAGS_RESTING` on the player's own object. */
  isResting?(): boolean;
  /** Rested experience still to earn; undefined when there is none, which the client answers as nil. */
  xpExhaustion?(): number | undefined;
  unitIsAFK?(unit: string): boolean;
  unitIsDND?(unit: string): boolean;
  /** The leader's `party<n>` slot, 1..4; 0 when the player leads, is alone or the group is a raid. */
  partyLeaderIndex?(): number;
  unitGroupRoles?(unit: string): FrameXmlGroupRoles;
  optOutOfLoot?(): boolean;
  setOptOutOfLoot?(passOnLoot: boolean): void;
  /** The 1..8 mark index the client numbers; undefined for an unmarked or unknown unit. */
  raidTargetIndex?(unit: string): number | undefined;
}

export function frameXmlPlayerFlagResting(flags: number | undefined): boolean {
  return ((flags ?? 0) & PLAYER_FLAGS_RESTING) !== 0;
}

export function frameXmlPlayerFlagAfk(flags: number | undefined): boolean {
  return ((flags ?? 0) & PLAYER_FLAGS_AFK) !== 0;
}

export function frameXmlPlayerFlagDnd(flags: number | undefined): boolean {
  return ((flags ?? 0) & PLAYER_FLAGS_DND) !== 0;
}

/**
 * `GetXPExhaustion` is nil, not 0, once the bonus is spent: `ExhaustionTick_OnEvent` tests
 * `not exhaustionThreshold` to hide the tick (MainMenuBar.lua:318), and the tooltip divides by it.
 */
export function frameXmlXpExhaustion(restedExperience: number | undefined): number | undefined {
  return restedExperience !== undefined && restedExperience > 0 ? restedExperience : undefined;
}

/**
 * `GetRestState`'s triple. MainMenuBar.lua:350-358 paints the bar blue for state 1 and purple for 2,
 * so 1 is «Rested» (double experience from kills) and 2 «Normal»; 3..5 are the exhaustion tiers
 * that never shipped. The state follows the rested bonus, not the inn: a character carries it out
 * of town, and `IsResting` says whether more is accruing.
 */
export function frameXmlRestState(restedExperience: number | undefined): readonly [number, string, number] {
  return frameXmlXpExhaustion(restedExperience) === undefined ? [2, "Normal", 1] : [1, "Rested", 2];
}

type LeaderGroup = Pick<GroupState, "groupType" | "leaderGuid" | "members">;

/** `GROUPTYPE_RAID` in Group.h; the same bit LiveWorldSeam's `party<n>` resolution stops at. */
const GROUPTYPE_RAID = 0x02;

/**
 * The leader's `party<n>` slot, following the seam's own `party1..4` numbering (the wire's member
 * order, which never lists the player). 0 is the client's answer when the player leads and, as a
 * party frame in a raid takes its rows from the sub-group instead, for a raid.
 */
export function frameXmlPartyLeaderIndex(group: LeaderGroup | undefined, selfGuid: bigint | undefined): number {
  if (!group || (group.groupType & GROUPTYPE_RAID) !== 0) return 0;
  if (selfGuid !== undefined && group.leaderGuid === selfGuid) return 0;
  const index = group.members.slice(0, 4).findIndex((member) => member.guid === group.leaderGuid);
  return index < 0 ? 0 : index + 1;
}

/** The dungeon finder's role byte (`SMSG_GROUP_LIST` carries one per member, and the player's own). */
export function frameXmlGroupRoles(roles: number | undefined): FrameXmlGroupRoles {
  if (!roles) return FRAMEXML_NO_GROUP_ROLES;
  return [(roles & LFG_ROLE_TANK) !== 0, (roles & LFG_ROLE_HEALER) !== 0, (roles & LFG_ROLE_DAMAGE) !== 0];
}

/** The world keeps marks as icon 0..7 → wearer; stock numbers them 1..8 (SetRaidTargetIconTexture). */
export function frameXmlRaidTargetIndex(
  marks: ReadonlyMap<number, bigint> | undefined,
  guid: bigint | undefined,
): number | undefined {
  if (!marks || guid === undefined || guid === 0n) return undefined;
  for (const [icon, wearer] of marks) if (wearer === guid) return icon + 1;
  return undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

function unitOf(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/** Lua truth: `SetOptOutOfLoot(1)` and `SetOptOutOfLoot(nil)` are the two stock calls (UnitPopup.lua). */
function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

export const FRAMEXML_PLAYER_STATUS_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  IsResting: (seam) => [seam.isResting?.() ?? false],
  GetXPExhaustion: (seam) => {
    const rested = seam.xpExhaustion?.();
    return rested === undefined ? NOTHING : [rested];
  },
  // The client's 1/nil rather than a boolean: BNet.lua:295-296 compares both with `== 1`, and
  // FriendsFrame.lua:2296 tests truth — a JS `true` would satisfy only the second.
  UnitIsAFK: (seam, args) => (seam.unitIsAFK?.(unitOf(args[0])) ? [1] : NOTHING),
  UnitIsDND: (seam, args) => (seam.unitIsDND?.(unitOf(args[0])) ? [1] : NOTHING),
  GetPartyLeaderIndex: (seam) => [seam.partyLeaderIndex?.() ?? 0],
  UnitGroupRolesAssigned: (seam, args) => [...(seam.unitGroupRoles?.(unitOf(args[0])) ?? FRAMEXML_NO_GROUP_ROLES)],
  GetOptOutOfLoot: (seam) => [seam.optOutOfLoot?.() ?? false],
  SetOptOutOfLoot: (seam, args) => {
    seam.setOptOutOfLoot?.(truthy(args[0]));
    return NOTHING;
  },
  GetRaidTargetIndex: (seam, args) => {
    const index = seam.raidTargetIndex?.(unitOf(args[0]));
    return index === undefined ? NOTHING : [index];
  },
});
