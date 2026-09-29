import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import {
  AUCTION_CANCEL,
  AUCTION_PLACE_BID,
  AUCTION_SELL_ITEM,
  buildAuctionListItems,
  buildAuctionListOwnerItems,
  buildAuctionListBidderItems,
  isLeadingBid,
  parseAuctionListResult,
} from "../dist/code/world/AuctionProtocol.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";

// Q3: «Мои ставки» — the tab the bidder list result finally has to land in.
//
// The core appends every auction with the player in its bidders set itself
// (`BuildListBidderItems`), so the request carries no id list; the outbid ids it accepts are
// for the client to refresh rows it already shows.

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

test("the bidder request is guid plus two ignored words, nothing else", () => {
  // guid(8), listfrom u32 (read and ignored), outbiddedCount u32, then the ids.
  const empty = buildAuctionListBidderItems(0x0102_0304_0506_0708n);
  assert.equal(empty.length, 16);
  const view = new DataView(empty.buffer, empty.byteOffset);
  assert.equal(view.getBigUint64(0, true), 0x0102_0304_0506_0708n);
  assert.equal(view.getUint32(8, true), 0);
  assert.equal(view.getUint32(12, true), 0);

  const withIds = buildAuctionListBidderItems(1n, [11, 22]);
  assert.equal(withIds.length, 24);
  const ids = new DataView(withIds.buffer, withIds.byteOffset);
  assert.equal(ids.getUint32(12, true), 2);
  assert.equal(ids.getUint32(16, true), 11);
  assert.equal(ids.getUint32(20, true), 22);
});

test("leading means my counter holds the lot, and only while a bid stands", () => {
  // `bidder` rides widened from a 32-bit counter (BuildAuctionInfo); the player's own counter
  // is the low 32 bits of their guid.
  const me = 0xf140_0058_9abc_def0n;
  assert.equal(isLeadingBid({ bid: 150, bidderLow: 0x9abc_def0n }, me), true);
  assert.equal(isLeadingBid({ bid: 150, bidderLow: 0x1234n }, me), false, "somebody else's counter is an outbid");
  assert.equal(isLeadingBid({ bid: 0, bidderLow: 0x9abc_def0n }, me), false, "no bid is no lead");
});

test("bidder results land in their own list, never in the owner one", async () => {
  const { client, connection } = await loggedIn();
  try {
    const bids = () => connection.sent.filter((entry) => entry.opcode === OPCODES.CMSG_AUCTION_LIST_BIDDER_ITEMS);
    client.auctioneerGuid = 0x77n;
    client.listBidderAuctions();
    assert.equal(bids().length, 1);
    assert.equal(bids()[0].payload.length, 16, "no id list: the server appends the bids itself");

    // A closed client and a closed window both stay silent.
    client.closeAuctionHouse();
    client.listBidderAuctions();
    assert.equal(bids().length, 1, "no auctioneer, no packet");

    // An empty bidder answer parses like every other list and lands apart from owner lots.
    const empty = new PacketWriter().u32(0).u32(0).u32(0).toUint8Array();
    connection.push(OPCODES.SMSG_AUCTION_BIDDER_LIST_RESULT, empty);
    await settle();
    assert.deepEqual(client.bidAuctions, parseAuctionListResult(empty));
    assert.equal(client.ownAuctions, undefined);
  } finally {
    client.close();
  }
});

test("successful auction actions refresh the affected lists and keep the current search", async () => {
  const { client, connection } = await loggedIn();
  try {
    client.auctioneerGuid = 0x77n;
    const search = { name: "меч", page: 3, quality: 2 };
    client.searchAuctions(search);
    client.listOwnAuctions();
    connection.sent.length = 0;

    const result = (command) => new PacketWriter().i32(12).i32(command).i32(0).toUint8Array();
    connection.push(OPCODES.SMSG_AUCTION_COMMAND_RESULT, result(AUCTION_PLACE_BID));
    await settle();
    assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [
      OPCODES.CMSG_AUCTION_LIST_ITEMS, OPCODES.CMSG_AUCTION_LIST_BIDDER_ITEMS,
    ], "a successful bid updates both the filtered search and My bids");
    assert.deepEqual(connection.sent[0].payload, buildAuctionListItems(0x77n, search),
      "the result must not reset the selected filters or page");

    connection.sent.length = 0;
    connection.push(OPCODES.SMSG_AUCTION_COMMAND_RESULT, result(AUCTION_SELL_ITEM));
    await settle();
    assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [
      OPCODES.CMSG_AUCTION_LIST_ITEMS, OPCODES.CMSG_AUCTION_LIST_OWNER_ITEMS,
    ], "a new own lot appears on My auctions without reopening the tab");
    assert.deepEqual(connection.sent[1].payload, buildAuctionListOwnerItems(0x77n),
      "a sale refresh requests the complete owner list; local page selection stays in the UI");

    connection.sent.length = 0;
    connection.push(OPCODES.SMSG_AUCTION_COMMAND_RESULT, result(AUCTION_CANCEL));
    await settle();
    assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [
      OPCODES.CMSG_AUCTION_LIST_ITEMS, OPCODES.CMSG_AUCTION_LIST_OWNER_ITEMS,
    ], "a removed own lot disappears without reopening the tab");
  } finally {
    client.close();
  }
});

test("the window owns a third tab with leading/outbid badges", async () => {
  const [markup, social, windows] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/ui/Social.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/ui/Windows.ts", import.meta.url), "utf8"),
  ]);
  assert.match(markup, /id="auction-bids"/, "the tab button is static markup");
  assert.match(social, /setAuctionTab/, "the tab is explicit state, not last-list-wins");
  assert.match(social, /bidAuctions/, "the bids list has its own slot");
  assert.match(social, /isLeadingBid\(entry, self\)/, "each bid row knows who leads it");
  assert.match(social, /Ведете.*Перебита|Перебита.*Ведете/, "in the player's own words");
  assert.match(windows, /listBidderAuctions/, "the tab asks the server when opened");
});
