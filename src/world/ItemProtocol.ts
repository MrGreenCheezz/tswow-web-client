import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: ItemHandler.cpp (`HandleSwapInvItemOpcode`,
// `HandleSwapItem`, `HandleAutoEquipItemOpcode`, `HandleAutoStoreBagItemOpcode`,
// `HandleSplitItemOpcode`, `HandleDestroyItemOpcode`), SpellHandler.cpp `HandleUseItemOpcode`,
// and Player.cpp `SendEquipError` / `SendNewItem`.
//
// Slots are addressed the way the handlers expect: bag 255 is the player's own inventory, where
// equipment occupies 0..18 and the backpack 23..38; a bag container is addressed by its own
// inventory slot, 19..22, and its contents are numbered from zero.

export const INVENTORY_SLOT_BAG_0 = 255;

/** ItemHandler::HandleSocketOpcode reads four full GUIDs; zero preserves an existing socket. */
export function buildSocketGems(itemGuid: bigint, gems: readonly [bigint, bigint, bigint]): Uint8Array {
  if (itemGuid <= 0n || gems.some((guid) => guid < 0n || guid === itemGuid)) throw new RangeError("Invalid socket item GUID");
  const selected = gems.filter((guid) => guid !== 0n);
  if (selected.length === 0 || new Set(selected).size !== selected.length) throw new RangeError("Socket gems must be distinct item instances");
  return new PacketWriter().u64(itemGuid).u64(gems[0]).u64(gems[1]).u64(gems[2]).toUint8Array();
}

export interface EquipFailure {
  result: number;
  itemGuid: bigint;
  otherItemGuid: bigint;
  bagTypeSubclass: number;
  /** Required level for result 1 and 87, item limit category for 84, 85 and 89. */
  detail?: number | undefined;
}

/** `Player::SendEquipError`. A zero result carries no body at all. */
export function parseInventoryChangeFailure(payload: Uint8Array): EquipFailure {
  const reader = new PacketReader(payload);
  const result = reader.u8();
  if (result === 0 || reader.remaining === 0) {
    return { result, itemGuid: 0n, otherItemGuid: 0n, bagTypeSubclass: 0 };
  }
  const itemGuid = reader.u64();
  const otherItemGuid = reader.u64();
  const bagTypeSubclass = reader.u8();
  let detail: number | undefined;
  if (result === 1 || result === 87 || result === 84 || result === 85 || result === 89) {
    if (reader.remaining >= 4) detail = reader.u32();
  }
  return { result, itemGuid, otherItemGuid, bagTypeSubclass, detail };
}

export interface ItemPushResult {
  playerGuid: bigint;
  /** False when the item came from loot, true when it came from an NPC. */
  fromNpc: boolean;
  created: boolean;
  showInChat: boolean;
  bag: number;
  /** -1 when the item merged into an existing stack. */
  slot: number;
  itemId: number;
  suffixFactor: number;
  randomPropertyId: number;
  count: number;
  countInInventory: number;
}

/** `Player::SendNewItem`. */
export function parseItemPushResult(payload: Uint8Array): ItemPushResult {
  const reader = new PacketReader(payload);
  const playerGuid = reader.u64();
  const fromNpc = reader.u32() !== 0;
  const created = reader.u32() !== 0;
  const showInChat = reader.u32() !== 0;
  const bag = reader.u8();
  const slot = reader.i32();
  const itemId = reader.u32();
  const suffixFactor = reader.u32();
  const randomPropertyId = reader.i32();
  const count = reader.u32();
  const countInInventory = reader.u32();
  return { playerGuid, fromNpc, created, showInChat, bag, slot, itemId, suffixFactor, randomPropertyId, count, countInInventory };
}

/**
 * `CMSG_SWAP_INV_ITEM` moves within the player's own inventory. The handler reads the
 * destination slot first, then the source, which is the reverse of the opcode's name.
 */
export function buildSwapInvItem(sourceSlot: number, destinationSlot: number): Uint8Array {
  return new PacketWriter().u8(destinationSlot).u8(sourceSlot).toUint8Array();
}

/** `CMSG_SWAP_ITEM` moves between containers; the destination is again read first. */
export function buildSwapItem(sourceBag: number, sourceSlot: number, destinationBag: number, destinationSlot: number): Uint8Array {
  return new PacketWriter().u8(destinationBag).u8(destinationSlot).u8(sourceBag).u8(sourceSlot).toUint8Array();
}

export function buildAutoEquipItem(bag: number, slot: number): Uint8Array {
  return new PacketWriter().u8(bag).u8(slot).toUint8Array();
}

export function buildAutoStoreBagItem(sourceBag: number, sourceSlot: number, destinationBag: number): Uint8Array {
  return new PacketWriter().u8(sourceBag).u8(sourceSlot).u8(destinationBag).toUint8Array();
}

export function buildSplitItem(sourceBag: number, sourceSlot: number, destinationBag: number, destinationSlot: number, count: number): Uint8Array {
  return new PacketWriter().u8(sourceBag).u8(sourceSlot).u8(destinationBag).u8(destinationSlot).u32(count).toUint8Array();
}

/** `count` of zero destroys the whole stack, which is what the original client sends. */
export function buildDestroyItem(bag: number, slot: number, count = 0): Uint8Array {
  return new PacketWriter().u8(bag).u8(slot).u8(count).u8(0).u8(0).u8(0).toUint8Array();
}

/**
 * `CMSG_USE_ITEM`. The trailing spell cast targets are written as a bare "no target" mask, which
 * covers self-cast consumables; anything needing a real target is separate work.
 */
export function buildUseItem(bag: number, slot: number, castCount: number, spellId: number, itemGuid: bigint): Uint8Array {
  return new PacketWriter()
    .u8(bag)
    .u8(slot)
    .u8(castCount)
    .u32(spellId)
    .u64(itemGuid)
    .u32(0)
    .u8(0)
    .u32(0)
    .toUint8Array();
}

// `InventoryResult` in ItemDefines.h. Only the codes a player actually runs into are named;
// anything else is reported with its number so the cause is still traceable.
const EQUIP_ERRORS: Record<number, string> = {
  1: "Слишком низкий уровень",
  2: "Не хватает навыка",
  3: "Предмет не подходит для этого слота",
  4: "Сумка заполнена",
  5: "Нельзя положить непустую сумку в другую сумку",
  7: "Сюда помещаются только боеприпасы",
  8: "Нет нужного класса владения",
  9: "Нет свободного слота экипировки",
  10: "Вы никогда не сможете использовать этот предмет",
  13: "Мешает двуручное оружие",
  14: "Нельзя держать оружие в двух руках",
  15: "Предмет не помещается в эту сумку",
  17: "Больше таких предметов нести нельзя",
  19: "Предметы не складываются",
  20: "Предмет нельзя надеть",
  21: "Предметы нельзя поменять местами",
  22: "Слот пуст",
  23: "Предмет не найден",
  24: "Нельзя выбросить привязанный предмет",
  25: "Слишком далеко",
  26: "Нельзя разделить больше, чем есть",
  29: "Не хватает денег",
  30: "Это не сумка",
  31: "Только с пустыми сумками",
  32: "Это не ваш предмет",
  36: "Предмет заблокирован",
  37: "Вы оглушены",
  38: "Вы мертвы",
  39: "Сейчас нельзя",
  49: "Уже забрано",
  50: "Инвентарь заполнен",
  52: "Товар распродан",
  58: "Объект занят",
  60: "Нельзя в бою",
  61: "Нельзя без оружия",
  63: "Нужно звание",
  64: "Нужна репутация",
  66: "Сейчас это нельзя забрать",
  67: "Такой предмет уже надет",
  77: "Слишком много золота",
  87: "Слишком низкий уровень для покупки",
  88: "Нужен талант",
};

export function equipErrorText(failure: EquipFailure): string {
  const base = EQUIP_ERRORS[failure.result] ?? `Действие отклонено (код ${failure.result})`;
  if ((failure.result === 1 || failure.result === 87) && failure.detail !== undefined) {
    return `${base}: нужен ${failure.detail}`;
  }
  return base;
}
