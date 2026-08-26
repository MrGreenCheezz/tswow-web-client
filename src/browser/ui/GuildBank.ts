/**
 * The guild bank.
 *
 * Six tabs of ninety-eight slots, a shared purse, a withdrawal allowance per rank per day, and a
 * log of who took what. Every packet of it has been parsed since slice P5 and not one of them had
 * a reader: `openGuildBank`, `requestGuildBankTab`, `requestGuildBankLog` and three more were
 * senders with no caller, and the whole mutating half of the protocol had no builder at all.
 *
 * Items move one click at a time rather than by dragging. The drag payload this client uses says
 * `{bag, slot}` and has no way to express "guild bank, tab three", and the swap packet has three
 * shapes chosen by two booleans — of which the auto-store one can only ever withdraw, because the
 * handler hardcodes the direction. Clicking is the shape that fits both.
 */

import { game } from "../game/Context.js";
import { formatMoney, unknownLabel } from "./Format.js";
import { itemTooltipFor } from "./ItemTooltip.js";
import {
  GUILD_BANK_TAB_COLUMNS, bankItemAt, bankLogLines, bankSlots, bankTabs, goldAllowanceText,
  mayDeposit, withdrawText,
} from "./GuildBankModel.js";
import { playerInventory } from "../Inventory.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { Panel, SlotGrid, Tabs, confirmPanel, showMenu, type MenuItem } from "./Widgets.js";

/** Tab six is the money log rather than a real tab; the strip shows it as one. */
const MONEY_LOG_TAB = 6;
const LOG_TAB_ID = "log";

interface Parts {
  panel: Panel;
  tabs: Tabs;
  status: HTMLElement;
  grid: SlotGrid;
  log: HTMLElement;
  money: HTMLElement;
  actions: HTMLElement;
}

let parts: Parts | undefined;
let shownTab = 0;

function build(): Parts {
  const panel = new Panel({
    id: "guild-bank-window",
    title: "Банк гильдии",
    className: "guild-bank",
    onClose: () => game.world?.closeGuildBank(),
  });
  const tabs = new Tabs();
  const status = document.createElement("p");
  status.className = "muted";
  status.setAttribute("role", "status");
  const grid = new SlotGrid({ columns: GUILD_BANK_TAB_COLUMNS, className: "guild-bank-grid" });
  const log = document.createElement("div");
  log.className = "guild-bank-log";
  log.hidden = true;
  const money = document.createElement("p");
  money.className = "guild-bank-money";
  const actions = document.createElement("div");
  actions.className = "guild-bank-actions";
  panel.body.append(tabs.root, status, grid.root, log, money, actions);

  tabs.onSelect = (id) => {
    if (id === LOG_TAB_ID) {
      game.world?.requestGuildBankLog(MONEY_LOG_TAB);
    } else {
      shownTab = Number(id);
      game.world?.requestGuildBankTab(shownTab);
    }
    showGuildBank();
  };
  grid.onSlot((index) => openSlotMenu(grid.root, index));
  return { panel, tabs, status, grid, log, money, actions };
}

export function guildBankOpen(): boolean {
  return parts?.panel.visible ?? false;
}

export function closeGuildBank(): void {
  parts?.panel.hide();
  game.world?.closeGuildBank();
}

export function resetGuildBank(): void {
  parts?.panel.hide();
  shownTab = 0;
}

/**
 * Opens the bank at whatever the player is standing at.
 *
 * The guid has to come from the target: `CMSG_GUILD_BANKER_ACTIVATE` names the chest or the NPC,
 * and the server checks that the player can actually reach it.
 */
export function openGuildBank(): void {
  const world = game.world;
  if (!world) return;
  const banker = world.guildBankerGuid !== 0n ? world.guildBankerGuid : world.targetGuid;
  if (banker === undefined || banker === 0n) return;
  world.openGuildBank(banker);
  showGuildBank();
}

function itemName(itemId: number): string {
  return game.world?.itemTemplate(itemId)?.name
    || game.itemMetadata?.get(itemId)?.name
    || unknownLabel("предмет", itemId);
}

function openSlotMenu(anchor: HTMLElement, slot: number): void {
  const world = game.world;
  if (!world) return;
  const item = bankItemAt(world.guildBank, slot);
  const items: MenuItem[] = [];
  if (item) {
    items.push({
      label: `Забрать ${itemName(item.itemId)}`,
      run: () => world.withdrawGuildBankItem(shownTab, slot, item.itemId),
    });
  }
  // Depositing needs a bag slot to take from, so the menu offers whatever is in the backpack.
  if (mayDeposit(world.guildPermissions, shownTab)) {
    const inventory = playerInventory(world.state);
    const carried = [...(inventory?.backpack ?? []), ...(inventory?.bags ?? []).flatMap((bag) => bag.slots)]
      .filter((entry) => entry.item !== undefined);
    for (const entry of carried.slice(0, 12)) {
      const entryId = entry.item?.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
      items.push({
        label: `Положить: ${itemName(entryId)}`,
        run: () => world.depositGuildBankItem(shownTab, slot, entryId, entry.bag, entry.slot),
      });
    }
  }
  if (items.length === 0) items.push({ label: "Пусто", enabled: false });
  showMenu(anchor, `Ячейка ${slot + 1}`, items);
}

export function showGuildBank(): void {
  const world = game.world;
  if (!world || world.guildBankerGuid === 0n) {
    parts?.panel.hide();
    return;
  }
  parts ??= build();
  const { panel, tabs, status, grid, log, money, actions } = parts;
  panel.show();

  const bought = bankTabs(world.guildBank, world.guildPermissions);
  tabs.set(
    [...bought.filter((tab) => tab.visible).map((tab) => ({ id: String(tab.tabId), title: tab.name })),
      { id: LOG_TAB_ID, title: "Журнал" }],
    tabs.active || String(shownTab));

  const showingLog = tabs.active === LOG_TAB_ID;
  log.hidden = !showingLog;
  grid.root.hidden = showingLog;

  if (showingLog) {
    const lines = bankLogLines(world.guildBankLog, (guid) => world.displayName(guid), itemName);
    log.replaceChildren(...(lines.length > 0 ? lines : ["Журнал пуст"]).map((line) => {
      const row = document.createElement("p");
      row.textContent = line;
      return row;
    }));
  } else {
    const client = game.itemMetadata;
    grid.render(bankSlots(
      world.guildBank,
      (itemId) => { const row = client?.get(itemId); return row ? client?.iconUrl(row) : undefined; },
      itemName,
      (itemId) => world.itemTemplate(itemId)?.quality ?? client?.get(itemId)?.quality,
      (itemId, count) => () => itemTooltipFor(itemId, { count, footer: ["Нажмите для действий"] })));
    // Names for anything the client has not seen before, so the tooltips stop saying «Предмет N».
    const wanted = (world.guildBank?.items ?? []).map((item) => item.itemId).filter((id) => id > 0 && !client?.get(id));
    if (client && wanted.length > 0) {
      void client.load(wanted).then((changed) => { if (changed && game.itemMetadata === client) showGuildBank(); }).catch(() => {});
    }
  }

  const permissions = world.guildPermissions;
  status.textContent = permissions
    ? `Вкладок куплено: ${permissions.purchasedTabs} · вынести с вкладки: ${withdrawText(world.guildBank?.withdrawalsRemaining ?? 0)}`
    : "Права ещё не пришли";
  money.textContent = world.guildBank
    ? `В банке: ${formatMoney(Number(world.guildBank.money))} · ${goldAllowanceText(permissions?.goldPerDay ?? 0)}`
    : "";

  actions.replaceChildren();
  const deposit = document.createElement("button");
  deposit.type = "button";
  deposit.textContent = "Внести золото";
  deposit.addEventListener("click", () => {
    const amount = Number(window.prompt("Сколько золота внести?", "1") ?? "0");
    if (!Number.isFinite(amount) || amount <= 0) return;
    confirmPanel(deposit, {
      title: `Внести ${formatMoney(Math.round(amount * 10000))}?`,
      confirm: "Внести",
      onConfirm: () => world.depositGuildBankMoney(Math.round(amount * 10000)),
    });
  });
  const withdraw = document.createElement("button");
  withdraw.type = "button";
  withdraw.textContent = "Снять золото";
  withdraw.disabled = (permissions?.goldPerDay ?? 0) === 0;
  withdraw.addEventListener("click", () => {
    const amount = Number(window.prompt("Сколько золота снять?", "1") ?? "0");
    if (!Number.isFinite(amount) || amount <= 0) return;
    confirmPanel(withdraw, {
      title: `Снять ${formatMoney(Math.round(amount * 10000))}?`,
      lines: [goldAllowanceText(permissions?.goldPerDay ?? 0)],
      confirm: "Снять",
      danger: true,
      onConfirm: () => world.withdrawGuildBankMoney(Math.round(amount * 10000)),
    });
  });
  const buy = document.createElement("button");
  buy.type = "button";
  buy.textContent = "Купить вкладку";
  buy.addEventListener("click", () => confirmPanel(buy, {
    title: `Купить вкладку ${(permissions?.purchasedTabs ?? 0) + 1}?`,
    lines: ["Оплата идёт из личных денег, а не из банка гильдии."],
    confirm: "Купить",
    onConfirm: () => world.buyGuildBankTab(permissions?.purchasedTabs ?? 0),
  }));
  actions.append(deposit, withdraw, buy);
}
