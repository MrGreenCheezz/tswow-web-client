import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { UNIT_FLAG_SKINNABLE } from "../../world/FactionRules.js";
import { isLootable, unit } from "../../world/Fields.js";
import type { KnownSpell } from "../../world/SpellProtocol.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { isWorldObjectDead, type WorldObjectState } from "../../world/WorldState.js";
import { spellCastBlockReason } from "../SpellCastGuard.js";
import type { SpellMetadata } from "../SpellMetadata.js";
import { game } from "./Context.js";

/**
 * Skinning a beast, and gathering herbs, ore or parts from a creature's body (WORK_PLAN 2.06).
 *
 * The original client has no separate gesture for it. A right click on a body the server still
 * shows loot on asks for the loot (`CMSG_LOOT`); once that loot is gone and the body still wears
 * `UNIT_FLAG_SKINNABLE`, the same click casts the gathering skill at the body — `CMSG_CAST_SPELL`
 * with the body as its unit target — and the core opens the `LOOT_SKINNING` window by itself
 * (`Spell::EffectSkinning`, SpellEffects.cpp). No targeting cursor is armed: the body under the
 * pointer *is* the target, and the gateway's own contract for these spells says as much
 * (`clientSelectionMask = 0`, `requiredTargetMode = Unit`, docs/implementation/probes/A3).
 *
 * The skill is the creature's, not the spell's. `Spell::CheckCast` (Spell.cpp, the
 * `SPELL_EFFECT_SKINNING` case) reads the skill off `CreatureTemplate::GetRequiredLootSkill`
 * (CreatureData.h) and checks the caster's value in it; which effect-95 spell carried the cast does
 * not enter into it. What does is that the spell is one the character knows
 * (`HandleCastSpellOpcode`, SpellHandler.cpp), and the client picks it the way the dataset pairs
 * them: the `EffectMiscValue` beside effect 95 is the skill it answers — 0 skinning (six ranks,
 * 8613 … 50305), 1 «Сбор трав» (32605), 2 «Горное дело» (32606), 3 «Инженерное дело» (49383).
 * A herbalist at a beast is therefore told what the beast wants rather than sent to cast «Сбор
 * трав» at it.
 *
 * Pure world state and `game.spells`, no DOM: the click (`ui/Npc.ts`) and the cursor
 * (`input/Controls.ts`) ask the same questions here, and the rules are testable without a page.
 */

/** `SPELL_EFFECT_SKINNING` (SharedDefines.h): every gathering-from-a-body spell carries it. */
export const SPELL_EFFECT_SKINNING = 95;

/** `CREATURE_TYPE_FLAG_SKIN_WITH_*` in a template's `type_flags` (SharedDefines.h:2733-2740). */
const SKIN_WITH_HERBALISM = 0x00000100;
const SKIN_WITH_MINING = 0x00000200;
const SKIN_WITH_ENGINEERING = 0x00008000;

/**
 * The gathering skill a body asks for, spelled as the `EffectMiscValue` of the spell that answers
 * it: 0 skinning, 1 herbalism, 2 mining, 3 engineering.
 */
export type GatherSkill = 0 | 1 | 2 | 3;

/**
 * The skills' own names (SkillLine.dbc 393, 182, 186, 202) — not the spells': 32605 is «Сбор трав»,
 * the skill it needs is «Травничество», which is also how `gameObjectLockHint` names it.
 */
const SKILL_NAMES: Readonly<Record<GatherSkill, string>> = {
  0: "Снятие шкур",
  1: "Травничество",
  2: "Горное дело",
  3: "Инженерное дело",
};

/** What the click says while the creature's template query is still out. */
const TEMPLATE_PENDING_HINT = "Загрузка данных существа…";

/**
 * Which skill a creature's body asks for, from its template's `type_flags` (`CreatureTemplate.flags`).
 *
 * `GetRequiredLootSkill` tests the three bits in this order and returns on the first one set, so a
 * template carrying two of them is the earlier one's; none of them is the normal case, skinning.
 */
export function gatherSkillOf(templateFlags: number): GatherSkill {
  if ((templateFlags & SKIN_WITH_HERBALISM) !== 0) return 1;
  if ((templateFlags & SKIN_WITH_MINING) !== 0) return 2;
  if ((templateFlags & SKIN_WITH_ENGINEERING) !== 0) return 3;
  return 0;
}

/** What `gatherSpellFor` reads of a spell: `SpellMetadata`'s effect columns and `SpellLevel`. */
export type GatherSpellRow = Pick<SpellMetadata, "effects" | "effectMiscValue" | "spellLevel">;

/** Whether the row gathers `skill`: effect 95 in some slot, with that same slot's misc value. */
function gathers(row: GatherSpellRow, skill: GatherSkill): boolean {
  const effects = row.effects ?? [];
  for (let slot = 0; slot < effects.length; slot++) {
    if (effects[slot] === SPELL_EFFECT_SKINNING && row.effectMiscValue[slot] === skill) return true;
  }
  return false;
}

/**
 * The known spell that gathers `skill`, or nothing — never another skill's spell in its place.
 *
 * Of several ranks the highest wins, by the order the spellbook's rank chains use (`SpellRanks.ts`):
 * `SpellLevel` first, then the id, a later rank having been authored later. The level alone decides
 * nothing here — all nine effect-95 rows of this dataset have `SpellLevel` 0 — and the ids run in
 * the rank strings' own order, «Ученик» 8613 to «Великий мастер» 50305. A spell whose row has not
 * arrived is not guessed at.
 */
export function gatherSpellFor(
  knownSpells: readonly Pick<KnownSpell, "id">[],
  metadataOf: (spellId: number) => GatherSpellRow | undefined,
  skill: GatherSkill,
): number | undefined {
  let best: { id: number; spellLevel: number } | undefined;
  for (const { id } of knownSpells) {
    const row = metadataOf(id);
    if (!row || !gathers(row, skill)) continue;
    if (!best || row.spellLevel > best.spellLevel || (row.spellLevel === best.spellLevel && id > best.id)) {
      best = { id, spellLevel: row.spellLevel };
    }
  }
  return best?.id;
}

/**
 * A creature's body the server still has something to gather from: dead, a unit rather than a
 * player (a player's body is `SPELL_EFFECT_SKIN_PLAYER_CORPSE`'s, 116), and `UNIT_FLAG_SKINNABLE`.
 * Says nothing about loot: a body can carry both, and the loot comes first (`gatherPlan`).
 */
export function isSkinnableCorpse(object: WorldObjectState): boolean {
  return object.typeId === 3 && isWorldObjectDead(object)
    && ((unit.flags(object) ?? 0) & UNIT_FLAG_SKINNABLE) !== 0;
}

/** A cast of `spellId` at the body `guid`. */
export interface GatherCast {
  readonly spellId: number;
  readonly guid: bigint;
}

/** The cast to make, or why there is none yet that the player should read. */
export type GatherPlan = GatherCast | { readonly hint: string };

/**
 * What a right click on `object` should gather, if anything.
 *
 * `undefined` leaves the click to whatever it did before — a living unit, a body without the flag,
 * and first of all a body the server still marks `UNIT_DYNFLAG_LOOTABLE`: the ordinary loot comes
 * first (`CheckCast` answers `SPELL_FAILED_TARGET_NOT_LOOTED` to a cast at a body whose loot is still
 * on it), so that body stays `CMSG_LOOT`'s. A critter the core would let be skinned with its loot on
 * shows no loot flag in the first place, so the plan covers it as well.
 *
 * The template is asked for through the query cache; the first ask sends `CMSG_CREATURE_QUERY`,
 * and until the answer arrives the plan is only a word to the player, never a guessed skill. The
 * creature names (`CreatureMetadata.ts`) ask for every entry they draw, so in practice the answer
 * is in hand. A template the realm answered it does not have leaves the click where it was.
 */
export function gatherPlan(
  world: Pick<WorldClient, "creatureTemplate" | "knownSpells">,
  object: WorldObjectState,
  metadataOf: (spellId: number) => GatherSpellRow | undefined = (spellId) => game.spells.get(spellId),
): GatherPlan | undefined {
  const resolved = resolveGather(world, object, metadataOf);
  if (resolved === undefined) return undefined;
  if (resolved === "pending") return { hint: TEMPLATE_PENDING_HINT };
  const { skill, spellId } = resolved;
  return spellId === undefined ? { hint: `Нужен навык: ${SKILL_NAMES[skill]}` } : { spellId, guid: object.guid };
}

/** Which skill a hovered body asks for, and whether this character knows a spell that answers it. */
export interface GatherCursor {
  readonly skill: GatherSkill;
  readonly able: boolean;
}

/**
 * The pointer over a body the click would gather from, or `undefined` where it would not.
 *
 * The original client draws one cursor per skill, with a greyed twin for a character that cannot
 * use it (`Interface/Cursor/Skin`, `GatherHerbs`, `Mine`, `EngineerSkin` and `Unable*` beside each,
 * in the client's own archives). `able` follows the same rule as the click — a known spell of the
 * body's own skill; whether that skill is high enough stays the realm's answer
 * (`SPELL_FAILED_LOW_CASTLEVEL`). A body with loot on it is the bag's, and a template still out
 * gives no cursor rather than a guessed skill.
 */
export function gatherCursor(
  world: Pick<WorldClient, "creatureTemplate" | "knownSpells">,
  object: WorldObjectState,
  metadataOf: (spellId: number) => GatherSpellRow | undefined = (spellId) => game.spells.get(spellId),
): GatherCursor | undefined {
  const resolved = resolveGather(world, object, metadataOf);
  if (resolved === undefined || resolved === "pending") return undefined;
  return { skill: resolved.skill, able: resolved.spellId !== undefined };
}

/** The one reading both the click and the cursor share: body, loot, template, skill, spell. */
function resolveGather(
  world: Pick<WorldClient, "creatureTemplate" | "knownSpells">,
  object: WorldObjectState,
  metadataOf: (spellId: number) => GatherSpellRow | undefined,
): { skill: GatherSkill; spellId: number | undefined } | "pending" | undefined {
  if (!isSkinnableCorpse(object) || isLootable(object)) return undefined;
  const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  if (entry <= 0) return undefined;
  const template = world.creatureTemplate(entry, object.guid);
  if (!template) return "pending";
  if (!template.found) return undefined;
  const skill = gatherSkillOf(template.flags);
  return { skill, spellId: gatherSpellFor(world.knownSpells, metadataOf, skill) };
}

/**
 * Sends the planned cast, through the same local preflight every browser-owned cast passes
 * (`spellCastBlockReason`, as `Spellbook.castSpell`): a blocked one sends nothing, and the realm
 * still has the last word on range, skill level and ownership of the kill.
 *
 * `castSpellOnUnit` rather than `Spellbook.castSpell(id, guid)`: the book's explicit target needs
 * the v1 unit contract, which the gateway derives only for `Targets == 0`, and these spells carry
 * `0x402` (UNIT | UNIT_DEAD) — the book would refuse the guid.
 */
export function performGather(world: WorldClient, plan: GatherCast): boolean {
  const metadata = game.spells.get(plan.spellId);
  if (!metadata || spellCastBlockReason(world, plan.spellId) !== undefined) return false;
  world.castSpellOnUnit(plan.spellId, plan.guid,
    Math.max(metadata.recoveryTime, metadata.categoryRecoveryTime), metadata.cooldownStartedOnEvent);
  return true;
}
