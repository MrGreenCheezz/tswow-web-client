/**
 * Plan item 3.12 (13.10): a unit's view of the player as the ReputationRank Wow.exe 3.3.5a 12340 answers —
 * 0x007251c0(unit, player), 0..7 — which `UnitReaction(unit, "player")` (0x0060d280: the rank + 1) and so the
 * stock tooltip's colour-blind standing line (0x00621070 at 0x00621504: FACTION_STANDING_LABEL<rank + 1>) and
 * `GameTooltip_UnitColor` read.
 *
 * The same rules `Targeting.unitReactionToPlayer` reads for the plate colour (see its comment and
 * world/ReputationReaction.ts), kept as the rank instead of folded into three reactions:
 *   1. a CONTESTED_GUARD template against a PvP-contested player: hostile (1) — 0x007253ca;
 *   2. a forced rank the player holds for the unit's faction (SMSG_SET_FORCED_REACTIONS, 0x005d06a0): that rank;
 *   3. a faction that keeps a reputation (0x00718b30): the player's rank with it, base + standing (0x005d0600) —
 *      «Уважение», «Почтение», «Превознесение» and the rest, which the three reactions could not tell apart;
 *   4. otherwise the unit's template against the player's (0x00715440): hostile 1, neutral 3, friendly 4.
 * Undefined outside the world or before the faction table has landed (no guess).
 *
 * Targeting.ts keeps the three-way answer; this file only reads the same exported pieces.
 */
import { player as playerFields, unit } from "../../world/Fields.js";
import { REACTION_FRIENDLY, REACTION_HOSTILE } from "../../world/FactionRules.js";
import { contestedGuardHostile } from "../../world/ContestedGuard.js";
import { reactionsByTemplate } from "../../world/UnitInteractGate.js";
import {
  REP_FRIENDLY, REP_HOSTILE, REP_NEUTRAL, reputationBaseFor, reputationListIdOf, reputationRank,
} from "../../world/ReputationReaction.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { ReputationCatalog } from "../../gateway/ReputationMetadata.js";

/** What the rank reads; the page's `game` satisfies it (tests hand a stub). */
export interface UnitStandingSources {
  readonly world?: {
    readonly state: { readonly selfGuid?: bigint | undefined; readonly objects: ReadonlyMap<bigint, WorldObjectState> };
    readonly forcedReactions?: ReadonlyMap<number, number> | undefined;
    readonly factions?: ReadonlyMap<number, { readonly standing: number; readonly flags: number }> | undefined;
  } | undefined;
  readonly factions?: {
    readonly ready: boolean;
    readonly reputationCatalog: ReputationCatalog | undefined;
    factionOf(templateId: number): number | undefined;
    templateFlagsOf?(templateId: number): number | undefined;
    reaction(selfTemplateId: number, otherTemplateId: number): number;
  } | undefined;
}

/** 4.04 (13.10): a three-way reaction (FactionRules REACTION_*) as the rank 0x00715440 answers it: 1, 3 or 4. */
export function rankOfReaction(reaction: number): number {
  return reaction === REACTION_HOSTILE ? REP_HOSTILE : reaction === REACTION_FRIENDLY ? REP_FRIENDLY : REP_NEUTRAL;
}

/**
 * 4.04 (13.10): the Faction.dbc row the unit tooltip's faction line reads (0x00621070 at 0x00621ae0): the unit's
 * FactionTemplate → Faction, when that faction keeps a reputation (ReputationIndex ≥ 0 — the rows `/dbc/reputation`
 * serves) — its race/class masks and flags, and its name; undefined otherwise or before the tables land.
 */
export function unitReputationFaction(object: WorldObjectState, sources: UnitStandingSources & {
  readonly factions?: { name(reputationIndex: number): string | undefined } | undefined;
}): { readonly row: ReputationCatalog["factions"][string]; readonly name: string | undefined } | undefined {
  const factions = sources.factions;
  const catalog = factions?.reputationCatalog;
  const template = unit.factionTemplate(object);
  const faction = template === undefined ? undefined : factions?.factionOf(template);
  if (!factions || !catalog || faction === undefined || faction <= 0) return undefined;
  const listId = reputationListIdOf(catalog, faction);
  const row = listId === undefined ? undefined : catalog.factions[listId];
  return row && listId !== undefined ? { row, name: factions.name(listId) } : undefined;
}

/** 0x007251c0(unit, player): the unit's rank towards the player, 0..7; undefined when it cannot be told yet. */
export function unitRankTowardsPlayer(object: WorldObjectState, sources: UnitStandingSources): number | undefined {
  const world = sources.world;
  const factions = sources.factions;
  const selfGuid = world?.state.selfGuid;
  const self = selfGuid === undefined ? undefined : world?.state.objects.get(selfGuid);
  if (!world || !self || !factions?.ready) return undefined;
  const template = unit.factionTemplate(object);
  const mine = unit.factionTemplate(self);
  if (template === undefined || mine === undefined) return undefined;
  const templateFlags = factions.templateFlagsOf?.(template);
  const contested = contestedGuardHostile(Number(playerFields.flags(self) ?? 0), templateFlags);
  if (contested === true) return REP_HOSTILE;
  const faction = factions.factionOf(template);
  const forced = faction === undefined ? undefined : world.forcedReactions?.get(faction);
  if (forced !== undefined) return forced;
  const catalog = factions.reputationCatalog;
  // The reputation's rank only where Targeting.reputationListFor reads it: a catalog, a faction that keeps a
  // reputation, the template flags known for a contested player, and the player's row for it already sent.
  if (catalog !== undefined && faction !== undefined && contested !== undefined
    && !reactionsByTemplate(self, faction, catalog, world.forcedReactions)) {
    const listId = reputationListIdOf(catalog, faction);
    const row = listId === undefined ? undefined : world.factions?.get(listId);
    if (listId !== undefined && row !== undefined) {
      const base = reputationBaseFor(catalog.factions[listId], unit.race(self) ?? 0, unit.classId(self) ?? 0);
      return reputationRank(base + row.standing);
    }
  }
  const reaction = factions.reaction(template, mine);
  return reaction === REACTION_HOSTILE ? REP_HOSTILE : reaction === REACTION_FRIENDLY ? REP_FRIENDLY : REP_NEUTRAL;
}
