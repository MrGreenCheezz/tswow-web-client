import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { readByte } from "../world/Fields.js";
import type { WorldObjectState, WorldState } from "../world/WorldState.js";
import { SELF, type WorldStore } from "../world/WorldStore.js";

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
  const low = object.fields.get(offset) ?? 0;
  const high = object.fields.get(offset + 1) ?? 0;
  // Most slots are empty — the bank, the keyring and the buyback shelf nearly always are — and an
  // empty one needs no BigInt at all. Same value as the full expression for every input.
  if (high === 0) return low === 0 ? 0n : BigInt(low);
  return BigInt(low) | BigInt(high) << 32n;
}

/** Finds one slot by the pair the opcodes address it with, across every list above. */
export function slotAt(inventory: PlayerInventoryState, bag: number, slot: number): ItemSlotState | undefined {
  if (bag !== INVENTORY_SLOT_BAG_0) {
    const container = [...inventory.bags, ...inventory.bankBags].find((candidate) => candidate.bagSlot === bag);
    return container?.slots[slot];
  }
  const containerStart = slot >= INVENTORY_SLOT_BAG_START && slot < INVENTORY_SLOT_BAG_START + 4
    ? INVENTORY_SLOT_BAG_START
    : slot >= BANK_SLOT_BAG_START && slot < BANK_SLOT_BAG_START + BANK_BAG_SLOTS
      ? BANK_SLOT_BAG_START
      : undefined;
  if (containerStart !== undefined) {
    const container = [...inventory.bags, ...inventory.bankBags].find((candidate) => candidate.bagSlot === slot);
    return {
      index: slot - containerStart, item: container?.bag, guid: container?.guid ?? 0n,
      bag: INVENTORY_SLOT_BAG_0, slot,
    };
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
  const result: ItemSlotState[] = [];
  for (let index = 0; index < count; index += 1) {
    const guid = fieldGuid(owner, offset + index * 2);
    result.push({ index, guid, item: guid === 0n ? undefined : state.objects.get(guid), bag, slot: firstSlot + index });
  }
  return result;
}

/** How many of a thing a slot holds. One when the field is absent, nothing when the slot is empty. */
export function stackCount(slot: ItemSlotState): number {
  return slot.item?.fields.get(UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset) ?? (slot.item ? 1 : 0);
}

/**
 * The wear an item shows: current and maximum durability, when the object carries both.
 *
 * Both live on the item object, so a durability bar costs no query — exactly the two numbers a
 * repair tool, combat wear and the tooltip already read. Items without durability (reagents, food,
 * ammo) answer nothing rather than a fabricated 100%.
 */
export function itemWear(
  item: { fields: Map<number, number> } | undefined,
): { durability: number; maximum: number } | undefined {
  if (!item) return undefined;
  const durability = item.fields.get(UPDATE_FIELDS.ITEM_FIELD_DURABILITY.offset);
  const maximum = item.fields.get(UPDATE_FIELDS.ITEM_FIELD_MAXDURABILITY.offset);
  if (durability === undefined || maximum === undefined || maximum <= 0) return undefined;
  return { durability: Math.max(0, Math.min(durability, maximum)), maximum };
}

/**
 * One bit per enchantment slot that carries an id: permanent enchant (0), the three sockets (2-4),
 * the socket bonus (5) and the prismatic socket (6). Only presence is kept, and only so a slot can
 * say "there is something here" without the DBC names the tooltip already resolves.
 */
export function itemEnchantPresence(item: { fields: Map<number, number> } | undefined): number {
  if (!item) return 0;
  let mask = 0;
  for (let slot = 0; slot < 7; slot++) {
    if ((item.fields.get(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + slot * 3) ?? 0) > 0) mask |= 1 << slot;
  }
  return mask;
}

/**
 * Everything about the slots that decides what is drawn: which item instance, how many, which
 * bags, and how many bank bag slots have been bought.
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
  inventory: Pick<PlayerInventoryState, "bags" | "bankBags" | "bankBagSlotsBought">,
): string {
  const parts: string[] = [];
  // The GUID must be included: two equal, non-stackable items can swap while their entry, count,
  // wear and enchantment marker remain identical. Item-slot actions close over the GUID, so the
  // old DOM would otherwise keep trying to use the item that left that slot. Wear and enchantment
  // presence also repaint the visible markers without waiting for another inventory change.
  for (const slot of slots) {
    const wear = itemWear(slot.item);
    parts.push(`${slot.guid}:${entryOf(slot.item)}:${stackCount(slot)}:${wear?.durability ?? -1}:${itemEnchantPresence(slot.item)}`);
  }
  // Bag-bar drag targets capture the container GUID. Two empty bags of the same entry can trade
  // slots without changing any inner item, so their buttons still need a fresh binding.
  for (const bag of inventory.bags) parts.push(`b${bag.bagSlot}:${bag.guid}:${entryOf(bag.bag)}`);
  for (const bag of inventory.bankBags) parts.push(`k${bag.bagSlot}:${bag.guid}:${entryOf(bag.bag)}`);
  // The purchased count is a player field, not a slot or a bag object. The bank's locked row
  // changes when this field arrives even if no item has moved into the newly unlocked slot yet.
  parts.push(`bank-slots:${inventory.bankBagSlotsBought}`);
  return parts.join("|");
}

/** The item id a slot's object carries, or zero when the slot is empty. */
export function entryOf(object: { fields: Map<number, number> } | undefined): number {
  return object?.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
}

/**
 * Every field of the player `playerInventory` reads (slot guids, buyback prices, the bank-bag byte)
 * and the coinage the bags print beside them.
 */
const INVENTORY_PLAYER_FIELDS = [
  "PLAYER_FIELD_INV_SLOT_HEAD", "PLAYER_FIELD_PACK_SLOT_1", "PLAYER_FIELD_BANK_SLOT_1",
  "PLAYER_FIELD_BANKBAG_SLOT_1", "PLAYER_FIELD_VENDORBUYBACK_SLOT_1", "PLAYER_FIELD_BUYBACK_PRICE_1",
  "PLAYER_FIELD_KEYRING_SLOT_1", "PLAYER_BYTES_2", "PLAYER_FIELD_COINAGE",
] as const;

/** `TYPEID_ITEM` and `TYPEID_CONTAINER`: the only objects a slot can hold. */
const TYPEID_ITEM = 1;
const TYPEID_CONTAINER = 2;
/** `HighGuid::Item` (ObjectGuid.h, bits 48-63): an item guid met before its create block. */
const HIGHGUID_ITEM = 0x4000n;

function isItemObject(guid: bigint, typeId: number | undefined): boolean {
  return typeId === TYPEID_ITEM || typeId === TYPEID_CONTAINER
    || (typeId === undefined && (guid >> 48n) === HIGHGUID_ITEM);
}

/**
 * Whether anything `playerInventory` reads has changed since a caller last looked, told by the
 * store rather than found by building the inventory again.
 *
 * `playerInventory` walks some three hundred slots (half a hundred microseconds on a full
 * character), and the bags' redraw guard and the stock containers' signatures built it once a frame
 * for as long as a crowd kept the store busy — although nothing a crowd sends can move a slot. Every
 * item and container object in the state is the player's own (other players' gear is their
 * PLAYER_VISIBLE_ITEM fields), and the slots are a fixed set of the player's own fields. The watch
 * subscribes to exactly those: the player fields above, every field of every item and container
 * object, and their arrival and removal. `revision` moves whenever any of them did; the same
 * revision means the inventory built last time is still the inventory.
 *
 * Changes arrive with `WorldStore.flush`, once a frame, and so does the revision: a caller that runs
 * between two packets and the next flush sees the previous frame's inventory, which is what the
 * frame on screen shows anyway.
 */
export class InventoryWatch {
  #revision = 0;
  readonly #stops: Array<() => void> = [];
  readonly #items = new Map<bigint, () => void>();
  readonly #store: WorldStore;

  constructor(store: WorldStore) {
    this.#store = store;
    const bump = (): void => { this.#revision += 1; };
    for (const name of INVENTORY_PLAYER_FIELDS) this.#stops.push(store.fieldRange(SELF, name, bump));
    for (const object of store.state.objects.values()) {
      if (isItemObject(object.guid, object.typeId)) this.#watchItem(object.guid, bump);
    }
    this.#stops.push(store.events.on("OBJECT_CREATED", ({ guid, typeId }) => {
      if (!isItemObject(guid, typeId)) return;
      this.#watchItem(guid, bump);
      bump();
    }));
    this.#stops.push(store.events.on("OBJECT_DESTROYED", ({ guid }) => {
      const stop = this.#items.get(guid);
      if (!stop) return;
      this.#items.delete(guid);
      stop();
      bump();
    }));
  }

  get revision(): number {
    // A detached store tells nobody anything any more (`WorldStore.detach` drops every listener
    // and lets go of the state): from then on every read is a change, which is the old behaviour.
    if (this.#store.state.observer !== this.#store) this.#revision += 1;
    return this.#revision;
  }

  /** The store this watch listens to; a caller holding another store needs another watch. */
  get store(): WorldStore {
    return this.#store;
  }

  dispose(): void {
    for (const stop of this.#stops.splice(0)) stop();
    for (const stop of this.#items.values()) stop();
    this.#items.clear();
  }

  #watchItem(guid: bigint, bump: () => void): void {
    if (this.#items.has(guid)) return;
    this.#items.set(guid, this.#store.object(guid, bump));
  }
}

const inventoryWatches = new WeakMap<WorldStore, InventoryWatch>();

/** The one watch of a store, made on first use; it lives and dies with the store's subscriptions. */
export function inventoryWatch(store: WorldStore): InventoryWatch {
  let watch = inventoryWatches.get(store);
  if (!watch) {
    watch = new InventoryWatch(store);
    inventoryWatches.set(store, watch);
  }
  return watch;
}
