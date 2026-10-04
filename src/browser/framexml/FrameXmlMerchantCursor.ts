import type { WorldState } from "../../world/WorldState.js";
import { INVENTORY_SLOT_BAG_0, playerInventory } from "../Inventory.js";
import type { FrameXmlCursorModel } from "./FrameXmlCursor.js";

/**
 * A merchant row on the cursor (plan item 3.23 slice E, lane L1): `PickupMerchantItem` and the drops
 * that buy into a chosen place. Wow.exe 12340, read-only Ghidra (`.runtime/re-2026-10-03/l1-item-cursor/`,
 * earlier `.runtime/re-2026-09-30/a1-fgc/d1.c`, `repair-review/r1.c`):
 *
 * - `PickupMerchantItem(index)` (0x005853a0): with a bag item held it is sold — CMSG_SELL_ITEM with the
 *   held count (0x006d2d40), unless the hand holds a split part smaller than its stack, which stays — and
 *   the hand lets go; otherwise a number naming a row the open merchant lists (0x00584080: index − 1 in
 *   range, its list slot non-zero) puts that row on the cursor (0x00520d30: type 5, the item id, its
 *   picture, the index; CURSOR_UPDATE), or lets it go when that item is held already; anything else —
 *   `PickupMerchantItem(0)` from MerchantFrame's OnMouseUp — lets go (0x00519280).
 * - `GetCursorInfo()` (0x00515200) answers type 5 with "merchant" and the index (one-based);
 *   `CursorHasItem()` (0x00515100) is false for it (types 1 and 9 only).
 * - `PickupContainerItem(bag, slot)` (0x005d7ff0) with the row held and a merchant open:
 *   CMSG_BUY_ITEM_IN_SLOT (0x006d2ea0) into that container slot, count 1, and the hand lets go; with no
 *   merchant nothing happens and the row stays.
 * - `PickupInventoryItem(id)` (0x005e85d0): the same into the player's own slot id − 1 when a merchant is
 *   open and the row is still listed (else nothing); the AmmoSlot (id 0) lets the row go.
 * - `UseContainerItem` (0x005d8650) lets any cursor go first (0x00519280(1, 1)), the row included.
 *
 * Not modelled: 0x005853a0 compares the held id with the row's for any cursor type that keeps one
 * (a guild-vault item of the same entry, too); here only a held row is compared.
 */

/** The world's share of a purchase into a place (`WorldClient` has it). */
export interface FrameXmlMerchantBuyWorld {
  readonly state: WorldState;
  readonly vendor?: unknown;
  buyFromVendorInSlot?(slot: number, itemId: number, bagGuid: bigint, bagSlot: number, count?: number): boolean;
}

/** The guid CMSG_BUY_ITEM_IN_SLOT names a container by: the player for bag 255, else the carried bag. */
export function frameXmlMerchantBagGuid(state: WorldState, bag: number): bigint | undefined {
  if (bag === INVENTORY_SLOT_BAG_0) return state.selfGuid;
  const inventory = playerInventory(state);
  return inventory ? [...inventory.bags, ...inventory.bankBags].find((container) => container.bagSlot === bag)?.guid : undefined;
}

/**
 * The held row into `place` (bag and slot as the item opcodes address it): undefined with no merchant
 * open, true when CMSG_BUY_ITEM_IN_SLOT went out, false otherwise.
 */
export function frameXmlBuyMerchantItemInSlot(
  world: FrameXmlMerchantBuyWorld | undefined,
  row: { readonly slot: number; readonly itemId: number } | undefined,
  place: { readonly bag: number; readonly slot: number } | undefined,
): boolean | undefined {
  if (!world?.vendor) return undefined;
  if (!row || row.slot === 0 || !place) return false;
  const bagGuid = frameXmlMerchantBagGuid(world.state, place.bag);
  if (bagGuid === undefined || bagGuid === 0n) return false;
  return world.buyFromVendorInSlot?.(row.slot, row.itemId, bagGuid, place.slot, 1) === true;
}

/** The seam calls a merchant cursor needs (FrameXmlWorldSeam's optional L1 members). */
export interface FrameXmlMerchantCursorSeam {
  readonly cursor?: FrameXmlCursorModel | undefined;
  sellCursorItemToMerchant?(): boolean;
  merchantItemEntry?(index: number): number | undefined;
  buyMerchantItemInSlot?(index: number, bagId: number | undefined, slot: number): boolean | undefined;
}

/** A Lua number as 0x005853a0 reads it (lua_isnumber, then truncated), or undefined. */
function luaIndex(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? Math.trunc(number) : undefined;
}

/** `PickupMerchantItem(index)` (0x005853a0). */
export function frameXmlPickupMerchantItem(seam: FrameXmlMerchantCursorSeam, value: unknown): void {
  const cursor = seam.cursor;
  if (!cursor) return;
  if (seam.sellCursorItemToMerchant?.() === true) {
    cursor.sync();
    return;
  }
  const index = luaIndex(value);
  const entry = index !== undefined && index >= 1 ? seam.merchantItemEntry?.(index) : undefined;
  if (index === undefined || entry === undefined) {
    cursor.clear();
    return;
  }
  const held = cursor.held();
  if (held?.kind === "merchant" && held.entry === entry) cursor.clear();
  else cursor.pickupMerchantItem(index, entry);
}

/**
 * A container (`bagId`) or paper-doll (`bagId` undefined, `slot` the inventory id) click while a row is
 * held: true when the click was the row's (bought, kept or let go), false when no row is held.
 */
export function frameXmlDropHeldMerchantItem(seam: FrameXmlMerchantCursorSeam, bagId: number | undefined, slot: number): boolean {
  const cursor = seam.cursor;
  const held = cursor?.held();
  if (!cursor || held?.kind !== "merchant") return false;
  if (bagId === undefined && slot === 0) {
    cursor.clear();
    return true;
  }
  // L1-review: the row at the held index must still be the held item. Wow.exe buys whatever row stands
  // at the stored index now (0x005d7ff0/0x005e85d0 → 0x00584080 → 0x006d2ea0 sends that row's item);
  // whether its type-5 cursor outlives a closed merchant is not established, and this one does — so a
  // row taken at one merchant would buy another merchant's row. Such a row is let go as a vanished one is
  // (a container slot lets go, a paper-doll slot keeps it); nothing is bought.
  const listed = seam.merchantItemEntry?.(held.index);
  if (listed !== undefined && listed !== held.entry) {
    if (bagId !== undefined) cursor.clear();
    return true;
  }
  const sent = seam.buyMerchantItemInSlot?.(held.index, bagId, slot);
  // A container slot lets the row go whenever a merchant is open; a paper-doll slot only on a purchase.
  if (sent === true || (bagId !== undefined && sent === false)) cursor.clear();
  return true;
}
