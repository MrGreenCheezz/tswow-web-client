import assert from "node:assert/strict";
import test from "node:test";

// 11.01 slice B, lifts. A lift (GAMEOBJECT_TYPE_TRANSPORT, 11) is a client-only ride: the server
// never moves it (`GameObject::Update` only counts PathProgress, the relocation is commented out,
// GameObject.cpp:520-554) and never makes a player its passenger (`GetTransport` is null for type
// 11, MovementHandler.cpp:340-345). The client moves the platform along its TransportAnimation path
// and the character standing on it with it; packets stay in world coordinates without
// MOVEMENTFLAG_ONTRANSPORT. The phase: the create block's transport word is the server's uptime for
// a lift (Object.cpp:442-454), and 11.01 it is what Wow.exe runs the lift on (0x00714250, 0x007139e0,
// 0x00710640); the high half of GAMEOBJECT_DYNAMIC, `int16(PathProgress % period / period × 65535)`
// (GameObject.cpp:2866-2873), is not read (0x0070cb60 → 0x005eeb70).
import { PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { MOVEMENT_FLAGS, parseMovementPacket } from "../dist/code/world/MovementProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { decodeCollisionModel, encodeCollisionModel } from "../dist/code/world/CollisionFormat.js";
import { game } from "../dist/code/browser/game/Context.js";
import {
  LIFT_CARRY_HEARTBEAT_INTERVAL, advancePhysics, forgetMovementState, heartbeatDue, isGrounded, isMoving, movementHeartbeat,
  releaseAllInput, sendMovement,
} from "../dist/code/browser/input/Movement.js";
import { TransportCollision } from "../dist/code/browser/game/TransportCollision.js";
import {
  GO_STATE_READY, GO_TYPE_TRANSPORT, GameObjectColliders, LIFT_CARRY_MAX_STEP, setGameObjectColliders,
} from "../dist/code/browser/game/GameObjectColliders.js";
import { liftCarrierPose, liftClock, liftPoseAt } from "../dist/code/browser/LiftClock.js";

const SELF = 0x1234n;
const LIFT = 0xf110_0000_0000_00aan;
const LIFT_ENTRY = 9999;
const LIFT_DISPLAY = 7777;
const BASE = { x: 500, y: 500, z: 10, orientation: 0.7 };
const GROUND = 5;
/** Up 40 in four seconds, a second at the top, down in four, a second at the bottom. */
const PATH = {
  entry: LIFT_ENTRY, period: 10_000,
  frames: [{ time: 0, x: 0, y: 0, z: 0 }, { time: 4000, x: 0, y: 0, z: 40 }, { time: 5000, x: 0, y: 0, z: 40 },
    { time: 9000, x: 0, y: 0, z: 0 }],
};
const PATHS = { path: (entry) => (entry === LIFT_ENTRY ? PATH : { entry, period: 0, frames: [] }) };
/** The DYNAMIC word for a phase, as the core writes it. */
const dynamicFor = (phaseMs) => (Math.trunc((phaseMs / PATH.period) * 65535) << 16) >>> 0;
const near = (a, b, tolerance = 1e-3) => Math.abs(a - b) <= tolerance;

/** The platform: a 6 × 6 floor at the lift's origin, in its own frame. */
function platformModel() {
  const vertices = Float32Array.from([-3, -3, 0, 3, -3, 0, 3, 3, 0, -3, 3, 0]);
  const indices = Uint32Array.from([0, 1, 2, 0, 2, 3]);
  const group = { bounds: { minX: -3, minY: -3, minZ: 0, maxX: 3, maxY: 3, maxZ: 0 }, flags: 0x8, groupId: 1, vertices, indices };
  return decodeCollisionModel(encodeCollisionModel([group]).slice().buffer);
}

function liftCollision() {
  const model = platformModel();
  return new TransportCollision({ revision: 0, model: (id) => (id === LIFT_DISPLAY ? model : null), requestGroups() {} });
}

/** 11.01: a worldserver uptime that is a whole number of the lift's periods — the word for a phase is UPTIME + phase. */
const UPTIME = 12 * PATH.period;

/**
 * A lift's create block as the core sends it: UPDATEFLAG_TRANSPORT | UPDATEFLAG_STATIONARY_POSITION
 * (GameObject.cpp:320-321), the transport word (the uptime: `phase` into the cycle), and the values the
 * colliders read. The dynamic word, unless given, says another phase: Wow.exe does not read it.
 */
function liftCreate({ phase = 0, dynamic = dynamicFor((phase + 3000) % PATH.period), transportTime = UPTIME + phase,
  base = BASE, word = true } = {}) {
  const values = new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, LIFT_ENTRY],
    [UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset, LIFT_DISPLAY],
    [UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, (GO_TYPE_TRANSPORT << 8) | GO_STATE_READY],
    [UPDATE_FIELDS.GAMEOBJECT_DYNAMIC.offset, dynamic],
  ]);
  const blocks = Math.ceil((Math.max(...values.keys()) + 1) / 32);
  const masks = new Array(blocks).fill(0);
  for (const index of values.keys()) masks[index >> 5] |= 1 << (index & 31);
  const writer = new PacketWriter().u32(1).u8(2).packedGuid(LIFT).u8(5).u16(word ? 0x42 : 0x40)
    .f32(base.x).f32(base.y).f32(base.z).f32(base.orientation);
  if (word) writer.u32(transportTime);
  writer.u8(blocks);
  for (const mask of masks) writer.u32(mask >>> 0);
  for (const index of [...values.keys()].sort((a, b) => a - b)) writer.u32(values.get(index));
  return writer.toUint8Array();
}

const pose = (object, now) => liftPoseAt(object, PATH, now, { x: 0, y: 0, z: 0, orientation: 0 });

// 11.01: Wow.exe runs a lift on the create block's word — `GO+0x200` = word − read time (0x00714250),
// the path time `now + GO+0x200` modulo the last keyframe (0x007139e0, 0x00710640) — and never on the
// phase word: its callback (0x0070cb60) calls the lift handler's vt+0x2c, a bare `ret` (0x005eeb70).
test("the phase is the create block's word (the uptime), anchored when the block was read; the dynamic word is not read", () => {
  const state = new WorldState();
  state.applyUpdate(liftCreate({ phase: 1000, dynamic: dynamicFor(6000) }), 1000);
  const lift = state.objects.get(LIFT);
  assert.equal(lift.transportTime, UPTIME + 1000);
  // First looked at two seconds after the block arrived (a hidden page): already 3 s into the cycle.
  const at = pose(lift, 3000);
  assert.ok(near(at.z, BASE.z + 30, 0.01), `at the read + 2 s: ${at.z}`);
  assert.ok(near(at.x, BASE.x) && near(at.y, BASE.y) && near(at.orientation, BASE.orientation));

  // A block without the word (never from this core): the dynamic phase, from the read.
  const fallback = new WorldState();
  fallback.applyUpdate(liftCreate({ word: false, dynamic: dynamicFor(1000) }), 0);
  assert.equal(fallback.objects.get(LIFT).transportTime, undefined);
  assert.ok(near(pose(fallback.objects.get(LIFT), 0).z, BASE.z + 10, 0.02), "1000 ms into the cycle");
});

test("a horizontal path is turned by the spawn's yaw before it is added", () => {
  const state = new WorldState();
  state.applyUpdate(liftCreate({ phase: 0 }), 0);
  const tram = { entry: LIFT_ENTRY, period: 2000, frames: [{ time: 0, x: 0, y: 0, z: 0 }, { time: 1000, x: 10, y: 0, z: 0 }] };
  const at = liftPoseAt(state.objects.get(LIFT), tram, 1000, { x: 0, y: 0, z: 0, orientation: 0 });
  assert.ok(near(at.x, BASE.x + 10 * Math.cos(BASE.orientation)) && near(at.y, BASE.y + 10 * Math.sin(BASE.orientation)));
});

test("a re-CREATE of the same lift resyncs its phase and keeps its mesh; a values update's phase word moves nothing", () => {
  const state = new WorldState();
  state.applyUpdate(liftCreate({ phase: 1000 }), 1000);
  const first = state.objects.get(LIFT);
  const collision = liftCollision();
  const mesh = collision.forObject(first);
  assert.ok(mesh, "the platform's mesh");
  assert.ok(near(pose(first, 5000).z, BASE.z + 40, 0.01), "the first clock: 5000 ms in, at the top");

  // The core sends the create block again on every visibility pass, with the uptime of that moment.
  state.applyUpdate(liftCreate({ phase: 7000 }), 5000);
  const second = state.objects.get(LIFT);
  assert.notEqual(second, first);
  assert.ok(near(pose(second, 5000).z, BASE.z + 20, 0.01), `resynced to 7000 ms: ${pose(second, 5000).z}`);
  assert.equal(collision.forObject(second), mesh, "the same mesh: the model is not rebuilt");

  // 11.01: a values update's phase word, near or far, is not read (0x0070cb60 → 0x005eeb70).
  for (const word of [7100, 2000]) {
    second.fields.set(UPDATE_FIELDS.GAMEOBJECT_DYNAMIC.offset, dynamicFor(word));
    assert.ok(near(pose(second, 5100).z, BASE.z + 19, 0.05), `a word for ${word} ms: the clock runs on (${pose(second, 5100).z})`);
  }
  // Another period (the entry, and so the path, changed): a clock of its own, on the same word and read.
  const other = liftClock(second, 20_000, 5100);
  assert.equal(other.progressMs, UPTIME + 7000);
  assert.equal(other.at, 5000, "counted from the block's read");
});

// ---------------------------------------------------------------------------------------------
// The ride, end to end: the real WorldClient over a fake connection and the real movement layer.

async function liftWorld({ phase = 0, offset = { x: 1, y: 0.5 } } = {}) {
  const clock = { now: 1000 };
  const realNow = performance.now;
  performance.now = () => clock.now;
  const login = new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array();
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
  const waiter = waiters.shift();
  const control = new PacketWriter().packedGuid(SELF).u8(1).toUint8Array();
  if (waiter) waiter({ opcode: OPCODES.SMSG_CLIENT_CONTROL_UPDATE, payload: control });
  else connection.packets.push({ opcode: OPCODES.SMSG_CLIENT_CONTROL_UPDATE, payload: control });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.movementReady, true);

  client.state.applyUpdate(liftCreate({ phase }), clock.now);
  const lift = () => client.state.objects.get(LIFT);
  const start = pose(lift(), clock.now);
  const cos = Math.cos(start.orientation);
  const sin = Math.sin(start.orientation);
  client.state.move(SELF, {
    flags: 0,
    position: { x: start.x + offset.x * cos - offset.y * sin, y: start.y + offset.x * sin + offset.y * cos, z: start.z, orientation: 0 },
  });
  forgetMovementState();
  setGameObjectColliders(new GameObjectColliders(liftCollision(), PATHS));
  game.world = client;
  game.worldLoading = false;
  game.terrain = { heightAt: () => GROUND, liquidAt: () => undefined, isHole: () => false };
  const frame = (seconds = 1 / 60) => {
    clock.now += seconds * 1000;
    client.state.updateMotions(clock.now);
    advancePhysics(seconds);
  };
  const self = () => client.state.objects.get(SELF).position;
  const teardown = () => {
    releaseAllInput();
    forgetMovementState();
    setGameObjectColliders(undefined);
    game.world = undefined;
    game.terrain = undefined;
    client.close();
    performance.now = realNow;
  };
  return { client, connection, clock, frame, self, lift, teardown };
}

const sentOf = (connection, opcode) => connection.sent.filter((packet) => packet.opcode === opcode);

test("standing on the lift: carried up and down without falling, packets in world coordinates without ONTRANSPORT", async () => {
  const env = await liftWorld();
  try {
    const startX = env.self().x;
    const startY = env.self().y;
    let movingFrames = 0;
    // Up for four seconds.
    for (let index = 0; index < 235; index++) {
      env.frame();
      const floor = pose(env.lift(), env.clock.now).z;
      assert.ok(near(env.self().z, floor, 0.02), `frame ${index}: on the platform (${env.self().z} vs ${floor})`);
      assert.ok(isGrounded(), `frame ${index}: never in the air`);
      if (isMoving()) movingFrames++;
    }
    assert.ok(env.self().z > BASE.z + 38, `went up with it: ${env.self().z}`);
    assert.ok(near(env.self().x, startX, 1e-3) && near(env.self().y, startY, 1e-3), "a vertical shaft does not move it sideways");
    assert.ok(movingFrames > 200, `a carried character is moving for the heartbeat (${movingFrames})`);

    // The heartbeat the loop sends while carried: world position, no flag, no block.
    sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    const packet = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_HEARTBEAT).at(-1).payload);
    assert.equal(packet.flags & MOVEMENT_FLAGS.onTransport, 0, "no MOVEMENTFLAG_ONTRANSPORT for a lift");
    assert.equal(packet.transport, undefined, "and no transport block");
    assert.ok(near(packet.position.z, env.self().z, 1e-3) && near(packet.position.x, startX, 1e-3), "the world position");

    // The top: the lift stops, the carry ends with one heartbeat where the character rests.
    const before = sentOf(env.connection, OPCODES.MSG_MOVE_HEARTBEAT).length;
    for (let index = 0; index < 30; index++) env.frame();
    assert.equal(isMoving(), false, "standing on a lift that waits is standing");
    const settled = sentOf(env.connection, OPCODES.MSG_MOVE_HEARTBEAT).slice(before);
    assert.equal(settled.length, 1, "one heartbeat when the ride stops");
    assert.ok(near(parseMovementPacket(settled[0].payload).position.z, BASE.z + 40, 0.01));

    // And down again, all the way.
    for (let index = 0; index < 280; index++) {
      env.frame();
      assert.ok(isGrounded(), `descending frame ${index}: never falling`);
    }
    assert.ok(near(env.self().z, pose(env.lift(), env.clock.now).z, 0.02));
    assert.ok(env.self().z < BASE.z + 1, `came down with it: ${env.self().z}`);
    assert.equal(sentOf(env.connection, OPCODES.MSG_MOVE_FALL_LAND).length, 0, "no landing: the character never fell");
    const heartbeats = sentOf(env.connection, OPCODES.MSG_MOVE_HEARTBEAT);
    assert.ok(heartbeats.length >= 3);
    for (const { payload } of heartbeats) {
      const moved = parseMovementPacket(payload);
      assert.equal(moved.flags & (MOVEMENT_FLAGS.falling | MOVEMENT_FLAGS.onTransport), 0, "no fall, no flag");
      assert.equal(moved.transport, undefined);
    }
  } finally {
    env.teardown();
  }
});

test("NET-21: while the lift carries a standing rider the heartbeat comes every 200 ms, and stops with the ride", async () => {
  const env = await liftWorld();
  movementHeartbeat.sentAt = 0;
  try {
    assert.equal(LIFT_CARRY_HEARTBEAT_INTERVAL, 200);
    const times = [];
    // Two seconds of the climb, the frames as Loop.ts runs them: the physics, then the heartbeat when it is due.
    for (let index = 0; index < 120; index++) {
      env.frame();
      if (heartbeatDue(env.clock.now)) {
        sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
        times.push(env.clock.now);
      }
    }
    assert.ok(times.length >= 9, `about ten in two seconds: ${times.length}`);
    for (let index = 1; index < times.length; index++) {
      const gap = times[index] - times[index - 1];
      assert.ok(gap >= 200 && gap < 200 + 17, `gap ${index}: ${gap} ms`);
    }
    // The top: once the platform waits there is nothing to repeat.
    for (let index = 0; index < 150; index++) env.frame();
    assert.equal(heartbeatDue(env.clock.now + 10_000), false, "a rider on a waiting lift is standing");
  } finally {
    env.teardown();
  }
});

test("off the platform the lift carries nothing; a landing flush with it is the landing", async () => {
  // Beside the platform (4 yards out of a 3-yard half width): on the ground, left behind.
  const beside = await liftWorld({ offset: { x: 4, y: 0 } });
  try {
    for (let index = 0; index < 120; index++) beside.frame();
    assert.ok(near(beside.self().z, GROUND, 0.01), `stayed on the ground: ${beside.self().z}`);
    assert.equal(isMoving(), false);
  } finally {
    beside.teardown();
  }
  // At the top, the landing flush with the platform: the platform goes down, the character stays.
  const flush = await liftWorld({ phase: 4500 });
  try {
    const top = BASE.z + 40;
    game.terrain = { heightAt: () => top, liquidAt: () => undefined, isHole: () => false };
    for (let index = 0; index < 120; index++) {
      flush.frame();
      assert.equal(isMoving(), false, `frame ${index}: not carried, so no heartbeat is due`);
    }
    assert.ok(near(flush.self().z, top, 0.01), `stayed on the landing: ${flush.self().z}`);
    assert.ok(pose(flush.lift(), flush.clock.now).z < top - 5, "while the platform went down");
  } finally {
    flush.teardown();
  }
});

test("a jump of the platform beyond a frame's reach (a cut, a stale frame) is not carried", () => {
  const colliders = new GameObjectColliders(liftCollision(), PATHS);
  const state = new WorldState();
  state.applyUpdate(liftCreate({ phase: 0 }), 0);
  const lift = state.objects.get(LIFT);
  const self = { guid: SELF, typeId: 4, position: { x: BASE.x, y: BASE.y, z: BASE.z, orientation: 0 }, fields: new Map() };
  const base = { ground: () => GROUND, liquid: () => undefined, hole: () => false };
  const motion = { mode: "ground" };
  colliders.frame(state.objects, self, base, motion, 0);
  colliders.frame(state.objects, self, base, motion, 100);
  assert.ok(colliders.carrying && near(self.position.z, pose(lift, 100).z, 1e-3), "a small move is carried");
  const z = self.position.z;
  const jump = ((LIFT_CARRY_MAX_STEP + 5) / 40) * 4000;
  colliders.frame(state.objects, self, base, motion, 100 + jump);
  assert.equal(self.position.z, z, "a jump past the limit leaves the character where it was");
  assert.equal(colliders.carrying, false);
});

// ---------------------------------------------------------------------------------------------
// 11.01: somebody else on the lift. A stock client riding a lift sends ONTRANSPORT with the lift's
// guid and its offset on the car, which the core relays (MovementHandler.cpp:340-345); Wow.exe draws
// a passenger at its offset times the carrier's matrix (0x00704cc0 → vt+0xc4), and a lift's is moved
// along its path every frame (0x007139e0) — the car, not the spawn the state holds.

const RIDER = 0x0000_0000_0000_0777n;

function liftRiderWorld(provide = true) {
  const state = new WorldState();
  if (provide) state.carrierPoseProvider = liftCarrierPose(PATHS);
  state.applyUpdate(liftCreate({ phase: 0 }), 0);
  return state;
}

/** Where an offset on the car is in the world at `now` (the car by `liftPoseAt`). */
function onCar(state, offset, now) {
  const car = pose(state.objects.get(LIFT), now);
  const cos = Math.cos(car.orientation);
  const sin = Math.sin(car.orientation);
  return { x: car.x + offset.x * cos - offset.y * sin, y: car.y + offset.x * sin + offset.y * cos, z: car.z + offset.z };
}

test("11.01: a stock client's rider on a lift is drawn on the car, going up with it", () => {
  const state = liftRiderWorld();
  const offset = { x: 1.5, y: -0.5, z: 0 };
  const world = onCar(state, offset, 1000);
  state.move(RIDER, {
    flags: MOVEMENT_FLAGS.onTransport,
    position: { ...world, orientation: BASE.orientation },
    transport: { guid: LIFT, ...offset, orientation: 0, seat: 0 },
  }, 1000);
  for (const now of [1000, 2000, 3500]) {
    state.updateMotions(now);
    const at = state.objects.get(RIDER).position;
    const expected = onCar(state, offset, now);
    assert.ok(near(at.x, expected.x) && near(at.y, expected.y) && near(at.z, expected.z),
      `${now} ms: on the car (${at.z.toFixed(2)} vs ${expected.z.toFixed(2)})`);
  }
  assert.ok(state.objects.get(RIDER).position.z > BASE.z + 30, "up the shaft, not at the spawn");
  // Without the provider (the state alone): the spawn, as before.
  const bare = liftRiderWorld(false);
  bare.move(RIDER, { flags: MOVEMENT_FLAGS.onTransport, position: { ...world, orientation: 0 },
    transport: { guid: LIFT, ...offset, orientation: 0, seat: 0 } }, 1000);
  bare.updateMotions(3500);
  assert.ok(near(bare.objects.get(RIDER).position.z, BASE.z), "the state's own pose of a lift is its spawn");
});

test("11.01: the rider's next packet glides on the car, not between two world points the car has left", () => {
  const state = liftRiderWorld();
  const first = { x: 1, y: 0, z: 0 };
  state.move(RIDER, { flags: MOVEMENT_FLAGS.onTransport, position: { ...onCar(state, first, 1000), orientation: 0 },
    transport: { guid: LIFT, ...first, orientation: 0, seat: 0 } }, 1000);
  state.updateMotions(1500);
  // Half a yard further along the car, in a packet written at 1500.
  const second = { x: 1.5, y: 0, z: 0 };
  state.move(RIDER, { flags: MOVEMENT_FLAGS.onTransport, position: { ...onCar(state, second, 1500), orientation: 0 },
    transport: { guid: LIFT, ...second, orientation: 0, seat: 0 } }, 1500);
  // Through the glide the car keeps rising; the rider stays on it, between the two offsets.
  for (const now of [1550, 1600, 1680]) {
    state.updateMotions(now);
    const at = state.objects.get(RIDER).position;
    const car = pose(state.objects.get(LIFT), now);
    assert.ok(near(at.z, car.z, 1e-6), `${now} ms: at the car's height (${at.z.toFixed(3)} vs ${car.z.toFixed(3)})`);
  }
  state.updateMotions(2000);
  const end = onCar(state, second, 2000);
  const at = state.objects.get(RIDER).position;
  assert.ok(near(at.x, end.x) && near(at.y, end.y) && near(at.z, end.z), "arrived on the new offset");
});
