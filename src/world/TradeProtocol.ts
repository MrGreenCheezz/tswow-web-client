import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: TradeHandler.cpp `SendTradeStatus`,
// `SendUpdateTrade` and the client handlers, plus TradeData.h for `TRADE_SLOT_COUNT`.

/** `TRADE_SLOT_COUNT` in TradeData.h. The last slot is the "will not be traded" one. */
export const TRADE_SLOT_COUNT = 7;

/** `TradeStatus` in SharedDefines.h. */
export const TRADE_STATUS_BUSY = 0;
export const TRADE_STATUS_BEGIN_TRADE = 1;
export const TRADE_STATUS_OPEN_WINDOW = 2;
export const TRADE_STATUS_TRADE_CANCELED = 3;
export const TRADE_STATUS_TRADE_ACCEPT = 4;
export const TRADE_STATUS_BACK_TO_TRADE = 7;
export const TRADE_STATUS_TRADE_COMPLETE = 8;
export const TRADE_STATUS_CLOSE_WINDOW = 12;

export interface TradeStatus {
  status: number;
  /** Only for `BEGIN_TRADE`: who opened the trade. */
  traderGuid: bigint;
  /** Only for `CLOSE_WINDOW`: the `InventoryResult` that stopped it. */
  result: number;
  targetResult: boolean;
  itemLimitCategoryId: number;
  /** Only for the two realm/taplist refusals. */
  slot: number;
}

/** The body after the status word differs per status, and most statuses have none. */
export function parseTradeStatus(payload: Uint8Array): TradeStatus {
  const reader = new PacketReader(payload);
  const status = reader.u32();
  const info: TradeStatus = {
    status, traderGuid: 0n, result: 0, targetResult: false, itemLimitCategoryId: 0, slot: 0,
  };
  if (status === TRADE_STATUS_BEGIN_TRADE && reader.remaining >= 8) info.traderGuid = reader.u64();
  else if (status === TRADE_STATUS_OPEN_WINDOW && reader.remaining >= 4) reader.u32();
  else if (status === TRADE_STATUS_CLOSE_WINDOW && reader.remaining >= 9) {
    info.result = reader.u32();
    info.targetResult = reader.u8() !== 0;
    info.itemLimitCategoryId = reader.u32();
  } else if (reader.remaining === 1) info.slot = reader.u8();
  return info;
}

export interface TradeItem {
  slot: number;
  itemId: number;
  displayId: number;
  count: number;
  wrapped: boolean;
  giftCreator: bigint;
  enchantId: number;
  gemEnchantIds: [number, number, number];
  creator: bigint;
  charges: number;
  suffixFactor: number;
  randomPropertyId: number;
  lockId: number;
  maxDurability: number;
  durability: number;
}

export interface TradeOffer {
  /** True for the other player's side of the window, false for your own. */
  traderData: boolean;
  money: number;
  spellId: number;
  items: TradeItem[];
}

/**
 * `SendUpdateTrade` always writes all seven slots at a fixed 72 bytes each, filling empty ones
 * with zeroes, so the layout is fixed regardless of how much is on offer.
 */
export function parseTradeStatusExtended(payload: Uint8Array): TradeOffer {
  const reader = new PacketReader(payload);
  const traderData = reader.u8() !== 0;
  reader.u32();
  reader.u32();
  reader.u32();
  const money = reader.u32();
  const spellId = reader.u32();
  const items: TradeItem[] = [];
  for (let index = 0; index < TRADE_SLOT_COUNT; index++) {
    if (reader.remaining < 1 + 72) break;
    const slot = reader.u8();
    const itemId = reader.u32();
    const displayId = reader.u32();
    const count = reader.u32();
    const wrapped = reader.u32() !== 0;
    const giftCreator = reader.u64();
    const enchantId = reader.u32();
    const gemEnchantIds: [number, number, number] = [reader.u32(), reader.u32(), reader.u32()];
    const creator = reader.u64();
    const charges = reader.u32();
    const suffixFactor = reader.u32();
    const randomPropertyId = reader.u32();
    const lockId = reader.u32();
    const maxDurability = reader.u32();
    const durability = reader.u32();
    if (itemId === 0) continue;
    items.push({
      slot, itemId, displayId, count, wrapped, giftCreator, enchantId, gemEnchantIds,
      creator, charges, suffixFactor, randomPropertyId, lockId, maxDurability, durability,
    });
  }
  return { traderData, money, spellId, items };
}

export function buildInitiateTrade(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

/** `HandleSetTradeItemOpcode` reads the trade slot, then the bag and slot the item sits in. */
export function buildSetTradeItem(tradeSlot: number, bag: number, slot: number): Uint8Array {
  return new PacketWriter().u8(tradeSlot).u8(bag).u8(slot).toUint8Array();
}

export function buildClearTradeItem(tradeSlot: number): Uint8Array {
  return new PacketWriter().u8(tradeSlot).toUint8Array();
}

export function buildSetTradeGold(copper: number): Uint8Array {
  return new PacketWriter().u32(copper).toUint8Array();
}

const TRADE_MESSAGES: Record<number, string> = {
  0: "Игрок занят",
  3: "Обмен отменён",
  5: "Игрок занят",
  6: "Нет цели",
  8: "Обмен завершён",
  9: "Обмен отклонён",
  10: "Слишком далеко",
  11: "Игрок из другой фракции",
  14: "Игрок вас игнорирует",
  15: "Вы оглушены",
  16: "Игрок оглушён",
  17: "Вы мертвы",
  18: "Игрок мёртв",
  19: "Вы выходите из игры",
  20: "Игрок выходит из игры",
  21: "Недоступно для пробного аккаунта",
  22: "Можно обменивать только созданные предметы",
  23: "Этот предмет вам не принадлежит по добыче",
};

export function tradeStatusText(status: number): string {
  return TRADE_MESSAGES[status] ?? "";
}
