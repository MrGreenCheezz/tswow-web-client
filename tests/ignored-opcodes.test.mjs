import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { IGNORED_OPCODES, IgnoredOpcodeLog } from "../dist/code/world/IgnoredOpcodes.js";

/** 5.29: an opcode accepted without an effect is counted with its reason, apart from the unhandled. */

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();
  return { client, connection };
}

// 05.10-A7a-H: SMSG_MIRRORIMAGE_DATA, the planned example here until 6.11б gave it its effect, is
// replaced by an unplanned one (SMSG_UPDATE_LAST_INSTANCE, a u32 map id); no planned entry is left.
test("5.29 an unplanned-but-ignored packet is counted with its reason, not as unhandled", async () => {
  const { client, connection } = await loggedIn();
  const lastInstance = () => new PacketWriter().u32(36).toUint8Array();
  connection.push(OPCODES.SMSG_UPDATE_LAST_INSTANCE, lastInstance());
  connection.push(OPCODES.SMSG_UPDATE_LAST_INSTANCE, lastInstance());
  await settle();
  const [entry] = client.ignoredOpcodes.summary();
  assert.equal(entry?.name, "SMSG_UPDATE_LAST_INSTANCE");
  assert.equal(entry?.count, 2);
  assert.equal(entry?.kind, "unplanned");
  assert.deepEqual(client.unhandledOpcodes.summary(), []);
  assert.deepEqual(client.ignoredOpcodes.counts(), { "by-design": 0, planned: 0, unplanned: 2, unregistered: 0 });
  client.close();
});

test("05.10-A7a-H 6.11б a mirror image reply is kept for the unit, not counted as ignored", async () => {
  const { client, connection } = await loggedIn();
  const mirror = new PacketWriter().u64(0xf130000000000001n).u32(49).u8(1).u8(0).u8(8).u8(0).u8(0).u8(0).u8(0).u8(0)
    .u32(0).toUint8Array();
  // 05.10 review H: a reply is kept only for a unit the client still knows (mirror-image-review.test.mjs).
  client.state.move(0xf130000000000001n, { flags: 0, position: { x: 1, y: 0, z: 0, orientation: 0 } });
  connection.push(OPCODES.SMSG_MIRRORIMAGE_DATA, mirror);
  await settle();
  assert.equal(client.ignoredOpcodes.entries.size, 0);
  assert.deepEqual(client.unhandledOpcodes.summary(), []);
  assert.equal(client.mirrorImages.get(0xf130000000000001n, 49, 0x10)?.classId, 8);
  const before = connection.sent.length;
  assert.equal(client.mirrorImages.get(0xf130000000000002n, 49, 0x10), undefined);
  assert.equal(connection.sent.length, before + 1);
  assert.equal(connection.sent.at(-1).opcode, OPCODES.CMSG_GET_MIRRORIMAGE_DATA);
  client.close();
});

test("5.29 the never-built movement relays are counted as by design", async () => {
  const { client, connection } = await loggedIn();
  connection.push(OPCODES.MSG_MOVE_ROOT, new Uint8Array([1, 2, 3]));
  await settle();
  assert.equal(client.ignoredOpcodes.summary()[0]?.kind, "by-design");
  assert.deepEqual(client.unhandledOpcodes.summary(), []);
  client.close();
});

test("5.29 an opcode nobody handles stays in the unhandled log, not the ignored one", async () => {
  const { client, connection } = await loggedIn();
  connection.push(0x7ff, new Uint8Array([9]));
  await settle();
  assert.equal(client.ignoredOpcodes.entries.size, 0);
  assert.equal(client.unhandledOpcodes.summary()[0]?.name, "UNKNOWN_0x7FF");
  client.close();
});

test("5.29 an ignored opcode missing from the registry is reported as unregistered", () => {
  const log = new IgnoredOpcodeLog();
  log.record({ opcode: OPCODES.SMSG_ATTACK_START, payload: new Uint8Array(16) });
  assert.equal(IGNORED_OPCODES.has("SMSG_ATTACK_START"), false);
  assert.equal(log.summary()[0]?.kind, "unregistered");
  assert.equal(log.counts().unregistered, 1);
});
