// 5.01, network half (docs/implementation/line-A4.ru.md): the knock back acknowledgement says the
// character is falling, and a relayed knock back is drawn as the arc it is (with 5.04).
import assert from "node:assert/strict";
import test from "node:test";
import { PacketReader, PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { knockBackMovement, parseKnockBack } from "../dist/code/world/MovementAckProtocol.js";
import { knockbackImpulse, knockbackJump } from "../dist/code/world/KnockbackImpulse.js";
import { MOVEMENT_FLAGS, readMovementInfo, writeMovementInfoBody } from "../dist/code/world/MovementProtocol.js";
import { parseMovementRelayKnockBack } from "../dist/code/world/MovementRelayProtocol.js";
import { settle, travelClient } from "./fixtures/world-packets.mjs";

const SELF = 0x0000_0000_0000_0007n;
const NEIGHBOUR = 0x0000_0000_0000_0042n;
const GRAVITY = 19.29110527038574;

/** `Unit::KnockbackFrom` (Unit.cpp:13232-13237): packed guid, `u32 0`, cos, sin, speedXY, `-speedZ`. */
function knockBackPacket(guid, { cos, sin, speedXY, speedZ }) {
  return new PacketWriter().packedGuid(guid).u32(0).f32(cos).f32(sin).f32(speedXY).f32(-speedZ).toUint8Array();
}

const f32 = (value) => Math.fround(value);

test("the acknowledgement already says falling, with the server's jump, and goes before the physics hears", async () => {
  const { client, connection } = await travelClient([], SELF);
  let sentWhenTold;
  let told;
  client.onKnockBack = (knockBack) => {
    sentWhenTold = connection.sentOf(OPCODES.CMSG_MOVE_KNOCK_BACK_ACK).length;
    told = knockBack;
  };
  // Thrown upwards at 7.5 yd/s: on the wire −7.5.
  connection.push(OPCODES.SMSG_MOVE_KNOCK_BACK, knockBackPacket(SELF, { cos: 0.6, sin: 0.8, speedXY: 12, speedZ: 7.5 }));
  await settle();
  const acks = connection.sentOf(OPCODES.CMSG_MOVE_KNOCK_BACK_ACK);
  assert.equal(acks.length, 1);
  assert.equal(sentWhenTold, 1, "the ack is out before onKnockBack runs");
  assert.ok(told);

  // Read as `HandleMoveKnockBackAck` reads it (MovementHandler.cpp:615-638).
  const reader = new PacketReader(acks[0].payload);
  assert.equal(reader.packedGuid(), SELF);
  reader.u32();
  const info = readMovementInfo(reader);
  reader.assertFinished();
  assert.ok(info.flags & MOVEMENT_FLAGS.falling, "FALLING");
  assert.equal(info.fallTime, 0);
  assert.deepEqual(info.jump, { velocity: f32(-7.5), sinAngle: f32(0.8), cosAngle: f32(0.6), speed: 12 },
    "the wire's sign, sine first in the block");
  assert.deepEqual([info.position.x, info.position.y, info.position.z], [10, 20, 30]);

  // The next acknowledgement of anything echoes the same fall until the physics reports its own.
  const object = client.state.objects.get(SELF);
  assert.ok(object.movementFlags & MOVEMENT_FLAGS.falling, "the state knows it is in the air");
  connection.push(OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE,
    new PacketWriter().packedGuid(SELF).u32(1).u8(0).f32(14).toUint8Array());
  await settle();
  const speedAck = new PacketReader(connection.sentOf(OPCODES.CMSG_FORCE_RUN_SPEED_CHANGE_ACK)[0].payload);
  speedAck.packedGuid();
  speedAck.u32();
  const echoed = readMovementInfo(speedAck);
  assert.ok(echoed.flags & MOVEMENT_FLAGS.falling);
  assert.deepEqual(echoed.jump, info.jump);
});

test("swimming ends with the knock, and the impulse the physics gets is up-positive", () => {
  const knockBack = parseKnockBack(knockBackPacket(SELF, { cos: 1, sin: 0, speedXY: 5, speedZ: 9 }));
  const after = knockBackMovement(knockBack, {
    flags: MOVEMENT_FLAGS.swimming | MOVEMENT_FLAGS.forward, flags2: 0, time: 1, position: { x: 0, y: 0, z: 0, orientation: 0 }, pitch: 0.2,
  });
  assert.equal(after.flags & MOVEMENT_FLAGS.swimming, 0);
  assert.ok(after.flags & MOVEMENT_FLAGS.falling);
  const impulse = knockbackImpulse(knockBack);
  assert.deepEqual(impulse, { cos: 1, sin: 0, speedXY: 5, upSpeed: 9 });
  assert.deepEqual(knockbackJump(impulse), after.jump, "heartbeats must keep the acknowledgement's block");
});

/**
 * `MSG_MOVE_KNOCK_BACK` as the core builds it from an acknowledgement (MovementHandler.cpp:654-661):
 * `WriteMovementInfo`, then `jump.sinAngle, cosAngle, xyspeed, zspeed`.
 */
function relayFrom(guid, movement) {
  const writer = new PacketWriter().packedGuid(guid);
  writeMovementInfoBody(writer, movement);
  const jump = movement.jump ?? { velocity: 0, sinAngle: 0, cosAngle: 0, speed: 0 };
  return writer.f32(jump.sinAngle).f32(jump.cosAngle).f32(jump.speed).f32(jump.velocity).toUint8Array();
}

test("the relay of our own acknowledgement reads back the same four numbers in the same fields", () => {
  const knockBack = parseKnockBack(knockBackPacket(NEIGHBOUR, { cos: 0.6, sin: 0.8, speedXY: 12, speedZ: 7.5 }));
  const after = knockBackMovement(knockBack, { flags: 0, flags2: 0, time: 5, position: { x: 1, y: 2, z: 3, orientation: 0 } });
  const relay = parseMovementRelayKnockBack(relayFrom(NEIGHBOUR, after));
  assert.equal(relay.directionSin, f32(0.8));
  assert.equal(relay.directionCos, f32(0.6));
  assert.equal(relay.speedXY, 12);
  assert.equal(relay.speedZ, f32(-7.5));
  assert.deepEqual(relay.movement.jump, { velocity: f32(-7.5), sinAngle: f32(0.8), cosAngle: f32(0.6), speed: 12 });
});

test("an observer draws the knock back as an arc, also from a relay whose victim said 'standing'", async () => {
  for (const victimSaidFalling of [true, false]) {
    const { client, connection } = await travelClient([], SELF);
    const standing = { flags: 0, flags2: 0, time: 5, position: { x: 100, y: 0, z: 0, orientation: 0 } };
    const knockBack = parseKnockBack(knockBackPacket(NEIGHBOUR, { cos: 1, sin: 0, speedXY: 10, speedZ: 8 }));
    const movement = victimSaidFalling ? knockBackMovement(knockBack, standing) : standing;
    const writer = new PacketWriter().packedGuid(NEIGHBOUR);
    writeMovementInfoBody(writer, movement);
    // The tail: sin, cos, xy, z. The core copies it out of the victim's acknowledgement; the second
    // round stands for a victim whose MovementInfo did not raise FALLING while the tail is intact.
    writer.f32(0).f32(1).f32(10).f32(-8);
    connection.push(OPCODES.MSG_MOVE_KNOCK_BACK, writer.toUint8Array());
    await settle();
    const object = client.state.objects.get(NEIGHBOUR);
    assert.ok(object.movementFlags & MOVEMENT_FLAGS.falling, `falling (${victimSaidFalling})`);
    const drift = object.drift;
    assert.ok(drift?.ballistic, "a ballistic drift");
    // Half a second later: 5 yards along +x, and up 8·0.5 − g·0.25/2.
    client.state.updateMotions(drift.at + 500);
    assert.ok(Math.abs(object.position.x - 105) < 1e-6, `x ${object.position.x}`);
    assert.ok(Math.abs(object.position.z - (4 - GRAVITY * 0.125)) < 1e-5, `z ${object.position.z}`);
  }
});

test("a relay with neither FALLING nor a tail is a standing unit, not one dropped through the floor", async () => {
  // What this core relays for an acknowledgement that said "standing": `MovementInfo` is fresh
  // (`jump` zeroed) and `ReadMovementInfo` fills the block only under FALLING.
  const { client, connection } = await travelClient([], SELF);
  const writer = new PacketWriter().packedGuid(NEIGHBOUR);
  writeMovementInfoBody(writer, { flags: 0, flags2: 0, time: 5, position: { x: 100, y: 0, z: 0, orientation: 0 } });
  writer.f32(0).f32(0).f32(0).f32(0);
  connection.push(OPCODES.MSG_MOVE_KNOCK_BACK, writer.toUint8Array());
  await settle();
  const object = client.state.objects.get(NEIGHBOUR);
  assert.equal(object.movementFlags & MOVEMENT_FLAGS.falling, 0);
  assert.equal(object.drift, undefined);
});
