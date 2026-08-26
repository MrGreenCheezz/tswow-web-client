import assert from "node:assert/strict";
import test from "node:test";
import {
  contactStatusText, friendRows, ignoreRows, whoRequestFromForm, whoSummary,
} from "../dist/code/browser/ui/ContactsModel.js";
import {
  arenaTeamRows, bracketName, memberLine, sortRoster, statsLine,
} from "../dist/code/browser/ui/ArenaModel.js";
import {
  arenaTeamHeader, objectiveCount, objectiveHeaders, scoreColumns, scoreGroups, teamName, winnerText,
} from "../dist/code/browser/ui/ScoreboardModel.js";
import {
  eventLine, formatWowDate, inviteStatusText, lockoutLines, monthGrid, serverMonth, stepMonth,
} from "../dist/code/browser/ui/CalendarModel.js";
import {
  activeRolls, remainingSeconds, rollOptions, voteLine,
} from "../dist/code/browser/ui/LootRollModel.js";
import {
  ROLL_FLAG_GREED, ROLL_FLAG_NEED, ROLL_FLAG_PASS, ROLL_NEED, ROLL_PASS,
} from "../dist/code/world/LootRollProtocol.js";
import { SOCIAL_FLAG_FRIEND, SOCIAL_FLAG_IGNORED } from "../dist/code/world/ContactProtocol.js";
import { PVP_TEAM_ALLIANCE, PVP_TEAM_HORDE } from "../dist/code/world/PvpProtocol.js";
import { packWowTime } from "../dist/code/world/GuildProtocol.js";

// --- contacts ---------------------------------------------------------------------------------

function contact(guid, flags, extra = {}) {
  return { guid, flags, note: "", status: 1, areaId: 0, level: 80, classId: 1, ...extra };
}

test("the same player can be a friend and ignored at once", () => {
  // `Contact.flags` is a mask, so splitting the list by position rather than by bit loses one of
  // the two rows.
  const list = { flags: 3, contacts: [contact(1n, SOCIAL_FLAG_FRIEND | SOCIAL_FLAG_IGNORED)] };
  assert.equal(friendRows(list).length, 1);
  assert.equal(ignoreRows(list).length, 1);
});

test("friends sort online first", () => {
  const list = {
    flags: 1,
    contacts: [contact(1n, SOCIAL_FLAG_FRIEND, { status: 0 }), contact(2n, SOCIAL_FLAG_FRIEND, { status: 1 })],
  };
  assert.deepEqual(friendRows(list).map((row) => row.guid), [2n, 1n]);
  assert.equal(contactStatusText(0), "не в сети");
  assert.equal(contactStatusText(2), "отошёл");
});

test("a who query refuses eleven zones before it can throw", () => {
  // `buildWhoQuery` throws past ten zones and four words, which in a click handler is an
  // uncaught exception rather than a message.
  const many = whoRequestFromForm({ zones: Array.from({ length: 11 }, (_, index) => index) });
  assert.equal(many.request, undefined);
  assert.ok(many.error);
  const words = whoRequestFromForm({ words: ["а", "б", "в", "г", "д"] });
  assert.ok(words.error);
  const backwards = whoRequestFromForm({ levelMin: 60, levelMax: 20 });
  assert.ok(backwards.error);
  const fine = whoRequestFromForm({ name: "Анна", levelMin: 70, levelMax: 80 });
  assert.equal(fine.error, undefined);
  assert.equal(fine.request.name, "Анна");
});

test("the who summary says when the row cap hid something", () => {
  assert.equal(whoSummary(undefined), "Поиск ещё не выполнялся");
  assert.equal(whoSummary({ displayed: 0, matched: 0, entries: [] }), "Никого не найдено");
  assert.equal(whoSummary({ displayed: 12, matched: 40, entries: [] }), "Показано 12 из 40");
});

// --- scoreboard -------------------------------------------------------------------------------

function score(extra = {}) {
  return {
    guid: 1n, killingBlows: 3, honorableKills: 5, deaths: 2, bonusHonor: 40, teamId: PVP_TEAM_HORDE,
    damageDone: 1000, healingDone: 0, objectives: [], ...extra,
  };
}

test("an arena scoreboard has no honour columns and a battleground has no team column", () => {
  // The two row shapes differ by eleven bytes and only the packet's first byte says which.
  const arena = scoreColumns({ arena: true }).map((column) => column.id);
  const battleground = scoreColumns({ arena: false }).map((column) => column.id);
  assert.ok(!arena.includes("bonusHonor"));
  assert.ok(!arena.includes("deaths"));
  assert.ok(battleground.includes("bonusHonor"));
  assert.ok(battleground.includes("deaths"));
});

test("the horde comes first, because on the wire it is team zero", () => {
  assert.equal(teamName(PVP_TEAM_HORDE), "Орда");
  assert.equal(teamName(PVP_TEAM_ALLIANCE), "Альянс");
  const log = {
    arena: true,
    teams: [
      { ratingLost: 0, ratingWon: 12, matchmakerRating: 1500, name: "Клинки" },
      { ratingLost: 12, ratingWon: 0, matchmakerRating: 1490, name: "Щиты" },
    ],
    ended: true, winner: PVP_TEAM_HORDE,
    scores: [score({ teamId: PVP_TEAM_ALLIANCE }), score({ guid: 2n, teamId: PVP_TEAM_HORDE })],
  };
  const groups = scoreGroups(log, () => "Игрок");
  assert.ok(groups[0].title.startsWith("Клинки"), "index zero is the horde team");
  assert.ok(arenaTeamHeader(log, PVP_TEAM_HORDE).includes("+12"));
  assert.ok(arenaTeamHeader(log, PVP_TEAM_ALLIANCE).includes("−12"));
});

test("a match that has not ended names no winner", () => {
  // There is no winner byte at all until `ended`; reading one eats the row count.
  assert.equal(winnerText({ arena: false, teams: [], ended: false, winner: 2, scores: [] }), "Матч ещё идёт");
  assert.equal(winnerText({ arena: false, teams: [], ended: true, winner: PVP_TEAM_HORDE, scores: [] }), "Победа: Орда");
});

test("objectives are numbered, because nothing here knows what they count", () => {
  const log = { arena: false, teams: [], ended: false, winner: 2, scores: [score({ objectives: [1, 2, 3] })] };
  assert.equal(objectiveCount(log), 3);
  assert.deepEqual(objectiveHeaders(3), ["Цель 1", "Цель 2", "Цель 3"]);
});

// --- arena ------------------------------------------------------------------------------------

function arenaMember(name, extra = {}) {
  return {
    guid: 1n, online: true, name, captain: false, level: 80, classId: 1,
    weekGames: 0, weekWins: 0, seasonGames: 0, seasonWins: 0, personalRating: 1500, ...extra,
  };
}

test("the captain sorts first and an offline member has no level to print", () => {
  const roster = {
    teamId: 7, type: 2,
    members: [arenaMember("Борис", { personalRating: 1600 }), arenaMember("Анна", { captain: true, level: 0, online: false })],
  };
  const rows = sortRoster(roster);
  assert.equal(rows[0].name, "Анна", "captain first, whatever the rating");
  // Level zero means offline, not level nought.
  assert.ok(memberLine(rows[0]).includes("не в сети"));
  assert.ok(!memberLine(rows[0]).includes("ур. 0"));
  assert.ok(memberLine(rows[1]).includes("ур. 80"));
});

test("all three brackets are listed, including the ones with no team", () => {
  const rows = arenaTeamRows(
    new Map([[7, { teamId: 7, name: "Клинки", type: 3, backgroundColor: 0, emblemStyle: 0, emblemColor: 0, borderStyle: 0, borderColor: 0 }]]),
    new Map(), new Map());
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((row) => row.info).length, 1);
  assert.equal(bracketName(3), "3 на 3");
  assert.equal(statsLine(undefined), "рейтинг ещё не пришёл");
});

// --- calendar ---------------------------------------------------------------------------------

test("a calendar date is a packed word, and the server's own clock is not", () => {
  const packed = packWowTime({ year: 2026, month: 8, day: 21, hour: 19, minute: 30 });
  assert.equal(formatWowDate(packed), "21.08.2026 19:30");
  // `serverNow` beside it is a raw unix second; only `serverTime` is packed.
  const month = serverMonth({ events: [], invites: [], serverNow: 1_755_000_000, serverTime: packed, lockouts: [], raidOrigin: 0, resets: [], holidays: [] });
  assert.deepEqual(month, { year: 2026, month: 8 });
});

test("a month grid starts on Monday and pads to whole weeks", () => {
  const packed = packWowTime({ year: 2026, month: 8, day: 21, hour: 19, minute: 30 });
  const grid = monthGrid([{ eventId: 1n, name: "Рейд", eventType: 0, date: packed, flags: 0, textureId: 0, ownerGuid: 1n }], 2026, 8);
  assert.equal(grid.length % 7, 0, "whole weeks, so the blanks are cells rather than an offset");
  const day = grid.find((cell) => cell.day === 21);
  assert.equal(day.events.length, 1);
  assert.equal(eventLine(day.events[0]), "19:30 Рейд");
  assert.equal(grid.filter((cell) => cell.day === 0 && cell.events.length > 0).length, 0);
});

test("stepping past December rolls the year", () => {
  assert.deepEqual(stepMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(stepMonth(2026, 1, -1), { year: 2025, month: 12 });
});

test("an expired raid save says so rather than counting down past zero", () => {
  // The standalone lockout packets do not clamp, unlike the snapshot's own copy.
  const lines = lockoutLines(
    [{ mapId: 409, difficulty: 0, timeRemaining: -50, instanceId: 1n },
      { mapId: 249, difficulty: 1, timeRemaining: 90_000, instanceId: 2n }],
    (mapId) => `Карта ${mapId}`);
  assert.ok(lines[0].endsWith("истекло"));
  assert.ok(lines[1].includes("1 д"));
  assert.equal(inviteStatusText(1), "придёт");
});

// --- loot rolls -------------------------------------------------------------------------------

function roll(extra = {}) {
  return {
    start: {
      itemGuid: 5n, mapId: 0, itemSlot: 1, itemId: 4306, randomSuffix: 0, randomPropertyId: 0,
      count: 1, countdown: 60_000, voteMask: ROLL_FLAG_PASS | ROLL_FLAG_NEED | ROLL_FLAG_GREED,
    },
    startedAt: 1_000, votes: [], ...extra,
  };
}

test("a roll shows only the buttons its mask allows", () => {
  const options = rollOptions(ROLL_FLAG_PASS | ROLL_FLAG_NEED).map((option) => option.rollType);
  assert.deepEqual(options, [ROLL_NEED, ROLL_PASS]);
  assert.ok(!options.includes(2), "greed was not offered, so it is not a button");
});

test("a won, passed or expired roll leaves the dialog stack", () => {
  // Nothing removes them from `lootRolls`, and no packet says the window closed.
  const rolls = new Map([
    [1, roll()],
    [2, roll({ start: { ...roll().start, itemSlot: 2 }, won: { itemSlot: 2 } })],
    [3, roll({ start: { ...roll().start, itemSlot: 3 }, passed: true })],
    [4, roll({ start: { ...roll().start, itemSlot: 4 }, startedAt: 0 })],
  ]);
  // At 60.5 seconds the first roll has half a second left and the one that started at zero
  // has run out; the other two ended by being won and by everyone passing.
  const live = activeRolls(rolls, 60_500).map((entry) => entry.itemSlot);
  assert.deepEqual(live, [1], "one still running; the other three are done or timed out");
  assert.equal(remainingSeconds(activeRolls(rolls, 60_500)[0].remainingMs), 1);
});

test("a roll with no number is a need, not a pass", () => {
  // The core announces need as type 0 with number 0, and pass as type 0 with number 128.
  const need = voteLine({ itemGuid: 0n, itemSlot: 1, playerGuid: 1n, itemId: 4306, randomSuffix: 0, randomPropertyId: 0, rollNumber: 0, rollType: 0, autoPass: false }, "Анна");
  assert.ok(need.includes("нужно"));
  const passed = voteLine({ itemGuid: 0n, itemSlot: 1, playerGuid: 1n, itemId: 4306, randomSuffix: 0, randomPropertyId: 0, rollNumber: 128, rollType: 0, autoPass: false }, "Анна");
  assert.ok(passed.includes("пропуск"));
});

test("a window opened where another already sits steps clear of it", async () => {
  const { CASCADE_STEP, cascadePlacement } = await import("../dist/code/browser/GameWindows.js");
  const size = { width: 430, height: 300 };
  const viewport = { width: 1600, height: 900 };
  // `.game-window` gives every window `top: 92px` and no `left`, and only six have a rule of their
  // own — so the talents window, the quest log, the calendar and five more all opened in one spot,
  // each hiding the last.
  const first = cascadePlacement({ left: 8, top: 92 }, [], size, viewport);
  assert.deepEqual(first, { left: 8, top: 92 });
  const second = cascadePlacement({ left: 8, top: 92 }, [first], size, viewport);
  assert.deepEqual(second, { left: 8 + CASCADE_STEP, top: 92 + CASCADE_STEP });
  const third = cascadePlacement({ left: 8, top: 92 }, [first, second], size, viewport);
  assert.deepEqual(third, { left: 8 + CASCADE_STEP * 2, top: 92 + CASCADE_STEP * 2 });

  // A window whose own rule puts it somewhere else is not moved at all.
  assert.deepEqual(cascadePlacement({ left: 466, top: 92 }, [first, second, third], size, viewport),
    { left: 466, top: 92 });
});

test("the cascade gives up rather than walking off the bottom of the screen", async () => {
  const { cascadePlacement } = await import("../dist/code/browser/GameWindows.js");
  const size = { width: 430, height: 300 };
  const viewport = { width: 900, height: 500 };
  // Eight windows already open in a short viewport: the ninth takes the original place and
  // overlaps, because a window half off the bottom edge is worse than a window on top of another.
  const taken = [];
  for (let index = 0; index < 8; index++) taken.push({ left: 8 + index * 28, top: 92 + index * 28 });
  const placed = cascadePlacement({ left: 8, top: 92 }, taken, size, viewport);
  assert.ok(placed.top + size.height <= viewport.height, `${placed.top} would hang off the bottom`);
  assert.deepEqual(placed, { left: 8, top: 92 });
});
