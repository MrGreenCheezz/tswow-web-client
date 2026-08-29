import type { WorldClient } from "../world/WorldClient.js";
import { game } from "./game/Context.js";
import { SPELL_AURA_MOUNTED } from "./SpellMetadata.js";

/**
 * Rebuilds the DBC-derived mount set after any spell metadata batch lands.
 *
 * Metadata is shared by the spellbook, action bar, aura strip and module windows.  None of those
 * loaders owns the map, so classification has to be refreshed at each batch boundary rather than
 * only after the spellbook's initial request.  The world client remains the owner of the result;
 * this helper only joins the browser's two data sources.
 */
export function syncMountSpellIds(world: WorldClient | undefined = game.world): void {
  // Metadata loaders can run while a lightweight test/view world is still being assembled. Keep
  // this optional integration point harmless for those partial contexts; a real WorldClient has
  // both members and continues through the same classification path below.
  if (!world || !Array.isArray(world.knownSpells)) return;
  if (typeof world.setMountSpellIds === "function") {
    world.setMountSpellIds(
      world.knownSpells.filter(({ id }) => {
        const effectAura = game.spells.get(id)?.effectAura;
        return Array.isArray(effectAura) && effectAura.includes(SPELL_AURA_MOUNTED);
      })
        .map(({ id }) => id),
    );
  }
  if (typeof world.setAutoRepeatSpellIds === "function") {
    world.setAutoRepeatSpellIds(
      world.knownSpells.filter(({ id }) => game.spells.get(id)?.autoRepeat === true).map(({ id }) => id),
    );
  }
}
