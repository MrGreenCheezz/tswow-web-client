/**
 * The stock AuctionFrame's C API — Blizzard_AuctionUI (load-on-demand): the Browse, Bids and
 * Auctions tabs and AuctionProgressFrame — over this client's auction packets (`WorldClient.auction*`,
 * AuctionProtocol.ts).
 *
 * Facts measured against the 3.3.5a client (Wow.exe build 12340, read-only) and the active
 * TrinityCore that shape it:
 *
 * * The browse filters are the client's own tables, not DBC order. GetAuctionItemClasses walks a
 *   static list of twelve ItemClass ids (Wow.exe .rdata 0xA14F70: 2,4,1,0,16,7,6,11,9,3,15,12, the
 *   last — Quest — without subclasses) and names each from ItemClass.dbc. GetAuctionItemSubClasses
 *   walks ItemSubClass.dbc in file order, skips rows with DisplayFlags bit 2 and names a row by its
 *   VerboseName, else its DisplayName. GetAuctionInvTypes answers only a subclass with Flags 0x200
 *   (armour Misc/Cloth/Leather/Mail/Plate): all fourteen pairs of a static table (0xA14FD0), each
 *   token with 1 or nil («display in list»): Misc shows the jewellery half, Cloth the armour slots
 *   plus Back, Leather/Mail/Plate the eight armour slots. QueryAuctionItems maps the three indices
 *   back through the same tables, the inventory index over all fourteen rows.
 * * A query waits for its answer and then for the server's `searchDelay` (5000 ms until the first
 *   list arrives; TrinityCore's Auction.SearchDelay after), as CanSendAuctionQuery reports.
 * * Every list is sorted by the client after it lands (0x59E853): the sort columns stock sets with
 *   SortAuctionSetSort are kept newest first, so the last one set is the primary (GetAuctionSort 1).
 *   TrinityCore reads and ignores the sort block of CMSG_AUCTION_LIST_ITEMS.
 * * GetAuctionItemTimeLeft buckets the milliseconds left at 30 min, 2 h and 12 h (0xA15238).
 * * CalculateAuctionDeposit is the client's 0x76DDE0: floor(DepositRate × SellPrice × count / 100)
 *   × runTime minutes / 240, at least 100 copper, with DepositRate from AuctionHouse.dbc.
 * * StartAuction posts `numStacks` lots of `stackSize`, one CMSG_AUCTION_SELL_ITEM each, the next
 *   after the previous lot's result; HandleAuctionSellItem takes a lot gathered from several stacks.
 *
 * The model fires the stock events from `AUCTION_STATE_CHANGED` (WorldClient emits it beside the
 * native window's `onAuctionChanged`). AUCTION_HOUSE_SHOW — the one event that opens the window —
 * fires only while the lazy owner has loaded and gated the add-on (`owned`); before that the native
 * window owns the visit and `onOpenRequest` asks the owner to start the load.
 */
import type { AuctionStateChange } from "../../world/EventBus.js";
import {
  AUCTION_CANCEL,
  AUCTION_PLACE_BID,
  AUCTION_SELL_ITEM,
  ERR_AUCTION_INVENTORY,
  isLeadingBid,
  type AuctionEntry,
  type AuctionList,
  type AuctionSearch,
} from "../../world/AuctionProtocol.js";
import { equipErrorText } from "../../world/ItemProtocol.js";
import { itemChatLink } from "../ui/ChatLink.js";

/** One browse class filter: an ItemClass id, its ruRU name and its visible subclasses. */
export interface FrameXmlAuctionClass {
  readonly id: number;
  readonly name: string;
  readonly subclasses: readonly { readonly id: number; readonly name: string; readonly invTypes: boolean }[];
}

/**
 * GetAuctionItemClasses/SubClasses of this dataset: the client's class order and subclass rule
 * over ItemClass.dbc and ItemSubClass.dbc (ruRU, measured; tests/framexml-auction-seam re-reads
 * both files). `invTypes` is ItemSubClass Flags 0x200.
 */
export const FRAMEXML_AUCTION_CLASSES: readonly FrameXmlAuctionClass[] = Object.freeze([
  { id: 2, name: "Оружие", subclasses: [
    [0, "Одноручные топоры"], [1, "Двуручные топоры"], [2, "Луки"], [3, "Огнестрельное"],
    [4, "Одноручное дробящее"], [5, "Двуручное дробящее"], [6, "Древковое"], [7, "Одноручные мечи"],
    [8, "Двуручные мечи"], [10, "Посохи"], [13, "Кистевое"], [14, "Разное"], [15, "Кинжалы"],
    [16, "Метательное"], [18, "Арбалеты"], [19, "Жезлы"], [20, "Удочки"],
  ] },
  { id: 4, name: "Доспехи", subclasses: [
    [0, "Разное", true], [1, "Тканевые", true], [2, "Кожаные", true], [3, "Кольчужные", true],
    [4, "Латные", true], [6, "Щиты"], [7, "Манускрипты"], [8, "Идолы"], [9, "Тотемы"], [10, "Печати"],
  ] },
  { id: 1, name: "Сумки", subclasses: [
    [0, "Сумка"], [1, "Сумка душ"], [2, "Сумка травника"], [3, "Сумка зачаровывателя"],
    [4, "Сумка инженера"], [5, "Сумка ювелира"], [6, "Сумка шахтера"], [7, "Сумка кожевника"],
    [8, "Сумка начертателя"],
  ] },
  { id: 0, name: "Расходуемые", subclasses: [
    [5, "Еда и напитки"], [1, "Зелья"], [2, "Эликсиры"], [3, "Настойки"], [7, "Бинты"],
    [6, "Улучшения"], [4, "Свитки"], [8, "Другое"],
  ] },
  { id: 16, name: "Символы", subclasses: [
    [1, "Воин"], [2, "Паладин"], [3, "Охотник"], [4, "Разбойник"], [5, "Жрец"], [6, "Рыцарь смерти"],
    [7, "Шаман"], [8, "Маг"], [9, "Чернокнижник"], [11, "Друид"],
  ] },
  { id: 7, name: "Хозяйственные товары", subclasses: [
    [10, "Стихии"], [5, "Ткань"], [6, "Кожа"], [7, "Металл и камень"], [8, "Мясо"], [9, "Трава"],
    [12, "Наложение чар"], [4, "Ювелирное дело"], [1, "Детали"], [3, "Устройства"], [2, "Взрывчатка"],
    [13, "Материалы"], [11, "Другое"], [14, "Чары для доспехов"], [15, "Чары для оружия"],
  ] },
  { id: 6, name: "Боеприпасы", subclasses: [[2, "Стрелы"], [3, "Пули"]] },
  { id: 11, name: "Амуниция", subclasses: [[2, "Колчан"], [3, "Подсумок"]] },
  { id: 9, name: "Рецепты", subclasses: [
    [0, "Книга"], [1, "Кожевничество"], [2, "Портняжное дело"], [3, "Инженерное дело"],
    [4, "Кузнечное дело"], [5, "Кулинария"], [6, "Алхимия"], [7, "Первая помощь"], [8, "Наложение чар"],
    [9, "Рыбная ловля"], [10, "Ювелирное дело"], [11, "Начертание"],
  ] },
  { id: 3, name: "Самоцветы", subclasses: [
    [0, "Красные"], [1, "Синие"], [2, "Желтые"], [3, "Фиолетовые"], [4, "Зеленые"], [5, "Оранжевые"],
    [6, "Особые"], [7, "Простые"], [8, "Радужные"],
  ] },
  { id: 15, name: "Разное", subclasses: [
    [0, "Хлам"], [1, "Реагенты"], [2, "Питомцы"], [3, "Праздничные предметы"], [4, "Другое"],
    [5, "Верховые животные"],
  ] },
  { id: 12, name: "Задания", subclasses: [] },
].map(({ id, name, subclasses }) => Object.freeze({
  id, name,
  subclasses: Object.freeze(subclasses.map(([sub, subName, invTypes]) =>
    Object.freeze({ id: sub as number, name: subName as string, invTypes: invTypes === true }))),
})));

/**
 * The client's inventory-type table (Wow.exe 0xA14FD0, 44-byte rows): the InventoryType, its
 * GlobalStrings token, and the two flags GetAuctionInvTypes reads — `misc` shows the row under armour
 * Misc, `notArmour` hides it under Leather/Mail/Plate (Cloth shows it only for INVTYPE_CLOAK).
 */
export const FRAMEXML_AUCTION_INV_TYPES: readonly {
  readonly invType: number; readonly token: string; readonly misc: boolean; readonly notArmour: boolean;
}[] = Object.freeze([
  [1, "INVTYPE_HEAD", 1, 0], [2, "INVTYPE_NECK", 1, 1], [3, "INVTYPE_SHOULDER", 0, 0],
  [4, "INVTYPE_BODY", 1, 1], [5, "INVTYPE_CHEST", 0, 0], [6, "INVTYPE_WAIST", 0, 0],
  [7, "INVTYPE_LEGS", 0, 0], [8, "INVTYPE_FEET", 0, 0], [9, "INVTYPE_WRIST", 0, 0],
  [10, "INVTYPE_HAND", 0, 0], [11, "INVTYPE_FINGER", 1, 1], [12, "INVTYPE_TRINKET", 1, 1],
  [16, "INVTYPE_CLOAK", 0, 1], [23, "INVTYPE_HOLDABLE", 1, 1],
].map(([invType, token, misc, notArmour]) => Object.freeze({
  invType: invType as number, token: token as string, misc: misc === 1, notArmour: notArmour === 1,
})));

const INVTYPE_CLOAK = 16;
/** AuctionHouse.dbc DepositRate by house id (hello's `houseId`), measured on this dataset. */
const HOUSE_DEPOSIT_RATE: ReadonlyMap<number, number> = new Map([[1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5], [7, 25]]);
const DEFAULT_DEPOSIT_RATE = 5;
/** `AH_MINIMUM_DEPOSIT`, and the client's floor (0x76DE5D). */
const MINIMUM_DEPOSIT = 100;
/** StartAuction/CalculateAuctionDeposit run times 1..3 in minutes (0xA15248); anything else is 1440. */
const RUN_TIME_MINUTES = [720, 1440, 2880] as const;
/** GetAuctionItemTimeLeft's buckets in milliseconds (0xA15238). */
const TIME_LEFT_BUCKETS = [1_800_000, 7_200_000, 43_200_000] as const;
/** The client's delay before the first list (0x59F062) and CanSendAuctionQuery's getAll wait. */
const INITIAL_QUERY_DELAY_MS = 5000;
const GET_ALL_DELAY_MS = 900_000;
/**
 * How long a list query or a posted lot waits for its answer, in pump seconds. Chosen, not measured:
 * TrinityCore answers in the same session update when it answers at all, but it drops a request
 * without a word when the auctioneer is out of interaction range (AuctionHouseHandler.cpp:170-173,
 * :779-784), and this client has no out-of-range close for the house. Without it one dropped request
 * kept CanSendAuctionQuery or the sell slot refused for the rest of the visit.
 */
const ANSWER_TIMEOUT_S = 30;
/** `NUM_AUCTION_ITEMS_PER_PAGE`; `MAXIMUM_BID_PRICE` (Blizzard_AuctionUI.lua:3, :12). */
const PAGE_SIZE = 50;
const MAXIMUM_BID_PRICE = 2_000_000_000;
/** The client keeps twelve sort columns per list (0xC0E608, 12-byte rows up to 0x90). */
const MAX_SORT_COLUMNS = 12;
/** ITEM_FLAG_CONJURED (ItemTemplate.h). */
const ITEM_FLAG_CONJURED = 0x2;

/** `AuctionError` (AuctionHouseMgr.h:37-48) in the client's words, GlobalStrings keys. */
const COMMAND_ERRORS: Readonly<Record<number, string>> = {
  2: "ERR_AUCTION_DATABASE_ERROR",
  3: "ERR_NOT_ENOUGH_MONEY",
  4: "ERR_ITEM_NOT_FOUND",
  5: "ERR_AUCTION_HIGHER_BID",
  7: "ERR_AUCTION_BID_INCREMENT",
  10: "ERR_AUCTION_BID_OWN",
  13: "ERR_RESTRICTED_ACCOUNT",
};
/** A successful command's system line. */
const COMMAND_DONE: Readonly<Record<number, string>> = {
  [AUCTION_SELL_ITEM]: "ERR_AUCTION_STARTED",
  [AUCTION_CANCEL]: "ERR_AUCTION_REMOVED",
  [AUCTION_PLACE_BID]: "ERR_AUCTION_BID_PLACED",
};

export type FrameXmlAuctionListType = "list" | "bidder" | "owner";
const LIST_TYPES: readonly FrameXmlAuctionListType[] = ["list", "bidder", "owner"];
const LIST_EVENTS: Readonly<Record<FrameXmlAuctionListType, string>> = {
  list: "AUCTION_ITEM_LIST_UPDATE", bidder: "AUCTION_BIDDER_LIST_UPDATE", owner: "AUCTION_OWNED_LIST_UPDATE",
};
/** The column names stock's AuctionSort tables use (Blizzard_AuctionUI.lua:24-177). */
const SORT_COLUMNS = new Set(["quality", "level", "duration", "bid", "name", "quantity", "minbidbuyout", "buyout", "status", "seller"]);

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlAuctionWorld {
  readonly events?: {
    on(name: "AUCTION_STATE_CHANGED", listener: (change: AuctionStateChange) => void): () => void;
  } | undefined;
  readonly auctioneerGuid: bigint;
  readonly auctions: AuctionList | undefined;
  readonly ownAuctions: AuctionList | undefined;
  readonly bidAuctions: AuctionList | undefined;
  readonly names?: { get(guid: bigint): string | undefined } | undefined;
  readonly selfName?: string | undefined;
  readonly state?: { readonly selfGuid?: bigint | undefined } | undefined;
  requestName?(guid: bigint): void;
  searchAuctions(search: AuctionSearch): void;
  listOwnAuctions(): void;
  listBidderAuctions(): void;
  bidOnAuction(auctionId: number, price: number): void;
  cancelAuction(auctionId: number): void;
  createAuction(itemGuid: bigint, count: number, startBid: number, buyout: number, durationMinutes: number): void;
  createAuctionFromStacks?(items: readonly { readonly guid: bigint; readonly count: number }[],
    startBid: number, buyout: number, durationMinutes: number): void;
  closeAuctionHouse(): void;
  /** WorldClient's hello-search predicate; the model answers false while stock owns the house. */
  auctionHelloSearch?: (() => boolean) | undefined;
}

/** Cache-only item facts; the template fields stay undefined until SMSG_ITEM_QUERY answers. */
export interface FrameXmlAuctionItem {
  readonly name: string;
  readonly texture?: string | undefined;
  readonly quality?: number | undefined;
  readonly requiredLevel?: number | undefined;
  readonly sellPrice?: number | undefined;
  /** `item_template.stackable`: GetAuctionSellItemInfo's `stackCount`. */
  readonly maxStack?: number | undefined;
  readonly flags?: number | undefined;
  /** `item_template.AllowableClass`/`AllowableRace` masks: 0 (or every bit) allows everyone. */
  readonly allowableClass?: number | undefined;
  readonly allowableRace?: number | undefined;
}

/** The owned carried item behind a GUID. */
export interface FrameXmlAuctionItemObject {
  readonly entry: number;
  readonly count: number;
  /** ITEM_FIELD_FLAGS bit 0: the client refuses to post a bound item (ERR_AUCTION_BOUND_ITEM). */
  readonly soulbound?: boolean | undefined;
  /** ITEM_FIELD_DURATION: a timed item cannot be posted (ERR_AUCTION_LIMITED_DURATION_ITEM). */
  readonly duration?: number | undefined;
}

/** What the model asks its host (LiveWorldSeam or the canned seam) besides the world. */
export interface FrameXmlAuctionContext {
  world(): FrameXmlAuctionWorld | undefined;
  item(entry: number): FrameXmlAuctionItem | undefined;
  itemObject(guid: bigint): FrameXmlAuctionItemObject | undefined;
  /** Every carried stack of an entry, in bag order: what a multisell gathers its lots from. */
  carriedStacks(entry: number): readonly { readonly guid: bigint; readonly count: number }[];
  /** An exact link for an owned item (its enchant/random suffix), when the host has one. */
  itemLink?(guid: bigint): string | undefined;
  cursorItem(): { readonly guid: bigint; readonly bag: number; readonly slot: number } | undefined;
  clearCursor(): void;
  pickupItem?(guid: bigint): void;
  playerLevel(): number;
  /** The player's ChrClasses and ChrRaces ids, for the AllowableClass/Race masks of `canUse`. */
  playerClassRace?(): { readonly classId?: number | undefined; readonly raceId?: number | undefined } | undefined;
  /** Load item metadata outside a C-API read; `onChanged` runs once the cache moved. */
  prefetchItems?(entries: readonly number[], onChanged: () => void): void;
  /** The sell slot moved: the bags repaint their lock state (`selling`). */
  locksChanged?(): void;
}

interface FrameXmlAuctionPump {
  fire(event: string, ...args: readonly unknown[]): number;
  now(): number;
}

/** GetAuctionItemInfo's thirteen values, in the order Blizzard_AuctionUI.lua:792 reads them. */
export type FrameXmlAuctionItemInfo = readonly [
  name: string | undefined, texture: string | undefined, count: number, quality: number, canUse: boolean | undefined,
  level: number, minBid: number, minIncrement: number, buyoutPrice: number, bidAmount: number,
  highBidder: 1 | string | undefined, owner: string | undefined, saleStatus: number,
];

/** GetAuctionSellItemInfo with nothing in the slot (0x59F914): stock indexes ITEM_QUALITY_COLORS[-1]. */
const EMPTY_SELL_ITEM: readonly unknown[] = Object.freeze([undefined, undefined, 1, -1, undefined, 0, 0, 0, 0]);

interface ShownList {
  readonly source: AuctionList;
  /** Pump seconds when the list landed; time left counts down from here. */
  readonly receivedAt: number;
  rows: readonly AuctionEntry[];
}

interface SortColumn {
  readonly column: string;
  readonly reverse: boolean;
}

interface Posting {
  readonly lots: readonly (readonly { readonly guid: bigint; readonly count: number }[])[];
  readonly startBid: number;
  readonly buyout: number;
  readonly minutes: number;
  sent: number;
  created: number;
  /** Pump seconds when the last lot went out (ANSWER_TIMEOUT_S). */
  sentAt: number;
}

/** One list request the model saw go out: stock's own query, or one the world sent for itself. */
interface AwaitedAnswer {
  readonly origin: "stock" | "world";
  readonly at: number;
}

/** AllowableClass/AllowableRace: 0 allows everyone, else the player's bit must be set (Player::CanUseItem). */
function maskExcludes(mask: number | undefined, id: number | undefined): boolean {
  return mask !== undefined && mask !== 0 && id !== undefined && Number.isInteger(id) && id >= 1 && id <= 32
    && (mask & (1 << (id - 1))) === 0;
}

function numberArg(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function indexArg(value: unknown): number | undefined {
  const number = numberArg(value);
  return number !== undefined && Number.isInteger(number) && number >= 1 ? number : undefined;
}

function copperArg(value: unknown): number | undefined {
  const number = numberArg(value);
  return number !== undefined && Number.isSafeInteger(Math.floor(number)) && number >= 0 ? Math.floor(number) : undefined;
}

/** Lua truthiness: nil and false are false (0 is true in Lua, but stock passes 1/nil here). */
function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function listType(value: unknown): FrameXmlAuctionListType | undefined {
  return value === "list" || value === "bidder" || value === "owner" ? value : undefined;
}

/** GlobalStrings `%s`/`%1$s` substitution for the one-argument auction lines. */
function formatOne(pattern: string, value: string): string {
  const match = /%(?:1\$)?s/.exec(pattern);
  if (!match) return pattern.replace(/%%/g, "%");
  return pattern.slice(0, match.index).replace(/%%/g, "%") + value
    + pattern.slice(match.index + match[0].length).replace(/%%/g, "%");
}

/** The client's deposit (0x76DDE0): uint32 products, floor to copper, 100 copper minimum. */
export function frameXmlAuctionDeposit(rate: number, sellPrice: number, count: number, minutes: number): number {
  if (!RUN_TIME_MINUTES.includes(minutes as typeof RUN_TIME_MINUTES[number])) return MINIMUM_DEPOSIT;
  const price = Math.imul(sellPrice >>> 0, count >>> 0) >>> 0;
  const base = Math.floor((Math.imul(rate >>> 0, price) >>> 0) / 100);
  const deposit = Math.trunc(base * minutes / 240);
  return deposit < MINIMUM_DEPOSIT ? MINIMUM_DEPOSIT : deposit;
}

/**
 * One owner of the stock auction C API. Client-held state — the sort columns, selections, the sell
 * slot and a multisell in progress — lives here as the client keeps it; server lists are adopted
 * from the world when their packet lands.
 */
export class FrameXmlAuctionModel {
  readonly #context: FrameXmlAuctionContext;
  #pump: FrameXmlAuctionPump | undefined;
  #unsubscribe: (() => void) | undefined;
  #owned = false;
  #muted = false;
  #resolve: ((name: string) => string | undefined) | undefined;
  /** The auctioneer stock was sent AUCTION_HOUSE_SHOW for; 0n while the stock window has none. */
  #shown = 0n;
  #houseId = 0;
  readonly #lists = new Map<FrameXmlAuctionListType, ShownList>();
  /** The browse list stays empty until stock asks: the world's own opening search is not stock's. */
  #listQueried = false;
  /**
   * Every list request in flight, oldest first, per list. TrinityCore answers them in order, so the
   * head names whose answer lands: the world's refresh after a command (and its opening search) is
   * not the answer to a newer stock query, and must neither end stock's wait nor replace its page.
   */
  readonly #awaiting = new Map<FrameXmlAuctionListType, AwaitedAnswer[]>();
  readonly #queriedAt = new Map<FrameXmlAuctionListType, number>();
  #getAllAt: number | undefined;
  #delayMs = INITIAL_QUERY_DELAY_MS;
  readonly #sorts = new Map<FrameXmlAuctionListType, SortColumn[]>(LIST_TYPES.map((type) => [type, []]));
  readonly #selected = new Map<FrameXmlAuctionListType, number>();
  #sellGuid: bigint | undefined;
  /** The sell slot's `entry:count` at the last repaint (`#watchSellItem`). */
  #sellSignature = "";
  #tabShowing = false;
  #posting: Posting | undefined;
  /** Chat lines waiting for an item name: SMSG_AUCTION_*_NOTIFICATION carries only the entry. */
  readonly #notices: { readonly token: string; readonly entry: number; readonly since: number }[] = [];
  #metadataSignature = "";
  #metadataCheckedAt = Number.NEGATIVE_INFINITY;
  readonly #prefetched = new Set<number>();
  readonly #namesAsked = new Set<bigint>();
  /** Set by the lazy owner: the first auctioneer of a session starts the add-on load. */
  onOpenRequest: (() => void) | undefined;
  /** The world whose `auctionHelloSearch` this model answers, and the answer itself. */
  #helloWorld: FrameXmlAuctionWorld | undefined;
  readonly #helloSearch = (): boolean => !this.#owned;

  constructor(context: FrameXmlAuctionContext) {
    this.#context = context;
  }

  // ---- lifecycle -------------------------------------------------------------------------

  attach(pump: FrameXmlAuctionPump): void {
    this.detach();
    this.#pump = pump;
    const world = this.#context.world();
    if (world?.events && typeof world.events.on === "function") {
      this.#unsubscribe = world.events.on("AUCTION_STATE_CHANGED", (change) => this.#onState(change));
    }
    // While stock owns the house a hello sends no opening search: stock waits for its Search button.
    if (world && typeof world === "object") {
      try {
        world.auctionHelloSearch = this.#helloSearch;
        this.#helloWorld = world;
      } catch { /* a sealed test double keeps its own default */ }
    }
    this.#shown = 0n;
    this.#metadataSignature = "";
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    try {
      if (this.#helloWorld?.auctionHelloSearch === this.#helloSearch) this.#helloWorld.auctionHelloSearch = undefined;
    } catch { /* see attach */ }
    this.#helloWorld = undefined;
    this.#pump = undefined;
    this.#owned = false;
    this.#reset(false);
    this.#resetQueries();
  }

  /**
   * Whether the stock AuctionFrame owns the auction route (set by the lazy owner once
   * Blizzard_AuctionUI is loaded and gated). Taking ownership is an edge: an auction house already
   * open is handed to stock with AUCTION_HOUSE_SHOW, because the server does not repeat its hello.
   */
  get owned(): boolean { return this.#owned; }
  set owned(owned: boolean) {
    if (owned === this.#owned) return;
    this.#owned = owned;
    if (!owned) {
      this.#reset(false);
      this.#resetQueries();
      return;
    }
    const world = this.#world();
    if (world) this.#show(world);
  }

  /** Whether stock is showing an auction house now (AUCTION_HOUSE_SHOW sent, CLOSED not yet). */
  get showing(): boolean { return this.#shown !== 0n; }

  /** Whether the world stands at an auctioneer (hello answered, not closed), whoever shows it. */
  houseOpen(): boolean { return this.#world() !== undefined; }

  /** Run a transactional probe (the owner's gate) without sending a packet or closing the house. */
  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  /** GlobalStrings for UI_ERROR_MESSAGE and the system lines; the owner binds the VM's own. */
  useGlobalStrings(resolve: ((name: string) => string | undefined) | undefined): void {
    this.#resolve = resolve;
  }

  /** Unbind `resolve` only if it is still the bound one (a newer owner may have bound its VM's). */
  releaseGlobalStrings(resolve: (name: string) => string | undefined): void {
    if (this.#resolve === resolve) this.#resolve = undefined;
  }

  #world(): FrameXmlAuctionWorld | undefined {
    const world = this.#context.world();
    // A partial world (older test doubles) without the field stands at no auctioneer.
    return world && typeof world.auctioneerGuid === "bigint" && world.auctioneerGuid !== 0n ? world : undefined;
  }

  #command(run: (world: FrameXmlAuctionWorld) => void): boolean {
    if (this.#muted) return false;
    const world = this.#world();
    if (!world) return false;
    run(world);
    return true;
  }

  #now(): number {
    return this.#pump?.now() ?? 0;
  }

  // ---- lists -----------------------------------------------------------------------------

  #shownList(type: FrameXmlAuctionListType): ShownList | undefined {
    return this.#world() ? this.#lists.get(type) : undefined;
  }

  #entry(type: unknown, index: unknown): { readonly entry: AuctionEntry; readonly list: ShownList } | undefined {
    const kind = listType(type);
    const number = indexArg(index);
    const list = kind ? this.#shownList(kind) : undefined;
    const entry = list && number !== undefined ? list.rows[number - 1] : undefined;
    return entry && list ? { entry, list } : undefined;
  }

  /** `GetNumAuctionItems(type)`: rows on this page and the server's total. */
  numItems(type: unknown): readonly [batch: number, total: number] {
    const kind = listType(type);
    const list = kind ? this.#shownList(kind) : undefined;
    if (!list) return [0, 0];
    return [list.rows.length, Math.max(list.rows.length, list.source.totalCount)];
  }

  #selfGuid(): bigint | undefined {
    const world = this.#context.world();
    return world?.state?.selfGuid;
  }

  #selfName(): string | undefined {
    return this.#context.world()?.selfName;
  }

  /** A player's name by the counter the auction entry carries (player GUIDs have a zero high part). */
  #playerName(low: bigint): string | undefined {
    if (low === 0n) return undefined;
    const self = this.#selfGuid();
    if (self !== undefined && (low & 0xffff_ffffn) === (self & 0xffff_ffffn)) return this.#selfName();
    return this.#context.world()?.names?.get(low);
  }

  #canUse(item: FrameXmlAuctionItem | undefined): boolean | undefined {
    // The refusals the item template proves: a level above the player's, and an AllowableClass or
    // AllowableRace mask without the player's bit. Stock tints those icons red, as the client does.
    // Skill, spell, reputation and proficiency need player state this model does not read.
    const required = item?.requiredLevel;
    if (required !== undefined && required > this.#context.playerLevel()) return undefined;
    const player = this.#context.playerClassRace?.();
    if (maskExcludes(item?.allowableClass, player?.classId) || maskExcludes(item?.allowableRace, player?.raceId)) return undefined;
    return true;
  }

  /**
   * `GetAuctionItemInfo(type, index)`. An item whose name is not cached answers a nil name with
   * numbers everywhere else: stock hides that row (Bug 145328, Blizzard_AuctionUI.lua:793) but still
   * compares `level`, `count`, `bidAmount` and `buyoutPrice` and indexes ITEM_QUALITY_COLORS.
   */
  itemInfo(type: unknown, index: unknown): FrameXmlAuctionItemInfo | undefined {
    const found = this.#entry(type, index);
    if (!found) return undefined;
    const { entry } = found;
    const item = this.#context.item(entry.itemId);
    const kind = listType(type)!;
    const self = this.#selfGuid() ?? 0n;
    const highBidder: 1 | string | undefined = kind === "owner"
      ? (entry.bid > 0 ? this.#playerName(entry.bidderLow) ?? "" : undefined)
      : (isLeadingBid(entry, self) ? 1 : undefined);
    const owner = kind === "owner" ? this.#selfName() : this.#playerName(entry.ownerLow);
    return [
      item?.name, item?.texture, entry.count, item?.quality ?? 1, this.#canUse(item),
      item?.requiredLevel ?? 0, entry.startBid, entry.minIncrement, entry.buyout, entry.bid,
      highBidder, owner, 0,
    ];
  }

  itemLink(type: unknown, index: unknown): string | undefined {
    const found = this.#entry(type, index);
    const item = found ? this.#context.item(found.entry.itemId) : undefined;
    return found && item
      ? itemChatLink(found.entry.itemId, item.quality ?? 1, item.name, 0, found.entry.randomPropertyId) : undefined;
  }

  #remainingMs(entry: AuctionEntry, list: ShownList): number {
    return entry.timeLeft - Math.max(0, this.#now() - list.receivedAt) * 1000;
  }

  /** `GetAuctionItemTimeLeft(type, index)`: 1 short … 4 very long (AUCTION_TIME_LEFT1..4). */
  timeLeft(type: unknown, index: unknown): number | undefined {
    const found = this.#entry(type, index);
    if (!found) return undefined;
    const remaining = this.#remainingMs(found.entry, found.list);
    const bucket = TIME_LEFT_BUCKETS.findIndex((limit) => remaining < limit);
    return bucket < 0 ? 4 : bucket + 1;
  }

  // ---- queries ---------------------------------------------------------------------------

  /** `CanSendAuctionQuery(type)`: no answer outstanding and the server's delay has passed. */
  canQuery(type: unknown = "list"): readonly [canQuery: boolean | undefined, canQueryAll: boolean | undefined] {
    const kind = listType(type) ?? "list";
    if (!this.#world() || this.#stockWaiting(kind)) return [undefined, undefined];
    const now = this.#now() * 1000;
    const at = this.#queriedAt.get(kind);
    if (at !== undefined && now - at < this.#delayMs) return [undefined, undefined];
    const all = this.#getAllAt === undefined || now - this.#getAllAt >= GET_ALL_DELAY_MS;
    return [true, all ? true : undefined];
  }

  /** A request of `origin` went out for `type`; its answer is the one after those already awaited. */
  #expect(type: FrameXmlAuctionListType, origin: AwaitedAnswer["origin"]): void {
    const queue = this.#awaiting.get(type) ?? [];
    queue.push({ origin, at: this.#now() });
    this.#awaiting.set(type, queue);
  }

  /** The requests still awaited, without those unanswered past ANSWER_TIMEOUT_S (dropped by the core). */
  #awaited(type: FrameXmlAuctionListType): AwaitedAnswer[] {
    const queue = this.#awaiting.get(type) ?? [];
    const now = this.#now();
    while (queue.length > 0 && now - queue[0]!.at > ANSWER_TIMEOUT_S) queue.shift();
    return queue;
  }

  /** Whether stock's own query of this list is still unanswered (CanSendAuctionQuery waits for it). */
  #stockWaiting(type: FrameXmlAuctionListType): boolean {
    return this.#awaited(type).some((request) => request.origin === "stock");
  }

  #markQueried(type: FrameXmlAuctionListType): void {
    this.#expect(type, "stock");
    this.#queriedAt.set(type, this.#now() * 1000);
  }

  /**
   * `QueryAuctionItems(name, minLevel, maxLevel, invTypeIndex, classIndex, subclassIndex, page,
   * usable, rarity, getAll)`, mapped through the client's filter tables. A throttled query does
   * nothing, as in the client (0x59BD0F).
   */
  query(args: readonly unknown[]): void {
    if (!this.canQuery("list")[0]) return;
    const [name, minLevel, maxLevel, invTypeIndex, classIndex, subclassIndex, page, usable, rarity, getAll] = args;
    const search: { -readonly [K in keyof AuctionSearch]: AuctionSearch[K] } = {};
    search.name = typeof name === "string" ? name : typeof name === "number" ? String(name) : "";
    const levelMin = numberArg(minLevel);
    const levelMax = numberArg(maxLevel);
    if (levelMin !== undefined) search.levelMin = Math.trunc(levelMin) & 0xff;
    if (levelMax !== undefined) search.levelMax = Math.trunc(levelMax) & 0xff;
    const invType = indexArg(invTypeIndex);
    const invRow = invType !== undefined ? FRAMEXML_AUCTION_INV_TYPES[invType - 1] : undefined;
    if (invRow) search.inventoryType = invRow.invType;
    const classRow = (() => {
      const index = indexArg(classIndex);
      return index !== undefined ? FRAMEXML_AUCTION_CLASSES[index - 1] : undefined;
    })();
    if (classRow) {
      search.itemClass = classRow.id;
      const index = indexArg(subclassIndex);
      const subRow = index !== undefined ? classRow.subclasses[index - 1] : undefined;
      if (subRow) search.itemSubClass = subRow.id;
    }
    const pageNumber = numberArg(page);
    search.page = pageNumber !== undefined && pageNumber >= 0 ? Math.trunc(pageNumber) : 0;
    const quality = numberArg(rarity);
    if (quality !== undefined && quality >= 0) search.quality = Math.trunc(quality);
    if (truthy(usable) && usable !== 0) search.usableOnly = true;
    const all = getAll === true;
    if (all) search.getAll = true;
    if (this.#command((world) => world.searchAuctions(search))) {
      this.#listQueried = true;
      this.#markQueried("list");
      if (all) this.#getAllAt = this.#now() * 1000;
    }
  }

  /** `GetOwnerAuctionItems(page)` / `GetBidderAuctionItems(page)`: TrinityCore answers each whole. */
  queryOwner(): void {
    if (!this.canQuery("owner")[0]) return;
    if (this.#command((world) => world.listOwnAuctions())) this.#markQueried("owner");
  }

  queryBidder(): void {
    if (!this.canQuery("bidder")[0]) return;
    if (this.#command((world) => world.listBidderAuctions())) this.#markQueried("bidder");
  }

  // ---- selection and sorting ---------------------------------------------------------------

  /** `GetSelectedAuctionItem(type)`: the selected row's index, 0 for none (stock compares `> 0`). */
  selected(type: unknown): number {
    const kind = listType(type);
    const auctionId = kind ? this.#selected.get(kind) : undefined;
    const list = kind ? this.#shownList(kind) : undefined;
    if (auctionId === undefined || !list) return 0;
    return list.rows.findIndex((entry) => entry.auctionId === auctionId) + 1;
  }

  /** `SetSelectedAuctionItem(type, index)`: kept by auction id, so a refreshed list keeps the lot. */
  select(type: unknown, index: unknown): void {
    const kind = listType(type);
    if (!kind) return;
    const number = indexArg(index);
    const entry = number !== undefined ? this.#shownList(kind)?.rows[number - 1] : undefined;
    if (entry) this.#selected.set(kind, entry.auctionId);
    else this.#selected.delete(kind);
  }

  clearSort(type: unknown): void {
    const kind = listType(type);
    if (kind) this.#sorts.set(kind, []);
  }

  /** `SortAuctionSetSort(type, column, reverse)`: the newest column is the primary (0x59A690). */
  setSort(type: unknown, column: unknown, reverse: unknown): void {
    const kind = listType(type);
    if (!kind || typeof column !== "string" || !SORT_COLUMNS.has(column)) return;
    const columns = this.#sorts.get(kind)!.filter((entry) => entry.column !== column);
    columns.unshift({ column, reverse: truthy(reverse) });
    this.#sorts.set(kind, columns.slice(0, MAX_SORT_COLUMNS));
  }

  /** `GetAuctionSort(type, index)`: the column and 1/nil for reversed; nothing past the last. */
  sort(type: unknown, index: unknown): readonly unknown[] {
    const kind = listType(type);
    const number = indexArg(index);
    const column = kind && number !== undefined ? this.#sorts.get(kind)![number - 1] : undefined;
    return column ? [column.column, column.reverse ? 1 : undefined] : [];
  }

  sortReversed(type: unknown, column: unknown): boolean {
    const kind = listType(type);
    return kind !== undefined && this.#sorts.get(kind)!.some((entry) => entry.column === column && entry.reverse);
  }

  /** `SortAuctionApplySort(type)`: re-sort the landed list and repaint it. */
  applySort(type: unknown): void {
    const kind = listType(type);
    if (!kind) return;
    const list = this.#lists.get(kind);
    if (list) list.rows = this.#sorted(kind, list);
    if (this.#shown !== 0n) this.#pump?.fire(LIST_EVENTS[kind]);
  }

  /** `SortAuctionItems(type, column)`, the older single-column form: repeat to reverse. */
  sortItems(type: unknown, column: unknown): void {
    const kind = listType(type);
    if (!kind || typeof column !== "string" || !SORT_COLUMNS.has(column)) return;
    const primary = this.#sorts.get(kind)![0];
    this.setSort(kind, column, primary?.column === column ? !primary.reverse : false);
    this.applySort(kind);
  }

  #sortKey(kind: FrameXmlAuctionListType, entry: AuctionEntry, list: ShownList, column: string): number | string {
    const item = this.#context.item(entry.itemId);
    switch (column) {
      case "quality": return item?.quality ?? -1;
      case "level": return item?.requiredLevel ?? 0;
      case "duration": return this.#remainingMs(entry, list);
      case "bid": return entry.bid > 0 ? entry.bid : entry.startBid;
      case "name": return item?.name ?? "";
      case "quantity": return entry.count;
      case "minbidbuyout": return entry.buyout > 0 ? entry.buyout : entry.bid > 0 ? entry.bid + entry.minIncrement : entry.startBid;
      case "buyout": return entry.buyout;
      case "seller": return this.#playerName(entry.ownerLow) ?? "";
      case "status":
        return kind === "owner" ? (entry.bid > 0 ? this.#playerName(entry.bidderLow) ?? "" : "")
          : isLeadingBid(entry, this.#selfGuid() ?? 0n) ? 1 : 0;
      default: return 0;
    }
  }

  /** Stable: equal lots keep the server's order, so a repaint never shuffles rows under the cursor. */
  #sorted(kind: FrameXmlAuctionListType, list: ShownList): readonly AuctionEntry[] {
    const columns = this.#sorts.get(kind)!;
    const ranked = list.source.entries.map((entry, index) => ({ entry, index }));
    if (columns.length === 0) return ranked.map(({ entry }) => entry);
    const keys = ranked.map(({ entry }) => columns.map(({ column }) => this.#sortKey(kind, entry, list, column)));
    const order = ranked.map((_, index) => index);
    order.sort((left, right) => {
      for (let at = 0; at < columns.length; at += 1) {
        const a = keys[left]![at]!;
        const b = keys[right]![at]!;
        const compared = typeof a === "string" || typeof b === "string"
          ? String(a).localeCompare(String(b), "ru") : a - b;
        if (compared !== 0) return columns[at]!.reverse ? -compared : compared;
      }
      return left - right;
    });
    return order.map((index) => ranked[index]!.entry);
  }

  // ---- commands --------------------------------------------------------------------------

  /** `PlaceAuctionBid(type, index, bid)`: a bid or, at the buyout price, a buyout. */
  placeBid(type: unknown, index: unknown, bid: unknown): void {
    const found = this.#entry(type, index);
    const price = copperArg(bid);
    if (!found || price === undefined || price <= 0 || price > MAXIMUM_BID_PRICE) return;
    this.#command((world) => world.bidOnAuction(found.entry.auctionId, price));
  }

  /** `CancelAuction(index)`: the owner list's row. */
  cancel(index: unknown): void {
    const found = this.#entry("owner", index);
    if (found) this.#command((world) => world.cancelAuction(found.entry.auctionId));
  }

  /** `CanCancelAuction(index)`: an unsold lot of the player's (TrinityCore lists no sold ones). */
  canCancel(index: unknown): boolean {
    return this.#entry("owner", index) !== undefined;
  }

  /** `CloseAuctionHouse`: AuctionFrame's OnHide. The client sends nothing; the world lets go. */
  close(): void {
    this.#command((world) => world.closeAuctionHouse());
  }

  /** `SetAuctionsTabShowing(showing)`: a right-clicked bag item then goes to the sell slot. */
  setTabShowing(showing: boolean): void {
    this.#tabShowing = showing;
  }

  // ---- the sell slot ---------------------------------------------------------------------

  #sellItem(): { readonly guid: bigint; readonly object: FrameXmlAuctionItemObject } | undefined {
    const guid = this.#sellGuid;
    if (guid === undefined) return undefined;
    const object = this.#context.itemObject(guid);
    return object ? { guid, object } : undefined;
  }

  /** The item in the sell slot, which the bags show locked as the client does. */
  selling(guid: bigint): boolean {
    return this.#owned && this.#sellGuid === guid && this.#sellItem() !== undefined;
  }

  /** Why the client refuses an item for the sell slot, as a GlobalStrings key; undefined if it may go. */
  #refusal(object: FrameXmlAuctionItemObject): string | undefined {
    const item = this.#context.item(object.entry);
    if (object.soulbound) return "ERR_AUCTION_BOUND_ITEM";
    if (((item?.flags ?? 0) & ITEM_FLAG_CONJURED) !== 0) return "ERR_AUCTION_CONJURED_ITEM";
    if ((object.duration ?? 0) > 0) return "ERR_AUCTION_LIMITED_DURATION_ITEM";
    return undefined;
  }

  /** The model's own slot changes repaint through NEW_AUCTION_UPDATE; the watch starts over. */
  #assignSell(guid: bigint | undefined): void {
    this.#sellGuid = guid;
    this.#sellSignature = "";
  }

  #setSellItem(guid: bigint | undefined): void {
    const previous = this.#sellItem()?.guid;
    this.#assignSell(guid);
    if (previous !== undefined && previous !== guid) this.#context.pickupItem?.(previous);
    this.#pump?.fire("NEW_AUCTION_UPDATE");
    this.#context.locksChanged?.();
  }

  /**
   * `ClickAuctionSellItemButton()`: the cursor's item goes into the sell slot and a held one comes
   * back onto the cursor (0x59D410); an empty cursor picks the held item up. Dropping the held item
   * back on its own slot only clears the cursor. A bound, conjured or timed item is refused in the
   * client's words and stays on the cursor.
   */
  clickSellItem(): void {
    if (this.#muted || !this.#world() || this.#postingActive()) return;
    const cursor = this.#context.cursorItem();
    if (cursor && cursor.guid === this.#sellItem()?.guid) {
      this.#context.clearCursor();
      return;
    }
    if (cursor) {
      const object = this.#context.itemObject(cursor.guid);
      if (!object) return;
      const refusal = this.#refusal(object);
      if (refusal) {
        this.#error(refusal);
        return;
      }
      this.#context.clearCursor();
      this.#setSellItem(cursor.guid);
      return;
    }
    if (this.#sellItem()) this.#setSellItem(undefined);
  }

  /** A right-clicked bag item while the Auctions tab shows: into the sell slot (as the client does). */
  useItem(guid: bigint): boolean {
    if (!this.#owned || !this.#tabShowing || this.#shown === 0n || this.#muted || this.#postingActive()) return false;
    if (this.#sellGuid === guid) return true;
    const object = this.#context.itemObject(guid);
    if (!object) return false;
    const refusal = this.#refusal(object);
    if (refusal) {
      this.#error(refusal);
      return true;
    }
    // A right click never lifts the previous item onto the cursor: it only stops being locked.
    this.#assignSell(guid);
    this.#pump?.fire("NEW_AUCTION_UPDATE");
    this.#context.locksChanged?.();
    return true;
  }

  #carriedTotal(entry: number): number {
    return this.#context.carriedStacks(entry).reduce((sum, stack) => sum + stack.count, 0);
  }

  /**
   * `GetAuctionSellItemInfo()`: name, texture, count, quality, canUse, price (the stack's vendor
   * price), pricePerUnit, stackCount (the item's stack size) and totalCount (carried of this item).
   */
  sellItemInfo(): readonly unknown[] {
    const sell = this.#sellItem();
    if (!sell || !this.#world()) return EMPTY_SELL_ITEM;
    const item = this.#context.item(sell.object.entry);
    const perUnit = item?.sellPrice ?? 0;
    return [
      item?.name, item?.texture, sell.object.count, item?.quality ?? 1, this.#canUse(item),
      Math.imul(perUnit >>> 0, sell.object.count >>> 0) >>> 0, perUnit,
      Math.max(1, item?.maxStack ?? sell.object.count), Math.max(sell.object.count, this.#carriedTotal(sell.object.entry)),
    ];
  }

  sellItemLink(): string | undefined {
    const sell = this.#sellItem();
    if (!sell) return undefined;
    const exact = this.#context.itemLink?.(sell.guid);
    if (exact) return exact;
    const item = this.#context.item(sell.object.entry);
    return item ? itemChatLink(sell.object.entry, item.quality ?? 1, item.name) : undefined;
  }

  /** `GetAuctionHouseDepositRate()`: the open house's AuctionHouse.dbc DepositRate. */
  depositRate(): number {
    return HOUSE_DEPOSIT_RATE.get(this.#houseId) ?? DEFAULT_DEPOSIT_RATE;
  }

  /** `CalculateAuctionDeposit(runTime[, count])`: 0 with no house or no sell item (0x59D3E8). */
  deposit(runTime: unknown, count: unknown): number {
    const sell = this.#sellItem();
    if (!sell || !this.#world()) return 0;
    const item = this.#context.item(sell.object.entry);
    const index = numberArg(runTime);
    const minutes = index !== undefined && index >= 1 && index <= 3 ? RUN_TIME_MINUTES[Math.trunc(index) - 1]! : 1440;
    const units = numberArg(count);
    const rate = HOUSE_DEPOSIT_RATE.get(this.#houseId) ?? DEFAULT_DEPOSIT_RATE;
    return frameXmlAuctionDeposit(rate, item?.sellPrice ?? 0, units !== undefined ? Math.trunc(units) : sell.object.count, minutes);
  }

  /** The lots of a multisell from the carried stacks, the sell slot's stack first. */
  #plan(entry: number, first: bigint, stackSize: number, numStacks: number): { readonly guid: bigint; readonly count: number }[][] {
    const stacks = this.#context.carriedStacks(entry).map((stack) => ({ ...stack }));
    stacks.sort((left, right) => Number(right.guid === first) - Number(left.guid === first));
    const lots: { readonly guid: bigint; readonly count: number }[][] = [];
    for (let lot = 0; lot < numStacks; lot += 1) {
      const items: { guid: bigint; count: number }[] = [];
      let needed = stackSize;
      for (const stack of stacks) {
        if (needed === 0) break;
        const take = Math.min(stack.count, needed);
        if (take <= 0) continue;
        items.push({ guid: stack.guid, count: take });
        stack.count -= take;
        needed -= take;
      }
      if (needed > 0) break;
      lots.push(items);
    }
    return lots;
  }

  /**
   * `StartAuction(minBid, buyout, runTime, stackSize, numStacks)`. One lot is one
   * CMSG_AUCTION_SELL_ITEM; more than one is a multisell whose lots go one at a time, each after
   * the previous lot's result, with AUCTION_MULTISELL_START/UPDATE/FAILURE for AuctionProgressFrame.
   */
  startAuction(args: readonly unknown[]): void {
    if (this.#muted || this.#postingActive()) return;
    const sell = this.#sellItem();
    const world = this.#world();
    const startBid = copperArg(args[0]);
    const buyout = copperArg(args[1]) ?? 0;
    const runTime = numberArg(args[2]);
    if (!sell || !world || startBid === undefined || startBid < 1 || startBid > MAXIMUM_BID_PRICE) return;
    if (buyout > MAXIMUM_BID_PRICE) return;
    const minutes = runTime !== undefined && runTime >= 1 && runTime <= 3 ? RUN_TIME_MINUTES[Math.trunc(runTime) - 1]! : 1440;
    const stackSize = indexArg(args[3]) ?? sell.object.count;
    const numStacks = indexArg(args[4]) ?? 1;
    const lots = this.#plan(sell.object.entry, sell.guid, stackSize, numStacks);
    if (lots.length === 0) return;
    this.#posting = { lots, startBid, buyout, minutes, sent: 0, created: 0, sentAt: this.#now() };
    if (lots.length > 1) this.#pump?.fire("AUCTION_MULTISELL_START", lots.length);
    this.#postNext(world);
  }

  /**
   * Whether a post still waits for its result. A lot unanswered past ANSWER_TIMEOUT_S was dropped by
   * the core: the post ends as a refused one would (AUCTION_MULTISELL_FAILURE lifts the block frame).
   */
  #postingActive(): boolean {
    const posting = this.#posting;
    if (posting && this.#now() - posting.sentAt > ANSWER_TIMEOUT_S) {
      this.#posting = undefined;
      if (posting.lots.length > 1) this.#pump?.fire("AUCTION_MULTISELL_FAILURE");
    }
    return this.#posting !== undefined;
  }

  #postNext(world: FrameXmlAuctionWorld): void {
    const posting = this.#posting;
    const lot = posting?.lots[posting.sent];
    if (!posting || !lot) return;
    posting.sent += 1;
    posting.sentAt = this.#now();
    if (lot.length === 1) world.createAuction(lot[0]!.guid, lot[0]!.count, posting.startBid, posting.buyout, posting.minutes);
    else world.createAuctionFromStacks?.(lot, posting.startBid, posting.buyout, posting.minutes);
  }

  /** `CancelSell()`: AuctionProgressFrame's cancel; the lots already posted stay posted. */
  cancelSell(): void {
    const posting = this.#posting;
    if (!posting) return;
    this.#posting = undefined;
    if (posting.lots.length > 1) this.#pump?.fire("AUCTION_MULTISELL_FAILURE");
  }

  // ---- events ----------------------------------------------------------------------------

  /** A new visit's query state: nothing outstanding, the client's opening delay (0x59F062). */
  #resetQueries(): void {
    this.#awaiting.clear();
    this.#queriedAt.clear();
    this.#delayMs = INITIAL_QUERY_DELAY_MS;
  }

  #reset(fire: boolean): void {
    const hadSell = this.#sellGuid !== undefined;
    this.#shown = 0n;
    this.#lists.clear();
    this.#listQueried = false;
    this.#selected.clear();
    this.#assignSell(undefined);
    this.#tabShowing = false;
    const posting = this.#posting;
    this.#posting = undefined;
    if (fire && posting && posting.lots.length > 1) this.#pump?.fire("AUCTION_MULTISELL_FAILURE");
    if (hadSell) this.#context.locksChanged?.();
  }

  #show(world: FrameXmlAuctionWorld): void {
    const pump = this.#pump;
    if (!pump || !this.#owned || typeof world.auctioneerGuid !== "bigint" || world.auctioneerGuid === 0n
      || world.auctioneerGuid === this.#shown) return;
    this.#reset(false);
    this.#shown = world.auctioneerGuid;
    // Owner and bidder lists that already landed this visit belong to it (stock asks again anyway).
    for (const type of ["bidder", "owner"] as const) this.#adopt(type, world);
    this.#metadataSignature = this.#signature();
    pump.fire("AUCTION_HOUSE_SHOW");
  }

  #source(type: FrameXmlAuctionListType, world: FrameXmlAuctionWorld): AuctionList | undefined {
    return type === "list" ? world.auctions : type === "owner" ? world.ownAuctions : world.bidAuctions;
  }

  #adopt(type: FrameXmlAuctionListType, world: FrameXmlAuctionWorld): boolean {
    const source = this.#source(type, world);
    if (!source) return false;
    const list: ShownList = { source, receivedAt: this.#now(), rows: [] };
    list.rows = this.#sorted(type, list);
    this.#lists.set(type, list);
    this.#prefetch(world, source);
    return true;
  }

  /** Item metadata for a landed list, and the names of its sellers and bidders. */
  #prefetch(world: FrameXmlAuctionWorld, list: AuctionList): void {
    const missing: number[] = [];
    for (const entry of list.entries) {
      if (!this.#prefetched.has(entry.itemId) && this.#context.item(entry.itemId)?.requiredLevel === undefined) {
        this.#prefetched.add(entry.itemId);
        missing.push(entry.itemId);
      }
      for (const low of [entry.ownerLow, entry.bid > 0 ? entry.bidderLow : 0n]) {
        if (low === 0n || this.#namesAsked.has(low) || this.#playerName(low) !== undefined) continue;
        this.#namesAsked.add(low);
        world.requestName?.(low);
      }
    }
    if (missing.length > 0) {
      this.#context.prefetchItems?.(missing, () => { this.#metadataCheckedAt = Number.NEGATIVE_INFINITY; });
    }
  }

  /** What the shown lists and pending lines still wait for: item names and templates, player names. */
  #signature(): string {
    let items = 0;
    let names = 0;
    for (const list of this.#lists.values()) {
      for (const entry of list.source.entries) {
        const item = this.#context.item(entry.itemId);
        if (!item) items += 1;
        else if (item.requiredLevel === undefined) items += 1;
        if (this.#playerName(entry.ownerLow) === undefined) names += 1;
        if (entry.bid > 0 && this.#playerName(entry.bidderLow) === undefined) names += 1;
      }
    }
    return `${items}:${names}`;
  }

  /** Per rendered frame: repaint once item or player names arrive, and write waiting notices. */
  tick(): void {
    const pump = this.#pump;
    if (!pump) return;
    const now = pump.now();
    if (now - this.#metadataCheckedAt < 0.25) return;
    this.#metadataCheckedAt = now;
    this.#flushNotices(now);
    if (this.#shown === 0n) return;
    this.#postingActive();
    this.#watchSellItem(pump);
    const signature = this.#signature();
    if (signature === this.#metadataSignature) return;
    this.#metadataSignature = signature;
    for (const [type, list] of this.#lists) {
      list.rows = this.#sorted(type, list);
      pump.fire(LIST_EVENTS[type]);
    }
  }

  /**
   * The sell slot names an item in the bags; a stack that was split, merged or destroyed there
   * repaints the slot (NEW_AUCTION_UPDATE), and one that left the bags empties it. A multisell in
   * flight owns those changes and is left alone.
   */
  #watchSellItem(pump: FrameXmlAuctionPump): void {
    if (this.#sellGuid === undefined || this.#posting) {
      this.#sellSignature = "";
      return;
    }
    const sell = this.#sellItem();
    const signature = sell ? `${sell.object.entry}:${sell.object.count}` : "";
    if (signature === this.#sellSignature) return;
    const first = this.#sellSignature === "" && sell !== undefined;
    this.#sellSignature = signature;
    if (first) return;
    if (!sell) {
      this.#sellGuid = undefined;
      this.#context.locksChanged?.();
    }
    pump.fire("NEW_AUCTION_UPDATE");
  }

  #text(key: string): string | undefined {
    const text = this.#resolve?.(key);
    return typeof text === "string" && text.length > 0 ? text : undefined;
  }

  #error(key: string): void {
    this.#errorText(this.#text(key));
  }

  #errorText(text: string | undefined): void {
    if (text) this.#pump?.fire("UI_ERROR_MESSAGE", text);
  }

  #system(text: string | undefined): void {
    if (text) this.#pump?.fire("CHAT_MSG_SYSTEM", text, "", "", "", "", "", 0, 0, "", 0, 0, "");
  }

  #flushNotices(now: number): void {
    for (let at = 0; at < this.#notices.length;) {
      const notice = this.#notices[at]!;
      const name = this.#context.item(notice.entry)?.name
        ?? (now - notice.since > 10 ? this.#text("UNKNOWN") : undefined);
      if (name === undefined) { at += 1; continue; }
      this.#notices.splice(at, 1);
      const pattern = this.#text(notice.token);
      if (pattern) this.#system(formatOne(pattern, name));
    }
  }

  /**
   * The client prints these from its own packet handler, loaded auction add-on or not: TrinityCore
   * sends them to the player anywhere (AuctionHouseMgr.cpp), mostly away from any auctioneer. Only
   * GlobalStrings (bound when the owner is created) are needed, not the stock AuctionFrame.
   */
  #notice(token: string, entry: number): void {
    if (!this.#resolve) return;
    this.#notices.push({ token, entry, since: this.#now() });
    if (!this.#context.item(entry)) this.#context.prefetchItems?.([entry], () => { this.#metadataCheckedAt = Number.NEGATIVE_INFINITY; });
    this.#flushNotices(this.#now());
  }

  #onState(change: AuctionStateChange): void {
    const pump = this.#pump;
    const world = this.#context.world();
    if (!pump || !world) return;
    switch (change.kind) {
      case "hello":
        if (typeof change.houseId === "number") this.#houseId = change.houseId;
        if (world.auctioneerGuid !== this.#shown) this.#resetQueries();
        if (change.searched === true) this.#expect("list", "world");
        if (change.enabled === false) {
          if (this.#owned) pump.fire("AUCTION_HOUSE_DISABLED");
          return;
        }
        if (this.#owned) this.#show(world);
        else this.onOpenRequest?.();
        return;
      case "list":
      case "owner":
      case "bidder": {
        const type: FrameXmlAuctionListType = change.kind;
        const answered = this.#awaited(type).shift();
        const delay = this.#source(type, world)?.searchDelay;
        if (typeof delay === "number" && delay > 0) this.#delayMs = delay;
        // A list reaches stock only while it shows the house, and the browse list only once stock
        // searched: the world's own opening search is the native window's.
        if (this.#shown === 0n || (type === "list" && !this.#listQueried)) return;
        // The world's refresh (the previous filter) landing before the answer to stock's newer query.
        if (answered?.origin === "world" && this.#stockWaiting(type)) return;
        if (!this.#adopt(type, world)) return;
        this.#metadataSignature = this.#signature();
        pump.fire(LIST_EVENTS[type]);
        return;
      }
      case "result":
        for (const type of change.refreshed ?? []) this.#expect(type, "world");
        if (this.#shown === 0n) return;
        this.#onResult(world, pump, change);
        return;
      case "bidderNotification":
        if (typeof change.itemId === "number") this.#notice(change.won ? "ERR_AUCTION_WON_S" : "ERR_AUCTION_OUTBID_S", change.itemId);
        return;
      case "ownerNotification":
        if (typeof change.itemId === "number") this.#notice((change.bid ?? 0) > 0 ? "ERR_AUCTION_SOLD_S" : "ERR_AUCTION_EXPIRED_S", change.itemId);
        return;
      case "closed":
        this.#resetQueries();
        if (this.#shown === 0n) {
          this.#reset(false);
          return;
        }
        this.#reset(true);
        pump.fire("AUCTION_HOUSE_CLOSED");
        return;
    }
  }

  /**
   * One SMSG_AUCTION_COMMAND_RESULT while stock shows the house. A success writes the client's
   * system line (ERR_AUCTION_STARTED/REMOVED/BID_PLACED) and moves a multisell on; a refusal says
   * why in the error frame and ends a multisell (AUCTION_MULTISELL_FAILURE). The world re-requests
   * the lists after every success, so the tabs repaint from those answers.
   */
  #onResult(world: FrameXmlAuctionWorld, pump: FrameXmlAuctionPump, change: AuctionStateChange): void {
    const posting = change.command === AUCTION_SELL_ITEM ? this.#posting : undefined;
    if ((change.error ?? 0) !== 0) {
      const key = COMMAND_ERRORS[change.error!];
      if (change.error === ERR_AUCTION_INVENTORY && change.bagResult) this.#errorText(equipErrorText({ result: change.bagResult }));
      else if (key) this.#error(key);
      if (posting) {
        this.#posting = undefined;
        if (posting.lots.length > 1) pump.fire("AUCTION_MULTISELL_FAILURE");
      }
      return;
    }
    const done = COMMAND_DONE[change.command ?? -1];
    if (done) this.#system(this.#text(done));
    if (!posting) return;
    posting.created += 1;
    if (posting.lots.length > 1) pump.fire("AUCTION_MULTISELL_UPDATE", posting.created, posting.lots.length);
    if (posting.sent < posting.lots.length) {
      this.#postNext(world);
      return;
    }
    this.#posting = undefined;
    // The posted stack left the bags (or shrank): the sell slot is empty again, as in the client.
    this.#assignSell(undefined);
    pump.fire("NEW_AUCTION_UPDATE");
    this.#context.locksChanged?.();
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlAuctionHost {
  readonly auction?: FrameXmlAuctionModel | undefined;
}

export type FrameXmlAuctionBinding = (host: FrameXmlAuctionHost, args: readonly unknown[]) => readonly unknown[];

const NOTHING: readonly [] = Object.freeze([]);

function optional(value: unknown): readonly unknown[] {
  return value === undefined ? NOTHING : [value];
}

const withAuction = (answer: (auction: FrameXmlAuctionModel, args: readonly unknown[]) => readonly unknown[]): FrameXmlAuctionBinding =>
  (host, args) => host.auction ? answer(host.auction, args) : NOTHING;

const command = (run: (auction: FrameXmlAuctionModel, args: readonly unknown[]) => void): FrameXmlAuctionBinding =>
  withAuction((auction, args) => { run(auction, args); return NOTHING; });

/** GetAuctionInvTypes for one class/subclass pair: all fourteen pairs, or none (0x59C590). */
function invTypes(classArg: unknown, subclassArg: unknown): readonly unknown[] {
  const classIndex = indexArg(classArg);
  const subIndex = indexArg(subclassArg);
  const auctionClass = classIndex !== undefined ? FRAMEXML_AUCTION_CLASSES[classIndex - 1] : undefined;
  const sub = auctionClass && subIndex !== undefined ? auctionClass.subclasses[subIndex - 1] : undefined;
  if (!auctionClass || !sub || !sub.invTypes || auctionClass.id !== 4) return NOTHING;
  const ordinal = subIndex! - 1;
  const values: unknown[] = [];
  for (const row of FRAMEXML_AUCTION_INV_TYPES) {
    const shown = ordinal === 0 ? row.misc
      : ordinal === 1 ? row.invType === INVTYPE_CLOAK || !row.notArmour
        : !row.notArmour;
    values.push(row.token, shown ? 1 : undefined);
  }
  return values;
}

/**
 * The flat C API, spread into FRAMEXML_SEAM_BINDINGS. The three filter lists answer without a model
 * (they are the client's tables); everything else needs the seam's auction model.
 */
export const FRAMEXML_AUCTION_BINDINGS: Readonly<Record<string, FrameXmlAuctionBinding>> = Object.freeze({
  GetAuctionItemClasses: () => FRAMEXML_AUCTION_CLASSES.map((row) => row.name),
  GetAuctionItemSubClasses: (_host, args) => {
    const index = indexArg(args[0]);
    return (index !== undefined ? FRAMEXML_AUCTION_CLASSES[index - 1]?.subclasses ?? [] : []).map((row) => row.name);
  },
  GetAuctionInvTypes: (_host, args) => invTypes(args[0], args[1]),
  QueryAuctionItems: command((auction, args) => auction.query(args)),
  CanSendAuctionQuery: (host, args) => host.auction ? host.auction.canQuery(args[0]) : [undefined, undefined],
  GetNumAuctionItems: (host, args) => host.auction ? host.auction.numItems(args[0]) : [0, 0],
  GetAuctionItemInfo: withAuction((auction, args) => auction.itemInfo(args[0], args[1]) ?? NOTHING),
  GetAuctionItemLink: withAuction((auction, args) => optional(auction.itemLink(args[0], args[1]))),
  GetAuctionItemTimeLeft: withAuction((auction, args) => optional(auction.timeLeft(args[0], args[1]))),
  GetSelectedAuctionItem: (host, args) => [host.auction?.selected(args[0]) ?? 0],
  SetSelectedAuctionItem: command((auction, args) => auction.select(args[0], args[1])),
  SortAuctionClearSort: command((auction, args) => auction.clearSort(args[0])),
  SortAuctionSetSort: command((auction, args) => auction.setSort(args[0], args[1], args[2])),
  SortAuctionApplySort: command((auction, args) => auction.applySort(args[0])),
  SortAuctionItems: command((auction, args) => auction.sortItems(args[0], args[1])),
  GetAuctionSort: withAuction((auction, args) => auction.sort(args[0], args[1])),
  IsAuctionSortReversed: (host, args) => [host.auction?.sortReversed(args[0], args[1]) ? 1 : undefined],
  GetOwnerAuctionItems: command((auction) => auction.queryOwner()),
  GetBidderAuctionItems: command((auction) => auction.queryBidder()),
  PlaceAuctionBid: command((auction, args) => auction.placeBid(args[0], args[1], args[2])),
  CancelAuction: command((auction, args) => auction.cancel(args[0])),
  CanCancelAuction: (host, args) => [host.auction?.canCancel(args[0]) ? 1 : undefined],
  CloseAuctionHouse: command((auction) => auction.close()),
  SetAuctionsTabShowing: command((auction, args) => auction.setTabShowing(truthy(args[0]))),
  ClickAuctionSellItemButton: command((auction) => auction.clickSellItem()),
  GetAuctionSellItemInfo: (host) => host.auction ? host.auction.sellItemInfo() : EMPTY_SELL_ITEM,
  CalculateAuctionDeposit: (host, args) => [host.auction?.deposit(args[0], args[1]) ?? 0],
  GetAuctionHouseDepositRate: (host) => [host.auction?.depositRate() ?? DEFAULT_DEPOSIT_RATE],
  StartAuction: command((auction, args) => auction.startAuction(args)),
  CancelSell: command((auction) => auction.cancelSell()),
  // GameTooltip:SetAuctionSellItem's accessor (GlueWidgets): the sell slot's link.
  WebClientAuctionSellItemLink: withAuction((auction) => optional(auction.sellItemLink())),
});

/** Page size and bid ceiling, shared with the owner's probe and the tests. */
export const FRAMEXML_AUCTION_PAGE_SIZE = PAGE_SIZE;
