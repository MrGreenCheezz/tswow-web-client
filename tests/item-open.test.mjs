import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      const packet = { opcode, payload };
      if (wake) { const resume = wake; wake = undefined; resume(packet); }
      else queue.push(packet);
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
  for (let round = 0; round < 6; round++) await new Promise((resolve) => setImmediate(resolve));
}

async function fixture(entry, instanceFlags = 0) {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  const itemGuid = 0x8765n;
  const player = { fields: new Map() };
  const offset = UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset;
  player.fields.set(offset, Number(itemGuid));
  player.fields.set(offset + 1, 0);
  client.state.selfGuid = 0x1234n;
  client.state.objects.set(0x1234n, player);
  client.state.objects.set(itemGuid, { fields: new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry],
    [UPDATE_FIELDS.ITEM_FIELD_FLAGS.offset, instanceFlags],
  ]) });
  connection.sent.length = 0;
  return { client, connection, itemGuid, player };
}

function itemAnswer(entry, flags) {
  const writer = new PacketWriter()
    .u32(entry).u32(0).u32(0).i32(-1).cString("Item").cString("").cString("").cString("")
    .u32(0).u32(1).u32(flags).u32(0).i32(0).u32(0).u32(0).u32(0xffffffff).u32(0xffffffff);
  for (let index = 0; index < 9; index++) writer.u32(0);
  writer.i32(0).i32(1).u32(0).u32(0).u32(0); // max, stack, slots, stats, scaling distribution
  writer.u32(0); // scaling value
  for (let index = 0; index < 2; index++) writer.f32(0).f32(0).u32(0);
  for (let index = 0; index < 7; index++) writer.u32(0);
  writer.u32(0).u32(0).f32(0);
  for (let index = 0; index < 5; index++) writer.i32(0).u32(0).i32(0).i32(-1).u32(0).i32(-1);
  writer.u32(0).cString("");
  for (let index = 0; index < 25; index++) writer.u32(0);
  writer.f32(0).u32(0).u32(0).u32(0);
  return writer.toUint8Array();
}

function itemPackets(connection) {
  return connection.sent.map(({ opcode }) => opcode).filter((opcode) =>
    opcode === OPCODES.CMSG_ITEM_QUERY_SINGLE || opcode === OPCODES.CMSG_OPEN_ITEM || opcode === OPCODES.CMSG_USE_ITEM);
}

test("known loot containers and wrapped gifts send OPEN_ITEM, consumables send USE_ITEM", async () => {
  for (const [templateFlags, instanceFlags, expected] of [
    [4, 0, OPCODES.CMSG_OPEN_ITEM],
    [0, 8, OPCODES.CMSG_OPEN_ITEM],
    [0, 0, OPCODES.CMSG_USE_ITEM],
  ]) {
    const { client, connection, itemGuid } = await fixture(60001, instanceFlags);
    try {
      client.itemTemplates.set(60001, { entry: 60001, found: true, flags: templateFlags });
      client.useItem(255, 23, itemGuid);
      assert.deepEqual(itemPackets(connection), [expected]);
      if (expected === OPCODES.CMSG_OPEN_ITEM) {
        assert.deepEqual([...connection.sent[0].payload], [255, 23]);
      }
    } finally { client.close(); }
  }
});

test("cold item query waits for the realm's flags, then resumes only the same slot", async () => {
  const { client, connection, itemGuid, player } = await fixture(60002);
  try {
    client.useItem(255, 23, itemGuid);
    assert.deepEqual(itemPackets(connection), [OPCODES.CMSG_ITEM_QUERY_SINGLE]);
    connection.push(OPCODES.SMSG_ITEM_QUERY_SINGLE_RESPONSE, itemAnswer(60002, 4));
    await settle();
    assert.deepEqual(itemPackets(connection), [
      OPCODES.CMSG_ITEM_QUERY_SINGLE, OPCODES.CMSG_OPEN_ITEM,
    ]);
  } finally { client.close(); }

  const second = await fixture(60003);
  try {
    second.client.useItem(255, 23, second.itemGuid);
    second.player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, 0);
    second.connection.push(OPCODES.SMSG_ITEM_QUERY_SINGLE_RESPONSE, itemAnswer(60003, 4));
    await settle();
    assert.deepEqual(itemPackets(second.connection), [OPCODES.CMSG_ITEM_QUERY_SINGLE],
      "an item moved before the answer must not open whatever replaced it");
  } finally { second.client.close(); }

  const consumable = await fixture(60004);
  try {
    consumable.client.useItem(255, 23, consumable.itemGuid);
    consumable.connection.push(OPCODES.SMSG_ITEM_QUERY_SINGLE_RESPONSE, itemAnswer(60004, 0));
    await settle();
    assert.deepEqual(itemPackets(consumable.connection), [
      OPCODES.CMSG_ITEM_QUERY_SINGLE, OPCODES.CMSG_USE_ITEM,
    ], "an ordinary item still works on its first use");
  } finally { consumable.client.close(); }

  const wrapped = await fixture(60005, 8);
  try {
    wrapped.client.useItem(255, 23, wrapped.itemGuid);
    assert.deepEqual(itemPackets(wrapped.connection), [OPCODES.CMSG_OPEN_ITEM],
      "the instance WRAPPED flag needs no template query");
  } finally { wrapped.client.close(); }
});
