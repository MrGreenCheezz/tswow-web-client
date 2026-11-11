import { unit } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/**
 * Plan item 5.05 (11.11): the colour of the selection circle under a unit, as Wow.exe 3.3.5a 12340 picks it (read-only
 * Ghidra, `.runtime/re-2026-11-11/worldtails/w5.c`, `w1.c`; `.runtime/re-2026-10-04/d3-factions/g2.c`, `g3.c`).
 *
 * The circle (0x00725980, texture "Textures\UnitSelectTexture.blp" loaded at 0x007460c0) takes its colour from the
 * unit's vtable +0x78, 0x00718ac0, which is 0x00521bf0(unit, out, 1) — the function behind UnitSelectionColor, with
 * its last argument 1. For a unit without UNIT_FLAG_PLAYER_CONTROLLED that is:
 * * health below 1 or UNIT_DYNFLAG_DEAD (0x20): 0x00acc3f8, grey 0x7f7f7f (only with that argument 1);
 * * else the row of 0x00bd0c94 for 0x007251c0(unit, player), the unit's ReputationRank towards the player: 0–1 red,
 *   2 (Unfriendly) orange (0xff, 0x80, 0), 3 yellow, 4–7 green — the same rows FrameXmlSelectionColor.ts paints.
 * A player-controlled unit (a player, a pet) takes the function's PvP, party and 0x00bd0c8c branches, not modelled
 * here; nor is 0x00718ac0's own first test (+0xa30 & 0x10 → 0x00adaa98).
 *
 * The ring keeps this client's own tones for red, yellow and green (NamePlates.ts); the orange lies halfway between
 * its red and its yellow, as the original's (G 0x80) lies halfway between its red and yellow.
 */

export const SELECTION_RING_RED = 0xdb4b45;
export const SELECTION_RING_ORANGE = 0xdd8743;
export const SELECTION_RING_YELLOW = 0xe0c341;
export const SELECTION_RING_GREEN = 0x4fd06a;
/** 0x00acc3f8: 7f 7f 7f ff (B, G, R, A). */
export const SELECTION_RING_DEAD = 0x7f7f7f;

/** UNIT_FLAG_PLAYER_CONTROLLED, the bit 0x00521bf0 tests before its rank table. */
const UNIT_FLAG_PLAYER_CONTROLLED = 0x8;
/** UNIT_DYNFLAG_DEAD, the bit 0x00521bf0 reads at descriptor +0x124 when its last argument is set. */
const UNIT_DYNFLAG_DEAD = 0x20;

/** The ring's row of 0x00bd0c94 for a ReputationRank (0..7). */
export function selectionRingColourOfRank(rank: number): number {
  if (rank <= 1) return SELECTION_RING_RED;
  if (rank === 2) return SELECTION_RING_ORANGE;
  if (rank === 3) return SELECTION_RING_YELLOW;
  return SELECTION_RING_GREEN;
}

/**
 * 0x00521bf0(unit, out, 1) for a unit the player does not control: grey when dead, else its rank's row; undefined for
 * the player itself, a player-controlled unit, or a rank that cannot be told yet (the caller keeps its reaction).
 */
export function selectionRingRankColour(object: WorldObjectState, selfGuid: bigint | undefined,
  rankTowardsPlayer: (object: WorldObjectState) => number | undefined): number | undefined {
  if (object.guid === selfGuid || ((unit.flags(object) ?? 0) & UNIT_FLAG_PLAYER_CONTROLLED) !== 0) return undefined;
  if ((unit.health(object) ?? 1) < 1 || ((unit.dynamicFlags(object) ?? 0) & UNIT_DYNFLAG_DEAD) !== 0) return SELECTION_RING_DEAD;
  const rank = rankTowardsPlayer(object);
  return rank === undefined ? undefined : selectionRingColourOfRank(rank);
}
