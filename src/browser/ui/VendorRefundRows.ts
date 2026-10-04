// Plan item 2.10 (04.10, L4): the rows of the native vendor window's purchase refunds (VendorRefund.ts
// draws them) — one per carried item the merchant can take back. The rules are the stock ones
// (framexml/FrameXmlRefund.ts, Wow.exe 0x005d8d80/0x005d91b0): a refund record, no permanent
// enchantment or gem (0x00708ac0), time left (`stamp − played + 7200`), the worn items, the backpack
// and the four bags (0x006d1760's sweep). A click asks first, as the stock CONFIRM_REFUND_TOKEN_ITEM
// does, then sends CMSG_ITEM_REFUND (WorldClient.refundItem); the realm's answer arrives as the
// usual system lines.

import { globalString } from "../../generated/globalStrings.js";
import { itemRefundSecondsLeft, type ItemRefundInfo } from "../../world/ItemRefundProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { frameXmlRefundBlockedByEnchant } from "../framexml/FrameXmlRefund.js";
import { playerInventory } from "../Inventory.js";
import type { WorldClient } from "../../world/WorldClient.js";

/** One item the open merchant would take back. */
export interface VendorRefundRow {
  readonly guid: bigint;
  readonly entry: number;
  readonly info: ItemRefundInfo;
  /** Seconds of the two hours left. */
  readonly left: number;
}

/** What the rows read; WorldClient satisfies it. */
export type VendorRefundWorld = Pick<WorldClient, "state"> & {
  readonly itemRefunds: { readonly info: ReadonlyMap<bigint, ItemRefundInfo> };
};

/**
 * L4-review (04.10): ITEM_FIELD_FLAG_REFUNDABLE — the realm's own test (TrinityCore Item::IsRefundable,
 * ItemTemplate.h:130). It goes while the item stays (Item::SetNotRefundable, e.g. TSWoW's
 * Transmogrification.cpp:46), and Player::RefundItem then returns without an answer; the client's
 * record does not go with it, so the native rows read the flag too.
 */
const ITEM_FIELD_FLAG_REFUNDABLE = 0x1000;

/** The carried items with a refund the merchant would take, worn first, then backpack and bags. */
export function vendorRefundRows(world: VendorRefundWorld, played: number | undefined): VendorRefundRow[] {
  const inventory = playerInventory(world.state);
  const rows: VendorRefundRow[] = [];
  if (!inventory) return rows;
  const consider = (guid: bigint, item: WorldObjectState | undefined): void => {
    if (guid === 0n || !item) return;
    // L4-review: the realm's flag first (see ITEM_FIELD_FLAG_REFUNDABLE).
    if (((item.fields.get(UPDATE_FIELDS.ITEM_FIELD_FLAGS.offset) ?? 0) & ITEM_FIELD_FLAG_REFUNDABLE) === 0) return;
    const info = world.itemRefunds.info.get(guid);
    if (!info || frameXmlRefundBlockedByEnchant(item)) return;
    const left = itemRefundSecondsLeft(info, played);
    if (left === undefined) return;
    rows.push({ guid, entry: item.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0, info, left });
  };
  for (const slot of inventory.equipment) consider(slot.guid, slot.item);
  for (const slot of inventory.backpack) consider(slot.guid, slot.item);
  for (const bag of inventory.bags) for (const slot of bag.slots) consider(slot.guid, slot.item);
  return rows;
}

/**
 * L4-review (04.10): the confirm's own click. The question may have stayed open while the row went —
 * the two hours ran out (the realm would answer code 10, which reads as ERR_INV_FULL), an enchantment
 * went on, the flag went, the item left the carried slots — so the row is looked up again by its guid
 * and only a row still offered sends CMSG_ITEM_REFUND (WorldClient.refundItem). The GlobalStrings key
 * of a refusal, undefined when sent.
 */
export function vendorRefundConfirm(
  world: VendorRefundWorld & { refundItem(guid: bigint): string | undefined }, guid: bigint, played: number | undefined,
): string | undefined {
  if (!vendorRefundRows(world, played).some((row) => row.guid === guid)) return "ERR_INTERNAL_BAG_ERROR";
  return world.refundItem(guid);
}

/** «Предмет можно вернуть…» left out: the time alone, by the stock 0x006277f0 rule in minutes. */
export function vendorRefundTimeText(left: number): string {
  const minutes = Math.max(1, Math.floor(left / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин` : `${minutes} мин`;
}

/** The price the refund gives back, in the stock popup's words (money, honor, arena, items). */
export function vendorRefundCostText(info: ItemRefundInfo, money: (copper: number) => string,
  itemName: (entry: number) => string): string {
  const parts: string[] = [];
  if (info.money > 0) parts.push(money(info.money));
  if (info.honor > 0) parts.push(`${globalString("HONOR_POINTS") ?? "Очки чести"}: ${info.honor}`);
  if (info.arena > 0) parts.push(`${globalString("ARENA_POINTS") ?? "Очки арены"}: ${info.arena}`);
  for (const cost of info.items) if (cost.itemId > 0 && cost.count > 0) parts.push(`${itemName(cost.itemId)} ×${cost.count}`);
  return parts.join(", ");
}
