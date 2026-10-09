/**
 * What an equipment set saves for each of its nineteen slots (WORK_PLAN 4.08), DOM-free.
 *
 * `CMSG_EQUIPMENT_SET_SAVE` carries a packed guid per slot: 0 for an empty slot, the worn item's
 * guid, or the raw value 1 for a slot the set leaves alone — the server turns that into a bit of
 * its `IgnoreMask` (`HandleEquipmentSetSave`, CharacterHandler.cpp:1544-1556), skips the slot when
 * the set is worn (`HandleEquipmentSetUse`, :1592-1594) and sends 1 back for it in the set list
 * (Player.cpp:26376-26377). Stock sets the bits from the slot flyout's «ignore this slot» before a
 * save (PaperDollFrame.lua:106-108, 1109-1122).
 */

import { EQUIPMENT_SET_IGNORED, EQUIPMENT_SET_SLOTS } from "../../world/CharacterProgressProtocol.js";
import { nativeString } from "./Strings.js";

/** The slots a saved set leaves alone: where its pieces carry the raw 1. */
export function ignoredSlotsOf(pieces: readonly bigint[]): Set<number> {
  const ignored = new Set<number>();
  for (let slot = 0; slot < EQUIPMENT_SET_SLOTS; slot++) if (pieces[slot] === EQUIPMENT_SET_IGNORED) ignored.add(slot);
  return ignored;
}

/** The nineteen guids a save sends: 1 for an ignored slot, else what is worn there, else 0. */
export function equipmentSetPieces(
  worn: (slot: number) => bigint | undefined, ignored: ReadonlySet<number>,
): bigint[] {
  return Array.from({ length: EQUIPMENT_SET_SLOTS }, (_, slot) =>
    ignored.has(slot) ? EQUIPMENT_SET_IGNORED : worn(slot) ?? 0n);
}

/** The stock names of equipment slots 0..18 (GlobalStrings `*SLOT`), with the ruRU words as fallback. */
const SLOT_NAMES: readonly (readonly [string, string])[] = [
  ["HEADSLOT", "Голова"], ["NECKSLOT", "Шея"], ["SHOULDERSLOT", "Плечи"], ["SHIRTSLOT", "Рубашка"],
  ["CHESTSLOT", "Грудь"], ["WAISTSLOT", "Пояс"], ["LEGSSLOT", "Ноги"], ["FEETSLOT", "Ступни"],
  ["WRISTSLOT", "Запястья"], ["HANDSSLOT", "Кисти рук"], ["FINGER0SLOT", "Палец"], ["FINGER1SLOT", "Палец"],
  ["TRINKET0SLOT", "Аксессуар"], ["TRINKET1SLOT", "Аксессуар"], ["BACKSLOT", "Спина"],
  ["MAINHANDSLOT", "Правая рука"], ["SECONDARYHANDSLOT", "Левая рука"], ["RANGEDSLOT", "Оружие дальнего боя"],
  ["TABARDSLOT", "Гербовая накидка"],
];

export function equipmentSlotName(slot: number): string {
  const entry = SLOT_NAMES[slot];
  return entry ? nativeString(entry[0], entry[1]) : `${slot + 1}`;
}
