import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { VEHICLE_SEAT_FLAG_ALLOW_TURNING, unitAutoFacing, unitSeatFacing } from "../dist/code/world/UnitFacing.js";
import { SEAT_FLAG_B_VEHICLE_FACES_PASSENGER, VehicleAims, seatAimsVehicle } from "../dist/code/browser/VehicleFacesPassenger.js";

// 11.11 (5.32): the answers of Wow.exe 0x00735f60 that were left. A vehicle's own aim (+0xf5c +0x160), set by
// 0x00756db0 when a passenger boards a seat with FlagsB 0x800000, is drawn. +0xa30 bit 0's fixed facing (+0xab8, set by
// SMSG_ATTACK_STOP with NowDead) is read but not drawn: no bound for it was found (world/UnitFacing.ts header), and
// taken literally it would turn every melee unit back to its last kill whenever it stands.

const F = UPDATE_FIELDS;
let nextGuid = 100n;
const close = (actual, expected, message) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9,
  `${message}: ${actual} vs ${expected}`);

function unit({ x = 0, y = 0, typeId = 3, orientation = 0, target, transport } = {}) {
  const fields = new Map();
  const guid = nextGuid++;
  fields.set(F.UNIT_FIELD_FLAGS.offset, 0);
  fields.set(F.UNIT_FIELD_FLAGS_2.offset, 0);
  fields.set(F.UNIT_FIELD_BYTES_1.offset, 0);
  if (target !== undefined) {
    fields.set(F.UNIT_FIELD_TARGET.offset, Number(target & 0xffffffffn));
    fields.set(F.UNIT_FIELD_TARGET.offset + 1, Number(target >> 32n));
  }
  return { guid, typeId, fields, movementFlags: 0, position: { x, y, z: 0, orientation }, motion: undefined, transport };
}

const world = (...objects) => new Map(objects.map((object) => [object.guid, object]));

test("5.32 after a kill: a creature home from its evade and a player who turned are drawn as they stand", () => {
  // The creature killed its victim at (0, 5), evaded and walked home; its spline ended facing 1.0 and it has no target.
  const creature = unit({ x: 20, y: 0, orientation: 1.0 });
  const player = unit({ typeId: 4, x: -4, y: 0, orientation: -2.0 }); // killed in melee, ran on, turned on the spot
  const objects = world(creature, player);
  assert.equal(unitAutoFacing(creature, objects), undefined, "the creature keeps its spline's facing");
  assert.equal(unitAutoFacing(player, objects), undefined, "the player keeps the facing he turned to");
});

test("5.32 a seat that does not turn its passenger keeps its facing; a turning seat faces the target", () => {
  const vehicle = unit({ x: 0, y: 0 });
  const victim = unit({ x: 0, y: 9 });
  const rider = unit({ x: 1, y: 0, target: victim.guid, transport: { guid: vehicle.guid, seat: 0 } });
  const objects = world(vehicle, victim, rider);
  const facing = () => 0.75;
  assert.equal(unitSeatFacing(rider, objects, 0, facing), undefined, "no ALLOW_TURNING");
  close(unitSeatFacing(rider, objects, VEHICLE_SEAT_FLAG_ALLOW_TURNING, facing), Math.atan2(9, -1) - 0.75, "target − vehicle");
});

test("5.32 a vehicle's own aim comes before its target; an aim not in view keeps its facing", () => {
  const enemy = unit({ x: 5, y: 0 });
  const passenger = unit({ typeId: 4, x: 0, y: -2 });
  const vehicle = unit({ x: 0, y: 0, target: enemy.guid });
  const objects = world(enemy, passenger, vehicle);
  close(unitAutoFacing(vehicle, objects), 0, "its target");
  close(unitAutoFacing(vehicle, objects, undefined, undefined, undefined, passenger.guid), -Math.PI / 2, "its boarder");
  assert.equal(unitAutoFacing(vehicle, objects, undefined, undefined, undefined, 999n), undefined, "not the target instead");
});

test("5.32 boarding seat 3788 or 4786 aims the vehicle; the aim ends with that passenger's animation", () => {
  // VehicleSeat.dbc rows of the dataset — the only two with FlagsB 0x800000.
  const row = (flags, flagsB, vehicleEnterAnim) => ({
    flags, flagsB, vehicleEnterAnim, vehicleEnterAnimBone: -1, vehicleExitAnim: -1, vehicleExitAnimBone: -1,
    vehicleRideAnimLoop: -1, vehicleRideAnimLoopBone: -1, vehicleEnterAnimDelay: 0, vehicleExitAnimDelay: 0,
  });
  assert.equal(seatAimsVehicle(row(0x842e00a, 0x8a0141, 112)), true, "seat 3788");
  assert.equal(seatAimsVehicle(row(0x42a04e, 0x2880041, 213)), true, "seat 4786");
  assert.equal(seatAimsVehicle(row(0x842e00a, 0x8a0141 & ~SEAT_FLAG_B_VEHICLE_FACES_PASSENGER, 112)), false, "no FlagsB bit");
  assert.equal(seatAimsVehicle(row(0x842e00a & ~0x400000, 0x8a0141, 112)), false, "no enter animation flag");
  assert.equal(seatAimsVehicle(row(0x842e00a, 0x8a0141, 0x1fa)), false, "no enter animation");
  const aims = new VehicleAims();
  aims.aim(1n, 10n);
  aims.aim(1n, 11n);
  assert.equal(aims.of(1n), 11n, "a later boarding takes it over");
  aims.ended(1n, 10n);
  assert.equal(aims.of(1n), 11n, "another passenger's end leaves it");
  aims.ended(1n, 11n);
  assert.equal(aims.of(1n), undefined);
  aims.aim(2n, 12n);
  aims.sweep((guid) => guid !== 2n);
  assert.equal(aims.of(2n), undefined, "a vehicle gone from view loses it");
});
