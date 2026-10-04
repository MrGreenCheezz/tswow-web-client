import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

// 11.02-F2: vehicles in the stock UI — the C API and the events of world/VehicleUi.ts and
// browser/framexml/FrameXmlVehicle.ts over the live seam, as Wow.exe 3.3.5a 12340 answers and raises
// them (Ghidra, .runtime/re-2026-10-03/l1102f2 and l1102f1): UnitHasVehicleUI 0x00613740 …
// UnitVehicleSeatInfo 0x006138c0, GetVehicleUIIndicator(Seat) 0x00614e60/0x00614ef0, CanExitVehicle
// 0x005fb9c0, VehicleExit 0x005fb660, VehiclePrev/NextSeat 0x005fb6d0/0x005fb720, UnitSwitchToVehicleSeat
// 0x006139b0 → 0x0074ca90, Can/EjectPassengerFromSeat 0x00613d20/0x00613e10, IsUsingVehicleControls
// 0x005fb970, IsVehicleAimAngle/PowerAdjustable 0x005f9f70/0x005f9fe0; UNIT_ENTERING/ENTERED_VEHICLE
// 0x00748810, UNIT_EXITING/EXITED_VEHICLE 0x00749650 by 0x00749fb0's state table, the party path
// 0x006cf740, VEHICLE_PASSENGERS_CHANGED 0x0074ad70, PLAYER_GAINS/LOSES_VEHICLE_DATA 0x0074bbd0/0x0074bc50,
// VEHICLE_UPDATE 0x00747f40 with 0x0074c5a0's SHOW/UPDATE events; the vehicle's bar on the main bar
// (0x005d4ad0's VehicleAbilityDisplay branch). Synthetic rows shaped like the dataset's siege engine 117
// with its turret 116 and a player's mammoth 312, then the real tables when the dataset is here.

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FrameXmlVehicleModel, frameXmlVehicleLive, FRAMEXML_VEHICLE_PRELUDE } = await import("../dist/code/browser/framexml/FrameXmlVehicle.js");
const {
  vehicleBarOnMainBar, vehicleEnterArgs, passengerEnterArgs, vehiclePassengersSignature, switchableVehicleSeat,
  ejectableOccupant, isUsingVehicleControls, isVehicleAimPowerAdjustable, vehicleAimEvents, passengerSeatOf,
  VEHICLE_ABILITY_DISPLAY_MAIN_BAR,
} = await import("../dist/code/world/VehicleUi.js");
const {
  VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_COLUMN, VEHICLE_SEAT_FORMAT, vehicleCatalogFrom,
} = await import("../dist/code/world/VehicleDbc.js");
const { VEHICLE_FLAGS, VEHICLE_SEAT_FLAGS } = await import("../dist/code/world/VehicleSeatModel.js");
const { packPetAction, REACT_DEFENSIVE, COMMAND_FOLLOW } = await import("../dist/code/world/PetProtocol.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const F = VEHICLE_SEAT_FLAGS;

function vehicleRow({ id, flags = 0, seats = [], indicator = 0, pitchMin = 0, pitchMax = 0 }) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  row[VEHICLE_COLUMN.Flags] = flags;
  row[VEHICLE_COLUMN.PitchMin] = pitchMin;
  row[VEHICLE_COLUMN.PitchMax] = pitchMax;
  seats.forEach((seat, slot) => { row[VEHICLE_COLUMN.SeatID + slot] = seat; });
  row[VEHICLE_COLUMN.VehicleUIIndicatorID] = indicator;
  return row;
}

function seatRow({ id, flags = 0, flagsB = 0, uiSkin = 0, ability = 1 }) {
  const row = [...VEHICLE_SEAT_FORMAT].map(() => 0);
  row[VEHICLE_SEAT_COLUMN.ID] = id;
  row[VEHICLE_SEAT_COLUMN.Flags] = flags;
  row[VEHICLE_SEAT_COLUMN.FlagsB] = flagsB;
  row[VEHICLE_SEAT_COLUMN.UiSkin] = uiSkin;
  row[VEHICLE_SEAT_COLUMN.VehicleAbilityDisplay] = ability;
  return row;
}

// The dataset's own words (probed from VehicleSeat.dbc / Vehicle.dbc): siege engine 117 (flags 0x5018f027:
// no ADJUST_AIM_*), seats 1648 driver (0x67108a0b, UiSkin 1), 1649/1650 passengers (0x4710820b, no
// CAN_CAST), slot 7 → turret 116 (0x471cf677: ADJUST_AIM_ANGLE) with gunner 1643 (0x67100a0f, UiSkin 1);
// indicator 223; the mammoth 312 a player rides as its kit, riders 2764/2765 (FlagsB 0x40000030: EJECTABLE).
const SIEGE = 117;
const TURRET = 116;
const MAMMOTH = 312;
const QUIET_CART = 901;
const FLAT_CART = 902;
const ANSWER = {
  version: VEHICLE_CATALOG_VERSION,
  vehicles: [
    vehicleRow({ id: SIEGE, flags: 0x5018f027, seats: [1648, 1649, 1650, 0, 0, 0, 0, 1652], indicator: 223 }),
    vehicleRow({ id: TURRET, flags: 0x471cf677, seats: [1643], indicator: 223 }),
    vehicleRow({ id: MAMMOTH, flags: 0x40000000, seats: [0, 2764, 2765], indicator: 225 }),
    vehicleRow({ id: FLAT_CART, flags: VEHICLE_FLAGS.CUSTOM_PITCH, seats: [9011], pitchMin: 0.3, pitchMax: 0.3 }),
    vehicleRow({ id: QUIET_CART, flags: VEHICLE_FLAGS.CUSTOM_PITCH | VEHICLE_FLAGS.ADJUST_AIM_POWER, seats: [9010], pitchMin: -0.5, pitchMax: 1.5 }),
  ],
  seats: [
    seatRow({ id: 1648, flags: 0x67108a0b, flagsB: 0x10, uiSkin: 1 }),
    seatRow({ id: 1649, flags: 0x4710820b, flagsB: 0x10 }),
    seatRow({ id: 1650, flags: 0x4710820b, flagsB: 0x10 }),
    seatRow({ id: 1652, flags: 0x3006408, flagsB: 0x280014 }),
    seatRow({ id: 1643, flags: 0x67100a0f, flagsB: 0x80011, uiSkin: 1 }),
    seatRow({ id: 2764, flags: 0xde00800b, flagsB: 0x40000030 }),
    seatRow({ id: 2765, flags: 0xde00800b, flagsB: 0x40000030 }),
    // A driver's seat whose abilities stay on the pet bar (VehicleAbilityDisplay 0; 18 dataset seats), and
    // one with IS_USING_VEHICLE_CONTROLS and the TARGETS_IN_RAIDUI bit.
    seatRow({ id: 9010, flags: F.CAN_CONTROL | F.CAN_CAST | 0x0080_0000, flagsB: 0x8, uiSkin: -1, ability: 0 }),
    // A seat with the vehicle UI but no control (a gunner of a vehicle that is not an accessory).
    seatRow({ id: 9011, flags: F.CAN_CAST }),
  ],
  indicators: [[223, "Interface\\Vehicles\\SeatIndicator\\Vehicle-SiegeEngine.blp"], [225, "Interface\\Vehicles\\SeatIndicator\\vehicle-mammoth.blp"]],
  indicatorSeats: [[229, 223, 4, 0.5, 0.578], [226, 223, 1, 0.501, 0.14], [228, 223, 3, 0.303, 0.799], [227, 223, 2, 0.698, 0.799],
    [231, 225, 1, 0.348, 0.76], [232, 225, 2, 0.652, 0.76]],
};
const catalog = vehicleCatalogFrom(ANSWER);

const SELF = 0x10n;
const FRIEND = 0x11n;
const ENGINE = 0xf150_0074_9800_0101n;
const GUN = 0xf150_0074_9800_0102n;
const CART = 0xf150_0385_0000_0103n;
const SHIP = 0x1fc0_0000_0000_0104n;
const FIELD = (name) => UPDATE_FIELDS[name].offset;
const CHARM = FIELD("UNIT_FIELD_CHARM");
const FARSIGHT = FIELD("PLAYER_FARSIGHT");
const HEALTH = FIELD("UNIT_FIELD_HEALTH");

function setGuid(object, offset, guid) {
  object.fields.set(offset, Number(guid & 0xffff_ffffn));
  object.fields.set(offset + 1, Number(guid >> 32n));
}

function unit(guid, { typeId = 3, vehicleId, carrier, seat = 0, health = 100 } = {}) {
  return {
    guid, typeId, vehicleId, movementFlags: 0, updateFlags: 0,
    position: { x: 0, y: 0, z: 0, orientation: 0 },
    transport: carrier === undefined ? undefined : { guid: carrier, x: 0, y: 0, z: 0, orientation: 0, seat },
    fields: new Map([[HEALTH, health]]),
  };
}

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    let listeners = this.#listeners.get(name);
    if (!listeners) { listeners = new Set(); this.#listeners.set(name, listeners); }
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  emit(name, payload) { for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload); }
}

/** The live seam over a fake WorldClient: a character beside a siege engine with its turret. */
/** `fixture({ tables: NO_TABLES })`: a page whose /dbc/vehicles never landed. */
const NO_TABLES = Symbol("no tables");

function fixture({ tables = catalog } = {}) {
  const objects = new Map();
  const player = unit(SELF, { typeId: 4 });
  const engine = unit(ENGINE, { vehicleId: SIEGE });
  const gun = unit(GUN, { vehicleId: TURRET, carrier: ENGINE, seat: 7 });
  for (const object of [player, engine, gun]) objects.set(object.guid, object);
  const calls = [];
  const world = {
    state: { selfGuid: SELF, objects, revision: 1 },
    events: new FakeEvents(),
    movementReady: true,
    controlledGuid: SELF,
    controlRefusedGuid: undefined,
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
    names: new Map([[SELF, "Водитель"], [FRIEND, "Друг"]]),
    selfName: "Водитель",
    creatureTemplates: new Map(),
    totems: new Map(),
    leaveVehicle() { calls.push(["leaveVehicle"]); },
    changeVehicleSeat(next) { calls.push(["changeVehicleSeat", next]); },
    takeVehicleSeat(vehicle, seat) { calls.push(["takeVehicleSeat", vehicle, seat]); },
    ejectPassenger(guid) { calls.push(["ejectPassenger", guid]); },
    usePetSlot(slot, target) { calls.push(["usePetSlot", slot, target]); },
  };
  const fired = [];
  let now = 0;
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => now };
  const store = { field: (_subject, _name, _listener) => () => {} };
  let held = tables === NO_TABLES ? undefined : tables;
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store, spell: () => undefined,
    monotonic: () => now * 1000, globalCooldownUntil: () => 0, castSpell: () => {},
    vehicles: () => held,
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  return {
    seam, world, objects, player, engine, gun, fired, pump, call, calls,
    /** The seam's attach: a UI load or a reload. */
    attach() { seam.attach(pump); },
    setTables(next) { held = next; },
    poll() { now += 0.1; world.state.revision += 1; seam.tick(now); },
    sit(guid, carrier, seat) { objects.get(guid).transport = { guid: carrier, x: 0, y: 0, z: 0, orientation: 0, seat }; },
    stand(guid) { objects.get(guid).transport = undefined; },
  };
}

const VEHICLE_EVENTS = new Set([
  "UNIT_ENTERING_VEHICLE", "UNIT_ENTERED_VEHICLE", "UNIT_EXITING_VEHICLE", "UNIT_EXITED_VEHICLE",
  "VEHICLE_PASSENGERS_CHANGED", "PLAYER_GAINS_VEHICLE_DATA", "PLAYER_LOSES_VEHICLE_DATA", "VEHICLE_UPDATE",
  "VEHICLE_ANGLE_SHOW", "VEHICLE_POWER_SHOW", "VEHICLE_ANGLE_UPDATE", "UI_ERROR_MESSAGE",
]);
const vehicleEvents = (fired) => fired.filter(([name]) => VEHICLE_EVENTS.has(name));
const DRIVER_ARGS = [true, "Mechanical", "", true, 223];

// ---- the rules (world/VehicleUi.ts) -------------------------------------------------------------

test("11.02-F2: the vehicle's bar on the main bar follows the rider's VehicleAbilityDisplay (0x005d4ad0)", () => {
  const objects = new Map([[SELF, unit(SELF, { typeId: 4, carrier: ENGINE, seat: 0 })], [ENGINE, unit(ENGINE, { vehicleId: SIEGE })],
    [CART, unit(CART, { vehicleId: QUIET_CART })]]);
  const bar = (guid) => ({ guid, closed: false, bar: [{ slot: 0, packed: packPetAction(62345, 8), action: 62345, type: 8 }] });
  assert.equal(VEHICLE_ABILITY_DISPLAY_MAIN_BAR, 1);
  assert.equal(vehicleBarOnMainBar(catalog, objects, SELF, ENGINE, bar(ENGINE), true), true, "seat 1648: VehicleAbilityDisplay 1");
  assert.equal(vehicleBarOnMainBar(undefined, objects, SELF, ENGINE, bar(ENGINE), true), false, "no tables: as before F2");
  assert.equal(vehicleBarOnMainBar(catalog, objects, SELF, undefined, bar(ENGINE), true), false, "no far sight");
  assert.equal(vehicleBarOnMainBar(catalog, objects, SELF, CART, bar(ENGINE), true), false, "the far sight is another unit");
  assert.equal(vehicleBarOnMainBar(catalog, objects, SELF, ENGINE, { ...bar(ENGINE), closed: true }, true), false);
  assert.equal(vehicleBarOnMainBar(catalog, objects, SELF, ENGINE, bar(ENGINE), false), false, "0x005d35b0 refuses the unit");
  objects.get(SELF).transport = { guid: CART, x: 0, y: 0, z: 0, orientation: 0, seat: 0 };
  assert.equal(vehicleBarOnMainBar(catalog, objects, SELF, CART, bar(CART), true), false, "seat 9010: VehicleAbilityDisplay 0 keeps it off");
  objects.get(SELF).transport = { guid: CART, x: 0, y: 0, z: 0, orientation: 0, seat: 5 };
  assert.equal(vehicleBarOnMainBar(catalog, objects, SELF, CART, bar(CART), true), true, "no row for the seat byte: as possession");
  objects.get(SELF).transport = undefined;
  assert.equal(vehicleBarOnMainBar(catalog, objects, SELF, CART, bar(CART), true), true, "not riding the bar's unit: as possession");
});

test("11.02-F2: the enter arguments, the passengers' signature and the seat gates (0x00748810, 0x0074ca90, 0x00613e10)", () => {
  assert.deepEqual(vehicleEnterArgs(catalog.seat(1648), 223), DRIVER_ARGS, "CAN_CAST, skin 1 = Mechanical, no sound name, CAN_CONTROL, indicator");
  assert.deepEqual(vehicleEnterArgs(catalog.seat(1649), 223), [false, "Natural", "", false, 223]);
  assert.deepEqual(vehicleEnterArgs(undefined, 0), [false, "", "", false, 0], "no seat row");
  assert.deepEqual(vehicleEnterArgs(catalog.seat(9010), 0), [true, "", "", true, 0], "UiSkin -1: an empty skin");
  assert.deepEqual(vehicleEnterArgs(catalog.seat(9011), 7), [true, "Natural", "", false, 7], "CAN_CAST without CAN_CONTROL");
  const objects = new Map([[SELF, unit(SELF, { typeId: 4, carrier: ENGINE, seat: 1 })], [ENGINE, unit(ENGINE, { vehicleId: SIEGE })],
    [GUN, unit(GUN, { vehicleId: TURRET, carrier: ENGINE, seat: 7 })], [FRIEND, unit(FRIEND, { typeId: 4, carrier: ENGINE, seat: 0 })]]);
  assert.deepEqual(passengerSeatOf(objects, SELF), { vehicleGuid: ENGINE, slot: 1 });
  assert.equal(passengerSeatOf(new Map([[SELF, unit(SELF, { typeId: 4, carrier: SHIP })]]), SELF), undefined, "a ship is no vehicle");
  assert.deepEqual(passengerEnterArgs(catalog, objects, { vehicleGuid: GUN, slot: 0 }), [true, "Mechanical", "", true, 223]);
  const before = vehiclePassengersSignature(catalog, objects, SELF);
  assert.equal(typeof before, "string");
  objects.get(FRIEND).transport.seat = 2;
  assert.notEqual(vehiclePassengersSignature(catalog, objects, SELF), before, "a passenger moved seat");
  assert.equal(vehiclePassengersSignature(catalog, new Map([[SELF, unit(SELF, { typeId: 4 })]]), SELF), undefined, "on foot");
  // UnitSwitchToVehicleSeat with the friend now at slot 2: seat 1 (slot 0) free, seat 2 the character's own,
  // seat 3 the friend's, seat 4 the turret's free gunner seat.
  assert.equal(switchableVehicleSeat(catalog, objects, SELF, 3), undefined, "taken by the friend");
  assert.deepEqual(switchableVehicleSeat(catalog, objects, SELF, 1), { vehicleGuid: ENGINE, slot: 0, occupantGuid: undefined });
  assert.deepEqual(switchableVehicleSeat(catalog, objects, SELF, 4), { vehicleGuid: GUN, slot: 0, occupantGuid: undefined });
  assert.equal(switchableVehicleSeat(catalog, objects, SELF, 2), undefined, "the character's own seat is taken");
  assert.equal(switchableVehicleSeat(catalog, objects, SELF, 9), undefined, "no such seat");
  assert.equal(switchableVehicleSeat(catalog, objects, FRIEND + 100n, 1), undefined, "not seated");
  // The character's own seat without CAN_SWITCH (1652's slot is the turret's, so use a seat word copy).
  const stuck = vehicleCatalogFrom({ ...ANSWER, seats: ANSWER.seats.map((row) => (row[0] === 1649 ? seatRow({ id: 1649, flags: F.CAN_ENTER_OR_EXIT }) : row)) });
  assert.equal(switchableVehicleSeat(stuck, objects, SELF, 1), undefined, "0x005fb560(CAN_SWITCH) on the character's seat");
  const cant = vehicleCatalogFrom({ ...ANSWER, seats: ANSWER.seats.map((row) => (row[0] === 1648 ? seatRow({ id: 1648, flags: F.CAN_CONTROL }) : row)) });
  assert.equal(switchableVehicleSeat(cant, objects, SELF, 1), undefined, "the target seat without CAN_SWITCH");
  assert.equal(ejectableOccupant(catalog, objects, SELF, 3), FRIEND);
  assert.equal(ejectableOccupant(catalog, objects, SELF, 1), undefined, "an empty seat");
});

test("11.02-F2: IsUsingVehicleControls, IsVehicleAimPowerAdjustable and the aim events after VEHICLE_UPDATE (0x0074c5a0)", () => {
  const objects = new Map([[SELF, unit(SELF, { typeId: 4, carrier: CART, seat: 0 })], [CART, unit(CART, { vehicleId: QUIET_CART })],
    [ENGINE, unit(ENGINE, { vehicleId: SIEGE })], [GUN, unit(GUN, { vehicleId: TURRET })]]);
  assert.equal(isUsingVehicleControls(catalog, objects, SELF), true, "seat 9010: IS_USING_VEHICLE_CONTROLS 0x00800000");
  assert.equal(isVehicleAimPowerAdjustable(catalog, objects, SELF), true, "the driven cart: ADJUST_AIM_POWER");
  objects.get(SELF).transport = { guid: ENGINE, x: 0, y: 0, z: 0, orientation: 0, seat: 0 };
  assert.equal(isUsingVehicleControls(catalog, objects, SELF), false);
  assert.equal(isVehicleAimPowerAdjustable(catalog, objects, SELF), false);
  assert.deepEqual(vehicleAimEvents(catalog, undefined), [["VEHICLE_ANGLE_SHOW"], ["VEHICLE_POWER_SHOW"]], "no mover in view");
  assert.deepEqual(vehicleAimEvents(catalog, objects.get(SELF)), [["VEHICLE_ANGLE_SHOW"], ["VEHICLE_POWER_SHOW"]], "a mover without a kit");
  assert.deepEqual(vehicleAimEvents(catalog, objects.get(ENGINE)),
    [["VEHICLE_ANGLE_SHOW"], ["VEHICLE_POWER_SHOW"], ["VEHICLE_ANGLE_UPDATE", 0.5, 0]], "±π/2 without CUSTOM_PITCH: pitch 0 is the middle");
  assert.deepEqual(vehicleAimEvents(catalog, objects.get(GUN)).slice(0, 2), [["VEHICLE_ANGLE_SHOW", 1], ["VEHICLE_POWER_SHOW"]]);
  objects.get(CART).pitch = 0.5;
  assert.deepEqual(vehicleAimEvents(catalog, objects.get(CART)),
    [["VEHICLE_ANGLE_SHOW"], ["VEHICLE_POWER_SHOW", 1], ["VEHICLE_ANGLE_UPDATE", 0.5, 0.5]], "CUSTOM_PITCH: over [PitchMin, PitchMax]");
  const flat = unit(0xf150_0386_0000_0104n, { vehicleId: FLAT_CART });
  flat.pitch = 0.3;
  assert.deepEqual(vehicleAimEvents(catalog, flat).at(-1), ["VEHICLE_ANGLE_UPDATE", 0, 0.3], "a span under 1e-4: 0 (0x009e8cd0)");
});

// ---- the C API over the live seam -----------------------------------------------------------------

test("11.02-F2: the driver of a siege engine — every C function the stock vehicle UI asks", () => {
  const f = fixture();
  f.sit(SELF, ENGINE, 0);
  setGuid(f.player, CHARM, ENGINE);
  f.world.controlledGuid = ENGINE;
  assert.deepEqual(f.call("UnitHasVehicleUI", "player"), [true]);
  assert.deepEqual(f.call("UnitHasVehicleUI", "PLAYER"), [true], "tokens are case-insensitive");
  assert.deepEqual(f.call("UnitInVehicle", "player"), [1]);
  assert.deepEqual(f.call("UnitUsingVehicle", "player"), [1]);
  assert.deepEqual(f.call("UnitControllingVehicle", "player"), [true], "UNIT_FIELD_CHARM is the vehicle (0x00613570)");
  assert.deepEqual(f.call("UnitInVehicleControlSeat", "player"), [true]);
  assert.deepEqual(f.call("UnitTargetsVehicleInRaidUI", "player"), [false]);
  assert.deepEqual(f.call("UnitVehicleSkin", "player"), ["Mechanical"]);
  assert.deepEqual(f.call("UnitVehicleSeatCount", "player"), [4], "three seats of 117 and the turret's one");
  assert.deepEqual(f.call("UnitVehicleSeatInfo", "player", 1), ["Root", "Водитель", undefined, false, true]);
  assert.deepEqual(f.call("UnitVehicleSeatInfo", "player", 2.9), ["None", undefined, undefined, false, true], "the index is truncated");
  assert.deepEqual(f.call("UnitVehicleSeatInfo", "player", 4), ["Child", undefined, undefined, false, true], "the turret's gunner seat");
  assert.deepEqual(f.call("UnitVehicleSeatInfo", "player", 5), []);
  assert.deepEqual(f.call("UnitVehicleSeatInfo", "player", "x"), []);
  assert.deepEqual(f.call("GetVehicleUIIndicator", 223), ["Interface\\Vehicles\\SeatIndicator\\Vehicle-SiegeEngine.blp", 4]);
  assert.deepEqual(f.call("GetVehicleUIIndicator", 224), [], "no row");
  assert.deepEqual(f.call("GetVehicleUIIndicatorSeat", 223, 2), [2, 0.698, 0.799], "by ascending row id");
  assert.deepEqual(f.call("GetVehicleUIIndicatorSeat", "223", "1"), [1, 0.501, 0.14], "numeric strings are numbers");
  assert.deepEqual(f.call("GetVehicleUIIndicatorSeat", 223, 5), []);
  assert.throws(() => f.call("GetVehicleUIIndicator"), /Usage: GetVehicleUIIndicator\(indicatorID\)/);
  assert.throws(() => f.call("GetVehicleUIIndicatorSeat", 223), /Usage: GetVehicleUIIndicatorSeat/);
  assert.deepEqual(f.call("CanExitVehicle"), [1], "1648 has CAN_ENTER_OR_EXIT");
  assert.deepEqual(f.call("CanSwitchVehicleSeats"), [1]);
  assert.deepEqual(f.call("CanSwitchVehicleSeat"), [true]);
  assert.deepEqual(f.call("IsUsingVehicleControls"), []);
  assert.deepEqual(f.call("IsVehicleAimAngleAdjustable"), [], "117 has no ADJUST_AIM_ANGLE");
  assert.deepEqual(f.call("IsVehicleAimPowerAdjustable"), []);
  assert.deepEqual(f.call("CanEjectPassengerFromSeat", 1), [false], "the driver is not a passenger of its own seat");
  assert.throws(() => f.call("CanEjectPassengerFromSeat"), /Usage: CanEjectPassengerFromSeat\(seatIndex\)/);
  assert.throws(() => f.call("UnitInVehicle"), /Usage: UnitInVehicle\("unit"\)/);
  assert.throws(() => f.call("UnitUsingVehicle", {}), /Usage: UnitUsingVehicle\("unit"\)/);
  // The gunner's seat: the turret's ADJUST_AIM_ANGLE is the aim (0x005f9d20: the driven vehicle).
  f.sit(SELF, GUN, 0);
  assert.deepEqual(f.call("IsVehicleAimAngleAdjustable"), [1]);
  assert.deepEqual(f.call("UnitVehicleSeatInfo", "player", 4), ["Child", "Водитель", undefined, false, true]);
  assert.deepEqual(f.call("UnitVehicleSeatCount", "player"), [4], "the root's seats from the accessory too");
});

test("11.02-F2: a passenger — no vehicle UI, a free seat to switch to, the step keys and the exit gate", () => {
  const f = fixture();
  f.objects.set(FRIEND, unit(FRIEND, { typeId: 4, carrier: ENGINE, seat: 0 }));
  f.sit(SELF, ENGINE, 1);
  assert.deepEqual(f.call("UnitHasVehicleUI", "player"), [false], "1649 has no CAN_CAST");
  assert.deepEqual(f.call("UnitVehicleSkin", "player"), ["Natural"]);
  assert.deepEqual(f.call("UnitControllingVehicle", "player"), [false]);
  assert.deepEqual(f.call("UnitVehicleSeatInfo", "player", 1), ["Root", "Друг", undefined, false, true]);
  f.world.targetGuid = FRIEND;
  f.call("UnitSwitchToVehicleSeat", "player", 1);
  f.call("UnitSwitchToVehicleSeat", "player", 2);
  f.call("UnitSwitchToVehicleSeat", "target", 3);
  assert.deepEqual(f.calls, [], "taken, own, and not the character (0x006139b0: the unit must be the active player)");
  // A passenger whose name the client does not know yet still occupies the seat: `false` from the host,
  // UNKNOWNOBJECT in Lua (FRAMEXML_VEHICLE_PRELUDE).
  f.objects.set(0x13n, unit(0x13n, { typeId: 4, carrier: GUN, seat: 0 }));
  assert.deepEqual(f.call("UnitVehicleSeatInfo", "player", 4).slice(0, 2), ["Child", false]);
  assert.match(FRAMEXML_VEHICLE_PRELUDE, /if occupant == false then occupant = UNKNOWNOBJECT end/);
  f.objects.delete(0x13n);
  f.call("UnitSwitchToVehicleSeat", "player", 3);
  f.call("UnitSwitchToVehicleSeat", "player", 4);
  assert.deepEqual(f.calls, [["takeVehicleSeat", ENGINE, 2], ["takeVehicleSeat", GUN, 0]], "the slot's own vehicle and byte");
  f.calls.length = 0;
  f.call("VehiclePrevSeat");
  f.call("VehicleNextSeat");
  assert.deepEqual(f.calls, [["changeVehicleSeat", false], ["changeVehicleSeat", true]]);
  // The chat API's VehicleExit asks the attached seam's model; the seam's own host name stands in before it.
  f.attach();
  assert.equal(frameXmlVehicleLive()?.active, true);
  f.calls.length = 0;
  f.call("WebClientVehicleExit");
  assert.deepEqual(f.calls, [["leaveVehicle"]]);
  f.seam.detach();
  assert.equal(frameXmlVehicleLive(), undefined, "detach unregisters");
  assert.match(FRAMEXML_VEHICLE_PRELUDE, /rawget\(_G, "VehicleExit"\) == nil/);
});

test("11.02-F2: seats without the gates — no exit, no switching; the UI error instead (0x005fb660)", () => {
  const locked = vehicleCatalogFrom({
    ...ANSWER,
    seats: ANSWER.seats.map((row) => (row[0] === 1648 ? seatRow({ id: 1648, flags: F.CAN_CONTROL | F.CAN_CAST, uiSkin: 1 }) : row)),
  });
  const f = fixture({ tables: locked });
  f.sit(SELF, ENGINE, 0);
  f.attach();
  assert.deepEqual(f.call("CanExitVehicle"), []);
  assert.deepEqual(f.call("CanSwitchVehicleSeats"), []);
  assert.deepEqual(f.call("CanSwitchVehicleSeat"), [false]);
  f.call("VehiclePrevSeat");
  f.call("VehicleNextSeat");
  f.call("UnitSwitchToVehicleSeat", "player", 2);
  f.call("WebClientVehicleExit");
  assert.deepEqual(f.calls, [], "nothing sent");
  assert.deepEqual(vehicleEvents(f.fired), [["UI_ERROR_MESSAGE", "Вы пока не можете этого сделать."]],
    "SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW");
  f.seam.detach();
});

test("11.02-F2: a player's mammoth — its riders can be ejected (0x00613d20, 0x00613e10)", () => {
  const f = fixture();
  f.player.vehicleId = MAMMOTH;
  f.objects.set(FRIEND, unit(FRIEND, { typeId: 4, carrier: SELF, seat: 1 }));
  assert.deepEqual(f.call("UnitVehicleSeatCount", "player"), [2], "slot 0 has no seat");
  assert.deepEqual([f.call("UnitInVehicle", "player"), f.call("UnitUsingVehicle", "player"), f.call("UnitControllingVehicle", "player")],
    [[], [], [false]], "the vehicle itself rides nothing: nil, nil, false");
  assert.deepEqual(f.call("UnitInVehicle", "party1"), [], "no such unit");
  assert.deepEqual(f.call("UnitVehicleSeatInfo", "player", 1), ["None", "Друг", undefined, true, true],
    "0xde00800b: no CAN_CONTROL, CAN_SWITCH; FlagsB EJECTABLE");
  assert.deepEqual(f.call("CanEjectPassengerFromSeat", 1), [true]);
  assert.deepEqual(f.call("CanEjectPassengerFromSeat", 2), [false], "empty");
  f.call("EjectPassengerFromSeat", 2);
  f.call("EjectPassengerFromSeat", 1);
  assert.deepEqual(f.calls, [["ejectPassenger", FRIEND]]);
  assert.throws(() => f.call("EjectPassengerFromSeat"), /Usage: EjectPassengerFromSeat\(seatIndex\)/);
});

test("11.02-F2: without the vehicle tables every name answers as before (no seat is known)", () => {
  const f = fixture({ tables: NO_TABLES });
  f.sit(SELF, ENGINE, 0);
  assert.deepEqual(f.call("UnitHasVehicleUI", "player"), [false], "the neutral answer");
  assert.deepEqual(f.call("UnitInVehicle", "player"), [false], "the neutral answer");
  assert.deepEqual(f.call("UnitInVehicle"), [false], "and no usage error");
  for (const name of ["UnitUsingVehicle", "UnitControllingVehicle", "UnitVehicleSkin", "UnitVehicleSeatCount", "CanExitVehicle",
    "CanSwitchVehicleSeats", "CanSwitchVehicleSeat", "IsUsingVehicleControls", "IsVehicleAimAngleAdjustable",
    "IsVehicleAimPowerAdjustable", "GetVehicleUIIndicator", "GetVehicleUIIndicatorSeat", "CanEjectPassengerFromSeat"]) {
    assert.deepEqual(f.call(name, "player", 1), [], `${name}: the stub floor's nothing`);
  }
  assert.deepEqual(f.call("UnitVehicleSeatInfo", "player", 1), []);
  for (const name of ["VehiclePrevSeat", "VehicleNextSeat", "UnitSwitchToVehicleSeat", "EjectPassengerFromSeat", "WebClientVehicleExit"]) {
    f.call(name, "player", 1);
  }
  assert.deepEqual(f.calls, [], "nothing sent");
  assert.equal(f.seam.unitGuid("vehicle"), undefined, "the vehicle token: the guid-only answer (no vehicle bar)");
  f.setTables(catalog);
  assert.notEqual(f.seam.unitGuid("vehicle"), undefined, "with the tables: the vehicle the character rides (0x0060abf0)");
  f.setTables(undefined);
  // A seam without the model (the canned world) is the same.
  const canned = {};
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.UnitHasVehicleUI(canned, ["player"]), [false]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.UnitVehicleSkin(canned, ["player"]), []);
});

test("11.02-F2: a party member out of view answers from its stats' VehicleSeat (0x00613600)", () => {
  const f = fixture();
  f.world.group = { groupType: 0, members: [{ guid: FRIEND, name: "Друг" }] };
  f.world.partyStats.set(FRIEND, { guid: FRIEND, flags: 0x80000, vehicleSeat: 1648 });
  assert.deepEqual(f.call("UnitHasVehicleUI", "party1"), [true]);
  assert.deepEqual(f.call("UnitVehicleSkin", "party1"), ["Mechanical"]);
  assert.deepEqual(f.call("UnitInVehicleControlSeat", "party1"), [true]);
  f.world.partyStats.set(FRIEND, { guid: FRIEND, flags: 0x80000, vehicleSeat: 9010 });
  assert.deepEqual(f.call("UnitTargetsVehicleInRaidUI", "party1"), [true], "FlagsB 0x8");
  // In view, the object's own transport wins: standing, no seat.
  f.objects.set(FRIEND, unit(FRIEND, { typeId: 4 }));
  assert.deepEqual(f.call("UnitHasVehicleUI", "party1"), [false]);
});

// ---- the events ---------------------------------------------------------------------------------

test("11.02-F2: entering, switching and leaving as the driver — the events in Wow.exe's order", () => {
  const f = fixture();
  f.attach();
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [], "on foot: nothing");
  // A mover out of view (0x00747f40 with no object): no VEHICLE_UPDATE, the two SHOW events without argument.
  f.world.controlledGuid = 0xf150_0000_0000_0dadn;
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [["VEHICLE_ANGLE_SHOW"], ["VEHICLE_POWER_SHOW"]]);
  f.fired.length = 0;
  f.world.controlledGuid = SELF;
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [["VEHICLE_UPDATE"], ["VEHICLE_ANGLE_SHOW"], ["VEHICLE_POWER_SHOW"]], "back to the character");
  f.fired.length = 0;
  f.sit(SELF, ENGINE, 0);
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [
    ["UNIT_ENTERING_VEHICLE", "player", ...DRIVER_ARGS],
    ["UNIT_ENTERED_VEHICLE", "player", ...DRIVER_ARGS],
    ["VEHICLE_PASSENGERS_CHANGED"],
  ]);
  f.fired.length = 0;
  f.world.controlledGuid = ENGINE;
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [
    ["VEHICLE_UPDATE"], ["VEHICLE_ANGLE_SHOW"], ["VEHICLE_POWER_SHOW"], ["VEHICLE_ANGLE_UPDATE", 0.5, 0],
  ], "the mover is the vehicle (0x00747f40 → 0x0074c5a0)");
  f.fired.length = 0;
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [], "nothing moved: nothing raised");
  // A seat switch is 3 → 3: ENTERING and ENTERED again with the new seat (0x00749fb0), no EXITING.
  f.sit(SELF, GUN, 0);
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [
    ["UNIT_ENTERING_VEHICLE", "player", ...DRIVER_ARGS],
    ["UNIT_ENTERED_VEHICLE", "player", ...DRIVER_ARGS],
    ["VEHICLE_PASSENGERS_CHANGED"],
  ]);
  f.fired.length = 0;
  f.sit(SELF, ENGINE, 1);
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [
    ["UNIT_ENTERING_VEHICLE", "player", false, "Natural", "", false, 223],
    ["UNIT_ENTERED_VEHICLE", "player", false, "Natural", "", false, 223],
    ["VEHICLE_PASSENGERS_CHANGED"],
  ]);
  f.fired.length = 0;
  // Another seat of the same vehicle: the seat byte alone moved.
  f.sit(SELF, ENGINE, 2);
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [
    ["UNIT_ENTERING_VEHICLE", "player", false, "Natural", "", false, 223],
    ["UNIT_ENTERED_VEHICLE", "player", false, "Natural", "", false, 223],
    ["VEHICLE_PASSENGERS_CHANGED"],
  ], "slot 1 → slot 2 of the engine");
  f.fired.length = 0;
  // Someone else climbs in: only VEHICLE_PASSENGERS_CHANGED.
  f.objects.set(FRIEND, unit(FRIEND, { typeId: 4, carrier: ENGINE, seat: 0 }));
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [["VEHICLE_PASSENGERS_CHANGED"]]);
  f.fired.length = 0;
  // Out: EXITING then EXITED (sound name ""), no passengers' change (no root left); control comes home.
  f.stand(SELF);
  f.world.controlledGuid = SELF;
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [
    ["UNIT_EXITING_VEHICLE", "player"], ["UNIT_EXITED_VEHICLE", "player", ""],
    ["VEHICLE_UPDATE"], ["VEHICLE_ANGLE_SHOW"], ["VEHICLE_POWER_SHOW"],
  ]);
});

test("11.02-F2: a reload while seated announces the seat once more; late tables do the same (0x00749ed0)", () => {
  const f = fixture({ tables: NO_TABLES });
  f.sit(SELF, ENGINE, 0);
  f.world.controlledGuid = ENGINE;
  f.attach();
  f.poll();
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [], "no tables: nothing at all");
  f.setTables(catalog);
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [
    ["UNIT_ENTERING_VEHICLE", "player", ...DRIVER_ARGS], ["UNIT_ENTERED_VEHICLE", "player", ...DRIVER_ARGS],
  ], "only the seat: no VEHICLE_UPDATE, no passengers' change");
  f.fired.length = 0;
  f.attach();
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [
    ["UNIT_ENTERING_VEHICLE", "player", ...DRIVER_ARGS], ["UNIT_ENTERED_VEHICLE", "player", ...DRIVER_ARGS],
  ], "a reload: the same");
  f.seam.detach();
  f.fired.length = 0;
  f.stand(SELF);
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [], "detached: nothing");
});

test("11.02-F2: the character's own kit — PLAYER_GAINS/LOSES_VEHICLE_DATA (0x0074bbd0, 0x0074bc50)", () => {
  const f = fixture();
  f.attach();
  f.poll();
  f.player.vehicleId = MAMMOTH;
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [["PLAYER_GAINS_VEHICLE_DATA", "player", 225]]);
  f.fired.length = 0;
  f.objects.set(FRIEND, unit(FRIEND, { typeId: 4, carrier: SELF, seat: 1 }));
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [["VEHICLE_PASSENGERS_CHANGED"]], "a rider on the character");
  f.fired.length = 0;
  f.objects.delete(FRIEND);
  f.player.vehicleId = 0;
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [["PLAYER_LOSES_VEHICLE_DATA", "player"]]);
});

test("11.02-F2: a party member's stats seat — ENTERING/ENTERED with indicator 0, EXITING/EXITED (0x006cf740)", () => {
  const f = fixture();
  f.world.group = { groupType: 0, members: [{ guid: FRIEND, name: "Друг" }] };
  f.attach();
  f.poll();
  f.world.partyStats.set(FRIEND, { guid: FRIEND, flags: 0x80000, vehicleSeat: 1648 });
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [
    ["UNIT_ENTERING_VEHICLE", "party1", true, "Mechanical", "", true, 0],
    ["UNIT_ENTERED_VEHICLE", "party1", true, "Mechanical", "", true, 0],
  ]);
  f.fired.length = 0;
  f.world.partyStats.set(FRIEND, { guid: FRIEND, flags: 0x80000, vehicleSeat: 0 });
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [["UNIT_EXITING_VEHICLE", "party1"], ["UNIT_EXITED_VEHICLE", "party1", ""]]);
  f.fired.length = 0;
  f.world.group = { groupType: 2, members: [{ guid: FRIEND, name: "Друг" }] };
  f.world.partyStats.set(FRIEND, { guid: FRIEND, flags: 0x80000, vehicleSeat: 1648 });
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), [], "a raid: no party tokens here");
});

test("11.02-F2: ordinary play raises nothing new — on foot, on a ship, a mover change of the character's own", () => {
  const f = fixture();
  f.attach();
  f.poll();
  f.world.controlledGuid = undefined;
  f.poll();
  f.world.controlledGuid = SELF;
  f.poll();
  f.objects.set(SHIP, unit(SHIP, { typeId: 5 }));
  f.sit(SELF, SHIP, 0);
  f.poll();
  f.stand(SELF);
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), []);
});

// ---- the vehicle's bar on the main bar (FrameXmlPossess.ts with the seat rule) -------------------

function vehicleBar(guid, spells) {
  const words = Array.from({ length: 10 }, (_, slot) => packPetAction(spells[slot] ?? 0, slot + 8));
  return {
    guid, closed: false, creatureFamily: 0, duration: 0, reactState: REACT_DEFENSIVE, commandState: COMMAND_FOLLOW, flags: 0,
    spells: [], cooldowns: [],
    bar: words.map((packed, slot) => ({ slot, packed, action: packed & 0xffffff, type: packed >>> 24 })),
  };
}

test("11.02-F2: the driven vehicle's spells on slots 121-126, pressed as the vehicle's (VehicleMenuBarActionButton1-6)", () => {
  const f = fixture();
  f.attach();
  f.sit(SELF, ENGINE, 0);
  f.world.controlledGuid = ENGINE;
  f.world.petSpells = vehicleBar(ENGINE, [62345, 62346, 0, 62348]);
  setGuid(f.player, CHARM, ENGINE);
  setGuid(f.player, FARSIGHT, ENGINE);
  f.poll();
  assert.deepEqual(f.call("GetBonusBarOffset"), [5], "VehicleAbilityDisplay 1: the main bar");
  assert.deepEqual(f.call("GetActionBarPage"), [1]);
  assert.deepEqual(f.call("HasAction", 121), [true]);
  assert.deepEqual(f.call("HasAction", 123), [false], "an empty vehicle slot");
  assert.deepEqual(f.call("GetActionInfo", 122), ["spell", 0, "pet", 62346]);
  f.call("UseAction", 124);
  assert.deepEqual(f.calls.filter(([name]) => name === "usePetSlot"), [["usePetSlot", 3, undefined]]);
  assert.ok(f.fired.some(([name]) => name === "UPDATE_BONUS_ACTIONBAR"));
});

test("11.02-F2: the bar stays off the main bar with VehicleAbilityDisplay 0, and without the tables until they land", () => {
  const f = fixture({ tables: NO_TABLES });
  f.attach();
  f.objects.set(CART, unit(CART, { vehicleId: QUIET_CART }));
  f.sit(SELF, ENGINE, 0);
  f.world.controlledGuid = ENGINE;
  f.world.petSpells = vehicleBar(ENGINE, [62345]);
  setGuid(f.player, FARSIGHT, ENGINE);
  f.poll();
  assert.notDeepEqual(f.call("GetBonusBarOffset"), [5], "no tables: as before F2");
  assert.deepEqual(f.call("GetBonusBarOffset"), [0], "the character's own offset");
  f.fired.length = 0;
  f.setTables(catalog);
  f.poll();
  assert.deepEqual(f.call("GetBonusBarOffset"), [5], "the tables landed under the open bar: 0x005d4ad0 again");
  assert.ok(f.fired.some(([name]) => name === "UPDATE_BONUS_ACTIONBAR"));
  // The cart's driver seat 9010 keeps its abilities on the pet bar.
  f.sit(SELF, CART, 0);
  f.world.controlledGuid = CART;
  f.world.petSpells = vehicleBar(CART, [62345]);
  setGuid(f.player, FARSIGHT, CART);
  f.world.events.emit("PET_BAR_CHANGED", { guid: CART });
  f.poll();
  assert.notDeepEqual(f.call("GetBonusBarOffset"), [5], "VehicleAbilityDisplay 0");
});

// ---- the real tables ----------------------------------------------------------------------------

const DATASET_DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const haveDataset = existsSync(`${DATASET_DBC}/Vehicle.dbc`) && existsSync(`${DATASET_DBC}/VehicleSeat.dbc`);

test("11.02-F2: the dataset's siege engine 117 and turret 116 answer as the synthetic rows do", { skip: !haveDataset && "no dataset DBCs on this machine" }, async () => {
  const { loadVehicles } = await import("../dist/code/gateway/VehicleMetadata.js");
  const real = vehicleCatalogFrom(await loadVehicles(DATASET_DBC));
  const f = fixture({ tables: real });
  f.sit(SELF, ENGINE, 0);
  f.world.controlledGuid = ENGINE;
  setGuid(f.player, CHARM, ENGINE);
  assert.deepEqual(f.call("UnitHasVehicleUI", "player"), [true]);
  assert.deepEqual(f.call("UnitVehicleSkin", "player"), ["Mechanical"]);
  assert.deepEqual(f.call("UnitVehicleSeatCount", "player"), [4]);
  assert.deepEqual(f.call("UnitVehicleSeatInfo", "player", 4).slice(0, 1), ["Child"]);
  assert.deepEqual(f.call("CanExitVehicle"), [1]);
  assert.equal(f.call("GetVehicleUIIndicator", 223)[1], 4);
  const [index, x, y] = f.call("GetVehicleUIIndicatorSeat", 223, 2);
  assert.equal(index, 2);
  assert.ok(Math.abs(x - 0.698) < 1e-6 && Math.abs(y - 0.799) < 1e-6);
  f.attach();
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired).slice(0, 2), [
    ["UNIT_ENTERING_VEHICLE", "player", true, "Mechanical", "", true, 223],
    ["UNIT_ENTERED_VEHICLE", "player", true, "Mechanical", "", true, 223],
  ]);
  assert.equal(real.seat(1648).vehicleAbilityDisplay, 1);
  f.seam.detach();
});

// ---- 11.02-F2-review: the rules the first tests left unpinned (mutations VU1-VU3, FV1-FV2 survived) ----

test("11.02-F2-review: a seat byte with no VehicleSeat row still carries the vehicle's indicator (0x00748810)", () => {
  // 0x00748810 with no seat row: CAN_CAST 0, skin "", sound "", CAN_CONTROL 0 — and the Vehicle row's
  // VehicleUIIndicatorID (+0x90) all the same, since that comes from the vehicle, not the seat.
  assert.deepEqual(vehicleEnterArgs(undefined, 223), [false, "", "", false, 223]);
  const f = fixture();
  f.attach();
  f.poll();
  f.sit(SELF, ENGINE, 3); // 117's SeatID[3] is 0: no row
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired).slice(0, 2), [
    ["UNIT_ENTERING_VEHICLE", "player", false, "", "", false, 223],
    ["UNIT_ENTERED_VEHICLE", "player", false, "", "", false, 223],
  ]);
  f.seam.detach();
});

test("11.02-F2-review: moving to another vehicle's same-numbered seat is a passengers' change (0x0074ad70)", () => {
  // The character alone on seat 1 of the siege engine, then alone on seat 1 of a cart: the occupants read
  // the same ("|1:self"), the root does not — the character's passenger state enters 3 under a new root.
  const f = fixture();
  f.objects.set(CART, unit(CART, { vehicleId: QUIET_CART }));
  f.attach();
  f.sit(SELF, ENGINE, 0);
  f.poll();
  f.fired.length = 0;
  f.sit(SELF, CART, 0);
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired).filter(([name]) => name === "VEHICLE_PASSENGERS_CHANGED"), [["VEHICLE_PASSENGERS_CHANGED"]]);
  f.seam.detach();
});

test("11.02-F2-review: a passenger aims with the character, not the vehicle (0x005f9d20 wants CAN_CONTROL)", () => {
  // A gunner-like seat without CAN_CONTROL in a vehicle with both ADJUST_AIM flags: the aimer is the
  // character itself, which has no kit — IsVehicleAimPowerAdjustable/AngleAdjustable answer nil.
  const AIMER = 903;
  const tables = vehicleCatalogFrom({
    ...ANSWER,
    vehicles: [...ANSWER.vehicles, vehicleRow({ id: AIMER, flags: VEHICLE_FLAGS.ADJUST_AIM_POWER | VEHICLE_FLAGS.ADJUST_AIM_ANGLE, seats: [9011, 9010] })],
  });
  const objects = new Map([[SELF, unit(SELF, { typeId: 4, carrier: CART, seat: 0 })], [CART, unit(CART, { vehicleId: AIMER })]]);
  assert.equal(isVehicleAimPowerAdjustable(tables, objects, SELF), false, "seat 9011: CAN_CAST only");
  objects.get(SELF).transport.seat = 1;
  assert.equal(isVehicleAimPowerAdjustable(tables, objects, SELF), true, "seat 9010: the driver aims with the vehicle");
  const f = fixture({ tables });
  f.objects.set(CART, unit(CART, { vehicleId: AIMER }));
  f.sit(SELF, CART, 0);
  assert.deepEqual([f.call("IsVehicleAimPowerAdjustable"), f.call("IsVehicleAimAngleAdjustable")], [[], []]);
  f.sit(SELF, CART, 1);
  assert.deepEqual([f.call("IsVehicleAimPowerAdjustable"), f.call("IsVehicleAimAngleAdjustable")], [[1], [1]]);
});

test("11.02-F2-review: a world without a revision counter is walked every poll", () => {
  const objects = new Map([[SELF, unit(SELF, { typeId: 4, carrier: ENGINE, seat: 0 })], [ENGINE, unit(ENGINE, { vehicleId: SIEGE })]]);
  const world = { state: { selfGuid: SELF, objects }, controlledGuid: SELF };
  const fired = [];
  const model = new FrameXmlVehicleModel({ world: () => world, catalog: () => catalog, unitGuid: () => undefined });
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  try {
    model.tick();
    fired.length = 0;
    objects.set(FRIEND, unit(FRIEND, { typeId: 4, carrier: ENGINE, seat: 1 }));
    model.tick();
    assert.deepEqual(vehicleEvents(fired), [["VEHICLE_PASSENGERS_CHANGED"]]);
  } finally {
    model.detach();
  }
});

test("11.02-F2-review: a party member who left and came back unseated raises nothing (no stale seat)", () => {
  // TrinityCore sends GROUP_UPDATE_FLAG_VEHICLE_SEAT only for a member in a vehicle (GroupHandler.cpp:984-985),
  // so a rejoin on foot carries no seat and Wow.exe's 0x006cf740 raises no exit.
  const f = fixture();
  const party = { groupType: 0, members: [{ guid: FRIEND, name: "Друг" }] };
  f.world.group = party;
  f.attach();
  f.poll();
  f.world.partyStats.set(FRIEND, { guid: FRIEND, flags: 0x80000, vehicleSeat: 1648 });
  f.poll();
  f.fired.length = 0;
  f.world.group = undefined;
  f.world.partyStats.delete(FRIEND);
  f.poll();
  f.world.group = party;
  f.world.partyStats.set(FRIEND, { guid: FRIEND, flags: 0 });
  f.poll();
  assert.deepEqual(vehicleEvents(f.fired), []);
  f.seam.detach();
});

test("11.02-F2-review: the chat API's VehicleExit asks the attached model's gate (FrameXmlChatApi.ts, 0x005fb660)", async () => {
  const { installFrameXmlChatApi } = await import("../dist/code/browser/framexml/FrameXmlChatApi.js");
  const locked = vehicleCatalogFrom({
    ...ANSWER,
    seats: ANSWER.seats.map((row) => (row[0] === 1648 ? seatRow({ id: 1648, flags: F.CAN_CONTROL | F.CAN_CAST, uiSkin: 1 }) : row)),
  });
  const f = fixture({ tables: locked });
  const globals = new Map();
  installFrameXmlChatApi({ registerGlobal: (name, binding) => globals.set(name, binding), execute: () => ({ ok: true }) }, {
    world: () => f.world, notice: () => {}, cast: () => {}, use: () => {}, unitGuid: () => undefined,
  });
  const exit = () => globals.get("VehicleExit")([]);
  f.sit(SELF, ENGINE, 0);
  f.attach();
  f.seam.detach(); // whatever an earlier test left attached is replaced, then nothing is
  assert.equal(frameXmlVehicleLive(), undefined);
  f.fired.length = 0;
  exit();
  assert.deepEqual(f.calls, [["leaveVehicle"]], "no attached stock seam: the plain exit, as before");
  f.calls.length = 0;
  f.attach();
  exit();
  assert.deepEqual(f.calls, [], "a seat without CAN_ENTER_OR_EXIT sends nothing");
  assert.deepEqual(vehicleEvents(f.fired), [["UI_ERROR_MESSAGE", "Вы пока не можете этого сделать."]]);
  f.seam.detach();
});

test("11.02-F2: the model reads nothing it is not given (a bare model)", () => {
  const model = new FrameXmlVehicleModel({ world: () => undefined, catalog: () => undefined, unitGuid: () => undefined });
  assert.equal(model.active, false);
  model.tick();
  assert.deepEqual(model.seatInfo("player", 1), []);
});
