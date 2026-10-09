import {
  EQUIPMENT_SET_SLOTS, MAX_EQUIPMENT_SETS, type EquipmentSet,
} from "../../world/CharacterProgressProtocol.js";
import { game } from "../game/Context.js";
import { locateItem, playerInventory } from "../Inventory.js";
import { equipmentSets as container } from "./Dom.js";
import { setTip, attachTooltip, closeFloating, confirmPanel, openFloating } from "./Widgets.js";
import { equipmentSetPieces, equipmentSlotName, ignoredSlotsOf } from "./EquipmentSetModel.js";

/**
 * The equipment manager: saved sets of worn gear, and the two buttons that use one.
 *
 * The protocol here is stranger than it looks. `SMSG_EQUIPMENT_SET_LIST` arrives once at login and
 * is never re-sent, so a set saved during the session exists only because the client keeps it.
 * `CMSG_EQUIPMENT_SET_USE` does not name the set at all: it is nineteen times "this item guid, and
 * here is where it is", so wearing a set is the client resolving it against the bags and telling
 * the server the answer. A piece the client cannot find is a slot the server *unequips* rather
 * than one it leaves alone — leaving a slot alone is a separate value, a raw guid of one, which is
 * why an empty set slot and an ignored set slot are different things on the wire.
 */

/** What the original client puts in the icon field. Nothing here reads it; the server stores it. */
const DEFAULT_SET_ICON = "Interface\\Icons\\INV_Misc_QuestionMark";

export function showEquipmentSets(): void {
  const world = game.world;
  if (!world) {
    container.replaceChildren();
    return;
  }
  const rows: HTMLElement[] = [];
  for (const set of [...world.equipmentSets].sort((left, right) => left.setId - right.setId)) {
    rows.push(setRow(set));
  }
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Наборов пока нет";
    rows.push(empty);
  }
  rows.push(saveRow());
  container.replaceChildren(...rows);
}

function setRow(set: EquipmentSet): HTMLElement {
  const row = document.createElement("div");
  row.className = "equipment-set";
  const name = document.createElement("strong");
  name.textContent = set.name || `Набор ${set.setId + 1}`;
  const wear = document.createElement("button");
  wear.type = "button";
  wear.textContent = "Надеть";
  wear.addEventListener("click", () => wearSet(set));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Удалить";
  // A set that has never come back from the server has no guid, and the delete opcode is a guid.
  remove.disabled = set.guid === 0n;
  remove.className = "danger";
  remove.addEventListener("click", () => confirmPanel(remove, {
    title: `Удалить набор «${set.name || `Набор ${set.setId + 1}`}»?`,
    confirm: "Удалить",
    danger: true,
    onConfirm: () => game.world?.deleteEquipmentSet(set.guid),
  }));
  const overwrite = document.createElement("button");
  overwrite.type = "button";
  overwrite.textContent = "Записать";
  setTip(overwrite, "Сохранить надетое в этот набор");
  // 4.08: «Записать» keeps the slots the set leaves alone; it used to save them as worn.
  overwrite.addEventListener("click", () => saveSet(set.setId, set.name, set.guid, ignoredSlotsOf(set.pieces)));
  const slots = document.createElement("button");
  slots.type = "button";
  slots.textContent = "Ячейки…";
  setTip(slots, "Какие ячейки набор не меняет");
  slots.addEventListener("click", () => openIgnoredSlots(slots, set));
  row.append(name, wear, overwrite, slots, remove);
  return row;
}

/**
 * The slots a set leaves alone, as stock's slot flyout «ignore this slot» sets them: a box per
 * slot, and «Записать» saves what is worn with the ticked slots ignored.
 */
function openIgnoredSlots(anchor: HTMLElement, set: EquipmentSet): void {
  const box = document.createElement("div");
  box.className = "ui-menu ui-confirm equipment-set-slots";
  const heading = document.createElement("strong");
  heading.textContent = `Не менять в «${set.name || `Набор ${set.setId + 1}`}»`;
  box.append(heading);
  const ignored = ignoredSlotsOf(set.pieces);
  for (let slot = 0; slot < EQUIPMENT_SET_SLOTS; slot++) {
    const label = document.createElement("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = ignored.has(slot);
    check.addEventListener("change", () => {
      if (check.checked) ignored.add(slot);
      else ignored.delete(slot);
    });
    label.append(check, equipmentSlotName(slot));
    box.append(label);
  }
  const actions = document.createElement("div");
  actions.className = "ui-confirm-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Записать";
  save.addEventListener("click", (event) => {
    event.stopPropagation();
    closeFloating();
    saveSet(set.setId, set.name, set.guid, ignored);
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Отмена";
  cancel.addEventListener("click", (event) => {
    event.stopPropagation();
    closeFloating();
  });
  actions.append(save, cancel);
  box.append(actions);
  openFloating(box, anchor);
}

function saveRow(): HTMLElement {
  const row = document.createElement("div");
  row.className = "equipment-set equipment-set-new";
  const input = document.createElement("input");
  input.maxLength = 31;
  input.placeholder = "Имя набора";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Сохранить надетое";
  const used = new Set((game.world?.equipmentSets ?? []).map((set) => set.setId));
  const free = Array.from({ length: MAX_EQUIPMENT_SETS }, (_, index) => index).find((index) => !used.has(index));
  if (free === undefined) {
    save.setAttribute("aria-disabled", "true");
    attachTooltip(save, () => ({
      title: "Сохранить надетое",
      footer: [`Больше ${MAX_EQUIPMENT_SETS} наборов не бывает — удалите один`],
    }));
  }
  save.addEventListener("click", () => {
    if (free === undefined) return;
    saveSet(free, input.value.trim() || `Набор ${free + 1}`, 0n);
    input.value = "";
  });
  row.append(input, save);
  return row;
}

/**
 * Saves whatever the character has on, except the slots the set leaves alone. The server checks
 * every other piece against the worn slot.
 */
function saveSet(index: number, name: string, setGuid: bigint, ignored: ReadonlySet<number> = new Set()): void {
  const world = game.world;
  const inventory = world && playerInventory(world.state);
  if (!world || !inventory) return;
  const pieces = equipmentSetPieces((slot) => inventory.equipment[slot]?.guid, ignored);
  world.saveEquipmentSet(setGuid, index, name, DEFAULT_SET_ICON, pieces);
}

function wearSet(set: EquipmentSet): void {
  const world = game.world;
  const inventory = world && playerInventory(world.state);
  if (!world || !inventory) return;
  const pieces = Array.from({ length: EQUIPMENT_SET_SLOTS }, (_, index) => {
    const guid = set.pieces[index] ?? 0n;
    const found = locateItem(inventory, guid);
    return { guid, bag: found?.bag ?? 0, slot: found?.slot ?? 0 };
  });
  world.useEquipmentSet(pieces);
}

/** Wears the set with this action-bar index, if it exists. Returns false when there is none. */
export function wearEquipmentSetByIndex(index: number): boolean {
  const set = game.world?.equipmentSets.find((entry) => entry.setId === index);
  if (!set) return false;
  wearSet(set);
  return true;
}
