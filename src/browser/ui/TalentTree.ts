/**
 * The rules a talent tree is drawn and clicked by, with no DOM in sight.
 *
 * All of them come from `Player::LearnTalent`, because the server is the only thing that decides
 * whether a point may go in and a tree that disagrees with it offers clicks that do nothing:
 *
 * * **A tier needs five points per tier below it.** `TierID > 0 && GetTalentPointsInTree(tab) <
 *   TierID * MAX_TALENT_RANK`, and `MAX_TALENT_RANK` is five — so tier 1 opens at five points in
 *   *that tree*, tier 2 at ten, and the count is per tree rather than per character.
 *   Pet trees use `MAX_PET_TALENT_RANK = 3` and open a tier every three points.
 * * **Only the first prerequisite is enforced.** `Talent.dbc` has room for three and the core reads
 *   `talentInfo->PrereqTalent` as a scalar, so the second and third are never checked. Measured
 *   against this dataset: 139 talents have exactly one prerequisite and none has two, so the extra
 *   columns are unused rather than ignored — but an interface that drew arrows from all three would
 *   be drawing rules the server does not have.
 * * **The rank on the wire is zero-based and the rank on the screen is not.** `SMSG_TALENTS_INFO`
 *   is parsed with `+ 1` and `buildLearnTalent` subtracts one again, so everything in this module
 *   counts from one: a talent showing "2/5" holds rank 2, and the next point is a request for 3.
 */

/** `MAX_TALENT_RANK` in the core. Also the number of points a tier costs to unlock. */
export const MAX_TALENT_RANK = 5;
/** Four columns in every tree in this build; `ColumnIndex` runs 0 to 3. */
export const TALENT_COLUMNS = 4;

export interface TalentDefinition {
  id: number;
  tabId: number;
  tier: number;
  column: number;
  ranks: number[];
  prerequisites: Array<{ talentId: number; rank: number }>;
}

export interface TalentCell {
  talent: TalentDefinition;
  /** Points already in it, 0 to `maxRank`. One-based, as shown. */
  rank: number;
  maxRank: number;
  /** Whether a point may go in right now, by the server's own rules. */
  available: boolean;
  /** Why not, when it is not. Shown as the tooltip rather than left to be guessed. */
  blockedBy: "maxed" | "tier" | "prerequisite" | "points" | undefined;
}

/** Points spent in one tree, which is what gates its tiers. */
export function pointsInTree(
  talents: readonly TalentDefinition[], learned: ReadonlyMap<number, number>, rankLimit = MAX_TALENT_RANK,
): number {
  let total = 0;
  for (const talent of talents) total += Math.min(learned.get(talent.id) ?? 0, talent.ranks.length, rankLimit);
  return total;
}

/** How many points a tier needs below it before it opens. Tier 0 is free. */
export const tierRequirement = (tier: number, pointsPerTier = MAX_TALENT_RANK): number => tier * pointsPerTier;

/**
 * Every talent in one tree with its rank and whether it can take another point.
 *
 * `unspentPoints` is the character's own pool: with none left, nothing is available however open
 * the tier is, and the reason is reported separately from "the tier is shut" because the two lead
 * a player to do different things.
 */
export function talentTreeState(
  talents: readonly TalentDefinition[],
  learned: ReadonlyMap<number, number>,
  unspentPoints: number,
  pointsPerTier = MAX_TALENT_RANK,
): TalentCell[] {
  const spent = pointsInTree(talents, learned, pointsPerTier);
  return talents.map((talent) => {
    const maxRank = Math.min(talent.ranks.length, pointsPerTier);
    const rank = Math.min(learned.get(talent.id) ?? 0, maxRank);
    let blockedBy: TalentCell["blockedBy"];
    if (rank >= maxRank) blockedBy = "maxed";
    else if (spent < tierRequirement(talent.tier, pointsPerTier)) blockedBy = "tier";
    else if (!prerequisitesMet(talent, learned)) blockedBy = "prerequisite";
    else if (unspentPoints <= 0) blockedBy = "points";
    return { talent, rank, maxRank, available: blockedBy === undefined, blockedBy };
  });
}

/** Only the first prerequisite is checked, because only the first is checked by the server. */
export function prerequisitesMet(talent: TalentDefinition, learned: ReadonlyMap<number, number>): boolean {
  const required = talent.prerequisites[0];
  if (!required) return true;
  return (learned.get(required.talentId) ?? 0) >= required.rank;
}

export interface TalentArrow {
  from: { tier: number; column: number };
  to: { tier: number; column: number };
  /** True once the prerequisite is satisfied, which is what makes the arrow light up. */
  satisfied: boolean;
}

/**
 * The arrows between talents, as tier and column pairs for whoever draws them.
 *
 * Only the first prerequisite of each talent produces one, for the reason above: an arrow the
 * server does not enforce is a promise the tree cannot keep.
 */
export function talentArrows(
  talents: readonly TalentDefinition[],
  learned: ReadonlyMap<number, number>,
): TalentArrow[] {
  const byId = new Map(talents.map((talent) => [talent.id, talent]));
  const arrows: TalentArrow[] = [];
  for (const talent of talents) {
    const required = talent.prerequisites[0];
    if (!required) continue;
    const source = byId.get(required.talentId);
    // A prerequisite in another tab cannot be drawn: there is nowhere on this grid to start from.
    if (!source) continue;
    arrows.push({
      from: { tier: source.tier, column: source.column },
      to: { tier: talent.tier, column: talent.column },
      satisfied: (learned.get(required.talentId) ?? 0) >= required.rank,
    });
  }
  return arrows;
}

/**
 * How many rows the grid needs.
 *
 * Not a constant: `TierID` runs to 10 in this dataset while a class tree uses far fewer, and a grid
 * sized to the largest leaves every tree with empty rows at the bottom.
 */
export function treeHeight(talents: readonly TalentDefinition[]): number {
  let height = 0;
  for (const talent of talents) height = Math.max(height, talent.tier + 1);
  return height;
}

/**
 * The rank to ask for when adding one point, in the one-based form the rest of this client uses.
 *
 * Three conventions meet here and only one of them is on the wire. `SMSG_TALENTS_INFO` is parsed
 * with `+ 1`, so a talent at "2/5" holds 2 here; the server wants the *index* of the rank being
 * learned, which is 2 for the third point; and `buildLearnTalent` does that subtraction itself. So
 * everything above the wire counts from one, and asking for the third point means asking for 3.
 */
export const nextRankRequest = (currentRank: number): number => currentRank + 1;

/** Which learned talents belong to one tab, folded into the map the rules above read. */
export function learnedInTab(
  talents: readonly TalentDefinition[],
  learned: ReadonlyMap<number, number>,
): Map<number, number> {
  const inTab = new Map<number, number>();
  for (const talent of talents) {
    const rank = learned.get(talent.id);
    if (rank !== undefined && rank > 0) inTab.set(talent.id, rank);
  }
  return inTab;
}
