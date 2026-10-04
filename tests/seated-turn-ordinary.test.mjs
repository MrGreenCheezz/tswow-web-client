import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { game } from "../dist/code/browser/game/Context.js";
import * as current from "../dist/code/browser/input/Movement.js";
import { setRideCarriers } from "../dist/code/browser/input/MovementRide.js";
import { TransportCollision } from "../dist/code/browser/game/TransportCollision.js";
import { startVehicleData } from "../dist/code/browser/VehicleClient.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { PacketWriter } from "../dist/code/protocol/index.js";
import { decodeCollisionModel, encodeCollisionModel } from "../dist/code/world/CollisionFormat.js";
import { MOVEMENT_FLAGS, parseMovementPacket } from "../dist/code/world/MovementProtocol.js";
import {
  VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_COLUMN, VEHICLE_SEAT_FORMAT,
} from "../dist/code/world/VehicleDbc.js";
import { VEHICLE_FLAGS as F, VEHICLE_SEAT_FLAGS as S } from "../dist/code/world/VehicleSeatModel.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

// 11.02-input review: ordinary movement is byte for byte what it was before the seated-turn hooks went into
// Movement.ts. The baseline is Movement.ts itself with every `11.02-input` hook taken back to the line that
// stood there (asserted to match exactly once each), loaded beside the real module over the same dependencies;
// both run the same scripted session through a real WorldClient on a fake connection under one stubbed clock,
// with the vehicle tables loaded (so the hooks are armed), and every byte that goes out is compared: walking,
// key and mouse turning, jumping, strafing, walk mode, autorun, a mount's forced speed and its ACK, swimming and
// flying with the pitch keys and the steer, a ship's deck (walk, mouse and key turns, a jump, an ACK with the
// block), an unseated driven vehicle with MovementFlags2, a possessed creature, a taxi, and a seat whose row lacks
// ALLOW_TURNING (11.02-A's silence). WorldClient.sendSeatedMovement is never reached in any of them.

const SELF = 0x1234n;
const SHIP = 0x1fc0_0000_0000_0007n;
const VEHICLE = 0xf150_7d9a_0000_0042n; // HighGuid::Vehicle
const CREATURE = 0xf130_0000_0000_0077n; // HighGuid::Unit: a possessed creature
const BASE = 0xf150_7d9a_0000_0075n;
const DISPLAY = 3015;
const DECK_Z = 2;

// ---- the baseline: Movement.ts without its 11.02-input hooks ------------------------------------------------

const MOVEMENT_TS = new URL("../src/browser/input/Movement.ts", import.meta.url);
const MOVEMENT_DIST = new URL("../dist/code/browser/input/Movement.js", import.meta.url);

/** Each 11.02-input hook of Movement.ts, and what stood in its place before (docs/WORK_PLAN.ru.md 11.02). */
const HOOKS = [
  ["    seatedFrame(world, elapsed); // 11.02-input: a seat with ALLOW_TURNING turns (SeatedTurn.ts)\n", ""],
  ["  // 11.02-input: a seated turner aims as well (Wow.exe 0x005fba60 asks 0x005fa110, which asks 0x0074b900).\n"
    + "  const seatedAim = ownMovementServerControlled() && freeSeatedTurner(world) !== undefined;\n"
    + "  if (!world || (movementBlocked() !== undefined && !seatedAim) || viewIsOut(world)) return false; // 11.02-input: `&& !seatedAim`\n",
  "  if (!world || movementBlocked() !== undefined || viewIsOut(world)) return false;\n"],
  ["  // 11.02-input: except a mover that turns on its seat: its seat with the facing and keys it has (SeatedTurn.ts).\n"
    + "  if (world && guid === moverGuid(world) && !game.worldLoading && ownMovementServerControlled()) {\n"
    + "    return seatedTurnSnapshot(world, guid, characterPitch);\n"
    + "  }\n", ""],
  ["  // 11.02-input: a held mover that turns on its seat reports its key edges with the seat (SeatedTurn.ts).\n"
    + "  if (game.world?.movementReady && !game.worldLoading && ownMovementServerControlled()) {\n"
    + "    const free = freeSeatedTurner(game.world) !== undefined;\n"
    + "    seatedTurnSync(game.world, free ? turnAxis() : 0, free ? pitchAxis() : 0, characterPitch);\n"
    + "    return;\n"
    + "  }\n", ""],
  ["  // 11.02-input: a held mover that turns on its seat is turned there, with the camera on it (SeatedTurn.ts).\n"
    + "  if (ownMovementServerControlled()) {\n"
    + "    return !viewIsOut(game.world) && freeSeatedTurner(game.world) !== undefined\n"
    + "      && seatedTurnBy(game.world, radians, characterPitch);\n"
    + "  }\n", ""],
  ["  // 11.02-input: a seated turner's last facing of the drag (SeatedTurn.ts); any other held mover, nothing.\n"
    + "  if (ownMovementServerControlled()) {\n"
    + "    if (!viewIsOut(game.world) && freeSeatedTurner(game.world) !== undefined) seatedFlushFacing(game.world, characterPitch);\n"
    + "    return;\n"
    + "  }\n", ""],
  ["  action = heldMovementAction(action); // 11.02-input: VEHICLEAIMUP/DOWN are the pitch keys themselves (Bindings.ts)\n", ""],
  ["  action = heldMovementAction(action); // 11.02-input: as `beginHeld`\n", ""],
  ["  forgetSeatedTurn(); // 11.02-input\n", ""],
];

function baselineSource() {
  let source = readFileSync(MOVEMENT_TS, "utf8").replace(/\r\n/g, "\n");
  for (const [hook, before] of HOOKS) {
    assert.equal(source.split(hook).length - 1, 1, `the 11.02-input hook stands where the review found it:\n${hook}`);
    source = source.replace(hook, before);
  }
  // What is left of the slice is two imports and the two helpers' doc comments, none of them on a path.
  const left = source.split("\n").filter((line) => line.includes("11.02-input"));
  assert.equal(left.length, 4, `no other 11.02-input hook in Movement.ts:\n${left.join("\n")}`);
  // The relative imports become absolute, so the copy shares every dependency module with the real one.
  return source.replace(/((?:from|import)\s+)"(\.{1,2}\/[^"]+)"/g,
    (_, lead, specifier) => `${lead}"${new URL(specifier, MOVEMENT_DIST).href}"`);
}

const js = ts.transpileModule(baselineSource(), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const before = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

// ---- one clock for both runs, the vehicle tables, the ship's deck --------------------------------------------

const clock = { now: 1000 };
const realNow = performance.now;
performance.now = () => clock.now;
test.after(() => { performance.now = realNow; });

function vehicleRow({ id, flags = 0, seats = [], pitchMin = 0, pitchMax = 0 }) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  row[VEHICLE_COLUMN.Flags] = flags >>> 0;
  row[VEHICLE_COLUMN.PitchMin] = pitchMin;
  row[VEHICLE_COLUMN.PitchMax] = pitchMax;
  seats.forEach((seat, slot) => { row[VEHICLE_COLUMN.SeatID + slot] = seat; });
  return row;
}
function seatRow(id, flags) {
  const row = [...VEHICLE_SEAT_FORMAT].map(() => 0);
  row[VEHICLE_SEAT_COLUMN.ID] = id;
  row[VEHICLE_SEAT_COLUMN.Flags] = flags >>> 0;
  return row;
}
const BASE_KIT = 9117;
const DRIVEN_KIT = 9116; // like turret 116: NO_STRAFE, NO_JUMPING, FULLSPEED turning and pitching, ALLOW_PITCHING
const AIM_KIT = 9216; // ALLOW_PITCHING and the mouse pitch (0x40000): the steering drag aims it (aimMoverPitchBy)
const SEAT_DRIVER = 91648;
const SEAT_TURNING = 91651;
const SEAT_FIXED = 91649;
await startVehicleData("ws://127.0.3.1:18090", {
  fetch: async () => new Response(JSON.stringify({
    version: VEHICLE_CATALOG_VERSION,
    vehicles: [
      vehicleRow({ id: BASE_KIT, flags: F.NO_STRAFE, seats: [SEAT_DRIVER, SEAT_TURNING, SEAT_FIXED] }),
      vehicleRow({
        id: DRIVEN_KIT, flags: F.NO_STRAFE | F.NO_JUMPING | F.FULLSPEEDTURNING | F.ALLOW_PITCHING | F.FULLSPEEDPITCHING
          | F.CUSTOM_PITCH, seats: [SEAT_DRIVER], pitchMin: -0.2, pitchMax: 0.8,
      }),
      vehicleRow({ id: AIM_KIT, flags: F.ALLOW_PITCHING | 0x0004_0000 | F.CUSTOM_PITCH, seats: [SEAT_DRIVER], pitchMin: -0.5, pitchMax: 0.5 }),
    ],
    seats: [
      seatRow(SEAT_DRIVER, S.CAN_CONTROL | S.CAN_ENTER_OR_EXIT),
      seatRow(SEAT_TURNING, S.ALLOW_TURNING | S.CAN_ENTER_OR_EXIT),
      seatRow(SEAT_FIXED, S.CAN_ENTER_OR_EXIT),
    ],
    indicators: [],
    indicatorSeats: [],
  }), { status: 200 }),
}).load();

function deck() {
  const vertices = Float32Array.from([-15, -6, DECK_Z, 15, -6, DECK_Z, 15, 6, DECK_Z, -15, 6, DECK_Z]);
  const group = {
    bounds: { minX: -15, minY: -6, minZ: DECK_Z, maxX: 15, maxY: 6, maxZ: DECK_Z },
    flags: 0x8, groupId: 1, vertices, indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
  const model = decodeCollisionModel(encodeCollisionModel([group]).slice().buffer);
  return new TransportCollision({ revision: 0, model: (id) => (id === DISPLAY ? model : null), requestGroups() {} });
}

const FLAT = { heightAt: () => 0, liquidAt: () => undefined, isHole: () => false };
const LAKE = { heightAt: () => -20, liquidAt: () => ({ height: 0, type: 1 }), isHole: () => false };
const SEA = { heightAt: () => -50, liquidAt: () => undefined, isHole: () => false };
const control = (guid) => new PacketWriter().packedGuid(guid).u8(1).toUint8Array();
const runSpeed = (guid, counter, speed) => new PacketWriter().packedGuid(guid).u32(counter).u8(1).f32(speed).toUint8Array();

/** A logged-in WorldClient over a fake connection, the character at `at`, control of it handed over. */
async function loggedIn(at) {
  const login = new PacketWriter().u32(0).f32(at.x).f32(at.y).f32(at.z).f32(at.orientation).toUint8Array();
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
  const deliver = async (opcode, payload) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ opcode, payload });
    else connection.packets.push({ opcode, payload });
    await new Promise((resolve) => setImmediate(resolve));
  };
  client.state.move(SELF, { flags: 0, position: { ...at } });
  client.state.objects.get(SELF).typeId = 4;
  await deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, control(SELF));
  return { client, connection, deliver };
}

/**
 * One scripted session with one movement module: a fresh client from `setup`, the session `play`, then every
 * packet sent after the setup as `opcode:hex`. The clock starts at the same instant for both modules.
 */
async function session(movement, { setup, play, terrain = FLAT, ship = false }) {
  clock.now = 1000;
  movement.forgetMovementState();
  const env = await setup();
  let seatedCalls = 0;
  const seated = env.client.sendSeatedMovement.bind(env.client);
  env.client.sendSeatedMovement = (...args) => { seatedCalls++; return seated(...args); };
  const start = env.connection.sent.length;
  game.world = env.client;
  game.worldLoading = false;
  game.terrain = terrain;
  if (ship) setRideCarriers(deck());
  const cameraPitch = game.camera.pitch;
  /** A render frame as Loop.ts runs one: the carriers, the physics, the heartbeat while moving. */
  const frame = (count = 1, seconds = 1 / 60) => {
    for (let index = 0; index < count; index++) {
      clock.now += seconds * 1000;
      env.client.state.updateMotions(clock.now);
      movement.advancePhysics(seconds);
      if (movement.isMoving() && clock.now - movement.movementHeartbeat.sentAt >= movement.MOVEMENT_HEARTBEAT_INTERVAL) {
        movement.sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
      }
    }
  };
  const drag = (radians, steps) => {
    for (let index = 0; index < steps; index++) {
      clock.now += 40;
      movement.turnCharacterBy(radians);
    }
    movement.flushFacing();
  };
  try {
    await play({ movement, env, frame, drag });
    movement.releaseAllInput();
  } finally {
    movement.forgetMovementState();
    movement.setSteering(false);
    setRideCarriers(undefined);
    game.world = undefined;
    game.terrain = undefined;
    game.camera.pitch = cameraPitch;
    env.client.close();
  }
  const packets = env.connection.sent.slice(start)
    .map((packet) => `${packet.opcode.toString(16)}:${Buffer.from(packet.payload).toString("hex")}`);
  return { packets, seatedCalls, opcodes: env.connection.sent.slice(start).map((packet) => packet.opcode) };
}

/** The same session with the module as it is and with the baseline: the same bytes, and enough of them. */
async function sameBytes(name, scenario, { atLeast = 1, expect = [] } = {}) {
  const now = await session(current, scenario);
  const then = await session(before, scenario);
  assert.equal(now.seatedCalls, 0, `${name}: the seated path is never reached`);
  assert.ok(then.packets.length >= atLeast, `${name}: ${then.packets.length} packets — the session says something`);
  for (const opcode of expect) assert.ok(then.opcodes.includes(opcode), `${name}: 0x${opcode.toString(16)} went out`);
  assert.deepEqual(now.packets, then.packets, `${name}: byte for byte as before 11.02-input`);
  return now;
}

const ON_FOOT = { x: 10, y: 20, z: 0, orientation: 0.25 };

test("11.02-input review: on foot — walk, key and mouse turns, strafe, walk mode, autorun, a mount's speed ACK, a jump", async () => {
  await sameBytes("on foot", {
    setup: () => loggedIn(ON_FOOT),
    async play({ movement, env, frame, drag }) {
      frame(3);
      movement.beginHeld("moveForward");
      frame(20);
      movement.endHeld("moveForward");
      movement.beginHeld("turnLeft");
      frame(10);
      movement.endHeld("turnLeft");
      drag(0.15, 6);
      drag(-0.04, 2);
      movement.beginHeld("strafeLeft");
      frame(5);
      movement.endHeld("strafeLeft");
      movement.toggleWalkRun();
      movement.beginHeld("moveBackward");
      frame(5);
      movement.endHeld("moveBackward");
      movement.toggleWalkRun();
      await env.deliver(OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE, runSpeed(SELF, 3, 14)); // a mount's run speed
      movement.beginHeld("moveForward");
      frame(5);
      movement.beginHeld("jump");
      frame();
      movement.endHeld("jump");
      for (let index = 0; index < 120 && !env.connection.sent.some((p) => p.opcode === OPCODES.MSG_MOVE_FALL_LAND); index++) frame();
      movement.endHeld("moveForward");
      movement.toggleAutoRun();
      frame(5);
      movement.toggleAutoRun();
      // Pitch keys and the VEHICLE section's aim keys on land: nothing, as ever.
      for (const key of ["pitchUp", "vehicleAimUp", "vehicleAimDown"]) {
        movement.beginHeld(key);
        frame(2);
        movement.endHeld(key);
      }
      await env.deliver(OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE, runSpeed(SELF, 4, 7));
      frame(2);
    },
  }, {
    atLeast: 20,
    expect: [OPCODES.MSG_MOVE_START_FORWARD, OPCODES.MSG_MOVE_START_TURN_LEFT, OPCODES.MSG_MOVE_SET_FACING,
      OPCODES.MSG_MOVE_START_STRAFE_LEFT, OPCODES.MSG_MOVE_SET_WALK_MODE, OPCODES.MSG_MOVE_JUMP, OPCODES.MSG_MOVE_FALL_LAND,
      OPCODES.CMSG_FORCE_RUN_SPEED_CHANGE_ACK, OPCODES.MSG_MOVE_HEARTBEAT],
  });
});

test("11.02-input review: swimming and flying with the pitch keys and the steer", async () => {
  await sameBytes("swimming", {
    terrain: LAKE,
    setup: () => loggedIn({ x: 10, y: 20, z: -5, orientation: 0 }),
    async play({ movement, frame, drag }) {
      frame(30);
      movement.beginHeld("pitchUp");
      frame(10);
      movement.endHeld("pitchUp");
      movement.beginHeld("moveForward");
      frame(20);
      game.camera.pitch = -0.3;
      movement.setSteering(true);
      frame(10);
      movement.setSteering(false);
      movement.endHeld("moveForward");
      movement.beginHeld("pitchDown");
      frame(5);
      movement.endHeld("pitchDown");
      drag(0.2, 3);
      frame(30);
    },
  }, { atLeast: 6, expect: [OPCODES.MSG_MOVE_START_SWIM, OPCODES.MSG_MOVE_START_PITCH_UP, OPCODES.MSG_MOVE_STOP_PITCH] });
  await sameBytes("flying", {
    setup: async () => {
      const env = await loggedIn({ x: 10, y: 20, z: 50, orientation: 0 });
      env.client.movementState.canFly = true;
      return env;
    },
    async play({ movement, frame, drag }) {
      frame(2);
      movement.beginHeld("pitchUp");
      frame(10);
      movement.endHeld("pitchUp");
      movement.beginHeld("moveForward");
      frame(20);
      movement.beginHeld("jump");
      frame(5);
      movement.endHeld("jump");
      movement.endHeld("moveForward");
      movement.beginHeld("pitchDown");
      frame(5);
      movement.endHeld("pitchDown");
      drag(0.2, 3);
      frame(5);
    },
  }, { atLeast: 6, expect: [OPCODES.MSG_MOVE_START_PITCH_UP, OPCODES.MSG_MOVE_START_ASCEND, OPCODES.MSG_MOVE_SET_PITCH] });
});

test("11.02-input review: a ship's deck — walk, mouse and key turns, a jump, an ACK with the block", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: Math.PI / 2 };
  const result = await sameBytes("ship deck", {
    terrain: SEA,
    ship: true,
    async setup() {
      const env = await loggedIn({ x: 100, y: 195, z: 10 + DECK_Z, orientation: Math.PI / 2 });
      env.client.state.move(SHIP, { flags: 0, position: { ...pose } });
      const ship = env.client.state.objects.get(SHIP);
      ship.typeId = 5;
      ship.fields.set(UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 15 << 8);
      ship.fields.set(UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset, DISPLAY);
      const sailsFrom = clock.now + 1000 / 60;
      env.client.state.poseProvider = (state, now) => {
        const position = state.objects.get(SHIP)?.position;
        if (position) position.x = pose.x + 4 * Math.max(0, now - sailsFrom) / 1000;
      };
      return env;
    },
    async play({ movement, env, frame, drag }) {
      frame();
      assert.equal(env.client.state.objects.get(SELF).transport?.guid, SHIP, "boarded the deck");
      movement.beginHeld("moveForward");
      frame(30);
      movement.endHeld("moveForward");
      drag(0.25, 3);
      frame(2);
      movement.beginHeld("turnRight");
      frame(10);
      movement.endHeld("turnRight");
      await env.deliver(OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE, runSpeed(SELF, 5, 11));
      movement.beginHeld("jump");
      frame();
      movement.endHeld("jump");
      for (let index = 0; index < 120 && !env.connection.sent.some((p) => p.opcode === OPCODES.MSG_MOVE_FALL_LAND); index++) frame();
      frame(20);
    },
  }, {
    atLeast: 10,
    expect: [OPCODES.MSG_MOVE_START_TURN_RIGHT, OPCODES.MSG_MOVE_SET_FACING, OPCODES.CMSG_FORCE_RUN_SPEED_CHANGE_ACK,
      OPCODES.MSG_MOVE_JUMP, OPCODES.MSG_MOVE_FALL_LAND],
  });
  // Not vacuous: the deck's turns went out with the ship's block.
  const turns = result.packets.filter((packet) => packet.startsWith(`${OPCODES.MSG_MOVE_SET_FACING.toString(16)}:`)
    || packet.startsWith(`${OPCODES.MSG_MOVE_STOP_TURN.toString(16)}:`));
  assert.ok(turns.length >= 2);
  for (const packet of turns) {
    const info = parseMovementPacket(Buffer.from(packet.split(":")[1], "hex"));
    assert.equal(info.flags & MOVEMENT_FLAGS.onTransport, MOVEMENT_FLAGS.onTransport);
    assert.equal(info.transport?.guid, SHIP);
  }
});

test("11.02-input review: an unseated driven vehicle (MovementFlags2) and a possessed creature move as before", async () => {
  const driven = (guid, vehicleId) => async () => {
    const env = await loggedIn({ x: 500, y: 600, z: 0, orientation: 1 });
    env.client.state.move(guid, { flags: 0, position: { x: 500, y: 600, z: 0, orientation: 1 } });
    const unit = env.client.state.objects.get(guid);
    unit.typeId = 3;
    if (vehicleId !== undefined) {
      unit.vehicleId = vehicleId;
      // The character in its driving seat, as 11.02-A drives it.
      env.client.state.move(SELF, { flags: MOVEMENT_FLAGS.onTransport, position: { x: 500, y: 600, z: 2, orientation: 1 },
        transport: { guid, x: 0, y: 0, z: 2, orientation: 0, time: 0, seat: 0 } });
    }
    await env.deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, control(guid));
    // The core's viewpoint on the unit taken over (Player::SetClientControl → SetViewpoint, Player.cpp:24596-24604).
    const self = env.client.state.objects.get(SELF);
    self.fields.set(UPDATE_FIELDS.PLAYER_FARSIGHT.offset, Number(guid & 0xffff_ffffn));
    self.fields.set(UPDATE_FIELDS.PLAYER_FARSIGHT.offset + 1, Number(guid >> 32n));
    return env;
  };
  const play = (guid) => async ({ movement, env, frame, drag }) => {
    frame(3);
    movement.beginHeld("moveForward");
    frame(10);
    movement.beginHeld("turnLeft");
    frame(10);
    movement.endHeld("turnLeft");
    movement.endHeld("moveForward");
    movement.beginHeld("strafeRight");
    frame(3);
    movement.endHeld("strafeRight");
    movement.beginHeld("pitchUp");
    frame(10);
    movement.endHeld("pitchUp");
    drag(0.2, 4);
    movement.aimMoverPitchBy(0.3); // the steering drag's vertical (Controls.ts), aiming where the kit lets it
    frame(3);
    movement.aimMoverPitchBy(-0.15);
    frame(3);
    await env.deliver(OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE, runSpeed(guid, 6, 9));
    frame(3);
  };
  await sameBytes("driven vehicle", { setup: driven(VEHICLE, DRIVEN_KIT), play: play(VEHICLE) }, {
    atLeast: 6,
    expect: [OPCODES.MSG_MOVE_START_FORWARD, OPCODES.MSG_MOVE_START_PITCH_UP, OPCODES.MSG_MOVE_SET_FACING,
      OPCODES.CMSG_FORCE_RUN_SPEED_CHANGE_ACK],
  });
  await sameBytes("vehicle aimed by the steering drag", { setup: driven(VEHICLE, AIM_KIT), play: play(VEHICLE) }, {
    atLeast: 6, expect: [OPCODES.MSG_MOVE_SET_PITCH, OPCODES.MSG_MOVE_SET_FACING],
  });
  await sameBytes("possessed creature", { setup: driven(CREATURE, undefined), play: play(CREATURE) }, {
    atLeast: 6, expect: [OPCODES.MSG_MOVE_START_FORWARD, OPCODES.MSG_MOVE_START_TURN_LEFT, OPCODES.MSG_MOVE_SET_FACING],
  });
});

test("11.02-input review: held movers — a taxi, a seat without ALLOW_TURNING, a creature carrier — send and ACK as before", async () => {
  const held = (board) => ({
    setup: () => loggedIn({ x: 100, y: 200, z: 0, orientation: 1 }),
    async play({ movement, env, frame, drag }) {
      frame(3); // on foot first: the ACK snapshot is installed as in play
      board(env.client);
      frame(3);
      for (const key of ["turnLeft", "moveForward", "pitchUp", "jump"]) movement.beginHeld(key);
      frame(10);
      drag(0.3, 3);
      movement.aimMoverPitchBy(0.2);
      await env.deliver(OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE, runSpeed(SELF, 7, 8));
      for (const key of ["turnLeft", "moveForward", "pitchUp", "jump"]) movement.endHeld(key);
      frame(3);
    },
  });
  const seat = (carrier, slot) => (client) => {
    client.state.move(carrier, { flags: 0, position: { x: 100, y: 200, z: 0, orientation: 1 } });
    const unit = client.state.objects.get(carrier);
    unit.typeId = 3;
    unit.vehicleId = BASE_KIT;
    client.state.move(SELF, { flags: MOVEMENT_FLAGS.onTransport, position: { x: 100, y: 200, z: 2, orientation: 1 },
      transport: { guid: carrier, x: 0, y: 0, z: 2, orientation: 0, time: 0, seat: slot } });
  };
  for (const [name, board] of [
    ["taxi", (client) => client.state.objects.get(SELF).fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x0010_0000)],
    ["seat without ALLOW_TURNING", seat(BASE, 2)],
    ["a creature (HighGuid::Unit) carrier's turning seat", seat(CREATURE, 1)],
  ]) {
    await sameBytes(name, held(board), { atLeast: 1, expect: [OPCODES.CMSG_FORCE_RUN_SPEED_CHANGE_ACK] });
  }
});
