import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: GuildPackets.cpp (`GuildRoster::Write`, the
// roster member and rank serialisers, `QueryGuildInfoResponse::Write`, `GuildInfoResponse::Write`,
// `GuildCommandResult::Write`, `GuildInvite::Write`, `GuildEvent::Write`) and Guild.h for the
// limits and enums.

/** `GUILD_RANKS_MAX_COUNT` in Guild.h: the query response always writes ten rank names. */
export const GUILD_RANKS_MAX_COUNT = 10;
/** `GUILD_BANK_MAX_TABS` in Guild.h: every rank carries this many tab permission pairs. */
export const GUILD_BANK_MAX_TABS = 6;

/** `GuildCommandType` in Guild.h. */
export const GUILD_COMMAND_INVITE = 1;
export const GUILD_COMMAND_QUIT = 3;
export const GUILD_COMMAND_ROSTER = 5;
export const GUILD_COMMAND_PROMOTE = 6;
export const GUILD_COMMAND_DEMOTE = 7;
export const GUILD_COMMAND_REMOVE = 8;

/** `GuildEvents` in Guild.h: only these four append a GUID after the string parameters. */
export const GE_JOINED = 3;
export const GE_LEFT = 4;
export const GE_SIGNED_ON = 12;
export const GE_SIGNED_OFF = 13;
export const GE_MOTD = 2;

export interface GuildRank {
  flags: number;
  withdrawGoldLimit: number;
}

export interface GuildMember {
  guid: bigint;
  /** Zero means offline, and only then does the packet carry `lastSaveDays`. */
  status: number;
  online: boolean;
  name: string;
  rankId: number;
  level: number;
  classId: number;
  gender: number;
  areaId: number;
  /** Days since the member last logged out; absent while they are online. */
  lastSaveDays: number;
  note: string;
  officerNote: string;
}

export interface GuildRoster {
  welcomeText: string;
  infoText: string;
  ranks: GuildRank[];
  members: GuildMember[];
}

export function parseGuildRoster(payload: Uint8Array): GuildRoster {
  const reader = new PacketReader(payload);
  const memberCount = reader.u32();
  if (memberCount > 2000) throw new RangeError(`Guild roster declares ${memberCount} members`);
  const welcomeText = reader.cString();
  const infoText = reader.cString();
  const rankCount = reader.u32();
  if (rankCount > 64) throw new RangeError(`Guild roster declares ${rankCount} ranks`);
  const ranks: GuildRank[] = [];
  for (let index = 0; index < rankCount; index++) {
    const flags = reader.u32();
    const withdrawGoldLimit = reader.u32();
    // Each rank carries a permission and a withdraw limit for every bank tab.
    for (let tab = 0; tab < GUILD_BANK_MAX_TABS; tab++) {
      reader.u32();
      reader.u32();
    }
    ranks.push({ flags, withdrawGoldLimit });
  }
  const members: GuildMember[] = [];
  for (let index = 0; index < memberCount; index++) {
    const guid = reader.u64();
    const status = reader.u8();
    const name = reader.cString();
    const rankId = reader.i32();
    const level = reader.u8();
    const classId = reader.u8();
    const gender = reader.u8();
    const areaId = reader.i32();
    // The last-save timestamp is written only for offline members.
    const lastSaveDays = status === 0 ? reader.f32() : 0;
    members.push({
      guid, status, online: status !== 0, name, rankId, level, classId, gender, areaId,
      lastSaveDays, note: reader.cString(), officerNote: reader.cString(),
    });
  }
  return { welcomeText, infoText, ranks, members };
}

export interface GuildQueryInfo {
  guildId: number;
  name: string;
  /** Always ten entries, padded with empty strings past the real rank count. */
  rankNames: string[];
  emblemStyle: number;
  emblemColor: number;
  borderStyle: number;
  borderColor: number;
  backgroundColor: number;
  rankCount: number;
}

export function parseGuildQueryResponse(payload: Uint8Array): GuildQueryInfo {
  const reader = new PacketReader(payload);
  const guildId = reader.u32();
  const name = reader.cString();
  const rankNames: string[] = [];
  for (let index = 0; index < GUILD_RANKS_MAX_COUNT; index++) rankNames.push(reader.cString());
  return {
    guildId,
    name,
    rankNames,
    emblemStyle: reader.u32(),
    emblemColor: reader.u32(),
    borderStyle: reader.u32(),
    borderColor: reader.u32(),
    backgroundColor: reader.u32(),
    rankCount: reader.u32(),
  };
}

export interface GuildInfo {
  name: string;
  createdYear: number;
  createdMonth: number;
  createdDay: number;
  memberCount: number;
  accountCount: number;
}

/**
 * Unpacks the `WowTime` word the server writes for dates. `WowTime::GetPackedTime` lays it out as
 * minute in bits 0-5, hour 6-10, weekday 11-13, day of month 14-19, month 20-23 and a two digit
 * year in 24-28.
 */
export function unpackWowTime(packed: number): { year: number; month: number; day: number; hour: number; minute: number } {
  return {
    year: 2000 + ((packed >>> 24) & 0x1f),
    month: ((packed >>> 20) & 0x0f) + 1,
    day: ((packed >>> 14) & 0x3f) + 1,
    hour: (packed >>> 6) & 0x1f,
    minute: packed & 0x3f,
  };
}

/**
 * The same word, built rather than read.
 *
 * The calendar needs it: every date a client sends — an event's time, its lock date, the day a copy
 * lands on — goes out in this format and not as a unix time. Weekday bits 11-13 are written too
 * because the server keeps them; a wrong weekday shows up as a day in the wrong column.
 */
export function packWowTime(date: { year: number; month: number; day: number; hour: number; minute: number }): number {
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return (((date.year - 2000) & 0x1f) << 24)
    | (((date.month - 1) & 0x0f) << 20)
    | (((date.day - 1) & 0x3f) << 14)
    | ((weekday & 0x07) << 11)
    | ((date.hour & 0x1f) << 6)
    | (date.minute & 0x3f);
}

/** `GuildInfoResponse` writes the creation date as one packed `WowTime` word, not three fields. */
export function parseGuildInfo(payload: Uint8Array): GuildInfo {
  const reader = new PacketReader(payload);
  const name = reader.cString();
  const created = unpackWowTime(reader.u32());
  return {
    name,
    createdYear: created.year,
    createdMonth: created.month,
    createdDay: created.day,
    memberCount: reader.i32(),
    accountCount: reader.i32(),
  };
}

export interface GuildCommandResult {
  command: number;
  name: string;
  result: number;
}

export function parseGuildCommandResult(payload: Uint8Array): GuildCommandResult {
  const reader = new PacketReader(payload);
  const command = reader.i32();
  const name = reader.cString();
  const result = reader.i32();
  return { command, name, result };
}

export interface GuildInviteMessage {
  inviterName: string;
  guildName: string;
}

export function parseGuildInvite(payload: Uint8Array): GuildInviteMessage {
  const reader = new PacketReader(payload);
  return { inviterName: reader.cString(), guildName: reader.cString() };
}

export interface GuildEvent {
  type: number;
  params: string[];
  /** Only the join, leave, sign on and sign off events append a GUID. */
  guid: bigint;
}

export function parseGuildEvent(payload: Uint8Array): GuildEvent {
  const reader = new PacketReader(payload);
  const type = reader.u8();
  const count = reader.u8();
  const params: string[] = [];
  for (let index = 0; index < count; index++) params.push(reader.cString());
  const carriesGuid = type === GE_JOINED || type === GE_LEFT || type === GE_SIGNED_ON || type === GE_SIGNED_OFF;
  const guid = carriesGuid && reader.remaining >= 8 ? reader.u64() : 0n;
  return { type, params, guid };
}

export function buildGuildQuery(guildId: number): Uint8Array {
  return new PacketWriter().u32(guildId).toUint8Array();
}

export function buildGuildInviteByName(name: string): Uint8Array {
  return new PacketWriter().cString(name).toUint8Array();
}

export function buildGuildPlayerName(name: string): Uint8Array {
  return new PacketWriter().cString(name).toUint8Array();
}

/**
 * `CMSG_GUILD_RANK`: one rank's whole permission row.
 *
 * The six tab pairs are always written, whatever the guild has bought — `GuildSetRankPermissions`
 * reads `GUILD_BANK_MAX_TABS` of them unconditionally, and stopping early leaves the server reading
 * the next packet's bytes as tab rights.
 */
export function buildGuildRank(
  rankId: number, flags: number, name: string, withdrawGoldLimit: number,
  tabs: ReadonlyArray<{ rights: number; slots: number }>,
): Uint8Array {
  const writer = new PacketWriter().u32(rankId).u32(flags).cString(name).u32(withdrawGoldLimit);
  for (let tab = 0; tab < GUILD_BANK_MAX_TABS; tab++) {
    const entry = tabs[tab];
    writer.u32(entry?.rights ?? 0).u32(entry?.slots ?? 0);
  }
  return writer.toUint8Array();
}

/** `CMSG_GUILD_ADD_RANK`: the new rank's name, appended at the bottom. */
export function buildGuildAddRank(name: string): Uint8Array {
  return new PacketWriter().cString(name).toUint8Array();
}

/** `CMSG_GUILD_DEL_RANK` reads nothing — it always removes the lowest rank. */
export function buildGuildDelRank(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

/** `CMSG_GUILD_SET_PUBLIC_NOTE` and `_OFFICER_NOTE` share one layout. */
export function buildGuildMemberNote(name: string, note: string): Uint8Array {
  return new PacketWriter().cString(name).cString(note).toUint8Array();
}

/** `CMSG_GUILD_INFO_TEXT`: the long "about the guild" text, not the message of the day. */
export function buildGuildInfoText(text: string): Uint8Array {
  return new PacketWriter().cString(text).toUint8Array();
}

/** `CMSG_GUILD_LEADER` hands the guild over **by name**, like most of this family. */
export function buildGuildLeader(name: string): Uint8Array {
  return new PacketWriter().cString(name).toUint8Array();
}

/** `CMSG_GUILD_DISBAND` reads nothing. */
export function buildGuildDisband(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

export function buildGuildMotd(text: string): Uint8Array {
  return new PacketWriter().cString(text).toUint8Array();
}

// `GuildCommandError` in Guild.h. Values 8 and later repeat for permissions, so only the ones
// a player actually meets are named.
const GUILD_ERRORS: Record<number, string> = {
  0: "Готово",
  1: "Внутренняя ошибка",
  2: "Вы уже в гильдии",
  3: "Игрок уже в гильдии",
  4: "Вас уже пригласили в гильдию",
  5: "Игрока уже пригласили",
  6: "Недопустимое название",
  7: "Такая гильдия уже есть",
  8: "Нет прав или лидер не может выйти",
  9: "Вы не состоите в гильдии",
  10: "Игрок не в вашей гильдии",
  11: "Игрок не найден",
  12: "Игрок из другой фракции",
  13: "Ранг слишком высок",
  14: "Ранг слишком низок",
  17: "Ранги заблокированы",
  18: "Ранг используется",
  19: "Игрок вас игнорирует",
  25: "Превышен лимит снятия",
  26: "В казне не хватает денег",
};

export function guildErrorText(result: number, name: string): string {
  const text = GUILD_ERRORS[result] ?? `Ошибка гильдии (код ${result})`;
  return name ? `${name}: ${text}` : text;
}
