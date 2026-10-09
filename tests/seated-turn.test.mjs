import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import {
  advancePhysics, beginHeld, endHeld, flushFacing, forgetMovementState, releaseAllInput, requestMoverPitch, setSteering,
  turnCharacterBy,
} from "../dist/code/browser/input/Movement.js";
import { seatAllowsTurning, seatedTurnSnapshot, seatedTurnSync, seatedTurner } from "../dist/code/browser/input/SeatedTurn.js";
import { startVehicleData, vehicleCatalog } from "../dist/code/browser/VehicleClient.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { PacketReader, PacketWriter } from "../dist/code/protocol/index.js";
import { MOVEMENT_FLAGS, parseMovementPacket, writeMovementInfo } from "../dist/code/world/MovementProtocol.js";
import {
  VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_COLUMN, VEHICLE_SEAT_FORMAT, vehicleCatalogFrom,
} from "../dist/code/world/VehicleDbc.js";
import { VEHICLE_FLAGS as F, VEHICLE_SEAT_FLAGS as S } from "../dist/code/world/VehicleSeatModel.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

// 11.02-input: a mover held in a vehicle seat (11.02-A) turns — and a pitching one pitches — when its seat row has
// ALLOW_TURNING 0x400, sending what Wow.exe 3.3.5a sends with the transport block the core places it from
// (browser/input/SeatedTurn.ts, hooks in Movement.ts, WorldClient.sendSeatedMovement). Wow.exe (Ghidra read-only,
// .runtime/re-2026-10-03/l1102input/r1-r3.c): 0x005fbbc0 runs the turn keys and an ALWAYS_ALLOW_PITCHING mover's
// pitch keys only while 0x005fa0d0 → 0x0074b900 allows (the seat row has 0x400); the event queue 0x006ef860 passes
// the turn/pitch/facing events of a seated unit; 0x007413f0 drops pitch opcodes without SWIMMING|FLYING or
// ALWAYS_ALLOW_PITCHING, keeps a FULL_SPEED mover's START back and sends SET_FACING/SET_PITCH at its STOP
// (0x007219f0/0x00721ac0), and skips SET_FACING/SET_PITCH under 0.1 of change (0x0071ae80). The core takes the
// MovementInfo whole (MovementHandler.cpp:378) and relocates passengers from `transport.pos` (Vehicle.cpp:633-636).

const SELF = 0x1n;
const BASE = 0xf150_7d9a_0000_0075n; // a siege engine: HighGuid::Vehicle
const TURRET = 0xf150_7d9a_0000_0074n; // its turret accessory in slot 7

const BASE_KIT = 9117;
const TURRET_KIT = 9116; // like 116: NO_STRAFE, NO_JUMPING, FULLSPEED turning and pitching, ALLOW_PITCHING, CUSTOM_PITCH
const PLAIN_TURRET_KIT = 9216; // ALLOW_PITCHING and CUSTOM_PITCH only: the START/STOP path
const SEAT = {
  driver: [91648, S.CAN_CONTROL | S.CAN_ENTER_OR_EXIT],
  turning: [91651, S.ALLOW_TURNING | S.CAN_ENTER_OR_EXIT],
  fixed: [91649, S.CAN_ENTER_OR_EXIT],
  turretMount: [91652, 0x03006408], // seat 1652: ALLOW_TURNING, CAN_ATTACK, ENABLE_VEHICLE_ZOOM, CAN_ENTER_OR_EXIT
  gunner: [91643, 0x67100a0f], // seat 1643: CAN_CONTROL, no ALLOW_TURNING
};
const OFFSET = { x: 1.5, y: -0.75, z: 2.25 };

function vehicleRow({ id, flags = 0, seats = [], pitchMin = 0, pitchMax = 0 }) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  row[VEHICLE_COLUMN.Flags] = flags >>> 0;
  row[VEHICLE_COLUMN.PitchMin] = pitchMin;
  row[VEHICLE_COLUMN.PitchMax] = pitchMax;
  seats.forEach((seat, slot) => { row[VEHICLE_COLUMN.SeatID + slot] = seat; });
  return row;
}
function seatRow([id, flags]) {
  const row = [...VEHICLE_SEAT_FORMAT].map(() => 0);
  row[VEHICLE_SEAT_COLUMN.ID] = id;
  row[VEHICLE_SEAT_COLUMN.Flags] = flags >>> 0;
  row[VEHICLE_SEAT_COLUMN.AttachmentOffsetX] = OFFSET.x;
  row[VEHICLE_SEAT_COLUMN.AttachmentOffsetY] = OFFSET.y;
  row[VEHICLE_SEAT_COLUMN.AttachmentOffsetZ] = OFFSET.z;
  return row;
}
const TURRET_FLAGS = F.NO_STRAFE | F.NO_JUMPING | F.FULLSPEEDTURNING | F.ALLOW_PITCHING | F.FULLSPEEDPITCHING | F.CUSTOM_PITCH;
const ANSWER = {
  version: VEHICLE_CATALOG_VERSION,
  vehicles: [
    vehicleRow({ id: BASE_KIT, flags: F.NO_STRAFE, seats: [SEAT.driver[0], SEAT.turning[0], SEAT.fixed[0], 0, 0, 0, 0, SEAT.turretMount[0]] }),
    vehicleRow({ id: TURRET_KIT, flags: TURRET_FLAGS, seats: [SEAT.gunner[0]], pitchMin: -0.2, pitchMax: 0.8 }),
    vehicleRow({ id: PLAIN_TURRET_KIT, flags: F.ALLOW_PITCHING | F.CUSTOM_PITCH, seats: [SEAT.gunner[0]], pitchMin: -0.2, pitchMax: 0.8 }),
  ],
  seats: Object.values(SEAT).map(seatRow),
  indicators: [],
  indicatorSeats: [],
};

let gatewayCount = 0;
async function useTables(answer) {
  gatewayCount++;
  const fetch = answer === undefined
    ? () => new Promise(() => {})
    : async () => new Response(JSON.stringify(answer), { status: 200 });
  const client = startVehicleData(`ws://127.0.1.${gatewayCount}:18090`, { fetch });
  if (answer !== undefined) await client.load();
  return vehicleCatalog();
}

const floatBits = (value) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
};
const toggles = (extra = {}) => ({
  rooted: false, waterWalking: false, featherFall: false, hovering: false,
  canFly: false, gravityDisabled: false, collisionHeight: 0, ...extra,
});
const BASE_FACING = 1;

/**
 * The character seated on the base (`slot`), or in the turret seated on the base's slot 7 (`turret`): the shape
 * of movement-vehicle.test.mjs with `sendSeatedMovement` recording what `WorldClient` would be handed.
 */
function seatedWorld({ slot = 1, turret, rooted = true } = {}) {
  const sent = [];
  const seated = [];
  const base = {
    guid: BASE, typeId: 3, movementFlags: 0, vehicleId: BASE_KIT,
    position: { x: 100, y: 200, z: 10, orientation: BASE_FACING },
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset, floatBits(3)]]),
  };
  const turretUnit = turret === undefined ? undefined : {
    guid: TURRET, typeId: 3, movementFlags: MOVEMENT_FLAGS.onTransport | MOVEMENT_FLAGS.root, vehicleId: turret,
    position: { x: 0, y: 0, z: 0, orientation: BASE_FACING },
    transport: { guid: BASE, ...OFFSET, orientation: 0, seat: 7 },
    speeds: new Map([["turnRate", Math.PI], ["pitchRate", 1]]),
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset, floatBits(1)]]),
  };
  const character = {
    guid: SELF, typeId: 4, movementFlags: MOVEMENT_FLAGS.onTransport | MOVEMENT_FLAGS.root,
    position: { x: 0, y: 0, z: 0, orientation: BASE_FACING },
    transport: turret === undefined ? { guid: BASE, ...OFFSET, orientation: 0, seat: slot } : { guid: TURRET, x: 0, y: 0, z: 1, orientation: 0, seat: 0 },
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset, floatBits(0.3)]]),
  };
  const objects = new Map([[SELF, character], [BASE, base]]);
  if (turretUnit) objects.set(TURRET, turretUnit);
  const world = {
    mapId: 0,
    movementReady: true,
    controlledGuid: turret === undefined ? SELF : TURRET,
    state: { selfGuid: SELF, objects },
    movementState: toggles({ rooted }),
    speeds: new Map([["turnRate", Math.PI]]),
    movementStateOf: (guid) => (guid === SELF ? world.movementState : toggles()),
    speedsOf: (guid) => (guid === SELF ? world.speeds : new Map()),
    sendMovement: (opcode) => sent.push(["sendMovement", opcode]),
    sendMovementAs: (guid, opcode) => sent.push(["sendMovementAs", guid, opcode]),
    sendSeatedMovement: (guid, opcode, info) => {
      seated.push({ guid, opcode, info: JSON.parse(JSON.stringify(info, (_, value) => (typeof value === "bigint" ? `${value}` : value))) });
      return true;
    },
  };
  return { world, sent, seated, character, base, turret: turretUnit };
}

function withWorld(world, body) {
  forgetMovementState();
  game.world = world;
  game.worldLoading = false;
  game.terrain = { heightAt: () => 0, liquidAt: () => undefined, isHole: () => false };
  const pitch = game.camera.pitch;
  try {
    body();
  } finally {
    releaseAllInput();
    setSteering(false);
    forgetMovementState();
    game.world = undefined;
    game.terrain = undefined;
    game.camera.pitch = pitch;
  }
}

const opcodes = (seated) => seated.map((packet) => packet.opcode);
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-4, `${label}: ${actual} vs ${expected}`);
const TWO_PI = Math.PI * 2;

test("11.02-input: a passenger of an ALLOW_TURNING seat turns on it — START/STOP_TURN with the seat, no heartbeat", async () => {
  await useTables(ANSWER);
  const { world, sent, seated, character } = seatedWorld({ slot: 1 });
  withWorld(world, () => {
    beginHeld("turnLeft");
    assert.deepEqual(opcodes(seated), [OPCODES.MSG_MOVE_START_TURN_LEFT]);
    const start = seated[0].info;
    assert.equal(seated[0].guid, SELF);
    assert.equal(start.flags & MOVEMENT_FLAGS.onTransport, MOVEMENT_FLAGS.onTransport);
    assert.equal(start.flags & MOVEMENT_FLAGS.turnLeft, MOVEMENT_FLAGS.turnLeft);
    assert.equal(start.flags & MOVEMENT_FLAGS.root, MOVEMENT_FLAGS.root, "the boarding's root, as the ACK carries it");
    assert.deepEqual([start.transport.guid, start.transport.x, start.transport.y, start.transport.z, start.transport.seat],
      [`${BASE}`, OFFSET.x, OFFSET.y, OFFSET.z, 1], "the seat as the core holds it");
    assert.equal(start.flags2, 0);
    assert.equal(start.pitch, undefined);
    for (let frame = 0; frame < 5; frame++) advancePhysics(0.1);
    assert.equal(seated.length, 1, "nothing while only turning (0x006ef860 schedules no heartbeat)");
    near(character.transport.orientation, Math.PI * 0.5, "the seat's facing at π rad/s for 0.5 s");
    near(character.position.orientation, BASE_FACING + Math.PI * 0.5, "the drawn facing over the carrier's");
    endHeld("turnLeft");
    assert.deepEqual(opcodes(seated), [OPCODES.MSG_MOVE_START_TURN_LEFT, OPCODES.MSG_MOVE_STOP_TURN]);
    const stop = seated[1].info;
    assert.equal(stop.flags & (MOVEMENT_FLAGS.turnLeft | MOVEMENT_FLAGS.turnRight), 0);
    near(stop.transport.orientation, Math.PI * 0.5, "the stop carries the facing on the seat");
    near(stop.position.orientation, BASE_FACING + Math.PI * 0.5, "and the world facing (SetOrientation for ALLOW_TURNING)");
    assert.equal(stop.transport.seat, 1);
    beginHeld("turnRight");
    advancePhysics(0.25);
    endHeld("turnRight");
    near(character.transport.orientation, Math.PI * 0.25, "back the other way");
    assert.deepEqual(opcodes(seated).slice(2), [OPCODES.MSG_MOVE_START_TURN_RIGHT, OPCODES.MSG_MOVE_STOP_TURN]);
    // Forward and strafe stay refused to a seated mover (0x005fac90): nothing moves, nothing is sent.
    beginHeld("moveForward");
    beginHeld("strafeLeft");
    advancePhysics(0.2);
    assert.equal(seated.length, 4);
    assert.deepEqual([character.transport.x, character.transport.y], [OFFSET.x, OFFSET.y]);
  });
  assert.deepEqual(sent, [], "never a packet without the block");
});

test("11.02-input: the mouse turns the seat too — SET_FACING by 0x0071ae80's 0.1, and the last facing at the drag's end", async () => {
  await useTables(ANSWER);
  const { world, sent, seated, character } = seatedWorld({ slot: 1 });
  withWorld(world, () => {
    assert.equal(turnCharacterBy(0.05), true, "the camera's offset is spent turning the passenger");
    assert.deepEqual(seated, [], "under 0.1 since the last packet: nothing yet");
    near(character.transport.orientation, 0.05, "seat");
    assert.equal(turnCharacterBy(0.06), true);
    assert.deepEqual(opcodes(seated), [OPCODES.MSG_MOVE_SET_FACING]);
    near(seated[0].info.transport.orientation, 0.11, "the SET_FACING facing on the seat");
    assert.equal(turnCharacterBy(0.02), true);
    assert.equal(seated.length, 1);
    flushFacing();
    assert.deepEqual(opcodes(seated), [OPCODES.MSG_MOVE_SET_FACING, OPCODES.MSG_MOVE_SET_FACING]);
    near(seated[1].info.transport.orientation, 0.13, "the drag's last facing");
    flushFacing();
    assert.equal(seated.length, 2, "nothing moved since: nothing more");
    turnCharacterBy(-0.2);
    near(character.transport.orientation, TWO_PI - 0.07, "kept in [0, 2π) as the server keeps it");
  });
  assert.deepEqual(sent, []);
});

test("11.02-input: a seat without ALLOW_TURNING, a page without tables, the boarding glide and a stun keep 11.02-A's silence", async () => {
  await useTables(ANSWER);
  for (const slot of [0, 2]) {
    const { world, sent, seated, character } = seatedWorld({ slot });
    withWorld(world, () => {
      beginHeld("turnLeft");
      advancePhysics(0.3);
      endHeld("turnLeft");
      assert.equal(turnCharacterBy(0.5), false, "the camera turns instead");
      flushFacing();
      assert.equal(character.transport.orientation, 0, `slot ${slot}: the seat is not turned`);
    });
    assert.deepEqual([...sent, ...seated], [], `slot ${slot}: nothing at all`);
  }
  {
    const { world, sent, seated, character } = seatedWorld({ slot: 1 });
    character.motion = { spline: true }; // the boarding spline (serverControlsMovement)
    withWorld(world, () => {
      beginHeld("turnLeft");
      advancePhysics(0.3);
      assert.equal(turnCharacterBy(0.5), false);
    });
    assert.deepEqual([...sent, ...seated], [], "the boarding glide");
  }
  {
    const { world, sent, seated, character } = seatedWorld({ slot: 1 });
    withWorld(world, () => {
      beginHeld("turnLeft");
      advancePhysics(0.1);
      character.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x0004_0000); // UNIT_FLAG_STUNNED
      advancePhysics(0.1);
      const facing = character.transport.orientation;
      advancePhysics(0.2);
      assert.equal(character.transport.orientation, facing, "a stun holds the facing");
      assert.equal(turnCharacterBy(0.5), false);
    });
    assert.deepEqual(opcodes(seated), [OPCODES.MSG_MOVE_START_TURN_LEFT, OPCODES.MSG_MOVE_STOP_TURN], "the stun stops the turn");
    assert.deepEqual(sent, []);
  }
  await useTables(undefined);
  {
    const { world, sent, seated, character } = seatedWorld({ slot: 1 });
    withWorld(world, () => {
      beginHeld("turnLeft");
      advancePhysics(0.3);
      assert.equal(turnCharacterBy(0.5), false);
    });
    assert.deepEqual([...sent, ...seated], [], "no tables: nothing is known of the seat");
    assert.equal(character.transport.orientation, 0);
  }
});

test("11.02-input: the turret on its base (FULL_SPEED turning and pitching) sends SET_FACING and SET_PITCH at the stops", async () => {
  await useTables(ANSWER);
  const { world, sent, seated, turret } = seatedWorld({ turret: TURRET_KIT });
  withWorld(world, () => {
    beginHeld("turnLeft");
    assert.deepEqual(seated, [], "0x007219f0 keeps a FULL_SPEED mover's START back");
    advancePhysics(0.2);
    near(turret.transport.orientation, Math.PI * 0.2, "the turret turns on its base at its own rate");
    near(turret.position.orientation, BASE_FACING + Math.PI * 0.2, "drawn over the base");
    endHeld("turnLeft");
    assert.deepEqual(opcodes(seated), [OPCODES.MSG_MOVE_SET_FACING], "its STOP is SET_FACING");
    const facing = seated[0].info;
    assert.equal(seated[0].guid, TURRET);
    assert.equal(facing.flags2, 0x3b, "the turret's MovementFlags2 (Vehicle.cpp:684-698)");
    assert.deepEqual([facing.transport.guid, facing.transport.seat], [`${BASE}`, 7], "the turret's own seat on the base");
    assert.equal(facing.flags & MOVEMENT_FLAGS.root, MOVEMENT_FLAGS.root, "the spline root the core gave the creature");
    assert.equal(facing.pitch, 0, "ALWAYS_ALLOW_PITCHING puts the pitch on the wire");
    // A quick tap that moved under 0.1 sends nothing at all (0x0071ae80).
    beginHeld("turnRight");
    advancePhysics(0.01);
    endHeld("turnRight");
    assert.equal(seated.length, 1);
    // The pitch keys on the ground (ALWAYS_ALLOW_PITCHING), in the band, SET_PITCH at the stop.
    beginHeld("pitchUp");
    assert.equal(seated.length, 1, "0x00721ac0 keeps the START_PITCH back");
    for (let frame = 0; frame < 10; frame++) advancePhysics(0.1);
    endHeld("pitchUp");
    assert.deepEqual(opcodes(seated), [OPCODES.MSG_MOVE_SET_FACING, OPCODES.MSG_MOVE_SET_PITCH]);
    near(seated[1].info.pitch, 0.8, "held at PitchMax");
    // The aim (VehicleAimRequest*/Increment, 0x005fb3a0) and the steer: SET_PITCH once it moved 0.1.
    assert.equal(requestMoverPitch(0.75), true);
    advancePhysics(0.016);
    assert.equal(seated.length, 2, "0.05: not yet");
    assert.equal(requestMoverPitch(0.1), true);
    advancePhysics(0.016);
    assert.deepEqual(opcodes(seated).slice(2), [OPCODES.MSG_MOVE_SET_PITCH]);
    near(seated[2].info.pitch, 0.1, "the aimed pitch");
    // The mouse turns the turret with the camera on it.
    world.state.objects.get(SELF).fields.set(UPDATE_FIELDS.PLAYER_FARSIGHT.offset, Number(TURRET & 0xffff_ffffn));
    world.state.objects.get(SELF).fields.set(UPDATE_FIELDS.PLAYER_FARSIGHT.offset + 1, Number(TURRET >> 32n));
    assert.equal(turnCharacterBy(0.3), true);
    assert.deepEqual(opcodes(seated).slice(3), [OPCODES.MSG_MOVE_SET_FACING]);
  });
  assert.deepEqual(sent, [], "never sendMovementAs for the seated turret (11.02-A review)");
});

test("11.02-input: a turret without FULL_SPEED turning and pitching sends START/STOP_TURN and START/STOP_PITCH", async () => {
  await useTables(ANSWER);
  const { world, sent, seated } = seatedWorld({ turret: PLAIN_TURRET_KIT });
  withWorld(world, () => {
    beginHeld("turnRight");
    advancePhysics(0.1);
    endHeld("turnRight");
    beginHeld("pitchDown");
    advancePhysics(0.1);
    endHeld("pitchDown");
  });
  assert.deepEqual(opcodes(seated), [OPCODES.MSG_MOVE_START_TURN_RIGHT, OPCODES.MSG_MOVE_STOP_TURN,
    OPCODES.MSG_MOVE_START_PITCH_DOWN, OPCODES.MSG_MOVE_STOP_PITCH]);
  assert.equal(seated[0].info.flags & MOVEMENT_FLAGS.turnRight, MOVEMENT_FLAGS.turnRight);
  assert.equal(seated[2].info.flags & MOVEMENT_FLAGS.pitchDown, MOVEMENT_FLAGS.pitchDown);
  near(seated[3].info.pitch, -0.1, "pitched down at 1 rad/s for 0.1 s");
  assert.equal(seated[0].info.flags2, 0x20);
  assert.deepEqual(sent, []);
});

test("11.02-input: a FIXED_POSITION turret keeps its limits around the offset's create orientation; a creature carrier is no vehicle", async () => {
  const FIXED_KIT = 9316;
  const answer = JSON.parse(JSON.stringify(ANSWER));
  const fixed = vehicleRow({ id: FIXED_KIT, flags: F.FIXED_POSITION });
  fixed[VEHICLE_COLUMN.FacingLimitRight] = 0.1;
  fixed[VEHICLE_COLUMN.FacingLimitLeft] = 0.3;
  answer.vehicles.push(fixed);
  await useTables(answer);
  const { world, seated, turret } = seatedWorld({ turret: FIXED_KIT });
  turret.vehicleOrientation = 0; // Object.cpp:463-467: the transport offset's orientation for a unit on a transport
  withWorld(world, () => {
    beginHeld("turnLeft");
    advancePhysics(0.5);
    endHeld("turnLeft");
    near(turret.transport.orientation, 0.3, "base + FacingLimitLeft (0x006eaa50)");
    beginHeld("turnRight");
    advancePhysics(0.5);
    endHeld("turnRight");
    near(turret.transport.orientation, TWO_PI - 0.1, "base − FacingLimitRight");
  });
  assert.deepEqual(opcodes(seated), [OPCODES.MSG_MOVE_START_TURN_LEFT, OPCODES.MSG_MOVE_STOP_TURN,
    OPCODES.MSG_MOVE_START_TURN_RIGHT, OPCODES.MSG_MOVE_STOP_TURN]);
  // A HighGuid::Unit creature (0xF130) carrying the character is not a vehicle (0x0074b900 → 0x0074b8b0): held.
  await useTables(ANSWER);
  const creature = seatedWorld({ slot: 1 });
  const CARRIER = 0xf130_0000_0000_0075n;
  creature.world.state.objects.set(CARRIER, { ...creature.base, guid: CARRIER });
  creature.character.transport.guid = CARRIER;
  withWorld(creature.world, () => {
    beginHeld("turnLeft");
    advancePhysics(0.2);
  });
  assert.deepEqual([...creature.seated, ...creature.sent], []);
  assert.equal(creature.character.transport.orientation, 0);
});

test("11.02-input: a passenger has no pitch to send, and its ACK carries the seat with the keys it holds", async () => {
  await useTables(ANSWER);
  const { world, seated } = seatedWorld({ slot: 1 });
  withWorld(world, () => {
    beginHeld("pitchUp");
    advancePhysics(0.2);
    assert.deepEqual(seated, [], "0x007413f0: no pitch opcode without SWIMMING|FLYING or ALWAYS_ALLOW_PITCHING");
    // The module's own rule, asked directly with a pitch key down (Movement's pitch axis is 0 here anyway).
    assert.equal(seatedTurnSync(world, 0, 1, 0.3), true);
    assert.equal(seatedTurnSync(world, 0, 0, 0.3), true);
    assert.deepEqual(seated, [], "a seated mover without ALWAYS_ALLOW_PITCHING sends no START/STOP_PITCH");
    beginHeld("turnLeft");
    advancePhysics(0.1);
    const ack = seatedTurnSnapshot(world, SELF, 0);
    assert.equal(ack.flags & MOVEMENT_FLAGS.turnLeft, MOVEMENT_FLAGS.turnLeft);
    assert.equal(ack.flags & MOVEMENT_FLAGS.onTransport, MOVEMENT_FLAGS.onTransport);
    assert.deepEqual([ack.transport.guid, ack.transport.seat], [BASE, 1]);
    near(ack.transport.orientation, Math.PI * 0.1, "the facing it has now");
    assert.equal(seatedTurnSnapshot(world, BASE, 0), undefined, "only the mover's");
  });
});

test("11.02-input: on foot and in a driven vehicle nothing goes through the seated path", async () => {
  await useTables(ANSWER);
  const { world, sent, seated, character } = seatedWorld({ slot: 1 });
  character.transport = undefined;
  character.movementFlags = 0;
  world.movementState.rooted = false;
  withWorld(world, () => {
    beginHeld("turnLeft");
    advancePhysics(0.1);
    endHeld("turnLeft");
    turnCharacterBy(0.2);
    flushFacing();
  });
  assert.deepEqual(seated, []);
  const order = [OPCODES.MSG_MOVE_START_TURN_LEFT, OPCODES.MSG_MOVE_STOP_TURN, OPCODES.MSG_MOVE_SET_FACING, OPCODES.MSG_MOVE_SET_FACING];
  let at = 0;
  for (const [, opcode] of sent) if (opcode === order[at]) at++;
  assert.equal(at, order.length, `the character's own packets as before: ${sent.map(([, opcode]) => opcode)}`);
  assert.ok(sent.every(([kind]) => kind === "sendMovement"));
  // The driver of the base itself (not seated: the base rides nothing) moves it as 11.02-A does.
  const driven = seatedWorld({ slot: 0 });
  driven.world.controlledGuid = BASE;
  withWorld(driven.world, () => {
    beginHeld("turnLeft");
    endHeld("turnLeft");
  });
  assert.deepEqual(driven.seated, []);
  assert.deepEqual(driven.sent.map(([kind, guid, opcode]) => [kind, guid, opcode]),
    [["sendMovementAs", BASE, OPCODES.MSG_MOVE_START_TURN_LEFT], ["sendMovementAs", BASE, OPCODES.MSG_MOVE_STOP_TURN]]);
});

// ---- the bytes, through the real WorldClient ------------------------------------------------------

async function realClient() {
  const login = new PacketWriter().u32(0).f32(10).f32(20).f32(30).f32(0).toUint8Array();
  const waiters = [];
  const connection = {
    packets: [{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login }],
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (this.packets.length) return Promise.resolve(this.packets.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {},
  };
  const client = new WorldClient(connection);
  client.state.selfGuid = SELF;
  await client.loginCharacter(SELF);
  await new Promise((resolve) => setImmediate(resolve));
  client.state.move(BASE, { flags: 0, position: { x: 100, y: 200, z: 10, orientation: BASE_FACING } });
  client.state.objects.get(BASE).typeId = 3;
  client.state.move(SELF, { flags: MOVEMENT_FLAGS.onTransport, position: { x: 0, y: 0, z: 0, orientation: 0 },
    transport: { guid: BASE, ...OFFSET, orientation: 0, time: 0, seat: 1 } });
  client.state.objects.get(SELF).typeId = 4;
  const deliver = async (opcode, payload) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ opcode, payload });
    else connection.packets.push({ opcode, payload });
    await new Promise((resolve) => setImmediate(resolve));
  };
  // The server hands the character over (a passenger seat keeps it the mover).
  await deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, new PacketWriter().packedGuid(SELF).u8(1).toUint8Array());
  return { client, connection, deliver };
}

const seatInfo = (overrides = {}) => ({
  flags: MOVEMENT_FLAGS.onTransport | MOVEMENT_FLAGS.root | MOVEMENT_FLAGS.turnLeft,
  flags2: 0,
  time: 1234,
  position: { x: 101, y: 201, z: 12.25, orientation: 1.5 },
  transport: { guid: BASE, ...OFFSET, orientation: 0.5, time: 1234, seat: 1 },
  fallTime: 0,
  ...overrides,
});

test("11.02-input: WorldClient.sendSeatedMovement writes ReadMovementInfo's layout with the block, and nothing without it", async () => {
  const { client, connection } = await realClient();
  const before = connection.sent.length;
  assert.equal(client.sendSeatedMovement(SELF, OPCODES.MSG_MOVE_START_TURN_LEFT, seatInfo()), true);
  const packet = connection.sent.at(-1);
  assert.equal(packet.opcode, OPCODES.MSG_MOVE_START_TURN_LEFT);
  // WorldSession::ReadMovementInfo (WorldSession.cpp:960-984): packed guid, u32 flags, u16 flags2, u32 time,
  // x y z o; with ONTRANSPORT packed transport guid, x y z o, u32 time, u8 seat; pitch only for
  // SWIMMING|FLYING or ALWAYS_ALLOW_PITCHING; u32 fall time.
  const reader = new PacketReader(packet.payload);
  assert.equal(reader.packedGuid(), SELF);
  assert.equal(reader.u32(), MOVEMENT_FLAGS.onTransport | MOVEMENT_FLAGS.root | MOVEMENT_FLAGS.turnLeft);
  assert.equal(reader.u16(), 0);
  assert.equal(reader.u32(), 1234);
  near(reader.f32(), 101, "x");
  reader.f32(); reader.f32();
  near(reader.f32(), 1.5, "o");
  assert.equal(reader.packedGuid(), BASE);
  near(reader.f32(), OFFSET.x, "tx");
  near(reader.f32(), OFFSET.y, "ty");
  near(reader.f32(), OFFSET.z, "tz");
  near(reader.f32(), 0.5, "to");
  assert.equal(reader.u32(), 1234);
  assert.equal(reader.u8(), 1);
  assert.equal(reader.u32(), 0, "fall time — no pitch for a passenger");
  reader.assertFinished();
  // The turret's flags2 0x3b carries the pitch.
  const parsed = parseMovementPacket(writeOf(seatInfo({ flags2: 0x3b, pitch: 0.25 })));
  near(parsed.pitch, 0.25, "pitch");
  // Refused, with nothing sent: no block, no ONTRANSPORT, another seat or vehicle, not the mover, a server spline.
  const refusals = [
    seatInfo({ transport: undefined }),
    seatInfo({ flags: MOVEMENT_FLAGS.turnLeft }),
    seatInfo({ transport: { guid: BASE, ...OFFSET, orientation: 0.5, time: 1, seat: 2 } }),
    seatInfo({ transport: { guid: TURRET, ...OFFSET, orientation: 0.5, time: 1, seat: 1 } }),
  ];
  const count = connection.sent.length;
  for (const info of refusals) assert.equal(client.sendSeatedMovement(SELF, OPCODES.MSG_MOVE_SET_FACING, info), false);
  assert.equal(client.sendSeatedMovement(BASE, OPCODES.MSG_MOVE_SET_FACING, seatInfo()), false, "not the mover");
  client.state.objects.get(SELF).motion = { spline: true };
  assert.equal(client.sendSeatedMovement(SELF, OPCODES.MSG_MOVE_SET_FACING, seatInfo()), false, "on a server spline");
  client.state.objects.get(SELF).motion = undefined;
  client.state.objects.get(SELF).transport = undefined;
  assert.equal(client.sendSeatedMovement(SELF, OPCODES.MSG_MOVE_SET_FACING, seatInfo()), false, "not seated");
  assert.equal(connection.sent.length, count);
  assert.ok(connection.sent.length > before);
});

function writeOf(info) {
  return writeMovementInfo(new PacketWriter(), TURRET, info).toUint8Array();
}

test("11.02-input: end to end — the keys through Movement.ts reach the wire of the real WorldClient with the seat", async () => {
  await useTables(ANSWER);
  const { client, connection } = await realClient();
  client.state.objects.get(BASE).vehicleId = BASE_KIT;
  const base = connection.sent.length;
  withWorld(client, () => {
    beginHeld("turnLeft");
    advancePhysics(0.1);
    endHeld("turnLeft");
  });
  const packets = connection.sent.slice(base);
  assert.deepEqual(packets.map((packet) => packet.opcode), [OPCODES.MSG_MOVE_START_TURN_LEFT, OPCODES.MSG_MOVE_STOP_TURN]);
  const stop = parseMovementPacket(packets[1].payload);
  assert.equal(stop.guid, SELF);
  assert.equal(stop.flags & MOVEMENT_FLAGS.onTransport, MOVEMENT_FLAGS.onTransport);
  assert.deepEqual([stop.transport.guid, stop.transport.seat], [BASE, 1]);
  near(stop.transport.x, OFFSET.x, "the seat offset as the state holds it");
  near(stop.transport.orientation, Math.PI * 0.1, "turned on the seat");
  near(client.state.objects.get(SELF).transport.orientation, Math.PI * 0.1, "and the state keeps the turned seat");
});

// ---- 11.02-input review ---------------------------------------------------------------------------

test("11.02-input review: the seat decision follows the seat byte, the carrier's kit and the tables, not only the block's identity", () => {
  const catalog = vehicleCatalogFrom(JSON.parse(JSON.stringify(ANSWER)));
  const without = JSON.parse(JSON.stringify(ANSWER));
  without.seats = without.seats.map((row) => (row[VEHICLE_SEAT_COLUMN.ID] === SEAT.turning[0]
    ? seatRow([SEAT.turning[0], S.CAN_ENTER_OR_EXIT]) : row));
  const reloaded = vehicleCatalogFrom(without);
  const base = { guid: BASE, typeId: 3, vehicleId: BASE_KIT, fields: new Map() };
  const objects = new Map([[BASE, base]]);
  // One block object, changed in place the way WorldState updates a passenger's seat.
  const seat = { guid: BASE, x: 0, y: 0, z: 0, orientation: 0, seat: 1 };
  assert.equal(seatAllowsTurning(catalog, objects, seat), true, "slot 1: ALLOW_TURNING");
  seat.seat = 2;
  assert.equal(seatAllowsTurning(catalog, objects, seat), false, "slot 2 of the same block object");
  seat.seat = 1;
  assert.equal(seatAllowsTurning(catalog, objects, seat), true);
  base.vehicleId = TURRET_KIT;
  assert.equal(seatAllowsTurning(catalog, objects, seat), false, "a new kit (SMSG_SET_VEHICLE_REC_ID): its slot 1 has no seat");
  base.vehicleId = BASE_KIT;
  assert.equal(seatAllowsTurning(catalog, objects, seat), true);
  assert.equal(seatAllowsTurning(reloaded, objects, seat), false, "tables that arrived again say otherwise");
  seat.guid = 0xf130_0000_0000_0075n;
  objects.set(seat.guid, { ...base, guid: seat.guid });
  assert.equal(seatAllowsTurning(catalog, objects, seat), false, "a HighGuid::Unit carrier in the same block object");
});

test("11.02-input review: a glide (a seat change re-boards: Vehicle::AddPassenger's spline) drops the seated record — a held key goes out again after it", async () => {
  await useTables(ANSWER);
  const { world, sent, seated, character } = seatedWorld({ slot: 1 });
  withWorld(world, () => {
    beginHeld("turnLeft");
    advancePhysics(0.1);
    character.motion = { spline: true };
    advancePhysics(0.1);
    character.motion = undefined;
    advancePhysics(0.1);
    endHeld("turnLeft");
  });
  assert.deepEqual(opcodes(seated), [OPCODES.MSG_MOVE_START_TURN_LEFT, OPCODES.MSG_MOVE_START_TURN_LEFT,
    OPCODES.MSG_MOVE_STOP_TURN], "the turn starts again once the glide is over, as 11.02-A's held keys do (5.15)");
  assert.deepEqual(sent, []);
});

test("11.02-input review: before the first packet from a seat the 0.1 rule measures from the seat's own facing (what the core holds)", async () => {
  await useTables(ANSWER);
  const { world, seated, character } = seatedWorld({ slot: 1 });
  character.transport.orientation = 1; // the seat as the core placed it (transport.pos.o)
  withWorld(world, () => {
    turnCharacterBy(0.05);
    assert.deepEqual(seated, [], "0.05 from the seat's facing");
    turnCharacterBy(0.06);
  });
  assert.deepEqual(opcodes(seated), [OPCODES.MSG_MOVE_SET_FACING]);
  near(seated[0].info.transport.orientation, 1.11, "turned on the seat");
});

test("11.02-input review: a packet WorldClient refused is not the last one sent — the 0.1 rule measures from what went out", async () => {
  await useTables(ANSWER);
  const { world, seated } = seatedWorld({ slot: 1 });
  const accept = world.sendSeatedMovement;
  let refuse = true;
  world.sendSeatedMovement = (...args) => (refuse ? false : accept(...args));
  withWorld(world, () => {
    assert.equal(turnCharacterBy(0.15), true);
    refuse = false;
    turnCharacterBy(0.01);
  });
  assert.deepEqual(opcodes(seated), [OPCODES.MSG_MOVE_SET_FACING], "0.16 from the facing last sent");
  near(seated[0].info.transport.orientation, 0.16, "the facing now");
});

test("11.02-input: the hooks stand where they belong", () => {
  const movement = readFileSync(new URL("../src/browser/input/Movement.ts", import.meta.url), "utf8");
  for (const hook of ["seatedFrame(world, elapsed); // 11.02-input", "seatedTurnBy(game.world", "seatedFlushFacing(game.world",
    "seatedTurnSync(game.world", "seatedTurnSnapshot(world, guid", "forgetSeatedTurn(); // 11.02-input"]) {
    assert.ok(movement.includes(hook), hook);
  }
});

test("11.02-input: the dataset — the turret's seat on the siege engine turns, its crew's seats do not", async (t) => {
  const DATASET_DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
  if (!existsSync(DATASET_DBC)) {
    t.skip("no dataset");
    return;
  }
  const { loadVehicles } = await import("../dist/code/gateway/VehicleMetadata.js");
  const answer = JSON.parse(JSON.stringify(await loadVehicles(DATASET_DBC)));
  const real = vehicleCatalogFrom(answer);
  const allows = (vehicleId, slot) => seatAllowsTurning(real,
    new Map([[BASE, { guid: BASE, typeId: 3, vehicleId, fields: new Map() }]]), { guid: BASE, x: 0, y: 0, z: 0, orientation: 0, seat: slot });
  assert.equal(allows(117, 7), true, "turret 116 on seat 1652");
  assert.equal(allows(117, 0), false, "the driver 1648");
  assert.equal(allows(117, 1), false, "a gunner 1649");
  assert.equal(allows(116, 0), false, "the turret's gunner 1643 — the character in the turret does not turn itself");
  assert.equal(allows(312, 1), false, "a mammoth's passenger");
  let turning = 0;
  let passengers = 0;
  for (const row of answer.seats) {
    const flags = real.seat(row[0]).flags;
    if (flags & S.ALLOW_TURNING) {
      turning++;
      if ((flags & S.CAN_CONTROL) === 0) passengers++;
    }
  }
  assert.deepEqual([turning, passengers], [80, 68], "ALLOW_TURNING seats of the dataset, and those without CAN_CONTROL");
  // The turret's own row: FULL_SPEED turning and pitching, ALWAYS_ALLOW_PITCHING (flags2 0x3b).
  assert.equal(seatedTurner(undefined, real), undefined);
});
