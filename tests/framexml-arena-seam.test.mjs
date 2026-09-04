import assert from "node:assert/strict";
import test from "node:test";

const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } = await import(
  "../dist/code/browser/framexml/FrameXmlWorldSeam.js",
);

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} seam binding exists`);
  return [...binding(seam, args)];
}

function arenaList(guid = 0x1234n, fromWhere = 0, bgTypeId = 6) {
  return {
    battlemasterGuid: guid,
    fromWhere,
    bgTypeId,
    hasWin: false,
    winHonor: 0,
    winArena: 0,
    lossHonor: 0,
    random: false,
    randomHasWin: false,
    randomWinHonor: 0,
    randomWinArena: 0,
    randomLossHonor: 0,
    instances: [],
  };
}

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

function liveWorld(list = undefined, guid = 0x10n) {
  return {
    state: { selfGuid: guid, objects: new Map() },
    battlefieldQueues: new Map(),
    battlefieldList: list,
    worldStates: new Map([[3191, 7]]),
    group: undefined,
    casts: new Map(),
    cooldownSnapshots: new Map(),
    actionButtons: [],
    events: new FakeEvents(),
    channels: new Map(),
    joins: [],
    joinArena(...args) { this.joins.push(args); },
    onGroupChanged: undefined,
  };
}

function pumpFor(seam, events) {
  seam.attach({
    now: () => 1,
    fire(event, ...args) {
      events.push([event, ...args]);
      return 1;
    },
  });
  events.length = 0;
}

test("Canned Arena context transitions are authoritative and deduplicated", () => {
  const seam = new CannedWorldSeam();
  const events = [];
  let closeContextWasArena = false;
  seam.attach({
    now: () => 1,
    fire(event, ...args) {
      events.push([event, ...args]);
      if (event === FRAMEXML_SEAM_EVENTS.arenaClose) closeContextWasArena = seam.isBattlefieldArena();
      return 1;
    },
  });
  events.length = 0;

  const fresh = arenaList();
  seam.setBattlefieldList(fresh);
  seam.setBattlefieldList({ ...fresh, battlemasterGuid: 0x1235n });
  assert.equal(seam.isBattlefieldArena(), true);
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaShow).length, 1,
    "none -> arena emits one stock SHOW");
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaClose).length, 0,
    "arena refresh does not emit CLOSE");

  seam.setBattlefieldList({ ...fresh, fromWhere: 1 });
  assert.equal(closeContextWasArena, true, "CLOSE is delivered while old arena context is valid");
  assert.equal(seam.isBattlefieldArena(), false, "queue-originated list is not an arena context");
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaClose).length, 1,
    "arena -> queue emits exactly one CLOSE");
  seam.setBattlefieldList({ ...fresh, battlemasterGuid: 0n });
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaShow).length, 1,
    "non-arena lists never resurrect the owner");
  seam.setBattlefieldList({ ...fresh, bgTypeId: 5 });
  assert.equal(seam.isBattlefieldArena(), false, "a non-arena bgTypeId stays neutral");

  seam.setArenaSeason(7);
  seam.setPartyLeader(true);
  seam.setBattlefieldList(fresh);
  assert.equal(api(seam, "IsBattlefieldArena")[0], true);
  assert.equal(api(seam, "GetCurrentArenaSeason")[0], 7);
  assert.equal(api(seam, "CanJoinBattlefieldAsGroup")[0], true,
    "stock C API reports queue capability; Lua applies leader gating separately");
  api(seam, "JoinBattlefield", 1, true, true);
  api(seam, "JoinBattlefield", 2, true);
  api(seam, "JoinBattlefield", 3);
  assert.deepEqual(seam.arenaJoins.map((join) => ({
    guid: join.battlemasterGuid.toString(), slot: join.arenaSlot, group: join.asGroup, rated: join.rated,
  })), [
    { guid: "4660", slot: 0, group: true, rated: true },
    { guid: "4660", slot: 1, group: true, rated: false },
    { guid: "4660", slot: 2, group: false, rated: false },
  ]);
  seam.setPartyLeader(false);
  api(seam, "JoinBattlefield", 1, true, true);
  assert.equal(seam.arenaJoins.length, 3, "rated/group join rejects a non-leader");
  seam.setArenaSeason(0);
  seam.setPartyLeader(true);
  api(seam, "JoinBattlefield", 1, true, true);
  assert.equal(seam.arenaJoins.length, 3, "rated join rejects NO_ARENA_SEASON");
  // The existing PVPBattlegroundFrame has a distinct zero-selection shape. It
  // must keep joining battlegrounds even if an arena list is still current;
  // only a stale 1-based arena-shaped call is rejected.
  api(seam, "RequestBattlegroundInstanceInfo", 7);
  api(seam, "JoinBattlefield", 0, true);
  assert.deepEqual(seam.battlegroundJoins.at(-1), {
    bgTypeId: 32, instanceId: 0, asGroup: true,
  });
  seam.setBattlefieldList({ ...fresh, fromWhere: 1 });
  const staleArenaJoinCount = seam.arenaJoins.length;
  api(seam, "JoinBattlefield", 1, false, false);
  assert.equal(seam.arenaJoins.length, staleArenaJoinCount,
    "a stale 1-based arena call stays neutral");
});

test("Live Arena context preserves packet identity, world identity and close/reattach freshness", () => {
  let world = liveWorld();
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    battlegroundCatalog: () => [],
  });
  const events = [];
  pumpFor(seam, events);
  const first = arenaList(0x55n);
  world.battlefieldList = first;
  world.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 6 });
  assert.equal(seam.isBattlefieldArena(), true);
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaShow).length, 1);

  world.battlefieldList = { ...first, battlemasterGuid: 0x56n };
  world.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 6 });
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaShow).length, 1,
    "fresh arena refresh does not re-show an already published owner");

  let closeContextWasArena = false;
  const closeCountBeforeQueue = events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaClose).length;
  world.battlefieldList = { ...first, fromWhere: 1 };
  // The seam must dispatch CLOSE synchronously against the old list before it
  // installs the queue response, exactly as the stock outer gate requires.
  seam.detach();
  seam.attach({
    now: () => 1,
    fire(event, ...args) {
      events.push([event, ...args]);
      if (event === FRAMEXML_SEAM_EVENTS.arenaClose) closeContextWasArena = seam.isBattlefieldArena();
      return 1;
    },
  });
  // Reattach does not adopt the list that existed before the packet callback;
  // this branch intentionally proves the queue response cannot close/show a
  // stale owner. The currently published arena was reset by detach above.
  world.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 6 });
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaClose).length, closeCountBeforeQueue,
    "queue response after reattach has no stale CLOSE");
  assert.equal(closeContextWasArena, false);

  // Re-establish a published arena and exercise the real arena -> queue edge.
  const publishedAgain = arenaList(0x57n);
  world.battlefieldList = publishedAgain;
  world.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 6 });
  assert.equal(seam.isBattlefieldArena(), true);
  world.battlefieldList = { ...publishedAgain, fromWhere: 1 };
  world.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 6 });
  assert.equal(closeContextWasArena, true, "live CLOSE sees old arena context");
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaClose).length, closeCountBeforeQueue + 1,
    "live arena -> queue emits one CLOSE");
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaShow).length, 2,
    "queue response never emits SHOW");

  // The event list above remains useful for counts; use a fresh pump to inspect synchronous CLOSE.
  closeContextWasArena = false;
  seam.detach();
  const closeEvents = [];
  seam.attach({
    now: () => 1,
    fire(event, ...args) {
      closeEvents.push([event, ...args]);
      if (event === FRAMEXML_SEAM_EVENTS.arenaClose) closeContextWasArena = seam.isBattlefieldArena();
      return 1;
    },
  });
  // Reattach intentionally does not adopt a stale pre-existing list. A new packet edge is required.
  assert.equal(seam.isBattlefieldArena(), false, "reattach does not publish a stale GUID/list");
  world.battlefieldList = { ...first, fromWhere: 1 };
  world.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 6 });
  assert.equal(closeEvents.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaClose).length, 0,
    "stale/queue list does not emit CLOSE without a currently published arena");
  assert.equal(closeContextWasArena, false);

  world = liveWorld(first, 0x22n);
  seam.detach();
  seam.attach({ now: () => 1, fire: (event, ...args) => {
    closeEvents.push([event, ...args]);
    return 1;
  } });
  assert.equal(seam.isBattlefieldArena(), false, "new world identity does not inherit stale publication");
  world.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 6 });
  assert.equal(seam.isBattlefieldArena(), true, "new world's fresh list is accepted");
  assert.equal(closeEvents.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaShow).length, 1);

  world.group = {
    groupType: 0,
    members: [{ name: "mate", guid: 0x33n, online: true, status: 0, subGroup: 0, flags: 0, roles: 0 }],
    leaderGuid: 0x22n,
  };
  api(seam, "JoinBattlefield", 1, true, true);
  assert.deepEqual(world.joins, [[first.battlemasterGuid, 0, true, true]],
    "live rated group join delegates exact guid/slot/group/rated tuple");
  world.group.leaderGuid = 0x33n;
  api(seam, "JoinBattlefield", 1, true, true);
  assert.deepEqual(world.joins, [[first.battlemasterGuid, 0, true, true]],
    "live non-leader rated join is rejected");
  world.group = {
    groupType: 1,
    members: [{ name: "raid-mate", guid: 0x44n, online: true, status: 0, subGroup: 0, flags: 0, roles: 0 }],
    leaderGuid: 0x22n,
  };
  api(seam, "JoinBattlefield", 1, true, true);
  assert.equal(world.joins.length, 2, "a real raid leader may group-join rated arena");
  world.group.leaderGuid = 0x44n;
  api(seam, "JoinBattlefield", 1, true, true);
  assert.equal(world.joins.length, 2, "a non-leader raid member is rejected");
  const joinsBeforeQueue = [...world.joins];
  world.battlefieldList = { ...first, fromWhere: 1 };
  world.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 6 });
  api(seam, "JoinBattlefield", 1, false, false);
  assert.deepEqual(world.joins, joinsBeforeQueue,
    "queue-originated context cannot delegate an arena join");
  seam.detach();
});
