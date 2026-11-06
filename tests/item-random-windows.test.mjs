import assert from "node:assert/strict";
import test from "node:test";

// 06.11 (3.12): the random suffix in the windows' item names and links, as Wow.exe writes them — the
// name through 0x00706d70, a link through 0x0061e290 (enchant, three gems, 0, random property, suffix
// factor, the player's level) — and the packet fields that carry them.

const { itemChatLink } = await import("../dist/code/browser/ui/ChatLink.js");
const { itemLinkFields, itemLinkRandom } = await import("../dist/code/browser/ItemRandomProperties.js");
const { itemObjectNameRandom } = await import("../dist/code/browser/ItemEnchantments.js");
const { findSpellTargetItem } = await import("../dist/code/browser/framexml/FrameXmlItemTargeting.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_AUCTION_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlAuction.js");
const { createCannedFrameXmlLoot } = await import("../dist/code/browser/framexml/FrameXmlLootCanned.js");
const { createCannedFrameXmlTrade, frameXmlCannedTradeItem } = await import("../dist/code/browser/framexml/FrameXmlTradeCanned.js");
const { createCannedFrameXmlMail, frameXmlCannedMailList } = await import("../dist/code/browser/framexml/FrameXmlMailCanned.js");
const { createCannedFrameXmlAuction, frameXmlCannedAuctionLots } = await import("../dist/code/browser/framexml/FrameXmlAuctionCanned.js");
const { createCannedFrameXmlGuildBank } = await import("../dist/code/browser/framexml/FrameXmlGuildBankCanned.js");
const { createLiveFrameXmlSocket } = await import("../dist/code/browser/framexml/FrameXmlSocketLive.js");
const { parseMailListResult } = await import("../dist/code/world/MailProtocol.js");
const { parseAuctionListResult, parseAuctionBidderNotification, parseAuctionOwnerNotification } =
  await import("../dist/code/world/AuctionProtocol.js");
const { parseLootResponse } = await import("../dist/code/world/LootProtocol.js");
const { parseTradeStatusExtended } = await import("../dist/code/world/TradeProtocol.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const field = (name) => UPDATE_FIELDS[name].offset;
const object = (guid, fields) => ({ guid, typeId: 1, fields: new Map(Object.entries(fields).map(([name, value]) => [field(name), value])) });
/** A host's suffix: -10 is «медведя»; any other id has none here. */
const named = (name, randomId) => (randomId === -10 ? `${name} медведя` : name);
const pump = () => {
  const events = [];
  return { events, fire(event, ...args) { events.push([event, ...args]); return 1; }, now: () => 0 };
};

test("a link carries the gems, the suffix factor and the level, the fourth gem field 0 (0x0061e290)", () => {
  assert.equal(itemChatLink(15210, 2, "Меч медведя", 1, -10, { gems: [2, 3, 4], suffixFactor: 30, level: 71 }),
    "|cff1eff00|Hitem:15210:1:2:3:4:0:-10:30:71|h[Меч медведя]|h|r");
  assert.equal(itemChatLink(15210, 2, "Меч"), "|cff1eff00|Hitem:15210:0:0:0:0:0:0:0:0|h[Меч]|h|r", "no parts: zeros");
  assert.deepEqual(itemLinkFields("|cff1eff00|Hitem:15210:1:2:3:4:5:-10:30:71|h[Меч]|h|r"), [1, 2, 3, 4, 5, -10, 30, 71]);
  assert.deepEqual(itemLinkFields("item:15210"), [0, 0, 0, 0, 0, 0, 0, 0], "absent numbers read 0");
  assert.deepEqual(itemLinkRandom("item:15210:0:0:0:0:0:-10:30:71"), { id: -10, factor: 30 });
});

test("an item object names its random property unless it is a wrapped gift (0x00707c20)", () => {
  assert.equal(itemObjectNameRandom(object(1n, { ITEM_FIELD_RANDOM_PROPERTIES_ID: -10 >>> 0 })), -10, "signed");
  assert.equal(itemObjectNameRandom(object(1n, { ITEM_FIELD_RANDOM_PROPERTIES_ID: -10 >>> 0, ITEM_FIELD_FLAGS: 0x8 })), 0);
});

test("the item lookup by name compares the suffixed name, as long as the argument (0x00754af0 → 0x00753b20)", () => {
  const sword = object(0x700n, { OBJECT_FIELD_ENTRY: 15210, ITEM_FIELD_RANDOM_PROPERTIES_ID: -10 >>> 0 });
  const inventory = { backpack: [{ index: 23, item: sword, guid: sword.guid, bag: 255, slot: 23 }], bags: [], keyring: [], equipment: [] };
  const nameOf = (entry, item) => (entry === 15210 ? named("Меч", itemObjectNameRandom(item)) : undefined);
  assert.equal(findSpellTargetItem(inventory, "меч медв", nameOf)?.guid, sword.guid, "longer than the bare name");
  assert.equal(findSpellTargetItem(inventory, "меч волка", nameOf), undefined);
});

test("the packets keep what the links need: enchantments, signed random properties, the notices' property", () => {
  const enchantments = (writer) => { for (let slot = 0; slot < 7; slot += 1) writer.u32(slot + 1).u32(0).u32(0); return writer; };
  // SMSG_MAIL_LIST_RESULT: one letter with one attachment (MailPackets.cpp).
  const mail = new PacketWriter().u32(1).u8(1).u16(0).u32(7).u8(0).u64(0x42n).u32(0).u32(0).u32(41).u32(0).u32(0)
    .f32(29.5).u32(0).cString("Тема").cString("").u8(1).u8(0).i32(3).i32(13446);
  enchantments(mail).i32(-10).i32(30).i32(1).i32(0).u32(0).i32(0).u8(1);
  const [attachment] = parseMailListResult(mail.toUint8Array()).mails[0].attachments;
  assert.deepEqual([attachment.enchantments, attachment.randomPropertiesId, attachment.randomPropertiesSeed],
    [[1, 2, 3, 4, 5, 6, 7], -10, 30]);
  // SMSG_AUCTION_LIST_RESULT: one lot (AuctionEntry::BuildAuctionInfo).
  const lots = enchantments(new PacketWriter().u32(1).u32(5).u32(15210)).i32(-10).u32(30).u32(1).u32(0).u32(0)
    .u64(7n).u32(100).u32(0).u32(0).u32(60000).u64(0n).u32(0).u32(1).u32(300);
  const [lot] = parseAuctionListResult(lots.toUint8Array()).entries;
  assert.deepEqual([lot.enchantments, lot.randomPropertyId, lot.suffixFactor], [[1, 2, 3, 4, 5, 6, 7], -10, 30]);
  assert.equal(parseAuctionBidderNotification(new PacketWriter().u32(2).u32(77).u64(1n).u32(5).u32(1).u32(15210).i32(-10)
    .toUint8Array()).randomPropertyId, -10, "the word Wow.exe 0x005a0480 names the lot with");
  assert.equal(parseAuctionOwnerNotification(new PacketWriter().u32(77).u32(5).u32(0).u64(0n).u32(15210).i32(-10).f32(0)
    .toUint8Array()).randomPropertyId, -10, "the word after the entry (0x005a0790)");
  // SMSG_LOOT_RESPONSE and SMSG_TRADE_STATUS_EXTENDED write the property as uint32: a suffix reads back negative.
  const loot = new PacketWriter().u64(9n).u8(1).u32(0).u8(1).u8(0).u32(15210).u32(1).u32(0).u32(30).u32(-10 >>> 0).u8(0);
  assert.equal(parseLootResponse(loot.toUint8Array()).slots[0].randomPropertyId, -10);
  const trade = new PacketWriter().u8(1).u32(0).u32(0).u32(0).u32(0).u32(0).u8(0).u32(15210).u32(0).u32(1).u32(0).u64(0n)
    .u32(0).u32(0).u32(0).u32(0).u64(0n).u32(0).u32(30).u32(-10 >>> 0).u32(0).u32(0).u32(0);
  assert.equal(parseTradeStatusExtended(trade.toUint8Array()).items[0].randomPropertyId, -10);
});

test("the loot window and a roll name the suffix and link it (0x00588430, 0x005889d0, 0x005884a0)", () => {
  const { model } = createCannedFrameXmlLoot({ playerLevel: () => 71, randomName: named });
  const slot = { index: 0, itemId: 15210, count: 1, displayId: 0, randomSuffix: 30, randomPropertyId: -10, slotType: 0, taken: false };
  const start = { itemGuid: 5n, mapId: 0, itemSlot: 0, itemId: 15210, randomSuffix: 30, randomPropertyId: -10, count: 1, countdown: 60_000, voteMask: 7 };
  const fixture = {
    loot: { guid: 9n, lootType: 1, gold: 0, slots: [slot] },
    items: new Map([[15210, { name: "Меч", quality: 2 }]]),
    roll: { id: 1, entry: { start, startedAt: 0, votes: [] } },
  };
  const [info, link, roll, rollLink] = model.probe(fixture,
    () => [model.slotInfo(1), model.slotLink(1), model.rollItemInfo(1), model.rollItemLink(1)]);
  assert.equal(info[1], "Меч медведя");
  assert.match(link, /\|Hitem:15210:0:0:0:0:0:-10:30:71\|h\[Меч медведя\]\|h/);
  assert.equal(roll[1], "Меч медведя");
  assert.match(rollLink, /\|Hitem:15210:0:0:0:0:0:-10:30:71\|h\[Меч медведя\]\|h/);
});

test("trade names both sides' suffixes and links the partner's item whole (0x00587eb0, 0x00587c60, 0x005865f0)", () => {
  const mine = 0x4000_0001n;
  const { model, world } = createCannedFrameXmlTrade({
    randomName: named, playerLevel: () => 71, itemRandomId: (guid) => (guid === mine ? -10 : 0),
  });
  model.attach(pump());
  model.owned = true;
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name]({ trade: model }, args);
  world.open();
  world.partnerOffers(0, [{
    ...frameXmlCannedTradeItem(0, 4306, 1), enchantId: 1, gemEnchantIds: [2, 3, 4], suffixFactor: 30, randomPropertyId: -10,
  }]);
  assert.equal(call("GetTradeTargetItemInfo", 1)[0], "Шелковый материал медведя");
  assert.deepEqual(call("GetTradeTargetItemLink", 1), ["|cffffffff|Hitem:4306:1:2:3:4:0:-10:30:71|h[Шелковый материал медведя]|h|r"]);
  world.cursor = { guid: mine, bag: 255, slot: 23 };
  call("ClickTradeButton", 1);
  assert.equal(call("GetTradePlayerItemInfo", 1)[0], "Огромный флакон с лечебным зельем медведя", "the offered object's own suffix");
});

test("mail names the attachment's, the auction subject's and the draft's suffix, and links the attachment whole", () => {
  const draft = 0x4000_0001n;
  const { model, world } = createCannedFrameXmlMail({
    randomName: named, playerLevel: () => 71,
    itemObject: (guid) => ({ entry: 13446, count: 1, randomPropertyId: guid === draft ? -10 : 0 }),
  });
  model.attach(pump());
  model.owned = true;
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name]({ mail: model }, args);
  const list = frameXmlCannedMailList();
  const first = list.mails[0].attachments[0];
  list.mails[0].attachments[0] = { ...first, randomPropertiesId: -10, randomPropertiesSeed: 30, enchantments: [1, 0, 2, 3, 4, 5, 0] };
  list.mails[1] = { ...list.mails[1], subject: list.mails[1].subject.replace(/^(\d+):0:/, "$1:-10:") };
  world.open(list);
  assert.equal(call("GetInboxItem", 1, 1)[0], "Огромный флакон с лечебным зельем медведя", "0x00570f10");
  assert.deepEqual(call("GetInboxItemLink", 1, 1),
    ["|cffffffff|Hitem:13446:1:2:3:4:0:-10:30:71|h[Огромный флакон с лечебным зельем медведя]|h|r"], "0x0056eca0");
  assert.deepEqual(call("WebClientMailAuctionSubject", 2), [1, "Льняной материал медведя"], "the subject's property (0x0056f520)");
  assert.equal(call("GetInboxInvoiceInfo", 2)[1], "Льняной материал медведя", "0x0056e9b0");
  world.cursor = { guid: draft, bag: 255, slot: 23 };
  model.clickSendItem(1, false);
  assert.equal(model.sendMailItem(1)[0], "Огромный флакон с лечебным зельем медведя", "the draft object's suffix (0x00570750)");
});

test("the auction house names the lot's, the sell slot's and the notices' suffix, and links the lot whole", () => {
  const strings = { ERR_AUCTION_WON_S: "Куплен предмет: %s." };
  const ref = {};
  const canned = createCannedFrameXmlAuction({
    randomName: named,
    itemObject: (guid) => {
      const item = ref.world.bags.get(guid);
      return item ? { entry: item.entry, count: item.count, randomPropertyId: -10 } : undefined;
    },
  });
  const { model, world } = canned;
  ref.world = world;
  const events = pump();
  model.attach(events);
  model.useGlobalStrings((name) => strings[name]);
  model.owned = true;
  world.open();
  const call = (name, ...args) => FRAMEXML_AUCTION_BINDINGS[name]({ auction: model }, args);
  call("QueryAuctionItems", "", "", "", undefined, undefined, undefined, 0);
  const potion = frameXmlCannedAuctionLots().find((lot) => lot.itemId === 13446);
  world.deliverList({ searchDelay: 300, totalCount: 1, entries: [
    { ...potion, randomPropertyId: -10, suffixFactor: 30, enchantments: [1, 0, 2, 3, 4, 0, 0] },
  ] });
  assert.equal(call("GetAuctionItemInfo", "list", 1)[0], "Огромный флакон с лечебным зельем медведя", "0x0059d5e0");
  assert.deepEqual(call("GetAuctionItemLink", "list", 1),
    ["|cffffffff|Hitem:13446:1:2:3:4:0:-10:30:60|h[Огромный флакон с лечебным зельем медведя]|h|r"], "0x0059c2d0");
  const [guid, carried] = [...world.bags].find(([, item]) => item.soulbound !== true);
  world.cursor = { guid, bag: carried.bag, slot: carried.slot };
  call("ClickAuctionSellItemButton");
  assert.match(call("GetAuctionSellItemInfo")[0], / медведя$/, "the sell slot's object (0x0059f760)");
  world.emit({ kind: "bidderNotification", auctionId: 1, itemId: 13446, randomPropertyId: -10, won: true, bid: 5 });
  assert.ok(events.events.some(([event, text]) => event === "CHAT_MSG_SYSTEM"
    && text === "Куплен предмет: Огромный флакон с лечебным зельем медведя."), "0x005a0480");
});

test("the guild bank's link names the stack's suffix (0x005a4d30)", () => {
  const { model, world } = createCannedFrameXmlGuildBank({ randomName: named });
  model.attach(pump());
  model.owned = true;
  const gladius = world.contents[0].find((item) => item.slot === 28);
  Object.assign(gladius, { randomPropertyId: -10, suffixFactor: 30 });
  world.open();
  world.answerOpen();
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetGuildBankItemLink({ guildBank: model }, [1, 29]),
    ["|cffffffff|Hitem:2488:1900:0:0:0:0:-10:30:60|h[Гладий медведя]|h|r"]);
});

test("socketing names the item object's suffix and previews it with its property (0x005c49d0, 0x0061e3a0)", () => {
  const sword = object(0x700n, { OBJECT_FIELD_ENTRY: 15210, ITEM_FIELD_RANDOM_PROPERTIES_ID: -10 >>> 0, ITEM_FIELD_PROPERTY_SEED: 30 });
  const self = object(0x10n, { UNIT_FIELD_LEVEL: 71 });
  const world = {
    itemTemplates: new Map([[15210, { found: true, name: "Меч", quality: 2, sockets: [{ color: 2 }, { color: 0 }, { color: 0 }], gemProperties: 0 }]]),
    state: { selfGuid: self.guid, objects: new Map([[self.guid, self], [sword.guid, sword]]) },
  };
  const slot = { index: 0, item: sword, guid: sword.guid, bag: 255, slot: 23 };
  const model = createLiveFrameXmlSocket({
    world: () => world, equipment: () => undefined, container: (bag, index) => (bag === 0 && index === 1 ? slot : undefined),
    cursorSource: () => undefined, setCursor() {}, clearCursor() {}, now: () => 0, enchantments: () => undefined, randomName: named,
  });
  model.onOpenRequest = () => true;
  assert.equal(model.request({ location: 1, bag: 0, slot: 1 }), true);
  assert.equal(model.socketItemInfo()[0], "Меч медведя");
  assert.equal(model.socketedItemLink(), "|cff1eff00|Hitem:15210:0:0:0:0:0:-10:30:71|h[Меч медведя]|h|r");
  sword.fields.set(field("ITEM_FIELD_FLAGS"), 0x8);
  assert.equal(model.socketItemInfo()[0], "Меч", "a wrapped gift");
  assert.equal(model.socketedItemLink(), "|cff1eff00|Hitem:15210:0:0:0:0:0:0:0:71|h[Меч]|h|r");
});
