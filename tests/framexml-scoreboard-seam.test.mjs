// Plan items 3.14a and 1.06: the scoreboard C API and LeaveBattlefield (FrameXmlScoreboard.ts) over
// MSG_PVP_LOG_DATA, with the original client's answers (Wow.exe 0x54d280, 0x54aa30, 0x54a740,
// 0x54be90, 0x54a180, 0x549f20/0x54c170/0x549f60, 0x54c120, 0x54de00, 0x54ce30, 0x54c250).
import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlBattlefieldScoreModel, FRAMEXML_SCOREBOARD_BINDINGS, FRAMEXML_SCORE_REQUEST_INTERVAL_MS } =
  await import("../dist/code/browser/framexml/FrameXmlScoreboard.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { STATUS_IN_PROGRESS } = await import("../dist/code/world/PvpProtocol.js");

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} seam binding exists`);
  return [...binding(seam, args)];
}

class Events {
  #listeners = new Map();
  on(name, listener) {
    const set = this.#listeners.get(name) ?? new Set();
    set.add(listener);
    this.#listeners.set(name, set);
    return () => set.delete(listener);
  }
  emit(name, payload = {}) { for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload); }
}

function score(guid, overrides = {}) {
  return {
    guid, killingBlows: 0, honorableKills: 0, deaths: 0, bonusHonor: 0, teamId: 2,
    damageDone: 0, healingDone: 0, objectives: [], ...overrides,
  };
}

const WSG_COLUMNS = [
  { mapId: 30, type: 2, text: "Кладбища", icon: "", tooltip: "" },
  { mapId: 489, type: 0, text: "не столбец", icon: "", tooltip: "" },
  { mapId: 489, type: 2, text: "Захваты флага", icon: "Interface\\WorldStateFrame\\ColumnIcon-FlagCapture", tooltip: "Флаги" },
  { mapId: 489, type: 2, text: "Возвраты флага", icon: "Interface\\WorldStateFrame\\ColumnIcon-FlagReturn", tooltip: "Возвраты" },
  { mapId: 0, type: 0, text: "разрыв", icon: "", tooltip: "" },
  { mapId: 489, type: 2, text: "после разрыва", icon: "", tooltip: "" },
];

function fixture({ arena = false, mapId = 489 } = {}) {
  const names = new Map();
  const world = {
    events: new Events(),
    pvpScores: undefined,
    battlefieldQueues: new Map([[0, { status: STATUS_IN_PROGRESS, isArena: arena, mapId }]]),
    names: {
      get: (guid) => names.get(guid)?.name,
      details: (guid) => names.get(guid)?.details,
    },
    asked: [],
    requests: 0,
    left: 0,
    requestName(guid) { this.asked.push(guid); },
    requestPvpScores() { this.requests++; },
    leaveBattleground() { this.left++; },
  };
  const clock = { now: 10_000 };
  const board = new FrameXmlBattlefieldScoreModel({ world: () => world, now: () => clock.now, worldStateUi: () => WSG_COLUMNS });
  const events = [];
  board.attach({ fire(event, ...args) { events.push([event, ...args]); return 1; } });
  const name = (guid, text, race, classId) => names.set(guid, { name: text, details: { race, classId, gender: 0 } });
  const deliver = (log) => { world.pvpScores = log; world.events.emit("PVP_SCOREBOARD_CHANGED", { ended: log?.ended ?? false }); };
  const call = (binding, ...args) => [...FRAMEXML_SCOREBOARD_BINDINGS[binding]({ scoreboard: board }, args)];
  return { world, clock, board, events, name, deliver, call };
}

function battleground(scores, ended = false) {
  return { arena: false, teams: [], ended, winner: ended ? 1 : 2, scores };
}

test("GetBattlefieldScore answers twelve values in stock order; race, class and token from the name cache", () => {
  const { name, deliver, call, events } = fixture();
  name(1n, "Орк", 2, 1);
  name(2n, "Человек", 1, 5);
  deliver(battleground([
    score(1n, { killingBlows: 3, honorableKills: 10, deaths: 2, bonusHonor: 40, damageDone: 900, healingDone: 5, objectives: [2, 1] }),
    score(2n, { killingBlows: 7, honorableKills: 4, deaths: 1, bonusHonor: 12, damageDone: 100, healingDone: 3000, objectives: [0, 3] }),
  ]));
  assert.equal(events.filter(([event]) => event === "UPDATE_BATTLEFIELD_SCORE").length, 1);
  assert.deepEqual(call("GetNumBattlefieldScores"), [2]);
  // Default sort: killing blows, large first.
  const first = call("GetBattlefieldScore", 1);
  assert.equal(first.length, 12);
  assert.deepEqual(first, ["Человек", 7, 4, 1, 12, 1, 0, "Человек", "Жрец", "PRIEST", 100, 3000]);
  const second = call("GetBattlefieldScore", 2);
  assert.deepEqual(second.slice(0, 7), ["Орк", 3, 10, 2, 40, 0, 0], "the Horde race's side is 0");
  assert.equal(second[9], "WARRIOR");
  assert.deepEqual(call("GetBattlefieldScore", 3), [undefined, 0, 0, 0, 0, 0, 0, undefined, undefined, undefined, 0, 0]);
  assert.deepEqual(call("GetBattlefieldScore", 0), [undefined, 0, 0, 0, 0, 0, 0, undefined, undefined, undefined, 0, 0]);
});

test("the list waits for every name: no event, packet order; the names complete it on tick", () => {
  const { world, board, name, deliver, call, events } = fixture();
  name(1n, "Первый", 1, 1);
  deliver(battleground([score(1n, { killingBlows: 1 }), score(2n, { killingBlows: 9 })]));
  assert.deepEqual(world.asked, [2n], "the missing name is asked for");
  assert.equal(events.length, 0, "no UPDATE_BATTLEFIELD_SCORE while a name is outstanding");
  assert.equal(call("GetBattlefieldScore", 2)[0], undefined, "a row without a name answers nil");
  board.tick();
  assert.equal(events.length, 0);
  assert.deepEqual(world.asked, [2n], "frames do not ask again");
  name(2n, "Второй", 2, 1);
  board.tick();
  assert.equal(events.length, 1);
  assert.deepEqual(call("GetNumBattlefieldScores"), [2]);
  assert.equal(call("GetBattlefieldScore", 1)[0], "Второй", "sorted by killing blows once complete");
});

test("a name the server answered as unknown stops the wait without asking again", () => {
  const { world, board, name, deliver, call, events } = fixture();
  const pending = new Set([2n]);
  world.names.isPending = (guid) => pending.has(guid);
  name(1n, "Первый", 1, 1);
  deliver(battleground([score(1n, { killingBlows: 1 }), score(2n, { killingBlows: 9 })]));
  board.tick();
  assert.equal(events.length, 0, "still out");
  pending.delete(2n);
  board.tick();
  board.tick();
  assert.equal(events.length, 1, "answered (unknown): the list is built once");
  assert.deepEqual(world.asked, [2n], "and never asked again");
  assert.equal(call("GetBattlefieldScore", 1)[0], "Первый", "a row without a name compares equal and keeps its place");
  assert.equal(call("GetBattlefieldScore", 2)[0], undefined);
});

test("SetBattlefieldScoreFaction filters by race side, puts that side first, ignores other numbers", () => {
  const { name, deliver, call, events } = fixture();
  name(1n, "Альянс", 1, 1);
  name(2n, "Орда", 2, 1);
  name(3n, "Нежить", 5, 1);
  deliver(battleground([score(1n, { killingBlows: 9 }), score(2n, { killingBlows: 1 }), score(3n, { killingBlows: 5 })]));
  assert.deepEqual(call("SetBattlefieldScoreFaction", 0), []);
  assert.deepEqual(call("GetNumBattlefieldScores"), [2]);
  assert.deepEqual([call("GetBattlefieldScore", 1)[0], call("GetBattlefieldScore", 2)[0]], ["Нежить", "Орда"]);
  call("SetBattlefieldScoreFaction", 1);
  assert.deepEqual(call("GetNumBattlefieldScores"), [1]);
  assert.equal(call("GetBattlefieldScore", 1)[0], "Альянс");
  const before = events.length;
  call("SetBattlefieldScoreFaction", 5);
  assert.equal(events.length, before, "a side other than 0/1/nil is ignored without a rebuild");
  assert.deepEqual(call("GetNumBattlefieldScores"), [1]);
  call("SetBattlefieldScoreFaction");
  assert.deepEqual(call("GetNumBattlefieldScores"), [3]);
  assert.equal(events.length, before + 1);
});

test("SortBattlefieldScoreData moves a key to the front and flips it on a second click", () => {
  const { name, deliver, call } = fixture();
  name(1n, "Бэ", 1, 1);
  name(2n, "Аа", 1, 1);
  name(3n, "Вв", 1, 1);
  deliver(battleground([
    score(1n, { killingBlows: 5, damageDone: 10, objectives: [1] }),
    score(2n, { killingBlows: 1, damageDone: 30, objectives: [3] }),
    score(3n, { killingBlows: 3, damageDone: 20, objectives: [2] }),
  ]));
  const order = () => [1, 2, 3].map((index) => call("GetBattlefieldScore", index)[0]);
  assert.deepEqual(order(), ["Бэ", "Вв", "Аа"]);
  call("SortBattlefieldScoreData", "name");
  assert.deepEqual(order(), ["Аа", "Бэ", "Вв"], "names small first");
  call("SortBattlefieldScoreData", "NAME");
  assert.deepEqual(order(), ["Вв", "Бэ", "Аа"], "the same key again flips it; words ignore case");
  call("SortBattlefieldScoreData", "damage");
  assert.deepEqual(order(), ["Аа", "Вв", "Бэ"]);
  call("SortBattlefieldScoreData", "stat1");
  assert.deepEqual(order(), ["Аа", "Вв", "Бэ"], "objective 1, large first");
  call("SortBattlefieldScoreData", "nonsense");
  assert.deepEqual(order(), ["Бэ", "Вв", "Аа"], "an unknown word is «kills»");
});

test("stat columns are the running map's WorldStateUI type-2 run, in table order; data is always a number", () => {
  const { name, deliver, call } = fixture();
  name(1n, "Один", 1, 1);
  deliver(battleground([score(1n, { objectives: [4, 2] })]));
  assert.deepEqual(call("GetNumBattlefieldStats"), [2], "the run ends at the first row that is not a column");
  assert.deepEqual(call("GetBattlefieldStatInfo", 1), ["Захваты флага", "Interface\\WorldStateFrame\\ColumnIcon-FlagCapture", "Флаги"]);
  assert.deepEqual(call("GetBattlefieldStatInfo", 3), [undefined, undefined, undefined]);
  assert.deepEqual(call("GetBattlefieldStatData", 1, 1), [4]);
  assert.deepEqual(call("GetBattlefieldStatData", 1, 2), [2]);
  assert.deepEqual(call("GetBattlefieldStatData", 1, 5), [0]);
  assert.deepEqual(call("GetBattlefieldStatData", 9, 1), [0]);
  assert.equal(typeof call("GetBattlefieldStatData", 9, 99)[0], "number");
});

test("GetBattlefieldTeamInfo: the arena teams' three words as sent, nil and zeros past 0/1", () => {
  const { name, deliver, call } = fixture({ arena: true, mapId: 559 });
  name(1n, "Зелёный", 2, 1);
  name(2n, "Золотой", 1, 1);
  deliver({
    arena: true,
    teams: [
      { ratingLost: 12, ratingWon: 0, matchmakerRating: 1500, name: "Зелёные" },
      { ratingLost: 0, ratingWon: 12, matchmakerRating: 1510, name: "Золотые" },
    ],
    ended: true, winner: 1,
    scores: [score(1n, { teamId: 0, killingBlows: 1 }), score(2n, { teamId: 1, killingBlows: 2 })],
  });
  assert.deepEqual(call("GetBattlefieldTeamInfo", 0), ["Зелёные", 12, 0, 1500]);
  const [teamName, teamRating, newTeamRating, teamSkill] = call("GetBattlefieldTeamInfo", 1);
  assert.deepEqual([teamName, newTeamRating - teamRating, teamSkill], ["Золотые", 12, 1510]);
  assert.deepEqual(call("GetBattlefieldTeamInfo", 2), [undefined, 0, 0, 0]);
  assert.deepEqual(call("GetBattlefieldTeamInfo"), [undefined, 0, 0, 0]);
  assert.equal(call("GetBattlefieldScore", 1)[5], 1, "an arena row's side is the packet's team byte");
  assert.equal(call("GetBattlefieldScore", 2)[5], 0);
});

test("RequestBattlefieldScoreData: first at once, then once per 5000 ms, none after the end or in an arena", () => {
  const { world, clock, deliver, call, name } = fixture();
  for (let frame = 0; frame < 60; frame++) {
    call("RequestBattlefieldScoreData");
    clock.now += 16;
  }
  assert.equal(world.requests, 1, "a second of OnUpdate calls sends one request");
  clock.now = 10_000 + FRAMEXML_SCORE_REQUEST_INTERVAL_MS - 1;
  call("RequestBattlefieldScoreData");
  assert.equal(world.requests, 1);
  clock.now = 10_000 + FRAMEXML_SCORE_REQUEST_INTERVAL_MS;
  call("RequestBattlefieldScoreData");
  assert.equal(world.requests, 2);
  name(1n, "Один", 1, 1);
  deliver(battleground([score(1n)], true));
  clock.now += 60_000;
  call("RequestBattlefieldScoreData");
  assert.equal(world.requests, 2, "the ended match is not asked again");
  deliver(undefined);
  call("RequestBattlefieldScoreData");
  assert.equal(world.requests, 3, "leaving the match forgets the gate");

  const inArena = fixture({ arena: true, mapId: 559 });
  inArena.call("RequestBattlefieldScoreData");
  inArena.clock.now += 60_000;
  inArena.call("RequestBattlefieldScoreData");
  assert.equal(inArena.world.requests, 1, "in an arena only the first request goes");
  // Left before the end (no final scoreboard): the next match starts with a fresh gate.
  inArena.world.battlefieldQueues.clear();
  inArena.world.events.emit("BATTLEFIELD_QUEUE_CHANGED", { queueSlot: 0, status: 0, cleared: true });
  inArena.world.battlefieldQueues.set(0, { status: STATUS_IN_PROGRESS, isArena: true, mapId: 562 });
  inArena.world.events.emit("BATTLEFIELD_QUEUE_CHANGED", { queueSlot: 0, status: STATUS_IN_PROGRESS, cleared: false });
  inArena.call("RequestBattlefieldScoreData");
  assert.equal(inArena.world.requests, 2, "the next arena's first request goes at once");
});

test("a status of the running match resets the side filter and rebuilds (0x54ae40)", () => {
  const { world, name, deliver, call, events } = fixture();
  name(1n, "А", 1, 1);
  name(2n, "О", 2, 1);
  deliver(battleground([score(1n), score(2n)]));
  call("SetBattlefieldScoreFaction", 1);
  assert.deepEqual(call("GetNumBattlefieldScores"), [1]);
  const before = events.length;
  world.events.emit("BATTLEFIELD_QUEUE_CHANGED", { queueSlot: 0, status: STATUS_IN_PROGRESS, cleared: false });
  assert.deepEqual(call("GetNumBattlefieldScores"), [2]);
  assert.equal(events.length, before + 1);
});

test("LeaveBattlefield calls WorldClient.leaveBattleground once and ignores its arguments", () => {
  const { world, call } = fixture();
  assert.deepEqual(call("LeaveBattlefield"), []);
  assert.deepEqual(call("LeaveBattlefield", { frame: true }, "LeftButton"), []);
  assert.equal(world.left, 2);
  assert.equal(world.requests, 0, "leaving is not a scoreboard request");
});

test("the seams bind every name; live wires the world, canned records", () => {
  for (const name of [
    "GetNumBattlefieldScores", "GetBattlefieldScore", "SetBattlefieldScoreFaction", "SortBattlefieldScoreData",
    "GetBattlefieldTeamInfo", "GetNumBattlefieldStats", "GetBattlefieldStatInfo", "GetBattlefieldStatData",
    "RequestBattlefieldScoreData", "LeaveBattlefield",
  ]) assert.equal(typeof FRAMEXML_SEAM_BINDINGS[name], "function", name);
  const canned = new CannedWorldSeam();
  assert.deepEqual(api(canned, "GetNumBattlefieldScores"), [0]);
  api(canned, "LeaveBattlefield");
  assert.equal(canned.pvpWorld.leftBattlefield, 1);

  let left = 0;
  const world = {
    state: { selfGuid: 7n, objects: new Map() },
    battlefieldQueues: new Map(),
    leaveBattleground: () => { left++; },
    requestPvpScores: () => {},
  };
  const live = new LiveWorldSeam({ world: () => world, store: () => undefined, monotonic: () => 5 });
  api(live, "LeaveBattlefield", {}, "LeftButton");
  assert.equal(left, 1);
  assert.deepEqual(api(live, "GetNumBattlefieldStats"), [0]);
});

test("the name cache keeps race, gender and class beside the name, and says what is still asked", async () => {
  const { NameCache } = await import("../dist/code/world/NameQueryProtocol.js");
  const cache = new NameCache();
  assert.equal(cache.shouldQuery(5n), true);
  assert.equal(cache.isPending(5n), true);
  cache.accept({ guid: 5n, known: true, name: "Тралл", realm: "", race: 2, gender: 0, classId: 7, declined: [] });
  assert.equal(cache.isPending(5n), false);
  assert.deepEqual(cache.details(5n), { race: 2, gender: 0, classId: 7 });
  cache.shouldQuery(6n);
  cache.accept({ guid: 6n, known: false, name: "", realm: "", race: 0, gender: 0, classId: 0, declined: [] });
  assert.equal(cache.isPending(6n), false, "an unknown answer is an answer");
  assert.equal(cache.details(6n), undefined);
  cache.clear();
  assert.equal(cache.details(5n), undefined);
});
