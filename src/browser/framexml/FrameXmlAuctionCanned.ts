/**
 * The offline auction house: a scripted world for `CannedWorldSeam`, its tests and the
 * `framexml.html?auction=` preview, in the exact shapes SMSG_AUCTION_LIST_RESULT,
 * SMSG_AUCTION_OWNER_LIST_RESULT, SMSG_AUCTION_BIDDER_LIST_RESULT and SMSG_AUCTION_COMMAND_RESULT
 * parse into (AuctionProtocol.ts).
 *
 * Item names and icons are this dataset's (`data/items.json` names, ItemDisplayInfo.InventoryIcon
 * icons, measured); required levels, vendor prices and every price and seller below are fixture
 * values chosen for the scenarios, not realm data. Commands record their wire intent; with
 * `autoAnswer` (the preview) the house answers each one as TrinityCore would, a microtask later.
 */
import { EventBus, type AuctionStateChange } from "../../world/EventBus.js";
import {
  AUCTION_CANCEL,
  AUCTION_PLACE_BID,
  AUCTION_SELL_ITEM,
  type AuctionEntry,
  type AuctionList,
  type AuctionSearch,
} from "../../world/AuctionProtocol.js";
import {
  FRAMEXML_AUCTION_CLASSES,
  FrameXmlAuctionModel,
  type FrameXmlAuctionContext,
  type FrameXmlAuctionItem,
  type FrameXmlAuctionWorld,
} from "./FrameXmlAuction.js";

interface CannedAuctionItem extends FrameXmlAuctionItem {
  readonly itemClass: number;
  readonly subClass: number;
  readonly inventoryType: number;
}

const icon = (name: string): string => `Interface\\Icons\\${name}`;

/** Names and icons measured on this dataset; class, level and prices are the fixture's. */
export const FRAMEXML_CANNED_AUCTION_ITEMS: ReadonlyMap<number, CannedAuctionItem> = new Map([
  [2589, { name: "Льняной материал", texture: icon("INV_Fabric_Linen_01"), quality: 1, requiredLevel: 0, sellPrice: 13, maxStack: 20, itemClass: 7, subClass: 5, inventoryType: 0 }],
  [4306, { name: "Шелковый материал", texture: icon("INV_Fabric_Silk_01"), quality: 1, requiredLevel: 0, sellPrice: 38, maxStack: 20, itemClass: 7, subClass: 5, inventoryType: 0 }],
  [14047, { name: "Руническая ткань", texture: icon("INV_Fabric_PurpleFire_01"), quality: 1, requiredLevel: 0, sellPrice: 400, maxStack: 20, itemClass: 7, subClass: 5, inventoryType: 0 }],
  [13446, { name: "Огромный флакон с лечебным зельем", texture: icon("INV_Potion_54"), quality: 1, requiredLevel: 45, sellPrice: 1000, maxStack: 20, itemClass: 0, subClass: 1, inventoryType: 0 }],
  [818, { name: "Тигровый глаз", texture: icon("INV_Misc_Gem_Opal_03"), quality: 2, requiredLevel: 0, sellPrice: 150, maxStack: 20, itemClass: 7, subClass: 7, inventoryType: 0 }],
  [2488, { name: "Гладий", texture: icon("INV_Sword_20"), quality: 1, requiredLevel: 3, sellPrice: 64, maxStack: 1, itemClass: 2, subClass: 7, inventoryType: 13 }],
  [15014, { name: "Волчий кулачный щит", texture: icon("INV_Shield_09"), quality: 2, requiredLevel: 16, sellPrice: 1200, maxStack: 1, itemClass: 4, subClass: 6, inventoryType: 14 }],
  [12360, { name: "Арканитовый слиток", texture: icon("INV_Misc_StoneTablet_05"), quality: 2, requiredLevel: 0, sellPrice: 2000, maxStack: 20, itemClass: 7, subClass: 7, inventoryType: 0 }],
  [7078, { name: "Субстанция Огня", texture: icon("Spell_Fire_Volcano"), quality: 2, requiredLevel: 0, sellPrice: 400, maxStack: 10, itemClass: 7, subClass: 10, inventoryType: 0 }],
  [6948, { name: "Камень возвращения", texture: icon("INV_Misc_Rune_01"), quality: 1, requiredLevel: 0, sellPrice: 0, maxStack: 1, itemClass: 15, subClass: 0, inventoryType: 0 }],
]);

export const FRAMEXML_CANNED_AUCTIONEER_GUID = 0xf13000071c000100n;
/** CannedWorldSeam's player: GUID 1, «Игрок» (UnitName("player")), level 60, 123456 copper. */
export const FRAMEXML_CANNED_AUCTION_SELF = 0x1n;
const SELLERS = new Map<bigint, string>([[0x5002n, "Торвальд"], [0x5001n, "Алистра"], [0x5003n, "Мираэль"]]);
const HOUR = 3_600_000;

function lot(auctionId: number, itemId: number, count: number, fields: Partial<AuctionEntry>): AuctionEntry {
  return {
    auctionId, itemId, randomPropertyId: 0, suffixFactor: 0, count, spellCharges: 0, itemFlags: 0,
    ownerLow: 0x5002n, startBid: 100, minIncrement: 0, buyout: 0, timeLeft: 20 * HOUR, bidderLow: 0n, bid: 0,
    ...fields,
  };
}

/** Ten lots of the browse fixture: enough for the list to scroll (eight rows show). */
export function frameXmlCannedAuctionLots(): AuctionEntry[] {
  return [
    lot(3001, 2589, 20, { startBid: 300, buyout: 500 }),
    lot(3002, 4306, 20, { ownerLow: 0x5001n, startBid: 1200, bid: 1500, bidderLow: 0x5003n, minIncrement: 75, buyout: 3000, timeLeft: 90 * 60_000 }),
    lot(3003, 14047, 20, { ownerLow: FRAMEXML_CANNED_AUCTION_SELF, startBid: 20_000, buyout: 40_000, timeLeft: 10 * HOUR }),
    lot(3004, 13446, 5, { ownerLow: 0x5003n, startBid: 25_000, bid: 26_000, bidderLow: FRAMEXML_CANNED_AUCTION_SELF, minIncrement: 1300, timeLeft: 25 * 60_000 }),
    lot(3005, 818, 3, { startBid: 4000, buyout: 9000, timeLeft: 36 * HOUR }),
    lot(3006, 15014, 1, { ownerLow: 0x5001n, startBid: 15_000, buyout: 22_000, timeLeft: 3 * HOUR }),
    lot(3007, 12360, 2, { ownerLow: 0x5003n, startBid: 90_000, buyout: 150_000, timeLeft: 11 * HOUR }),
    lot(3008, 7078, 4, { startBid: 6000, buyout: 8000, timeLeft: 47 * HOUR }),
    lot(3009, 2488, 1, { ownerLow: 0x5001n, startBid: 150, buyout: 400, timeLeft: 40 * 60_000 }),
    lot(3010, 2589, 10, { ownerLow: 0x5003n, startBid: 120, timeLeft: 5 * HOUR }),
  ];
}

/** The player's two lots: runecloth nobody bid on, and linen Торвальд bid on. */
export function frameXmlCannedOwnAuctions(): AuctionList {
  return { searchDelay: 300, totalCount: 2, entries: [
    lot(3003, 14047, 20, { ownerLow: FRAMEXML_CANNED_AUCTION_SELF, startBid: 20_000, buyout: 40_000, timeLeft: 10 * HOUR }),
    lot(3011, 2589, 10, { ownerLow: FRAMEXML_CANNED_AUCTION_SELF, startBid: 200, bid: 260, bidderLow: 0x5002n, minIncrement: 13, buyout: 600, timeLeft: 20 * HOUR }),
  ] };
}

/** The player's bids: the potions it leads, and the silk it was outbid on. */
export function frameXmlCannedBidAuctions(): AuctionList {
  const lots = frameXmlCannedAuctionLots();
  return { searchDelay: 300, totalCount: 2, entries: [lots[3]!, lots[1]!] };
}

/** One command the canned house received, in order; tests assert the wire-level intent. */
export type FrameXmlCannedAuctionCall =
  | { readonly kind: "search"; readonly search: AuctionSearch }
  | { readonly kind: "owner" | "bidder" | "close" }
  | { readonly kind: "bid"; readonly auctionId: number; readonly price: number }
  | { readonly kind: "cancel"; readonly auctionId: number }
  | { readonly kind: "sell"; readonly items: readonly { readonly guid: bigint; readonly count: number }[];
      readonly startBid: number; readonly buyout: number; readonly minutes: number };

export interface FrameXmlCannedAuctionBagItem {
  readonly entry: number;
  count: number;
  readonly bag: number;
  readonly slot: number;
  readonly soulbound?: boolean;
}

/**
 * The canned auction house: `WorldClient`'s `auction*` fields and commands, plus the bags and cursor
 * the sell slot reads. `open()` stands in for MSG_AUCTION_HELLO.
 */
export class FrameXmlCannedAuctionWorld implements FrameXmlAuctionWorld {
  readonly events = new EventBus<{ AUCTION_STATE_CHANGED: AuctionStateChange }>();
  readonly calls: FrameXmlCannedAuctionCall[] = [];
  readonly names = new Map<bigint, string>(SELLERS);
  readonly state = { selfGuid: FRAMEXML_CANNED_AUCTION_SELF as bigint | undefined };
  readonly selfName = "Игрок";
  auctioneerGuid = 0n;
  auctions: AuctionList | undefined;
  ownAuctions: AuctionList | undefined;
  bidAuctions: AuctionList | undefined;
  /** Answer every command a microtask later, as the preview's live-looking house does. */
  autoAnswer = false;
  /** The offline bags by GUID: three linen stacks, a bound hearthstone and three tigerseyes. */
  readonly bags = new Map<bigint, FrameXmlCannedAuctionBagItem>([
    [0x4000_0101n, { entry: 2589, count: 20, bag: 255, slot: 23 }],
    [0x4000_0102n, { entry: 2589, count: 20, bag: 255, slot: 24 }],
    [0x4000_0103n, { entry: 2589, count: 7, bag: 255, slot: 25 }],
    [0x4000_0104n, { entry: 6948, count: 1, bag: 255, slot: 26, soulbound: true }],
    [0x4000_0105n, { entry: 818, count: 3, bag: 255, slot: 27 }],
  ]);
  cursor: { readonly guid: bigint; readonly bag: number; readonly slot: number } | undefined;
  #nextAuctionId = 3100;

  emit(change: AuctionStateChange): void {
    this.events.emit("AUCTION_STATE_CHANGED", change);
  }

  /** MSG_AUCTION_HELLO for the canned auctioneer (house 2, the Alliance house). */
  open(enabled = true): void {
    this.auctioneerGuid = FRAMEXML_CANNED_AUCTIONEER_GUID;
    this.emit({ kind: "hello", enabled, houseId: 2 });
  }

  /** Script one SMSG_AUCTION_LIST_RESULT (the whole fixture unless given). */
  deliverList(list: AuctionList = { searchDelay: 300, totalCount: 10, entries: frameXmlCannedAuctionLots() }): void {
    this.auctions = list;
    this.emit({ kind: "list" });
  }

  deliverOwner(list: AuctionList = frameXmlCannedOwnAuctions()): void {
    this.ownAuctions = list;
    this.emit({ kind: "owner" });
  }

  deliverBidder(list: AuctionList = frameXmlCannedBidAuctions()): void {
    this.bidAuctions = list;
    this.emit({ kind: "bidder" });
  }

  /** Script one SMSG_AUCTION_COMMAND_RESULT. */
  answer(command: number, error = 0, auctionId = 0, bagResult = 0): void {
    this.emit({ kind: "result", auctionId, command, error, bagResult });
  }

  requestName(): void {}

  /** The fixture filtered the way BuildListAuctionItems filters, one page of 50. */
  search(search: AuctionSearch): AuctionList {
    const needle = (search.name ?? "").toLowerCase();
    const matches = frameXmlCannedAuctionLots().filter((entry) => {
      const item = FRAMEXML_CANNED_AUCTION_ITEMS.get(entry.itemId);
      if (!item) return false;
      if (search.itemClass !== undefined && item.itemClass !== search.itemClass) return false;
      if (search.itemSubClass !== undefined && item.subClass !== search.itemSubClass) return false;
      if (search.inventoryType !== undefined && item.inventoryType !== search.inventoryType) return false;
      if (search.quality !== undefined && item.quality !== search.quality) return false;
      const level = item.requiredLevel ?? 0;
      if (search.levelMin && (level < search.levelMin || (search.levelMax && level > search.levelMax))) return false;
      return needle === "" || item.name.toLowerCase().includes(needle);
    });
    const first = (search.page ?? 0) * 50;
    return { searchDelay: 300, totalCount: matches.length, entries: matches.slice(first, first + 50) };
  }

  #later(run: () => void): void {
    if (this.autoAnswer) queueMicrotask(run);
  }

  searchAuctions(search: AuctionSearch): void {
    this.calls.push({ kind: "search", search });
    this.#later(() => this.deliverList(this.search(search)));
  }

  listOwnAuctions(): void {
    this.calls.push({ kind: "owner" });
    this.#later(() => this.deliverOwner(this.ownAuctions ?? frameXmlCannedOwnAuctions()));
  }

  listBidderAuctions(): void {
    this.calls.push({ kind: "bidder" });
    this.#later(() => this.deliverBidder(this.bidAuctions ?? frameXmlCannedBidAuctions()));
  }

  bidOnAuction(auctionId: number, price: number): void {
    this.calls.push({ kind: "bid", auctionId, price });
    this.#later(() => this.answer(AUCTION_PLACE_BID, 0, auctionId));
  }

  cancelAuction(auctionId: number): void {
    this.calls.push({ kind: "cancel", auctionId });
    this.#later(() => {
      const own = this.ownAuctions ?? frameXmlCannedOwnAuctions();
      this.answer(AUCTION_CANCEL, 0, auctionId);
      const entries = own.entries.filter((entry) => entry.auctionId !== auctionId);
      this.deliverOwner({ ...own, entries, totalCount: entries.length });
    });
  }

  createAuction(itemGuid: bigint, count: number, startBid: number, buyout: number, durationMinutes: number): void {
    this.createAuctionFromStacks([{ guid: itemGuid, count }], startBid, buyout, durationMinutes);
  }

  createAuctionFromStacks(items: readonly { readonly guid: bigint; readonly count: number }[],
    startBid: number, buyout: number, durationMinutes: number): void {
    this.calls.push({ kind: "sell", items: items.map(({ guid, count }) => ({ guid, count })), startBid, buyout, minutes: durationMinutes });
    this.#later(() => {
      const entry = this.bags.get(items[0]?.guid ?? 0n)?.entry ?? 0;
      let total = 0;
      for (const { guid, count } of items) {
        const bagItem = this.bags.get(guid);
        if (!bagItem) continue;
        bagItem.count -= count;
        total += count;
        if (bagItem.count <= 0) this.bags.delete(guid);
      }
      const auctionId = this.#nextAuctionId++;
      this.answer(AUCTION_SELL_ITEM, 0, auctionId);
      const own = this.ownAuctions ?? frameXmlCannedOwnAuctions();
      const entries = [...own.entries, lot(auctionId, entry, total, {
        ownerLow: FRAMEXML_CANNED_AUCTION_SELF, startBid, buyout, timeLeft: durationMinutes * 60_000,
      })];
      this.deliverOwner({ ...own, entries, totalCount: entries.length });
    });
  }

  closeAuctionHouse(): void {
    this.calls.push({ kind: "close" });
    this.auctioneerGuid = 0n;
    this.auctions = undefined;
    this.ownAuctions = undefined;
    this.bidAuctions = undefined;
    this.emit({ kind: "closed" });
  }
}

export interface FrameXmlCannedAuction {
  readonly model: FrameXmlAuctionModel;
  readonly world: FrameXmlCannedAuctionWorld;
}

/** A model over the canned house; `context` may override what a test needs. */
export function createCannedFrameXmlAuction(context: Partial<FrameXmlAuctionContext> = {}): FrameXmlCannedAuction {
  const world = new FrameXmlCannedAuctionWorld();
  const model = new FrameXmlAuctionModel({
    world: () => world,
    item: (entry) => FRAMEXML_CANNED_AUCTION_ITEMS.get(entry),
    itemObject: (guid) => {
      const item = world.bags.get(guid);
      return item ? { entry: item.entry, count: item.count, soulbound: item.soulbound === true } : undefined;
    },
    carriedStacks: (entry) => [...world.bags].filter(([, item]) => item.entry === entry)
      .sort(([, left], [, right]) => left.bag - right.bag || left.slot - right.slot)
      .map(([guid, item]) => ({ guid, count: item.count })),
    cursorItem: () => world.cursor,
    clearCursor: () => { world.cursor = undefined; },
    pickupItem: (guid) => {
      const item = world.bags.get(guid);
      world.cursor = item ? { guid, bag: item.bag, slot: item.slot } : undefined;
    },
    playerLevel: () => 60,
    ...context,
  });
  return { model, world };
}

/** The browse classes' ids, for tests that assert the QueryAuctionItems mapping. */
export const FRAMEXML_CANNED_AUCTION_CLASS_IDS: readonly number[] = FRAMEXML_AUCTION_CLASSES.map((row) => row.id);
