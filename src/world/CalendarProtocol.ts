import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";
import { packWowTime, unpackWowTime } from "./GuildProtocol.js";

// Layouts follow the active TrinityCore source: CalendarPackets.cpp (every `Write` in the family
// plus the five helper `operator<<` overloads the calendar dump uses), CalendarMgr.cpp for what
// fills them, and CalendarHandler.cpp for the calendar dump and the three raid lockout packets.
//
// Almost every time in this family is a packed `WowTime` word rather than a unix timestamp, and
// `SMSG_CALENDAR_SEND_CALENDAR` writes one of each kind side by side. Each field below says which
// it is; `unpackWowTime` decodes the packed form, and the raw ones are seconds since 1970.

/** `CalendarInviteStatus` in CalendarMgr.h — the values a player actually sees. */
export const CALENDAR_STATUS_INVITED = 0;
export const CALENDAR_STATUS_ACCEPTED = 1;
export const CALENDAR_STATUS_DECLINED = 2;
export const CALENDAR_STATUS_CONFIRMED = 3;
export const CALENDAR_STATUS_OUT = 4;
export const CALENDAR_STATUS_STANDBY = 5;
export const CALENDAR_STATUS_SIGNED_UP = 6;
export const CALENDAR_STATUS_NOT_SIGNED_UP = 7;
export const CALENDAR_STATUS_TENTATIVE = 8;
export const CALENDAR_STATUS_REMOVED = 9;

/** `CalendarModerationRank` in CalendarMgr.h. */
export const CALENDAR_RANK_PLAYER = 0;
export const CALENDAR_RANK_MODERATOR = 1;
export const CALENDAR_RANK_OWNER = 2;

/** `CalendarSendEventType` in CalendarMgr.h: why `SMSG_CALENDAR_SEND_EVENT` arrived. */
export const CALENDAR_SEND_GET = 0;
export const CALENDAR_SEND_ADD = 1;
export const CALENDAR_SEND_COPY = 2;

/** Fixed array widths in a holiday entry: `MAX_HOLIDAY_DATES`, `_DURATIONS` and `_FLAGS`. */
export const MAX_HOLIDAY_DATES = 26;
export const MAX_HOLIDAY_DURATIONS = 10;
export const MAX_HOLIDAY_FLAGS = 10;

export { packWowTime, unpackWowTime };

export interface CalendarInitialInvite {
  guid: bigint;
  /** The guild filter sends real levels; the arena team path sends a literal zero for everyone. */
  level: number;
}

/**
 * `SMSG_CALENDAR_ARENA_TEAM` and `SMSG_CALENDAR_FILTER_GUILD` are the same class with the opcode
 * chosen by a flag, so one parser serves both.
 */
export function parseCalendarInitialInvites(payload: Uint8Array): CalendarInitialInvite[] {
  const reader = new PacketReader(payload);
  const count = reader.u32();
  if (count > 1000) throw new RangeError(`Calendar invite list declares ${count} entries`);
  const invites: CalendarInitialInvite[] = [];
  for (let index = 0; index < count; index++) {
    invites.push({ guid: reader.packedGuid(), level: reader.u8() });
  }
  reader.assertFinished();
  return invites;
}

export interface CalendarCommandResult {
  /** Widened from a byte, and hardcoded to one by every sender. */
  command: number;
  name: string;
  /** `CalendarError` in CalendarMgr.h. */
  result: number;
}

/**
 * Two strings in a row, the first of which the core writes as a literal empty one. Reading a
 * single string here leaves the packet one byte short and the result code garbage.
 */
export function parseCalendarCommandResult(payload: Uint8Array): CalendarCommandResult {
  const reader = new PacketReader(payload);
  const command = reader.u32();
  reader.cString();
  const name = reader.cString();
  const result = reader.u32();
  reader.assertFinished();
  return { command, name, result };
}

export interface CalendarInviteAdded {
  inviteeGuid: bigint;
  /** Zero while the invite is still being composed and no event exists yet. */
  eventId: bigint;
  inviteId: bigint;
  level: number;
  status: number;
  /** One for a guild event. It is also what decides whether a response time follows. */
  type: number;
  /** Packed `WowTime`, and only present on a guild event. */
  responseTime: number | undefined;
  clearPending: boolean;
}

/** The one variable-length packet of the family: a non-guild invite is four bytes shorter. */
export function parseCalendarInviteAdded(payload: Uint8Array): CalendarInviteAdded {
  const reader = new PacketReader(payload);
  const inviteeGuid = reader.packedGuid();
  const eventId = reader.u64();
  const inviteId = reader.u64();
  const level = reader.u8();
  const status = reader.u8();
  const type = reader.u8();
  const responseTime = type === 1 ? reader.u32() : undefined;
  const clearPending = reader.u8() !== 0;
  reader.assertFinished();
  return { inviteeGuid, eventId, inviteId, level, status, type, responseTime, clearPending };
}

export interface CalendarInviteAlert {
  eventId: bigint;
  name: string;
  /** Packed `WowTime`, already shifted into the receiving session's timezone by the server. */
  date: number;
  flags: number;
  /** Widened from the byte an event type really is. */
  eventType: number;
  textureId: number;
  inviteId: bigint;
  status: number;
  moderatorStatus: number;
  ownerGuid: bigint;
  invitedByGuid: bigint;
}

/** Ends on two packed guids in a row; both are packed, neither is eight bytes. */
export function parseCalendarInviteAlert(payload: Uint8Array): CalendarInviteAlert {
  const reader = new PacketReader(payload);
  const alert: CalendarInviteAlert = {
    eventId: reader.u64(),
    name: reader.cString(),
    date: reader.u32(),
    flags: reader.u32(),
    eventType: reader.u32(),
    textureId: reader.i32(),
    inviteId: reader.u64(),
    status: reader.u8(),
    moderatorStatus: reader.u8(),
    ownerGuid: reader.packedGuid(),
    invitedByGuid: reader.packedGuid(),
  };
  reader.assertFinished();
  return alert;
}

export interface CalendarInviteNotes {
  inviteGuid: bigint;
  eventId: bigint;
  notes: string;
  clearPending: boolean;
}

/**
 * `SMSG_CALENDAR_EVENT_INVITE_NOTES`. The core compiles this writer and never constructs it, so
 * the layout is read off real code but the packet does not arrive from this build.
 */
export function parseCalendarInviteNotes(payload: Uint8Array): CalendarInviteNotes {
  const reader = new PacketReader(payload);
  const inviteGuid = reader.packedGuid();
  const eventId = reader.u64();
  const notes = reader.cString();
  const clearPending = reader.u8() !== 0;
  reader.assertFinished();
  return { inviteGuid, eventId, notes, clearPending };
}

/** `SMSG_CALENDAR_EVENT_INVITE_NOTES_ALERT`, likewise compiled and never constructed. */
export function parseCalendarInviteNotesAlert(payload: Uint8Array): { eventId: bigint; notes: string } {
  const reader = new PacketReader(payload);
  const eventId = reader.u64();
  const notes = reader.cString();
  reader.assertFinished();
  return { eventId, notes };
}

export interface CalendarInviteRemoved {
  inviteGuid: bigint;
  eventId: bigint;
  flags: number;
  clearPending: boolean;
}

/** Built once and sent to everyone concerned, so this one is not rebuilt per recipient. */
export function parseCalendarInviteRemoved(payload: Uint8Array): CalendarInviteRemoved {
  const reader = new PacketReader(payload);
  const inviteGuid = reader.packedGuid();
  const eventId = reader.u64();
  const flags = reader.u32();
  const clearPending = reader.u8() !== 0;
  reader.assertFinished();
  return { inviteGuid, eventId, flags, clearPending };
}

export interface CalendarEventStatusAlert {
  eventId: bigint;
  /** Packed `WowTime`. */
  date: number;
  flags: number;
  status: number;
}

/**
 * `SMSG_CALENDAR_EVENT_INVITE_REMOVED_ALERT`, and byte for byte also the never-constructed
 * `SMSG_CALENDAR_EVENT_INVITE_STATUS_ALERT`. The live one only goes to the removed player and only
 * for a non-guild event, and its status is always "removed".
 */
export function parseCalendarEventStatusAlert(payload: Uint8Array): CalendarEventStatusAlert {
  const reader = new PacketReader(payload);
  const alert: CalendarEventStatusAlert = {
    eventId: reader.u64(),
    date: reader.u32(),
    flags: reader.u32(),
    status: reader.u8(),
  };
  reader.assertFinished();
  return alert;
}

export interface CalendarModeratorStatus {
  inviteGuid: bigint;
  eventId: bigint;
  /**
   * Named for the moderator rank and filled with the invite status: the core assigns
   * `invite.GetStatus()` here. Read it as a status, not a rank.
   */
  status: number;
  clearPending: boolean;
}

export function parseCalendarModeratorStatus(payload: Uint8Array): CalendarModeratorStatus {
  const reader = new PacketReader(payload);
  const inviteGuid = reader.packedGuid();
  const eventId = reader.u64();
  const status = reader.u8();
  const clearPending = reader.u8() !== 0;
  reader.assertFinished();
  return { inviteGuid, eventId, status, clearPending };
}

export interface CalendarEventRemovedAlert {
  clearPending: boolean;
  eventId: bigint;
  /** Packed `WowTime`. */
  date: number;
}

/** The pending flag leads here, where the rest of the family leads with the event id. */
export function parseCalendarEventRemovedAlert(payload: Uint8Array): CalendarEventRemovedAlert {
  const reader = new PacketReader(payload);
  const clearPending = reader.u8() !== 0;
  const eventId = reader.u64();
  const date = reader.u32();
  reader.assertFinished();
  return { clearPending, eventId, date };
}

export interface CalendarEventStatus {
  inviteGuid: bigint;
  eventId: bigint;
  /** Packed `WowTime`. */
  date: number;
  flags: number;
  status: number;
  clearPending: boolean;
  /** Packed `WowTime`, a second one, six bytes past the first: a flags word and two flags. */
  responseTime: number;
}

export function parseCalendarEventStatus(payload: Uint8Array): CalendarEventStatus {
  const reader = new PacketReader(payload);
  const status: CalendarEventStatus = {
    inviteGuid: reader.packedGuid(),
    eventId: reader.u64(),
    date: reader.u32(),
    flags: reader.u32(),
    status: reader.u8(),
    clearPending: reader.u8() !== 0,
    responseTime: reader.u32(),
  };
  reader.assertFinished();
  return status;
}

export interface CalendarEventUpdatedAlert {
  clearPending: boolean;
  eventId: bigint;
  /** Packed `WowTime` — the date before the edit, and it comes before the flags. */
  originalDate: number;
  flags: number;
  /** Packed `WowTime` — the date after it, and this one comes after the flags. */
  date: number;
  eventType: number;
  textureId: number;
  name: string;
  description: string;
  /** Written as a literal by the core, not carried by the event. */
  repeatable: number;
  maxInvites: number;
  /**
   * Packed `WowTime`. An event with no lock date still gets one: the core packs unix zero, which
   * is not zero but a word derived from 1970. Trust it only when the flags say the event locks.
   */
  lockDate: number;
}

export function parseCalendarEventUpdatedAlert(payload: Uint8Array): CalendarEventUpdatedAlert {
  const reader = new PacketReader(payload);
  const alert: CalendarEventUpdatedAlert = {
    clearPending: reader.u8() !== 0,
    eventId: reader.u64(),
    originalDate: reader.u32(),
    flags: reader.u32(),
    date: reader.u32(),
    eventType: reader.u8(),
    textureId: reader.u32(),
    name: reader.cString(),
    description: reader.cString(),
    repeatable: reader.u8(),
    maxInvites: reader.u32(),
    lockDate: reader.u32(),
  };
  reader.assertFinished();
  return alert;
}

export interface RaidLockoutChange {
  /** Packed `WowTime` on the added and updated packets; absent from the removed one. */
  serverTime: number | undefined;
  mapId: number;
  difficulty: number;
  /** Seconds, signed and unclamped: an expired save reports a negative number. */
  timeRemaining: number;
  /** Only on the updated packet, and the core hardcodes it to zero. */
  oldTimeRemaining: number | undefined;
  /** Absent from the updated packet, which identifies the lockout by map and difficulty alone. */
  instanceId: bigint | undefined;
}

/**
 * Three shapes for one idea. Added leads with a server time and ends with an instance id; removed
 * drops the leading time, so every field after it sits four bytes earlier; updated keeps the time,
 * carries the old and new remainders and has no instance id at all.
 *
 * The updated form is dead in this build — its only caller is commented out — but its writer is
 * complete, so it is read rather than guessed.
 */
export function parseRaidLockoutAdded(payload: Uint8Array): RaidLockoutChange {
  const reader = new PacketReader(payload);
  const change: RaidLockoutChange = {
    serverTime: reader.u32(),
    mapId: reader.i32(),
    difficulty: reader.u32(),
    timeRemaining: reader.i32(),
    oldTimeRemaining: undefined,
    instanceId: reader.u64(),
  };
  reader.assertFinished();
  return change;
}

export function parseRaidLockoutRemoved(payload: Uint8Array): RaidLockoutChange {
  const reader = new PacketReader(payload);
  const change: RaidLockoutChange = {
    serverTime: undefined,
    mapId: reader.i32(),
    difficulty: reader.u32(),
    timeRemaining: reader.i32(),
    oldTimeRemaining: undefined,
    instanceId: reader.u64(),
  };
  reader.assertFinished();
  return change;
}

export function parseRaidLockoutUpdated(payload: Uint8Array): RaidLockoutChange {
  const reader = new PacketReader(payload);
  const serverTime = reader.u32();
  const mapId = reader.i32();
  const difficulty = reader.u32();
  const oldTimeRemaining = reader.i32();
  const timeRemaining = reader.i32();
  reader.assertFinished();
  return { serverTime, mapId, difficulty, timeRemaining, oldTimeRemaining, instanceId: undefined };
}

export interface CalendarPendingInvite {
  eventId: bigint;
  inviteId: bigint;
  status: number;
  moderator: number;
  /** One when the event belongs to the viewer's own guild. */
  inviteType: number;
  inviterGuid: bigint;
}

export interface CalendarEventSummary {
  eventId: bigint;
  name: string;
  eventType: number;
  /** Packed `WowTime`. */
  date: number;
  flags: number;
  textureId: number;
  ownerGuid: bigint;
}

export interface CalendarRaidLockout {
  mapId: number;
  difficulty: number;
  /** Seconds, clamped to zero here even though the standalone lockout packets do not clamp. */
  expireSeconds: number;
  instanceId: bigint;
}

export interface CalendarRaidReset {
  mapId: number;
  durationSeconds: number;
  offset: number;
}

export interface CalendarHoliday {
  holidayId: number;
  region: number;
  looping: number;
  priority: number;
  filterType: number;
  /** Twenty-six packed `WowTime` words, always all of them, zeros included. */
  dates: number[];
  durations: number[];
  flags: number[];
  textureFilename: string;
}

export interface CalendarSnapshot {
  invites: CalendarPendingInvite[];
  events: CalendarEventSummary[];
  /** Raw unix seconds — the only two in this packet, and the second one is packed instead. */
  serverNow: number;
  /** Packed `WowTime`, immediately after the raw one. */
  serverTime: number;
  lockouts: CalendarRaidLockout[];
  /** Raw unix seconds, a hardcoded constant the reset schedule counts from. */
  raidOrigin: number;
  resets: CalendarRaidReset[];
  holidays: CalendarHoliday[];
}

/**
 * Five counted lists and three scalars between them. The trap is the pair in the middle:
 * `serverNow` is a truncated unix time and `serverTime` is a packed `WowTime`, adjacent and the
 * same width, so reading both the same way looks like it works.
 */
export function parseCalendarSnapshot(payload: Uint8Array): CalendarSnapshot {
  const reader = new PacketReader(payload);

  const inviteCount = reader.u32();
  if (inviteCount > 5000) throw new RangeError(`Calendar declares ${inviteCount} invites`);
  const invites: CalendarPendingInvite[] = [];
  for (let index = 0; index < inviteCount; index++) {
    invites.push({
      eventId: reader.u64(),
      inviteId: reader.u64(),
      status: reader.u8(),
      moderator: reader.u8(),
      inviteType: reader.u8(),
      inviterGuid: reader.packedGuid(),
    });
  }

  const eventCount = reader.u32();
  if (eventCount > 5000) throw new RangeError(`Calendar declares ${eventCount} events`);
  const events: CalendarEventSummary[] = [];
  for (let index = 0; index < eventCount; index++) {
    events.push({
      eventId: reader.u64(),
      name: reader.cString(),
      eventType: reader.u32(),
      date: reader.u32(),
      flags: reader.u32(),
      textureId: reader.i32(),
      ownerGuid: reader.packedGuid(),
    });
  }

  const serverNow = reader.u32();
  const serverTime = reader.u32();

  const lockoutCount = reader.u32();
  if (lockoutCount > 5000) throw new RangeError(`Calendar declares ${lockoutCount} lockouts`);
  const lockouts: CalendarRaidLockout[] = [];
  for (let index = 0; index < lockoutCount; index++) {
    lockouts.push({
      mapId: reader.i32(),
      difficulty: reader.u32(),
      expireSeconds: reader.i32(),
      instanceId: reader.u64(),
    });
  }

  const raidOrigin = reader.u32();

  const resetCount = reader.u32();
  if (resetCount > 5000) throw new RangeError(`Calendar declares ${resetCount} resets`);
  const resets: CalendarRaidReset[] = [];
  for (let index = 0; index < resetCount; index++) {
    resets.push({ mapId: reader.i32(), durationSeconds: reader.i32(), offset: reader.i32() });
  }

  const holidayCount = reader.u32();
  if (holidayCount > 1000) throw new RangeError(`Calendar declares ${holidayCount} holidays`);
  const holidays: CalendarHoliday[] = [];
  for (let index = 0; index < holidayCount; index++) {
    const holidayId = reader.u32();
    const region = reader.u32();
    const looping = reader.u32();
    const priority = reader.u32();
    const filterType = reader.u32();
    const dates: number[] = [];
    for (let slot = 0; slot < MAX_HOLIDAY_DATES; slot++) dates.push(reader.u32());
    const durations: number[] = [];
    for (let slot = 0; slot < MAX_HOLIDAY_DURATIONS; slot++) durations.push(reader.i32());
    const flags: number[] = [];
    for (let slot = 0; slot < MAX_HOLIDAY_FLAGS; slot++) flags.push(reader.i32());
    holidays.push({
      holidayId, region, looping, priority, filterType, dates, durations, flags,
      textureFilename: reader.cString(),
    });
  }

  reader.assertFinished();
  return { invites, events, serverNow, serverTime, lockouts, raidOrigin, resets, holidays };
}

export interface CalendarEventInvite {
  guid: bigint;
  level: number;
  status: number;
  moderator: number;
  inviteType: number;
  inviteId: bigint;
  /** Packed `WowTime`, in the *viewer's* timezone rather than the invitee's. */
  responseTime: number;
  notes: string;
}

export interface CalendarEventDetail {
  /** Why this arrived: asked for, just added, or copied. Not the event's own type. */
  sendType: number;
  ownerGuid: bigint;
  eventId: bigint;
  name: string;
  description: string;
  /** This one is the event's real type, despite sitting after the description. */
  eventType: number;
  repeatable: number;
  maxInvites: number;
  textureId: number;
  flags: number;
  /** Packed `WowTime`. */
  date: number;
  /** Packed `WowTime`; an event with no lock still carries a 1970-derived word rather than zero. */
  lockDate: number;
  guildId: number;
  invites: CalendarEventInvite[];
}

/**
 * Two type bytes whose names read backwards: the first says why the packet came, the last says
 * what kind of event it is. Between the description and the texture the core writes two constants
 * that live nowhere in the event.
 */
export function parseCalendarEvent(payload: Uint8Array): CalendarEventDetail {
  const reader = new PacketReader(payload);
  const detail: CalendarEventDetail = {
    sendType: reader.u8(),
    ownerGuid: reader.packedGuid(),
    eventId: reader.u64(),
    name: reader.cString(),
    description: reader.cString(),
    eventType: reader.u8(),
    repeatable: reader.u8(),
    maxInvites: reader.u32(),
    textureId: reader.i32(),
    flags: reader.u32(),
    date: reader.u32(),
    lockDate: reader.u32(),
    guildId: reader.u32(),
    invites: [],
  };
  const count = reader.u32();
  if (count > 1000) throw new RangeError(`Calendar event declares ${count} invites`);
  for (let index = 0; index < count; index++) {
    detail.invites.push({
      guid: reader.packedGuid(),
      level: reader.u8(),
      status: reader.u8(),
      moderator: reader.u8(),
      inviteType: reader.u8(),
      inviteId: reader.u64(),
      responseTime: reader.u32(),
      // The trailing note is what makes an invite entry variable length: the list must be walked.
      notes: reader.cString(),
    });
  }
  reader.assertFinished();
  return detail;
}

/** How many invites are waiting for an answer. Drives the badge on the calendar button. */
export function parseCalendarPendingCount(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const pending = reader.u32();
  reader.assertFinished();
  return pending;
}

/** The calendar dump, the pending count and the pending-action clear are all asked for with nothing. */
export function buildCalendarQuery(): Uint8Array {
  return new Uint8Array(0);
}

export function buildCalendarPendingCountQuery(): Uint8Array {
  return new Uint8Array(0);
}

/** `CalendarGetEvent::Read` takes the event id alone; the invite id is not part of the request. */
export function buildCalendarEventQuery(eventId: bigint): Uint8Array {
  return new PacketWriter().u64(eventId).toUint8Array();
}

/** One invitee written into a new event. The guid is **packed** here, unlike everywhere else. */
export interface CalendarNewInvite {
  guid: bigint;
  status: number;
  moderator: number;
}

export interface CalendarEventFields {
  title: string;
  description: string;
  eventType: number;
  maxSize: number;
  textureId: number;
  /** Packed `WowTime`, not a unix second. */
  time: number;
  /** Packed `WowTime`. Zero when the event does not lock. */
  lockDate: number;
  flags: number;
}

/**
 * `CMSG_CALENDAR_ADD_EVENT`.
 *
 * The skipped byte after the event type is `Repeatable`, which the server reads and throws away —
 * it is a Cataclysm field the 3.3.5 client still writes.
 */
export function buildCalendarAddEvent(
  event: CalendarEventFields, invites: readonly CalendarNewInvite[] = [],
): Uint8Array {
  const writer = new PacketWriter()
    .cString(event.title)
    .cString(event.description)
    .u8(event.eventType)
    .u8(0)
    .u32(event.maxSize)
    .i32(event.textureId)
    .u32(event.time)
    .u32(event.lockDate)
    .u32(event.flags)
    .u32(invites.length);
  for (const invite of invites) writer.packedGuid(invite.guid).u8(invite.status).u8(invite.moderator);
  return writer.toUint8Array();
}

/** `CMSG_CALENDAR_UPDATE_EVENT`: the same fields again, with the event named and no invite list. */
export function buildCalendarUpdateEvent(
  eventId: bigint, moderatorId: bigint, event: CalendarEventFields,
): Uint8Array {
  return new PacketWriter()
    .u64(eventId)
    .u64(moderatorId)
    .cString(event.title)
    .cString(event.description)
    .u8(event.eventType)
    .u8(0)
    .u32(event.maxSize)
    .u32(event.textureId)
    .u32(event.time)
    .u32(event.lockDate)
    .u32(event.flags)
    .toUint8Array();
}

/** `CMSG_CALENDAR_REMOVE_EVENT`: the event, who is removing it, and whether it was a sign-up. */
export function buildCalendarRemoveEvent(eventId: bigint, moderatorId: bigint, isSignUp: boolean): Uint8Array {
  return new PacketWriter().u64(eventId).u64(moderatorId).u8(isSignUp ? 1 : 0).toUint8Array();
}

/** `CMSG_CALENDAR_COPY_EVENT`: the same event on another day. */
export function buildCalendarCopyEvent(eventId: bigint, moderatorId: bigint, date: number): Uint8Array {
  return new PacketWriter().u64(eventId).u64(moderatorId).u32(date).toUint8Array();
}

/** `CMSG_CALENDAR_EVENT_RSVP`: answering an invitation addressed to this character. */
export function buildCalendarRsvp(eventId: bigint, inviteId: bigint, status: number): Uint8Array {
  return new PacketWriter().u64(eventId).u64(inviteId).u8(status).toUint8Array();
}

/** `CMSG_CALENDAR_EVENT_INVITE`: inviting someone by name. */
export function buildCalendarInvite(
  eventId: bigint, moderatorId: bigint, name: string, creating: boolean, isSignUp: boolean,
): Uint8Array {
  return new PacketWriter()
    .u64(eventId).u64(moderatorId).cString(name).u8(creating ? 1 : 0).u8(isSignUp ? 1 : 0)
    .toUint8Array();
}

/** `CMSG_CALENDAR_EVENT_SIGNUP`: putting yourself down for a guild event nobody invited you to. */
export function buildCalendarSignUp(eventId: bigint, tentative: boolean): Uint8Array {
  return new PacketWriter().u64(eventId).u8(tentative ? 1 : 0).toUint8Array();
}

/** `CMSG_CALENDAR_EVENT_REMOVE_INVITE`: the invitee's guid is **packed** and comes first. */
export function buildCalendarRemoveInvite(
  guid: bigint, inviteId: bigint, moderatorId: bigint, eventId: bigint,
): Uint8Array {
  return new PacketWriter().packedGuid(guid).u64(inviteId).u64(moderatorId).u64(eventId).toUint8Array();
}

/** `CMSG_CALENDAR_EVENT_STATUS`: a moderator setting somebody else's status. */
export function buildCalendarEventStatus(
  guid: bigint, eventId: bigint, inviteId: bigint, moderatorId: bigint, status: number,
): Uint8Array {
  return new PacketWriter()
    .packedGuid(guid).u64(eventId).u64(inviteId).u64(moderatorId).u8(status)
    .toUint8Array();
}

/** `CMSG_CALENDAR_EVENT_MODERATOR_STATUS`: the same five fields, granting or removing moderation. */
export function buildCalendarModeratorStatus(
  guid: bigint, eventId: bigint, inviteId: bigint, moderatorId: bigint, status: number,
): Uint8Array {
  return new PacketWriter()
    .packedGuid(guid).u64(eventId).u64(inviteId).u64(moderatorId).u8(status)
    .toUint8Array();
}

/** `CMSG_CALENDAR_GUILD_FILTER`: which guild members a new event's invite list is drawn from. */
export function buildCalendarGuildFilter(minLevel: number, maxLevel: number, maxRankOrder: number): Uint8Array {
  return new PacketWriter().u32(minLevel).u32(maxLevel).u32(maxRankOrder).toUint8Array();
}

/** `CMSG_CALENDAR_ARENA_TEAM`: the same, for an arena team's roster. */
export function buildCalendarArenaTeam(arenaTeamId: number): Uint8Array {
  return new PacketWriter().u32(arenaTeamId).toUint8Array();
}

/** `CMSG_CALENDAR_COMPLAIN`: reporting whoever sent an invitation. */
export function buildCalendarComplain(invitedByGuid: bigint, eventId: bigint, inviteId: bigint): Uint8Array {
  return new PacketWriter().u64(invitedByGuid).u64(eventId).u64(inviteId).toUint8Array();
}

/**
 * `CalendarError` in CalendarMgr.h. The numbering has gaps — there is no 15, 18, 23 or anything
 * between 29 and 36 — so it is transcribed rather than counted, and every code this build actually
 * sends is worded.
 */
const CALENDAR_ERRORS: Record<number, string> = {
  0: "Готово",
  1: "У гильдии слишком много событий",
  2: "Вы создали слишком много событий",
  3: "Вы разослали слишком много приглашений",
  4: "У игрока слишком много приглашений",
  5: "Нет прав",
  6: "Событие не найдено",
  7: "Вас не приглашали",
  8: "Внутренняя ошибка",
  9: "Игрок не состоит в гильдии",
  10: "Игрок уже приглашён",
  11: "Игрок не найден",
  12: "Игрок из другой фракции",
  13: "Игрок вас игнорирует",
  14: "Слишком много приглашений",
  16: "Неверная дата",
  17: "Неверное время",
  19: "Нужно звание",
  20: "Событие уже прошло",
  21: "Событие заблокировано",
  22: "Нельзя удалить создателя события",
  24: "Календарь отключён",
  25: "Учётная запись ограничена",
  26: "Слишком много аренных событий",
  27: "Слишком низкий уровень",
  28: "Вам запрещено говорить",
  29: "Приглашение не найдено",
  36: "Событие на другом сервере",
  37: "Приглашение с другого сервера",
  38: "Гильдия не принимает приглашения",
  39: "Неверная запись",
  40: "Нет модератора",
};

export function calendarErrorText(result: number): string {
  return CALENDAR_ERRORS[result] ?? `Ошибка календаря (код ${result})`;
}

/** Turns a packed `WowTime` word into the "21.08.2026 19:30" the calendar shows. */
export function formatWowTime(packed: number): string {
  const time = unpackWowTime(packed);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(time.day)}.${pad(time.month)}.${time.year} ${pad(time.hour)}:${pad(time.minute)}`;
}
