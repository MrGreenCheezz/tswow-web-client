/**
 * Plan item 5.05 (11.11): UnitSelectionColor's colour for a unit the player does not control — Wow.exe 3.3.5a 12340
 * 0x0060da00 → 0x00521bf0 (read-only Ghidra, .runtime/re-2026-10-04/d3-factions/g2.c).
 *
 * For a unit without UNIT_FLAG_PLAYER_CONTROLLED (UNIT_FIELD_FLAGS 0x8, descriptor +0xd4 bit 3) 0x00521bf0 indexes the
 * table it fills at 0x00bd0c94 (four bytes B, G, R, A a row) by 0x007251c0(unit, player) — the ReputationRank 0..7
 * (game/UnitStandingRank.ts): 0 and 1 red, 2 (Unfriendly) orange 0x80/0xff green, 3 yellow, 4..7 green. The three-way
 * reaction folded rank 2 into neutral and painted it yellow. A player-controlled unit (a player, a pet) takes the
 * function's other branches (PvP, party and the 0x00bd0c8c row), which this file does not model.
 */

/** UNIT_FLAG_PLAYER_CONTROLLED, the bit 0x00521bf0 tests before its rank table. */
export const UNIT_FLAG_PLAYER_CONTROLLED = 0x8;

const RED: readonly [number, number, number] = Object.freeze([1, 0, 0]);
const ORANGE: readonly [number, number, number] = Object.freeze([1, 0x80 / 0xff, 0]);
const YELLOW: readonly [number, number, number] = Object.freeze([1, 1, 0]);
const GREEN: readonly [number, number, number] = Object.freeze([0, 1, 0]);

/** The row of 0x00bd0c94 for a ReputationRank (0..7); a rank past 7 reads as the last row, green. */
export function frameXmlSelectionColorOfRank(rank: number): readonly [number, number, number] {
  if (rank <= 1) return RED;
  if (rank === 2) return ORANGE;
  if (rank === 3) return YELLOW;
  return GREEN;
}
