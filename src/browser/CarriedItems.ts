import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { WorldState } from "../world/WorldState.js";
import { fieldGuid, INVENTORY_SLOT_BAG_0, type ItemSlotState, type PlayerInventoryState } from "./Inventory.js";

/**
 * The currency-token slots of the player's own inventory and the places an item target can be
 * (plan item 2.05, lane L1). Player.h: CURRENCYTOKEN_SLOT_START 118 .. 149, one item guid each in
 * PLAYER_FIELD_CURRENCYTOKEN_SLOT_1 — where the realm keeps emblems, badges and other token items.
 *
 * `SpellTargetItem`'s walk (Wow.exe 0x007546f0 with flags 0x247) visits them: its order table at
 * 0x00a37b14 — pairs of «last slot, next slot» (38→19, 22→86, 117→39, 66→67, 73→118, 149→0, 18→74,
 * 85→end) — runs backpack 23..38, the bag slots 19..22 (each bag, then its contents), the keyring
 * 86..117, the bank 39..73, the currency tokens 118..149, the worn items 0..18 and the buyback shelf;
 * 0x00753a50 lets 0x247 through for the worn items (bit 0x1), the bag slots (0x2), the backpack (0x4),
 * the keyring (0x40) and the currency tokens (0x200), not the bank (0x8) nor the buyback shelf.
 * The realm takes any of those as an item target (`Player::GetItemByGuid`, Player.cpp:10095-10124).
 */

export const CURRENCY_TOKEN_SLOT_START = 118;
export const CURRENCY_TOKEN_SLOTS = 32;

/** The 32 currency-token slots in slot order, each as the item opcodes address it (bag 255). */
export function currencyTokenSlots(state: WorldState | undefined): ItemSlotState[] {
  const self = state?.selfGuid === undefined ? undefined : state.objects.get(state.selfGuid);
  if (!state || !self) return [];
  const base = UPDATE_FIELDS.PLAYER_FIELD_CURRENCYTOKEN_SLOT_1.offset;
  const slots: ItemSlotState[] = [];
  for (let index = 0; index < CURRENCY_TOKEN_SLOTS; index++) {
    const guid = fieldGuid(self, base + index * 2);
    slots.push({
      index, guid, item: guid === 0n ? undefined : state.objects.get(guid),
      bag: INVENTORY_SLOT_BAG_0, slot: CURRENCY_TOKEN_SLOT_START + index,
    });
  }
  return slots;
}

/**
 * Whether `guid` is one of the player's items the walk reaches outside the worn items, the backpack
 * and the bags' contents: a bag itself (19..22), the keyring, a currency token.
 */
export function carriedOutsideBags(state: WorldState, inventory: PlayerInventoryState, guid: bigint): boolean {
  if (guid === 0n) return false;
  if (inventory.bags.some((bag) => bag.guid === guid)) return true;
  if (inventory.keyring.some((slot) => slot.guid === guid && slot.item !== undefined)) return true;
  return currencyTokenSlots(state).some((slot) => slot.guid === guid && slot.item !== undefined);
}
