import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { lfgRewardSystemLines } from "../dist/code/world/LfgRewardMessages.js";
import { itemRefundMoneyText } from "../dist/code/world/ItemRefundProtocol.js";
import { formatGlobalStringByName } from "../dist/code/world/GlobalStringFormat.js";

// 3.25 (11.11): Wow.exe 0x0055bdc0 (SMSG_LFG_PLAYER_REWARD) prints game messages 0xa1 ERR_QUEST_REWARD_EXP_I and
// 0xa4 ERR_QUEST_REWARD_MONEY_S (type 0: system lines) for the base experience, strangers × experience per
// stranger, the base money and strangers × money per stranger — each only above zero — before LFG_COMPLETION_REWARD.

const exp = (amount) => formatGlobalStringByName("ERR_QUEST_REWARD_EXP_I", [amount], "Получено опыта: %d.");
const money = (amount) => formatGlobalStringByName("ERR_QUEST_REWARD_MONEY_S", [itemRefundMoneyText(amount)], "Получено: %s.");

const reward = (fields) => ({ randomEntry: 258, dungeonEntry: 36,
  reward: { done: false, money: fields.money ?? 0, experience: fields.experience ?? 0, items: [] },
  strangers: fields.strangers ?? 0, moneyVar: fields.moneyVar ?? 0, experienceVar: fields.experienceVar ?? 0 });

test("the order and the zero rule of 0x0055bdc0's lines", () => {
  assert.deepEqual(lfgRewardSystemLines(reward({ money: 13_150, experience: 4_200, strangers: 2, moneyVar: 500, experienceVar: 300 })),
    [exp(4_200), exp(600), money(13_150), money(1_000)]);
  assert.deepEqual(lfgRewardSystemLines(reward({ money: 0, experience: 0, strangers: 1 })), [], "nothing above zero, no line");
  assert.deepEqual(lfgRewardSystemLines(reward({ money: 2_500, experience: 900, strangers: 1 })), [exp(900), money(2_500)],
    "TrinityCore's reward: per-stranger words 0");
  assert.match(money(13_150), /1/);
});

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) { const resume = wake; wake = undefined; resume(queue.shift()); }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload: [...payload] }); },
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

test("WorldClient prints the reward's lines as system chat when the packet lands", async () => {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  client.state.selfGuid = 0x42n;
  await client.loginCharacter(0x42n);
  await settle();
  const lines = [];
  client.events.on("CHAT_MESSAGE", (message) => lines.push(message.text));
  // LFGHandler.cpp SendLfgPlayerReward: random, dungeon, done, 1 (strangers), money, xp, 0, 0, items.
  connection.push(OPCODES.SMSG_LFG_PLAYER_REWARD,
    new PacketWriter().u32(258).u32(36).u8(0).u32(1).u32(2_500).u32(900).u32(0).u32(0).u8(0).toUint8Array());
  await settle();
  assert.deepEqual(lines, [exp(900), money(2_500)]);
  client.close();
});
