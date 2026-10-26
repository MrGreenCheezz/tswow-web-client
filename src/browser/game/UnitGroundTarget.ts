import type { WorldClient } from "../../world/WorldClient.js";
import { game } from "./Context.js";
import { beginGroundTarget, isGroundTargetSpell } from "./GroundTarget.js";

/**
 * 11.02 (26.10): the reticle for the spells of the unit the character steers — a Wintergrasp catapult's boulder,
 * a demolisher's or siege engine's area spells, a possessed creature's ground spell. Wow.exe arms the same
 * targeting for them (the pet bar casts through 0x0080cce0, whose ground spells wait for SpellTargetTerrain) and the
 * click sends `CMSG_PET_CAST_SPELL` from the unit with the point (WorldClient `castUnitSpellAt`); before this the
 * spell went out at the selection and landed wherever the target stood, or nowhere.
 *
 * A spell is a ground spell by the gateway's targeting contract (`requiredTargetMode`), never by id. A vehicle's
 * spells are seldom in the book, so their row may not be loaded at the press: it is fetched once, and the press
 * is decided when it comes (failing open to the ordinary cast, as an item use does).
 */
export function installUnitGroundTarget(world: WorldClient): void {
  world.armUnitGroundTarget = (casterGuid, spellId, send) => {
    const metadata = game.spells.get(spellId);
    if (metadata !== undefined) return armFor(world, casterGuid, spellId, isGroundTargetSpell(metadata));
    const client = game.spellMetadataClient;
    if (!client) return false;
    const decide = (ground: boolean): void => {
      if (game.world !== world) return;
      if (!armFor(world, casterGuid, spellId, ground)) send();
    };
    void client.load([spellId]).then((loaded) => {
      if (game.world !== world || game.spellMetadataClient !== client) return;
      for (const [id, row] of loaded) game.spells.set(id, row);
      decide(isGroundTargetSpell(loaded.get(spellId)));
    }, () => decide(false));
    return true;
  };
}

function armFor(world: WorldClient, casterGuid: bigint, spellId: number, ground: boolean): boolean {
  if (!ground || !beginGroundTarget(spellId)) return false;
  game.groundTargetCaster = casterGuid;
  world.onSpellStatus?.("Кликните по земле для выбора точки · правый клик или Esc — отмена", false);
  return true;
}
