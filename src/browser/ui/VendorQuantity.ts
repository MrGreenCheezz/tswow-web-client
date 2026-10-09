/**
 * How many a Shift+click on a vendor's item may buy at once (WORK_PLAN 4.07).
 *
 * Stock `MerchantItemButton_OnModifiedClick` (MerchantFrame.lua:412-430) opens the stack split
 * frame on `IsModifiedClick("SPLITSTACK")` (Shift by default) with `GetMerchantItemMaxStack`, cut to
 * `floor(GetMoney() / price)` when the item has a money price, and buys the chosen number with
 * `BuyMerchantItem(index, n)`. The server reads that number as purchases of `BuyCount` items each
 * (`Player::BuyItemFromVendorSlot`, Player.cpp:22181-22322: `count` is a uint8, at least 1; the
 * stock check and the honor and arena price are per purchase × count).
 *
 * Wow.exe's `GetMerchantItemMaxStack` (0x005842d0) answers 1 for a row whose `BuyCount` (the
 * seventh uint32 of the SMSG_LIST_INVENTORY row) is 2 or more, and the item's stack otherwise; stock
 * Lua then opens nothing for a most of 1. `BuyMerchantItem` (0x005854c0) clamps the count to 255.
 * The vendor's stock caps it here too (the server refuses more, Player.cpp:22290-22292).
 */

/** CMSG_BUY_ITEM's count is a uint8. */
export const VENDOR_COUNT_LIMIT = 255;

export interface VendorQuantityInput {
  /** The item template's `stackable`; 0 or 1 for an item that does not stack. */
  readonly stackable: number;
  readonly buyCount: number;
  /** Items the vendor has left, or a negative number for an unlimited row. */
  readonly leftInStock: number;
  /** The price of one purchase (`BuyCount` items), in copper. */
  readonly price: number;
  readonly extendedCost: number;
  readonly money: number;
}

/** The most purchases one Shift+click may ask for, at least 1. */
export function vendorMaxUnits(input: VendorQuantityInput): number {
  if (input.buyCount >= 2) return 1;
  let max = Math.max(1, Math.trunc(input.stackable) || 1);
  if (input.leftInStock >= 0) max = Math.min(max, Math.floor(input.leftInStock));
  // A special price is honor, arena points or items: the server checks it, as stock leaves it.
  if (input.extendedCost <= 0 && input.price > 0) max = Math.min(max, Math.floor(Math.max(0, input.money) / input.price));
  return Math.max(1, Math.min(VENDOR_COUNT_LIMIT, max));
}

/** What `units` purchases cost in copper. */
export function vendorTotal(price: number, units: number): number {
  return Math.max(0, price) * Math.max(0, Math.trunc(units));
}
