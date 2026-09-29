import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import {
  TRADE_STATUS_BACK_TO_TRADE,
  TRADE_STATUS_BEGIN_TRADE,
  TRADE_STATUS_CLOSE_WINDOW,
  TRADE_STATUS_NOT_ON_TAPLIST,
  TRADE_STATUS_OPEN_WINDOW,
  TRADE_STATUS_TRADE_ACCEPT,
  TRADE_STATUS_TRADE_COMPLETE,
} from "../dist/code/world/TradeProtocol.js";
import { firstFreeTradeSlot } from "../dist/code/world/TradeProtocol.js";

function fakeConnection() {
  const queue = [{
    opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    payload: new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(4).toUint8Array(),
  }];
  let pending;
  return {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { pending = resolve; });
    },
    feed(opcode, payload) {
      const packet = { opcode, payload };
      if (!pending) { queue.push(packet); return; }
      const resolve = pending;
      pending = undefined;
      resolve(packet);
    },
    close() {},
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const status = (code, guid) => {
  const writer = new PacketWriter().u32(code);
  if (guid !== undefined) writer.u64(guid);
  else if (code === TRADE_STATUS_OPEN_WINDOW) writer.u32(0);
  return writer.toUint8Array();
};

test("incoming trade request waits for explicit begin, then open and reset follow server statuses", async () => {
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  await world.loginCharacter(1n);
  await settle();

  connection.feed(OPCODES.SMSG_TRADE_STATUS, status(TRADE_STATUS_BEGIN_TRADE, 0x77n));
  await settle();
  assert.equal(world.tradePending, true);
  assert.equal(world.tradeOpen, false, "a request is not yet an open exchange");
  assert.equal(world.tradePartnerGuid, 0x77n);
  assert.equal(connection.sent.some(({ opcode }) => opcode === OPCODES.CMSG_BEGIN_TRADE), false);

  const before = connection.sent.length;
  world.offerTradeItem(0, 0, 5);
  world.acceptTrade();
  assert.equal(connection.sent.length, before, "an unopened request cannot offer or accept items");
  world.beginTrade();
  world.beginTrade();
  assert.equal(connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_BEGIN_TRADE).length, 1);
  assert.equal(world.tradeBeginRequested, true);

  connection.feed(OPCODES.SMSG_TRADE_STATUS, status(TRADE_STATUS_OPEN_WINDOW));
  await settle();
  assert.equal(world.tradePending, false);
  assert.equal(world.tradeOpen, true);
  assert.equal(world.tradeBeginRequested, false);
  world.offerTradeItem(0, 255, 23);
  world.offerTradeItem(1, 255, 24);
  assert.deepEqual(world.ownTradeOffer().items.map(({ slot }) => slot), [0, 1],
    "the core echoes own item changes only to the partner, so local slots must be reserved");
  assert.equal(firstFreeTradeSlot(world.ownTradeOffer().items.map(({ slot }) => slot)), 2);
  world.offerTradeGold(12345);
  assert.equal(world.ownTradeOffer().money, 12345);
  world.acceptTrade();
  assert.equal(connection.sent.at(-1).opcode, OPCODES.CMSG_ACCEPT_TRADE);

  connection.feed(OPCODES.SMSG_TRADE_STATUS, status(TRADE_STATUS_TRADE_ACCEPT));
  await settle();
  assert.equal(world.tradePartnerAccepted, true);
  world.offerTradeGold(10_000);
  assert.equal(world.tradePartnerAccepted, false, "changing an offer cannot keep a stale agreement lit");
  connection.feed(OPCODES.SMSG_TRADE_STATUS, status(TRADE_STATUS_BACK_TO_TRADE));
  await settle();
  assert.equal(world.tradePartnerAccepted, false, "the server revokes agreement when an offer changes");

  connection.feed(OPCODES.SMSG_TRADE_STATUS, new PacketWriter().u32(TRADE_STATUS_NOT_ON_TAPLIST).u8(1).toUint8Array());
  await settle();
  assert.deepEqual(world.ownTradeOffer().items.map(({ slot }) => slot), [0],
    "a rejected slot is available again without closing the window");
  world.clearTradeItem(0);
  assert.deepEqual(world.ownTradeOffer().items, []);

  connection.feed(OPCODES.SMSG_TRADE_STATUS, status(TRADE_STATUS_TRADE_COMPLETE));
  await settle();
  assert.equal(world.tradeOpen, false);
  assert.equal(world.tradePartnerGuid, 0n);
  assert.deepEqual(world.ownTradeOffer().items, []);
  world.close();
});

test("declining an incoming request sends cancel and clears pending state", async () => {
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  await world.loginCharacter(1n);
  await settle();
  connection.feed(OPCODES.SMSG_TRADE_STATUS, status(TRADE_STATUS_BEGIN_TRADE, 0x88n));
  await settle();
  world.cancelTrade();
  assert.equal(connection.sent.at(-1).opcode, OPCODES.CMSG_CANCEL_TRADE);
  assert.equal(world.tradePending, false);
  assert.equal(world.tradePartnerGuid, 0n);
  world.close();
});

test("a CLOSE_WINDOW inventory result survives the hidden trade window as a system chat line", async () => {
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  const shown = [];
  world.onChatMessage = (message) => shown.push(message);
  await world.loginCharacter(1n);
  await settle();

  const closeWith = (result, targetResult) => new PacketWriter()
    .u32(TRADE_STATUS_CLOSE_WINDOW).u32(result).u8(targetResult ? 1 : 0).u32(0).toUint8Array();
  connection.feed(OPCODES.SMSG_TRADE_STATUS, status(TRADE_STATUS_OPEN_WINDOW));
  await settle();
  connection.feed(OPCODES.SMSG_TRADE_STATUS, closeWith(29, false));
  await settle();
  assert.equal(world.tradeOpen, false);
  assert.equal(shown.at(-1)?.text, "Обмен не завершён: Не хватает денег");
  assert.equal(world.chatLog.at(-1)?.text, shown.at(-1)?.text,
    "the error remains in the chat backlog after the trade window closes");

  connection.feed(OPCODES.SMSG_TRADE_STATUS, status(TRADE_STATUS_OPEN_WINDOW));
  await settle();
  connection.feed(OPCODES.SMSG_TRADE_STATUS, closeWith(4, true));
  await settle();
  assert.equal(shown.at(-1)?.text, "Обмен не завершён: У партнёра: Сумка заполнена");
  const messagesBeforeEmptyResult = shown.length;
  connection.feed(OPCODES.SMSG_TRADE_STATUS, closeWith(0, false));
  await settle();
  assert.equal(shown.length, messagesBeforeEmptyResult, "result OK does not invent an error");
  world.close();
});
