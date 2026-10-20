import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 5 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-live-merchant-seam.test.mjs
{
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { itemChatLink } = await import("../dist/code/browser/ui/ChatLink.js");

class FakeEvents {
  #listeners = new Map();

  on(name, listener) {
    let listeners = this.#listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(name, listeners);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  emit(name, payload = {}) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
}

function object(guid, entry = 0) {
  return {
    guid,
    typeId: entry === 0 ? 4 : 3,
    position: undefined,
    movementFlags: 0,
    updateFlags: 0,
    targetGuid: undefined,
    runSpeed: undefined,
    turnRate: undefined,
    motion: undefined,
    glide: undefined,
    transport: undefined,
    speeds: undefined,
    transportTime: undefined,
    fields: new Map(entry === 0 ? [] : [[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry]]),
  };
}

const extendedCost = {
  honor: 125, arena: 20, arenaBracket: 0, rating: 0,
  items: [{ entry: 6948, count: 2 }],
};

function fixture(costFor = (id) => id === 4 ? extendedCost : undefined) {
  const selfGuid = 0x10n;
  const vendorGuid = 0x600n;
  const buybackGuid = 0x701n;
  const secondBuybackGuid = 0x703n;
  const player = object(selfGuid);
  const vendorObject = object(vendorGuid);
  const buybackObject = object(buybackGuid, 13446);
  const secondBuybackObject = object(secondBuybackGuid, 6948);
  buybackObject.fields.set(UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 2);
  buybackObject.fields.set(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset, 123);
  buybackObject.fields.set(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + 2 * 3, 456);
  buybackObject.fields.set(UPDATE_FIELDS.ITEM_FIELD_RANDOM_PROPERTIES_ID.offset, 77);
  buybackObject.fields.set(UPDATE_FIELDS.ITEM_FIELD_PROPERTY_SEED.offset, 3);
  secondBuybackObject.fields.set(UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 1);
  const buybackBase = UPDATE_FIELDS.PLAYER_FIELD_VENDORBUYBACK_SLOT_1.offset;
  player.fields.set(buybackBase + 2, Number(buybackGuid & 0xffffffffn));
  player.fields.set(buybackBase + 3, Number(buybackGuid >> 32n));
  // Leave physical slot 76 empty; the second visible row is the absolute slot 77.
  player.fields.set(buybackBase + 6, Number(secondBuybackGuid & 0xffffffffn));
  player.fields.set(buybackBase + 7, Number(secondBuybackGuid >> 32n));
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_BUYBACK_PRICE_1.offset + 1, 900);
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_BUYBACK_PRICE_1.offset + 3, 100);
  const events = new FakeEvents();
  const world = {
    mapId: 0,
    worldStateContext: undefined,
    state: {
      selfGuid,
      objects: new Map([
        [selfGuid, player], [vendorGuid, vendorObject], [buybackGuid, buybackObject],
        [secondBuybackGuid, secondBuybackObject],
      ]),
    },
    names: new Map([[vendorGuid, "Живой торговец"]]),
    creatureTemplates: new Map(),
    vendor: {
      guid: vendorGuid,
      items: [
        { slot: 7, itemId: 13446, displayId: 1, leftInStock: 4, price: 1250, maxDurability: 0, buyCount: 1, extendedCost: 0 },
        { slot: 9, itemId: 90001, displayId: 2, leftInStock: 1, price: 1, maxDurability: 0, buyCount: 1, extendedCost: 4 },
      ],
    },
    itemTemplates: new Map([
      [13446, { found: true, name: "Лечебное зелье", stackable: 20, quality: 1 }],
      [6948, { found: true, name: "Камень возвращения", stackable: 1, quality: 1 }],
    ]),
    actionButtons: [],
    casts: new Map(),
    channels: new Map(),
    cooldownSnapshots: new Map(),
    partyStats: new Map(),
    questPoi: new Map(),
    chatLog: [],
    events,
    cooldownRemaining: () => 0,
    aurasFor: () => [],
  };
  const fired = [];
  const calls = { buy: [], buyback: [], close: 0 };
  const counters = { itemInfo: 0, itemTexture: 0 };
  world.buyFromVendor = (slot, count) => calls.buy.push([slot, count]);
  world.buybackFromVendor = (slot) => calls.buyback.push(slot);
  world.closeVendor = () => {
    calls.close += 1;
    world.vendor = undefined;
  };
  const pump = {
    now: () => 100,
    fire: (event, ...args) => {
      fired.push([event, ...args]);
      return 1;
    },
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: () => undefined,
    monotonic: () => 100000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
    itemInfo: (entry) => {
      counters.itemInfo += 1;
      if (entry === 13446) return { name: "Зелье из metadata", texture: "Interface\\Icons\\INV_Potion_54" };
      if (entry === 6948) return { name: "Камень возвращения", texture: "Interface\\Icons\\INV_Misc_Rune_01" };
      return undefined;
    },
    vendorCost: costFor,
    itemTexture: () => {
      counters.itemTexture += 1;
      return undefined;
    },
  });
  return { seam, world, events, fired, pump, calls, counters };
}

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

test("live Merchant projects all rows, preserves physical slots, and deduplicates lifecycle", () => {
  const { seam, world, fired, pump, calls, counters } = fixture();
  const vendorGuid = world.vendor.guid;
  world.names.delete(vendorGuid);
  seam.attach(pump);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.merchantShow), [
    [FRAMEXML_SEAM_EVENTS.merchantShow],
  ]);
  fired.length = 0;

  assert.deepEqual(call("UnitName", seam, "NPC"), []);
  // Extended-cost rows are exposed with the original price fields; the server validates payment.
  assert.deepEqual(call("GetMerchantNumItems", seam), [2], "both rows are exposed");
  assert.deepEqual(call("GetMerchantItemInfo", seam, 1), [
    "Зелье из metadata", "Interface\\Icons\\INV_Potion_54", 1250, 1, 4, true, false,
  ]);
  assert.deepEqual(call("GetMerchantItemCostInfo", seam, 1), [0, 0, 0],
    "an ordinary copper purchase has no alternate cost");
  assert.deepEqual(call("GetMerchantItemInfo", seam, 2), [
    "Предмет 90001", undefined, 1, 1, 1, true, true,
  ]);
  assert.deepEqual(call("GetMerchantItemCostInfo", seam, 2), [125, 20, 1]);
  assert.deepEqual(call("GetMerchantItemCostItem", seam, 2, 1), [
    "Interface\\Icons\\INV_Misc_Rune_01", 2,
    itemChatLink(6948, 1, "Камень возвращения"),
  ]);
  assert.deepEqual(call("GetMerchantItemCostItem", seam, 2, 2), []);
  const requiredLink = itemChatLink(6948, 1, "Камень возвращения");
  assert.deepEqual(call("GetItemInfo", seam, requiredLink), [
    "Камень возвращения", requiredLink, 1,
  ], "stock token confirmation receives the known required-item rarity");
  assert.deepEqual(call("GetMerchantItemLink", seam, 2), [],
    "a missing name/quality cannot produce a trustworthy template link");
  call("BuyMerchantItem", seam, 1, 2);
  assert.deepEqual(calls.buy, [[7, 2]], "buy uses the vendor's source slot, not projected row index");
  call("BuyMerchantItem", seam, 2, 1);
  assert.deepEqual(calls.buy, [[7, 2], [9, 1]], "the extended-cost row buys through the same opcode");
  assert.deepEqual(call("GetBuybackItemInfo", seam, 1), [
    "Зелье из metadata", "Interface\\Icons\\INV_Potion_54", 900, 2, 2, true,
  ]);
  assert.deepEqual(call("GetBuybackItemLink", seam, 1), [
    "|cffffffff|Hitem:13446:123:456:0:0:0:77:3:0|h[Лечебное зелье]|h|r",
  ], "buyback links retain the item's enchantments and random properties");
  assert.deepEqual(call("GetBuybackItemLink", seam, 2), [
    "|cffffffff|Hitem:6948:0:0:0:0:0:0:0:0|h[Камень возвращения]|h|r",
  ], "a compact buyback row resolves its own physical item");
  assert.deepEqual(call("GetBuybackItemLink", seam, 3), [], "a missing buyback row has no link");
  call("BuybackItem", seam, 1);
  call("BuybackItem", seam, 2);
  assert.deepEqual(calls.buyback, [75, 77], "buyback uses each compact row's physical absolute slot");

  seam.merchantChanged("update");
  seam.tick(0.01);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.merchantUpdate), [],
    "callback/poll with unchanged vendor does not duplicate UPDATE");
  const stableResolverCalls = counters.itemInfo + counters.itemTexture;
  seam.tick(0.02);
  assert.equal(counters.itemInfo + counters.itemTexture, stableResolverCalls,
    "stable sub-60ms ticks do not resolve merchant metadata");
  world.itemTemplates.set(90001, { found: true, name: "Эмблемный предмет", quality: 4, stackable: 1 });
  assert.deepEqual(call("GetMerchantItemLink", seam, 2), [
    itemChatLink(90001, 4, "Эмблемный предмет"),
  ]);
  assert.deepEqual(call("GetItemInfo", seam, 90001), [
    "Эмблемный предмет", itemChatLink(90001, 4, "Эмблемный предмет"), 4,
  ], "GetItemInfo by entry uses the same cached template as the merchant link");
  assert.deepEqual(call("GetItemInfo", seam, "|Hitem:999999|h[Unknown]|h"), [],
    "an unknown item remains nil rather than inheriting the hyperlink's display text");
  seam.merchantChanged("update");
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.merchantUpdate), [
    [FRAMEXML_SEAM_EVENTS.merchantUpdate],
  ], "late item-template link data repaints the stock row once");
  fired.length = 0;
  world.vendor.items[0].price = 1300;
  seam.merchantChanged("update");
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.merchantUpdate), [
    [FRAMEXML_SEAM_EVENTS.merchantUpdate],
  ]);
  fired.length = 0;
  seam.tick(0.03);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.merchantUpdate), [],
    "the next tick observes the atomically advanced signature");

  world.names.set(vendorGuid, "Живой торговец");
  seam.tick(0.10);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.merchantUpdate), [
    [FRAMEXML_SEAM_EVENTS.merchantUpdate],
  ], "late vendor name resolution repaints the stock title once");
  assert.deepEqual(call("UnitName", seam, "NPC"), ["Живой торговец"]);
  fired.length = 0;
  seam.tick(0.11);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.merchantUpdate), [],
    "unchanged vendor name does not duplicate merchant update");

  // Buyback state is carried by PLAYER_FIELD_* updates rather than the vendor callback.  A
  // changed price must repaint the shelf once, while the following poll stays quiet.
  fired.length = 0;
  const player = world.state.objects.get(world.state.selfGuid);
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_BUYBACK_PRICE_1.offset + 1, 950);
  seam.tick(0.17);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.merchantUpdate), [
    [FRAMEXML_SEAM_EVENTS.merchantUpdate],
  ], "buyback field change emits one merchant update");
  fired.length = 0;
  seam.tick(0.18);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.merchantUpdate), [],
    "unchanged buyback fields do not duplicate merchant update");

  world.closeVendor();
  seam.merchantChanged("closed");
  seam.tick(0.24);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.merchantClosed), [
    [FRAMEXML_SEAM_EVENTS.merchantClosed],
  ]);
  assert.equal(calls.close, 1);
  assert.deepEqual(call("GetBuybackItemLink", seam, 1), [], "closing the vendor removes the buyback context");
  seam.detach();
});

test("extended-cost purchase stays blocked while its DBC row is pending or unavailable", () => {
  let resolved = false;
  const { seam, calls, pump } = fixture((id) => id === 4 && resolved ? extendedCost : undefined);
  seam.attach(pump);
  assert.deepEqual(call("GetMerchantItemInfo", seam, 2), [
    "Предмет 90001", undefined, 1, 1, 1, false, true,
  ], "stock shows the unresolved alternate-price row as unusable");
  assert.deepEqual(call("GetMerchantItemCostInfo", seam, 2), [0, 0, 0]);
  call("BuyMerchantItem", seam, 2, 1);
  assert.deepEqual(calls.buy, [], "a stock zero-cost fallback cannot bypass the missing DBC row");

  // A failed catalog request leaves the row unresolved until a later successful retry.
  call("BuyMerchantItem", seam, 2, 1);
  assert.deepEqual(calls.buy, [], "repeated attempts during a catalog failure remain blocked");
  call("BuyMerchantItem", seam, 1, 1);
  assert.deepEqual(calls.buy, [[7, 1]], "ordinary money rows are unaffected");

  resolved = true;
  seam.merchantChanged("update");
  assert.deepEqual(call("GetMerchantItemInfo", seam, 2), [
    "Предмет 90001", undefined, 1, 1, 1, true, true,
  ]);
  call("BuyMerchantItem", seam, 2, 1);
  assert.deepEqual(calls.buy, [[7, 1], [9, 1]], "the server-validated buy resumes once cost is known");
  seam.detach();
});

// Wow.exe GetMerchantItemMaxStack (0x005842d0) answers 1 for a row sold BuyCount ≥ 2 at a time and the
// item's stack otherwise (1 while the item is unknown); BuyMerchantItem (0x005854c0) clamps its count
// to 255 — the server reads the uint32 into a uint8 (ItemHandler.cpp:602-613, Player.cpp:22181).
test("stock SPLITSTACK on a vendor row: a pack row is one, the count is a byte", () => {
  const { seam, world, calls, pump } = fixture();
  world.vendor.items.push(
    { slot: 11, itemId: 2512, displayId: 3, leftInStock: -1, price: 10, maxDurability: 0, buyCount: 200, extendedCost: 0 },
    { slot: 12, itemId: 424242, displayId: 4, leftInStock: -1, price: 10, maxDurability: 0, buyCount: 1, extendedCost: 0 },
  );
  world.itemTemplates.set(2512, { found: true, name: "Грубая стрела", stackable: 1000, quality: 1 });
  seam.attach(pump);
  assert.deepEqual(call("GetMerchantItemMaxStack", seam, 1), [20], "an ordinary row: the item's stack");
  assert.deepEqual(call("GetMerchantItemMaxStack", seam, 3), [1], "a pack of 200 arrows is not split");
  assert.deepEqual(call("GetMerchantItemMaxStack", seam, 4), [1], "an item not in the cache yet");
  call("BuyMerchantItem", seam, 1, 300);
  assert.deepEqual(calls.buy, [[7, 255]], "never a count the server's uint8 would wrap");
  seam.detach();
});
}

// ── framexml-merchant-controller.test.mjs
{
const {
  closeFrameXmlMerchant,
  frameXmlMerchantOpen,
  notifyFrameXmlMerchant,
  publishFrameXmlMerchant,
} = await import("../dist/code/browser/framexml/FrameXmlMerchantController.js");

test("Merchant owner is identity-safe and forwards forced metadata refreshes", () => {
  const calls = [];
  let open = false;
  const owner = {
    isOpen: () => open,
    show: () => { open = true; calls.push("show"); },
    hide: () => { open = false; calls.push("hide"); },
    refresh: (event, force) => calls.push([event, force === true]),
  };
  const cleanup = publishFrameXmlMerchant(owner);
  assert.equal(frameXmlMerchantOpen(), false);
  owner.show();
  assert.equal(frameXmlMerchantOpen(), true);
  assert.equal(notifyFrameXmlMerchant("update"), true);
  assert.equal(notifyFrameXmlMerchant("update", true), true);
  assert.deepEqual(calls, ["show", ["update", false], ["update", true]]);
  assert.equal(closeFrameXmlMerchant(), true);
  assert.equal(frameXmlMerchantOpen(), false);
  cleanup();
  assert.equal(notifyFrameXmlMerchant("closed"), false);
});
}

// ── framexml-merchant-cursor.test.mjs
{
// Plan item 3.23 slice E (lane L1, 03.10): `PickupMerchantItem` and the merchant row on the cursor.
// Wow.exe 12340: 0x005853a0 sells a held bag item (0x006d2d40, CMSG_SELL_ITEM; a split part smaller than
// its stack stays held), or puts the listed row on the cursor (0x00520d30: type 5, CURSOR_UPDATE) and
// lets it go when that item is held already; anything else lets go. GetCursorInfo (0x00515200) answers
// "merchant", index; CursorHasItem (0x00515100) is false. PickupContainerItem (0x005d7ff0) and
// PickupInventoryItem (0x005e85d0) buy the row into the clicked place — CMSG_BUY_ITEM_IN_SLOT
// (0x006d2ea0; ItemHandler.cpp:556-596: vendor guid, item, list slot, container guid, u8 slot, u32 count).

const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { PacketReader } = await import("../dist/code/protocol/PacketReader.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { buildBuyItemInSlot } = await import("../dist/code/world/VendorSlotProtocol.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const merchant = await import("../dist/code/browser/framexml/FrameXmlMerchantCursor.js");

const offset = (name) => UPDATE_FIELDS[name].offset;
const PLAYER = 0x10n;
const VENDOR = 0xf130_0000_0000_0042n;
const BREAD = 0x4000_0000_0000_0801n;
const BAG = 0x4000_0000_0000_0802n;

function setGuid(fields, at, guid) {
  fields.set(at, Number(guid & 0xffff_ffffn));
  fields.set(at + 1, Number(guid >> 32n));
}

const object = (guid, typeId, entries = []) => ({
  guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined, fields: new Map(entries),
});

function row(slot, itemId) {
  return { slot, itemId, displayId: 0, leftInStock: -1, price: 10, maxDurability: 0, buyCount: 1, extendedCost: 0 };
}

function fixture() {
  const sent = [];
  const world = new WorldClient({
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload: [...payload] }); },
    close() {},
  });
  const state = new WorldState();
  world.state = state;
  const fields = new Map();
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1"), BREAD);
  setGuid(fields, offset("PLAYER_FIELD_INV_SLOT_HEAD") + 19 * 2, BAG);
  state.objects.set(PLAYER, { ...object(PLAYER, 4), fields });
  state.objects.set(BREAD, object(BREAD, 1, [[offset("OBJECT_FIELD_ENTRY"), 4540], [offset("ITEM_FIELD_STACK_COUNT"), 5]]));
  state.objects.set(BAG, object(BAG, 2, [[offset("OBJECT_FIELD_ENTRY"), 4496], [offset("CONTAINER_FIELD_NUM_SLOTS"), 4]]));
  state.selfGuid = PLAYER;
  world.vendor = { guid: VENDOR, items: [row(1, 159), row(2, 4540), row(3, 0)] };
  world.vendor.items[2].slot = 0;
  const packets = (opcode) => sent.filter((packet) => packet.opcode === opcode);
  return { world, sent, packets };
}

function withSeam(run) {
  const setup = fixture();
  const seam = new LiveWorldSeam({
    world: () => setup.world, store: () => new WorldStore(setup.world.state), spell: () => undefined,
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const events = [];
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  seam.attach({ now: () => 100, fire(event, ...args) { events.push([event, ...args]); return 1; } });
  setup.sent.length = 0;
  const result = run({ ...setup, seam, events, call });
  // An async case keeps the seam attached until it is done: the cursor's events go out in a microtask.
  if (result && typeof result.then === "function") return result.finally(() => seam.detach());
  seam.detach();
  return result;
}

/** CMSG_BUY_ITEM_IN_SLOT read back in ItemHandler.cpp:563's order. */
function buyInSlot(payload) {
  const reader = new PacketReader(Uint8Array.from(payload));
  const read = { vendor: reader.u64(), item: reader.u32(), slot: reader.u32(), bag: reader.u64(), bagSlot: reader.u8(), count: reader.u32() };
  reader.assertFinished();
  return read;
}

test("CMSG_BUY_ITEM_IN_SLOT: vendor, item, list slot, container guid, u8 slot, u32 count", () => {
  assert.deepEqual(buyInSlot(buildBuyItemInSlot(VENDOR, 159, 1, PLAYER, 25, 1)),
    { vendor: VENDOR, item: 159, slot: 1, bag: PLAYER, bagSlot: 25, count: 1 });
  assert.equal(buildBuyItemInSlot(1n, 2, 3, 4n, 5, 6).length, 8 + 4 + 4 + 8 + 1 + 4);
});

test("PickupMerchantItem puts the listed row on the cursor as \"merchant\", index; the same row again lets go", async () => {
  await withSeam(async ({ call, events }) => {
    call("PickupMerchantItem", 1);
    assert.deepEqual(call("GetCursorInfo"), ["merchant", 1]);
    assert.deepEqual(call("CursorHasItem"), [false], "type 5 is no item (0x00515100)");
    await Promise.resolve();
    assert.ok(events.some(([event]) => event === "CURSOR_UPDATE"));
    assert.equal(events.some(([event]) => event === "ACTIONBAR_SHOWGRID"), false, "no action-bar grid for a row");
    call("PickupMerchantItem", "1");
    assert.deepEqual(call("GetCursorInfo"), [], "the held item again: ClearCursor");
    call("PickupMerchantItem", 2);
    call("PickupMerchantItem", 1);
    assert.deepEqual(call("GetCursorInfo"), ["merchant", 1], "another row replaces it");
    call("PickupMerchantItem", 3);
    assert.deepEqual(call("GetCursorInfo"), [], "a row without a list slot: let go");
    call("PickupMerchantItem", 2);
    call("PickupMerchantItem", 0);
    assert.deepEqual(call("GetCursorInfo"), [], "MerchantFrame's OnMouseUp: PickupMerchantItem(0) lets go");
  });
});

test("dropped on a backpack, bag or paper-doll slot the row is bought there and the hand lets go", () => {
  withSeam(({ call, packets }) => {
    call("PickupMerchantItem", 2);
    call("PickupContainerItem", 0, 3);
    const backpack = packets(OPCODES.CMSG_BUY_ITEM_IN_SLOT).map((packet) => buyInSlot(packet.payload));
    assert.deepEqual(backpack, [{ vendor: VENDOR, item: 4540, slot: 2, bag: PLAYER, bagSlot: 25, count: 1 }]);
    assert.deepEqual(call("GetCursorInfo"), []);
    call("PickupMerchantItem", 1);
    call("PickupContainerItem", 1, 2);
    assert.deepEqual(buyInSlot(packets(OPCODES.CMSG_BUY_ITEM_IN_SLOT)[1].payload),
      { vendor: VENDOR, item: 159, slot: 1, bag: BAG, bagSlot: 1, count: 1 }, "a carried bag: its guid and slot");
    call("PickupMerchantItem", 1);
    call("PickupInventoryItem", 11);
    assert.deepEqual(buyInSlot(packets(OPCODES.CMSG_BUY_ITEM_IN_SLOT)[2].payload),
      { vendor: VENDOR, item: 159, slot: 1, bag: PLAYER, bagSlot: 10, count: 1 }, "the paper doll: id − 1");
    assert.deepEqual(call("GetCursorInfo"), []);
    call("PickupMerchantItem", 1);
    call("PickupInventoryItem", 0);
    assert.equal(packets(OPCODES.CMSG_BUY_ITEM_IN_SLOT).length, 3, "the AmmoSlot buys nothing");
    assert.deepEqual(call("GetCursorInfo"), [], "and lets the row go");
    assert.equal(packets(OPCODES.CMSG_BUY_ITEM).length, 0);
  });
});

test("with no merchant open the row stays held and nothing is sent", () => {
  withSeam(({ call, packets, world }) => {
    call("PickupMerchantItem", 1);
    world.vendor = undefined;
    call("PickupContainerItem", 0, 3);
    call("PickupInventoryItem", 11);
    assert.equal(packets(OPCODES.CMSG_BUY_ITEM_IN_SLOT).length, 0);
    assert.deepEqual(call("GetCursorInfo"), ["merchant", 1]);
    call("ClearCursor");
    assert.deepEqual(call("GetCursorInfo"), []);
  });
});

test("a held bag item is sold by PickupMerchantItem; a split part smaller than its stack stays held", () => {
  withSeam(({ call, packets, seam }) => {
    call("PickupContainerItem", 0, 1);
    assert.equal(seam.cursorHasItem(), true);
    call("PickupMerchantItem", 0);
    const sold = packets(OPCODES.CMSG_SELL_ITEM);
    assert.equal(sold.length, 1);
    const reader = new PacketReader(Uint8Array.from(sold[0].payload));
    assert.deepEqual([reader.u64(), reader.u64(), reader.u32()], [VENDOR, BREAD, 0], "the whole item (count 0)");
    assert.equal(seam.cursorHasItem(), false);
    assert.deepEqual(call("GetCursorInfo"), []);
    call("SplitContainerItem", 0, 1, 2);
    assert.equal(seam.cursorHasItem(), true);
    call("PickupMerchantItem", 1);
    assert.equal(packets(OPCODES.CMSG_SELL_ITEM).length, 1, "a part of a stack is not sold");
    assert.equal(seam.cursorHasItem(), true, "and stays held");
    call("ClearCursor");
  });
});

test("UseContainerItem lets the row go first (0x005d8650 → 0x00519280), then the click is the seam's", () => {
  withSeam(({ call, packets }) => {
    call("PickupMerchantItem", 1);
    call("UseContainerItem", 0, 1);
    assert.deepEqual(call("GetCursorInfo"), []);
    assert.equal(packets(OPCODES.CMSG_SELL_ITEM).length, 1, "at the merchant the right-clicked bread is sold");
    assert.equal(packets(OPCODES.CMSG_BUY_ITEM_IN_SLOT).length, 0);
  });
});

test("the pieces: the container guid, no merchant, no row", () => {
  const { world } = fixture();
  assert.equal(merchant.frameXmlMerchantBagGuid(world.state, 255), PLAYER);
  assert.equal(merchant.frameXmlMerchantBagGuid(world.state, 19), BAG);
  assert.equal(merchant.frameXmlMerchantBagGuid(world.state, 20), undefined);
  const calls = [];
  const buyer = { state: world.state, vendor: world.vendor, buyFromVendorInSlot: (...args) => { calls.push(args); return true; } };
  assert.equal(merchant.frameXmlBuyMerchantItemInSlot(buyer, { slot: 2, itemId: 4540 }, { bag: 255, slot: 30 }), true);
  assert.deepEqual(calls, [[2, 4540, PLAYER, 30, 1]]);
  assert.equal(merchant.frameXmlBuyMerchantItemInSlot({ ...buyer, vendor: undefined }, { slot: 2, itemId: 4540 }, { bag: 255, slot: 30 }), undefined);
  assert.equal(merchant.frameXmlBuyMerchantItemInSlot(buyer, undefined, { bag: 255, slot: 30 }), false);
  assert.equal(merchant.frameXmlBuyMerchantItemInSlot(buyer, { slot: 0, itemId: 4540 }, { bag: 255, slot: 30 }), false, "no list slot");
  assert.equal(merchant.frameXmlBuyMerchantItemInSlot(buyer, { slot: 2, itemId: 4540 }, { bag: 20, slot: 0 }), false, "no such bag");
  assert.equal(calls.length, 1);
});
}

// ── framexml-merchant-metadata.test.mjs
{
const { createFrameXmlMerchantMetadataCoordinator } = await import(
  "../dist/code/browser/framexml/FrameXmlMerchantMetadata.js",
);

function vendor() {
  return {
    guid: 0x600n,
    items: [
      { slot: 1, itemId: 100, displayId: 1, leftInStock: 3, price: 25, maxDurability: 0, buyCount: 1, extendedCost: 0 },
      { slot: 4, itemId: 200, displayId: 2, leftInStock: 3, price: 25, maxDurability: 0, buyCount: 1, extendedCost: 7 },
    ],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("merchant metadata prefetch includes extended rows and turn-ins, coalescing wire/http", async () => {
  let currentVendor = vendor();
  let costsLoaded = false;
  const cache = new Map();
  const loads = [];
  const pending = [];
  let coordinator;
  const updates = [];
  const metadata = {
    get(entry) { return cache.get(entry); },
    load(entries) {
      loads.push([...entries]);
      const next = deferred();
      pending.push(next);
      return next.promise;
    },
  };
  coordinator = createFrameXmlMerchantMetadataCoordinator({
    vendor: () => currentVendor,
    itemMetadata: () => metadata,
    itemTemplate: () => undefined,
    costFor: (id) => id === 7 && costsLoaded ? {
      honor: 125, arena: 20, arenaBracket: 0, rating: 0,
      items: [{ entry: 300, count: 2 }],
    } : undefined,
    onMetadataLoaded() {
      const result = coordinator.refresh("metadata");
      if (result.changed) updates.push(result.signature);
    },
  });

  const initial = coordinator.refresh("vendor");
  assert.equal(initial.changed, true);
  assert.deepEqual(loads, [[100, 200]], "both visible vendor rows are prefetched");
  cache.set(100, { entry: 100, name: "Зелье", displayId: 11, quality: 1, inventoryType: 0, stackable: 20, iconId: 22 });
  cache.set(200, { entry: 200, name: "Эмблемный предмет", displayId: 12, quality: 1, inventoryType: 0, stackable: 1, iconId: 23 });
  pending.shift().resolve(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(updates.length, 1, "HTTP-only completion causes one relevant repaint");

  // The wire callback may arrive after the HTTP promise. The signature is already current.
  const wire = coordinator.refresh("metadata");
  assert.equal(wire.changed, false, "wire+HTTP completion does not duplicate UPDATE");
  cache.set(999, { entry: 999, name: "Чужой предмет", displayId: 13, quality: 1, inventoryType: 0, stackable: 1, iconId: 24 });
  assert.equal(coordinator.refresh("metadata").changed, false,
    "unrelated metadata does not repaint the merchant");

  costsLoaded = true;
  assert.equal(coordinator.refresh("vendor").changed, true,
    "the DBC cost arrival changes the visible price");
  assert.deepEqual(loads, [[100, 200], [300]], "the turn-in item is prefetched after its DBC row arrives");
  cache.set(300, { entry: 300, name: "Эмблема", displayId: 13, quality: 1, inventoryType: 0, stackable: 20, iconId: 24 });
  pending.shift().resolve(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(updates.length, 2, "turn-in icon/name arrival repaints once");

  currentVendor = {
    ...currentVendor,
    items: [...currentVendor.items, {
      slot: 8, itemId: 400, displayId: 3, leftInStock: 1, price: 30, maxDurability: 0, buyCount: 1, extendedCost: 0,
    }],
  };
  coordinator.refresh("vendor");
  assert.deepEqual(loads, [[100, 200], [300], [400]], "a new row starts one new prefetch");
  pending.shift().reject(new Error("gateway down"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(updates.length, 2, "failed prefetch does not recurse into merchant updates");

  // Once the failure backoff expires in the real cache, a later vendor refresh may retry; the
  // coordinator must not permanently latch the failed request key.
  coordinator.refresh("vendor");
  assert.deepEqual(loads, [[100, 200], [300], [400], [400]], "failed request is released for a later retry");
  pending.shift().reject(new Error("gateway still down"));
});

test("merchant observes metadata completed by another pending loader on the next refresh", () => {
  const currentVendor = vendor();
  const cache = new Map();
  let loadCalls = 0;
  let ownerUpdates = 0;
  const metadata = {
    get(entry) { return cache.get(entry); },
    // A shared AssetWarmup request owns the HTTP work.  This client receives no completion
    // callback, so its bounded metadata refresh must discover the cache entry itself.
    load() {
      loadCalls += 1;
      return Promise.resolve(false);
    },
  };
  const coordinator = createFrameXmlMerchantMetadataCoordinator({
    vendor: () => currentVendor,
    itemMetadata: () => metadata,
    itemTemplate: () => undefined,
    onMetadataLoaded() { ownerUpdates += 1; },
  });

  const initial = coordinator.refresh("vendor");
  assert.equal(initial.changed, true);
  assert.equal(loadCalls, 1);
  cache.set(100, { entry: 100, name: "Зелье из общего запроса", displayId: 11, quality: 1,
    inventoryType: 0, stackable: 20, iconId: 22 });
  const arrived = coordinator.refresh("metadata");
  assert.equal(arrived.changed, true, "cache arrival is visible without a client-owned callback");
  assert.equal(ownerUpdates, 0, "shared-loader completion does not fabricate a callback");
});
}

// ── framexml-merchant-seam.test.mjs
{
const { CannedWorldSeam, CANNED_MERCHANT } =
  await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} binding exists`);
  return [...binding(seam, args)];
}

function pump() {
  const events = [];
  return {
    events,
    now: () => 100,
    fire(event, ...args) { events.push([event, ...args]); return 1; },
  };
}

test("Canned Merchant answers truthful rows, repair-neutral APIs, and NPC context", () => {
  const seam = new CannedWorldSeam();
  const worldPump = pump();
  seam.attach(worldPump);
  worldPump.events.length = 0;
  assert.deepEqual(api(seam, "GetMerchantNumItems"), [0]);
  assert.deepEqual(api(seam, "UnitName", "NPC"), []);
  seam.openMerchant();
  assert.deepEqual(worldPump.events, [[FRAMEXML_SEAM_EVENTS.merchantShow]]);
  assert.deepEqual(api(seam, "UnitName", "NPC"), [CANNED_MERCHANT.name]);
  assert.deepEqual(api(seam, "UnitExists", "NPC"), [true]);
  assert.deepEqual(api(seam, "GetMerchantNumItems"), [2]);
  assert.deepEqual(api(seam, "GetMerchantItemInfo", 1), [
    CANNED_MERCHANT.items[0].name, CANNED_MERCHANT.items[0].texture, 1250, 1, -1, true, false,
  ]);
  assert.deepEqual(api(seam, "GetMerchantItemInfo", 2), [
    CANNED_MERCHANT.items[1].name, CANNED_MERCHANT.items[1].texture, 100, 1, 1, true, false,
  ]);
  assert.deepEqual(api(seam, "GetMerchantItemInfo", 3), []);
  assert.deepEqual(api(seam, "GetMerchantItemCostInfo", 1), [0, 0, 0]);
  assert.deepEqual(api(seam, "GetMerchantItemCostItem", 1, 1), []);
  assert.deepEqual(api(seam, "CanMerchantRepair"), [false]);
  assert.deepEqual(api(seam, "GetRepairAllCost"), [0, false]);
  assert.deepEqual(api(seam, "CanGuildBankRepair"), [false]);
  assert.deepEqual(api(seam, "InRepairMode"), [false]);

  seam.refreshMerchant();
  assert.deepEqual(worldPump.events.slice(-1), [[FRAMEXML_SEAM_EVENTS.merchantUpdate]]);
  seam.closeMerchant();
  assert.deepEqual(worldPump.events.slice(-1), [[FRAMEXML_SEAM_EVENTS.merchantClosed]]);
  assert.deepEqual(api(seam, "UnitName", "NPC"), []);
  seam.detach();
});

test("Canned Merchant routes standard purchases and absolute buyback slots", () => {
  const seam = new CannedWorldSeam();
  seam.attach(pump());
  seam.openMerchant();
  api(seam, "BuyMerchantItem", 2);
  api(seam, "BuyMerchantItem", 1, 3);
  api(seam, "BuyMerchantItem", 2, 0);
  api(seam, "BuybackItem", 1);
  api(seam, "BuybackItem", 0);
  assert.deepEqual(seam.merchantBuyRequests, [{ slot: 2, count: 1 }, { slot: 1, count: 3 }, { slot: 2, count: 1 }]);
  assert.deepEqual(seam.merchantBuybackRequests, [74]);
  seam.detach();
});
}
