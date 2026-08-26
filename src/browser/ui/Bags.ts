import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { WorldState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import {
  EQUIPMENT_SLOT_NAMES, INVENTORY_SLOT_BAG_0, INVENTORY_SLOT_BAG_START, freeSlots, playerInventory,
  type BagState, type ItemSlotState, type PlayerInventoryState, entryOf, inventorySignature, stackCount,
} from "../Inventory.js";
import {
  bagBar, characterWindow, equipmentSlots, inventoryMessage, inventoryMoney, inventorySlots,
  inventoryWindow,
} from "./Dom.js";
import { showCharacterSheet } from "./CharacterSheet.js";
import { formatMoney } from "./Format.js";
import { showEquipmentSets } from "./EquipmentSets.js";
import { refreshBank } from "./Bank.js";
import { attachDragAndDrop, bagSection, itemSlot } from "./ItemSlots.js";
import { skinnable, slotElement } from "./Slots.js";
import { Panel } from "./Widgets.js";
import { setIconSource } from "./IconImage.js";

/**
 * The bags: the equipment doll, the backpack, the four carried bags, the keyring and the bar that
 * opens them.
 *
 * The four bags are windows of their own rather than sections of one list, because that is what
 * makes moving an item between two of them a drag instead of a puzzle — and because the original
 * client's bag bar opens exactly these. Nothing about them is on the wire: a bag is an ordinary
 * item in slot 19 to 22 of the player's own inventory, and its contents are the container object's
 * own `CONTAINER_FIELD_SLOT_1` run.
 */

export { closeItemMenu } from "./ItemSlots.js";

/** One panel per bag slot, built on first open and kept: the slot number is what makes it stable. */
const bagPanels = new Map<number, Panel>();
let keyringPanel: Panel | undefined;

// The inventory window is markup, so a patch's `class:` can reach it from here (М7).
skinnable("inventory-window", inventoryWindow);

export function showItemMessage(): void {
  const message = game.world?.itemMessage;
  inventoryMessage.className = message ? (message.error ? "error" : "success") : "muted";
  inventoryMessage.textContent = message?.text ?? "";
}

/** `B`: everything the character carries at once, which is what the original key does. */
export function toggleAllBags(): void {
  const inventory = game.world && playerInventory(game.world.state);
  const open = !inventoryWindow.hidden || [...bagPanels.values()].some((panel) => panel.visible);
  inventoryWindow.hidden = open;
  for (const bag of inventory?.bags ?? []) bagWindow(bag.bagSlot).root.hidden = open;
  if (!open && game.world) renderInventory(game.world.state);
}

export function toggleKeyring(): void {
  keyring().toggle();
  if (game.world) renderInventory(game.world.state);
}

/** Whether any bag window is up, so Escape knows there is something to close. */
export function anyBagWindowOpen(): boolean {
  return [...bagPanels.values(), ...(keyringPanel ? [keyringPanel] : [])].some((panel) => panel.visible);
}

export function closeBagWindows(): void {
  for (const panel of bagPanels.values()) panel.hide();
  keyringPanel?.hide();
}

function bagWindow(bagSlot: number): Panel {
  let panel = bagPanels.get(bagSlot);
  if (!panel) {
    panel = new Panel({ id: `bag-window-${bagSlot}`, title: "Сумка", className: "bag-window" });
    // Four windows sharing one stylesheet rule would open on top of each other, and the layout
    // manager pins whatever the stylesheet laid out the first time. Stepping them apart here is
    // the only chance to say where each one starts; after that the player owns the position.
    const index = bagSlot - INVENTORY_SLOT_BAG_START;
    panel.root.style.right = `${18 + index * 26}px`;
    panel.root.style.bottom = `${120 + index * 34}px`;
    bagPanels.set(bagSlot, panel);
    // One slot name for all four windows, told apart by `slot.bag` — the number the player sees on
    // the bag bar, 1 to 4. A name per bag would make a patch that wants a footer in every bag write
    // four identical entries, and one that wants it in the second still reads a parameter.
    panel.root.append(slotElement("bag-window/footer", { bag: index + 1 }));
    skinnable("bag-window", panel.root);
  }
  return panel;
}

function keyring(): Panel {
  keyringPanel ??= new Panel({ id: "keyring-window", title: "Брелок", className: "bag-window keyring-window" });
  return keyringPanel;
}


/** The bar of bag buttons. Each button is also the container's own slot, so a bag can be dropped in. */
function showBagBar(inventory: PlayerInventoryState): void {
  const buttons: HTMLElement[] = [
    barButton("🎒", "Рюкзак", freeSlots(inventory.backpack), inventory.backpack.length, () => {
      inventoryWindow.hidden = !inventoryWindow.hidden;
      if (game.world) renderInventory(game.world.state);
    }),
  ];
  for (let index = 0; index < 4; index++) {
    const bagSlot = INVENTORY_SLOT_BAG_START + index;
    const held = inventory.bags.find((bag) => bag.bagSlot === bagSlot);
    const entry = entryOf(held?.bag);
    const metadata = game.itemMetadata?.get(entry);
    const button = barButton(
      metadata && game.itemMetadata ? game.itemMetadata.iconUrl(metadata) : "",
      metadata?.name ?? `Слот сумки ${index + 1}`,
      held ? freeSlots(held.slots) : 0,
      held?.slots.length ?? 0,
      () => {
        if (!held) return;
        bagWindow(bagSlot).toggle();
        if (game.world) renderInventory(game.world.state);
      },
    );
    // The bag slot itself, 19 to 22 of `INVENTORY_SLOT_BAG_0`: dropping a bag here equips it.
    const slot: ItemSlotState = {
      index, item: held?.bag, guid: held?.guid ?? 0n, bag: INVENTORY_SLOT_BAG_0, slot: bagSlot,
    };
    attachDragAndDrop(button, slot);
    buttons.push(button);
  }
  buttons.push(barButton("🔑", "Брелок", freeSlots(inventory.keyring), inventory.keyring.length, toggleKeyring));
  bagBar.replaceChildren(...buttons);
}

function barButton(icon: string, title: string, free: number, size: number, onClick: () => void): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "bag-bar-button";
  button.title = size > 0 ? `${title} · ${free} из ${size} свободно` : title;
  if (icon.includes("/")) {
    const image = document.createElement("img");
    image.alt = "";
    setIconSource(image, icon);
    image.addEventListener("error", () => image.remove(), { once: true });
    button.append(image);
  } else {
    const glyph = document.createElement("span");
    glyph.textContent = icon;
    button.append(glyph);
  }
  if (size > 0) {
    const count = document.createElement("em");
    count.className = "bag-bar-free";
    count.textContent = String(free);
    button.append(count);
  }
  button.addEventListener("click", onClick);
  return button;
}

/** What the slots held when they were last drawn, so an unchanged inventory is not rebuilt. */
let renderedSignature = "";
/** Which windows were open, because opening one is a reason to draw even when nothing moved. */
let renderedWindows = "";
/** Bumped when item names and icons land, which is the other thing that changes what a slot looks like. */
let metadataRevision = 0;
let renderedMetadata = -1;

/** Called when item metadata lands: the same slots then draw differently. */
export function itemMetadataChanged(): void {
  metadataRevision++;
}

export function renderInventory(state: WorldState): void {
  const inventory = playerInventory(state);
  const player = state.selfGuid === undefined ? undefined : state.objects.get(state.selfGuid);
  if (!inventory || !player) return;
  const allSlots = [
    ...inventory.equipment, ...inventory.backpack, ...inventory.keyring, ...inventory.bank,
    ...inventory.bags.flatMap((bag) => bag.slots), ...inventory.bankBags.flatMap((bag) => bag.slots),
    ...inventory.buyback,
  ];
  const entries = [
    ...allSlots.map((slot) => entryOf(slot.item)),
    ...inventory.bags.map((bag) => entryOf(bag.bag)),
    ...inventory.bankBags.map((bag) => entryOf(bag.bag)),
  ].filter((entry) => entry > 0);
  // Names and icons are fetched even with the bags closed, because loot, vendor, trade and quest
  // windows read the same cache. Only the slot grids themselves wait until they are on screen.
  void loadItemMetadata(entries, state);

  // Nothing below this line is worth doing when nothing about the inventory has moved.
  //
  // `showWorldState` calls this once a frame for as long as packets keep arriving, and everything
  // after this point is `replaceChildren`: every slot in the bags, the bank and on the character
  // was destroyed and rebuilt sixty times a second. That is visible twice over. An icon flickers,
  // because the element carrying it is thrown away and remade between paints. And an icon that has
  // to be fetched — which is every item whose `iconId` is zero, 22,489 of 38,609 on this dataset —
  // never appears at all: by the time the picture arrives the `<img>` that asked for it has been
  // detached, and the new one starts the wait over.
  //
  // Money and the character sheet move without any slot moving — coin from a quest, a stat from a
  // buff — so they are refreshed above the guard rather than behind it, and are not in the key.
  inventoryMoney.textContent = formatMoney(player.fields.get(UPDATE_FIELDS.PLAYER_FIELD_COINAGE.offset) ?? 0);
  showCharacterSheet();

  // The signature is the slots themselves: what is in them, how many, and which bags are carried.
  const signature = inventorySignature(allSlots, inventory);
  const windowsOpen = `${characterWindow.hidden}/${inventoryWindow.hidden}/${keyringPanel?.visible ?? false}`
    + [...bagPanels].map(([bagSlot, panel]) => `${bagSlot}:${panel.visible}`).join(",");
  if (signature === renderedSignature && windowsOpen === renderedWindows && metadataRevision === renderedMetadata) return;
  renderedSignature = signature;
  renderedWindows = windowsOpen;
  renderedMetadata = metadataRevision;

  // The bar is part of the permanent interface rather than a window, so it is always current.
  showBagBar(inventory);
  refreshBank(inventory);

  for (const [bagSlot, panel] of bagPanels) {
    const bag = inventory.bags.find((candidate) => candidate.bagSlot === bagSlot);
    // A bag the character no longer carries takes its window down with it.
    if (!bag) {
      panel.hide();
      continue;
    }
    if (panel.visible) showBagPanel(panel, bag);
  }
  if (keyringPanel?.visible) {
    keyringPanel.title = `Брелок · ${freeSlots(inventory.keyring)} своб.`;
    keyringPanel.body.replaceChildren(grid(inventory.keyring));
  }

  if (characterWindow.hidden && inventoryWindow.hidden) return;
  equipmentSlots.replaceChildren(...inventory.equipment.map((slot, index) =>
    itemSlot(slot, EQUIPMENT_SLOT_NAMES[index] ?? `Слот ${index + 1}`)));
  showEquipmentSets();
  inventorySlots.replaceChildren(bagSection("Рюкзак", inventory.backpack));

}

function showBagPanel(panel: Panel, bag: BagState): void {
  const metadata = game.itemMetadata?.get(entryOf(bag.bag));
  panel.title = `${metadata?.name ?? `Сумка ${bag.bagSlot - INVENTORY_SLOT_BAG_START + 1}`} · ${freeSlots(bag.slots)} своб.`;
  panel.body.replaceChildren(grid(bag.slots));
}

function grid(slots: readonly ItemSlotState[]): HTMLElement {
  const element = document.createElement("div");
  element.className = "bag-grid";
  element.append(...slots.map((slot) => itemSlot(slot)));
  return element;
}

export async function loadItemMetadata(entries: number[], state: WorldState): Promise<void> {
  const client = game.itemMetadata;
  if (!client) return;
  try {
    if (await client.load(entries) && game.itemMetadata === client) {
      // The slots have not moved, but what they draw has: names and icons just arrived. Without
      // this the redraw below is skipped as "nothing changed" and the bags stay full of "?".
      itemMetadataChanged();
      renderInventory(state);
    }
  } catch (error) {
    inventoryMoney.className = "inventory-money error";
    inventoryMoney.textContent = error instanceof Error ? error.message : String(error);
  }
}
