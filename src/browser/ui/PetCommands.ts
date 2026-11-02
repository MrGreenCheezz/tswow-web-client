/**
 * Pressing a button of the pet bar, which is also the vehicle bar (PetProtocol.ts): what the keys
 * BONUSACTIONBUTTON1-10 do, whatever draws the bar.
 */

import {
  ACT_COMMAND, ACT_REACTION, COMMAND_ABANDON, petActionOf, petActionTypeOf,
} from "../../world/PetProtocol.js";
import { game } from "../game/Context.js";

/**
 * Asks before dismissing the pet, when something on screen can ask: answers true when it has taken
 * the question, and `abandon` runs if the player agrees. PetBar.ts registers its own (this module
 * stays free of the page's DOM); without one the command simply goes out.
 */
export type PetAbandonConfirm = (slot: number, abandon: () => void) => boolean;

let abandonConfirm: PetAbandonConfirm | undefined;

export function setPetAbandonConfirm(confirm: PetAbandonConfirm | undefined): void {
  abandonConfirm = confirm;
}

/**
 * `PetActionButtonDown(id)` from the keyboard (BONUSACTIONBUTTON1-10, 3.11): the button the click
 * presses, `id` 1–10. False when there is no pet bar or nothing in that button.
 */
export function pressPetButton(id: number): boolean {
  const button = game.world?.petSpells?.bar[id - 1];
  if (!button || game.world?.petSpells?.closed) return false;
  // An empty button is hidden on the bar (showPetBar); a key on it presses nothing either.
  if (petActionOf(button.packed) === 0 && petActionTypeOf(button.packed) !== ACT_COMMAND
    && petActionTypeOf(button.packed) !== ACT_REACTION) return false;
  pressPetSlot(id - 1);
  return true;
}

export function pressPetSlot(slot: number): void {
  const world = game.world;
  const button = world?.petSpells?.bar[slot];
  if (!world || !button) return;
  const type = petActionTypeOf(button.packed);
  const action = petActionOf(button.packed);
  // Dismissing is the one command worth asking about: a hunter's pet has to be summoned again and
  // a temporary one does not come back at all.
  if (type === ACT_COMMAND && action === COMMAND_ABANDON
    && abandonConfirm?.(slot, () => world.usePetSlot(slot))) return;
  world.usePetSlot(slot);
}
