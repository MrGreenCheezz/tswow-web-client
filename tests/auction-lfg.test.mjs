import assert from "node:assert/strict";
import test from "node:test";
import {
  AUCTION_FILTER_ANY,
  ERR_AUCTION_INVENTORY,
  auctionErrorText,
  buildAuctionListItems,
  buildAuctionPlaceBid,
  buildAuctionSellItem,
  nextBid,
  parseAuctionCommandResult,
  parseAuctionHello,
  parseAuctionListResult,
} from "../dist/code/world/AuctionProtocol.js";
import {
  LFG_ROLE_DAMAGE,
  LFG_ROLE_TANK,
  buildLfgJoin,
  buildLfgProposalResult,
  buildLfgSetRoles,
  lfgJoinResultText,
  parseLfgJoinResult,
  parseLfgProposalUpdate,
  parseLfgQueueStatus,
  parseLfgUpdate,
  rolesText,
} from "../dist/code/world/LfgProtocol.js";

const encoder = new TextEncoder();
function bytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
const u8 = (value) => Uint8Array.from([value & 0xff]);
const u32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
};
const i32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, true);
  return out;
};
const u64 = (value) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
};
const cstr = (value) => bytes(encoder.encode(value), u8(0));

// AuctionEntry::BuildAuctionInfo writes a fixed 148 bytes with no conditional fields.
function auctionEntry({ id = 1, itemId = 2589, count = 1, startBid = 100, minIncrement = 0, buyout = 0, timeLeft = 60000, bid = 0 }) {
  const parts = [u32(id), u32(itemId)];
  for (let slot = 0; slot < 7 * 3; slot++) parts.push(u32(0));
  parts.push(i32(-42), u32(0), u32(count), u32(0), u32(0), u64(7n), u32(startBid), u32(minIncrement), u32(buyout), u32(timeLeft), u64(0n), u32(bid));
  return bytes(...parts);
}

test("an auction entry is a fixed 148 bytes and the count leads the packet", () => {
  const entry = auctionEntry({ id: 5, itemId: 2589, count: 3, startBid: 500, bid: 700, minIncrement: 35, buyout: 5000 });
  assert.equal(entry.length, 148);

  const payload = bytes(u32(1), entry, u32(9), u32(1500));
  const list = parseAuctionListResult(payload);
  assert.equal(list.entries.length, 1);
  assert.equal(list.totalCount, 9, "the total trails the entries, not leads them");
  assert.equal(list.searchDelay, 1500);
  assert.equal(list.entries[0].auctionId, 5);
  assert.equal(list.entries[0].count, 3);
  assert.equal(list.entries[0].randomPropertyId, -42, "the property id is signed");
  assert.equal(list.entries[0].timeLeft, 60000);
  assert.equal(nextBid(list.entries[0]), 735, "current bid plus the increment");
  assert.equal(nextBid({ ...list.entries[0], bid: 0 }), 500, "start bid on an untouched lot");
});

test("the auction command result grows only for an inventory error", () => {
  const plain = parseAuctionCommandResult(bytes(i32(5), i32(2), i32(3)));
  assert.deepEqual(plain, { auctionId: 5, command: 2, error: 3, bagResult: 0 });
  assert.match(auctionErrorText(3), /денег/i);

  const withBag = parseAuctionCommandResult(bytes(i32(5), i32(0), i32(ERR_AUCTION_INVENTORY), i32(50)));
  assert.equal(withBag.bagResult, 50);
  assert.match(auctionErrorText(99), /99/);
});

test("auction hello and the client packets match the handlers", () => {
  assert.deepEqual(parseAuctionHello(bytes(u64(0x77n), u32(2), u8(1))), { auctioneerGuid: 0x77n, houseId: 2, enabled: true });

  // The search puts quality, a uint32, before the usable byte, and ends with a sort block.
  const search = buildAuctionListItems(0x77n, { name: "меч", levelMin: 10 });
  assert.deepEqual(
    [...search],
    [...bytes(u64(0x77n), u32(0), cstr("меч"), u8(10), u8(0),
      u32(AUCTION_FILTER_ANY), u32(AUCTION_FILTER_ANY), u32(AUCTION_FILTER_ANY), u32(AUCTION_FILTER_ANY),
      u8(0), u8(0), u8(0))],
  );

  assert.deepEqual([...buildAuctionPlaceBid(0x77n, 5, 900)], [...bytes(u64(0x77n), u32(5), u32(900))]);
  // The duration is in minutes and the item array is counted first.
  assert.deepEqual(
    [...buildAuctionSellItem(0x77n, [{ guid: 0x11n, count: 2 }], 100, 500, 720)],
    [...bytes(u64(0x77n), u32(1), u64(0x11n), u32(2), u32(100), u32(500), u32(720))],
  );
});

test("an empty LFG lock map omits even its count byte", () => {
  const empty = parseLfgJoinResult(bytes(u32(5), u32(0)));
  assert.equal(empty.result, 5);
  assert.deepEqual(empty.lockedPlayers, []);
  assert.match(lfgJoinResultText(5), /не подходите/i);

  const locked = parseLfgJoinResult(bytes(u32(6), u32(0), u8(1), u64(0x11n), u32(2), u32(100), u32(1), u32(200), u32(2)));
  assert.equal(locked.lockedPlayers.length, 1);
  assert.equal(locked.lockedPlayers[0].guid, 0x11n);
  assert.deepEqual(locked.lockedPlayers[0].dungeons, [{ dungeonId: 100, reason: 1 }, { dungeonId: 200, reason: 2 }]);
});

test("the queue status puts the average wait before the player's own", () => {
  const status = parseLfgQueueStatus(bytes(u32(258), i32(120000), i32(-1), i32(60000), i32(-1), i32(90000), u8(1), u8(0), u8(2), u32(300)));
  assert.equal(status.dungeonId, 258);
  assert.equal(status.waitTimeAverage, 120000);
  assert.equal(status.waitTime, -1, "unknown waits arrive as signed -1");
  assert.equal(status.tanksNeeded, 1);
  assert.equal(status.damageNeeded, 2);
  assert.equal(status.queuedSeconds, 300);
});

test("the player and party updates differ by seven bytes of header", () => {
  // With no dungeons both forms are exactly two bytes.
  assert.deepEqual(parseLfgUpdate(bytes(u8(4), u8(0)), false), { updateType: 4, joined: false, queued: false, dungeons: [], comment: "" });
  assert.deepEqual(parseLfgUpdate(bytes(u8(4), u8(0)), true).dungeons, []);

  const player = parseLfgUpdate(bytes(u8(6), u8(1), u8(1), u8(0), u8(0), u8(2), u32(258), u32(259), cstr("го")), false);
  assert.equal(player.queued, true);
  assert.deepEqual(player.dungeons, [258, 259]);
  assert.equal(player.comment, "го");

  // The party form inserts a join byte and three needs bytes around the same fields.
  const party = parseLfgUpdate(bytes(u8(6), u8(1), u8(1), u8(1), u8(0), u8(0), u8(0), u8(0), u8(0), u8(1), u32(258), cstr("")), true);
  assert.equal(party.queued, true);
  assert.deepEqual(party.dungeons, [258]);
});

test("a proposal player block is a fixed nine bytes", () => {
  const payload = bytes(
    u32(258), u8(2), u32(77), u32(0), u8(1), u8(2),
    u32(LFG_ROLE_TANK), u8(1), u8(0), u8(0), u8(1), u8(1),
    u32(LFG_ROLE_DAMAGE), u8(0), u8(0), u8(0), u8(0), u8(0),
  );
  const proposal = parseLfgProposalUpdate(payload);
  assert.equal(proposal.proposalId, 77);
  assert.equal(proposal.players.length, 2);
  assert.equal(proposal.players[0].self, true);
  assert.equal(proposal.players[0].accepted, true);
  assert.equal(proposal.players[1].answered, false);
  assert.match(rolesText(LFG_ROLE_TANK), /танк/);
});

test("LFG client packets match their reads", () => {
  // LFGJoin::Read discards a needs count and then reads exactly three needs bytes.
  assert.deepEqual(
    [...buildLfgJoin(LFG_ROLE_DAMAGE, [258, 259], "го")],
    [...bytes(u32(LFG_ROLE_DAMAGE), u8(0), u8(0), u8(2), u32(258), u32(259), u8(3), u8(0), u8(0), u8(0), cstr("го"))],
  );
  assert.deepEqual([...buildLfgSetRoles(LFG_ROLE_TANK)], [LFG_ROLE_TANK]);
  assert.deepEqual([...buildLfgProposalResult(77, true)], [...bytes(u32(77), u8(1))]);
});
