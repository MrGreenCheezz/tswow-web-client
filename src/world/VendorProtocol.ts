import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: ItemHandler.cpp `SendListInventory`,
// `HandleBuyItemOpcode`, `HandleSellItemOpcode`, `HandleBuybackItem`, plus Player.cpp
// `SendBuyError`, `SendSellError` and the SMSG_BUY_ITEM block in Player::BuyItemFromVendorSlot.

export interface VendorItem {
  /** One based, exactly as the server sends it; `CMSG_BUY_ITEM` expects the same numbering. */
  slot: number;
  itemId: number;
  displayId: number;
  /** -1 when the item is unlimited, otherwise how many are left in stock. */
  leftInStock: number;
  price: number;
  maxDurability: number;
  /** How many units one purchase yields. */
  buyCount: number;
  extendedCost: number;
}

export interface VendorInventory {
  guid: bigint;
  items: VendorItem[];
  /** Present only when the vendor sent an empty list. */
  error?: number;
}

export function parseListInventory(payload: Uint8Array): VendorInventory {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const count = reader.u8();
  if (count === 0) {
    const error = reader.remaining > 0 ? reader.u8() : 0;
    return { guid, items: [], error };
  }
  const items: VendorItem[] = [];
  for (let entry = 0; entry < count; entry++) {
    items.push({
      slot: reader.u32(),
      itemId: reader.u32(),
      displayId: reader.u32(),
      leftInStock: reader.i32(),
      price: reader.u32(),
      maxDurability: reader.u32(),
      buyCount: reader.u32(),
      extendedCost: reader.u32(),
    });
  }
  return { guid, items };
}

export interface BuyResult {
  guid: bigint;
  /** One based vendor slot. */
  slot: number;
  /** -1 when the vendor's stock is unlimited. */
  leftInStock: number;
  count: number;
}

export function parseBuyItem(payload: Uint8Array): BuyResult {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const slot = reader.u32();
  const leftInStock = reader.i32();
  const count = reader.u32();
  reader.assertFinished();
  return { guid, slot, leftInStock, count };
}

export interface BuyFailure {
  guid: bigint;
  itemId: number;
  /** `Player::SendBuyError` only writes this when it is non-zero. */
  param?: number | undefined;
  error: number;
}

export function parseBuyFailed(payload: Uint8Array): BuyFailure {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const itemId = reader.u32();
  // The optional parameter makes this packet 13 or 17 bytes long.
  const param = reader.remaining > 1 ? reader.u32() : undefined;
  const error = reader.u8();
  reader.assertFinished();
  return { guid, itemId, param, error };
}

export interface SellResult {
  guid: bigint;
  itemGuid: bigint;
  param?: number | undefined;
  error: number;
}

export function parseSellItem(payload: Uint8Array): SellResult {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const itemGuid = reader.u64();
  const param = reader.remaining > 1 ? reader.u32() : undefined;
  const error = reader.u8();
  reader.assertFinished();
  return { guid, itemGuid, param, error };
}

export function buildListInventory(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

/** `slot` is the one based number the vendor list carried. */
export function buildBuyItem(vendorGuid: bigint, itemId: number, slot: number, count: number): Uint8Array {
  return new PacketWriter().u64(vendorGuid).u32(itemId).u32(slot).u32(count).u8(0).toUint8Array();
}

export function buildSellItem(vendorGuid: bigint, itemGuid: bigint, count: number): Uint8Array {
  return new PacketWriter().u64(vendorGuid).u64(itemGuid).u32(count).toUint8Array();
}

export function buildBuybackItem(vendorGuid: bigint, slot: number): Uint8Array {
  return new PacketWriter().u64(vendorGuid).u32(slot).toUint8Array();
}

// `BuyResult` in ItemDefines.h. The list is sparse, so unknown codes are reported as numbers.
const BUY_ERRORS: Record<number, string> = {
  0: "Товар не найден",
  1: "Товар уже продан",
  2: "Не хватает денег",
  4: "Торговец не хочет с вами торговать",
  5: "Слишком далеко",
  7: "Товар закончился",
  8: "Некуда положить",
  11: "Нужно звание",
  12: "Нужна репутация",
};

// `SellResult` in ItemDefines.h, which starts at one. `SMSG_SELL_ITEM` is only ever written by
// `Player::SendSellError`, so this packet always means failure - a successful sale is visible
// only through the following object update.
const SELL_ERRORS: Record<number, string> = {
  1: "Предмет не найден",
  2: "Торговец не берёт такой предмет",
  3: "Торговец не хочет с вами торговать",
  4: "Это не ваш предмет",
  5: "Продать не удалось",
  6: "Сумку можно продать только пустой",
  7: "Этому торговцу продавать нельзя",
};

export function buyErrorText(error: number): string {
  return BUY_ERRORS[error] ?? `Покупка не удалась (код ${error})`;
}

export function sellErrorText(error: number): string {
  return SELL_ERRORS[error] ?? `Продажа не удалась (код ${error})`;
}
