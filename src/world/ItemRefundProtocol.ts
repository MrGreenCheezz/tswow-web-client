import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";
import { formatGlobalStringByName } from "./GlobalStringFormat.js";

/**
 * Item purchase refunds (plan item 2.10): an item bought for an `ItemExtendedCost` (honor, arena
 * points, tokens) can be sold back for its full price within two hours of played time.
 *
 * Wire layouts are the core's (`Player::SendRefundInfo`, Player.cpp:26896; `Player::RefundItem`,
 * :26967; `WorldSession::HandleItemRefundInfoRequest`/`HandleItemRefund`, ItemHandler.cpp:1219-1254);
 * the client rules are Wow.exe's, cited where they are applied.
 */

/** `ITEM_FLAG_ITEM_PURCHASE_RECORD` (ItemTemplate.h:168): the template bit the client asks refund info for. */
export const ITEM_FLAG_ITEM_PURCHASE_RECORD = 0x1000;
/** Two hours of played time: the refund window (`Item::IsRefundExpired`, Item.cpp:1221-1224; Wow.exe `+ 0x1c20`). */
export const ITEM_REFUND_WINDOW_SECONDS = 7200;
/** `SMSG_ITEM_REFUND_RESULT` codes the client names (Wow.exe 0x006d9b40). */
export const ITEM_REFUND_ERROR_INVENTORY_FULL = 10;
export const ITEM_REFUND_ERROR_CURRENCY_FULL = 11;

export interface ItemRefundCost {
  readonly money: number;
  readonly honor: number;
  readonly arena: number;
  /** The five `ItemExtendedCost` item columns, zeros included, in order. */
  readonly items: readonly { readonly itemId: number; readonly count: number }[];
}

export interface ItemRefundInfo extends ItemRefundCost {
  /**
   * The last word of `SMSG_ITEM_REFUND_INFO_RESPONSE`: `GetTotalPlayedTime() − item->GetPlayedTime()`,
   * the player's played seconds at the purchase. The client keeps it as is (item info +0x38) and
   * reads the time left as `stamp − playedNow + 7200` (0x005d8d80, 0x006277f0).
   */
  readonly purchasedAtPlayed: number;
}

export interface ItemRefundResult {
  readonly guid: bigint;
  readonly code: number;
  /** Present with code 0 only: what came back. */
  readonly cost?: ItemRefundCost;
}

/** `CMSG_ITEM_REFUND_INFO`: the item's guid (Wow.exe 0x007089e0). */
export function buildItemRefundInfo(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

/** `CMSG_ITEM_REFUND`: the item's guid (Wow.exe 0x005d91b0). */
export function buildItemRefund(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

function readCost(reader: PacketReader): ItemRefundCost {
  const money = reader.u32();
  const honor = reader.u32();
  const arena = reader.u32();
  const items: { itemId: number; count: number }[] = [];
  for (let index = 0; index < 5; index++) items.push({ itemId: reader.u32(), count: reader.u32() });
  return { money, honor, arena, items };
}

/** `SMSG_ITEM_REFUND_INFO_RESPONSE` (Player.cpp:26921-26933; read by Wow.exe 0x006d1650). */
export function parseItemRefundInfo(payload: Uint8Array): { guid: bigint; info: ItemRefundInfo } {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const cost = readCost(reader);
  reader.u32(); // always 0 (item info +0x34)
  const purchasedAtPlayed = reader.u32();
  reader.assertFinished();
  return { guid, info: { ...cost, purchasedAtPlayed } };
}

/** `SMSG_ITEM_REFUND_RESULT`: guid, code, and on success the cost that came back (Player.cpp:26967-27045). */
export function parseItemRefundResult(payload: Uint8Array): ItemRefundResult {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const code = reader.u32();
  if (code !== 0) {
    reader.assertFinished();
    return { guid, code };
  }
  const cost = readCost(reader);
  reader.assertFinished();
  return { guid, code, cost };
}

/** Seconds of refund left, or undefined when none: Wow.exe's `stamp − playedNow + 7200`, only while > 0. */
export function itemRefundSecondsLeft(info: ItemRefundInfo | undefined, playedNow: number | undefined): number | undefined {
  if (!info) return undefined;
  // 0x006cf440 answers 0 while the client has no played time; the arithmetic is kept as is.
  const left = info.purchasedAtPlayed - (playedNow ?? 0) + ITEM_REFUND_WINDOW_SECONDS;
  return left > 0 ? left : undefined;
}

/**
 * The client's refund record per item (Wow.exe keeps it on the item object, +0x3d4) and its
 * «asked once» bit (+0x394 bit 2, set by 0x007089e0 before it sends).
 */
export class ItemRefunds {
  readonly info = new Map<bigint, ItemRefundInfo>();
  readonly #asked = new Set<bigint>();

  /** Whether `CMSG_ITEM_REFUND_INFO` should go out for this item now — at most once per item. */
  shouldAsk(guid: bigint): boolean {
    if (guid === 0n || this.info.has(guid) || this.#asked.has(guid)) return false;
    this.#asked.add(guid);
    return true;
  }

  /** The response for an item the client holds; one for an unknown item is dropped (0x006d1650). */
  accept(guid: bigint, info: ItemRefundInfo, itemKnown: boolean): boolean {
    if (!itemKnown) return false;
    this.info.set(guid, info);
    return true;
  }

  forget(guid: bigint): void {
    this.info.delete(guid);
    this.#asked.delete(guid);
  }

  clear(): void {
    this.info.clear();
    this.#asked.clear();
  }
}

/** What `SMSG_ITEM_REFUND_RESULT` makes the client say: system lines, or one UI error. */
export interface ItemRefundMessages {
  /** Chat system lines, in order (Wow.exe 0x006d9b40 → 0x00509dd0). */
  readonly lines: readonly string[];
  /** A GlobalStrings key for UIErrorsFrame (game messages 0 and 0x2c8 are type 2, UI errors). */
  readonly error?: string;
}

/** The money line: GOLD_AMOUNT, SILVER_AMOUNT, COPPER_AMOUNT for the non-zero parts, joined by ", " (0x007e7d80). */
export function itemRefundMoneyText(copper: number): string {
  const parts: string[] = [];
  const gold = Math.floor(copper / 10000);
  const silver = Math.floor(copper / 100) % 100;
  const rest = copper % 100;
  if (gold > 0) parts.push(formatGlobalStringByName("GOLD_AMOUNT", [gold], "%d з"));
  if (silver > 0) parts.push(formatGlobalStringByName("SILVER_AMOUNT", [silver], "%d с"));
  if (rest > 0) parts.push(formatGlobalStringByName("COPPER_AMOUNT", [rest], "%d м"));
  return parts.join(", ");
}

/**
 * Wow.exe 0x006d9b40: code 0 prints ITEM_REFUND_MSG, then the money, then honor and arena points
 * (CURRENCY_AMOUNT_REFUND_FORMAT, each capped at what still fits under 75000 honor / 10000 arena
 * points from the player's current ones), then each cost item the item cache already names — one
 * line each. Code 10 is ERR_INV_FULL, 11 ERR_CURRENCY_FULL; any other code UNABLE_TO_REFUND_ITEM.
 */
export function itemRefundMessages(
  result: ItemRefundResult,
  facts: { honor: number; arena: number; itemName: (itemId: number) => string | undefined },
): ItemRefundMessages {
  if (result.code === ITEM_REFUND_ERROR_INVENTORY_FULL) return { lines: [], error: "ERR_INV_FULL" };
  if (result.code === ITEM_REFUND_ERROR_CURRENCY_FULL) return { lines: [], error: "ERR_CURRENCY_FULL" };
  if (result.code !== 0 || !result.cost) {
    return { lines: [formatGlobalStringByName("UNABLE_TO_REFUND_ITEM", [], "Извините, компенсировать затраты на предмет не удалось.")] };
  }
  const cost = result.cost;
  const amount = (count: number, name: string): string =>
    formatGlobalStringByName("CURRENCY_AMOUNT_REFUND_FORMAT", [count, name], "%2$s, %1$d");
  const lines = [formatGlobalStringByName("ITEM_REFUND_MSG", [], "За предмет получено возмещение:")];
  if (cost.money > 0) lines.push(itemRefundMoneyText(cost.money));
  if (cost.honor > 0) {
    const count = cost.honor + facts.honor < 75001 ? cost.honor : 75000 - facts.honor;
    lines.push(amount(count, formatGlobalStringByName("HONOR_POINTS", [], "Очки чести")));
  }
  if (cost.arena > 0) {
    const count = cost.arena + facts.arena < 10001 ? cost.arena : 10000 - facts.arena;
    lines.push(amount(count, formatGlobalStringByName("ARENA_POINTS", [], "Очки арены")));
  }
  for (const { itemId, count } of cost.items) {
    if (count <= 0) continue;
    const name = facts.itemName(itemId);
    if (name !== undefined) lines.push(amount(count, name));
  }
  return { lines };
}
