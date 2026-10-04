// Plan item 3.14 (L3): WORLD_STATE_UI_TIMER_UPDATE as Wow.exe 3.3.5a fires it. 0x5487d0 lists the
// WorldStateUI rows of the current map (or -1), zone/area (or 0) and phase (or 0) whose Type is 0, 1
// or 3 — whatever their state; 0x5488f0 (each frame) fires event 0x28b once a second while that list
// holds a Type-3 row (the %Nk countdowns: Wintergrasp rows 208 and 212 in this dataset), and
// UPDATE_WORLD_STATES (0x1d0) only comes with the world-state packets (0x526530 cases 0x2c2/0x2c3).
import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlWorldStates } = await import("../dist/code/browser/framexml/FrameXmlWorldStates.js");

function row(overrides) {
  return {
    id: 1, mapId: 571, areaId: 4197, phaseMask: 0, icon: "", text: "", tooltip: "", stateVariable: 3710,
    type: 3, dynamicIcon: "", dynamicTooltip: "", extendedUi: "", extendedVariables: [0, 0, 0], ...overrides,
  };
}

function fixture(catalog) {
  const states = new Map([[3710, 0], [3781, 1_090]]);
  const snapshot = { mapId: 571, zoneId: 4197, areaId: 4197, phaseMask: 1, states, serverTime: 1_000 };
  const clock = { seconds: 100 };
  const events = [];
  const resolver = new FrameXmlWorldStates(() => catalog, () => snapshot);
  const pump = { fire(event) { events.push(event); return 1; }, now: () => clock.seconds };
  const count = (name) => events.filter((event) => event === name).length;
  return { states, snapshot, clock, events, resolver, pump, count };
}

const TIMER = "WORLD_STATE_UI_TIMER_UPDATE";
const UPDATE = "UPDATE_WORLD_STATES";

test("once a second while a Type-3 row of this map, zone and phase is listed, whatever its state", () => {
  const { clock, resolver, pump, count, snapshot } = fixture([row({ text: "Время: %3781k" })]);
  resolver.attach(pump);
  assert.equal(count(TIMER), 1, "the first frame fires (the client's next-tick starts at 0)");
  clock.seconds += 0.5;
  resolver.tick();
  assert.equal(count(TIMER), 1, "not within the second");
  clock.seconds += 0.5;
  resolver.tick();
  assert.equal(count(TIMER), 2);
  clock.seconds += 1.2;
  resolver.tick();
  assert.equal(count(TIMER), 3);
  snapshot.zoneId = 1519;
  snapshot.areaId = 1519;
  clock.seconds += 2;
  resolver.tick();
  assert.equal(count(TIMER), 3, "another zone lists no timer row");
  snapshot.zoneId = 4197;
  snapshot.mapId = 0;
  clock.seconds += 2;
  resolver.tick();
  assert.equal(count(TIMER), 3, "another map neither");
  snapshot.mapId = 571;
  snapshot.zoneId = 1519;
  snapshot.areaId = 4197;
  clock.seconds += 2;
  resolver.tick();
  assert.equal(count(TIMER), 4, "the sub-area matches as the zone does");
  resolver.detach();
  clock.seconds += 2;
  resolver.tick();
  assert.equal(count(TIMER), 4, "detached: nothing");
  resolver.attach(pump);
  assert.equal(count(TIMER), 5, "a new attach starts its clock again: at once, not a second later");
  clock.seconds += 0.3;
  resolver.detach();
  resolver.attach(pump);
  assert.equal(count(TIMER), 6, "even within the second of the previous attach's last event");
});

test("phase, any map (-1) and any area (0); rows of Type 0, 1 and 2 never tick", () => {
  const phased = fixture([row({ phaseMask: 2 })]);
  phased.resolver.attach(phased.pump);
  assert.equal(phased.count(TIMER), 0, "a phase-specific row outside its phase is not listed");
  phased.snapshot.phaseMask = 3;
  phased.clock.seconds += 1;
  phased.resolver.tick();
  assert.equal(phased.count(TIMER), 1);

  const anywhere = fixture([row({ mapId: -1, areaId: 0 })]);
  anywhere.snapshot.mapId = 1;
  anywhere.snapshot.zoneId = 14;
  anywhere.resolver.attach(anywhere.pump);
  assert.equal(anywhere.count(TIMER), 1);

  const others = fixture([row({ type: 0, text: "%3781k" }), row({ type: 1 }), row({ type: 2 })]);
  others.resolver.attach(others.pump);
  others.clock.seconds += 5;
  others.resolver.tick();
  assert.equal(others.count(TIMER), 0);
});

test("a countdown's passing second is the timer event's, not UPDATE_WORLD_STATES; a state change still is", () => {
  const { states, snapshot, clock, resolver, pump, count } = fixture([row({ text: "Время: %3781k", tooltip: "Осталось %3781k" })]);
  states.set(3710, 1);
  resolver.attach(pump);
  assert.equal(count(UPDATE), 1, "the first look describes the world");
  const before = resolver.rows()[0][2];
  assert.match(before, /^Время: \d+:30$/);
  snapshot.serverTime = 1_001;
  clock.seconds += 1;
  resolver.tick();
  assert.notEqual(resolver.rows()[0][2], before, "the text the timer event re-reads has moved");
  assert.equal(count(UPDATE), 1, "no UPDATE_WORLD_STATES for a second passing");
  assert.equal(count(TIMER), 2);
  states.set(3710, 0);
  resolver.tick();
  assert.equal(count(UPDATE), 2, "the row's own state changed");
  states.set(3710, 2);
  resolver.tick();
  assert.equal(count(UPDATE), 3);
  states.set(3710, 3);
  resolver.tick();
  assert.equal(count(UPDATE), 4, "a listed row's state value is still compared");
});

test("a Type-0 row keeps its old behaviour: its countdown text is part of the state the poll compares", () => {
  const { snapshot, resolver, pump, count } = fixture([row({ type: 0, text: "Осталось %3781k" })]);
  snapshot.states.set(3710, 1);
  resolver.attach(pump);
  snapshot.serverTime = 1_002;
  resolver.tick();
  assert.equal(count(UPDATE), 2);
  assert.equal(count(TIMER), 0);
});

test("a pump without a clock (test doubles) still gets UPDATE_WORLD_STATES and no timer", () => {
  const { resolver, count } = fixture([row({})]);
  const events = [];
  resolver.attach({ fire(event) { events.push(event); return 1; } });
  resolver.tick();
  assert.deepEqual(events, [UPDATE]);
  assert.equal(count(TIMER), 0);
});
