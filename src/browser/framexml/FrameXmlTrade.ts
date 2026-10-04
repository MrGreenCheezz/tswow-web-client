/**
 * The stock TradeFrame's C API (`TradeFrame.xml`/`TradeFrame.lua`) over this client's trade packets
 * (`WorldClient.trade*`, TradeProtocol.ts).
 *
 * Facts measured against the stock 3.3.5 Lua and the active TrinityCore that shape it:
 *
 * * Stock numbers the seven trade slots 1..7 (MAX_TRADE_ITEMS; 7 is TRADE_ENCHANT_SLOT, the "will
 *   not be traded" one); the wire numbers them 0..6 (TRADE_SLOT_COUNT, TradeData.h).
 * * This core never echoes a player's own item or gold change back to them: TradeData::SetItem and
 *   SetMoney call `Update()` for the trader only (TradeData.cpp:70, :116). The player's side is
 *   therefore `WorldClient.ownTradeOffer()` — the sent changes over the last own
 *   SMSG_TRADE_STATUS_EXTENDED — and the model fires TRADE_PLAYER_ITEM_CHANGED from the local edge.
 * * Accept state: HandleAcceptTradeOpcode sends TRADE_STATUS_TRADE_ACCEPT to the partner only, and
 *   any change clears both sides with TRADE_STATUS_BACK_TO_TRADE (TradeData::SetAccepted). The
 *   player's own accept is client memory, set by AcceptTrade and cleared by BACK_TO_TRADE or
 *   CancelTradeAccept — the pair stock's TRADE_ACCEPT_UPDATE(player, target) paints.
 *
 * TRADE_SHOW — the one event that opens the window — fires only while the world mount has
 * published the stock owner (`owned`). The incoming request (TRADE_REQUEST and its popup) is not
 * this model's: the trade opens here once the server sends TRADE_STATUS_OPEN_WINDOW.
 */
import type { TradeStateChange } from "../../world/EventBus.js";
import {
  TRADE_SLOT_COUNT,
  TRADE_STATUS_BACK_TO_TRADE,
  TRADE_STATUS_NOT_ON_TAPLIST,
  TRADE_STATUS_TRADE_ACCEPT,
  TRADE_STATUS_TRADE_CANCELED,
  TRADE_STATUS_TRADE_COMPLETE,
  type TradeOffer,
} from "../../world/TradeProtocol.js";
import { itemChatLink } from "../ui/ChatLink.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { ITEM_FIELD_FLAG_SOULBOUND, itemBoundByEnchantment, type EnchantFlagsOf } from "../game/SpellCursor.js";

/** `ITEM_FIELD_FLAG_BOP_TRADEABLE` (ItemTemplate.h): a soulbound item still tradeable for two hours. */
const ITEM_FIELD_FLAG_BOP_TRADEABLE = 0x100;
/** The trade window of a BoP-tradeable item, in played seconds (Wow.exe 0x00708b40: 0x1c20). */
const BOP_TRADE_WINDOW_SECONDS = 7200;

/**
 * TRADE_POTENTIAL_BIND_ENCHANT's argument (Wow.exe 0x005869a0, event 0x18c, format "%b") for the item
 * the player puts in their own «will not be traded» slot: true when it is bound (0x00708520) but not
 * bound for good (!0x00709550) — soulbound, still BoP-tradeable within the two played hours since
 * `ITEM_FIELD_CREATE_PLAYED_TIME` (0x00708b40), and no enchantment on it binds (0x007073e0). An
 * enchant from the partner would end that window, so TradeFrame.lua shows the warning. False for an
 * empty slot and whenever the player's played time is unknown (`playedSeconds` undefined).
 */
export function tradePotentialBindEnchant(
  item: WorldObjectState | undefined, playedSeconds: number | undefined, flagsOf: EnchantFlagsOf,
): boolean {
  if (!item || playedSeconds === undefined) return false;
  const flags = item.fields.get(UPDATE_FIELDS.ITEM_FIELD_FLAGS.offset) ?? 0;
  if ((flags & ITEM_FIELD_FLAG_SOULBOUND) === 0 || (flags & ITEM_FIELD_FLAG_BOP_TRADEABLE) === 0) return false;
  if (itemBoundByEnchantment(item, flagsOf)) return false;
  const created = item.fields.get(UPDATE_FIELDS.ITEM_FIELD_CREATE_PLAYED_TIME.offset) ?? 0;
  return created - playedSeconds > -BOP_TRADE_WINDOW_SECONDS;
}

/** `TRADE_ENCHANT_SLOT` (TradeFrame.lua:3): stock slot 7 is wire slot 6. */
export const FRAMEXML_TRADE_ENCHANT_SLOT = TRADE_SLOT_COUNT;
/** Player.cpp `MAX_MONEY_AMOUNT`. */
const MAX_MONEY_COPPER = 0x7fffffff;

/** The player's own side as `WorldClient.ownTradeOffer()` reports it. */
export interface FrameXmlOwnTradeOffer {
  readonly money: number;
  readonly spellId: number;
  readonly items: ReadonlyArray<{ readonly slot: number; readonly itemId: number; readonly count: number }>;
}

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlTradeWorld {
  readonly events?: {
    on(name: "TRADE_STATE_CHANGED", listener: (change: TradeStateChange) => void): () => void;
  } | undefined;
  readonly tradeOpen: boolean;
  readonly tradePartnerGuid: bigint;
  readonly tradePartnerAccepted: boolean;
  readonly theirOffer: TradeOffer | undefined;
  readonly tradeMessage?: string | undefined;
  readonly names?: { get(guid: bigint): string | undefined } | undefined;
  ownTradeOffer(): FrameXmlOwnTradeOffer;
  /**
   * `false` when the world refused before sending (WorldClient: an item already in the trade, which
   * TradeHandler would answer by cancelling the whole trade); nothing was offered then.
   */
  offerTradeItem(tradeSlot: number, bag: number, slot: number): boolean | void;
  clearTradeItem(tradeSlot: number): void;
  offerTradeGold(copper: number): void;
  acceptTrade(): void;
  unacceptTrade?(): void;
  cancelTrade(): void;
}

export interface FrameXmlTradeItem {
  readonly name: string;
  readonly texture?: string | undefined;
  readonly quality?: number | undefined;
}

/** The item on the shared bag cursor, in wire bag/slot coordinates (LiveWorldSeam's cursor). */
export interface FrameXmlTradeCursorItem {
  readonly guid: bigint;
  readonly bag: number;
  readonly slot: number;
}

/** What the model asks its host besides the world. */
export interface FrameXmlTradeContext {
  world(): FrameXmlTradeWorld | undefined;
  /** Cache-only item presentation; a C-API read never starts a fetch. */
  item(entry: number): FrameXmlTradeItem | undefined;
  /** ItemDisplayInfo's icon for SendUpdateTrade's display id (the loot host's resolver), cache-only. */
  displayIcon?(displayId: number): string | undefined;
  /** An owned item's wire position, to put it back on the cursor or offer it (bag right-click). */
  itemPosition?(guid: bigint): { readonly bag: number; readonly slot: number } | undefined;
  /** An exact link for an owned item (the inventory's enchant/random/suffix), when the host has one. */
  itemLink?(guid: bigint): string | undefined;
  cursorItem(): FrameXmlTradeCursorItem | undefined;
  clearCursor(): void;
  /** Put an owned item back on the cursor: stock picks an offered item up when its slot is clicked. */
  pickupItem?(guid: bigint): void;
  spellName?(id: number): string | undefined;
  /** Load item metadata outside a C-API read; `onChanged` runs once the cache moved. */
  prefetchItems?(entries: readonly number[], onChanged: () => void): void;
  /** The set of offered items changed: the bags repaint their lock state (`offered`). */
  locksChanged?(): void;
  /**
   * TRADE_POTENTIAL_BIND_ENCHANT's argument for the item now in the player's own seventh slot
   * (`tradePotentialBindEnchant`); absent, the event is not raised.
   */
  potentialBindEnchant?(guid: bigint): boolean;
}

interface FrameXmlTradePump {
  fire(event: string, ...args: readonly unknown[]): number;
  now(): number;
}

function stockSlot(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) && number >= 1 && number <= TRADE_SLOT_COUNT ? number : undefined;
}

/**
 * One owner of the stock trade C API. What the player offered through it (the GUID behind each of
 * their slots) and whether they accepted is client memory; everything else is read from the world.
 */
export class FrameXmlTradeModel {
  readonly #context: FrameXmlTradeContext;
  #pump: FrameXmlTradePump | undefined;
  #unsubscribe: (() => void) | undefined;
  #owned = false;
  #muted = false;
  /** TRADE_SHOW was sent for the open trade; TRADE_CLOSED not yet. */
  #shown = false;
  #playerAccepted = false;
  /** The GUID behind each wire slot the player filled through stock (pickup, locks). */
  readonly #offered = new Map<number, bigint>();
  /** Last painted shape per stock slot 1..7, and each side's money. */
  #playerSlots: string[] = [];
  #targetSlots: string[] = [];
  #playerMoney = 0;
  #targetMoney = 0;
  #metadataSignature = "";
  #metadataCheckedAt = Number.NEGATIVE_INFINITY;
  readonly #prefetched = new Set<number>();
  /** A trade closed with the player's gold still offered and not traded: the bags repaint (`tick`). */
  #releasedMoney = false;

  constructor(context: FrameXmlTradeContext) {
    this.#context = context;
  }

  // ---- lifecycle -------------------------------------------------------------------------

  attach(pump: FrameXmlTradePump): void {
    this.detach();
    this.#pump = pump;
    const world = this.#context.world();
    if (world?.events && typeof world.events.on === "function") {
      this.#unsubscribe = world.events.on("TRADE_STATE_CHANGED", (change) => this.#onState(change));
    }
    this.#reset();
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pump = undefined;
    this.#owned = false;
    this.#reset();
  }

  #reset(): void {
    const locked = this.#offered.size > 0;
    this.#shown = false;
    this.#playerAccepted = false;
    this.#offered.clear();
    if (locked) this.#context.locksChanged?.();
    this.#playerSlots = [];
    this.#targetSlots = [];
    this.#playerMoney = 0;
    this.#targetMoney = 0;
    this.#metadataSignature = "";
    this.#releasedMoney = false;
  }

  /**
   * Whether stock TradeFrame owns the trade route (set by the world mount once published). Taking
   * ownership is an edge: a trade window already open is handed to stock with TRADE_SHOW, because
   * the server sends TRADE_STATUS_OPEN_WINDOW only once.
   */
  get owned(): boolean { return this.#owned; }
  set owned(owned: boolean) {
    if (owned === this.#owned) return;
    this.#owned = owned;
    if (!owned) {
      this.#reset();
      return;
    }
    const world = this.#context.world();
    if (world?.tradeOpen) this.#show(world);
  }

  get showing(): boolean { return this.#shown; }

  /** Run a transactional probe (the mount's gate) without sending a packet. */
  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  #command(run: (world: FrameXmlTradeWorld) => void): void {
    if (this.#muted) return;
    const world = this.#context.world();
    if (world?.tradeOpen) run(world);
  }

  /**
   * Per rendered frame: repaint once item names/icons or the partner's name arrive, and the bags'
   * gold once a trade closed with the player's gold still theirs (see `#close`).
   */
  tick(): void {
    const pump = this.#pump;
    if (!pump) return;
    if (this.#releasedMoney) {
      this.#releasedMoney = false;
      pump.fire("PLAYER_TRADE_MONEY");
    }
    if (!this.#shown) return;
    const now = pump.now();
    if (now - this.#metadataCheckedAt < 0.25) return;
    this.#metadataCheckedAt = now;
    const signature = this.#presentationSignature();
    if (signature === this.#metadataSignature) return;
    this.#metadataSignature = signature;
    pump.fire("TRADE_UPDATE");
    // TRADE_UPDATE re-enables the Trade button and TradeFrame_Update hides all four accept
    // highlights (TradeFrame.lua:29-30, :61-64), while the realm still holds both accepts: repaint
    // them. Measured before this: a partner item's name arriving after AcceptTrade left the
    // highlights hidden and the button enabled, TradeFrame.acceptState still 1.
    const partner = this.#context.world()?.tradePartnerAccepted === true;
    if (this.#shown && (this.#playerAccepted || partner)) {
      pump.fire("TRADE_ACCEPT_UPDATE", this.#playerAccepted ? 1 : 0, partner ? 1 : 0);
    }
  }

  // ---- the two offers --------------------------------------------------------------------

  #own(slot: number): { readonly itemId: number; readonly count: number } | undefined {
    const world = this.#context.world();
    if (!world?.tradeOpen) return undefined;
    return world.ownTradeOffer().items.find((item) => item.slot === slot - 1);
  }

  #their(slot: number) {
    const world = this.#context.world();
    if (!world?.tradeOpen) return undefined;
    return world.theirOffer?.items.find((item) => item.slot === slot - 1);
  }

  /**
   * `GetTradePlayerItemInfo(id)`: name, texture, count, quality, enchantment. Stock reads the fourth
   * value as `isUsable` and never uses it for the player's side (TradeFrame.lua:73); the enchantment
   * on slot 7 is the spell the partner applies to it.
   */
  playerItemInfo(id: unknown): readonly unknown[] | undefined {
    const slot = stockSlot(id);
    const offered = slot === undefined ? undefined : this.#own(slot);
    if (slot === undefined || !offered) return undefined;
    const item = this.#context.item(offered.itemId);
    if (!item) return undefined;
    const spell = slot === FRAMEXML_TRADE_ENCHANT_SLOT ? this.#context.world()?.theirOffer?.spellId ?? 0 : 0;
    return [item.name, item.texture, offered.count, item.quality ?? 1,
      spell > 0 ? this.#context.spellName?.(spell) : undefined];
  }

  /** `GetTradeTargetItemInfo(id)`: name, texture, count, quality, isUsable, enchantment. */
  targetItemInfo(id: unknown): readonly unknown[] | undefined {
    const slot = stockSlot(id);
    const offered = slot === undefined ? undefined : this.#their(slot);
    if (slot === undefined || !offered) return undefined;
    const item = this.#context.item(offered.itemId);
    const spell = slot === FRAMEXML_TRADE_ENCHANT_SLOT
      ? this.#context.world()?.ownTradeOffer().spellId ?? 0 : 0;
    const enchantment = spell > 0 ? this.#context.spellName?.(spell) : undefined;
    if (!item) {
      // The item's metadata is still on its way, but SendUpdateTrade names its display
      // (TradeHandler.cpp:98, DisplayInfoID): the slot shows the partner's icon and count at once,
      // not an empty slot beside an enabled Trade button; the name follows with the tick's
      // TRADE_UPDATE. A nil name paints white (`isUsable or not name`, TradeFrame.lua:117).
      const texture = offered.displayId > 0 ? this.#context.displayIcon?.(offered.displayId) : undefined;
      return texture ? [undefined, texture, offered.count, 1, true, enchantment] : undefined;
    }
    // Usability needs class/skill/level rules this client does not model; white is stock's default.
    return [item.name, item.texture, offered.count, item.quality ?? 1, true, enchantment];
  }

  playerItemLink(id: unknown): string | undefined {
    const slot = stockSlot(id);
    const offered = slot === undefined ? undefined : this.#own(slot);
    if (slot === undefined || !offered) return undefined;
    const guid = this.#offered.get(slot - 1);
    const exact = guid === undefined ? undefined : this.#context.itemLink?.(guid);
    if (exact) return exact;
    const item = this.#context.item(offered.itemId);
    return item ? itemChatLink(offered.itemId, item.quality ?? 1, item.name) : undefined;
  }

  /** The partner's item as SendUpdateTrade describes it: permanent enchant and random property. */
  targetItemLink(id: unknown): string | undefined {
    const slot = stockSlot(id);
    const offered = slot === undefined ? undefined : this.#their(slot);
    const item = offered ? this.#context.item(offered.itemId) : undefined;
    return offered && item
      ? itemChatLink(offered.itemId, item.quality ?? 1, item.name, offered.enchantId, offered.randomPropertyId)
      : undefined;
  }

  playerMoney(): number {
    const world = this.#context.world();
    return world?.tradeOpen ? world.ownTradeOffer().money : 0;
  }

  targetMoney(): number {
    const world = this.#context.world();
    return world?.tradeOpen ? world.theirOffer?.money ?? 0 : 0;
  }

  /** Items the player has in the trade, which the bags show locked as the client does. */
  offered(guid: bigint): boolean {
    if (!this.#owned || !this.#shown) return false;
    for (const held of this.#offered.values()) if (held === guid) return true;
    return false;
  }

  // ---- commands --------------------------------------------------------------------------

  /**
   * `ClickTradeButton(id, clear)`: the cursor's item goes into slot `id`; with an empty cursor an
   * offered item is picked back up, and `clear` (a right click) just takes it out of the trade.
   */
  clickPlayerSlot(id: unknown, clear: boolean): void {
    if (this.#muted) return;
    const slot = stockSlot(id);
    const world = this.#context.world();
    if (slot === undefined || !world?.tradeOpen) return;
    const wire = slot - 1;
    const cursor = this.#context.cursorItem();
    if (cursor) {
      if ([...this.#offered.values()].includes(cursor.guid)) {
        // An offered item dropped on any trade slot: the client leaves the offer where it is
        // (a second CMSG_SET_TRADE_ITEM for it makes TradeHandler cancel the whole trade).
        this.#context.clearCursor();
        return;
      }
      const previous = this.#offered.get(wire);
      // Recorded before the send: a world that answers the change at once (the canned one) diffs the
      // slot inside the call, and TRADE_POTENTIAL_BIND_ENCHANT reads the guid behind slot 7 there.
      this.#offered.set(wire, cursor.guid);
      if (world.offerTradeItem(wire, cursor.bag, cursor.slot) === false) {
        // Refused before sending (offered earlier through the native window): nothing moved.
        if (previous === undefined) this.#offered.delete(wire);
        else this.#offered.set(wire, previous);
        this.#refused(world);
        return;
      }
      this.#context.clearCursor();
      if (previous !== undefined && previous !== cursor.guid) this.#context.pickupItem?.(previous);
      this.#context.locksChanged?.();
      return;
    }
    if (!this.#own(slot)) return;
    const held = this.#offered.get(wire);
    world.clearTradeItem(wire);
    this.#offered.delete(wire);
    if (!clear && held !== undefined) this.#context.pickupItem?.(held);
    this.#context.locksChanged?.();
  }

  /** A right-clicked bag item while the trade is open: offer it in the first free tradable slot. */
  useItem(guid: bigint): boolean {
    if (!this.#owned || !this.#shown || this.#muted) return false;
    const world = this.#context.world();
    if (!world?.tradeOpen) return false;
    if (this.offered(guid)) return true;
    const position = this.#context.itemPosition?.(guid);
    if (!position) return true;
    const used = new Set(world.ownTradeOffer().items.map((item) => item.slot));
    for (let wire = 0; wire < TRADE_SLOT_COUNT - 1; wire += 1) {
      if (used.has(wire)) continue;
      if (world.offerTradeItem(wire, position.bag, position.slot) === false) {
        this.#refused(world);
        return true;
      }
      this.#offered.set(wire, guid);
      this.#context.locksChanged?.();
      return true;
    }
    return true;
  }

  /** The world's reason for a refused offer, in the error frame; no local state moves. */
  #refused(world: FrameXmlTradeWorld): void {
    if (world.tradeMessage) this.#pump?.fire("UI_ERROR_MESSAGE", world.tradeMessage);
  }

  /** `SetTradeMoney`: stock calls it on every MoneyInputFrame change and on show; send changes only. */
  setMoney(value: unknown): void {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(number) || number < 0 || number > MAX_MONEY_COPPER) return;
    if (number === this.playerMoney()) return;
    this.#command((world) => world.offerTradeGold(number));
  }

  accept(): void {
    if (this.#muted) return;
    const world = this.#context.world();
    if (!world?.tradeOpen) return;
    world.acceptTrade();
    this.#playerAccepted = true;
    this.#pump?.fire("TRADE_ACCEPT_UPDATE", 1, world.tradePartnerAccepted ? 1 : 0);
  }

  unaccept(): void {
    if (this.#muted) return;
    const world = this.#context.world();
    if (!world?.tradeOpen) return;
    world.unacceptTrade?.();
    this.#playerAccepted = false;
    this.#pump?.fire("TRADE_ACCEPT_UPDATE", 0, world.tradePartnerAccepted ? 1 : 0);
  }

  /** `CloseTrade`/`CancelTrade`: TradeFrame's OnHide; the world sends CMSG_CANCEL_TRADE. */
  cancel(): void {
    this.#command((world) => world.cancelTrade());
  }

  /** The partner's name for `UnitName("NPC")` while the trade window is open. */
  partnerName(): string | undefined {
    const world = this.#context.world();
    if (!world?.tradeOpen || world.tradePartnerGuid === 0n) return undefined;
    return world.names?.get(world.tradePartnerGuid);
  }

  // ---- events ----------------------------------------------------------------------------

  #show(world: FrameXmlTradeWorld): void {
    const pump = this.#pump;
    if (!pump || !this.#owned || this.#shown || !world.tradeOpen) return;
    this.#shown = true;
    this.#playerAccepted = false;
    this.#snapshot(world);
    this.#prefetch(world);
    // What TRADE_SHOW paints now; only a later change is the tick's TRADE_UPDATE (a handed-over trade
    // the partner already accepted keeps the highlight painted just below).
    this.#metadataSignature = this.#presentationSignature();
    pump.fire("TRADE_SHOW");
    if (world.tradePartnerAccepted) pump.fire("TRADE_ACCEPT_UPDATE", 0, 1);
  }

  /**
   * TRADE_CLOSED. MoneyTypeInfo["PLAYER"] — the bags' gold — is GetMoney() minus
   * GetPlayerTradeMoney(), repainted only on PLAYER_MONEY/PLAYER_TRADE_MONEY (MoneyFrame.lua:19,
   * :193), and the trade money is 0 from here on. A trade that did not complete leaves the gold
   * where it was, so the next tick fires PLAYER_TRADE_MONEY; a completed one moved it, and the
   * realm's coinage update raises PLAYER_MONEY (`#onState` drops the edge on TRADE_COMPLETE, which
   * WorldClient reports after its own close edge). Measured before this: a cancel after
   * SetTradeMoney(5000) fired only TRADE_CLOSED, and the bags kept showing 5000 copper less.
   */
  #close(pump: FrameXmlTradePump): void {
    if (!this.#shown) return;
    const offeredMoney = this.#playerMoney;
    this.#reset();
    pump.fire("TRADE_CLOSED");
    this.#releasedMoney = offeredMoney > 0;
  }

  #shape(offered: { readonly itemId: number; readonly count: number } | undefined): string {
    return offered ? `${offered.itemId}:${offered.count}` : "";
  }

  #snapshot(world: FrameXmlTradeWorld): void {
    const own = world.ownTradeOffer();
    this.#playerSlots = Array.from({ length: TRADE_SLOT_COUNT }, (_, index) =>
      this.#shape(own.items.find((item) => item.slot === index)));
    this.#targetSlots = Array.from({ length: TRADE_SLOT_COUNT }, (_, index) =>
      this.#shape(world.theirOffer?.items.find((item) => item.slot === index)));
    this.#playerMoney = own.money;
    this.#targetMoney = world.theirOffer?.money ?? 0;
  }

  /** Fire one item edge per stock slot whose shape moved, and one money edge per side. */
  #diff(world: FrameXmlTradeWorld, pump: FrameXmlTradePump): void {
    const own = world.ownTradeOffer();
    for (let index = 0; index < TRADE_SLOT_COUNT; index += 1) {
      const player = this.#shape(own.items.find((item) => item.slot === index));
      if (player !== this.#playerSlots[index]) {
        this.#playerSlots[index] = player;
        if (player === "" && this.#offered.delete(index)) this.#context.locksChanged?.();
        // The own seventh slot: the client raises TRADE_POTENTIAL_BIND_ENCHANT before the slot's own
        // event, true or false every time it changes (Wow.exe 0x005869a0 set, 0x00586aa0 cleared).
        if (index === FRAMEXML_TRADE_ENCHANT_SLOT - 1 && this.#context.potentialBindEnchant) {
          const guid = player === "" ? undefined : this.#offered.get(index);
          pump.fire("TRADE_POTENTIAL_BIND_ENCHANT", guid !== undefined && this.#context.potentialBindEnchant(guid));
        }
        pump.fire("TRADE_PLAYER_ITEM_CHANGED", index + 1);
      }
      const target = this.#shape(world.theirOffer?.items.find((item) => item.slot === index));
      if (target !== this.#targetSlots[index]) {
        this.#targetSlots[index] = target;
        pump.fire("TRADE_TARGET_ITEM_CHANGED", index + 1);
      }
    }
    if (own.money !== this.#playerMoney) {
      this.#playerMoney = own.money;
      pump.fire("PLAYER_TRADE_MONEY");
    }
    const theirs = world.theirOffer?.money ?? 0;
    if (theirs !== this.#targetMoney) {
      this.#targetMoney = theirs;
      pump.fire("TRADE_MONEY_CHANGED");
    }
    this.#prefetch(world);
  }

  #prefetch(world: FrameXmlTradeWorld): void {
    const entries = new Set<number>();
    for (const item of world.ownTradeOffer().items) entries.add(item.itemId);
    for (const item of world.theirOffer?.items ?? []) entries.add(item.itemId);
    const missing = [...entries].filter((entry) => entry > 0 && !this.#prefetched.has(entry) && !this.#context.item(entry));
    if (missing.length === 0 || !this.#context.prefetchItems) return;
    for (const entry of missing) this.#prefetched.add(entry);
    this.#context.prefetchItems(missing, () => { this.#metadataCheckedAt = Number.NEGATIVE_INFINITY; });
  }

  #presentationSignature(): string {
    const world = this.#context.world();
    if (!world?.tradeOpen) return "";
    let items = 0;
    for (const item of world.ownTradeOffer().items) if (this.#context.item(item.itemId)) items += 1;
    for (const item of world.theirOffer?.items ?? []) if (this.#context.item(item.itemId)) items += 1;
    return `${items}:${this.partnerName() ?? ""}`;
  }

  #onState(change: TradeStateChange): void {
    const pump = this.#pump;
    const world = this.#context.world();
    if (!pump || !world) return;
    if (!world.tradeOpen) {
      this.#close(pump);
      if (change.kind === "status" && change.status === TRADE_STATUS_TRADE_COMPLETE) this.#releasedMoney = false;
      return;
    }
    if (!this.#shown) {
      this.#show(world);
      return;
    }
    if (change.kind === "status") {
      if (change.status === TRADE_STATUS_TRADE_ACCEPT) {
        pump.fire("TRADE_ACCEPT_UPDATE", this.#playerAccepted ? 1 : 0, 1);
      } else if (change.status === TRADE_STATUS_BACK_TO_TRADE) {
        this.#playerAccepted = false;
        pump.fire("TRADE_ACCEPT_UPDATE", 0, 0);
      } else if (change.status === TRADE_STATUS_NOT_ON_TAPLIST) {
        this.#diff(world, pump);
      } else if (change.status !== TRADE_STATUS_TRADE_CANCELED && change.status !== TRADE_STATUS_TRADE_COMPLETE
        && world.tradeMessage) {
        // A refusal that leaves the window open (too far, the partner stunned or dead, …).
        pump.fire("UI_ERROR_MESSAGE", world.tradeMessage);
      }
      return;
    }
    this.#diff(world, pump);
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlTradeHost {
  readonly trade?: FrameXmlTradeModel | undefined;
}

export type FrameXmlTradeBinding = (host: FrameXmlTradeHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

function optional(value: unknown): readonly unknown[] {
  return value === undefined ? NOTHING : [value];
}

function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

const withTrade = (answer: (trade: FrameXmlTradeModel, args: readonly unknown[]) => readonly unknown[]): FrameXmlTradeBinding =>
  (host, args) => host.trade ? answer(host.trade, args) : NOTHING;

const command = (run: (trade: FrameXmlTradeModel, args: readonly unknown[]) => void): FrameXmlTradeBinding =>
  withTrade((trade, args) => { run(trade, args); return NOTHING; });

/**
 * The flat C API. The two money getters replace F2's neutral zeros (FrameXmlNeutralApi.ts), which
 * MoneyTypeInfo["PLAYER"] subtracts from GetMoney. The coin pickup/drop pair below stays inert here:
 * L5c 3.09 — FrameXmlCursorMoney.ts answers PickupTradeMoney/AddTradeMoney over the cursor's money,
 * spread after this table in FRAMEXML_SEAM_BINDINGS.
 */
export const FRAMEXML_TRADE_BINDINGS: Readonly<Record<string, FrameXmlTradeBinding>> = Object.freeze({
  GetTradePlayerItemInfo: withTrade((trade, args) => trade.playerItemInfo(args[0]) ?? NOTHING),
  GetTradeTargetItemInfo: withTrade((trade, args) => trade.targetItemInfo(args[0]) ?? NOTHING),
  GetTradePlayerItemLink: withTrade((trade, args) => optional(trade.playerItemLink(args[0]))),
  GetTradeTargetItemLink: withTrade((trade, args) => optional(trade.targetItemLink(args[0]))),
  GetPlayerTradeMoney: (host) => [host.trade?.playerMoney() ?? 0],
  GetTargetTradeMoney: (host) => [host.trade?.targetMoney() ?? 0],
  ClickTradeButton: command((trade, args) => trade.clickPlayerSlot(args[0], truthy(args[1]))),
  // Inert here; FRAMEXML_ITEM_TARGETING_BINDINGS (FrameXmlItemTargeting.ts, spread after these) binds
  // it: slot 7 takes the waiting enchant or item-target spell as TARGET_FLAG_TRADE_ITEM slot 6.
  ClickTargetTradeButton: () => NOTHING,
  SetTradeMoney: command((trade, args) => trade.setMoney(args[0])),
  PickupTradeMoney: () => NOTHING,
  AddTradeMoney: () => NOTHING,
  AcceptTrade: command((trade) => trade.accept()),
  CancelTradeAccept: command((trade) => trade.unaccept()),
  // TradeFrame's OnHide. CancelTrade (the TRADE popup's decline, which also covers a pending request)
  // is FrameXmlPopups.ts's binding; both reach WorldClient.cancelTrade.
  CloseTrade: command((trade) => trade.cancel()),
  // TRADE_REPLACE_ENCHANT's accept; FRAMEXML_ITEM_TARGETING_BINDINGS binds it (0x00510b80 →
  // 0x0080c5f0). TRADE_POTENTIAL_BIND_ENCHANT is the model's (#diff, tradePotentialBindEnchant).
  ReplaceTradeEnchant: () => NOTHING,
});
