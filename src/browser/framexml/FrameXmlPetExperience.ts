import { readField } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/**
 * GetPetExperience's two return values are owner update fields on the pet
 * object, not the player's PLAYER_XP fields. The values remain unknown until
 * both slots arrive. Stock PetPaperDollFrame.lua:630 requires a numeric pair;
 * its no-pet neutral answer is [0, 0].
 */
export function frameXmlPetExperience(
  pet: WorldObjectState | undefined,
): readonly [current: number, nextLevel: number] | undefined {
  if (!pet) return undefined;
  const current = readField(pet, "UNIT_FIELD_PETEXPERIENCE");
  const nextLevel = readField(pet, "UNIT_FIELD_PETNEXTLEVELEXP");
  if (current === undefined || nextLevel === undefined) return undefined;
  return [current, nextLevel];
}
