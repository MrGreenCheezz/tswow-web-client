// Plan item 2.10 (04.10, L4): the native vendor window's purchase refunds, under the repair row — one
// button per carried item the merchant can take back (VendorRefundRows.ts), asking first as the stock
// CONFIRM_REFUND_TOKEN_ITEM does, then CMSG_ITEM_REFUND (WorldClient.refundItem). The realm's answer
// comes as the usual system lines. The time left counts down while the window is open.

import { globalString } from "../../generated/globalStrings.js";
import { game } from "../game/Context.js";
import { vendorItems, vendorWindow } from "./Dom.js";
import { formatMoney, unknownLabel } from "./Format.js";
import { itemTooltipFor } from "./ItemTooltip.js";
import { notice } from "./Notices.js";
import {
  vendorRefundConfirm, vendorRefundCostText, vendorRefundRows, vendorRefundTimeText, type VendorRefundRow,
} from "./VendorRefundRows.js";
import { attachTooltip, confirmPanel } from "./Widgets.js";

/** How often an open window re-reads the records and the time left. */
const REFRESH_MS = 1000;

let section: HTMLDivElement | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let shownSignature = "";

function rows(): VendorRefundRow[] {
  const world = game.world;
  if (!world?.vendor) return [];
  return vendorRefundRows(world, world.playedSecondsNow?.());
}

function itemName(entry: number): string {
  return game.world?.itemTemplate(entry)?.name || game.itemMetadata?.get(entry)?.name || unknownLabel("предмет", entry);
}

/** What the drawn list depends on: the items and the minutes shown. */
function signature(list: readonly VendorRefundRow[]): string {
  return list.map((row) => `${row.guid}:${Math.floor(row.left / 60)}`).join(",");
}

function render(list: readonly VendorRefundRow[]): void {
  const current = section;
  if (!current) return;
  shownSignature = signature(list);
  current.hidden = list.length === 0;
  if (list.length === 0) {
    current.replaceChildren();
    return;
  }
  const heading = document.createElement("h3");
  heading.textContent = "Возврат покупок";
  const buttons = list.map((row) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vendor-item vendor-refund";
    const name = itemName(row.entry);
    button.textContent = `Вернуть: ${name} · ${vendorRefundTimeText(row.left)}`;
    const cost = vendorRefundCostText(row.info, formatMoney, itemName);
    attachTooltip(button, () => itemTooltipFor(row.entry, {
      footer: [`Можно вернуть ещё ${vendorRefundTimeText(row.left)}${cost ? ` и получить: ${cost}` : ""}`],
    }));
    button.addEventListener("click", () => {
      const template = globalString("CONFIRM_REFUND_TOKEN_ITEM");
      confirmPanel(button, {
        title: `Вернуть «${name}»?`,
        lines: [template && cost ? template.replace("%s", cost) : cost],
        confirm: "Вернуть",
        onConfirm: () => {
          // L4-review: the row is checked again at the click (VendorRefundRows.vendorRefundConfirm).
          const world = game.world;
          const refused = world ? vendorRefundConfirm(world, row.guid, world.playedSecondsNow?.()) : undefined;
          if (refused) notice(globalString(refused) ?? "Не удалось вернуть предмет.");
        },
      });
    });
    return button;
  });
  current.replaceChildren(heading, ...buttons);
}

function stopRefresh(): void {
  if (refreshTimer === undefined) return;
  clearInterval(refreshTimer);
  refreshTimer = undefined;
}

/** Called by showVendor on every vendor change, open or closed (Npc.ts). */
export function renderVendorRefunds(): void {
  if (!section) {
    section = document.createElement("div");
    section.className = "vendor-refunds";
    section.setAttribute("aria-label", "Возврат покупок");
    (vendorItems.parentElement?.querySelector(".vendor-repair") ?? vendorItems).after(section);
  }
  render(rows());
  if (vendorWindow.hidden || !game.world?.vendor) {
    stopRefresh();
    return;
  }
  refreshTimer ??= setInterval(() => {
    if (vendorWindow.hidden || !game.world?.vendor) {
      stopRefresh();
      render([]);
      return;
    }
    const list = rows();
    if (signature(list) !== shownSignature) render(list);
  }, REFRESH_MS);
}
