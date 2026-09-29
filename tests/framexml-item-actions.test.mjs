import assert from "node:assert/strict";
import test from "node:test";

// The C side of the stock item actions (FrameXmlItemActions.ts, LiveWorldSeam's item sections): which
// packet a right click in the bags, a drop on the paper doll, the bag buttons and the bind prompts
// send, over a fake WorldClient that records them. The realm decides the outcome; this only checks
// the client chooses the packet the original client would.
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_PRELUDE } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_NEUTRAL_PRELUDE } = await import("../dist/code/browser/framexml/FrameXmlNeutralApi.js");
const {
  FRAMEXML_BIND_CONFIRM_EVENTS, FRAMEXML_ITEM_INVENTORY_LOCATION_BAGS, FRAMEXML_ITEM_INVENTORY_LOCATION_PLAYER,
  frameXmlContainerInventoryId, frameXmlEquipmentSlotsForInventoryType,
} = await import("../dist/code/browser/framexml/FrameXmlItemActions.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { EventBus } = await import("../dist/code/world/EventBus.js");

const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
const field = (name) => UPDATE_FIELDS[name].offset;

function place(fields, offset, guid) {
  fields.set(offset, Number(guid & 0xffffffffn));
  fields.set(offset + 1, Number(guid >> 32n));
}

function item(guid, entry, extra = {}) {
  const fields = new Map([[field("OBJECT_FIELD_ENTRY"), entry]]);
  for (const [name, value] of Object.entries(extra)) fields.set(field(name), value);
  return { guid, typeId: 1, fields };
}

function template(entry, name, extra = {}) {
  return {
    entry, found: true, name, quality: 1, itemClass: 4, subClass: 0, flags: 0, inventoryType: 0, bonding: 0,
    stackable: 1, bagFamily: 0, spells: [], itemLevel: 7, requiredLevel: 1, startQuest: 0, pageText: 0,
    containerSlots: 0, maxDurability: 0, ...extra,
  };
}

/**
 * The realm's test character, roughly: a belt and a recipe carried, a worn belt, a bag with a stack.
 * `store`, when given, is the WorldStore double the seam subscribes its player fields on.
 */
function fixture({ handlers = 1, store } = {}) {
  const selfGuid = 0x10n;
  const player = { guid: selfGuid, typeId: 4, fields: new Map() };
  // Copper Chain Belt (2652, bind-on-equip) in backpack slot 1 (wire 255/23); unbound unless a test binds it.
  const belt = item(0x201n, 2652, { ITEM_FIELD_FLAGS: 0 });
  const potion = item(0x202n, 118);
  // Recipe: Longjaw Mud Snapper (6328): class 9, no InventoryType, «Use: teaches» 483 plus the taught 7753.
  const recipe = item(0x203n, 6328);
  const scroll = item(0x204n, 90001, { ITEM_FIELD_FLAGS: 0 });
  const mystery = item(0x205n, 7900);
  const wornBelt = item(0x301n, 1372, { ITEM_FIELD_DURABILITY: 8, ITEM_FIELD_MAXDURABILITY: 40 });
  const wornTrinket = item(0x302n, 90002);
  const wornNeck = item(0x303n, 7901);
  const bag = { guid: 0x400n, typeId: 2, fields: new Map([
    [field("OBJECT_FIELD_ENTRY"), 4496], [field("CONTAINER_FIELD_NUM_SLOTS"), 4],
  ]) };
  const cloth = item(0x401n, 2589, { ITEM_FIELD_STACK_COUNT: 5 });
  const key = item(0x501n, 20815);
  place(player.fields, field("PLAYER_FIELD_PACK_SLOT_1"), belt.guid);
  place(player.fields, field("PLAYER_FIELD_PACK_SLOT_1") + 2, potion.guid);
  place(player.fields, field("PLAYER_FIELD_PACK_SLOT_1") + 4, recipe.guid);
  place(player.fields, field("PLAYER_FIELD_PACK_SLOT_1") + 6, scroll.guid);
  place(player.fields, field("PLAYER_FIELD_PACK_SLOT_1") + 8, mystery.guid);
  place(player.fields, field("PLAYER_FIELD_INV_SLOT_HEAD") + 1 * 2, wornNeck.guid);
  place(player.fields, field("PLAYER_FIELD_INV_SLOT_HEAD") + 5 * 2, wornBelt.guid);
  place(player.fields, field("PLAYER_FIELD_INV_SLOT_HEAD") + 12 * 2, wornTrinket.guid);
  place(player.fields, field("PLAYER_FIELD_INV_SLOT_HEAD") + 19 * 2, bag.guid);
  place(bag.fields, field("CONTAINER_FIELD_SLOT_1"), cloth.guid);
  place(player.fields, field("PLAYER_FIELD_KEYRING_SLOT_1"), key.guid);
  const templates = new Map([
    [2652, template(2652, "Медный кольчужный пояс", { inventoryType: 6, bonding: 2, maxDurability: 40 })],
    [118, template(118, "Малое лечебное зелье", { itemClass: 0, spells: [{ spellId: 439, trigger: 0 }], stackable: 5 })],
    [6328, template(6328, "Рецепт: длинночелюстный грязевой луциан", {
      itemClass: 9, spells: [{ spellId: 483, trigger: 0 }, { spellId: 7753, trigger: 6 }],
    })],
    [90001, template(90001, "Свиток", { itemClass: 0, bonding: 3, spells: [{ spellId: 8326, trigger: 0 }] })],
    [1372, template(1372, "Свободный кольчужный пояс", { inventoryType: 6, bonding: 2, maxDurability: 40 })],
    [90002, template(90002, "Аксессуар", { inventoryType: 12, bonding: 1, spells: [{ spellId: 8327, trigger: 0 }] })],
    [2589, template(2589, "Льняная ткань", { itemClass: 7, stackable: 20 })],
    [4496, template(4496, "Маленький коричневый мешочек", { itemClass: 1, inventoryType: 18, containerSlots: 4 })],
    [20815, template(20815, "Ключ", { itemClass: 13 })],
  ]);
  const spells = new Map([
    [439, { id: 439, name: "Малое лечебное зелье", rank: "" }],
    [8326, { id: 8326, name: "Призрачная форма", rank: "" }],
  ]);
  const sent = [];
  const asked = new Set();
  const events = new EventBus();
  const world = {
    mapId: 0, worldStateContext: undefined, names: new Map(), creatureTemplates: new Map(),
    state: {
      selfGuid,
      objects: new Map([player, belt, potion, recipe, scroll, mystery, wornBelt, wornTrinket, wornNeck, bag, cloth, key]
        .map((object) => [object.guid, object])),
    },
    events, itemTemplates: templates, knownSpells: [], vendor: undefined, bankerGuid: undefined,
    actionButtons: [], casts: new Map(), channels: new Map(), cooldownSnapshots: new Map(), partyStats: new Map(),
    questPoi: new Map(), chatLog: [], cooldownRemaining: () => 0, aurasFor: () => [],
    itemTemplate: (entry) => {
      const known = templates.get(entry);
      if (known) return known;
      if (!asked.has(entry)) {
        asked.add(entry);
        sent.push(["query", entry]);
      }
      return undefined;
    },
    equipItem: (...args) => sent.push(["equip", ...args]),
    useItem: (...args) => sent.push(["use", ...args]),
    sellToVendor: (...args) => sent.push(["sell", ...args]),
    moveItem: (...args) => sent.push(["move", ...args]),
    storeItemInBag: (...args) => sent.push(["store", ...args]),
    splitItem: (...args) => sent.push(["split", ...args]),
    destroyItem: (...args) => sent.push(["destroy", ...args]),
    setAmmo: (...args) => sent.push(["ammo", ...args]),
  };
  const fired = [];
  const pump = { now: () => 0, fire: (event, ...args) => { fired.push([event, ...args]); return handlers; } };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store, spell: (id) => spells.get(id),
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    itemTexture: (entry) => `Interface\\Icons\\item${entry}`,
  });
  seam.attach(pump);
  fired.length = 0;
  const prompts = () => fired.filter(([event]) => Object.values(FRAMEXML_BIND_CONFIRM_EVENTS).includes(event));
  return { seam, world, player, belt, potion, scroll, mystery, wornBelt, wornTrinket, bag, cloth, templates, sent, fired, prompts, events };
}

/**
 * Ammo as this realm's item_template has it: Rough Arrow (2512), class 6 with INVTYPE_AMMO (24) — 200
 * in backpack slot 7 (wire 255/29) and 55 in the bag's second slot (19/1) — and a Light Quiver (2101),
 * class 11 with INVTYPE_BAG (18), in backpack slot 8 (255/30). Backpack slot 6 (255/28) stays free.
 */
function withAmmo(fixtureState) {
  const { world, player, bag, templates } = fixtureState;
  const arrows = item(0x206n, 2512, { ITEM_FIELD_STACK_COUNT: 200 });
  const bagArrows = item(0x402n, 2512, { ITEM_FIELD_STACK_COUNT: 55 });
  const quiver = item(0x207n, 2101);
  place(player.fields, field("PLAYER_FIELD_PACK_SLOT_1") + 12, arrows.guid);
  place(player.fields, field("PLAYER_FIELD_PACK_SLOT_1") + 14, quiver.guid);
  place(bag.fields, field("CONTAINER_FIELD_SLOT_1") + 2, bagArrows.guid);
  for (const object of [arrows, bagArrows, quiver]) world.state.objects.set(object.guid, object);
  templates.set(2512, template(2512, "Грубая стрела", { itemClass: 6, subClass: 2, inventoryType: 24, stackable: 200 }));
  templates.set(2101, template(2101, "Легкий колчан", { itemClass: 11, subClass: 2, inventoryType: 18, containerSlots: 6 }));
  return { ...fixtureState, arrows, bagArrows, quiver };
}

test("a right click on carried gear equips it: bound at once, unbound after AUTOEQUIP_BIND_CONFIRM", () => {
  const { seam, belt, player, sent, prompts } = fixture();
  belt.fields.set(field("ITEM_FIELD_FLAGS"), 0x1);
  call(seam, "UseContainerItem", 0, 1);
  assert.deepEqual(sent, [["equip", 255, 23]], "a soulbound belt: CMSG_AUTOEQUIP_ITEM at once, not CMSG_USE_ITEM");
  assert.deepEqual(prompts(), []);

  belt.fields.set(field("ITEM_FIELD_FLAGS"), 0);
  sent.length = 0;
  call(seam, "UseContainerItem", 0, 1);
  assert.deepEqual(prompts(), [["AUTOEQUIP_BIND_CONFIRM", 6]], "the waist slot, as the popup's data");
  assert.deepEqual(sent, [], "nothing goes out until the prompt is answered");
  call(seam, "EquipPendingItem", 6);
  assert.deepEqual(sent, [["equip", 255, 23]]);
  call(seam, "CancelPendingEquip", 6);
  call(seam, "EquipPendingItem", 6);
  assert.deepEqual(sent, [["equip", 255, 23]], "OnHide's cancel after the accept, and a second accept, send nothing");

  sent.length = 0;
  call(seam, "UseContainerItem", 0, 1);
  call(seam, "CancelPendingEquip", 6);
  call(seam, "EquipPendingItem", 6);
  assert.deepEqual(sent, [], "cancelled: nothing is sent");

  call(seam, "UseContainerItem", 0, 1);
  call(seam, "EquipPendingItem", 1);
  assert.deepEqual(sent, [], "an answer for another slot is not this prompt's");

  call(seam, "UseContainerItem", 0, 1);
  place(player.fields, field("PLAYER_FIELD_PACK_SLOT_1"), 0n);
  call(seam, "EquipPendingItem", 6);
  assert.deepEqual(sent, [], "the item left the slot while the prompt was up: no packet for whatever is there now");
});

test("a prompt nobody handles does not swallow the click", () => {
  const { seam, sent, prompts } = fixture({ handlers: 0 });
  call(seam, "UseContainerItem", 0, 1);
  assert.deepEqual(prompts(), [["AUTOEQUIP_BIND_CONFIRM", 6]]);
  assert.deepEqual(sent, [["equip", 255, 23]], "no UIParent to answer: the realm binds on equip either way");
});

test("a bind-on-use item asks USE_BIND_CONFIRM; ConfirmBindOnUse sends the use once", () => {
  const { seam, scroll, sent, prompts } = fixture();
  call(seam, "UseContainerItem", 0, 4);
  assert.deepEqual(prompts(), [["USE_BIND_CONFIRM"]]);
  assert.deepEqual(sent, []);
  call(seam, "ConfirmBindOnUse");
  assert.deepEqual(sent, [["use", 255, 26, scroll.guid]]);
  call(seam, "ConfirmBindOnUse");
  assert.deepEqual(sent, [["use", 255, 26, scroll.guid]], "answered once");

  sent.length = 0;
  scroll.fields.set(field("ITEM_FIELD_FLAGS"), 0x1);
  call(seam, "UseContainerItem", 0, 4);
  assert.deepEqual(sent, [["use", 255, 26, scroll.guid]], "already bound: no prompt");
  assert.equal(prompts().length, 1);
});

test("consumables and recipes are plain uses", () => {
  const { seam, potion, sent, prompts } = fixture();
  call(seam, "UseContainerItem", 0, 2);
  call(seam, "UseContainerItem", 0, 3);
  assert.deepEqual(sent, [["use", 255, 24, potion.guid], ["use", 255, 25, 0x203n]]);
  assert.deepEqual(prompts(), []);
});

test("at a merchant a right click sells, from the bags and from the paper doll", () => {
  const { seam, world, belt, wornBelt, wornTrinket, sent } = fixture();
  world.vendor = { guid: 0x600n, items: [] };
  call(seam, "UseContainerItem", 0, 1);
  call(seam, "UseInventoryItem", 6);
  assert.deepEqual(sent, [["sell", belt.guid], ["sell", wornBelt.guid]], "CMSG_SELL_ITEM for the whole stack");

  world.vendor = undefined;
  sent.length = 0;
  call(seam, "UseInventoryItem", 6);
  assert.deepEqual(sent, [], "worn gear with no use effect sends nothing");
  call(seam, "UseInventoryItem", 13);
  assert.deepEqual(sent, [["use", 255, 12, wornTrinket.guid]], "a worn trinket with a use effect is used");
});

test("an item whose template is unknown is asked for, and the click resumes once the answer lands", () => {
  const { seam, player, mystery, templates, sent, events } = fixture();
  call(seam, "UseContainerItem", 0, 5);
  assert.deepEqual(sent, [["query", 7900]], "CMSG_ITEM_QUERY_SINGLE, and no use or equip yet");
  events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: 118 });
  assert.deepEqual(sent, [["query", 7900]], "another item's answer is not this one");
  templates.set(7900, template(7900, "Шлем", { inventoryType: 1, bonding: 0 }));
  events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: 7900 });
  assert.deepEqual(sent, [["query", 7900], ["equip", 255, 27]], "a helm: CMSG_AUTOEQUIP_ITEM once the template says so");
  events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: 7900 });
  assert.equal(sent.length, 2, "resumed once");

  templates.delete(7900);
  sent.length = 0;
  call(seam, "UseContainerItem", 0, 5);
  assert.deepEqual(sent, [], "already asked: no second query, the click waits for the same answer");
  place(player.fields, field("PLAYER_FIELD_PACK_SLOT_1") + 8, 0n);
  templates.set(7900, template(7900, "Шлем", { inventoryType: 1 }));
  events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: 7900 });
  assert.deepEqual(sent, [], "the item left the slot before the answer: nothing is sent");
  assert.equal(mystery.guid, 0x205n);
});

test("worn gear with an unknown template is asked for too, and stays quiet when it has no use", () => {
  const { seam, templates, sent, events } = fixture();
  call(seam, "UseInventoryItem", 2);
  assert.deepEqual(sent, [["query", 7901]]);
  templates.set(7901, template(7901, "Ожерелье", { inventoryType: 2 }));
  events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: 7901 });
  assert.deepEqual(sent, [["query", 7901]], "no use effect: no CMSG_USE_ITEM for the realm to refuse");
});

test("a held unbound bind-on-equip item dropped on the paper doll asks EQUIP_BIND_CONFIRM and swaps on accept", () => {
  const { seam, sent, prompts } = fixture();
  call(seam, "PickupContainerItem", 0, 1);
  assert.deepEqual(call(seam, "CursorHasItem"), [true]);
  assert.deepEqual(call(seam, "CursorCanGoInSlot", 6), [true]);
  assert.deepEqual(call(seam, "CursorCanGoInSlot", 1), [false]);
  call(seam, "PickupInventoryItem", 6);
  assert.deepEqual(prompts(), [["EQUIP_BIND_CONFIRM", 6]]);
  assert.deepEqual(call(seam, "CursorHasItem"), [false], "the hand lets go when the prompt opens");
  assert.deepEqual(sent, []);
  call(seam, "EquipPendingItem", 6);
  assert.deepEqual(sent, [["move", 255, 23, 255, 5]], "CMSG_SWAP_INV_ITEM into the waist slot");

  sent.length = 0;
  call(seam, "PickupContainerItem", 0, 1);
  call(seam, "PickupInventoryItem", 1);
  assert.deepEqual(sent, [["move", 255, 23, 255, 0]], "a slot the belt cannot take: the realm refuses, no prompt asks");
  assert.equal(prompts().length, 1);
});

test("PutItemInBackpack and PutItemInBag store the held item; split parts ride the cursor to CMSG_SPLIT_ITEM", () => {
  const { seam, sent } = fixture();
  assert.deepEqual(call(seam, "PutItemInBackpack"), [false], "nothing held: stock toggles the backpack");
  assert.deepEqual(call(seam, "PutItemInBag", 20), [false]);
  call(seam, "PickupContainerItem", 1, 1);
  assert.deepEqual(call(seam, "PutItemInBackpack"), [true]);
  assert.deepEqual(sent, [["store", 19, 0, 255]], "CMSG_AUTOSTORE_BAG_ITEM into the backpack");
  assert.deepEqual(call(seam, "CursorHasItem"), [false]);
  call(seam, "PickupContainerItem", 0, 1);
  assert.deepEqual(call(seam, "PutItemInBag", 20), [true]);
  assert.deepEqual(sent.at(-1), ["store", 255, 23, 19], "into the bag in slot 19");
  call(seam, "PickupContainerItem", 0, 1);
  assert.deepEqual(call(seam, "PutItemInBag", 21), [true]);
  assert.deepEqual(sent.at(-1), ["move", 255, 23, 255, 20], "an empty bag slot: the item goes into the slot itself");

  sent.length = 0;
  call(seam, "SplitContainerItem", 1, 1, 5);
  assert.deepEqual(call(seam, "CursorHasItem"), [false], "a whole stack is not a split");
  call(seam, "SplitContainerItem", 1, 1, 2);
  assert.deepEqual(call(seam, "CursorHasItem"), [true]);
  assert.deepEqual(call(seam, "GetCursorInfo").slice(0, 2), ["item", 2589]);
  assert.deepEqual(call(seam, "CursorCanGoInSlot", 6), [false]);
  call(seam, "PickupContainerItem", 0, 6);
  assert.deepEqual(sent, [["split", 19, 0, 255, 28, 2]], "the next click names the destination");
  assert.deepEqual(call(seam, "CursorHasItem"), [false]);

  sent.length = 0;
  call(seam, "SplitContainerItem", 1, 1, 3);
  assert.deepEqual(call(seam, "PutItemInBackpack"), [true]);
  assert.deepEqual(sent, [["split", 19, 0, 255, 28, 3]], "a bag button splits into its first free slot");

  sent.length = 0;
  call(seam, "SplitContainerItem", 1, 1, 2);
  call(seam, "DeleteCursorItem");
  assert.deepEqual(sent, [["destroy", 19, 0, 2]], "CMSG_DESTROYITEM with the part's count");
  assert.deepEqual(call(seam, "CursorHasItem"), [false]);
});

test("AutoEquipCursorItem, EquipCursorItem and EquipItemByName wear a carried item, asking first when it would bind", () => {
  const { seam, belt, sent, prompts } = fixture();
  belt.fields.set(field("ITEM_FIELD_FLAGS"), 0x1);
  call(seam, "PickupContainerItem", 0, 1);
  call(seam, "AutoEquipCursorItem");
  assert.deepEqual(sent, [["equip", 255, 23]], "a click on the model with a bound belt held");
  assert.deepEqual(call(seam, "CursorHasItem"), [false]);

  belt.fields.set(field("ITEM_FIELD_FLAGS"), 0);
  sent.length = 0;
  call(seam, "EquipItemByName", "медный кольчужный пояс");
  assert.deepEqual(prompts(), [["AUTOEQUIP_BIND_CONFIRM", 6]], "by cached name, the auto-equip form");
  call(seam, "EquipPendingItem", 6);
  assert.deepEqual(sent, [["equip", 255, 23]]);

  sent.length = 0;
  call(seam, "EquipItemByName", 2652, 6);
  assert.deepEqual(prompts().at(-1), ["EQUIP_BIND_CONFIRM", 6], "a named slot, the equip form");
  call(seam, "EquipPendingItem", 6);
  assert.deepEqual(sent, [["move", 255, 23, 255, 5]]);

  sent.length = 0;
  call(seam, "PickupContainerItem", 0, 1);
  call(seam, "EquipCursorItem", 6);
  assert.deepEqual(prompts().at(-1), ["EQUIP_BIND_CONFIRM", 6]);
  assert.deepEqual(call(seam, "CursorHasItem"), [false]);
  call(seam, "EquipPendingItem", 6);
  assert.deepEqual(sent, [["move", 255, 23, 255, 5]]);
  call(seam, "EquipItemByName", "нет такого");
  assert.equal(sent.length, 1, "an unknown name is nothing");
});

test("the item readers answer from the update fields and the cached templates, nil while unknown", () => {
  const { seam, belt, wornBelt, sent } = fixture();
  const clothLink = "|cffffffff|Hitem:2589:0:0:0:0:0:0:0:80|h[Льняная ткань]|h|r";
  assert.deepEqual(call(seam, "GetItemCount", 2652), [1]);
  assert.deepEqual(call(seam, "GetItemCount", clothLink), [5]);
  assert.deepEqual(call(seam, "GetItemCount", "льняная ткань", true), [5]);
  assert.deepEqual(call(seam, "GetItemCount", 1372), [0], "worn gear is not carried");
  assert.deepEqual(call(seam, "GetItemCount", 7900), [1], "a carried item counts before its template is known");
  assert.deepEqual(call(seam, "GetItemCount", 7902), [0]);
  assert.deepEqual(call(seam, "IsEquippableItem", 2652), [true]);
  assert.deepEqual(call(seam, "IsEquippableItem", 118), [false]);
  assert.deepEqual(call(seam, "IsEquippableItem", 7900), [], "unknown template: nil, not a guess");
  assert.deepEqual(call(seam, "IsEquippedItem", 2652), [false]);
  assert.deepEqual(call(seam, "IsEquippedItem", 1372), [true]);
  assert.deepEqual(call(seam, "IsEquippedItem", 4496), [true], "the carried bag is worn in its slot");
  assert.deepEqual(call(seam, "IsUsableItem", 118), [true]);
  assert.deepEqual(call(seam, "IsUsableItem", 2652), [false]);
  assert.deepEqual(call(seam, "IsUsableItem", 7900), []);
  assert.deepEqual(call(seam, "IsConsumableItem", 118), [true]);
  assert.deepEqual(call(seam, "IsConsumableItem", 2652), [false]);
  assert.deepEqual(call(seam, "GetItemSpell", 118), ["Малое лечебное зелье", ""]);
  assert.deepEqual(call(seam, "GetItemSpell", 6328), [], "the recipe's spell row is not cached: nil");
  assert.deepEqual(call(seam, "GetItemSpell", 2652), []);
  assert.deepEqual(call(seam, "GetItemIcon", 118), ["Interface\\Icons\\item118"]);
  assert.deepEqual(call(seam, "GetItemCooldown", 118), [0, 0, 0]);
  assert.deepEqual(call(seam, "GetContainerItemDurability", 0, 1), [], "no durability pair on the object yet");
  belt.fields.set(field("ITEM_FIELD_DURABILITY"), 10);
  belt.fields.set(field("ITEM_FIELD_MAXDURABILITY"), 40);
  assert.deepEqual(call(seam, "GetContainerItemDurability", 0, 1), [10, 40]);
  assert.deepEqual(call(seam, "GetInventoryItemDurability", 6), [8, 40]);
  assert.deepEqual(call(seam, "GetInventoryItemDurability", 13), []);
  assert.deepEqual(call(seam, "GetInventoryAlertStatus", 4), [1], "the waist at a fifth: low");
  wornBelt.fields.set(field("ITEM_FIELD_DURABILITY"), 0);
  assert.deepEqual(call(seam, "GetInventoryAlertStatus", 4), [2], "broken");
  assert.deepEqual(call(seam, "GetInventoryAlertStatus", 1), [0], "an empty head slot is sound");
  assert.deepEqual(call(seam, "GetInventoryItemBroken", "player", 6), [true]);
  assert.deepEqual(call(seam, "GetInventoryItemQuality", "player", 6), [1]);
  assert.deepEqual(call(seam, "GetInventoryItemQuality", "player", 1), []);
  assert.deepEqual(call(seam, "GetInventoryItemID", "player", 6), [1372]);
  assert.deepEqual(call(seam, "GetContainerItemID", 0, 1), [2652]);
  assert.deepEqual(call(seam, "GetContainerItemID", 0, 7), []);
  assert.deepEqual(call(seam, "ContainerIDToInventoryID", 1), [20]);
  assert.deepEqual(call(seam, "ContainerIDToInventoryID", 5), [68]);
  assert.deepEqual(call(seam, "ContainerIDToInventoryID", 0), []);
  assert.deepEqual(call(seam, "KeyRingButtonIDToInvSlotID", 1), [87]);
  assert.deepEqual(call(seam, "GetInventoryItemTexture", "player", 87), ["Interface\\Icons\\item20815"],
    "the keyring's inventory ids reach its keys");
  assert.deepEqual(call(seam, "GetInventoryItemsForSlot", 6), [[
    FRAMEXML_ITEM_INVENTORY_LOCATION_PLAYER + 6, 1372,
    FRAMEXML_ITEM_INVENTORY_LOCATION_PLAYER + FRAMEXML_ITEM_INVENTORY_LOCATION_BAGS + (0 << 8) + 1, 2652,
  ]], "the worn belt under PLAYER + slot, the carried one by container and slot");
  assert.deepEqual(call(seam, "GetInventoryItemsForSlot", 1), [[]]);
  assert.deepEqual(call(seam, "ShowContainerSellCursor", 0, 1), []);
  assert.deepEqual(sent, [], "readers send nothing");
});

test("a right click on ammo sets it as the ammo (CMSG_SET_AMMO); a quiver is still worn in a bag slot", () => {
  const { seam, world, arrows, sent, prompts } = withAmmo(fixture());
  call(seam, "UseContainerItem", 0, 7);
  assert.deepEqual(sent, [["ammo", 2512]], "the entry — not CMSG_AUTOEQUIP_ITEM into a bag slot, not CMSG_USE_ITEM");
  call(seam, "UseContainerItem", 1, 2);
  assert.deepEqual(sent, [["ammo", 2512], ["ammo", 2512]], "a stack in a bag names the same entry");

  sent.length = 0;
  call(seam, "UseContainerItem", 0, 8);
  assert.deepEqual(sent, [["equip", 255, 30]], "Light Quiver, INVTYPE_BAG: CMSG_AUTOEQUIP_ITEM, the realm picks the bag slot");
  assert.deepEqual(prompts(), []);

  sent.length = 0;
  world.vendor = { guid: 0x600n, items: [] };
  call(seam, "UseContainerItem", 0, 7);
  assert.deepEqual(sent, [["sell", arrows.guid]], "at a merchant the stack is sold, before anything else");
});

test("ammo whose template is unknown is asked for, and the click sets it once the answer lands", () => {
  const { seam, templates, sent, events } = withAmmo(fixture());
  const known = templates.get(2512);
  templates.delete(2512);
  call(seam, "UseContainerItem", 0, 7);
  assert.deepEqual(sent, [["query", 2512]], "CMSG_ITEM_QUERY_SINGLE, and nothing else yet");
  templates.set(2512, known);
  events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: 2512 });
  assert.deepEqual(sent, [["query", 2512], ["ammo", 2512]]);
});

test("the AmmoSlot (inventory id 0) reads PLAYER_AMMO_ID: nothing while it is 0, else its icon, link, tooltip and carried count", () => {
  const { seam, player, bag, arrows, sent } = withAmmo(fixture());
  assert.deepEqual(call(seam, "GetInventoryItemTexture", "player", 0), []);
  assert.deepEqual(call(seam, "GetInventoryItemCount", "player", 0), [0]);
  assert.deepEqual(call(seam, "GetInventoryItemLink", "player", 0), []);
  assert.equal(seam.inventoryItemTooltip("player", 0)?.entry, undefined);

  player.fields.set(field("PLAYER_AMMO_ID"), 2512);
  assert.deepEqual(call(seam, "GetInventoryItemTexture", "player", 0), ["Interface\\Icons\\item2512"]);
  assert.deepEqual(call(seam, "GetInventoryItemCount", "player", 0), [255], "both carried stacks");
  assert.deepEqual(call(seam, "GetInventoryItemCount", "player", 0), call(seam, "GetItemCount", 2512),
    "the sum GetItemCount gives");
  assert.deepEqual(call(seam, "GetInventoryItemLink", "player", 0),
    ["|cffffffff|Hitem:2512:0:0:0:0:0:0:0:0|h[Грубая стрела]|h|r"]);
  const tooltip = seam.inventoryItemTooltip("player", 0);
  assert.equal(tooltip?.entry, 2512);
  assert.equal(tooltip?.count, 255);
  assert.equal(tooltip?.template?.inventoryType, 24);
  assert.deepEqual(call(seam, "GetInventoryItemTexture", "target", 0), [], "only the player has an AmmoSlot");
  assert.deepEqual(call(seam, "GetInventoryItemCount", "target", 0), [0]);

  // Spell.cpp:5102 spends one per shot with DestroyItemCount and leaves the field alone.
  arrows.fields.set(field("ITEM_FIELD_STACK_COUNT"), 199);
  assert.deepEqual(call(seam, "GetInventoryItemCount", "player", 0), [254]);
  place(player.fields, field("PLAYER_FIELD_PACK_SLOT_1") + 12, 0n);
  place(bag.fields, field("CONTAINER_FIELD_SLOT_1") + 2, 0n);
  assert.deepEqual(call(seam, "GetInventoryItemCount", "player", 0), [0], "none carried");
  assert.deepEqual(call(seam, "GetInventoryItemTexture", "player", 0), ["Interface\\Icons\\item2512"],
    "the field still names them until the next shot clears it (Spell.cpp:7429-7432)");

  assert.deepEqual(call(seam, "GetInventoryItemTexture", "player", 6), ["Interface\\Icons\\item1372"], "the worn rows are unchanged");
  assert.deepEqual(call(seam, "GetInventoryItemCount", "player", 6), [1]);
  assert.deepEqual(sent, [], "readers send nothing");
});

test("UNIT_INVENTORY_CHANGED(player) repaints the AmmoSlot: at once for PLAYER_AMMO_ID, on the 60 ms poll for a spent arrow", () => {
  const listeners = new Map();
  const store = {
    field: (_subject, name, listener) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
  };
  const { seam, player, arrows, fired } = withAmmo(fixture({ store }));
  const edges = () => fired.filter(([event]) => event === "UNIT_INVENTORY_CHANGED").length;
  assert.equal(typeof listeners.get("PLAYER_AMMO_ID"), "function", "the field is subscribed, not polled per frame");
  seam.tick(0.1);
  assert.equal(edges(), 0, "no ammo, nothing worn changed");

  player.fields.set(field("PLAYER_AMMO_ID"), 2512);
  listeners.get("PLAYER_AMMO_ID")();
  assert.deepEqual(fired.filter(([event]) => event === "UNIT_INVENTORY_CHANGED"), [["UNIT_INVENTORY_CHANGED", "player"]],
    "Player::SetAmmo: PaperDollItemSlotButton_OnEvent's edge, before the next poll");
  seam.tick(0.2);
  assert.equal(edges(), 1, "the poll does not repeat it");

  arrows.fields.set(field("ITEM_FIELD_STACK_COUNT"), 199);
  seam.tick(0.21);
  assert.equal(edges(), 1, "under 60 ms: no poll yet");
  seam.tick(0.3);
  assert.equal(edges(), 2, "an arrow spent: the count repaints");
  seam.tick(0.4);
  assert.equal(edges(), 2, "nothing moved, nothing fired");

  player.fields.set(field("PLAYER_AMMO_ID"), 0);
  listeners.get("PLAYER_AMMO_ID")();
  assert.equal(edges(), 3, "RemoveAmmo empties the slot at once");
  seam.detach();
  assert.equal(listeners.has("PLAYER_AMMO_ID"), false, "detach drops the subscription");
});

test("a held ammo stack dropped on the AmmoSlot sets it and lets go; with nothing held the slot does nothing", () => {
  const { seam, sent } = withAmmo(fixture());
  call(seam, "PickupInventoryItem", 0);
  assert.deepEqual(sent, [], "an empty hand sends nothing");
  assert.deepEqual(call(seam, "CursorHasItem"), [false]);

  call(seam, "PickupContainerItem", 0, 7);
  assert.deepEqual(call(seam, "CursorCanGoInSlot", 0), [true], "the AmmoSlot lights up for ammo");
  assert.deepEqual(call(seam, "CursorCanGoInSlot", 20), [false], "a bag button no longer does");
  call(seam, "PickupInventoryItem", 0);
  assert.deepEqual(sent, [["ammo", 2512]], "CMSG_SET_AMMO with the held entry; no stack moves");
  assert.deepEqual(call(seam, "CursorHasItem"), [false], "the hand lets go");

  sent.length = 0;
  call(seam, "SplitContainerItem", 0, 7, 50);
  assert.deepEqual(call(seam, "CursorHasItem"), [true]);
  assert.deepEqual(call(seam, "CursorCanGoInSlot", 0), [true], "a part of the stack is the same entry");
  call(seam, "PickupInventoryItem", 0);
  assert.deepEqual(sent, [["ammo", 2512]], "no CMSG_SPLIT_ITEM: the slot takes an entry, not a stack");
  assert.deepEqual(call(seam, "CursorHasItem"), [false]);

  sent.length = 0;
  call(seam, "PickupContainerItem", 0, 1);
  assert.deepEqual(call(seam, "CursorCanGoInSlot", 0), [false], "a belt does not light it");
  call(seam, "PickupInventoryItem", 0);
  assert.deepEqual(sent, [["ammo", 2652]], "the realm's to refuse: CanUseAmmo answers EQUIP_ERR_ONLY_AMMO_CAN_GO_HERE");
  assert.deepEqual(call(seam, "CursorHasItem"), [false]);
});

test("the slot table follows Player::FindEquipSlot; dual wield opens the off hand", () => {
  assert.deepEqual(frameXmlEquipmentSlotsForInventoryType(13), [15]);
  assert.deepEqual(frameXmlEquipmentSlotsForInventoryType(13, true), [15, 16]);
  assert.deepEqual(frameXmlEquipmentSlotsForInventoryType(11), [10, 11]);
  assert.deepEqual(frameXmlEquipmentSlotsForInventoryType(18), [19, 20, 21, 22], "INVTYPE_BAG, quivers and pouches too");
  assert.deepEqual(frameXmlEquipmentSlotsForInventoryType(0), []);
  assert.deepEqual(frameXmlEquipmentSlotsForInventoryType(24), [], "INVTYPE_AMMO: FindEquipSlot has no case, NULL_SLOT");
  assert.deepEqual(frameXmlEquipmentSlotsForInventoryType(27), [], "INVTYPE_QUIVER: no case either");
  assert.equal(frameXmlContainerInventoryId(4), 23);
  assert.equal(frameXmlContainerInventoryId(11), 74);
  assert.equal(frameXmlContainerInventoryId(12), undefined);
});

test("the Lua half keys GetInventoryItemsForSlot's flat list into the table stock hands it", () => {
  const { seam } = fixture();
  const vm = new GlueLuaVm();
  try {
    vm.setGlobal("__fxNeutralImpl", {});
    vm.setGlobal("__fxAddonModules", []);
    assert.equal(vm.execute(FRAMEXML_NEUTRAL_PRELUDE, "@item-actions:neutral").ok, true);
    vm.registerGlobal("__fxSeam_GetInventoryItemsForSlot", (args) => call(seam, "GetInventoryItemsForSlot", ...args));
    vm.setGlobal("__fxSeamNames", ["GetInventoryItemsForSlot"]);
    assert.equal(vm.execute(FRAMEXML_SEAM_PRELUDE, "@item-actions:seam").ok, true);
    const run = vm.execute(`
      local t = { stale = true }
      local back = __fxNeutralImpl.GetInventoryItemsForSlot(6, t)
      __same = back == t
      __stale = t.stale
      __worn = t[${FRAMEXML_ITEM_INVENTORY_LOCATION_PLAYER} + 6]
      __carried = t[${FRAMEXML_ITEM_INVENTORY_LOCATION_PLAYER + FRAMEXML_ITEM_INVENTORY_LOCATION_BAGS} + 1]
      __count = 0
      for _ in pairs(t) do __count = __count + 1 end
      local made = __fxNeutralImpl.GetInventoryItemsForSlot(1)
      __madeCount = 0
      for _ in pairs(made) do __madeCount = __madeCount + 1 end
    `, "@item-actions:flyout");
    assert.equal(run.ok, true, run.error);
    assert.equal(vm.getGlobal("__same"), true, "stock's own table comes back");
    assert.equal(vm.getGlobal("__stale"), true, "stock clears the table itself (PaperDollFrame.lua:1787)");
    assert.equal(vm.getGlobal("__worn"), 1372);
    assert.equal(vm.getGlobal("__carried"), 2652);
    assert.equal(vm.getGlobal("__count"), 3);
    assert.equal(vm.getGlobal("__madeCount"), 0, "no table passed: an empty one is made");
  } finally {
    vm.close();
  }
});
