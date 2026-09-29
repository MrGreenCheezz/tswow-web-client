import assert from "node:assert/strict";
import test from "node:test";

const { EventBus } = await import("../dist/code/world/EventBus.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const {
  FRAMEXML_SEAM_BINDINGS,
  FRAMEXML_SEAM_EVENTS,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function object(guid, typeId) {
  return {
    guid,
    typeId,
    position: undefined,
    movementFlags: 0,
    updateFlags: 0,
    targetGuid: undefined,
    runSpeed: undefined,
    turnRate: undefined,
    motion: undefined,
    glide: undefined,
    transport: undefined,
    speeds: undefined,
    transportTime: undefined,
    fields: new Map(),
  };
}

function set(objectState, name, value) {
  objectState.fields.set(UPDATE_FIELDS[name].offset, value);
}

test("live target follows world selection and target fields without aliasing player", () => {
  const state = new WorldState();
  const store = new WorldStore(state);
  const player = object(1n, 4);
  const target = object(2n, 3);
  set(player, "UNIT_FIELD_LEVEL", 60);
  set(player, "UNIT_FIELD_HEALTH", 4000);
  set(player, "UNIT_FIELD_MAXHEALTH", 5000);
  set(player, "UNIT_FIELD_BYTES_0", 1 | (8 << 8) | (0 << 16) | (1 << 24));
  set(target, "OBJECT_FIELD_ENTRY", 9001);
  set(target, "UNIT_FIELD_LEVEL", 58);
  set(target, "UNIT_FIELD_HEALTH", 1200);
  set(target, "UNIT_FIELD_MAXHEALTH", 2000);
  set(target, "UNIT_FIELD_BYTES_0", 2 | (0 << 8) | (1 << 16));
  set(target, "UNIT_DYNAMIC_FLAGS", 0x0c); // tapped and tapped by this player
  set(target, "UNIT_FIELD_BYTES_2", 1 << 8); // a non-zero PvP byte
  state.objects.set(player.guid, player);
  state.objects.set(target.guid, target);
  state.selfGuid = player.guid;
  store.flush();

  const world = {
    state,
    targetGuid: undefined,
    selfName: "Герой",
    names: { get: () => undefined },
    creatureTemplates: new Map(),
    actionButtons: [],
    casts: new Map(),
    events: new EventBus(),
    cooldownState: () => undefined,
    cooldownRemaining: () => 0,
    isActiveMountSpell: () => false,
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: () => undefined,
    monotonic: () => 0,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  let now = 100;
  const events = [];
  seam.attach({
    now: () => now,
    fire: (event, ...args) => {
      events.push([event, ...args]);
      return 1;
    },
  });
  events.length = 0;
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

  assert.deepEqual(call("UnitExists", "target"), [false]);
  assert.deepEqual(call("UnitName", "target"), []);
  assert.deepEqual(call("UnitHealth", "target"), [0]);
  assert.deepEqual(call("UnitIsUnit", "target", "player"), [false]);

  world.targetGuid = target.guid;
  seam.tick(now);
  assert.deepEqual(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.targetChanged), [
    [FRAMEXML_SEAM_EVENTS.targetChanged],
  ]);
  assert.deepEqual(call("UnitExists", "target"), [true]);
  assert.deepEqual(call("UnitName", "target"), [], "unknown target names stay nil, not a GUID fallback");
  assert.deepEqual(call("UnitLevel", "target"), [58]);
  assert.deepEqual(call("UnitHealth", "target"), [1200]);
  assert.deepEqual(call("UnitHealthMax", "target"), [2000]);
  assert.deepEqual(call("UnitPowerType", "target"), [0, "MANA"]);
  assert.deepEqual(call("UnitIsPlayer", "target"), [false]);
  assert.deepEqual(call("UnitIsConnected", "target"), [true]);
  assert.deepEqual(call("UnitIsTapped", "target"), [true]);
  assert.deepEqual(call("UnitIsTappedByPlayer", "target"), [true]);
  assert.deepEqual(call("UnitIsTappedByAllThreatList", "target"), [false]);
  assert.deepEqual(call("UnitIsPVP", "target"), [true]);
  assert.deepEqual(call("UnitFactionGroup", "target"), [], "FactionTemplate.dbc is outside this seam context");
  assert.deepEqual(call("UnitIsEnemy", "player", "target"), [false]);
  assert.deepEqual(call("UnitIsFriend", "player", "target"), [false]);
  assert.deepEqual(call("UnitCanAttack", "player", "target"), [false]);
  assert.deepEqual(call("UnitSelectionColor", "target"), [1, 1, 0]);

  // A creature query fills the same world cache used by the rest of the client and publishes one
  // name edge. The next poll sees the already-published value and stays quiet.
  world.creatureTemplates.set(9001, {
    entry: 9001, found: true, name: "Элитный зверь", subName: "", cursorName: "", flags: 0,
    creatureType: 1, creatureFamily: 0, classification: 1, proxyCreatureIds: [], displayIds: [],
    healthModifier: 1, powerModifier: 1, leader: false, questItems: [], movementId: 0,
  });
  world.events.emit("QUERY_CACHE_CHANGED", { kind: "creature", id: 9001 });
  assert.deepEqual(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.unitName), [
    [FRAMEXML_SEAM_EVENTS.unitName, "target"],
  ]);
  assert.deepEqual(call("UnitName", "target"), ["Элитный зверь"]);
  assert.deepEqual(call("UnitClassification", "target"), ["elite"]);
  now += 0.01;
  seam.tick(now);
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.unitName).length, 1);

  // Store field events are forwarded with the exact target unit argument.
  events.length = 0;
  state.setField(target.guid, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 800);
  store.flush();
  assert.deepEqual(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.health), [
    [FRAMEXML_SEAM_EVENTS.health, "target"],
  ]);
  assert.deepEqual(call("UnitHealth", "target"), [800]);
  events.length = 0;
  state.setField(target.guid, UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 2400);
  store.flush();
  assert.deepEqual(events, [[FRAMEXML_SEAM_EVENTS.maxHealth, "target"]]);
  events.length = 0;
  state.setField(target.guid, UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 350);
  store.flush();
  assert.deepEqual(events, [["UNIT_MANA", "target"]]);
  events.length = 0;
  state.setField(target.guid, UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset, 700);
  store.flush();
  assert.deepEqual(events, [["UNIT_MAXMANA", "target"]]);
  events.length = 0;
  state.setField(target.guid, UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset, 12);
  store.flush();
  assert.deepEqual(events, [[FRAMEXML_SEAM_EVENTS.faction, "target"]]);
  events.length = 0;
  state.setField(target.guid, UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset, 0x04);
  store.flush();
  assert.deepEqual(events, [[FRAMEXML_SEAM_EVENTS.aura, "target"]]);

  // Selection is a property on WorldClient, so a poll supplies its missing edge. Repeating it is
  // idempotent, and losing the object through the store supplies the same edge once.
  events.length = 0;
  world.targetGuid = undefined;
  seam.tick(now + 0.01);
  seam.tick(now + 0.02);
  assert.deepEqual(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.targetChanged), [
    [FRAMEXML_SEAM_EVENTS.targetChanged],
  ]);
  world.targetGuid = target.guid;
  seam.tick(now + 0.03);
  events.length = 0;
  state.destroy(target.guid);
  store.flush();
  assert.deepEqual(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.targetChanged), [
    [FRAMEXML_SEAM_EVENTS.targetChanged],
  ]);
  seam.tick(now + 0.04);
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.targetChanged).length, 1);

  seam.detach();
  seam.detach();
  world.targetGuid = player.guid;
  seam.tick(now + 1);
  assert.deepEqual(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.targetChanged), [
    [FRAMEXML_SEAM_EVENTS.targetChanged],
  ], "detached seam does not publish a new target edge");
  store.detach();
});

test("live relation resolver supplies hostile and friendly colors when the host has faction data", () => {
  const state = new WorldState();
  const store = new WorldStore(state);
  const player = object(11n, 4);
  const target = object(12n, 3);
  state.objects.set(player.guid, player);
  state.objects.set(target.guid, target);
  state.selfGuid = player.guid;
  store.flush();
  const world = {
    state,
    targetGuid: target.guid,
    selfName: "Герой",
    names: { get: () => undefined },
    creatureTemplates: new Map(),
    actionButtons: [], casts: new Map(), events: new EventBus(),
    cooldownState: () => undefined, cooldownRemaining: () => 0,
    isActiveMountSpell: () => false,
  };
  let relation = -1;
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: () => undefined,
    reaction: (left, right) => left.guid === player.guid && right.guid === target.guid ? relation : 0,
    monotonic: () => 0,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  seam.attach({ now: () => 1, fire: () => 1 });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  assert.deepEqual(call("UnitIsEnemy", "player", "target"), [true]);
  assert.deepEqual(call("UnitCanAttack", "player", "target"), [true]);
  assert.deepEqual(call("UnitSelectionColor", "target"), [1, 0, 0]);
  relation = 1;
  assert.deepEqual(call("UnitIsFriend", "player", "target"), [true]);
  assert.deepEqual(call("UnitIsEnemy", "player", "target"), [false]);
  assert.deepEqual(call("UnitSelectionColor", "target"), [0, 1, 0]);
  relation = 0;
  assert.deepEqual(call("UnitIsEnemy", "player", "target"), [false]);
  assert.deepEqual(call("UnitIsFriend", "player", "target"), [false]);
  assert.deepEqual(call("UnitCanAttack", "player", "target"), [true]);
  assert.deepEqual(call("UnitSelectionColor", "target"), [1, 1, 0]);
  seam.detach();
  store.detach();
});
