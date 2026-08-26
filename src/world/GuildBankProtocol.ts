import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: GuildPackets.cpp (`GuildBankQueryResults::Write`,
// `GuildBankLogQueryResults::Write`, `GuildEventLogQueryResults::Write`,
// `GuildPermissionsQueryResults::Write`, `GuildBankTextQueryResult::Write`,
// `PlayerSaveGuildEmblem::Write`), Guild.cpp (`_SendBankList`, `SendBankLog`, `SendEventLog`,
// `SendPermissions`, `SendMoneyInfo`, `BankTab::SendText`) and NPCHandler.cpp
// `SendTabardVendorActivate`.

/** `GUILD_BANK_MAX_TABS` in Guild.h. The permissions packet always writes all six pairs. */
export const GUILD_BANK_MAX_TABS = 6;
/** `GUILD_BANK_MAX_SLOTS` in Guild.h. */
export const GUILD_BANK_MAX_SLOTS = 98;
/** `MAX_GEM_SOCKETS` in Item.h: at most three socket entries per bank item. */
export const GUILD_BANK_MAX_SOCKETS = 3;

/** `GuildBankRights` in Guild.h. `GUILD_BANK_RIGHT_FULL` is 0xFF and arrives sign extended. */
export const GUILD_BANK_RIGHT_VIEW_TAB = 0x01;
export const GUILD_BANK_RIGHT_PUT_ITEM = 0x02;
export const GUILD_BANK_RIGHT_UPDATE_TEXT = 0x04;

/**
 * `GUILD_WITHDRAW_MONEY_UNLIMITED` and `GUILD_WITHDRAW_SLOT_UNLIMITED` are both -1. Every one of
 * these limits is signed on the wire, and a guild master gets -1 rather than a large number: read
 * unsigned, "unlimited" becomes four billion copper.
 */
export const GUILD_WITHDRAW_UNLIMITED = -1;

/** `GuildBankEventLogTypes` in Guild.h. Types 1, 2, 3 and 7 carry an item; the rest carry money. */
export const GUILD_BANK_LOG_DEPOSIT_ITEM = 1;
export const GUILD_BANK_LOG_WITHDRAW_ITEM = 2;
export const GUILD_BANK_LOG_MOVE_ITEM = 3;
export const GUILD_BANK_LOG_DEPOSIT_MONEY = 4;
export const GUILD_BANK_LOG_WITHDRAW_MONEY = 5;
export const GUILD_BANK_LOG_REPAIR_MONEY = 6;
export const GUILD_BANK_LOG_MOVE_ITEM2 = 7;
export const GUILD_BANK_LOG_BUY_SLOT = 9;

/** `GuildEventLogTypes` in Guild.h. */
export const GUILD_EVENT_INVITE_PLAYER = 1;
export const GUILD_EVENT_JOIN_GUILD = 2;
export const GUILD_EVENT_PROMOTE_PLAYER = 3;
export const GUILD_EVENT_DEMOTE_PLAYER = 4;
export const GUILD_EVENT_UNINVITE_PLAYER = 5;
export const GUILD_EVENT_LEAVE_GUILD = 6;

const BANK_LOG_ITEM_TYPES = new Set([
  GUILD_BANK_LOG_DEPOSIT_ITEM, GUILD_BANK_LOG_WITHDRAW_ITEM, GUILD_BANK_LOG_MOVE_ITEM, GUILD_BANK_LOG_MOVE_ITEM2,
]);
const BANK_LOG_MOVE_TYPES = new Set([GUILD_BANK_LOG_MOVE_ITEM, GUILD_BANK_LOG_MOVE_ITEM2]);

export interface GuildBankLogEntry {
  /** Signed on the wire, though every real value is 1 to 9. */
  type: number;
  playerGuid: bigint;
  itemId: number;
  itemCount: number;
  /** Where a moved stack went. Only the two move types carry it. */
  destinationTab: number;
  money: number;
  /**
   * Seconds since it happened, not a timestamp: the server subtracts before writing, so this
   * counts up on its own and needs no clock agreement between the two sides.
   */
  secondsAgo: number;
}

export interface GuildBankLog {
  /** Six is the money log rather than a real tab. */
  tabId: number;
  entries: GuildBankLogEntry[];
}

export function parseGuildBankLog(payload: Uint8Array): GuildBankLog {
  const reader = new PacketReader(payload);
  const tabId = reader.u8();
  const count = reader.u8();
  const entries: GuildBankLogEntry[] = [];
  for (let index = 0; index < count; index++) {
    // The type is written as a signed byte; nothing in range is negative, but the width matters.
    const type = reader.u8();
    const playerGuid = reader.u64();
    const entry: GuildBankLogEntry = {
      type, playerGuid, itemId: 0, itemCount: 0, destinationTab: 0, money: 0, secondsAgo: 0,
    };
    if (BANK_LOG_ITEM_TYPES.has(type)) {
      entry.itemId = reader.u32();
      entry.itemCount = reader.u32();
      if (BANK_LOG_MOVE_TYPES.has(type)) entry.destinationTab = reader.u8();
    } else {
      // Every other type, including any this build does not name, takes the money branch.
      entry.money = reader.u32();
    }
    entry.secondsAgo = reader.u32();
    entries.push(entry);
  }
  reader.assertFinished();
  return { tabId, entries };
}

export interface GuildEventLogEntry {
  type: number;
  playerGuid: bigint;
  /** Whoever did it to them. Joining and leaving are nobody's doing, so neither carries it. */
  otherGuid: bigint;
  /** The rank landed on. Only a promotion or a demotion carries it. */
  rankId: number;
  secondsAgo: number;
}

/** The entry length is decided by its own type byte, so the list cannot be walked by stride. */
export function parseGuildEventLog(payload: Uint8Array): GuildEventLogEntry[] {
  const reader = new PacketReader(payload);
  const count = reader.u8();
  const entries: GuildEventLogEntry[] = [];
  for (let index = 0; index < count; index++) {
    const type = reader.u8();
    const playerGuid = reader.u64();
    const carriesOther = type !== GUILD_EVENT_JOIN_GUILD && type !== GUILD_EVENT_LEAVE_GUILD;
    const otherGuid = carriesOther ? reader.u64() : 0n;
    const carriesRank = type === GUILD_EVENT_PROMOTE_PLAYER || type === GUILD_EVENT_DEMOTE_PLAYER;
    const rankId = carriesRank ? reader.u8() : 0;
    entries.push({ type, playerGuid, otherGuid, rankId, secondsAgo: reader.u32() });
  }
  reader.assertFinished();
  return entries;
}

export interface GuildTabPermission {
  /**
   * Sign extended from a byte: a rank with full rights holds 0xFF, which arrives as -1 rather
   * than 255. Compare against the low eight bits, never against the whole word.
   */
  rights: number;
  /** Item withdrawals left today, or -1 for unlimited. */
  slotsRemaining: number;
}

export interface GuildPermissions {
  /** Widened from the byte a rank id really is. */
  rankId: number;
  /** `GR_RIGHT_*` in Guild.h. */
  rights: number;
  /** Copper a day, or -1 for unlimited. */
  goldPerDay: number;
  /** How many tabs the guild has bought. The six permission pairs are written regardless. */
  purchasedTabs: number;
  tabs: GuildTabPermission[];
}

/** Always sixty-one bytes: the six tab pairs are written whether or not the tabs exist. */
export function parseGuildPermissions(payload: Uint8Array): GuildPermissions {
  const reader = new PacketReader(payload);
  const rankId = reader.u32();
  const rights = reader.i32();
  const goldPerDay = reader.i32();
  const purchasedTabs = reader.u8();
  const tabs: GuildTabPermission[] = [];
  for (let tab = 0; tab < GUILD_BANK_MAX_TABS; tab++) {
    tabs.push({ rights: reader.i32(), slotsRemaining: reader.i32() });
  }
  reader.assertFinished();
  return { rankId, rights, goldPerDay, purchasedTabs, tabs };
}

/** Copper the player may still take out today, or -1 for a guild master. */
export function parseGuildBankMoneyWithdrawn(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const remaining = reader.i32();
  reader.assertFinished();
  return remaining;
}

export interface GuildBankTabText {
  tabId: number;
  text: string;
}

/**
 * Answers a query, and also arrives unasked: setting a tab's text broadcasts the same packet to
 * the whole guild.
 */
export function parseGuildBankTabText(payload: Uint8Array): GuildBankTabText {
  const reader = new PacketReader(payload);
  const tabId = reader.u8();
  const text = reader.cString();
  reader.assertFinished();
  return { tabId, text };
}

export interface GuildBankSocket {
  index: number;
  enchantId: number;
}

export interface GuildBankItem {
  slot: number;
  /** Zero means the slot is now empty, and the entry stops there. */
  itemId: number;
  flags: number;
  randomPropertyId: number;
  /** Only present when there is a random property to scale. */
  suffixFactor: number;
  count: number;
  enchantId: number;
  /** The core takes the absolute value and then keeps only the low byte of it. */
  charges: number;
  sockets: GuildBankSocket[];
}

export interface GuildBankTabInfo {
  name: string;
  icon: string;
}

export interface GuildBankContent {
  money: bigint;
  tabId: number;
  /** Item withdrawals left today on this tab for the receiving player; -1 is unlimited. */
  withdrawalsRemaining: number;
  fullUpdate: boolean;
  /** Only the full refresh of tab zero carries the tab list; every other packet leaves it empty. */
  tabs: GuildBankTabInfo[];
  items: GuildBankItem[];
}

/**
 * The tab list is written only when both the tab is zero and the full-update flag is set — one
 * condition, two halves, and reading the item count where the tab count sits swallows the list.
 *
 * A full refresh lists only occupied slots; an incremental one lists exactly the slots that moved,
 * and a slot is emptied by naming it with item zero.
 */
export function parseGuildBankList(payload: Uint8Array): GuildBankContent {
  const reader = new PacketReader(payload);
  const money = reader.u64();
  const tabId = reader.u8();
  const withdrawalsRemaining = reader.i32();
  const fullUpdate = reader.u8() !== 0;
  const tabs: GuildBankTabInfo[] = [];
  if (tabId === 0 && fullUpdate) {
    const tabCount = reader.u8();
    if (tabCount > GUILD_BANK_MAX_TABS) throw new RangeError(`Guild bank declares ${tabCount} tabs`);
    for (let tab = 0; tab < tabCount; tab++) tabs.push({ name: reader.cString(), icon: reader.cString() });
  }
  const itemCount = reader.u8();
  const items: GuildBankItem[] = [];
  for (let index = 0; index < itemCount; index++) {
    const slot = reader.u8();
    const itemId = reader.u32();
    if (itemId === 0) {
      items.push({ slot, itemId: 0, flags: 0, randomPropertyId: 0, suffixFactor: 0, count: 0, enchantId: 0, charges: 0, sockets: [] });
      continue;
    }
    const flags = reader.i32();
    const randomPropertyId = reader.i32();
    // The suffix factor rides on the property being non-zero, not on a flag of its own.
    const suffixFactor = randomPropertyId !== 0 ? reader.i32() : 0;
    const count = reader.i32();
    const enchantId = reader.i32();
    const charges = reader.u8();
    const socketCount = reader.u8();
    if (socketCount > GUILD_BANK_MAX_SOCKETS) throw new RangeError(`Bank item declares ${socketCount} sockets`);
    const sockets: GuildBankSocket[] = [];
    // Only sockets holding a gem are written, so the indices can skip.
    for (let socket = 0; socket < socketCount; socket++) sockets.push({ index: reader.u8(), enchantId: reader.i32() });
    items.push({ slot, itemId, flags, randomPropertyId, suffixFactor, count, enchantId, charges, sockets });
  }
  reader.assertFinished();
  return { money, tabId, withdrawalsRemaining, fullUpdate, tabs, items };
}

/** `GuildEmblemError` in Guild.h. */
export function parseSaveGuildEmblem(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const error = reader.i32();
  reader.assertFinished();
  return error;
}

/** The tabard designer echoes back the guid it was asked about, and that is what opens the window. */
export function parseTabardVendorActivate(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  reader.assertFinished();
  return guid;
}

export function buildGuildBankLogQuery(tabId: number): Uint8Array {
  return new PacketWriter().u8(tabId).toUint8Array();
}

/** The event log, the permissions and the withdraw allowance are all asked for with nothing. */
export function buildGuildEventLogQuery(): Uint8Array {
  return new Uint8Array(0);
}

export function buildGuildPermissionsQuery(): Uint8Array {
  return new Uint8Array(0);
}

export function buildGuildBankMoneyWithdrawnQuery(): Uint8Array {
  return new Uint8Array(0);
}

export function buildGuildBankTextQuery(tabId: number): Uint8Array {
  return new PacketWriter().u8(tabId).toUint8Array();
}

export function buildGuildBankerActivate(bankerGuid: bigint, fullUpdate: boolean): Uint8Array {
  return new PacketWriter().u64(bankerGuid).u8(fullUpdate ? 1 : 0).toUint8Array();
}

export function buildGuildBankQueryTab(bankerGuid: bigint, tabId: number, fullUpdate: boolean): Uint8Array {
  return new PacketWriter().u64(bankerGuid).u8(tabId).u8(fullUpdate ? 1 : 0).toUint8Array();
}

/** `CMSG_GUILD_BANK_BUY_TAB`: which banker, and which tab to unlock next. */
export function buildGuildBankBuyTab(bankerGuid: bigint, tabId: number): Uint8Array {
  return new PacketWriter().u64(bankerGuid).u8(tabId).toUint8Array();
}

/** `CMSG_GUILD_BANK_UPDATE_TAB`: a tab's name and the icon path shown on its button. */
export function buildGuildBankUpdateTab(bankerGuid: bigint, tabId: number, name: string, icon: string): Uint8Array {
  return new PacketWriter().u64(bankerGuid).u8(tabId).cString(name).cString(icon).toUint8Array();
}

/**
 * `CMSG_GUILD_BANK_DEPOSIT_MONEY` and `_WITHDRAW_MONEY` share a layout.
 *
 * The amount is copper in a **u32**, so the four-and-a-bit thousand gold that fits there is the
 * real limit on one transfer — the bank itself holds a u64.
 */
export function buildGuildBankMoney(bankerGuid: bigint, copper: number): Uint8Array {
  return new PacketWriter().u64(bankerGuid).u32(copper).toUint8Array();
}

/**
 * `CMSG_GUILD_BANK_SWAP_ITEMS`, taking an item out of a tab and letting the server find a bag slot.
 *
 * `GuildBankSwapItems::Read` has three shapes chosen by two booleans, and the auto-store one is
 * withdraw-only by construction: the handler hardcodes `toChar = 1` and a null bag whenever
 * `AutoStore` is set, so this form cannot deposit however its fields are filled in. The three
 * trailing values are read and then ignored on this branch; they are written because the reader
 * still consumes them.
 */
export function buildGuildBankWithdrawItem(
  bankerGuid: bigint, tabId: number, slotId: number, itemId: number,
): Uint8Array {
  return new PacketWriter()
    .u64(bankerGuid)
    .u8(0) // BankOnly: never a move from one tab to another.
    .u8(tabId).u8(slotId).u32(itemId)
    .u8(1) // AutoStore.
    .i32(0).u8(0).i32(0)
    .toUint8Array();
}

/**
 * The other direction: a named bag slot into a named tab slot.
 *
 * `ToSlot` is the `toChar` flag in disguise — the handler reads it as "move towards the character"
 * — so depositing writes a zero there, and the bag position has to be a real inventory position
 * because the server refuses anything else.
 */
export function buildGuildBankDepositItem(
  bankerGuid: bigint, tabId: number, slotId: number, itemId: number,
  bag: number, bagSlot: number, splitCount = 0,
): Uint8Array {
  return new PacketWriter()
    .u64(bankerGuid)
    .u8(0)
    .u8(tabId).u8(slotId).u32(itemId)
    .u8(0) // AutoStore off: the bag position below is the source.
    .u8(bag).u8(bagSlot)
    .u8(0) // toChar = 0, i.e. into the bank.
    .i32(splitCount)
    .toUint8Array();
}

export function buildTabardVendorActivate(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

/** The emblem is read style, colour, border style, border colour, background — in that order. */
export function buildSaveGuildEmblem(
  vendorGuid: bigint,
  style: number,
  color: number,
  borderStyle: number,
  borderColor: number,
  background: number,
): Uint8Array {
  return new PacketWriter()
    .u64(vendorGuid)
    .i32(style)
    .i32(color)
    .i32(borderStyle)
    .i32(borderColor)
    .i32(background)
    .toUint8Array();
}

// `GuildEmblemError` in Guild.h. Code 1 exists but this build never reaches it.
const EMBLEM_ERRORS: Record<number, string> = {
  0: "Герб сохранён",
  1: "Недопустимые цвета",
  2: "Вы не состоите в гильдии",
  3: "Только глава гильдии может менять герб",
  4: "Не хватает денег",
  5: "Это не мастер по гербам",
};

export function guildEmblemErrorText(error: number): string {
  return EMBLEM_ERRORS[error] ?? `Ошибка герба (код ${error})`;
}

const BANK_LOG_NAMES: Record<number, string> = {
  1: "положил предмет",
  2: "взял предмет",
  3: "переложил предмет",
  4: "положил деньги",
  5: "взял деньги",
  6: "потратил на починку",
  7: "переложил предмет",
  9: "купил вкладку",
};

export function guildBankLogText(entry: GuildBankLogEntry): string {
  return BANK_LOG_NAMES[entry.type] ?? `действие ${entry.type}`;
}

const EVENT_LOG_NAMES: Record<number, string> = {
  1: "пригласил",
  2: "вступил в гильдию",
  3: "повысил",
  4: "понизил",
  5: "исключил",
  6: "покинул гильдию",
};

export function guildEventLogText(entry: GuildEventLogEntry): string {
  return EVENT_LOG_NAMES[entry.type] ?? `событие ${entry.type}`;
}
