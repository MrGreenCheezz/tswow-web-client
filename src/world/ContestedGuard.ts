/**
 * L18 5.05: Wow.exe 3.3.5a 12340's CONTESTED_GUARD rule (Ghidra read-only).
 *
 * A faction template with FACTION_TEMPLATE_FLAG_CONTESTED_GUARD (FactionTemplate.dbc Flags, the row word
 * Wow.exe reads at +8) is hostile to a player with PLAYER_FLAGS_CONTESTED_PVP — one who took part in PvP
 * where the guards keep the peace:
 * * the player's view of a unit, 0x007251c0, the branch at 0x007253ca (.runtime/re-2026-09-30/gw-data/
 *   r2.c): after the forced rank (0x005d06a0) and only for a faction that keeps a reputation (0x00718b30,
 *   the player without UNIT_FLAG2_IGNORE_REPUTATION) — before the at-war flag (0x005d04b0);
 * * a unit's view of a player, 0x0071f770 (.runtime/re-2026-10-03/l1102tails-review/r1.c): first of all,
 *   before the forced rank, with or without a reputation.
 * The realm reads the same (Object.cpp WorldObject::GetReactionTo, GetFactionReactionTo).
 */

/** DBCEnums.h:322: the faction's guards attack players involved in PvP in their zone. */
export const FACTION_TEMPLATE_FLAG_CONTESTED_GUARD = 0x0000_1000;
/** Player.h:362: the player was involved in PvP combat and contested guards will attack. */
export const PLAYER_FLAGS_CONTESTED_PVP = 0x0000_0100;

/**
 * Whether the rule makes the template hostile to the player: false when the player is not contested,
 * else the template's flag — undefined when the template's flags are not known (a gateway that serves
 * /dbc/factions without them), so the caller can keep its older reading.
 */
export function contestedGuardHostile(playerFlags: number, templateFlags: number | undefined): boolean | undefined {
  if ((playerFlags & PLAYER_FLAGS_CONTESTED_PVP) === 0) return false;
  if (templateFlags === undefined) return undefined;
  return (templateFlags & FACTION_TEMPLATE_FLAG_CONTESTED_GUARD) !== 0;
}
