import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: Loot.cpp `operator<<(ByteBuffer&, LootItem const&)`
// and `operator<<(ByteBuffer&, LootView const&)`, Player::SendLoot and LootHandler.cpp.
// The wow_messages IR describes a six byte loot item here, which is the vanilla layout and wrong
// for 3.3.5 - the server writes twenty two bytes per entry.

/** `LootType` in Loot.h. Zero means the packet carries an error instead of a loot list. */
export const LOOT_NONE = 0;
export const LOOT_CORPSE = 1;
export const LOOT_PICKPOCKETING = 2;
export const LOOT_FISHING = 3;
export const LOOT_DISENCHANTING = 4;
export const LOOT_SKINNING = 6;
export const LOOT_PROSPECTING = 7;
export const LOOT_MILLING = 8;

/** `LootSlotType` in Loot.h. Only `ALLOW_LOOT` and `OWNER` are freely takeable. */
export const LOOT_SLOT_ALLOW_LOOT = 0;
export const LOOT_SLOT_ROLL_ONGOING = 1;
export const LOOT_SLOT_MASTER = 2;
export const LOOT_SLOT_LOCKED = 3;
export const LOOT_SLOT_OWNER = 4;

export interface LootSlot {
  index: number;
  itemId: number;
  count: number;
  displayId: number;
  randomSuffix: number;
  randomPropertyId: number;
  slotType: number;
  taken: boolean;
}

export interface LootWindow {
  guid: bigint;
  lootType: number;
  gold: number;
  slots: LootSlot[];
  error?: number;
}

export function parseLootResponse(payload: Uint8Array): LootWindow {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const lootType = reader.u8();
  if (lootType === LOOT_NONE) {
    // Player::SendLootError writes the guid, LOOT_NONE and a `LootError`.
    const error = reader.remaining > 0 ? reader.u8() : 0;
    return { guid, lootType, gold: 0, slots: [], error };
  }
  const gold = reader.u32();
  const count = reader.u8();
  const slots: LootSlot[] = [];
  for (let entry = 0; entry < count; entry++) {
    slots.push({
      index: reader.u8(),
      itemId: reader.u32(),
      count: reader.u32(),
      displayId: reader.u32(),
      randomSuffix: reader.u32(),
      randomPropertyId: reader.u32(),
      slotType: reader.u8(),
      taken: false,
    });
  }
  return { guid, lootType, gold, slots };
}

export interface LootMoneyNotify {
  amount: number;
  /** False when the money was shared with nearby group members. */
  alone: boolean;
}

export function parseLootMoneyNotify(payload: Uint8Array): LootMoneyNotify {
  const reader = new PacketReader(payload);
  const amount = reader.u32();
  const alone = reader.u8() !== 0;
  reader.assertFinished();
  return { amount, alone };
}

export function parseLootRemoved(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const slot = reader.u8();
  reader.assertFinished();
  return slot;
}

export function parseLootReleaseResponse(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  reader.u8();
  reader.assertFinished();
  return guid;
}

export function buildLootRequest(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

export function buildLootRelease(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

/** `CMSG_LOOT_MONEY` carries no body: the server uses the player's current loot target. */
export function buildLootMoney(): Uint8Array {
  return new Uint8Array(0);
}

export function buildAutostoreLootItem(slot: number): Uint8Array {
  return new PacketWriter().u8(slot).toUint8Array();
}

/** Whether the slot can be taken by this player right now. */
export function isLootSlotTakeable(slot: LootSlot): boolean {
  return !slot.taken && (slot.slotType === LOOT_SLOT_ALLOW_LOOT || slot.slotType === LOOT_SLOT_OWNER);
}

// `LootError` in Loot.h. The value list is sparse, so unknown codes are reported as numbers.
const LOOT_ERRORS: Record<number, string> = {
  0: "Нет права на добычу с этого тела",
  4: "Слишком далеко",
  5: "Нужно повернуться к телу",
  6: "Кто-то уже обыскивает",
  8: "Нужно встать",
  9: "Нельзя обыскивать в оглушении",
  10: "Игрок не найден",
  11: "Превышено игровое время",
  12: "У игрока полна сумка",
  13: "У игрока уже слишком много таких предметов",
  14: "Нельзя передать предмет этому игроку",
  15: "Карманы цели уже обчищены",
  16: "Нельзя в облике зверя",
};

export function lootErrorText(error: number | undefined): string {
  if (error === undefined) return "Добыча недоступна";
  return LOOT_ERRORS[error] ?? `Добыча недоступна (код ${error})`;
}
