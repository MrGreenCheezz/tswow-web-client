import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import { formatMoney } from "./Format.js";
import {
  BANK_BAG_SLOTS, BANK_SLOT_BAG_START, INVENTORY_SLOT_BAG_0, freeSlots, playerInventory,
  type ItemSlotState, type PlayerInventoryState,
} from "../Inventory.js";
import { bagSection, itemSlot } from "./ItemSlots.js";
import { setTip, Panel, confirmPanel } from "./Widgets.js";
import { frameXmlBankPublished } from "../framexml/FrameXmlBankController.js";

/**
 * The bank.
 *
 * There is no bank container and no bank packet: the twenty-eight slots and the seven bag slots
 * have been arriving in the player's own private update fields since the first login, as slots
 * 39 to 73 of `INVENTORY_SLOT_BAG_0`. What `SMSG_SHOW_BANK` grants is *permission* — the server
 * keeps the banker's guid in `m_currentBankerGUID` and `CanUseBank` refuses every bank move
 * without it — so this window can draw itself from state the client already had, and still cannot
 * move a single item until the player is standing at a banker.
 *
 * How many of the seven bag slots have been paid for is byte 2 of `PLAYER_BYTES_2`, and nothing
 * else says it; the unpaid ones are drawn as what they are, a purchase.
 */

interface BankPanel {
  panel: Panel;
  message: HTMLElement;
  bagRow: HTMLElement;
  buy: HTMLButtonElement;
  grid: HTMLElement;
  bagContents: HTMLElement;
}

let parts: BankPanel | undefined;

function build(): BankPanel {
  const panel = new Panel({
    id: "bank-window",
    title: "Банк",
    className: "bank-window",
    // Closing the window tells the server nothing — there is no "close bank" opcode — but it does
    // drop the permission locally, so the bag menu stops offering a deposit that would be refused.
    onClose: () => game.world?.closeBank(),
  });
  const message = document.createElement("p");
  message.className = "muted";
  message.setAttribute("role", "status");
  const bagRow = document.createElement("div");
  bagRow.className = "bank-bags";
  const buy = document.createElement("button");
  buy.type = "button";
  buy.className = "bank-buy";
  buy.textContent = "Купить ячейку";
  // The price is `BankBagSlotPrices.dbc` row `bought+1` (`BankHandler.cpp`); the server still
  // validates funds and answers failure in words. A missing row falls back to asking.
  buy.addEventListener("click", () => confirmPanel(buy, {
    title: buy.textContent || "Купить ячейку банка?",
    lines: [bankSlotPriceLine()],
    confirm: "Купить",
    onConfirm: () => game.world?.buyBankSlot(),
  }));
  const grid = document.createElement("div");
  grid.className = "bag-grid";
  const bagContents = document.createElement("div");
  bagContents.className = "inventory-slots";
  panel.body.append(message, grid, bagRow, buy, bagContents);
  return { panel, message, bagRow, buy, grid, bagContents };
}

/** Opens the window the moment `SMSG_SHOW_BANK` grants permission, as the original client does. */
export function showBank(): void {
  // Stock BankFrame owns the bank while published: BANKFRAME_OPENED shows it, the panel steps aside.
  if (frameXmlBankPublished()) {
    parts?.panel.hide();
    return;
  }
  const world = game.world;
  if (!parts && world?.bankerGuid === undefined) return;
  parts ??= build();
  if (!world || world.bankerGuid === undefined) {
    parts.panel.hide();
    return;
  }
  parts.panel.show();
  const inventory = playerInventory(world.state);
  const message = world.bankMessage;
  parts.message.className = message ? (message.error ? "error" : "success") : "muted";
  parts.message.textContent = message?.text ?? "";
  if (!inventory) return;
  renderBank(parts, inventory);
}

/** Redraws the contents without opening anything; called by the once-a-frame inventory refresh. */
export function refreshBank(inventory: PlayerInventoryState): void {
  if (!parts || !parts.panel.visible) return;
  renderBank(parts, inventory);
}

function renderBank(bank: BankPanel, inventory: PlayerInventoryState): void {
  bank.panel.title = `Банк · ${freeSlots(inventory.bank)} своб.`;
  bank.grid.replaceChildren(...inventory.bank.map((slot) => itemSlot(slot)));

  // The seven bag slots: the bought ones as containers to drop a bag into, the rest as the
  // purchase they are. A slot that has not been paid for cannot hold anything at all.
  const bought = inventory.bankBagSlotsBought;
  bank.bagRow.replaceChildren(...Array.from({ length: BANK_BAG_SLOTS }, (_, index) => {
    const held = inventory.bankBags.find((bag) => bag.bagSlot === BANK_SLOT_BAG_START + index);
    if (index >= bought) {
      const locked = document.createElement("div");
      locked.className = "item-slot bank-slot-locked";
      setTip(locked, `Ячейка ${index + 1} не куплена`);
      locked.textContent = "🔒";
      return locked;
    }
    // The bag itself sits in slot 67 + index of the player's own inventory, so it is an ordinary
    // slot: a bag can be dragged in and out of it like any other item.
    const slot: ItemSlotState = {
      index,
      item: held?.bag,
      guid: held?.guid ?? 0n,
      bag: INVENTORY_SLOT_BAG_0,
      slot: BANK_SLOT_BAG_START + index,
    };
    return itemSlot(slot);
  }));
  bank.buy.disabled = bought >= BANK_BAG_SLOTS;
  const nextPrice = game.slotPrices?.bankSlotPrice(bought);
  bank.buy.textContent = bought >= BANK_BAG_SLOTS
    ? "Все ячейки куплены"
    : nextPrice === undefined
      ? `Купить ячейку ${bought + 1}`
      : `Купить ячейку ${bought + 1} · ${formatMoney(nextPrice)}`;

  bank.bagContents.replaceChildren(...inventory.bankBags.map((bag, index) =>
    bagSection(bagName(bag.bag, index), bag.slots)));
}

function bagName(bag: WorldObjectState, index: number): string {
  const entry = bag.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  return game.itemMetadata?.get(entry)?.name ?? `Банковская сумка ${index + 1}`;
}

/** The next slot's price from the table, or the honest fallback when the row is missing. */
function bankSlotPriceLine(): string {
  const inventory = game.world && playerInventory(game.world.state);
  const bought = inventory?.bankBagSlotsBought ?? 0;
  const price = game.slotPrices?.bankSlotPrice(bought);
  return price === undefined
    ? "Ячейка стоит золото, и чем дальше, тем больше. Сумму назовёт сервер."
    : `Ячейка ${bought + 1} стоит ${formatMoney(price)}. Сервер всё равно проверит золото.`;
}
