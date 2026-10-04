import assert from "node:assert/strict";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import {
  advancePhysics, beginHeld, forgetMovementState, isMoving, lastPhysicsSubsteps, releaseAllInput, sendMovement,
} from "../dist/code/browser/input/Movement.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";

// 11.02-A (M7-1): the keys move the vehicle the server handed over (`controlledGuid`), at the
// vehicle's own rates and size; the character in the driving seat follows it; a character seated
// without control moves and sends nothing. The world below is the shape `movement-root-input` uses,
// with the vehicle half of `WorldClient` (`movementStateOf`, `speedsOf`, `sendMovementAs`) added.

const SELF = 0x1n;
const VEHICLE = 0xf150_7d9a_0000_0042n;
const SEAT = { guid: VEHICLE, x: 1.5, y: 0, z: 2.25, orientation: 0, seat: 0 };

const floatBits = (value) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
};
const toggles = () => ({
  rooted: false, waterWalking: false, featherFall: false, hovering: false,
  canFly: false, gravityDisabled: false, collisionHeight: 0,
});

function vehicleWorld({ controlled = VEHICLE, seated = true } = {}) {
  const sent = [];
  const character = {
    guid: SELF, typeId: 4, movementFlags: 0,
    position: { x: SEAT.x, y: SEAT.y, z: SEAT.z, orientation: 0 },
    transport: seated ? { ...SEAT } : undefined,
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset, floatBits(0.3)]]),
  };
  const vehicle = {
    guid: VEHICLE, typeId: 3, movementFlags: 0,
    position: { x: 0, y: 0, z: 0, orientation: 0 },
    // The CREATE block's rates (`speeds` on the object) and a forced one below.
    speeds: new Map([["run", 10]]),
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset, floatBits(3)]]),
  };
  const objects = new Map([[SELF, character], [VEHICLE, vehicle]]);
  const vehicleToggles = toggles();
  const vehicleSpeeds = new Map([["run", 14]]);
  const world = {
    mapId: 0,
    movementReady: true,
    controlledGuid: controlled,
    state: { selfGuid: SELF, objects },
    movementState: toggles(),
    speeds: new Map([["run", 7]]),
    movementStateOf: (guid) => (guid === SELF ? world.movementState : vehicleToggles),
    speedsOf: (guid) => (guid === SELF ? world.speeds : vehicleSpeeds),
    sendMovement: (opcode, flags, position, extra) => {
      sent.push({ guid: SELF, opcode, flags, position: { ...position }, extra });
      character.position = { ...character.position };
    },
    sendMovementAs: (guid, opcode, flags, position, extra) => {
      sent.push({ guid, opcode, flags, position: { ...position }, extra });
      // WorldState.move snaps the predicted unit into a fresh object on every send.
      objects.get(guid).position = { ...position };
    },
  };
  return { world, sent, character, vehicle, vehicleToggles };
}

function withWorld(world, body) {
  forgetMovementState();
  game.world = world;
  game.worldLoading = false;
  game.terrain = { heightAt: () => 0, liquidAt: () => undefined, isHole: () => false };
  try {
    body();
  } finally {
    releaseAllInput();
    forgetMovementState();
    game.world = undefined;
    game.terrain = undefined;
    game.worldLoading = false;
  }
}

test("11.02-A: the driven vehicle moves at its own speed under its own guid, and the driver follows", () => {
  const { world, sent, character, vehicle } = vehicleWorld();
  withWorld(world, () => {
    beginHeld("moveForward");
    assert.deepEqual(sent.map((packet) => [packet.guid, packet.opcode]), [[VEHICLE, OPCODES.MSG_MOVE_START_FORWARD]]);
    assert.equal(sent[0].flags & MOVEMENT_FLAGS.forward, MOVEMENT_FLAGS.forward);
    assert.equal(sent[0].flags & MOVEMENT_FLAGS.onTransport, 0, "the vehicle itself rides nothing");
    assert.equal(sent[0].extra.transport, undefined);

    for (let frame = 0; frame < 5; frame++) advancePhysics(0.1);
    // 14 yd/s is the rate the server forced on the vehicle: not the character's 7, not the CREATE 10.
    assert.ok(Math.abs(vehicle.position.x - 7) < 1e-6, `vehicle at ${vehicle.position.x}`);
    assert.equal(vehicle.position.y, 0);
    assert.ok(Math.abs(character.position.x - (vehicle.position.x + SEAT.x)) < 1e-9, "the driver sits on the seat");
    assert.equal(character.position.z, vehicle.position.z + SEAT.z);

    assert.equal(isMoving(), true);
    sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    assert.equal(sent.at(-1).guid, VEHICLE);
    assert.equal(sent.at(-1).position.x, vehicle.position.x, "the heartbeat says where the vehicle is");
    releaseAllInput();
    assert.deepEqual([sent.at(-1).guid, sent.at(-1).opcode], [VEHICLE, OPCODES.MSG_MOVE_STOP]);
    assert.ok(sent.every((packet) => packet.guid === VEHICLE), "not one packet for the character");
  });
});

test("11.02-A: the step is sized by the vehicle's bounding radius, not the character's", () => {
  const { world, vehicle } = vehicleWorld();
  withWorld(world, () => {
    beginHeld("moveForward");
    advancePhysics(0.1);
    // 1.4 yd in one frame: one substep under a 3-yard body; a 0.3-yard one would need ten.
    assert.equal(lastPhysicsSubsteps(), 1);
    assert.ok(vehicle.position.x > 1.39);
  });
});

test("11.02-A: a root on the vehicle (spline root bit or its toggle) holds the vehicle", () => {
  const { world, sent, vehicle, vehicleToggles } = vehicleWorld();
  vehicle.movementFlags = MOVEMENT_FLAGS.root;
  withWorld(world, () => {
    beginHeld("moveForward");
    advancePhysics(0.1);
    assert.equal(vehicle.position.x, 0);
    assert.equal(sent.length, 0, "input pressed under a root claims no movement");
    vehicle.movementFlags = 0;
    vehicleToggles.rooted = true;
    advancePhysics(0.1);
    assert.equal(vehicle.position.x, 0);
    vehicleToggles.rooted = false;
    advancePhysics(0.1);
    assert.deepEqual(sent.map((packet) => [packet.guid, packet.opcode]), [[VEHICLE, OPCODES.MSG_MOVE_START_FORWARD]]);
    advancePhysics(0.1);
    assert.ok(vehicle.position.x > 0);
  });
});

test("11.02-A: a drake's CAN_FLY from its create block holds it up, and its packets keep saying so", () => {
  const { world, sent, vehicle } = vehicleWorld();
  vehicle.position = { x: 0, y: 0, z: 30, orientation: 0 };
  // Creature::SetCanFly sends SMSG_SPLINE_MOVE_SET_FLYING, never the FORCE/ACK pair (Creature.cpp:3312-3324).
  vehicle.movementFlags = MOVEMENT_FLAGS.canFly;
  withWorld(world, () => {
    for (let frame = 0; frame < 10; frame++) advancePhysics(0.1);
    assert.ok(vehicle.position.z > 29.9, `the drake hangs in the air (z ${vehicle.position.z})`);
    beginHeld("moveForward");
    assert.equal(sent.at(-1).guid, VEHICLE);
    assert.equal(sent.at(-1).flags & MOVEMENT_FLAGS.canFly, MOVEMENT_FLAGS.canFly);
    assert.equal(sent.at(-1).flags & MOVEMENT_FLAGS.falling, 0);
  });
});

test("11.02-A: a character seated without control moves nothing and says nothing", () => {
  const { world, sent, character, vehicle } = vehicleWorld({ controlled: SELF });
  withWorld(world, () => {
    beginHeld("moveForward");
    beginHeld("jump");
    for (let frame = 0; frame < 5; frame++) advancePhysics(0.1);
    sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    assert.equal(sent.length, 0);
    assert.deepEqual([character.position.x, character.position.z], [SEAT.x, SEAT.z],
      "no step and no fall from the seat");
    assert.equal(vehicle.position.x, 0);
    assert.equal(isMoving(), false);
    assert.equal(world.movementSnapshot?.(SELF), undefined, "its ACK is WorldClient's, from the seat");
  });
});

test("11.02-A review: a controlled turret seated on its base (an accessory) moves nothing and says nothing", () => {
  // A siege engine's gun: the player boards the accessory's CAN_CONTROL seat, the accessory is charmed
  // (SMSG_CLIENT_CONTROL_UPDATE(turret, 1)) and is itself a passenger of the base vehicle. Its
  // MSG_MOVE_* would overwrite the seat RelocatePassengers places it from (Vehicle.cpp:633-636).
  const TURRET = 0xf150_7d9a_0000_0043n;
  const { world, sent, character, vehicle } = vehicleWorld({ controlled: TURRET });
  const turretSeat = { guid: VEHICLE, x: -2, y: 0, z: 3, orientation: 0, seat: 1 };
  const turret = {
    guid: TURRET, typeId: 3, movementFlags: MOVEMENT_FLAGS.onTransport,
    position: { x: -2, y: 0, z: 3, orientation: 0 }, transport: turretSeat,
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset, floatBits(1)]]),
  };
  world.state.objects.set(TURRET, turret);
  character.transport = { guid: TURRET, x: 0, y: 0, z: 1, orientation: 0, seat: 0 };
  withWorld(world, () => {
    beginHeld("moveForward");
    beginHeld("jump");
    for (let frame = 0; frame < 5; frame++) advancePhysics(0.1);
    sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    assert.equal(sent.length, 0, "no packet for the seated turret, none for the character");
    assert.deepEqual([turret.position.x, turret.position.y, turret.position.z], [-2, 0, 3], "the turret stays on its seat");
    assert.equal(vehicle.position.x, 0);
    assert.equal(isMoving(), false);
  });
});

test("11.02-A: taking the wheel with a key held starts the vehicle once; the snapshot is the vehicle's", () => {
  const { world, sent, character, vehicle } = vehicleWorld({ controlled: SELF, seated: false });
  character.position = { x: 5, y: 5, z: 0, orientation: 0 };
  withWorld(world, () => {
    advancePhysics(0.1);
    beginHeld("moveForward");
    assert.deepEqual(sent.map((packet) => [packet.guid, packet.opcode]), [[SELF, OPCODES.MSG_MOVE_START_FORWARD]]);
    // VehicleJoinEvent: the seat, then SMSG_CLIENT_CONTROL_UPDATE(vehicle, 1).
    character.transport = { ...SEAT };
    world.controlledGuid = VEHICLE;
    advancePhysics(0.1);
    assert.deepEqual(sent.slice(1).map((packet) => [packet.guid, packet.opcode]), [[VEHICLE, OPCODES.MSG_MOVE_START_FORWARD]]);
    advancePhysics(0.1);
    assert.equal(sent.length, 2, "the transition is not repeated");
    assert.ok(vehicle.position.x > 0);
    const snapshot = world.movementSnapshot(VEHICLE);
    assert.equal(snapshot.flags & MOVEMENT_FLAGS.forward, MOVEMENT_FLAGS.forward);
    assert.equal(snapshot.position.x, vehicle.position.x);
    assert.equal(world.movementSnapshot(SELF), undefined);
  });
});
