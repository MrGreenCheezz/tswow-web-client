import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { game } from "../game/Context.js";
import { armGiftWrap, giftWrapLocks, isWrappingPaper, pendingGiftWrap, wrapWithPendingPaper, type GiftWrapWorld } from "../game/GiftWrap.js";
import {
  INVENTORY_SLOT_BAG_0, INVENTORY_SLOT_BAG_START, INVENTORY_SLOT_ITEM_START, KEYRING_SLOT_START, KEYRING_SLOTS,
  type ItemSlotState,
} from "../Inventory.js";

/**
 * The native bags' share of gift wrapping (plan item 2.05 slice E, lane L1; game/GiftWrap.ts holds
 * the paper), in Wow.exe's order:
 *
 * - Using wrapping paper — the native bag's double click or its «Использовать» entry, the native
 *   UseContainerItem — arms it instead of sending CMSG_USE_ITEM (`Item::Use` 0x00708c20 → 0x006d67e0),
 *   unless the item is a wrapped gift, which opens.
 * - With paper waiting, a plain click on a container item — the backpack, a carried bag's contents,
 *   the keyring: the places `PickupContainerItem` (0x005d7ff0) answers for — wraps it
 *   (0x006dcf20 → CMSG_WRAP_ITEM). A locked item — here the paper itself — eats the click and the
 *   paper keeps waiting. Worn items, the bag bar and the bank are not containers' clicks:
 *   `PickupInventoryItem` does not look at the paper.
 */

type NativeWrapWorld = GiftWrapWorld & { itemTemplate?(entry: number): { flags?: number } | undefined };

/** A container slot `PickupContainerItem` answers for: backpack 23..38, a bag's contents, the keyring 86..117. */
export function nativeWrapPlace(slot: ItemSlotState): boolean {
  if (slot.bag !== INVENTORY_SLOT_BAG_0) return slot.bag >= INVENTORY_SLOT_BAG_START && slot.bag < INVENTORY_SLOT_BAG_START + 4;
  return (slot.slot >= INVENTORY_SLOT_ITEM_START && slot.slot < INVENTORY_SLOT_ITEM_START + 16)
    || (slot.slot >= KEYRING_SLOT_START && slot.slot < KEYRING_SLOT_START + KEYRING_SLOTS);
}

/** A native use of a container item: wrapping paper waits for its item instead. True when it was paper. */
export function armNativeGiftWrap(slot: ItemSlotState, world: NativeWrapWorld | undefined = game.world): boolean {
  if (!world || !slot.item || slot.guid === 0n || !nativeWrapPlace(slot)) return false;
  const entry = slot.item.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  if (!isWrappingPaper(slot.item, world.itemTemplate?.(entry)?.flags)) return false;
  return armGiftWrap(world, { bag: slot.bag, slot: slot.slot, guid: slot.guid });
}

/** A native click on a container item while paper waits: the wrap's (sent, or eaten when locked). */
export function wrapNativeSlot(slot: ItemSlotState, world: NativeWrapWorld | undefined = game.world): boolean {
  if (!world || !slot.item || slot.guid === 0n || !nativeWrapPlace(slot) || !pendingGiftWrap(world)) return false;
  return wrapWithPendingPaper(world, { bag: slot.bag, slot: slot.slot, guid: slot.guid }, giftWrapLocks(world, slot.guid));
}
