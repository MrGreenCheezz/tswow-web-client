import assert from "node:assert/strict";
import test from "node:test";

// seam-sweep (03.10): the live seam has always attached over a sparse fake world — `state: { selfGuid }` with
// no `state.objects`, no `events`, no `petSpells` or `controlledGuid` (tests/framexml-live-castbar.test.mjs and
// others build one) — and read it as holding no objects (LiveWorldSeam's `typeof world.state.objects?.get`
// idiom). The possess (11.02-IF), vehicle (11.02-F2) and vehicle-aim (11.02-E) models attached inside
// `LiveWorldSeam.attach` and its poll follow the same rule through browser/framexml/FrameXmlWorldObjects.ts:
// no possession, no seat, no aimer, and nothing raised.

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FrameXmlPossessModel } = await import("../dist/code/browser/framexml/FrameXmlPossess.js");
const { NO_WORLD_OBJECTS, frameXmlWorldObjects } = await import("../dist/code/browser/framexml/FrameXmlWorldObjects.js");
const { VEHICLE_CATALOG_VERSION, vehicleCatalogFrom } = await import("../dist/code/world/VehicleDbc.js");

const SELF = 0x10n;
/** Tables that landed but name no vehicle: the vehicle and aim models are active and read the world. */
const EMPTY_TABLES = vehicleCatalogFrom({ version: VEHICLE_CATALOG_VERSION, vehicles: [], seats: [], indicators: [], indicatorSeats: [] });

/** What the possess, vehicle and aim models raise; none of it may come from a world with nothing in it. */
const MODEL_EVENTS = new Set([
  "PLAYER_FARSIGHT_FOCUS_CHANGED", "PET_BAR_UPDATE",
  "UNIT_ENTERING_VEHICLE", "UNIT_ENTERED_VEHICLE", "UNIT_EXITING_VEHICLE", "UNIT_EXITED_VEHICLE",
  "VEHICLE_PASSENGERS_CHANGED", "PLAYER_GAINS_VEHICLE_DATA", "PLAYER_LOSES_VEHICLE_DATA", "VEHICLE_UPDATE",
  "VEHICLE_ANGLE_SHOW", "VEHICLE_POWER_SHOW", "VEHICLE_ANGLE_UPDATE",
]);

function sparseSeam(tables) {
  // The shape tests/framexml-live-castbar.test.mjs attached over before 03.10: the seam has needed a bus
  // (FrameXmlCalendarLive subscribes on attach) and the cast table since earlier slices; nothing else.
  const world = { state: { selfGuid: SELF }, casts: new Map(), events: { on: () => () => {} } };
  const fired = [];
  let now = 0;
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => now };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: () => undefined,
    monotonic: () => now * 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
    vehicles: () => tables,
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  // The three models' share of the seam's 60 ms poll (LiveWorldSeam `tick`, which itself needs the action
  // bar tables and more of a world than this one has — as it did before 03.10).
  const poll = () => { now += 0.1; seam.possess.tick(); seam.vehicle.tick(); seam.vehicleAim.tick(); };
  return { seam, world, fired, pump, call, poll };
}

for (const [label, tables] of [["with the vehicle tables", EMPTY_TABLES], ["without the vehicle tables", undefined]]) {
  test(`a world without state.objects attaches, polls and detaches; possess, vehicle and aim report nothing (${label})`, () => {
    assert.ok(EMPTY_TABLES, "the empty tables parse");
    const { seam, fired, pump, call, poll } = sparseSeam(tables);

    assert.doesNotThrow(() => seam.attach(pump));
    assert.doesNotThrow(() => { poll(); poll(); });

    // 11.02-IF: no possess spell, no main-bar bit, no mirrored slots.
    assert.equal(seam.possess.possessSpell, 0);
    assert.equal(seam.possess.onMainBar(), false);
    assert.equal(seam.possess.barVisible(), false);
    assert.equal(seam.possess.mirrorIndex(121), undefined);
    assert.equal(seam.possess.unitIsPossessed("player"), false);
    assert.equal(seam.possess.unitIsCharmed("player"), false);
    assert.deepEqual([...seam.possess.info(1)], [undefined, undefined, undefined]);
    assert.deepEqual(call("IsPossessBarVisible"), [false]);
    assert.deepEqual(call("UnitIsCharmed", "player"), []);

    // 11.02-F2: no seat, no vehicle unit, nothing to exit or switch.
    assert.equal(seam.vehicle.active, tables !== undefined);
    assert.equal(seam.vehicle.vehicleUnitGuid(), undefined);
    assert.equal(seam.vehicle.inVehicle("player"), false);
    assert.equal(seam.vehicle.controlling("player"), false);
    assert.equal(seam.vehicle.seatOf("player"), undefined);
    assert.equal(seam.vehicle.seatCount("player"), 0);
    assert.equal(seam.vehicle.canExit(), false);
    assert.equal(seam.vehicle.canSwitch(), false);
    assert.equal(seam.vehicle.usingControls(), false);
    assert.equal(seam.unitIsVisible("vehicle"), false);

    // 11.02-E: no aimer.
    assert.equal(seam.vehicleAim.angle(), 0);
    assert.equal(seam.vehicleAim.normAngle(), 0);
    if (tables) {
      assert.deepEqual(call("UnitInVehicle", "player"), []);
      assert.deepEqual(call("CanExitVehicle"), []);
      assert.deepEqual(call("VehicleAimGetAngle"), [0]);
      assert.deepEqual(call("VehicleAimGetNormAngle"), [0]);
      assert.doesNotThrow(() => call("VehicleAimIncrement", 0.2));
    }

    assert.deepEqual(fired.filter(([event]) => MODEL_EVENTS.has(event)).map(([event]) => event), []);
    assert.equal(NO_WORLD_OBJECTS.size, 0, "nothing was written into the shared empty table");
    assert.doesNotThrow(() => seam.detach());
  });
}

test("the native possess model (ui/PossessActionBar.ts) ticks over a world without state.objects", () => {
  const world = { state: { selfGuid: SELF }, petSpells: { guid: 0x20n, closed: false, bar: [], spells: [] } };
  const model = new FrameXmlPossessModel({
    world: () => world, spell: () => undefined, unitGuid: () => undefined, native: true, vehicles: () => EMPTY_TABLES,
  });
  const fired = [];
  assert.doesNotThrow(() => model.attach({ fire: (event) => { fired.push(event); return 0; } }));
  assert.doesNotThrow(() => model.tick());
  assert.equal(model.onMainBar(), false);
  assert.equal(model.possessSpell, 0);
  assert.equal(model.unitIsPossessed("player"), false);
  assert.equal(model.cancelBuffByName("player", "Mind Control", undefined, undefined), true);
  assert.deepEqual(fired, []);
  model.detach();
});

test("frameXmlWorldObjects hands back the world's own table and the shared empty one otherwise", () => {
  const objects = new Map();
  assert.equal(frameXmlWorldObjects({ state: { selfGuid: SELF, objects } }) === objects, true, "the real table, not a copy");
  assert.equal(frameXmlWorldObjects({ state: { selfGuid: SELF } }) === NO_WORLD_OBJECTS, true);
  assert.equal(frameXmlWorldObjects({ state: { objects: {} } }) === NO_WORLD_OBJECTS, true, "not a table");
  assert.equal(frameXmlWorldObjects({}) === NO_WORLD_OBJECTS, true);
  assert.equal(frameXmlWorldObjects(undefined) === NO_WORLD_OBJECTS, true);
  assert.equal(Object.isFrozen(NO_WORLD_OBJECTS), true);
});
