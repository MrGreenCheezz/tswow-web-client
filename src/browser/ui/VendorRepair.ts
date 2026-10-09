// The native vendor window's repair row (plan item 2.02): «repair everything», the repair cursor
// toggle and «the guild pays», shown for a merchant who repairs, and the repair cursor's picture
// and clicks on the native bags and paper doll (ItemSlots.ts). The rules are browser/Repair.ts's,
// the same ones the stock MerchantFrame reaches through framexml/FrameXmlRepair.ts.

import { globalString } from "../../generated/globalStrings.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import { repair, type RepairOutcome } from "../Repair.js";
import { vendorItems, vendorWindow } from "./Dom.js";
import { formatMoney } from "./Format.js";
import { notice } from "./Notices.js";
import { attachTooltip } from "./Widgets.js";

/** The body class style.css draws the repair cursor for, and the custom property holding its picture. */
export const REPAIR_CURSOR_CLASS = "repair-cursor";
export const REPAIR_CURSOR_PROPERTY = "--repair-cursor";
const REPAIR_CURSOR_TEXTURE = "Interface\\Cursor\\Repair.blp";
/** How often an open window re-reads the price and the wear: a repair lands as update fields. */
const REFRESH_MS = 500;

let row: HTMLDivElement | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let shownSignature = "";
let cursorRequested = false;

function refused(outcome: RepairOutcome): void {
  if (outcome !== "unaffordable") return;
  const text = globalString("ERR_NOT_ENOUGH_MONEY") ?? "У вас недостаточно денег.";
  game.world?.onSpellStatus?.(text, true);
  if (!game.world?.onSpellStatus) notice(text);
}

/** The picture is asked for on the first repair cursor, never at load; a crosshair stands in. */
function requestCursorPicture(): void {
  if (cursorRequested || !game.gatewayOrigin || typeof document === "undefined") return;
  cursorRequested = true;
  const url = new URL("/texture", game.gatewayOrigin);
  url.searchParams.set("path", REPAIR_CURSOR_TEXTURE);
  void fetch(url.href).then(async (response) => {
    if (!response.ok) throw new Error(`the repair cursor answered ${response.status}`);
    const picture = URL.createObjectURL(await response.blob());
    document.documentElement.style.setProperty(REPAIR_CURSOR_PROPERTY, `url("${picture}") 0 0, crosshair`);
  }).catch(() => { cursorRequested = false; });
}

repair.onActiveChange((active) => {
  if (typeof document === "undefined") return;
  if (active) requestCursorPicture();
  document.body.classList.toggle(REPAIR_CURSOR_CLASS, active);
  if (row) render();
});

/**
 * A click on a native item slot (ItemSlots.ts): true when the repair cursor took it, so the slot's
 * own click (the item menu) does not run.
 */
export function clickRepairSlot(item: WorldObjectState | undefined, guid: bigint): boolean {
  repair.sync();
  if (!repair.active) return false;
  if (item && guid !== 0n) refused(repair.repairItem(item, guid));
  return true;
}

/** The repair price line for a native item tooltip while the repair cursor is shown, else nothing. */
export function repairTooltipLine(item: WorldObjectState | undefined): string | undefined {
  if (!repair.active) return undefined;
  const cost = repair.itemCost(item);
  return cost > 0 ? `${globalString("REPAIR_COST") ?? "Стоимость ремонта:"} ${formatMoney(cost)}` : undefined;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "vendor-item vendor-repair-button";
  element.textContent = text;
  element.addEventListener("click", onClick);
  return element;
}

function signature(): string {
  const cost = repair.allCost();
  return cost === undefined ? "" : [cost.cost, cost.canRepair, repair.active, repair.canGuildBankRepair()].join(":");
}

function render(): void {
  const current = row;
  if (!current) return;
  const cost = repair.allCost();
  shownSignature = signature();
  current.hidden = cost === undefined;
  if (!cost) {
    current.replaceChildren();
    return;
  }
  // Disabled while nothing is worn, as MerchantFrame_UpdateCanRepairAll disables the stock button.
  const all = button(cost.canRepair ? `Починить всё · ${formatMoney(cost.cost)}` : "Починить всё", () => {
    if (repair.allCost()?.canRepair) refused(repair.repairAll(false));
  });
  if (!cost.canRepair) all.setAttribute("aria-disabled", "true");
  attachTooltip(all, () => ({
    title: globalString("REPAIR_ALL_ITEMS") ?? "Починить все предметы",
    lines: [cost.canRepair ? `Стоимость: ${formatMoney(cost.cost)}` : "Чинить нечего"],
  }));
  const one = button(repair.active ? "Отменить ремонт предмета" : "Починить предмет", () => {
    if (repair.active) repair.hide();
    else repair.show();
  });
  one.setAttribute("aria-pressed", String(repair.active));
  attachTooltip(one, () => ({
    title: globalString("REPAIR_AN_ITEM") ?? "Починить предмет",
    lines: ["Нажмите на предмет в сумке или на персонаже, чтобы починить его."],
  }));
  const buttons = [all, one];
  if (repair.canGuildBankRepair()) {
    const guild = button("За счёт гильдии", () => {
      if (repair.canGuildBankRepair() && repair.allCost()?.canRepair) repair.repairAll(true);
    });
    if (!cost.canRepair) guild.setAttribute("aria-disabled", "true");
    attachTooltip(guild, () => ({
      title: globalString("REPAIR_ALL_ITEMS") ?? "Починить все предметы",
      lines: [globalString("GUILDBANK_REPAIR") ?? "Оплатить ремонт из гильдейского банка"],
    }));
    buttons.push(guild);
  }
  current.replaceChildren(...buttons);
}

function stopRefresh(): void {
  if (refreshTimer === undefined) return;
  clearInterval(refreshTimer);
  refreshTimer = undefined;
}

/**
 * Called by showVendor on every vendor change, open or closed. The row lives just under the goods;
 * while the window shows a merchant who repairs, it re-reads the price every half second.
 */
export function renderVendorRepair(): void {
  repair.sync();
  if (!row) {
    row = document.createElement("div");
    row.className = "vendor-repair";
    row.setAttribute("aria-label", "Ремонт");
    vendorItems.after(row);
  }
  render();
  if (vendorWindow.hidden || row.hidden) {
    stopRefresh();
    return;
  }
  refreshTimer ??= setInterval(() => {
    repair.sync();
    if (vendorWindow.hidden || !game.world?.vendor) {
      stopRefresh();
      return;
    }
    if (signature() !== shownSignature) render();
  }, REFRESH_MS);
}
