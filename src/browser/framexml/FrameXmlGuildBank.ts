/**
 * The stock GuildBankFrame's C API — Blizzard_GuildBankUI (load-on-demand): six tab buttons over
 * ninety-eight slots, the item and money logs, each tab's info text, buying the next tab and money
 * in and out — over this client's guild bank packets (`WorldClient.guildBank*`, GuildBankProtocol.ts).
 *
 * Facts from the active TrinityCore (GuildHandler.cpp, Guild.cpp, GuildPackets.cpp) that shape it:
 *
 * * The client keeps every tab it was sent. SMSG_GUILD_BANK_LIST carries one tab: a full list (every
 *   occupied slot) answers CMSG_GUILD_BANK_QUERY_TAB — forced full by the HACK in
 *   HandleGuildBankQueryTab, because «client doesn't query entire tab content if it had received
 *   SMSG_GUILD_BANK_LIST in this session» — and a partial one (the slots that moved, an emptied slot
 *   as item 0) goes to every member who may view the tab whenever anyone moves an item there
 *   (`_SendBankContentUpdate`). WorldClient holds one tab and replaces it with the next tab's list,
 *   so the per-tab cache is here, fed by each list as it arrived (GUILD_BANK_CHANGED `list`).
 * * The tab names and icons ride only on the full list of tab 0 (the banker's activation answer);
 *   GE_BANK_TAB_UPDATED renames one. An icon is a texture name under Interface\Icons\ on the wire.
 * * MSG_GUILD_PERMISSIONS carries the rank's rights, the bought tab count and each tab's rights byte
 *   (sign extended: full rights read -1) with its WithdrawItemLimit; every list carries the player's
 *   WithdrawalsRemaining for its tab. -1 is unlimited in both (the guild master).
 * * Money: every list carries the bank total; a deposit or withdrawal is answered only by the
 *   GE_BANK_MONEY_SET broadcast (the new total as sixteen hex digits), no list. The daily allowance
 *   (MSG_GUILD_BANK_MONEY_WITHDRAWN) is not pushed, so it is asked again after that event while the
 *   bank is open (chosen, not measured against the client).
 * * The money log is log tab 6 (`GUILD_BANK_MAX_TABS`), which stock asks for as MAX_GUILDBANK_TABS + 1.
 *   A log is in wire order — the LogHolder appends, so entry 1 is the oldest — with seconds since.
 *   Type 3 (a move) is logged in its source tab with the destination; moves inside a tab are not.
 * * GetGuildBankTabCost is TrinityCore's GetGuildBankTabPrice (100, 250, 500, 1000, 2500, 5000 gold).
 * * There is no close opcode: CloseGuildBankFrame is WorldClient.closeGuildBank.
 *
 * GUILDBANKFRAME_OPENED — the event that opens the window through UIParent — fires once the first
 * list of a banker visit has arrived (the activation answer; a player outside any guild gets an error
 * instead and no window), and only while the lazy owner has loaded and gated the add-on (`owned`).
 * Before that the native window owns the visit and `onOpenRequest` asks the owner to start the load.
 */
import type { GuildBankChange } from "../../world/EventBus.js";
import {
  GE_BANK_MONEY_SET, GE_BANK_TAB_AND_MONEY_UPDATED, GE_BANK_TAB_PURCHASED, GE_BANK_TAB_UPDATED,
  GE_BANK_TEXT_CHANGED, GE_GUILDBANKBAGSLOTS_CHANGED,
  GUILD_BANK_MAX_SLOTS, GUILD_BANK_MAX_TABS, GUILD_BANK_RIGHT_PUT_ITEM, GUILD_BANK_RIGHT_UPDATE_TEXT,
  GUILD_BANK_RIGHT_VIEW_TAB,
  type GuildBankContent, type GuildBankItem, type GuildBankLog, type GuildBankLogEntry, type GuildPermissions,
} from "../../world/GuildBankProtocol.js";
import { GR_RIGHT_WITHDRAW_GOLD } from "../ui/GuildModel.js";
import { QUALITY_LINK_COLORS } from "../ui/ChatLink.js";
import { unknownLabel } from "../ui/Format.js";

/** `GR_GUILDMASTER` (Guild.h): rank 0 holds every right, whatever its stored word says. */
const GUILD_MASTER_RANK = 0;
/** GetGuildBankTabPrice (Guild.cpp), in gold; GetGuildBankTabCost answers copper. */
const TAB_PRICES_GOLD: readonly number[] = [100, 250, 500, 1000, 2500, 5000];
const COPPER_PER_GOLD = 10000;
/** The log tab TrinityCore keeps money in (`GUILD_BANK_MAX_TABS`); stock names it tab 7. */
const MONEY_LOG_TAB = GUILD_BANK_MAX_TABS;
/** `NULL_SLOT`: a deposit with no slot named, which `BankMoveItemData::CanStore` merges and places. */
const NULL_SLOT = 255;
/** The copper one CMSG_GUILD_BANK_DEPOSIT/WITHDRAW_MONEY can carry (a u32). */
const MAX_TRANSFER = 0xffffffff;
const ICON_ROOT = "Interface\\Icons\\";
/** What the client shows for an item it has not cached yet. */
const UNKNOWN_ITEM_ICON = "Interface\\Icons\\INV_Misc_QuestionMark";
/** How often (pump seconds) a log waiting for player names looks again. */
const NAME_RETRY_S = 0.25;
/** GetGuildTabardFileNames's six paths (the tabard vendor's GuildEmblems files, upper and lower halves). */
const EMBLEM_ROOT = "Textures\\GuildEmblems\\";

/** GetGuildBankTransaction's type words by `GuildBankEventLogTypes` (Guild.h) — stock formats these. */
const ITEM_LOG_TYPES: Readonly<Record<number, string>> = { 1: "deposit", 2: "withdraw", 3: "move", 7: "move" };
/** GetGuildBankMoneyTransaction's: 8 is TrinityCore's GUILD_BANK_LOG_UNK1, stock's «withdrawForTab». */
const MONEY_LOG_TYPES: Readonly<Record<number, string>> = {
  4: "deposit", 5: "withdraw", 6: "repair", 8: "withdrawForTab", 9: "buyTab",
};

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlGuildBankWorld {
  readonly events?: {
    on(name: "GUILD_BANK_CHANGED", listener: (change: GuildBankChange) => void): () => void;
  } | undefined;
  /** The chest or banker the player stands at; 0n while no bank is open. */
  readonly guildBankerGuid: bigint;
  readonly guildBank: GuildBankContent | undefined;
  readonly guildBankLog: GuildBankLog | undefined;
  readonly guildPermissions: GuildPermissions | undefined;
  readonly guildBankWithdrawRemaining: number | undefined;
  readonly guildBankTabText: ReadonlyMap<number, string>;
  readonly guildQuery?: {
    readonly emblemStyle: number; readonly emblemColor: number; readonly borderStyle: number;
    readonly borderColor: number; readonly backgroundColor: number;
  } | undefined;
  displayName?(guid: bigint): string;
  requestName?(guid: bigint): void;
  queryGuildBankTab(tabId: number): void;
  requestGuildBankText(tabId: number): void;
  requestGuildBankLog(tabId: number): void;
  requestGuildBankMoneyWithdrawn?(): void;
  setGuildBankText(tabId: number, text: string): void;
  closeGuildBank(): void;
  buyGuildBankTab(tabId: number): void;
  renameGuildBankTab(tabId: number, name: string, icon: string): void;
  depositGuildBankMoney(copper: number): void;
  withdrawGuildBankMoney(copper: number): void;
  withdrawGuildBankItem(tabId: number, slotId: number, itemId: number): void;
  withdrawGuildBankItemTo(tabId: number, slotId: number, itemId: number, bag: number, bagSlot: number, split?: number): void;
  depositGuildBankItem(tabId: number, slotId: number, itemId: number, bag: number, bagSlot: number, split?: number): void;
  moveGuildBankItem(fromTab: number, fromSlot: number, fromItemId: number,
    toTab: number, toSlot: number, toItemId: number, split?: number): void;
}

/** Cache-only item facts: a C-API read never starts a fetch. */
export interface FrameXmlGuildBankItemFacts {
  readonly name: string;
  readonly texture?: string | undefined;
  readonly quality?: number | undefined;
}

/** A carried bag item by its wire position (`CMSG_GUILD_BANK_SWAP_ITEMS` names bag and slot). */
export interface FrameXmlGuildBankBagItem {
  readonly entry: number;
  readonly bag: number;
  readonly slot: number;
}

/** What the model asks its host (LiveWorldSeam or the canned seam) besides the world. */
export interface FrameXmlGuildBankContext {
  world(): FrameXmlGuildBankWorld | undefined;
  item(entry: number): FrameXmlGuildBankItemFacts | undefined;
  playerLevel(): number;
  /** The bag item on the shared item cursor, if any: what a click on a vault slot deposits. */
  cursorItem(): FrameXmlGuildBankBagItem | undefined;
  /** Drop whatever else is on the shared cursor (the bag item, a macro): one thing at a time. */
  clearCursor(): void;
  /** The vault item on the cursor was picked up or let go (the page's cursor class). */
  cursorChanged?(held: boolean): void;
  /** Load item metadata outside a C-API read; `onChanged` runs once the cache moved. */
  prefetchItems?(entries: readonly number[], onChanged: () => void): void;
  /** GetMacroItemIconInfo(index): the icon picker's texture (SetGuildBankTabInfo's third argument). */
  macroItemIcon?(index: number): string | undefined;
}

interface FrameXmlGuildBankPump {
  fire(event: string, ...args: readonly unknown[]): number;
  now(): number;
}

interface TabInfo {
  name: string;
  icon: string;
}

/** A vault item held on the cursor: 1-based tab and slot as stock names them, and a split count. */
interface HeldItem {
  readonly tab: number;
  readonly slot: number;
  readonly itemId: number;
  /** 0 is the whole stack (SplitGuildBankItem sets the rest). */
  readonly split: number;
}

const NOTHING: readonly [] = Object.freeze([]);

function numberArg(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function indexArg(value: unknown): number | undefined {
  const number = numberArg(value);
  return number !== undefined && Number.isInteger(number) && number >= 1 ? number : undefined;
}

/** Rights arrive sign extended: full rights are 0xFF read as -1, so only the low byte counts. */
function hasRight(rights: number | undefined, right: number): boolean {
  return rights !== undefined && ((rights & 0xff) & right) === right;
}

/** `GetGuildBankTransaction`'s time: years, months, days and hours since, as RecentTimeDate reads them. */
function since(secondsAgo: number): readonly [number, number, number, number] {
  let seconds = Math.max(0, secondsAgo);
  const hour = 3600;
  const day = 24 * hour;
  const years = Math.floor(seconds / (365 * day));
  seconds -= years * 365 * day;
  const months = Math.floor(seconds / (30 * day));
  seconds -= months * 30 * day;
  const days = Math.floor(seconds / day);
  seconds -= days * day;
  return [years, months, days, Math.floor(seconds / hour)];
}

/** The texture a wire icon names; a path already rooted is kept (a core that sends one). */
function iconPath(icon: string): string | undefined {
  if (!icon) return undefined;
  return /[\\/]/.test(icon) ? icon : `${ICON_ROOT}${icon}`;
}

/** The wire form of a picked icon: its name under Interface\Icons\. */
function iconName(path: string): string {
  return path.toLowerCase().startsWith(ICON_ROOT.toLowerCase()) ? path.slice(ICON_ROOT.length) : path;
}

/**
 * One owner of the stock guild bank C API. Client-held state — the selected tab, the per-tab item
 * cache, the logs by tab and a vault item on the cursor — lives here as the client keeps it.
 */
export class FrameXmlGuildBankModel {
  readonly #context: FrameXmlGuildBankContext;
  #pump: FrameXmlGuildBankPump | undefined;
  #unsubscribe: (() => void) | undefined;
  #owned = false;
  #muted = false;
  /** The banker of the visit the model has seen begin; 0n while no bank is open. */
  #visit = 0n;
  /** Whether this visit's first list (the activation answer) has arrived. */
  #listed = false;
  /** The banker stock was sent GUILDBANKFRAME_OPENED for; 0n while the stock window has none. */
  #opened = 0n;
  #currentTab = 1;
  readonly #tabs: TabInfo[] = [];
  /** Slots by 0-based tab, as the lists put them: `SLOTS_PER_GUILD_BANK_TAB` keys at most. */
  readonly #items = new Map<number, Map<number, GuildBankItem>>();
  /** Each tab's WithdrawalsRemaining from its latest list. */
  readonly #remaining = new Map<number, number>();
  #money: number | undefined;
  readonly #logs = new Map<number, GuildBankLog>();
  /** Each log's entries of the kinds stock formats, filtered once per packet. */
  readonly #shownEntries = new WeakMap<GuildBankLog, readonly GuildBankLogEntry[]>();
  #seenLog: GuildBankLog | undefined;
  #seenPermissions: GuildPermissions | undefined;
  #seenWithdrawn: number | undefined;
  #held: HeldItem | undefined;
  readonly #prefetched = new Set<number>();
  /** Log players with no name yet; the log repaints once they resolve. */
  readonly #pendingNames = new Set<bigint>();
  #namesCheckedAt = Number.NEGATIVE_INFINITY;
  /** Set by the lazy owner: the first bank of a session starts the add-on load. */
  onOpenRequest: (() => void) | undefined;

  constructor(context: FrameXmlGuildBankContext) {
    this.#context = context;
  }

  // ---- lifecycle -------------------------------------------------------------------------

  attach(pump: FrameXmlGuildBankPump): void {
    this.detach();
    this.#pump = pump;
    const world = this.#context.world();
    if (world?.events && typeof world.events.on === "function") {
      this.#unsubscribe = world.events.on("GUILD_BANK_CHANGED", (change) => this.#onChange(change));
    }
    this.#visit = this.#bankerGuid();
    // A reattach (a /reload) keeps the session's caches; what the world holds now seeds them.
    if (world?.guildBank) this.#fold(world.guildBank);
    this.#seenLog = world?.guildBankLog;
    if (world?.guildBankLog) this.#logs.set(world.guildBankLog.tabId, world.guildBankLog);
    this.#seenPermissions = world?.guildPermissions;
    this.#seenWithdrawn = world?.guildBankWithdrawRemaining;
    // A bank already open was answered before this attach.
    this.#listed = this.#visit !== 0n && world?.guildBank !== undefined;
    this.#opened = 0n;
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#releaseHeld(false);
    this.#pump = undefined;
    this.#owned = false;
    this.#opened = 0n;
    this.#pendingNames.clear();
  }

  /**
   * Whether the stock GuildBankFrame owns the guild bank (set by the lazy owner once
   * Blizzard_GuildBankUI is loaded and gated). Taking ownership is an edge: a bank already open and
   * answered is handed to stock with GUILDBANKFRAME_OPENED, because the server sends nothing again.
   */
  get owned(): boolean { return this.#owned; }
  set owned(owned: boolean) {
    if (owned === this.#owned) return;
    this.#owned = owned;
    if (!owned) {
      this.#releaseHeld(true);
      this.#opened = 0n;
      return;
    }
    this.#syncVisit();
    this.#show();
  }

  /** Whether stock was sent GUILDBANKFRAME_OPENED for the bank open now. */
  get showing(): boolean { return this.#opened !== 0n; }

  /** Whether the player stands at a guild bank (the world's banker), whoever shows it. */
  bankOpen(): boolean { return this.#bankerGuid() !== 0n; }

  /** Run a transactional probe (the owner's gate) without sending a packet or closing the bank. */
  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  #bankerGuid(): bigint {
    const guid = this.#context.world()?.guildBankerGuid;
    return typeof guid === "bigint" ? guid : 0n;
  }

  /** The world, only while a bank is open: every command names the banker. */
  #bank(): FrameXmlGuildBankWorld | undefined {
    const world = this.#context.world();
    return world && typeof world.guildBankerGuid === "bigint" && world.guildBankerGuid !== 0n ? world : undefined;
  }

  #command(run: (world: FrameXmlGuildBankWorld) => void): void {
    if (this.#muted) return;
    const world = this.#bank();
    if (world) run(world);
  }

  /** The per-frame edge: a bank opened or closed by the native window, a relog, or walking off. */
  tick(): void {
    const pump = this.#pump;
    if (!pump) return;
    this.#syncVisit();
    if (this.#pendingNames.size > 0 && this.#opened !== 0n) {
      const now = pump.now();
      if (now - this.#namesCheckedAt >= NAME_RETRY_S) {
        this.#namesCheckedAt = now;
        this.#checkNames(pump);
      }
    }
  }

  #syncVisit(): void {
    const guid = this.#bankerGuid();
    if (guid === this.#visit) return;
    const previous = this.#visit;
    this.#visit = guid;
    this.#listed = false;
    if (previous !== 0n) this.#endVisit();
    if (guid !== 0n && !this.#owned) this.onOpenRequest?.();
  }

  #endVisit(): void {
    this.#releaseHeld(true);
    this.#pendingNames.clear();
    if (this.#opened === 0n) return;
    this.#opened = 0n;
    this.#pump?.fire("GUILDBANKFRAME_CLOSED");
  }

  #show(): void {
    const pump = this.#pump;
    if (!pump || !this.#owned || this.#visit === 0n || !this.#listed || this.#opened === this.#visit) return;
    this.#opened = this.#visit;
    // Tabs cached from broadcasts while no bank was open were not prefetched (#fold): stock shows them
    // from the cache as soon as their tab button is clicked, before the query's full list answers.
    const entries: number[] = [];
    for (const slots of this.#items.values()) for (const item of slots.values()) entries.push(item.itemId);
    this.#prefetch(entries, "GUILDBANKBAGSLOTS_CHANGED");
    pump.fire("GUILDBANKFRAME_OPENED");
  }

  // ---- packets ---------------------------------------------------------------------------

  #onChange(change: GuildBankChange): void {
    const pump = this.#pump;
    const world = this.#context.world();
    if (!pump || !world) return;
    this.#syncVisit();
    if (change.list) {
      const moneyBefore = this.#money;
      const tabsChanged = this.#fold(change.list);
      pump.fire("GUILDBANKBAGSLOTS_CHANGED");
      if (tabsChanged) pump.fire("GUILDBANK_UPDATE_TABS");
      if (this.#money !== moneyBefore) pump.fire("GUILDBANK_UPDATE_MONEY");
      if (this.#visit !== 0n && !this.#listed) {
        this.#listed = true;
        this.#show();
      }
    }
    // TrinityCore answers every save with a guild-wide MSG_QUERY_GUILD_BANK_TEXT (SendText(this, nullptr)),
    // never GE_BANK_TEXT_CHANGED, and stock's GuildBankFrame_UpdateTabInfo fills the Info box from the
    // event's tab without comparing it with the shown one; the next Save would write that text into the
    // shown tab. So only the shown tab's text is announced: another tab's (a guildmate's save, a late
    // answer after a quick tab switch) stays in the world's cache, which stock asks again on its click.
    if (typeof change.textTab === "number" && change.textTab + 1 === this.#currentTab) {
      pump.fire("GUILDBANK_UPDATE_TEXT", this.#currentTab);
    }
    if (change.guildEvent) this.#onGuildEvent(change.guildEvent, pump);
    if (world.guildBankLog !== this.#seenLog) {
      this.#seenLog = world.guildBankLog;
      if (world.guildBankLog) {
        this.#logs.set(world.guildBankLog.tabId, world.guildBankLog);
        this.#prefetch(world.guildBankLog.entries.map((entry) => entry.itemId), "GUILDBANKLOG_UPDATE");
      }
      this.#pendingNames.clear();
      pump.fire("GUILDBANKLOG_UPDATE");
    }
    if (world.guildPermissions !== this.#seenPermissions) {
      this.#seenPermissions = world.guildPermissions;
      pump.fire("GUILDBANK_UPDATE_TABS");
    }
    if (world.guildBankWithdrawRemaining !== this.#seenWithdrawn) {
      this.#seenWithdrawn = world.guildBankWithdrawRemaining;
      pump.fire("GUILDBANK_UPDATE_WITHDRAWMONEY");
    }
  }

  /** One SMSG_GUILD_BANK_LIST into the per-tab cache; true when it carried the tab list. */
  #fold(list: GuildBankContent): boolean {
    this.#money = Number(list.money);
    const tabId = list.tabId;
    if (tabId < GUILD_BANK_MAX_TABS) this.#remaining.set(tabId, list.withdrawalsRemaining);
    let slots = this.#items.get(tabId);
    if (list.fullUpdate || !slots) {
      slots = new Map();
      this.#items.set(tabId, slots);
    }
    for (const item of list.items) {
      if (item.itemId === 0) slots.delete(item.slot);
      else slots.set(item.slot, item);
    }
    // A vault item on the cursor whose slot another member emptied or refilled is let go.
    const held = this.#held;
    if (held && held.tab - 1 === tabId && slots.get(held.slot - 1)?.itemId !== held.itemId) this.#releaseHeld(true);
    // TrinityCore broadcasts a partial list to every member who may view the tab whenever anyone moves
    // an item (_SendBankContentUpdate), at a vault or not: only an open bank asks for item facts, and
    // the OPENED edge asks for what was cached before it (#show).
    if (this.#visit !== 0n) this.#prefetch(list.items.map((item) => item.itemId), "GUILDBANKBAGSLOTS_CHANGED");
    if (tabId !== 0 || !list.fullUpdate) return false;
    this.#tabs.length = 0;
    for (const tab of list.tabs) this.#tabs.push({ name: tab.name, icon: tab.icon });
    return true;
  }

  #onGuildEvent(event: NonNullable<GuildBankChange["guildEvent"]>, pump: FrameXmlGuildBankPump): void {
    switch (event.type) {
      case GE_BANK_MONEY_SET: {
        const hex = event.params[0] ?? "";
        if (/^[0-9a-f]{1,16}$/i.test(hex)) {
          this.#money = Number(BigInt(`0x${hex}`));
          pump.fire("GUILDBANK_UPDATE_MONEY");
        }
        // The allowance moved with it (for the player who withdrew); TrinityCore does not push it.
        // Only for stock's display: the native window reads the rank's daily gold instead.
        if (this.#visit !== 0n && this.#owned && !this.#muted) this.#context.world()?.requestGuildBankMoneyWithdrawn?.();
        return;
      }
      case GE_BANK_TAB_UPDATED: {
        const tabId = numberArg(event.params[0]);
        if (tabId !== undefined && Number.isInteger(tabId) && tabId >= 0 && tabId < GUILD_BANK_MAX_TABS) {
          while (this.#tabs.length <= tabId) this.#tabs.push({ name: "", icon: "" });
          this.#tabs[tabId] = { name: event.params[1] ?? "", icon: event.params[2] ?? "" };
        }
        pump.fire("GUILDBANK_UPDATE_TABS");
        return;
      }
      case GE_BANK_TAB_PURCHASED:
        // TrinityCore then sends the buyer MSG_GUILD_PERMISSIONS with the new count.
        pump.fire("GUILDBANK_UPDATE_TABS");
        return;
      case GE_BANK_TAB_AND_MONEY_UPDATED:
        // The daily reset: the allowances start over.
        if (this.#visit !== 0n && this.#owned && !this.#muted) this.#context.world()?.requestGuildBankMoneyWithdrawn?.();
        pump.fire("GUILDBANK_UPDATE_TABS");
        return;
      case GE_BANK_TEXT_CHANGED: {
        const tabId = numberArg(event.params[0]);
        if (tabId !== undefined && Number.isInteger(tabId)) pump.fire("GUILDBANK_TEXT_CHANGED", tabId + 1);
        return;
      }
      case GE_GUILDBANKBAGSLOTS_CHANGED:
        // Guild.h: «all players with bank open will send tab query».
        if (this.#visit !== 0n && this.#owned) this.#command((world) => world.queryGuildBankTab(this.#currentTab - 1));
        return;
      default:
    }
  }

  /** Ask for item names and icons not cached yet, outside any C-API read; repaint once they land. */
  #prefetch(entries: readonly number[], event: string): void {
    const prefetch = this.#context.prefetchItems;
    if (!prefetch) return;
    const wanted: number[] = [];
    for (const entry of entries) {
      if (entry <= 0 || this.#prefetched.has(entry) || this.#context.item(entry)?.texture) continue;
      this.#prefetched.add(entry);
      wanted.push(entry);
    }
    if (wanted.length > 0) prefetch(wanted, () => { this.#pump?.fire(event); });
  }

  #checkNames(pump: FrameXmlGuildBankPump): void {
    const world = this.#context.world();
    for (const guid of this.#pendingNames) {
      if (this.#nameOf(world, guid, false) === undefined) return;
    }
    this.#pendingNames.clear();
    pump.fire("GUILDBANKLOG_UPDATE");
  }

  #nameOf(world: FrameXmlGuildBankWorld | undefined, guid: bigint, remember: boolean): string | undefined {
    if (guid === 0n) return undefined;
    const name = world?.displayName?.(guid);
    if (!name || name.startsWith("0x")) {
      if (remember && !this.#pendingNames.has(guid)) {
        this.#pendingNames.add(guid);
        world?.requestName?.(guid);
      }
      return undefined;
    }
    return name;
  }

  // ---- tabs ------------------------------------------------------------------------------

  /** `GetNumGuildBankTabs()`: tabs the guild bought (MSG_GUILD_PERMISSIONS), else the tab list's size. */
  numTabs(): number {
    const world = this.#context.world();
    return Math.min(GUILD_BANK_MAX_TABS, world?.guildPermissions?.purchasedTabs ?? this.#tabs.length);
  }

  #tabRights(tab: number): number | undefined {
    return this.#context.world()?.guildPermissions?.tabs[tab - 1]?.rights;
  }

  #isMaster(): boolean {
    return this.#context.world()?.guildPermissions?.rankId === GUILD_MASTER_RANK;
  }

  /**
   * `GetGuildBankTabInfo(tab)`: name, icon, isViewable, canDeposit, numWithdrawals (the
   * permissions' WithdrawItemLimit) and remainingWithdrawals (the tab's latest list, else the same
   * limit). A tab the guild has not bought answers nothing.
   */
  tabInfo(tabArg: unknown): readonly unknown[] {
    const tab = indexArg(tabArg);
    if (tab === undefined || tab > this.numTabs()) return NOTHING;
    const info = this.#tabs[tab - 1];
    const permission = this.#context.world()?.guildPermissions?.tabs[tab - 1];
    const rights = permission?.rights;
    const limit = permission?.slotsRemaining ?? 0;
    return [info?.name ?? "", iconPath(info?.icon ?? ""), hasRight(rights, GUILD_BANK_RIGHT_VIEW_TAB),
      hasRight(rights, GUILD_BANK_RIGHT_PUT_ITEM), limit, this.#remaining.get(tab - 1) ?? limit];
  }

  currentTab(): number { return this.#currentTab; }

  /** `SetCurrentGuildBankTab(tab)`: 1 to the tab after the last bought one (stock's buy tab). */
  setCurrentTab(tabArg: unknown): void {
    const tab = indexArg(tabArg);
    if (tab !== undefined && tab <= GUILD_BANK_MAX_TABS) this.#currentTab = tab;
  }

  queryTab(tabArg: unknown): void {
    const tab = indexArg(tabArg);
    if (tab !== undefined && tab <= this.numTabs()) this.#command((world) => world.queryGuildBankTab(tab - 1));
  }

  /** `CanEditGuildTabInfo(tab)`: the tab's update-text right, or the guild master's. */
  canEditTabInfo(tabArg: unknown): boolean {
    const tab = indexArg(tabArg);
    return tab !== undefined && tab <= this.numTabs()
      && (this.#isMaster() || hasRight(this.#tabRights(tab), GUILD_BANK_RIGHT_UPDATE_TEXT));
  }

  /** `GetGuildBankTabCost()`: the next tab's price in copper; nothing once all six are bought. */
  tabCost(): number | undefined {
    const next = this.numTabs();
    const gold = TAB_PRICES_GOLD[next];
    return gold === undefined ? undefined : gold * COPPER_PER_GOLD;
  }

  /** `BuyGuildBankTab()`: the next tab; the price comes out of the player's own money. */
  buyTab(): void {
    const next = this.numTabs();
    if (next < GUILD_BANK_MAX_TABS) this.#command((world) => world.buyGuildBankTab(next));
  }

  /** `SetGuildBankTabInfo(tab, name, iconIndex)`: the icon picker's index names a macro item icon. */
  setTabInfo(tabArg: unknown, nameArg: unknown, iconArg: unknown): void {
    const tab = indexArg(tabArg);
    if (tab === undefined || tab > this.numTabs()) return;
    const name = typeof nameArg === "string" ? nameArg.trim() : "";
    const index = indexArg(iconArg);
    const picked = index !== undefined ? this.#context.macroItemIcon?.(index) : undefined;
    const icon = picked ? iconName(picked) : this.#tabs[tab - 1]?.icon ?? "";
    // HandleGuildBankUpdateTab ignores an empty name or icon, so neither is sent.
    if (!name || !icon) return;
    this.#command((world) => world.renameGuildBankTab(tab - 1, name, icon));
  }

  // ---- slots and the cursor ----------------------------------------------------------------

  #itemAt(tab: number, slot: number): GuildBankItem | undefined {
    return this.#items.get(tab - 1)?.get(slot - 1);
  }

  #slotArgs(tabArg: unknown, slotArg: unknown): readonly [tab: number, slot: number] | undefined {
    const tab = indexArg(tabArg);
    const slot = indexArg(slotArg);
    return tab !== undefined && slot !== undefined && tab <= GUILD_BANK_MAX_TABS && slot <= GUILD_BANK_MAX_SLOTS
      ? [tab, slot] : undefined;
  }

  /** `GetGuildBankItemInfo(tab, slot)`: texture, count, locked (on the cursor). */
  itemInfo(tabArg: unknown, slotArg: unknown): readonly unknown[] {
    const at = this.#slotArgs(tabArg, slotArg);
    const item = at ? this.#itemAt(at[0], at[1]) : undefined;
    if (!at || !item) return NOTHING;
    const held = this.#held;
    const locked = held !== undefined && held.tab === at[0] && held.slot === at[1];
    return [this.#context.item(item.itemId)?.texture ?? UNKNOWN_ITEM_ICON, item.count, locked ? 1 : undefined];
  }

  /**
   * `GetGuildBankItemLink(tab, slot)`: the stack's own link — its permanent enchant, the gems in its
   * sockets (the three socket enchantments, as the client's links carry them), random property and
   * suffix factor, and the player's level — once its name is cached.
   */
  itemLink(tabArg: unknown, slotArg: unknown): string | undefined {
    const at = this.#slotArgs(tabArg, slotArg);
    const item = at ? this.#itemAt(at[0], at[1]) : undefined;
    return item ? this.#link(item) : undefined;
  }

  #link(item: GuildBankItem): string | undefined {
    const facts = this.#context.item(item.itemId);
    if (!facts?.name) return undefined;
    const gems = [0, 0, 0];
    for (const socket of item.sockets) if (socket.index >= 0 && socket.index < 3) gems[socket.index] = socket.enchantId;
    const color = QUALITY_LINK_COLORS[facts.quality ?? 1] ?? QUALITY_LINK_COLORS[1];
    return `|c${color}|Hitem:${item.itemId}:${item.enchantId}:${gems[0]}:${gems[1]}:${gems[2]}:0:${item.randomPropertyId}:${item.suffixFactor}:${this.#context.playerLevel()}|h[${facts.name}]|h|r`;
  }

  /** A log's item by entry alone: the log names no enchant, so the plain link. */
  #entryLink(entry: number): string {
    const facts = this.#context.item(entry);
    const color = QUALITY_LINK_COLORS[facts?.quality ?? 1] ?? QUALITY_LINK_COLORS[1];
    return `|c${color}|Hitem:${entry}:0:0:0:0:0:0:0:${this.#context.playerLevel()}|h[${facts?.name || unknownLabel("предмет", entry)}]|h|r`;
  }

  #hold(next: HeldItem | undefined): void {
    const pump = this.#pump;
    if (next) this.#context.clearCursor();
    this.#held = next;
    this.#context.cursorChanged?.(next !== undefined);
    pump?.fire("GUILDBANK_ITEM_LOCK_CHANGED");
    pump?.fire("CURSOR_UPDATE");
  }

  #releaseHeld(fire: boolean): void {
    if (!this.#held) return;
    if (fire) {
      this.#hold(undefined);
      return;
    }
    this.#held = undefined;
    this.#context.cursorChanged?.(false);
  }

  /**
   * `PickupGuildBankItem(tab, slot)`, stock's left click and drag: with nothing held the stack goes
   * on the cursor (its slot locks); a held vault stack moves onto this slot (CMSG_GUILD_BANK_SWAP_ITEMS
   * BankOnly — the core swaps with what is there); a bag item on the cursor is deposited into it.
   */
  pickupItem(tabArg: unknown, slotArg: unknown): void {
    const at = this.#slotArgs(tabArg, slotArg);
    if (!at || this.#muted || !this.#bank()) return;
    const [tab, slot] = at;
    const held = this.#held;
    if (held) {
      if (held.tab !== tab || held.slot !== slot) {
        const target = this.#itemAt(tab, slot);
        this.#command((world) => world.moveGuildBankItem(held.tab - 1, held.slot - 1, held.itemId,
          tab - 1, slot - 1, target?.itemId ?? 0, held.split));
      }
      this.#hold(undefined);
      return;
    }
    const carried = this.#context.cursorItem();
    if (carried) {
      this.#command((world) => world.depositGuildBankItem(tab - 1, slot - 1, carried.entry, carried.bag, carried.slot, 0));
      this.#context.clearCursor();
      return;
    }
    const item = this.#itemAt(tab, slot);
    if (item) this.#hold({ tab, slot, itemId: item.itemId, split: 0 });
  }

  /** `SplitGuildBankItem(tab, slot, count)`: StackSplitFrame's amount goes on the cursor. */
  splitItem(tabArg: unknown, slotArg: unknown, countArg: unknown): void {
    const at = this.#slotArgs(tabArg, slotArg);
    const count = indexArg(countArg);
    if (!at || count === undefined || this.#muted || !this.#bank()) return;
    const item = this.#itemAt(at[0], at[1]);
    if (!item) return;
    this.#hold({ tab: at[0], slot: at[1], itemId: item.itemId, split: count < item.count ? count : 0 });
  }

  /** `AutoStoreGuildBankItem(tab, slot)`, the right click: the core finds the bag slot. */
  autoStoreItem(tabArg: unknown, slotArg: unknown): void {
    const at = this.#slotArgs(tabArg, slotArg);
    const item = at ? this.#itemAt(at[0], at[1]) : undefined;
    if (!at || !item) return;
    const held = this.#held;
    if (held && held.tab === at[0] && held.slot === at[1]) this.#hold(undefined);
    this.#command((world) => world.withdrawGuildBankItem(at[0] - 1, at[1] - 1, item.itemId));
  }

  cursorHasItem(): boolean { return this.#held !== undefined; }

  /** `GetCursorInfo()` while a vault stack is held: "item", its entry and link. */
  cursorInfo(): readonly unknown[] | undefined {
    const held = this.#held;
    if (!held) return undefined;
    const item = this.#itemAt(held.tab, held.slot);
    const link = item ? this.#link(item) : undefined;
    return link ? ["item", held.itemId, link] : ["item", held.itemId];
  }

  /** `ClearCursor()` and every other «let go»: the held stack returns to its slot. */
  clearCursor(): void {
    this.#releaseHeld(true);
  }

  /**
   * Stock PickupContainerItem on a bag slot while a vault stack is held: it goes into exactly that
   * slot. False leaves the bag click to the bag cursor.
   */
  dropOnBagSlot(target: { readonly bag: number; readonly slot: number }): boolean {
    const held = this.#held;
    if (!held) return false;
    this.#command((world) => world.withdrawGuildBankItemTo(held.tab - 1, held.slot - 1, held.itemId,
      target.bag, target.slot, held.split));
    this.#hold(undefined);
    return true;
  }

  /**
   * A right-clicked bag item while stock shows the bank goes into the tab shown. No slot is named
   * (NULL_SLOT): the core merges it into a stack of its kind or the first free slot. False leaves
   * the click to the bags.
   */
  useItem(item: FrameXmlGuildBankBagItem): boolean {
    if (!this.#owned || this.#opened === 0n || this.#muted) return false;
    const tab = this.#currentTab;
    if (tab > this.numTabs()) return false;
    this.#command((world) => world.depositGuildBankItem(tab - 1, NULL_SLOT, item.entry, item.bag, item.slot, 0));
    return true;
  }

  // ---- money -----------------------------------------------------------------------------

  money(): number { return this.#money ?? 0; }

  /** `GetGuildBankWithdrawMoney()`: copper left today; -1 is unlimited (the guild master). */
  withdrawAllowance(): number { return this.#context.world()?.guildBankWithdrawRemaining ?? 0; }

  /** `CanWithdrawGuildBankMoney()`: the rank's GR_RIGHT_WITHDRAW_GOLD, or the guild master's. */
  canWithdrawMoney(): boolean {
    const permissions = this.#context.world()?.guildPermissions;
    return permissions !== undefined
      && (permissions.rankId === GUILD_MASTER_RANK || (permissions.rights & GR_RIGHT_WITHDRAW_GOLD) !== 0);
  }

  #copper(value: unknown): number | undefined {
    const copper = numberArg(value);
    return copper !== undefined && copper >= 1 ? Math.min(MAX_TRANSFER, Math.floor(copper)) : undefined;
  }

  depositMoney(value: unknown): void {
    const copper = this.#copper(value);
    if (copper !== undefined) this.#command((world) => world.depositGuildBankMoney(copper));
  }

  withdrawMoney(value: unknown): void {
    const copper = this.#copper(value);
    if (copper !== undefined) this.#command((world) => world.withdrawGuildBankMoney(copper));
  }

  // ---- text ------------------------------------------------------------------------------

  text(tabArg: unknown): string | undefined {
    const tab = indexArg(tabArg);
    return tab !== undefined ? this.#context.world()?.guildBankTabText.get(tab - 1) : undefined;
  }

  queryText(tabArg: unknown): void {
    const tab = indexArg(tabArg);
    if (tab !== undefined && tab <= this.numTabs()) this.#command((world) => world.requestGuildBankText(tab - 1));
  }

  /**
   * `SetGuildBankText(tab, text)`. TrinityCore checks no right (HandleGuildBankSetTabText →
   * Guild::SetBankTabText) and stock's Info OnHide clicks GuildBankInfoSaveButton even while it is
   * hidden, so the tab's update-text right — or the guild master's — is checked here. A text equal to
   * what the server last said for the tab (empty while it has said nothing) is not sent: stock compares
   * with `GuildBankTabInfoEditBox.text`, which is nil until the text answer arrives, so leaving Info
   * before it would otherwise store "" for the whole guild.
   */
  setText(tabArg: unknown, textArg: unknown): void {
    const tab = indexArg(tabArg);
    if (tab === undefined || typeof textArg !== "string" || !this.canEditTabInfo(tab)) return;
    // String<500, NoHyperlinks>: a longer or linked text is dropped by the core.
    const text = [...textArg].slice(0, 500).join("");
    if (text === (this.#context.world()?.guildBankTabText.get(tab - 1) ?? "")) return;
    this.#command((world) => world.setGuildBankText(tab - 1, text));
  }

  // ---- logs ------------------------------------------------------------------------------

  /** `QueryGuildBankLog(tab)`: 1-6 a tab's item log, MAX_GUILDBANK_TABS + 1 the money log. */
  queryLog(tabArg: unknown): void {
    const tab = indexArg(tabArg);
    if (tab !== undefined && tab <= MONEY_LOG_TAB + 1) this.#command((world) => world.requestGuildBankLog(tab - 1));
  }

  #entries(tabId: number, types: Readonly<Record<number, string>>): readonly GuildBankLogEntry[] {
    const log = this.#logs.get(tabId);
    if (!log) return NOTHING;
    let entries = this.#shownEntries.get(log);
    if (!entries) {
      entries = log.entries.filter((entry) => types[entry.type] !== undefined);
      this.#shownEntries.set(log, entries);
    }
    return entries;
  }

  numTransactions(tabArg: unknown): number {
    const tab = indexArg(tabArg);
    return tab !== undefined && tab <= GUILD_BANK_MAX_TABS ? this.#entries(tab - 1, ITEM_LOG_TYPES).length : 0;
  }

  /** `GetGuildBankTransaction(tab, i)`: type, name, itemLink, count, tab1, tab2, then the time since. */
  transaction(tabArg: unknown, indexValue: unknown): readonly unknown[] {
    const tab = indexArg(tabArg);
    const index = indexArg(indexValue);
    if (tab === undefined || index === undefined || tab > GUILD_BANK_MAX_TABS) return NOTHING;
    const entry = this.#entries(tab - 1, ITEM_LOG_TYPES)[index - 1];
    if (!entry) return NOTHING;
    const type = ITEM_LOG_TYPES[entry.type]!;
    const moved = type === "move";
    return [type, this.#nameOf(this.#context.world(), entry.playerGuid, true), this.#entryLink(entry.itemId),
      entry.itemCount, moved ? tab : undefined, moved ? entry.destinationTab + 1 : undefined, ...since(entry.secondsAgo)];
  }

  numMoneyTransactions(): number { return this.#entries(MONEY_LOG_TAB, MONEY_LOG_TYPES).length; }

  /** `GetGuildBankMoneyTransaction(i)`: type, name, amount, then the time since. */
  moneyTransaction(indexValue: unknown): readonly unknown[] {
    const index = indexArg(indexValue);
    const entry = index !== undefined ? this.#entries(MONEY_LOG_TAB, MONEY_LOG_TYPES)[index - 1] : undefined;
    if (!entry) return NOTHING;
    return [MONEY_LOG_TYPES[entry.type]!, this.#nameOf(this.#context.world(), entry.playerGuid, true), entry.money,
      ...since(entry.secondsAgo)];
  }

  // ---- the window ------------------------------------------------------------------------

  /** `CloseGuildBankFrame()`, GuildBankFrame's OnHide: the bank closes (locally: there is no opcode). */
  close(): void {
    if (this.#muted) return;
    this.#releaseHeld(true);
    const world = this.#bank();
    if (world) world.closeGuildBank();
    this.#syncVisit();
  }

  /**
   * `GetGuildTabardFileNames()`: the guild's emblem as the six GuildEmblems halves (background,
   * emblem, border; upper, lower), in the tabard vendor's naming. Nothing until the guild query is in.
   */
  tabardFileNames(): readonly unknown[] {
    const guild = this.#context.world()?.guildQuery;
    if (!guild) return NOTHING;
    const code = (value: number): string => String(Math.max(0, Math.trunc(value))).padStart(2, "0");
    const background = `${EMBLEM_ROOT}Background_${code(guild.backgroundColor)}`;
    const emblem = `${EMBLEM_ROOT}Emblem_${code(guild.emblemStyle)}_${code(guild.emblemColor)}`;
    const border = `${EMBLEM_ROOT}Border_${code(guild.borderStyle)}_${code(guild.borderColor)}`;
    return [`${background}_TU_U`, `${background}_TL_U`, `${emblem}_TU_U`, `${emblem}_TL_U`, `${border}_TU_U`, `${border}_TL_U`];
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlGuildBankHost {
  readonly guildBank?: FrameXmlGuildBankModel | undefined;
}

export type FrameXmlGuildBankBinding = (host: FrameXmlGuildBankHost, args: readonly unknown[]) => readonly unknown[];

function optional(value: unknown): readonly unknown[] {
  return value === undefined ? NOTHING : [value];
}

const withBank = (answer: (bank: FrameXmlGuildBankModel, args: readonly unknown[]) => readonly unknown[]): FrameXmlGuildBankBinding =>
  (host, args) => host.guildBank ? answer(host.guildBank, args) : NOTHING;

const command = (run: (bank: FrameXmlGuildBankModel, args: readonly unknown[]) => void): FrameXmlGuildBankBinding =>
  withBank((bank, args) => { run(bank, args); return NOTHING; });

/**
 * The flat C API, spread into FRAMEXML_SEAM_BINDINGS. GetNumGuildBankTabs and GetGuildBankTabInfo are
 * FrameXmlGuild.ts's seam names (the rank editor reads the name and icon); the vault's six-value tab
 * info and its tab count are the flat `WebClientGuildBank*` names here, which the lazy owner's preload
 * puts behind the stock names before Blizzard_GuildBankUI runs (FrameXmlGuildBankOwner.ts).
 * IsGuildLeader, GetGuildBankTabPermissions and the rank editor's setters stay FrameXmlGuild.ts's;
 * CanGuildBankRepair stays the merchant seam's. PickupGuildBankMoney is not bound: stock never calls
 * it (MoneyTypeInfo GUILDBANK has no canPickup).
 */
export const FRAMEXML_GUILDBANK_BINDINGS: Readonly<Record<string, FrameXmlGuildBankBinding>> = Object.freeze({
  WebClientGuildBankNumTabs: (host) => [host.guildBank?.numTabs() ?? 0],
  WebClientGuildBankTabInfo: withBank((bank, args) => bank.tabInfo(args[0])),
  GetCurrentGuildBankTab: (host) => [host.guildBank?.currentTab() ?? 1],
  SetCurrentGuildBankTab: command((bank, args) => bank.setCurrentTab(args[0])),
  QueryGuildBankTab: command((bank, args) => bank.queryTab(args[0])),
  CanEditGuildTabInfo: (host, args) => [host.guildBank?.canEditTabInfo(args[0]) ? 1 : undefined],
  GetGuildBankTabCost: withBank((bank) => optional(bank.tabCost())),
  BuyGuildBankTab: command((bank) => bank.buyTab()),
  SetGuildBankTabInfo: command((bank, args) => bank.setTabInfo(args[0], args[1], args[2])),
  GetGuildBankItemInfo: withBank((bank, args) => bank.itemInfo(args[0], args[1])),
  GetGuildBankItemLink: withBank((bank, args) => optional(bank.itemLink(args[0], args[1]))),
  PickupGuildBankItem: command((bank, args) => bank.pickupItem(args[0], args[1])),
  SplitGuildBankItem: command((bank, args) => bank.splitItem(args[0], args[1], args[2])),
  AutoStoreGuildBankItem: command((bank, args) => bank.autoStoreItem(args[0], args[1])),
  GetGuildBankMoney: (host) => [host.guildBank?.money() ?? 0],
  GetGuildBankWithdrawMoney: (host) => [host.guildBank?.withdrawAllowance() ?? 0],
  CanWithdrawGuildBankMoney: (host) => [host.guildBank?.canWithdrawMoney() ? 1 : undefined],
  DepositGuildBankMoney: command((bank, args) => bank.depositMoney(args[0])),
  WithdrawGuildBankMoney: command((bank, args) => bank.withdrawMoney(args[0])),
  GetGuildBankText: withBank((bank, args) => optional(bank.text(args[0]))),
  QueryGuildBankText: command((bank, args) => bank.queryText(args[0])),
  SetGuildBankText: command((bank, args) => bank.setText(args[0], args[1])),
  QueryGuildBankLog: command((bank, args) => bank.queryLog(args[0])),
  GetNumGuildBankTransactions: (host, args) => [host.guildBank?.numTransactions(args[0]) ?? 0],
  GetGuildBankTransaction: withBank((bank, args) => bank.transaction(args[0], args[1])),
  GetNumGuildBankMoneyTransactions: (host) => [host.guildBank?.numMoneyTransactions() ?? 0],
  GetGuildBankMoneyTransaction: withBank((bank, args) => bank.moneyTransaction(args[0])),
  CloseGuildBankFrame: command((bank) => bank.close()),
  GetGuildTabardFileNames: withBank((bank) => bank.tabardFileNames()),
});

/** TrinityCore's tab prices in gold, for the tests. */
export const FRAMEXML_GUILDBANK_TAB_PRICES_GOLD = TAB_PRICES_GOLD;
