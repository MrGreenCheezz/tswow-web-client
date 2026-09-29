/**
 * The offline trade: a scripted partner for `CannedWorldSeam` and its tests, in the shapes
 * `SMSG_TRADE_STATUS`/`SMSG_TRADE_STATUS_EXTENDED` parse into (TradeProtocol.ts), with the same
 * local bookkeeping `WorldClient` keeps for the player's own side (this core never echoes it).
 *
 * Item names are this dataset's ruRU `item_template` names and icons its ItemDisplayInfo rows, both
 * measured (FRAMEXML_CANNED_MAIL_ITEMS). Commands record; a test scripts the partner with
 * `open`/`partnerOffers`/`status`.
 */
import { EventBus, type TradeStateChange } from "../../world/EventBus.js";
import {
  TRADE_STATUS_BACK_TO_TRADE,
  TRADE_STATUS_OPEN_WINDOW,
  TRADE_STATUS_TRADE_ACCEPT,
  TRADE_STATUS_TRADE_CANCELED,
  TRADE_STATUS_TRADE_COMPLETE,
  type TradeItem,
  type TradeOffer,
} from "../../world/TradeProtocol.js";
import { FRAMEXML_CANNED_MAIL_ITEMS } from "./FrameXmlMailCanned.js";
import {
  FrameXmlTradeModel,
  type FrameXmlOwnTradeOffer,
  type FrameXmlTradeContext,
  type FrameXmlTradeCursorItem,
  type FrameXmlTradeWorld,
} from "./FrameXmlTrade.js";

export const FRAMEXML_CANNED_TRADE_PARTNER = 0x5004n;

/** One partner item in SendUpdateTrade's 72-byte slot shape, zeros where the fixture has none. */
export function frameXmlCannedTradeItem(slot: number, itemId: number, count: number): TradeItem {
  return {
    slot, itemId, displayId: 0, count, wrapped: false, giftCreator: 0n, enchantId: 0,
    gemEnchantIds: [0, 0, 0], creator: 0n, charges: 0, suffixFactor: 0, randomPropertyId: 0,
    lockId: 0, maxDurability: 0, durability: 0,
  };
}

export type FrameXmlCannedTradeCall =
  | { readonly kind: "offer"; readonly tradeSlot: number; readonly bag: number; readonly slot: number }
  | { readonly kind: "clear"; readonly tradeSlot: number }
  | { readonly kind: "gold"; readonly copper: number }
  | { readonly kind: "accept" | "unaccept" | "cancel" };

/** One owned item of the offline bags, by GUID, at its wire position. */
export interface FrameXmlCannedTradeBagItem {
  readonly entry: number;
  readonly count: number;
  readonly bag: number;
  readonly slot: number;
}

export class FrameXmlCannedTradeWorld implements FrameXmlTradeWorld {
  readonly events = new EventBus<{ TRADE_STATE_CHANGED: TradeStateChange }>();
  readonly calls: FrameXmlCannedTradeCall[] = [];
  readonly names = new Map<bigint, string>([[FRAMEXML_CANNED_TRADE_PARTNER, "Эльмира"]]);
  tradeOpen = false;
  tradePartnerGuid = 0n;
  tradePartnerAccepted = false;
  theirOffer: TradeOffer | undefined;
  tradeMessage: string | undefined;
  readonly bags = new Map<bigint, FrameXmlCannedTradeBagItem>([
    [0x4000_0001n, { entry: 13446, count: 5, bag: 255, slot: 23 }],
    [0x4000_0002n, { entry: 6948, count: 1, bag: 255, slot: 24 }],
  ]);
  cursor: FrameXmlTradeCursorItem | undefined;
  readonly #local = new Map<number, { itemId: number; count: number; guid: bigint | undefined }>();
  #gold = 0;

  #emit(change: TradeStateChange): void {
    this.events.emit("TRADE_STATE_CHANGED", change);
  }

  /** TRADE_STATUS_OPEN_WINDOW after both sides began the trade. */
  open(partner = FRAMEXML_CANNED_TRADE_PARTNER): void {
    this.tradePartnerGuid = partner;
    this.tradeOpen = true;
    this.tradePartnerAccepted = false;
    this.theirOffer = undefined;
    this.#local.clear();
    this.#gold = 0;
    this.#emit({ kind: "status", status: TRADE_STATUS_OPEN_WINDOW });
  }

  /** One SMSG_TRADE_STATUS_EXTENDED for the partner's side. */
  partnerOffers(money: number, items: readonly TradeItem[], spellId = 0): void {
    this.theirOffer = { traderData: true, money, spellId, items: [...items] };
    this.#emit({ kind: "offer", trader: true });
  }

  /** One SMSG_TRADE_STATUS with WorldClient's field updates for it. */
  status(status: number, message?: string): void {
    if (status === TRADE_STATUS_TRADE_ACCEPT) this.tradePartnerAccepted = true;
    else if (status === TRADE_STATUS_TRADE_CANCELED || status === TRADE_STATUS_TRADE_COMPLETE) this.#close();
    else if (status === TRADE_STATUS_BACK_TO_TRADE) this.tradePartnerAccepted = false;
    this.tradeMessage = message;
    this.#emit({ kind: "status", status });
  }

  #close(): void {
    this.tradeOpen = false;
    this.tradePartnerGuid = 0n;
    this.tradePartnerAccepted = false;
    this.theirOffer = undefined;
    this.#local.clear();
    this.#gold = 0;
  }

  ownTradeOffer(): FrameXmlOwnTradeOffer {
    return {
      money: this.#gold,
      spellId: 0,
      items: [...this.#local].map(([slot, { itemId, count }]) => ({ slot, itemId, count }))
        .sort((left, right) => left.slot - right.slot),
    };
  }

  /** WorldClient's own refusal: an item already in any slot is not offered again (no packet). */
  offerTradeItem(tradeSlot: number, bag: number, slot: number): boolean {
    if (!this.tradeOpen) return false;
    const held = [...this.bags].find(([, item]) => item.bag === bag && item.slot === slot);
    if (held && [...this.#local.values()].some((offered) => offered.guid === held[0])) {
      this.tradeMessage = "Этот предмет уже предложен в обмен";
      return false;
    }
    this.calls.push({ kind: "offer", tradeSlot, bag, slot });
    if (held) this.#local.set(tradeSlot, { itemId: held[1].entry, count: held[1].count, guid: held[0] });
    this.tradeMessage = undefined;
    this.tradePartnerAccepted = false;
    this.#emit({ kind: "local" });
    return true;
  }

  clearTradeItem(tradeSlot: number): void {
    if (!this.tradeOpen) return;
    this.calls.push({ kind: "clear", tradeSlot });
    this.#local.delete(tradeSlot);
    this.tradePartnerAccepted = false;
    this.#emit({ kind: "local" });
  }

  offerTradeGold(copper: number): void {
    if (!this.tradeOpen) return;
    this.calls.push({ kind: "gold", copper });
    this.#gold = copper;
    this.tradePartnerAccepted = false;
    this.#emit({ kind: "local" });
  }

  acceptTrade(): void { if (this.tradeOpen) this.calls.push({ kind: "accept" }); }
  unacceptTrade(): void { if (this.tradeOpen) this.calls.push({ kind: "unaccept" }); }

  cancelTrade(): void {
    this.calls.push({ kind: "cancel" });
    this.#close();
    this.#emit({ kind: "local" });
  }
}

export interface FrameXmlCannedTrade {
  readonly model: FrameXmlTradeModel;
  readonly world: FrameXmlCannedTradeWorld;
}

export function createCannedFrameXmlTrade(context: Partial<FrameXmlTradeContext> = {}): FrameXmlCannedTrade {
  const world = new FrameXmlCannedTradeWorld();
  const model = new FrameXmlTradeModel({
    world: () => world,
    item: (entry) => FRAMEXML_CANNED_MAIL_ITEMS.get(entry),
    itemPosition: (guid) => {
      const item = world.bags.get(guid);
      return item ? { bag: item.bag, slot: item.slot } : undefined;
    },
    cursorItem: () => world.cursor,
    clearCursor: () => { world.cursor = undefined; },
    pickupItem: (guid) => {
      const item = world.bags.get(guid);
      world.cursor = item ? { guid, bag: item.bag, slot: item.slot } : undefined;
    },
    ...context,
  });
  return { model, world };
}
