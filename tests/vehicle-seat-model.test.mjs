import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

// 11.02-F1: the vehicle tables (world/VehicleDbc.ts) and the seat model (world/VehicleSeatModel.ts) —
// the answers the stock vehicle UI will ask the C API for (slice F2). The rules are Wow.exe 3.3.5a's
// (Ghidra, .runtime/re-2026-10-03/l1102f1): virtual seat numbering 0x00757550, seat answers
// 0x007579e0, root vehicle 0x0074c650, the unit's seat 0x00613600, CanExit/CanSwitch 0x005fb560,
// CanEject 0x00613d20, the skin table 0x00ad8660. Synthetic rows for the rules, then the real
// dataset's Vehicle.dbc/VehicleSeat.dbc when it is on this machine (skipped otherwise).
const {
  MAX_VEHICLE_SEATS, VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_COLUMN, VEHICLE_SEAT_FORMAT,
  vehicleCatalogFrom,
} = await import("../dist/code/world/VehicleDbc.js");
const {
  VEHICLE_FLAGS, VEHICLE_SEAT_FLAGS, VEHICLE_SEAT_FLAGS_B, canEjectPassengerFromSeat, canExitVehicle, canSwitchVehicleSeats,
  isVehicleAimAngleAdjustable, isVehicleCarrierGuid, rootVehicleGuid, unitControllingVehicle, unitVehicleGuid,
  unitVehicleSeat, unitVehicleSeatCount, unitVehicleSeatInfo, vehicleSkinName, vehicleVirtualSeats, virtualSeatIndexOf,
} = await import("../dist/code/world/VehicleSeatModel.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const F = VEHICLE_SEAT_FLAGS;

/** A Vehicle.dbc row of 40 columns: zero numbers, empty strings, then the given columns. */
function vehicleRow({ id, flags = 0, seats = [], indicator = 0, pitchMin = 0 }) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  row[VEHICLE_COLUMN.Flags] = flags;
  row[VEHICLE_COLUMN.PitchMin] = pitchMin;
  seats.forEach((seat, slot) => { row[VEHICLE_COLUMN.SeatID + slot] = seat; });
  row[VEHICLE_COLUMN.VehicleUIIndicatorID] = indicator;
  return row;
}

/** A VehicleSeat.dbc row of 58 columns. */
function seatRow({ id, flags = 0, flagsB = 0, uiSkin = 0, zoomMax = 0 }) {
  const row = [...VEHICLE_SEAT_FORMAT].map(() => 0);
  row[VEHICLE_SEAT_COLUMN.ID] = id;
  row[VEHICLE_SEAT_COLUMN.Flags] = flags;
  row[VEHICLE_SEAT_COLUMN.FlagsB] = flagsB;
  row[VEHICLE_SEAT_COLUMN.UiSkin] = uiSkin;
  row[VEHICLE_SEAT_COLUMN.CameraSeatZoomMax] = zoomMax;
  return row;
}

// The shapes of the dataset's own vehicles: a siege engine with a turret accessory in slot 7
// (Vehicle 117 + 116), and a player's mammoth whose slot 0 is empty (Vehicle 312).
const SIEGE = 117;
const TURRET = 116;
const MAMMOTH = 312;
const BROKEN = 900;
const DRIVER_SEAT = 1648;
const PASSENGER_SEAT = 1649;
const TURRET_SLOT_SEAT = 1652;
const GUNNER_SEAT = 1643;
const RIDER_EJECTABLE = 2764;
const RIDER_FIXED = 2765;

const ANSWER = {
  version: VEHICLE_CATALOG_VERSION,
  vehicles: [
    vehicleRow({ id: SIEGE, flags: VEHICLE_FLAGS.ADJUST_AIM_ANGLE, seats: [DRIVER_SEAT, PASSENGER_SEAT, 1650, 0, 0, 0, 0, TURRET_SLOT_SEAT], indicator: 223 }),
    vehicleRow({ id: TURRET, seats: [GUNNER_SEAT], indicator: 223 }),
    vehicleRow({ id: MAMMOTH, seats: [0, RIDER_EJECTABLE, RIDER_FIXED], indicator: 225 }),
    vehicleRow({ id: BROKEN, seats: [PASSENGER_SEAT, 9999] }),
  ],
  seats: [
    // The driver: CAN_CONTROL and CAN_CAST, but no CAN_ENTER_OR_EXIT — the UI offers no way out.
    seatRow({ id: DRIVER_SEAT, flags: F.CAN_CONTROL | F.CAN_CAST | F.CAN_SWITCH, uiSkin: 1 }),
    seatRow({ id: PASSENGER_SEAT, flags: F.CAN_SWITCH | F.CAN_ENTER_OR_EXIT }),
    seatRow({ id: 1650, flags: F.CAN_ENTER_OR_EXIT }),
    seatRow({ id: TURRET_SLOT_SEAT, flags: F.CAN_SWITCH | F.CAN_ENTER_OR_EXIT }),
    seatRow({ id: GUNNER_SEAT, flags: F.CAN_CONTROL | F.CAN_SWITCH | F.CAN_ENTER_OR_EXIT, uiSkin: 1 }),
    seatRow({ id: RIDER_EJECTABLE, flags: 0xde00800b, flagsB: VEHICLE_SEAT_FLAGS_B.EJECTABLE }),
    seatRow({ id: RIDER_FIXED, flags: 0xde00800b }),
  ],
  indicators: [[223, "Interface\\Vehicles\\SeatIndicator\\Vehicle-SiegeEngine.blp"], [225, "Interface\\Vehicles\\SeatIndicator\\vehicle-mammoth.blp"]],
  // Out of id order on purpose: GetVehicleUIIndicatorSeat numbers them by ascending row id.
  indicatorSeats: [[229, 223, 4, 0.5, 0.578], [226, 223, 1, 0.501, 0.14], [231, 225, 1, 0.348, 0.76], [228, 223, 3, 0.303, 0.799], [227, 223, 2, 0.698, 0.799]],
};

const ENGINE = 0xf150_0074_9800_0101n;
const GUN = 0xf150_0074_9800_0102n;
const SELF = 0x10n;
const FRIEND = 0x11n;
const STRANGER = 0x12n;
const CREATURE = 0xf130_0074_9800_0103n;
const SHIP = 0x1fc0_0000_0000_0104n;

function unit(guid, { typeId = 3, vehicleId, carrier, seat = 0, charm } = {}) {
  const fields = new Map();
  if (charm !== undefined) {
    fields.set(UPDATE_FIELDS.UNIT_FIELD_CHARM.offset, Number(charm & 0xffff_ffffn));
    fields.set(UPDATE_FIELDS.UNIT_FIELD_CHARM.offset + 1, Number(charm >> 32n));
  }
  return {
    guid, typeId, vehicleId, fields,
    position: { x: 0, y: 0, z: 0, orientation: 0 },
    transport: carrier === undefined ? undefined : { guid: carrier, x: 0, y: 0, z: 0, orientation: 0, seat },
  };
}

function world(...units) {
  return new Map(units.map((object) => [object.guid, object]));
}

const catalog = vehicleCatalogFrom(ANSWER);

test("the flag words are DBCEnums.h's and VehicleDefines.h's, the formats DBCfmt.h's widths", () => {
  assert.equal(F.CAN_CONTROL, 0x800);
  assert.equal(F.CAN_ENTER_OR_EXIT, 0x0200_0000);
  assert.equal(F.CAN_SWITCH, 0x0400_0000);
  assert.equal(F.CAN_CAST, 0x2000_0000);
  assert.equal(F.HIDE_PASSENGER, 0x200);
  assert.equal(F.ALLOW_TURNING, 0x400);
  assert.equal(F.HAS_LOWER_ANIM_FOR_RIDE, 0x2);
  assert.equal(F.ENABLE_VEHICLE_ZOOM, 0x0100_0000);
  assert.equal(F.PASSENGER_NOT_SELECTABLE, 0x0010_0000);
  assert.equal(F.ALLOWS_INTERACTION, 0x8000_0000);
  assert.equal(VEHICLE_SEAT_FLAGS_B.EJECTABLE, 0x20);
  assert.equal(VEHICLE_SEAT_FLAGS_B.TARGETS_IN_RAIDUI, 0x8);
  assert.equal(VEHICLE_SEAT_FLAGS_B.VEHICLE_PLAYERFRAME_UI, 0x8000_0000);
  assert.deepEqual(
    [VEHICLE_FLAGS.NO_STRAFE, VEHICLE_FLAGS.NO_JUMPING, VEHICLE_FLAGS.ALLOW_PITCHING, VEHICLE_FLAGS.CUSTOM_PITCH,
      VEHICLE_FLAGS.ADJUST_AIM_ANGLE, VEHICLE_FLAGS.ADJUST_AIM_POWER, VEHICLE_FLAGS.FIXED_POSITION],
    [0x1, 0x2, 0x10, 0x40, 0x400, 0x800, 0x0020_0000]);
  assert.equal(MAX_VEHICLE_SEATS, 8);
  assert.equal(VEHICLE_FORMAT.length, 40);
  assert.equal(VEHICLE_SEAT_FORMAT.length, 58);
  // The core's own columns keep DBCfmt.h's types; the flag words read unsigned.
  const core = (fmt, ours) => [...fmt].every((kind, column) => kind === "x" || kind === ours[column]
    || (kind === "i" && ours[column] === "u"));
  assert.ok(core("niffffiiiiiiiifffffffffffffffssssfifiixx", VEHICLE_FORMAT));
  assert.ok(core("niiffffffffffiiiiiifffffffiiifffiiiiiiiffiiiiixxxxxxxxxxxx", VEHICLE_SEAT_FORMAT));
  assert.equal(VEHICLE_FORMAT[VEHICLE_COLUMN.Flags], "u");
  assert.equal(VEHICLE_SEAT_FORMAT[VEHICLE_SEAT_COLUMN.Flags], "u");
  assert.equal(VEHICLE_SEAT_FORMAT[VEHICLE_SEAT_COLUMN.FlagsB], "u");
  assert.equal(VEHICLE_SEAT_FORMAT[VEHICLE_SEAT_COLUMN.UiSkin], "i");
  assert.equal(VEHICLE_FORMAT.slice(37), "iii", "PowerDisplayID[3] — the core reads only the first");
  assert.equal(VEHICLE_SEAT_FORMAT.slice(46), "f".repeat(12), "the Camera* columns the core skips are floats");
  assert.deepEqual([VEHICLE_SEAT_COLUMN.RideAnimStart, VEHICLE_SEAT_COLUMN.PassengerYaw, VEHICLE_SEAT_COLUMN.CameraSeatZoomMax,
    VEHICLE_COLUMN.CameraYawOffset, VEHICLE_COLUMN.FacingLimitRight, VEHICLE_COLUMN.VehicleUIIndicatorID], [15, 29, 57, 33, 18, 36]);
});

test("the catalog: its version only, malformed rows skipped, unsigned flags, a null float as NaN", () => {
  assert.equal(vehicleCatalogFrom({ ...ANSWER, version: 2 }), undefined);
  assert.equal(vehicleCatalogFrom({ version: 1, vehicles: [], seats: [], indicators: [] }), undefined);
  assert.equal(vehicleCatalogFrom(null), undefined);
  const shortRow = vehicleRow({ id: 5 }).slice(0, 39);
  const textId = seatRow({ id: 6 });
  textId[0] = "6";
  const nullFloat = seatRow({ id: 7 });
  nullFloat[VEHICLE_SEAT_COLUMN.CameraSeatZoomMax] = null;
  const loose = vehicleCatalogFrom({ ...ANSWER, vehicles: [...ANSWER.vehicles, shortRow], seats: [...ANSWER.seats, textId, nullFloat] });
  assert.equal(loose.vehicleCount, 4, "the short row is dropped, the rest stand");
  assert.equal(loose.seat(6), undefined);
  assert.ok(Number.isNaN(loose.seat(7).cameraSeatZoomMax));
  assert.equal(catalog.seat(RIDER_EJECTABLE).flags, 0xde00800b, "bit 31 stays a positive word");
  const signed = seatRow({ id: 8 });
  signed[VEHICLE_SEAT_COLUMN.Flags] = -1;
  assert.equal(vehicleCatalogFrom({ ...ANSWER, seats: [signed] }).seat(8), undefined, "a flag word is never negative");
  const twice = vehicleCatalogFrom({ ...ANSWER, seats: [...ANSWER.seats, seatRow({ id: DRIVER_SEAT, uiSkin: 0 })],
    vehicles: [...ANSWER.vehicles, vehicleRow({ id: SIEGE, seats: [1650] })] });
  assert.equal(twice.seat(DRIVER_SEAT).uiSkin, 0, "a later row with the same id wins, as an id index filled in order");
  assert.equal(twice.vehicle(SIEGE).seatIds[0], 1650);
  assert.equal(catalog.vehicle(SIEGE).seatIds.length, 8);
  assert.equal(catalog.seatInSlot(SIEGE, 0).id, DRIVER_SEAT);
  assert.equal(catalog.seatInSlot(SIEGE, 3), undefined, "a zero SeatID is no seat");
  assert.equal(catalog.seatInSlot(SIEGE, 8), undefined, "0x00756ec0: a slot past 7");
  assert.equal(catalog.seatInSlot(BROKEN, 1), undefined, "a SeatID the table does not hold");
  const indicator = catalog.indicator(223);
  assert.equal(indicator.backgroundTexture, "Interface\\Vehicles\\SeatIndicator\\Vehicle-SiegeEngine.blp");
  assert.deepEqual(indicator.seats.map((seat) => [seat.id, seat.virtualSeatIndex, seat.x, seat.y]),
    [[226, 1, 0.501, 0.14], [227, 2, 0.698, 0.799], [228, 3, 0.303, 0.799], [229, 4, 0.5, 0.578]],
    "GetVehicleUIIndicatorSeat(id, i) is the i-th row by ascending id (0x00614d90)");
  assert.equal(catalog.indicator(225).seats.length, 1);
  assert.equal(catalog.indicator(0), undefined);
});

test("the guid test of 0x0074b8b0: vehicles and players carry seats, ships and plain creatures do not", () => {
  assert.equal(isVehicleCarrierGuid(ENGINE), true);
  assert.equal(isVehicleCarrierGuid(SELF), true);
  assert.equal(isVehicleCarrierGuid(0x0000_0001_0000_0000n), true, "a player guid with only high bits");
  assert.equal(isVehicleCarrierGuid(0n), false);
  assert.equal(isVehicleCarrierGuid(CREATURE), false, "HighGuid::Unit");
  assert.equal(isVehicleCarrierGuid(SHIP), false, "a transport game object");
  assert.equal(isVehicleCarrierGuid(0xf110_0000_0000_0001n), false, "a game object");
});

test("virtual seats: slots in order, empty SeatIDs skipped, an accessory's seats in place of its slot", () => {
  const alone = world(unit(ENGINE, { vehicleId: SIEGE }), unit(SELF, { typeId: 4, carrier: ENGINE, seat: 0 }));
  const seats = vehicleVirtualSeats(catalog, alone, ENGINE);
  assert.deepEqual(seats.map((seat) => [seat.index, seat.slot, seat.seat.id]),
    [[1, 0, DRIVER_SEAT], [2, 1, PASSENGER_SEAT], [3, 2, 1650], [4, 7, TURRET_SLOT_SEAT]]);
  assert.equal(seats[0].occupantGuid, SELF);
  assert.equal(seats[1].occupantGuid, undefined);
  assert.deepEqual(unitVehicleSeatInfo(catalog, alone, SELF, 1),
    { controlType: "Root", occupantGuid: SELF, ejectable: false, canSwitchSeats: true });
  assert.equal(unitVehicleSeatInfo(catalog, alone, SELF, 4).controlType, "None", "the turret's slot without the turret");
  assert.equal(unitVehicleSeatCount(catalog, alone, SELF), 4);
  assert.equal(unitVehicleSeatInfo(catalog, alone, SELF, 5), undefined);
  assert.equal(unitVehicleSeatInfo(catalog, alone, SELF, 0), undefined, "1-based");

  // The turret (a vehicle creature) sits in slot 7; the character mans it.
  const manned = world(
    unit(ENGINE, { vehicleId: SIEGE }),
    unit(GUN, { vehicleId: TURRET, carrier: ENGINE, seat: 7 }),
    unit(SELF, { typeId: 4, carrier: GUN, seat: 0 }),
    unit(FRIEND, { typeId: 4, carrier: ENGINE, seat: 1 }),
  );
  const expanded = vehicleVirtualSeats(catalog, manned, ENGINE);
  assert.deepEqual(expanded.map((seat) => [seat.vehicleGuid === GUN ? "gun" : "engine", seat.slot]),
    [["engine", 0], ["engine", 1], ["engine", 2], ["gun", 0]]);
  assert.equal(rootVehicleGuid(catalog, manned, SELF), ENGINE, "up from the turret to the engine");
  assert.deepEqual(unitVehicleSeatInfo(catalog, manned, SELF, 4),
    { controlType: "Child", occupantGuid: SELF, ejectable: false, canSwitchSeats: true });
  assert.equal(unitVehicleSeatInfo(catalog, manned, SELF, 1).controlType, "Root");
  assert.equal(unitVehicleSeatInfo(catalog, manned, FRIEND, 2).occupantGuid, FRIEND, "asked from any rider");
  assert.equal(unitVehicleSeatCount(catalog, manned, SELF), 4, "0x00757470: 4 seats + 1 gunner − the slot it takes");
  assert.equal(virtualSeatIndexOf(expanded, GUN, 0), 4, "the character's own button");

  // A player with a vehicle kit riding in a seat is a passenger, never an accessory.
  const playerKit = world(unit(ENGINE, { vehicleId: SIEGE }), unit(FRIEND, { typeId: 4, vehicleId: TURRET, carrier: ENGINE, seat: 7 }));
  assert.deepEqual(vehicleVirtualSeats(catalog, playerKit, ENGINE).map((seat) => seat.slot), [0, 1, 2, 7]);
});

test("a SeatID without a row still takes a number and answers nothing", () => {
  const objects = world(unit(ENGINE, { vehicleId: BROKEN }), unit(SELF, { typeId: 4, carrier: ENGINE, seat: 0 }));
  assert.equal(unitVehicleSeatCount(catalog, objects, SELF), 2);
  assert.equal(unitVehicleSeatInfo(catalog, objects, SELF, 1).controlType, "None");
  assert.equal(unitVehicleSeatInfo(catalog, objects, SELF, 2), undefined);
});

test("the root: a unit riding nothing is its own when it is a vehicle; plain creatures, ships and unseen carriers are no root", () => {
  assert.equal(rootVehicleGuid(catalog, world(unit(SELF, { typeId: 4, vehicleId: MAMMOTH })), SELF), SELF);
  assert.equal(rootVehicleGuid(catalog, world(unit(SELF, { typeId: 4 })), SELF), undefined);
  assert.equal(rootVehicleGuid(catalog, world(unit(SELF, { typeId: 4, carrier: ENGINE })), SELF), undefined, "carrier out of view");
  assert.equal(rootVehicleGuid(catalog,
    world(unit(CREATURE, { vehicleId: SIEGE }), unit(SELF, { typeId: 4, carrier: CREATURE })), SELF), undefined,
  "a HighGuid::Unit carrier is not a vehicle to the client");
  const onShip = world(unit(SHIP, { typeId: 5 }), unit(SELF, { typeId: 4, carrier: SHIP, seat: -1 }));
  assert.equal(rootVehicleGuid(catalog, onShip, SELF), undefined);
  assert.equal(unitVehicleSeat(catalog, onShip, SELF), undefined);
  assert.equal(unitVehicleGuid(onShip, SELF), undefined);
  // A stale loop in the objects ends the walk instead of hanging it.
  const loop = world(unit(ENGINE, { vehicleId: SIEGE, carrier: GUN }), unit(GUN, { vehicleId: TURRET, carrier: ENGINE }),
    unit(SELF, { typeId: 4, carrier: ENGINE }));
  assert.equal(rootVehicleGuid(catalog, loop, SELF), undefined);
});

test("the character's seat: CanExitVehicle wants CAN_ENTER_OR_EXIT, not CAN_CONTROL; CanSwitch wants CAN_SWITCH", () => {
  const driving = world(unit(ENGINE, { vehicleId: SIEGE }), unit(SELF, { typeId: 4, carrier: ENGINE, seat: 0, charm: ENGINE }));
  const seated = unitVehicleSeat(catalog, driving, SELF);
  assert.equal(seated.vehicleGuid, ENGINE);
  assert.equal(seated.slot, 0);
  assert.equal(seated.seat.id, DRIVER_SEAT);
  assert.equal(canExitVehicle(catalog, driving, SELF), false, "the driver's seat lacks CAN_ENTER_OR_EXIT");
  assert.equal(canSwitchVehicleSeats(catalog, driving, SELF), true);
  assert.equal(unitControllingVehicle(driving, SELF), true, "UNIT_FIELD_CHARM is the vehicle");
  assert.equal(isVehicleAimAngleAdjustable(catalog, driving, SELF), true, "the driven vehicle's ADJUST_AIM_ANGLE");

  const riding = world(unit(ENGINE, { vehicleId: SIEGE }), unit(SELF, { typeId: 4, carrier: ENGINE, seat: 2 }));
  assert.equal(canExitVehicle(catalog, riding, SELF), true);
  assert.equal(canSwitchVehicleSeats(catalog, riding, SELF), false);
  assert.equal(unitControllingVehicle(riding, SELF), false);
  // Charming something else — here a creature whose low word happens to be the engine's — is not driving.
  const charming = world(unit(ENGINE, { vehicleId: SIEGE }),
    unit(SELF, { typeId: 4, carrier: ENGINE, seat: 2, charm: 0xf130_0074_9800_0101n }));
  assert.equal(unitControllingVehicle(charming, SELF), false, "the whole guid, not its low word");
  assert.equal(isVehicleAimAngleAdjustable(catalog, riding, SELF), false, "a passenger aims nothing");
  assert.equal(unitVehicleGuid(riding, SELF), ENGINE);

  const walking = world(unit(SELF, { typeId: 4 }));
  assert.equal(canExitVehicle(catalog, walking, SELF), false);
  assert.equal(canSwitchVehicleSeats(catalog, walking, undefined), false);
});

test("CanEjectPassengerFromSeat: only the vehicle the passenger rides on, and only from an EJECTABLE seat", () => {
  const mammoth = world(
    unit(SELF, { typeId: 4, vehicleId: MAMMOTH }),
    unit(FRIEND, { typeId: 4, carrier: SELF, seat: 1 }),
    unit(STRANGER, { typeId: 4, carrier: SELF, seat: 2 }),
  );
  assert.deepEqual(vehicleVirtualSeats(catalog, mammoth, SELF).map((seat) => seat.slot), [1, 2], "slot 0 has no seat");
  assert.equal(canEjectPassengerFromSeat(catalog, mammoth, SELF, 1), true);
  assert.equal(canEjectPassengerFromSeat(catalog, mammoth, SELF, 2), false, "occupied but not EJECTABLE");
  assert.equal(canEjectPassengerFromSeat(catalog, mammoth, SELF, 3), false);
  const empty = world(unit(SELF, { typeId: 4, vehicleId: MAMMOTH }));
  assert.equal(canEjectPassengerFromSeat(catalog, empty, SELF, 1), false, "nobody to eject");
  // The friend asks about the seat it shares with the stranger's: it is not the vehicle.
  assert.equal(canEjectPassengerFromSeat(catalog, mammoth, FRIEND, 1), false);
  assert.equal(unitVehicleSeatInfo(catalog, mammoth, FRIEND, 1).ejectable, true, "though the seat is ejectable");
});

test("UnitVehicleSkin: UiSkin 0 Natural, 1 Mechanical, anything else empty (Wow.exe 0x00ad8660)", () => {
  assert.equal(vehicleSkinName(0), "Natural");
  assert.equal(vehicleSkinName(1), "Mechanical");
  assert.equal(vehicleSkinName(-1), "");
  assert.equal(vehicleSkinName(2), "");
});

// ---- the real dataset ------------------------------------------------------------------------

const DATASET_DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const haveDataset = existsSync(`${DATASET_DBC}/Vehicle.dbc`) && existsSync(`${DATASET_DBC}/VehicleSeat.dbc`);

test("the dataset's tables through the gateway loader: counts, a siege engine, its turret, the skins", { skip: !haveDataset && "no dataset DBCs on this machine" }, async () => {
  const { loadVehicles } = await import("../dist/code/gateway/VehicleMetadata.js");
  const answer = await loadVehicles(DATASET_DBC);
  const json = JSON.stringify(answer);
  assert.deepEqual([answer.vehicles.length, answer.seats.length, answer.indicators.length, answer.indicatorSeats.length],
    [412, 720, 9, 19], "the spec's counts");
  assert.ok(json.length < 200_000, `one answer per page stays small: ${json.length} bytes`);
  const real = vehicleCatalogFrom(JSON.parse(json));
  assert.equal(real.vehicleCount, 412);
  assert.equal(real.seatCount, 720);

  const siege = real.vehicle(SIEGE);
  assert.deepEqual(siege.seatIds, [DRIVER_SEAT, PASSENGER_SEAT, 1650, 0, 0, 0, 0, TURRET_SLOT_SEAT]);
  assert.equal(siege.vehicleUIIndicatorId, 223);
  assert.ok(real.seat(DRIVER_SEAT).flags & F.CAN_CONTROL, "the driver's seat controls");
  assert.equal(vehicleSkinName(real.seat(DRIVER_SEAT).uiSkin), "Mechanical");
  assert.equal(real.vehicle(TURRET).seatIds[0], GUNNER_SEAT);
  const alone = world(unit(ENGINE, { vehicleId: SIEGE }), unit(SELF, { typeId: 4, carrier: ENGINE, seat: 0 }));
  assert.equal(unitVehicleSeatCount(real, alone, SELF), 4);
  assert.deepEqual([1, 2, 3, 4].map((index) => unitVehicleSeatInfo(real, alone, SELF, index).controlType),
    ["Root", "None", "None", "None"]);
  const manned = world(unit(ENGINE, { vehicleId: SIEGE }), unit(GUN, { vehicleId: TURRET, carrier: ENGINE, seat: 7 }),
    unit(SELF, { typeId: 4, carrier: GUN, seat: 0 }));
  assert.equal(unitVehicleSeatInfo(real, manned, SELF, 4).controlType, "Child", "the gunner's cursor");
  assert.deepEqual(real.indicator(223).seats.map((seat) => seat.virtualSeatIndex), [1, 2, 3, 4],
    "the indicator has a button for each of the four");

  const skins = new Map();
  for (const row of answer.seats) {
    const skin = row[VEHICLE_SEAT_COLUMN.UiSkin];
    skins.set(skin, (skins.get(skin) ?? 0) + 1);
  }
  assert.deepEqual([...skins].sort((a, b) => a[0] - b[0]), [[-1, 4], [0, 635], [1, 81]]);
  assert.equal(answer.vehicles.filter((row) => row[VEHICLE_COLUMN.VehicleUIIndicatorID] !== 0).length, 26);
  assert.equal(real.vehicle(MAMMOTH).seatIds[0], 0, "a player vehicle leaves slot 0 to its owner");
});
