import assert from "node:assert/strict";
import test from "node:test";

// LiveWorldSeam's auction wiring over a real item projection (FrameXmlAuctionLive.ts): the stock bag
// cursor fills the sell slot, the sell item shows locked in the bags and cannot be picked up, a
// right-clicked bag item goes into the slot while the Auctions tab shows, bound and timed items are
// refused from their own update fields, a lot spans stacks, and canUse reads the template's masks.

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { EventBus } = await import("../dist/code/world/EventBus.js");

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
const field = (name) => UPDATE_FIELDS[name].offset;

function place(fields, offset, guid) {
  fields.set(offset, Number(guid & 0xffffffffn));
  fields.set(offset + 1, Number(guid >> 32n));
}

function item(guid, entry, extra = []) {
  return { guid, fields: new Map([[field("OBJECT_FIELD_ENTRY"), entry], ...extra]) };
}

const template = (name, fields = {}) => ({
  found: true, name, quality: 1, requiredLevel: 0, sellPrice: 13, stackable: 20, flags: 0, allowableClass: -1, allowableRace: -1, ...fields,
});

function fixture() {
  // A level 60 human (race 1) warrior (class 1): UNIT_FIELD_BYTES_0 is race | class << 8.
  const player = { guid: 1n, fields: new Map([[field("UNIT_FIELD_BYTES_0"), 0x0101], [field("UNIT_FIELD_LEVEL"), 60]]) };
  const bag = [
    item(2n, 2589, [[field("ITEM_FIELD_STACK_COUNT"), 20]]),
    item(3n, 2589, [[field("ITEM_FIELD_STACK_COUNT"), 7]]),
    item(4n, 6948, [[field("ITEM_FIELD_FLAGS"), 1]]), // soulbound
    item(5n, 7079, [[field("ITEM_FIELD_DURATION"), 3600]]), // a timed item
  ];
  bag.forEach((object, index) => place(player.fields, field("PLAYER_FIELD_PACK_SLOT_1") + index * 2, object.guid));
  const sent = [];
  const events = new EventBus();
  const world = {
    events,
    state: { selfGuid: player.guid, objects: new Map([[player.guid, player], ...bag.map((object) => [object.guid, object])]) },
    names: new Map(), selfName: "Игрок",
    itemTemplates: new Map([
      [2589, template("Льняной материал")],
      [6948, template("Камень возвращения", { sellPrice: 0, stackable: 1 })],
      [7079, template("Сфера времени", { stackable: 1 })],
      [43412, template("Символ волшебной брони", { sellPrice: 0, stackable: 1, allowableClass: 1 << 7 })],
    ]),
    itemTemplate: (entry) => world.itemTemplates.get(entry),
    // What LiveWorldSeam.attach reads of a world (casts in flight, the action bar, cooldowns).
    casts: new Map(), channels: new Map(), actionButtons: [], creatureTemplates: new Map(), questTemplates: new Map(),
    cooldownRemaining: () => 0,
    mailboxGuid: 0n, tradeOpen: false, tradePartnerGuid: 0n,
    auctioneerGuid: 0n, auctions: undefined, ownAuctions: undefined, bidAuctions: undefined,
    searchAuctions: (search) => sent.push(["search", search]),
    listOwnAuctions: () => sent.push(["owner"]),
    listBidderAuctions: () => sent.push(["bidder"]),
    bidOnAuction: (...args) => sent.push(["bid", ...args]),
    cancelAuction: (...args) => sent.push(["cancel", ...args]),
    createAuction: (...args) => sent.push(["sell", ...args]),
    createAuctionFromStacks: (...args) => sent.push(["sellStacks", ...args]),
    closeAuctionHouse: () => sent.push(["close"]),
    useItem: (...args) => sent.push(["use", ...args]),
    moveItem: (...args) => sent.push(["move", ...args]),
    ownTradeOffer: () => ({ money: 0, spellId: 0, items: [] }),
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    itemInfo: (entry) => world.itemTemplates.has(entry) ? { name: world.itemTemplates.get(entry).name, quality: 1 } : undefined,
  });
  const fired = [];
  seam.auction.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
  // GlobalStrings by their keys, so a refusal names itself.
  seam.auction.useGlobalStrings((name) => name);
  return { world, seam, sent, fired, events };
}

/** Blizzard_AuctionUI loaded and gated, then MSG_AUCTION_HELLO. */
function openHouse({ world, seam, events }) {
  seam.auction.owned = true;
  world.auctioneerGuid = 0xf130n;
  events.emit("AUCTION_STATE_CHANGED", { kind: "hello", enabled: true, houseId: 2 });
}

test("the bag cursor fills the live sell slot, which is locked in the bags and totals every carried stack", () => {
  const context = fixture();
  const { seam, sent, fired } = context;
  assert.equal(context.world.auctionHelloSearch(), true, "not owned yet: the world keeps its opening search");
  openHouse(context);
  assert.equal(context.world.auctionHelloSearch(), false);
  assert.deepEqual(fired.map(([event]) => event), ["AUCTION_HOUSE_SHOW"]);
  call("PickupContainerItem", seam, 0, 1);
  assert.deepEqual(call("CursorHasItem", seam), [true]);
  call("ClickAuctionSellItemButton", seam);
  assert.deepEqual(call("CursorHasItem", seam), [false], "the sell slot took the cursor's item");
  const info = call("GetAuctionSellItemInfo", seam);
  assert.deepEqual([info[0], info[2], info[6], info[7], info[8]], ["Льняной материал", 20, 13, 20, 27],
    "name, the stack, the vendor price per unit, the stack size and all 20 + 7 carried");
  assert.equal(call("GetContainerItemInfo", seam, 0, 1)[2], true, "the sell item is locked in the bags");
  assert.equal(call("GetContainerItemInfo", seam, 0, 2)[2], undefined);
  call("PickupContainerItem", seam, 0, 1);
  assert.deepEqual(call("CursorHasItem", seam), [false], "a locked bag item is not picked up");
  // 25 of 27: one lot gathered from both stacks, the sell slot's first.
  call("StartAuction", seam, 300, 0, 2, 25, 1);
  assert.deepEqual(sent.filter(([kind]) => kind.startsWith("sell")), [
    ["sellStacks", [{ guid: 2n, count: 20 }, { guid: 3n, count: 5 }], 300, 0, 1440],
  ]);
});

test("a right click goes into the sell slot while the Auctions tab shows; bound and timed items are refused", () => {
  const context = fixture();
  const { seam, sent, fired } = context;
  openHouse(context);
  call("UseContainerItem", seam, 0, 2);
  assert.deepEqual(sent.map(([kind]) => kind), ["use"], "the Browse tab: an ordinary use");
  call("SetAuctionsTabShowing", seam, true);
  call("UseContainerItem", seam, 0, 2);
  assert.equal(sent.length, 1, "the Auctions tab: no use packet");
  assert.deepEqual(call("GetAuctionSellItemInfo", seam).slice(0, 3), ["Льняной материал", undefined, 7]);
  call("SetAuctionsTabShowing", seam, false);
  call("UseContainerItem", seam, 0, 2);
  assert.equal(sent.length, 1, "the sell item is locked: not used from another tab either");
  call("SetAuctionsTabShowing", seam, true);
  fired.length = 0;
  call("UseContainerItem", seam, 0, 3);
  call("UseContainerItem", seam, 0, 4);
  assert.deepEqual(fired, [["UI_ERROR_MESSAGE", "ERR_AUCTION_BOUND_ITEM"], ["UI_ERROR_MESSAGE", "ERR_AUCTION_LIMITED_DURATION_ITEM"]],
    "ITEM_FIELD_FLAGS' soulbound bit and ITEM_FIELD_DURATION, in the client's words");
  assert.equal(sent.length, 1, "no packet for a refused item");
  assert.equal(call("GetAuctionSellItemInfo", seam)[2], 7, "the slot keeps its item");
});

test("canUse reads the template's AllowableClass against the player's class", () => {
  const context = fixture();
  const { world, seam, events } = context;
  openHouse(context);
  call("QueryAuctionItems", seam, "", "", "", undefined, undefined, undefined, 0);
  const lot = (auctionId, itemId) => ({
    auctionId, itemId, randomPropertyId: 0, suffixFactor: 0, count: 1, spellCharges: 0, itemFlags: 0, ownerLow: 0x5001n,
    startBid: 100, minIncrement: 0, buyout: 0, timeLeft: 3_600_000, bidderLow: 0n, bid: 0,
  });
  world.auctions = { searchDelay: 300, totalCount: 2, entries: [lot(1, 43412), lot(2, 2589)] };
  events.emit("AUCTION_STATE_CHANGED", { kind: "list" });
  call("SortAuctionClearSort", seam, "list");
  call("SortAuctionApplySort", seam, "list");
  assert.deepEqual([1, 2].map((index) => call("GetAuctionItemInfo", seam, "list", index)[4]), [undefined, true],
    "a mage-only glyph for a warrior: nil, which stock tints red");
});
