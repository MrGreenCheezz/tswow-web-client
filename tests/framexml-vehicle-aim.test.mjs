import assert from "node:assert/strict";
import test from "node:test";

// 11.02-E: the stock UI's aim over the live seam — VehicleAim* (registration table 0x00ad1a48…0x00ad1aa0) and
// VEHICLE_ANGLE_UPDATE — as Wow.exe 3.3.5a 12340 answers and raises them (Ghidra read-only,
// .runtime/re-2026-10-03/l1102e/r1-r2.c, l1102gf3/r1.c, r4.c): GetAngle 0x005f9e10 and GetNormAngle 0x005f9e60 read
// the aimer (0x005f9d20) — the vehicle driven from a CAN_CONTROL seat, else the character; RequestAngle 0x005fb820
// sets the active mover's pitch when its row has ADJUST_AIM_ANGLE 0x400, RequestNormAngle 0x005fb8c0 the aimer's
// over [PitchMin, PitchMax] (CUSTOM_PITCH) or ±π/2; Increment/Decrement 0x005fb770/0x005fb7d0 step the mover by the
// number or 0.1; Up/Down Start/Stop are PitchUp/Down Start/Stop's own functions; Get/SetNormPower 0x005f9550/
// 0x005f9f10 the global power, clamped to [0, 1]; 0x005fb3a0 raises VEHICLE_ANGLE_UPDATE ("%f%f", 0x005fa910) for a
// 0x400 row unless FULL_SPEED_PITCHING.

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_VEHICLE_AIM_NAMES, normalizedVehiclePitch } = await import("../dist/code/browser/framexml/FrameXmlVehicleAim.js");
const { registerVehicleAimInput, setVehicleAimPower, vehicleAimPower } = await import("../dist/code/browser/game/VehicleAim.js");
const {
  VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_COLUMN, VEHICLE_SEAT_FORMAT, vehicleCatalogFrom,
} = await import("../dist/code/world/VehicleDbc.js");
const { VEHICLE_SEAT_FLAGS } = await import("../dist/code/world/VehicleSeatModel.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

function vehicleRow({ id, flags, seats, pitchMin = 0, pitchMax = 0 }) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  row[VEHICLE_COLUMN.Flags] = flags;
  row[VEHICLE_COLUMN.PitchMin] = pitchMin;
  row[VEHICLE_COLUMN.PitchMax] = pitchMax;
  seats.forEach((seat, slot) => { row[VEHICLE_COLUMN.SeatID + slot] = seat; });
  return row;
}

function seatRow({ id, flags }) {
  const row = [...VEHICLE_SEAT_FORMAT].map(() => 0);
  row[VEHICLE_SEAT_COLUMN.ID] = id;
  row[VEHICLE_SEAT_COLUMN.Flags] = flags;
  row[VEHICLE_SEAT_COLUMN.VehicleAbilityDisplay] = 1;
  return row;
}

// The dataset's turret 116 (0x471cf677: ALLOW_PITCHING, FULLSPEEDPITCHING, CUSTOM_PITCH, ADJUST_AIM_ANGLE;
// −0.524…0.785) with gunner seat 1643 (CAN_CONTROL), the siege engine 117 (0x5018f027: no ADJUST_AIM_*) with driver
// 1648, and a made-up cannon with the aim but not FULLSPEEDPITCHING (0x5fb3a0's other path).
const TURRET = 116;
const SIEGE = 117;
const QUICK = 903;
/** Pitches (ALLOW_PITCHING | CUSTOM_PITCH) but has no aim: 0x005fb3a0 sets it and raises nothing. */
const TILT = 905;
const catalog = vehicleCatalogFrom({
  version: VEHICLE_CATALOG_VERSION,
  vehicles: [
    vehicleRow({ id: TURRET, flags: 0x471cf677, seats: [1643], pitchMin: -0.524, pitchMax: 0.785 }),
    vehicleRow({ id: SIEGE, flags: 0x5018f027, seats: [1648] }),
    vehicleRow({ id: QUICK, flags: 0x10 | 0x40 | 0x400, seats: [9030], pitchMin: -0.524, pitchMax: 0.785 }),
    vehicleRow({ id: TILT, flags: 0x10 | 0x40, seats: [9030], pitchMin: -1, pitchMax: 1 }),
  ],
  seats: [
    seatRow({ id: 1643, flags: 0x67100a0f }),
    seatRow({ id: 1648, flags: 0x67108a0b }),
    seatRow({ id: 9030, flags: VEHICLE_SEAT_FLAGS.CAN_CONTROL }),
  ],
  indicators: [],
  indicatorSeats: [],
});

const SELF = 0x10n;
const GUN = 0xf150_0074_9800_0102n;
const ENGINE = 0xf150_0075_9800_0101n;
const CANNON = 0xf150_0385_0000_0103n;
const CART = 0xf150_0389_0000_0104n;
const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;

function unit(guid, { typeId = 3, vehicleId, carrier, seat = 0 } = {}) {
  return {
    guid, typeId, vehicleId, movementFlags: 0, updateFlags: 0,
    position: { x: 0, y: 0, z: 0, orientation: 0 },
    transport: carrier === undefined ? undefined : { guid: carrier, x: 0, y: 0, z: 0, orientation: 0, seat },
    fields: new Map([[HEALTH, 100]]),
  };
}

class FakeEvents {
  on() { return () => {}; }
  emit() {}
}

/** The movement code's side as game/VehicleAim.ts sees it: the pitch of the mover, its band, its keys. */
function fakeMovement(world) {
  const input = {
    pitch: 0,
    keys: [],
    sets: [],
    moverPitch() { return this.pitch; },
    setMoverPitch(pitch) {
      this.sets.push(pitch);
      const mover = world.state.objects.get(world.controlledGuid ?? world.state.selfGuid);
      const row = mover?.vehicleId ? catalog.vehicle(mover.vehicleId) : undefined;
      if (row === undefined || (row.flags & 0x10) === 0) return false;
      const [min, max] = (row.flags & 0x40) !== 0 ? [row.pitchMin, row.pitchMax] : [-Math.PI / 2, Math.PI / 2];
      this.pitch = Math.min(max, Math.max(min, pitch));
      return true;
    },
    pitchKey(direction, down) { this.keys.push([direction, down]); },
  };
  registerVehicleAimInput(input);
  return input;
}

function fixture({ tables = true } = {}) {
  const objects = new Map();
  for (const object of [
    unit(SELF, { typeId: 4 }), unit(ENGINE, { vehicleId: SIEGE }), unit(GUN, { vehicleId: TURRET }), unit(CANNON, { vehicleId: QUICK }),
    unit(CART, { vehicleId: TILT }),
  ]) objects.set(object.guid, object);
  const world = {
    state: { selfGuid: SELF, objects, revision: 1 },
    events: new FakeEvents(),
    movementReady: true,
    controlledGuid: SELF,
    attacking: false,
    targetGuid: undefined,
    petSpells: undefined,
    petCooldowns: new Map(),
    partyStats: new Map(),
    group: undefined,
    auras: new Map(),
    aurasFor: () => [],
    actionButtons: [],
    casts: new Map(),
    cooldownRemaining: () => 0,
    cooldownState: () => undefined,
    names: new Map([[SELF, "Наводчик"]]),
    selfName: "Наводчик",
    creatureTemplates: new Map(),
    totems: new Map(),
  };
  const fired = [];
  let now = 0;
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => now };
  const store = { field: () => () => {} };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store, spell: () => undefined,
    monotonic: () => now * 1000, globalCooldownUntil: () => 0, castSpell: () => {},
    vehicles: () => (tables ? catalog : undefined),
  });
  const input = fakeMovement(world);
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  return {
    seam, world, objects, fired, input, call,
    angleUpdates: () => fired.filter(([name]) => name === "VEHICLE_ANGLE_UPDATE").map(([, ...args]) => args),
    attach() { seam.attach(pump); },
    poll() { now += 0.1; world.state.revision += 1; seam.tick(now); },
    /** The character takes `vehicle`'s seat 0 and drives it. */
    drive(vehicle) {
      objects.get(SELF).transport = { guid: vehicle, x: 0, y: 0, z: 0, orientation: 0, seat: 0 };
      world.controlledGuid = vehicle;
    },
  };
}

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} vs ${expected}`);

test("11.02-E: the twelve names are in the seam's table; without the vehicle tables they answer nothing", () => {
  for (const name of FRAMEXML_VEHICLE_AIM_NAMES) assert.equal(typeof FRAMEXML_SEAM_BINDINGS[name], "function", name);
  assert.equal(FRAMEXML_VEHICLE_AIM_NAMES.length, 12);
  assert.equal(FRAMEXML_SEAM_BINDINGS.VehicleCameraZoomIn, undefined, "not done: CameraZoomIn itself is not implemented");
  const f = fixture({ tables: false });
  f.attach();
  f.drive(GUN);
  f.input.pitch = 0.3;
  for (const name of FRAMEXML_VEHICLE_AIM_NAMES) assert.deepEqual(f.call(name, 0.5), [], name);
  f.poll();
  f.input.pitch = 0.6;
  f.poll();
  assert.deepEqual(f.angleUpdates(), []);
  assert.deepEqual(f.input.sets, []);
  assert.deepEqual(f.input.keys, [], "the keys are not pressed either");
});

test("11.02-E: the driver of a cannon — angle, normalised angle, requests, steps, keys (0x005f9e10…0x005fc5c0)", () => {
  const f = fixture();
  f.attach();
  f.drive(CANNON);
  f.poll();
  f.input.pitch = 0.2;
  close(f.call("VehicleAimGetAngle")[0], 0.2, "the aimer's pitch");
  close(f.call("VehicleAimGetNormAngle")[0], (0.2 + 0.524) / (0.785 + 0.524), "over PitchMin…PitchMax");
  f.fired.length = 0;

  assert.deepEqual(f.call("VehicleAimRequestNormAngle", 0.5), []);
  close(f.input.pitch, -0.524 + 0.5 * (0.785 + 0.524), "min + (max − min) × n");
  assert.equal(f.angleUpdates().length, 1, "raised at once (0x005fb3a0 → 0x005fa910)");
  close(f.angleUpdates()[0][0], 0.5, "normalised");
  close(f.angleUpdates()[0][1], f.input.pitch, "and the pitch");
  f.poll();
  assert.equal(f.angleUpdates().length, 1, "the poll does not raise the same pitch again");

  f.call("VehicleAimRequestAngle", 9);
  close(f.input.pitch, 0.785, "the band holds it");
  close(f.angleUpdates()[1][0], 1, "at the top");
  f.call("VehicleAimRequestAngle", "x");
  assert.equal(f.input.sets.length, 2, "not a number: nothing");

  f.call("VehicleAimDecrement");
  close(f.input.pitch, 0.685, "0.1 without an argument (0x009e3004)");
  f.call("VehicleAimDecrement", "0.25");
  close(f.input.pitch, 0.435, "a string that reads as a number counts (lua_isnumber)");
  f.call("VehicleAimIncrement", 0.05);
  close(f.input.pitch, 0.485, "Increment adds");
  assert.equal(f.angleUpdates().length, 5);

  for (const name of ["VehicleAimUpStart", "VehicleAimUpStop", "VehicleAimDownStart", "VehicleAimDownStop"]) f.call(name);
  assert.deepEqual(f.input.keys, [["up", true], ["up", false], ["down", true], ["down", false]], "PitchUp/Down Start/Stop");

  // The keys pitch it frame by frame: the poll raises the event when the pitch moved.
  f.input.pitch = 0.3;
  f.poll();
  assert.equal(f.angleUpdates().length, 6);
  close(f.angleUpdates()[5][1], 0.3, "the moved pitch");
  f.poll();
  assert.equal(f.angleUpdates().length, 6, "still: nothing");
});

test("11.02-E: no ADJUST_AIM_ANGLE, the turret's FULL_SPEED_PITCHING, on foot, a mover change", () => {
  const f = fixture();
  f.attach();
  f.drive(ENGINE);
  f.poll();
  f.fired.length = 0;
  f.call("VehicleAimRequestAngle", 0.4);
  f.call("VehicleAimRequestNormAngle", 0.4);
  assert.deepEqual(f.input.sets, [], "the siege engine's row has no 0x400: neither request reaches the pitch");
  f.call("VehicleAimIncrement", 0.2);
  assert.deepEqual(f.input.sets, [0.2], "Increment has no flag test (0x005fb4b0); the engine itself does not pitch");
  assert.deepEqual(f.angleUpdates(), []);

  f.drive(CART);
  f.poll();
  f.fired.length = 0;
  f.call("VehicleAimIncrement", 0.3);
  close(f.input.pitch, 0.3, "a pitching vehicle without the aim takes the step");
  f.poll();
  assert.deepEqual(f.angleUpdates(), [], "no 0x400, no FULL_SPEED_PITCHING: no event now and none from the poll");

  f.drive(GUN);
  f.poll();
  f.fired.length = 0;
  f.call("VehicleAimRequestNormAngle", 0.25);
  close(f.input.pitch, -0.524 + 0.25 * (0.785 + 0.524), "set");
  assert.deepEqual(f.angleUpdates(), [], "FULL_SPEED_PITCHING: 0x005fb3a0 takes the other path, no event at once");
  f.poll();
  assert.equal(f.angleUpdates().length, 1, "the poll raises it (Wow.exe: 0x005fb510 once the pitch is applied)");
  close(f.angleUpdates()[0][0], 0.25, "normalised");
  f.poll();
  assert.equal(f.angleUpdates().length, 1);

  const g = fixture();
  g.attach();
  g.poll();
  g.input.pitch = 0.4;
  g.poll();
  assert.deepEqual(g.angleUpdates(), [], "a swimmer's pitch: no vehicle row, no event");
  g.call("VehicleAimIncrement");
  assert.deepEqual(g.input.sets, [0.5], "asked; the movement code refuses a mover that is not a vehicle");
  close(g.call("VehicleAimGetAngle")[0], 0.4, "the character is its own aimer");
  close(g.call("VehicleAimGetNormAngle")[0], (0.4 + Math.PI / 2) / Math.PI, "over ±π/2 without a row");

  g.drive(GUN);
  g.input.pitch = 0.1;
  g.fired.length = 0;
  g.poll();
  assert.equal(g.angleUpdates().length, 1, "a mover change: FrameXmlVehicle.ts's VEHICLE_UPDATE batch, not a second one here");
});

test("11.02-E: the power — one global, clamped, set only with an aimer (0x005f9550, 0x005f9f10)", () => {
  setVehicleAimPower(0);
  const f = fixture();
  f.attach();
  f.drive(GUN);
  assert.deepEqual(f.call("VehicleAimGetNormPower"), [0], ".bss: 0 until set");
  f.call("VehicleAimSetNormPower", 0.3);
  assert.deepEqual(f.call("VehicleAimGetNormPower"), [0.3]);
  f.call("VehicleAimSetNormPower", 7);
  assert.equal(vehicleAimPower(), 1, "1 and above → 1");
  f.call("VehicleAimSetNormPower", -2);
  assert.equal(vehicleAimPower(), 0, "below 0 → 0");
  f.call("VehicleAimSetNormPower", 0.6);
  f.objects.delete(SELF);
  f.call("VehicleAimSetNormPower", 0.9);
  assert.equal(vehicleAimPower(), 0.6, "no aimer in view: unchanged");
  assert.equal(normalizedVehiclePitch(undefined, 0), 0.5);
  setVehicleAimPower(0);
  registerVehicleAimInput(undefined);
});
