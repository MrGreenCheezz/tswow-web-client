/**
 * The stock Blizzard_Calendar's C API (the 95 `Calendar*` names Wow.exe 3.3.5a registers, table at
 * 0xAD0048) over this client's calendar packets.
 *
 * What the model holds is what the client holds: the viewed month, the month's day lists (player
 * events, holidays, raid lockouts and resets), the one open event with the player's unsaved edits, the
 * draft of a new event with its pre-invited names, the context-menu event, the copy clipboard, the
 * invite list's sort and selection, and the «action pending» latch. The server's answers arrive as
 * {@link CalendarPacket}s (EventBus.ts) through a live or canned source and are folded in the client's
 * way: an alert updates the row it names rather than asking for a new snapshot.
 *
 * Constants read from Wow.exe 3.3.5a (build 12340), not guessed:
 * * CalendarGetMinDate 24.11.2004, CalendarGetMaxDate 31.12.2030 23:59 (0x5B81F0, 0x5B82A0);
 *   CalendarGetMaxCreateDate is the last day of the month twelve months ahead, 23:59 (0x5B7A80);
 *   CalendarGetMinHistoryDate is today minus 14 days (0x5B8350).
 * * CalendarCanAddEvent: no action pending and 5 s since the last add; CalendarCanSendInvite: the same
 *   with 2 s since the last invite (0x5B8BA0, 0x5B8B30).
 * * CalendarEventSetLocked/SetAutoApprove set event flags 0x10/0x20 (0x5BB870, 0x5BB8F0).
 * * CalendarEventGetStatusOptions: statuses 1..8 except SIGNED_UP and NOT_SIGNED_UP, except
 *   ACCEPTED and DECLINED on a guild event, except the invite's current one (0x5F26F0).
 * * CalendarEventGetTextures: LFGDungeons rows of TypeID 1 (dungeon) or 2 (raid) of the player's
 *   faction or both, by ExpansionLevel descending then name; a raid's difficulty name is its
 *   MapDifficulty string, a dungeon's is empty (0x5BB970, list built at 0x5BE3A0, compare 0x5B8E50).
 * * CalendarRemoveEvent: the creator removes the event, anyone else removes their own invitation
 *   (0x5B96A0); CalendarEventAvailable/Tentative/Decline answer 1/8/2 (0x5F23F0).
 * * CalendarDefaultGuildFilter: max level, max level, the guild's rank count (0x5BCDA0).
 * * CanEditGuildEvent: the rank's GR_RIGHT_CREATE_GUILDEVENT (0x100000) (0x5CC360).
 * * CALENDAR_EVENT_ALARM's text (CALENDAR_EVENT_ALARM_MESSAGE) says the event begins in 15 minutes.
 */

import {
  CALENDAR_RANK_MODERATOR, CALENDAR_RANK_OWNER, CALENDAR_SEND_ADD, CALENDAR_SEND_COPY, CALENDAR_SEND_GET,
  CALENDAR_STATUS_ACCEPTED, CALENDAR_STATUS_CONFIRMED, CALENDAR_STATUS_DECLINED, CALENDAR_STATUS_INVITED,
  CALENDAR_STATUS_NOT_SIGNED_UP, CALENDAR_STATUS_SIGNED_UP, CALENDAR_STATUS_TENTATIVE,
  calendarErrorText, packWowTime,
  type CalendarEventDetail, type CalendarEventFields, type CalendarNewInvite, type CalendarSnapshot,
} from "../../world/CalendarProtocol.js";
import type { CalendarPacket } from "../../world/EventBus.js";
import {
  frameXmlCalendarHolidayMonth, frameXmlCalendarMergeHolidays, frameXmlCalendarPackedWall, frameXmlCalendarWall,
  frameXmlCalendarWallTime, type FrameXmlCalendarHoliday, type FrameXmlCalendarSequenceType,
} from "./FrameXmlCalendarHolidays.js";

// ---- catalog and host -----------------------------------------------------------------------

/** One LFGDungeons row the event icon picker can offer (`/dbc/calendar`). */
export interface FrameXmlCalendarTexture {
  /** The LFGDungeons id: what an event carries as its texture id on the wire. */
  readonly id: number;
  readonly name: string;
  /** `TextureFilename`: `Interface\LFGFrame\LFGIcon-<texture>`. */
  readonly texture: string;
  readonly expansion: number;
  /** LFGDungeons TypeID: 1 dungeon, 2 raid. */
  readonly type: number;
  /** -1 both, 0 Horde, 1 Alliance. */
  readonly faction: number;
  readonly difficulty: number;
  /** MapDifficulty.Difficultystring of (MapID, Difficulty): a GlobalStrings key, or empty. */
  readonly difficultyToken: string;
}

/** A raid map's name and, per difficulty, its MapDifficulty string and reset period. */
export interface FrameXmlCalendarRaidMap {
  readonly mapId: number;
  readonly name: string;
  readonly difficulties: readonly {
    readonly difficulty: number;
    readonly token: string;
    /** MapDifficulty.RaidDuration: seconds between resets. */
    readonly resetSeconds: number;
  }[];
}

export interface FrameXmlCalendarCatalog {
  readonly holidays: readonly FrameXmlCalendarHoliday[];
  readonly textures: readonly FrameXmlCalendarTexture[];
  readonly raids: readonly FrameXmlCalendarRaidMap[];
}

/** The calendar opcodes, each one WorldClient method (CalendarProtocol.ts builders). */
export interface FrameXmlCalendarServer {
  requestCalendar(): void;
  requestEvent(eventId: bigint): void;
  addEvent(fields: CalendarEventFields, invites: readonly CalendarNewInvite[]): void;
  updateEvent(eventId: bigint, moderatorId: bigint, fields: CalendarEventFields): void;
  removeEvent(eventId: bigint, moderatorId: bigint): void;
  copyEvent(eventId: bigint, moderatorId: bigint, packedDate: number): void;
  rsvp(eventId: bigint, inviteId: bigint, status: number): void;
  invite(eventId: bigint, name: string, moderatorId: bigint, creating: boolean, isSignUp: boolean): void;
  signUp(eventId: bigint, tentative: boolean): void;
  removeInvite(guid: bigint, inviteId: bigint, eventId: bigint, moderatorId: bigint): void;
  setStatus(guid: bigint, eventId: bigint, inviteId: bigint, status: number, moderatorId: bigint): void;
  setModerator(guid: bigint, eventId: bigint, inviteId: bigint, rank: number, moderatorId: bigint): void;
  guildFilter(minLevel: number, maxLevel: number, maxRankOrder: number): void;
  arenaTeam(teamId: number): void;
  complain(invitedByGuid: bigint, eventId: bigint, inviteId: bigint): void;
}

export interface FrameXmlCalendarPlayer {
  readonly guid: bigint;
  readonly name: string;
  readonly level: number;
  /** 0 Horde, 1 Alliance, -1 not known. */
  readonly faction: number;
}

/** What the model asks of its world; the live one is FrameXmlCalendarLive.ts, the canned one a fixture. */
export interface FrameXmlCalendarHost {
  server(): FrameXmlCalendarServer | undefined;
  /** The realm's wall clock in minutes (FrameXmlCalendarHolidays.ts), or undefined while unknown. */
  now(): number | undefined;
  /** Monotonic milliseconds, for the client's own throttles. */
  monotonic(): number;
  player(): FrameXmlCalendarPlayer | undefined;
  /** A resolved character name; undefined asks for it (the host queries once). */
  nameOf(guid: bigint): string | undefined;
  /** Localized class name and ChrClasses token, when this client knows the character's class. */
  classOf(guid: bigint): readonly [name: string, token: string] | undefined;
  inGuild(): boolean;
  /** The player's guild rank has GR_RIGHT_CREATE_GUILDEVENT. */
  canCreateGuildEvent(): boolean;
  guildRankCount(): number;
  maxLevel(): number;
  /** The arena team in the player's slot 1..3, by id. */
  arenaTeamId(index: number): number | undefined;
}

export interface FrameXmlCalendarPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export const FRAMEXML_CALENDAR_UI_EVENTS = Object.freeze({
  eventList: "CALENDAR_UPDATE_EVENT_LIST",
  openEvent: "CALENDAR_OPEN_EVENT",
  closeEvent: "CALENDAR_CLOSE_EVENT",
  updateEvent: "CALENDAR_UPDATE_EVENT",
  inviteList: "CALENDAR_UPDATE_INVITE_LIST",
  newEvent: "CALENDAR_NEW_EVENT",
  actionPending: "CALENDAR_ACTION_PENDING",
  error: "CALENDAR_UPDATE_ERROR",
  alarm: "CALENDAR_EVENT_ALARM",
});

/** The five filter CVars (Blizzard_Calendar.lua CALENDAR_FILTER_CVARS) and their Wow.exe defaults. */
export const FRAMEXML_CALENDAR_FILTER_DEFAULTS: Readonly<Record<string, boolean>> = Object.freeze({
  calendarShowWeeklyHolidays: true,
  calendarShowDarkmoon: true,
  calendarShowBattlegrounds: false,
  calendarShowLockouts: true,
  calendarShowResets: false,
});

// ---- constants ------------------------------------------------------------------------------

export type FrameXmlCalendarType =
  | "PLAYER" | "GUILD_ANNOUNCEMENT" | "GUILD_EVENT" | "SYSTEM" | "HOLIDAY" | "RAID_LOCKOUT" | "RAID_RESET";

/** CalendarMgr.h CalendarFlags. */
const FLAG_INVITES_LOCKED = 0x10;
const FLAG_AUTO_APPROVE = 0x20;
const FLAG_WITHOUT_INVITES = 0x40;
const FLAG_GUILD_EVENT = 0x400;
/** CalendarMgr.h CalendarEventType. */
const TYPE_RAID = 0;
const TYPE_DUNGEON = 1;
const TYPE_PVP = 2;
const TYPE_OTHER = 4;
/** CALENDAR_MAX_INVITES (CalendarMgr.h). */
const MAX_INVITES = 100;
const ADD_THROTTLE_MS = 5_000;
const INVITE_THROTTLE_MS = 2_000;
/** A command the server never answers must not hold the latch for the session. */
const PENDING_TIMEOUT_MS = 10_000;
const ALARM_LEAD_MINUTES = 15;
const TICK_INTERVAL_MS = 1_000;
const MIN_DATE = Object.freeze([11, 24, 2004] as const);
const MAX_DATE = Object.freeze([12, 31, 2030] as const);
/** Any response time before the calendar existed is the core's CALENDAR_DEFAULT_RESPONSE_TIME. */
const MIN_RESPONSE_WALL = frameXmlCalendarWall(2004, 11, 24);
/** The ruRU client's region besides «every region» (Holidays.dbc Region; 1 is the US-only row). */
const CLIENT_REGIONS: readonly number[] = Object.freeze([3]);

const STATUS_NAMES: readonly string[] = Object.freeze([
  "CALENDAR_STATUS_INVITED", "CALENDAR_STATUS_ACCEPTED", "CALENDAR_STATUS_DECLINED", "CALENDAR_STATUS_CONFIRMED",
  "CALENDAR_STATUS_OUT", "CALENDAR_STATUS_STANDBY", "CALENDAR_STATUS_SIGNEDUP", "CALENDAR_STATUS_NOT_SIGNEDUP",
  "CALENDAR_STATUS_TENTATIVE",
]);
const TYPE_NAMES: readonly string[] = Object.freeze([
  "CALENDAR_TYPE_RAID", "CALENDAR_TYPE_DUNGEON", "CALENDAR_TYPE_PVP", "CALENDAR_TYPE_MEETING", "CALENDAR_TYPE_OTHER",
]);
const REPEAT_NAMES: readonly string[] = Object.freeze([
  "CALENDAR_REPEAT_NEVER", "CALENDAR_REPEAT_WEEKLY", "CALENDAR_REPEAT_BIWEEKLY", "CALENDAR_REPEAT_MONTHLY",
]);
const MONTH_NAMES: readonly string[] = Object.freeze([
  "MONTH_JANUARY", "MONTH_FEBRUARY", "MONTH_MARCH", "MONTH_APRIL", "MONTH_MAY", "MONTH_JUNE", "MONTH_JULY",
  "MONTH_AUGUST", "MONTH_SEPTEMBER", "MONTH_OCTOBER", "MONTH_NOVEMBER", "MONTH_DECEMBER",
]);
const WEEKDAY_NAMES: readonly string[] = Object.freeze([
  "WEEKDAY_SUNDAY", "WEEKDAY_MONDAY", "WEEKDAY_TUESDAY", "WEEKDAY_WEDNESDAY", "WEEKDAY_THURSDAY",
  "WEEKDAY_FRIDAY", "WEEKDAY_SATURDAY",
]);

/**
 * CalendarError (CalendarMgr.h) → the GlobalStrings key and its format argument, as the client's
 * switch at 0x6CD3E4 pushes them (the numbers are the limits it prints: 100 invites, 30 events, 100
 * guild events). `name` is the packet's player name.
 */
const ERROR_STRINGS: Readonly<Record<number, readonly [key: string, argument?: number | "name"]>> = Object.freeze({
  1: ["CALENDAR_ERROR_GUILD_EVENTS_EXCEEDED", 100],
  2: ["CALENDAR_ERROR_EVENTS_EXCEEDED", 30],
  3: ["CALENDAR_ERROR_SELF_INVITES_EXCEEDED", 30],
  4: ["CALENDAR_ERROR_OTHER_INVITES_EXCEEDED", "name"],
  5: ["CALENDAR_ERROR_PERMISSIONS"],
  6: ["CALENDAR_ERROR_EVENT_INVALID"],
  7: ["CALENDAR_ERROR_NOT_INVITED"],
  8: ["CALENDAR_ERROR_INTERNAL"],
  9: ["ERR_GUILD_PLAYER_NOT_IN_GUILD"],
  10: ["CALENDAR_ERROR_ALREADY_INVITED_TO_EVENT_S", "name"],
  11: ["PLAYER_NOT_FOUND"],
  12: ["CALENDAR_ERROR_NOT_ALLIED"],
  13: ["ERR_IGNORING_YOU_S", "name"],
  14: ["CALENDAR_ERROR_INVITES_EXCEEDED", 100],
  16: ["CALENDAR_ERROR_INVALID_DATE"],
  17: ["CALENDAR_ERROR_INVALID_TIME"],
  19: ["CALENDAR_ERROR_NEEDS_TITLE"],
  20: ["CALENDAR_ERROR_EVENT_PASSED"],
  21: ["CALENDAR_ERROR_EVENT_LOCKED"],
  22: ["CALENDAR_ERROR_DELETE_CREATOR_FAILED"],
  24: ["ERR_SYSTEM_DISABLED"],
  25: ["ERR_RESTRICTED_ACCOUNT"],
  26: ["CALENDAR_ERROR_ARENA_EVENTS_EXCEEDED"],
  27: ["CALENDAR_ERROR_RESTRICTED_LEVEL"],
  28: ["ERR_USER_SQUELCHED"],
  29: ["CALENDAR_ERROR_NO_INVITE"],
  36: ["CALENDAR_ERROR_EVENT_WRONG_SERVER"],
  37: ["CALENDAR_ERROR_INVITE_WRONG_SERVER"],
  38: ["CALENDAR_ERROR_NO_GUILD_INVITES"],
  39: ["CALENDAR_ERROR_INVALID_SIGNUP"],
  40: ["CALENDAR_ERROR_NO_MODERATOR"],
});

// ---- rows -----------------------------------------------------------------------------------

interface MyInvite {
  inviteId: bigint;
  status: number;
  rank: number;
  /** Wire invite type: 1 is a sign-up to the viewer's own guild's event. */
  inviteType: number;
  inviterGuid: bigint;
}

/** One player-created event of the list: the snapshot's summary and the player's own invitation. */
interface EventRow {
  readonly eventId: bigint;
  title: string;
  eventType: number;
  /** Wall minutes. */
  date: number;
  flags: number;
  textureId: number;
  ownerGuid: bigint;
  mine: MyInvite | undefined;
}

interface WorkingInvite {
  guid: bigint;
  level: number;
  status: number;
  rank: number;
  inviteType: number;
  inviteId: bigint;
  /** Packed WowTime, 0 when never answered. */
  responseTime: number;
}

/** The open event, or a new one being written. */
interface WorkingEvent {
  readonly isNew: boolean;
  readonly eventId: bigint;
  readonly calendarType: FrameXmlCalendarType;
  readonly ownerGuid: bigint;
  title: string;
  description: string;
  eventType: number;
  repeatOption: number;
  maxSize: number;
  textureId: number;
  /** Wall minutes. */
  date: number;
  lockDate: number | undefined;
  flags: number;
  invites: WorkingInvite[];
}

type EntryRef =
  | { readonly kind: "event"; readonly eventId: bigint }
  | { readonly kind: "holiday"; readonly holiday: FrameXmlCalendarHoliday }
  | { readonly kind: "raid"; readonly mapId: number; readonly difficulty: number; readonly instanceId: bigint };

interface DayEntry {
  readonly ref: EntryRef;
  readonly calendarType: FrameXmlCalendarType;
  readonly title: string;
  readonly hour: number;
  readonly minute: number;
  readonly sequenceType: FrameXmlCalendarSequenceType;
  readonly sequenceIndex: number;
  readonly numSequenceDays: number;
  /** Holiday priority, for the day's order. */
  readonly priority: number;
}

interface Position {
  readonly monthIndex: number;
  readonly day: number;
  readonly index: number;
}

interface Lockout {
  readonly mapId: number;
  readonly difficulty: number;
  readonly instanceId: bigint;
  /** Wall minutes of the reset. */
  readonly resetAt: number;
}

interface RaidReset {
  readonly mapId: number;
  /** Wall minutes of the next reset after the snapshot. */
  readonly first: number;
}

type Criterion = "name" | "class" | "status";

// ---- helpers --------------------------------------------------------------------------------

const NOTHING: readonly [] = Object.freeze([]);

function integer(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? Math.trunc(number) : undefined;
}

function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

function monthOf(index: number): { readonly year: number; readonly month: number } {
  return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 + 1 };
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function firstWeekday(year: number, month: number): number {
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 1;
}

/** weekday (1 = Sunday), month, day, year of a date, as CalendarGet*Date answer. */
function dateTuple(year: number, month: number, day: number): readonly [number, number, number, number] {
  return [new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 1, month, day, year];
}

function calendarTypeOf(flags: number): FrameXmlCalendarType {
  if ((flags & FLAG_WITHOUT_INVITES) !== 0) return "GUILD_ANNOUNCEMENT";
  if ((flags & FLAG_GUILD_EVENT) !== 0) return "GUILD_EVENT";
  return "PLAYER";
}

function isPending(status: number): boolean {
  // CalendarMgr::GetPlayerNumPending: the statuses the server counts for the GameTime badge.
  return status === CALENDAR_STATUS_INVITED || status === CALENDAR_STATUS_TENTATIVE
    || status === CALENDAR_STATUS_NOT_SIGNED_UP;
}

function modStatus(rank: number | undefined): string {
  return rank === CALENDAR_RANK_OWNER ? "CREATOR" : rank === CALENDAR_RANK_MODERATOR ? "MODERATOR" : "";
}

function packWall(minutes: number): number {
  const time = frameXmlCalendarWallTime(minutes);
  return packWowTime(time);
}

function formatText(template: string, argument: string | number | undefined): string {
  if (argument === undefined) return template;
  return template.replace(/%(?:\d\$)?[sd]/, String(argument));
}

const STATUS_ORDER: readonly number[] = Object.freeze([
  CALENDAR_STATUS_CONFIRMED, CALENDAR_STATUS_ACCEPTED, CALENDAR_STATUS_SIGNED_UP, CALENDAR_STATUS_TENTATIVE,
  5 /* STANDBY */, CALENDAR_STATUS_INVITED, CALENDAR_STATUS_NOT_SIGNED_UP, CALENDAR_STATUS_DECLINED, 4 /* OUT */,
]);

// ---- the model ------------------------------------------------------------------------------

export class FrameXmlCalendarModel {
  readonly #host: FrameXmlCalendarHost;
  #pump: FrameXmlCalendarPump | undefined;
  #globalString: ((name: string) => string | undefined) | undefined;
  #catalog: FrameXmlCalendarCatalog | undefined;
  readonly #filters = new Map<string, boolean>(Object.entries(FRAMEXML_CALENDAR_FILTER_DEFAULTS));

  readonly #events = new Map<bigint, EventRow>();
  readonly #lockouts = new Map<string, Lockout>();
  #resets: readonly RaidReset[] = NOTHING;
  #serverHolidays: CalendarSnapshot["holidays"] = [];
  #holidays: readonly FrameXmlCalendarHoliday[] = NOTHING;
  readonly #monthCache = new Map<number, readonly (readonly DayEntry[])[]>();
  #cachedDay = -1;
  /** Whether a snapshot has listed the player's invitations (a replaced world forgets it). */
  #snapshotSeen = false;
  /** {@link pendingInviteCount}'s answer, dropped with the month cache whenever a row changes. */
  #pendingCount: number | undefined;

  #viewed: number | undefined;
  #open: (Position & { readonly ref: EntryRef; readonly calendarType: FrameXmlCalendarType }) | undefined;
  /** The player event whose CMSG_CALENDAR_GET_EVENT is in flight for CalendarOpenEvent. */
  #awaitingOpen: bigint | undefined;
  #current: WorkingEvent | undefined;
  #original: WorkingEvent | undefined;
  #context: (Position & { readonly ref: EntryRef; readonly calendarType: FrameXmlCalendarType }) | undefined;
  #clipboard: bigint | undefined;
  #selectedInvite = 0;
  #criterion: Criterion = "status";
  #reverse = false;
  #order: WorkingInvite[] | undefined;
  #unresolvedNames = false;

  #pending: { readonly since: number } | undefined;
  #lastAddAt = Number.NEGATIVE_INFINITY;
  #lastInviteAt = Number.NEGATIVE_INFINITY;
  #massInvite = false;
  readonly #alarmed = new Set<bigint>();
  #tickAt = Number.NEGATIVE_INFINITY;
  #alarmMinute = -1;

  constructor(host: FrameXmlCalendarHost) {
    this.#host = host;
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  attach(pump: FrameXmlCalendarPump): void {
    this.#pump = pump;
  }

  detach(): void {
    this.#pump = undefined;
    this.#pending = undefined;
  }

  /** Localized text: the booted VM's GlobalStrings (set by the lazy owner). */
  useGlobalStrings(resolve: ((name: string) => string | undefined) | undefined): void {
    this.#globalString = resolve;
  }

  /** The `/dbc/calendar` catalog: holidays, the icon picker's dungeons, raid map names. */
  useCatalog(catalog: FrameXmlCalendarCatalog | undefined): void {
    this.#catalog = catalog;
    this.#rebuildHolidays();
    this.#invalidate();
    this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.eventList);
  }

  get catalog(): FrameXmlCalendarCatalog | undefined {
    return this.#catalog;
  }

  /** A filter CVar changed (the owner's SetCVar hook); the month lists are rebuilt on next read. */
  setFilter(cvar: string, shown: boolean): void {
    const key = Object.keys(FRAMEXML_CALENDAR_FILTER_DEFAULTS).find((name) => name.toLowerCase() === cvar.toLowerCase());
    if (!key || this.#filters.get(key) === shown) return;
    this.#filters.set(key, shown);
    this.#invalidate();
  }

  filter(cvar: string): boolean {
    return this.#filters.get(cvar) ?? false;
  }

  /**
   * The host's bounded poll: once a second at most, the pending latch's timeout, the midnight
   * redraw, the alarm 15 minutes before an accepted event, and names that arrived for the open list.
   */
  tick(): void {
    const now = this.#host.monotonic();
    if (now - this.#tickAt < TICK_INTERVAL_MS) return;
    this.#tickAt = now;
    if (this.#pending && now - this.#pending.since >= PENDING_TIMEOUT_MS) this.#setPending(false);
    const wall = this.#host.now();
    if (wall !== undefined) {
      const minute = Math.floor(wall);
      const day = Math.floor(minute / 1440);
      if (this.#cachedDay >= 0 && day !== this.#cachedDay) {
        this.#invalidate();
        this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.eventList);
      }
      this.#cachedDay = day;
      if (minute !== this.#alarmMinute) {
        this.#alarmMinute = minute;
        this.#alarms(minute);
      }
    }
    if (this.#unresolvedNames && this.#current) {
      this.#unresolvedNames = false;
      for (const invite of this.#current.invites) {
        if (this.#host.nameOf(invite.guid) === undefined) this.#unresolvedNames = true;
      }
      if (!this.#unresolvedNames) this.#inviteListChanged();
    }
  }

  #alarms(minute: number): void {
    for (const row of this.#events.values()) {
      const status = row.mine?.status;
      if (status !== CALENDAR_STATUS_ACCEPTED && status !== CALENDAR_STATUS_CONFIRMED
        && status !== CALENDAR_STATUS_SIGNED_UP) continue;
      if (this.#alarmed.has(row.eventId) || minute < row.date - ALARM_LEAD_MINUTES || minute >= row.date) continue;
      this.#alarmed.add(row.eventId);
      const time = frameXmlCalendarWallTime(row.date);
      this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.alarm, row.title, time.hour, time.minute);
    }
  }

  #fire(event: string, ...args: readonly unknown[]): void {
    this.#pump?.fire(event, ...args);
  }

  #text(key: string): string {
    return this.#globalString?.(key) ?? key;
  }

  #setPending(pending: boolean): void {
    if (pending === (this.#pending !== undefined)) {
      if (pending) this.#pending = { since: this.#host.monotonic() };
      return;
    }
    this.#pending = pending ? { since: this.#host.monotonic() } : undefined;
    if (!pending) this.#massInvite = false;
    this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.actionPending, pending);
  }

  #invalidate(): void {
    this.#monthCache.clear();
    this.#pendingCount = undefined;
  }

  /**
   * CalendarMgr::GetPlayerNumPending over the rows this client holds (the snapshot's invites, then the
   * alerts and statuses since): the GameTime badge's count once a snapshot has arrived, undefined
   * before. Unlike WorldClient's `calendarPending`, an answered command (CLEAR_PENDING_ACTION) does
   * not zero it — only an answered invitation leaves the count.
   */
  pendingInviteCount(): number | undefined {
    if (!this.#snapshotSeen) return undefined;
    if (this.#pendingCount === undefined) {
      let count = 0;
      for (const row of this.#events.values()) if (row.mine && isPending(row.mine.status)) count += 1;
      this.#pendingCount = count;
    }
    return this.#pendingCount;
  }

  /** A replaced world (a relog, a new session): its rows, saves and holidays are not the next world's. */
  forget(): void {
    this.#events.clear();
    this.#lockouts.clear();
    this.#resets = NOTHING;
    this.#serverHolidays = [];
    this.#snapshotSeen = false;
    this.#alarmed.clear();
    this.#clipboard = undefined;
    this.#rebuildHolidays();
    this.#invalidate();
    this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.eventList);
  }

  #rebuildHolidays(): void {
    this.#holidays = frameXmlCalendarMergeHolidays(this.#catalog?.holidays ?? NOTHING, this.#serverHolidays);
  }

  // ---- packets ------------------------------------------------------------------------------

  /** One calendar packet from the source, in arrival order. */
  receive(packet: CalendarPacket): void {
    switch (packet.kind) {
      case "snapshot": this.#snapshot(packet.snapshot); return;
      case "event": this.#detail(packet.detail); return;
      case "pending": return;
      case "result": {
        this.#setPending(false);
        if (packet.result.result !== 0) this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.error, this.#errorText(packet.result.result, packet.result.name));
        return;
      }
      case "clearPending": this.#setPending(false); return;
      case "candidates": this.#candidates(packet.invites); return;
      case "inviteAdded": this.#inviteAdded(packet.invite); return;
      case "inviteAlert": this.#inviteAlert(packet.alert); return;
      case "inviteRemoved": this.#inviteRemoved(packet.removed.eventId, packet.removed.inviteGuid); return;
      case "inviteRemovedAlert": this.#removedFromEvent(packet.alert.eventId, packet.alert.flags); return;
      case "status": this.#status(packet.status.eventId, packet.status.inviteGuid, packet.status.status, packet.status.responseTime); return;
      case "moderator": this.#moderator(packet.status.eventId, packet.status.inviteGuid, packet.status.status); return;
      case "updatedAlert": this.#updatedAlert(packet.alert); return;
      case "removedAlert": this.#eventRemoved(packet.alert.eventId); return;
      case "lockout": this.#lockout(packet.change, packet.removed); return;
    }
  }

  /** The text CALENDAR_UPDATE_ERROR carries: the client's own string for the code. */
  #errorText(code: number, name: string): string {
    const entry = ERROR_STRINGS[code];
    const template = entry ? this.#globalString?.(entry[0]) : undefined;
    if (!entry || template === undefined) return calendarErrorText(code) + (name ? `: ${name}` : "");
    return formatText(template, entry[1] === "name" ? name : entry[1]);
  }

  #snapshot(snapshot: CalendarSnapshot): void {
    const self = this.#host.player()?.guid;
    const mine = new Map<bigint, MyInvite>();
    for (const invite of snapshot.invites) {
      mine.set(invite.eventId, {
        inviteId: invite.inviteId, status: invite.status, rank: invite.moderator,
        inviteType: invite.inviteType, inviterGuid: invite.inviterGuid,
      });
    }
    this.#events.clear();
    for (const event of snapshot.events) {
      const date = frameXmlCalendarPackedWall(event.date);
      if (date === undefined) continue;
      this.#events.set(event.eventId, {
        eventId: event.eventId, title: event.name, eventType: event.eventType, date, flags: event.flags,
        textureId: event.textureId, ownerGuid: event.ownerGuid, mine: mine.get(event.eventId),
      });
      this.#host.nameOf(event.ownerGuid);
      const inviter = mine.get(event.eventId)?.inviterGuid;
      if (inviter !== undefined && inviter !== self) this.#host.nameOf(inviter);
    }
    // Raid saves count down from the snapshot's own clock; resets repeat at the map's period.
    const now = frameXmlCalendarPackedWall(snapshot.serverTime);
    this.#lockouts.clear();
    const resets: RaidReset[] = [];
    if (now !== undefined) {
      for (const lockout of snapshot.lockouts) {
        this.#lockouts.set(`${lockout.mapId}:${lockout.difficulty}`, {
          mapId: lockout.mapId, difficulty: lockout.difficulty, instanceId: lockout.instanceId,
          resetAt: now + Math.max(0, lockout.expireSeconds) / 60,
        });
      }
      for (const reset of snapshot.resets) resets.push({ mapId: reset.mapId, first: now + reset.durationSeconds / 60 });
    }
    this.#resets = resets;
    this.#serverHolidays = snapshot.holidays;
    this.#snapshotSeen = true;
    this.#rebuildHolidays();
    this.#invalidate();
    this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.eventList);
  }

  #rowFromDetail(detail: CalendarEventDetail): void {
    const date = frameXmlCalendarPackedWall(detail.date);
    if (date === undefined) return;
    const self = this.#host.player()?.guid;
    const own = detail.invites.find((invite) => invite.guid === self);
    const previous = this.#events.get(detail.eventId);
    this.#events.set(detail.eventId, {
      eventId: detail.eventId, title: detail.name, eventType: detail.eventType, date, flags: detail.flags,
      textureId: detail.textureId, ownerGuid: detail.ownerGuid,
      mine: own ? {
        inviteId: own.inviteId, status: own.status, rank: own.moderator, inviteType: own.inviteType,
        inviterGuid: previous?.mine?.inviterGuid ?? detail.ownerGuid,
      } : previous?.mine,
    });
    this.#invalidate();
  }

  #working(detail: CalendarEventDetail): WorkingEvent {
    const date = frameXmlCalendarPackedWall(detail.date) ?? 0;
    // A core that stores no lock date still packs unix zero; only a locking event's word is a date.
    const lockDate = (detail.flags & FLAG_INVITES_LOCKED) !== 0 ? frameXmlCalendarPackedWall(detail.lockDate) : undefined;
    return {
      isNew: false, eventId: detail.eventId, calendarType: calendarTypeOf(detail.flags), ownerGuid: detail.ownerGuid,
      title: detail.name, description: detail.description, eventType: detail.eventType,
      repeatOption: detail.repeatable, maxSize: detail.maxInvites, textureId: detail.textureId, date, lockDate,
      flags: detail.flags,
      invites: detail.invites.map((invite) => ({
        guid: invite.guid, level: invite.level, status: invite.status, rank: invite.moderator,
        inviteType: invite.inviteType, inviteId: invite.inviteId, responseTime: invite.responseTime,
      })),
    };
  }

  #detail(detail: CalendarEventDetail): void {
    this.#rowFromDetail(detail);
    if (detail.sendType === CALENDAR_SEND_ADD || detail.sendType === CALENDAR_SEND_COPY) {
      this.#setPending(false);
      this.#lastAddAt = this.#host.monotonic();
      this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.newEvent, detail.sendType === CALENDAR_SEND_COPY);
      this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.eventList);
      return;
    }
    if (detail.sendType !== CALENDAR_SEND_GET) return;
    for (const invite of detail.invites) this.#host.nameOf(invite.guid);
    if (this.#awaitingOpen === detail.eventId) {
      this.#awaitingOpen = undefined;
      this.#setCurrent(this.#working(detail));
      this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.openEvent, this.#current!.calendarType);
    } else if (this.#current && !this.#current.isNew && this.#current.eventId === detail.eventId) {
      this.#setCurrent(this.#working(detail));
      this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.updateEvent);
      this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.inviteList);
    }
    this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.eventList);
  }

  #setCurrent(working: WorkingEvent | undefined): void {
    this.#current = working;
    this.#original = working ? { ...working, invites: working.invites.map((invite) => ({ ...invite })) } : undefined;
    this.#selectedInvite = 0;
    this.#order = undefined;
    this.#unresolvedNames = working !== undefined;
  }

  #inviteListChanged(): void {
    this.#order = undefined;
    this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.inviteList);
  }

  #candidates(invites: readonly { readonly guid: bigint; readonly level: number }[]): void {
    const current = this.#current;
    this.#setPending(false);
    if (!current?.isNew) return;
    for (const candidate of invites) {
      if (current.invites.length >= MAX_INVITES) break;
      if (current.invites.some((invite) => invite.guid === candidate.guid)) continue;
      this.#host.nameOf(candidate.guid);
      current.invites.push({
        guid: candidate.guid, level: candidate.level, status: CALENDAR_STATUS_INVITED, rank: 0,
        inviteType: current.calendarType === "GUILD_EVENT" ? 1 : 0, inviteId: 0n, responseTime: 0,
      });
    }
    this.#unresolvedNames = true;
    this.#inviteListChanged();
  }

  #inviteAdded(invite: { readonly inviteeGuid: bigint; readonly eventId: bigint; readonly inviteId: bigint;
    readonly level: number; readonly status: number; readonly type: number; readonly responseTime: number | undefined;
    readonly clearPending: boolean }): void {
    const current = this.#current;
    if (invite.eventId === 0n) {
      // The core's pre-invite (HandleCalendarEventInvite with `creating`): a name checked for the
      // draft; it also echoes the invites of an add it has just stored, which are already listed.
      if (!current?.isNew || current.invites.some((row) => row.guid === invite.inviteeGuid)) return;
      current.invites.push({
        guid: invite.inviteeGuid, level: invite.level, status: invite.status, rank: 0, inviteType: invite.type,
        inviteId: 0n, responseTime: 0,
      });
      this.#unresolvedNames = true;
      this.#inviteListChanged();
      return;
    }
    // The player's own invite to a listed event. This is the core's only answer to a guild-event
    // sign-up (HandleCalendarEventSignup → CalendarMgr::AddInvite → SendCalendarEventInvite, never an
    // EVENT_STATUS), and a moderator's invitation to a guild event has no alert either: without it the
    // row stays «not signed up» and a second sign-up makes the core store a second invite.
    const listed = this.#events.get(invite.eventId);
    if (listed && invite.inviteeGuid === this.#host.player()?.guid) {
      listed.mine = {
        inviteId: invite.inviteId, status: invite.status, rank: listed.mine?.rank ?? 0, inviteType: invite.type,
        // ClearPending is the core's «sent by someone else»; a sign-up's sender is the player.
        inviterGuid: listed.mine?.inviterGuid ?? (invite.clearPending ? listed.ownerGuid : invite.inviteeGuid),
      };
      this.#invalidate();
      this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.eventList);
    }
    if (!current || current.isNew || current.eventId !== invite.eventId) return;
    const existing = current.invites.find((row) => row.guid === invite.inviteeGuid);
    if (existing) {
      existing.inviteId = invite.inviteId;
      existing.status = invite.status;
      existing.level = invite.level;
    } else {
      current.invites.push({
        guid: invite.inviteeGuid, level: invite.level, status: invite.status, rank: 0, inviteType: invite.type,
        inviteId: invite.inviteId, responseTime: invite.responseTime ?? 0,
      });
    }
    this.#original?.invites.splice(0, this.#original.invites.length, ...current.invites.map((row) => ({ ...row })));
    this.#unresolvedNames = true;
    this.#inviteListChanged();
  }

  #inviteAlert(alert: {
    readonly eventId: bigint; readonly name: string; readonly date: number; readonly flags: number;
    readonly eventType: number; readonly textureId: number; readonly inviteId: bigint; readonly status: number;
    readonly moderatorStatus: number; readonly ownerGuid: bigint; readonly invitedByGuid: bigint;
  }): void {
    const date = frameXmlCalendarPackedWall(alert.date);
    if (date === undefined) return;
    const self = this.#host.player()?.guid;
    const guild = (alert.flags & (FLAG_GUILD_EVENT | FLAG_WITHOUT_INVITES)) !== 0;
    // A guild event's alert is broadcast to the guild with the creator's own invite in it
    // (CalendarMgr::SendCalendarEventInviteAlert): it is the viewer's only when the viewer created it.
    const own = !guild || alert.ownerGuid === self;
    const previous = this.#events.get(alert.eventId);
    this.#events.set(alert.eventId, {
      eventId: alert.eventId, title: alert.name, eventType: alert.eventType, date, flags: alert.flags,
      textureId: alert.textureId, ownerGuid: alert.ownerGuid,
      mine: own ? {
        inviteId: alert.inviteId, status: alert.status, rank: alert.moderatorStatus,
        inviteType: (alert.flags & FLAG_GUILD_EVENT) !== 0 ? 1 : 0, inviterGuid: alert.invitedByGuid,
      } : previous?.mine,
    });
    this.#host.nameOf(alert.invitedByGuid);
    this.#invalidate();
    this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.eventList);
  }

  #inviteRemoved(eventId: bigint, guid: bigint): void {
    const self = this.#host.player()?.guid;
    const row = this.#events.get(eventId);
    if (row && guid === self && row.mine) {
      row.mine = undefined;
      // Only a guild event stays on the calendar of someone who is no longer invited.
      if ((row.flags & (FLAG_GUILD_EVENT | FLAG_WITHOUT_INVITES)) === 0) this.#events.delete(eventId);
      this.#invalidate();
      this.#setPending(false);
      this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.eventList);
    }
    const current = this.#current;
    if (!current || current.isNew || current.eventId !== eventId) return;
    const index = current.invites.findIndex((invite) => invite.guid === guid);
    if (index < 0) return;
    current.invites.splice(index, 1);
    this.#original?.invites.splice(0, this.#original.invites.length, ...current.invites.map((invite) => ({ ...invite })));
    if (this.#selectedInvite > current.invites.length) this.#selectedInvite = 0;
    this.#inviteListChanged();
  }

  #removedFromEvent(eventId: bigint, flags: number): void {
    const row = this.#events.get(eventId);
    if (row && (flags & (FLAG_GUILD_EVENT | FLAG_WITHOUT_INVITES)) === 0) this.#events.delete(eventId);
    else if (row) row.mine = undefined;
    this.#invalidate();
    this.#setPending(false);
    this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.eventList);
    if (this.#current && !this.#current.isNew && this.#current.eventId === eventId && !this.#events.has(eventId)) {
      this.#closeOpen();
    }
  }

  #status(eventId: bigint, guid: bigint, status: number, responseTime: number): void {
    const self = this.#host.player()?.guid;
    const row = this.#events.get(eventId);
    if (row && guid === self) {
      if (row.mine) row.mine.status = status;
      else if (row.ownerGuid !== self) {
        // An invite this client never saw (a sign-up answers with SMSG_CALENDAR_EVENT_INVITE, see
        // #inviteAdded): the invite exists now, its id arrives with the event detail.
        row.mine = { inviteId: 0n, status, rank: 0, inviteType: 1, inviterGuid: guid };
      }
      this.#invalidate();
      this.#setPending(false);
      this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.eventList);
    }
    const current = this.#current;
    if (!current || current.isNew || current.eventId !== eventId) return;
    const invite = current.invites.find((row2) => row2.guid === guid);
    if (!invite) {
      // A sign-up the open list has not seen: fetch the list with its invite id.
      this.#host.server()?.requestEvent(eventId);
      return;
    }
    invite.status = status;
    invite.responseTime = responseTime;
    const original = this.#original?.invites.find((row2) => row2.guid === guid);
    if (original) {
      original.status = status;
      original.responseTime = responseTime;
    }
    this.#inviteListChanged();
  }

  #moderator(eventId: bigint, guid: bigint, value: number): void {
    // SMSG_CALENDAR_EVENT_MODERATOR_STATUS_ALERT's byte is filled from the invite's *status*, not its
    // rank (CalendarMgr::SendCalendarEventModeratorStatusAlert), so it cannot say what the new rank is:
    // the open event's list is fetched again instead of trusting it.
    void value;
    const current = this.#current;
    if (current && !current.isNew && current.eventId === eventId && current.invites.some((row) => row.guid === guid)) {
      this.#host.server()?.requestEvent(eventId);
    }
  }

  #updatedAlert(alert: {
    readonly eventId: bigint; readonly flags: number; readonly date: number; readonly eventType: number;
    readonly textureId: number; readonly name: string; readonly description: string; readonly lockDate: number;
  }): void {
    const date = frameXmlCalendarPackedWall(alert.date);
    const row = this.#events.get(alert.eventId);
    if (row && date !== undefined) {
      row.title = alert.name;
      row.date = date;
      row.eventType = alert.eventType;
      row.flags = alert.flags;
      row.textureId = alert.textureId;
      this.#alarmed.delete(row.eventId);
    }
    this.#setPending(false);
    this.#invalidate();
    this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.eventList);
    const current = this.#current;
    if (!current || current.isNew || current.eventId !== alert.eventId || date === undefined) return;
    const lockDate = (alert.flags & FLAG_INVITES_LOCKED) !== 0 ? frameXmlCalendarPackedWall(alert.lockDate) : undefined;
    for (const target of [current, this.#original]) {
      if (!target) continue;
      target.title = alert.name;
      target.description = alert.description;
      target.date = date;
      target.eventType = alert.eventType;
      target.textureId = alert.textureId;
      target.flags = alert.flags;
      target.lockDate = lockDate;
    }
    this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.updateEvent);
  }

  #eventRemoved(eventId: bigint): void {
    this.#events.delete(eventId);
    if (this.#clipboard === eventId) this.#clipboard = undefined;
    this.#setPending(false);
    this.#invalidate();
    this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.eventList);
    if (this.#current && !this.#current.isNew && this.#current.eventId === eventId) this.#closeOpen();
  }

  #closeOpen(): void {
    this.#open = undefined;
    this.#awaitingOpen = undefined;
    this.#setCurrent(undefined);
    this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.closeEvent);
  }

  #lockout(change: { readonly mapId: number; readonly difficulty: number; readonly serverTime: number | undefined;
    readonly timeRemaining: number; readonly instanceId: bigint | undefined }, removed: boolean): void {
    const key = `${change.mapId}:${change.difficulty}`;
    if (removed) this.#lockouts.delete(key);
    else {
      const now = change.serverTime === undefined ? this.#host.now() : frameXmlCalendarPackedWall(change.serverTime);
      if (now === undefined) return;
      this.#lockouts.set(key, {
        mapId: change.mapId, difficulty: change.difficulty,
        instanceId: change.instanceId ?? this.#lockouts.get(key)?.instanceId ?? 0n,
        resetAt: now + Math.max(0, change.timeRemaining) / 60,
      });
    }
    this.#invalidate();
    this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.eventList);
  }

  // ---- dates and months ---------------------------------------------------------------------

  #today(): { readonly year: number; readonly month: number; readonly day: number } {
    const wall = this.#host.now();
    if (wall !== undefined) return frameXmlCalendarWallTime(wall);
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  }

  #viewedIndex(): number {
    if (this.#viewed === undefined) {
      const today = this.#today();
      this.#viewed = monthIndex(today.year, today.month);
    }
    return this.#viewed;
  }

  #clampMonth(index: number): number {
    return Math.min(monthIndex(MAX_DATE[2], MAX_DATE[0]), Math.max(monthIndex(MIN_DATE[2], MIN_DATE[0]), index));
  }

  minDate(): readonly unknown[] { return dateTuple(MIN_DATE[2], MIN_DATE[0], MIN_DATE[1]); }
  maxDate(): readonly unknown[] { return dateTuple(MAX_DATE[2], MAX_DATE[0], MAX_DATE[1]); }

  minHistoryDate(): readonly unknown[] {
    const today = this.#today();
    const date = frameXmlCalendarWallTime(frameXmlCalendarWall(today.year, today.month, today.day - 14));
    return dateTuple(date.year, date.month, date.day);
  }

  maxCreateDate(): readonly unknown[] {
    const today = this.#today();
    const last = frameXmlCalendarWallTime(frameXmlCalendarWall(today.year, today.month + 13, 1) - 1);
    return dateTuple(last.year, last.month, last.day);
  }

  month(offset: unknown): readonly unknown[] {
    const { year, month } = monthOf(this.#viewedIndex() + (integer(offset) ?? 0));
    return [month, year, daysIn(year, month), firstWeekday(year, month)];
  }

  absMonth(monthArg: unknown, yearArg: unknown): readonly unknown[] {
    const month = integer(monthArg);
    const year = integer(yearArg);
    if (month === undefined || year === undefined || month < 1 || month > 12) return NOTHING;
    return [month, year, daysIn(year, month), firstWeekday(year, month)];
  }

  setMonth(offset: unknown): void {
    this.#viewed = this.#clampMonth(this.#viewedIndex() + (integer(offset) ?? 0));
  }

  setAbsMonth(monthArg: unknown, yearArg: unknown): void {
    const month = integer(monthArg);
    const year = integer(yearArg);
    if (month === undefined || year === undefined || month < 1 || month > 12) return;
    this.#viewed = this.#clampMonth(monthIndex(year, month));
  }

  monthNames(): readonly unknown[] { return MONTH_NAMES.map((key) => this.#text(key)); }
  weekdayNames(): readonly unknown[] { return WEEKDAY_NAMES.map((key) => this.#text(key)); }

  // ---- the day lists ------------------------------------------------------------------------

  #days(index: number): readonly (readonly DayEntry[])[] {
    const cached = this.#monthCache.get(index);
    if (cached) return cached;
    const { year, month } = monthOf(index);
    const count = daysIn(year, month);
    const days: DayEntry[][] = Array.from({ length: count + 1 }, () => []);
    const lo = frameXmlCalendarWall(year, month, 1);
    const hi = frameXmlCalendarWall(year, month + 1, 1);
    const holidayDays = frameXmlCalendarHolidayMonth(this.#holidays, year, month, {
      regions: CLIENT_REGIONS,
      shown: (filterType) => this.#filters.get(
        filterType === 0 ? "calendarShowWeeklyHolidays" : filterType === 1 ? "calendarShowDarkmoon" : "calendarShowBattlegrounds",
      ) ?? true,
    });
    for (const [day, list] of holidayDays) {
      for (const entry of list) {
        days[day]?.push({
          ref: { kind: "holiday", holiday: entry.holiday }, calendarType: "HOLIDAY", title: entry.holiday.name,
          hour: entry.hour, minute: entry.minute, sequenceType: entry.sequenceType,
          sequenceIndex: entry.sequenceIndex, numSequenceDays: entry.numSequenceDays, priority: entry.holiday.priority,
        });
      }
    }
    const raidEntry = (calendarType: "RAID_LOCKOUT" | "RAID_RESET", mapId: number, difficulty: number,
      instanceId: bigint, at: number): void => {
      if (at < lo || at >= hi) return;
      const time = frameXmlCalendarWallTime(at);
      days[time.day]?.push({
        ref: { kind: "raid", mapId, difficulty, instanceId }, calendarType, title: this.#raidName(mapId),
        hour: time.hour, minute: time.minute, sequenceType: "", sequenceIndex: 1, numSequenceDays: 1, priority: 0,
      });
    };
    if (this.#filters.get("calendarShowLockouts")) {
      for (const lockout of this.#lockouts.values()) {
        raidEntry("RAID_LOCKOUT", lockout.mapId, lockout.difficulty, lockout.instanceId, lockout.resetAt);
      }
    }
    if (this.#filters.get("calendarShowResets")) {
      for (const reset of this.#resets) {
        const period = this.#resetPeriod(reset.mapId);
        const first = reset.first + Math.ceil((lo - reset.first) / period) * period;
        for (let at = first; at < hi; at += period) raidEntry("RAID_RESET", reset.mapId, 0, 0n, at);
      }
    }
    for (const row of this.#events.values()) {
      if (row.date < lo || row.date >= hi) continue;
      const time = frameXmlCalendarWallTime(row.date);
      days[time.day]?.push({
        ref: { kind: "event", eventId: row.eventId }, calendarType: calendarTypeOf(row.flags), title: row.title,
        hour: time.hour, minute: time.minute, sequenceType: "", sequenceIndex: 1, numSequenceDays: 1, priority: 0,
      });
    }
    // Holidays lead (the day's art and overlay come from them), by priority; the rest by time.
    for (const list of days) {
      list.sort((left, right) => {
        const leftHoliday = left.calendarType === "HOLIDAY" ? 0 : 1;
        const rightHoliday = right.calendarType === "HOLIDAY" ? 0 : 1;
        if (leftHoliday !== rightHoliday) return leftHoliday - rightHoliday;
        if (leftHoliday === 0 && left.priority !== right.priority) return right.priority - left.priority;
        const byTime = (left.hour * 60 + left.minute) - (right.hour * 60 + right.minute);
        if (byTime !== 0) return byTime;
        return left.title < right.title ? -1 : left.title > right.title ? 1 : 0;
      });
    }
    const frozen = days.map((list) => Object.freeze(list));
    this.#monthCache.set(index, frozen);
    return frozen;
  }

  #raidName(mapId: number): string {
    return this.#catalog?.raids.find((raid) => raid.mapId === mapId)?.name ?? "";
  }

  #resetPeriod(mapId: number): number {
    const seconds = this.#catalog?.raids.find((raid) => raid.mapId === mapId)?.difficulties
      .find((row) => row.resetSeconds > 0)?.resetSeconds ?? 7 * 86_400;
    return seconds / 60;
  }

  #entryAt(offsetArg: unknown, dayArg: unknown, indexArg: unknown): (Position & { readonly entry: DayEntry }) | undefined {
    const offset = integer(offsetArg) ?? 0;
    const day = integer(dayArg);
    const index = integer(indexArg);
    if (day === undefined || index === undefined || index < 1) return undefined;
    const month = this.#viewedIndex() + offset;
    const entry = this.#days(month)[day]?.[index - 1];
    return entry ? { monthIndex: month, day, index, entry } : undefined;
  }

  numDayEvents(offset: unknown, day: unknown): readonly unknown[] {
    const dayNumber = integer(day);
    if (dayNumber === undefined) return [0];
    return [this.#days(this.#viewedIndex() + (integer(offset) ?? 0))[dayNumber]?.length ?? 0];
  }

  #texture(row: { readonly eventType: number; readonly textureId: number }): FrameXmlCalendarTexture | undefined {
    if (row.eventType !== TYPE_RAID && row.eventType !== TYPE_DUNGEON) return undefined;
    return this.#catalog?.textures.find((texture) => texture.id === row.textureId);
  }

  #difficultyName(texture: FrameXmlCalendarTexture | undefined): string {
    if (!texture || texture.type !== 2 || !texture.difficultyToken) return "";
    return this.#globalString?.(texture.difficultyToken) ?? "";
  }

  /** The self-facing status and invite type of a list row (a guild event with no invite is «not signed up»). */
  #rowStatus(row: EventRow): { readonly status: number; readonly inviteType: number } {
    if (row.mine) return { status: row.mine.status, inviteType: row.mine.inviteType };
    const guild = (row.flags & (FLAG_GUILD_EVENT | FLAG_WITHOUT_INVITES)) !== 0;
    return { status: guild ? CALENDAR_STATUS_NOT_SIGNED_UP : CALENDAR_STATUS_INVITED, inviteType: guild ? 1 : 0 };
  }

  #rowModStatus(row: EventRow): string {
    return row.ownerGuid === this.#host.player()?.guid ? "CREATOR" : modStatus(row.mine?.rank);
  }

  dayEvent(offset: unknown, day: unknown, index: unknown): readonly unknown[] {
    const at = this.#entryAt(offset, day, index);
    if (!at) return NOTHING;
    const entry = at.entry;
    const ref = entry.ref;
    if (ref.kind === "event") {
      const row = this.#events.get(ref.eventId);
      if (!row) return NOTHING;
      const texture = this.#texture(row);
      const { status, inviteType } = this.#rowStatus(row);
      const inviter = row.mine?.inviterGuid ?? row.ownerGuid;
      return [
        row.title, entry.hour, entry.minute, entry.calendarType, "", row.eventType + 1, texture?.texture ?? "",
        this.#rowModStatus(row), status + 1, this.#host.nameOf(inviter) ?? "", texture?.difficulty ?? 0,
        inviteType + 1, 1, 1, this.#difficultyName(texture),
      ];
    }
    if (ref.kind === "holiday") {
      // Battleground holidays carry the PvP icon on their untextured days; every other holiday «other».
      const eventType = ref.holiday.filterType === 2 ? TYPE_PVP : TYPE_OTHER;
      return [
        entry.title, entry.hour, entry.minute, "HOLIDAY", entry.sequenceType, eventType + 1, ref.holiday.texture,
        "", 0, "", 0, 0, entry.sequenceIndex, entry.numSequenceDays, "",
      ];
    }
    return [
      entry.title, entry.hour, entry.minute, entry.calendarType, "", TYPE_RAID + 1, "", "", 0, "",
      ref.difficulty, 0, 1, 1, this.#raidDifficultyName(ref.mapId, ref.difficulty),
    ];
  }

  #raidDifficultyName(mapId: number, difficulty: number): string {
    const token = this.#catalog?.raids.find((raid) => raid.mapId === mapId)?.difficulties
      .find((row) => row.difficulty === difficulty)?.token;
    return token ? this.#globalString?.(token) ?? "" : "";
  }

  dayEventSequenceInfo(offset: unknown, day: unknown, index: unknown): readonly unknown[] {
    const at = this.#entryAt(offset, day, index);
    return at ? [at.entry.sequenceIndex, at.entry.numSequenceDays, at.entry.sequenceType] : NOTHING;
  }

  firstPendingInvite(offset: unknown, day: unknown): readonly unknown[] {
    const dayNumber = integer(day);
    const list = dayNumber === undefined ? undefined : this.#days(this.#viewedIndex() + (integer(offset) ?? 0))[dayNumber];
    const index = list?.findIndex((entry) => {
      if (entry.ref.kind !== "event") return false;
      const mine = this.#events.get(entry.ref.eventId)?.mine;
      return mine !== undefined && isPending(mine.status);
    }) ?? -1;
    return [index + 1];
  }

  holidayInfo(offset: unknown, day: unknown, index: unknown): readonly unknown[] {
    const at = this.#entryAt(offset, day, index);
    if (at?.entry.ref.kind !== "holiday") return NOTHING;
    const holiday = at.entry.ref.holiday;
    return [holiday.name, holiday.description, holiday.texture];
  }

  raidInfo(offset: unknown, day: unknown, index: unknown): readonly unknown[] {
    const at = this.#entryAt(offset, day, index);
    if (at?.entry.ref.kind !== "raid") return NOTHING;
    const ref = at.entry.ref;
    return [
      at.entry.title, at.entry.calendarType, Number(ref.instanceId), at.entry.hour, at.entry.minute, ref.difficulty,
      this.#raidDifficultyName(ref.mapId, ref.difficulty),
    ];
  }

  // ---- open / context -----------------------------------------------------------------------

  #relative(position: Position | undefined): readonly unknown[] {
    if (!position) return [0, 0, 0];
    return [position.monthIndex - this.#viewedIndex(), position.day, position.index];
  }

  openEvent(offset: unknown, day: unknown, index: unknown): void {
    const at = this.#entryAt(offset, day, index);
    if (!at) return;
    const { entry } = at;
    this.#open = { monthIndex: at.monthIndex, day: at.day, index: at.index, ref: entry.ref, calendarType: entry.calendarType };
    if (entry.ref.kind === "event") {
      this.#setCurrent(undefined);
      this.#awaitingOpen = entry.ref.eventId;
      this.#host.server()?.requestEvent(entry.ref.eventId);
      return;
    }
    this.#awaitingOpen = undefined;
    this.#setCurrent(undefined);
    this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.openEvent, entry.calendarType);
  }

  closeEvent(): void {
    this.#open = undefined;
    this.#awaitingOpen = undefined;
    this.#setCurrent(undefined);
  }

  eventIndex(): readonly unknown[] {
    return this.#relative(this.#open);
  }

  contextSelectEvent(offset: unknown, day: unknown, index: unknown): void {
    const at = this.#entryAt(offset, day, index);
    this.#context = at ? {
      monthIndex: at.monthIndex, day: at.day, index: at.index, ref: at.entry.ref, calendarType: at.entry.calendarType,
    } : undefined;
  }

  contextDeselectEvent(): void {
    this.#context = undefined;
  }

  contextEventIndex(): readonly unknown[] {
    return this.#relative(this.#context);
  }

  #contextRow(): EventRow | undefined {
    const ref = this.#context?.ref;
    return ref?.kind === "event" ? this.#events.get(ref.eventId) : undefined;
  }

  contextInviteIsPending(): boolean {
    const mine = this.#contextRow()?.mine;
    return mine !== undefined && isPending(mine.status);
  }

  contextInviteModeratorStatus(): readonly unknown[] {
    const row = this.#contextRow();
    return row ? [this.#rowModStatus(row)] : NOTHING;
  }

  contextInviteStatus(): readonly unknown[] {
    const row = this.#contextRow();
    return row ? [this.#rowStatus(row).status + 1] : NOTHING;
  }

  contextInviteType(): readonly unknown[] {
    const row = this.#contextRow();
    return row ? [this.#rowStatus(row).inviteType + 1] : NOTHING;
  }

  #respond(row: EventRow | undefined, status: number): void {
    const server = this.#host.server();
    if (!row || !server || this.#pending) return;
    const guildEvent = (row.flags & FLAG_GUILD_EVENT) !== 0;
    if (!row.mine || row.mine.inviteId === 0n) {
      // No invitation to answer: a guild event is signed up to instead (CMSG_CALENDAR_EVENT_SIGNUP).
      if (!guildEvent || status === CALENDAR_STATUS_DECLINED) return;
      server.signUp(row.eventId, status === CALENDAR_STATUS_TENTATIVE);
    } else {
      server.rsvp(row.eventId, row.mine.inviteId, status);
    }
    this.#setPending(true);
  }

  contextInviteAvailable(): void { this.#respond(this.#contextRow(), CALENDAR_STATUS_ACCEPTED); }
  contextInviteTentative(): void { this.#respond(this.#contextRow(), CALENDAR_STATUS_TENTATIVE); }
  contextInviteDecline(): void { this.#respond(this.#contextRow(), CALENDAR_STATUS_DECLINED); }

  contextEventSignUp(): void {
    const row = this.#contextRow();
    const server = this.#host.server();
    if (!row || !server || this.#pending) return;
    server.signUp(row.eventId, false);
    this.#setPending(true);
  }

  #removeSelf(row: EventRow | undefined): void {
    const server = this.#host.server();
    const self = this.#host.player()?.guid;
    if (!row || !server || self === undefined || this.#pending) return;
    if (row.ownerGuid === self) server.removeEvent(row.eventId, row.mine?.inviteId ?? 0n);
    else if (row.mine) server.removeInvite(self, row.mine.inviteId, row.eventId, row.mine.inviteId);
    else return;
    this.#setPending(true);
  }

  contextInviteRemove(): void { this.#removeSelf(this.#contextRow()); }

  contextEventRemove(): void {
    const row = this.#contextRow();
    const server = this.#host.server();
    if (!row || !server || this.#pending) return;
    server.removeEvent(row.eventId, row.mine?.inviteId ?? 0n);
    this.#setPending(true);
  }

  contextEventCopy(): void {
    const row = this.#contextRow();
    if (row && this.#canEditRow(row)) this.#clipboard = row.eventId;
  }

  contextEventClipboard(): boolean {
    return this.#clipboard !== undefined && this.#events.has(this.#clipboard);
  }

  contextEventPaste(offsetArg: unknown, dayArg: unknown): void {
    const row = this.#clipboard === undefined ? undefined : this.#events.get(this.#clipboard);
    const server = this.#host.server();
    const day = integer(dayArg);
    if (!row || !server || day === undefined || this.#pending) return;
    const { year, month } = monthOf(this.#viewedIndex() + (integer(offsetArg) ?? 0));
    const time = frameXmlCalendarWallTime(row.date);
    server.copyEvent(row.eventId, row.mine?.inviteId ?? 0n, packWall(frameXmlCalendarWall(year, month, day, time.hour, time.minute)));
    this.#setPending(true);
  }

  contextEventCanComplain(offset: unknown, day: unknown, index: unknown): boolean {
    const at = this.#entryAt(offset, day, index);
    if (at?.entry.ref.kind !== "event") return false;
    const row = this.#events.get(at.entry.ref.eventId);
    const self = this.#host.player()?.guid;
    return row !== undefined && row.mine !== undefined && calendarTypeOf(row.flags) === "PLAYER"
      && row.mine.status === CALENDAR_STATUS_INVITED && row.mine.inviterGuid !== self && row.ownerGuid !== self;
  }

  contextEventComplain(): void {
    const row = this.#contextRow();
    if (!row?.mine) return;
    this.#host.server()?.complain(row.mine.inviterGuid, row.eventId, row.mine.inviteId);
  }

  /**
   * Wow.exe's two edit checks (CalendarEventSetLocked at 0x5BB870 picks one by the announcement flag):
   * a guild announcement — no invites, so no moderators — is anyone's with the guild's event right; any
   * other event is its creator's and its moderators'.
   */
  #canEditRow(row: EventRow): boolean {
    if ((row.flags & FLAG_WITHOUT_INVITES) !== 0) return row.ownerGuid === this.#host.player()?.guid || this.#host.canCreateGuildEvent();
    return row.ownerGuid === this.#host.player()?.guid || (row.mine?.rank ?? 0) >= CALENDAR_RANK_MODERATOR;
  }

  contextEventCanEdit(offset: unknown, day: unknown, index: unknown): boolean {
    const at = this.#entryAt(offset, day, index);
    if (at?.entry.ref.kind !== "event") return false;
    const row = this.#events.get(at.entry.ref.eventId);
    return row !== undefined && this.#canEditRow(row);
  }

  contextEventGetCalendarType(): readonly unknown[] {
    const context = this.#context;
    if (!context) return NOTHING;
    const row = context.ref.kind === "event" ? this.#events.get(context.ref.eventId) : undefined;
    return [row ? calendarTypeOf(row.flags) : context.calendarType];
  }

  // ---- the working event --------------------------------------------------------------------

  #newEvent(calendarType: FrameXmlCalendarType): void {
    const player = this.#host.player();
    const today = this.#today();
    const flags = calendarType === "GUILD_EVENT" ? FLAG_GUILD_EVENT : calendarType === "GUILD_ANNOUNCEMENT" ? FLAG_WITHOUT_INVITES : 0;
    const invites: WorkingInvite[] = calendarType === "GUILD_ANNOUNCEMENT" || !player ? [] : [{
      guid: player.guid, level: player.level,
      status: calendarType === "GUILD_EVENT" ? CALENDAR_STATUS_SIGNED_UP : CALENDAR_STATUS_ACCEPTED,
      rank: CALENDAR_RANK_OWNER, inviteType: calendarType === "GUILD_EVENT" ? 1 : 0, inviteId: 0n, responseTime: 0,
    }];
    this.#open = undefined;
    this.#awaitingOpen = undefined;
    this.#setCurrent({
      isNew: true, eventId: 0n, calendarType, ownerGuid: player?.guid ?? 0n, title: "", description: "",
      eventType: TYPE_OTHER, repeatOption: 0, maxSize: MAX_INVITES, textureId: -1,
      date: frameXmlCalendarWall(today.year, today.month, today.day, 12, 0), lockDate: undefined, flags, invites,
    });
  }

  newEvent(): void { this.#newEvent("PLAYER"); }

  newGuildEvent(): void {
    if (!this.#host.inGuild()) {
      this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.error, this.#text("ERR_GUILD_PLAYER_NOT_IN_GUILD"));
      return;
    }
    this.#newEvent("GUILD_EVENT");
  }

  newGuildAnnouncement(): void {
    if (!this.#host.inGuild()) {
      this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.error, this.#text("ERR_GUILD_PLAYER_NOT_IN_GUILD"));
      return;
    }
    this.#newEvent("GUILD_ANNOUNCEMENT");
  }

  #myInvite(event: WorkingEvent | undefined): WorkingInvite | undefined {
    const self = this.#host.player()?.guid;
    return self === undefined ? undefined : event?.invites.find((invite) => invite.guid === self);
  }

  /** The invite id a moderator command names itself by (the CMSG `ModeratorID`). */
  #moderatorId(event: WorkingEvent): bigint {
    return this.#myInvite(event)?.inviteId ?? this.#events.get(event.eventId)?.mine?.inviteId ?? 0n;
  }

  eventInfo(): readonly unknown[] {
    const event = this.#current;
    if (!event) return NOTHING;
    const date = frameXmlCalendarWallTime(event.date);
    const lock = event.lockDate === undefined ? undefined : frameXmlCalendarWallTime(event.lockDate);
    const lockTuple = lock ? [lock.weekday + 1, lock.month, lock.day, lock.year, lock.hour, lock.minute] : [0, 0, 0, 0, 0, 0];
    const row = event.isNew ? undefined : this.#events.get(event.eventId);
    const mine = this.#myInvite(event);
    const status = mine?.status ?? (row ? this.#rowStatus(row).status : CALENDAR_STATUS_INVITED);
    const inviteType = mine?.inviteType ?? (row ? this.#rowStatus(row).inviteType : 0);
    return [
      event.title, event.description, this.#host.nameOf(event.ownerGuid) ?? "", event.eventType + 1,
      event.repeatOption + 1, event.maxSize, this.#textureIndex(event),
      date.weekday + 1, date.month, date.day, date.year, date.hour, date.minute,
      ...lockTuple,
      (event.flags & FLAG_INVITES_LOCKED) !== 0 ? 1 : undefined,
      (event.flags & FLAG_AUTO_APPROVE) !== 0 ? 1 : undefined,
      !event.isNew && isPending(status) ? 1 : undefined,
      status + 1, inviteType + 1, event.calendarType,
    ];
  }

  #textureIndex(event: WorkingEvent): number {
    const list = this.#textures(event.eventType);
    const index = list.findIndex((texture) => texture.id === event.textureId);
    return index + 1;
  }

  eventGetCalendarType(): readonly unknown[] {
    return this.#current ? [this.#current.calendarType] : NOTHING;
  }

  eventCanEdit(): boolean {
    const event = this.#current;
    if (!event) return false;
    if (event.isNew) return true;
    const self = this.#host.player()?.guid;
    if (event.calendarType === "GUILD_ANNOUNCEMENT") return event.ownerGuid === self || this.#host.canCreateGuildEvent();
    return event.ownerGuid === self || (this.#myInvite(event)?.rank ?? 0) >= CALENDAR_RANK_MODERATOR;
  }

  eventIsModerator(): boolean {
    const event = this.#current;
    if (!event) return false;
    return event.isNew || event.ownerGuid === this.#host.player()?.guid
      || (this.#myInvite(event)?.rank ?? 0) >= CALENDAR_RANK_MODERATOR;
  }

  eventHasPendingInvite(): boolean {
    const event = this.#current;
    const mine = event && !event.isNew ? this.#myInvite(event) : undefined;
    return mine !== undefined && isPending(mine.status);
  }

  eventHaveSettingsChanged(): boolean {
    const event = this.#current;
    const original = this.#original;
    if (!event || !original) return false;
    return event.title !== original.title || event.description !== original.description
      || event.eventType !== original.eventType || event.repeatOption !== original.repeatOption
      || event.maxSize !== original.maxSize || event.textureId !== original.textureId || event.date !== original.date
      || event.lockDate !== original.lockDate || event.flags !== original.flags;
  }

  setTitle(value: unknown): void { if (this.#current) this.#current.title = typeof value === "string" ? value : ""; }
  setDescription(value: unknown): void { if (this.#current) this.#current.description = typeof value === "string" ? value : ""; }

  setType(value: unknown): void {
    const event = this.#current;
    const type = integer(value);
    if (!event || type === undefined || type < 1 || type > TYPE_NAMES.length) return;
    if (event.eventType !== type - 1 && type - 1 !== TYPE_RAID && type - 1 !== TYPE_DUNGEON) event.textureId = -1;
    event.eventType = type - 1;
  }

  setRepeatOption(value: unknown): void {
    const option = integer(value);
    if (this.#current && option !== undefined && option >= 1 && option <= REPEAT_NAMES.length) this.#current.repeatOption = option - 1;
  }

  setSize(value: unknown): void {
    const size = integer(value);
    if (this.#current && size !== undefined && size > 0) this.#current.maxSize = size;
  }

  #withDate(minutes: number, monthArg: unknown, dayArg: unknown, yearArg: unknown): number | undefined {
    const month = integer(monthArg);
    const day = integer(dayArg);
    const year = integer(yearArg);
    if (month === undefined || day === undefined || year === undefined || month < 1 || month > 12
      || day < 1 || day > daysIn(year, month)) return undefined;
    const time = frameXmlCalendarWallTime(minutes);
    return frameXmlCalendarWall(year, month, day, time.hour, time.minute);
  }

  #withTime(minutes: number, hourArg: unknown, minuteArg: unknown): number | undefined {
    const hour = integer(hourArg);
    const minute = integer(minuteArg);
    if (hour === undefined || minute === undefined || hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
    const date = frameXmlCalendarWallTime(minutes);
    return frameXmlCalendarWall(date.year, date.month, date.day, hour, minute);
  }

  setDate(month: unknown, day: unknown, year: unknown): void {
    const event = this.#current;
    const date = event ? this.#withDate(event.date, month, day, year) : undefined;
    if (event && date !== undefined) event.date = date;
  }

  setTime(hour: unknown, minute: unknown): void {
    const event = this.#current;
    const date = event ? this.#withTime(event.date, hour, minute) : undefined;
    if (event && date !== undefined) event.date = date;
  }

  setLockoutDate(month: unknown, day: unknown, year: unknown): void {
    const event = this.#current;
    const date = event ? this.#withDate(event.lockDate ?? event.date, month, day, year) : undefined;
    if (event && date !== undefined) event.lockDate = date;
  }

  setLockoutTime(hour: unknown, minute: unknown): void {
    const event = this.#current;
    const date = event ? this.#withTime(event.lockDate ?? event.date, hour, minute) : undefined;
    if (event && date !== undefined) event.lockDate = date;
  }

  setTextureId(value: unknown): void {
    const event = this.#current;
    const index = integer(value);
    if (!event || index === undefined) return;
    const texture = this.#textures(event.eventType)[index - 1];
    event.textureId = texture?.id ?? -1;
  }

  #flag(flag: number, on: boolean): void {
    const event = this.#current;
    if (!event || !this.eventCanEdit()) return;
    event.flags = on ? event.flags | flag : event.flags & ~flag;
  }

  setLocked(): void { this.#flag(FLAG_INVITES_LOCKED, true); }
  clearLocked(): void { this.#flag(FLAG_INVITES_LOCKED, false); }
  setAutoApprove(): void { this.#flag(FLAG_AUTO_APPROVE, true); }
  clearAutoApprove(): void { this.#flag(FLAG_AUTO_APPROVE, false); }

  #textures(eventType: number): readonly FrameXmlCalendarTexture[] {
    const type = eventType === TYPE_RAID ? 2 : eventType === TYPE_DUNGEON ? 1 : 0;
    const faction = this.#host.player()?.faction ?? -1;
    const cached = this.#textureCache;
    if (cached && cached.type === type && cached.faction === faction && cached.catalog === this.#catalog) return cached.list;
    const list = type === 0 ? [] : (this.#catalog?.textures ?? []).filter((texture) =>
      texture.type === type && (texture.faction < 0 || faction < 0 || texture.faction === faction));
    list.sort((left, right) => right.expansion - left.expansion || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    this.#textureCache = { type, faction, catalog: this.#catalog, list };
    return list;
  }

  #textureCache: {
    readonly type: number; readonly faction: number; readonly catalog: FrameXmlCalendarCatalog | undefined;
    readonly list: readonly FrameXmlCalendarTexture[];
  } | undefined;

  eventTextures(value: unknown): readonly unknown[] {
    const type = integer(value);
    if (type === undefined || (type - 1 !== TYPE_RAID && type - 1 !== TYPE_DUNGEON)) return NOTHING;
    const values: unknown[] = [];
    for (const texture of this.#textures(type - 1)) {
      values.push(texture.name, texture.texture, texture.expansion, this.#difficultyName(texture));
    }
    return values;
  }

  eventTypes(): readonly unknown[] { return TYPE_NAMES.map((key) => this.#text(key)); }
  repeatOptions(): readonly unknown[] { return REPEAT_NAMES.map((key) => this.#text(key)); }

  // ---- the invite list ----------------------------------------------------------------------

  #sorted(): WorkingInvite[] {
    const event = this.#current;
    if (!event) return [];
    if (this.#order) return this.#order;
    const name = (invite: WorkingInvite): string => this.#host.nameOf(invite.guid) ?? "";
    const className = (invite: WorkingInvite): string => this.#host.classOf(invite.guid)?.[0] ?? "";
    const compare = (left: string, right: string): number => left.localeCompare(right, "ru");
    const order = [...event.invites].sort((left, right) => {
      let result = 0;
      if (this.#criterion === "status") {
        result = STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status);
      } else if (this.#criterion === "class") {
        result = compare(className(left), className(right));
      }
      if (result === 0) result = compare(name(left), name(right));
      return this.#reverse ? -result : result;
    });
    this.#order = order;
    return order;
  }

  #inviteAt(value: unknown): WorkingInvite | undefined {
    const index = integer(value);
    return index === undefined || index < 1 ? undefined : this.#sorted()[index - 1];
  }

  eventNumInvites(): readonly unknown[] {
    return [this.#current?.invites.length ?? 0];
  }

  eventInvite(value: unknown): readonly unknown[] {
    const invite = this.#inviteAt(value);
    if (!invite) return NOTHING;
    const self = this.#host.player();
    const name = this.#host.nameOf(invite.guid) ?? (invite.guid === self?.guid ? self.name : "");
    const classInfo = this.#host.classOf(invite.guid);
    return [
      name, invite.level, classInfo?.[0] ?? "", classInfo?.[1] ?? "", invite.status + 1, modStatus(invite.rank),
      invite.guid === self?.guid ? 1 : undefined,
    ];
  }

  eventInviteResponseTime(value: unknown): readonly unknown[] {
    const invite = this.#inviteAt(value);
    const wall = invite && invite.responseTime !== 0 ? frameXmlCalendarPackedWall(invite.responseTime) : undefined;
    if (wall === undefined || wall < MIN_RESPONSE_WALL) return [0, 0, 0, 0, 0, 0];
    const time = frameXmlCalendarWallTime(wall);
    return [time.weekday + 1, time.month, time.day, time.year, time.hour, time.minute];
  }

  eventSelectInvite(value: unknown): void {
    const index = integer(value);
    this.#selectedInvite = index !== undefined && index >= 1 && index <= (this.#current?.invites.length ?? 0) ? index : 0;
  }

  eventSelectedInvite(): readonly unknown[] { return [this.#selectedInvite]; }

  eventSortInvites(criterionArg: unknown, reverse: unknown): void {
    const criterion = criterionArg === "name" || criterionArg === "class" || criterionArg === "status" ? criterionArg : undefined;
    if (!criterion) return;
    this.#criterion = criterion;
    this.#reverse = reverse !== undefined && reverse !== null && reverse !== false && reverse !== 0;
    this.#inviteListChanged();
  }

  eventInviteSortCriterion(): readonly unknown[] {
    return [this.#criterion, this.#reverse ? 1 : undefined];
  }

  eventStatusOptions(value: unknown): readonly unknown[] {
    const event = this.#current;
    const invite = this.#inviteAt(value);
    if (!event || !invite || !this.eventCanEdit()) return NOTHING;
    const values: unknown[] = [];
    for (let status = 1; status < STATUS_NAMES.length; status += 1) {
      if (status === CALENDAR_STATUS_SIGNED_UP || status === CALENDAR_STATUS_NOT_SIGNED_UP || status === invite.status) continue;
      if (event.calendarType === "GUILD_EVENT" && (status === CALENDAR_STATUS_ACCEPTED || status === CALENDAR_STATUS_DECLINED)) continue;
      values.push(status + 1, this.#text(STATUS_NAMES[status]!));
    }
    return values;
  }

  eventCanModerate(value: unknown): boolean {
    const invite = this.#inviteAt(value);
    return invite !== undefined && invite.rank !== CALENDAR_RANK_OWNER && this.eventIsModerator();
  }

  inviteByName(name: unknown): void {
    const event = this.#current;
    const server = this.#host.server();
    const text = typeof name === "string" ? name.trim() : "";
    if (!event || !server || !text || !this.canSendInvite()) return;
    if (event.invites.length >= MAX_INVITES) {
      this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.error, this.#errorText(14, ""));
      return;
    }
    this.#lastInviteAt = this.#host.monotonic();
    if (event.isNew) server.invite(0n, text, 0n, true, event.calendarType === "GUILD_EVENT");
    else server.invite(event.eventId, text, this.#moderatorId(event), false, false);
  }

  eventRemoveInvite(value: unknown): void {
    const event = this.#current;
    const invite = this.#inviteAt(value);
    if (!event || !invite || invite.rank === CALENDAR_RANK_OWNER) return;
    if (event.isNew) {
      event.invites.splice(event.invites.indexOf(invite), 1);
      this.#inviteListChanged();
      return;
    }
    this.#host.server()?.removeInvite(invite.guid, invite.inviteId, event.eventId, this.#moderatorId(event));
  }

  eventSetStatus(value: unknown, statusArg: unknown): void {
    const event = this.#current;
    const invite = this.#inviteAt(value);
    const status = integer(statusArg);
    if (!event || !invite || status === undefined || status < 1 || status > STATUS_NAMES.length) return;
    if (event.isNew) {
      invite.status = status - 1;
      this.#inviteListChanged();
      return;
    }
    this.#host.server()?.setStatus(invite.guid, event.eventId, invite.inviteId, status - 1, this.#moderatorId(event));
  }

  #setRank(value: unknown, rank: number): void {
    const event = this.#current;
    const invite = this.#inviteAt(value);
    if (!event || !invite || invite.rank === CALENDAR_RANK_OWNER) return;
    if (event.isNew) {
      invite.rank = rank;
      this.#inviteListChanged();
      return;
    }
    this.#host.server()?.setModerator(invite.guid, event.eventId, invite.inviteId, rank, this.#moderatorId(event));
    // The alert cannot carry the rank (see #moderator); the client shows its own request at once.
    invite.rank = rank;
    this.#inviteListChanged();
  }

  eventSetModerator(value: unknown): void { this.#setRank(value, CALENDAR_RANK_MODERATOR); }
  eventClearModerator(value: unknown): void { this.#setRank(value, 0); }

  #respondCurrent(status: number): void {
    const event = this.#current;
    if (!event || event.isNew) return;
    const row = this.#events.get(event.eventId);
    const mine = this.#myInvite(event);
    if (row && mine && mine.inviteId !== 0n && row.mine?.inviteId !== mine.inviteId) {
      row.mine = { inviteId: mine.inviteId, status: mine.status, rank: mine.rank, inviteType: mine.inviteType, inviterGuid: row.mine?.inviterGuid ?? row.ownerGuid };
      this.#pendingCount = undefined;
    }
    this.#respond(row, status);
  }

  eventAvailable(): void { this.#respondCurrent(CALENDAR_STATUS_ACCEPTED); }
  eventTentative(): void { this.#respondCurrent(CALENDAR_STATUS_TENTATIVE); }
  eventDecline(): void { this.#respondCurrent(CALENDAR_STATUS_DECLINED); }

  eventSignUp(): void {
    const event = this.#current;
    const server = this.#host.server();
    if (!event || event.isNew || !server || this.#pending) return;
    server.signUp(event.eventId, false);
    this.#setPending(true);
  }

  // ---- commands -----------------------------------------------------------------------------

  #fields(event: WorkingEvent): CalendarEventFields {
    return {
      title: event.title, description: event.description, eventType: event.eventType, maxSize: event.maxSize,
      textureId: event.textureId, time: packWall(event.date),
      lockDate: event.lockDate === undefined ? 0 : packWall(event.lockDate), flags: event.flags,
    };
  }

  addEvent(): void {
    const event = this.#current;
    const server = this.#host.server();
    if (!event?.isNew || !server || !this.canAddEvent()) return;
    if (!event.title.trim()) {
      this.#fire(FRAMEXML_CALENDAR_UI_EVENTS.error, this.#errorText(19, ""));
      return;
    }
    const invites = event.invites.map((invite) => ({ guid: invite.guid, status: invite.status, moderator: invite.rank }));
    server.addEvent(this.#fields(event), invites);
    this.#lastAddAt = this.#host.monotonic();
    this.#setPending(true);
  }

  updateEvent(): void {
    const event = this.#current;
    const server = this.#host.server();
    if (!event || event.isNew || !server || this.#pending || !this.eventCanEdit()) return;
    server.updateEvent(event.eventId, this.#moderatorId(event), this.#fields(event));
    this.#setPending(true);
  }

  removeEvent(): void {
    const event = this.#current;
    if (!event || event.isNew) return;
    const row = this.#events.get(event.eventId);
    const mine = this.#myInvite(event);
    this.#removeSelf(row && mine && row.mine?.inviteId !== mine.inviteId && mine.inviteId !== 0n
      ? { ...row, mine: { inviteId: mine.inviteId, status: mine.status, rank: mine.rank, inviteType: mine.inviteType, inviterGuid: row.ownerGuid } }
      : row);
  }

  massInviteGuild(minArg: unknown, maxArg: unknown, rankArg: unknown): void {
    const server = this.#host.server();
    const min = integer(minArg);
    const max = integer(maxArg);
    const rank = integer(rankArg);
    if (!server || !this.#current?.isNew || min === undefined || max === undefined || rank === undefined || this.#pending) return;
    server.guildFilter(Math.max(0, min), Math.max(0, max), Math.max(0, rank - 1));
    this.#massInvite = true;
    this.#setPending(true);
  }

  massInviteArenaTeam(indexArg: unknown): void {
    const server = this.#host.server();
    const index = integer(indexArg);
    const teamId = index === undefined ? undefined : this.#host.arenaTeamId(index);
    if (!server || !this.#current?.isNew || teamId === undefined || this.#pending) return;
    server.arenaTeam(teamId);
    this.#massInvite = true;
    this.#setPending(true);
  }

  defaultGuildFilter(): readonly unknown[] {
    const level = this.#host.maxLevel();
    return [level, level, this.#host.guildRankCount()];
  }

  isActionPending(): boolean { return this.#pending !== undefined; }

  canSendInvite(): boolean {
    return this.#pending === undefined && this.#host.monotonic() - this.#lastInviteAt >= INVITE_THROTTLE_MS;
  }

  canAddEvent(): boolean {
    return this.#pending === undefined && this.#host.monotonic() - this.#lastAddAt >= ADD_THROTTLE_MS;
  }

  /** OpenCalendar: CMSG_CALENDAR_GET_CALENDAR and CMSG_CALENDAR_GET_NUM_PENDING. */
  open(): void {
    this.#host.server()?.requestCalendar();
  }

  canEditGuildEvent(): boolean {
    return this.#host.inGuild() && this.#host.canCreateGuildEvent();
  }

  /** For tests and diagnostics: whether a mass invite is being answered. */
  get massInvitePending(): boolean { return this.#massInvite; }
}

// ---- bindings -------------------------------------------------------------------------------

/** The part of the world seam the calendar bindings read. */
export interface FrameXmlCalendarUiHost {
  readonly calendar?: { readonly ui?: FrameXmlCalendarModel | undefined } | undefined;
  partyMemberCount?(): number;
  raidMemberCount?(): number;
}

export type FrameXmlCalendarBinding = (host: FrameXmlCalendarUiHost, args: readonly unknown[]) => readonly unknown[];

const flag = (value: boolean): readonly unknown[] => [value ? 1 : undefined];

const withModel = (answer: (model: FrameXmlCalendarModel, args: readonly unknown[]) => readonly unknown[],
  fallback: readonly unknown[] = NOTHING): FrameXmlCalendarBinding =>
  (host, args) => {
    const model = host.calendar?.ui;
    return model ? answer(model, args) : fallback;
  };

const command = (run: (model: FrameXmlCalendarModel, args: readonly unknown[]) => void): FrameXmlCalendarBinding =>
  withModel((model, args) => { run(model, args); return NOTHING; });

const test = (answer: (model: FrameXmlCalendarModel, args: readonly unknown[]) => boolean): FrameXmlCalendarBinding =>
  withModel((model, args) => flag(answer(model, args)), [undefined]);

/**
 * The stock calendar's C API, spread into FRAMEXML_SEAM_BINDINGS. Without a model (a seam that has no
 * calendar) the date getters answer nothing, counts answer zero and predicates answer nil — every
 * stock caller of those guards, and the lazy owner's gate refuses the window before a player sees it.
 * `CalendarGetDate`/`CalendarGetNumPendingInvites` stay FrameXmlCalendar.ts's (GameTime's clock).
 */
export const FRAMEXML_CALENDAR_UI_BINDINGS: Readonly<Record<string, FrameXmlCalendarBinding>> = Object.freeze({
  CalendarGetMonthNames: withModel((model) => model.monthNames()),
  CalendarGetWeekdayNames: withModel((model) => model.weekdayNames()),
  CalendarGetMinDate: withModel((model) => model.minDate()),
  CalendarGetMaxDate: withModel((model) => model.maxDate()),
  CalendarGetMinHistoryDate: withModel((model) => model.minHistoryDate()),
  CalendarGetMaxCreateDate: withModel((model) => model.maxCreateDate()),
  CalendarGetMonth: withModel((model, args) => model.month(args[0])),
  CalendarGetAbsMonth: withModel((model, args) => model.absMonth(args[0], args[1])),
  CalendarSetMonth: command((model, args) => model.setMonth(args[0])),
  CalendarSetAbsMonth: command((model, args) => model.setAbsMonth(args[0], args[1])),
  CalendarGetNumDayEvents: withModel((model, args) => model.numDayEvents(args[0], args[1]), [0]),
  CalendarGetDayEvent: withModel((model, args) => model.dayEvent(args[0], args[1], args[2])),
  CalendarGetDayEventSequenceInfo: withModel((model, args) => model.dayEventSequenceInfo(args[0], args[1], args[2])),
  CalendarGetFirstPendingInvite: withModel((model, args) => model.firstPendingInvite(args[0], args[1]), [0]),
  CalendarOpenEvent: command((model, args) => model.openEvent(args[0], args[1], args[2])),
  CalendarGetEventIndex: withModel((model) => model.eventIndex(), [0, 0, 0]),
  CalendarCloseEvent: command((model) => model.closeEvent()),
  CalendarGetEventInfo: withModel((model) => model.eventInfo()),
  CalendarGetHolidayInfo: withModel((model, args) => model.holidayInfo(args[0], args[1], args[2])),
  CalendarGetRaidInfo: withModel((model, args) => model.raidInfo(args[0], args[1], args[2])),
  CalendarEventGetNumInvites: withModel((model) => model.eventNumInvites(), [0]),
  CalendarEventGetInvite: withModel((model, args) => model.eventInvite(args[0])),
  CalendarEventGetInviteResponseTime: withModel((model, args) => model.eventInviteResponseTime(args[0]), [0, 0, 0, 0, 0, 0]),
  CalendarAddEvent: command((model) => model.addEvent()),
  CalendarNewEvent: command((model) => model.newEvent()),
  CalendarMassInviteGuild: command((model, args) => model.massInviteGuild(args[0], args[1], args[2])),
  CalendarMassInviteArenaTeam: command((model, args) => model.massInviteArenaTeam(args[0])),
  CalendarNewGuildAnnouncement: command((model) => model.newGuildAnnouncement()),
  CalendarNewGuildEvent: command((model) => model.newGuildEvent()),
  CalendarDefaultGuildFilter: withModel((model) => model.defaultGuildFilter()),
  CalendarUpdateEvent: command((model) => model.updateEvent()),
  CalendarRemoveEvent: command((model) => model.removeEvent()),
  CalendarEventSelectInvite: command((model, args) => model.eventSelectInvite(args[0])),
  CalendarEventGetSelectedInvite: withModel((model) => model.eventSelectedInvite(), [0]),
  CalendarContextSelectEvent: command((model, args) => model.contextSelectEvent(args[0], args[1], args[2])),
  CalendarContextDeselectEvent: command((model) => model.contextDeselectEvent()),
  CalendarContextGetEventIndex: withModel((model) => model.contextEventIndex(), [0, 0, 0]),
  CalendarContextInviteIsPending: test((model) => model.contextInviteIsPending()),
  CalendarContextInviteModeratorStatus: withModel((model) => model.contextInviteModeratorStatus()),
  CalendarContextInviteStatus: withModel((model) => model.contextInviteStatus()),
  CalendarContextInviteType: withModel((model) => model.contextInviteType()),
  CalendarContextInviteAvailable: command((model) => model.contextInviteAvailable()),
  CalendarContextInviteTentative: command((model) => model.contextInviteTentative()),
  CalendarContextInviteDecline: command((model) => model.contextInviteDecline()),
  CalendarContextInviteRemove: command((model) => model.contextInviteRemove()),
  CalendarContextEventSignUp: command((model) => model.contextEventSignUp()),
  CalendarContextEventRemove: command((model) => model.contextEventRemove()),
  CalendarContextEventCopy: command((model) => model.contextEventCopy()),
  CalendarContextEventPaste: command((model, args) => model.contextEventPaste(args[0], args[1])),
  CalendarContextEventClipboard: test((model) => model.contextEventClipboard()),
  CalendarContextEventCanComplain: test((model, args) => model.contextEventCanComplain(args[0], args[1], args[2])),
  CalendarContextEventComplain: command((model) => model.contextEventComplain()),
  CalendarContextEventCanEdit: test((model, args) => model.contextEventCanEdit(args[0], args[1], args[2])),
  CalendarContextEventGetCalendarType: withModel((model) => model.contextEventGetCalendarType()),
  CalendarEventInvite: command((model, args) => model.inviteByName(args[0])),
  CalendarEventRemoveInvite: command((model, args) => model.eventRemoveInvite(args[0])),
  CalendarEventAvailable: command((model) => model.eventAvailable()),
  CalendarEventTentative: command((model) => model.eventTentative()),
  CalendarEventDecline: command((model) => model.eventDecline()),
  CalendarEventSignUp: command((model) => model.eventSignUp()),
  CalendarEventSortInvites: command((model, args) => model.eventSortInvites(args[0], args[1])),
  CalendarEventGetInviteSortCriterion: withModel((model) => model.eventInviteSortCriterion()),
  CalendarEventGetStatusOptions: withModel((model, args) => model.eventStatusOptions(args[0])),
  CalendarEventSetStatus: command((model, args) => model.eventSetStatus(args[0], args[1])),
  CalendarEventSetModerator: command((model, args) => model.eventSetModerator(args[0])),
  CalendarEventClearModerator: command((model, args) => model.eventClearModerator(args[0])),
  CalendarEventCanModerate: test((model, args) => model.eventCanModerate(args[0])),
  CalendarEventIsModerator: test((model) => model.eventIsModerator()),
  CalendarEventGetTypes: withModel((model) => model.eventTypes()),
  CalendarEventGetRepeatOptions: withModel((model) => model.repeatOptions()),
  CalendarEventSetTitle: command((model, args) => model.setTitle(args[0])),
  CalendarEventSetDescription: command((model, args) => model.setDescription(args[0])),
  CalendarEventSetType: command((model, args) => model.setType(args[0])),
  CalendarEventSetRepeatOption: command((model, args) => model.setRepeatOption(args[0])),
  CalendarEventSetSize: command((model, args) => model.setSize(args[0])),
  CalendarEventSetDate: command((model, args) => model.setDate(args[0], args[1], args[2])),
  CalendarEventSetTime: command((model, args) => model.setTime(args[0], args[1])),
  CalendarEventSetLockoutDate: command((model, args) => model.setLockoutDate(args[0], args[1], args[2])),
  CalendarEventSetLockoutTime: command((model, args) => model.setLockoutTime(args[0], args[1])),
  CalendarEventSetTextureID: command((model, args) => model.setTextureId(args[0])),
  CalendarEventSetLocked: command((model) => model.setLocked()),
  CalendarEventClearLocked: command((model) => model.clearLocked()),
  CalendarEventSetAutoApprove: command((model) => model.setAutoApprove()),
  CalendarEventClearAutoApprove: command((model) => model.clearAutoApprove()),
  CalendarEventGetTextures: withModel((model, args) => model.eventTextures(args[0])),
  CalendarEventHasPendingInvite: test((model) => model.eventHasPendingInvite()),
  CalendarEventHaveSettingsChanged: test((model) => model.eventHaveSettingsChanged()),
  CalendarEventCanEdit: test((model) => model.eventCanEdit()),
  CalendarEventGetCalendarType: withModel((model) => model.eventGetCalendarType()),
  CalendarCanSendInvite: test((model) => model.canSendInvite()),
  CalendarCanAddEvent: test((model) => model.canAddEvent()),
  CalendarIsActionPending: test((model) => model.isActionPending()),
  OpenCalendar: command((model) => model.open()),
  // Not calendar names, but only Blizzard_Calendar calls them in this corpus: the guild right, and
  // the «real» (non-battleground) group sizes its raid-invite button subtracts from MAX_RAID_MEMBERS.
  CanEditGuildEvent: test((model) => model.canEditGuildEvent()),
  GetRealNumPartyMembers: (host) => [host.partyMemberCount?.() ?? 0],
  GetRealNumRaidMembers: (host) => [host.raidMemberCount?.() ?? 0],
});
