import assert from "node:assert/strict";
import test from "node:test";

// 11.01 slice B, lifts. A lift (GAMEOBJECT_TYPE_TRANSPORT, 11) is a client-only ride: the server
// never moves it (`GameObject::Update` only counts PathProgress, the relocation is commented out,
// GameObject.cpp:520-554) and never makes a player its passenger (`GetTransport` is null for type
// 11, MovementHandler.cpp:340-345). The client moves the platform along its TransportAnimation path
// and the character standing on it with it; packets stay in world coordinates without
// MOVEMENTFLAG_ONTRANSPORT. The phase: the high half of GAMEOBJECT_DYNAMIC is
// `int16(PathProgress % period / period × 65535)` (GameObject.cpp:2866-2873); the create block's
// transport word is the server's uptime for a lift (Object.cpp:442-454).
import { PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { MOVEMENT_FLAGS, parseMovementPacket } from "../dist/code/world/MovementProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { decodeCollisionModel, encodeCollisionModel } from "../dist/code/world/CollisionFormat.js";
import { game } from "../dist/code/browser/game/Context.js";
import { advancePhysics, forgetMovementState, isGrounded, isMoving, releaseAllInput, sendMovement } from "../dist/code/browser/input/Movement.js";
import { TransportCollision } from "../dist/code/browser/game/TransportCollision.js";
import {
  GO_STATE_READY, GO_TYPE_TRANSPORT, GameObjectColliders, LIFT_CARRY_MAX_STEP, setGameObjectColliders,
} from "../dist/code/browser/game/GameObjectColliders.js";
import { liftClock, liftPoseAt } from "../dist/code/browser/LiftClock.js";

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

/**
 * A lift's create block as the core sends it: UPDATEFLAG_TRANSPORT | UPDATEFLAG_STATIONARY_POSITION
 * (GameObject.cpp:320-321), the transport word, and the values the colliders read.
 */
function liftCreate({ dynamic, transportTime = 123_456, base = BASE }) {
  const values = new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, LIFT_ENTRY],
    [UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset, LIFT_DISPLAY],
    [UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, (GO_TYPE_TRANSPORT << 8) | GO_STATE_READY],
    [UPDATE_FIELDS.GAMEOBJECT_DYNAMIC.offset, dynamic],
  ]);
  const blocks = Math.ceil((Math.max(...values.keys()) + 1) / 32);
  const masks = new Array(blocks).fill(0);
  for (const index of values.keys()) masks[index >> 5] |= 1 << (index & 31);
  const writer = new PacketWriter().u32(1).u8(2).packedGuid(LIFT).u8(5).u16(0x42)
    .f32(base.x).f32(base.y).f32(base.z).f32(base.orientation).u32(transportTime).u8(blocks);
  for (const mask of masks) writer.u32(mask >>> 0);
  for (const index of [...values.keys()].sort((a, b) => a - b)) writer.u32(values.get(index));
  return writer.toUint8Array();
}

const pose = (object, now) => liftPoseAt(object, PATH, now, { x: 0, y: 0, z: 0, orientation: 0 });

test("the phase comes from GAMEOBJECT_DYNAMIC, anchored when the create block was read", () => {
  const state = new WorldState();
  state.applyUpdate(liftCreate({ dynamic: dynamicFor(1000) }), 1000);
  const lift = state.objects.get(LIFT);
  assert.equal(lift.transportTime, 123_456, "the uptime word is there and loses to the dynamic phase");
  // First looked at two seconds after the block arrived (a hidden page): already 3 s into the cycle.
  const at = pose(lift, 3000);
  assert.ok(near(at.z, BASE.z + 30, 0.01), `at the read + 2 s: ${at.z}`);
  assert.ok(near(at.x, BASE.x) && near(at.y, BASE.y) && near(at.orientation, BASE.orientation));

  // No phase in the dynamic word (−1): the uptime modulo the period.
  const fallback = new WorldState();
  fallback.applyUpdate(liftCreate({ dynamic: 0xffff_0000, transportTime: 21_000 }), 0);
  assert.ok(near(pose(fallback.objects.get(LIFT), 0).z, BASE.z + 10, 0.01), "1000 ms into the cycle");
});

test("a horizontal path is turned by the spawn's yaw before it is added", () => {
  const state = new WorldState();
  state.applyUpdate(liftCreate({ dynamic: dynamicFor(0) }), 0);
  const tram = { entry: LIFT_ENTRY, period: 2000, frames: [{ time: 0, x: 0, y: 0, z: 0 }, { time: 1000, x: 10, y: 0, z: 0 }] };
  const at = liftPoseAt(state.objects.get(LIFT), tram, 1000, { x: 0, y: 0, z: 0, orientation: 0 });
  assert.ok(near(at.x, BASE.x + 10 * Math.cos(BASE.orientation)) && near(at.y, BASE.y + 10 * Math.sin(BASE.orientation)));
});

test("a re-CREATE of the same lift resyncs its phase and keeps its mesh; a far DYNAMIC corrects it", () => {
  const state = new WorldState();
  state.applyUpdate(liftCreate({ dynamic: dynamicFor(1000) }), 1000);
  const first = state.objects.get(LIFT);
  const collision = liftCollision();
  const mesh = collision.forObject(first);
  assert.ok(mesh, "the platform's mesh");
  assert.ok(near(pose(first, 5000).z, BASE.z + 40, 0.01), "the first clock: 5000 ms in, at the top");

  // The core sends the create block again on every visibility pass, with a fresh phase.
  state.applyUpdate(liftCreate({ dynamic: dynamicFor(7000) }), 5000);
  const second = state.objects.get(LIFT);
  assert.notEqual(second, first);
  assert.ok(near(pose(second, 5000).z, BASE.z + 20, 0.01), `resynced to 7000 ms: ${pose(second, 5000).z}`);
  assert.equal(collision.forObject(second), mesh, "the same mesh: the model is not rebuilt");

  // A values update whose phase is far from the running clock re-anchors it; one inside the window does not.
  second.fields.set(UPDATE_FIELDS.GAMEOBJECT_DYNAMIC.offset, dynamicFor(7100));
  assert.ok(near(pose(second, 5100).z, BASE.z + 19, 0.05), "within the slack: the clock stands");
  second.fields.set(UPDATE_FIELDS.GAMEOBJECT_DYNAMIC.offset, dynamicFor(2000));
  assert.ok(near(pose(second, 5100).z, BASE.z + 20, 0.05), "far off: the word wins");
  assert.equal(liftClock(second, PATH.period, 5100).corrections, 1);
  // Another period (the entry, and so the path, changed): a clock of its own, from the word as it is.
  const other = liftClock(second, 20_000, 5100);
  assert.equal(other.corrections, 0);
  assert.ok(near(other.progressMs, (Math.trunc((2000 / PATH.period) * 65535) / 65535) * 20_000, 1e-6));
  // Review: that word is the values update's, not the create block's: it counts from now, not from the read.
  assert.equal(other.at, 5100, "a re-anchored clock starts now");
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

  client.state.applyUpdate(liftCreate({ dynamic: dynamicFor(phase) }), clock.now);
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
  state.applyUpdate(liftCreate({ dynamic: dynamicFor(0) }), 0);
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
