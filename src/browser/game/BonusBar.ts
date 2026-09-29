import { unit as unitField } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { SpellMetadata } from "../SpellMetadata.js";
import { game } from "./Context.js";

/**
 * Which bonus bar a stance, a form or stealth puts on the main bar: stock `GetBonusBarOffset()`.
 *
 * The rule used to live inside `LiveWorldSeam.bonusBarOffset`, where only the stock HUD could reach
 * it; the native bar and keys 1 to = run without that seam and kept pressing the main page. It is
 * here now, DOM-free, and the seam delegates to it.
 *
 * The form is byte 3 of `UNIT_FIELD_BYTES_2` (`Unit::SetShapeshiftForm`). The bar is the form's
 * BonusActionBar column of SpellShapeshiftForm.dbc, which `/dbc/spells` joins onto every spell whose
 * `SPELL_AURA_MOD_SHAPESHIFT` names that form — so the offset is found through a learned spell that
 * gives the current form. A form without one (put on by an item or an aura) answers 0, exactly as the
 * stock seam always has; a direct form → bar table is the fix once a route serves it.
 */

/** `SPELL_AURA_MOD_SHAPESHIFT`: the aura whose misc value is the form a spell puts the caster in. */
const SPELL_AURA_MOD_SHAPESHIFT = 36;

/** What the offset is read from: the player's object and the learned spells. `WorldClient` is one. */
export interface BonusBarWorld {
  readonly state: {
    readonly selfGuid: bigint | undefined;
    readonly objects: ReadonlyMap<bigint, WorldObjectState>;
  };
  readonly knownSpells?: readonly { readonly id: number }[];
}

/** The part of a spell row the offset is read from. */
export type BonusBarSpell = Pick<SpellMetadata, "effectAura" | "effectMiscValue" | "bonusActionBarOffset">;

/** The player's form byte; 0 without one or without a player object. */
function formOf(world: BonusBarWorld): number {
  const guid = world.state.selfGuid;
  const objects = world.state.objects;
  const self = guid !== undefined && typeof objects?.get === "function" ? objects.get(guid) : undefined;
  return self ? unitField.shapeshiftForm(self) ?? 0 : 0;
}

/** `GetBonusBarOffset()` for `world`, with spell rows from `spell`; 0 when there is no bonus bar. */
export function bonusBarOffset(
  world: BonusBarWorld | undefined,
  spell: (id: number) => BonusBarSpell | undefined,
): number {
  if (!world) return 0;
  const formId = formOf(world);
  if (!formId) return 0;
  for (const known of world.knownSpells ?? []) {
    const metadata = spell(known.id);
    if (!metadata) continue;
    const effect = metadata.effectAura.findIndex((aura) => aura === SPELL_AURA_MOD_SHAPESHIFT);
    if (effect >= 0 && metadata.effectMiscValue[effect] === formId
      && metadata.bonusActionBarOffset !== undefined) {
      return metadata.bonusActionBarOffset;
    }
  }
  return 0;
}

/** Rows this session already resolved; reading the offset never starts a fetch. */
const resolvedSpell = (id: number): SpellMetadata | undefined => game.spells.get(id);

/**
 * The last answer and everything it was read from.
 *
 * The native bar asks once a frame, and in a form the answer is a walk over the learned spells until
 * one gives that form: 16 µs for 1 500 learned spells and 65 µs for 4 000 (Node, measured). What it
 * depends on moves a few times a session: the form byte, the learned-spell list (`WorldClient`
 * replaces it, never edits it in place) and the rows resolved so far (added, never replaced by
 * different ones), so those are the key.
 */
let last: { knownSpells: BonusBarWorld["knownSpells"]; form: number; rows: number; offset: number } | undefined;

/** `GetBonusBarOffset()` for the world this client is in. */
export function currentBonusBarOffset(): number {
  const world = game.world;
  const form = world ? formOf(world) : 0;
  if (!world || !form) return 0;
  const rows = game.spells.size;
  if (last && last.knownSpells === world.knownSpells && last.form === form && last.rows === rows) {
    return last.offset;
  }
  const offset = bonusBarOffset(world, resolvedSpell);
  last = { knownSpells: world.knownSpells, form, rows, offset };
  return offset;
}

/**
 * Where line A9 (vehicles and possession, М7) plugs in: for one column of the main bar, a 0-based
 * page of the server's twelve that the button and its key use instead of the bonus page, or undefined
 * to leave the stock rule in charge. Per column because stock sends only keys 1–6 to the vehicle bar
 * (`id <= VEHICLE_MAX_ACTIONBUTTONS`, ActionButton.lua:17,31; the vehicle buttons are `alwaysBonus`,
 * VehicleMenuBar.xml:10-11). Asked twelve times a frame while set, so it must be cheap. Nothing sets it yet.
 */
export const bonusBarHooks: { keyBarOverride: ((column: number) => number | undefined) | undefined } = {
  keyBarOverride: undefined,
};
