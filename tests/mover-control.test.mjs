import assert from "node:assert/strict";
import test from "node:test";
import { PacketReader, PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { MOVEMENT_FLAGS, MOVEMENT_MASK_MOVING, readMovementInfo } from "../dist/code/world/MovementProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

const SELF = 0x1234n;
const VEHICLE = 0xf150_7d9a_0000_0042n;
const OTHER = 0xf150_7d9a_0000_0099n;

/** A WorldClient over a fake connection, logged in as SELF, with a vehicle standing elsewhere. */
async function moverClient() {
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
  client.state.move(SELF, { flags: 0, position: { x: 10, y: 20, z: 30, orientation: 0 } });
  client.state.move(VEHICLE, { flags: 0, position: { x: 500, y: 600, z: 70, orientation: 1 } });
  await client.loginCharacter(SELF);
  await new Promise((resolve) => setImmediate(resolve));
  const deliver = async (opcode, payload) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ opcode, payload });
    else connection.packets.push({ opcode, payload });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { client, connection, deliver };
}

const control = (guid, allowed) => new PacketWriter().packedGuid(guid).u8(allowed ? 1 : 0).toUint8Array();
const sentOf = (connection, opcode) => connection.sent.filter((packet) => packet.opcode === opcode);

test("M7-0: control moves to the unit allowed, and only its own refusal takes it back", async () => {
  const { client, connection, deliver } = await moverClient();
  await deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, control(VEHICLE, true));
  assert.equal(client.controlledGuid, VEHICLE);
  const claim = new PacketReader(sentOf(connection, OPCODES.CMSG_SET_ACTIVE_MOVER).at(-1).payload);
  assert.equal(claim.u64(), VEHICLE, "the claim spells the guid in full");

  // A late refusal of some other unit must not take the vehicle away.
  await deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, control(OTHER, false));
  assert.equal(client.controlledGuid, VEHICLE);
  assert.equal(client.movementReady, true);
  const release = new PacketReader(sentOf(connection, OPCODES.CMSG_MOVE_NOT_ACTIVE_MOVER).at(-1).payload);
  assert.equal(release.packedGuid(), OTHER, "the release is read packed by the core");

  await deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, control(VEHICLE, false));
  assert.equal(client.controlledGuid, undefined);
  assert.equal(client.movementReady, false);
  client.close();
});

test("M7-0: a forced speed for the vehicle is the vehicle's, and its ACK carries the vehicle", async () => {
  const { client, connection, deliver } = await moverClient();
  await deliver(OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE,
    new PacketWriter().packedGuid(VEHICLE).u32(5).u8(1).f32(14).toUint8Array());
  assert.equal(client.speedsOf(VEHICLE).get("run"), Math.fround(14));
  assert.equal(client.speeds.get("run"), undefined, "the character's own rate is untouched");
  const ack = new PacketReader(sentOf(connection, OPCODES.CMSG_FORCE_RUN_SPEED_CHANGE_ACK).at(-1).payload);
  assert.equal(ack.packedGuid(), VEHICLE);
  assert.equal(ack.u32(), 5);
  const info = readMovementInfo(ack);
  assert.deepEqual([info.position.x, info.position.y, info.position.z], [500, 600, 70],
    "the vehicle's own position, not the character's");
  assert.equal(ack.f32(), Math.fround(14));
  assert.equal(ack.remaining, 0);

  await deliver(OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE,
    new PacketWriter().packedGuid(SELF).u32(6).u8(1).f32(9).toUint8Array());
  assert.equal(client.speeds.get("run"), Math.fround(9));
  assert.equal(client.speedsOf(SELF), client.speeds, "the character's record is the old map itself");
  client.close();
});

test("M7-0: a toggle for the vehicle roots the vehicle, not the character", async () => {
  const { client, connection, deliver } = await moverClient();
  await deliver(OPCODES.SMSG_FORCE_MOVE_ROOT, new PacketWriter().packedGuid(VEHICLE).u32(3).toUint8Array());
  assert.equal(client.movementStateOf(VEHICLE).rooted, true);
  assert.equal(client.movementState.rooted, false);
  const ack = new PacketReader(sentOf(connection, OPCODES.CMSG_FORCE_MOVE_ROOT_ACK).at(-1).payload);
  assert.equal(ack.packedGuid(), VEHICLE);
  client.close();
});

test("M7-0: the character's ACK is built from the live snapshot the movement layer registers", async () => {
  const { client, connection, deliver } = await moverClient();
  client.movementSnapshot = (guid) => guid === SELF
    ? { flags: MOVEMENT_FLAGS.falling, flags2: 0, time: 1, position: { x: 1, y: 2, z: 3, orientation: 0 },
      fallTime: 250, jump: { velocity: 7.955547, sinAngle: 0, cosAngle: 1, speed: 7 } }
    : undefined;
  await deliver(OPCODES.SMSG_FORCE_SWIM_SPEED_CHANGE, new PacketWriter().packedGuid(SELF).u32(8).f32(5).toUint8Array());
  const ack = new PacketReader(sentOf(connection, OPCODES.CMSG_FORCE_SWIM_SPEED_CHANGE_ACK).at(-1).payload);
  assert.equal(ack.packedGuid(), SELF);
  ack.u32();
  const info = readMovementInfo(ack);
  assert.equal(info.flags & MOVEMENT_FLAGS.falling, MOVEMENT_FLAGS.falling);
  assert.equal(info.fallTime, 250);
  assert.deepEqual([info.position.x, info.position.y, info.position.z], [1, 2, 3]);
  client.close();
});

// 11.02-A: the vehicle as the mover. The vehicle is a creature (typeId 3); the character sits in
// seat 0 at the seat's AttachmentOffset (Vehicle.cpp:936-945).
const SEAT = { guid: VEHICLE, x: 1.5, y: 0, z: 2.25, orientation: 0, seat: 0 };
async function seatedClient({ drive }) {
  const harness = await moverClient();
  const { client, deliver } = harness;
  client.state.objects.get(VEHICLE).typeId = 3;
  client.state.move(SELF, { flags: 0, position: { x: 501.5, y: 600, z: 72.25, orientation: 1 }, transport: SEAT });
  if (drive) {
    await deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, control(VEHICLE, false));
    await deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, control(VEHICLE, true));
  } else {
    await deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, control(SELF, true));
  }
  harness.connection.sent.length = 0;
  return harness;
}
const movementOf = (packet) => {
  const reader = new PacketReader(packet.payload);
  const guid = reader.packedGuid();
  const info = readMovementInfo(reader);
  return { guid, info, remaining: reader.remaining };
};

test("11.02-A: sendMovementAs speaks for the driven vehicle, and the vehicle is put where it said", async () => {
  const { client, connection } = await seatedClient({ drive: true });
  assert.equal(client.controlledGuid, VEHICLE);
  client.sendMovementAs(VEHICLE, OPCODES.MSG_MOVE_START_FORWARD, MOVEMENT_FLAGS.forward,
    { x: 503, y: 601, z: 70, orientation: 1.25 }, { fallTime: 0 });
  const sent = sentOf(connection, OPCODES.MSG_MOVE_START_FORWARD);
  assert.equal(sent.length, 1);
  const { guid, info, remaining } = movementOf(sent[0]);
  assert.equal(guid, VEHICLE, "MSG_MOVE_* begins with the vehicle's packed guid (MovementHandler.cpp:273-279)");
  assert.equal(info.flags, MOVEMENT_FLAGS.forward);
  assert.deepEqual([info.position.x, info.position.y, info.position.z], [503, 601, 70]);
  assert.equal(remaining, 0);
  const vehicle = client.state.objects.get(VEHICLE);
  assert.deepEqual([vehicle.position.x, vehicle.position.y, vehicle.position.z], [503, 601, 70]);
  assert.equal(vehicle.glide, undefined, "a driven vehicle is predicted, not glided");
  assert.equal(vehicle.drift, undefined, "nor extrapolated");
  assert.equal(client.state.objects.get(SELF).transport?.guid, VEHICLE, "the driver keeps the seat");

  // Not for a unit this client does not move, and nothing for the character meanwhile.
  client.sendMovementAs(OTHER, OPCODES.MSG_MOVE_HEARTBEAT, 0, { x: 0, y: 0, z: 0, orientation: 0 });
  client.sendMovement(OPCODES.MSG_MOVE_HEARTBEAT, 0, { x: 501.5, y: 600, z: 72.25, orientation: 1 });
  client.sendMovementAs(SELF, OPCODES.MSG_MOVE_HEARTBEAT, 0, { x: 501.5, y: 600, z: 72.25, orientation: 1 });
  assert.equal(sentOf(connection, OPCODES.MSG_MOVE_HEARTBEAT).length, 0);
  client.close();
});

test("11.02-A: a seated character sends nothing of its own, and its ACK carries the seat", async () => {
  const { client, connection, deliver } = await seatedClient({ drive: false });
  assert.notEqual(client.controlledGuid, VEHICLE);
  client.sendMovement(OPCODES.MSG_MOVE_START_FORWARD, MOVEMENT_FLAGS.forward, { x: 502, y: 600, z: 72.25, orientation: 1 });
  assert.equal(sentOf(connection, OPCODES.MSG_MOVE_START_FORWARD).length, 0,
    "a passenger's MSG_MOVE_* would overwrite its seat (MovementHandler.cpp:378)");

  // SMSG_FORCE_MOVE_ROOT at boarding (Vehicle.cpp:969), then a buff on the character expires.
  await deliver(OPCODES.SMSG_FORCE_MOVE_ROOT, new PacketWriter().packedGuid(SELF).u32(1).toUint8Array());
  await deliver(OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE, new PacketWriter().packedGuid(SELF).u32(7).u8(1).f32(7).toUint8Array());
  const ack = new PacketReader(sentOf(connection, OPCODES.CMSG_FORCE_RUN_SPEED_CHANGE_ACK).at(-1).payload);
  assert.equal(ack.packedGuid(), SELF);
  assert.equal(ack.u32(), 7);
  const info = readMovementInfo(ack);
  assert.equal(ack.f32(), 7);
  assert.equal(ack.remaining, 0);
  assert.equal(info.flags & MOVEMENT_FLAGS.onTransport, MOVEMENT_FLAGS.onTransport);
  assert.equal(info.flags & MOVEMENT_FLAGS.root, MOVEMENT_FLAGS.root, "the server's root on the passenger");
  assert.equal(info.flags & MOVEMENT_MASK_MOVING, 0);
  assert.deepEqual([info.transport.guid, info.transport.x, info.transport.y, info.transport.z, info.transport.seat],
    [VEHICLE, 1.5, 0, 2.25, 0], "the ACK replaces m_movementInfo (MovementHandler.cpp:549): the seat goes back as held");
  client.close();
});

test("11.02-A: a spline root of the driven vehicle is kept as its toggle; another unit's is not", async () => {
  const { client, deliver } = await seatedClient({ drive: true });
  assert.equal(client.movementStateOf(VEHICLE).rooted, false);
  await deliver(OPCODES.SMSG_SPLINE_MOVE_ROOT, new PacketWriter().packedGuid(VEHICLE).toUint8Array());
  assert.equal(client.movementStateOf(VEHICLE).rooted, true);
  assert.equal(client.movementState.rooted, false, "not the character's");
  await deliver(OPCODES.SMSG_SPLINE_MOVE_UNROOT, new PacketWriter().packedGuid(VEHICLE).toUint8Array());
  assert.equal(client.movementStateOf(VEHICLE).rooted, false);
  client.state.move(OTHER, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  await deliver(OPCODES.SMSG_SPLINE_MOVE_ROOT, new PacketWriter().packedGuid(OTHER).toUint8Array());
  assert.equal(client.moverStates.has(OTHER), false, "a neighbour's root makes no mover record");
  client.close();
});

test("11.02-A: without a vehicle the character's packets are what they were", async () => {
  const { client, connection, deliver } = await moverClient();
  await deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, control(SELF, true));
  const position = { x: 11, y: 21, z: 31, orientation: 0.5 };
  const extra = { fallTime: 120, jump: { velocity: -7.955547, sinAngle: 0, cosAngle: 1, speed: 7 } };
  client.sendMovement(OPCODES.MSG_MOVE_JUMP, MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.falling, position, extra);
  client.sendMovementAs(SELF, OPCODES.MSG_MOVE_JUMP, MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.falling, position, extra);
  const [plain, viaMover] = sentOf(connection, OPCODES.MSG_MOVE_JUMP);
  assert.ok(plain && viaMover);
  // Everything but the four time bytes (after packed guid, u32 flags, u16 flags2) is identical.
  const strip = (bytes) => [...bytes.slice(0, 1 + 2 + 4 + 2), ...bytes.slice(1 + 2 + 4 + 2 + 4)];
  assert.deepEqual(strip(viaMover.payload), strip(plain.payload));
  const { guid, info, remaining } = movementOf(plain);
  assert.equal(guid, SELF);
  assert.equal(info.flags, MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.falling);
  assert.equal(info.fallTime, 120);
  assert.equal(remaining, 0);
  client.close();
});

test("11.02-A review: a unit taken over stops being extrapolated and stands where the server last had it", async () => {
  const { client, deliver } = await moverClient();
  // A unit somebody else was running (a player about to be mind-controlled): its relayed packet
  // starts a drift that carries it on between packets (MovementExtrapolation.ts).
  const said = { x: 500, y: 600, z: 70, orientation: 0 };
  const start = performance.now();
  client.state.move(VEHICLE, { flags: MOVEMENT_FLAGS.forward, position: { ...said } }, start);
  client.state.updateMotions(start + 500);
  assert.ok(client.state.objects.get(VEHICLE).drift !== undefined, "the relay drifts the unit");
  await deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, control(VEHICLE, true));
  const unit = client.state.objects.get(VEHICLE);
  assert.equal(unit.drift, undefined, "a unit this client moves is not extrapolated");
  assert.equal(unit.glide, undefined);
  assert.deepEqual([unit.position.x, unit.position.y, unit.position.z], [said.x, said.y, said.z],
    "it stands where its last packet put it, as the core holds it");
  client.state.updateMotions(start + 1500);
  assert.deepEqual([unit.position.x, unit.position.y], [said.x, said.y], "nothing carries it on before the keys do");
  client.close();
});

test("11.02-A review: a new world forgets the driven unit's prediction", async () => {
  const { client, deliver } = await moverClient();
  await deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, control(VEHICLE, true));
  assert.equal(client.state.predictedGuid, VEHICLE);
  await deliver(OPCODES.SMSG_NEW_WORLD, new PacketWriter().u32(571).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  assert.equal(client.controlledGuid, undefined);
  assert.equal(client.state.predictedGuid, undefined, "the next map's unit with this guid is somebody else's to glide");
  client.close();
});

test("11.02-A review: a controlled unit seated on another (a turret accessory) sends nothing", async () => {
  const { client, connection, deliver } = await moverClient();
  const TURRET = 0xf150_7d9a_0000_0043n;
  client.state.objects.get(VEHICLE).typeId = 3;
  client.state.move(TURRET, { flags: MOVEMENT_FLAGS.onTransport, position: { x: 498, y: 600, z: 73, orientation: 1 },
    transport: { guid: VEHICLE, x: -2, y: 0, z: 3, orientation: 0, seat: 1 } });
  client.state.objects.get(TURRET).typeId = 3;
  await deliver(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, control(TURRET, true));
  connection.sent.length = 0;
  client.sendMovementAs(TURRET, OPCODES.MSG_MOVE_START_FORWARD, MOVEMENT_FLAGS.forward, { x: 499, y: 600, z: 73, orientation: 1 });
  assert.equal(connection.sent.length, 0, "its MSG_MOVE_* would overwrite the seat (MovementHandler.cpp:378)");
  assert.equal(client.state.objects.get(TURRET).transport?.guid, VEHICLE, "the turret keeps its seat");
  client.close();
});
