/**
 * The guild roster, sorted and worded.
 *
 * Sorting matters more here than it looks: a roster is read to find one person, and the window
 * used to order it online-first-then-rank with no third key, so two officers swapped places
 * whenever the packet arrived in a different order. Ranks matter too — the names for them live in
 * a different packet from the ranks themselves, and the one that carries the names always writes
 * ten of them whatever the guild has, so the count has to come from the roster.
 */

import type { GuildMember, GuildQueryInfo, GuildRank, GuildRoster } from "../../world/GuildProtocol.js";
import { guildEventLogText } from "../../world/GuildBankProtocol.js";
import { formatAgo } from "./Format.js";
import type { GuildEventLogEntry } from "../../world/GuildBankProtocol.js";

/** `GR_RIGHT_*` in Guild.h: what a rank is allowed to do. */
export const GR_RIGHT_EMPTY = 0x00000040;
export const GR_RIGHT_GCHATLISTEN = 0x00000041;
export const GR_RIGHT_GCHATSPEAK = 0x00000042;
export const GR_RIGHT_OFFCHATLISTEN = 0x00000044;
export const GR_RIGHT_OFFCHATSPEAK = 0x00000048;
export const GR_RIGHT_INVITE = 0x00000050;
export const GR_RIGHT_REMOVE = 0x00000060;
export const GR_RIGHT_PROMOTE = 0x000000C0;
export const GR_RIGHT_DEMOTE = 0x00000140;
export const GR_RIGHT_SETMOTD = 0x00001040;
export const GR_RIGHT_EPNOTE = 0x00002040;
export const GR_RIGHT_VIEWOFFNOTE = 0x00004040;
export const GR_RIGHT_EOFFNOTE = 0x00008040;
export const GR_RIGHT_MODIFY_GUILD_INFO = 0x00010040;
export const GR_RIGHT_WITHDRAW_GOLD_LOCK = 0x00020000;
export const GR_RIGHT_WITHDRAW_REPAIR = 0x00040000;
export const GR_RIGHT_WITHDRAW_GOLD = 0x00080000;
export const GR_RIGHT_CREATE_GUILDEVENT = 0x00100000;

/** The rights worth a checkbox, in the order the original client lists them. */
export const GUILD_RIGHT_LABELS: ReadonlyArray<readonly [number, string]> = [
  [GR_RIGHT_GCHATLISTEN, "Читать чат гильдии"],
  [GR_RIGHT_GCHATSPEAK, "Писать в чат гильдии"],
  [GR_RIGHT_OFFCHATLISTEN, "Читать чат офицеров"],
  [GR_RIGHT_OFFCHATSPEAK, "Писать в чат офицеров"],
  [GR_RIGHT_INVITE, "Приглашать"],
  [GR_RIGHT_REMOVE, "Исключать"],
  [GR_RIGHT_PROMOTE, "Повышать"],
  [GR_RIGHT_DEMOTE, "Понижать"],
  [GR_RIGHT_SETMOTD, "Менять объявление"],
  [GR_RIGHT_EPNOTE, "Менять заметки"],
  [GR_RIGHT_VIEWOFFNOTE, "Видеть заметки офицеров"],
  [GR_RIGHT_EOFFNOTE, "Менять заметки офицеров"],
  [GR_RIGHT_MODIFY_GUILD_INFO, "Менять описание гильдии"],
  [GR_RIGHT_WITHDRAW_GOLD, "Снимать золото из банка"],
  [GR_RIGHT_WITHDRAW_REPAIR, "Чинить за счёт гильдии"],
  [GR_RIGHT_CREATE_GUILDEVENT, "Создавать события"],
];

export function hasGuildRight(flags: number, right: number): boolean {
  return (flags & right) === right;
}

/**
 * Online first, then by rank, then by name.
 *
 * The name is the tiebreak the old list did not have. Without it the order came out of whatever
 * order the server wrote the members in, which changes between rosters.
 */
export function sortRoster(members: readonly GuildMember[]): GuildMember[] {
  return [...members].sort((left, right) =>
    Number(right.online) - Number(left.online)
    || left.rankId - right.rankId
    || left.name.localeCompare(right.name, "ru"));
}

/**
 * How many ranks the guild actually has.
 *
 * `SMSG_GUILD_QUERY_RESPONSE` always writes ten names, padded with empty strings; the roster is
 * the only packet that says how many are real.
 */
export function rankCount(roster: GuildRoster | undefined): number {
  return roster?.ranks.length ?? 0;
}

export function rankLabel(rankId: number, query: GuildQueryInfo | undefined): string {
  const name = query?.rankNames[rankId];
  return name && name.length > 0 ? name : `Ранг ${rankId}`;
}

export interface RankRow {
  rankId: number;
  name: string;
  rank: GuildRank;
}

/** One row per real rank, named from the query packet where it has a name. */
export function rankRows(roster: GuildRoster | undefined, query: GuildQueryInfo | undefined): RankRow[] {
  if (!roster) return [];
  return roster.ranks.map((rank, rankId) => ({ rankId, name: rankLabel(rankId, query), rank }));
}

/** «Не в сети 3 д» or nothing at all, because an online member carries no such field. */
export function lastSeenText(member: GuildMember): string {
  if (member.online) return "в сети";
  const days = Math.floor(member.lastSaveDays);
  if (days <= 0) return "не в сети";
  return `не в сети ${days} д`;
}

/**
 * The event log as sentences.
 *
 * `guildEventLogText` gives the verb and has had no caller at all since slice P5 wrote it; the log
 * behind it was fetched by a sender with no caller, into a field nothing read. Two of the six
 * events — joining and leaving — are nobody's doing and carry no second guid, so the sentence has
 * to be built rather than templated.
 */
export function eventLogLines(
  entries: readonly GuildEventLogEntry[],
  nameOf: (guid: bigint) => string,
  query: GuildQueryInfo | undefined,
): string[] {
  return entries.map((entry) => {
    const verb = guildEventLogText(entry);
    const who = nameOf(entry.playerGuid);
    const other = entry.otherGuid === 0n ? "" : nameOf(entry.otherGuid);
    const rank = entry.rankId > 0 ? ` до «${rankLabel(entry.rankId, query)}»` : "";
    const sentence = other ? `${other} ${verb} ${who}${rank}` : `${who} ${verb}`;
    return `${sentence} · ${formatAgo(entry.secondsAgo)}`;
  });
}
