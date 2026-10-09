// Who is an enemy.
//
// Nothing on the wire says it. A 3.3.5 server publishes `UNIT_FIELD_FACTIONTEMPLATE` and leaves
// the client to work the reaction out of `FactionTemplate.dbc`, exactly the way the core's own
// `FactionTemplateEntry::IsHostileTo` does. Without that answer there is no Tab targeting, no red
// name plate and no way to tell a guard from a boar.
//
// Split the same way `LockRules` is: the gateway reads the table off disk, the browser decides,
// and the rule itself sits where both can import it.
//
// D3 (04.10): the comparison `reactionBetween` makes is Wow.exe's own (FactionTemplateReaction.ts,
// 0x00715440), not the core's IsHostileTo/IsFriendlyTo, which stay below as the realm's predicates.

import { TEMPLATE_RANK_FRIENDLY, TEMPLATE_RANK_HOSTILE, factionTemplateRank } from "./FactionTemplateReaction.js"; // D3

/** `MAX_FACTION_RELATIONS`: four explicit enemies and four explicit friends per template. */
export const FACTION_RELATIONS = 4;

/** `FactionMasks`, from the core's `DBCEnums.h`. A group mask, not a faction id. */
export const FACTION_MASK_PLAYER = 1;
export const FACTION_MASK_ALLIANCE = 2;
export const FACTION_MASK_HORDE = 4;
export const FACTION_MASK_MONSTER = 8;

/** One row of `FactionTemplate.dbc`, under the names the core gives its columns. */
export interface FactionTemplate {
  /** The `Faction.dbc` row this template belongs to. 0 means the template stands alone. */
  faction: number;
  factionGroup: number;
  friendGroup: number;
  enemyGroup: number;
  enemies: readonly number[];
  friends: readonly number[];
  /**
   * D3: `FactionTemplate.Flags` (HOSTILE_BY_DEFAULT 0x2000 for FactionTemplateReaction.ts, CONTESTED_GUARD
   * 0x1000 for ContestedGuard.ts); absent from a gateway that serves /dbc/factions before v=3 — unknown.
   */
  readonly flags?: number; // D3
}

export interface FactionData {
  /** Template id to its row. Keyed by string because this crosses the wire as JSON. */
  templates: Record<number, FactionTemplate>;
  /**
   * `Faction.ReputationIndex` to the faction's name.
   *
   * Keyed by the slot number rather than by the faction's id, because that is what the wire uses:
   * the reputation block of a character's own fields is 128 slots, and the number in one is a
   * `ReputationIndex`. Without this the character sheet could only say «Фракция 1097».
   */
  names?: Record<number, string>;
}

/**
 * Reaction of `self` towards `other`, as `FactionTemplateEntry::IsHostileTo` computes it.
 * D3: the realm's predicate; this client's reaction (`reactionBetween`) reads Wow.exe's comparison
 * instead (FactionTemplateReaction.ts), which takes the EnemyGroup mask before the lists.
 *
 * The order matters and is the core's: an explicit enemy wins over an explicit friend, both win
 * over the group masks, and both lists are only consulted when the other side belongs to a
 * faction at all. Reversing those two loops turns every guard in a contested zone friendly.
 */
export function isHostileTo(self: FactionTemplate, other: FactionTemplate): boolean {
  if (other.faction) {
    if (self.enemies.includes(other.faction)) return true;
    if (self.friends.includes(other.faction)) return false;
  }
  return (self.enemyGroup & other.factionGroup) !== 0;
}

/** Reaction the other way round, from `FactionTemplateEntry::IsFriendlyTo`. */
export function isFriendlyTo(self: FactionTemplate, other: FactionTemplate): boolean {
  if (other.faction) {
    if (self.enemies.includes(other.faction)) return false;
    if (self.friends.includes(other.faction)) return true;
  }
  return (self.friendGroup & other.factionGroup) !== 0 || (self.factionGroup & other.friendGroup) !== 0;
}

/**
 * Hostile, neutral or friendly, as one number, so a name plate and a target list can share it.
 * Neutral is the middle case the two predicates leave between them: a critter is neither.
 */
export const REACTION_HOSTILE = -1;
export const REACTION_NEUTRAL = 0;
export const REACTION_FRIENDLY = 1;

export function reactionBetween(data: FactionData, selfTemplateId: number, otherTemplateId: number): number {
  const self = data.templates[selfTemplateId];
  const other = data.templates[otherTemplateId];
  // A template the client has never heard of is not made an enemy on a guess: an unknown faction
  // reads as neutral, which is the one reaction that costs nothing to be wrong about.
  if (!self || !other) return REACTION_NEUTRAL;
  // D3 (owner's decision 04.10): Wow.exe 0x00715440 — EnemyGroup first, the target's Friend list, the
  // viewer's HOSTILE_BY_DEFAULT (FactionTemplateReaction.ts); was isHostileTo, then isFriendlyTo.
  const rank = factionTemplateRank(self, other); // D3
  return rank === TEMPLATE_RANK_HOSTILE ? REACTION_HOSTILE : rank === TEMPLATE_RANK_FRIENDLY ? REACTION_FRIENDLY : REACTION_NEUTRAL; // D3
}

/**
 * Whether a swing at this unit would be legal, before range or line of sight.
 *
 * Two things can forbid it and both are on the wire: the unit flags the server publishes, and the
 * reaction. Friendly is not attackable without a duel or a flag, so Tab skips it — the original
 * client's "target nearest enemy" means enemy, not "nearest anything".
 */
export const UNIT_FLAG_NON_ATTACKABLE = 0x00000002;
export const UNIT_FLAG_NOT_ATTACKABLE_1 = 0x00000080;
export const UNIT_FLAG_NON_ATTACKABLE_2 = 0x00010000;
export const UNIT_FLAG_UNINTERACTIBLE = 0x02000000;

/** The flags that make a unit unable to be attacked or even clicked, whatever its faction says. */
export const UNIT_FLAGS_UNTARGETABLE =
  UNIT_FLAG_NON_ATTACKABLE | UNIT_FLAG_NOT_ATTACKABLE_1 | UNIT_FLAG_NON_ATTACKABLE_2 | UNIT_FLAG_UNINTERACTIBLE;

/**
 * What stops a *click* from landing on a unit — which is not the same list.
 *
 * Tab means «target the nearest enemy», so it is right for it to skip everything the server has
 * marked unattackable. A click means «that one, there», and half of what a player clicks is not
 * attackable at all: an innkeeper, a flight master, a quest giver. The core sets `0x02` on those
 * and on anything still spawning, so borrowing Tab's mask here would take the vendors away.
 *
 * `0x02000000` is the one flag that means what this needs: `UNIT_FLAG_NOT_SELECTABLE`, worn by the
 * spell triggers, totem aura anchors and quest bunnies standing invisibly all over a zone. They are
 * units with a position and a health bar, they were being pushed into the hit list like any other
 * body, and with a 12px slop around every box they no longer even had to be clicked on to win.
 */
export const UNIT_FLAGS_UNCLICKABLE = UNIT_FLAG_UNINTERACTIBLE;

/**
 * Whether the character is fighting, straight off its own `UNIT_FIELD_FLAGS`.
 *
 * `0x00080000` (`UnitDefines.h:154`), which the core writes on the unit itself the moment a combat
 * reference is taken and clears when the last one goes (`CombatManager.cpp:465` and `:475`), so it
 * is on the wire in the player's own update fields and needs no bookkeeping here. Tab reads it to
 * refuse a corpse mid-fight, as the reference client does (`combat_handler.cpp:1590`).
 */
export const UNIT_FLAG_IN_COMBAT = 0x00080000;

/**
 * A dead creature that still has skin, herbs, ore or parts to give (`UnitDefines.h:161`).
 *
 * The core raises it once the body's ordinary loot is gone (`Creature::AllLootRemovedFromCorpse`,
 * Creature.cpp) and drops it again in `Spell::EffectSkinning` (SpellEffects.cpp), the moment the
 * gathering loot is handed out; `Spell::CheckCast` refuses effect 95 at a unit without it
 * (`SPELL_FAILED_TARGET_UNSKINNABLE`). Public in `UNIT_FIELD_FLAGS`, so every viewer sees it.
 * Which skill the body wants is not here but in its template (`CreatureGather.ts`).
 */
export const UNIT_FLAG_SKINNABLE = 0x04000000;
