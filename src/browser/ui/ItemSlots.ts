import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { firstFreeTradeSlot } from "../../world/TradeProtocol.js";
import { itemOpensForLoot } from "../../world/ItemProtocol.js";
import { game } from "../game/Context.js";
import { clickFrameXmlNativeBankSlot } from "../framexml/FrameXmlItemCursorBridge.js";
import { frameXmlPopupsDestroyItem } from "../framexml/FrameXmlPopupsController.js";
import { requestInventoryItemUse } from "../game/GroundTarget.js";
import {
  BUYBACK_SLOT_START, EQUIPMENT_SLOT_NAMES, INVENTORY_SLOT_BAG_0, KEYRING_SLOT_START,
  firstFreeSlot, isBankSlot, itemEnchantPresence, itemWear, playerInventory, slotAt,
  type ItemSlotState, stackCount,
} from "../Inventory.js";
import { itemActionDragPayload } from "./ActionBar.js";
import { beginIconDrag } from "./DragGhost.js";
import { systemLine } from "./Chat.js";
import { insertIntoChat } from "./ChatDock.js";
import { itemChatLink } from "./ChatLink.js";
import { formatMoney, unknownLabel } from "./Format.js";
import { itemTooltipFor } from "./ItemTooltip.js";
import { itemEnchantmentIds, itemSocketColors } from "../ItemEnchantments.js";
import { openSocketing } from "./Socketing.js";
import { extendItemTooltip, hideItemTooltipExtension } from "./ItemTooltipExtensions.js";
import { attachTooltip, hideTooltip, setTip, type TooltipContent, lastPointer,
} from "./Widgets.js";
import { setIconSource } from "./IconImage.js";
import { clickRepairSlot, repairTooltipLine } from "./VendorRepair.js";
import { clickItemTargetSlot } from "./ItemTargetClick.js";
import { armNativeGiftWrap, wrapNativeSlot } from "./NativeGiftWrap.js"; // L1 (2.05 E)

/**
 * One item slot, and everything the player can do to what is in it.
 *
 * Split out of the bag window because a slot is not the bags' own: the same square is the bank,
 * the keyring, the equipment doll and the vendor's buyback shelf, and all of them address it with
 * the same `{bag, slot}` pair the item opcodes take. The bank in particular is not a container the
 * server hands over — it is more slots of the player's own inventory, 39 to 73, which is why one
 * slot type covers it.
 */

/** What a slot-to-slot drag carries: where the item is now, which is all a move needs. */
export const ITEM_DRAG_FORMAT = "application/x-webclient-item";

export interface ItemDrag {
  bag: number;
  slot: number;
}

/**
 * Reads a bag-slot drag off a drop event. `undefined` when the gesture carries no item —
 * a spell, a macro or a foreign drag the trade window must ignore.
 */
export function readItemDrag(dataTransfer: DataTransfer | null | undefined): ItemDrag | undefined {
  const raw = dataTransfer?.getData(ITEM_DRAG_FORMAT);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<ItemDrag>;
    if (!Number.isInteger(parsed.bag) || !Number.isInteger(parsed.slot)) return undefined;
    return { bag: parsed.bag as number, slot: parsed.slot as number };
  } catch {
    return undefined;
  }
}

function isEquipmentSlot(slot: ItemSlotState): boolean {
  return slot.bag === INVENTORY_SLOT_BAG_0 && slot.slot < EQUIPMENT_SLOT_NAMES.length;
}

/** The buyback shelf is read-only: an item there is bought back, never dragged. */
function isBuybackSlot(slot: ItemSlotState): boolean {
  return slot.bag === INVENTORY_SLOT_BAG_0 && slot.slot >= BUYBACK_SLOT_START && slot.slot < KEYRING_SLOT_START;
}

function itemName(slot: ItemSlotState): string {
  const entry = slot.item ? slot.item.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0 : 0;
  if (entry === 0) return "пустой слот";
  // The wire first: the query answers from `item_template` at run time, and the dump was written
  // when `npm run assets:items` last ran, so a renamed item keeps its old name until it is rerun.
  return game.world?.itemTemplate(entry)?.name
    || game.itemMetadata?.get(entry)?.name
    || unknownLabel("предмет", entry);
}



// Actions on a slot. The original client uses a right-click menu; here one click opens the same
// choices, because a browser right-click belongs to the page.
function showItemMenu(anchor: HTMLElement, slot: ItemSlotState, name: string): void {
  const world = game.world;
  closeItemMenu();
  if (!world) return;

  const menu = document.createElement("div");
  menu.className = "item-menu";
  menu.id = "item-menu";
  const title = document.createElement("strong");
  title.textContent = name;
  menu.append(title);

  const equipped = isEquipmentSlot(slot);
  const banked = isBankSlot(slot.bag, slot.slot);
  const bankOpen = world.bankerGuid !== undefined;
  const count = stackCount(slot);
  const actions: Array<[string, () => void]> = [];
  const template = world.itemTemplate(entryOfSlot(slot));
  const opensForLoot = itemOpensForLoot(slot.item?.fields.get(UPDATE_FIELDS.ITEM_FIELD_FLAGS.offset), template?.flags);
  if (!banked && slot.item && itemSocketColors(template?.sockets ?? [], itemEnchantmentIds(slot.item)).some(Boolean)) {
    actions.push(["Вставить камни", () => openSocketing(slot)]);
  }
  if (world.vendor && !banked) actions.push(["Продать", () => world.sellToVendor(slot.guid)]);
  if (world.tradeOpen && !equipped && !banked) {
    actions.push(["Предложить в обмен", () => {
      const free = firstFreeTradeSlot(world.ownTradeOffer().items.map((item) => item.slot));
      if (free === undefined) systemLine("Свободных слотов обмена нет");
      else world.offerTradeItem(free, slot.bag, slot.slot);
    }]);
  }
  if (world.auctioneerGuid !== 0n && !equipped && !banked) {
    actions.push(["Выставить на аукцион", () => showAuctionPrompt(anchor, slot, name, count)]);
  }
  if (equipped) actions.push(["Снять", () => world.storeItemInBag(slot.bag, slot.slot, INVENTORY_SLOT_BAG_0)]);
  else actions.push(["Надеть", () => world.equipItem(slot.bag, slot.slot)]);
  if (!banked) actions.push([opensForLoot ? "Открыть" : "Использовать", () => {
    if (opensForLoot) world.useItem(slot.bag, slot.slot, slot.guid);
    // L1 (2.05 E): wrapping paper waits for its item instead of being used (NativeGiftWrap.ts).
    else if (!armNativeGiftWrap(slot)) requestInventoryItemUse(slot, () => world.useItem(slot.bag, slot.slot, slot.guid));
  }]);
  // The auto-bank pair is the only route the server checks the banker on, so these are the
  // buttons rather than a swap into a chosen slot: they are what a shift-click does originally.
  if (bankOpen && !equipped) {
    actions.push(banked
      ? ["Забрать из банка", () => world.withdrawFromBank(slot.bag, slot.slot)]
      : ["Положить в банк", () => world.depositToBank(slot.bag, slot.slot)]);
  }
  if (count > 1 && !equipped) actions.push(["Разделить", () => showSplitPrompt(anchor, slot, count)]);
  if (!equipped) {
    actions.push(["Разрушить", () => {
      // Stock DELETE_ITEM/DELETE_GOOD_ITEM asks while the popup owner is published: the item goes
      // onto the stock cursor and the dialog's DeleteCursorItem destroys it (FrameXmlPopups.ts).
      if (frameXmlPopupsDestroyItem(slot.bag, slot.slot)) return;
      if (window.confirm(`Разрушить «${name}»? Это необратимо.`)) world.destroyItem(slot.bag, slot.slot);
    }]);
  }

  for (const [label, run] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      closeItemMenu();
      run();
    });
    menu.append(button);
  }

  openFloating(menu, anchor);
}

/**
 * Puts a floating box next to the thing that opened it, out of that thing's own window.
 *
 * A game window is `overflow: auto`, so a menu appended inside one is clipped by it: on the bottom
 * row of a bag the choices were cut in half, and the auction prompt — the only route to
 * `CMSG_AUCTION_SELL_ITEM` — was scrolled entirely out of sight. So the box goes on the body,
 * fixed, and is nudged back inside the viewport when it would hang off an edge.
 */
function openFloating(box: HTMLElement, anchor: HTMLElement): void {
  box.style.position = "fixed";
  box.style.visibility = "hidden";
  document.body.append(box);
  // A node that has been detached — the panels rebuild themselves — measures as all zeros, and the
  // box lands in the top-left corner instead of beside what opened it.
  const at = anchor.isConnected
    ? anchor.getBoundingClientRect()
    : { left: lastPointer.x, top: lastPointer.y, right: lastPointer.x, bottom: lastPointer.y, width: 0, height: 0 };
  const size = box.getBoundingClientRect();
  const margin = 8;
  const left = Math.max(margin, Math.min(at.left, window.innerWidth - size.width - margin));
  // Below the slot if it fits, above it if it does not.
  const below = at.bottom + 4;
  const top = below + size.height + margin <= window.innerHeight
    ? below
    : Math.max(margin, at.top - size.height - 4);
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
  box.style.visibility = "visible";
  window.setTimeout(() => window.addEventListener("click", closeItemMenu, { once: true }), 0);
}

export function closeItemMenu(): void {
  document.getElementById("item-menu")?.remove();
}

/**
 * A number to confirm, anchored to the slot it came from.
 *
 * Deliberately not the original client's cursor-carries-the-stack dance: a browser drag already
 * carries the source, so a split is the same drag with Shift held, and this is what asks how many.
 */
function prompt(anchor: HTMLElement, title: string, fields: HTMLElement[], confirm: string, run: () => void): void {
  closeItemMenu();
  const box = document.createElement("div");
  box.className = "item-menu item-prompt";
  box.id = "item-menu";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const accept = document.createElement("button");
  accept.type = "button";
  accept.textContent = confirm;
  accept.addEventListener("click", (event) => {
    event.stopPropagation();
    closeItemMenu();
    run();
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "item-prompt-cancel";
  cancel.textContent = "Отмена";
  cancel.addEventListener("click", (event) => {
    event.stopPropagation();
    closeItemMenu();
  });
  const actions = document.createElement("div");
  actions.className = "item-prompt-actions";
  actions.append(accept, cancel);
  box.append(heading, ...fields, actions);
  box.addEventListener("click", (event) => event.stopPropagation());
  openFloating(box, anchor);
}

function numberField(label: string, value: number, min: number, max: number): [HTMLElement, HTMLInputElement] {
  const row = document.createElement("label");
  row.className = "item-prompt-field";
  const text = document.createElement("span");
  text.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  row.append(text, input);
  return [row, input];
}

/** Splits a stack into a slot the player names, or into the first free one if none is given. */
function showSplitPrompt(anchor: HTMLElement, slot: ItemSlotState, count: number, destination?: ItemSlotState): void {
  const [row, input] = numberField("Сколько", Math.max(1, Math.floor(count / 2)), 1, count - 1);
  prompt(anchor, `Разделить: ${itemName(slot)}`, [row], "Разделить", () => {
    const world = game.world;
    const amount = Math.max(1, Math.min(count - 1, Math.floor(Number(input.value) || 0)));
    if (!world) return;
    const target = destination ?? firstFreeSlot(playerInventory(world.state), isBankSlot(slot.bag, slot.slot));
    if (!target) {
      systemLine("Некуда разделить стопку: нет свободного слота");
      return;
    }
    world.splitItem(slot.bag, slot.slot, target.bag, target.slot, amount);
  });
}

/**
 * Puts an item up for auction. `CMSG_AUCTION_SELL_ITEM` has been sendable since slice P4 and no
 * button has ever called it; the duration is one of the three the server accepts and nothing else.
 */
function showAuctionPrompt(anchor: HTMLElement, slot: ItemSlotState, name: string, count: number): void {
  const [countRow, countInput] = numberField("Количество", count, 1, Math.max(1, count));
  const moneyField = (label: string, def: number): [HTMLElement, HTMLInputElement, HTMLInputElement, HTMLInputElement] => {
    const row = document.createElement("div");
    row.className = "item-prompt-field item-prompt-money";
    const text = document.createElement("span");
    text.textContent = label;
    const gold = document.createElement("input");
    gold.type = "number"; gold.min = "0"; gold.max = "214748"; gold.step = "1"; gold.value = "0";
    gold.setAttribute("aria-label", `${label}, золото`);
    const silver = document.createElement("input");
    silver.type = "number"; silver.min = "0"; silver.max = "99"; silver.step = "1"; silver.value = "0";
    silver.setAttribute("aria-label", `${label}, серебро`);
    const copper = document.createElement("input");
    copper.type = "number"; copper.min = "0"; copper.max = "99"; copper.step = "1"; copper.value = String(def);
    copper.setAttribute("aria-label", `${label}, медь`);
    row.append(text, gold, silver, copper);
    return [row, gold, silver, copper];
  };
  const [bidRow, bidGold, bidSilver, bidCopper] = moneyField("Ставка", 100);
  const [buyoutRow, outGold, outSilver, outCopper] = moneyField("Выкуп", 0);
  const duration = document.createElement("select");
  for (const [minutes, label] of [[720, "12 часов"], [1440, "24 часа"], [2880, "48 часов"]] as const) {
    const option = document.createElement("option");
    option.value = String(minutes);
    option.textContent = label;
    duration.append(option);
  }
  const durationRow = document.createElement("label");
  durationRow.className = "item-prompt-field";
  const durationText = document.createElement("span");
  durationText.textContent = "Срок";
  durationRow.append(durationText, duration);
  prompt(anchor, `На аукцион: ${name}`, [countRow, bidRow, buyoutRow, durationRow], "Выставить", () => {
    const moneyOf = (gold: HTMLInputElement, silver: HTMLInputElement, copper: HTMLInputElement): number => {
      const g = Math.max(0, Math.floor(Number(gold.value) || 0));
      const s = Math.min(99, Math.max(0, Math.floor(Number(silver.value) || 0)));
      const c = Math.min(99, Math.max(0, Math.floor(Number(copper.value) || 0)));
      return Math.min(999_999_999, g * 10000 + s * 100 + c);
    };
    const bid = Math.max(1, moneyOf(bidGold, bidSilver, bidCopper));
    const buyout = moneyOf(outGold, outSilver, outCopper);
    game.world?.createAuction(slot.guid, Math.max(1, Math.floor(Number(countInput.value) || 1)), bid, buyout, Number(duration.value));
    systemLine(`Лот отправлен: ${name}, ставка ${formatMoney(bid)}`);
  });
}

/**
 * Where a dragged item lands. Shift splits instead of moving, which is the original client's
 * modifier; without it the two slots swap, because that is what the swap opcodes do to an
 * occupied destination.
 */
function dropOnSlot(target: ItemSlotState, source: ItemDrag, wantSplit: boolean, anchor: HTMLElement): void {
  const world = game.world;
  if (!world || (source.bag === target.bag && source.slot === target.slot)) return;
  if (isBuybackSlot(target)) return;
  const inventory = playerInventory(world.state);
  const from = inventory && slotAt(inventory, source.bag, source.slot);
  if (!from?.item) return;
  const count = stackCount(from);
  if (wantSplit && count > 1 && target.item === undefined) {
    showSplitPrompt(anchor, from, count, target);
    return;
  }
  world.moveItem(source.bag, source.slot, target.bag, target.slot);
}

/** A titled grid of slots: the backpack, a bag, the bank, the keyring. */
export function bagSection(
  title: string, slots: ItemSlotState[], dim?: ((slot: ItemSlotState) => boolean) | undefined,
): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("h4");
  const grid = document.createElement("div");
  section.className = "bag-section";
  grid.className = "bag-grid";
  heading.textContent = title;
  grid.append(...slots.map((slot) => itemSlot(slot, "", dim?.(slot) ?? false)));
  section.append(heading, grid);
  return section;
}

const QUALITY_NAMES = ["Бедный", "Обычный", "Необычный", "Редкий", "Эпический", "Легендарный", "Артефакт", "Наследие"];

/**
 * The quality's word, or its number when 3.3.5 has no word for it.
 *
 * A dense array of eight ends at 7, and the eight are the eight the original client has — but the
 * quality on the wire is whatever the item template says, and a module is free to write 8. Reading
 * past the end used to answer `undefined` and the tooltip simply dropped the line, so an item of an
 * unknown quality looked like an item with no quality at all.
 *
 * The tooltip no longer prints this: quality is the colour of the title and of the slot's border,
 * which is what the original client and the reference both do with it. It is the *accessible* name
 * that needs the word, because a screen reader is given no colour at all.
 */
export function qualityName(quality: number): string {
  return QUALITY_NAMES[quality] ?? `Качество ${quality}`;
}

/** Everything the client knows about an item, plus what only this slot knows: the stack and the wear. */
export function itemTooltip(slot: ItemSlotState, label: string): TooltipContent | undefined {
  const entry = slot.item?.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  if (!slot.item) return label ? { title: label, footer: ["Пустой слот"] } : undefined;
  const count = stackCount(slot);
  const footer: string[] = [];
  if (!isBuybackSlot(slot)) {
    // The repair cursor's price (2.02), as the stock bags add REPAIR_COST while InRepairMode.
    const repairLine = repairTooltipLine(slot.item);
    if (repairLine) footer.push(repairLine);
    footer.push("Нажмите для действий");
    footer.push("Shift + щелчок — вставить в чат");
    if (count > 1) footer.push("Shift и перетаскивание — разделить стопку");
    else footer.push("Перетащите, чтобы переложить");
  } else {
    footer.push("Нажмите, чтобы выкупить");
  }
  return extendItemTooltip(slot, itemTooltipFor(entry, {
    count,
    // The one line on the whole tooltip that is not in the template: an item's wear is a field of
    // the item object, and only an item the player owns has one.
    durability: slot.item.fields.get(UPDATE_FIELDS.ITEM_FIELD_DURABILITY.offset),
    // L4-review (5.22): a timed item's own time left (ITEM_FIELD_DURATION, absent read as 0, as the stock path does).
    durationLeft: slot.item.fields.get(UPDATE_FIELDS.ITEM_FIELD_DURATION.offset) ?? 0,
    enchantments: itemEnchantmentIds(slot.item),
    // An equipped item is not compared with itself.
    equipped: slot.bag === INVENTORY_SLOT_BAG_0 && slot.slot >= 0 && slot.slot < EQUIPMENT_SLOT_NAMES.length,
    footer,
  }));
}

function entryOfSlot(slot: ItemSlotState): number {
  return slot.item?.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
}

export function itemSlot(slot: ItemSlotState, label = "", dim = false): HTMLElement {
  const entry = slot.item?.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  const metadata = game.itemMetadata?.get(entry);
  const element = document.createElement("div");
  const count = stackCount(slot);
  const wear = itemWear(slot.item);
  element.className = `item-slot quality-${metadata?.quality ?? 0}`;
  // Bag search dims whatever does not match; the slot stays clickable, because a filter that
  // eats clicks teaches the player that the item is gone rather than elsewhere.
  if (dim) element.classList.add("is-dimmed");
  // A slot is a control: it can be clicked, dragged and reached by keyboard. It was a bare div
  // with a click handler, which put the whole of the bags, the bank and the doll out of reach of
  // anything but a mouse.
  if (slot.item && !isBuybackSlot(slot)) {
    element.tabIndex = 0;
    element.setAttribute("role", "button");
  }
  // The quality is a colour everywhere else on this element — the border, the title — so the
  // accessible name is the one place it has to be a word. Wear is said in words too: the bar is
  // the sighted hint, and a screen reader gets no colour or width from it.
  const accessible = [
    metadata
      ? `${metadata.name}, ${qualityName(metadata.quality)}`
      : entry ? unknownLabel("предмет", entry) : label || "Пустой слот",
    ...(wear ? [wear.durability === 0 ? "предмет сломан" : `прочность ${wear.durability} из ${wear.maximum}`] : []),
  ];
  element.setAttribute("aria-label", accessible.join(", "));
  attachTooltip(element, () => itemTooltip(slot, label), { onHide: hideItemTooltipExtension });
  if (slot.item && !isBuybackSlot(slot) && !isBankSlot(slot.bag, slot.slot)) {
    // A spell or item waiting for an item (2.05) takes the click first, before the repair cursor,
    // as the client's UseContainerItem/PickupInventoryItem ask the spell cursor first.
    let targetedAt = Number.NEGATIVE_INFINITY;
    element.addEventListener("click", (event) => {
      if (event.shiftKey || !clickItemTargetSlot(slot.item, slot.guid, element)) return;
      targetedAt = event.timeStamp;
      event.preventDefault();
      event.stopImmediatePropagation();
      hideTooltip();
      closeItemMenu();
    }, { capture: true });
    // A double click that began as the cursor's target is spent: its dblclick must not use the item.
    element.addEventListener("dblclick", (event) => {
      if (event.timeStamp - targetedAt > 1000) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
  }
  if (slot.item && !isBuybackSlot(slot)) {
    // The repair cursor (2.02) takes an item's click before its menu: the item is repaired, not used.
    element.addEventListener("click", (event) => {
      if (event.shiftKey || !clickRepairSlot(slot.item, slot.guid)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      hideTooltip();
      closeItemMenu();
    }, { capture: true });
  }
  if (slot.item && !isBuybackSlot(slot)) {
    // L1 (2.05 E): with wrapping paper waiting, a container item's click wraps it (0x005d7ff0 → 0x006dcf20),
    // after the spell and repair cursors; its double click is spent like the spell cursor's.
    let wrappedAt = Number.NEGATIVE_INFINITY;
    element.addEventListener("click", (event) => {
      if (event.shiftKey || !wrapNativeSlot(slot)) return;
      wrappedAt = event.timeStamp;
      event.preventDefault();
      event.stopImmediatePropagation();
      hideTooltip();
      closeItemMenu();
    }, { capture: true });
    element.addEventListener("dblclick", (event) => {
      if (event.timeStamp - wrappedAt > 1000) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
  }
  if (isBankSlot(slot.bag, slot.slot)) {
    element.addEventListener("click", (event) => {
      if (event.shiftKey || !clickFrameXmlNativeBankSlot(slot)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      hideTooltip();
      closeItemMenu();
    }, { capture: true });
  }
  if (slot.item) {
    const icon = document.createElement("span");
    icon.className = "item-icon";
    icon.textContent = "?";
    if (metadata && game.itemMetadata) {
      const image = document.createElement("img");
      image.alt = "";
      setIconSource(image, game.itemMetadata.iconUrl(metadata));
      image.addEventListener("error", () => image.remove(), { once: true });
      icon.append(image);
    }
    element.append(icon);
    if (count > 1) {
      const stack = document.createElement("span");
      stack.className = "stack-count";
      stack.textContent = String(count);
      element.append(stack);
    }
    // Wear and enchantment presence are both state the player should not have to hover for: a
    // broken tool, a red bar, or a gem socketed is worth seeing across a full bag at a glance.
    if (wear && wear.durability < wear.maximum) {
      const bar = document.createElement("span");
      bar.className = wear.durability === 0 ? "item-wear broken" : "item-wear";
      setTip(bar, wear.durability === 0 ? "Предмет сломан" : `Прочность ${wear.durability} из ${wear.maximum}`);
      const fill = document.createElement("i");
      fill.style.width = `${Math.round((wear.durability / wear.maximum) * 100)}%`;
      bar.append(fill);
      element.append(bar);
      if (wear.durability === 0) element.classList.add("is-broken");
    }
    if (itemEnchantPresence(slot.item) !== 0) {
      const marker = document.createElement("span");
      marker.className = "item-enchant";
      setTip(marker, "Есть чары или камни");
      element.append(marker);
    }
    // Equipment is where an item level reads as the answer to "is this an upgrade"; the tooltip
    // already carries it, and the template query behind it is the one the bag pass asks for anyway.
    const itemLevel = isEquipmentSlot(slot) ? game.world?.itemTemplate(entry)?.itemLevel : undefined;
    if (itemLevel !== undefined && Number.isFinite(itemLevel) && itemLevel > 0) {
      const badge = document.createElement("span");
      badge.className = "item-level";
      badge.textContent = String(itemLevel);
      setTip(badge, `Уровень предмета ${itemLevel}`);
      element.append(badge);
    }
  }
  if (slot.item && slot.guid !== 0n && !isBuybackSlot(slot)) {
    const open = (event: Event): void => {
      event.stopPropagation();
      hideTooltip();
      showItemMenu(element, slot, itemName(slot));
    };
    element.addEventListener("click", (event) => {
      // Shift writes the item into whatever the player is typing, as in the original client. The
      // enchant and the random property go out as zero: their fields are in the update block and
      // nothing reads them yet, and a wrong suffix in a link is worse than no suffix.
      if (event.shiftKey) {
        event.stopPropagation();
        hideTooltip();
        insertIntoChat(itemChatLink(entry, metadata?.quality ?? 1,
          metadata?.name ?? unknownLabel("предмет", entry)));
        return;
      }
      // A second click of a double is the gesture the original client uses to consume, equip or
      // open a thing, and it must not also open the menu the first click already opened.
      if (event.detail >= 2) {
        event.stopPropagation();
        return;
      }
      open(event);
    });
    // The original client's own way of using an item, and the one that depends on nothing: no
    // menu, no layer, no anchor. Equipping is what "use" means for a wearable — the server decides
    // which, from the item itself — so this is the same call the menu entry makes.
    element.addEventListener("dblclick", (event) => {
      if (event.shiftKey) return;
      event.stopPropagation();
      hideTooltip();
      closeItemMenu();
      // A banked item is not used from the bank; the original client moves it out first.
      if (isBankSlot(slot.bag, slot.slot)) return;
      const world = game.world;
      if (world) {
        const template = world.itemTemplate(entry);
        if (itemOpensForLoot(slot.item?.fields.get(UPDATE_FIELDS.ITEM_FIELD_FLAGS.offset), template?.flags)) {
          world.useItem(slot.bag, slot.slot, slot.guid);
        } else if (!armNativeGiftWrap(slot)) requestInventoryItemUse(slot, () => world.useItem(slot.bag, slot.slot, slot.guid)); // L1 (2.05 E)
      }
    });
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open(event);
      }
    });
  }
  attachDragAndDrop(element, slot);
  if (label) {
    const name = document.createElement("span");
    name.className = "slot-label";
    name.textContent = metadata?.name ?? label;
    element.append(name);
  }
  return element;
}

/**
 * Makes one element a drag source and a drop target for its slot.
 *
 * Shared with the bag bar, whose buttons are the four bag *container* slots — 19 to 22 of the
 * player's own inventory — so dropping a bag onto the bar equips it, exactly as in the original.
 */
export function attachDragAndDrop(element: HTMLElement, slot: ItemSlotState): void {
  if (isBuybackSlot(slot)) return;
  const entry = slot.item?.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  if (slot.item) {
    element.draggable = true;
    element.addEventListener("dragstart", (event) => {
      closeItemMenu();
      event.dataTransfer?.setData(ITEM_DRAG_FORMAT, JSON.stringify({ bag: slot.bag, slot: slot.slot }));
      // The same drag can land on an action bar, where an item is stored by entry rather than by
      // where it happens to sit.
      if (entry > 0) event.dataTransfer?.setData(...itemActionDragPayload(entry));
      // 4.02: the item's icon with its stack count and quality border on the cursor.
      beginIconDrag(event, element);
    });
  }
  element.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes(ITEM_DRAG_FORMAT)) event.preventDefault();
  });
  element.addEventListener("drop", (event) => {
    const raw = event.dataTransfer?.getData(ITEM_DRAG_FORMAT);
    if (!raw) return;
    event.preventDefault();
    dropOnSlot(slot, JSON.parse(raw) as ItemDrag, event.shiftKey, element);
  });
}
