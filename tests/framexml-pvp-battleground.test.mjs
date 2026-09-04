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
const { STATUS_IN_PROGRESS, STATUS_WAIT_QUEUE } = await import("../dist/code/world/PvpProtocol.js");

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
  assert.deepEqual(api(seam, "GetBattlefieldStatus", 1), [
    "queued", "Warsong Gulch", 17, 10, 80, 5, false,
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
    "active", "Warsong Gulch", 17, 10, 80, 5, true,
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
