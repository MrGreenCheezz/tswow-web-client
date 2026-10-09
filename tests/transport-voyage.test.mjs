import assert from "node:assert/strict";
import test from "node:test";

// 11.01 slice C: the voyage goes on across the map change. TrinityCore's facts this pins:
// - a ship reaching its teleport frame onto another map takes its players with
//   `TeleportTo(…, TELE_TO_NOT_LEAVE_TRANSPORT)` (Transport.cpp:651-690), which keeps
//   `MOVEMENTFLAG_ONTRANSPORT` (Player.cpp:1735-1741) and sends `SMSG_TRANSFER_PENDING(map, entry,
//   old map)` and `SMSG_NEW_WORLD` with the deck offset, not a world position (Player.cpp:1875-1907);
// - after `MSG_MOVE_WORLDPORT_ACK` the player is relocated to the composed world position
//   (MovementHandler.cpp HandleMoveWorldportAck) and `Map::AddPlayerToMap` → `SendInitSelf` sends the
//   ship's create block and then the player's, the latter with `ONTRANSPORT` and the same offset
//   (Map.cpp:603-635, 3045-3080); the ship's guid is global and its `PathProgress` is the core's;
// - a teleport frame on the same map sends every passenger `MSG_MOVE_TELEPORT_ACK` with the old
//   offset (Transport.cpp:628-643, Unit::SendTeleportPacket with teleportingTransport);
// - any movement packet without `ONTRANSPORT` takes the player off (MovementHandler.cpp:347-351).
import { PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { MOVEMENT_FLAGS, parseMovementPacket, writeMovementInfoBody } from "../dist/code/world/MovementProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { decodeCollisionModel, encodeCollisionModel } from "../dist/code/world/CollisionFormat.js";
import { game } from "../dist/code/browser/game/Context.js";
import {
  advancePhysics, beginHeld, endHeld, forgetMovementState, reissueHeldMovement, releaseAllInput, resetCharacterMotion,
  sendMovement, syncMovement,
} from "../dist/code/browser/input/Movement.js";
import { currentRide, setRideCarriers } from "../dist/code/browser/input/MovementRide.js";
import { TransportCollision } from "../dist/code/browser/game/TransportCollision.js";
import { SHIP_SEAT } from "../dist/code/browser/game/TransportRide.js";
import { LOAD_WAIT_MAX } from "../dist/code/browser/game/Physics.js";
import { handleSameMapTeleport } from "../dist/code/browser/game/TeleportEffects.js";
import { SHIP_OFF_MAP_WARN_MS, SHIP_SAMPLE_CUT, ShipMotion } from "../dist/code/browser/TransportMotion.js";

const SELF = 0x1234n;
const SHIP = 0x1fc0_0000_0000_0007n;
const ENTRY = 176310;
const DISPLAY = 3015;
const DECK_Z = 2;
const DECK_HALF_X = 15;
const SEA_FLOOR = -50;
const OFFSET = { x: 3, y: 1, z: DECK_Z };
const PERIOD = 20_000;
const STEP = 100;
const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------------------------
// Fixtures.

/**
 * A two-continent timetable: the first half on map 0 along +x from (1000, 500) facing 0, a jump,
 * the second half on map 1 along +y from (−3000, −800) facing π/2. 5 yards a second.
 */
function twoMapTrack() {
  const samples = PERIOD / STEP;
  const track = { path: 1, speed: 5, accel: 1, period: PERIOD, step: STEP, map: [], x: [], y: [], z: [], o: [], flags: [] };
  for (let i = 0; i < samples; i++) {
    const second = i < samples / 2;
    const t = (second ? i : i - samples / 2) * STEP / 1000;
    track.map.push(second ? 0 : 1);
    track.x.push(second ? 1000 + 5 * t : -3000);
    track.y.push(second ? 500 : -800 + 5 * t);
    track.z.push(0);
    track.o.push(second ? 0 : Math.PI / 2);
    track.flags.push(i === samples / 2 - 1 || i === samples - 1 ? SHIP_SAMPLE_CUT : 0);
  }
  return track;
}

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

function compose(pose, offset) {
  const cos = Math.cos(pose.orientation);
  const sin = Math.sin(pose.orientation);
  return {
    x: pose.x + offset.x * cos - offset.y * sin,
    y: pose.y + offset.x * sin + offset.y * cos,
    z: pose.z + offset.z,
    orientation: ((pose.orientation + (offset.orientation ?? 0)) % TWO_PI + TWO_PI) % TWO_PI,
  };
}

const near = (a, b, tolerance = 1e-2) => Math.abs(a - b) <= tolerance;
const sentOf = (connection, opcode) => connection.sent.filter((packet) => packet.opcode === opcode);
const MOVES = new Set([
  OPCODES.MSG_MOVE_HEARTBEAT, OPCODES.MSG_MOVE_START_FORWARD, OPCODES.MSG_MOVE_STOP, OPCODES.MSG_MOVE_FALL_LAND,
  OPCODES.MSG_MOVE_JUMP, OPCODES.MSG_MOVE_START_SWIM, OPCODES.MSG_MOVE_SET_FACING, OPCODES.MSG_MOVE_START_BACKWARD,
]);

function f32bits(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

function values(writer, fields) {
  const words = Math.floor(Math.max(...fields.keys()) / 32) + 1;
  writer.u8(words);
  const masks = new Array(words).fill(0);
  for (const index of fields.keys()) masks[index >> 5] |= 1 << (index & 31);
  for (const mask of masks) writer.u32(mask >>> 0);
  for (const index of [...fields.keys()].sort((a, b) => a - b)) writer.u32(fields.get(index));
}

/** The ship's create block: TRANSPORT|LOWGUID|STATIONARY|ROTATION (Transport.cpp:40), `PathProgress`. */
function shipCreate(writer, pose, progress) {
  writer.u8(2).packedGuid(SHIP).u8(5).u16(0x0252);
  writer.f32(pose.x).f32(pose.y).f32(pose.z).f32(pose.orientation);
  writer.u32(7).u32(progress).i64(0n);
  values(writer, new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, ENTRY],
    [UPDATE_FIELDS.OBJECT_FIELD_SCALE_X.offset, f32bits(1)],
    [UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset, DISPLAY],
    [UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 15 << 8],
    [UPDATE_FIELDS.GAMEOBJECT_LEVEL.offset, PERIOD],
  ]));
}

/** The player's own create block (LIVING|SELF) on the deck: `ONTRANSPORT`, world `pos`, the offset. */
function selfCreate(writer, world, offset) {
  writer.u8(2).packedGuid(SELF).u8(4).u16(0x21);
  writeMovementInfoBody(writer, {
    flags: MOVEMENT_FLAGS.onTransport, flags2: 0, time: 100, position: world,
    transport: { guid: SHIP, x: offset.x, y: offset.y, z: offset.z, orientation: offset.orientation ?? 0, time: 100, seat: SHIP_SEAT },
    fallTime: 0,
  });
  for (let index = 0; index < 9; index++) writer.f32(7);
  writer.u8(0);
}

/**
 * A logged-in WorldClient on map 0 with control, the ship created by its own block and sailed by
 * the real `ShipMotion` on the two-map timetable, the deck a `TransportCollision` whose model can be
 * taken away (`deck.online = false`, a reload). One clock for packets and frames.
 */
async function voyageWorld() {
  const clock = { ms: 10_000 };
  performance.now = () => clock.ms;
  const login = new PacketWriter().u32(0).f32(1000).f32(500).f32(0).f32(0).toUint8Array();
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

  const track = twoMapTrack();
  const logs = [];
  const motion = new ShipMotion({
    paths: { track: () => track },
    template: () => ({ type: 15, data: [1, 5, 1] }),
    mapId: () => client.mapId,
    log: (message) => logs.push(message),
  });
  client.state.poseProvider = (state, now) => motion.update(state, now);

  const model = deckModel();
  const deck = { online: true, revision: 0 };
  forgetMovementState();
  setRideCarriers(new TransportCollision({
    get revision() { return deck.revision; },
    model: (id) => (id !== DISPLAY ? null : deck.online ? model : undefined),
    requestGroups() {},
  }));
  game.world = client;
  game.worldLoading = false;
  game.terrain = { heightAt: () => SEA_FLOOR, liquidAt: () => undefined, isHole: () => false };

  /** One render frame as Loop.ts runs it: poses and carries, then the physics (paused under the curtain). */
  const frame = (seconds = 1 / 60) => {
    clock.ms += seconds * 1000;
    client.state.updateMotions(clock.ms);
    advancePhysics(seconds);
  };
  const self = () => client.state.objects.get(SELF);
  const shipPose = () => client.state.objects.get(SHIP)?.position;
  const close = () => {
    releaseAllInput();
    forgetMovementState();
    setRideCarriers(undefined);
    game.world = undefined;
    game.terrain = undefined;
    game.worldLoading = false;
    client.close();
    delete performance.now;
  };
  return { client, connection, deliver, frame, self, shipPose, deck, logs, clock, close };
}

/** The ship's create on map 0 and the character standing on its deck at OFFSET, boarded. */
async function aboard(env, progress = 5_000) {
  const packet = new PacketWriter().u32(1);
  shipCreate(packet, { x: 1000 + 5 * progress / 1000, y: 500, z: 0, orientation: 0 }, progress);
  await env.deliver(OPCODES.SMSG_UPDATE_OBJECT, packet.toUint8Array());
  env.frame();
  const pose = env.shipPose();
  env.client.state.move(SELF, { flags: 0, position: compose(pose, OFFSET) });
  env.frame();
  assert.equal(currentRide()?.guid, SHIP, "boarded on map 0");
}

function assertBlock(packet, pose, label) {
  assert.equal(packet.flags & MOVEMENT_FLAGS.onTransport, MOVEMENT_FLAGS.onTransport, `${label}: the flag`);
  assert.equal(packet.transport?.guid, SHIP, `${label}: the block`);
  assert.ok(near(packet.transport.x, OFFSET.x) && near(packet.transport.y, OFFSET.y) && near(packet.transport.z, OFFSET.z),
    `${label}: the offset ${packet.transport.x}, ${packet.transport.y}, ${packet.transport.z}`);
  const world = compose(pose, packet.transport);
  assert.ok(near(packet.position.x, world.x) && near(packet.position.y, world.y) && near(packet.position.z, world.z),
    `${label}: the world position ${JSON.stringify(packet.position)} vs ${JSON.stringify(world)}`);
}

// ---------------------------------------------------------------------------------------------

test("cross-map voyage: TRANSFER_PENDING → NEW_WORLD(offset) → WORLDPORT_ACK → CREATE(ship) → CREATE(self); the ride is back and every packet carries the block", async () => {
  const env = await voyageWorld();
  try {
    await aboard(env);
    // What EnterWorld does on a world change: the curtain, the keys and the character's motion reset.
    const arrivals = [];
    env.client.onWorldChanged = (mapId, position) => {
      arrivals.push({ mapId, position: position && { ...position } });
      game.worldLoading = true;
      releaseAllInput();
      resetCharacterMotion();
    };
    await env.deliver(OPCODES.SMSG_TRANSFER_PENDING, new PacketWriter().u32(1).u32(ENTRY).u32(0).toUint8Array());
    await env.deliver(OPCODES.SMSG_NEW_WORLD,
      new PacketWriter().u32(1).f32(OFFSET.x).f32(OFFSET.y).f32(OFFSET.z).f32(0).toUint8Array());
    assert.equal(sentOf(env.connection, OPCODES.MSG_MOVE_WORLDPORT_ACK).length, 1);
    assert.equal(env.client.mapId, 1);
    assert.equal(env.self().position, undefined, "NEW_WORLD's xyz is the offset: no false position");
    assert.equal(env.shipPose(), undefined, "the old map's objects are retired; the ship comes back by its create");
    // The deck's collision goes away for the reload, and the curtain stays up a long time.
    env.deck.online = false;
    env.deck.revision++;
    for (let frame = 0; frame < 5 * 60; frame++) env.frame();
    const before = env.connection.sent.length;

    // The core's SendInitSelf: the ship (its clock on the map-1 leg), then the player aboard.
    const progress = 12_000;
    const pose = { x: -3000, y: -800 + 5 * (progress - PERIOD / 2) / 1000, z: 0, orientation: Math.PI / 2 };
    const world = compose(pose, OFFSET);
    const packet = new PacketWriter().u32(2);
    shipCreate(packet, pose, progress);
    selfCreate(packet, world, OFFSET);
    await env.deliver(OPCODES.SMSG_UPDATE_OBJECT, packet.toUint8Array());
    assert.equal(arrivals.length, 2);
    assert.deepEqual(arrivals.map((arrival) => arrival.mapId), [1, 1]);
    assert.equal(arrivals[0].position, undefined);
    assert.ok(near(arrivals[1].position.x, world.x, 1e-3) && near(arrivals[1].position.y, world.y, 1e-3),
      "the arrival is the self create's world position");
    assert.equal(env.self().transport?.guid, SHIP, "the seat from the self create");

    // Still loading (terrain, collision, the deck): four more seconds. The ship sails on its new clock.
    // A key pressed under this curtain (the arrival's own `clearHeldKeys` has run) is sent when it lifts.
    beginHeld("moveForward");
    for (let frame = 0; frame < 4 * 60; frame++) env.frame();
    const sailing = env.shipPose();
    assert.ok(near(sailing.x, -3000, 1e-3) && near(sailing.y, pose.y + 5 * 4, 0.1) && near(sailing.orientation, Math.PI / 2, 1e-6),
      `the map-1 leg, from the create's PathProgress: ${JSON.stringify(sailing)}`);
    const carried = compose(sailing, OFFSET);
    assert.ok(near(env.self().position.x, carried.x) && near(env.self().position.y, carried.y), "carried under the curtain");
    assert.equal(env.connection.sent.slice(before).filter((p) => MOVES.has(p.opcode)).length, 0, "nothing sent under the curtain");

    // The curtain lifts (hideLoadingScreen): the held key goes out — aboard.
    game.worldLoading = false;
    syncMovement();
    const start = sentOf(env.connection, OPCODES.MSG_MOVE_START_FORWARD).at(-1);
    assert.ok(start && env.connection.sent.indexOf(start) >= before, "the key is told");
    assertBlock(parseMovementPacket(start.payload), env.shipPose(), "the first packet after the curtain");
    env.frame();
    // Let go before the walk reaches the rail of the test's small deck; the stop goes out aboard too.
    endHeld("moveForward");
    const stop = sentOf(env.connection, OPCODES.MSG_MOVE_STOP).at(-1);
    assert.ok(stop && env.connection.sent.indexOf(stop) >= before);
    assert.equal(parseMovementPacket(stop.payload).transport?.guid, SHIP, "the stop carries the block");

    // The deck is still reloading: the ride waits for it (a second and a half, under LOAD_WAIT_MAX).
    const waitFrames = Math.floor((LOAD_WAIT_MAX / 1000) * 60 / 2);
    for (let frame = 0; frame < waitFrames; frame++) {
      env.frame();
      assert.equal(currentRide()?.guid, SHIP, `the ride holds while the deck reloads (frame ${frame})`);
    }
    env.deck.online = true;
    env.deck.revision++;
    for (let frame = 0; frame < 60; frame++) env.frame();
    assert.equal(currentRide()?.guid, SHIP, "riding on the new map");
    assert.equal(env.self().transport?.guid, SHIP);
    sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    const heartbeat = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_HEARTBEAT).at(-1).payload);
    assert.equal(heartbeat.flags & MOVEMENT_FLAGS.onTransport, MOVEMENT_FLAGS.onTransport);
    assert.equal(heartbeat.transport?.guid, SHIP);
    const now = compose(env.shipPose(), heartbeat.transport);
    assert.ok(near(heartbeat.position.x, now.x) && near(heartbeat.position.y, now.y) && near(heartbeat.position.z, now.z),
      "the world position on the new map");
    for (const sent of env.connection.sent.slice(before)) {
      if (!MOVES.has(sent.opcode)) continue;
      assert.equal(parseMovementPacket(sent.payload).flags & MOVEMENT_FLAGS.onTransport, MOVEMENT_FLAGS.onTransport,
        `0x${sent.opcode.toString(16)} after the arrival carries the flag: the core never took the character off`);
    }
    assert.deepEqual(env.logs, [], "the clock and the server agree about the map");
  } finally {
    env.close();
  }
});

test("a path's teleport frame on the same map: MSG_MOVE_TELEPORT_ACK with the old offset keeps the ride, the re-issued key carries the block", async () => {
  const env = await voyageWorld();
  try {
    // A stand-in carrier whose pose the test sets: before and after the jump.
    let shipAt = { x: 1100, y: 500, z: 0, orientation: 0 };
    const packet = new PacketWriter().u32(1);
    shipCreate(packet, shipAt, 0);
    await env.deliver(OPCODES.SMSG_UPDATE_OBJECT, packet.toUint8Array());
    env.client.state.poseProvider = (state) => {
      const position = state.objects.get(SHIP)?.position;
      if (position) Object.assign(position, shipAt);
    };
    env.frame();
    env.client.state.move(SELF, { flags: 0, position: compose(shipAt, OFFSET) });
    env.frame();
    assert.equal(currentRide()?.guid, SHIP);
    beginHeld("moveForward");
    for (let frame = 0; frame < 10; frame++) env.frame();
    const seat = { ...env.self().transport };

    // The core teleports the ship 60 yards back to its first node and its passengers with it.
    env.client.onSameMapTeleport = (mapId, destination, origin) => handleSameMapTeleport({
      destinationReady: () => true,
      resetCharacterMotion,
      refreshCollision() {},
      reissueHeldMovement,
      spellVisualsWorldChanged() {},
      showLoadingScreen() { game.worldLoading = true; },
      clearHeldKeys() { releaseAllInput(); resetCharacterMotion(); },
      invalidateGroundCover() {},
      clearPortraitTargets() {},
      refreshUnitFrames() {},
      refreshMinimapZone() {},
    }, mapId, destination, origin);
    shipAt = { x: 1040, y: 500, z: 0, orientation: 0 };
    const destination = compose(shipAt, seat);
    const teleport = new PacketWriter().packedGuid(SELF).u32(0);
    writeMovementInfoBody(teleport, {
      flags: MOVEMENT_FLAGS.onTransport, flags2: 0, time: 200, position: destination,
      transport: { guid: SHIP, x: seat.x, y: seat.y, z: seat.z, orientation: seat.orientation, time: 200, seat: SHIP_SEAT },
      fallTime: 0,
    });
    const before = env.connection.sent.length;
    await env.deliver(OPCODES.MSG_MOVE_TELEPORT_ACK, teleport.toUint8Array());
    const after = env.connection.sent.slice(before);
    assert.equal(after[0]?.opcode, OPCODES.MSG_MOVE_TELEPORT_ACK, "the acknowledgement first");
    const reissued = after.find((sent) => sent.opcode === OPCODES.MSG_MOVE_START_FORWARD);
    assert.ok(reissued, "the held key is re-issued at once");
    const start = parseMovementPacket(reissued.payload);
    assert.equal(start.flags & MOVEMENT_FLAGS.onTransport, MOVEMENT_FLAGS.onTransport, "with the flag");
    assert.equal(start.transport?.guid, SHIP, "and the block: the core keeps the passenger");
    assert.ok(near(start.position.x, destination.x) && near(start.position.y, destination.y), "at the new world position");
    assert.equal(env.self().transport?.guid, SHIP, "the seat survives the packet");

    for (let frame = 0; frame < 30; frame++) env.frame();
    endHeld("moveForward");
    assert.equal(currentRide()?.guid, SHIP, "the ride goes on from the new position");
    const at = env.self().position;
    const local = env.self().transport;
    const expected = compose(shipAt, local);
    assert.ok(near(at.x, expected.x) && near(at.y, expected.y) && near(at.z, expected.z), "on the deck where it now is");
    assert.ok(local.x > seat.x + 1, "walked forward on the deck after the jump");
    for (const sent of env.connection.sent.slice(before)) {
      if (!MOVES.has(sent.opcode)) continue;
      assert.equal(parseMovementPacket(sent.payload).flags & MOVEMENT_FLAGS.onTransport, MOVEMENT_FLAGS.onTransport,
        `0x${sent.opcode.toString(16)} carries the flag`);
    }
  } finally {
    env.close();
  }
});

test("a ship whose clock disagrees with the server about the map is logged once, after the grace, and stays put", async () => {
  const env = await voyageWorld();
  try {
    // Created on map 0 at a PathProgress the timetable puts on map 1.
    const packet = new PacketWriter().u32(1);
    shipCreate(packet, { x: 1010, y: 500, z: 0, orientation: 0 }, 15_000);
    await env.deliver(OPCODES.SMSG_UPDATE_OBJECT, packet.toUint8Array());
    const frames = Math.ceil(SHIP_OFF_MAP_WARN_MS / (1000 / 60)) - 2;
    for (let frame = 0; frame < frames; frame++) env.frame();
    assert.deepEqual(env.logs, [], "a crossing's moment of disagreement is not news");
    for (let frame = 0; frame < 120; frame++) env.frame();
    assert.equal(env.logs.length, 1, "logged once");
    assert.match(env.logs[0], /map 1.*map 0/);
    assert.ok(near(env.shipPose().x, 1010, 1e-3), "where its create put it");
  } finally {
    env.close();
  }
});

test("between a reset and the next frame, only a seat the next frame would ride is told: a ship with no pose is not", async () => {
  const env = await voyageWorld();
  try {
    await aboard(env);
    resetCharacterMotion();
    assert.equal(currentRide(), undefined, "the ride's own state is gone until the next frame");
    sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    let packet = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_HEARTBEAT).at(-1).payload);
    assert.equal(packet.transport?.guid, SHIP, "a ship in view with a pose: the seat is told");
    // The same ship, but nothing says where it is: the next frame would end the ride, so this does not keep it.
    const ship = env.client.state.objects.get(SHIP);
    const pose = ship.position;
    ship.position = undefined;
    resetCharacterMotion();
    sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    packet = parseMovementPacket(sentOf(env.connection, OPCODES.MSG_MOVE_HEARTBEAT).at(-1).payload);
    assert.equal(packet.flags & MOVEMENT_FLAGS.onTransport, 0);
    assert.equal(packet.transport, undefined);
    ship.position = pose;
  } finally {
    env.close();
  }
});
