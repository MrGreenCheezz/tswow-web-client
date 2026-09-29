/**
 * The offline calendar (CannedWorldSeam, `framexml.html?calendar=`): the stock model over a scripted
 * server that answers every calendar opcode the way CalendarHandler.cpp/CalendarMgr.cpp do, one
 * microtask later (the real answer is a network round trip; stock never sees its own call answered
 * inside the call).
 *
 * The month is built around the day the page opens, so the grid always has something to show: a
 * raid invitation from another player waiting for an answer (the GameTime badge counts it), the
 * player's own dungeon run with two invitees, a guild event to sign up to, a guild announcement,
 * an event already past, a raid save that resets in four days, and four holidays — Brewfest and the
 * weekly fishing contest from their real Holidays.dbc words, and the Darkmoon Faire and Children's
 * Week placed around today. Names, levels and classes are the fixture's; icons are real LFGDungeons
 * rows of this dataset (measured: Наксрамас 159/227, Мертвые копи 6, Крепость Утгард 202).
 */

import {
  CALENDAR_RANK_MODERATOR, CALENDAR_RANK_OWNER, CALENDAR_SEND_ADD, CALENDAR_SEND_COPY, CALENDAR_SEND_GET,
  CALENDAR_STATUS_ACCEPTED, CALENDAR_STATUS_CONFIRMED, CALENDAR_STATUS_DECLINED, CALENDAR_STATUS_INVITED,
  CALENDAR_STATUS_NOT_SIGNED_UP, CALENDAR_STATUS_SIGNED_UP, CALENDAR_STATUS_TENTATIVE,
  packWowTime, type CalendarEventDetail, type CalendarSnapshot,
} from "../../world/CalendarProtocol.js";
import type { CalendarPacket } from "../../world/EventBus.js";
import { LocalFrameXmlCalendar } from "./FrameXmlCalendar.js";
import {
  frameXmlCalendarPackedWall, frameXmlCalendarWall, frameXmlCalendarWallTime, type FrameXmlCalendarHoliday,
} from "./FrameXmlCalendarHolidays.js";
import {
  FrameXmlCalendarModel, type FrameXmlCalendarCatalog, type FrameXmlCalendarPump, type FrameXmlCalendarServer,
} from "./FrameXmlCalendarModel.js";

interface CannedPerson {
  readonly guid: bigint;
  readonly name: string;
  readonly level: number;
  readonly className: string;
  readonly classToken: string;
  /** Guild rank id, when in the player's guild. */
  readonly guildRank?: number;
}

/** The canned player is the canned seam's (UnitGUID("player") is 0x1, «Игрок», warrior 60). */
export const FRAMEXML_CANNED_CALENDAR_SELF = 0x1n;

const PEOPLE: readonly CannedPerson[] = Object.freeze([
  { guid: FRAMEXML_CANNED_CALENDAR_SELF, name: "Игрок", level: 60, className: "Воин", classToken: "WARRIOR", guildRank: 1 },
  { guid: 0x21n, name: "Тралл", level: 80, className: "Шаман", classToken: "SHAMAN" },
  { guid: 0x22n, name: "Джайна", level: 80, className: "Маг", classToken: "MAGE", guildRank: 0 },
  { guid: 0x23n, name: "Утер", level: 80, className: "Паладин", classToken: "PALADIN", guildRank: 2 },
  { guid: 0x24n, name: "Сильвана", level: 80, className: "Охотник", classToken: "HUNTER", guildRank: 2 },
  { guid: 0x25n, name: "Андуин", level: 70, className: "Жрец", classToken: "PRIEST", guildRank: 3 },
]);

/** Holidays.dbc words of this dataset, verbatim: Brewfest (372) and the fishing contest (301). */
const BREWFEST_DATE = 0x1f833800;
const FISHING_DATE = 0x1fffc380;

function holiday(id: number, name: string, description: string, texture: string, filterType: number,
  priority: number, dates: readonly number[], durations: readonly number[], flags: readonly number[]): FrameXmlCalendarHoliday {
  const pad = (values: readonly number[], length: number): number[] =>
    [...values, ...new Array<number>(Math.max(0, length - values.length)).fill(0)];
  return {
    id, name, description, texture, region: 0, looping: 0, priority, filterType,
    dates: pad(dates, 26), durations: pad(durations, 10), flags: pad(flags, 10),
  };
}

function packed(minutes: number): number {
  return packWowTime(frameXmlCalendarWallTime(minutes));
}

/** The catalog `/dbc/calendar` would serve, for this fixture's holidays, icons and raid names. */
export function frameXmlCannedCalendarCatalog(now: number): FrameXmlCalendarCatalog {
  const day = 1440;
  // The placed holidays start at midnight, as the table's own dated rows do.
  const today = Math.floor(now / day) * day;
  return {
    holidays: [
      holiday(372, "Хмельной фестиваль", "Первыми Хмельной фестиваль стали проводить дворфы, но он завоевал популярность и у всех остальных жителей Азерота.",
        "Calendar_Brewfest", -1, 2, [BREWFEST_DATE], [168, 384], [0, 3]),
      holiday(301, "Рыбомания Тернистой долины", "Турнир рыболовов собирает лучших мастеров в Тернистой долине.",
        "Calendar_FishingExtravaganza", 0, 0, [FISHING_DATE], [2], [3]),
      holiday(374, "Ярмарка Новолуния", "В тихий Элвиннский лес приехала Ярмарка Новолуния!",
        "Calendar_DarkmoonFaireElwynn", 1, 1, [packed(today + 6 * day)], [48, 168], [0, 3]),
      holiday(201, "Детская неделя", "Покажи сиротке жизнь настоящего искателя приключений!",
        "Calendar_ChildrensWeek", -1, 2, [packed(today - 3 * day)], [168], [3]),
    ],
    textures: [
      { id: 159, name: "Наксрамас", texture: "NAXXRAMAS", expansion: 2, type: 2, faction: -1, difficulty: 0, difficultyToken: "RAID_DIFFICULTY_10PLAYER" },
      { id: 227, name: "Наксрамас", texture: "NAXXRAMAS", expansion: 2, type: 2, faction: -1, difficulty: 1, difficultyToken: "RAID_DIFFICULTY_25PLAYER" },
      { id: 239, name: "Склеп Аркавона", texture: "VAULTOFARCHAVON", expansion: 2, type: 2, faction: -1, difficulty: 0, difficultyToken: "RAID_DIFFICULTY_10PLAYER" },
      { id: 48, name: "Огненные Недра", texture: "MoltenCore", expansion: 0, type: 2, faction: -1, difficulty: 0, difficultyToken: "RAID_DIFFICULTY_40PLAYER" },
      { id: 202, name: "Крепость Утгард", texture: "UTGARDE", expansion: 2, type: 1, faction: -1, difficulty: 0, difficultyToken: "DUNGEON_DIFFICULTY_5PLAYER" },
      { id: 225, name: "Нексус", texture: "THENEXUS", expansion: 2, type: 1, faction: -1, difficulty: 0, difficultyToken: "DUNGEON_DIFFICULTY_5PLAYER" },
      { id: 6, name: "Мертвые копи", texture: "DEADMINES", expansion: 0, type: 1, faction: -1, difficulty: 0, difficultyToken: "" },
    ],
    raids: [
      { mapId: 533, name: "Наксрамас", difficulties: [
        { difficulty: 0, token: "RAID_DIFFICULTY_10PLAYER", resetSeconds: 604_800 },
        { difficulty: 1, token: "RAID_DIFFICULTY_25PLAYER", resetSeconds: 604_800 },
      ] },
      { mapId: 624, name: "Склеп Аркавона", difficulties: [
        { difficulty: 0, token: "RAID_DIFFICULTY_10PLAYER", resetSeconds: 604_800 },
      ] },
    ],
  };
}

interface CannedInvite {
  inviteId: bigint;
  guid: bigint;
  status: number;
  rank: number;
  sender: bigint;
  /** Wall minutes, 0 when never answered. */
  responded: number;
}

interface CannedEvent {
  eventId: bigint;
  title: string;
  description: string;
  type: number;
  flags: number;
  textureId: number;
  date: number;
  lockDate: number;
  owner: bigint;
  invites: CannedInvite[];
}

/** A calendar server over the fixture: TrinityCore's answers, in its packet shapes. */
export class CannedFrameXmlCalendarServer implements FrameXmlCalendarServer {
  /** Every opcode stock sent, by name and arguments, for tests and the preview report. */
  readonly calls: { readonly name: string; readonly args: readonly unknown[] }[] = [];
  readonly events = new Map<bigint, CannedEvent>();
  readonly #deliver: (packet: CalendarPacket) => void;
  readonly #now: () => number;
  #nextEvent = 100n;
  #nextInvite = 1000n;

  constructor(now: () => number, deliver: (packet: CalendarPacket) => void) {
    this.#now = now;
    this.#deliver = deliver;
    const today = frameXmlCalendarWallTime(now());
    const at = (days: number, hour: number, minute = 0): number =>
      frameXmlCalendarWall(today.year, today.month, today.day + days, hour, minute);
    const self = FRAMEXML_CANNED_CALENDAR_SELF;
    this.#add({ title: "Наксрамас 25", description: "Сбор у входа за 15 минут. Нужны два лекаря.", type: 0, flags: 0,
      textureId: 227, date: at(3, 19, 30), owner: 0x21n,
      invites: [[0x21n, CALENDAR_STATUS_CONFIRMED, CALENDAR_RANK_OWNER], [0x23n, CALENDAR_STATUS_ACCEPTED, CALENDAR_RANK_MODERATOR],
        [0x24n, CALENDAR_STATUS_TENTATIVE, 0], [self, CALENDAR_STATUS_INVITED, 0]] });
    this.#add({ title: "Мертвые копи", description: "Помогаем Андуину с заданиями.", type: 1, flags: 0, textureId: 6,
      date: at(9, 18), owner: self,
      invites: [[self, CALENDAR_STATUS_ACCEPTED, CALENDAR_RANK_OWNER], [0x25n, CALENDAR_STATUS_ACCEPTED, 0],
        [0x24n, CALENDAR_STATUS_DECLINED, 0]] });
    this.#add({ title: "Сбор гильдии", description: "Обсуждаем рейды на следующую неделю.", type: 3, flags: 0x400,
      textureId: -1, date: at(5, 20), owner: 0x22n, invites: [[0x22n, CALENDAR_STATUS_SIGNED_UP, CALENDAR_RANK_OWNER]] });
    this.#add({ title: "Новый устав", description: "Прочитайте обновлённые правила гильдии.", type: 4, flags: 0x40,
      textureId: -1, date: at(1, 12), owner: 0x22n, invites: [] });
    this.#add({ title: "Склеп Аркавона", description: "", type: 0, flags: 0, textureId: 239, date: at(-5, 21), owner: 0x23n,
      invites: [[0x23n, CALENDAR_STATUS_CONFIRMED, CALENDAR_RANK_OWNER], [self, CALENDAR_STATUS_ACCEPTED, 0]] });
  }

  #add(event: { title: string; description: string; type: number; flags: number; textureId: number; date: number;
    owner: bigint; invites: readonly (readonly [bigint, number, number])[] }): CannedEvent {
    const eventId = this.#nextEvent++;
    const row: CannedEvent = {
      eventId, title: event.title, description: event.description, type: event.type, flags: event.flags,
      textureId: event.textureId, date: event.date, lockDate: 0, owner: event.owner,
      invites: event.invites.map(([guid, status, rank]) => ({
        inviteId: this.#nextInvite++, guid, status, rank, sender: event.owner,
        responded: status === CALENDAR_STATUS_INVITED ? 0 : event.date - 2 * 1440,
      })),
    };
    this.events.set(eventId, row);
    return row;
  }

  #send(packet: CalendarPacket): void {
    queueMicrotask(() => this.#deliver(packet));
  }

  #visible(event: CannedEvent): boolean {
    // CalendarMgr::GetPlayerEvents: invited, or an event of the player's own guild.
    return event.invites.some((invite) => invite.guid === FRAMEXML_CANNED_CALENDAR_SELF) || (event.flags & 0x440) !== 0;
  }

  pending(): number {
    let count = 0;
    for (const event of this.events.values()) {
      const mine = event.invites.find((invite) => invite.guid === FRAMEXML_CANNED_CALENDAR_SELF);
      if (mine && (mine.status === CALENDAR_STATUS_INVITED || mine.status === CALENDAR_STATUS_TENTATIVE
        || mine.status === CALENDAR_STATUS_NOT_SIGNED_UP)) count += 1;
    }
    return count;
  }

  snapshot(): CalendarSnapshot {
    const events = [...this.events.values()].filter((event) => this.#visible(event));
    const now = this.#now();
    return {
      invites: events.flatMap((event) => event.invites.filter((invite) => invite.guid === FRAMEXML_CANNED_CALENDAR_SELF).map((invite) => ({
        eventId: event.eventId, inviteId: invite.inviteId, status: invite.status, moderator: invite.rank,
        inviteType: (event.flags & 0x400) !== 0 ? 1 : 0, inviterGuid: invite.sender,
      }))),
      events: events.map((event) => ({
        eventId: event.eventId, name: event.title, eventType: event.type, date: packed(event.date), flags: event.flags,
        textureId: event.textureId, ownerGuid: event.owner,
      })),
      serverNow: Math.floor(Date.now() / 1000), serverTime: packed(now),
      lockouts: [{ mapId: 533, difficulty: 1, expireSeconds: 4 * 86_400 + 3 * 3_600, instanceId: 42n }],
      raidOrigin: 1_135_753_200,
      resets: [{ mapId: 624, durationSeconds: 2 * 86_400, offset: 0 }],
      holidays: [],
    };
  }

  #detail(event: CannedEvent, sendType: number): CalendarEventDetail {
    return {
      sendType, ownerGuid: event.owner, eventId: event.eventId, name: event.title, description: event.description,
      eventType: event.type, repeatable: 0, maxInvites: 100, textureId: event.textureId, flags: event.flags,
      date: packed(event.date), lockDate: event.lockDate ? packed(event.lockDate) : 0, guildId: (event.flags & 0x440) !== 0 ? 1 : 0,
      invites: event.invites.map((invite) => {
        const person = PEOPLE.find((row) => row.guid === invite.guid);
        return {
          guid: invite.guid, level: person?.level ?? 1, status: invite.status, moderator: invite.rank,
          inviteType: (event.flags & 0x400) !== 0 && person?.guildRank !== undefined ? 1 : 0, inviteId: invite.inviteId,
          responseTime: invite.responded ? packed(invite.responded) : 0, notes: "",
        };
      }),
    };
  }

  #record(name: string, args: readonly unknown[]): void {
    this.calls.push({ name, args });
  }

  #error(result: number, name = ""): void {
    this.#send({ kind: "result", result: { command: 1, name, result } });
  }

  requestCalendar(): void {
    this.#record("requestCalendar", []);
    this.#send({ kind: "snapshot", snapshot: this.snapshot() });
    this.#send({ kind: "pending", count: this.pending() });
  }

  requestEvent(eventId: bigint): void {
    this.#record("requestEvent", [eventId]);
    const event = this.events.get(eventId);
    if (event) this.#send({ kind: "event", detail: this.#detail(event, CALENDAR_SEND_GET) });
    else this.#error(6);
  }

  addEvent(fields: Parameters<FrameXmlCalendarServer["addEvent"]>[0], invites: Parameters<FrameXmlCalendarServer["addEvent"]>[1]): void {
    this.#record("addEvent", [fields, invites]);
    const date = frameXmlCalendarPackedWall(fields.time);
    if (date === undefined || date < this.#now()) { this.#error(20); return; }
    const event = this.#add({
      title: fields.title, description: fields.description, type: fields.eventType, flags: fields.flags,
      textureId: fields.textureId, date, owner: FRAMEXML_CANNED_CALENDAR_SELF,
      invites: (fields.flags & 0x40) !== 0 ? [] : invites.map((invite) => [invite.guid, invite.status, invite.moderator] as const),
    });
    this.#send({ kind: "event", detail: this.#detail(event, CALENDAR_SEND_ADD) });
  }

  updateEvent(eventId: bigint, moderatorId: bigint, fields: Parameters<FrameXmlCalendarServer["updateEvent"]>[2]): void {
    this.#record("updateEvent", [eventId, moderatorId, fields]);
    const event = this.events.get(eventId);
    const date = frameXmlCalendarPackedWall(fields.time);
    if (!event) { this.#error(6); return; }
    if (date === undefined || date < this.#now()) return;
    const original = event.date;
    Object.assign(event, {
      title: fields.title, description: fields.description, type: fields.eventType, flags: fields.flags,
      textureId: fields.textureId, date, lockDate: frameXmlCalendarPackedWall(fields.lockDate) ?? 0,
    });
    this.#send({ kind: "updatedAlert", alert: {
      clearPending: true, eventId, originalDate: packed(original), flags: event.flags, date: packed(event.date),
      eventType: event.type, textureId: event.textureId, name: event.title, description: event.description,
      repeatable: 0, maxInvites: 100, lockDate: event.lockDate ? packed(event.lockDate) : 0,
    } });
  }

  removeEvent(eventId: bigint, moderatorId: bigint): void {
    this.#record("removeEvent", [eventId, moderatorId]);
    const event = this.events.get(eventId);
    if (!event) { this.#error(6); return; }
    this.events.delete(eventId);
    this.#send({ kind: "removedAlert", alert: { clearPending: true, eventId, date: packed(event.date) } });
  }

  copyEvent(eventId: bigint, moderatorId: bigint, packedDate: number): void {
    this.#record("copyEvent", [eventId, moderatorId, packedDate]);
    const event = this.events.get(eventId);
    const date = frameXmlCalendarPackedWall(packedDate);
    if (!event) { this.#error(6); return; }
    if (date === undefined || date < this.#now()) { this.#error(20); return; }
    const copy = this.#add({
      title: event.title, description: event.description, type: event.type, flags: event.flags, textureId: event.textureId,
      date, owner: event.owner, invites: event.invites.map((invite) => [invite.guid, invite.status, invite.rank] as const),
    });
    this.#send({ kind: "event", detail: this.#detail(copy, CALENDAR_SEND_COPY) });
  }

  #statusPacket(event: CannedEvent, invite: CannedInvite): void {
    this.#send({ kind: "status", status: {
      inviteGuid: invite.guid, eventId: event.eventId, date: packed(event.date), flags: event.flags, status: invite.status,
      clearPending: invite.guid === FRAMEXML_CANNED_CALENDAR_SELF, responseTime: invite.responded ? packed(invite.responded) : 0,
    } });
  }

  rsvp(eventId: bigint, inviteId: bigint, status: number): void {
    this.#record("rsvp", [eventId, inviteId, status]);
    const event = this.events.get(eventId);
    const invite = event?.invites.find((row) => row.inviteId === inviteId);
    if (!event) { this.#error(6); return; }
    if (!invite) { this.#error(29); return; }
    if ((event.flags & 0x10) !== 0 && status !== 9) { this.#error(21); return; }
    invite.status = status;
    invite.responded = this.#now();
    // HandleCalendarEventRsvp: the status and the cleared action, no NUM_PENDING.
    this.#statusPacket(event, invite);
    this.#send({ kind: "clearPending" });
  }

  invite(eventId: bigint, name: string, moderatorId: bigint, creating: boolean, isSignUp: boolean): void {
    this.#record("invite", [eventId, name, moderatorId, creating, isSignUp]);
    const person = PEOPLE.find((row) => row.name.toLowerCase() === name.toLowerCase());
    if (!person) { this.#error(11); return; }
    if (creating) {
      if (isSignUp && person.guildRank !== undefined) { this.#error(38); return; }
      this.#send({ kind: "inviteAdded", invite: {
        inviteeGuid: person.guid, eventId: 0n, inviteId: 0n, level: person.level, status: CALENDAR_STATUS_INVITED, type: 0,
        responseTime: undefined, clearPending: true,
      } });
      return;
    }
    const event = this.events.get(eventId);
    if (!event) { this.#error(6); return; }
    if (event.invites.some((invite) => invite.guid === person.guid)) { this.#error(10, person.name); return; }
    if ((event.flags & 0x400) !== 0 && person.guildRank !== undefined) { this.#error(38); return; }
    const invite: CannedInvite = {
      inviteId: this.#nextInvite++, guid: person.guid, status: CALENDAR_STATUS_INVITED, rank: 0, sender: FRAMEXML_CANNED_CALENDAR_SELF, responded: 0,
    };
    event.invites.push(invite);
    this.#send({ kind: "inviteAdded", invite: {
      inviteeGuid: person.guid, eventId, inviteId: invite.inviteId, level: person.level, status: invite.status,
      type: (event.flags & 0x400) !== 0 ? 1 : 0, responseTime: (event.flags & 0x400) !== 0 ? 0 : undefined, clearPending: true,
    } });
  }

  signUp(eventId: bigint, tentative: boolean): void {
    this.#record("signUp", [eventId, tentative]);
    const event = this.events.get(eventId);
    if (!event) { this.#error(6); return; }
    const invite: CannedInvite = {
      inviteId: this.#nextInvite++, guid: FRAMEXML_CANNED_CALENDAR_SELF,
      status: tentative ? CALENDAR_STATUS_TENTATIVE : CALENDAR_STATUS_SIGNED_UP, rank: 0, sender: FRAMEXML_CANNED_CALENDAR_SELF,
      responded: this.#now(),
    };
    event.invites.push(invite);
    // HandleCalendarEventSignup → CalendarMgr::AddInvite, then SendCalendarClearPendingAction; no
    // EVENT_STATUS. A guild event's relatives are the guild, so the signer gets SendCalendarEventInvite
    // (sent by its own invitee: ClearPending false); another event's relatives are its invitees so far,
    // and the signer gets the invite alert instead.
    if ((event.flags & 0x400) !== 0) {
      const person = PEOPLE.find((row) => row.guid === FRAMEXML_CANNED_CALENDAR_SELF);
      this.#send({ kind: "inviteAdded", invite: {
        inviteeGuid: FRAMEXML_CANNED_CALENDAR_SELF, eventId, inviteId: invite.inviteId, level: person?.level ?? 1,
        status: invite.status, type: 1, responseTime: packed(invite.responded), clearPending: false,
      } });
    } else {
      this.#send({ kind: "inviteAlert", alert: {
        eventId, name: event.title, date: packed(event.date), flags: event.flags, eventType: event.type, textureId: event.textureId,
        inviteId: invite.inviteId, status: invite.status, moderatorStatus: 0, ownerGuid: event.owner,
        invitedByGuid: FRAMEXML_CANNED_CALENDAR_SELF,
      } });
    }
    this.#send({ kind: "clearPending" });
  }

  removeInvite(guid: bigint, inviteId: bigint, eventId: bigint, moderatorId: bigint): void {
    this.#record("removeInvite", [guid, inviteId, eventId, moderatorId]);
    const event = this.events.get(eventId);
    if (!event) { this.#error(29); return; }
    if (event.owner === guid) { this.#error(22); return; }
    const index = event.invites.findIndex((invite) => invite.inviteId === inviteId);
    if (index < 0) return;
    event.invites.splice(index, 1);
    if ((event.flags & 0x400) === 0 && guid === FRAMEXML_CANNED_CALENDAR_SELF) {
      this.#send({ kind: "inviteRemovedAlert", alert: { eventId, date: packed(event.date), flags: event.flags, status: 9 } });
    }
    this.#send({ kind: "inviteRemoved", removed: { inviteGuid: guid, eventId, flags: event.flags, clearPending: true } });
  }

  setStatus(guid: bigint, eventId: bigint, inviteId: bigint, status: number, moderatorId: bigint): void {
    this.#record("setStatus", [guid, eventId, inviteId, status, moderatorId]);
    const event = this.events.get(eventId);
    const invite = event?.invites.find((row) => row.inviteId === inviteId);
    if (!event) { this.#error(6); return; }
    if (!invite) { this.#error(29); return; }
    invite.status = status;
    this.#statusPacket(event, invite);
  }

  setModerator(guid: bigint, eventId: bigint, inviteId: bigint, rank: number, moderatorId: bigint): void {
    this.#record("setModerator", [guid, eventId, inviteId, rank, moderatorId]);
    const event = this.events.get(eventId);
    const invite = event?.invites.find((row) => row.inviteId === inviteId);
    if (!event) { this.#error(6); return; }
    if (!invite) { this.#error(29); return; }
    invite.rank = rank;
    // The core's alert carries the invite's status in the rank's byte (see FrameXmlCalendarModel).
    this.#send({ kind: "moderator", status: { inviteGuid: guid, eventId, status: invite.status, clearPending: true } });
  }

  guildFilter(minLevel: number, maxLevel: number, maxRankOrder: number): void {
    this.#record("guildFilter", [minLevel, maxLevel, maxRankOrder]);
    const invites = PEOPLE.filter((person) => person.guildRank !== undefined && person.guid !== FRAMEXML_CANNED_CALENDAR_SELF
      && person.level >= minLevel && person.level <= maxLevel && person.guildRank <= maxRankOrder)
      .map((person) => ({ guid: person.guid, level: person.level }));
    this.#send({ kind: "candidates", source: "guild", invites });
  }

  arenaTeam(teamId: number): void {
    this.#record("arenaTeam", [teamId]);
    this.#send({ kind: "candidates", source: "arena", invites: [] });
  }

  complain(invitedByGuid: bigint, eventId: bigint, inviteId: bigint): void {
    this.#record("complain", [invitedByGuid, eventId, inviteId]);
  }
}

/**
 * The canned seam's calendar: GameTime's local clock (LocalFrameXmlCalendar) and the stock window's
 * model over {@link CannedFrameXmlCalendarServer}. `now` is the page's clock unless a test pins it.
 */
export class CannedFrameXmlCalendar extends LocalFrameXmlCalendar {
  readonly ui: FrameXmlCalendarModel;
  readonly server: CannedFrameXmlCalendarServer;
  /** Canned monotonic milliseconds; tests move it to pass the client's throttles. */
  monotonicMs = 0;

  constructor(now: () => Date = () => new Date()) {
    super(now);
    const wall = (): number => {
      const date = now();
      return frameXmlCalendarWall(date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes());
    };
    this.server = new CannedFrameXmlCalendarServer(wall, (packet) => this.ui.receive(packet));
    this.ui = new FrameXmlCalendarModel({
      server: () => this.server,
      now: wall,
      monotonic: () => this.monotonicMs,
      player: () => ({ guid: FRAMEXML_CANNED_CALENDAR_SELF, name: "Игрок", level: 60, faction: 1 }),
      nameOf: (guid) => PEOPLE.find((person) => person.guid === guid)?.name,
      classOf: (guid) => {
        const person = PEOPLE.find((row) => row.guid === guid);
        return person ? [person.className, person.classToken] : undefined;
      },
      inGuild: () => true,
      canCreateGuildEvent: () => true,
      guildRankCount: () => 4,
      maxLevel: () => 80,
      arenaTeamId: () => undefined,
    });
    this.ui.useCatalog(frameXmlCannedCalendarCatalog(wall()));
  }

  override pendingInvites(): number {
    return this.server.pending();
  }

  attach(pump: FrameXmlCalendarPump): void {
    this.ui.attach(pump);
    // The snapshot a live world holds before the window opens (the GameTime badge's query).
    this.ui.receive({ kind: "snapshot", snapshot: this.server.snapshot() });
  }

  detach(): void {
    this.ui.detach();
  }

  tick(): void {
    this.ui.tick();
  }
}
