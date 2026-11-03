import type { WorldClient } from "../../world/WorldClient.js";
import { game } from "./Context.js";
import { beginGroundTarget, isGroundTargetSpell } from "./GroundTarget.js";
import { armItemTarget, isItemTargetSpell, spellTargetsObject } from "./SpellCursor.js"; // 2.05

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
 *
 * 2.05: a spell of that bar that waits for an item, or an item or an object, raises the item cursor the same way, and
 * the pick goes out from the unit (SpellCursor.ts `caster`).
 */
export function installUnitGroundTarget(world: WorldClient): void {
  world.armUnitGroundTarget = (casterGuid, spellId, send) => {
    const metadata = game.spells.get(spellId);
    if (metadata !== undefined) return armFor(world, casterGuid, spellId, metadata); // 2.05: the row, was whether it is ground
    const client = game.spellMetadataClient;
    if (!client) return false;
    const decide = (row: SpellRow | undefined): void => { // 2.05: the row, was whether it is ground
      if (game.world !== world) return;
      if (!armFor(world, casterGuid, spellId, row)) send();
    };
    void client.load([spellId]).then((loaded) => {
      if (game.world !== world || game.spellMetadataClient !== client) return;
      for (const [id, row] of loaded) game.spells.set(id, row);
      decide(loaded.get(spellId));
    }, () => decide(undefined));
    return true;
  };
}

type SpellRow = Parameters<typeof isItemTargetSpell>[0] & Parameters<typeof isGroundTargetSpell>[0];

function armFor(world: WorldClient, casterGuid: bigint, spellId: number, row: SpellRow | undefined): boolean {
  if (isItemTargetSpell(row)) return armItemTarget(world, spellId, undefined, spellTargetsObject(row), casterGuid); // 2.05
  if (!isGroundTargetSpell(row) || !beginGroundTarget(spellId)) return false;
  game.groundTargetCaster = casterGuid;
  world.onSpellStatus?.("Кликните по земле для выбора точки · правый клик или Esc — отмена", false);
  return true;
}
