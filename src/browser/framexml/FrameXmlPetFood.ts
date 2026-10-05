import type { WorldObjectState } from "../../world/WorldState.js";
import { frameXmlIsHunterPet } from "./FrameXmlHasPetUI.js";

/**
 * 05.10-petfood: `GetPetFoodTypes()` as Wow.exe 3.3.5a 12340 answers it — 0x005d3bd0, the Lua name
 * beside it at .data 0x00ad0d00 (Ghidra read-only, .runtime/re-2026-10-05/l-petfood/g1.c).
 *
 * The client looks the PetInfo pet up as a unit (our `petSpells.guid`, as HasPetUI 0x005d3960 does),
 * asks 0x0071b630 whether it is a hunter's pet (a pet number and a hunter creator,
 * FrameXmlHasPetUI.ts), reads the family of its creature cache entry (0x007153e0: nothing cached is
 * family 0), finds that CreatureFamily row and returns, in ItemPetFood's own order, the name of every
 * row whose bit `1 << (ID - 1)` is set in the row's PetFoodMask. Any step that fails — no pet, not a
 * hunter's, no cache entry, no family row, an empty mask — returns no values at all, and the stock
 * tooltip's `format(PET_DIET_TEMPLATE, BuildListString(...))` then raises in the real client too.
 *
 * One deviation, for this client only: before `/dbc/pet-foods` answers (a gateway older than the
 * route), a hunter's pet whose family is known answers one empty string, so the stock tooltip reads
 * an empty list instead of raising over a table this client has not received. No food is guessed.
 *
 * `GetStablePetFoodTypes(index)` (0x005a16a0, PetStable.lua:101, :151-152) shares the family-to-names
 * half below; its slot pet and family are the stable model's (FrameXmlStable.ts).
 */

/** What the diet lookup needs from the pet diet table (PetFoodClient.ts `PetFoodTable`). */
export interface FrameXmlPetFoodNames {
  familyMask(family: number): number;
  foodNames(mask: number): readonly string[];
}

const NOTHING: readonly string[] = Object.freeze([]);
/** The stale-gateway answer: an empty list, not a raise and not a guess. */
const NO_TABLE: readonly string[] = Object.freeze([""]);

/**
 * `GetPetFoodTypes()` for the pet-bar unit. `family` is the pet's creature cache family (0 or
 * undefined when nothing is cached); `table` is undefined until the route answers.
 */
export function frameXmlPetFoodTypes(
  pet: WorldObjectState | undefined,
  objectFor: (guid: bigint) => WorldObjectState | undefined,
  family: number | undefined,
  table: FrameXmlPetFoodNames | undefined,
): readonly string[] {
  // 0x005d3bd0's gate before the family: a PetInfo pet that 0x0071b630 calls a hunter's.
  return frameXmlIsHunterPet(pet, objectFor) ? frameXmlFamilyFoodNames(family, table) : NOTHING;
}

/**
 * The part both diet calls share (0x005d3bd0 and `GetStablePetFoodTypes` 0x005a16a0): the family's
 * CreatureFamily row, its PetFoodMask, the ItemPetFood names in table order; no values for no family,
 * no row or an empty mask; the stale-gateway empty string while the table is absent.
 */
export function frameXmlFamilyFoodNames(family: number | undefined, table: FrameXmlPetFoodNames | undefined): readonly string[] {
  if (!family || family <= 0) return NOTHING;
  if (!table) return NO_TABLE;
  const mask = table.familyMask(family);
  return mask === 0 ? NOTHING : table.foodNames(mask);
}
