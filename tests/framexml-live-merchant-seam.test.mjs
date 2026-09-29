import assert from "node:assert/strict";
import test from "node:test";

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
