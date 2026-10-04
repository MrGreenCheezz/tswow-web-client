import assert from "node:assert/strict";
import test from "node:test";

// 11.01, L16: what happens to the character's own motion when it changes frames in the air, and the
// camera on a turning deck. Wow.exe's frame change is CMovementData_C::ForceSetTransportInt
// (0x006ec400): leaving goes through 0x0098c730 → 0x0098b9a0 → 0x0098b850, boarding through
// 0x0098ba20 → 0x0098b850, which compose the position and turn the movement direction — the 3-D one at
// +0x64 and the jump block's cos/sin at +0x70/+0x74 — by the transport's rotation, and keep the
// speeds; nothing adds the transport's own velocity. The camera's yaw is made relative to the
// transport the character boards (0x0074b380 → 0x00604a70 → 0x005fe5f0), so it turns with the deck.
// Fixtures as tests/transport-ride.test.mjs: a real WorldClient over a fake connection, the real
// WorldState and movement layer, the deck a TransportCollision plane at z = 2 in the ship's frame.
import { PacketReader, PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { MOVEMENT_FLAGS, parseMovementPacket, readMovementInfo } from "../dist/code/world/MovementProtocol.js";
import { knockbackImpulse } from "../dist/code/world/KnockbackImpulse.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { decodeCollisionModel, encodeCollisionModel } from "../dist/code/world/CollisionFormat.js";
import { game } from "../dist/code/browser/game/Context.js";
import {
  advancePhysics, applyKnockback, beginHeld, characterMotion, endHeld, forgetMovementState, releaseAllInput,
} from "../dist/code/browser/input/Movement.js";
import { currentRide, setRideCarriers } from "../dist/code/browser/input/MovementRide.js";
import { TransportCollision } from "../dist/code/browser/game/TransportCollision.js";
import { createCamera } from "../dist/code/browser/SimpleScene.js";

const SELF = 0x1234n;
const SHIP = 0x1fc0_0000_0000_0007n;
const DISPLAY = 3015;
const DECK_Z = 2;
const DECK_HALF_X = 15;
const DECK_HALF_Y = 6;
const SEA_FLOOR = -50;

function carriers() {
  const vertices = Float32Array.from([
    -DECK_HALF_X, -DECK_HALF_Y, DECK_Z, DECK_HALF_X, -DECK_HALF_Y, DECK_Z,
    DECK_HALF_X, DECK_HALF_Y, DECK_Z, -DECK_HALF_X, DECK_HALF_Y, DECK_Z,
  ]);
  const group = {
    bounds: { minX: -DECK_HALF_X, minY: -DECK_HALF_Y, minZ: DECK_Z, maxX: DECK_HALF_X, maxY: DECK_HALF_Y, maxZ: DECK_Z },
    flags: 0x8, groupId: 1, vertices, indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
  const model = decodeCollisionModel(encodeCollisionModel([group]).slice().buffer);
  return new TransportCollision({ revision: 0, model: (id) => (id === DISPLAY ? model : null), requestGroups() {} });
}

function compose(pose, offset) {
  const cos = Math.cos(pose.orientation);
  const sin = Math.sin(pose.orientation);
  return { x: pose.x + offset.x * cos - offset.y * sin, y: pose.y + offset.x * sin + offset.y * cos, z: pose.z + offset.z };
}

const near = (a, b, tolerance = 1e-3) => Math.abs(a - b) <= tolerance;
const turnNear = (a, b, tolerance = 1e-3) => Math.abs(((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) <= tolerance;
const sentOf = (connection, opcode) => connection.sent.filter((packet) => packet.opcode === opcode);

/** The character at `world` (or on the deck at `offset`), a ship sailing at `velocity` and turning at `turnRate`. */
async function shipWorld({ pose, offset, world, velocity = { x: 0, y: 0 }, turnRate = 0 }) {
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
  const control = { opcode: OPCODES.SMSG_CLIENT_CONTROL_UPDATE, payload: new PacketWriter().packedGuid(SELF).u8(1).toUint8Array() };
  if (waiter) waiter(control);
  else connection.packets.push(control);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.movementReady, true);

  client.state.move(SHIP, { flags: 0, position: { ...pose } });
  const ship = client.state.objects.get(SHIP);
  ship.typeId = 5;
  ship.fields.set(UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 15 << 8);
  ship.fields.set(UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset, DISPLAY);
  const start = { ...pose };
  const clock = { now: 1000, startedAt: 1000 + 1000 / 60 };
  client.state.poseProvider = (state, now) => {
    const position = state.objects.get(SHIP)?.position;
    if (!position) return;
    const seconds = (now - clock.startedAt) / 1000;
    position.x = start.x + velocity.x * seconds;
    position.y = start.y + velocity.y * seconds;
    position.orientation = start.orientation + turnRate * seconds;
  };
  const at = world ?? { ...compose(pose, offset), orientation: pose.orientation + (offset.orientation ?? 0) };
  client.state.move(SELF, { flags: 0, position: { ...at } });

  forgetMovementState();
  setRideCarriers(carriers());
  game.world = client;
  game.worldLoading = false;
  game.terrain = { heightAt: () => SEA_FLOOR, liquidAt: () => undefined, isHole: () => false };
  const frame = (seconds = 1 / 60) => {
    clock.now += seconds * 1000;
    client.state.updateMotions(clock.now);
    advancePhysics(seconds);
  };
  /** L16-review: a server packet into the client's read loop. */
  const deliver = async (opcode, payload) => {
    const next = waiters.shift();
    if (next) next({ opcode, payload });
    else connection.packets.push({ opcode, payload });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    client, connection, frame, deliver,
    self: () => client.state.objects.get(SELF),
    shipPose: () => client.state.objects.get(SHIP).position,
  };
}

function teardown(client) {
  releaseAllInput();
  forgetMovementState();
  setRideCarriers(undefined);
  game.world = undefined;
  game.terrain = undefined;
  game.worldLoading = false;
  client.close();
}

test("jumping over the rail of a sailing ship: the fall keeps the character's own way, turned into the world, and not the ship's speed", async () => {
  // The ship faces world +y (its own +x) and sails along world +x — across its own keel, so its
  // velocity and the character's run are at right angles and cannot be mistaken for each other.
  const pose = { x: 100, y: 200, z: 10, orientation: Math.PI / 2 };
  const env = await shipWorld({ pose, offset: { x: 12, y: 0, z: DECK_Z }, velocity: { x: 6, y: 0 } });
  try {
    env.frame();
    assert.equal(currentRide()?.guid, SHIP);
    beginHeld("moveForward");
    env.frame();
    beginHeld("jump");
    env.frame();
    endHeld("jump");
    const jump = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_JUMP).at(-1).payload);
    assert.equal(jump.flags & MOVEMENT_FLAGS.onTransport, MOVEMENT_FLAGS.onTransport);
    assert.ok(near(jump.jump.cosAngle, 1) && near(jump.jump.sinAngle, 0), "aboard, the jump's way is the ship's frame's");
    let frames = 0;
    while (currentRide() !== undefined && frames < 120) {
      env.frame();
      frames++;
    }
    assert.equal(currentRide(), undefined, "over the rail and off the ship, in the air");
    assert.equal(characterMotion().mode, "air");
    // The packet that says so: no block, and the jump block now in the world's frame.
    const leaving = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_HEARTBEAT).at(-1).payload);
    assert.equal(leaving.flags & MOVEMENT_FLAGS.onTransport, 0);
    assert.equal(leaving.flags & MOVEMENT_FLAGS.falling, MOVEMENT_FLAGS.falling);
    assert.ok(near(leaving.jump.cosAngle, 0) && near(leaving.jump.sinAngle, 1),
      `the jump's way turned by the ship's heading: cos ${leaving.jump.cosAngle}, sin ${leaving.jump.sinAngle}`);
    assert.ok(near(leaving.jump.speed, jump.jump.speed), "at the speed it left the deck with");
    // And the body goes that way: world +y at its own speed, nothing of the ship's +x.
    const before = { ...env.self().position };
    env.frame(0.1);
    const at = env.self().position;
    assert.equal(characterMotion().mode, "air");
    assert.ok(near(at.x - before.x, 0, 1e-3), `the ship's velocity is not the character's: dx ${at.x - before.x}`);
    assert.ok(near(at.y - before.y, jump.jump.speed * 0.1, 1e-3), `its own run: dy ${at.y - before.y}`);
  } finally {
    endHeld("moveForward");
    teardown(env.client);
  }
});

test("a knock back carried over the rail goes on the way it was pushed once the ride ends", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: Math.PI / 2 };
  // Near the starboard rail (the ship's −y), which on this ship is world +x.
  const env = await shipWorld({ pose, offset: { x: 0, y: -5, z: DECK_Z } });
  try {
    env.frame();
    assert.equal(currentRide()?.guid, SHIP);
    applyKnockback({ cos: 1, sin: 0, speedXY: 6, upSpeed: 4 });
    let frames = 0;
    while (currentRide() !== undefined && frames < 120) {
      env.frame();
      frames++;
    }
    assert.equal(currentRide(), undefined);
    assert.equal(characterMotion().mode, "air");
    const leaving = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_HEARTBEAT).at(-1).payload);
    assert.ok(near(leaving.jump.cosAngle, 1) && near(leaving.jump.sinAngle, 0), "the knock back's way is the world's again");
    const before = { ...env.self().position };
    env.frame(0.1);
    const at = env.self().position;
    assert.ok(near(at.x - before.x, 0.6, 1e-3), `still pushed along world +x: ${at.x - before.x}`);
    assert.ok(near(at.y - before.y, 0, 1e-3), `not along the ship's −y turned wrong: ${at.y - before.y}`);
  } finally {
    teardown(env.client);
  }
});

test("L16-review: over the rail of a turning ship the arc leaves by the heading of the frame it leaves in", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: Math.PI / 2 };
  const env = await shipWorld({ pose, offset: { x: 0, y: -5, z: DECK_Z }, turnRate: 0.5 });
  try {
    env.frame();
    assert.equal(currentRide()?.guid, SHIP);
    const boarded = env.shipPose().orientation;
    // Along world +x, the ship's −y at this moment; aboard, the block stays in the ship's frame.
    applyKnockback({ cos: 1, sin: 0, speedXY: 6, upSpeed: 4 });
    let frames = 0;
    while (currentRide() !== undefined && frames < 120) {
      env.frame();
      frames++;
    }
    assert.equal(currentRide(), undefined);
    const turned = env.shipPose().orientation - boarded;
    assert.ok(turned > 0.1, `the ship turned while the character was aboard: ${turned}`);
    const leaving = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_HEARTBEAT).at(-1).payload);
    assert.ok(near(leaving.jump.cosAngle, Math.cos(turned)) && near(leaving.jump.sinAngle, Math.sin(turned)),
      `turned with the deck, then into the world: cos ${leaving.jump.cosAngle} vs ${Math.cos(turned)}`);
  } finally {
    teardown(env.client);
  }
});

test("boarding in the air turns a knock back's way into the ship's frame", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: Math.PI / 2 };
  // Half a yard over the deck, not aboard: the knock back starts in the world.
  const env = await shipWorld({ pose, world: { x: 100, y: 200, z: 10 + DECK_Z + 0.5, orientation: 0 } });
  try {
    applyKnockback({ cos: 1, sin: 0, speedXY: 3, upSpeed: 0 });
    const before = { ...env.self().position };
    env.frame();
    assert.equal(currentRide()?.guid, SHIP, "boarded in the air");
    for (let frame = 0; frame < 5; frame++) env.frame();
    const at = env.self().position;
    assert.ok(at.x - before.x > 0.2, `pushed along world +x: ${at.x - before.x}`);
    assert.ok(Math.abs(at.y - before.y) < 0.01, `not turned onto world y: ${at.y - before.y}`);
  } finally {
    teardown(env.client);
  }
});

test("a seat the server gives or takes in the air changes the arc's frame as boarding and leaving do", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: Math.PI / 2 };
  const env = await shipWorld({ pose, world: { x: 100, y: 200, z: 10 + DECK_Z + 3, orientation: 0 } });
  try {
    // In the air in the world, pushed along world +x; then a seat on the ship arrives (a create block).
    applyKnockback({ cos: 1, sin: 0, speedXY: 3, upSpeed: 6 });
    env.self().transport = { guid: SHIP, x: 0, y: 0, z: DECK_Z + 3, orientation: -Math.PI / 2, seat: 0xff };
    let before = { ...env.self().position };
    env.frame();
    assert.equal(currentRide()?.guid, SHIP, "the server's seat is the ride");
    for (let frame = 0; frame < 4; frame++) env.frame();
    let at = env.self().position;
    assert.ok(at.x - before.x > 0.2 && Math.abs(at.y - before.y) < 0.01, `still along world +x aboard: ${at.x - before.x}, ${at.y - before.y}`);
    // The server takes the seat away mid-air: the arc goes on along world +x in the world.
    assert.equal(characterMotion().mode, "air");
    env.self().transport = undefined;
    before = { ...env.self().position };
    for (let frame = 0; frame < 4; frame++) env.frame();
    assert.equal(currentRide(), undefined);
    at = env.self().position;
    assert.ok(at.x - before.x > 0.15 && Math.abs(at.y - before.y) < 0.01, `still along world +x off it: ${at.x - before.x}, ${at.y - before.y}`);
  } finally {
    teardown(env.client);
  }
});

// L16-review: Wow.exe applies a knock back (SMSG 0xEF → 0x0072d1b0 → movement event 0x22 in 0x006ed0f0 →
// 0x006e9ff0) by writing the server's world direction into the jump block (+0x70/+0x74) and, for a mover
// on a transport, turning it through the transport's inverse matrix into the transport's frame; the
// acknowledgement (0xF0) goes out after that, from the same block. The heartbeats that follow carry the
// block in the ship's frame here too (`rideImpulse`), so the acknowledgement must not be the odd one out:
// the core relays its block to everyone around as MSG_MOVE_KNOCK_BACK (MovementHandler.cpp:651-663).
test("L16-review: a knock back on a deck is acknowledged in the ship's frame, the frame the heartbeats after it use", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: Math.PI / 2 };
  const env = await shipWorld({ pose, offset: { x: 0, y: 0, z: DECK_Z } });
  try {
    env.client.onKnockBack = (knockBack) => applyKnockback(knockbackImpulse(knockBack));
    env.frame();
    assert.equal(currentRide()?.guid, SHIP);
    // Thrown along world +x — across this ship's keel, its own −y (`Unit::KnockbackFrom`: cos, sin, xy, −z).
    await env.deliver(OPCODES.SMSG_MOVE_KNOCK_BACK,
      new PacketWriter().packedGuid(SELF).u32(0).f32(1).f32(0).f32(6).f32(-4).toUint8Array());
    const acks = sentOf(env.connection, OPCODES.CMSG_MOVE_KNOCK_BACK_ACK);
    assert.equal(acks.length, 1);
    const reader = new PacketReader(acks[0].payload);
    assert.equal(reader.packedGuid(), SELF);
    reader.u32();
    const ack = readMovementInfo(reader);
    assert.equal(ack.flags & MOVEMENT_FLAGS.onTransport, MOVEMENT_FLAGS.onTransport, "still aboard");
    assert.equal(ack.transport?.guid, SHIP);
    assert.ok(near(ack.jump.cosAngle, 0) && near(ack.jump.sinAngle, -1),
      `the way in the ship's frame: cos ${ack.jump.cosAngle}, sin ${ack.jump.sinAngle}`);
    const block = characterMotion().jump;
    assert.ok(near(block.cosAngle, ack.jump.cosAngle) && near(block.sinAngle, ack.jump.sinAngle),
      "the block the heartbeats carry is the acknowledged one");
    assert.ok(near(ack.jump.speed, 6) && near(ack.jump.velocity, -4), "speeds as the server sent them");
  } finally {
    teardown(env.client);
  }
});

test("the camera turns with the ship: the character's facing follows the deck, the camera's offset from it stays", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: 0.3 };
  const env = await shipWorld({ pose, offset: { x: 2, y: 1, z: DECK_Z, orientation: 0.2 }, turnRate: 0.25 });
  try {
    const rigYaw = 0.6;
    env.frame();
    assert.equal(currentRide()?.guid, SHIP);
    for (let frame = 0; frame < 120; frame++) env.frame();
    const shipNow = env.shipPose();
    assert.ok(shipNow.orientation > pose.orientation + 0.4, "the ship turned");
    const self = env.self();
    assert.ok(turnNear(self.position.orientation, shipNow.orientation + 0.2), "the facing turned with it");
    assert.ok(near(self.transport.orientation, 0.2), "and stayed the same on the deck");
    const camera = createCamera(self.position, rigYaw);
    assert.ok(turnNear(Math.atan2(camera.forward.y, camera.forward.x), shipNow.orientation + 0.2 + rigYaw),
      "the camera looks the deck's way, its offset kept");
  } finally {
    teardown(env.client);
  }
});
