import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketReader, PacketWriter } from "../dist/code/protocol/index.js";
import { readMovementInfo, writeMovementInfo, writeMovementInfoBody } from "../dist/code/world/MovementProtocol.js";
import {
  ackOpcodeForSpeed, buildForcedSpeedAck, buildMovementToggleAck, buildTeleportAck,
  isForcedSpeed, isMovementToggle, parseForcedSpeed, parseMovementToggle, parseNewWorld,
  parseTeleportRequest, parseTransferPending,
} from "../dist/code/world/MovementAckProtocol.js";

const GUID = 0x0000_0000_0000_1234n;
const FALLING = 0x00001000;
const SWIMMING = 0x00200000;
const ON_TRANSPORT = 0x00000200;

function movement(overrides = {}) {
  return {
    flags: 0,
    flags2: 0,
    time: 123456,
    position: { x: -8949.95, y: -132.49, z: 83.53, orientation: 0.5 },
    ...overrides,
  };
}

test("MovementInfo survives a write and read, including the parts that were dropped", () => {
  // The reader used to skip pitch, fall time, the jump vector and the transport block. An ack
  // has to echo the mover's state back byte for byte, so they have to be kept.
  const cases = [
    movement(),
    movement({ flags: SWIMMING, pitch: -0.42, fallTime: 900 }),
    movement({ flags: FALLING, fallTime: 1500, jump: { velocity: -7.95, sinAngle: 0.5, cosAngle: 0.86, speed: 7.1 } }),
    movement({
      flags: ON_TRANSPORT,
      transport: { guid: 0x0000_0000_0000_00abn, x: 1.5, y: -2.5, z: 3.5, orientation: 1.25, time: 4242, seat: 3 },
    }),
  ];
  for (const info of cases) {
    const written = writeMovementInfo(new PacketWriter(), GUID, info).toUint8Array();
    const reader = new PacketReader(written);
    assert.equal(reader.packedGuid(), GUID);
    const read = readMovementInfo(reader);
    assert.equal(reader.remaining, 0, "the writer and reader must agree on the length exactly");
    assert.equal(read.flags, info.flags);
    assert.equal(read.time, info.time);
    assert.equal(read.position.x, Math.fround(info.position.x));
    if (info.pitch !== undefined) assert.equal(read.pitch, Math.fround(info.pitch));
    if (info.fallTime !== undefined) assert.equal(read.fallTime, info.fallTime);
    if (info.jump) assert.equal(read.jump.speed, Math.fround(info.jump.speed));
    if (info.transport) {
      assert.equal(read.transport.guid, info.transport.guid);
      assert.equal(read.transport.seat, info.transport.seat);
    }
  }
});

test("a forced speed change is recognised and acknowledged the way the core reads it", () => {
  // MovementPacketSender.cpp:71-77: packed guid, counter, one byte for run only, then the speed.
  const run = new PacketWriter().packedGuid(GUID).u32(77).u8(1).f32(11.5).toUint8Array();
  assert.ok(isForcedSpeed(OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE));
  const parsed = parseForcedSpeed(OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE, run);
  assert.deepEqual({ guid: parsed.guid, counter: parsed.counter, speed: parsed.speed, name: parsed.name },
    { guid: GUID, counter: 77, speed: 11.5, name: "run" });

  // Everything else omits that byte.
  const swim = new PacketWriter().packedGuid(GUID).u32(9).f32(4.72).toUint8Array();
  assert.equal(parseForcedSpeed(OPCODES.SMSG_FORCE_SWIM_SPEED_CHANGE, swim).speed, Math.fround(4.72));

  // HandleForceSpeedChangeAck reads guid, counter, MovementInfo, speed — in that order.
  const ack = buildForcedSpeedAck(parsed, movement());
  const reader = new PacketReader(ack);
  assert.equal(reader.packedGuid(), GUID);
  assert.equal(reader.u32(), 77);
  // ReadMovementInfo starts at the flags: the guid is read once, by the handler, not twice.
  readMovementInfo(reader);
  assert.equal(reader.f32(), 11.5);
  assert.equal(reader.remaining, 0);

  assert.equal(ackOpcodeForSpeed("run"), OPCODES.CMSG_FORCE_RUN_SPEED_CHANGE_ACK);
  assert.equal(ackOpcodeForSpeed("flightBack"), OPCODES.CMSG_FORCE_FLIGHT_BACK_SPEED_CHANGE_ACK);
});

test("movement toggles ack with the counter and, where there is one, the value", () => {
  assert.ok(isMovementToggle(OPCODES.SMSG_FORCE_MOVE_ROOT));
  const root = parseMovementToggle(OPCODES.SMSG_FORCE_MOVE_ROOT,
    new PacketWriter().packedGuid(GUID).u32(5).toUint8Array());
  assert.equal(root.counter, 5);
  assert.equal(root.value, undefined);
  assert.equal(root.ackOpcode, OPCODES.CMSG_FORCE_MOVE_ROOT_ACK);

  const height = parseMovementToggle(OPCODES.SMSG_MOVE_SET_COLLISION_HGT,
    new PacketWriter().packedGuid(GUID).u32(6).f32(2.03).toUint8Array());
  assert.equal(height.value, Math.fround(2.03));

  const ack = buildMovementToggleAck(height, movement());
  const reader = new PacketReader(ack);
  assert.equal(reader.packedGuid(), GUID);
  assert.equal(reader.u32(), 6);
  readMovementInfo(reader);
  assert.equal(reader.f32(), Math.fround(2.03));
  assert.equal(reader.remaining, 0);
});

test("a teleport is parsed and acknowledged", () => {
  // SMSG_NEW_WORLD: the map and where on it the player lands.
  const world = parseNewWorld(new PacketWriter().u32(571).f32(5807.5).f32(587.2).f32(660.9).f32(1.5).toUint8Array());
  assert.equal(world.mapId, 571);
  assert.equal(world.z, Math.fround(660.9));
  assert.equal(parseTransferPending(new PacketWriter().u32(571).toUint8Array()), 571);

  // MSG_MOVE_TELEPORT_ACK arrives with the mover's new state and is answered with three fields.
  const request = new PacketWriter().packedGuid(GUID).u32(42);
  writeMovementInfoBody(request, movement());
  const parsed = parseTeleportRequest(request.toUint8Array().slice(0));
  assert.equal(parsed.counter, 42);
  assert.equal(parsed.movement.position.z, Math.fround(83.53));

  const ack = new PacketReader(buildTeleportAck(GUID, 42, 999));
  assert.equal(ack.packedGuid(), GUID);
  assert.equal(ack.u32(), 42);
  assert.equal(ack.u32(), 999);
  assert.equal(ack.remaining, 0);
});
