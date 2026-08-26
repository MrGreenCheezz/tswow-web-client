/**
 * Arena teams, as rows.
 *
 * Two facts about the roster packet that a straight read gets wrong, both already handled by the
 * parser and both worth stating where the rows are built: the captain flag is **inverted** on the
 * wire — the core writes 0 for the captain — and `level` is zero for anyone offline, because the
 * server reads it off the connected player rather than off the roster row.
 */

import { arenaTypeBySlot, MAX_ARENA_SLOT, type ArenaTeamInfo, type ArenaTeamMember, type ArenaTeamRoster, type ArenaTeamStats } from "../../world/ArenaProtocol.js";

export interface ArenaTeamRow {
  slot: number;
  /** 2, 3 or 5. */
  type: number;
  info: ArenaTeamInfo | undefined;
  stats: ArenaTeamStats | undefined;
  roster: ArenaTeamRoster | undefined;
}

/**
 * The three bracket slots, in order, whether or not the character has a team in each.
 *
 * Shown as three rows rather than as a list, because an empty bracket is information: it is the
 * one that can still be joined.
 */
export function arenaTeamRows(
  teams: ReadonlyMap<number, ArenaTeamInfo>,
  stats: ReadonlyMap<number, ArenaTeamStats>,
  rosters: ReadonlyMap<number, ArenaTeamRoster>,
): ArenaTeamRow[] {
  const bySlot = new Map<number, ArenaTeamInfo>();
  for (const info of teams.values()) {
    const slot = arenaSlotOf(info.type);
    if (slot !== undefined) bySlot.set(slot, info);
  }
  return Array.from({ length: MAX_ARENA_SLOT }, (_, slot) => {
    const info = bySlot.get(slot);
    return {
      slot,
      type: arenaTypeBySlot(slot),
      info,
      stats: info ? stats.get(info.teamId) : undefined,
      roster: info ? rosters.get(info.teamId) : undefined,
    };
  });
}

function arenaSlotOf(type: number): number | undefined {
  for (let slot = 0; slot < MAX_ARENA_SLOT; slot++) if (arenaTypeBySlot(slot) === type) return slot;
  return undefined;
}

export function bracketName(type: number): string {
  return `${type} на ${type}`;
}

/** «1834 · за неделю 6/10 · за сезон 40/70 · место 12» */
export function statsLine(stats: ArenaTeamStats | undefined): string {
  if (!stats) return "рейтинг ещё не пришёл";
  return [
    `рейтинг ${stats.rating}`,
    `за неделю ${stats.weekWins}/${stats.weekGames}`,
    `за сезон ${stats.seasonWins}/${stats.seasonGames}`,
    stats.rank > 0 ? `место ${stats.rank}` : "",
  ].filter(Boolean).join(" · ");
}

/** Captain first, then by personal rating. */
export function sortRoster(roster: ArenaTeamRoster | undefined): ArenaTeamMember[] {
  return [...(roster?.members ?? [])].sort((left, right) =>
    Number(right.captain) - Number(left.captain)
    || right.personalRating - left.personalRating
    || left.name.localeCompare(right.name, "ru"));
}

/**
 * One member's line.
 *
 * The level is left out entirely when it is zero rather than printed as «ур. 0»: zero means the
 * member is offline, not that they are level nought.
 */
export function memberLine(member: ArenaTeamMember): string {
  return [
    member.captain ? "капитан" : "",
    member.level > 0 ? `ур. ${member.level}` : "не в сети",
    `личный рейтинг ${member.personalRating}`,
    `за неделю ${member.weekWins}/${member.weekGames}`,
  ].filter(Boolean).join(" · ");
}
