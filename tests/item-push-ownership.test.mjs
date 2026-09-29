import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    push(opcode, payload = new Uint8Array()) {
      const packet = { opcode, payload };
      if (wake) { const resume = wake; wake = undefined; resume(packet); }
      else queue.push(packet);
    },
    send() {},
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => setImmediate(resolve));
}

function itemPush(playerGuid, itemId) {
  // Player::SendNewItem writes the receiver's GUID even when broadcast to the whole group.
  return new PacketWriter().u64(playerGuid).u32(0).u32(0).u32(1)
    .u8(255).i32(23).u32(itemId).u32(0).i32(0).u32(1).u32(1).toUint8Array();
}

test("a group member's loot push never confirms an item in my bags", async () => {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  client.state.selfGuid = 0x1234n;
  let messageEvents = 0;
  client.onItemMessage = () => { messageEvents++; };
  try {
    connection.push(OPCODES.SMSG_ITEM_PUSH_RESULT, itemPush(0x7777n, 2589));
    await settle();
    assert.equal(client.itemMessage, undefined, "a group broadcast is not my loot receipt");
    assert.equal(messageEvents, 0);

    connection.push(OPCODES.SMSG_ITEM_PUSH_RESULT, itemPush(0x1234n, 4306));
    await settle();
    assert.deepEqual(client.itemMessage, { text: "Получено: предмет 4306 ×1", error: false });
    assert.equal(messageEvents, 1, "my own loot is still confirmed");

    connection.push(OPCODES.SMSG_ITEM_PUSH_RESULT, itemPush(0x7777n, 6948));
    await settle();
    assert.deepEqual(client.itemMessage, { text: "Получено: предмет 4306 ×1", error: false },
      "the peer's later loot cannot replace my own result");
    assert.equal(messageEvents, 1);
  } finally {
    client.close();
  }
});
