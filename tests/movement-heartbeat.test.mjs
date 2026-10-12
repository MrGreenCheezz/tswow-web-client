import assert from "node:assert/strict";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import {
  HEARTBEAT_FLAGS, MOVEMENT_HEARTBEAT_INTERVAL, advancePhysics, beginHeld, characterMotion, endHeld, forgetMovementState,
  heartbeatDue, movementHeartbeat, releaseAllInput, sendMovement,
} from "../dist/code/browser/input/Movement.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { PacketWriter } from "../dist/code/protocol/index.js";
import { MOVEMENT_FLAGS, parseMovementPacket } from "../dist/code/world/MovementProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

// NET-21: MSG_MOVE_HEARTBEAT as Wow.exe 3.3.5a (12340) sends it. Every packet with the active mover's
// MovementInfo goes out through 0x0071f0c0, which sets the next heartbeat's deadline to that packet's
// time + 500 ms (0x006e9b70); the movement update 0x006f09f0 sends one when the movement clock reaches
// the deadline and the flags hold 0x00C0100F (FORWARD, BACKWARD, STRAFE_LEFT/RIGHT, FALLING, ASCENDING,
// DESCENDING). The ground step starts a fall without a packet (0x007620f0 → 0x00988370). Each test runs
// the render loop's own order: the physics, then `heartbeatDue` (Loop.ts), under one stubbed clock.

const clock = { now: 1_000_000 };
const realNow = performance.now;
performance.now = () => clock.now;
test.after(() => { performance.now = realNow; });

/** 16 ms frames: 500 is not a whole number of them, so a heartbeat lands on the first frame past it. */
const FRAME_MS = 16;
/** `UNIT_FLAG_STUNNED`, UnitDefines.h:153. */
const UNIT_FLAG_STUNNED = 0x00040000;

function stubWorld({ x = 0, z = 0, movementState = {} } = {}) {
  const sent = [];
  const mover = { position: { x, y: 0, z, orientation: 0 }, fields: new Map() };
  const world = {
    mapId: 0,
    movementReady: true,
    state: { selfGuid: 1n, objects: new Map([[1n, mover]]) },
    movementState: {
      rooted: false, waterWalking: false, featherFall: false, hovering: false,
      canFly: false, gravityDisabled: false, collisionHeight: 0, ...movementState,
    },
    speeds: new Map(),
    sendMovement: (opcode, flags, position, extra) => {
      sent.push({ opcode, flags, position: { ...position }, extra, at: clock.now });
      mover.position = { ...mover.position };
    },
  };
  return { world, mover, sent };
}

function withWorld(stub, terrain, run) {
  forgetMovementState();
  movementHeartbeat.sentAt = 0;
  game.world = stub.world;
  game.worldLoading = false;
  game.terrain = terrain;
  try {
    run();
  } finally {
    releaseAllInput();
    forgetMovementState();
    game.world = undefined;
    game.terrain = undefined;
  }
}

/** `count` render frames as Loop.ts runs them: the physics, then the heartbeat when it is due. */
function frames(count) {
  for (let index = 0; index < count; index++) {
    clock.now += FRAME_MS;
    advancePhysics(FRAME_MS / 1000);
    if (heartbeatDue(clock.now)) sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
  }
}

const flat = { heightAt: () => 0, liquidAt: () => undefined, isHole: () => false };
const lake = { heightAt: () => -20, liquidAt: () => ({ height: 0, type: 1 }), isHole: () => false };
const heartbeats = (sent) => sent.filter((packet) => packet.opcode === OPCODES.MSG_MOVE_HEARTBEAT);
const opcodes = (sent) => sent.map((packet) => packet.opcode);

/** Every gap is the interval, plus less than one frame. */
function assertCadence(times, interval, label) {
  for (let index = 1; index < times.length; index++) {
    const gap = times[index] - times[index - 1];
    assert.ok(gap >= interval && gap < interval + FRAME_MS, `${label}: gap ${index} is ${gap} ms`);
  }
}

test("NET-21: the interval and the flags are Wow.exe's (0x006e9b70 adds 500; 0x006f09f0 tests 0x00C0100F)", () => {
  assert.equal(MOVEMENT_HEARTBEAT_INTERVAL, 500);
  assert.equal(HEARTBEAT_FLAGS, 0x00c0100f);
});

test("NET-21: walking, the first heartbeat is 500 ms after START_FORWARD and the next ones 500 ms apart", () => {
  const stub = stubWorld();
  withWorld(stub, flat, () => {
    frames(2);
    beginHeld("moveForward");
    const start = clock.now;
    assert.deepEqual(opcodes(stub.sent), [OPCODES.MSG_MOVE_START_FORWARD]);
    frames(Math.ceil(2100 / FRAME_MS));
    const times = heartbeats(stub.sent).map((packet) => packet.at);
    assert.equal(times.length, 4, `four in 2.1 s, not ten: ${times.map((at) => at - start)}`);
    assert.ok(times[0] - start >= 500 && times[0] - start < 500 + FRAME_MS, `the first at ${times[0] - start} ms`);
    assertCadence(times, 500, "walking");
    for (const packet of heartbeats(stub.sent)) assert.ok(packet.flags & MOVEMENT_FLAGS.forward);

    // A packet of the walk's own moves the deadline: the strafe starts at once, the heartbeat waits for it.
    const last = times.at(-1);
    frames(Math.ceil((last + 300 - clock.now) / FRAME_MS));
    beginHeld("strafeLeft");
    const strafe = clock.now;
    frames(Math.ceil(600 / FRAME_MS));
    const after = heartbeats(stub.sent).map((packet) => packet.at).filter((at) => at > last);
    assert.ok(after.length >= 1 && after[0] - strafe >= 500, `500 ms after the strafe, not after the last heartbeat: ${after[0] - strafe}`);
  });
});

test("NET-21: turning in place with the keys is START_TURN and STOP_TURN, with no heartbeat between", () => {
  const stub = stubWorld();
  withWorld(stub, flat, () => {
    frames(2);
    beginHeld("turnLeft");
    frames(Math.ceil(2000 / FRAME_MS));
    endHeld("turnLeft");
    assert.deepEqual(opcodes(stub.sent), [OPCODES.MSG_MOVE_START_TURN_LEFT, OPCODES.MSG_MOVE_STOP_TURN]);
    assert.ok(stub.mover.position.orientation !== 0, "it did turn");
  });
});

test("NET-21: hanging in the air on a flying mount, pitch keys held, sends no heartbeat; rising does", () => {
  const stub = stubWorld({ z: 50, movementState: { canFly: true } });
  withWorld(stub, flat, () => {
    frames(2);
    assert.equal(characterMotion().mode, "air");
    stub.sent.length = 0;
    beginHeld("pitchUp");
    frames(Math.ceil(1500 / FRAME_MS));
    endHeld("pitchUp");
    assert.deepEqual(heartbeats(stub.sent), [], "FLYING and PITCH_UP are not in 0x00C0100F");

    stub.sent.length = 0;
    beginHeld("jump"); // the rise key in the air
    frames(Math.ceil(1600 / FRAME_MS));
    endHeld("jump");
    assert.equal(stub.sent[0].opcode, OPCODES.MSG_MOVE_START_ASCEND);
    const rising = heartbeats(stub.sent);
    assert.equal(rising.length, 3, "ASCENDING keeps the cadence");
    assert.ok(rising.every((packet) => packet.flags & MOVEMENT_FLAGS.ascending));
    assertCadence([stub.sent[0].at, ...rising.map((packet) => packet.at)], 500, "rising");
  });
});

test("NET-21: floating in water sends no heartbeat; swimming forward does, every 500 ms", () => {
  const stub = stubWorld({ z: -5 });
  withWorld(stub, lake, () => {
    frames(2);
    assert.equal(characterMotion().mode, "swim");
    frames(Math.ceil(3000 / FRAME_MS)); // settles at the float line and hangs there
    assert.deepEqual(opcodes(stub.sent), [OPCODES.MSG_MOVE_START_SWIM], "SWIMMING alone repeats nothing");
    beginHeld("moveForward");
    frames(Math.ceil(1100 / FRAME_MS));
    const swum = heartbeats(stub.sent);
    assert.equal(swum.length, 2);
    assert.ok(swum.every((packet) => packet.flags & MOVEMENT_FLAGS.swimming && packet.flags & MOVEMENT_FLAGS.forward));
  });
});

test("NET-21: walking off an edge sends nothing as the fall starts; the next heartbeat, on the walk's deadline, carries it", () => {
  const edge = { heightAt: (_map, x) => (x < 1 ? 0 : -60), liquidAt: () => undefined, isHole: () => false };
  const stub = stubWorld();
  withWorld(stub, edge, () => {
    frames(2);
    beginHeld("moveForward");
    const start = clock.now;
    let fellAt;
    for (let index = 0; index < Math.ceil(700 / FRAME_MS); index++) {
      frames(1);
      if (fellAt === undefined && characterMotion().mode === "air") fellAt = clock.now;
    }
    assert.ok(fellAt !== undefined && fellAt - start < 300, `walked off early in the walk: ${fellAt - start}`);
    const told = heartbeats(stub.sent);
    assert.equal(told.length, 1, `one heartbeat in 700 ms: ${told.map((packet) => packet.at - start)}`);
    assert.ok(told[0].at - start >= 500 && told[0].at - start < 500 + FRAME_MS, `on the deadline, not at the edge: ${told[0].at - start}`);
    assert.ok(told[0].flags & MOVEMENT_FLAGS.falling, "and it says falling");
    assert.ok(told[0].extra.fallTime >= told[0].at - fellAt - FRAME_MS, `with the fall's clock: ${told[0].extra.fallTime}`);
  });
});

test("NET-21: a fall that starts from standing is told on its first frame (the deadline has long passed)", () => {
  const stub = stubWorld({ z: 30 });
  withWorld(stub, flat, () => {
    clock.now += 5000;
    frames(1);
    assert.equal(characterMotion().mode, "air");
    const told = heartbeats(stub.sent);
    assert.equal(told.length, 1, "at once");
    assert.ok(told[0].flags & MOVEMENT_FLAGS.falling);
    frames(Math.ceil(400 / FRAME_MS));
    assert.equal(heartbeats(stub.sent).length, 1, "then 500 ms after it");
  });
});

test("NET-21: a stunned character holding W repeats nothing (the step is out of the flags)", () => {
  const stub = stubWorld();
  withWorld(stub, flat, () => {
    frames(2);
    beginHeld("moveForward");
    stub.mover.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, UNIT_FLAG_STUNNED);
    frames(2);
    assert.equal(stub.sent.at(-1).opcode, OPCODES.MSG_MOVE_STOP, "the stun stopped the step on the wire");
    stub.sent.length = 0;
    frames(Math.ceil(1500 / FRAME_MS));
    assert.deepEqual(opcodes(stub.sent), [], "the key is still down, the flags say standing");
  });
});

// ---- a real WorldClient: the acknowledgements move the deadline too ------------------------------

const SELF = 0x1234n;
const OTHER = 0x9999n;

async function liveWorld() {
  const login = new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array();
  const waiters = [];
  const connection = {
    packets: [{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login }],
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload, at: clock.now }); },
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
  await deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, new PacketWriter().packedGuid(SELF).u8(1).toUint8Array());
  assert.equal(client.movementReady, true);
  client.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  forgetMovementState();
  movementHeartbeat.sentAt = 0;
  game.world = client;
  game.worldLoading = false;
  game.terrain = flat;
  const teardown = () => {
    releaseAllInput();
    forgetMovementState();
    game.world = undefined;
    game.terrain = undefined;
    client.close();
  };
  return { client, connection, deliver, teardown };
}

const speedChange = (guid, counter, speed) => new PacketWriter().packedGuid(guid).u32(counter).u8(1).f32(speed).toUint8Array();

test("NET-21: a forced speed ACK of the mover moves the next heartbeat to 500 ms after it; another unit's does not", async () => {
  const env = await liveWorld();
  try {
    frames(2);
    beginHeld("moveForward");
    const start = clock.now;
    frames(Math.ceil(300 / FRAME_MS));
    await env.deliver(OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE, speedChange(SELF, 1, 8));
    const ack = env.connection.sent.findLast((packet) => packet.opcode === OPCODES.CMSG_FORCE_RUN_SPEED_CHANGE_ACK);
    assert.ok(ack, "acknowledged");
    assert.equal(env.client.moverPacketAt, ack.at, "the acknowledgement is stamped");
    frames(Math.ceil(700 / FRAME_MS));
    const sent = env.connection.sent.filter((packet) => packet.opcode === OPCODES.MSG_MOVE_HEARTBEAT);
    assert.equal(sent.length, 1, `one heartbeat in the second after START_FORWARD: ${sent.map((packet) => packet.at - start)}`);
    assert.ok(sent[0].at - ack.at >= 500 && sent[0].at - ack.at < 500 + FRAME_MS, `500 ms after the ACK: ${sent[0].at - ack.at}`);
    assert.ok(parseMovementPacket(sent[0].payload).flags & MOVEMENT_FLAGS.forward);

    // An acknowledgement for a unit this client does not move leaves the clock alone (0x006e9b70 asks for the mover).
    const stamped = env.client.moverPacketAt;
    frames(5);
    await env.deliver(OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE, speedChange(OTHER, 2, 9));
    assert.equal(env.client.moverPacketAt, stamped);
    assert.ok(env.connection.sent.at(-1).opcode === OPCODES.CMSG_FORCE_RUN_SPEED_CHANGE_ACK, "it was acknowledged");
  } finally {
    env.teardown();
  }
});
