import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { readByte } from "../world/Fields.js";
import type { WorldObjectState, WorldState } from "../world/WorldState.js";

export const EQUIPMENT_SLOT_NAMES = [
  "Голова", "Шея", "Плечи", "Рубашка", "Грудь", "Пояс", "Ноги", "Ступни", "Запястья", "Кисти",
  "Кольцо 1", "Кольцо 2", "Аксессуар 1", "Аксессуар 2", "Спина", "Правая рука", "Левая рука", "Дальний бой", "Накидка",
] as const;

/** `INVENTORY_SLOT_BAG_0` in Player.h: the player's own inventory rather than a bag container. */
export const INVENTORY_SLOT_BAG_0 = 255;
/** Player.h: equipment is 0..18, bag containers 19..22, backpack 23..38. */
export const INVENTORY_SLOT_BAG_START = 19;
export const INVENTORY_SLOT_ITEM_START = 23;
/**
 * Player.h again, and the reason a bank needs no container of its own: the numbering simply keeps
 * going. Bank items are 39..66, bank bag containers 67..73, the vendor's buyback shelf 74..85 and
 * the keyring 86..117 — all of them slots of `INVENTORY_SLOT_BAG_0`, all of them arriving in
 * private update fields from the first login, and none of them read by anything until now.
 */
export const BANK_SLOT_ITEM_START = 39;
export const BANK_ITEM_SLOTS = 28;
export const BANK_SLOT_BAG_START = 67;
export const BANK_BAG_SLOTS = 7;
export const BUYBACK_SLOT_START = 74;
export const BUYBACK_SLOTS = 12;
export const KEYRING_SLOT_START = 86;
export const KEYRING_SLOTS = 32;

export interface ItemSlotState {
  index: number;
  item: WorldObjectState | undefined;
  guid: bigint;
  /** Container this slot lives in, addressed the way the item opcodes expect. */
  bag: number;
  /** Slot number inside `bag`, again as the opcodes expect. */
  slot: number;
}

/** An equipped or banked container, and what is inside it. */
export interface BagState {
  bag: WorldObjectState;
  guid: bigint;
  /** The container's own place in the player inventory: 19 to 22, or 67 to 73 in the bank. */
  bagSlot: number;
  slots: ItemSlotState[];
}

/** One shelf of the vendor's buyback, which is a player slot rather than anything the vendor holds. */
export interface BuybackSlotState extends ItemSlotState {
  /** What taking it back costs. Zero when the shelf is empty. */
  price: number;
}

export interface PlayerInventoryState {
  equipment: ItemSlotState[];
  backpack: ItemSlotState[];
  bags: BagState[];
  keyring: ItemSlotState[];
  bank: ItemSlotState[];
  bankBags: BagState[];
  /** How many bank bag slots have been bought; the rest of `bankBags` cannot be filled yet. */
  bankBagSlotsBought: number;
  buyback: BuybackSlotState[];
}

export function playerInventory(state: WorldState): PlayerInventoryState | undefined {
  const player = state.selfGuid === undefined ? undefined : state.objects.get(state.selfGuid);
  if (!player) return undefined;
  const equipment = slots(state, player, UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset, EQUIPMENT_SLOT_NAMES.length, INVENTORY_SLOT_BAG_0, 0);
  const backpack = slots(state, player, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, 16, INVENTORY_SLOT_BAG_0, INVENTORY_SLOT_ITEM_START);
  const bags = containers(state, player, UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + EQUIPMENT_SLOT_NAMES.length * 2, 4, INVENTORY_SLOT_BAG_START);
  const keyring = slots(state, player, UPDATE_FIELDS.PLAYER_FIELD_KEYRING_SLOT_1.offset, KEYRING_SLOTS, INVENTORY_SLOT_BAG_0, KEYRING_SLOT_START);
  const bank = slots(state, player, UPDATE_FIELDS.PLAYER_FIELD_BANK_SLOT_1.offset, BANK_ITEM_SLOTS, INVENTORY_SLOT_BAG_0, BANK_SLOT_ITEM_START);
  const bankBags = containers(state, player, UPDATE_FIELDS.PLAYER_FIELD_BANKBAG_SLOT_1.offset, BANK_BAG_SLOTS, BANK_SLOT_BAG_START);
  // `PLAYER_BYTES_2_OFFSET_BANK_BAG_SLOTS` — how many of the seven the character has paid for.
  const bankBagSlotsBought = readByte(player, "PLAYER_BYTES_2", 2) ?? 0;
  const buyback = slots(state, player, UPDATE_FIELDS.PLAYER_FIELD_VENDORBUYBACK_SLOT_1.offset, BUYBACK_SLOTS, INVENTORY_SLOT_BAG_0, BUYBACK_SLOT_START)
    .map((slot) => ({ ...slot, price: player.fields.get(UPDATE_FIELDS.PLAYER_FIELD_BUYBACK_PRICE_1.offset + slot.index) ?? 0 }));
  return { equipment, backpack, bags, keyring, bank, bankBags, bankBagSlotsBought, buyback };
}

export function fieldGuid(object: WorldObjectState, offset: number): bigint {
  return BigInt(object.fields.get(offset) ?? 0) | BigInt(object.fields.get(offset + 1) ?? 0) << 32n;
}

/** Finds one slot by the pair the opcodes address it with, across every list above. */
export function slotAt(inventory: PlayerInventoryState, bag: number, slot: number): ItemSlotState | undefined {
  if (bag !== INVENTORY_SLOT_BAG_0) {
    const container = [...inventory.bags, ...inventory.bankBags].find((candidate) => candidate.bagSlot === bag);
    return container?.slots[slot];
  }
  return [...inventory.equipment, ...inventory.backpack, ...inventory.keyring, ...inventory.bank, ...inventory.buyback]
    .find((candidate) => candidate.slot === slot);
}

/** Where an item is right now, by guid. What an equipment set needs and never carries. */
export function locateItem(inventory: PlayerInventoryState, guid: bigint): ItemSlotState | undefined {
  if (guid === 0n) return undefined;
  const everywhere = [
    ...inventory.equipment, ...inventory.backpack, ...inventory.keyring, ...inventory.bank,
    ...inventory.bags.flatMap((bag) => bag.slots), ...inventory.bankBags.flatMap((bag) => bag.slots),
  ];
  return everywhere.find((slot) => slot.guid === guid);
}

/** How many free squares a run of slots has: what a bag bar button shows under each bag. */
export function freeSlots(slots: readonly ItemSlotState[]): number {
  return slots.reduce((free, slot) => free + (slot.item === undefined ? 1 : 0), 0);
}

/**
 * The first empty slot on one side of the inventory: the bags, or the bank.
 *
 * Which side matters. `CMSG_SPLIT_ITEM` takes an explicit destination and the server refuses a
 * bank-to-bag split that names a slot the item may not go to, so a split started in the bank has
 * to land in the bank.
 */
export function firstFreeSlot(inventory: PlayerInventoryState | undefined, inBank: boolean): ItemSlotState | undefined {
  if (!inventory) return undefined;
  const candidates = inBank
    ? [...inventory.bank, ...inventory.bankBags.flatMap((bag) => bag.slots)]
    : [...inventory.backpack, ...inventory.bags.flatMap((bag) => bag.slots)];
  return candidates.find((slot) => slot.item === undefined);
}

/** True for the slots `IsBankPos` accepts, which is what decides the direction of a bank move. */
export function isBankSlot(bag: number, slot: number): boolean {
  if (bag !== INVENTORY_SLOT_BAG_0) return bag >= BANK_SLOT_BAG_START && bag < BANK_SLOT_BAG_START + BANK_BAG_SLOTS;
  return slot >= BANK_SLOT_ITEM_START && slot < BANK_SLOT_BAG_START + BANK_BAG_SLOTS;
}

/** The containers held in a run of guid fields: equipped bags, or the bank's own bag row. */
function containers(state: WorldState, player: WorldObjectState, offset: number, count: number, firstBagSlot: number): BagState[] {
  const found: BagState[] = [];
  for (let index = 0; index < count; index++) {
    const guid = fieldGuid(player, offset + index * 2);
    const bag = state.objects.get(guid);
    if (!bag) continue;
    const size = Math.min(36, bag.fields.get(UPDATE_FIELDS.CONTAINER_FIELD_NUM_SLOTS.offset) ?? 0);
    const bagSlot = firstBagSlot + index;
    found.push({ bag, guid, bagSlot, slots: slots(state, bag, UPDATE_FIELDS.CONTAINER_FIELD_SLOT_1.offset, size, bagSlot, 0) });
  }
  return found;
}

function slots(state: WorldState, owner: WorldObjectState, offset: number, count: number, bag: number, firstSlot: number): ItemSlotState[] {
  return Array.from({ length: count }, (_, index) => {
    const guid = fieldGuid(owner, offset + index * 2);
    return { index, guid, item: guid === 0n ? undefined : state.objects.get(guid), bag, slot: firstSlot + index };
  });
}

/** How many of a thing a slot holds. One when the field is absent, nothing when the slot is empty. */
export function stackCount(slot: ItemSlotState): number {
  return slot.item?.fields.get(UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset) ?? (slot.item ? 1 : 0);
}

/**
 * Everything about the slots that decides what is drawn: which item, how many, and which bags.
 *
 * Here rather than in the panel that uses it because it needs no DOM, and because it is the thing
 * that decides whether the bags are rebuilt at all. `showWorldState` calls the panel once a frame
 * for as long as packets keep arriving, and the panel's redraw is `replaceChildren` over every
 * slot in the bags, the bank and the character — so without this every icon was destroyed and
 * remade sixty times a second. That is visible twice over: an icon flickers, and an icon that has
 * to be fetched never lands at all, because the element that asked for it is gone before the
 * picture arrives.
 *
 * Money and the character sheet are not in it: they are refreshed on their own.
 */
export function inventorySignature(
  slots: readonly ItemSlotState[],
  inventory: { bags: readonly BagState[]; bankBags: readonly BagState[] },
): string {
  const parts: string[] = [];
  for (const slot of slots) parts.push(`${entryOf(slot.item)}:${stackCount(slot)}`);
  for (const bag of inventory.bags) parts.push(`b${bag.bagSlot}:${entryOf(bag.bag)}`);
  for (const bag of inventory.bankBags) parts.push(`k${bag.bagSlot}:${entryOf(bag.bag)}`);
  return parts.join("|");
}

/** The item id a slot's object carries, or zero when the slot is empty. */
export function entryOf(object: { fields: Map<number, number> } | undefined): number {
  return object?.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
}
