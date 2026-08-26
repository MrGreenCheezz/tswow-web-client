import { OPCODES } from "../generated/opcodes.js";
import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: GroupHandler.cpp
// (`BuildPartyMemberStatsChangedPacket`, `HandleRequestPartyMemberStatsOpcode`, the ready check,
// the minimap ping and the raid target handlers), Group.cpp (`ChangeLeader`, `SetTargetIcon`,
// `SendTargetIconList`, `SendOriginalGroupUpdateToPlayer`, `OfflineReadyCheck`) and
// MiscPackets.cpp `RandomRoll::Write`.
//
// The guid rule for this whole slice: a bare `data << guid` streams the full eight bytes, and only
// `GetPackGUID()` / `WriteAsPacked()` packs. In this family only the two member-stats packets pack;
// every other guid here is eight bytes.

/** `GroupUpdateFlags` in Group.h. The bit order is the write order, so a reader walks bits 0..19. */
export const GROUP_UPDATE_STATUS = 0x00000001;
export const GROUP_UPDATE_CUR_HP = 0x00000002;
export const GROUP_UPDATE_MAX_HP = 0x00000004;
export const GROUP_UPDATE_POWER_TYPE = 0x00000008;
export const GROUP_UPDATE_CUR_POWER = 0x00000010;
export const GROUP_UPDATE_MAX_POWER = 0x00000020;
export const GROUP_UPDATE_LEVEL = 0x00000040;
export const GROUP_UPDATE_ZONE = 0x00000080;
export const GROUP_UPDATE_POSITION = 0x00000100;
export const GROUP_UPDATE_AURAS = 0x00000200;
export const GROUP_UPDATE_PET_GUID = 0x00000400;
export const GROUP_UPDATE_PET_NAME = 0x00000800;
export const GROUP_UPDATE_PET_MODEL_ID = 0x00001000;
export const GROUP_UPDATE_PET_CUR_HP = 0x00002000;
export const GROUP_UPDATE_PET_MAX_HP = 0x00004000;
export const GROUP_UPDATE_PET_POWER_TYPE = 0x00008000;
export const GROUP_UPDATE_PET_CUR_POWER = 0x00010000;
export const GROUP_UPDATE_PET_MAX_POWER = 0x00020000;
export const GROUP_UPDATE_PET_AURAS = 0x00040000;
export const GROUP_UPDATE_VEHICLE_SEAT = 0x00080000;

/** `GroupMemberOnlineStatus` in Group.h. `GroupProtocol` names the two the group list needs. */
export const MEMBER_STATUS_OFFLINE = 0x0000;
export const MEMBER_STATUS_DEAD = 0x0004;
export const MEMBER_STATUS_GHOST = 0x0008;
export const MEMBER_STATUS_PVP_FFA = 0x0010;
export const MEMBER_STATUS_AFK = 0x0040;
export const MEMBER_STATUS_DND = 0x0080;

/** `MAX_AURAS_GROUP_UPDATE` in SpellAuraDefines.h: the aura mask is exactly this many bits. */
export const MAX_AURAS_GROUP_UPDATE = 64;

export interface PartyMemberAura {
  /** Which of the 64 raid aura slots this entry came from. */
  slot: number;
  /**
   * Zero means the slot was cleared. `SMSG_PARTY_MEMBER_STATS` names a changed slot in the mask
   * whether or not an aura is still in it, so an emptied slot arrives as a real entry with no
   * spell; the `_FULL` reply enumerates only occupied slots and never writes one.
   */
  spellId: number;
  /**
   * `AuraApplication::GetFlags`, except in the player aura block of `SMSG_PARTY_MEMBER_STATS`,
   * where the core writes a hardcoded 1. The pet block next to it writes the real flags, so the
   * inconsistency is the core's, not a misread.
   */
  flags: number;
}

/**
 * What one member-stats packet carried. Every field is optional because every field is behind its
 * own mask bit: there is no fixed body beyond the guid and the mask, and a packet that moves one
 * number carries only that number.
 */
export interface PartyMemberStats {
  guid: bigint;
  /** The mask as it arrived. A field is absent here exactly when its bit was clear. */
  flags: number;
  status?: number;
  health?: number;
  maxHealth?: number;
  powerType?: number;
  power?: number;
  maxPower?: number;
  level?: number;
  zoneId?: number;
  /**
   * The server truncates the world coordinate to an unsigned 16-bit integer, so this is neither
   * signed nor fractional: a member standing at a negative coordinate reports a large number.
   * Kept raw — pretending it is a position would invent precision the wire does not carry.
   */
  positionX?: number;
  positionY?: number;
  auraMask?: bigint;
  auras?: PartyMemberAura[];
  petGuid?: bigint;
  petName?: string;
  petDisplayId?: number;
  petHealth?: number;
  petMaxHealth?: number;
  petPowerType?: number;
  petPower?: number;
  petMaxPower?: number;
  petAuraMask?: bigint;
  petAuras?: PartyMemberAura[];
  vehicleSeat?: number;
}

function readAuraBlock(reader: PacketReader): { mask: bigint; auras: PartyMemberAura[] } {
  const mask = reader.u64();
  const auras: PartyMemberAura[] = [];
  for (let slot = 0; slot < MAX_AURAS_GROUP_UPDATE; slot++) {
    if ((mask & (1n << BigInt(slot))) === 0n) continue;
    auras.push({ slot, spellId: reader.u32(), flags: reader.u8() });
  }
  return { mask, auras };
}

/**
 * `SMSG_PARTY_MEMBER_STATS` and `SMSG_PARTY_MEMBER_STATS_FULL` are the same walk over the same
 * mask; the `_FULL` reply only puts one byte in front of the guid. Reading that byte as part of
 * the packed guid shifts the whole packet.
 *
 * The reply to an unknown or offline guid is the same shape and stops after the status word: mask
 * `GROUP_UPDATE_STATUS` alone, status `MEMBER_STATUS_OFFLINE`. That falls out of the mask walk
 * rather than needing a branch.
 */
export function parsePartyMemberStats(payload: Uint8Array, full: boolean): PartyMemberStats {
  const reader = new PacketReader(payload);
  if (full) reader.u8();
  const guid = reader.packedGuid();
  const flags = reader.u32();
  const stats: PartyMemberStats = { guid, flags };

  if (flags & GROUP_UPDATE_STATUS) stats.status = reader.u16();
  if (flags & GROUP_UPDATE_CUR_HP) stats.health = reader.u32();
  if (flags & GROUP_UPDATE_MAX_HP) stats.maxHealth = reader.u32();
  if (flags & GROUP_UPDATE_POWER_TYPE) stats.powerType = reader.u8();
  if (flags & GROUP_UPDATE_CUR_POWER) stats.power = reader.u16();
  if (flags & GROUP_UPDATE_MAX_POWER) stats.maxPower = reader.u16();
  // Level and both powers are widened on the wire: the level is a byte everywhere else.
  if (flags & GROUP_UPDATE_LEVEL) stats.level = reader.u16();
  if (flags & GROUP_UPDATE_ZONE) stats.zoneId = reader.u16();
  if (flags & GROUP_UPDATE_POSITION) {
    stats.positionX = reader.u16();
    stats.positionY = reader.u16();
  }
  if (flags & GROUP_UPDATE_AURAS) {
    const block = readAuraBlock(reader);
    stats.auraMask = block.mask;
    stats.auras = block.auras;
  }
  // No single "has a pet" bit: each pet field has its own, and a member without a pet still sends
  // whichever of them the mask names, as a zero or an empty name.
  if (flags & GROUP_UPDATE_PET_GUID) stats.petGuid = reader.u64();
  if (flags & GROUP_UPDATE_PET_NAME) stats.petName = reader.cString();
  if (flags & GROUP_UPDATE_PET_MODEL_ID) stats.petDisplayId = reader.u16();
  if (flags & GROUP_UPDATE_PET_CUR_HP) stats.petHealth = reader.u32();
  if (flags & GROUP_UPDATE_PET_MAX_HP) stats.petMaxHealth = reader.u32();
  if (flags & GROUP_UPDATE_PET_POWER_TYPE) stats.petPowerType = reader.u8();
  if (flags & GROUP_UPDATE_PET_CUR_POWER) stats.petPower = reader.u16();
  if (flags & GROUP_UPDATE_PET_MAX_POWER) stats.petMaxPower = reader.u16();
  if (flags & GROUP_UPDATE_PET_AURAS) {
    const block = readAuraBlock(reader);
    stats.petAuraMask = block.mask;
    stats.petAuras = block.auras;
  }
  if (flags & GROUP_UPDATE_VEHICLE_SEAT) stats.vehicleSeat = reader.u32();
  return stats;
}

/** Folds a new packet onto what is already known, so a one-field update does not erase the rest. */
export function mergePartyMemberStats(held: PartyMemberStats | undefined, fresh: PartyMemberStats): PartyMemberStats {
  if (!held) return fresh;
  const merged: PartyMemberStats = { ...held, ...fresh };
  merged.flags = held.flags | fresh.flags;
  return merged;
}

/**
 * `SMSG_GROUP_SET_LEADER` carries the new leader's name and nothing else — no guid at all, which
 * is why the group list has to be matched by name when this arrives on its own.
 */
export function parseGroupSetLeader(payload: Uint8Array): string {
  return new PacketReader(payload).cString();
}

export interface RealGroupUpdate {
  groupType: number;
  /** The core writes `GetMembersCount() - 1`: the receiving player is not counted. */
  otherMembers: number;
  leaderGuid: bigint;
}

/**
 * The packet that tells an addon how big the player's *real* party is while they stand in a
 * battleground or dungeon-finder sub-group. Leaving one is announced with group type 0x10, no
 * members and an empty leader.
 */
export function parseRealGroupUpdate(payload: Uint8Array): RealGroupUpdate {
  const reader = new PacketReader(payload);
  const groupType = reader.u8();
  const otherMembers = reader.u32();
  const leaderGuid = reader.u64();
  reader.assertFinished();
  return { groupType, otherMembers, leaderGuid };
}

/** `MSG_RAID_READY_CHECK` from the server is the initiator's guid, full width. */
export function parseReadyCheckStart(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  reader.assertFinished();
  return guid;
}

export interface ReadyCheckAnswer {
  guid: bigint;
  ready: boolean;
}

/**
 * The answers come back on a different opcode from the question — `MSG_RAID_READY_CHECK_CONFIRM`,
 * which the core declares `Handle_NULL` and therefore refuses from a client, while sending it from
 * two places. `Group::OfflineReadyCheck` answers for everyone absent the moment the check starts,
 * so the first confirmations usually arrive before any person has pressed anything.
 */
export function parseReadyCheckAnswer(payload: Uint8Array): ReadyCheckAnswer {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const ready = reader.u8() !== 0;
  reader.assertFinished();
  return { guid, ready };
}

/** `TARGET_ICONS_COUNT` in Group.h. */
export const RAID_TARGET_ICON_COUNT = 8;

export interface RaidTargetUpdate {
  /** True for the whole list, false for a single icon moving. */
  whole: boolean;
  /** Who set the icon. Zero on the clearing packet the server sends before a reassignment. */
  setterGuid: bigint;
  icons: Array<{ icon: number; guid: bigint }>;
}

/**
 * Two shapes behind one leading byte. The list form has no count and no terminator: empty slots
 * are skipped entirely and the entries simply run to the end of the packet, so it is read by what
 * is left rather than by a counter.
 *
 * Moving an icon that is already on another unit produces two packets, not one: the core calls
 * itself first to clear the old slot, and that clearing packet has a zero setter and a zero target.
 */
export function parseRaidTargetUpdate(payload: Uint8Array): RaidTargetUpdate {
  const reader = new PacketReader(payload);
  const whole = reader.u8() === 1;
  if (!whole) {
    const setterGuid = reader.u64();
    const icon = reader.u8();
    const guid = reader.u64();
    reader.assertFinished();
    return { whole: false, setterGuid, icons: [{ icon, guid }] };
  }
  const icons: Array<{ icon: number; guid: bigint }> = [];
  while (reader.remaining >= 9) icons.push({ icon: reader.u8(), guid: reader.u64() });
  reader.assertFinished();
  return { whole: true, setterGuid: 0n, icons };
}

export interface MinimapPing {
  guid: bigint;
  x: number;
  y: number;
}

/**
 * Real floats here, unlike the coordinates in the member-stats packets. The guid is not always a
 * player: a Sentry Totem pings its owner with its own creature guid when it starts attacking.
 */
export function parseMinimapPing(payload: Uint8Array): MinimapPing {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const x = reader.f32();
  const y = reader.f32();
  reader.assertFinished();
  return { guid, x, y };
}

export interface RandomRoll {
  minimum: number;
  maximum: number;
  result: number;
  rollerGuid: bigint;
}

/** The result sits between the range and the roller, not at the end. */
export function parseRandomRoll(payload: Uint8Array): RandomRoll {
  const reader = new PacketReader(payload);
  const minimum = reader.u32();
  const maximum = reader.u32();
  const result = reader.u32();
  const rollerGuid = reader.u64();
  reader.assertFinished();
  return { minimum, maximum, result, rollerGuid };
}

/** An empty body starts a ready check; only a leader or an assistant may. */
export function buildReadyCheckRequest(): Uint8Array {
  return new Uint8Array(0);
}

/** One byte answers one. */
export function buildReadyCheckAnswer(ready: boolean): Uint8Array {
  return new PacketWriter().u8(ready ? 1 : 0).toUint8Array();
}

/** Ending the check is empty in both directions. */
export function buildReadyCheckFinished(): Uint8Array {
  return new Uint8Array(0);
}

/** `0xFF` asks for the whole icon list; anything else is an assignment. */
export function buildRaidTargetQuery(): Uint8Array {
  return new PacketWriter().u8(0xff).toUint8Array();
}

export function buildSetRaidTarget(icon: number, guid: bigint): Uint8Array {
  return new PacketWriter().u8(icon).u64(guid).toUint8Array();
}

/** The client sends the two coordinates; the server prepends the pinger's guid before relaying. */
export function buildMinimapPing(x: number, y: number): Uint8Array {
  return new PacketWriter().f32(x).f32(y).toUint8Array();
}

/** The server drops the request silently when the range is backwards or the maximum exceeds 10000. */
export function buildRandomRoll(minimum: number, maximum: number): Uint8Array {
  return new PacketWriter().u32(minimum).u32(maximum).toUint8Array();
}

/** `GroupMemberAssignment` in Group.h. */
export const GROUP_ASSIGN_MAINTANK = 0;
export const GROUP_ASSIGN_MAINASSIST = 1;

/**
 * The one opcode of this slice the server never sends. It reads this body and answers with
 * `SMSG_GROUP_LIST` carrying the changed member flags, so main tank and main assist are learned
 * from the group list and never from an echo of this packet.
 */
export function buildPartyAssignment(assignment: number, apply: boolean, guid: bigint): Uint8Array {
  return new PacketWriter().u8(assignment).u8(apply ? 1 : 0).u64(guid).toUint8Array();
}

const RAID_TARGET_NAMES = [
  "Звезда", "Круг", "Ромб", "Треугольник", "Полумесяц", "Квадрат", "Крест", "Череп",
];

export function raidTargetName(icon: number): string {
  return RAID_TARGET_NAMES[icon] ?? `Метка ${icon + 1}`;
}

/** Which of the two stats opcodes this is; the `_FULL` reply has the extra leading byte. */
export function isPartyMemberStatsFull(opcode: number): boolean {
  return opcode === OPCODES.SMSG_PARTY_MEMBER_STATS_FULL;
}
