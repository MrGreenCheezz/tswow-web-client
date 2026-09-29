import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketReader, PacketWriter } from "../dist/code/protocol/index.js";
import { MOVEMENT_FLAGS, readMovementInfo, writeMovementInfo, writeMovementInfoBody } from "../dist/code/world/MovementProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
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

// What each toggle ack's handler reads after the packed guid, the counter and the MovementInfo
// (MovementHandler.cpp): HandleMoveHoverAck :686, HandleMoveWaterWalkAck :709, HandleFeatherFallAck
// :753 and HandleMoveSetCanFlyAckOpcode :797 one more u32; the root pair (:712-775) and the gravity
// pair (:823-863) nothing; HandleMoveSetCollisionHgtAck the height, as a float (:886).
const CORE_TAIL = new Map([
  [OPCODES.CMSG_MOVE_HOVER_ACK, "u32"],
  [OPCODES.CMSG_MOVE_WATER_WALK_ACK, "u32"],
  [OPCODES.CMSG_MOVE_FEATHER_FALL_ACK, "u32"],
  [OPCODES.CMSG_MOVE_SET_CAN_FLY_ACK, "u32"],
  [OPCODES.CMSG_FORCE_MOVE_ROOT_ACK, undefined],
  [OPCODES.CMSG_FORCE_MOVE_UNROOT_ACK, undefined],
  [OPCODES.CMSG_MOVE_GRAVITY_DISABLE_ACK, undefined],
  [OPCODES.CMSG_MOVE_GRAVITY_ENABLE_ACK, undefined],
  [OPCODES.CMSG_MOVE_SET_COLLISION_HGT_ACK, "f32"],
]);

/** An ack read the way its core handler reads it: a short one throws here as it does there. */
function readLikeTheCore(opcode, ack) {
  assert.ok(CORE_TAIL.has(opcode), `0x${opcode.toString(16)} is a toggle ack`);
  const reader = new PacketReader(ack);
  const guid = reader.packedGuid();
  const counter = reader.u32();
  const { flags } = readMovementInfo(reader);
  const tail = CORE_TAIL.get(opcode);
  const value = tail === "u32" ? reader.u32() : tail === "f32" ? reader.f32() : undefined;
  assert.equal(reader.remaining, 0, "the handler reads the ack to its last byte");
  return { guid, counter, flags, value };
}

const WALKING = MOVEMENT_FLAGS.walking;

test("the four flag families' acks end in their apply word and echo the flag already switched", () => {
  // Every one of these is the packed guid and a zero counter, nothing more (Player.cpp:27214-27285).
  // On 2026-09-28 Levitate's (feather fall, hover, water walk) and a can-fly ack were four bytes
  // short, and each died in its handler with a ByteBufferException.
  const cases = [
    [OPCODES.SMSG_MOVE_WATER_WALK, OPCODES.CMSG_MOVE_WATER_WALK_ACK, 1, MOVEMENT_FLAGS.waterWalking],
    [OPCODES.SMSG_MOVE_LAND_WALK, OPCODES.CMSG_MOVE_WATER_WALK_ACK, 0, MOVEMENT_FLAGS.waterWalking],
    [OPCODES.SMSG_MOVE_FEATHER_FALL, OPCODES.CMSG_MOVE_FEATHER_FALL_ACK, 1, MOVEMENT_FLAGS.fallingSlow],
    [OPCODES.SMSG_MOVE_NORMAL_FALL, OPCODES.CMSG_MOVE_FEATHER_FALL_ACK, 0, MOVEMENT_FLAGS.fallingSlow],
    [OPCODES.SMSG_MOVE_SET_HOVER, OPCODES.CMSG_MOVE_HOVER_ACK, 1, MOVEMENT_FLAGS.hover],
    [OPCODES.SMSG_MOVE_UNSET_HOVER, OPCODES.CMSG_MOVE_HOVER_ACK, 0, MOVEMENT_FLAGS.hover],
    [OPCODES.SMSG_MOVE_SET_CAN_FLY, OPCODES.CMSG_MOVE_SET_CAN_FLY_ACK, 1, MOVEMENT_FLAGS.canFly],
    [OPCODES.SMSG_MOVE_UNSET_CAN_FLY, OPCODES.CMSG_MOVE_SET_CAN_FLY_ACK, 0, MOVEMENT_FLAGS.canFly],
  ];
  for (const [server, ackOpcode, apply, flag] of cases) {
    const toggle = parseMovementToggle(server, new PacketWriter().packedGuid(GUID).u32(0).toUint8Array());
    assert.equal(toggle.ackOpcode, ackOpcode);
    assert.equal(toggle.value, undefined, "the server sends no value with these");
    // Start from the other state, so the echo has something to switch; walking must survive it.
    const before = apply ? WALKING : WALKING | flag;
    const ack = buildMovementToggleAck(toggle, movement({ flags: before }));
    assert.deepEqual(readLikeTheCore(ackOpcode, ack),
      { guid: GUID, counter: 0, flags: (apply ? WALKING | flag : WALKING) >>> 0, value: apply },
      `0x${server.toString(16)}`);
  }
});

test("root, unroot and the gravity pair end at the MovementInfo; the collision height ends in its float", () => {
  for (const [server, ackOpcode] of [
    [OPCODES.SMSG_FORCE_MOVE_ROOT, OPCODES.CMSG_FORCE_MOVE_ROOT_ACK],
    [OPCODES.SMSG_FORCE_MOVE_UNROOT, OPCODES.CMSG_FORCE_MOVE_UNROOT_ACK],
    [OPCODES.SMSG_MOVE_GRAVITY_DISABLE, OPCODES.CMSG_MOVE_GRAVITY_DISABLE_ACK],
    [OPCODES.SMSG_MOVE_GRAVITY_ENABLE, OPCODES.CMSG_MOVE_GRAVITY_ENABLE_ACK],
  ]) {
    const toggle = parseMovementToggle(server, new PacketWriter().packedGuid(GUID).u32(7).toUint8Array());
    assert.deepEqual(readLikeTheCore(ackOpcode, buildMovementToggleAck(toggle, movement({ flags: WALKING }))),
      { guid: GUID, counter: 7, flags: WALKING, value: undefined }, `0x${server.toString(16)}`);
  }
  // Unit.cpp:8732-8735: the counter is the game time, then the height the ack sends back.
  const height = parseMovementToggle(OPCODES.SMSG_MOVE_SET_COLLISION_HGT,
    new PacketWriter().packedGuid(GUID).u32(1_790_608_000).f32(2.5).toUint8Array());
  assert.deepEqual(readLikeTheCore(OPCODES.CMSG_MOVE_SET_COLLISION_HGT_ACK, buildMovementToggleAck(height, movement())),
    { guid: GUID, counter: 1_790_608_000, flags: 0, value: 2.5 });
});

function recordingConnection() {
  const packets = [];
  const sent = [];
  let wake;
  return {
    sent,
    push(opcode, payload) {
      const packet = { opcode, payload };
      if (wake) { const resolve = wake; wake = undefined; resolve(packet); }
      else packets.push(packet);
    },
    read() { return packets.length ? Promise.resolve(packets.shift()) : new Promise((resolve) => { wake = resolve; }); },
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload }); },
    close() {},
  };
}

async function settle() { for (let index = 0; index < 6; index++) await new Promise(setImmediate); }

/** `SMSG_MULTIPLE_MOVES` as Player.cpp:23301-23341 writes it: a byte count, then sized blocks. */
function multipleMoves(guid, opcodes) {
  const blocks = new PacketWriter();
  for (const opcode of opcodes) {
    const block = new PacketWriter().u16(opcode).packedGuid(guid).u32(0).toUint8Array();
    blocks.u8(block.length).bytes(block);
  }
  const body = blocks.toUint8Array();
  return new PacketWriter().u32(body.length).bytes(body).toUint8Array();
}

test("the client's acks for Levitate, a can-fly change and a login's SMSG_MULTIPLE_MOVES parse in the core", async () => {
  const transport = recordingConnection();
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(604).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(transport);
  await world.loginCharacter(GUID);
  await settle();
  try {
    const body = () => new PacketWriter().packedGuid(GUID).u32(0).toUint8Array();
    // Levitate (Spell.dbc 1706: auras 105, 106, 104) in its effects' order, then a can-fly change.
    for (const opcode of [OPCODES.SMSG_MOVE_FEATHER_FALL, OPCODES.SMSG_MOVE_SET_HOVER, OPCODES.SMSG_MOVE_WATER_WALK,
      OPCODES.SMSG_MOVE_SET_CAN_FLY]) transport.push(opcode, body());
    // What a character already holding feather fall, water walking and hover logs in with.
    transport.push(OPCODES.SMSG_MULTIPLE_MOVES, multipleMoves(GUID,
      [OPCODES.SMSG_MOVE_FEATHER_FALL, OPCODES.SMSG_MOVE_WATER_WALK, OPCODES.SMSG_MOVE_SET_HOVER]));
    // And Levitate going: the same three families switched off.
    for (const opcode of [OPCODES.SMSG_MOVE_NORMAL_FALL, OPCODES.SMSG_MOVE_UNSET_HOVER, OPCODES.SMSG_MOVE_LAND_WALK]) {
      transport.push(opcode, body());
    }
    await settle();
    const acks = transport.sent.filter(({ opcode }) => CORE_TAIL.has(opcode))
      .map(({ opcode, payload }) => [opcode, readLikeTheCore(opcode, payload).value]);
    assert.deepEqual(acks, [
      [OPCODES.CMSG_MOVE_FEATHER_FALL_ACK, 1], [OPCODES.CMSG_MOVE_HOVER_ACK, 1], [OPCODES.CMSG_MOVE_WATER_WALK_ACK, 1],
      [OPCODES.CMSG_MOVE_SET_CAN_FLY_ACK, 1],
      [OPCODES.CMSG_MOVE_FEATHER_FALL_ACK, 1], [OPCODES.CMSG_MOVE_WATER_WALK_ACK, 1], [OPCODES.CMSG_MOVE_HOVER_ACK, 1],
      [OPCODES.CMSG_MOVE_FEATHER_FALL_ACK, 0], [OPCODES.CMSG_MOVE_HOVER_ACK, 0], [OPCODES.CMSG_MOVE_WATER_WALK_ACK, 0],
    ]);
  } finally { world.close(); }
});

test("a teleport is parsed and acknowledged", () => {
  // SMSG_NEW_WORLD: the map and where on it the player lands.
  const world = parseNewWorld(new PacketWriter().u32(571).f32(5807.5).f32(587.2).f32(660.9).f32(1.5).toUint8Array());
  assert.equal(world.mapId, 571);
  assert.equal(world.z, Math.fround(660.9));
  assert.deepEqual(parseTransferPending(new PacketWriter().u32(571).toUint8Array()), { mapId: 571 });
  assert.deepEqual(parseTransferPending(new PacketWriter().u32(571).u32(176310).u32(0).toUint8Array()),
    { mapId: 571, transportEntry: 176310, sourceMapId: 0 });

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
