import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: Group.cpp `SendUpdateToPlayer`,
// GroupHandler.cpp (`SendPartyResult`, the invite, accept, uninvite and disband handlers)
// and PartyPackets.cpp (`PartyInvite::Write`, `PartyInviteClient::Read`).

/** `GroupType` in Group.h. The LFG bit adds two fields to the group list. */
export const GROUPTYPE_RAID = 0x02;
export const GROUPTYPE_LFG = 0x08;

/** `LootMethod` in LootMgr.h, in the order `CMSG_LOOT_METHOD` numbers them. */
export const LOOT_METHOD_FREE_FOR_ALL = 0;
export const LOOT_METHOD_ROUND_ROBIN = 1;
export const LOOT_METHOD_MASTER = 2;
export const LOOT_METHOD_GROUP = 3;
export const LOOT_METHOD_NEED_BEFORE_GREED = 4;

/** Five to a subgroup, eight subgroups: `MAX_RAID_SUBGROUPS` in Group.h. */
export const RAID_SUBGROUPS = 8;
export const RAID_SUBGROUP_SIZE = 5;

/** `GroupMemberStatusFlag` in Group.h. */
export const MEMBER_STATUS_ONLINE = 0x01;
export const MEMBER_STATUS_PVP = 0x02;

/** `GroupMemberFlags` in Group.h. */
export const MEMBER_FLAG_ASSISTANT = 0x01;
export const MEMBER_FLAG_MAINTANK = 0x02;
export const MEMBER_FLAG_MAINASSIST = 0x04;

export interface GroupMember {
  name: string;
  guid: bigint;
  online: boolean;
  status: number;
  subGroup: number;
  flags: number;
  roles: number;
}

export interface GroupState {
  groupType: number;
  ownSubGroup: number;
  ownFlags: number;
  ownRoles: number;
  guid: bigint;
  /** Increases on every update the server sends. */
  counter: number;
  members: GroupMember[];
  leaderGuid: bigint;
  lootMethod: number;
  masterLooterGuid: bigint;
  lootThreshold: number;
  dungeonDifficulty: number;
  raidDifficulty: number;
  /**
   * 5.28 (L6): the block's last byte, `raidDifficulty >= RAID_DIFFICULTY_10MAN_HEROIC` (Group.cpp:2091);
   * Wow.exe keeps it as the player difficulty GetInstanceInfo answers sixth (0x6d8fd0 → 0x00bd1980).
   * Undefined when the block or the byte is absent.
   */
  raidHeroic?: number;
}

/** The member list excludes the receiving player, so `members` is one short of the real size. */
export function parseGroupList(payload: Uint8Array): GroupState {
  const reader = new PacketReader(payload);
  const groupType = reader.u8();
  const ownSubGroup = reader.u8();
  const ownFlags = reader.u8();
  const ownRoles = reader.u8();
  if (groupType & GROUPTYPE_LFG) {
    reader.u8();
    reader.u32();
  }
  const guid = reader.u64();
  const counter = reader.u32();
  const count = reader.u32();
  if (count > 40) throw new RangeError(`Group list declares ${count} members`);
  const members: GroupMember[] = [];
  for (let index = 0; index < count; index++) {
    const name = reader.cString();
    const memberGuid = reader.u64();
    const status = reader.u8();
    members.push({
      name,
      guid: memberGuid,
      online: (status & MEMBER_STATUS_ONLINE) !== 0,
      status,
      subGroup: reader.u8(),
      flags: reader.u8(),
      roles: reader.u8(),
    });
  }
  const leaderGuid = reader.u64();
  const state: GroupState = {
    groupType, ownSubGroup, ownFlags, ownRoles, guid, counter, members, leaderGuid,
    lootMethod: 0, masterLooterGuid: 0n, lootThreshold: 0, dungeonDifficulty: 0, raidDifficulty: 0,
  };
  // The loot and difficulty block is only written when the group still has other members.
  if (count > 0 && reader.remaining >= 12) {
    state.lootMethod = reader.u8();
    state.masterLooterGuid = reader.u64();
    state.lootThreshold = reader.u8();
    state.dungeonDifficulty = reader.u8();
    state.raidDifficulty = reader.u8();
    if (reader.remaining >= 1) state.raidHeroic = reader.u8(); // 5.28 (L6)
  }
  return state;
}

export interface GroupInvite {
  canAccept: boolean;
  inviterName: string;
  proposedRoles: number;
}

export function parseGroupInvite(payload: Uint8Array): GroupInvite {
  const reader = new PacketReader(payload);
  const canAccept = reader.u8() !== 0;
  const inviterName = reader.cString();
  const proposedRoles = reader.u32();
  return { canAccept, inviterName, proposedRoles };
}

export interface PartyCommandResult {
  operation: number;
  member: string;
  result: number;
  value: number;
}

export function parsePartyCommandResult(payload: Uint8Array): PartyCommandResult {
  const reader = new PacketReader(payload);
  const operation = reader.u32();
  const member = reader.cString();
  const result = reader.u32();
  const value = reader.u32();
  reader.assertFinished();
  return { operation, member, result, value };
}

/** `SMSG_GROUP_DECLINE` carries only the name of whoever refused. */
export function parseGroupDecline(payload: Uint8Array): string {
  return new PacketReader(payload).cString();
}

export function buildGroupInvite(name: string, proposedRoles = 0): Uint8Array {
  return new PacketWriter().cString(name).u32(proposedRoles).toUint8Array();
}

/** `HandleGroupAcceptOpcode` skips a uint32 it never reads. */
export function buildGroupAccept(): Uint8Array {
  return new PacketWriter().u32(0).toUint8Array();
}

export function buildGroupUninvite(guid: bigint, reason = ""): Uint8Array {
  return new PacketWriter().u64(guid).cString(reason).toUint8Array();
}

/** `HandleGroupSetLeaderOpcode`: a raw guid and nothing else. */
export function buildGroupSetLeader(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

/**
 * `HandleLootMethodOpcode`: method, master and threshold, in that order.
 *
 * The three come back in the same order at the tail of `SMSG_GROUP_LIST`, which is the only place
 * a client can read what the loot rules currently are.
 */
export function buildLootMethod(method: number, masterGuid: bigint, threshold: number): Uint8Array {
  return new PacketWriter().u32(method).u64(masterGuid).u32(threshold).toUint8Array();
}

/** `HandleGroupRaidConvertOpcode` reads nothing; the server needs two members and a leader. */
export function buildGroupRaidConvert(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

/** `HandleGroupAssistantLeaderOpcode`: whom, and whether the flag goes on or off. */
export function buildGroupAssistantLeader(guid: bigint, apply: boolean): Uint8Array {
  return new PacketWriter().u64(guid).u8(apply ? 1 : 0).toUint8Array();
}

/** `HandleGroupChangeSubGroupOpcode` moves by **name**, not by guid, and the subgroup is a byte. */
export function buildGroupChangeSubGroup(name: string, subGroup: number): Uint8Array {
  return new PacketWriter().cString(name).u8(subGroup & 0xff).toUint8Array();
}

/** `HandleRequestPartyMemberStatsOpcode`: a raw guid. */
export function buildRequestPartyMemberStats(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

const LOOT_METHOD_NAMES: Record<number, string> = {
  [LOOT_METHOD_FREE_FOR_ALL]: "Свободно для всех",
  [LOOT_METHOD_ROUND_ROBIN]: "По очереди",
  [LOOT_METHOD_MASTER]: "Ответственный за добычу",
  [LOOT_METHOD_GROUP]: "Групповая",
  [LOOT_METHOD_NEED_BEFORE_GREED]: "«Нужно» перед «хочу»",
};

export function lootMethodName(method: number): string {
  return LOOT_METHOD_NAMES[method] ?? `Способ ${method}`;
}

/** The quality at and above which an item goes to a roll rather than to the round robin. */
const LOOT_THRESHOLD_NAMES = ["Бедный", "Обычный", "Необычный", "Редкий", "Эпический", "Легендарный", "Артефакт"];

export function lootThresholdName(threshold: number): string {
  return LOOT_THRESHOLD_NAMES[threshold] ?? `Качество ${threshold}`;
}

/**
 * `PartyResult::ERR_VOTE_KICK_REASON_NEEDED` (SharedDefines.h): a vote-kick in a dungeon-finder group
 * asked for without a reason. Wow.exe's SMSG_PARTY_COMMAND_RESULT handler (0x6cbec0, case 0x1b) prints
 * nothing for it and fires VOTE_KICK_REASON_NEEDED with the packet's name instead; LFDFrame.lua then
 * opens VOTE_BOOT_REASON_REQUIRED, whose OK calls UninviteUnit(name, reason). TrinityCore never sends
 * it (its LFG starts the vote with an empty reason, LFGScripts.cpp:190-197); another core may.
 */
export const ERR_VOTE_KICK_REASON_NEEDED = 27;

// `PartyResult` in SharedDefines.h.
const PARTY_RESULTS: Record<number, string> = {
  0: "Готово",
  1: "Игрок не найден",
  2: "Игрок не в вашей группе",
  3: "Игрок не в подземелье",
  4: "Группа заполнена",
  5: "Игрок уже в группе",
  6: "Вы не в группе",
  7: "Вы не лидер группы",
  8: "Игрок из другой фракции",
  9: "Игрок вас игнорирует",
  12: "Ожидание поиска подземелья",
  13: "Приглашение ограничено",
  14: "Нельзя приглашать в бою",
  17: "Группа занята",
  18: "Имя неоднозначно",
  25: "Не подходит по уровню",
  27: "Нужна причина исключения",
};

export function partyResultText(result: number, member: string): string {
  const text = PARTY_RESULTS[result] ?? `Ошибка группы (код ${result})`;
  return member ? `${member}: ${text}` : text;
}
