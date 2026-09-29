import assert from "node:assert/strict";
import test from "node:test";

// The stock calendar's C API (FrameXmlCalendarModel.ts) and its holiday walk
// (FrameXmlCalendarHolidays.ts) without a VM: packets in the shapes CalendarProtocol.ts parses from
// TrinityCore, commands out through a recording server, the Wow.exe constants the header names.
const { packWowTime } = await import("../dist/code/world/CalendarProtocol.js");
const {
  frameXmlCalendarHolidayMonth, frameXmlCalendarMergeHolidays, frameXmlCalendarPackedWall, frameXmlCalendarWall,
} = await import("../dist/code/browser/framexml/FrameXmlCalendarHolidays.js");
const {
  FrameXmlCalendarModel, FRAMEXML_CALENDAR_UI_BINDINGS: B, FRAMEXML_CALENDAR_UI_EVENTS,
} = await import("../dist/code/browser/framexml/FrameXmlCalendarModel.js");
const { FRAMEXML_CALENDAR_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlCalendar.js");

const SELF = 0x10n;
const OTHER = 0x20n;
const packed = (year, month, day, hour = 0, minute = 0) => packWowTime({ year, month, day, hour, minute });
const pad = (values, length) => [...values, ...new Array(length - values.length).fill(0)];
const holiday = (id, name, dates, durations, flags, extra = {}) => ({
  id, name, description: `${name}!`, texture: `Calendar_${id}`, region: 0, looping: 0, priority: 0, filterType: -1,
  dates: pad(dates, 26), durations: pad(durations, 10), flags: pad(flags, 10), ...extra,
});

function recordingServer() {
  const calls = [];
  const server = new Proxy({}, { get: (_target, name) => (...args) => { calls.push([name, ...args]); } });
  return { server, calls };
}

/** A model on 15 September 2026 10:00, the player 0x10 (Alliance, level 80) in a guild with the event right. */
function model({ now = frameXmlCalendarWall(2026, 9, 15, 10), guild = true, right = true, catalog } = {}) {
  const { server, calls } = recordingServer();
  const fired = [];
  const clock = { now, monotonic: 0 };
  const names = new Map([[SELF, "Игрок"], [OTHER, "Тралл"], [0x30n, "Утер"]]);
  const host = {
    server: () => server, now: () => clock.now, monotonic: () => clock.monotonic,
    player: () => ({ guid: SELF, name: "Игрок", level: 80, faction: 1 }),
    nameOf: (guid) => names.get(guid), classOf: (guid) => guid === OTHER ? ["Шаман", "SHAMAN"] : undefined,
    inGuild: () => guild, canCreateGuildEvent: () => right, guildRankCount: () => 5, maxLevel: () => 80,
    arenaTeamId: (index) => index === 2 ? 777 : undefined,
  };
  const calendar = new FrameXmlCalendarModel(host);
  calendar.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  if (catalog) calendar.useCatalog(catalog);
  fired.length = 0;
  const seam = { calendar: { ui: calendar }, partyMemberCount: () => 2, raidMemberCount: () => 0 };
  const call = (name, ...args) => B[name](seam, args);
  return { calendar, calls, fired, clock, call, seam };
}

function snapshot({ events = [], invites = [], lockouts = [], resets = [], holidays = [], now = packed(2026, 9, 15, 10) } = {}) {
  return {
    kind: "snapshot",
    snapshot: { invites, events, serverNow: 1_789_000_000, serverTime: now, lockouts, raidOrigin: 1_135_753_200, resets, holidays },
  };
}

const RAID = {
  eventId: 41n, name: "Наксрамас", eventType: 0, date: packed(2026, 9, 18, 19, 30), flags: 0, textureId: 227, ownerGuid: OTHER,
};
const MY_INVITE = { eventId: 41n, inviteId: 900n, status: 0, moderator: 0, inviteType: 0, inviterGuid: OTHER };

test("dates and months are Wow.exe's: min 24.11.2004, max 31.12.2030, create a year ahead, history two weeks back", () => {
  const { call } = model();
  assert.deepEqual(call("CalendarGetMinDate"), [4, 11, 24, 2004], "a Wednesday");
  assert.deepEqual(call("CalendarGetMaxDate"), [3, 12, 31, 2030], "a Tuesday");
  assert.deepEqual(call("CalendarGetMaxCreateDate"), [5, 9, 30, 2027], "the last day of the same month next year, a Thursday");
  assert.deepEqual(call("CalendarGetMinHistoryDate"), [3, 9, 1, 2026]);
  // The viewed month starts at the realm's; offsets and absolute months, first weekday 1 = Sunday.
  assert.deepEqual(call("CalendarGetMonth"), [9, 2026, 30, 3]);
  assert.deepEqual(call("CalendarGetMonth", -1), [8, 2026, 31, 7]);
  assert.deepEqual(call("CalendarGetMonth", 4), [1, 2027, 31, 6]);
  call("CalendarSetMonth", -1);
  assert.deepEqual(call("CalendarGetMonth"), [8, 2026, 31, 7]);
  call("CalendarSetAbsMonth", 2, 2028);
  assert.deepEqual(call("CalendarGetMonth"), [2, 2028, 29, 3], "a leap February");
  call("CalendarSetAbsMonth", 1, 1999);
  assert.deepEqual(call("CalendarGetMonth").slice(0, 2), [11, 2004], "clamped to the min date's month");
  assert.deepEqual(call("CalendarGetAbsMonth", 13, 2026), [], "no thirteenth month");
  assert.deepEqual(call("CalendarEventGetTypes"), ["CALENDAR_TYPE_RAID", "CALENDAR_TYPE_DUNGEON", "CALENDAR_TYPE_PVP", "CALENDAR_TYPE_MEETING", "CALENDAR_TYPE_OTHER"],
    "the keys, until the VM's GlobalStrings resolve them");
  assert.deepEqual(call("CalendarDefaultGuildFilter"), [80, 80, 5], "max level both ends, every rank");
});

test("the snapshot fills the grid: the player's invitation, a guild event with none, lockouts and resets", () => {
  const { calendar, call, fired } = model({ catalog: { holidays: [], textures: [
    { id: 227, name: "Наксрамас", texture: "NAXXRAMAS", expansion: 2, type: 2, faction: -1, difficulty: 1, difficultyToken: "RAID_DIFFICULTY_25PLAYER" },
  ], raids: [{ mapId: 533, name: "Наксрамас", difficulties: [{ difficulty: 1, token: "RAID_DIFFICULTY_25PLAYER", resetSeconds: 604_800 }] }] } });
  calendar.useGlobalStrings((name) => ({ RAID_DIFFICULTY_25PLAYER: "25 игроков" })[name]);
  fired.length = 0;
  calendar.receive(snapshot({
    events: [RAID, { eventId: 42n, name: "Сбор", eventType: 3, date: packed(2026, 9, 20, 20), flags: 0x400, textureId: -1, ownerGuid: 0x30n }],
    invites: [MY_INVITE],
    lockouts: [{ mapId: 533, difficulty: 1, expireSeconds: 4 * 86_400 + 3 * 3_600, instanceId: 42n }],
    resets: [{ mapId: 533, durationSeconds: 86_400, offset: 0 }],
  }));
  assert.deepEqual(fired, [[FRAMEXML_CALENDAR_UI_EVENTS.eventList]]);
  assert.deepEqual(call("CalendarGetNumDayEvents", 0, 18), [1]);
  assert.deepEqual(call("CalendarGetDayEvent", 0, 18, 1), [
    "Наксрамас", 19, 30, "PLAYER", "", 1, "NAXXRAMAS", "", 1, "Тралл", 1, 1, 1, 1, "25 игроков",
  ], "title, time, calendar type, raid (1), its icon, invited (1), by Тралл, difficulty, normal invite, the MapDifficulty name");
  assert.deepEqual(call("CalendarGetFirstPendingInvite", 0, 18), [1]);
  // A guild event nobody invited the player to: «not signed up», a sign-up invite, the creator as inviter.
  assert.deepEqual(call("CalendarGetDayEvent", 0, 20, 1).slice(3, 12), ["GUILD_EVENT", "", 4, "", "", 8, "Утер", 0, 2]);
  assert.deepEqual(call("CalendarGetFirstPendingInvite", 0, 20), [0], "a guild event is no pending invitation");
  // The save resets 4 days 3 hours after the snapshot's 10:00; with resets off only the lockout shows.
  const lockout = call("CalendarGetDayEvent", 0, 19, 1);
  assert.deepEqual(lockout.slice(0, 4), ["Наксрамас", 13, 0, "RAID_LOCKOUT"]);
  assert.deepEqual(call("CalendarGetRaidInfo", 0, 19, 1), ["Наксрамас", "RAID_LOCKOUT", 42, 13, 0, 1, "25 игроков"]);
  assert.deepEqual(call("CalendarGetNumDayEvents", 0, 16), [0], "calendarShowResets is off by default");
  calendar.setFilter("calendarShowResets", true);
  assert.deepEqual(call("CalendarGetDayEvent", 0, 16, 1).slice(0, 4), ["Наксрамас", 10, 0, "RAID_RESET"], "a day after the snapshot");
  assert.deepEqual(call("CalendarGetNumDayEvents", 0, 23), [1], "and weekly after it");
  calendar.setFilter("CALENDARSHOWLOCKOUTS", false);
  assert.deepEqual(call("CalendarGetNumDayEvents", 0, 19), [0], "CVar names are case-insensitive");
  // Past rows and other months are on the grid too.
  assert.deepEqual(call("CalendarGetNumDayEvents", 1, 18), [0]);
});

test("the holiday walk: hidden stages, yearly, weekly, looping, one-day markers, regions and filters", () => {
  const rows = [
    // Brewfest's real word: any year, 13 September; 168 hidden hours then 384 shown.
    holiday(372, "Хмельной", [0x1f833800], [168, 384], [0, 3]),
    // The fishing contest's real word: any date, Sunday 14:00, two hours; filter 0 (weekly).
    holiday(301, "Рыбомания", [0x1fffc380], [2], [3], { filterType: 0 }),
    // Call to Arms: looping from 26 October 2007, 96 shown hours in every 1008; filter 2.
    holiday(283, "К оружию", [packed(2007, 10, 26)], [96, 912], [3, 0], { looping: 1, filterType: 2 }),
    // The Wrath launch marker: no duration, a one-day note.
    holiday(406, "Wrath", [packed(2026, 9, 2)], [0], [3]),
    // A US-only row (the fireworks, region 1) is not the ruRU client's.
    holiday(62, "Фейерверк", [packed(2026, 9, 4, 6)], [18], [3], { region: 1 }),
  ];
  const month = frameXmlCalendarHolidayMonth(rows, 2026, 9, { regions: [3], shown: () => true });
  const list = (day) => (month.get(day) ?? []).map((entry) => `${entry.holiday.name}:${entry.sequenceType || "-"}:${entry.sequenceIndex}/${entry.numSequenceDays}@${entry.hour}:${entry.minute}`);
  assert.deepEqual(list(19), ["Рыбомания:-:1/1@14:0"].filter(() => false), "Saturday the 19th: nothing");
  assert.deepEqual(list(20), ["Хмельной:START:1/16@0:0", "Рыбомания:-:1/1@14:0"]);
  assert.deepEqual(list(21), ["Хмельной:ONGOING:2/16@0:0"]);
  assert.deepEqual(list(2), ["Wrath:-:1/1@0:0"]);
  assert.equal(list(4).some((entry) => entry.startsWith("Фейерверк")), false, "region 1 is not shown");
  // Every Sunday.
  assert.deepEqual([6, 13, 20, 27].map((day) => list(day).some((entry) => entry.startsWith("Рыбомания"))), [true, true, true, true]);
  // The 42-day cycle from 2007: count the Call to Arms days in September 2026.
  const cycleDays = [...month.entries()].filter(([, entries]) => entries.some((entry) => entry.holiday.id === 283)).map(([day]) => day)
    .sort((left, right) => left - right);
  const first = frameXmlCalendarWall(2007, 10, 26);
  const expected = [];
  for (let day = 1; day <= 30; day += 1) {
    const start = frameXmlCalendarWall(2026, 9, day);
    const phase = ((start - first) % (1008 * 60) + 1008 * 60) % (1008 * 60);
    if (phase < 96 * 60) expected.push(day);
  }
  assert.deepEqual(cycleDays, expected);
  assert.ok(expected.length >= 3 && expected.length <= 8);
  // Filters by the holiday's filterType.
  const filtered = frameXmlCalendarHolidayMonth(rows, 2026, 9, { regions: [3], shown: (type) => type !== 0 });
  assert.equal((filtered.get(20) ?? []).some((entry) => entry.holiday.id === 301), false);
  // Brewfest runs into October and ends there: its END is on the 5th (384 hours from 20 September).
  const october = frameXmlCalendarHolidayMonth(rows, 2026, 10, { regions: [3], shown: () => true });
  assert.equal((october.get(5) ?? []).find((entry) => entry.holiday.id === 372)?.sequenceType, "END");
  assert.equal((october.get(6) ?? []).some((entry) => entry.holiday.id === 372), false);
  // The server's re-dated copy replaces the table's dates and keeps its name.
  const merged = frameXmlCalendarMergeHolidays([rows[0]], [{
    holidayId: 372, region: 0, looping: 0, priority: 5, filterType: -1, dates: pad([packed(2026, 9, 1)], 26),
    durations: pad([48], 10), flags: pad([3], 10), textureFilename: "",
  }]);
  assert.deepEqual([merged[0].name, merged[0].texture, merged[0].priority], ["Хмельной", "Calendar_372", 5]);
  const moved = frameXmlCalendarHolidayMonth(merged, 2026, 9, { regions: [], shown: () => true });
  assert.deepEqual((moved.get(1) ?? []).map((entry) => entry.sequenceType), ["START"]);
  assert.equal(moved.has(20), false);
  // Sentinel words are not dates.
  assert.equal(frameXmlCalendarPackedWall(0x1fffc380), undefined);
});

test("holidays reach the grid, lead their day, and answer CalendarGetHolidayInfo", () => {
  const { calendar, call } = model({ catalog: { holidays: [holiday(201, "Детская неделя", [packed(2026, 9, 12)], [168], [3], { priority: 2 })], textures: [], raids: [] } });
  calendar.receive(snapshot({ events: [{ ...RAID, date: packed(2026, 9, 12, 8) }] }));
  assert.deepEqual(call("CalendarGetDayEvent", 0, 12, 1).slice(0, 7), ["Детская неделя", 0, 0, "HOLIDAY", "START", 5, "Calendar_201"]);
  assert.deepEqual(call("CalendarGetDayEvent", 0, 12, 2).slice(0, 4), ["Наксрамас", 8, 0, "PLAYER"], "the holiday leads even an earlier event");
  assert.deepEqual(call("CalendarGetDayEventSequenceInfo", 0, 18, 1), [7, 7, "END"]);
  assert.deepEqual(call("CalendarGetHolidayInfo", 0, 15, 1), ["Детская неделя", "Детская неделя!", "Calendar_201"]);
  assert.deepEqual(call("CalendarGetHolidayInfo", 0, 12, 2), [], "a player event is no holiday");
  const { fired } = model();
  void fired;
});

test("opening a player event asks the server; its detail opens it; edits are the model's until sent", () => {
  const { calendar, call, calls, fired } = model();
  calendar.receive(snapshot({ events: [RAID], invites: [MY_INVITE] }));
  fired.length = 0;
  call("CalendarOpenEvent", 0, 18, 1);
  assert.deepEqual(calls.at(-1), ["requestEvent", 41n]);
  assert.deepEqual(call("CalendarGetEventIndex"), [0, 18, 1]);
  assert.deepEqual(call("CalendarGetEventInfo"), [], "nothing until the detail lands");
  calendar.receive({ kind: "event", detail: {
    sendType: 0, ownerGuid: OTHER, eventId: 41n, name: "Наксрамас", description: "Сбор в 19:15", eventType: 0, repeatable: 0,
    maxInvites: 25, textureId: 227, flags: 0x10 | 0x20, date: RAID.date, lockDate: packed(2026, 9, 18, 18), guildId: 0,
    invites: [
      { guid: OTHER, level: 80, status: 3, moderator: 2, inviteType: 0, inviteId: 899n, responseTime: packed(2026, 9, 10, 12), notes: "" },
      { guid: SELF, level: 80, status: 0, moderator: 0, inviteType: 0, inviteId: 900n, responseTime: 0, notes: "" },
    ],
  } });
  assert.deepEqual(fired.slice(0, 1), [[FRAMEXML_CALENDAR_UI_EVENTS.openEvent, "PLAYER"]]);
  const info = call("CalendarGetEventInfo");
  assert.deepEqual(info.slice(0, 13), ["Наксрамас", "Сбор в 19:15", "Тралл", 1, 1, 25, 0, 6, 9, 18, 2026, 19, 30]);
  assert.deepEqual(info.slice(13, 19), [6, 9, 18, 2026, 18, 0], "the lock date of a locking event");
  assert.deepEqual(info.slice(19), [1, 1, 1, 1, 1, "PLAYER"], "locked 0x10, auto-approve 0x20, pending, invited, normal");
  assert.equal(call("CalendarEventCanEdit")[0], undefined, "an invitee cannot edit");
  // The roster, by status: confirmed first.
  assert.deepEqual(call("CalendarEventGetInvite", 1), ["Тралл", 80, "Шаман", "SHAMAN", 4, "CREATOR", undefined]);
  assert.deepEqual(call("CalendarEventGetInvite", 2), ["Игрок", 80, "", "", 1, "", 1]);
  assert.deepEqual(call("CalendarEventGetInviteResponseTime", 1), [5, 9, 10, 2026, 12, 0]);
  assert.deepEqual(call("CalendarEventGetInviteResponseTime", 2), [0, 0, 0, 0, 0, 0], "never answered");
  call("CalendarEventSortInvites", "name", 1);
  assert.deepEqual(call("CalendarEventGetInviteSortCriterion"), ["name", 1]);
  assert.equal(call("CalendarEventGetInvite", 1)[0], "Тралл", "reversed by name: Т before И");
  assert.equal(fired.at(-1)[0], FRAMEXML_CALENDAR_UI_EVENTS.inviteList);
  // Locked: the RSVP still goes out (the server refuses it with EVENT_LOCKED).
  call("CalendarEventTentative");
  assert.deepEqual(calls.at(-1), ["rsvp", 41n, 900n, 8]);
  assert.equal(call("CalendarIsActionPending")[0], 1);
  assert.deepEqual(fired.at(-1), [FRAMEXML_CALENDAR_UI_EVENTS.actionPending, true]);
  call("CalendarEventDecline");
  assert.equal(calls.filter(([name]) => name === "rsvp").length, 1, "a second answer waits for the latch");
  calendar.receive({ kind: "result", result: { command: 1, name: "", result: 21 } });
  assert.deepEqual(fired.slice(-2), [[FRAMEXML_CALENDAR_UI_EVENTS.actionPending, false], [FRAMEXML_CALENDAR_UI_EVENTS.error, "Событие заблокировано"]],
    "without the VM's strings the error falls back to the native wording");
  calendar.useGlobalStrings((name) => ({ CALENDAR_ERROR_EVENT_LOCKED: "Событие заблокировано!", CALENDAR_ERROR_ALREADY_INVITED_TO_EVENT_S: "Игрок %s уже приглашен." })[name]);
  calendar.receive({ kind: "result", result: { command: 1, name: "Утер", result: 10 } });
  assert.deepEqual(fired.at(-1), [FRAMEXML_CALENDAR_UI_EVENTS.error, "Игрок Утер уже приглашен."]);
  // The server's status for the player's invite updates both the list row and the open roster.
  calendar.receive({ kind: "status", status: { inviteGuid: SELF, eventId: 41n, date: RAID.date, flags: 0, status: 1, clearPending: true, responseTime: packed(2026, 9, 15, 10, 5) } });
  assert.equal(call("CalendarGetDayEvent", 0, 18, 1)[8], 2, "accepted on the grid");
  assert.equal(call("CalendarEventGetInvite", 2)[4], 2, "accepted in the roster");
  assert.deepEqual(call("CalendarGetFirstPendingInvite", 0, 18), [0]);
  // The updated alert renames the row and the open event and fires CALENDAR_UPDATE_EVENT.
  calendar.receive({ kind: "updatedAlert", alert: { clearPending: false, eventId: 41n, originalDate: RAID.date, flags: 0,
    date: packed(2026, 9, 19, 20), eventType: 0, textureId: 227, name: "Накс 25", description: "Новое время", repeatable: 0, maxInvites: 25, lockDate: 0 } });
  assert.equal(fired.at(-1)[0], FRAMEXML_CALENDAR_UI_EVENTS.updateEvent);
  assert.deepEqual(call("CalendarGetNumDayEvents", 0, 18), [0]);
  assert.equal(call("CalendarGetDayEvent", 0, 19, 1)[0], "Накс 25");
  assert.equal(call("CalendarGetEventInfo")[1], "Новое время");
  // Removed while open: the row goes and CALENDAR_CLOSE_EVENT fires.
  calendar.receive({ kind: "removedAlert", alert: { clearPending: false, eventId: 41n, date: packed(2026, 9, 19, 20) } });
  assert.equal(fired.at(-1)[0], FRAMEXML_CALENDAR_UI_EVENTS.closeEvent);
  assert.deepEqual(call("CalendarGetEventInfo"), []);
  assert.deepEqual(call("CalendarGetEventIndex"), [0, 0, 0]);
});

test("a new event: the creator listed, server-checked pre-invites, mass invites, throttles and CMSG_CALENDAR_ADD_EVENT's fields", () => {
  const { calendar, call, calls, fired, clock } = model({ catalog: { holidays: [], raids: [], textures: [
    { id: 6, name: "Мертвые копи", texture: "DEADMINES", expansion: 0, type: 1, faction: -1, difficulty: 0, difficultyToken: "" },
    { id: 202, name: "Крепость Утгард", texture: "UTGARDE", expansion: 2, type: 1, faction: -1, difficulty: 0, difficultyToken: "DUNGEON_DIFFICULTY_5PLAYER" },
    { id: 12, name: "Тюрьма", texture: "STOCKADES", expansion: 0, type: 1, faction: 0, difficulty: 0, difficultyToken: "" },
    { id: 48, name: "Огненные Недра", texture: "MoltenCore", expansion: 0, type: 2, faction: -1, difficulty: 0, difficultyToken: "RAID_DIFFICULTY_40PLAYER" },
  ] } });
  call("CalendarNewEvent");
  assert.deepEqual(call("CalendarEventGetCalendarType"), ["PLAYER"]);
  assert.equal(call("CalendarEventCanEdit")[0], 1);
  assert.deepEqual(call("CalendarEventGetNumInvites"), [1]);
  assert.deepEqual(call("CalendarEventGetInvite", 1).slice(4, 7), [2, "CREATOR", 1], "the creator, accepted");
  call("CalendarEventSetTitle", "Копи");
  call("CalendarEventSetDate", 9, 20, 2026);
  call("CalendarEventSetTime", 18, 30);
  // Dungeon icons: the player's faction or both (the Horde-only Stockade is not an Alliance player's), newest expansion first.
  assert.deepEqual(call("CalendarEventGetTextures", 2), ["Крепость Утгард", "UTGARDE", 2, "", "Мертвые копи", "DEADMINES", 0, ""]);
  call("CalendarEventSetType", 2);
  call("CalendarEventSetTextureID", 2);
  call("CalendarEventSetLocked");
  call("CalendarEventSetRepeatOption", 2);
  assert.deepEqual(call("CalendarGetEventInfo").slice(3, 7), [2, 2, 100, 2], "dungeon, weekly, 100 places, the second icon");
  // A name is checked by the server first (creating = 1, event 0): only its answer lists it.
  call("CalendarEventInvite", "Утер");
  assert.deepEqual(calls.at(-1), ["invite", 0n, "Утер", 0n, true, false]);
  assert.equal(call("CalendarCanSendInvite")[0], undefined, "two seconds between invites");
  calendar.receive({ kind: "inviteAdded", invite: { inviteeGuid: 0x30n, eventId: 0n, inviteId: 0n, level: 77, status: 0, type: 0, responseTime: undefined, clearPending: true } });
  assert.equal(fired.at(-1)[0], FRAMEXML_CALENDAR_UI_EVENTS.inviteList);
  assert.deepEqual(call("CalendarEventGetNumInvites"), [2]);
  // A second echo of the same name (the core echoes an add's invites) is not listed twice.
  calendar.receive({ kind: "inviteAdded", invite: { inviteeGuid: 0x30n, eventId: 0n, inviteId: 0n, level: 77, status: 0, type: 0, responseTime: undefined, clearPending: true } });
  assert.deepEqual(call("CalendarEventGetNumInvites"), [2]);
  // The guild's filter: max rank 3 means rank order ≤ 2; candidates join the draft invited.
  call("CalendarMassInviteGuild", 70, 80, 3);
  assert.deepEqual(calls.at(-1), ["guildFilter", 70, 80, 2]);
  calendar.receive({ kind: "candidates", source: "guild", invites: [{ guid: 0x30n, level: 77 }, { guid: 0x40n, level: 80 }] });
  assert.deepEqual(call("CalendarEventGetNumInvites"), [3]);
  assert.equal(call("CalendarIsActionPending")[0], undefined, "the candidates end the latch");
  call("CalendarMassInviteArenaTeam", 2);
  assert.deepEqual(calls.at(-1), ["arenaTeam", 777]);
  calendar.receive({ kind: "candidates", source: "arena", invites: [] });
  // Moderation of a draft stays local; the creator cannot be removed.
  const indexOf = (guidName) => {
    for (let index = 1; index <= call("CalendarEventGetNumInvites")[0]; index += 1) if (call("CalendarEventGetInvite", index)[0] === guidName) return index;
    return 0;
  };
  call("CalendarEventSetModerator", indexOf("Утер"));
  assert.equal(call("CalendarEventGetInvite", indexOf("Утер"))[5], "MODERATOR");
  call("CalendarEventRemoveInvite", indexOf("Игрок"));
  assert.deepEqual(call("CalendarEventGetNumInvites"), [3], "not the creator");
  call("CalendarEventRemoveInvite", indexOf(""));
  assert.equal(calls.filter(([name]) => name === "removeInvite" || name === "setModerator").length, 0);
  clock.monotonic += 5_000;
  call("CalendarAddEvent");
  const [name, fields, invites] = calls.at(-1);
  assert.equal(name, "addEvent");
  assert.deepEqual({ ...fields }, {
    title: "Копи", description: "", eventType: 1, maxSize: 100, textureId: 6, time: packed(2026, 9, 20, 18, 30), lockDate: 0, flags: 0x10,
  });
  assert.equal(invites.length, 2);
  assert.deepEqual(invites.find((invite) => invite.guid === SELF), { guid: SELF, status: 1, moderator: 2 });
  assert.deepEqual(invites.find((invite) => invite.guid === 0x30n), { guid: 0x30n, status: 0, moderator: 1 });
  assert.equal(call("CalendarCanAddEvent")[0], undefined, "pending, and five seconds between adds");
  calendar.receive({ kind: "event", detail: {
    sendType: 1, ownerGuid: SELF, eventId: 77n, name: "Копи", description: "", eventType: 1, repeatable: 0, maxInvites: 100,
    textureId: 6, flags: 0x10, date: packed(2026, 9, 20, 18, 30), lockDate: 0, guildId: 0,
    invites: [{ guid: SELF, level: 80, status: 1, moderator: 2, inviteType: 0, inviteId: 1n, responseTime: 0, notes: "" }],
  } });
  assert.deepEqual(fired.slice(-2), [[FRAMEXML_CALENDAR_UI_EVENTS.newEvent, false], [FRAMEXML_CALENDAR_UI_EVENTS.eventList]]);
  assert.equal(call("CalendarGetDayEvent", 0, 20, 1)[7], "CREATOR");
  assert.equal(call("CalendarCanAddEvent")[0], undefined, "the add's own five seconds");
  clock.monotonic += 5_000;
  assert.equal(call("CalendarCanAddEvent")[0], 1);
  // Without a title the client refuses before sending.
  call("CalendarNewEvent");
  call("CalendarAddEvent");
  assert.equal(calls.filter(([entry]) => entry === "addEvent").length, 1);
  assert.equal(fired.at(-1)[0], FRAMEXML_CALENDAR_UI_EVENTS.error);
});

test("guild rows: announcements need the guild right, guild events their creator; sign-ups for the uninvited", () => {
  const { calendar, call, calls, fired } = model({ right: true });
  calendar.receive(snapshot({ events: [
    { eventId: 50n, name: "Устав", eventType: 4, date: packed(2026, 9, 16, 12), flags: 0x40, textureId: -1, ownerGuid: OTHER },
    { eventId: 51n, name: "Сбор", eventType: 3, date: packed(2026, 9, 20, 20), flags: 0x400, textureId: -1, ownerGuid: OTHER },
  ] }));
  assert.equal(call("CalendarContextEventCanEdit", 0, 16, 1)[0], 1, "an officer edits an announcement");
  assert.equal(call("CalendarContextEventCanEdit", 0, 20, 1)[0], undefined, "not another officer's guild event");
  call("CalendarContextSelectEvent", 0, 20, 1);
  assert.deepEqual(call("CalendarContextEventGetCalendarType"), ["GUILD_EVENT"]);
  assert.deepEqual(call("CalendarContextInviteType"), [2], "a sign-up");
  assert.deepEqual(call("CalendarContextInviteStatus"), [8], "not signed up");
  call("CalendarContextInviteTentative");
  assert.deepEqual(calls.at(-1), ["signUp", 51n, true], "tentative with no invitation is a tentative sign-up");
  // HandleCalendarEventSignup's answer (CalendarMgr::AddInvite → SendCalendarEventInvite): the new invite
  // naming the player, sent by the player (ClearPending false), then CLEAR_PENDING_ACTION; no EVENT_STATUS.
  fired.length = 0;
  const signedUp = { eventId: 51n, level: 80, type: 1, responseTime: packed(2026, 9, 15, 10), clearPending: false };
  calendar.receive({ kind: "inviteAdded", invite: { ...signedUp, inviteeGuid: SELF, inviteId: 5001n, status: 8 } });
  calendar.receive({ kind: "clearPending" });
  assert.deepEqual(call("CalendarContextInviteStatus"), [9]);
  assert.equal(call("CalendarGetDayEvent", 0, 20, 1)[8], 9, "the grid row is tentative too");
  assert.ok(fired.some(([event]) => event === FRAMEXML_CALENDAR_UI_EVENTS.eventList), "and redraws");
  // Another member's sign-up reaches the whole guild; it is not the player's.
  calendar.receive({ kind: "inviteAdded", invite: { ...signedUp, inviteeGuid: 0x30n, inviteId: 5002n, status: 6 } });
  assert.deepEqual(call("CalendarContextInviteStatus"), [9]);
  // The next answer is to that invite (CMSG_CALENDAR_EVENT_RSVP), never a second sign-up: the core
  // does not check for one and would store a duplicate invite.
  call("CalendarContextInviteAvailable");
  assert.deepEqual(calls.at(-1), ["rsvp", 51n, 5001n, 1]);
  assert.equal(calls.filter(([name]) => name === "signUp").length, 1);
  // Not in a guild: CanEditGuildEvent is nil and a guild event cannot be started.
  const loner = model({ guild: false });
  assert.equal(loner.call("CanEditGuildEvent")[0], undefined);
  loner.call("CalendarNewGuildEvent");
  assert.deepEqual(loner.call("CalendarEventGetCalendarType"), []);
  assert.equal(loner.fired.at(-1)[0], FRAMEXML_CALENDAR_UI_EVENTS.error);
  assert.equal(model({ right: true }).call("CanEditGuildEvent")[0], 1);
  assert.equal(model({ right: false }).call("CanEditGuildEvent")[0], undefined);
});

test("the owner's own event: status options, moderator commands carry the owner's invite id, copy/paste and removal", () => {
  const { calendar, call, calls, clock } = model();
  const own = { eventId: 60n, name: "Копи", eventType: 1, date: packed(2026, 9, 24, 18), flags: 0, textureId: -1, ownerGuid: SELF };
  calendar.receive(snapshot({ events: [own], invites: [{ eventId: 60n, inviteId: 600n, status: 1, moderator: 2, inviteType: 0, inviterGuid: SELF }] }));
  call("CalendarOpenEvent", 0, 24, 1);
  calendar.receive({ kind: "event", detail: {
    sendType: 0, ownerGuid: SELF, eventId: 60n, name: "Копи", description: "", eventType: 1, repeatable: 0, maxInvites: 100,
    textureId: -1, flags: 0, date: own.date, lockDate: 0, guildId: 0,
    invites: [
      { guid: SELF, level: 80, status: 1, moderator: 2, inviteType: 0, inviteId: 600n, responseTime: 0, notes: "" },
      { guid: 0x30n, level: 77, status: 1, moderator: 0, inviteType: 0, inviteId: 601n, responseTime: 0, notes: "" },
    ],
  } });
  assert.equal(call("CalendarEventCanEdit")[0], 1);
  const utherIndex = call("CalendarEventGetInvite", 1)[0] === "Утер" ? 1 : 2;
  // Wow.exe 0x5F26F0: 1..8 without SIGNED_UP/NOT_SIGNED_UP and without the current status.
  assert.deepEqual(call("CalendarEventGetStatusOptions", utherIndex).filter((_value, index) => index % 2 === 0), [3, 4, 5, 6, 9]);
  call("CalendarEventSetStatus", utherIndex, 4);
  assert.deepEqual(calls.at(-1), ["setStatus", 0x30n, 60n, 601n, 3, 600n]);
  call("CalendarEventSetModerator", utherIndex);
  assert.deepEqual(calls.at(-1), ["setModerator", 0x30n, 60n, 601n, 1, 600n]);
  assert.equal(call("CalendarEventCanModerate", utherIndex)[0], 1);
  call("CalendarEventRemoveInvite", utherIndex);
  assert.deepEqual(calls.at(-1), ["removeInvite", 0x30n, 601n, 60n, 600n]);
  calendar.receive({ kind: "inviteRemoved", removed: { inviteGuid: 0x30n, eventId: 60n, flags: 0, clearPending: true } });
  assert.deepEqual(call("CalendarEventGetNumInvites"), [1]);
  // Copy from the day's menu and paste two days later at the same time of day.
  call("CalendarContextSelectEvent", 0, 24, 1);
  call("CalendarContextEventCopy");
  assert.equal(call("CalendarContextEventClipboard")[0], 1);
  call("CalendarContextEventPaste", 0, 26);
  assert.deepEqual(calls.at(-1), ["copyEvent", 60n, 600n, packed(2026, 9, 26, 18)]);
  calendar.receive({ kind: "clearPending" });
  clock.monotonic += 10_000;
  // The creator's Remove deletes the whole event.
  call("CalendarRemoveEvent");
  assert.deepEqual(calls.at(-1), ["removeEvent", 60n, 600n]);
});

test("an invitee's Remove is its own invite; an invite alert adds a row; alarms fire 15 minutes before", () => {
  const { calendar, call, calls, fired, clock } = model();
  calendar.receive(snapshot({ events: [RAID], invites: [{ ...MY_INVITE, status: 1 }] }));
  call("CalendarOpenEvent", 0, 18, 1);
  calendar.receive({ kind: "event", detail: {
    sendType: 0, ownerGuid: OTHER, eventId: 41n, name: "Наксрамас", description: "", eventType: 0, repeatable: 0, maxInvites: 25,
    textureId: 227, flags: 0, date: RAID.date, lockDate: 0, guildId: 0,
    invites: [{ guid: SELF, level: 80, status: 1, moderator: 0, inviteType: 0, inviteId: 900n, responseTime: 0, notes: "" }],
  } });
  call("CalendarRemoveEvent");
  assert.deepEqual(calls.at(-1), ["removeInvite", SELF, 900n, 41n, 900n]);
  calendar.receive({ kind: "inviteRemovedAlert", alert: { eventId: 41n, date: RAID.date, flags: 0, status: 9 } });
  assert.deepEqual(call("CalendarGetNumDayEvents", 0, 18), [0], "a removed player loses a non-guild event");
  assert.equal(fired.at(-1)[0], FRAMEXML_CALENDAR_UI_EVENTS.closeEvent);
  // A new invitation arrives as an alert with everything the grid needs.
  calendar.receive({ kind: "inviteAlert", alert: {
    eventId: 70n, name: "Око Вечности", date: packed(2026, 9, 15, 10, 14), flags: 0, eventType: 0, textureId: -1, inviteId: 701n,
    status: 1, moderatorStatus: 0, ownerGuid: OTHER, invitedByGuid: OTHER,
  } });
  assert.deepEqual(call("CalendarGetDayEvent", 0, 15, 1).slice(0, 4), ["Око Вечности", 10, 14, "PLAYER"]);
  // One at 10:16 is outside the 15-minute lead until 10:01.
  calendar.receive({ kind: "inviteAlert", alert: {
    eventId: 72n, name: "Ульдуар", date: packed(2026, 9, 15, 10, 16), flags: 0, eventType: 0, textureId: -1, inviteId: 702n,
    status: 1, moderatorStatus: 0, ownerGuid: OTHER, invitedByGuid: OTHER,
  } });
  const alarms = () => fired.filter(([name]) => name === FRAMEXML_CALENDAR_UI_EVENTS.alarm).map((entry) => entry.slice(1));
  // 10:00 now; the event starts at 10:14, inside the 15-minute lead: one alarm, once.
  clock.monotonic += 1_000;
  calendar.tick();
  assert.deepEqual(alarms(), [["Око Вечности", 10, 14]]);
  clock.monotonic += 1_000;
  clock.now += 1;
  calendar.tick();
  assert.deepEqual(alarms(), [["Око Вечности", 10, 14], ["Ульдуар", 10, 16]], "10:01: the second one, and each only once");
  // A guild event's alert broadcast to the guild carries the creator's invite, not the viewer's.
  calendar.receive({ kind: "inviteAlert", alert: {
    eventId: 71n, name: "Сбор", date: packed(2026, 9, 21, 20), flags: 0x400, eventType: 3, textureId: -1, inviteId: 710n,
    status: 6, moderatorStatus: 2, ownerGuid: OTHER, invitedByGuid: OTHER,
  } });
  assert.deepEqual(call("CalendarGetDayEvent", 0, 21, 1).slice(7, 9), ["", 8], "not the creator; not signed up");
});

test("the GameTime badge's count: CalendarMgr::GetPlayerNumPending over the listed invitations; a replaced world forgets", () => {
  const { calendar, call } = model();
  assert.equal(calendar.pendingInviteCount(), undefined, "no snapshot yet: the server's own count stands");
  const guildEvent = { eventId: 51n, name: "Сбор", eventType: 3, date: packed(2026, 9, 20, 20), flags: 0x400, textureId: -1, ownerGuid: OTHER };
  calendar.receive(snapshot({ events: [RAID, guildEvent], invites: [MY_INVITE] }));
  assert.equal(calendar.pendingInviteCount(), 1, "a guild event the player has not signed up to is not an invitation");
  calendar.receive({ kind: "inviteAlert", alert: {
    eventId: 70n, name: "Око Вечности", date: packed(2026, 9, 22, 20), flags: 0, eventType: 0, textureId: -1, inviteId: 701n,
    status: 0, moderatorStatus: 0, ownerGuid: OTHER, invitedByGuid: OTHER,
  } });
  assert.equal(calendar.pendingInviteCount(), 2);
  // An answered invitation leaves the count; the CLEAR_PENDING_ACTION that follows every command does not.
  calendar.receive({ kind: "status", status: { inviteGuid: SELF, eventId: 41n, date: RAID.date, flags: 0, status: 1, clearPending: true, responseTime: 0 } });
  calendar.receive({ kind: "clearPending" });
  assert.equal(calendar.pendingInviteCount(), 1);
  // A tentative sign-up is one the core counts.
  calendar.receive({ kind: "inviteAdded", invite: {
    inviteeGuid: SELF, eventId: 51n, inviteId: 5001n, level: 80, status: 8, type: 1, responseTime: 0, clearPending: false,
  } });
  assert.equal(calendar.pendingInviteCount(), 2);
  calendar.forget();
  assert.equal(calendar.pendingInviteCount(), undefined);
  assert.deepEqual(call("CalendarGetNumDayEvents", 0, 22), [0], "the replaced world's rows are gone");
});

test("the latch times out; the model answers nothing without a seam; GameTime's two stay FrameXmlCalendar's", () => {
  const { calendar, call, fired, clock } = model();
  calendar.receive(snapshot({ events: [RAID], invites: [MY_INVITE] }));
  call("CalendarContextSelectEvent", 0, 18, 1);
  call("CalendarContextInviteAvailable");
  assert.equal(call("CalendarIsActionPending")[0], 1);
  clock.monotonic += 10_000;
  calendar.tick();
  assert.equal(call("CalendarIsActionPending")[0], undefined);
  assert.deepEqual(fired.at(-1), [FRAMEXML_CALENDAR_UI_EVENTS.actionPending, false]);
  const none = {};
  assert.deepEqual(B.CalendarGetMonth(none, []), []);
  assert.deepEqual(B.CalendarGetNumDayEvents(none, [0, 1]), [0]);
  assert.deepEqual(B.CalendarEventCanEdit(none, []), [undefined]);
  assert.deepEqual(B.CalendarGetEventIndex(none, []), [0, 0, 0]);
  assert.deepEqual(B.GetRealNumPartyMembers({ partyMemberCount: () => 3 }, []), [3]);
  // The seam table carries GameTime's two and every model name, the 95 Wow.exe registers but
  // CalendarNewArenaTeamEvent's absence (3.3.5a has none), plus the three helpers.
  assert.equal(typeof FRAMEXML_CALENDAR_SEAM_BINDINGS.CalendarGetDate, "function");
  assert.equal(Object.keys(FRAMEXML_CALENDAR_SEAM_BINDINGS).length, 98);
});
