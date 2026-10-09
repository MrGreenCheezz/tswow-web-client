import assert from "node:assert/strict";
import test from "node:test";

const {
  FRAMEXML_SEAM_BINDINGS,
  FRAMEXML_SEAM_EVENTS,
  FRAMEXML_SEAM_NAMES,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const {
  CannedWorldSeam,
  CANNED_REPUTATION,
} = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } =
  await import("../dist/code/browser/framexml/LiveWorldSeam.js");

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

test("reputation rows expose only stock color-table standing IDs 1 through 8", () => {
  const rows = [0, 9, 4.5, NaN, 1, 8].map((standingId, listId) => ({
    ...CANNED_REPUTATION[1], standingId, listId,
  }));
  const canned = new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined, rows);
  const live = new LiveWorldSeam({
    world: () => ({}), store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    reputation: () => rows,
  });
  for (const seam of [canned, live]) {
    assert.deepEqual(call("GetNumFactions", seam), [2]);
    assert.equal(call("GetFactionInfo", seam, 1)[2], 1);
    assert.equal(call("GetFactionInfo", seam, 2)[2], 8);
  }
});

class FakeEvents {
  #listeners = new Map();

  on(name, listener) {
    let listeners = this.#listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(name, listeners);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  emit(name, payload = {}) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
}

test("reputation bindings preserve the exact 3.3.5 tuples and local state", () => {
  for (const name of [
    "GetNumFactions", "GetFactionInfo", "GetSelectedFaction", "SetSelectedFaction",
    "GetWatchedFactionInfo", "SetWatchedFactionIndex", "ExpandFactionHeader",
    "CollapseFactionHeader", "IsFactionInactive", "SetFactionInactive",
    "SetFactionActive", "FactionToggleAtWar", "GetAccountExpansionLevel",
    "IsXPUserDisabled",
  ]) assert.equal(typeof FRAMEXML_SEAM_BINDINGS[name], "function", name);
  assert.equal(FRAMEXML_SEAM_EVENTS.reputationChanged, "UPDATE_FACTION");
  assert.ok(FRAMEXML_SEAM_NAMES.includes("GetFactionInfo"));

  const seam = new CannedWorldSeam();
  const fired = [];
  seam.attach({
    now: () => 1,
    fire: (event, ...args) => { fired.push([event, ...args]); return 1; },
  });
  assert.equal(fired.filter(([event]) => event === "UPDATE_FACTION").length, 1);
  fired.length = 0;

  assert.deepEqual(call("GetNumFactions", seam), [2]);
  assert.deepEqual(call("GetFactionInfo", seam, 1), [
    "Alliance", "Alliance factions", 4, 0, 3000, 0,
    false, false, true, false, true, false, false,
  ]);
  assert.deepEqual(call("GetFactionInfo", seam, 2), [
    "Stormwind", "Stormwind reputation", 5, 3000, 9000, 4500,
    false, true, false, false, true, false, true,
  ]);
  assert.deepEqual(call("GetFactionInfo", seam, 3), []);
  assert.deepEqual(call("GetSelectedFaction", seam), [0]);
  assert.deepEqual(call("GetWatchedFactionInfo", seam), []);
  assert.deepEqual(call("GetAccountExpansionLevel", seam), [2]);
  assert.deepEqual(call("IsXPUserDisabled", seam), [false]);

  call("SetSelectedFaction", seam, 1);
  assert.deepEqual(call("GetSelectedFaction", seam), [1]);
  assert.deepEqual(fired, [["UPDATE_FACTION"]], "selecting valid listId 0 emits one update");
  fired.length = 0;
  call("SetSelectedFaction", seam, 1);
  assert.deepEqual(fired, [], "reselecting the listId 0 header is quiet");
  call("SetWatchedFactionIndex", seam, 1);
  assert.deepEqual(call("GetWatchedFactionInfo", seam), [
    "Alliance", 4, 0, 3000, 0,
  ]);
  assert.deepEqual(fired, [["UPDATE_FACTION"]], "watching valid listId 0 emits one update");
  fired.length = 0;
  call("SetWatchedFactionIndex", seam, 1);
  assert.deepEqual(fired, [], "rewatching the listId 0 header is quiet");

  call("SetSelectedFaction", seam, 2);
  call("SetWatchedFactionIndex", seam, 2);
  call("FactionToggleAtWar", seam, 2);
  call("SetFactionInactive", seam, 2);
  assert.deepEqual(call("GetSelectedFaction", seam), [2]);
  assert.deepEqual(call("GetFactionInfo", seam, 2), [
    "Stormwind", "Stormwind reputation", 5, 3000, 9000, 4500,
    true, true, false, false, true, true, true,
  ]);
  assert.deepEqual(call("GetWatchedFactionInfo", seam), [
    "Stormwind", 5, 3000, 9000, 4500,
  ]);
  assert.deepEqual(call("IsFactionInactive", seam, 2), [true]);
  const updatesAfterMutation = fired.filter(([event]) => event === "UPDATE_FACTION").length;
  call("SetFactionInactive", seam, 2);
  call("FactionToggleAtWar", seam, 1);
  assert.equal(
    fired.filter(([event]) => event === "UPDATE_FACTION").length,
    updatesAfterMutation,
    "invalid/inert mutations do not create duplicate UPDATE_FACTION edges",
  );

  call("CollapseFactionHeader", seam, 1);
  assert.deepEqual(call("GetNumFactions", seam), [1]);
  assert.deepEqual(call("GetFactionInfo", seam, 1), [
    "Alliance", "Alliance factions", 4, 0, 3000, 0,
    false, false, true, true, true, false, false,
  ]);
  assert.deepEqual(call("GetSelectedFaction", seam), [0]);
  assert.deepEqual(call("GetWatchedFactionInfo", seam), [
    "Stormwind", 5, 3000, 9000, 4500,
  ], "watch bar remains resolved while its child row is collapsed");
  call("ExpandFactionHeader", seam, 1);
  assert.deepEqual(call("GetNumFactions", seam), [2]);
  assert.deepEqual(call("GetSelectedFaction", seam), [2]);
  assert.deepEqual(call("GetWatchedFactionInfo", seam), [
    "Stormwind", 5, 3000, 9000, 4500,
  ]);
  call("SetFactionActive", seam, 2);
  call("FactionToggleAtWar", seam, 2);
  assert.deepEqual(call("IsFactionInactive", seam, 2), [false]);
  assert.deepEqual(call("GetFactionInfo", seam, 2), [
    "Stormwind", "Stormwind reputation", 5, 3000, 9000, 4500,
    false, true, false, false, true, true, true,
  ]);
  fired.length = 0;
  seam.detach();
  call("SetSelectedFaction", seam, 1);
  call("FactionToggleAtWar", seam, 2);
  assert.deepEqual(fired, [], "detached seam cannot publish reputation events");
});

test("unresolved canned reputation metadata answers no synthetic rows", () => {
  const seam = new CannedWorldSeam([], undefined, [], [], [], []);
  assert.deepEqual(call("GetNumFactions", seam), [0]);
  assert.deepEqual(call("GetFactionInfo", seam, 1), []);
  assert.deepEqual(call("GetWatchedFactionInfo", seam), []);
});

test("live reputation edges subscribe to REPUTATION_CHANGED and deduplicate by shape", () => {
  const events = new FakeEvents();
  const selfGuid = 0x101n;
  const world = {
    state: {
      selfGuid,
      objects: new Map([[selfGuid, {
        guid: selfGuid, typeId: 4, fields: new Map(),
      }]]),
    },
    actionButtons: [], casts: new Map(), channels: new Map(),
    itemTemplates: new Map(), questTemplates: new Map(), questPoi: new Map(),
    cooldownRemaining: () => 0,
    events,
  };
  const store = { field: () => () => {}, any: () => () => {}, events };
  let rows = CANNED_REPUTATION;
  const fired = [];
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: () => undefined,
    monotonic: () => 0,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
    reputation: () => rows,
  });
  seam.attach({
    now: () => 1,
    fire: (event, ...args) => { fired.push([event, ...args]); return 1; },
  });
  assert.equal(fired.filter(([event]) => event === "UPDATE_FACTION").length, 1);
  fired.length = 0;
  events.emit("REPUTATION_CHANGED");
  assert.deepEqual(fired, [], "same server edge and same rows are quiet");

  rows = [CANNED_REPUTATION[0], { ...CANNED_REPUTATION[1], barValue: 5000 }];
  events.emit("REPUTATION_CHANGED");
  assert.deepEqual(fired, [["UPDATE_FACTION"]]);
  fired.length = 0;
  events.emit("REPUTATION_CHANGED");
  assert.deepEqual(fired, [], "repeated packet edges deduplicate by tuple shape");
  assert.deepEqual(call("GetFactionInfo", seam, 2), [
    "Stormwind", "Stormwind reputation", 5, 3000, 9000, 5000,
    false, true, false, false, true, false, true,
  ]);
  seam.detach();
  events.emit("REPUTATION_CHANGED");
  assert.deepEqual(fired, [], "detached live seam ignores later world edges");
});

test("live reputation without a resolver remains truthfully unresolved", () => {
  const events = new FakeEvents();
  const world = {
    state: { selfGuid: 1n, objects: new Map() },
    actionButtons: [], casts: new Map(), channels: new Map(), events,
    cooldownRemaining: () => 0,
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: () => undefined,
    monotonic: () => 0,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  seam.attach({ now: () => 1, fire: () => 1 });
  assert.deepEqual(call("GetNumFactions", seam), [0]);
  assert.deepEqual(call("GetFactionInfo", seam, 1), []);
  seam.detach();
});

test("live faction fixture maps server at-war/inactive flags without changing the 3.3.5 tuple", () => {
  const events = new FakeEvents();
  const selfGuid = 0x102n;
  // 5.19: the seam keeps no overrides; it asks the world, which flips its own copy and emits
  // REPUTATION_CHANGED (WorldClient.setFactionAtWar/setFactionInactive). This double does the same.
  const sent = [];
  const world = {
    state: { selfGuid, objects: new Map() },
    actionButtons: [], casts: new Map(), channels: new Map(), events,
    cooldownRemaining: () => 0,
    setFactionAtWar(listId, atWar) {
      sent.push(["war", listId, atWar]);
      rows = rows.map((row) => row.listId === listId ? { ...row, atWarWith: atWar } : row);
      events.emit("REPUTATION_CHANGED");
      return undefined;
    },
    setFactionInactive(listId, inactive) {
      sent.push(["inactive", listId, inactive]);
      rows = rows.map((row) => row.listId === listId ? { ...row, isInactive: inactive } : row);
      events.emit("REPUTATION_CHANGED");
    },
  };
  const store = { field: () => () => {}, any: () => () => {}, events };
  let rows = [
    {
      ...CANNED_REPUTATION[1],
      listId: 7,
      atWarWith: true,
      isInactive: true,
      canToggleAtWar: true,
    },
    {
      ...CANNED_REPUTATION[1],
      listId: 8,
      name: "Darnassus",
      atWarWith: false,
      isInactive: false,
      canToggleAtWar: true,
    },
  ];
  const fired = [];
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: () => undefined,
    monotonic: () => 0,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
    reputation: () => rows,
  });
  seam.attach({ now: () => 1, fire: (...args) => { fired.push(args); return 1; } });
  assert.deepEqual(call("GetFactionInfo", seam, 1), [
    "Stormwind", "Stormwind reputation", 5, 3000, 9000, 4500,
    true, true, false, false, true, false, true,
  ], "initial AT_WAR is exposed in the exact tuple");
  assert.deepEqual(call("IsFactionInactive", seam, 1), [true]);
  assert.deepEqual(call("GetFactionInfo", seam, 2), [
    "Darnassus", "Stormwind reputation", 5, 3000, 9000, 4500,
    false, true, false, false, true, false, true,
  ], "initially clear AT_WAR remains clear");
  assert.deepEqual(call("IsFactionInactive", seam, 2), [false]);

  call("FactionToggleAtWar", seam, 1);
  call("SetFactionActive", seam, 1);
  call("FactionToggleAtWar", seam, 2);
  call("SetFactionInactive", seam, 2);
  assert.deepEqual(call("GetFactionInfo", seam, 1).slice(6, 8), [false, true],
    "toggle can clear an initially set AT_WAR flag");
  assert.deepEqual(call("IsFactionInactive", seam, 1), [false],
    "SetFactionActive can clear an initially set INACTIVE flag");
  assert.deepEqual(call("GetFactionInfo", seam, 2).slice(6, 8), [true, true],
    "toggle can set an initially clear AT_WAR flag");
  assert.deepEqual(call("IsFactionInactive", seam, 2), [true],
    "SetFactionInactive can set an initially clear INACTIVE flag");

  const updateCount = fired.filter(([event]) => event === "UPDATE_FACTION").length;
  call("SetFactionActive", seam, 1);
  call("SetFactionInactive", seam, 2);
  assert.equal(
    fired.filter(([event]) => event === "UPDATE_FACTION").length,
    updateCount,
    "repeating operations at the current effective state is idempotent",
  );

  // Wow.exe 0x005d1c10 sends whatever the current state; the edge still deduplicates by shape.
  assert.deepEqual(sent.filter(([kind]) => kind === "inactive"), [
    ["inactive", 7, false], ["inactive", 8, true], ["inactive", 7, false], ["inactive", 8, true],
  ]);
  assert.deepEqual(sent.filter(([kind]) => kind === "war"), [["war", 7, false], ["war", 8, true]]);
  // The world is the only state: a later server snapshot is what the seam shows.
  rows = rows.map((row) => ({ ...row, atWarWith: row.listId === 7, isInactive: row.listId === 7 }));
  events.emit("REPUTATION_CHANGED");
  assert.deepEqual(call("GetFactionInfo", seam, 1).slice(6, 8), [true, true]);
  assert.deepEqual(call("GetFactionInfo", seam, 2).slice(6, 8), [false, true]);
  assert.deepEqual(call("IsFactionInactive", seam, 1), [true]);
  assert.deepEqual(call("IsFactionInactive", seam, 2), [false]);
  seam.detach();
  const afterDetach = fired.length;
  events.emit("REPUTATION_CHANGED");
  assert.equal(fired.length, afterDetach, "detached seam ignores world edges");
});
