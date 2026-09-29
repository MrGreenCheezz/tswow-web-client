/**
 * The offline guild bank: a scripted world for `CannedWorldSeam`, its tests and the
 * `framexml.html?guildbank=` preview, in the exact shapes SMSG_GUILD_BANK_LIST, MSG_GUILD_PERMISSIONS,
 * MSG_GUILD_BANK_LOG_QUERY, MSG_QUERY_GUILD_BANK_TEXT, MSG_GUILD_BANK_MONEY_WITHDRAWN and the bank's
 * SMSG_GUILD_EVENTs parse into (GuildBankProtocol.ts, GuildProtocol.ts).
 *
 * «Стражи Элвинна» and its two tabs are the canned guild's (FrameXmlFriendsCanned.ts, whose player
 * 0x42 leads it, so the permissions are the guild master's: every right, -1 limits). Item names and
 * icons are the canned auction house's, measured on this dataset (FrameXmlAuctionCanned.ts); what
 * lies in which slot, the money and the log are fixture values. Commands record their wire intent;
 * with `autoAnswer` (the preview) the bank answers each one as TrinityCore would, a microtask later.
 */
import { EventBus, type GuildBankChange } from "../../world/EventBus.js";
import {
  GE_BANK_MONEY_SET, GE_BANK_TAB_PURCHASED, GE_BANK_TAB_UPDATED, GUILD_BANK_MAX_SLOTS, GUILD_BANK_MAX_TABS,
  type GuildBankContent, type GuildBankItem, type GuildBankLog, type GuildBankLogEntry, type GuildPermissions,
} from "../../world/GuildBankProtocol.js";
import { FRAMEXML_CANNED_AUCTION_ITEMS } from "./FrameXmlAuctionCanned.js";
import {
  FrameXmlGuildBankModel, type FrameXmlGuildBankContext, type FrameXmlGuildBankWorld,
} from "./FrameXmlGuildBank.js";

/** The canned vault chest's GUID (a GameObject, high 0xF110). */
export const FRAMEXML_CANNED_GUILD_BANKER_GUID = 0xf1100000b3000200n;
/** The bank's money: 1234 g 56 s 78 c. */
export const FRAMEXML_CANNED_GUILD_BANK_MONEY = 12_345_678;
/** TrinityCore's tab prices (Guild.cpp GetGuildBankTabPrice), the canned buy answers with them. */
const TAB_PRICES_GOLD = [100, 250, 500, 1000, 2500, 5000];
const HOUR = 3600;
const DAY = 24 * HOUR;

/** Log players: the canned guild's members (FrameXmlFriendsCanned.ts) by GUID. */
const NAMES = new Map<bigint, string>([
  [0x42n, "Игрок"], [0x101n, "Аэлинда"], [0x303n, "Хельга"], [0x307n, "Олли"],
]);

function stack(slot: number, itemId: number, count: number, fields: Partial<GuildBankItem> = {}): GuildBankItem {
  return { slot, itemId, flags: 0, randomPropertyId: 0, suffixFactor: 0, count, enchantId: 0, charges: 0, sockets: [], ...fields };
}

/** What lies in the two bought tabs, 0-based slots (the first row of fourteen, and a few below). */
export function frameXmlCannedGuildBankTabs(): GuildBankItem[][] {
  return [
    [
      stack(0, 2589, 20), stack(1, 2589, 20), stack(2, 2589, 7), stack(3, 4306, 20), stack(4, 14047, 12),
      stack(14, 818, 3), stack(15, 12360, 2), stack(16, 7078, 4),
      // A sword with a permanent enchant (Crusader, 1900): its link carries it.
      stack(28, 2488, 1, { enchantId: 1900 }),
      stack(97, 15014, 1),
    ],
    [
      stack(0, 13446, 5), stack(1, 13446, 5), stack(2, 13446, 3),
    ],
  ];
}

function logEntry(type: number, playerGuid: bigint, secondsAgo: number, fields: Partial<GuildBankLogEntry> = {}): GuildBankLogEntry {
  return { type, playerGuid, itemId: 0, itemCount: 0, destinationTab: 0, money: 0, secondsAgo, ...fields };
}

/** Tab 0's item log, oldest first (LogHolder order), and the money log (tab 6). */
export function frameXmlCannedGuildBankLogs(): Map<number, GuildBankLogEntry[]> {
  return new Map([
    [0, [
      logEntry(1, 0x101n, 3 * DAY, { itemId: 2589, itemCount: 20 }),
      logEntry(1, 0x303n, 2 * DAY, { itemId: 4306, itemCount: 20 }),
      logEntry(2, 0x307n, 26 * HOUR, { itemId: 14047, itemCount: 8 }),
      logEntry(3, 0x42n, 5 * HOUR, { itemId: 13446, itemCount: 5, destinationTab: 1 }),
      logEntry(1, 0x42n, 40 * 60, { itemId: 2488, itemCount: 1 }),
    ]],
    [1, [logEntry(1, 0x42n, 5 * HOUR, { itemId: 13446, itemCount: 13 })]],
    [GUILD_BANK_MAX_TABS, [
      logEntry(4, 0x101n, 4 * DAY, { money: 500_000 }),
      logEntry(9, 0x42n, 3 * DAY, { money: 1_000_000 }),
      logEntry(6, 0x303n, 30 * HOUR, { money: 12_345 }),
      logEntry(5, 0x307n, 3 * HOUR, { money: 20_000 }),
      logEntry(4, 0x42n, 20 * 60, { money: 150_000 }),
    ]],
  ]);
}

/** One command the canned bank received, in order; tests assert the wire-level intent. */
export type FrameXmlCannedGuildBankCall =
  | { readonly kind: "queryTab" | "text" | "log"; readonly tab: number }
  | { readonly kind: "withdrawn" | "close" }
  | { readonly kind: "setText"; readonly tab: number; readonly text: string }
  | { readonly kind: "buy"; readonly tab: number }
  | { readonly kind: "rename"; readonly tab: number; readonly name: string; readonly icon: string }
  | { readonly kind: "deposit" | "withdraw"; readonly copper: number }
  | { readonly kind: "autoStore"; readonly tab: number; readonly slot: number; readonly itemId: number }
  | { readonly kind: "withdrawTo"; readonly tab: number; readonly slot: number; readonly itemId: number;
      readonly bag: number; readonly bagSlot: number; readonly split: number }
  | { readonly kind: "depositItem"; readonly tab: number; readonly slot: number; readonly itemId: number;
      readonly bag: number; readonly bagSlot: number; readonly split: number }
  | { readonly kind: "move"; readonly fromTab: number; readonly fromSlot: number; readonly fromItemId: number;
      readonly toTab: number; readonly toSlot: number; readonly toItemId: number; readonly split: number };

/**
 * The canned guild bank: `WorldClient`'s `guildBank*` fields and commands. `open()` stands in for
 * CMSG_GUILD_BANKER_ACTIVATE at the vault (its answers follow with `answerOpen()`, or at once with
 * `autoAnswer`).
 */
export class FrameXmlCannedGuildBankWorld implements FrameXmlGuildBankWorld {
  readonly events = new EventBus<{ GUILD_BANK_CHANGED: GuildBankChange }>();
  readonly calls: FrameXmlCannedGuildBankCall[] = [];
  readonly names = new Map<bigint, string>(NAMES);
  guildBankerGuid = 0n;
  guildBank: GuildBankContent | undefined;
  guildBankLog: GuildBankLog | undefined;
  guildPermissions: GuildPermissions | undefined;
  guildBankWithdrawRemaining: number | undefined;
  readonly guildBankTabText = new Map<number, string>();
  readonly guildQuery = { emblemStyle: 0, emblemColor: 0, borderStyle: 0, borderColor: 0, backgroundColor: 0 };
  /** Answer every command a microtask later, as the preview's live-looking bank does. */
  autoAnswer = false;
  money = FRAMEXML_CANNED_GUILD_BANK_MONEY;
  readonly tabs = [{ name: "Общее", icon: "INV_Misc_Bag_10" }, { name: "Рейд", icon: "INV_Potion_54" }];
  readonly contents = frameXmlCannedGuildBankTabs();
  readonly logs = frameXmlCannedGuildBankLogs();
  readonly texts = new Map<number, string>([
    [0, "Общие материалы гильдии.\nБерите для профессий, возвращайте излишки."],
    [1, "Зелья для рейда в пятницу."],
  ]);
  /** Rights by tab for the permissions packet: the guild master's -1 (0xFF sign extended). */
  rights = -1;
  rankId = 0;

  displayName(guid: bigint): string { return this.names.get(guid) ?? `0x${guid.toString(16)}`; }
  requestName(): void { /* every canned name is known */ }

  #emit(change: GuildBankChange = {}): void {
    this.events.emit("GUILD_BANK_CHANGED", change);
  }

  #later(run: () => void): void {
    if (this.autoAnswer) queueMicrotask(run);
  }

  /** The activation at the canned vault; `autoAnswer` answers as `answerOpen` does. */
  open(): void {
    this.guildBankerGuid = FRAMEXML_CANNED_GUILD_BANKER_GUID;
    this.#later(() => this.answerOpen());
  }

  /** CMSG_GUILD_BANKER_ACTIVATE's answers: tab 0 in full with the tab list, permissions, allowance. */
  answerOpen(): void {
    this.deliverTab(0);
    this.deliverPermissions();
    this.deliverWithdrawn();
  }

  /** One full SMSG_GUILD_BANK_LIST of a tab; tab 0 carries the tab list. */
  deliverTab(tabId: number): void {
    const list: GuildBankContent = {
      money: BigInt(this.money), tabId, withdrawalsRemaining: this.rankId === 0 ? -1 : 5, fullUpdate: true,
      tabs: tabId === 0 ? this.tabs.map((tab) => ({ ...tab })) : [],
      items: (this.contents[tabId] ?? []).map((item) => ({ ...item })),
    };
    this.guildBank = list;
    this.#emit({ list });
  }

  /** A partial list: exactly these slots of a tab, an emptied one as item 0 (what a move broadcasts). */
  deliverSlots(tabId: number, slots: readonly number[]): void {
    const items = slots.map((slot) => {
      const item = this.contents[tabId]?.find((candidate) => candidate.slot === slot);
      return item ? { ...item } : stack(slot, 0, 0);
    });
    const list: GuildBankContent = {
      money: BigInt(this.money), tabId, withdrawalsRemaining: this.rankId === 0 ? -1 : 4, fullUpdate: false, tabs: [], items,
    };
    this.guildBank = list;
    this.#emit({ list });
  }

  deliverPermissions(): void {
    this.guildPermissions = {
      rankId: this.rankId, rights: this.rankId === 0 ? -1 : 0x000800c3, goldPerDay: this.rankId === 0 ? -1 : 500_000,
      purchasedTabs: this.tabs.length,
      tabs: Array.from({ length: GUILD_BANK_MAX_TABS }, () => ({ rights: this.rights, slotsRemaining: this.rankId === 0 ? -1 : 5 })),
    };
    this.#emit();
  }

  deliverWithdrawn(remaining = this.rankId === 0 ? -1 : 500_000): void {
    this.guildBankWithdrawRemaining = remaining;
    this.#emit();
  }

  deliverLog(tabId: number): void {
    this.guildBankLog = { tabId, entries: (this.logs.get(tabId) ?? []).map((entry) => ({ ...entry })) };
    this.#emit();
  }

  deliverText(tabId: number): void {
    this.guildBankTabText.set(tabId, this.texts.get(tabId) ?? "");
    this.#emit({ textTab: tabId });
  }

  /** One of the bank's SMSG_GUILD_EVENTs. */
  guildEvent(type: number, params: readonly string[] = []): void {
    this.#emit({ guildEvent: { type, params } });
  }

  queryGuildBankTab(tabId: number): void {
    this.calls.push({ kind: "queryTab", tab: tabId });
    this.#later(() => this.deliverTab(tabId));
  }

  requestGuildBankText(tabId: number): void {
    this.calls.push({ kind: "text", tab: tabId });
    this.#later(() => this.deliverText(tabId));
  }

  requestGuildBankLog(tabId: number): void {
    this.calls.push({ kind: "log", tab: tabId });
    this.#later(() => this.deliverLog(tabId));
  }

  requestGuildBankMoneyWithdrawn(): void {
    this.calls.push({ kind: "withdrawn" });
    this.#later(() => this.deliverWithdrawn());
  }

  setGuildBankText(tabId: number, text: string): void {
    this.calls.push({ kind: "setText", tab: tabId, text });
    // TrinityCore stores it and broadcasts MSG_QUERY_GUILD_BANK_TEXT to the guild.
    this.#later(() => { this.texts.set(tabId, text); this.deliverText(tabId); });
  }

  closeGuildBank(): void {
    this.calls.push({ kind: "close" });
    this.guildBankerGuid = 0n;
    this.guildBank = undefined;
  }

  buyGuildBankTab(tabId: number): void {
    this.calls.push({ kind: "buy", tab: tabId });
    this.#later(() => {
      if (tabId !== this.tabs.length || tabId >= GUILD_BANK_MAX_TABS) return;
      this.tabs.push({ name: "", icon: "" });
      this.contents[tabId] = [];
      const price = (TAB_PRICES_GOLD[tabId] ?? 0) * 10000;
      this.logs.get(GUILD_BANK_MAX_TABS)?.push(logEntry(9, 0x42n, 0, { money: price }));
      this.guildEvent(GE_BANK_TAB_PURCHASED);
      this.deliverPermissions();
    });
  }

  renameGuildBankTab(tabId: number, name: string, icon: string): void {
    this.calls.push({ kind: "rename", tab: tabId, name, icon });
    this.#later(() => {
      const tab = this.tabs[tabId];
      if (!tab) return;
      tab.name = name;
      tab.icon = icon;
      this.guildEvent(GE_BANK_TAB_UPDATED, [String(tabId), name, icon]);
    });
  }

  #setMoney(money: number): void {
    this.money = money;
    this.guildEvent(GE_BANK_MONEY_SET, [money.toString(16).toUpperCase().padStart(16, "0")]);
  }

  depositGuildBankMoney(copper: number): void {
    this.calls.push({ kind: "deposit", copper });
    this.#later(() => this.#setMoney(this.money + copper));
  }

  withdrawGuildBankMoney(copper: number): void {
    this.calls.push({ kind: "withdraw", copper });
    this.#later(() => { if (copper <= this.money) this.#setMoney(this.money - copper); });
  }

  #take(tabId: number, slot: number, split: number): void {
    const items = this.contents[tabId];
    const index = items?.findIndex((item) => item.slot === slot) ?? -1;
    if (!items || index < 0) return;
    const item = items[index]!;
    if (split > 0 && split < item.count) items[index] = { ...item, count: item.count - split };
    else items.splice(index, 1);
    this.deliverSlots(tabId, [slot]);
  }

  withdrawGuildBankItem(tabId: number, slotId: number, itemId: number): void {
    this.calls.push({ kind: "autoStore", tab: tabId, slot: slotId, itemId });
    this.#later(() => this.#take(tabId, slotId, 0));
  }

  withdrawGuildBankItemTo(tabId: number, slotId: number, itemId: number, bag: number, bagSlot: number, split = 0): void {
    this.calls.push({ kind: "withdrawTo", tab: tabId, slot: slotId, itemId, bag, bagSlot, split });
    this.#later(() => this.#take(tabId, slotId, split));
  }

  depositGuildBankItem(tabId: number, slotId: number, itemId: number, bag: number, bagSlot: number, split = 0): void {
    this.calls.push({ kind: "depositItem", tab: tabId, slot: slotId, itemId, bag, bagSlot, split });
    this.#later(() => {
      const items = this.contents[tabId];
      if (!items) return;
      // NULL_SLOT: the first free slot, as BankMoveItemData::CanStore places an unnamed deposit.
      let slot = slotId;
      if (slot >= GUILD_BANK_MAX_SLOTS) {
        slot = Array.from({ length: GUILD_BANK_MAX_SLOTS }, (_, index) => index)
          .find((index) => !items.some((item) => item.slot === index)) ?? -1;
      }
      if (slot < 0 || items.some((item) => item.slot === slot)) return;
      items.push(stack(slot, itemId, 1));
      this.deliverSlots(tabId, [slot]);
    });
  }

  moveGuildBankItem(fromTab: number, fromSlot: number, fromItemId: number,
    toTab: number, toSlot: number, toItemId: number, split = 0): void {
    this.calls.push({ kind: "move", fromTab, fromSlot, fromItemId, toTab, toSlot, toItemId, split });
    this.#later(() => {
      const source = this.contents[fromTab];
      const target = this.contents[toTab];
      const item = source?.find((candidate) => candidate.slot === fromSlot);
      if (!source || !target || !item) return;
      const there = target.find((candidate) => candidate.slot === toSlot);
      // Guild::SwapItems: an occupied destination swaps (a whole-stack move), a split needs it empty.
      if (split > 0 && split < item.count) {
        if (there) return;
        item.count -= split;
        target.push({ ...item, slot: toSlot, count: split });
      } else {
        source.splice(source.indexOf(item), 1);
        if (there) {
          target.splice(target.indexOf(there), 1);
          source.push({ ...there, slot: fromSlot });
        }
        target.push({ ...item, slot: toSlot });
      }
      if (fromTab === toTab) this.deliverSlots(fromTab, [fromSlot, toSlot]);
      else {
        this.deliverSlots(fromTab, [fromSlot]);
        this.deliverSlots(toTab, [toSlot]);
      }
    });
  }
}

export interface FrameXmlCannedGuildBank {
  readonly model: FrameXmlGuildBankModel;
  readonly world: FrameXmlCannedGuildBankWorld;
}

/** A model over the canned bank; `context` may override what a test or the seam needs. */
export function createCannedFrameXmlGuildBank(context: Partial<FrameXmlGuildBankContext> = {}): FrameXmlCannedGuildBank {
  const world = new FrameXmlCannedGuildBankWorld();
  const model = new FrameXmlGuildBankModel({
    world: () => world,
    item: (entry) => FRAMEXML_CANNED_AUCTION_ITEMS.get(entry),
    playerLevel: () => 60,
    cursorItem: () => undefined,
    clearCursor: () => {},
    ...context,
  });
  return { model, world };
}
