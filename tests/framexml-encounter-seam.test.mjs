// Plan item 3.16: boss1…bossN and INSTANCE_ENCOUNTER_ENGAGE_UNIT as Wow.exe keeps them
// (SMSG_UPDATE_INSTANCE_ENCOUNTER_UNIT handler 0x5eddd0: engage 0x5ed7b0, disengage 0x5ed870,
// priority 0x5ed930, sort 0x5ed750 with 0x5ed590, token parser 0x60abf0 → 0x5ed710).
import assert from "node:assert/strict";
import test from "node:test";

const {
  FrameXmlEncounters, frameXmlBossTokenIndex, FRAMEXML_ENCOUNTER_SLOTS, INSTANCE_ENCOUNTER_ENGAGE_UNIT,
} = await import("../dist/code/browser/framexml/FrameXmlEncounters.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }
  emit(name, payload) { for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload); }
  count(name) { return this.#listeners.get(name)?.size ?? 0; }
}

const ENGAGE = 0, DISENGAGE = 1, PRIORITY = 2, TIMER = 3, PHASE = 7;
const frame = (type, guid, param1 = 0) => ({ type, guid, param1, param2: 0 });

function model() {
  const events = new FakeEvents();
  const fired = [];
  const encounters = new FrameXmlEncounters({ events: () => events });
  encounters.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  return { events, fired, encounters, emit: (f) => events.emit("ENCOUNTER_FRAME", f) };
}

test("engaged units become boss1, boss2 in order, one argumentless event per change", () => {
  const { fired, encounters, emit } = model();
  emit(frame(ENGAGE, 0xa1n));
  emit(frame(ENGAGE, 0xa2n));
  assert.equal(encounters.bossGuid(1), 0xa1n);
  assert.equal(encounters.bossGuid(2), 0xa2n);
  assert.equal(encounters.bossGuid(3), undefined);
  assert.equal(encounters.indexOf(0xa2n), 2);
  assert.equal(encounters.indexOf(0xffn), 0);
  assert.deepEqual(fired, [[INSTANCE_ENCOUNTER_ENGAGE_UNIT], [INSTANCE_ENCOUNTER_ENGAGE_UNIT]]);
  emit(frame(ENGAGE, 0xa1n));
  assert.equal(fired.length, 2, "an engaged unit engaging again changes nothing and signals nothing");
  emit(frame(DISENGAGE, 0xa1n));
  assert.equal(encounters.bossGuid(1), 0xa2n, "the next one moves up");
  assert.equal(fired.length, 3);
  emit(frame(DISENGAGE, 0xa1n));
  assert.equal(fired.length, 3, "an unlisted unit's disengage signals nothing");
  emit(frame(TIMER, undefined, 5));
  assert.equal(fired.length, 3, "the objective and timer types are not the unit list");
});

test("the list is sorted by priority, lowest first; equal priorities keep their order", () => {
  const { encounters, emit, fired } = model();
  emit(frame(ENGAGE, 0xb1n, 2));
  emit(frame(ENGAGE, 0xb2n, 1));
  emit(frame(ENGAGE, 0xb3n, 2));
  assert.deepEqual(encounters.guids(), [0xb2n, 0xb1n, 0xb3n]);
  emit(frame(PRIORITY, 0xb3n, 0));
  assert.deepEqual(encounters.guids(), [0xb3n, 0xb2n, 0xb1n]);
  emit(frame(PRIORITY, 0xeeen, 0));
  assert.equal(fired.length, 4, "an unlisted unit's priority signals nothing");
  emit(frame(PHASE, undefined));
  assert.equal(fired.length, 5, "a phase shift re-sorts and signals");
});

test("sixteen slots, as the client allocates; a seventeenth still signals but is not listed", () => {
  const { encounters, emit, fired } = model();
  for (let index = 1; index <= FRAMEXML_ENCOUNTER_SLOTS + 1; index += 1) emit(frame(ENGAGE, BigInt(0x100 + index)));
  assert.equal(encounters.guids().length, FRAMEXML_ENCOUNTER_SLOTS);
  assert.equal(encounters.bossGuid(5), 0x105n, "boss5 exists although stock draws four frames");
  assert.equal(encounters.bossGuid(FRAMEXML_ENCOUNTER_SLOTS + 1), undefined);
  assert.equal(fired.length, FRAMEXML_ENCOUNTER_SLOTS + 1);
});

test("detach stops listening; tokens parse only as bossN", () => {
  const { events, encounters, emit, fired } = model();
  encounters.detach();
  assert.equal(events.count("ENCOUNTER_FRAME"), 0);
  emit(frame(ENGAGE, 0xc1n));
  assert.equal(fired.length, 0);
  assert.equal(frameXmlBossTokenIndex("boss1"), 1);
  assert.equal(frameXmlBossTokenIndex("BOSS4"), 4);
  assert.equal(frameXmlBossTokenIndex("boss"), undefined);
  assert.equal(frameXmlBossTokenIndex("boss0"), undefined);
  assert.equal(frameXmlBossTokenIndex("bossy"), undefined);
});

test("the live seam answers the boss tokens and routes unit events to them", () => {
  const selfGuid = 0x10n;
  const bossGuid = 0xf130000000001234n;
  const fields = (entries) => new Map(entries.map(([name, value]) => [UPDATE_FIELDS[name].offset, value]));
  const self = { guid: selfGuid, typeId: 4, fields: fields([["UNIT_FIELD_BYTES_0", (1 << 8) | (1 << 24)]]) };
  const boss = { guid: bossGuid, typeId: 3, fields: fields([
    ["OBJECT_FIELD_ENTRY", 29304], ["UNIT_FIELD_HEALTH", 5000], ["UNIT_FIELD_MAXHEALTH", 10000],
    ["UNIT_FIELD_BYTES_0", 1 | (1 << 8) | (1 << 24)],
  ]) };
  const events = new FakeEvents();
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, self], [bossGuid, boss]]) },
    events, names: new Map(), creatureTemplates: new Map([[29304, { found: true, name: "Слад'ран" }]]),
    partyStats: new Map(), casts: new Map(), actionButtons: [], knownSpells: [], cooldownRemaining: () => 0,
  };
  // The store's unit events (WorldStore UNIT_HEALTH etc.); field subscriptions are inert here.
  const storeEvents = new FakeEvents();
  const store = { events: storeEvents, field: () => () => {} };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store, spell: () => undefined,
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {}, targetGuid: () => undefined,
  });
  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 1 });
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  try {
    assert.deepEqual(call("UnitExists", "boss1"), [false]);
    events.emit("ENCOUNTER_FRAME", frame(ENGAGE, bossGuid, 0));
    assert.ok(fired.some(([event]) => event === INSTANCE_ENCOUNTER_ENGAGE_UNIT));
    assert.deepEqual(call("UnitExists", "boss1"), [true]);
    assert.deepEqual(call("UnitName", "boss1").slice(0, 1), ["Слад'ран"]);
    assert.deepEqual(call("UnitHealth", "boss1"), [5000]);
    assert.deepEqual(call("UnitIsUnit", "boss1", "boss1"), [true]);
    assert.deepEqual(call("UnitExists", "boss2"), [false]);
    fired.length = 0;
    storeEvents.emit("UNIT_HEALTH", { guid: bossGuid });
    assert.ok(fired.some(([event, unit]) => event === "UNIT_HEALTH" && unit === "boss1"), JSON.stringify(fired));
    world.state.objects.delete(bossGuid);
    assert.deepEqual(call("UnitExists", "boss1"), [false], "a listed boss out of sight does not exist");
  } finally {
    seam.detach();
  }
  assert.equal(events.count("ENCOUNTER_FRAME"), 0, "detach unsubscribes");
});
