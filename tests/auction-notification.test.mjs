import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketReader } from "../dist/code/protocol/PacketReader.js";
import {
  auctionBidderNotificationPacket, auctionOwnerNotificationPacket, clientControlUpdatePacket, settle, travelClient,
} from "./fixtures/world-packets.mjs";

// 1.21. SMSG_AUCTION_BIDDER_NOTIFICATION is one packet for "you won" and "you were outbid": the
// winner hears its own guid with bid and difference zero (AuctionHouseMgr.cpp:173), the outbid
// player hears the NEW bidder's guid, the new price and the outbid step (:277). "Mine" is the
// character's guid, not the unit it steers: in a vehicle that is the vehicle, and under fear or a
// charm (`allowed = 0`) it is nobody, and both used to turn a won lot into «перебили».
const SELF = 0x1234n;
const VEHICLE = 0xf150_7a00_0000_0099n;
const RIVAL = 0x5678n;
const ITEM = 13446;

function changesOf(client) {
  const changes = [];
  client.events.on("AUCTION_STATE_CHANGED", (change) => changes.push(change));
  return changes;
}

/** A name the query cache would hold once CMSG_ITEM_QUERY_SINGLE was answered. */
function knowItem(client, entry, name) {
  client.itemTemplates.set(entry, { entry, found: true, name });
}

test("a lot won while steering a vehicle is still won, and says so without a price", async () => {
  const { client, connection } = await travelClient([
    // The server hands the vehicle over (Player::SetClientControl): controlledGuid is the vehicle.
    { opcode: OPCODES.SMSG_CLIENT_CONTROL_UPDATE, payload: clientControlUpdatePacket(VEHICLE, true) },
  ], SELF);
  const changes = changesOf(client);
  knowItem(client, ITEM, "Большой эликсир маны");
  try {
    assert.equal(client.controlledGuid, VEHICLE);
    connection.push(OPCODES.SMSG_AUCTION_BIDDER_NOTIFICATION,
      auctionBidderNotificationPacket({ auctionId: 3004, bidder: SELF, itemEntry: ITEM }));
    await settle();
    assert.equal(changes.at(-1)?.won, true);
    assert.equal(client.auctionMessage?.error, false);
    assert.equal(client.auctionMessage?.text, "Вы выиграли торги. Куплен предмет: Большой эликсир маны.");
    assert.doesNotMatch(client.auctionMessage.text, /\d/, "no lot number and no «за 0»: the packet carries no price");
  } finally {
    client.close();
  }
});

test("a lot won while the character is feared or charmed is still won", async () => {
  const { client, connection } = await travelClient([
    // `allowed = 0`: the client may move nothing, and controlledGuid becomes undefined.
    { opcode: OPCODES.SMSG_CLIENT_CONTROL_UPDATE, payload: clientControlUpdatePacket(SELF, false) },
  ], SELF);
  const changes = changesOf(client);
  try {
    assert.equal(client.controlledGuid, undefined);
    connection.push(OPCODES.SMSG_AUCTION_BIDDER_NOTIFICATION,
      auctionBidderNotificationPacket({ auctionId: 3004, bidder: SELF, itemEntry: ITEM }));
    await settle();
    assert.equal(changes.at(-1)?.won, true);
    // The item is not in the cache yet: the word stands in for the name, and the name is asked for.
    assert.equal(client.auctionMessage?.text, "Вы выиграли торги. Куплен предмет: предмет.");
    assert.doesNotMatch(client.auctionMessage.text, /\d/);
    const queries = connection.sentOf(OPCODES.CMSG_ITEM_QUERY_SINGLE);
    assert.equal(queries.length, 1);
    assert.equal(new PacketReader(queries[0].payload).u32(), ITEM);
  } finally {
    client.close();
  }
});

test("another bidder's guid is an outbid, in the stock words", async () => {
  const { client, connection } = await travelClient([], SELF);
  const changes = changesOf(client);
  knowItem(client, ITEM, "Большой эликсир маны");
  try {
    connection.push(OPCODES.SMSG_AUCTION_BIDDER_NOTIFICATION,
      auctionBidderNotificationPacket({ auctionId: 3004, bidder: RIVAL, bid: 26_000, diff: 1_300, itemEntry: ITEM }));
    await settle();
    assert.deepEqual(changes.at(-1),
      { kind: "bidderNotification", auctionId: 3004, itemId: ITEM, won: false, bid: 26_000 });
    assert.equal(client.auctionMessage?.error, true);
    assert.equal(client.auctionMessage?.text, "Большой эликсир маны: предмет перекуплен.");
  } finally {
    client.close();
  }
});

test("before the self CREATE names the character, the unit the server handed over stands in", async () => {
  // The login's own SMSG_CLIENT_CONTROL_UPDATE names the character itself; a notification arriving
  // before the self CREATE is read against it (and a stale controlled unit is never preferred to
  // the character once the character is known — the first test).
  const { client, connection } = await travelClient([], SELF);
  const changes = changesOf(client);
  try {
    client.state.selfGuid = undefined;
    connection.push(OPCODES.SMSG_AUCTION_BIDDER_NOTIFICATION,
      auctionBidderNotificationPacket({ auctionId: 1, bidder: SELF, itemEntry: ITEM }));
    await settle();
    assert.equal(changes.at(-1)?.won, false, "nobody named yet: nothing to compare with");
    connection.push(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, clientControlUpdatePacket(SELF, true));
    connection.push(OPCODES.SMSG_AUCTION_BIDDER_NOTIFICATION,
      auctionBidderNotificationPacket({ auctionId: 2, bidder: SELF, itemEntry: ITEM }));
    await settle();
    assert.equal(client.state.selfGuid, undefined);
    assert.equal(changes.at(-1)?.won, true, "the controlled unit is the character here");
    connection.push(OPCODES.SMSG_AUCTION_BIDDER_NOTIFICATION,
      auctionBidderNotificationPacket({ auctionId: 3, bidder: RIVAL, bid: 900, itemEntry: ITEM }));
    await settle();
    assert.equal(changes.at(-1)?.won, false);
  } finally {
    client.close();
  }
});

test("the owner hears a sale, and an expiry without a bid, by the item's name", async () => {
  const { client, connection } = await travelClient([], SELF);
  knowItem(client, 2589, "Льняная ткань");
  try {
    connection.push(OPCODES.SMSG_AUCTION_OWNER_NOTIFICATION, auctionOwnerNotificationPacket({ auctionId: 3011, bid: 600, itemEntry: 2589 }));
    await settle();
    // ERR_AUCTION_SOLD_S keeps its Lua quotes escaped in the generated table; they print as quotes.
    assert.equal(client.auctionMessage?.text, "На ваш товар \"Льняная ткань\" нашелся покупатель.");
    // SendAuctionExpiredMail sends the same packet with no bid (AuctionHouseMgr.cpp:250).
    connection.push(OPCODES.SMSG_AUCTION_OWNER_NOTIFICATION, auctionOwnerNotificationPacket({ auctionId: 3011, bid: 0, itemEntry: 2589 }));
    await settle();
    assert.equal(client.auctionMessage?.text, "Ваш товар (Льняная ткань) снят с аукциона.");
  } finally {
    client.close();
  }
});
