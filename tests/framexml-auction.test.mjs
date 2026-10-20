import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { AUCTION_PLACE_BID, AUCTION_SELL_ITEM, parseAuctionListResult } from "../dist/code/world/AuctionProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-auction-live-seam.test.mjs
{
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
}

// ── framexml-auction-seam.test.mjs
{
// The stock AuctionFrame's C API (FrameXmlAuction.ts) over the canned auction house. No MPQ: the
// model answers exactly what Blizzard_AuctionUI.lua reads, in the order it reads it; the vertical
// test (framexml-auction-vertical) runs the real add-on on top of this.
const {
  FrameXmlAuctionModel, FRAMEXML_AUCTION_BINDINGS, FRAMEXML_AUCTION_CLASSES, FRAMEXML_AUCTION_INV_TYPES, frameXmlAuctionDeposit,
} = await import("../dist/code/browser/framexml/FrameXmlAuction.js");
const {
  createCannedFrameXmlAuction, frameXmlCannedAuctionLots, frameXmlCannedOwnAuctions, FRAMEXML_CANNED_AUCTION_ITEMS,
  FRAMEXML_CANNED_AUCTIONEER_GUID,
} = await import("../dist/code/browser/framexml/FrameXmlAuctionCanned.js");
const { AUCTION_CANCEL, AUCTION_PLACE_BID, AUCTION_SELL_ITEM } = await import("../dist/code/world/AuctionProtocol.js");

const STRINGS = {
  ERR_AUCTION_STARTED: "Аукцион создан.", ERR_AUCTION_REMOVED: "Аукцион отменен.", ERR_AUCTION_BID_PLACED: "Ставка принята.",
  ERR_AUCTION_BID_OWN: "Вы не можете делать ставку на свой собственный лот.", ERR_NOT_ENOUGH_MONEY: "Недостаточно денег",
  ERR_AUCTION_BOUND_ITEM: "Невозможно выставить на торги персональный предмет.",
  ERR_AUCTION_CONJURED_ITEM: "Нельзя продавать сотворенные предметы.",
  ERR_AUCTION_LIMITED_DURATION_ITEM: "Нельзя продавать предмет с ограниченным сроком действия.",
  ERR_AUCTION_OUTBID_S: "Ваша ставка на «%s» перебита.", ERR_AUCTION_WON_S: "Вы выиграли аукцион: %s.",
  ERR_AUCTION_SOLD_S: "Ваш лот (%s) продан.", ERR_AUCTION_EXPIRED_S: "Срок вашего лота истек: %s", UNKNOWN: "Неизвестно",
};

function pump() {
  const events = [];
  let now = 100;
  return {
    events,
    fire(event, ...args) { events.push([event, ...args]); return 1; },
    now: () => now,
    advance(seconds) { now += seconds; },
    names() { return events.map(([event]) => event); },
    clear() { events.length = 0; },
  };
}

/** A model over the canned house, attached, owned, with GlobalStrings and an open house. */
function owned(context = {}) {
  const canned = createCannedFrameXmlAuction(context);
  const events = pump();
  canned.model.attach(events);
  canned.model.useGlobalStrings((name) => STRINGS[name]);
  canned.model.owned = true;
  canned.world.open();
  return { ...canned, events };
}

const call = (model, name, ...args) => FRAMEXML_AUCTION_BINDINGS[name]({ auction: model }, args);

test("the browse filters are the client's twelve classes, visible subclasses and armour slot table", () => {
  assert.deepEqual(call(undefined, "GetAuctionItemClasses"), [
    "Оружие", "Доспехи", "Сумки", "Расходуемые", "Символы", "Хозяйственные товары", "Боеприпасы", "Амуниция",
    "Рецепты", "Самоцветы", "Разное", "Задания",
  ], "Wow.exe's class list (2,4,1,0,16,7,6,11,9,3,15,12) named from ItemClass.dbc");
  assert.equal(call(undefined, "GetAuctionItemSubClasses", 1).length, 17, "no obsolete, exotic or spear rows");
  assert.deepEqual(call(undefined, "GetAuctionItemSubClasses", 4).slice(0, 3), ["Еда и напитки", "Зелья", "Эликсиры"],
    "consumables in ItemSubClass.dbc row order, not subclass-id order");
  assert.deepEqual(call(undefined, "GetAuctionItemSubClasses", 12), [], "Quest has no subclasses");
  // GetAuctionInvTypes: fourteen token/flag pairs for armour Misc/Cloth/Leather/Mail/Plate only.
  const shown = (classIndex, subIndex) => {
    const values = call(undefined, "GetAuctionInvTypes", classIndex, subIndex);
    const tokens = [];
    for (let at = 0; at < values.length; at += 2) if (values[at + 1] === 1) tokens.push(values[at]);
    return { pairs: values.length / 2, tokens };
  };
  assert.deepEqual(shown(2, 1), { pairs: 14, tokens: ["INVTYPE_HEAD", "INVTYPE_NECK", "INVTYPE_BODY", "INVTYPE_FINGER", "INVTYPE_TRINKET", "INVTYPE_HOLDABLE"] });
  assert.deepEqual(shown(2, 2).tokens, ["INVTYPE_HEAD", "INVTYPE_SHOULDER", "INVTYPE_CHEST", "INVTYPE_WAIST", "INVTYPE_LEGS",
    "INVTYPE_FEET", "INVTYPE_WRIST", "INVTYPE_HAND", "INVTYPE_CLOAK"], "Cloth adds Back");
  assert.deepEqual(shown(2, 5).tokens, ["INVTYPE_HEAD", "INVTYPE_SHOULDER", "INVTYPE_CHEST", "INVTYPE_WAIST", "INVTYPE_LEGS",
    "INVTYPE_FEET", "INVTYPE_WRIST", "INVTYPE_HAND"], "Plate: the eight armour slots");
  assert.deepEqual(call(undefined, "GetAuctionInvTypes", 2, 6), [], "Shields carry no slot list");
  assert.deepEqual(call(undefined, "GetAuctionInvTypes", 1, 1), [], "weapons carry no slot list");
});

const DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc/";
test("the class table re-reads this dataset's ItemClass.dbc and ItemSubClass.dbc", {
  skip: existsSync(`${DBC}ItemSubClass.dbc`) ? false : "no dataset DBCs on this machine",
}, () => {
  const read = (name) => {
    const b = readFileSync(DBC + name);
    const records = b.readUInt32LE(4), fields = b.readUInt32LE(8), size = b.readUInt32LE(12);
    const strings = 20 + records * size;
    const str = (offset) => { let end = strings + offset; while (b[end]) end++; return b.subarray(strings + offset, end).toString("utf8"); };
    return { str, rows: Array.from({ length: records }, (_, r) => Array.from({ length: fields }, (__, i) => b.readUInt32LE(20 + r * size + i * 4))) };
  };
  const classes = read("ItemClass.dbc");
  const subclasses = read("ItemSubClass.dbc");
  // ruRU is locale column 8 of each string block; DisplayFlags bit 2 hides a row; Flags 0x200 has slots.
  const measured = FRAMEXML_AUCTION_CLASSES.map(({ id }, index) => ({
    id,
    name: classes.str(classes.rows.find((row) => row[0] === id)[3 + 8]),
    subclasses: index === 11 ? [] : subclasses.rows.filter((row) => row[0] === id && (row[5] & 2) === 0).map((row) => ({
      id: row[1], name: subclasses.str(row[27 + 8]) || subclasses.str(row[10 + 8]), invTypes: (row[4] & 0x200) !== 0,
    })),
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(FRAMEXML_AUCTION_CLASSES)), measured);
  assert.equal(FRAMEXML_AUCTION_INV_TYPES.length, 14);
});

test("QueryAuctionItems maps the stock indices through the client's tables, and waits for its answer", () => {
  const { model, world, events } = owned();
  assert.deepEqual(call(model, "CanSendAuctionQuery", "list"), [true, true]);
  // text, minLevel, maxLevel, invTypeIndex, classIndex, subclassIndex, page, usable, rarity
  call(model, "QueryAuctionItems", "плащ", "10", "", 13, 2, 2, 2, 1, 3);
  assert.deepEqual(world.calls.at(-1), { kind: "search", search: {
    name: "плащ", levelMin: 10, inventoryType: 16, itemClass: 4, itemSubClass: 1, page: 2, quality: 3, usableOnly: true,
  } }, "Доспехи → class 4, its second visible subclass → Cloth (1), slot row 13 → INVTYPE_CLOAK (16)");
  assert.deepEqual(call(model, "CanSendAuctionQuery", "list"), [undefined, undefined], "an answer is outstanding");
  events.advance(6);
  assert.deepEqual(call(model, "CanSendAuctionQuery", "list"), [undefined, undefined],
    "past the opening 5 s delay: still no second query before the answer");
  call(model, "QueryAuctionItems", "", "", "", undefined, undefined, undefined, 0, undefined, -1);
  assert.equal(world.calls.length, 1, "a throttled query sends nothing, as in the client");
  world.deliverList();
  assert.deepEqual(call(model, "CanSendAuctionQuery", "list"), [true, true], "answered, and 6 s since the query");
  // The client times the delay from the query it sent (Wow.exe 0x59C153), with the server's value now.
  call(model, "QueryAuctionItems", "", "", "", undefined, undefined, undefined, 0);
  world.deliverList();
  assert.deepEqual(call(model, "CanSendAuctionQuery", "list"), [undefined, undefined], "the server's 300 ms delay");
  events.advance(0.301);
  assert.deepEqual(call(model, "CanSendAuctionQuery", "list"), [true, true]);
  call(model, "QueryAuctionItems", "", "", "", undefined, 4, 1, 0, undefined, -1);
  assert.deepEqual(world.calls.at(-1).search, { name: "", itemClass: 0, itemSubClass: 5, page: 0 },
    "Расходуемые' first subclass is Food & Drink (5); rarity -1 and nil levels are «any»");
});

test("the browse list stays empty until stock searches; lists repaint their tabs", () => {
  const { model, world, events } = owned();
  assert.deepEqual(events.names(), ["AUCTION_HOUSE_SHOW"]);
  events.clear();
  world.deliverList();
  assert.deepEqual(call(model, "GetNumAuctionItems", "list"), [0, 0], "the world's own opening search is not stock's");
  assert.deepEqual(events.names(), []);
  call(model, "QueryAuctionItems", "", "", "", undefined, undefined, undefined, 0);
  world.deliverList();
  assert.deepEqual(call(model, "GetNumAuctionItems", "list"), [10, 10]);
  world.deliverOwner();
  world.deliverBidder();
  assert.deepEqual(events.names(), ["AUCTION_ITEM_LIST_UPDATE", "AUCTION_OWNED_LIST_UPDATE", "AUCTION_BIDDER_LIST_UPDATE"]);
  assert.deepEqual(call(model, "GetNumAuctionItems", "owner"), [2, 2]);
});

test("GetAuctionItemInfo answers the thirteen stock values, with the level refusal and who leads", () => {
  const { model, world, events } = owned();
  call(model, "QueryAuctionItems", "", "", "", undefined, undefined, undefined, 0);
  call(model, "SortAuctionClearSort", "list");
  world.deliverList();
  // Server order without a sort: 3004 is the potion lot the player leads, 3006 the level-16 shield.
  assert.deepEqual(call(model, "GetAuctionItemInfo", "list", 4), [
    "Огромный флакон с лечебным зельем", "Interface\\Icons\\INV_Potion_54", 5, 1, true, 45, 25_000, 1300, 0, 26_000, 1, "Мираэль", 0,
  ]);
  assert.deepEqual(call(model, "GetAuctionItemInfo", "list", 3).slice(10, 12), [undefined, "Игрок"], "the player's own lot");
  world.deliverOwner();
  assert.deepEqual(call(model, "GetAuctionItemInfo", "owner", 2).slice(9, 12), [260, "Торвальд", "Игрок"],
    "the owner list names the high bidder");
  assert.deepEqual(call(model, "GetAuctionItemInfo", "owner", 1)[10], undefined, "no bid, no bidder");
  // A level the player lacks: canUse nil (stock tints the icon red).
  const low = owned({ playerLevel: () => 10 });
  call(low.model, "QueryAuctionItems", "", "", "", undefined, undefined, undefined, 0);
  call(low.model, "SortAuctionClearSort", "list");
  low.world.deliverList();
  assert.equal(call(low.model, "GetAuctionItemInfo", "list", 6)[4], undefined);
  // An uncached item: nil name, numbers everywhere stock compares them.
  const bare = owned({ item: (entry) => entry === 2589 ? undefined : FRAMEXML_CANNED_AUCTION_ITEMS.get(entry) });
  call(bare.model, "QueryAuctionItems", "", "", "", undefined, undefined, undefined, 0);
  call(bare.model, "SortAuctionClearSort", "list");
  bare.world.deliverList();
  assert.deepEqual(call(bare.model, "GetAuctionItemInfo", "list", 1), [
    undefined, undefined, 20, 1, true, 0, 300, 0, 500, 0, undefined, "Торвальд", 0,
  ]);
  assert.deepEqual(call(bare.model, "GetAuctionItemLink", "list", 1), []);
  assert.match(call(model, "GetAuctionItemLink", "list", 4)[0], /^\|cffffffff\|Hitem:13446:0:0:0:0:0:0:0:0\|h\[Огромный флакон с лечебным зельем\]\|h\|r$/);
  void events;
});

test("time left counts down from the list's arrival in the client's 30 min / 2 h / 12 h buckets", () => {
  const { model, world, events } = owned();
  call(model, "QueryAuctionItems", "", "", "", undefined, undefined, undefined, 0);
  call(model, "SortAuctionClearSort", "list");
  world.deliverList();
  // 20 h, 90 min, 10 h, 25 min
  assert.deepEqual([1, 2, 3, 4].map((index) => call(model, "GetAuctionItemTimeLeft", "list", index)[0]), [4, 2, 3, 1]);
  events.advance(61 * 60);
  assert.deepEqual([1, 2, 3, 4].map((index) => call(model, "GetAuctionItemTimeLeft", "list", index)[0]), [4, 1, 3, 1]);
});

test("the sort columns are kept newest first and the landed page is sorted by them", () => {
  const { model, world } = owned();
  call(model, "QueryAuctionItems", "", "", "", undefined, undefined, undefined, 0);
  // AuctionFrame_SetSort("list", "quality", false): ... then quality last, which becomes primary.
  call(model, "SortAuctionClearSort", "list");
  for (const [column, reverse] of [["duration", false], ["bid", false], ["quantity", true], ["minbidbuyout", false],
    ["name", false], ["level", true], ["quality", false]]) call(model, "SortAuctionSetSort", "list", column, reverse);
  assert.deepEqual(call(model, "GetAuctionSort", "list", 1), ["quality", undefined]);
  assert.deepEqual(call(model, "GetAuctionSort", "list", 2), ["level", 1]);
  assert.deepEqual(call(model, "GetAuctionSort", "list", 8), []);
  world.deliverList();
  const names = () => Array.from({ length: 10 }, (_, index) => call(model, "GetAuctionItemInfo", "list", index + 1)[0]);
  assert.deepEqual(names(), [
    "Огромный флакон с лечебным зельем", "Гладий", "Льняной материал", "Льняной материал", "Руническая ткань",
    "Шелковый материал", "Волчий кулачный щит", "Арканитовый слиток", "Субстанция Огня", "Тигровый глаз",
  ], "quality up, level down, name up; the two linen lots by min bid/buyout (120 before 500)");
  // Selection follows the lot through a re-sort.
  call(model, "SetSelectedAuctionItem", "list", 2);
  call(model, "SortAuctionSetSort", "list", "name", true);
  call(model, "SortAuctionApplySort", "list");
  assert.equal(names()[0], "Шелковый материал");
  assert.equal(call(model, "GetAuctionItemInfo", "list", call(model, "GetSelectedAuctionItem", "list")[0])[0], "Гладий");
  // SortAuctionItems: the older single-column form reverses on repeat.
  call(model, "SortAuctionItems", "list", "bid");
  const first = call(model, "GetAuctionItemInfo", "list", 1);
  call(model, "SortAuctionItems", "list", "bid");
  assert.notDeepEqual(call(model, "GetAuctionItemInfo", "list", 1), first);
  assert.deepEqual(call(model, "IsAuctionSortReversed", "list", "bid"), [1]);
});

test("bids, buyouts and cancels name the lot by auction id; the results speak in the client's words", () => {
  const { model, world, events } = owned();
  call(model, "QueryAuctionItems", "", "", "", undefined, undefined, undefined, 0);
  call(model, "SortAuctionClearSort", "list");
  world.deliverList();
  world.deliverOwner();
  call(model, "PlaceAuctionBid", "list", 2, 1575);
  call(model, "PlaceAuctionBid", "list", 2, 0);
  call(model, "CancelAuction", 2);
  assert.deepEqual(world.calls.slice(1), [{ kind: "bid", auctionId: 3002, price: 1575 }, { kind: "cancel", auctionId: 3011 }]);
  assert.deepEqual(call(model, "CanCancelAuction", 2), [1]);
  assert.deepEqual(call(model, "CanCancelAuction", 3), [undefined]);
  events.clear();
  world.answer(AUCTION_PLACE_BID, 0, 3002);
  world.answer(AUCTION_CANCEL, 0, 3011);
  world.answer(AUCTION_PLACE_BID, 10);
  world.answer(AUCTION_PLACE_BID, 3);
  assert.deepEqual(events.events.map(([event, text]) => [event, text]), [
    ["CHAT_MSG_SYSTEM", "Ставка принята."], ["CHAT_MSG_SYSTEM", "Аукцион отменен."],
    ["UI_ERROR_MESSAGE", "Вы не можете делать ставку на свой собственный лот."], ["UI_ERROR_MESSAGE", "Недостаточно денег"],
  ]);
});

test("the sell slot takes the cursor's item, refuses a bound one, and gives the held item back", () => {
  const { model, world, events } = owned();
  assert.deepEqual(call(model, "GetAuctionSellItemInfo"), [undefined, undefined, 1, -1, undefined, 0, 0, 0, 0],
    "an empty slot answers the client's placeholder (ITEM_QUALITY_COLORS[-1])");
  world.cursor = { guid: 0x4000_0104n, bag: 255, slot: 26 };
  events.clear();
  call(model, "ClickAuctionSellItemButton");
  assert.deepEqual(events.events, [["UI_ERROR_MESSAGE", "Невозможно выставить на торги персональный предмет."]]);
  assert.ok(world.cursor, "the hearthstone stays on the cursor");
  world.cursor = { guid: 0x4000_0101n, bag: 255, slot: 23 };
  call(model, "ClickAuctionSellItemButton");
  assert.equal(world.cursor, undefined);
  assert.equal(model.selling(0x4000_0101n), true, "the bags show it locked");
  assert.deepEqual(call(model, "GetAuctionSellItemInfo"), ["Льняной материал", "Interface\\Icons\\INV_Fabric_Linen_01", 20, 1, true, 260, 13, 20, 47]);
  world.cursor = { guid: 0x4000_0105n, bag: 255, slot: 27 };
  call(model, "ClickAuctionSellItemButton");
  assert.deepEqual(world.cursor, { guid: 0x4000_0101n, bag: 255, slot: 23 }, "the linen comes back on the cursor");
  assert.equal(call(model, "GetAuctionSellItemInfo")[0], "Тигровый глаз");
  world.cursor = undefined;
  call(model, "ClickAuctionSellItemButton");
  assert.deepEqual(world.cursor, { guid: 0x4000_0105n, bag: 255, slot: 27 }, "an empty cursor picks the held item up");
  assert.equal(call(model, "GetAuctionSellItemInfo")[0], undefined);
  // A right click goes to the slot only while the Auctions tab shows.
  assert.equal(model.useItem(0x4000_0102n), false);
  call(model, "SetAuctionsTabShowing", 1);
  assert.equal(model.useItem(0x4000_0102n), true);
  assert.equal(call(model, "GetAuctionSellItemInfo")[2], 20);
  assert.deepEqual(call(model, "WebClientAuctionSellItemLink"), ["|cffffffff|Hitem:2589:0:0:0:0:0:0:0:0|h[Льняной материал]|h|r"]);
});

test("the sell slot follows its stack in the bags without resetting the form on the model's own changes", () => {
  const { model, world, events } = owned();
  const tick = () => { events.advance(0.3); model.tick(); };
  world.cursor = { guid: 0x4000_0101n, bag: 255, slot: 23 };
  call(model, "ClickAuctionSellItemButton");
  events.clear();
  tick();
  tick();
  assert.deepEqual(events.names(), [], "the click already repainted; the watch adds no second NEW_AUCTION_UPDATE");
  world.bags.get(0x4000_0101n).count = 15;
  tick();
  assert.deepEqual(events.names(), ["NEW_AUCTION_UPDATE"], "a stack split in the bags repaints the slot");
  assert.equal(call(model, "GetAuctionSellItemInfo")[2], 15);
  world.bags.delete(0x4000_0101n);
  tick();
  assert.deepEqual(events.names(), ["NEW_AUCTION_UPDATE", "NEW_AUCTION_UPDATE"]);
  assert.equal(call(model, "GetAuctionSellItemInfo")[0], undefined, "an item that left the bags leaves the slot");
  assert.equal(model.selling(0x4000_0101n), false);
  // GetAuctionHouseDepositRate: the hello's house.
  assert.deepEqual(call(model, "GetAuctionHouseDepositRate"), [5]);
  world.emit({ kind: "hello", enabled: true, houseId: 7 });
  assert.deepEqual(call(model, "GetAuctionHouseDepositRate"), [25]);
});

test("CalculateAuctionDeposit is the client's floor(rate × price / 100) × minutes / 240, at least 100", () => {
  assert.equal(frameXmlAuctionDeposit(5, 13, 20, 1440), 100, "floor(13) × 6 = 78 → the 100 copper floor");
  assert.equal(frameXmlAuctionDeposit(5, 400, 20, 720), 1200, "Runecloth: floor(400) × 3");
  assert.equal(frameXmlAuctionDeposit(5, 400, 20, 2880), 4800);
  assert.equal(frameXmlAuctionDeposit(25, 400, 20, 1440), 12_000, "the neutral house's rate");
  assert.equal(frameXmlAuctionDeposit(5, 1000, 3, 999), 100, "an unknown run time is the floor");
  assert.equal(frameXmlAuctionDeposit(5, 1333, 1, 2880), 792, "floor(66.65) × 12, not 799.8");
  const { model, world } = owned();
  world.cursor = { guid: 0x4000_0101n, bag: 255, slot: 23 };
  call(model, "ClickAuctionSellItemButton");
  assert.deepEqual(call(model, "CalculateAuctionDeposit", 3, 40), [312], "house 2: floor(5 × 520 / 100) × 12");
  assert.deepEqual(call(model, "CalculateAuctionDeposit", 2), [100], "no count: the sell stack's 20");
  // Blackwater (house 7, DepositRate 25): the hello's house id prices the lot.
  world.emit({ kind: "hello", enabled: true, houseId: 7 });
  assert.deepEqual(call(model, "CalculateAuctionDeposit", 3, 40), [1560], "floor(25 × 520 / 100) × 12");
  assert.deepEqual(call(undefined, "CalculateAuctionDeposit", 3, 40), [0], "no model, no house: 0 as the client answers");
});

test("StartAuction posts one lot, or a multisell lot by lot with its progress events", () => {
  const { model, world, events } = owned();
  world.cursor = { guid: 0x4000_0101n, bag: 255, slot: 23 };
  call(model, "ClickAuctionSellItemButton");
  events.clear();
  // 3 stacks of 15 from 20 + 20 + 7: [101×15], [101×5 + 102×10], [102×10 + 103×5].
  call(model, "StartAuction", 390, 600, 2, 15, 3);
  assert.deepEqual(events.events, [["AUCTION_MULTISELL_START", 3]]);
  assert.deepEqual(world.calls.at(-1), { kind: "sell", items: [{ guid: 0x4000_0101n, count: 15 }], startBid: 390, buyout: 600, minutes: 1440 });
  call(model, "StartAuction", 390, 600, 2, 15, 3);
  assert.equal(world.calls.filter(({ kind }) => kind === "sell").length, 1, "one multisell at a time");
  world.answer(AUCTION_SELL_ITEM, 0, 3200);
  assert.deepEqual(world.calls.at(-1).items, [{ guid: 0x4000_0101n, count: 5 }, { guid: 0x4000_0102n, count: 10 }]);
  world.answer(AUCTION_SELL_ITEM, 0, 3201);
  assert.deepEqual(world.calls.at(-1).items, [{ guid: 0x4000_0102n, count: 10 }, { guid: 0x4000_0103n, count: 5 }]);
  world.answer(AUCTION_SELL_ITEM, 0, 3202);
  assert.deepEqual(events.events.map(([event, ...args]) => [event, ...args.slice(0, event === "CHAT_MSG_SYSTEM" ? 1 : 2)]), [
    ["AUCTION_MULTISELL_START", 3],
    ["CHAT_MSG_SYSTEM", "Аукцион создан."], ["AUCTION_MULTISELL_UPDATE", 1, 3],
    ["CHAT_MSG_SYSTEM", "Аукцион создан."], ["AUCTION_MULTISELL_UPDATE", 2, 3],
    ["CHAT_MSG_SYSTEM", "Аукцион создан."], ["AUCTION_MULTISELL_UPDATE", 3, 3],
    ["NEW_AUCTION_UPDATE"],
  ]);
  assert.equal(call(model, "GetAuctionSellItemInfo")[0], undefined, "the posted item left the slot");
  // One lot: no multisell events; a refusal names the reason.
  world.cursor = { guid: 0x4000_0105n, bag: 255, slot: 27 };
  call(model, "ClickAuctionSellItemButton");
  events.clear();
  call(model, "StartAuction", 4000, 0, 1);
  assert.deepEqual(world.calls.at(-1), { kind: "sell", items: [{ guid: 0x4000_0105n, count: 3 }], startBid: 4000, buyout: 0, minutes: 720 });
  world.answer(AUCTION_SELL_ITEM, 3);
  assert.deepEqual(events.events, [["UI_ERROR_MESSAGE", "Недостаточно денег"]]);
  assert.equal(call(model, "GetAuctionSellItemInfo")[0], "Тигровый глаз", "a refused post keeps the item ready");
  // A multisell refused midway ends with FAILURE; one cancelled from the progress bar posts nothing more.
  world.cursor = { guid: 0x4000_0102n, bag: 255, slot: 24 };
  call(model, "ClickAuctionSellItemButton");
  events.clear();
  call(model, "StartAuction", 100, 0, 2, 5, 3);
  world.answer(AUCTION_SELL_ITEM, 3);
  assert.deepEqual(events.names(), ["AUCTION_MULTISELL_START", "UI_ERROR_MESSAGE", "AUCTION_MULTISELL_FAILURE"]);
  events.clear();
  call(model, "StartAuction", 100, 0, 2, 5, 3);
  call(model, "CancelSell");
  const sent = world.calls.filter(({ kind }) => kind === "sell").length;
  world.answer(AUCTION_SELL_ITEM, 0, 3300);
  assert.equal(world.calls.filter(({ kind }) => kind === "sell").length, sent, "a cancelled multisell posts nothing more");
  assert.deepEqual(events.names(), ["AUCTION_MULTISELL_START", "AUCTION_MULTISELL_FAILURE", "CHAT_MSG_SYSTEM"],
    "the lot already sent still reports its own creation");
});

test("notifications become system lines once the item name is known", () => {
  const { model, world, events } = owned();
  events.clear();
  world.emit({ kind: "bidderNotification", auctionId: 3002, itemId: 4306, won: false, bid: 1650 });
  world.emit({ kind: "bidderNotification", auctionId: 3004, itemId: 13446, won: true, bid: 26_000 });
  world.emit({ kind: "ownerNotification", auctionId: 3011, itemId: 2589, bid: 600 });
  world.emit({ kind: "ownerNotification", auctionId: 3003, itemId: 14047, bid: 0 });
  assert.deepEqual(events.events.map(([, text]) => text), [
    "Ваша ставка на «Шелковый материал» перебита.", "Вы выиграли аукцион: Огромный флакон с лечебным зельем.",
    "Ваш лот (Льняной материал) продан.", "Срок вашего лота истек: Руническая ткань",
  ]);
  // An uncached item waits for its name (up to 10 s, then the client's UNKNOWN).
  const pending = owned({ item: () => undefined });
  pending.events.clear();
  pending.world.emit({ kind: "ownerNotification", auctionId: 1, itemId: 999, bid: 5 });
  assert.deepEqual(pending.events.events, []);
  pending.events.advance(11);
  pending.model.tick();
  assert.deepEqual(pending.events.events, [["CHAT_MSG_SYSTEM", "Ваш лот (Неизвестно) продан.", "", "", "", "", "", 0, 0, "", 0, 0, ""]]);
});

test("before the add-on is gated the house belongs to the native window; closing fires CLOSED once", () => {
  const canned = createCannedFrameXmlAuction();
  const events = pump();
  canned.model.attach(events);
  // The lazy owner binds GlobalStrings when it is created, long before the add-on loads.
  canned.model.useGlobalStrings((name) => STRINGS[name]);
  let requests = 0;
  canned.model.onOpenRequest = () => { requests += 1; };
  canned.world.open();
  assert.equal(requests, 1, "the first auctioneer asks the owner to load Blizzard_AuctionUI");
  canned.world.deliverList();
  canned.world.answer(AUCTION_PLACE_BID, 10);
  assert.deepEqual(events.events, [], "nothing reaches the unloaded stock frames: the native window says why");
  canned.model.owned = true;
  assert.deepEqual(events.names(), ["AUCTION_HOUSE_SHOW"], "the ownership edge shows the open house");
  events.clear();
  call(canned.model, "CloseAuctionHouse");
  assert.deepEqual(canned.world.calls, [{ kind: "close" }]);
  assert.deepEqual(events.names(), ["AUCTION_HOUSE_CLOSED"]);
  canned.world.emit({ kind: "closed" });
  assert.deepEqual(events.names(), ["AUCTION_HOUSE_CLOSED"]);
  canned.world.open(false);
  assert.deepEqual(events.names(), ["AUCTION_HOUSE_CLOSED", "AUCTION_HOUSE_DISABLED"]);
  // A partial world without the auctioneer field (older test doubles) stands at no auctioneer.
  const partial = createCannedFrameXmlAuction({ world: () => ({ state: {} }) });
  assert.equal(partial.model.houseOpen(), false, "the mount must not load the add-on for it");
  partial.model.attach(pump());
  partial.model.owned = true;
  assert.equal(partial.model.showing, false);
  // A muted probe sends nothing and closes nothing.
  canned.world.open();
  canned.model.muted(() => { call(canned.model, "GetOwnerAuctionItems"); call(canned.model, "CloseAuctionHouse"); });
  assert.deepEqual(canned.world.calls, [{ kind: "close" }]);
  void frameXmlCannedAuctionLots; void frameXmlCannedOwnAuctions; void FrameXmlAuctionModel;
});

test("outbid, won, sold and expired lines print before Blizzard_AuctionUI ever loads", () => {
  // Away from any auctioneer, the add-on never loaded this session: the client's own packet handler speaks.
  const canned = createCannedFrameXmlAuction();
  const events = pump();
  canned.model.attach(events);
  canned.world.emit({ kind: "ownerNotification", auctionId: 7, itemId: 2589, bid: 500 });
  assert.deepEqual(events.events, [], "no GlobalStrings bound: nothing to say it with");
  canned.model.useGlobalStrings((name) => STRINGS[name]);
  canned.world.emit({ kind: "ownerNotification", auctionId: 7, itemId: 2589, bid: 500 });
  canned.world.emit({ kind: "bidderNotification", auctionId: 8, itemId: 4306, won: false, bid: 600 });
  assert.equal(canned.model.owned, false);
  assert.equal(canned.world.auctioneerGuid, 0n);
  assert.deepEqual(events.events.map(([event, text]) => [event, text]), [
    ["CHAT_MSG_SYSTEM", "Ваш лот (Льняной материал) продан."], ["CHAT_MSG_SYSTEM", "Ваша ставка на «Шелковый материал» перебита."],
  ]);
});

test("the model answers WorldClient's hello-search predicate: a search on open only while stock does not own the house", () => {
  const canned = createCannedFrameXmlAuction();
  canned.model.attach(pump());
  assert.equal(canned.world.auctionHelloSearch?.(), true, "loading or failed: the native window's opening search");
  canned.model.owned = true;
  assert.equal(canned.world.auctionHelloSearch(), false, "stock owns the house: no search on open, as in 3.3.5");
  canned.model.owned = false;
  assert.equal(canned.world.auctionHelloSearch(), true);
  canned.model.detach();
  assert.equal(canned.world.auctionHelloSearch, undefined, "a detached model leaves the world's own default");
});

const listOf = (entries) => ({ searchDelay: 300, totalCount: entries.length, entries });

test("a world refresh answered before stock's newer query neither ends its wait nor replaces its page", () => {
  const { model, world, events } = owned();
  const lots = frameXmlCannedAuctionLots();
  call(model, "QueryAuctionItems", "", "", "", undefined, undefined, undefined, 0);
  world.deliverList(listOf(lots));
  assert.deepEqual(call(model, "GetNumAuctionItems", "list"), [10, 10]);
  // A bid succeeds: WorldClient re-sends the current search and the bidder list (`refreshed`) …
  events.advance(0.4);
  world.emit({ kind: "result", auctionId: 3001, command: AUCTION_PLACE_BID, error: 0, bagResult: 0, refreshed: ["list", "bidder"] });
  // … and stock searches again before that refresh is answered.
  call(model, "QueryAuctionItems", "Льняной", "", "", undefined, undefined, undefined, 0);
  assert.equal(world.calls.at(-1).search.name, "Льняной");
  events.clear();
  world.deliverList(listOf(lots.slice(1))); // the refresh: the previous filter, less the lot bought
  assert.deepEqual(call(model, "GetNumAuctionItems", "list"), [10, 10], "the refresh is not the answer to stock's query");
  assert.deepEqual(call(model, "CanSendAuctionQuery", "list"), [undefined, undefined], "stock still waits for its own answer");
  assert.deepEqual(events.names(), []);
  world.deliverList(listOf(lots.filter(({ itemId }) => itemId === 2589)));
  assert.deepEqual(call(model, "GetNumAuctionItems", "list"), [2, 2]);
  assert.deepEqual(events.names(), ["AUCTION_ITEM_LIST_UPDATE"]);
  // With nothing of stock's outstanding, a refresh repaints its tab (the bid lot now shows the bid).
  world.deliverBidder();
  assert.deepEqual(events.names(), ["AUCTION_ITEM_LIST_UPDATE", "AUCTION_BIDDER_LIST_UPDATE"]);
  events.advance(0.4);
  world.emit({ kind: "result", auctionId: 3010, command: AUCTION_PLACE_BID, error: 0, bagResult: 0, refreshed: ["list", "bidder"] });
  world.deliverList(listOf(lots.filter(({ auctionId }) => auctionId === 3001)));
  assert.deepEqual(call(model, "GetNumAuctionItems", "list"), [1, 1]);
});

test("the native window's opening search, answered after stock's first query, is not stock's answer", () => {
  const canned = createCannedFrameXmlAuction();
  const events = pump();
  canned.model.attach(events);
  canned.model.useGlobalStrings((name) => STRINGS[name]);
  // The session's first auctioneer: WorldClient sent its unfiltered search with the hello.
  canned.world.auctioneerGuid = FRAMEXML_CANNED_AUCTIONEER_GUID;
  canned.world.emit({ kind: "hello", enabled: true, houseId: 2, searched: true });
  canned.model.owned = true; // Blizzard_AuctionUI passed its gate
  call(canned.model, "QueryAuctionItems", "Шелк", "", "", undefined, undefined, undefined, 0);
  const lots = frameXmlCannedAuctionLots();
  canned.world.deliverList(listOf(lots));
  assert.deepEqual(call(canned.model, "GetNumAuctionItems", "list"), [0, 0]);
  assert.deepEqual(call(canned.model, "CanSendAuctionQuery", "list"), [undefined, undefined]);
  canned.world.deliverList(listOf(lots.filter(({ itemId }) => itemId === 4306)));
  assert.deepEqual(call(canned.model, "GetNumAuctionItems", "list"), [1, 1]);
});

test("a request the core drops without an answer stops blocking after 30 s", () => {
  const { model, world, events } = owned();
  call(model, "QueryAuctionItems", "", "", "", undefined, undefined, undefined, 0);
  events.advance(29);
  assert.deepEqual(call(model, "CanSendAuctionQuery", "list"), [undefined, undefined], "still waiting inside the timeout");
  events.advance(2);
  assert.deepEqual(call(model, "CanSendAuctionQuery", "list"), [true, true], "HandleAuctionListItems returned without a word");
  // A multisell lot never answered (HandleAuctionSellItem, auctioneer out of range) ends as a refused one.
  world.cursor = { guid: 0x4000_0101n, bag: 255, slot: 23 };
  call(model, "ClickAuctionSellItemButton");
  call(model, "StartAuction", 100, 0, 2, 10, 3);
  const sells = () => world.calls.filter(({ kind }) => kind === "sell").length;
  assert.equal(sells(), 1);
  events.clear();
  events.advance(29);
  model.tick();
  call(model, "StartAuction", 100, 0, 2, 10, 1);
  assert.equal(sells(), 1, "inside the timeout the post still waits");
  events.advance(2);
  model.tick();
  assert.deepEqual(events.names().filter((name) => name.startsWith("AUCTION_MULTISELL")), ["AUCTION_MULTISELL_FAILURE"]);
  call(model, "StartAuction", 100, 0, 2, 10, 1);
  assert.equal(sells(), 2, "the sell slot takes a new post");
});

test("closing the house mid-multisell ends the progress with AUCTION_MULTISELL_FAILURE", () => {
  const { model, world, events } = owned();
  world.cursor = { guid: 0x4000_0101n, bag: 255, slot: 23 };
  call(model, "ClickAuctionSellItemButton");
  call(model, "StartAuction", 100, 0, 2, 10, 3);
  world.answer(AUCTION_SELL_ITEM, 0, 3200);
  events.clear();
  call(model, "CloseAuctionHouse");
  assert.deepEqual(events.names(), ["AUCTION_MULTISELL_FAILURE", "AUCTION_HOUSE_CLOSED"]);
  assert.equal(model.selling(0x4000_0101n), false);
});

test("a conjured or timed item is refused for the sell slot in the client's words", () => {
  let bags;
  const conjured = { ...FRAMEXML_CANNED_AUCTION_ITEMS.get(818), flags: 0x2 };
  const { model, world, events } = owned({
    item: (entry) => entry === 818 ? conjured : FRAMEXML_CANNED_AUCTION_ITEMS.get(entry),
    itemObject: (guid) => {
      const item = bags.get(guid);
      return item ? { entry: item.entry, count: item.count, duration: guid === 0x4000_0103n ? 3600 : 0 } : undefined;
    },
  });
  bags = world.bags;
  events.clear();
  world.cursor = { guid: 0x4000_0105n, bag: 255, slot: 27 };
  call(model, "ClickAuctionSellItemButton");
  world.cursor = { guid: 0x4000_0103n, bag: 255, slot: 25 };
  call(model, "ClickAuctionSellItemButton");
  assert.deepEqual(events.events, [
    ["UI_ERROR_MESSAGE", STRINGS.ERR_AUCTION_CONJURED_ITEM], ["UI_ERROR_MESSAGE", STRINGS.ERR_AUCTION_LIMITED_DURATION_ITEM],
  ]);
  assert.ok(world.cursor, "the refused item stays on the cursor");
  assert.equal(call(model, "GetAuctionSellItemInfo")[0], undefined);
  call(model, "SetAuctionsTabShowing", 1);
  assert.equal(model.useItem(0x4000_0105n), true, "a right click is refused the same way");
  assert.equal(events.events.length, 3);
  assert.equal(call(model, "GetAuctionSellItemInfo")[0], undefined);
});

test("a multisell takes the sell slot's own stack first, then the rest in bag order", () => {
  const { model, world } = owned();
  world.cursor = { guid: 0x4000_0102n, bag: 255, slot: 24 };
  call(model, "ClickAuctionSellItemButton");
  call(model, "StartAuction", 100, 0, 2, 15, 2);
  assert.deepEqual(world.calls.at(-1).items, [{ guid: 0x4000_0102n, count: 15 }]);
  world.answer(AUCTION_SELL_ITEM, 0, 3200);
  assert.deepEqual(world.calls.at(-1).items, [{ guid: 0x4000_0102n, count: 5 }, { guid: 0x4000_0101n, count: 10 }]);
});

test("canUse refuses an item whose AllowableClass or AllowableRace mask leaves the player out", () => {
  const potion = FRAMEXML_CANNED_AUCTION_ITEMS.get(13446);
  let masks = {};
  let player = { classId: 1, raceId: 1 }; // a human warrior
  const { model, world } = owned({
    item: (entry) => entry === 13446 ? { ...potion, ...masks } : FRAMEXML_CANNED_AUCTION_ITEMS.get(entry),
    playerClassRace: () => player,
  });
  call(model, "QueryAuctionItems", "", "", "", undefined, undefined, undefined, 0);
  call(model, "SortAuctionClearSort", "list");
  world.deliverList();
  const canUse = () => call(model, "GetAuctionItemInfo", "list", 4)[4];
  assert.equal(canUse(), true);
  masks = { allowableClass: 1 << 7 };
  assert.equal(canUse(), undefined, "a mage-only item (ChrClasses 8): stock tints the icon red");
  masks = { allowableClass: (1 << 7) | 1 };
  assert.equal(canUse(), true);
  masks = { allowableClass: -1 };
  assert.equal(canUse(), true, "-1: every class");
  masks = { allowableClass: 0 };
  assert.equal(canUse(), true, "0: every class, as the quest reward check reads it");
  masks = { allowableRace: 1 << 1 };
  assert.equal(canUse(), undefined, "an orc-only item (ChrRaces 2)");
  masks = { allowableRace: 0xffffffff };
  assert.equal(canUse(), true);
  masks = { allowableClass: 1 << 7 };
  player = undefined;
  assert.equal(canUse(), true, "no class known: nothing is claimed");
});
}

// ── framexml-auction-worldclient.test.mjs
{
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
}
