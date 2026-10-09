import assert from "node:assert/strict";
import test from "node:test";

// 11.01 slice A3: standing on a ship's deck and sailing with it. A real WorldClient over a fake
// connection (as tests/mover-control.test.mjs), the real WorldState (its poseProvider moves the
// ship, #carryPassenger carries passengers) and the real movement layer; the deck is a carrier
// mesh of `TransportCollision` (slice A2): a plane at z = 2 in the ship's frame. The core's facts
// these pin: a movement packet with MOVEMENTFLAG_ONTRANSPORT (0x200) and a transport guid makes
// the player a passenger, one without it takes them off (MovementHandler.cpp:306-351); `pos` is
// the world position (an offset there is dropped as off the map, :299/:310); the offset may not
// exceed 75 on any axis (:313-315); a ship's seat is −1, 0xFF on the wire (MovementInfo.h:40,
// WorldSession.cpp:976); every ACK replaces m_movementInfo whole, so it must carry the block too.
import { PacketReader, PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { MOVEMENT_FLAGS, parseMovementPacket, readMovementInfo } from "../dist/code/world/MovementProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { decodeCollisionModel, encodeCollisionModel } from "../dist/code/world/CollisionFormat.js";
import { game } from "../dist/code/browser/game/Context.js";
import {
  advancePhysics, applyKnockback, beginHeld, endHeld, forgetMovementState, isMoving, releaseAllInput, sendMovement,
  turnCharacterBy,
} from "../dist/code/browser/input/Movement.js";
import { currentRide, setRideCarriers } from "../dist/code/browser/input/MovementRide.js";
import { TransportCollision } from "../dist/code/browser/game/TransportCollision.js";
import {
  RIDE_LEAVE_FRAMES, RIDE_MAX_OFFSET, SHIP_SEAT, TRANSPORT_OFFSET_LIMIT, boardingDecision, newRideState, rideVerdict,
} from "../dist/code/browser/game/TransportRide.js";
import { LOAD_WAIT_MAX } from "../dist/code/browser/game/Physics.js";

const SELF = 0x1234n;
const SHIP = 0x1fc0_0000_0000_0007n;
const DISPLAY = 3015;
const DECK_Z = 2;
/** The deck: x ∈ [−15, 15], y ∈ [−6, 6] in the ship's frame. */
const DECK_HALF_X = 15;
const SEA_FLOOR = -50;

// ---------------------------------------------------------------------------------------------
// Fixtures.

function deckModel() {
  const vertices = Float32Array.from([
    -DECK_HALF_X, -6, DECK_Z, DECK_HALF_X, -6, DECK_Z, DECK_HALF_X, 6, DECK_Z, -DECK_HALF_X, 6, DECK_Z,
  ]);
  const indices = Uint32Array.from([0, 1, 2, 0, 2, 3]);
  const group = {
    bounds: { minX: -DECK_HALF_X, minY: -6, minZ: DECK_Z, maxX: DECK_HALF_X, maxY: 6, maxZ: DECK_Z },
    flags: 0x8, groupId: 1, vertices, indices,
  };
  return decodeCollisionModel(encodeCollisionModel([group]).slice().buffer);
}

/** The ship's collision as the page has it: `TransportCollision` over a model source. */
function carriers() {
  const model = deckModel();
  return new TransportCollision({ revision: 0, model: (id) => (id === DISPLAY ? model : null), requestGroups() {} });
}

function compose(pose, offset) {
  const cos = Math.cos(pose.orientation);
  const sin = Math.sin(pose.orientation);
  return {
    x: pose.x + offset.x * cos - offset.y * sin,
    y: pose.y + offset.x * sin + offset.y * cos,
    z: pose.z + offset.z,
  };
}

const near = (a, b, tolerance = 1e-3) => Math.abs(a - b) <= tolerance;
const sentOf = (connection, opcode) => connection.sent.filter((packet) => packet.opcode === opcode);

/**
 * A logged-in WorldClient with control of the character, a ship in view and the character on its
 * deck at `offset`. `pier` (world x) raises the ground to the deck's height beyond it.
 */
async function rideWorld({ pose, offset, velocity = { x: 0, y: 0 }, pier } = {}) {
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
  const deliver = async (opcode, payload) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ opcode, payload });
    else connection.packets.push({ opcode, payload });
    await new Promise((resolve) => setImmediate(resolve));
  };
  await deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, new PacketWriter().packedGuid(SELF).u8(1).toUint8Array());
  assert.equal(client.movementReady, true);

  // The ship: a MO transport (GAMEOBJECT_BYTES_1 byte 1 = 15) whose pose the provider moves along a line.
  client.state.move(SHIP, { flags: 0, position: { ...pose } });
  const ship = client.state.objects.get(SHIP);
  ship.typeId = 5;
  ship.fields.set(UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 15 << 8);
  ship.fields.set(UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset, DISPLAY);
  const start = { ...pose };
  // The ship starts sailing at the first frame: the character boards the deck it was put on.
  const clock = { now: 1000, startedAt: 1000 + 1000 / 60 };
  client.state.poseProvider = (state, now) => {
    const position = state.objects.get(SHIP)?.position;
    if (!position) return;
    const seconds = (now - clock.startedAt) / 1000;
    position.x = start.x + velocity.x * seconds;
    position.y = start.y + velocity.y * seconds;
  };
  const world = compose(pose, offset);
  client.state.move(SELF, { flags: 0, position: { ...world, orientation: pose.orientation + (offset.orientation ?? 0) } });

  forgetMovementState();
  setRideCarriers(carriers());
  game.world = client;
  game.worldLoading = false;
  game.terrain = {
    heightAt: (_map, x) => (pier !== undefined && x >= pier ? pose.z + DECK_Z : SEA_FLOOR),
    liquidAt: () => undefined,
    isHole: () => false,
  };
  /** One render frame as Loop.ts runs it: the carriers' poses and the carry, then the physics. */
  const frame = (seconds = 1 / 60) => {
    clock.now += seconds * 1000;
    client.state.updateMotions(clock.now);
    advancePhysics(seconds);
  };
  const self = () => client.state.objects.get(SELF);
  const shipPose = () => client.state.objects.get(SHIP).position;
  return { client, connection, deliver, frame, self, shipPose };
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

/** The world position a passenger packet stands for, by the core's own composition. */
function assertWorldPosition(info, pose) {
  const expected = compose(pose, info.transport);
  assert.ok(near(info.position.x, expected.x, 1e-2) && near(info.position.y, expected.y, 1e-2)
    && near(info.position.z, expected.z, 1e-2),
  `pos is the world position: got ${JSON.stringify(info.position)}, expected ${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------------------------------
// The pure rules.

test("boardingDecision: the deck must be the highest floor within a step over the feet, and within reach under them", () => {
  const deck = (z) => ({ z, carrier: SHIP });
  const world = (z) => ({ z, carrier: undefined });
  assert.equal(boardingDecision(12, [deck(12), world(-50)], 1.6), SHIP, "standing on the deck");
  assert.equal(boardingDecision(12, [deck(12.8), world(-50)], 1.6), SHIP, "a step up onto it");
  assert.equal(boardingDecision(12, [deck(11), world(11.5)], 1.6), undefined, "a pier over the deck is the floor");
  assert.equal(boardingDecision(12, [deck(12), world(12)], 1.6), undefined, "a deck flush with the pier: the pier");
  assert.equal(boardingDecision(12, [deck(14), world(-50)], 1.6), undefined, "a deck over the head is not under the feet");
  assert.equal(boardingDecision(30, [deck(12), world(-50)], 1.6), undefined, "far below: not until the feet get there");
  assert.equal(boardingDecision(30, [deck(12), world(-50)], 20), SHIP, "a fall that reaches it this frame boards");
  assert.equal(boardingDecision(12, [world(undefined), deck(undefined)], 1.6), undefined);
});

test("rideVerdict: twenty frames without the deck, a jump over it does not count, the world's floor or the bounds end it at once", () => {
  const ride = newRideState(SHIP, { x: 0, y: 0, z: 10, orientation: 0 });
  const footing = (over) => ({ deckZ: 2, deckKnown: true, worldFloorZ: -50, poseZ: 10, mode: "ground", flying: false, ...over });
  const local = { x: 1, y: 1, z: 2 };
  assert.equal(rideVerdict(ride, local, footing()), false, "on the deck");

  // A jump: high over the deck, which is still what is underneath.
  for (let frame = 0; frame < 40; frame++) {
    assert.equal(rideVerdict(ride, { x: 1, y: 1, z: 4 }, footing({ mode: "air" })), false, "a jump is not leaving");
  }
  assert.equal(ride.offDeckFrames, 0);

  // Over the rail: nothing of the deck under the feet.
  for (let frame = 1; frame < RIDE_LEAVE_FRAMES; frame++) {
    assert.equal(rideVerdict(ride, { x: 16, y: 1, z: 1 }, footing({ deckZ: undefined, mode: "air" })), false, `frame ${frame}`);
  }
  assert.equal(rideVerdict(ride, { x: 16, y: 1, z: 1 }, footing({ deckZ: undefined, mode: "air" })), true,
    `frame ${RIDE_LEAVE_FRAMES} ends it`);

  const fresh = () => newRideState(SHIP, { x: 0, y: 0, z: 10, orientation: 0 });
  assert.equal(rideVerdict(fresh(), local, footing({ deckZ: undefined, worldFloorZ: 12, mode: "air" })), true,
    "the world's floor right under the feet (a pier) ends it at once");
  assert.equal(rideVerdict(fresh(), local, footing({ deckZ: undefined, worldFloorZ: 12.5 })), true,
    "stood on the world's floor");
  assert.equal(rideVerdict(fresh(), { x: RIDE_MAX_OFFSET + 0.1, y: 0, z: 2 }, footing()), true, "beyond 65 on an axis");
  assert.equal(rideVerdict(fresh(), local, footing({ mode: "swim" })), true, "in water");
  assert.equal(rideVerdict(fresh(), local, footing({ mode: "air", flying: true })), true, "flying");
  const loading = fresh();
  for (let frame = 0; frame < 2 * RIDE_LEAVE_FRAMES; frame++) {
    assert.equal(rideVerdict(loading, local, footing({ deckZ: undefined, deckKnown: false })), false);
  }
  assert.ok(RIDE_MAX_OFFSET < TRANSPORT_OFFSET_LIMIT, "the ride ends before the core would drop the packets");
});

// ---------------------------------------------------------------------------------------------
// The ride, end to end.

test("boarding: the deck under the feet makes a passenger, and the packet says so with the world position", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: 0.5 };
  const env = await rideWorld({ pose, offset: { x: 3, y: 1, z: DECK_Z } });
  try {
    env.frame();
    assert.equal(currentRide()?.guid, SHIP, "boarded");
    assert.equal(env.self().transport?.guid, SHIP);
    const heartbeats = sentOf(env.connection, OPCODES.MSG_MOVE_HEARTBEAT);
    assert.equal(heartbeats.length, 1, "the flag flip is told at once");
    const packet = parseMovementPacket(heartbeats[0].payload);
    assert.equal(packet.guid, SELF);
    assert.equal(packet.flags & MOVEMENT_FLAGS.onTransport, MOVEMENT_FLAGS.onTransport);
    assert.equal(packet.transport.guid, SHIP);
    assert.equal(packet.transport.seat, SHIP_SEAT, "a ship's seat is −1");
    assert.ok(near(packet.transport.x, 3) && near(packet.transport.y, 1) && near(packet.transport.z, DECK_Z), "the offset");
    assert.ok(near(packet.transport.orientation, 0), "facing relative to the ship");
    assertWorldPosition(packet, pose);
  } finally {
    teardown(env.client);
  }
});

test("riding with no input: the character goes where the ship goes, heartbeats carry the block and the world position", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: 0.5 };
  const env = await rideWorld({ pose, offset: { x: 3, y: 1, z: DECK_Z }, velocity: { x: 6, y: -2 } });
  try {
    env.frame();
    for (let frame = 0; frame < 120; frame++) env.frame();
    const shipPose = env.shipPose();
    assert.ok(shipPose.x > 110, "the ship sailed");
    const expected = compose(shipPose, { x: 3, y: 1, z: DECK_Z });
    const at = env.self().position;
    assert.ok(near(at.x, expected.x) && near(at.y, expected.y) && near(at.z, expected.z),
      `on the same spot of the deck: ${JSON.stringify(at)} vs ${JSON.stringify(expected)}`);
    assert.ok(near(at.orientation, 0.5), "facing turns with the ship");
    assert.equal(isMoving(), true, "a sailing ship keeps the heartbeat going without a key");

    // The heartbeat Loop.ts sends while isMoving().
    sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    const packet = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_HEARTBEAT).at(-1).payload);
    assert.equal(packet.flags & MOVEMENT_FLAGS.onTransport, MOVEMENT_FLAGS.onTransport);
    assert.equal(packet.transport.guid, SHIP);
    assertWorldPosition(packet, shipPose);
    assert.ok(Math.abs(packet.position.x - packet.transport.x) > 50, "not the offset");
    for (const axis of ["x", "y", "z"]) {
      assert.ok(Math.abs(packet.transport[axis]) <= TRANSPORT_OFFSET_LIMIT, `offset ${axis} within the core's limit`);
    }
    assert.equal(env.self().transport?.guid, SHIP, "the packet did not take the character off the ship");
  } finally {
    teardown(env.client);
  }
});

test("an acknowledgement on a deck carries the block: a forced speed ACK keeps the character a passenger", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: 2 };
  const env = await rideWorld({ pose, offset: { x: -4, y: 2, z: DECK_Z }, velocity: { x: 0, y: 5 } });
  try {
    for (let frame = 0; frame < 30; frame++) env.frame();
    await env.deliver(OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE,
      new PacketWriter().packedGuid(SELF).u32(9).u8(1).f32(11).toUint8Array());
    const ack = new PacketReader(sentOf(env.connection, OPCODES.CMSG_FORCE_RUN_SPEED_CHANGE_ACK).at(-1).payload);
    assert.equal(ack.packedGuid(), SELF);
    assert.equal(ack.u32(), 9);
    const info = readMovementInfo(ack);
    assert.equal(ack.f32(), Math.fround(11));
    assert.equal(ack.remaining, 0);
    assert.equal(info.flags & MOVEMENT_FLAGS.onTransport, MOVEMENT_FLAGS.onTransport, "the flag");
    assert.equal(info.transport?.guid, SHIP, "and the block with it");
    assert.ok(near(info.transport.x, -4) && near(info.transport.y, 2), "the offset");
    assertWorldPosition(info, env.shipPose());
  } finally {
    teardown(env.client);
  }
});

test("walking on the deck is walking in the ship's frame; a mouse turn sticks; a jump stays aboard", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: Math.PI / 2 };
  const env = await rideWorld({ pose, offset: { x: -5, y: 0, z: DECK_Z }, velocity: { x: 4, y: 0 } });
  try {
    env.frame();
    beginHeld("moveForward");
    for (let frame = 0; frame < 30; frame++) env.frame();
    endHeld("moveForward");
    const seat = env.self().transport;
    assert.ok(seat.x > -5 + 3 && near(seat.y, 0, 1e-3), `forward along the ship's own x: ${seat.x}, ${seat.y}`);
    assert.ok(near(seat.z, DECK_Z), "on the deck");

    // The right-button drag turns the character between frames; the carry must not undo it.
    assert.equal(turnCharacterBy(0.75), true);
    env.frame();
    env.frame();
    assert.ok(near(env.self().transport.orientation, 0.75), "the facing relative to the ship turned");
    assert.ok(near(env.self().position.orientation, Math.PI / 2 + 0.75), "and the world facing with it");

    beginHeld("jump");
    env.frame();
    endHeld("jump");
    const jump = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_JUMP).at(-1).payload);
    assert.equal(jump.flags & MOVEMENT_FLAGS.onTransport, MOVEMENT_FLAGS.onTransport, "the jump is told with the block");
    assert.equal(jump.flags & MOVEMENT_FLAGS.falling, MOVEMENT_FLAGS.falling);
    let frames = 0;
    while (sentOf(env.connection, OPCODES.MSG_MOVE_FALL_LAND).length === 0 && frames < 120) {
      env.frame();
      frames++;
      assert.equal(currentRide()?.guid, SHIP, `aboard through the jump (frame ${frames})`);
    }
    const land = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_FALL_LAND).at(-1).payload);
    assert.equal(land.transport?.guid, SHIP, "landed on the deck it left");
    assert.ok(near(land.transport.z, DECK_Z));
    assertWorldPosition(land, env.shipPose());
  } finally {
    teardown(env.client);
  }
});

test("stepping off onto a pier ends the ride at once, without a seam; later packets have no block", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: 0 };
  // The pier begins where the deck ends, at the deck's own height.
  const env = await rideWorld({ pose, offset: { x: 10, y: 0, z: DECK_Z }, pier: 100 + DECK_HALF_X + 0.01 });
  try {
    env.frame();
    assert.equal(currentRide()?.guid, SHIP);
    beginHeld("moveForward");
    let offDeckFrames = 0;
    let previous = { ...env.self().position };
    for (let frame = 0; frame < 120 && currentRide() !== undefined; frame++) {
      env.frame();
      const at = env.self().position;
      assert.ok(Math.hypot(at.x - previous.x, at.y - previous.y, at.z - previous.z) < 0.5, "no jump in the world position");
      previous = { ...at };
      if (at.x > 100 + DECK_HALF_X) offDeckFrames++;
    }
    assert.equal(currentRide(), undefined, "off the ship");
    assert.ok(offDeckFrames <= 1, `the pier is taken at once, not after ${RIDE_LEAVE_FRAMES} frames (${offDeckFrames})`);
    assert.equal(env.self().transport, undefined, "no seat left on the character");
    const leaving = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_HEARTBEAT).at(-1).payload);
    assert.equal(leaving.flags & MOVEMENT_FLAGS.onTransport, 0, "the packet that leaves has no flag");
    assert.equal(leaving.transport, undefined, "and no block");
    for (let frame = 0; frame < 10; frame++) env.frame();
    endHeld("moveForward");
    const stop = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_STOP).at(-1).payload);
    assert.equal(stop.flags & MOVEMENT_FLAGS.onTransport, 0);
    assert.equal(stop.transport, undefined);
    assert.ok(near(env.self().position.z, pose.z + DECK_Z), "standing on the pier");
    assert.equal(currentRide(), undefined, "and not boarded again from the pier");
  } finally {
    teardown(env.client);
  }
});

test("walking over the rail: the ride ends after the leave frames and the fall goes on in the world", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: 0 };
  const env = await rideWorld({ pose, offset: { x: 12, y: 0, z: DECK_Z } });
  try {
    env.frame();
    beginHeld("moveForward");
    let ridingOffDeck = 0;
    for (let frame = 0; frame < 120 && currentRide() !== undefined; frame++) {
      env.frame();
      if (env.self().position.x > 100 + DECK_HALF_X) ridingOffDeck++;
    }
    endHeld("moveForward");
    assert.equal(currentRide(), undefined);
    assert.ok(ridingOffDeck >= RIDE_LEAVE_FRAMES - 1 && ridingOffDeck <= RIDE_LEAVE_FRAMES,
      `${ridingOffDeck} frames over the rail before the ride ended`);
    const z = env.self().position.z;
    for (let frame = 0; frame < 10; frame++) env.frame();
    assert.ok(env.self().position.z < z, "still falling, now in the world");
    const packet = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_STOP).at(-1).payload);
    assert.equal(packet.transport, undefined);
  } finally {
    teardown(env.client);
  }
});

test("a packet that only knows the flags (faceTarget) is completed with the seat, its facing taken relative to the ship", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: 1 };
  const env = await rideWorld({ pose, offset: { x: 2, y: 2, z: DECK_Z } });
  try {
    env.frame();
    const self = env.self();
    env.client.sendMovement(OPCODES.MSG_MOVE_SET_FACING, self.movementFlags, { ...self.position, orientation: 2.5 });
    const packet = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_SET_FACING).at(-1).payload);
    assert.equal(packet.transport?.guid, SHIP, "never the flag with an empty block");
    assert.ok(near(packet.transport.orientation, 1.5), "facing relative to the ship");
    assert.ok(near(packet.transport.x, 2) && near(packet.transport.y, 2));
    env.frame();
    assert.ok(near(env.self().position.orientation, 2.5), "the new facing survives the next carry");
  } finally {
    teardown(env.client);
  }
});

// Review A3: what the running gateway (no /vmap/gobject-models, 404) does to a character the server
// put on a ship (a CREATE seat after logging in aboard or a teleport onto a deck).
test("a server seat on a ship whose deck never arrives: the ride waits LOAD_WAIT_MAX, then ends once and the world takes over", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: 0.5 };
  const env = await rideWorld({ pose, offset: { x: 3, y: 1, z: DECK_Z } });
  try {
    // The deck is "still loading" forever: the gateway has no route for it.
    setRideCarriers({ forObject: () => undefined, retain() {}, clear() {} });
    env.self().transport = { guid: SHIP, x: 3, y: 1, z: DECK_Z, orientation: 0, seat: SHIP_SEAT };
    const before = env.connection.sent.length;
    env.frame();
    assert.equal(currentRide()?.guid, SHIP, "the seat is kept while the deck may still come");
    for (let frame = 0; frame < Math.ceil((LOAD_WAIT_MAX / 1000) * 60) + 2; frame++) env.frame();
    assert.equal(currentRide(), undefined, "no deck after the wait: no ride");
    assert.equal(env.self().transport, undefined, "the seat is dropped");
    const sent = env.connection.sent.slice(before).filter((packet) => packet.opcode === OPCODES.MSG_MOVE_HEARTBEAT);
    // The leave, and in the same frame the world's fall that starts under the feet.
    assert.ok(sent.length >= 1 && sent.length <= 2, `the leave is told (${sent.length})`);
    for (const packet of sent) assert.equal(parseMovementPacket(packet.payload).flags & MOVEMENT_FLAGS.onTransport, 0, "without the flag");
    const z = env.self().position.z;
    for (let frame = 0; frame < 10; frame++) env.frame();
    assert.ok(env.self().position.z < z, "the world's physics: nothing under the feet, a fall");
    beginHeld("moveForward");
    env.frame();
    endHeld("moveForward");
    const moves = new Set([OPCODES.MSG_MOVE_HEARTBEAT, OPCODES.MSG_MOVE_START_FORWARD, OPCODES.MSG_MOVE_STOP,
      OPCODES.MSG_MOVE_FALL_LAND, OPCODES.MSG_MOVE_JUMP, OPCODES.MSG_MOVE_START_SWIM]);
    const after = env.connection.sent.slice(before).filter((packet) => moves.has(packet.opcode));
    assert.ok(after.length >= 2, "the fall and the key went out");
    for (const packet of after) {
      assert.equal(parseMovementPacket(packet.payload).flags & MOVEMENT_FLAGS.onTransport, 0, "no packet carries the flag");
    }
  } finally {
    teardown(env.client);
  }
});

test("no ship under a seat (a vehicle's, stale): no ride, no flag, idle stays quiet — the packet clears the seat as before", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: 0 };
  // Ground at the seat's height everywhere: the character stands still on land.
  const env = await rideWorld({ pose, offset: { x: 3, y: 1, z: DECK_Z }, pier: -1e9 });
  try {
    const carrier = env.client.state.objects.get(SHIP);
    carrier.typeId = 3;
    env.self().transport = { guid: SHIP, x: 3, y: 1, z: DECK_Z, orientation: 0, seat: 0 };
    const before = env.connection.sent.length;
    for (let frame = 0; frame < 5; frame++) env.frame();
    assert.equal(currentRide(), undefined);
    assert.equal(isMoving(), false, "no heartbeat cadence for a seat that is not a ride");
    // 11.02-A: a seat in a unit in view is a vehicle seat: the passenger sends nothing of its own
    // (its MSG_MOVE_* would overwrite the seat, MovementHandler.cpp:378) and keeps the seat.
    const quiet = env.connection.sent.length;
    beginHeld("moveForward");
    env.frame();
    endHeld("moveForward");
    assert.equal(env.connection.sent.length, quiet, "nothing from a vehicle seat");
    assert.equal(env.self().transport?.guid, SHIP);
    // Stale: the carrier gone from view — the packet without the block takes the seat off, as before.
    env.client.state.objects.delete(SHIP);
    beginHeld("moveForward");
    env.frame();
    endHeld("moveForward");
    const forward = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_START_FORWARD).at(-1).payload);
    assert.equal(forward.flags & MOVEMENT_FLAGS.onTransport, 0);
    assert.equal(forward.transport, undefined);
    assert.equal(env.self().transport, undefined, "our packet without the block takes the seat off, as before A3");
    assert.ok(env.connection.sent.length > before);
  } finally {
    teardown(env.client);
  }
});

test("the ship leaves view under a rider: the ride ends and the next packet goes without the block", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: 0 };
  const env = await rideWorld({ pose, offset: { x: 3, y: 1, z: DECK_Z } });
  try {
    env.frame();
    assert.equal(currentRide()?.guid, SHIP);
    env.client.state.destroy(SHIP);
    env.frame();
    assert.equal(currentRide(), undefined, "no ship, no ride");
    assert.equal(env.self().transport, undefined);
    const packet = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_HEARTBEAT).at(-1).payload);
    assert.equal(packet.flags & MOVEMENT_FLAGS.onTransport, 0, "the leave is told");
    beginHeld("moveForward");
    env.frame();
    endHeld("moveForward");
    const forward = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_START_FORWARD).at(-1).payload);
    assert.equal(forward.transport, undefined, "a frozen offset is never sent for a ship that is gone");
  } finally {
    teardown(env.client);
  }
});

test("a knock back on a deck goes the world's way: its direction is turned into the ship's frame", async () => {
  const pose = { x: 100, y: 200, z: 10, orientation: Math.PI / 2 };
  const env = await rideWorld({ pose, offset: { x: 0, y: 0, z: DECK_Z } });
  try {
    env.frame();
    const before = { ...env.self().position };
    // Away along world +x, which on this ship is its own −y.
    applyKnockback({ cos: 1, sin: 0, speedXY: 6, upSpeed: 4 });
    for (let frame = 0; frame < 10; frame++) env.frame();
    const at = env.self().position;
    assert.equal(currentRide()?.guid, SHIP, "still aboard, over the deck");
    assert.ok(at.x - before.x > 0.5, `pushed along world +x (${at.x - before.x})`);
    assert.ok(Math.abs(at.y - before.y) < 0.05, `not along world y (${at.y - before.y})`);
  } finally {
    teardown(env.client);
  }
});
