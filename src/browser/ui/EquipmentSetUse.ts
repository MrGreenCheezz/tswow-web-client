/**
 * Wearing a saved set, which an action bar slot can do whatever draws the bar. The protocol's
 * oddities are told in EquipmentSets.ts, the window that saves them.
 */

import { EQUIPMENT_SET_SLOTS, type EquipmentSet } from "../../world/CharacterProgressProtocol.js";
import { game } from "../game/Context.js";
import { locateItem, playerInventory } from "../Inventory.js";

export function wearSet(set: EquipmentSet): void {
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
