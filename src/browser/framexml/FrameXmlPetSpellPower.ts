import { readField } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/**
 * TC Guardian::SetBonusDamage writes the pet's bonus to its player's private
 * PLAYER_PET_SPELL_POWER field. It is an int32 carried as one update-field word.
 * A missing word stays unknown; the stock no-pet display supplies its own zero.
 */
export function frameXmlPetSpellBonusDamage(owner: WorldObjectState | undefined): number | undefined {
  const raw = owner ? readField(owner, "PLAYER_PET_SPELL_POWER") : undefined;
  return raw === undefined ? undefined : raw | 0;
}
