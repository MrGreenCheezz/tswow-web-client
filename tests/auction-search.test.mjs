import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AUCTION_SORT_BUYOUT_ASC,
  AUCTION_SORT_PRICE_ASC,
  AUCTION_SORT_PRICE_DESC,
  AUCTION_SORT_TIME_LEFT,
  auctionPrice,
  buildAuctionListItems,
  sortAuctionEntries,
} from "../dist/code/world/AuctionProtocol.js";

// G4: the window already filters and paginates server-side — the missing piece was ordering
// the answered page without another round trip.

const lot = (auctionId, { bid = 0, startBid = 100, buyout = 0, timeLeft = 3600000 } = {}) => ({
  auctionId, itemId: 1000 + auctionId, randomPropertyId: 0, suffixFactor: 0, count: 1,
  spellCharges: 0, itemFlags: 0, ownerLow: 5n, startBid, minIncrement: 5, buyout,
  timeLeft, bidderLow: 0n, bid,
});

test("browse page numbers use TrinityCore's 50-lot listfrom offset", () => {
  const listfrom = (page) => {
    const request = buildAuctionListItems(0x77n, { page, name: "меч" });
    return new DataView(request.buffer, request.byteOffset, request.byteLength).getUint32(8, true);
  };
  assert.equal(listfrom(0), 0);
  assert.equal(listfrom(1), 50, "the second page starts after the first 50 lots");
  assert.equal(listfrom(3), 150, "the page label is not the server's item offset");
});

test("the price is the leading bid, or the opening price before the first one", () => {
  assert.equal(auctionPrice(lot(1, { bid: 0, startBid: 100 })), 100);
  assert.equal(auctionPrice(lot(2, { bid: 150, startBid: 100 })), 150);
});

test("a page sorts by price, time and buyout without shuffling ties", () => {
  const entries = [
    lot(1, { startBid: 300, timeLeft: 3000, buyout: 900 }),
    lot(2, { bid: 150, startBid: 100, timeLeft: 1000, buyout: 0 }),
    lot(3, { startBid: 150, timeLeft: 2000, buyout: 400 }),
  ];
  assert.deepEqual(
    sortAuctionEntries(entries, AUCTION_SORT_PRICE_ASC).map((entry) => entry.auctionId),
    [2, 3, 1],
    "bid 150 and start 150 tie and keep the server's order",
  );
  assert.deepEqual(
    sortAuctionEntries(entries, AUCTION_SORT_PRICE_DESC).map((entry) => entry.auctionId),
    [1, 2, 3],
  );
  assert.deepEqual(
    sortAuctionEntries(entries, AUCTION_SORT_TIME_LEFT).map((entry) => entry.auctionId),
    [2, 3, 1],
  );
  assert.deepEqual(
    sortAuctionEntries(entries, AUCTION_SORT_BUYOUT_ASC).map((entry) => entry.auctionId),
    [3, 1, 2],
    "lots without a buyout sink below every priced one",
  );
  assert.deepEqual(entries.map((entry) => entry.auctionId), [1, 2, 3], "the server's page is not mutated");
});

test("the complete owner result pages locally without losing later lots", () => {
  const all = Array.from({ length: 51 }, (_, index) => lot(index + 1));
  assert.deepEqual(sortAuctionEntries(all, AUCTION_SORT_PRICE_ASC, 0).map((entry) => entry.auctionId),
    Array.from({ length: 50 }, (_, index) => index + 1));
  assert.deepEqual(sortAuctionEntries(all, AUCTION_SORT_PRICE_ASC, 1).map((entry) => entry.auctionId), [51]);
  assert.deepEqual(sortAuctionEntries(all.slice(0, 50), AUCTION_SORT_PRICE_ASC, 1).map((entry) => entry.auctionId),
    Array.from({ length: 50 }, (_, index) => index + 1),
    "after removing the last lot, the owner page returns to the last populated page");
  assert.equal(all.length, 51, "paging does not discard the server's full owner list");
});

test("owner page arrows use the local list instead of resending an ignored server offset", async () => {
  const [social, windows] = await Promise.all([
    readFile(new URL("../src/browser/ui/Social.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/ui/Windows.ts", import.meta.url), "utf8"),
  ]);
  assert.match(social, /sortAuctionEntries\(list\?\.entries \?\? \[\], sort, isOwn \? auctionOwnerPage : undefined\)/);
  assert.match(windows, /auction-prev[\s\S]{0,250}changeAuctionOwnerPage\(-1\)/);
  assert.match(windows, /auction-next[\s\S]{0,250}changeAuctionOwnerPage\(1\)/);
  assert.doesNotMatch(windows, /listOwnAuctions\(auctionOwnPage\)/);
});

test("the auction window orders the answered page from the sort control", async () => {
  const source = await readFile(new URL("../src/browser/ui/Social.ts", import.meta.url), "utf8");
  assert.match(source, /getElementById\("auction-sort"\)/, "the select is read by id like the other filters");
  assert.match(source, /sortAuctionEntries\(list\?\.entries \?\? \[\], sort, isOwn \? auctionOwnerPage : undefined\)/,
    "the answered page is ordered, with a local slice only for the complete owner list");
});
