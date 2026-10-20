import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 4 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-world-events-seam.test.mjs
{
// Plan item 3.22 (b–d): PET_ATTACK_START/STOP (Wow.exe 0x73c330 → 0x5d30a0), CHARACTER_POINTS_CHANGED
// (0x5e8330), COMBAT_RATING_UPDATE (0x6cddf0), PARTY_LOOT_METHOD_CHANGED (0x6d8870 → 0x52bd90) and
// UNIT_PET_EXPERIENCE, each from the field or packet the client fires it from.

const {
  FrameXmlWorldEvents, UNIT_FLAG_PET_IN_COMBAT,
} = await import("../dist/code/browser/framexml/FrameXmlWorldEvents.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const offset = (name) => UPDATE_FIELDS[name].offset;

/** A store double: named field subscriptions, the per-flush `any`, and the UNIT_FLAGS event. */
class FakeStore {
  fields = new Map();
  anys = new Set();
  flags = new Set();
  subscriptions = 0;
  #add(key, listener) {
    const set = this.fields.get(key) ?? new Set();
    set.add(listener);
    this.fields.set(key, set);
    this.subscriptions += 1;
    return () => { set.delete(listener); this.subscriptions -= 1; };
  }
  field(subject, name, listener) { return this.#add(offset(name), listener); }
  fieldRange(subject, name, listener) {
    const offs = [];
    for (let i = 0; i < (UPDATE_FIELDS[name].size ?? 1); i += 1) offs.push(this.#add(offset(name) + i, listener));
    return () => offs.forEach((off) => off());
  }
  any(listener) { this.anys.add(listener); this.subscriptions += 1; return () => { this.anys.delete(listener); this.subscriptions -= 1; }; }
  events = { on: (name, listener) => { this.flags.add(listener); this.subscriptions += 1; return () => { this.flags.delete(listener); this.subscriptions -= 1; }; } };
  /** One flush: each changed word's listeners, then `any`. */
  flush(object, changes) {
    for (const [key, value] of changes) object.fields.set(key, value);
    for (const [key] of changes) for (const listener of this.fields.get(key) ?? []) listener(object, object.guid);
    for (const listener of this.anys) listener();
  }
  unitFlags(guid) { for (const listener of this.flags) listener({ guid }); }
}

function fixture() {
  const self = { guid: 0x0000000200000010n, fields: new Map() };
  const pet = { guid: 0xf140000000000abcn, fields: new Map() };
  const stranger = { guid: 0xf140000000000def0n, fields: new Map() };
  const setGuid = (object, name, guid) => {
    object.fields.set(offset(name), Number(guid & 0xffffffffn));
    object.fields.set(offset(name) + 1, Number(guid >> 32n));
  };
  setGuid(pet, "UNIT_FIELD_SUMMONEDBY", self.guid);
  setGuid(stranger, "UNIT_FIELD_SUMMONEDBY", 0x99n);
  const objects = new Map([[self.guid, self], [pet.guid, pet], [stranger.guid, stranger]]);
  const world = { group: undefined, petGuid: pet.guid };
  const fired = [];
  const events = new FrameXmlWorldEvents({
    self: () => self,
    object: (guid) => objects.get(guid),
    pet: () => (world.petGuid === undefined ? undefined : objects.get(world.petGuid)),
    group: () => world.group,
  });
  const store = new FakeStore();
  events.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } }, store);
  return { self, pet, stranger, world, fired, events, store, setGuid };
}

test("PET_ATTACK_START/STOP follow UNIT_FLAG_PET_IN_COMBAT of the player's pet, and only its", () => {
  const { pet, stranger, store, fired, self, setGuid } = fixture();
  pet.fields.set(offset("UNIT_FIELD_FLAGS"), UNIT_FLAG_PET_IN_COMBAT | 0x8);
  store.unitFlags(pet.guid);
  store.unitFlags(pet.guid);
  assert.deepEqual(fired, [["PET_ATTACK_START"]], "once per flip");
  pet.fields.set(offset("UNIT_FIELD_FLAGS"), 0x8);
  store.unitFlags(pet.guid);
  assert.deepEqual(fired.at(-1), ["PET_ATTACK_STOP"]);
  stranger.fields.set(offset("UNIT_FIELD_FLAGS"), UNIT_FLAG_PET_IN_COMBAT);
  store.unitFlags(stranger.guid);
  assert.equal(fired.length, 2, "another player's pet is not ours");
  // A unit the player charms counts though it was summoned by someone else.
  setGuid(stranger, "UNIT_FIELD_CHARMEDBY", self.guid);
  store.unitFlags(stranger.guid);
  assert.deepEqual(fired.at(-1), ["PET_ATTACK_START"]);
});

test("CHARACTER_POINTS_CHANGED carries both words' differences, once per change", () => {
  const { self, store, fired } = fixture();
  store.flush(self, [[offset("PLAYER_CHARACTER_POINTS1"), 1]]);
  assert.deepEqual(fired, [["CHARACTER_POINTS_CHANGED", 1, 0]]);
  store.flush(self, [[offset("PLAYER_CHARACTER_POINTS1"), 0], [offset("PLAYER_CHARACTER_POINTS2"), 2]]);
  assert.deepEqual(fired.at(-1), ["CHARACTER_POINTS_CHANGED", -1, 2]);
  assert.equal(fired.length, 2, "two words in one update are one event");
  store.flush(self, [[offset("PLAYER_CHARACTER_POINTS2"), 2]]);
  assert.equal(fired.length, 2, "the same value is no change");
});

test("COMBAT_RATING_UPDATE on any rating word or the shield block, once per update", () => {
  const { self, store, fired } = fixture();
  const base = offset("PLAYER_FIELD_COMBAT_RATING_1");
  store.flush(self, [[base + 24, 30], [base + 5, 12]]);
  assert.deepEqual(fired, [["COMBAT_RATING_UPDATE"]]);
  store.flush(self, [[offset("PLAYER_SHIELD_BLOCK"), 40]]);
  assert.equal(fired.length, 2);
  store.flush(self, [[base + 24, 30]]);
  assert.equal(fired.length, 2);
  store.flush(self, [[base, 7]]);
  assert.equal(fired.length, 3, "the first rating word counts too");
});

test("PARTY_LOOT_METHOD_CHANGED: the first list of a group, then a changed method, looter or threshold", () => {
  const { world, events, fired } = fixture();
  events.groupChanged();
  assert.equal(fired.length, 0, "no group, nothing");
  world.group = { lootMethod: 3, masterLooterGuid: 0n, lootThreshold: 2 };
  events.groupChanged();
  assert.deepEqual(fired, [["PARTY_LOOT_METHOD_CHANGED"]]);
  events.groupChanged();
  assert.equal(fired.length, 1, "the same settings, nothing");
  world.group = { lootMethod: 2, masterLooterGuid: 0x10n, lootThreshold: 2 };
  events.groupChanged();
  world.group = { lootMethod: 2, masterLooterGuid: 0x10n, lootThreshold: 3 };
  events.groupChanged();
  assert.equal(fired.length, 3);
  world.group = undefined;
  events.groupChanged();
  world.group = { lootMethod: 2, masterLooterGuid: 0x10n, lootThreshold: 3 };
  events.groupChanged();
  assert.equal(fired.length, 4, "a new group's first list tells again");
});

test("UNIT_PET_EXPERIENCE when the same pet's experience moves; a new pet is not an experience change", () => {
  const { pet, self, store, fired, world } = fixture();
  store.flush(pet, [[offset("UNIT_FIELD_PETEXPERIENCE"), 100], [offset("UNIT_FIELD_PETNEXTLEVELEXP"), 1000]]);
  assert.deepEqual(fired, [["UNIT_PET_EXPERIENCE", "pet"]]);
  store.flush(self, [[offset("UNIT_FIELD_HEALTH"), 5]]);
  assert.equal(fired.length, 1, "an unrelated flush is quiet");
  world.petGuid = undefined;
  store.flush(self, []);
  world.petGuid = pet.guid;
  store.flush(self, []);
  assert.equal(fired.length, 1, "dismissed and called again: UNIT_PET's edge, not this one");
});

test("detach removes every subscription", () => {
  const { events, store, fired, pet } = fixture();
  assert.ok(store.subscriptions > 0);
  events.detach();
  assert.equal(store.subscriptions, 0);
  pet.fields.set(offset("UNIT_FIELD_FLAGS"), UNIT_FLAG_PET_IN_COMBAT);
  store.unitFlags(pet.guid);
  assert.equal(fired.length, 0);
});
}

// ── framexml-world-exit-events.test.mjs
{
// Plan item 3.18 (L5c, 04.10): the world exit of Wow.exe 3.3.5a 12340 (0x00528c30, read-only Ghidra,
// .runtime/re-2026-09-30/a2-3-review/d4.txt) raises, in this order and each once:
//   CINEMATIC_STOP (event 0x169) — only while a cinematic plays (its flag 0xbd07fc), which also stops it;
//   INSTANCE_LOCK_STOP (0x279) — always: UIParent hides the INSTANCE_LOCK dialog (UIParent.lua:876);
//   PLAYER_LEAVING_WORLD (0x100) — last.
// Event ids from the name table at 0x00c24eb0. The exit runs on the player's destruction behind a
// loading screen (0x006e6020) and in the UI teardown (0x00528f00) before PLAYER_LOGOUT.
const { frameXmlWorldExitEvents } = await import("../dist/code/browser/framexml/FrameXmlWorldExit.js");
const { createFrameXmlWorldEntry } = await import("../dist/code/browser/framexml/FrameXmlWorldEntry.js");
const { FrameXmlLoginState } = await import("../dist/code/browser/framexml/FrameXmlLoginEdge.js");
const { EventBus } = await import("../dist/code/world/EventBus.js");

const SELF = 0x10n;

test("the world exit's events, in Wow.exe's order", () => {
  assert.deepEqual([...frameXmlWorldExitEvents(false)], ["INSTANCE_LOCK_STOP", "PLAYER_LEAVING_WORLD"]);
  assert.deepEqual([...frameXmlWorldExitEvents(true)], ["CINEMATIC_STOP", "INSTANCE_LOCK_STOP", "PLAYER_LEAVING_WORLD"]);
});

function loadingScreen(inCinematic) {
  const world = new EventBus();
  const store = new EventBus();
  const fired = [];
  const entry = createFrameXmlWorldEntry();
  entry.attach({ fire: (event) => { fired.push(event); return 1; }, now: () => 0 },
    { world, store, selfGuid: () => SELF, ...(inCinematic ? { inCinematic } : {}) });
  return { world, store, fired, entry };
}

test("a loading screen's leave is the whole world exit, once", () => {
  const { world, store, fired } = loadingScreen();
  world.emit("WORLD_TRANSFER", { mapId: 571 });
  assert.deepEqual(fired, ["INSTANCE_LOCK_STOP", "PLAYER_LEAVING_WORLD"]);
  world.emit("WORLD_TRANSFER", { mapId: 571 });
  assert.equal(fired.length, 2, "a second SMSG_NEW_WORLD before the entry is no second exit");
  store.emit("OBJECT_CREATED", { guid: SELF, typeId: 4 });
  assert.deepEqual(fired, ["INSTANCE_LOCK_STOP", "PLAYER_LEAVING_WORLD", "PLAYER_ENTERING_WORLD"]);
});

test("a cinematic still playing at the leave is stopped first", () => {
  let playing = true;
  const { world, fired } = loadingScreen(() => playing);
  world.emit("WORLD_TRANSFER", { mapId: 0 });
  assert.deepEqual(fired, ["CINEMATIC_STOP", "INSTANCE_LOCK_STOP", "PLAYER_LEAVING_WORLD"]);
  playing = false;
});

test("the UI teardown in the world: regen, the world exit, then the logout", () => {
  const login = new FrameXmlLoginState();
  login.observe("PLAYER_ENTERING_WORLD");
  assert.deepEqual([...login.teardownEvents(() => true)],
    ["PLAYER_REGEN_ENABLED", "INSTANCE_LOCK_STOP", "PLAYER_LEAVING_WORLD", "PLAYER_LOGOUT"]);
  assert.deepEqual([...login.teardownEvents(() => true)], ["PLAYER_LOGOUT"], "out of the world: no second exit");
  const idle = new FrameXmlLoginState();
  idle.observe("PLAYER_ENTERING_WORLD");
  assert.deepEqual([...idle.teardownEvents()], ["INSTANCE_LOCK_STOP", "PLAYER_LEAVING_WORLD", "PLAYER_LOGOUT"]);
});
}

// ── framexml-world-mouseover.test.mjs
{
const {
  compileFrameXmlWorldMouseoverScripts,
  createFrameXmlWorldMouseover,
  FRAMEXML_WORLD_MOUSEOVER_EXPIRE_DELAY_MS,
  FRAMEXML_WORLD_MOUSEOVER_LEAVE_DELAY_MS,
} = await import("../dist/code/browser/framexml/FrameXmlWorldMouseover.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");

function recorder(hover) {
  const calls = [];
  const mouseover = createFrameXmlWorldMouseover({
    hovered: () => hover.value,
    enter: () => calls.push(`enter:${hover.value}`),
    leave: () => calls.push("leave"),
    expire: () => calls.push("expire"),
  });
  return { calls, mouseover };
}

test("a world unit enters at once and leaves only after the hover stays clear", () => {
  const hover = { value: undefined };
  const { calls, mouseover } = recorder(hover);
  mouseover.tick(0);
  assert.deepEqual(calls, [], "no hover, no tooltip");
  hover.value = 7n;
  mouseover.tick(16);
  assert.deepEqual(calls, ["enter:7"], "the first committed pick shows the stock tooltip");
  // Controls.ts clears the pick for ~16 ms around every throttled pointermove.
  hover.value = undefined;
  mouseover.tick(33);
  hover.value = 7n;
  mouseover.tick(50);
  assert.deepEqual(calls, ["enter:7"], "a throttle gap neither fades nor re-runs SetUnit");
  hover.value = 9n;
  mouseover.tick(66);
  assert.deepEqual(calls, ["enter:7", "enter:9"], "a different unit re-runs SetUnit");
  hover.value = undefined;
  mouseover.tick(100);
  mouseover.tick(100 + FRAMEXML_WORLD_MOUSEOVER_LEAVE_DELAY_MS - 1);
  assert.deepEqual(calls, ["enter:7", "enter:9"], "leave waits for the settle delay");
  mouseover.tick(100 + FRAMEXML_WORLD_MOUSEOVER_LEAVE_DELAY_MS);
  assert.deepEqual(calls, ["enter:7", "enter:9", "leave"], "a settled clear fades the tooltip");
  mouseover.tick(200 + FRAMEXML_WORLD_MOUSEOVER_LEAVE_DELAY_MS + FRAMEXML_WORLD_MOUSEOVER_EXPIRE_DELAY_MS);
  assert.deepEqual(calls, ["enter:7", "enter:9", "leave", "expire"],
    "a tooltip that outlived its fade is hidden once");
  mouseover.tick(10_000);
  assert.equal(calls.length, 4, "nothing repeats while nothing is hovered");
});

test("re-entering before the fade expires cancels the expiry", () => {
  const hover = { value: 3n };
  const { calls, mouseover } = recorder(hover);
  mouseover.tick(0);
  hover.value = undefined;
  mouseover.tick(10);
  mouseover.tick(10 + FRAMEXML_WORLD_MOUSEOVER_LEAVE_DELAY_MS);
  hover.value = 3n;
  mouseover.tick(200);
  // Still hovering long past the first fade's expiry time.
  mouseover.tick(100 + FRAMEXML_WORLD_MOUSEOVER_LEAVE_DELAY_MS + FRAMEXML_WORLD_MOUSEOVER_EXPIRE_DELAY_MS);
  assert.deepEqual(calls, ["enter:3", "leave", "enter:3"],
    "the first fade's expiry never hides the tooltip of the unit hovered again");
});

/** A Lua GameTooltip double that records the engine calls the stock client makes. */
function tooltipVm({ mouseoverExists = true, fadeOut = true } = {}) {
  const vm = new GlueLuaVm();
  const setup = vm.execute(`
    __calls = {}
    local function note(text) __calls[#__calls + 1] = text end
    UIParent = { name = "UIParent" }
    OtherButton = { name = "OtherButton" }
    GameTooltip = { shown = false, owner = nil }
    function GameTooltip:IsShown() return self.shown end
    function GameTooltip:IsOwned(frame) return self.owner == frame end
    function GameTooltip:SetUnit(unit) note("SetUnit:" .. unit); self.shown = true end
    function GameTooltip:Hide() note("Hide"); self.shown = false; self.owner = nil end
    ${fadeOut ? 'function GameTooltip:FadeOut() note("FadeOut"); self.shown = false; self.owner = nil end' : ""}
    function GameTooltip_SetDefaultAnchor(tooltip, parent) note("SetDefaultAnchor:" .. parent.name); tooltip.owner = parent end
    function UnitExists(unit) return unit == "mouseover" and ${mouseoverExists ? "1" : "nil"} or nil end
  `, "@world-mouseover:test");
  assert.equal(setup.ok, true, setup.error);
  const calls = () => {
    vm.execute("__joined = table.concat(__calls, ',')", "@t");
    return vm.getGlobal("__joined");
  };
  return { vm, calls };
}

test("the Lua bodies make the stock engine calls and fade only the world tooltip", () => {
  const { vm, calls } = tooltipVm();
  try {
    const scripts = compileFrameXmlWorldMouseoverScripts(vm);
    scripts.enter();
    assert.equal(calls(), "SetDefaultAnchor:UIParent,SetUnit:mouseover");
    scripts.leave();
    assert.equal(calls(), "SetDefaultAnchor:UIParent,SetUnit:mouseover,FadeOut");
    // A frame's own OnEnter re-owned the tooltip: the world leave must not touch it.
    vm.execute('GameTooltip.shown = true; GameTooltip.owner = OtherButton', "@t");
    scripts.leave();
    scripts.expire();
    assert.equal(calls(), "SetDefaultAnchor:UIParent,SetUnit:mouseover,FadeOut",
      "a tooltip owned by another frame is left alone");
  } finally {
    vm.close();
  }
});

test("the Lua bodies degrade without the mouseover token or a real FadeOut", () => {
  const missing = tooltipVm({ mouseoverExists: false });
  try {
    compileFrameXmlWorldMouseoverScripts(missing.vm).enter();
    assert.equal(missing.calls(), "", "no mouseover unit yet: no tooltip");
  } finally {
    missing.vm.close();
  }
  const noFade = tooltipVm({ fadeOut: false });
  try {
    const scripts = compileFrameXmlWorldMouseoverScripts(noFade.vm);
    scripts.enter();
    scripts.leave();
    assert.equal(noFade.calls(), "SetDefaultAnchor:UIParent,SetUnit:mouseover,Hide",
      "without FadeOut the world tooltip is hidden");
  } finally {
    noFade.vm.close();
  }
  const bare = new GlueLuaVm();
  try {
    const scripts = compileFrameXmlWorldMouseoverScripts(bare);
    scripts.enter();
    scripts.leave();
    scripts.expire();
    assert.equal(bare.errors?.length ?? 0, 0, "a VM without GameTooltip raises nothing");
  } finally {
    bare.close();
  }
});
}

// ── framexml-world-state-timer.test.mjs
{
// Plan item 3.14 (L3): WORLD_STATE_UI_TIMER_UPDATE as Wow.exe 3.3.5a fires it. 0x5487d0 lists the
// WorldStateUI rows of the current map (or -1), zone/area (or 0) and phase (or 0) whose Type is 0, 1
// or 3 — whatever their state; 0x5488f0 (each frame) fires event 0x28b once a second while that list
// holds a Type-3 row (the %Nk countdowns: Wintergrasp rows 208 and 212 in this dataset), and
// UPDATE_WORLD_STATES (0x1d0) only comes with the world-state packets (0x526530 cases 0x2c2/0x2c3).

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
}
