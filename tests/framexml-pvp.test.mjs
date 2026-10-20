import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-pvp-battleground.test.mjs
{
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const {
  FRAMEXML_CANNED_BATTLEGROUNDS,
} = await import("../dist/code/browser/framexml/FrameXmlBattlegrounds.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } = await import(
  "../dist/code/browser/framexml/FrameXmlWorldSeam.js",
);
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { STATUS_IN_PROGRESS, STATUS_WAIT_JOIN, STATUS_WAIT_QUEUE } = await import("../dist/code/world/PvpProtocol.js");

class FakeEvents {
  #listeners = new Map();

  on(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }

  emit(name, payload = {}) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
}

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} seam binding exists`);
  return [...binding(seam, args)];
}

function liveFixture(raceId = 4) {
  const guid = 0x10n;
  const fields = new Map([
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, raceId],
    [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 80],
  ]);
  const player = { guid, typeId: 4, fields };
  const events = new FakeEvents();
  const world = {
    state: { selfGuid: guid, objects: new Map([[guid, player]]) },
    battlefieldQueues: new Map(),
    battlefieldList: undefined,
    casts: new Map(),
    cooldownSnapshots: new Map(),
    actionButtons: [],
    events,
    requests: [],
    joins: [],
    requestBattlefieldList(bgTypeId, fromWhere) {
      this.requests.push([bgTypeId, fromWhere]);
    },
    joinBattleground(...args) {
      this.joins.push(args);
    },
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    battlegroundCatalog: () => FRAMEXML_CANNED_BATTLEGROUNDS,
  });
  return { seam, world, player, events };
}

test("Canned battleground seam preserves seven-row order and selected-row requests", () => {
  const seam = new CannedWorldSeam();
  assert.equal(api(seam, "GetNumBattlegroundTypes")[0], 7);
  assert.deepEqual(api(seam, "GetBattlegroundInfo", 1), [
    "Alterac Valley", true, false, false, 1,
  ]);
  // Enumerating rows must not move the selection used by GetBattlefieldInfo.
  for (let index = 1; index <= 7; index += 1) api(seam, "GetBattlegroundInfo", index);
  assert.deepEqual(api(seam, "GetBattlefieldInfo"), [
    "Alterac Valley", "Fight for the Stormpike clan.", 40, true, false, false,
  ]);
  api(seam, "RequestBattlegroundInstanceInfo", 2);
  assert.deepEqual(api(seam, "GetBattlefieldInfo"), [
    "Warsong Gulch", "Capture the enemy flag.", 5, true, false, false,
  ]);
  api(seam, "JoinBattlefield", 0, true);
  assert.deepEqual(seam.battlegroundListRequests, [{ bgTypeId: 2, fromWhere: 1 }]);
  assert.deepEqual(seam.battlegroundJoins, [{ bgTypeId: 2, instanceId: 0, asGroup: true }]);
});

test("live battleground seam maps race faction, descriptions, status tuple and packet edges", () => {
  const { seam, world, player, events } = liveFixture(4);
  assert.equal(api(seam, "UnitFactionGroup", "player")[0], "Alliance");
  for (const raceId of [1, 3, 4, 7, 11]) {
    player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, raceId);
    assert.equal(api(seam, "UnitFactionGroup", "player")[0], "Alliance");
  }
  for (const raceId of [2, 5, 6, 8, 10]) {
    player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, raceId);
    assert.equal(api(seam, "UnitFactionGroup", "player")[0], "Horde");
  }
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 4);
  assert.deepEqual(api(seam, "UnitFactionGroup", "target"), []);
  assert.deepEqual(api(seam, "GetBattlefieldInfo"), [
    "Alterac Valley", "Fight for the Stormpike clan.", 40, true, false, false,
  ]);

  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 2);
  assert.equal(api(seam, "UnitFactionGroup", "player")[0], "Horde");
  assert.deepEqual(api(seam, "GetBattlefieldInfo"), [
    "Alterac Valley", "Fight for the Frostwolf clan.", 40, true, false, false,
  ]);
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 0);
  assert.deepEqual(api(seam, "UnitFactionGroup", "player"), []);
  assert.deepEqual(api(seam, "GetBattlefieldInfo"), ["Alterac Valley", "", 40, true, false, false],
    "an unresolved faction does not choose a side-specific description");

  api(seam, "RequestBattlegroundInstanceInfo", 2);
  api(seam, "JoinBattlefield", 0, true);
  assert.deepEqual(world.requests, [[2, 1]], "list request uses the selected type and queue source");
  assert.deepEqual(world.joins, [[0n, 2, 0, true]], "join uses stock guid/type/instance/group args");

  world.battlefieldQueues.set(0, {
    cleared: false,
    status: STATUS_WAIT_QUEUE,
    bgTypeId: 2,
    clientInstanceId: 17,
    minLevel: 10,
    maxLevel: 80,
    rated: false,
  });
  // teamSize is the packet's arena type, 0 for a battleground (BattlegroundMgr.cpp:206): a non-zero
  // one makes stock call the queue an arena skirmish and disable Leave Queue on the entry dialog.
  assert.deepEqual(api(seam, "GetBattlefieldStatus", 1), [
    "queued", "Warsong Gulch", 17, 10, 80, 0, false,
  ]);
  world.battlefieldQueues.set(0, {
    cleared: false,
    status: STATUS_IN_PROGRESS,
    bgTypeId: 2,
    clientInstanceId: 17,
    minLevel: 10,
    maxLevel: 80,
    rated: true,
  });
  assert.deepEqual(api(seam, "GetBattlefieldStatus", 1), [
    "active", "Warsong Gulch", 17, 10, 80, 0, true,
  ]);

  const fired = [];
  const pump = { now: () => 1, fire: (event, ...args) => { fired.push([event, ...args]); return 1; } };
  seam.attach(pump);
  fired.length = 0;
  events.emit("BATTLEFIELD_QUEUE_CHANGED", { queueSlot: 0 });
  events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 2 });
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.battlefieldStatus],
    [FRAMEXML_SEAM_EVENTS.battlefieldList],
  ]);
  seam.detach();
  fired.length = 0;
  events.emit("BATTLEFIELD_QUEUE_CHANGED", { queueSlot: 0 });
  assert.deepEqual(fired, [], "detach removes queue/list listeners");
});

test("live random and holiday bonus bindings preserve ordinary/list tuple semantics", () => {
  const { seam, world } = liveFixture();
  world.battlefieldList = {
    random: true,
    randomHasWin: true,
    randomWinHonor: 900,
    randomWinArena: 30,
    randomLossHonor: 100,
    hasWin: false,
    winHonor: 400,
    winArena: 10,
    lossHonor: 50,
  };
  assert.deepEqual(api(seam, "GetRandomBGHonorCurrencyBonuses"), [true, 900, 30, 100, 0]);
  assert.deepEqual(api(seam, "GetHolidayBGHonorCurrencyBonuses"), [false, 400, 10, 50, 0]);
  assert.deepEqual(api(seam, "GetBattlegroundInfo", 7), [
    "Random Battleground", true, false, true, 32,
  ]);
});

test("live queue clocks count on from each status packet; an arena answers its type and map", () => {
  let now = 1_000;
  const world = { state: { selfGuid: 0x10n, objects: new Map() }, battlefieldQueues: new Map(), events: new FakeEvents() };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    monotonic: () => now,
    battlegroundCatalog: () => FRAMEXML_CANNED_BATTLEGROUNDS,
    mapSource: {
      metadata: () => ({ maps: [{ id: 559, name: "Арена Награнда", instanceType: 4 }] }),
      location: () => undefined,
    },
  });
  const clocks = () => [
    ...api(seam, "GetBattlefieldEstimatedWaitTime", 1), ...api(seam, "GetBattlefieldTimeWaited", 1),
    ...api(seam, "GetBattlefieldInstanceExpiration"), ...api(seam, "GetBattlefieldInstanceRunTime"),
  ];
  assert.deepEqual(clocks(), [0, 0, 0, 0], "no queue: every clock is a number, 0");

  // SMSG_BATTLEFIELD_STATUS, STATUS_WAIT_QUEUE: Time1 average wait, Time2 time in queue (ms).
  const queued = {
    queueSlot: 0, cleared: false, isArena: false, arenaType: 0, bgTypeId: 2, clientInstanceId: 0,
    minLevel: 10, maxLevel: 19, rated: false, status: STATUS_WAIT_QUEUE, averageWaitTime: 90_000,
    timeInQueue: 30_000, mapId: 0, removeTime: 0, autoLeaveTime: 0, elapsedTime: 0,
  };
  world.battlefieldQueues.set(0, queued);
  assert.deepEqual(api(seam, "GetBattlefieldStatus", 1), ["queued", "Warsong Gulch", 0, 10, 19, 0, false]);
  assert.deepEqual(clocks(), [90_000, 30_000, 0, 0]);
  now += 12_500;
  assert.deepEqual(clocks(), [90_000, 42_500, 0, 0], "the wait counts on between packets");
  world.battlefieldQueues.set(0, { ...queued, timeInQueue: 60_000 });
  assert.deepEqual(clocks(), [90_000, 60_000, 0, 0], "a fresh packet re-bases it");
  assert.deepEqual([...api(seam, "GetBattlefieldEstimatedWaitTime", 2), ...api(seam, "GetBattlefieldTimeWaited", 2)],
    [0, 0], "the empty slot");

  // An arena queue is bgTypeId 6 with no map; the invitation names the arena's map (Map.dbc 559).
  const arena = { ...queued, queueSlot: 1, isArena: true, arenaType: 2, bgTypeId: 6, minLevel: 80, maxLevel: 80 };
  world.battlefieldQueues.set(1, arena);
  assert.deepEqual(api(seam, "GetBattlefieldStatus", 2), ["queued", "", 0, 80, 80, 2, false]);
  world.battlefieldQueues.set(1, { ...arena, status: STATUS_WAIT_JOIN, bgTypeId: 4, mapId: 559, removeTime: 120_000 });
  assert.deepEqual(api(seam, "GetBattlefieldStatus", 2), ["confirm", "Арена Награнда", 0, 80, 80, 2, false]);
  assert.deepEqual(api(seam, "GetBattlefieldTimeWaited", 2), [0], "an invitation is not a queue");

  // STATUS_IN_PROGRESS: Time1 is 0 while the match runs, the auto-leave countdown once it ended.
  const active = { ...queued, status: STATUS_IN_PROGRESS, mapId: 489, averageWaitTime: 0, timeInQueue: 0, elapsedTime: 300_000 };
  world.battlefieldQueues.set(0, active);
  assert.deepEqual(clocks(), [0, 0, 0, 300_000]);
  now += 1_000;
  assert.deepEqual(clocks(), [0, 0, 0, 301_000], "the run time counts on");
  world.battlefieldQueues.set(0, { ...active, autoLeaveTime: 120_000, elapsedTime: 900_000 });
  assert.deepEqual(clocks(), [0, 0, 120_000, 900_000]);
  now += 30_000;
  assert.deepEqual(clocks(), [0, 0, 90_000, 930_000], "the shutdown counts down");
  now += 200_000;
  assert.deepEqual(clocks().slice(2, 3), [0], "and stops at 0");
});
}

// ── framexml-pvp-controller.test.mjs
{
const controller = await import("../dist/code/browser/framexml/FrameXmlPvpController.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");

function owner() {
  return {
    open: false,
    shows: 0,
    hides: 0,
    isOpen() { return this.open; },
    show() { this.open = true; this.shows += 1; },
    hide() { this.open = false; this.hides += 1; },
  };
}

test("PvP controller owns the stock summary, Escape closes it, and stale cleanup is harmless", () => {
  const first = owner();
  const releaseFirst = controller.publishFrameXmlPvp(first);
  assert.equal(controller.frameXmlPvpOpen(), false);
  assert.equal(controller.toggleFrameXmlPvp(), true);
  assert.equal(first.open, true);
  assert.equal(controller.frameXmlPvpOpen(), true);
  assert.equal(controller.closeFrameXmlPvp(), true);
  assert.equal(first.open, false);

  const second = owner();
  const releaseSecond = controller.publishFrameXmlPvp(second);
  releaseFirst();
  assert.equal(controller.toggleFrameXmlPvp(), true);
  assert.equal(second.open, true);
  releaseSecond();
  releaseSecond();
  assert.equal(second.open, false);
  assert.equal(controller.frameXmlPvpOpen(), false);
});

test("without a stock gate the caller can retain its native fallback", () => {
  assert.equal(controller.toggleFrameXmlPvp(), false);
  assert.equal(controller.closeFrameXmlPvp(), false);
});

test("stock PvP keeps the H route and closes through its owner", () => {
  assert.deepEqual(bindings.DEFAULT_BINDINGS.togglePvp, ["KeyH", ""]);
  assert.equal(bindings.actionFor("KeyH"), "togglePvp");
  const current = owner();
  const release = controller.publishFrameXmlPvp(current);
  try {
    assert.equal(controller.toggleFrameXmlPvp(), true, "H's action reaches the stock owner");
    assert.equal(current.open, true);
    assert.equal(controller.closeFrameXmlPvp(), true, "Escape reaches the same owner");
    assert.equal(current.open, false);
  } finally {
    release();
  }
});
}

// ── framexml-pvp-flag-seam.test.mjs
{
// Plan item 1.09: the PvP flag C API (FrameXmlPvpFlag.ts) — GetPVPDesired, SetPVP, TogglePVP,
// IsPVPTimerRunning, GetPVPTimer — with the original client's answers (Wow.exe 0x51bca0, 0x51bd60,
// 0x51bd00/0x6de7a0, 0x5168b0, 0x516840; described in FrameXmlPvpFlag.ts).

const { FrameXmlPvpFlagModel, FRAMEXML_PVP_FLAG_BINDINGS, frameXmlSetPvpEnable, frameXmlRoundToInt } =
  await import("../dist/code/browser/framexml/FrameXmlPvpFlag.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { PLAYER_FLAGS_IN_PVP, PLAYER_FLAGS_PVP_TIMER, PLAYER_FLAGS_AFK } = await import("../dist/code/world/Fields.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} seam binding exists`);
  return [...binding(seam, args)];
}

function model(initialFlags) {
  const clock = { now: 1000, flags: initialFlags, calls: [] };
  const flag = new FrameXmlPvpFlagModel({
    flags: () => clock.flags,
    now: () => clock.now,
    togglePvp: (...args) => { clock.calls.push(args); },
  });
  return { clock, flag };
}

test("the flag bits and constants are TrinityCore's (Player.h:363, :372)", () => {
  assert.equal(PLAYER_FLAGS_IN_PVP, 0x200);
  assert.equal(PLAYER_FLAGS_PVP_TIMER, 0x40000);
});

test("GetPVPDesired is the number 1 or 0, never a boolean; 0 without a player", () => {
  const { clock, flag } = model(0);
  const host = { pvpFlag: flag };
  assert.deepEqual([...FRAMEXML_PVP_FLAG_BINDINGS.GetPVPDesired(host, [])], [0]);
  clock.flags = PLAYER_FLAGS_IN_PVP | PLAYER_FLAGS_AFK;
  assert.deepEqual([...FRAMEXML_PVP_FLAG_BINDINGS.GetPVPDesired(host, [])], [1]);
  clock.flags = undefined;
  assert.deepEqual([...FRAMEXML_PVP_FLAG_BINDINGS.GetPVPDesired(host, [])], [0]);
  assert.deepEqual([...FRAMEXML_PVP_FLAG_BINDINGS.GetPVPDesired({}, [])], [0]);
});

test("IsPVPTimerRunning answers 1 or a single nil", () => {
  const { clock, flag } = model(0);
  const host = { pvpFlag: flag };
  assert.deepEqual([...FRAMEXML_PVP_FLAG_BINDINGS.IsPVPTimerRunning(host, [])], [undefined]);
  clock.flags = PLAYER_FLAGS_PVP_TIMER;
  assert.deepEqual([...FRAMEXML_PVP_FLAG_BINDINGS.IsPVPTimerRunning(host, [])], [1]);
});

test("GetPVPTimer counts the client's own five minutes from the flag change, plus 1000", () => {
  const { clock, flag } = model(PLAYER_FLAGS_IN_PVP);
  flag.enterWorld();
  const timer = () => FRAMEXML_PVP_FLAG_BINDINGS.GetPVPTimer({ pvpFlag: flag }, [])[0];
  // Timer bit clear: the helper's 300000, plus the Lua function's 1000.
  assert.equal(timer(), 301000);
  // Switched off at t=1000: the server raises the timer bit; the deadline is now + 300000.
  clock.flags = PLAYER_FLAGS_PVP_TIMER;
  flag.flagsChanged();
  clock.now = 101_000;
  assert.equal(timer(), 200_000 + 1000);
  // Another flag moving while the timer runs keeps the deadline.
  clock.flags = PLAYER_FLAGS_PVP_TIMER | PLAYER_FLAGS_AFK;
  flag.flagsChanged();
  assert.equal(timer(), 201_000);
  // Past the deadline while the bit is still up: -1 + 1000.
  clock.now = 401_000;
  assert.equal(timer(), 999);
  // Switched on again: no deadline; the bit clear answers 301000 again.
  clock.flags = PLAYER_FLAGS_IN_PVP;
  flag.flagsChanged();
  assert.equal(timer(), 301_000);
  assert.equal(FRAMEXML_PVP_FLAG_BINDINGS.GetPVPTimer({}, [])[0], 0);
});

test("entering the world with the timer already running keeps no deadline (0x6e7f50): 999", () => {
  const { flag } = model(PLAYER_FLAGS_PVP_TIMER);
  flag.flagsChanged(); // the first look is the entry into the world
  assert.equal(flag.timer(), 999);
  const fresh = model(0);
  fresh.flag.flagsChanged();
  fresh.clock.flags = PLAYER_FLAGS_PVP_TIMER;
  fresh.flag.flagsChanged();
  fresh.clock.now += 100_000;
  assert.equal(fresh.flag.timer(), 201_000);
});

test("SetPVP sends the rounded number's byte, so nil, true and 0 all switch the flag off", () => {
  const { clock, flag } = model(0);
  const host = { pvpFlag: flag };
  for (const value of [1, "1", 2, undefined, true, false, 0, 0.4, 256, "x"]) {
    assert.deepEqual([...FRAMEXML_PVP_FLAG_BINDINGS.SetPVP(host, [value])], []);
  }
  assert.deepEqual(clock.calls, [[true], [true], [true], [false], [false], [false], [false], [false], [false], [false]]);
  assert.equal(frameXmlSetPvpEnable(1.5), true, "1.5 rounds to 2");
  assert.equal(frameXmlSetPvpEnable(0.5), false, "0.5 rounds to even 0");
  assert.equal(frameXmlRoundToInt(2.5), 2);
  assert.equal(frameXmlRoundToInt(-1.5), -2);
});

test("TogglePVP toggles: no argument reaches WorldClient.togglePvp", () => {
  const { clock, flag } = model(0);
  assert.deepEqual([...FRAMEXML_PVP_FLAG_BINDINGS.TogglePVP({ pvpFlag: flag }, ["ignored"])], []);
  assert.deepEqual(clock.calls, [[]]);
});

test("the canned and live seams bind the five names over their own player", () => {
  const canned = new CannedWorldSeam();
  assert.deepEqual(api(canned, "GetPVPDesired"), [0]);
  assert.deepEqual(api(canned, "IsPVPTimerRunning"), [undefined]);
  canned.pvpWorld.setPlayerFlags(PLAYER_FLAGS_IN_PVP);
  assert.deepEqual(api(canned, "GetPVPDesired"), [1]);
  api(canned, "SetPVP", undefined);
  api(canned, "TogglePVP");
  assert.deepEqual(canned.pvpWorld.pvpCalls, [false, undefined]);

  const self = { guid: 7n, typeId: 4, fields: new Map([[UPDATE_FIELDS.PLAYER_FLAGS.offset, PLAYER_FLAGS_IN_PVP]]) };
  const calls = [];
  const world = {
    state: { selfGuid: 7n, objects: new Map([[7n, self]]) },
    togglePvp: (...args) => { calls.push(args); },
  };
  const live = new LiveWorldSeam({ world: () => world, store: () => undefined, monotonic: () => 5 });
  assert.deepEqual(api(live, "GetPVPDesired"), [1]);
  api(live, "SetPVP", 1);
  api(live, "TogglePVP");
  assert.deepEqual(calls, [[true], [undefined]]);
  self.fields.set(UPDATE_FIELDS.PLAYER_FLAGS.offset, PLAYER_FLAGS_PVP_TIMER);
  assert.deepEqual(api(live, "IsPVPTimerRunning"), [1]);
});
}
