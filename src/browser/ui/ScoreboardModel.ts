/**
 * The battleground and arena scoreboard, as columns and rows.
 *
 * The packet is two packets under one opcode and the difference is eleven bytes per row: a
 * battleground row has honorable kills, deaths and bonus honor where an arena row has a single
 * team byte. So the column set is not a constant — it is chosen from the same flag the parser
 * chose the row shape from, and a column list that shows both sets shows a blank column in every
 * match.
 *
 * Two more inversions worth stating out loud: `PVP_TEAM_HORDE` is **0** and alliance is 1, and the
 * arena team array is written horde first. And there is no winner byte at all until the match has
 * ended, so a winner shown mid-match is a number read out of the row count.
 */

import {
  PVP_TEAM_ALLIANCE, PVP_TEAM_HORDE, type PvpLogData, type PvpScore,
} from "../../world/PvpProtocol.js";

export interface ScoreColumn {
  id: string;
  title: string;
  value: (score: PvpScore) => string;
}

const NUMBER = (value: number): string => value.toLocaleString("ru-RU");

/** The columns this kind of match actually has. */
export function scoreColumns(log: Pick<PvpLogData, "arena">): ScoreColumn[] {
  const columns: ScoreColumn[] = [
    { id: "killingBlows", title: "Добивания", value: (score) => NUMBER(score.killingBlows) },
  ];
  if (!log.arena) {
    columns.push({ id: "honorableKills", title: "Победы", value: (score) => NUMBER(score.honorableKills) });
    columns.push({ id: "deaths", title: "Смерти", value: (score) => NUMBER(score.deaths) });
    columns.push({ id: "bonusHonor", title: "Честь", value: (score) => NUMBER(score.bonusHonor) });
  }
  columns.push({ id: "damageDone", title: "Урон", value: (score) => NUMBER(score.damageDone) });
  columns.push({ id: "healingDone", title: "Лечение", value: (score) => NUMBER(score.healingDone) });
  return columns;
}

export function teamName(teamId: number): string {
  return teamId === PVP_TEAM_HORDE ? "Орда" : teamId === PVP_TEAM_ALLIANCE ? "Альянс" : "";
}

export interface ScoreRow {
  score: PvpScore;
  name: string;
  teamId: number;
}

/** Rows with names attached, sorted by the thing a player looks at first. */
export function scoreRows(log: PvpLogData, nameOf: (guid: bigint) => string): ScoreRow[] {
  return log.scores
    .map((score) => ({ score, name: nameOf(score.guid), teamId: score.teamId }))
    .sort((left, right) =>
      left.teamId - right.teamId
      || right.score.damageDone - left.score.damageDone
      || left.name.localeCompare(right.name, "ru"));
}

/** In an arena, rows split by team; in a battleground, one flat list. */
export function scoreGroups(log: PvpLogData, nameOf: (guid: bigint) => string): Array<{ title: string; rows: ScoreRow[] }> {
  const rows = scoreRows(log, nameOf);
  if (!log.arena) return [{ title: "", rows }];
  return [PVP_TEAM_HORDE, PVP_TEAM_ALLIANCE].map((teamId) => ({
    title: arenaTeamHeader(log, teamId),
    rows: rows.filter((row) => row.teamId === teamId),
  }));
}

/**
 * One arena team's line: its name and what the match did to its rating.
 *
 * The array is horde first — index zero is `PVP_TEAM_HORDE`, which is also zero — and the core
 * splits one signed rating change into a lost and a won word, only one of which is non-zero.
 */
export function arenaTeamHeader(log: PvpLogData, teamId: number): string {
  const team = log.teams[teamId];
  if (!team) return teamName(teamId);
  const change = team.ratingWon > 0 ? `+${team.ratingWon}` : team.ratingLost > 0 ? `−${team.ratingLost}` : "±0";
  return `${team.name || teamName(teamId)} · ${change} (ММР ${team.matchmakerRating})`;
}

/** Empty until the match is over: before that there is no winner byte on the wire at all. */
export function winnerText(log: PvpLogData): string {
  if (!log.ended) return "Матч ещё идёт";
  const name = teamName(log.winner);
  return name ? `Победа: ${name}` : "Ничья";
}

/**
 * Column headers for the objective block.
 *
 * What the numbers count belongs to the battleground — bases in Alterac Valley, flags in Warsong
 * Gulch — and nothing in this client maps a battleground id to those names. Numbered placeholders
 * are the honest answer; inventing labels from the field name would put "flags" over a tower count.
 */
export function objectiveHeaders(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `Цель ${index + 1}`);
}

/** How many objective columns this scoreboard needs: the widest row decides. */
export function objectiveCount(log: PvpLogData): number {
  return log.scores.reduce((widest, score) => Math.max(widest, score.objectives.length), 0);
}
