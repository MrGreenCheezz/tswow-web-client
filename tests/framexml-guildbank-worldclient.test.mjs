import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { PacketReader } from "../dist/code/protocol/PacketReader.js";
import {
  buildGuildBankMoveItem, buildGuildBankWithdrawItemTo, buildSetGuildBankText,
  GE_BANK_MONEY_SET, GE_BANK_TAB_UPDATED,
} from "../dist/code/world/GuildBankProtocol.js";

// The stock GuildBankFrame's packets beside the native window's: the three CMSG shapes stock needs
// in TrinityCore's reader layouts (GuildPackets.cpp GuildBankSwapItems::Read, GuildBankSetTabText::Read),
// and the GUILD_BANK_CHANGED edges that carry each SMSG_GUILD_BANK_LIST as it arrived, a tab's text
// and the bank's SMSG_GUILD_EVENTs (Guild.cpp _SendBankList, BankTab::SendText, _BroadcastEvent).

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) { const resume = wake; wake = undefined; resume(queue.shift()); }
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
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();
  return { client, connection };
}

const BANKER = 0xf1100000b3000200n;

/** GuildBankQueryResults::Write: money, tab, withdrawals left, full flag, [tab infos], items. */
function bankList(tabId, fullUpdate, items, tabs = []) {
  const writer = new PacketWriter().u64(1_000_000n).u8(tabId).i32(4).u8(fullUpdate ? 1 : 0);
  if (tabId === 0 && fullUpdate) {
    writer.u8(tabs.length);
    for (const [name, icon] of tabs) writer.cString(name).cString(icon);
  }
  writer.u8(items.length);
  for (const [slot, itemId, count] of items) {
    writer.u8(slot).u32(itemId);
    if (itemId) writer.i32(0).i32(0).i32(count).i32(0).u8(0).u8(0);
  }
  return writer.toUint8Array();
}

test("the three stock-only CMSG shapes read back in TrinityCore's field order", () => {
  // BankOnly: dest (tab, slot, item), src (tab, slot, item), AutoStore, BankItemCount.
  const move = new PacketReader(buildGuildBankMoveItem(BANKER, 0, 3, 2589, 2, 97, 818, 5));
  assert.deepEqual([move.u64(), move.u8(), move.u8(), move.u8(), move.u32(), move.u8(), move.u8(), move.u32(), move.u8(), move.i32()],
    [BANKER, 1, 2, 97, 818, 0, 3, 2589, 0, 5]);
  move.assertFinished();
  // Not BankOnly, not AutoStore: tab, slot, item, AutoStore 0, ContainerSlot, ContainerItemSlot, ToSlot (toChar) 1, StackCount.
  const withdraw = new PacketReader(buildGuildBankWithdrawItemTo(BANKER, 1, 7, 13446, 255, 25, 2));
  assert.deepEqual([withdraw.u64(), withdraw.u8(), withdraw.u8(), withdraw.u8(), withdraw.u32(), withdraw.u8(),
    withdraw.u8(), withdraw.u8(), withdraw.u8(), withdraw.i32()], [BANKER, 0, 1, 7, 13446, 0, 255, 25, 1, 2]);
  withdraw.assertFinished();
  const text = new PacketReader(buildSetGuildBankText(1, "Зелья"));
  assert.deepEqual([text.u8(), text.cString()], [1, "Зелья"]);
  text.assertFinished();
});

test("stock's commands send exactly their opcodes, and only while a banker is named", async () => {
  const { client, connection } = await loggedIn();
  connection.sent.length = 0;
  try {
    client.moveGuildBankItem(0, 1, 2589, 0, 2, 0);
    client.withdrawGuildBankItemTo(0, 1, 2589, 255, 23);
    client.queryGuildBankTab(1);
    assert.deepEqual(connection.sent, [], "no banker: the vault commands are dropped");
    client.openGuildBank(BANKER);
    connection.sent.length = 0;
    client.queryGuildBankTab(1);
    client.requestGuildBankText(1);
    client.setGuildBankText(1, "Зелья");
    client.requestGuildBankMoneyWithdrawn();
    client.moveGuildBankItem(0, 1, 2589, 1, 2, 0, 5);
    client.withdrawGuildBankItemTo(0, 1, 2589, 255, 23);
    assert.deepEqual(connection.sent.map((packet) => packet.opcode), [
      OPCODES.CMSG_GUILD_BANK_QUERY_TAB, OPCODES.MSG_QUERY_GUILD_BANK_TEXT, OPCODES.CMSG_SET_GUILD_BANK_TEXT,
      OPCODES.MSG_GUILD_BANK_MONEY_WITHDRAWN, OPCODES.CMSG_GUILD_BANK_SWAP_ITEMS, OPCODES.CMSG_GUILD_BANK_SWAP_ITEMS,
    ], "QueryGuildBankTab asks for the tab alone; stock asks for its text separately");
    assert.deepEqual([...connection.sent[0].payload], [...new PacketWriter().u64(BANKER).u8(1).u8(1).toUint8Array()],
      "GuildBankQueryTab::Read: banker, tab, full update");
    assert.deepEqual([...connection.sent[4].payload], [...buildGuildBankMoveItem(BANKER, 0, 1, 2589, 1, 2, 0, 5)]);
  } finally {
    client.close?.();
  }
});

test("every bank list reaches GUILD_BANK_CHANGED as it arrived, beside the world's one held tab", async () => {
  const { client, connection } = await loggedIn();
  const changes = [];
  client.events.on("GUILD_BANK_CHANGED", (change) => changes.push(change));
  try {
    client.openGuildBank(BANKER);
    connection.push(OPCODES.SMSG_GUILD_BANK_LIST, bankList(0, true, [[0, 2589, 20], [4, 818, 3]], [["Общее", "INV_Misc_Bag_10"]]));
    // Another member moves something on tab 2: TrinityCore's partial list for that tab.
    connection.push(OPCODES.SMSG_GUILD_BANK_LIST, bankList(2, false, [[5, 0, 0]]));
    connection.push(OPCODES.MSG_QUERY_GUILD_BANK_TEXT, new PacketWriter().u8(1).cString("Зелья").toUint8Array());
    // _BroadcastEvent(GE_BANK_MONEY_SET, "{:016X}") and GE_BANK_TAB_UPDATED (tab, name, icon); GE_MOTD is not the bank's.
    connection.push(OPCODES.SMSG_GUILD_EVENT, new PacketWriter().u8(GE_BANK_MONEY_SET).u8(1).cString("00000000000F4240").toUint8Array());
    connection.push(OPCODES.SMSG_GUILD_EVENT, new PacketWriter().u8(GE_BANK_TAB_UPDATED).u8(3).cString("1").cString("Зелья").cString("INV_Potion_54").toUint8Array());
    connection.push(OPCODES.SMSG_GUILD_EVENT, new PacketWriter().u8(2).u8(1).cString("Привет").toUint8Array());
    connection.push(OPCODES.MSG_GUILD_BANK_MONEY_WITHDRAWN, new PacketWriter().i32(-1).toUint8Array());
    await settle();
    assert.equal(changes.length, 6);
    assert.equal(changes[0].list.tabId, 0);
    assert.deepEqual(changes[0].list.tabs, [{ name: "Общее", icon: "INV_Misc_Bag_10" }]);
    assert.deepEqual(changes[1].list.items.map((item) => [item.slot, item.itemId]), [[5, 0]],
      "the partial list as it arrived, its emptied slot included");
    assert.equal(client.guildBank.tabId, 2, "while the world replaced its held tab 0 with it");
    assert.deepEqual(changes[2], { textTab: 1 });
    assert.deepEqual(changes[3], { guildEvent: { type: GE_BANK_MONEY_SET, params: ["00000000000F4240"] } });
    assert.deepEqual(changes[4], { guildEvent: { type: GE_BANK_TAB_UPDATED, params: ["1", "Зелья", "INV_Potion_54"] } });
    assert.deepEqual(changes[5], {}, "the allowance, like the logs and permissions, is read from the world");
  } finally {
    client.close?.();
  }
});
