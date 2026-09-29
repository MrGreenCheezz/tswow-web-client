import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { AUCTION_PLACE_BID, AUCTION_SELL_ITEM, parseAuctionListResult } from "../dist/code/world/AuctionProtocol.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";

// The world edges the stock AuctionFrame model hears (AUCTION_STATE_CHANGED beside the native
// `onAuctionChanged`), from packets in TrinityCore's own layouts (AuctionHouseHandler.cpp), and the
// multi-stack CMSG_AUCTION_SELL_ITEM a multisell lot needs.

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

test("every auction packet raises one AUCTION_STATE_CHANGED beside the native callback", async () => {
  const { client, connection } = await loggedIn();
  const changes = [];
  let native = 0;
  client.events.on("AUCTION_STATE_CHANGED", (change) => changes.push(change));
  client.onAuctionChanged = () => { native += 1; };
  // SMSG_CLIENT_CONTROL_UPDATE hands the player its own body; the fake login stops short of it.
  client.controlledGuid = 0x1234n;
  try {
    client.openAuctionHouse(0x77n);
    // SendAuctionHello: guid, AuctionHouse.dbc id, enabled byte.
    connection.push(OPCODES.MSG_AUCTION_HELLO, new PacketWriter().u64(0x77n).u32(7).u8(1).toUint8Array());
    const empty = new PacketWriter().u32(0).u32(0).u32(300).toUint8Array();
    connection.push(OPCODES.SMSG_AUCTION_LIST_RESULT, empty);
    connection.push(OPCODES.SMSG_AUCTION_OWNER_LIST_RESULT, empty);
    connection.push(OPCODES.SMSG_AUCTION_BIDDER_LIST_RESULT, empty);
    // SendAuctionCommandResult: id, command, error, and the bag result only for ERR_AUCTION_INVENTORY.
    connection.push(OPCODES.SMSG_AUCTION_COMMAND_RESULT, new PacketWriter().i32(3100).i32(AUCTION_SELL_ITEM).i32(0).toUint8Array());
    connection.push(OPCODES.SMSG_AUCTION_COMMAND_RESULT, new PacketWriter().i32(0).i32(AUCTION_SELL_ITEM).i32(1).i32(3).toUint8Array());
    // SendAuctionBidderNotification: house, auction, bidder, bid, diff, item, 0 — the bidder is the player: a win.
    connection.push(OPCODES.SMSG_AUCTION_BIDDER_NOTIFICATION, new PacketWriter().u32(7).u32(3004).u64(0x1234n).u32(26_000).u32(1300).u32(13446).u32(0).toUint8Array());
    // SendAuctionOwnerNotification: id, bid, 0, 0 (u64), item, 0, 0.0f.
    connection.push(OPCODES.SMSG_AUCTION_OWNER_NOTIFICATION, new PacketWriter().u32(3011).u32(600).u32(0).u64(0n).u32(2589).u32(0).f32(0).toUint8Array());
    await settle();
    client.closeAuctionHouse();
    assert.deepEqual(changes, [
      { kind: "hello", enabled: true, houseId: 7, searched: true },
      { kind: "list" }, { kind: "owner" }, { kind: "bidder" },
      { kind: "result", auctionId: 3100, command: AUCTION_SELL_ITEM, error: 0, bagResult: 0, refreshed: ["list", "owner"] },
      { kind: "result", auctionId: 0, command: AUCTION_SELL_ITEM, error: 1, bagResult: 3, refreshed: [] },
      { kind: "bidderNotification", auctionId: 3004, itemId: 13446, won: true, bid: 26_000 },
      { kind: "ownerNotification", auctionId: 3011, itemId: 2589, bid: 600 },
      { kind: "closed" },
    ]);
    assert.equal(native, changes.length, "the native window's single slot still hears every edge");
    assert.deepEqual(client.auctions, undefined, "closing clears the lists before the edge");
    void parseAuctionListResult;
  } finally {
    client.close();
  }
});

test("while stock owns the house a hello sends no opening search, and each refresh is named", async () => {
  const { client, connection } = await loggedIn();
  const changes = [];
  client.events.on("AUCTION_STATE_CHANGED", (change) => changes.push(change));
  const lists = () => connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_AUCTION_LIST_ITEMS).length;
  const hello = () => new PacketWriter().u64(0x77n).u32(2).u8(1).toUint8Array();
  try {
    // The stock model's predicate (FrameXmlAuction.ts attach): false while it owns the house.
    client.auctionHelloSearch = () => false;
    client.openAuctionHouse(0x77n);
    connection.push(OPCODES.MSG_AUCTION_HELLO, hello());
    await settle();
    assert.equal(lists(), 0, "the 3.3.5 client sends no search on open; stock waits for its Search button");
    assert.deepEqual(changes.at(-1), { kind: "hello", enabled: true, houseId: 2, searched: false });
    // Not owned (the add-on still loading, or failed): the native window's opening search, as before.
    client.auctionHelloSearch = () => true;
    client.openAuctionHouse(0x77n);
    connection.push(OPCODES.MSG_AUCTION_HELLO, hello());
    await settle();
    assert.equal(lists(), 1);
    assert.equal(changes.at(-1).searched, true);
    // A bid's refresh: the current search, then the bidder list, named in that order.
    connection.push(OPCODES.SMSG_AUCTION_COMMAND_RESULT, new PacketWriter().i32(12).i32(AUCTION_PLACE_BID).i32(0).toUint8Array());
    await settle();
    assert.deepEqual(changes.at(-1).refreshed, ["list", "bidder"]);
    assert.deepEqual(connection.sent.slice(-2).map(({ opcode }) => opcode),
      [OPCODES.CMSG_AUCTION_LIST_ITEMS, OPCODES.CMSG_AUCTION_LIST_BIDDER_ITEMS]);
  } finally {
    client.close();
  }
});

test("a multisell lot gathers several stacks in one CMSG_AUCTION_SELL_ITEM", async () => {
  const { client, connection } = await loggedIn();
  const sells = () => connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_AUCTION_SELL_ITEM);
  try {
    client.createAuctionFromStacks([{ guid: 0x4000_0101n, count: 5 }], 100, 0, 1440);
    assert.equal(sells().length, 0, "no auctioneer, no packet");
    client.auctioneerGuid = 0x77n;
    client.createAuctionFromStacks([], 100, 0, 1440);
    assert.equal(sells().length, 0, "an empty lot is not sent");
    client.createAuctionFromStacks([{ guid: 0x4000_0101n, count: 5 }, { guid: 0x4000_0102n, count: 10 }], 390, 600, 1440);
    const [sent] = sells();
    assert.equal(sent.opcode, OPCODES.CMSG_AUCTION_SELL_ITEM);
    // HandleAuctionSellItem: auctioneer, itemsCount, count × (guid, count), bid, buyout, etime (minutes).
    assert.deepEqual(sent.payload, new PacketWriter().u64(0x77n).u32(2)
      .u64(0x4000_0101n).u32(5).u64(0x4000_0102n).u32(10).u32(390).u32(600).u32(1440).toUint8Array());
  } finally {
    client.close();
  }
});
