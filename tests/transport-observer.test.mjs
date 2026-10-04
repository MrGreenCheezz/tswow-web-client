import assert from "node:assert/strict";
import test from "node:test";

// 11.01 slices D and E: passengers seen by a bystander. The server sends a ship's position once,
// in its create block, and never again (`Transport::UpdatePosition` has no network output); its
// passengers are relocated server-side with no packet either (`UpdatePassengerPositions`,
// Transport.cpp:693-747). What lasts is the offset: a relayed `MSG_MOVE_*` carries it in the
// transport block, a game object's create block in `UPDATEFLAG_POSITION` (Object.cpp:347-380:
// transport packed guid, world xyz, offset xyz, world o, f32 0). A passenger is therefore wherever
// the ship's pose of this frame puts its offset, every frame — the composition of
// `TransportBase::CalculatePassengerPosition` (VehicleDefines.h:140-149): rotate by the ship's yaw,
// translate, add the facings.
import { PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { MOVEMENT_FLAGS, writeMovementInfoBody } from "../dist/code/world/MovementProtocol.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { gameObjectTilt, packRotation } from "../dist/code/world/GameObjectRotation.js";
import { NO_SEAT, passengerGameObjectTilt } from "../dist/code/world/TransportPassengers.js";

const SELF = 0x1234n;
const OTHER = 0x5678n;
const SHIP = 0x1fc0_0000_0000_0007n;
const CHAIR = 0xf110_0000_0000_0042n;
const TWO_PI = Math.PI * 2;

function compose(pose, offset) {
  const cos = Math.cos(pose.orientation);
  const sin = Math.sin(pose.orientation);
  return {
    x: pose.x + offset.x * cos - offset.y * sin,
    y: pose.y + offset.x * sin + offset.y * cos,
    z: pose.z + offset.z,
    orientation: (((pose.orientation + offset.orientation) % TWO_PI) + TWO_PI) % TWO_PI,
  };
}

/** The drawn position back in the ship's frame. */
function local(pose, world) {
  const cos = Math.cos(pose.orientation);
  const sin = Math.sin(pose.orientation);
  const dx = world.x - pose.x;
  const dy = world.y - pose.y;
  return { x: dx * cos + dy * sin, y: dy * cos - dx * sin, z: world.z - pose.z };
}

const angleGap = (a, b) => Math.abs(((((a - b) % TWO_PI) + 3 * Math.PI) % TWO_PI) - Math.PI);

function assertAt(actual, expected, label, tolerance = 1e-3) {
  for (const axis of ["x", "y", "z"]) {
    assert.ok(Math.abs(actual[axis] - expected[axis]) <= tolerance,
      `${label}: ${axis} ${actual[axis]} vs ${expected[axis]}`);
  }
  assert.ok(angleGap(actual.orientation, expected.orientation) <= tolerance,
    `${label}: orientation ${actual.orientation} vs ${expected.orientation}`);
}

/** A ship sailing and turning: 20 yards a second along a slanted line, a tenth of a radian a second. */
function shipPoseAt(seconds) {
  return { x: 100 + 20 * seconds, y: 200 + 6 * seconds, z: 10, orientation: 0.5 + 0.1 * seconds };
}

/** A WorldClient whose state has the ship, moved every frame by a pose provider on a test clock. */
async function observerWorld() {
  // One clock for the packets' arrival (`WorldState.move` reads performance.now()) and the frames.
  const clock = { seconds: 0, get ms() { return 1000 + this.seconds * 1000; } };
  performance.now = () => clock.ms;
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
  client.state.move(SHIP, { flags: 0, position: shipPoseAt(0) });
  const ship = client.state.objects.get(SHIP);
  ship.typeId = 5;
  ship.fields.set(UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 15 << 8);
  client.state.poseProvider = (state) => {
    const position = state.objects.get(SHIP)?.position;
    if (position) Object.assign(position, shipPoseAt(clock.seconds));
  };
  const frame = (seconds = 1 / 60) => {
    clock.seconds += seconds;
    client.state.updateMotions(clock.ms);
  };
  const close = () => {
    client.close();
    delete performance.now;
  };
  return { client, deliver, frame, clock, close };
}

/** What the core relays of a passenger's packet: packed guid and its MovementInfo, block included. */
function relayed(guid, seat, world, time) {
  const writer = new PacketWriter().packedGuid(guid);
  writeMovementInfoBody(writer, {
    flags: MOVEMENT_FLAGS.onTransport | MOVEMENT_FLAGS.forward, flags2: 0, time, position: world,
    transport: { guid: SHIP, x: seat.x, y: seat.y, z: seat.z, orientation: seat.orientation, time, seat: NO_SEAT },
    fallTime: 0,
  });
  return writer.toUint8Array();
}

// ---------------------------------------------------------------------------------------------
// E: a relayed passenger.

test("observer: a relayed passenger stands on its offset on the ship's pose of every frame, while the ship sails and turns", async () => {
  const env = await observerWorld();
  try {
    const seat = { x: 3, y: -1.5, z: 2, orientation: 0.4 };
    // The packet was written a moment ago: its world position is the ship's pose of then.
    const written = compose(shipPoseAt(env.clock.seconds), seat);
    await env.deliver(OPCODES.MSG_MOVE_HEARTBEAT, relayed(OTHER, seat, written, 1000));
    const other = () => env.client.state.objects.get(OTHER);
    assert.equal(other().transport?.guid, SHIP, "the block is kept");
    const start = { ...shipPoseAt(env.clock.seconds) };
    for (let frame = 0; frame < 120; frame++) {
      env.frame();
      assertAt(other().position, compose(shipPoseAt(env.clock.seconds), seat), `frame ${frame}`);
    }
    // A static carrier (the pose of the packet) would be this far off by now: the check above bites.
    const sailed = Math.hypot(shipPoseAt(env.clock.seconds).x - start.x, shipPoseAt(env.clock.seconds).y - start.y);
    assert.ok(sailed > 30, `the ship sailed ${sailed} yards`);
    assert.equal(other().drift, undefined, "no world extrapolation for a passenger");
  } finally {
    env.close();
  }
});

test("observer: a step on the deck glides in the ship's frame — never off the line between the two offsets — and lands on the new one", async () => {
  const env = await observerWorld();
  try {
    const from = { x: 3, y: -1.5, z: 2, orientation: 0.4 };
    await env.deliver(OPCODES.MSG_MOVE_HEARTBEAT, relayed(OTHER, from, compose(shipPoseAt(env.clock.seconds), from), 1000));
    for (let frame = 0; frame < 30; frame++) env.frame();
    // Two yards forward on the deck, the packet written on the pose of now.
    const to = { x: 5, y: -1.5, z: 2, orientation: 0.4 };
    await env.deliver(OPCODES.MSG_MOVE_HEARTBEAT, relayed(OTHER, to, compose(shipPoseAt(env.clock.seconds), to), 1500));
    const other = () => env.client.state.objects.get(OTHER);
    let last = -1;
    let gliding = 0;
    for (let frame = 0; frame < 30; frame++) {
      env.frame();
      const pose = shipPoseAt(env.clock.seconds);
      const at = local(pose, other().position);
      // On the segment from → to in the ship's frame, moving forward along it.
      assert.ok(Math.abs(at.y - from.y) < 1e-3 && Math.abs(at.z - from.z) < 1e-3, `frame ${frame}: off the line ${JSON.stringify(at)}`);
      const t = (at.x - from.x) / (to.x - from.x);
      assert.ok(t >= last - 1e-6 && t <= 1 + 1e-6, `frame ${frame}: progress ${t} after ${last}`);
      if (t < 1 - 1e-6) gliding++;
      last = t;
    }
    assert.ok(gliding >= 5, `it glides (${gliding} frames), it does not jump`);
    assertAt(other().position, compose(shipPoseAt(env.clock.seconds), to), "landed on the new offset");
  } finally {
    env.close();
  }
});

test("observer: the packet that takes a passenger off the ship ends the carry and the glide on the deck", async () => {
  const env = await observerWorld();
  try {
    const seat = { x: 3, y: -1.5, z: 2, orientation: 0.4 };
    await env.deliver(OPCODES.MSG_MOVE_HEARTBEAT, relayed(OTHER, seat, compose(shipPoseAt(0), seat), 1000));
    env.frame();
    const pier = { x: 500, y: 500, z: 12, orientation: 1 };
    const writer = new PacketWriter().packedGuid(OTHER);
    writeMovementInfoBody(writer, { flags: 0, flags2: 0, time: 1100, position: pier, fallTime: 0 });
    await env.deliver(OPCODES.MSG_MOVE_HEARTBEAT, writer.toUint8Array());
    for (let frame = 0; frame < 30; frame++) env.frame();
    const other = env.client.state.objects.get(OTHER);
    assert.equal(other.transport, undefined);
    assertAt(other.position, pier, "stays where the packet put it while the ship sails on");
  } finally {
    env.close();
  }
});

// Review C/D/E: the ship's-frame glide is for ships only. A lift (type 11) keeps no server-side
// passengers, yet the core relays a stock client's `ONTRANSPORT` on one (MovementHandler.cpp:340-345)
// with an offset this client cannot place (the lift's state position is its spawn, not the car); a
// vehicle seat is 11.02's. Both glide between the packet's world points exactly as before 11.01-E.
test("observer: a relayed packet on a lift or in a vehicle seat glides between world points as before", () => {
  const cases = [
    { name: "lift", guid: 0xf110_0000_0000_00aan, typeId: 5, bytes1: 11 << 8 },
    { name: "vehicle", guid: 0xf150_0000_0000_0009n, typeId: 3, bytes1: 0 },
  ];
  for (const carrierCase of cases) {
    const state = new WorldState();
    state.move(carrierCase.guid, { flags: 0, position: { x: 10, y: 20, z: 30, orientation: 0.3 } }, 0);
    const carrier = state.objects.get(carrierCase.guid);
    carrier.typeId = carrierCase.typeId;
    if (carrierCase.bytes1) carrier.fields.set(UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, carrierCase.bytes1);
    const before = { x: 10, y: 21, z: 80, orientation: 1 };
    state.move(OTHER, { flags: 0, position: before }, 0);
    // The packet's world point: where the rider really is (the lift car is 50 yards above its spawn).
    const target = { x: 12, y: 21, z: 82, orientation: 1 };
    const seat = { x: 2, y: 1, z: 52, orientation: 0.7 };
    state.move(OTHER, {
      flags: MOVEMENT_FLAGS.onTransport, position: target,
      transport: { guid: carrierCase.guid, ...seat, time: 0, seat: carrierCase.name === "lift" ? NO_SEAT : 0 },
    }, 1000);
    const other = state.objects.get(OTHER);
    assert.equal(other.transport?.guid, carrierCase.guid, `${carrierCase.name}: the block is kept`);
    assert.ok(other.glide !== undefined, `${carrierCase.name}: the world glide of before`);
    state.updateMotions(1090);
    assertAt(other.position, {
      x: (before.x + target.x) / 2, y: (before.y + target.y) / 2, z: (before.z + target.z) / 2, orientation: 1,
    }, `${carrierCase.name}: half way between the world points`);
  }
});

// ---------------------------------------------------------------------------------------------
// D: a game object created aboard.

function f32bits(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

function values(writer, fields) {
  const words = fields.size === 0 ? 0 : Math.floor(Math.max(...fields.keys()) / 32) + 1;
  writer.u8(words);
  const masks = new Array(words).fill(0);
  for (const index of fields.keys()) masks[index >> 5] |= 1 << (index & 31);
  for (const mask of masks) writer.u32(mask >>> 0);
  for (const index of [...fields.keys()].sort((a, b) => a - b)) writer.u32(fields.get(index));
}

/** A ship's create block: TRANSPORT|LOWGUID|STATIONARY|ROTATION (Transport.cpp:40). */
function shipCreateBlock(writer, pose, progress) {
  writer.u8(2).packedGuid(SHIP).u8(5).u16(0x0252);
  writer.f32(pose.x).f32(pose.y).f32(pose.z).f32(pose.orientation);
  writer.u32(7).u32(progress).i64(0n);
  values(writer, new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 176310],
    [UPDATE_FIELDS.OBJECT_FIELD_SCALE_X.offset, f32bits(1)],
    [UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 15 << 8],
  ]));
}

/**
 * A game object's create block with `UPDATEFLAG_POSITION` (GameObject.cpp:124): the transport's
 * packed guid, the world position, the offset, the world orientation, `f32 0`; LOWGUID; ROTATION.
 */
function passengerCreateBlock(writer, world, offset, rotation) {
  writer.u8(2).packedGuid(CHAIR).u8(5).u16(0x0350);
  writer.packedGuid(SHIP);
  writer.f32(world.x).f32(world.y).f32(world.z);
  writer.f32(offset.x).f32(offset.y).f32(offset.z);
  writer.f32(world.orientation).f32(0);
  writer.u32(0x42).i64(packRotation(rotation));
  values(writer, new Map([[UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 7 << 8]]));
}

const yaw = (angle) => ({ x: 0, y: 0, z: Math.sin(angle / 2), w: Math.cos(angle / 2) });

test("a game object created aboard keeps the transport, its offset and its facing relative to the ship, and is carried", () => {
  const state = new WorldState();
  const pose = { x: 1000, y: -400, z: 5, orientation: 1.25 };
  const seat = { x: -7.5, y: 2.25, z: 6, orientation: 0.75 };
  const world = compose(pose, seat);
  const packet = new PacketWriter().u32(2);
  shipCreateBlock(packet, pose, 5000);
  passengerCreateBlock(packet, world, seat, yaw(seat.orientation));
  state.applyUpdate(packet.toUint8Array(), 0);
  const chair = state.objects.get(CHAIR);
  assert.equal(chair.transport?.guid, SHIP);
  assert.ok(Math.abs(chair.transport.x - seat.x) < 1e-4 && Math.abs(chair.transport.y - seat.y) < 1e-4
    && Math.abs(chair.transport.z - seat.z) < 1e-4, "the offset, not the world position");
  assert.ok(angleGap(chair.transport.orientation, seat.orientation) < 1e-4, "world − ship facing");
  assert.equal(chair.transport.seat, NO_SEAT);
  assert.equal(chair.positionTransport?.guid, SHIP, "the raw block stays as it was");
  assertAt(chair.position, world, "drawn at the block's world position", 1e-3);

  // The ship sails on and turns; nothing is sent; the chair goes with it.
  let seconds = 0;
  state.poseProvider = (s) => Object.assign(s.objects.get(SHIP).position, {
    x: pose.x + 9 * seconds, y: pose.y - 4 * seconds, z: pose.z, orientation: pose.orientation + 0.2 * seconds,
  });
  for (let frame = 0; frame < 90; frame++) {
    seconds += 1 / 30;
    state.updateMotions(seconds * 1000);
    assertAt(chair.position, compose(state.objects.get(SHIP).position, seat), `frame ${frame}`);
  }
});

test("a game object created aboard a ship not in view stays where its block put it", () => {
  const state = new WorldState();
  const world = { x: 50, y: 60, z: 7, orientation: 2 };
  const packet = new PacketWriter().u32(1);
  passengerCreateBlock(packet, world, { x: 1, y: 2, z: 3 }, yaw(2));
  state.applyUpdate(packet.toUint8Array(), 0);
  const chair = state.objects.get(CHAIR);
  assert.equal(chair.transport, undefined, "no carrier, no facing to measure against");
  assert.equal(chair.positionTransport?.guid, SHIP);
  state.updateMotions(1000);
  assertAt(chair.position, world, "untouched");
});

// The renderer turns a game object by its world facing, then by `gameObjectTilt`. A passenger's
// local rotation is the spawn's in the ship's frame.
const qmul = (a, b) => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
});
function rotate(q, v) {
  const p = qmul(qmul(q, { x: v[0], y: v[1], z: v[2], w: 0 }), { x: -q.x, y: -q.y, z: -q.z, w: q.w });
  return [p.x, p.y, p.z];
}

test("a passenger's rotation is drawn in the ship's frame: a level one by its world facing alone, a leaning one leans with the ship", () => {
  const heading = 2.1;
  const facing = 0.6;
  const level = { rotation: yaw(facing), fields: new Map(), transport: { guid: SHIP, x: 0, y: 0, z: 0, orientation: facing, seat: NO_SEAT } };
  const tilt = { x: 0, y: 0, z: 0, w: 1 };
  assert.equal(gameObjectTilt(level, heading + facing, tilt), true, "measured against the world facing it reads as a turn");
  assert.equal(passengerGameObjectTilt(level, heading + facing, tilt), false, "aboard: no tilt, the world facing is the whole rotation");

  // A lean about the ship's own x, on a seat facing 0.6.
  const lean = { x: Math.sin(0.2), y: 0, z: 0, w: Math.cos(0.2) };
  const leaning = { ...level, rotation: qmul(lean, yaw(facing)) };
  assert.equal(passengerGameObjectTilt(leaning, heading + facing, tilt), true);
  const drawn = qmul(tilt, yaw(heading + facing));
  const truth = qmul(yaw(heading), leaning.rotation);
  for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 2, 3]]) {
    const a = rotate(drawn, v);
    const b = rotate(truth, v);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-5, `${v}: ${a} vs ${b}`);
  }
  // Off a transport it is the plain tilt.
  const ashore = { rotation: qmul(lean, yaw(facing)), fields: new Map(), transport: undefined };
  const plain = { x: 0, y: 0, z: 0, w: 1 };
  assert.equal(gameObjectTilt(ashore, facing, plain), passengerGameObjectTilt(ashore, facing, tilt));
  assert.deepEqual([tilt.x, tilt.y, tilt.z, tilt.w], [plain.x, plain.y, plain.z, plain.w]);
});
