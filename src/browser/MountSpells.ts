import type { WorldClient } from "../world/WorldClient.js";
import { game } from "./game/Context.js";
import { SPELL_AURA_MOUNTED } from "./SpellMetadata.js";
import { SPELL_ATTR4_AUTO_RANGED_COMBAT } from "../world/AutoRangedCombat.js"; // L15 5.05
import { autoRangedLimits } from "./game/Targeting.js"; // L15 5.05

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
  // L15 5.05: the autoRangedCombat controller's spell — SPELL_ATTR4 0x01000000, Auto Shot (Wow.exe
  // 0x00542030 → 0x00be5d84) — and its range against a target (world/AutoRangedCombat.ts).
  if (typeof world.setAutoRangedCombatSpellIds === "function") { // L15 5.05
    world.setAutoRangedCombatSpellIds( // L15 5.05
      world.knownSpells.filter(({ id }) => ((game.spells.get(id)?.attributes?.[4] ?? 0) & SPELL_ATTR4_AUTO_RANGED_COMBAT) !== 0) // L15 5.05
        .map(({ id }) => id), // L15 5.05
    ); // L15 5.05
    world.autoRangedLimits = autoRangedLimits; // L15 5.05
  } // L15 5.05
}
