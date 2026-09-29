import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { fakeWorldConnection } from "./fixtures/world-packets.mjs";

// 1.25 (1). While the login handshake owns the socket, `#waitFor` runs each packet through the
// utility handlers itself — outside `#deliver`, whose try/catch keeps one bad packet from ending a
// session. A parse error there rejected `characters()` (or `loginCharacter`, or the auth loop) and
// the character list never opened.

test("a malformed utility packet during the handshake is recorded, and the list still arrives", async () => {
  const connection = fakeWorldConnection([
    // SMSG_START_MIRROR_TIMER is 21 bytes (MirrorTimerProtocol.ts); three cannot hold its first word.
    { opcode: OPCODES.SMSG_START_MIRROR_TIMER, payload: new Uint8Array([1, 2, 3]) },
    // SMSG_CHAR_ENUM with no characters: the count byte alone.
    { opcode: OPCODES.SMSG_CHAR_ENUM, payload: new PacketWriter().u8(0).toUint8Array() },
  ]);
  const client = new WorldClient(connection);
  const errors = [];
  client.onPacketError = (opcode, error) => errors.push({ opcode, error });
  try {
    assert.deepEqual(await client.characters(), []);
    assert.equal(connection.sentOf(OPCODES.CMSG_CHAR_ENUM).length, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].opcode, OPCODES.SMSG_START_MIRROR_TIMER);
    assert.ok(errors[0].error instanceof RangeError, `a parse error, not ${errors[0].error}`);
    assert.equal(client.mirrorTimers.size, 0, "the broken timer is not half-applied");
    assert.equal(client.packetErrors.count, 1, "the diagnostics log counts it like any world-loop failure");
    assert.equal(client.packetErrors.summary()[0]?.category, "dispatch");
    assert.equal(client.packetErrors.summary()[0]?.payloadSizes?.[0], 3);
  } finally {
    client.close();
  }
});

test("the packet being waited for is never taken by the recovery", async () => {
  // The awaited opcode is not a utility packet, so a throw before it cannot swallow it; a second
  // bad packet after the first is recorded on its own.
  const connection = fakeWorldConnection([
    { opcode: OPCODES.SMSG_START_MIRROR_TIMER, payload: new Uint8Array([1]) },
    { opcode: OPCODES.SMSG_PAUSE_MIRROR_TIMER, payload: new Uint8Array([9]) },
    { opcode: OPCODES.SMSG_CHAR_DELETE, payload: new PacketWriter().u8(71).toUint8Array() },
  ]);
  const client = new WorldClient(connection);
  const errors = [];
  client.onPacketError = (opcode) => errors.push(opcode);
  try {
    assert.equal(await client.deleteCharacter(0x42n), 71);
    assert.deepEqual(errors, [OPCODES.SMSG_START_MIRROR_TIMER, OPCODES.SMSG_PAUSE_MIRROR_TIMER]);
  } finally {
    client.close();
  }
});
