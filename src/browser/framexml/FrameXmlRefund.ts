/**
 * Item purchase refunds for the stock UI (plan item 2.10), as Wow.exe answers them:
 *
 * - `GetContainerItemPurchaseInfo(bag, slot[, isEquipped])` (0x005d8d80) — for an item that is not
 *   the one being looted (0x00bfa8d8, the loot guid), has a refund record, is not enchanted or
 *   socketed (0x00708ac0) and has time left (`stamp − played + 7200 > 0`): money, honor points,
 *   arena points, the number of cost items with a count, and the seconds left. **Nothing** otherwise —
 *   not nil values: `ContainerFrame_GetExtendedPriceString` then treats the click as a sale.
 * - `GetContainerItemPurchaseItem(bag, slot, index[, isEquipped])` (0x005d8f70) — the index-th cost
 *   item with a count: texture, count and link (nil until the item cache has the item).
 * - `ContainerRefundItemPurchase(bag, slot[, isEquipped])` (0x005d91b0) — `CMSG_ITEM_REFUND` with a
 *   record and a merchant open; ERR_INTERNAL_BAG_ERROR otherwise.
 * - `EndRefund(kind)` (0x00523370) — END_REFUND's accept: 1 re-runs the enchant for the item named
 *   last (0x005210d0 with the question answered), 2 sends the staged gems (0x005c4ff0, AcceptSockets).
 *
 * `isEquipped` takes `slot` as an inventory slot 1-19 (`0x12 < slot - 1` refuses the rest).
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { itemRefundSecondsLeft, type ItemRefundInfo } from "../../world/ItemRefundProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { FrameXmlSeamBinding, FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";

const NOTHING: readonly unknown[] = Object.freeze([]);

/** The enchantment slots 0x00708ac0 looks at: permanent (0), sockets 1 and 2 (2, 3), prismatic (6). */
const REFUND_BLOCKING_ENCHANT_SLOTS = [0, 2, 3, 6] as const;

/**
 * Wow.exe 0x00708ac0: an item with a permanent enchantment, a gem in its first two sockets or a
 * prismatic socket's gem shows no refund. (The client first tests a bit 13 of a word from the item's
 * vtable, not modelled here, the same unknown the 2.05 notes record for 0x007073e0.)
 */
export function frameXmlRefundBlockedByEnchant(item: WorldObjectState): boolean {
  const base = UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset;
  for (const slot of REFUND_BLOCKING_ENCHANT_SLOTS) {
    if ((item.fields.get(base + slot * 3) ?? 0) !== 0) return true;
  }
  return false;
}

/**
 * Whether an item still shows a refund: a record, no blocking enchantment (0x00708ac0) and time
 * left (`stamp − played + 7200 > 0`) — the test `GetSocketItemRefundable` (0x005c50e0) and the
 * tooltip line (0x006277f0) make; the container API adds the loot check (#record below).
 */
export function frameXmlItemRefundable(
  item: WorldObjectState | undefined, info: ItemRefundInfo | undefined, played: number | undefined,
): boolean {
  return item !== undefined && info !== undefined && !frameXmlRefundBlockedByEnchant(item)
    && itemRefundSecondsLeft(info, played) !== undefined;
}

export interface FrameXmlRefundItem {
  readonly guid: bigint;
  readonly item: WorldObjectState;
}

/** What the model reads; LiveWorldSeam supplies it from the world. */
export interface FrameXmlRefundHost {
  /** The item at a container place, or at an inventory slot 1-19 when `equipped`. */
  item(bag: number, slot: number, equipped: boolean): FrameXmlRefundItem | undefined;
  info(guid: bigint): ItemRefundInfo | undefined;
  /** 0x006cf440: played seconds now; undefined reads as 0, as the client's does. */
  played(): number | undefined;
  /** The guid being looted (0x00bfa8d8), if any. */
  lootGuid(): bigint | undefined;
  itemTexture(entry: number): string | undefined;
  /** A chat link only when the item cache holds the entry (0x0061e360 needs the cache row). */
  itemLink(entry: number): string | undefined;
  /** `CMSG_ITEM_REFUND`; the GlobalStrings key of the client's refusal, or undefined when sent. */
  refund(guid: bigint): string | undefined;
  /**
   * `CMSG_ITEM_REFUND_INFO` when the world's rules allow (0x007089e0: template flag 0x1000, once).
   * 2.10 (04.10, L4): true when the request went out with this call.
   */
  ask?(guid: bigint): boolean | void;
}

export type FrameXmlPurchaseInfo = readonly [number, number, number, number, number];

export class FrameXmlRefundModel {
  readonly #host: FrameXmlRefundHost;

  constructor(host: FrameXmlRefundHost) {
    this.#host = host;
  }

  #record(bag: number, slot: number, equipped: boolean): { info: ItemRefundInfo; left: number } | undefined {
    if (equipped && (slot < 1 || slot > 19)) return undefined;
    const place = this.#host.item(bag, slot, equipped);
    if (!place || place.guid === this.#host.lootGuid()) return undefined;
    const info = this.#host.info(place.guid);
    if (!info || frameXmlRefundBlockedByEnchant(place.item)) return undefined;
    const left = itemRefundSecondsLeft(info, this.#host.played());
    return left === undefined ? undefined : { info, left };
  }

  purchaseInfo(bag: number, slot: number, equipped: boolean): FrameXmlPurchaseInfo | undefined {
    const record = this.#record(bag, slot, equipped);
    if (!record) return undefined;
    const { info, left } = record;
    const counted = info.items.filter((cost) => cost.count > 0).length;
    return [info.money, info.honor, info.arena, counted, left];
  }

  purchaseItem(bag: number, slot: number, index: number, equipped: boolean): readonly unknown[] | undefined {
    const record = this.#record(bag, slot, equipped);
    if (!record) return undefined;
    // 0x005d8f70 indexes the columns that name an item (record +0xc), whatever their count; the
    // number GetContainerItemPurchaseInfo reports counts the columns with a count (+0x20).
    let seen = 0;
    for (const cost of record.info.items) {
      if (cost.itemId <= 0) continue;
      if (seen === index - 1) {
        return [this.#host.itemTexture(cost.itemId), cost.count, this.#host.itemLink(cost.itemId)];
      }
      seen += 1;
    }
    return undefined;
  }

  /**
   * The item tooltip's refund line (Wow.exe 0x006277f0, SetBagItem/SetInventoryItem): the seconds
   * left for an item with a record, no blocking enchantment and time left — no loot check here. With
   * no record the tooltip asks the realm (0x007089e0, which holds the template flag and once-only
   * rules) and shows nothing yet. 2.10 (04.10, L4): 0 when that request went out with this call —
   * no line, but 0x006277f0 then writes no sell price either.
   */
  tooltipSeconds(bag: number, slot: number, equipped: boolean): number | undefined {
    if (equipped && (slot < 1 || slot > 19)) return undefined;
    const place = this.#host.item(bag, slot, equipped);
    if (!place) return undefined;
    const info = this.#host.info(place.guid);
    if (!info) return this.#host.ask?.(place.guid) === true ? 0 : undefined; // 2.10 (04.10, L4)
    if (frameXmlRefundBlockedByEnchant(place.item)) return undefined;
    return itemRefundSecondsLeft(info, this.#host.played());
  }

  /** The GlobalStrings key UIErrorsFrame shows when the client refuses, undefined when sent. */
  refund(bag: number, slot: number, equipped: boolean): string | undefined {
    if (equipped && (slot < 1 || slot > 19)) return "ERR_INTERNAL_BAG_ERROR";
    const place = this.#host.item(bag, slot, equipped);
    if (!place) return "ERR_INTERNAL_BAG_ERROR";
    return this.#host.refund(place.guid);
  }
}

function integer(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

/** Lua truthiness of the optional `isEquipped` argument (nil and false are false; 0 is true). */
function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

export const FRAMEXML_REFUND_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  GetContainerItemPurchaseInfo: (seam: FrameXmlWorldSeam, args) =>
    seam.containerItemPurchaseInfo?.(integer(args[0]), integer(args[1]), truthy(args[2])) ?? NOTHING,
  GetContainerItemPurchaseItem: (seam: FrameXmlWorldSeam, args) =>
    seam.containerItemPurchaseItem?.(integer(args[0]), integer(args[1]), integer(args[2]), truthy(args[3])) ?? NOTHING,
  ContainerRefundItemPurchase: (seam: FrameXmlWorldSeam, args) => {
    seam.containerRefundItemPurchase?.(integer(args[0]), integer(args[1]), truthy(args[2]));
    return NOTHING;
  },
  EndRefund: (seam: FrameXmlWorldSeam, args) => {
    seam.endRefund?.(integer(args[0]));
    return NOTHING;
  },
});
