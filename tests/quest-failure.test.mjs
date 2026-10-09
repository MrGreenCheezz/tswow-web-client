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

test("quest failure shows the inventory reason after the quest's name, never its id (1.32)", async () => {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(connection);
  try {
    await world.loginCharacter(0x1234n);
    connection.push(OPCODES.SMSG_QUESTGIVER_QUEST_FAILED,
      new PacketWriter().u32(3456).u32(50).toUint8Array());
    await settle();
    assert.match(world.questMessage?.text ?? "", /^Задание: /, "no title cached yet: the word, not the id");
    assert.doesNotMatch(world.questMessage?.text ?? "", /3456/);
    assert.match(world.questMessage?.text ?? "", /Инвентарь заполнен/);
    assert.doesNotMatch(world.questMessage?.text ?? "", /код 3456/);

    connection.push(OPCODES.SMSG_QUESTGIVER_QUEST_INVALID,
      new PacketWriter().u32(7).toUint8Array());
    await settle();
    assert.doesNotMatch(world.questMessage?.text ?? "", /код 7/,
      "QUEST_INVALID has only a reason, spoken in the stock words (1.32)");
    assert.match(world.questMessage?.text ?? "", /выполн/);
  } finally { world.close(); }
});

test("paid quest completion reports money spent from the signed server reward word", async () => {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(connection);
  try {
    await world.loginCharacter(0x1234n);
    // Player::SendQuestReward writes GetRewOrReqMoney as a uint32 packet word,
    // preserving a negative turn-in cost in two's complement.
    connection.push(OPCODES.SMSG_QUESTGIVER_QUEST_COMPLETE,
      new PacketWriter().u32(43).u32(300).i32(-125).u32(0).u32(0).u32(0).toUint8Array());
    await settle();
    assert.match(world.questMessage?.text ?? "", /Задание выполнено.*списано 125 медных/);
    assert.doesNotMatch(world.questMessage?.text ?? "", /4294967171/);
  } finally { world.close(); }
});
