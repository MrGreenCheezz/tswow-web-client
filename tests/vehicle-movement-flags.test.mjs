import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import {
  advancePhysics, aimMoverPitchBy, beginHeld, characterPitchNow, endHeld, flushFacing, forgetMovementState, moverRefusesStrafe,
  releaseAllInput, sendMovement, setSteering, turnCharacterBy,
} from "../dist/code/browser/input/Movement.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import {
  MOVEMENT_FLAGS2, VEHICLE_DEFAULT_PITCH_LIMIT, VEHICLE_FLAG_CAMERA_PITCH, VEHICLE_FLAG_MOUSE_PITCH, clampVehicleFacing,
  clampVehiclePitch, moverVehicleRules, vehicleMovementFlags2, vehicleMoverRules, vehicleSteerPitchesFromCamera,
} from "../dist/code/browser/input/VehicleMovementFlags.js";
import { startVehicleData, vehicleCatalog } from "../dist/code/browser/VehicleClient.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { MOVEMENT_FLAGS, buildMovementPacket, parseMovementPacket, writeMovementInfo } from "../dist/code/world/MovementProtocol.js";
import {
  VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_FORMAT, vehicleCatalogFrom,
} from "../dist/code/world/VehicleDbc.js";
import { VEHICLE_FLAGS } from "../dist/code/world/VehicleSeatModel.js";

// 11.02-F3: the Vehicle.dbc flags of the unit the keys move (browser/input/VehicleMovementFlags.ts and its
// hooks in Movement.ts / Controls.ts). The rules are Wow.exe 3.3.5a's (.runtime/re-2026-10-03/l1102gf3):
// NO_STRAFE refuses a strafe (CMovement 0x00988b00) and rising in water/air (0x009898e0); ALLOW_PITCHING
// (MovementFlags2 ALWAYS_ALLOW_PITCHING, Vehicle.cpp:694-695) lets the pitch keys act on the ground
// (0x005fbbc0) and puts the pitch on the wire (WorldSession.cpp:982); a vehicle's pitch stays in its band
// (0x005fb3a0); the steer adds MouseLookOffsetPitch (0x005fbe70) when 0x005fa790 allows it; Flags 0x40000
// without 0x40000000 aims by the drag (0x00756f00/0x005fba60); FIXED_POSITION keeps the facing inside its
// limits around the create block's orientation (0x006eaa50, kit+0x50 from 0x00757fa0).

const F = VEHICLE_FLAGS;
const SELF = 0x1n;
const VEHICLE = 0xf150_7d9a_0000_0042n;
const SEAT = { guid: VEHICLE, x: 1.5, y: 0, z: 2.25, orientation: 0, seat: 0 };

const SIEGE = 9001;   // like Vehicle 117: NO_STRAFE, NO_JUMPING, FULLSPEEDTURNING, FULLSPEEDPITCHING
const CANNON = 9002;  // a fixed cannon: FIXED_POSITION, ALLOW_PITCHING, CUSTOM_PITCH, 0x40000 | 0x40000000
const AIMER = 9003;   // aims with the drag: ALLOW_PITCHING, 0x40000 alone
const KEYS = 9004;    // ALLOW_PITCHING only: the keys pitch it, the mouse does not
const DRAKE = 9005;   // a flier with a custom band and an offset
const PLAIN = 9006;   // flags 0

function vehicleRow({ id, flags = 0, pitchMin = 0, pitchMax = 0, mlop = 0, right = 0, left = 0 }) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  row[VEHICLE_COLUMN.Flags] = flags >>> 0;
  row[VEHICLE_COLUMN.TurnSpeed] = 1;
  row[VEHICLE_COLUMN.PitchSpeed] = 1;
  row[VEHICLE_COLUMN.PitchMin] = pitchMin;
  row[VEHICLE_COLUMN.PitchMax] = pitchMax;
  row[VEHICLE_COLUMN.MouseLookOffsetPitch] = mlop;
  row[VEHICLE_COLUMN.FacingLimitRight] = right;
  row[VEHICLE_COLUMN.FacingLimitLeft] = left;
  return row;
}

const ANSWER = {
  version: VEHICLE_CATALOG_VERSION,
  vehicles: [
    vehicleRow({ id: SIEGE, flags: F.NO_STRAFE | F.NO_JUMPING | F.FULLSPEEDTURNING | F.FULLSPEEDPITCHING }),
    vehicleRow({
      id: CANNON, flags: F.FIXED_POSITION | F.ALLOW_PITCHING | F.CUSTOM_PITCH | VEHICLE_FLAG_MOUSE_PITCH | VEHICLE_FLAG_CAMERA_PITCH,
      pitchMin: -0.2, pitchMax: 0.6, mlop: 0.5, right: 0.5, left: 0.25,
    }),
    vehicleRow({ id: AIMER, flags: F.ALLOW_PITCHING | VEHICLE_FLAG_MOUSE_PITCH }),
    vehicleRow({ id: KEYS, flags: F.ALLOW_PITCHING | F.CUSTOM_PITCH, pitchMin: -0.3, pitchMax: 0.4 }),
    vehicleRow({ id: DRAKE, flags: F.CUSTOM_PITCH, pitchMin: -0.5, pitchMax: 0.5, mlop: 0.3 }),
    vehicleRow({ id: PLAIN }),
  ],
  seats: [[...VEHICLE_SEAT_FORMAT].map((_, column) => (column === 0 ? 1 : 0))],
  indicators: [],
  indicatorSeats: [],
};

let gatewayCount = 0;
/** A page whose vehicle tables are `answer` (or none at all: a gateway that never answers). */
async function useTables(answer) {
  gatewayCount++;
  const fetch = answer === undefined
    ? () => new Promise(() => {})
    : async () => new Response(JSON.stringify(answer), { status: 200 });
  const client = startVehicleData(`ws://127.0.0.${gatewayCount}:18090`, { fetch });
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

const FARSIGHT = UPDATE_FIELDS.PLAYER_FARSIGHT.offset;

/**
 * The world of movement-vehicle.test.mjs, its vehicle carrying a kit (`vehicleId`, `vehicleOrientation`)
 * and the driver's PLAYER_FARSIGHT naming it, as the core writes it on taking the controls.
 */
function vehicleWorld({ vehicleId, orientation = 0, vehicleToggles = toggles(), z = 0 } = {}) {
  const sent = [];
  const character = {
    guid: SELF, typeId: 4, movementFlags: 0,
    position: { x: SEAT.x, y: SEAT.y, z: z + SEAT.z, orientation },
    transport: { ...SEAT },
    fields: new Map([
      [UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset, floatBits(0.3)],
      [FARSIGHT, Number(VEHICLE & 0xffff_ffffn)],
      [FARSIGHT + 1, Number(VEHICLE >> 32n)],
    ]),
  };
  const vehicle = {
    guid: VEHICLE, typeId: 3, movementFlags: 0, vehicleId, vehicleOrientation: orientation,
    position: { x: 0, y: 0, z, orientation },
    speeds: new Map([["run", 10], ["turnRate", Math.PI], ["pitchRate", 1]]),
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset, floatBits(3)]]),
  };
  const objects = new Map([[SELF, character], [VEHICLE, vehicle]]);
  const world = {
    mapId: 0,
    movementReady: true,
    controlledGuid: VEHICLE,
    state: { selfGuid: SELF, objects },
    movementState: toggles(),
    speeds: new Map([["run", 7]]),
    movementStateOf: (guid) => (guid === SELF ? world.movementState : vehicleToggles),
    speedsOf: (guid) => (guid === SELF ? world.speeds : new Map()),
    sendMovement: (opcode, flags, position, extra) => {
      sent.push({ guid: SELF, opcode, flags, position: { ...position }, extra });
      character.position = { ...character.position };
    },
    sendMovementAs: (guid, opcode, flags, position, extra) => {
      sent.push({ guid, opcode, flags, position: { ...position }, extra });
      objects.get(guid).position = { ...position };
    },
  };
  return { world, sent, character, vehicle };
}

/** A character on foot. */
function footWorld() {
  const sent = [];
  const character = {
    guid: SELF, typeId: 4, movementFlags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 },
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset, floatBits(0.3)]]),
  };
  const world = {
    mapId: 0, movementReady: true, state: { selfGuid: SELF, objects: new Map([[SELF, character]]) },
    movementState: toggles(), speeds: new Map([["run", 7]]),
    sendMovement: (opcode, flags, position, extra) => {
      sent.push({ guid: SELF, opcode, flags, position: { ...position }, extra });
      character.position = { ...character.position };
    },
  };
  return { world, sent, character };
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
    game.worldLoading = false;
    game.camera.pitch = pitch;
  }
}

const opcodesOf = (sent) => sent.map((packet) => packet.opcode);

test("11.02-F3: the MovementFlags2 the core derives from a row (Vehicle.cpp:684-698), and the rules built once per row", () => {
  assert.equal(vehicleMovementFlags2(0), 0);
  assert.equal(vehicleMovementFlags2(F.NO_STRAFE), MOVEMENT_FLAGS2.NO_STRAFE);
  assert.equal(vehicleMovementFlags2(F.NO_JUMPING), MOVEMENT_FLAGS2.NO_JUMPING);
  assert.equal(vehicleMovementFlags2(F.FULLSPEEDTURNING), MOVEMENT_FLAGS2.FULL_SPEED_TURNING);
  assert.equal(vehicleMovementFlags2(F.ALLOW_PITCHING), MOVEMENT_FLAGS2.ALWAYS_ALLOW_PITCHING);
  assert.equal(vehicleMovementFlags2(F.FULLSPEEDPITCHING), MOVEMENT_FLAGS2.FULL_SPEED_PITCHING);
  // CUSTOM_PITCH, the aim bits and FIXED_POSITION are not movement flags.
  assert.equal(vehicleMovementFlags2(F.CUSTOM_PITCH | F.ADJUST_AIM_ANGLE | F.FIXED_POSITION | VEHICLE_FLAG_MOUSE_PITCH), 0);
  assert.deepEqual([MOVEMENT_FLAGS2.NO_STRAFE, MOVEMENT_FLAGS2.NO_JUMPING, MOVEMENT_FLAGS2.FULL_SPEED_TURNING,
    MOVEMENT_FLAGS2.FULL_SPEED_PITCHING, MOVEMENT_FLAGS2.ALWAYS_ALLOW_PITCHING], [0x1, 0x2, 0x8, 0x10, 0x20], "UnitDefines.h:326-331");

  const catalog = vehicleCatalogFrom(ANSWER);
  const siege = vehicleMoverRules(catalog.vehicle(SIEGE));
  assert.equal(siege.flags2, 0x1b);
  assert.equal(siege.noStrafe, true);
  assert.equal(siege.alwaysPitch, false);
  assert.equal(vehicleMoverRules(catalog.vehicle(SIEGE)), siege, "kept with its row");
  const cannon = vehicleMoverRules(catalog.vehicle(CANNON));
  assert.deepEqual([cannon.alwaysPitch, cannon.fixedPosition, cannon.groundMousePitch, cannon.mouseAims], [true, true, true, false]);
  assert.ok(Math.abs(cannon.pitchMin + 0.2) < 1e-6 && Math.abs(cannon.pitchMax - 0.6) < 1e-6, "CUSTOM_PITCH: the row's band");
  const aimer = vehicleMoverRules(catalog.vehicle(AIMER));
  assert.equal(aimer.mouseAims, true, "0x40000 without 0x40000000 (0x00756f00)");
  assert.deepEqual([aimer.pitchMin, aimer.pitchMax], [-VEHICLE_DEFAULT_PITCH_LIMIT, VEHICLE_DEFAULT_PITCH_LIMIT], "no CUSTOM_PITCH: ±π/2");
  assert.equal(clampVehiclePitch(cannon, 2), cannon.pitchMax);
  assert.equal(clampVehiclePitch(cannon, -2), cannon.pitchMin);
  assert.equal(clampVehiclePitch(cannon, 0.1), 0.1);
  assert.equal(clampVehiclePitch(cannon, Number.NaN), cannon.pitchMin);
  // 0x005fa790 and 0x00756f00: who the steer pitches from the camera.
  assert.equal(vehicleSteerPitchesFromCamera(cannon, false), true);
  assert.equal(vehicleSteerPitchesFromCamera(aimer, false), false);
  assert.equal(vehicleSteerPitchesFromCamera(vehicleMoverRules(catalog.vehicle(KEYS)), false), false);
  assert.equal(vehicleSteerPitchesFromCamera(vehicleMoverRules(catalog.vehicle(KEYS)), true), true, "aloft every mover");
});

test("11.02-F3: FIXED_POSITION facing window around the create block's orientation (0x006eaa50, 0x006e9290)", () => {
  const cannon = vehicleMoverRules(vehicleCatalogFrom(ANSWER).vehicle(CANNON));
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);
  close(clampVehicleFacing(cannon, 1, 1.1), 1.1);
  close(clampVehicleFacing(cannon, 1, 1.4), 1.25);
  close(clampVehicleFacing(cannon, 1, 0.2), 0.5);
  // Across ±π: base 3, window [2.5, 3.25]; -3.0 is 3.283 there (above), -3.1 is 3.183 (inside).
  close(clampVehicleFacing(cannon, 3, -3.1), -3.1);
  close(clampVehicleFacing(cannon, 3, -2.9), 3.25 - 2 * Math.PI);
  // Opposite the window: the nearer end (−0.1 is 0.6 from the low end 0.5, 2.28 from the high end).
  close(clampVehicleFacing(cannon, 1, -0.1), 0.5);
  close(clampVehicleFacing(cannon, 1, 2.0), 1.25);
  close(clampVehicleFacing(cannon, 1, 1.25), 1.25);
  const siege = vehicleMoverRules(vehicleCatalogFrom(ANSWER).vehicle(SIEGE));
  assert.equal(clampVehicleFacing(siege, 1, 2.9), 2.9, "not FIXED_POSITION: unchanged");
});

test("11.02-F3: without vehicle tables nothing changes — the NO_STRAFE vehicle still strafes, no flags2 goes out", async () => {
  await useTables(undefined);
  assert.equal(vehicleCatalog(), undefined);
  const { world, sent, vehicle } = vehicleWorld({ vehicleId: SIEGE });
  withWorld(world, () => {
    assert.equal(moverVehicleRules(world), undefined);
    beginHeld("strafeLeft");
    assert.deepEqual(sent.map((packet) => [packet.guid, packet.opcode]), [[VEHICLE, OPCODES.MSG_MOVE_START_STRAFE_LEFT]]);
    assert.equal(sent[0].extra.flags2, undefined);
    advancePhysics(0.1);
    assert.ok(vehicle.position.y > 0.5, "slides sideways as before");
  });
});

test("11.02-F3: NO_STRAFE — the driven vehicle starts no strafe and does not slide; its packets echo its MovementFlags2", async () => {
  await useTables(ANSWER);
  const { world, sent, vehicle } = vehicleWorld({ vehicleId: SIEGE });
  withWorld(world, () => {
    assert.equal(moverVehicleRules(world)?.vehicleId, SIEGE);
    assert.equal(moverVehicleRules(world), moverVehicleRules(world), "the same rules object every call");
    beginHeld("strafeLeft");
    assert.deepEqual(sent, [], "no START_STRAFE (0x00988b00 refuses it)");
    advancePhysics(0.1);
    assert.equal(vehicle.position.y, 0, "no sideways step");
    beginHeld("moveForward");
    assert.deepEqual(sent.map((packet) => [packet.guid, packet.opcode]), [[VEHICLE, OPCODES.MSG_MOVE_START_FORWARD]]);
    assert.equal(sent[0].flags & (MOVEMENT_FLAGS.strafeLeft | MOVEMENT_FLAGS.strafeRight), 0);
    assert.equal(sent[0].extra.flags2, 0x1b, "NO_STRAFE | NO_JUMPING | FULL_SPEED_TURNING | FULL_SPEED_PITCHING");
    // On the wire: the writer puts the u16 flags2 after the flags; no pitch without ALWAYS_ALLOW_PITCHING.
    const bytes = buildMovementPacket(VEHICLE, sent[0].flags, sent[0].position, 7, sent[0].extra);
    const parsed = parseMovementPacket(bytes);
    assert.equal(parsed.flags2, 0x1b);
    assert.equal(parsed.pitch, undefined);
    endHeld("strafeLeft");
    assert.equal(sent.length, 1, "releasing a strafe that never started sends nothing");
  });
});

test("11.02-F3: NO_STRAFE leaves the character on foot alone, and a vehicle without the flag strafes", async () => {
  await useTables(ANSWER);
  const foot = footWorld();
  withWorld(foot.world, () => {
    beginHeld("strafeLeft");
    assert.deepEqual(opcodesOf(foot.sent), [OPCODES.MSG_MOVE_START_STRAFE_LEFT]);
    assert.equal(foot.sent[0].extra.flags2, undefined, "the character's packets are as they were");
  });
  const plain = vehicleWorld({ vehicleId: PLAIN });
  withWorld(plain.world, () => {
    beginHeld("strafeRight");
    assert.deepEqual(opcodesOf(plain.sent), [OPCODES.MSG_MOVE_START_STRAFE_RIGHT]);
    assert.equal(plain.sent[0].extra.flags2, undefined, "flags 0: no MovementFlags2");
  });
});

test("11.02-F3: NO_STRAFE also refuses rising in the air (0x009898e0)", async () => {
  await useTables(ANSWER);
  const flying = vehicleWorld({ vehicleId: SIEGE, vehicleToggles: toggles({ canFly: true }), z: 50 });
  withWorld(flying.world, () => {
    advancePhysics(1 / 60);
    const before = flying.vehicle.position.z;
    beginHeld("jump");
    for (let frame = 0; frame < 6; frame++) advancePhysics(0.1);
    assert.ok(flying.vehicle.position.z <= before + 1e-6, `rose to ${flying.vehicle.position.z}`);
    assert.ok(!opcodesOf(flying.sent).includes(OPCODES.MSG_MOVE_START_ASCEND));
  });
  const free = vehicleWorld({ vehicleId: PLAIN, vehicleToggles: toggles({ canFly: true }), z: 50 });
  withWorld(free.world, () => {
    advancePhysics(1 / 60);
    const before = free.vehicle.position.z;
    beginHeld("jump");
    for (let frame = 0; frame < 6; frame++) advancePhysics(0.1);
    assert.ok(free.vehicle.position.z > before + 1, "a vehicle without NO_STRAFE rises");
  });
});

test("11.02-F3: ALLOW_PITCHING — the pitch keys act on the ground, the pitch stops at the band and rides the packets", async () => {
  await useTables(ANSWER);
  const { world, sent } = vehicleWorld({ vehicleId: KEYS });
  withWorld(world, () => {
    advancePhysics(1 / 60);
    beginHeld("pitchUp");
    assert.deepEqual(sent.map((packet) => [packet.guid, packet.opcode]), [[VEHICLE, OPCODES.MSG_MOVE_START_PITCH_UP]]);
    assert.ok(sent[0].flags & MOVEMENT_FLAGS.pitchUp);
    assert.equal(sent[0].extra.flags2, MOVEMENT_FLAGS2.ALWAYS_ALLOW_PITCHING);
    for (let frame = 0; frame < 20; frame++) advancePhysics(0.1);
    assert.ok(Math.abs(characterPitchNow() - 0.4) < 1e-6, `held at PitchMax, got ${characterPitchNow()}`);
    sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    const heartbeat = sent.at(-1);
    assert.ok(Math.abs(heartbeat.extra.pitch - 0.4) < 1e-6, "the pitch goes with the packet");
    const parsed = parseMovementPacket(buildMovementPacket(VEHICLE, heartbeat.flags, heartbeat.position, 9, heartbeat.extra));
    assert.equal(parsed.flags2, MOVEMENT_FLAGS2.ALWAYS_ALLOW_PITCHING);
    assert.ok(Math.abs(parsed.pitch - 0.4) < 1e-6, "WorldSession.cpp:982 reads it because of the flags2 bit");
    assert.ok(opcodesOf(sent).includes(OPCODES.MSG_MOVE_SET_PITCH), "the pitch change was reported");
    endHeld("pitchUp");
    assert.equal(sent.at(-1).opcode, OPCODES.MSG_MOVE_STOP_PITCH);
    beginHeld("pitchDown");
    for (let frame = 0; frame < 20; frame++) advancePhysics(0.1);
    assert.ok(Math.abs(characterPitchNow() + 0.3) < 1e-6, `held at PitchMin, got ${characterPitchNow()}`);
  });
  const plain = vehicleWorld({ vehicleId: PLAIN });
  withWorld(plain.world, () => {
    advancePhysics(1 / 60);
    beginHeld("pitchUp");
    assert.deepEqual(plain.sent, [], "a ground vehicle without ALLOW_PITCHING: the keys say nothing");
    advancePhysics(0.5);
    assert.equal(characterPitchNow(), 0);
  });
});

test("11.02-F3: without CUSTOM_PITCH a vehicle's pitch stops at ±π/2", async () => {
  await useTables(ANSWER);
  const { world } = vehicleWorld({ vehicleId: AIMER });
  withWorld(world, () => {
    advancePhysics(1 / 60);
    beginHeld("pitchUp");
    for (let frame = 0; frame < 40; frame++) advancePhysics(0.1);
    assert.ok(Math.abs(characterPitchNow() - VEHICLE_DEFAULT_PITCH_LIMIT) < 1e-6, `${characterPitchNow()}`);
  });
});

test("11.02-F3: the steer pitches a cannon as the camera looks plus MouseLookOffsetPitch, inside its band", async () => {
  await useTables(ANSWER);
  const { world } = vehicleWorld({ vehicleId: CANNON });
  withWorld(world, () => {
    setSteering(true);
    game.camera.pitch = 0.05;
    advancePhysics(0.05);
    assert.ok(Math.abs(characterPitchNow() - 0.55) < 1e-6, `0.05 + 0.5, got ${characterPitchNow()}`);
    game.camera.pitch = 0.3;
    advancePhysics(0.05);
    assert.ok(Math.abs(characterPitchNow() - 0.6) < 1e-6, "PitchMax");
    game.camera.pitch = -1;
    advancePhysics(0.05);
    assert.ok(Math.abs(characterPitchNow() + 0.2) < 1e-6, "PitchMin");
  });
  for (const id of [KEYS, AIMER]) {
    const other = vehicleWorld({ vehicleId: id });
    withWorld(other.world, () => {
      setSteering(true);
      game.camera.pitch = 0.3;
      advancePhysics(0.05);
      assert.equal(characterPitchNow(), 0, `vehicle ${id}: the steer does not pitch it from the camera`);
    });
  }
});

test("11.02-F3: a flier's steer adds MouseLookOffsetPitch and stays in its CUSTOM_PITCH band", async () => {
  await useTables(ANSWER);
  const { world } = vehicleWorld({ vehicleId: DRAKE, vehicleToggles: toggles({ canFly: true }), z: 50 });
  withWorld(world, () => {
    advancePhysics(1 / 60);
    setSteering(true);
    game.camera.pitch = 0.1;
    advancePhysics(0.05);
    assert.ok(Math.abs(characterPitchNow() - 0.4) < 1e-6, `0.1 + 0.3, got ${characterPitchNow()}`);
    game.camera.pitch = 0.6;
    advancePhysics(0.05);
    assert.ok(Math.abs(characterPitchNow() - 0.5) < 1e-6, "PitchMax");
  });
});

test("11.02-F3: a vehicle that aims with the drag takes its vertical (aimMoverPitchBy); nobody else does", async () => {
  await useTables(ANSWER);
  const { world } = vehicleWorld({ vehicleId: AIMER });
  withWorld(world, () => {
    advancePhysics(1 / 60);
    assert.equal(aimMoverPitchBy(0.25), true);
    assert.ok(Math.abs(characterPitchNow() - 0.25) < 1e-6);
    setSteering(true);
    game.camera.pitch = -0.4;
    advancePhysics(0.05);
    assert.ok(Math.abs(characterPitchNow() - 0.25) < 1e-6, "the camera's pitch does not overwrite the aim");
    for (let step = 0; step < 10; step++) aimMoverPitchBy(0.25);
    assert.ok(Math.abs(characterPitchNow() - VEHICLE_DEFAULT_PITCH_LIMIT) < 1e-6, "held in its band");
  });
  for (const id of [CANNON, KEYS, SIEGE]) {
    const other = vehicleWorld({ vehicleId: id });
    withWorld(other.world, () => {
      advancePhysics(1 / 60);
      assert.equal(aimMoverPitchBy(0.25), false, `vehicle ${id}`);
    });
  }
  const foot = footWorld();
  withWorld(foot.world, () => assert.equal(aimMoverPitchBy(0.25), false, "the character on foot"));
});

test("11.02-F3: FIXED_POSITION — keys and the mouse turn the cannon only inside its facing limits", async () => {
  await useTables(ANSWER);
  const { world, vehicle } = vehicleWorld({ vehicleId: CANNON, orientation: 1 });
  withWorld(world, () => {
    advancePhysics(1 / 60);
    beginHeld("turnLeft");
    for (let frame = 0; frame < 10; frame++) advancePhysics(0.1);
    assert.ok(Math.abs(vehicle.position.orientation - 1.25) < 1e-6, `left limit, got ${vehicle.position.orientation}`);
    endHeld("turnLeft");
    beginHeld("turnRight");
    for (let frame = 0; frame < 10; frame++) advancePhysics(0.1);
    assert.ok(Math.abs(vehicle.position.orientation - 0.5) < 1e-6, `right limit, got ${vehicle.position.orientation}`);
    endHeld("turnRight");
    assert.equal(turnCharacterBy(2), true);
    assert.ok(Math.abs(vehicle.position.orientation - 1.25) < 1e-6, "the mouse turn stops there too");
  });
  const free = vehicleWorld({ vehicleId: SIEGE, orientation: 1 });
  withWorld(free.world, () => {
    advancePhysics(1 / 60);
    turnCharacterBy(2);
    assert.ok(Math.abs(free.vehicle.position.orientation - 3) < 1e-6, "no FIXED_POSITION: turns freely");
  });
});

test("11.02-F3: the hooks are where the rules apply (Movement.ts, Controls.ts carry the 11.02-GF3 marks)", () => {
  const movement = readFileSync(new URL("../src/browser/input/Movement.ts", import.meta.url), "utf8");
  const controls = readFileSync(new URL("../src/browser/input/Controls.ts", import.meta.url), "utf8");
  assert.ok(movement.includes("moverVehicleRules"), "Movement.ts reads the rules");
  assert.ok(controls.includes("aimMoverPitchBy("), "Controls.ts hands the drag's vertical to an aiming vehicle");
  const pointer = controls.slice(controls.indexOf("\"pointermove\""), controls.indexOf("\"pointerup\""));
  assert.ok(pointer.includes("aimMoverPitchBy(") && pointer.includes("11.02-GF3"), "inside the drag handler, marked");
  // 0x005fb0b0: a NO_STRAFE mover's turn keys are not turned into strafes by the steer — both places
  // that decide it (the modifier's refresh and a key going down) ask Movement.moverRefusesStrafe.
  const refresh = controls.slice(controls.indexOf("function refreshStrafeModifier("), controls.indexOf("function onKeyDown("));
  assert.ok(refresh.includes("&& !moverRefusesStrafe()"), "refreshStrafeModifier");
  const keyDown = controls.slice(controls.indexOf("if (HELD_ACTIONS.has(action))"), controls.indexOf("heldByCode.set(event.code"));
  assert.ok(keyDown.includes("&& !moverRefusesStrafe() ? strafeInsteadOfTurn(action) : action"), "the key going down");
});

test("11.02-F3: moverRefusesStrafe — the driven NO_STRAFE vehicle only", async () => {
  await useTables(ANSWER);
  for (const [id, expected] of [[SIEGE, true], [PLAIN, false], [CANNON, false]]) {
    const { world } = vehicleWorld({ vehicleId: id });
    withWorld(world, () => assert.equal(moverRefusesStrafe(), expected, `vehicle ${id}`));
  }
  const foot = footWorld();
  withWorld(foot.world, () => assert.equal(moverRefusesStrafe(), false, "on foot"));
  await useTables(undefined);
  const { world } = vehicleWorld({ vehicleId: SIEGE });
  withWorld(world, () => assert.equal(moverRefusesStrafe(), false, "no tables"));
});

// ---- review of 11.02-G/F3 (03.10): ordinary play, byte for byte ---------------------------------

const FIXED_TIME = 4242;
const FLAT = { heightAt: () => 0, liquidAt: () => undefined, isHole: () => false };
const LAKE = { heightAt: () => -20, liquidAt: () => ({ height: 0, type: 1 }), isHole: () => false };

/** A character of its own (no kit), and a NO_STRAFE | ALLOW_PITCHING vehicle standing next to it, not driven. */
function ordinaryWorld({ z = 0, movementState = {} } = {}) {
  const sent = [];
  const character = {
    guid: SELF, typeId: 4, movementFlags: 0, position: { x: 0, y: 0, z, orientation: 0.5 },
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset, floatBits(0.3)]]),
  };
  const parked = {
    guid: VEHICLE, typeId: 3, movementFlags: 0, vehicleId: KEYS, vehicleOrientation: 0,
    position: { x: 30, y: 0, z, orientation: 0 }, fields: new Map(),
  };
  const world = {
    mapId: 0, movementReady: true, state: { selfGuid: SELF, objects: new Map([[SELF, character], [VEHICLE, parked]]) },
    movementState: toggles(movementState), speeds: new Map([["run", 7]]),
    sendMovement: (opcode, flags, position, extra) => {
      sent.push({ guid: SELF, opcode, flags, position: { ...position }, extra });
      character.position = { ...character.position };
    },
  };
  return { world, sent, character };
}

function withTerrain(world, terrain, body) {
  forgetMovementState();
  game.world = world;
  game.worldLoading = false;
  game.terrain = terrain;
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

const hex = (bytes) => Buffer.from(bytes).toString("hex");
/** What one recorded packet puts on the wire, at a fixed clock. */
const wire = (packet) => hex(buildMovementPacket(packet.guid, packet.flags, packet.position, FIXED_TIME, packet.extra));
/** The acknowledgement body the movement layer would answer with now (M7-0 `movementSnapshot`). */
function ackWire(world) {
  const info = world.movementSnapshot?.(SELF);
  return info === undefined ? "none" : hex(writeMovementInfo(new PacketWriter(), SELF, { ...info, time: FIXED_TIME }).toUint8Array());
}

/** On foot, swimming under the steer, flying on the pitch keys: every packet and ACK as bytes. */
function ordinaryRun() {
  const out = [];
  const record = (label, run) => {
    for (const packet of run.sent) {
      const parsed = parseMovementPacket(buildMovementPacket(packet.guid, packet.flags, packet.position, FIXED_TIME, packet.extra));
      out.push({
        label, opcode: packet.opcode, wire: wire(packet), flags2Key: packet.extra !== undefined && "flags2" in packet.extra,
        flags2: parsed.flags2, aloft: (parsed.flags & (MOVEMENT_FLAGS.swimming | MOVEMENT_FLAGS.flying)) !== 0, pitch: parsed.pitch,
      });
    }
    out.push({ label: `${label} ack`, wire: ackWire(run.world) });
  };
  const foot = ordinaryWorld();
  withTerrain(foot.world, FLAT, () => {
    advancePhysics(1 / 60);
    beginHeld("moveForward");
    beginHeld("strafeLeft");
    beginHeld("pitchUp");
    for (let frame = 0; frame < 6; frame++) advancePhysics(1 / 60);
    sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    flushFacing();
    endHeld("pitchUp");
    endHeld("strafeLeft");
    endHeld("moveForward");
    record("foot", foot);
  });
  const swim = ordinaryWorld({ z: -5 });
  withTerrain(swim.world, LAKE, () => {
    game.camera.pitch = -0.4137;
    for (let frame = 0; frame < 30; frame++) advancePhysics(1 / 60);
    setSteering(true);
    beginHeld("moveForward");
    beginHeld("strafeRight");
    for (let frame = 0; frame < 10; frame++) advancePhysics(1 / 60);
    sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    record("swim", swim);
  });
  const fly = ordinaryWorld({ z: 50, movementState: { canFly: true } });
  withTerrain(fly.world, FLAT, () => {
    advancePhysics(1 / 60);
    beginHeld("pitchUp");
    for (let frame = 0; frame < 5; frame++) advancePhysics(0.05);
    beginHeld("moveForward");
    advancePhysics(0.05);
    sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    endHeld("pitchUp");
    record("fly", fly);
  });
  return out;
}

test("11.02-F3 review: ordinary play is byte-identical with the vehicle tables loaded — on foot, swimming, flying", async () => {
  await useTables(undefined);
  const without = ordinaryRun();
  await useTables(ANSWER);
  assert.ok(vehicleCatalog()?.vehicle(KEYS), "the tables are there this time");
  const withTables = ordinaryRun();
  assert.deepEqual(withTables, without);
  const packets = without.filter((entry) => entry.opcode !== undefined);
  assert.ok(packets.length >= 10, `packets: ${packets.length}`);
  for (const packet of packets) {
    assert.equal(packet.flags2Key, false, `${packet.label} ${packet.opcode}: no flags2 in the extra`);
    assert.equal(packet.flags2, 0, `${packet.label} ${packet.opcode}`);
    assert.equal(packet.pitch !== undefined, packet.aloft, `${packet.label} ${packet.opcode}: a pitch exactly with SWIMMING | FLYING`);
  }
  assert.ok(packets.some((packet) => packet.label === "swim" && Math.abs(packet.pitch + 0.4137) < 1e-6), "the swimmer's steered pitch is on the wire");
  assert.ok(packets.some((packet) => packet.label === "fly" && packet.pitch > 0.1), "the flier's keyed pitch is on the wire");
  assert.ok(packets.some((packet) => packet.label === "foot" && packet.opcode === OPCODES.MSG_MOVE_START_STRAFE_LEFT), "on foot it strafes");
  assert.ok(!packets.some((packet) => packet.label === "foot" && packet.opcode === OPCODES.MSG_MOVE_START_PITCH_UP), "on land no pitch");
  for (const label of ["foot ack", "swim ack", "fly ack"]) {
    const ack = without.find((entry) => entry.label === label);
    assert.notEqual(ack?.wire, "none", label);
    // The packed guid (a mask byte and one guid byte here), the u32 flags, then the u16 flags2: bytes 6..7.
    assert.equal(ack.wire.slice(2 * 6, 2 * 8), "0000", `${label}: flags2 0`);
  }
});

test("11.02-F3 review: a passenger seat of an ALLOW_PITCHING | NO_STRAFE vehicle — the character still sends nothing", async () => {
  await useTables(ANSWER);
  const { world, sent, character } = vehicleWorld({ vehicleId: KEYS });
  world.controlledGuid = SELF;
  character.fields.delete(FARSIGHT);
  character.fields.delete(FARSIGHT + 1);
  withWorld(world, () => {
    assert.equal(moverVehicleRules(world), undefined, "the character is no vehicle");
    advancePhysics(1 / 60);
    for (const action of ["strafeLeft", "pitchUp", "moveForward"]) beginHeld(action);
    for (let frame = 0; frame < 5; frame++) advancePhysics(0.05);
    sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    assert.deepEqual(sent, [], "held in the seat (11.02-A)");
    assert.equal(characterPitchNow(), 0);
  });
});

// ---- the real dataset ----------------------------------------------------------------------------

const DATASET_DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const haveDataset = existsSync(`${DATASET_DBC}/Vehicle.dbc`) && existsSync(`${DATASET_DBC}/VehicleSeat.dbc`);

test("11.02-F3: the dataset's siege engine, its turret and a fixed cannon", { skip: !haveDataset && "no dataset DBCs on this machine" }, async () => {
  const { loadVehicles } = await import("../dist/code/gateway/VehicleMetadata.js");
  const real = vehicleCatalogFrom(JSON.parse(JSON.stringify(await loadVehicles(DATASET_DBC))));
  const engine = vehicleMoverRules(real.vehicle(117));
  assert.equal(engine.flags2, 0x1b, "Siege Engine: NO_STRAFE, NO_JUMPING, FULL_SPEED_TURNING, FULL_SPEED_PITCHING");
  assert.deepEqual([engine.noStrafe, engine.alwaysPitch, engine.fixedPosition], [true, false, false]);
  const turret = vehicleMoverRules(real.vehicle(116));
  assert.equal(turret.flags2, 0x3b);
  assert.deepEqual([turret.alwaysPitch, turret.groundMousePitch, turret.mouseAims], [true, true, false]);
  assert.ok(Math.abs(turret.pitchMin + 0.5236) < 1e-4 && Math.abs(turret.pitchMax - 0.7854) < 1e-4);
  assert.ok(Math.abs(turret.mouseLookOffsetPitch - 0.7854) < 1e-4);
  const cannon = vehicleMoverRules(real.vehicle(160));
  assert.deepEqual([cannon.fixedPosition, cannon.alwaysPitch], [true, true]);
  assert.ok(Math.abs(cannon.facingLimitRight - 1.7453) < 1e-4 && Math.abs(cannon.facingLimitLeft - 1.7453) < 1e-4);
  let fixed = 0;
  let aims = 0;
  for (let id = 1; id < 1000; id++) {
    const row = real.vehicle(id);
    if (!row) continue;
    const rules = vehicleMoverRules(row);
    if (rules.fixedPosition) fixed++;
    if (rules.mouseAims) aims++;
  }
  assert.equal(fixed, 13, "13 FIXED_POSITION vehicles");
  assert.ok(aims > 0, "some vehicles aim by the drag");
});
