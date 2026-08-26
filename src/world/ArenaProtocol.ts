import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: ArenaTeam.cpp (`Roster`, `Query`, `SendStats`,
// `Inspect`, `BroadcastEvent`), ArenaTeamHandler.cpp (`SendArenaTeamCommandResult`,
// `SendNotInArenaTeamPacket`, the invite, and every handler a client drives) and MiscHandler.cpp
// `HandleInspectHonorStatsOpcode`.

/** `MAX_ARENA_SLOT` in ArenaTeam.h: slots 0, 1 and 2 for 2v2, 3v3 and 5v5. */
export const MAX_ARENA_SLOT = 3;

/** `ArenaTeamTypes` in ArenaTeam.h. The type is the team size; the slot is not. */
export const ARENA_TEAM_2V2 = 2;
export const ARENA_TEAM_3V3 = 3;
export const ARENA_TEAM_5V5 = 5;

/** `ArenaTeam::GetSlotByType`. The two are used interchangeably in conversation and are not equal. */
export function arenaSlotByType(type: number): number {
  if (type === ARENA_TEAM_2V2) return 0;
  if (type === ARENA_TEAM_3V3) return 1;
  if (type === ARENA_TEAM_5V5) return 2;
  return -1;
}

export const arenaTypeBySlot = (slot: number): number => [ARENA_TEAM_2V2, ARENA_TEAM_3V3, ARENA_TEAM_5V5][slot] ?? 0;

export interface ArenaTeamInfo {
  teamId: number;
  name: string;
  /** 2, 3 or 5. */
  type: number;
  backgroundColor: number;
  emblemStyle: number;
  emblemColor: number;
  borderStyle: number;
  borderColor: number;
}

/** The team's name and tabard. Answered together with `SMSG_ARENA_TEAM_STATS` for one query. */
export function parseArenaTeamQueryResponse(payload: Uint8Array): ArenaTeamInfo {
  const reader = new PacketReader(payload);
  const info: ArenaTeamInfo = {
    teamId: reader.u32(),
    name: reader.cString(),
    type: reader.u32(),
    backgroundColor: reader.u32(),
    emblemStyle: reader.u32(),
    emblemColor: reader.u32(),
    borderStyle: reader.u32(),
    borderColor: reader.u32(),
  };
  reader.assertFinished();
  return info;
}

export interface ArenaTeamStats {
  teamId: number;
  rating: number;
  weekGames: number;
  weekWins: number;
  seasonGames: number;
  seasonWins: number;
  /** Where the team stands on the ladder. Recomputed by the server, not derivable here. */
  rank: number;
}

/**
 * The team's record. Sent unasked to every member after a rated match, not only to those who
 * played it — so this arrives for a team the client may never have queried.
 */
export function parseArenaTeamStats(payload: Uint8Array): ArenaTeamStats {
  const reader = new PacketReader(payload);
  const stats: ArenaTeamStats = {
    teamId: reader.u32(),
    rating: reader.u32(),
    weekGames: reader.u32(),
    weekWins: reader.u32(),
    seasonGames: reader.u32(),
    seasonWins: reader.u32(),
    rank: reader.u32(),
  };
  reader.assertFinished();
  return stats;
}

export interface ArenaTeamMember {
  guid: bigint;
  online: boolean;
  name: string;
  /**
   * True for the team captain. On the wire this is inverted — the core writes 0 for the captain
   * and 1 for everybody else — so a reader that treats the word as a boolean gets it backwards and
   * marks the whole team captain except the captain.
   */
  captain: boolean;
  /** Zero for an offline member: the core reads it off the connected player, not off the roster. */
  level: number;
  classId: number;
  weekGames: number;
  weekWins: number;
  seasonGames: number;
  seasonWins: number;
  personalRating: number;
}

export interface ArenaTeamRoster {
  teamId: number;
  /** 2, 3 or 5. */
  type: number;
  members: ArenaTeamMember[];
}

/**
 * Who is on the team.
 *
 * The count sits between two bytes of the header rather than in front of the list, and the byte
 * before it is a 3.0.8 flag the core hard-codes to zero — the branch it would take appends two
 * floats per member and is commented out. Reading it as part of the count, or skipping it, moves
 * every member field by one byte and produces names that decode and numbers that do not.
 */
export function parseArenaTeamRoster(payload: Uint8Array): ArenaTeamRoster {
  const reader = new PacketReader(payload);
  const teamId = reader.u32();
  reader.u8(); // 3.0.8 flag, always zero here; when set it would append two floats per member.
  const count = reader.u32();
  const type = reader.u32();
  const members: ArenaTeamMember[] = [];
  for (let index = 0; index < count; index++) {
    members.push({
      guid: reader.u64(),
      online: reader.u8() !== 0,
      name: reader.cString(),
      captain: reader.u32() === 0,
      level: reader.u8(),
      classId: reader.u8(),
      weekGames: reader.u32(),
      weekWins: reader.u32(),
      seasonGames: reader.u32(),
      seasonWins: reader.u32(),
      personalRating: reader.u32(),
    });
  }
  reader.assertFinished();
  return { teamId, type, members };
}

/**
 * `ArenaTeamEvents` in ArenaTeam.h, with the string order each one is broadcast with.
 *
 * `ERR_ARENA_TEAM_LEADER_IS_SS` — 6 — is declared and never broadcast anywhere in this core, so it
 * is named for completeness rather than handled.
 */
export const ARENA_TEAM_EVENT_JOINED = 3;
export const ARENA_TEAM_EVENT_LEFT = 4;
export const ARENA_TEAM_EVENT_REMOVED = 5;
export const ARENA_TEAM_EVENT_LEADER_IS = 6;
export const ARENA_TEAM_EVENT_LEADER_CHANGED = 7;
export const ARENA_TEAM_EVENT_DISBANDED = 8;

export interface ArenaTeamEvent {
  /** An `ARENA_TEAM_EVENT_*` value. */
  event: number;
  /** One to three names, in the order the event's own message expects them. */
  strings: string[];
  /** Zero unless the event named somebody by guid, which only the join and leave events do. */
  guid: bigint;
}

/**
 * Something that happened to the team, broadcast to everyone on it.
 *
 * The trailing guid is written only when it is non-zero, and nothing marks its absence — the core
 * simply stops. So it is read from what is left rather than from a flag, which is safe here
 * because the strings before it are terminated and the guid is the last field there is.
 */
export function parseArenaTeamEvent(payload: Uint8Array): ArenaTeamEvent {
  const reader = new PacketReader(payload);
  const event = reader.u8();
  const count = reader.u8();
  const strings: string[] = [];
  for (let index = 0; index < count; index++) strings.push(reader.cString());
  const guid = reader.remaining >= 8 ? reader.u64() : 0n;
  reader.assertFinished();
  return { event, strings, guid };
}

/**
 * The wording, and with it the string order each event is broadcast with — which is not uniform:
 * a removal reads (removed, team, captain) while a change of captain reads (old, new, team), so a
 * single "first name, second name" reading gets one of the two backwards.
 */
const ARENA_TEAM_EVENTS: Record<number, (names: string[]) => string> = {
  [ARENA_TEAM_EVENT_JOINED]: ([player, team]) => `${player ?? "Игрок"} вступает в команду ${team ?? ""}`.trim(),
  [ARENA_TEAM_EVENT_LEFT]: ([player, team]) => `${player ?? "Игрок"} покидает команду ${team ?? ""}`.trim(),
  [ARENA_TEAM_EVENT_REMOVED]: ([player, team, captain]) => `${captain ?? "Капитан"} исключает ${player ?? "игрока"} из команды ${team ?? ""}`.trim(),
  [ARENA_TEAM_EVENT_LEADER_IS]: ([player, team]) => `${player ?? "Игрок"} — капитан команды ${team ?? ""}`.trim(),
  [ARENA_TEAM_EVENT_LEADER_CHANGED]: ([oldCaptain, newCaptain, team]) => `${oldCaptain ?? "Капитан"} передаёт команду ${team ?? ""} игроку ${newCaptain ?? ""}`.trim(),
  [ARENA_TEAM_EVENT_DISBANDED]: ([captain, team]) => `${captain ?? "Капитан"} распускает команду ${team ?? ""}`.trim(),
};

export function arenaTeamEventText(event: ArenaTeamEvent): string {
  const worded = ARENA_TEAM_EVENTS[event.event];
  return worded ? worded(event.strings) : `Команда арены: событие ${event.event} ${event.strings.join(" ")}`.trim();
}

export interface ArenaTeamInvite {
  /** Who is inviting. */
  playerName: string;
  teamName: string;
}

/**
 * An invitation. It names neither the team id nor its size, so the answer — `CMSG_ARENA_TEAM_ACCEPT`
 * — carries nothing either: the server remembers which team the invitation was for.
 */
export function parseArenaTeamInvite(payload: Uint8Array): ArenaTeamInvite {
  const reader = new PacketReader(payload);
  const playerName = reader.cString();
  const teamName = reader.cString();
  reader.assertFinished();
  return { playerName, teamName };
}

export interface ArenaTeamCommandResult {
  /** An `ArenaTeamCommandTypes` value: which command is being answered. */
  action: number;
  teamName: string;
  playerName: string;
  /** An `ArenaTeamCommandErrors` value. There is no success code: success sends an event instead. */
  error: number;
}

export function parseArenaTeamCommandResult(payload: Uint8Array): ArenaTeamCommandResult {
  const reader = new PacketReader(payload);
  const result: ArenaTeamCommandResult = {
    action: reader.u32(),
    teamName: reader.cString(),
    playerName: reader.cString(),
    error: reader.u32(),
  };
  reader.assertFinished();
  return result;
}

/**
 * `ArenaTeamCommandErrors` in ArenaTeam.h.
 *
 * Two of them share the value 8 — `ERR_ARENA_TEAM_LEADER_LEAVE_S` and `ERR_ARENA_TEAM_PERMISSIONS`
 * — so that code cannot be told apart on the wire. The wording here is the permissions one, which
 * is the reachable case for a client that is not the captain.
 */
const ARENA_TEAM_ERRORS: Record<number, string> = {
  0x01: "Внутренняя ошибка команды арены",
  0x02: "Вы уже в команде арены такого размера",
  0x03: "%s уже в команде арены такого размера",
  0x04: "Вас уже пригласили в команду арены",
  0x05: "%s уже приглашён в команду арены",
  0x06: "Недопустимое название команды",
  0x07: "Команда с названием «%t» уже есть",
  0x08: "У вас нет на это прав",
  0x09: "Вы не состоите в команде арены такого размера",
  0x0a: "%s не состоит в команде «%t»",
  0x0b: "«%s» не найден",
  0x0c: "Нельзя приглашать игроков враждебной фракции",
  0x13: "%s вас игнорирует",
  0x15: "%s слишком низкого уровня",
  0x16: "%s слишком высокого уровня",
  0x17: "Команда «%t» заполнена",
  0x1b: "Команда арены не найдена",
  0x1e: "Команды арены заблокированы",
};

export function arenaTeamCommandResultText(result: ArenaTeamCommandResult): string {
  const template = ARENA_TEAM_ERRORS[result.error];
  if (!template) return `Команда арены: код ${result.error}`;
  return template.replace("%s", result.playerName).replace("%t", result.teamName);
}

export interface ArenaError {
  /** Zero in every reachable path; when it is not zero, no team type follows. */
  code: number;
  /** 2, 3 or 5 — the arena size the player has no team for. */
  teamType: number;
}

/**
 * "You are not in a 3v3 arena team", and nothing else uses this opcode.
 *
 * The team-type byte is written only when the leading word is zero, which it always is — the core
 * assigns `unk = 0` and then tests it. So the packet is five bytes in practice and four in theory,
 * and the reader honours the condition rather than the length so a non-zero code still parses.
 */
export function parseArenaError(payload: Uint8Array): ArenaError {
  const reader = new PacketReader(payload);
  const code = reader.u32();
  const teamType = code === 0 && reader.remaining >= 1 ? reader.u8() : 0;
  reader.assertFinished();
  return { code, teamType };
}

export function arenaErrorText(error: ArenaError): string {
  if (error.teamType > 0) return `Вы не состоите в команде арены ${error.teamType}×${error.teamType}`;
  return `Ошибка арены: код ${error.code}`;
}

export interface InspectedArenaTeam {
  guid: bigint;
  /** 0, 1 or 2 — the slot, not the team size. */
  slot: number;
  teamId: number;
  /** The team's rating, and then the same member's own. */
  teamRating: number;
  seasonGames: number;
  seasonWins: number;
  /** How many games this member played, which is not the team's season total. */
  memberSeasonGames: number;
  personalRating: number;
}

/**
 * One arena team of somebody being inspected. The server sends one packet per team they are on, so
 * up to three arrive for one request, and only the slot inside tells them apart.
 */
export function parseInspectArenaTeams(payload: Uint8Array): InspectedArenaTeam {
  const reader = new PacketReader(payload);
  const team: InspectedArenaTeam = {
    guid: reader.u64(),
    slot: reader.u8(),
    teamId: reader.u32(),
    teamRating: reader.u32(),
    seasonGames: reader.u32(),
    seasonWins: reader.u32(),
    memberSeasonGames: reader.u32(),
    personalRating: reader.u32(),
  };
  reader.assertFinished();
  return team;
}

export interface HonorStats {
  guid: bigint;
  /**
   * Honor points, truncated to a byte by the core — `data << uint8(player->GetHonorPoints())`
   * against a `uint32` field. Anybody past 255 points inspects as their total modulo 256, and
   * there is no way to recover the real number from this packet.
   */
  honorPoints: number;
  /** Honorable kills today. */
  kills: number;
  todayHonor: number;
  yesterdayHonor: number;
  lifetimeKills: number;
}

/** Somebody else's honor, answered on the same opcode the client asks with. */
export function parseInspectHonorStats(payload: Uint8Array): HonorStats {
  const reader = new PacketReader(payload);
  const stats: HonorStats = {
    guid: reader.u64(),
    honorPoints: reader.u8(),
    kills: reader.u32(),
    todayHonor: reader.u32(),
    yesterdayHonor: reader.u32(),
    lifetimeKills: reader.u32(),
  };
  reader.assertFinished();
  return stats;
}

/** Asking for a team's tabard and record. The server answers with the query response and the stats. */
export function buildArenaTeamQuery(teamId: number): Uint8Array {
  return new PacketWriter().u32(teamId).toUint8Array();
}

export function buildArenaTeamRosterQuery(teamId: number): Uint8Array {
  return new PacketWriter().u32(teamId).toUint8Array();
}

/** Inviting somebody. An empty name is refused by the server rather than treated as the target. */
export function buildArenaTeamInvite(teamId: number, name: string): Uint8Array {
  return new PacketWriter().u32(teamId).cString(name).toUint8Array();
}

/** Both answers are empty: the server remembers which team the invitation was for. */
export function buildArenaTeamAccept(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

export function buildArenaTeamDecline(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

export function buildArenaTeamLeave(teamId: number): Uint8Array {
  return new PacketWriter().u32(teamId).toUint8Array();
}

export function buildArenaTeamRemove(teamId: number, name: string): Uint8Array {
  return new PacketWriter().u32(teamId).cString(name).toUint8Array();
}

export function buildArenaTeamDisband(teamId: number): Uint8Array {
  return new PacketWriter().u32(teamId).toUint8Array();
}

/** Handing the team over. Same shape as removing somebody, and one letter apart in the opcode name. */
export function buildArenaTeamLeader(teamId: number, name: string): Uint8Array {
  return new PacketWriter().u32(teamId).cString(name).toUint8Array();
}

/** Both inspections are a bare guid on the same opcode the answer arrives on. */
export function buildInspectArenaTeams(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

export function buildInspectHonorStats(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}
