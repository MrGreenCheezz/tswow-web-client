/**
 * What the guild bank holds, and what this character is allowed to do with it.
 *
 * Every number here is a trap of some kind. Rights arrive sign-extended, so a rank with everything
 * enabled reads as −1 rather than 255. Withdrawal allowances use −1 for "unlimited", which sorts
 * below zero and prints as a negative if it is passed straight through. The permissions packet
 * always writes six tab pairs whether or not six tabs were ever bought, so iterating the array
 * offers tabs the guild does not own. And a bank list can arrive without the tab list attached:
 * the names are written only for a full refresh of tab zero.
 *
 * DOM-free, which is why any of that can be tested.
 */

import {
  GUILD_BANK_MAX_SLOTS, GUILD_BANK_MAX_TABS, GUILD_BANK_RIGHT_PUT_ITEM, GUILD_BANK_RIGHT_VIEW_TAB,
  GUILD_WITHDRAW_UNLIMITED, guildBankLogText,
  type GuildBankContent, type GuildBankItem, type GuildBankLog, type GuildPermissions,
} from "../../world/GuildBankProtocol.js";
import { formatAgo, formatMoney } from "./Format.js";
import type { SlotContent } from "./Widgets.js";

/** The tab strip: only the tabs the guild has actually bought. */
export interface BankTab {
  tabId: number;
  name: string;
  icon: string;
  /** False when this rank may not even look inside. */
  visible: boolean;
}

/**
 * Rights come as a sign-extended byte, so the whole word cannot be compared: full rights is
 * `0xFF`, which arrives as −1.
 */
export function hasTabRight(rights: number, right: number): boolean {
  return ((rights & 0xff) & right) === right;
}

export function bankTabs(
  content: GuildBankContent | undefined, permissions: GuildPermissions | undefined,
): BankTab[] {
  const bought = permissions?.purchasedTabs ?? content?.tabs.length ?? 0;
  const tabs: BankTab[] = [];
  for (let tabId = 0; tabId < Math.min(bought, GUILD_BANK_MAX_TABS); tabId++) {
    const info = content?.tabs[tabId];
    const rights = permissions?.tabs[tabId]?.rights ?? 0;
    tabs.push({
      tabId,
      name: info?.name || `Вкладка ${tabId + 1}`,
      icon: info?.icon ?? "",
      // With no permissions packet yet, assume visible: the server will simply send nothing back.
      visible: permissions === undefined || hasTabRight(rights, GUILD_BANK_RIGHT_VIEW_TAB),
    });
  }
  return tabs;
}

export function mayDeposit(permissions: GuildPermissions | undefined, tabId: number): boolean {
  const rights = permissions?.tabs[tabId]?.rights;
  return rights === undefined || hasTabRight(rights, GUILD_BANK_RIGHT_PUT_ITEM);
}

/** `SLOTS_PER_GUILD_BANK_TAB` in Guild.h: seven rows of fourteen. */
export const GUILD_BANK_TAB_SLOTS = GUILD_BANK_MAX_SLOTS;
export const GUILD_BANK_TAB_COLUMNS = 14;

/**
 * The tab as a dense array of slots.
 *
 * The wire form is sparse — a full refresh lists only the occupied slots, an incremental one lists
 * exactly what moved — so the grid is built by index rather than by walking the list.
 */
export function bankSlots(
  content: GuildBankContent | undefined,
  iconOf: (itemId: number) => string | undefined,
  nameOf: (itemId: number) => string,
  qualityOf: (itemId: number) => number | undefined,
  // Optional because the name is what a caller without one still gets, through the browser's own
  // `title`. The panel passes the real builder; the model has no business knowing what is in it.
  tooltipOf?: (itemId: number, count: number) => SlotContent["tooltip"],
): SlotContent[] {
  const byIndex = new Map<number, GuildBankItem>();
  for (const item of content?.items ?? []) if (item.itemId !== 0) byIndex.set(item.slot, item);
  return Array.from({ length: GUILD_BANK_TAB_SLOTS }, (_, index) => {
    const item = byIndex.get(index);
    if (!item) return { empty: true };
    const slot: SlotContent = { title: nameOf(item.itemId) };
    const icon = iconOf(item.itemId);
    if (icon) slot.icon = icon;
    if (item.count > 1) slot.count = item.count;
    const quality = qualityOf(item.itemId);
    if (quality !== undefined) slot.quality = quality;
    const tooltip = tooltipOf?.(item.itemId, item.count);
    if (tooltip) slot.tooltip = tooltip;
    return slot;
  });
}

/** The item in one slot of the tab currently shown, or nothing. */
export function bankItemAt(content: GuildBankContent | undefined, slot: number): GuildBankItem | undefined {
  return content?.items.find((item) => item.slot === slot && item.itemId !== 0);
}

/** «осталось 3 предмета» / «без ограничений» — the −1 that means unlimited, said out loud. */
export function withdrawText(remaining: number): string {
  return remaining === GUILD_WITHDRAW_UNLIMITED ? "без ограничений" : `осталось ${Math.max(0, remaining)}`;
}

/** The same for money, where the allowance is copper a day. */
export function goldAllowanceText(goldPerDay: number): string {
  return goldPerDay === GUILD_WITHDRAW_UNLIMITED
    ? "снятие золота без ограничений"
    : goldPerDay <= 0 ? "снятие золота запрещено" : `в день можно снять ${formatMoney(goldPerDay)}`;
}

/**
 * The bank log as sentences.
 *
 * Tab six is the money log rather than a real tab, and its entries carry copper where the others
 * carry an item. `guildBankLogText` gives the verb and has had no caller since it was written.
 */
export function bankLogLines(
  log: GuildBankLog | undefined, nameOf: (guid: bigint) => string, itemName: (itemId: number) => string,
): string[] {
  if (!log) return [];
  return log.entries.map((entry) => {
    const who = nameOf(entry.playerGuid);
    const what = entry.itemId > 0
      ? `${itemName(entry.itemId)}${entry.itemCount > 1 ? ` ×${entry.itemCount}` : ""}`
      : formatMoney(entry.money);
    const moved = entry.destinationTab > 0 ? ` → вкладка ${entry.destinationTab + 1}` : "";
    return `${who} ${guildBankLogText(entry)}: ${what}${moved} · ${formatAgo(entry.secondsAgo)}`;
  });
}
