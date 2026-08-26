import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: AuctionHouseHandler.cpp (`SendAuctionHello`,
// `SendAuctionCommandResult`, the bidder and owner notifications, and every client handler) and
// AuctionHouseMgr.cpp `AuctionEntry::BuildAuctionInfo`.
//
// Nothing here uses a packed GUID, and the auction entry is a fixed 148 bytes with no conditional
// fields inside it. `SMSG_AUCTION_REMOVED_NOTIFICATION` exists as an opcode but this core never
// sends it, so there is nothing to parse.

/** `MAX_INSPECTED_ENCHANTMENT_SLOT`: the entry always carries seven enchantment triples. */
const ENCHANTMENT_SLOTS = 7;

/** `AuctionAction` in AuctionHouseMgr.h, written as int32 despite being a uint8 enum. */
export const AUCTION_SELL_ITEM = 0;
export const AUCTION_CANCEL = 1;
export const AUCTION_PLACE_BID = 2;

/** `AuctionError` in AuctionHouseMgr.h. Only `ERR_AUCTION_INVENTORY` grows the result packet. */
export const ERR_AUCTION_OK = 0;
export const ERR_AUCTION_INVENTORY = 1;

/** `etime` is sent in minutes and the server only accepts these three. */
export const AUCTION_DURATION_SHORT = 720;
export const AUCTION_DURATION_MEDIUM = 1440;
export const AUCTION_DURATION_LONG = 2880;

/** Filter value meaning "any" for the uint32 fields of the search. */
export const AUCTION_FILTER_ANY = 0xffffffff;

export interface AuctionHello {
  auctioneerGuid: bigint;
  houseId: number;
  enabled: boolean;
}

export function parseAuctionHello(payload: Uint8Array): AuctionHello {
  const reader = new PacketReader(payload);
  const auctioneerGuid = reader.u64();
  const houseId = reader.u32();
  const enabled = reader.u8() !== 0;
  return { auctioneerGuid, houseId, enabled };
}

export interface AuctionEntry {
  auctionId: number;
  itemId: number;
  randomPropertyId: number;
  suffixFactor: number;
  count: number;
  spellCharges: number;
  itemFlags: number;
  /** Only the low 32 bits are meaningful: the server widens a counter, not a real GUID. */
  ownerLow: bigint;
  startBid: number;
  /** Zero until someone has bid; then it is the minimum increment over the current bid. */
  minIncrement: number;
  buyout: number;
  /** Milliseconds, not seconds. */
  timeLeft: number;
  bidderLow: bigint;
  bid: number;
}

function readAuctionEntry(reader: PacketReader): AuctionEntry {
  const auctionId = reader.u32();
  const itemId = reader.u32();
  // Seven enchantment slots, three uint32 each; the count is a constant and never sent.
  for (let slot = 0; slot < ENCHANTMENT_SLOTS * 3; slot++) reader.u32();
  return {
    auctionId,
    itemId,
    randomPropertyId: reader.i32(),
    suffixFactor: reader.u32(),
    count: reader.u32(),
    spellCharges: reader.u32(),
    itemFlags: reader.u32(),
    ownerLow: reader.u64(),
    startBid: reader.u32(),
    minIncrement: reader.u32(),
    buyout: reader.u32(),
    timeLeft: reader.u32(),
    bidderLow: reader.u64(),
    bid: reader.u32(),
  };
}

export interface AuctionList {
  entries: AuctionEntry[];
  /** Total matches on the server; can exceed `entries.length` across pages or broken lots. */
  totalCount: number;
  /** Search cooldown the server asks the client to honour, in milliseconds. */
  searchDelay: number;
}

/**
 * The count comes first as a placeholder the server backfills, then the entries, and the total
 * only at the end. A broken lot is skipped entirely, so the count can be below the total.
 */
export function parseAuctionListResult(payload: Uint8Array): AuctionList {
  const reader = new PacketReader(payload);
  const count = reader.u32();
  if (count > 60000) throw new RangeError(`Auction list declares ${count} entries`);
  const entries: AuctionEntry[] = [];
  for (let index = 0; index < count; index++) entries.push(readAuctionEntry(reader));
  const totalCount = reader.remaining >= 4 ? reader.u32() : count;
  const searchDelay = reader.remaining >= 4 ? reader.u32() : 0;
  return { entries, totalCount, searchDelay };
}

export interface AuctionCommandResult {
  auctionId: number;
  command: number;
  error: number;
  /** Present only when the error is `ERR_AUCTION_INVENTORY`, making the packet 16 bytes. */
  bagResult: number;
}

export function parseAuctionCommandResult(payload: Uint8Array): AuctionCommandResult {
  const reader = new PacketReader(payload);
  const auctionId = reader.i32();
  const command = reader.i32();
  const error = reader.i32();
  const bagResult = error === ERR_AUCTION_INVENTORY && reader.remaining >= 4 ? reader.i32() : 0;
  return { auctionId, command, error, bagResult };
}

export interface AuctionBidderNotification {
  /** The auction house's faction location: 2 alliance, 6 horde, 7 neutral. */
  houseId: number;
  auctionId: number;
  /** Who holds the lot now: the player themselves on a win, somebody else on an outbid. */
  bidderGuid: bigint;
  /** The new winning bid. */
  bidSum: number;
  /** How much more than the previous bid it was. */
  diff: number;
  itemId: number;
}

/**
 * "You have been outbid" — and also "you won", on the same opcode, with nothing in the packet
 * saying which.
 *
 * The only thing separating the two is whether `bidderGuid` is the player's own, so this cannot be
 * worded without knowing who the player is. The trailing word is a literal zero the core never
 * fills; it is read so the packet is accounted for rather than left half-consumed.
 */
export function parseAuctionBidderNotification(payload: Uint8Array): AuctionBidderNotification {
  const reader = new PacketReader(payload);
  const notification: AuctionBidderNotification = {
    houseId: reader.u32(),
    auctionId: reader.u32(),
    bidderGuid: reader.u64(),
    bidSum: reader.u32(),
    diff: reader.u32(),
    itemId: reader.u32(),
  };
  reader.u32();
  reader.assertFinished();
  return notification;
}

export function buildAuctionHello(auctioneerGuid: bigint): Uint8Array {
  return new PacketWriter().u64(auctioneerGuid).toUint8Array();
}

export interface AuctionSearch {
  page?: number;
  name?: string;
  levelMin?: number;
  levelMax?: number;
  inventoryType?: number;
  itemClass?: number;
  itemSubClass?: number;
  quality?: number;
  usableOnly?: boolean;
  getAll?: boolean;
}

/**
 * The field order is not the obvious one: `quality` is a uint32 and comes before the `usable`
 * byte, and the packet ends with a client-side sort block the server reads only to keep the
 * buffer aligned.
 */
export function buildAuctionListItems(auctioneerGuid: bigint, search: AuctionSearch = {}): Uint8Array {
  return new PacketWriter()
    .u64(auctioneerGuid)
    .u32(search.page ?? 0)
    .cString(search.name ?? "")
    .u8(search.levelMin ?? 0)
    .u8(search.levelMax ?? 0)
    .u32(search.inventoryType ?? AUCTION_FILTER_ANY)
    .u32(search.itemClass ?? AUCTION_FILTER_ANY)
    .u32(search.itemSubClass ?? AUCTION_FILTER_ANY)
    .u32(search.quality ?? AUCTION_FILTER_ANY)
    .u8(search.usableOnly ? 1 : 0)
    .u8(search.getAll ? 1 : 0)
    .u8(0)
    .toUint8Array();
}

export function buildAuctionListOwnerItems(auctioneerGuid: bigint, page = 0): Uint8Array {
  return new PacketWriter().u64(auctioneerGuid).u32(page).toUint8Array();
}

export function buildAuctionPlaceBid(auctioneerGuid: bigint, auctionId: number, price: number): Uint8Array {
  return new PacketWriter().u64(auctioneerGuid).u32(auctionId).u32(price).toUint8Array();
}

export function buildAuctionRemoveItem(auctioneerGuid: bigint, auctionId: number): Uint8Array {
  return new PacketWriter().u64(auctioneerGuid).u32(auctionId).toUint8Array();
}

/** `duration` is in minutes; the server only accepts 720, 1440 and 2880. */
export function buildAuctionSellItem(
  auctioneerGuid: bigint,
  items: Array<{ guid: bigint; count: number }>,
  startBid: number,
  buyout: number,
  duration: number,
): Uint8Array {
  const writer = new PacketWriter().u64(auctioneerGuid).u32(items.length);
  for (const item of items) writer.u64(item.guid).u32(item.count);
  return writer.u32(startBid).u32(buyout).u32(duration).toUint8Array();
}

// `AuctionError` in AuctionHouseMgr.h. The list is sparse - 6, 8, 9, 11 and 12 do not exist.
const AUCTION_ERRORS: Record<number, string> = {
  0: "Готово",
  1: "Некуда положить предмет",
  2: "Ошибка базы данных",
  3: "Не хватает денег",
  4: "Предмет не найден",
  5: "Ставка уже перебита",
  7: "Ставка ниже минимального шага",
  10: "Нельзя ставить на свой лот",
  13: "Ограниченный аккаунт",
};

export function auctionErrorText(error: number): string {
  return AUCTION_ERRORS[error] ?? `Ошибка аукциона (код ${error})`;
}

/** The next legal bid: the current bid plus the increment, or the start bid on an empty lot. */
export function nextBid(entry: AuctionEntry): number {
  return entry.bid > 0 ? entry.bid + entry.minIncrement : entry.startBid;
}

export interface AuctionOwnerNotification {
  auctionId: number;
  /** What it sold for. */
  bid: number;
  itemEntry: number;
}

/**
 * "Your auction sold."
 *
 * Four of its seven fields are literal zeros the core writes and never fills — including the
 * bidder guid, so the seller is never told who bought it — and the last of them is a float where
 * the six before it are words. Reading the trailing zeros as data yields plausible-looking nothing.
 */
export function parseAuctionOwnerNotification(payload: Uint8Array): AuctionOwnerNotification {
  const reader = new PacketReader(payload);
  const auctionId = reader.u32();
  const bid = reader.u32();
  reader.u32();
  reader.u64();
  const itemEntry = reader.u32();
  reader.u32();
  reader.f32();
  reader.assertFinished();
  return { auctionId, bid, itemEntry };
}

/**
 * Sales waiting to be collected. Always empty in this core: the count is a literal zero and the
 * loop that would fill it is commented out, so the entry layout below is what the client would
 * read if a fork ever filled it in — two strings, two words and a float.
 */
export function parseAuctionListPendingSales(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const count = reader.u32();
  for (let index = 0; index < count; index++) {
    reader.cString();
    reader.cString();
    reader.u32();
    reader.u32();
    reader.f32();
  }
  reader.assertFinished();
  return count;
}

/** Asking for the pending-sales list. The guid is read and discarded by the server. */
export function buildAuctionListPendingSales(auctioneerGuid: bigint): Uint8Array {
  return new PacketWriter().u64(auctioneerGuid).toUint8Array();
}
