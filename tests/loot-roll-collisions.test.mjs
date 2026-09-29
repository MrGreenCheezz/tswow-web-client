import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { activeRolls } from "../dist/code/browser/ui/LootRollModel.js";

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

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(connection);
  await world.loginCharacter(0x1234n);
  connection.sent.length = 0;
  return { world, connection };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => setImmediate(resolve));
}

function startRoll(itemGuid, itemId, slot = 1) {
  return new PacketWriter()
    .u64(itemGuid).u32(0).u32(slot).u32(itemId).u32(0).i32(0).u32(1)
    .u32(60_000).u8(0x07).toUint8Array();
}

test("two concurrent rolls in the same corpse slot stay distinct and choose their own GUID", async () => {
  const { world, connection } = await loggedIn();
  try {
    connection.push(OPCODES.SMSG_LOOT_START_ROLL, startRoll(0x101n, 4306));
    connection.push(OPCODES.SMSG_LOOT_START_ROLL, startRoll(0x202n, 4307));
    await settle();

    assert.equal(world.lootRolls.size, 2, "the second corpse must not replace the first roll");
    assert.deepEqual(activeRolls(world.lootRolls, Date.now()).map((roll) => roll.start.itemGuid),
      [0x101n, 0x202n], "both dialogs remain actionable");

    world.rollForLoot(0x101n, 1);
    world.rollForLoot(0x202n, 2);
    const sent = connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_LOOT_ROLL);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map(({ payload }) => new DataView(payload.buffer, payload.byteOffset).getBigUint64(0, true)),
      [0x101n, 0x202n]);
    assert.deepEqual(sent.map(({ payload }) => new DataView(payload.buffer, payload.byteOffset).getUint32(8, true)),
      [1, 1], "both rolls still use the server's per-corpse slot index");
  } finally { world.close(); }
});

test("zero-GUID result never closes the wrong one of two identical rolls", async () => {
  const { world, connection } = await loggedIn();
  try {
    connection.push(OPCODES.SMSG_LOOT_START_ROLL, startRoll(0x303n, 4306));
    connection.push(OPCODES.SMSG_LOOT_START_ROLL, startRoll(0x404n, 4306));
    await settle();

    const won = new PacketWriter()
      .u64(0n).u32(1).u32(4306).u32(0).i32(0).u64(0x1234n).u8(55).u8(1)
      .toUint8Array();
    connection.push(OPCODES.SMSG_LOOT_ROLL_WON, won);
    await settle();
    assert.equal(world.lootRolls.get(0x303n)?.won, undefined);
    assert.equal(world.lootRolls.get(0x404n)?.won, undefined,
      "the core omits the GUID in a won packet, so two identical rolls cannot be distinguished yet");

    connection.push(OPCODES.SMSG_LOOT_ALL_PASSED,
      new PacketWriter().u64(0x404n).u32(1).u32(4306).i32(0).u32(0).toUint8Array());
    await settle();
    assert.equal(world.lootRolls.get(0x404n)?.passed, true);
    assert.equal(world.lootRolls.get(0x303n)?.passed, undefined);

    connection.push(OPCODES.SMSG_LOOT_ROLL_WON, won);
    await settle();
    assert.equal(world.lootRolls.get(0x303n)?.won?.winnerGuid, 0x1234n);
  } finally { world.close(); }
});
