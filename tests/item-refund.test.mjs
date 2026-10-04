import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import {
  buildItemRefund, buildItemRefundInfo, itemRefundMessages, itemRefundMoneyText, itemRefundSecondsLeft,
  parseItemRefundInfo, parseItemRefundResult,
} from "../dist/code/world/ItemRefundProtocol.js";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { frameXmlRefundBlockedByEnchant } = await import("../dist/code/browser/framexml/FrameXmlRefund.js");
const cursor = await import("../dist/code/browser/game/SpellCursor.js");

// 2.10: item purchase refunds. Layouts: Player.cpp:26896-26933 (info), :26967-27045 (result),
// ItemHandler.cpp:1219-1254 (requests). Client rules: Wow.exe 0x007089e0 (ask once, template flag
// 0x1000), 0x006d1760 (sweep at SMSG_LIST_INVENTORY), 0x005d8d80/0x005d8f70/0x005d91b0 (stock C API),
// 0x006d9b40 (result lines), 0x005210d0 (END_REFUND before an enchant), 0x00523370 (EndRefund).

const SELF = 0x42n;
const VENDOR = 0x0F00_0000_0000_0077n;
const ITEM = 0x4000_0000_0000_0101n;
const PLAIN = 0x4000_0000_0000_0102n;
const EQUIPPED = 0x4000_0000_0000_0103n;
const ITEM_ENTRY = 40_000;
const PLAIN_ENTRY = 40_001;
const TOKEN_ENTRY = 29_434;
const offset = (name) => UPDATE_FIELDS[name].offset;

function infoPayload(guid, stamp, { money = 12_000, honor = 0, arena = 0, items = [[TOKEN_ENTRY, 15]] } = {}) {
  const writer = new PacketWriter().u64(guid).u32(money).u32(honor).u32(arena);
  for (let index = 0; index < 5; index++) writer.u32(items[index]?.[0] ?? 0).u32(items[index]?.[1] ?? 0);
  return writer.u32(0).u32(stamp).toUint8Array();
}

function resultPayload(guid, code, cost) {
  const writer = new PacketWriter().u64(guid).u32(code);
  if (cost) {
    writer.u32(cost.money).u32(cost.honor).u32(cost.arena);
    for (let index = 0; index < 5; index++) writer.u32(cost.items[index]?.[0] ?? 0).u32(cost.items[index]?.[1] ?? 0);
  }
  return writer.toUint8Array();
}

test("packet layouts: two guid requests, the info response, the result", () => {
  assert.deepEqual([...buildItemRefundInfo(0x1234n)], [0x34, 0x12, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...buildItemRefund(0x1234n)], [0x34, 0x12, 0, 0, 0, 0, 0, 0]);
  const { guid, info } = parseItemRefundInfo(infoPayload(ITEM, 5000, { items: [[TOKEN_ENTRY, 15], [0, 0], [47241, 2]] }));
  assert.equal(guid, ITEM);
  assert.deepEqual([info.money, info.honor, info.arena, info.purchasedAtPlayed], [12_000, 0, 0, 5000]);
  assert.deepEqual(info.items.map((cost) => [cost.itemId, cost.count]),
    [[TOKEN_ENTRY, 15], [0, 0], [47241, 2], [0, 0], [0, 0]]);
  assert.deepEqual(parseItemRefundResult(resultPayload(ITEM, 10)), { guid: ITEM, code: 10 });
  const ok = parseItemRefundResult(resultPayload(ITEM, 0, { money: 0, honor: 500, arena: 0, items: [] }));
  assert.equal(ok.code, 0);
  assert.equal(ok.cost.honor, 500);
});

test("the time left is the purchase stamp minus played time plus two hours, only while positive", () => {
  const info = { money: 0, honor: 0, arena: 0, items: [], purchasedAtPlayed: 10_000 };
  assert.equal(itemRefundSecondsLeft(info, 10_600), 6600);
  assert.equal(itemRefundSecondsLeft(info, 17_200), undefined);
  assert.equal(itemRefundSecondsLeft(info, 17_199), 1);
  assert.equal(itemRefundSecondsLeft(undefined, 0), undefined);
});

test("result lines follow Wow.exe 0x006d9b40", () => {
  const facts = { honor: 74_800, arena: 0, itemName: (id) => (id === TOKEN_ENTRY ? "Знак справедливости" : undefined) };
  const ok = itemRefundMessages({ guid: ITEM, code: 0, cost: {
    money: 12_345, honor: 500, arena: 0,
    items: [{ itemId: TOKEN_ENTRY, count: 15 }, { itemId: 99_999, count: 1 }, { itemId: 0, count: 0 }],
  } }, facts);
  assert.equal(ok.error, undefined);
  assert.equal(ok.lines.length, 4, "the message, the money, the honor capped, the one named item");
  assert.equal(ok.lines[2].endsWith(", 200"), true, "75000 − 74800 honor: the cap");
  assert.equal(ok.lines[3].endsWith(", 15"), true);
  assert.equal(itemRefundMoneyText(12_345).split(", ").length, 3, "gold, silver, copper");
  assert.equal(itemRefundMoneyText(100).split(", ").length, 1, "only the non-zero parts");
  assert.deepEqual(itemRefundMessages({ guid: ITEM, code: 10 }, facts), { lines: [], error: "ERR_INV_FULL" });
  assert.deepEqual(itemRefundMessages({ guid: ITEM, code: 11 }, facts), { lines: [], error: "ERR_CURRENCY_FULL" });
  const other = itemRefundMessages({ guid: ITEM, code: 3 }, facts);
  assert.equal(other.error, undefined);
  assert.equal(other.lines.length, 1, "UNABLE_TO_REFUND_ITEM as a system line");
});

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) { const resume = wake; wake = undefined; resume(queue.shift()); }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload: [...payload] }); },
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

function object(guid, typeId, entries) {
  return { guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined, fields: new Map(entries) };
}

function setGuid(fields, at, guid) {
  fields.set(at, Number(guid & 0xffff_ffffn));
  fields.set(at + 1, Number(guid >> 32n));
}

function template(entry, flags) {
  return { found: true, entry, name: `Предмет ${entry}`, quality: 4, flags, inventoryType: 5, itemClass: 4, subClass: 0 };
}

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  client.state.selfGuid = SELF;
  await client.loginCharacter(SELF);
  await settle();
  const fields = new Map();
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1"), ITEM);
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1") + 2, PLAIN);
  setGuid(fields, offset("PLAYER_FIELD_INV_SLOT_HEAD") + 4 * 2, EQUIPPED);
  client.state.objects.set(SELF, { ...object(SELF, 4, []), fields });
  client.state.objects.set(ITEM, object(ITEM, 1, [[offset("OBJECT_FIELD_ENTRY"), ITEM_ENTRY]]));
  client.state.objects.set(PLAIN, object(PLAIN, 1, [[offset("OBJECT_FIELD_ENTRY"), PLAIN_ENTRY]]));
  client.state.objects.set(EQUIPPED, object(EQUIPPED, 1, [[offset("OBJECT_FIELD_ENTRY"), ITEM_ENTRY]]));
  client.state.objects.set(VENDOR, object(VENDOR, 3, []));
  client.itemTemplates.set(ITEM_ENTRY, template(ITEM_ENTRY, 0x1000));
  client.itemTemplates.set(PLAIN_ENTRY, template(PLAIN_ENTRY, 0));
  client.itemTemplates.set(TOKEN_ENTRY, template(TOKEN_ENTRY, 0));
  client.playedTime = { total: 20_000, atLevel: 100 };
  client.playedTimeReceivedAt = performance.now();
  connection.sent.length = 0;
  return { client, connection };
}

const sentOf = (connection, opcode) => connection.sent.filter((packet) => packet.opcode === opcode);

test("info is asked once per item whose template has ITEM_FLAG_ITEM_PURCHASE_RECORD", async () => {
  const { client, connection } = await loggedIn();
  assert.equal(client.requestItemRefundInfo(ITEM), true);
  assert.equal(client.requestItemRefundInfo(ITEM), false, "asked once (0x007089e0 flag 4)");
  assert.equal(client.requestItemRefundInfo(PLAIN), false, "no purchase record bit");
  assert.deepEqual(sentOf(connection, OPCODES.CMSG_ITEM_REFUND_INFO).map((packet) => packet.payload), [[...buildItemRefundInfo(ITEM)]]);
  client.close();
});

test("SMSG_LIST_INVENTORY sweeps equipment, backpack and bags; the answer is kept for known items only", async () => {
  const { client, connection } = await loggedIn();
  client.openVendor(VENDOR);
  connection.push(OPCODES.SMSG_LIST_INVENTORY, new PacketWriter().u64(VENDOR).u8(0).u8(0).toUint8Array());
  await settle();
  assert.deepEqual(sentOf(connection, OPCODES.CMSG_ITEM_REFUND_INFO).map((packet) => packet.payload).sort(),
    [[...buildItemRefundInfo(ITEM)], [...buildItemRefundInfo(EQUIPPED)]].sort());
  connection.push(OPCODES.SMSG_ITEM_REFUND_INFO_RESPONSE, infoPayload(ITEM, 19_000));
  connection.push(OPCODES.SMSG_ITEM_REFUND_INFO_RESPONSE, infoPayload(0x4000_0000_0000_0999n, 19_000));
  await settle();
  assert.equal(client.itemRefunds.info.get(ITEM)?.purchasedAtPlayed, 19_000);
  assert.equal(client.itemRefunds.info.size, 1, "a record for an unknown item is dropped (0x006d1650)");

  assert.equal(client.refundItem(ITEM), undefined);
  assert.deepEqual(sentOf(connection, OPCODES.CMSG_ITEM_REFUND).map((packet) => packet.payload), [[...buildItemRefund(ITEM)]]);
  assert.equal(client.refundItem(PLAIN), "ERR_INTERNAL_BAG_ERROR", "no record");
  client.closeVendor();
  assert.equal(client.refundItem(ITEM), "ERR_INTERNAL_BAG_ERROR", "no merchant open (0x005d91b0)");
  assert.equal(sentOf(connection, OPCODES.CMSG_ITEM_REFUND).length, 1);

  const lines = [];
  client.events.on("CHAT_MESSAGE", (message) => lines.push(message.text));
  const errors = [];
  client.events.on("ITEM_REFUND_ERROR", ({ error }) => errors.push(error));
  connection.push(OPCODES.SMSG_ITEM_REFUND_RESULT, resultPayload(ITEM, 10));
  connection.push(OPCODES.SMSG_ITEM_REFUND_RESULT, resultPayload(ITEM, 0, { money: 12_000, honor: 0, arena: 0, items: [[TOKEN_ENTRY, 15]] }));
  await settle();
  assert.deepEqual(errors, ["ERR_INV_FULL"]);
  assert.equal(lines.length, 3, "ITEM_REFUND_MSG, the money, the token");
  client.close();
});

function seamOf(world) {
  const events = [];
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, monotonic: () => performance.now(),
    globalCooldownUntil: () => 0, castSpell: () => {}, itemTexture: (entry) => `Interface\\Icons\\Item${entry}`,
  });
  seam.attach({ now: () => 0, fire: (event, ...args) => { events.push([event, ...args]); return 1; } });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  return { seam, events, call };
}

test("the stock C API answers from the record: five values, cost items, refund, nothing without time", async () => {
  const { client, connection } = await loggedIn();
  client.openVendor(VENDOR);
  connection.push(OPCODES.SMSG_LIST_INVENTORY, new PacketWriter().u64(VENDOR).u8(0).u8(0).toUint8Array());
  connection.push(OPCODES.SMSG_ITEM_REFUND_INFO_RESPONSE, infoPayload(ITEM, 19_000, { honor: 1500, items: [[TOKEN_ENTRY, 15], [0, 0], [PLAIN_ENTRY, 2]] }));
  connection.push(OPCODES.SMSG_ITEM_REFUND_INFO_RESPONSE, infoPayload(EQUIPPED, 19_000));
  await settle();
  const { seam, events, call } = seamOf(client);
  const info = call("GetContainerItemPurchaseInfo", 0, 1);
  assert.deepEqual(info.slice(0, 4), [12_000, 1500, 0, 2]);
  assert.ok(info[4] > 6100 && info[4] <= 6200, `about 7200 − 1000 seconds left, got ${info[4]}`);
  assert.deepEqual(call("GetContainerItemPurchaseInfo", 0, 2), [], "no record: nothing, not nils");
  assert.deepEqual(call("GetContainerItemPurchaseInfo", 0, 5, 1).slice(0, 4), [12_000, 0, 0, 1], "equipped slot 5");
  assert.deepEqual(call("GetContainerItemPurchaseInfo", 0, 20, 1), [], "only inventory slots 1-19");
  const first = call("GetContainerItemPurchaseItem", 0, 1, 1);
  assert.equal(first[0], `Interface\\Icons\\Item${TOKEN_ENTRY}`);
  assert.equal(first[1], 15);
  assert.match(first[2], /\|Hitem:29434:/);
  assert.equal(call("GetContainerItemPurchaseItem", 0, 1, 2)[1], 2, "the second counted item, skipping the empty column");
  assert.deepEqual(call("GetContainerItemPurchaseItem", 0, 1, 3), []);

  call("ContainerRefundItemPurchase", 0, 1);
  assert.deepEqual(sentOf(connection, OPCODES.CMSG_ITEM_REFUND).map((packet) => packet.payload), [[...buildItemRefund(ITEM)]]);
  call("ContainerRefundItemPurchase", 0, 2);
  assert.deepEqual(events.filter(([event]) => event === "UI_ERROR_MESSAGE").length, 1, "ERR_INTERNAL_BAG_ERROR");

  // An enchanted item shows no refund (0x00708ac0); nor does one being looted (0x00bfa8d8).
  client.state.objects.get(ITEM).fields.set(offset("ITEM_FIELD_ENCHANTMENT_1_1"), 1897);
  assert.deepEqual(call("GetContainerItemPurchaseInfo", 0, 1), []);
  client.state.objects.get(ITEM).fields.delete(offset("ITEM_FIELD_ENCHANTMENT_1_1"));
  client.loot = { guid: ITEM, lootType: 0, gold: 0, slots: [] };
  assert.deepEqual(call("GetContainerItemPurchaseInfo", 0, 1), []);
  client.loot = undefined;
  // Two hours of played time later there is nothing to refund.
  client.playedTime = { total: 26_300, atLevel: 100 };
  assert.deepEqual(call("GetContainerItemPurchaseInfo", 0, 1), []);
  assert.equal(frameXmlRefundBlockedByEnchant(client.state.objects.get(PLAIN)), false);
  seam.detach();
  client.close();
});

test("an enchant on a refundable purchase asks END_REFUND first; EndRefund(1) sends it", async () => {
  const { client, connection } = await loggedIn();
  client.itemRefunds.info.set(ITEM, { money: 0, honor: 1500, arena: 0, items: [], purchasedAtPlayed: 19_000 });
  const ENCHANT = 20_023;
  const TEMPORARY = 3_829;
  const spells = (id) => (id === ENCHANT ? { effects: [53, 0, 0], effectMiscValue: [1897, 0, 0] }
    : id === TEMPORARY ? { effects: [54, 0, 0], effectMiscValue: [26, 0, 0] } : undefined);
  client.knownSpells = [{ id: ENCHANT, slot: 0 }, { id: TEMPORARY, slot: 1 }];
  const item = client.state.objects.get(ITEM);
  cursor.armItemTarget(client, ENCHANT);
  const outcome = cursor.targetItemWithCursor(item, ITEM, client, spells, () => undefined, () => undefined);
  assert.deepEqual(outcome, { kind: "confirm", event: "END_REFUND", oldName: "", newName: "" });
  assert.equal(sentOf(connection, OPCODES.CMSG_CAST_SPELL).length, 0, "nothing sent before the answer");
  assert.deepEqual(cursor.bindEnchantWithCursor(client, spells, () => undefined, () => undefined), { kind: "sent" },
    "EndRefund(1) is 0x005210d0 answered, like BindEnchant");
  assert.equal(sentOf(connection, OPCODES.CMSG_CAST_SPELL).length, 1);

  cursor.armItemTarget(client, TEMPORARY);
  assert.deepEqual(cursor.targetItemWithCursor(item, ITEM, client, spells, () => undefined, () => undefined), { kind: "sent" },
    "a temporary enchant (54) never asks");
  client.playedTime = { total: 26_300, atLevel: 100 };
  cursor.armItemTarget(client, ENCHANT);
  assert.deepEqual(cursor.targetItemWithCursor(item, ITEM, client, spells, () => undefined, () => undefined), { kind: "sent" },
    "no time left, no question");
  cursor.cancelItemTarget();
  client.close();
});

test("GetContainerItemPurchaseItem walks the cost columns with an item id (0x005d8f70), the count is by count", async () => {
  // Wow.exe keeps ids at record +0xc and counts at +0x20 (0x006d1650); 0x005d8d80 counts the
  // columns with a count, 0x005d8f70 indexes the columns with an item id.
  const { FrameXmlRefundModel } = await import("../dist/code/browser/framexml/FrameXmlRefund.js");
  const item = { guid: ITEM, typeId: 1, fields: new Map() };
  const info = { money: 0, honor: 0, arena: 0, purchasedAtPlayed: 0,
    items: [{ itemId: TOKEN_ENTRY, count: 15 }, { itemId: PLAIN_ENTRY, count: 0 }, { itemId: 777, count: 3 },
      { itemId: 0, count: 0 }, { itemId: 0, count: 0 }] };
  const model = new FrameXmlRefundModel({
    item: () => ({ guid: ITEM, item }), info: () => info, played: () => 100, lootGuid: () => undefined,
    itemTexture: (entry) => `tex${entry}`, itemLink: (entry) => `link${entry}`, refund: () => undefined,
  });
  assert.equal(model.purchaseInfo(0, 1, false)[3], 2);
  assert.deepEqual(model.purchaseItem(0, 1, 2, false), [`tex${PLAIN_ENTRY}`, 0, `link${PLAIN_ENTRY}`]);
  assert.deepEqual(model.purchaseItem(0, 1, 3, false), ["tex777", 3, "link777"]);
  assert.equal(model.purchaseItem(0, 1, 4, false), undefined);
});

test("GetSocketItemRefundable is the refund record, not the item flag (0x005c5470 → 0x005c50e0)", async () => {
  const { createLiveFrameXmlSocket } = await import("../dist/code/browser/framexml/FrameXmlSocketLive.js");
  const { client } = await loggedIn();
  client.itemTemplates.set(ITEM_ENTRY, { ...template(ITEM_ENTRY, 0x1000), sockets: [{ color: 2 }, { color: 0 }, { color: 0 }] });
  const slot = { index: 0, item: client.state.objects.get(ITEM), guid: ITEM, bag: 255, slot: 23 };
  const model = createLiveFrameXmlSocket({
    world: () => client, equipment: () => undefined, container: (bag, index) => (bag === 0 && index === 1 ? slot : undefined),
    cursorSource: () => undefined, setCursor() {}, clearCursor() {}, now: () => 0, enchantments: () => undefined,
  });
  model.onOpenRequest = () => true;
  assert.equal(model.request({ location: 1, bag: 0, slot: 1 }), true);
  // ITEM_FIELD_FLAG_REFUNDABLE (0x1000) alone does not answer: the client has no record yet.
  client.state.objects.get(ITEM).fields.set(offset("ITEM_FIELD_FLAGS"), 0x1000);
  assert.equal(model.socketItemRefundable(), false);
  client.itemRefunds.info.set(ITEM, { money: 0, honor: 1500, arena: 0, items: [], purchasedAtPlayed: 19_000 });
  assert.equal(model.socketItemRefundable(), true, "a record with time left");
  client.state.objects.get(ITEM).fields.set(offset("ITEM_FIELD_ENCHANTMENT_1_1") + 2 * 3, 3621);
  assert.equal(model.socketItemRefundable(), false, "a socketed gem ends it (0x00708ac0)");
  client.state.objects.get(ITEM).fields.delete(offset("ITEM_FIELD_ENCHANTMENT_1_1") + 2 * 3);
  client.state.objects.get(ITEM).fields.set(offset("ITEM_FIELD_FLAGS"), 0);
  assert.equal(model.socketItemRefundable(), true, "the flag does not matter either way");
  client.playedTime = { total: 26_300, atLevel: 100 };
  assert.equal(model.socketItemRefundable(), false, "no time left");
  client.close();
});

test("the stock TradeSkillFrame's enchant asks END_REFUND(1) too; EndRefund(1) casts it (0x005210d0, 0x00523370)", async () => {
  const { createCannedFrameXmlTradeSkill, FRAMEXML_CANNED_ENCHANTING, FRAMEXML_CANNED_BRACERS_GUID } =
    await import("../dist/code/browser/framexml/FrameXmlTradeSkillCanned.js");
  const { model, world } = createCannedFrameXmlTradeSkill();
  const events = [];
  model.attach({ fire: (event, ...args) => { events.push([event, ...args]); return 1; }, now: () => 100 });
  const host = { tradeSkill: model };
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](host, args);
  assert.equal(model.open(FRAMEXML_CANNED_ENCHANTING), true);
  assert.equal(model.show(), true);
  world.refundItems.add(FRAMEXML_CANNED_BRACERS_GUID);
  call("DoTradeSkill", 3, 1);
  events.length = 0;
  assert.equal(model.targetItem(FRAMEXML_CANNED_BRACERS_GUID), true);
  assert.deepEqual(events, [["END_REFUND", 1]], "asked with the kind EndRefund answers");
  assert.deepEqual(world.calls, [], "nothing before the answer");
  assert.deepEqual(call("SpellCanTargetItem"), [true], "the enchant still waits");
  assert.equal(model.bindEnchant(), true, "EndRefund(1) re-runs 0x005210d0 answered, as BindEnchant does");
  assert.deepEqual(world.calls, [{ kind: "item", spellId: 7418, guid: FRAMEXML_CANNED_BRACERS_GUID }]);
});
