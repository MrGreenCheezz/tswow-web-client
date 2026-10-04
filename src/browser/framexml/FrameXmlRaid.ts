/**
 * The raid half of the stock FriendsFrame (tab 5, RaidFrame.xml): the roster answers, the saved
 * instance list behind «Информация о рейде» (RaidInfoFrame) and the RAID_ROSTER_UPDATE edge.
 *
 * RaidFrame.lua itself shows only «convert to raid» and the raid-info button; the group grid is the
 * load-on-demand Blizzard_RaidUI. The world mount's lazy owner (FrameXmlRaidLod.ts) takes
 * `RaidFrame_LoadUI` and loads it through the host at the first RAID_ROSTER_UPDATE — at once when the
 * player is already in a raid — and its RaidGroupFrame_Update draws the rows `GetRaidRosterInfo` below
 * answers; a leader's drag moves a member through `changeSubgroup`. Before that owner is published (and wherever it is not), the add-on runtime answers
 * LoadAddOn("Blizzard_RaidUI") with MISSING, FrameXmlFriendsOwner's adapter skips `RaidFrame_LoadUI`
 * (no «Ошибка загрузки» dialog), and `RaidGroupFrame_Update`/`RaidPullout_RenewFrames` are the stub
 * plan's no-ops: the tab shows no grid.
 *
 * Two wire facts shape the answers:
 *
 * * `SMSG_GROUP_LIST` lists every member *except the receiver* (TrinityCore
 *   `Group::SendUpdateToPlayer` skips the target's own slot), with the receiver's subgroup and flags
 *   in the header; the server's slot order for the player is not on the wire. Stock pairs
 *   `GetRaidRosterInfo(i)` with unit `raid<i>` for i = 1..GetNumRaidMembers() (PlayerFrame.lua:481,
 *   SecureTemplates.lua:884, TargetFrame.lua:662), and the world seam resolves `raid<i>` to the
 *   i-th listed member (LiveWorldSeam `#guidOnlyUnit`). So the listed members come first in wire
 *   order and the player is the row after them: `raid<i>` and row i name the same player for every i
 *   the seam counts. The world seam's `GetNumRaidMembers` counts the player too, as stock does (the
 *   listed members + 1, LiveWorldSeam `raidMemberCount`), and resolves `raid<N>`, the last row, to the
 *   player, so every row — the player's included — is inside stock's 1..N walks.
 * * `SMSG_RAID_INSTANCE_INFO` (`Player::SendRaidInfo`) carries map, difficulty, the 64-bit instance
 *   id, locked/extended and the seconds to reset. Stock splits the id into two 32-bit halves
 *   (`format("%x%x", instanceIDMostSig, instanceID)`, RaidFrame.lua:117) and names the difficulty
 *   with `difficultyName`; the Lua prelude fills that from `RAID_DIFFICULTYn`/`DUNGEON_DIFFICULTYn`.
 */
import type { GroupState } from "../../world/GroupProtocol.js";
import type { InstanceLockout } from "../../world/InstanceProtocol.js";

/** `GroupType` / `GroupMemberFlags` (Group.h). */
const GROUPTYPE_RAID = 0x02;
const MEMBER_FLAG_ASSISTANT = 0x01;
const MEMBER_FLAG_MAINTANK = 0x02;
const MEMBER_FLAG_MAINASSIST = 0x04;
/** `MAX_RAID_SUBGROUPS`, `MAX_GROUP_SIZE` (Group.h). */
const RAID_SUBGROUPS = 8;
const RAID_SUBGROUP_SIZE = 5;
/** `Map.InstanceType` 2 (MapInfo). */
const MAP_RAID = 2;

/** The world facts and commands the raid model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlRaidWorld {
  readonly group?: GroupState | undefined;
  readonly lockouts?: readonly InstanceLockout[] | undefined;
  readonly state: { readonly selfGuid?: bigint | undefined };
  displayName(guid: bigint): string;
  convertToRaid?(): void;
  /** CMSG_GROUP_CHANGE_SUB_GROUP: a member by name into a 0-based subgroup. */
  changeSubGroup?(name: string, subGroup: number): void;
  requestRaidInfo?(): void;
  setSavedInstanceExtend?(mapId: number, difficulty: number, extend: boolean): void;
}

/** One group member's live facts, when the host can see them (level, class, zone, death). */
export interface FrameXmlRaidMemberFacts {
  readonly level?: number | undefined;
  readonly classId?: number | undefined;
  readonly areaId?: number | undefined;
  readonly dead?: boolean | undefined;
}

export interface FrameXmlRaidContext {
  world(): FrameXmlRaidWorld | undefined;
  mapInfo?(mapId: number): { readonly name: string; readonly instanceType: number } | undefined;
  areaName?(areaId: number): string | undefined;
  /** L3-review: `female` picks the sexed name (Wow.exe 0x7159e0); undefined, `Name_lang`. */
  classInfo?(classId: number, female?: boolean): readonly [name: string, token: string] | undefined;
  /** L3-review: a character's sex as the name cache holds it (0x573690/0x6b4130 read +0x144). */
  female?(guid: bigint): boolean | undefined;
  memberFacts?(guid: bigint): FrameXmlRaidMemberFacts | undefined;
  playerName?(): string | undefined;
}

interface RaidPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

interface RaidRow {
  readonly guid: bigint;
  readonly name: string;
  readonly subGroup: number;
  readonly flags: number;
  readonly online: boolean;
}

export class FrameXmlRaidModel {
  readonly #context: FrameXmlRaidContext;
  #pump: RaidPump | undefined;
  #muted = false;
  #rosterSeen = "";
  #lockoutsSeen: readonly InstanceLockout[] | undefined;

  constructor(context: FrameXmlRaidContext) {
    this.#context = context;
  }

  attach(pump: RaidPump): void {
    this.#pump = pump;
    this.#rosterSeen = this.#rosterSignature();
    this.#lockoutsSeen = this.#context.world()?.lockouts;
  }

  detach(): void {
    this.#pump = undefined;
  }

  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  #inRaid(): GroupState | undefined {
    const group = this.#context.world()?.group;
    return group && (group.groupType & GROUPTYPE_RAID) !== 0 ? group : undefined;
  }

  #rows(): RaidRow[] {
    const world = this.#context.world();
    const group = this.#inRaid();
    if (!world || !group) return [];
    const self = world.state.selfGuid ?? 0n;
    // Wire order, then the player (see the module doc): row i is unit raid<i> for every listed member.
    const rows: RaidRow[] = group.members.map((member) => ({
      guid: member.guid, name: member.name, subGroup: member.subGroup, flags: member.flags, online: member.online,
    }));
    // TrinityCore never lists the receiver; should a list carry it anyway, its wire row stands.
    if (!rows.some((row) => row.guid === self)) rows.push({
      guid: self, name: this.#context.playerName?.() ?? world.displayName(self),
      subGroup: group.ownSubGroup, flags: group.ownFlags, online: true,
    });
    return rows;
  }

  isRaidLeader(): boolean {
    const group = this.#inRaid();
    const self = this.#context.world()?.state.selfGuid;
    return group !== undefined && self !== undefined && group.leaderGuid === self;
  }

  isRaidOfficer(): boolean {
    const group = this.#inRaid();
    return group !== undefined && (this.isRaidLeader() || (group.ownFlags & MEMBER_FLAG_ASSISTANT) !== 0);
  }

  /**
   * `GetRaidRosterInfo(i)`: name, rank (2 leader, 1 assistant, 0), subgroup (1-8), level, class,
   * fileName, zone, online, isDead, role ("MAINTANK"/"MAINASSIST"), isML.
   */
  rosterInfo(index: number): readonly unknown[] | undefined {
    const row = Number.isInteger(index) && index >= 1 ? this.#rows()[index - 1] : undefined;
    const group = this.#inRaid();
    if (!row || !group) return undefined;
    const facts = this.#context.memberFacts?.(row.guid);
    const classInfo = facts?.classId === undefined ? undefined
      : this.#context.classInfo?.(facts.classId, this.#context.female?.(row.guid)); // L3-review: 0x573690's sex
    const rank = group.leaderGuid === row.guid ? 2 : (row.flags & MEMBER_FLAG_ASSISTANT) !== 0 ? 1 : 0;
    const role = (row.flags & MEMBER_FLAG_MAINTANK) !== 0 ? "MAINTANK"
      : (row.flags & MEMBER_FLAG_MAINASSIST) !== 0 ? "MAINASSIST" : undefined;
    const zone = facts?.areaId === undefined ? undefined : this.#context.areaName?.(facts.areaId);
    return [
      row.name, rank, row.subGroup + 1, facts?.level ?? 0, classInfo?.[0], classInfo?.[1], zone,
      row.online, facts?.dead === true, role, group.masterLooterGuid !== 0n && group.masterLooterGuid === row.guid,
    ];
  }

  convertToRaid(): void {
    if (!this.#muted) this.#context.world()?.convertToRaid?.();
  }

  /**
   * `SetRaidSubgroup(i, group)` (Blizzard_RaidUI's drag, FrameXmlRaidLodApi.ts): row i's name and
   * the 0-based group in CMSG_GROUP_CHANGE_SUB_GROUP. TrinityCore's handler drops a request from
   * anyone but the leader or an assistant, into a full group or into the member's own group, and
   * answers the rest with an SMSG_GROUP_LIST (`Group::ChangeMembersGroup` → `SendUpdate`); those
   * refusals are not sent. True when the request went out: the roster moves when the list arrives.
   */
  changeSubgroup(index: number, subgroup: number): boolean {
    const world = this.#context.world();
    const rows = this.#rows();
    const row = Number.isInteger(index) && index >= 1 ? rows[index - 1] : undefined;
    if (this.#muted || !row || !world?.changeSubGroup || !this.isRaidOfficer()
      || !Number.isInteger(subgroup) || subgroup < 1 || subgroup > RAID_SUBGROUPS) return false;
    const target = subgroup - 1;
    if (row.subGroup === target
      || rows.filter((member) => member.subGroup === target).length >= RAID_SUBGROUP_SIZE) return false;
    world.changeSubGroup(row.name, target);
    return true;
  }

  requestRaidInfo(): void {
    if (!this.#muted) this.#context.world()?.requestRaidInfo?.();
  }

  numSavedInstances(): number { return this.#context.world()?.lockouts?.length ?? 0; }

  /**
   * `GetSavedInstanceInfo(i)`: name, id, reset, difficulty, locked, extended, idMostSig, isRaid,
   * maxPlayers. `difficultyName` is appended by the Lua prelude. `maxPlayers` follows Wrath's raid
   * difficulties (0/2 ten players, 1/3 twenty-five); dungeons are five.
   */
  savedInstanceInfo(index: number): readonly unknown[] | undefined {
    const lockout = Number.isInteger(index) && index >= 1 ? this.#context.world()?.lockouts?.[index - 1] : undefined;
    if (!lockout) return undefined;
    const map = this.#context.mapInfo?.(lockout.mapId);
    const isRaid = map?.instanceType === MAP_RAID;
    const id = lockout.instanceId & 0xffffffffn;
    const mostSig = (lockout.instanceId >> 32n) & 0xffffffffn;
    const maxPlayers = isRaid ? (lockout.difficulty % 2 === 0 ? 10 : 25) : 5;
    return [map?.name ?? String(lockout.mapId), Number(id), lockout.secondsUntilReset, lockout.difficulty,
      lockout.active, lockout.extended, Number(mostSig), isRaid, maxPlayers];
  }

  /** `SetSavedInstanceExtend(i, extend)`: CMSG_SET_SAVED_INSTANCE_EXTEND by map and difficulty. */
  setSavedInstanceExtend(index: number, extend: boolean): void {
    const lockout = Number.isInteger(index) && index >= 1 ? this.#context.world()?.lockouts?.[index - 1] : undefined;
    if (!lockout || this.#muted) return;
    this.#context.world()?.setSavedInstanceExtend?.(lockout.mapId, lockout.difficulty, extend);
  }

  #rosterSignature(): string {
    const group = this.#inRaid();
    if (!group) return "";
    return [group.leaderGuid, group.ownSubGroup, group.ownFlags, group.masterLooterGuid,
      ...group.members.map((member) => `${member.guid}:${member.subGroup}:${member.flags}:${Number(member.online)}`)].join("|");
  }

  /**
   * The 60 ms poll's raid half. The client fires RAID_ROSTER_UPDATE for every group list while in
   * a raid and once more when it leaves one; PARTY_MEMBERS_CHANGED stays the seam's own edge.
   * A new lockout list (`SMSG_RAID_INSTANCE_INFO`) is UPDATE_INSTANCE_INFO, which RaidFrame reads.
   */
  tick(): void {
    const pump = this.#pump;
    if (!pump) return;
    const roster = this.#rosterSignature();
    if (roster !== this.#rosterSeen) {
      this.#rosterSeen = roster;
      pump.fire("RAID_ROSTER_UPDATE");
    }
    const lockouts = this.#context.world()?.lockouts;
    if (lockouts !== this.#lockoutsSeen) {
      this.#lockoutsSeen = lockouts;
      pump.fire("UPDATE_INSTANCE_INFO");
    }
  }
}

export type FrameXmlRaidCall = (raid: FrameXmlRaidModel, args: readonly unknown[]) => readonly unknown[] | undefined;

const NOTHING: readonly [] = Object.freeze([]);

function integerArg(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) ? number : undefined;
}

/**
 * The raid C API. `GetNumRaidMembers` stays the world seam's own binding (FrameXmlWorldSeam.ts);
 * `GetSavedInstanceInfo` is the flat `WebClientSavedInstanceInfo` plus the prelude's difficulty name.
 */
export const FRAMEXML_RAID_CALLS: Readonly<Record<string, FrameXmlRaidCall>> = Object.freeze({
  GetRaidRosterInfo: (raid, args) => raid.rosterInfo(integerArg(args[0]) ?? 0),
  IsRaidLeader: (raid) => [raid.isRaidLeader()],
  IsRaidOfficer: (raid) => [raid.isRaidOfficer()],
  ConvertToRaid: (raid) => { raid.convertToRaid(); return NOTHING; },
  RequestRaidInfo: (raid) => { raid.requestRaidInfo(); return NOTHING; },
  GetNumSavedInstances: (raid) => [raid.numSavedInstances()],
  WebClientSavedInstanceInfo: (raid, args) => raid.savedInstanceInfo(integerArg(args[0]) ?? 0),
  SetSavedInstanceExtend: (raid, args) => {
    const extend = args[1];
    raid.setSavedInstanceExtend(integerArg(args[0]) ?? 0, extend !== undefined && extend !== null && extend !== false);
    return NOTHING;
  },
});
