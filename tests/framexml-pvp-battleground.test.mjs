import assert from "node:assert/strict";
import test from "node:test";

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
    "Alterac Valley", "Fight for the Stormpike clan.", 40,
  ]);
  api(seam, "RequestBattlegroundInstanceInfo", 2);
  assert.deepEqual(api(seam, "GetBattlefieldInfo"), [
    "Warsong Gulch", "Capture the enemy flag.", 5,
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
    "Alterac Valley", "Fight for the Stormpike clan.", 40,
  ]);

  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 2);
  assert.equal(api(seam, "UnitFactionGroup", "player")[0], "Horde");
  assert.deepEqual(api(seam, "GetBattlefieldInfo"), [
    "Alterac Valley", "Fight for the Frostwolf clan.", 40,
  ]);
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 0);
  assert.deepEqual(api(seam, "UnitFactionGroup", "player"), []);
  assert.deepEqual(api(seam, "GetBattlefieldInfo"), ["Alterac Valley", "", 40],
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
