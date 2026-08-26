import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: Group.cpp `SendLootStartRoll`,
// `SendLootStartRollToPlayer`, `SendLootRoll`, `SendLootRollWon`, `SendLootAllPassed`,
// `MasterLoot` and `SendLooter`, plus the second `SMSG_LOOT_LIST` builder in Unit.cpp for a kill
// with no group behind it.

/**
 * `RollType` in Loot.h — what a player pressed, and what the winner won with. Not to be confused
 * with `RollVote` in Group.h, which is the server's own bookkeeping and shares these four values
 * before adding two that never reach the wire.
 */
export const ROLL_PASS = 0;
export const ROLL_NEED = 1;
export const ROLL_GREED = 2;
export const ROLL_DISENCHANT = 3;

/** `RollMask` in Loot.h — which of the four buttons the window offers. */
export const ROLL_FLAG_PASS = 0x01;
export const ROLL_FLAG_NEED = 0x02;
export const ROLL_FLAG_GREED = 0x04;
export const ROLL_FLAG_DISENCHANT = 0x08;

/**
 * `rollNumber` is not always a number. Zero means "you chose need on this", 128 announces a choice
 * with no dice behind it — a pass, a greed, a disenchant — and 1 to 100 is a real roll.
 */
export const ROLL_NUMBER_ANNOUNCEMENT = 128;

export interface LootRollStart {
  /**
   * A guid minted for this roll alone, in the item range. It is not the guid of any item that
   * exists: the client echoes it back in `CMSG_LOOT_ROLL` and nothing else uses it.
   */
  itemGuid: bigint;
  mapId: number;
  itemSlot: number;
  itemId: number;
  randomSuffix: number;
  /** Signed: a rolled suffix is a negative property id, which reads as four billion unsigned. */
  randomPropertyId: number;
  count: number;
  /** Milliseconds the window stays open. Every call site passes sixty seconds. */
  countdown: number;
  /**
   * Which buttons to show. Need is stripped two independent ways: for the whole roll when the item
   * may only be rolled greed, and for one player when they cannot need it under the dungeon
   * finder's rules.
   */
  voteMask: number;
}

export function parseLootStartRoll(payload: Uint8Array): LootRollStart {
  const reader = new PacketReader(payload);
  const start: LootRollStart = {
    itemGuid: reader.u64(),
    mapId: reader.u32(),
    itemSlot: reader.u32(),
    itemId: reader.u32(),
    randomSuffix: reader.u32(),
    randomPropertyId: reader.i32(),
    count: reader.u32(),
    countdown: reader.u32(),
    voteMask: reader.u8(),
  };
  reader.assertFinished();
  return start;
}

export interface LootRollVote {
  /**
   * Almost always zero. Only the three auto-pass broadcasts put the roll's real item guid here;
   * every announcement and every result leaves it empty, so a roll has to be matched by its slot.
   */
  itemGuid: bigint;
  itemSlot: number;
  playerGuid: bigint;
  itemId: number;
  randomSuffix: number;
  randomPropertyId: number;
  rollNumber: number;
  rollType: number;
  /** Set on the one broadcast that means "you could not have looted this anyway". */
  autoPass: boolean;
}

/** The roller's guid is third here — `SMSG_LOOT_ROLL_WON` puts the winner's after the item block. */
export function parseLootRoll(payload: Uint8Array): LootRollVote {
  const reader = new PacketReader(payload);
  const vote: LootRollVote = {
    itemGuid: reader.u64(),
    itemSlot: reader.u32(),
    playerGuid: reader.u64(),
    itemId: reader.u32(),
    randomSuffix: reader.u32(),
    randomPropertyId: reader.i32(),
    rollNumber: reader.u8(),
    rollType: reader.u8(),
    autoPass: reader.u8() !== 0,
  };
  reader.assertFinished();
  return vote;
}

export interface LootRollWon {
  itemGuid: bigint;
  itemSlot: number;
  itemId: number;
  randomSuffix: number;
  randomPropertyId: number;
  winnerGuid: bigint;
  rollNumber: number;
  rollType: number;
}

/** Both call sites leave the item guid empty, so the winner is the only guid this carries. */
export function parseLootRollWon(payload: Uint8Array): LootRollWon {
  const reader = new PacketReader(payload);
  const won: LootRollWon = {
    itemGuid: reader.u64(),
    itemSlot: reader.u32(),
    itemId: reader.u32(),
    randomSuffix: reader.u32(),
    randomPropertyId: reader.i32(),
    winnerGuid: reader.u64(),
    rollNumber: reader.u8(),
    rollType: reader.u8(),
  };
  reader.assertFinished();
  return won;
}

export interface LootAllPassed {
  itemGuid: bigint;
  itemSlot: number;
  itemId: number;
  randomPropertyId: number;
  randomSuffix: number;
}

/**
 * The one packet of the four that writes the random property before the suffix. Copying the sibling
 * layout swaps the two silently, because both are plausible numbers either way round.
 *
 * It does carry the roll's minted item guid, as `SMSG_LOOT_START_ROLL` always does and
 * `SMSG_LOOT_ROLL` does on its three auto-pass broadcasts. Only `SMSG_LOOT_ROLL_WON` never has one.
 */
export function parseLootAllPassed(payload: Uint8Array): LootAllPassed {
  const reader = new PacketReader(payload);
  const passed: LootAllPassed = {
    itemGuid: reader.u64(),
    itemSlot: reader.u32(),
    itemId: reader.u32(),
    randomPropertyId: reader.i32(),
    randomSuffix: reader.u32(),
  };
  reader.assertFinished();
  return passed;
}

/**
 * Who the master looter may hand the item to. The count is a placeholder the server overwrites
 * once it knows how many candidates were near enough, so it is the number of guids that follow
 * and not the size of the group.
 */
export function parseLootMasterList(payload: Uint8Array): bigint[] {
  const reader = new PacketReader(payload);
  const count = reader.u8();
  const candidates: bigint[] = [];
  for (let index = 0; index < count; index++) candidates.push(reader.u64());
  reader.assertFinished();
  return candidates;
}

export interface LootOwners {
  /** The corpse this is about — the only full-width guid in the packet. */
  corpseGuid: bigint;
  /** Empty unless the group loots by master looter and the corpse holds something above threshold. */
  masterLooterGuid: bigint;
  /** Whose turn it is under round robin. Empty when nobody in particular owns the corpse. */
  allowedLooterGuid: bigint;
}

/**
 * Neither trailing guid is ever omitted, only shortened: where the core has nobody to name it
 * writes a bare zero byte, which is exactly how a packed empty guid encodes. So both are read
 * unconditionally and come back as zero.
 */
export function parseLootList(payload: Uint8Array): LootOwners {
  const reader = new PacketReader(payload);
  const owners: LootOwners = {
    corpseGuid: reader.u64(),
    masterLooterGuid: reader.packedGuid(),
    allowedLooterGuid: reader.packedGuid(),
  };
  reader.assertFinished();
  return owners;
}

/** The item guid is the one the roll was announced with, not an inventory guid. */
export function buildLootRoll(itemGuid: bigint, itemSlot: number, rollType: number): Uint8Array {
  return new PacketWriter().u64(itemGuid).u32(itemSlot).u8(rollType).toUint8Array();
}

export function buildLootMasterGive(lootGuid: bigint, slot: number, targetGuid: bigint): Uint8Array {
  return new PacketWriter().u64(lootGuid).u8(slot).u64(targetGuid).toUint8Array();
}

export function rollTypeText(rollType: number): string {
  switch (rollType) {
    case ROLL_PASS: return "пропуск";
    case ROLL_NEED: return "нужно";
    case ROLL_GREED: return "интересно";
    case ROLL_DISENCHANT: return "распыление";
    default: return `выбор ${rollType}`;
  }
}

/**
 * The line the chat log shows for one vote or result, worded the way the original client words it.
 *
 * The roll type alone cannot be read: choosing need is announced as type 0 with number 0, and
 * passing is announced as type 0 — `ROLL_PASS` — with number 128. Only the number tells them apart,
 * which is why the core's own comment on that field spells out both meanings. Deciding on the type
 * turns every need into its opposite.
 */
export function lootRollText(vote: LootRollVote, name: string): string {
  const who = name || "Игрок";
  if (vote.autoPass) return `${who} автоматически пропускает предмет ${vote.itemId}`;
  if (vote.rollNumber === 0) return `${who}: нужно на предмет ${vote.itemId}`;
  if (vote.rollNumber >= ROLL_NUMBER_ANNOUNCEMENT) {
    return `${who}: ${rollTypeText(vote.rollType)} на предмет ${vote.itemId}`;
  }
  return `${who} бросает ${vote.rollNumber} (${rollTypeText(vote.rollType)}) на предмет ${vote.itemId}`;
}
