import assert from "node:assert/strict";
import test from "node:test";

// LiveWorldSeam's NPC-window wiring over a fake world: the bank as stock containers -1/5..11 and
// as inventory ids 40..74, right-click across an open bank, a readable item read instead of used,
// PLAYERBANKSLOTS_CHANGED from the seam's own inventory edge while a banker's permission stands (and
// no bank work at all without one), a late item query repainting the open bank, and
// UnitName/UnitExists("npc") for the conversation, flight master and banker.
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

function place(fields, offset, guid) {
  fields.set(offset, Number(guid & 0xffffffffn));
  fields.set(offset + 1, Number(guid >> 32n));
}

const itemObject = (guid, entry, count = 1) => ({ guid, typeId: 1, fields: new Map([
  [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry], [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, count],
]) });

function fixture() {
  const player = { guid: 1n, typeId: 4, fields: new Map() };
  const potion = itemObject(2n, 118, 5);
  const bankOre = itemObject(3n, 2770, 20);
  const bankBag = { guid: 4n, typeId: 2, fields: new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 4496], [UPDATE_FIELDS.CONTAINER_FIELD_NUM_SLOTS.offset, 6],
  ]) };
  const letter = itemObject(5n, 2794);
  const npc = { guid: 77n, typeId: 3, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 295]]) };
  const lectern = { guid: 88n, typeId: 5, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 175740]]) };
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, potion.guid);
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 2, letter.guid);
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_BANK_SLOT_1.offset, bankOre.guid);
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_BANKBAG_SLOT_1.offset, bankBag.guid);
  const sent = [];
  const listeners = new Map();
  const emit = (name, payload) => { for (const listener of listeners.get(name) ?? []) listener(payload); };
  let icons = (entry) => `icon-${entry}`;
  const world = {
    state: { selfGuid: player.guid, objects: new Map([[1n, player], [2n, potion], [3n, bankOre], [4n, bankBag], [5n, letter], [77n, npc], [88n, lectern]]) },
    gameObjectTemplates: new Map([[175740, { type: 2, name: "Кафедра", data: [] }]]),
    names: { get: () => undefined, declined: () => undefined },
    creatureTemplates: new Map([[295, { found: true, name: "Трактирщик Фарли" }]]),
    itemTemplates: new Map([
      [4496, { found: true, name: "Маленький мешочек", bagFamily: 0, itemClass: 1, startQuest: 0 }],
      [2794, { found: true, name: "Летопись", pageText: 1131, pageMaterial: 1, startQuest: 0, spells: [], itemClass: 15 }],
    ]),
    bankerGuid: undefined,
    casts: new Map(),
    events: { on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== listener));
    } },
    useItem: (...args) => sent.push(["use", ...args]),
    depositToBank: (...args) => sent.push(["deposit", ...args]),
    withdrawFromBank: (...args) => sent.push(["withdraw", ...args]),
    readItem: (...args) => sent.push(["read", ...args]),
    moveItem: (...args) => sent.push(["move", ...args]),
  };
  let inventoryEdge;
  const store = { field: () => () => {}, any: (listener) => { inventoryEdge = listener; return () => {}; } };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    itemTexture: (entry) => icons(entry),
  });
  const fired = [];
  seam.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; }, now: () => 0 });
  return {
    world, player, seam, sent, fired, emit, inventoryEdge: () => inventoryEdge?.(),
    set icons(next) { icons = next; },
  };
}

test("the bank is stock container -1 and bank bag 5, and inventory ids 40..74", () => {
  const { seam } = fixture();
  assert.deepEqual(call("GetContainerNumSlots", seam, -1), [28]);
  assert.deepEqual(call("GetContainerItemInfo", seam, -1, 1).slice(0, 2), ["icon-2770", 20]);
  assert.deepEqual(call("GetContainerNumSlots", seam, 5), [6], "the bag in bank bag slot 1 is container 5");
  assert.deepEqual(call("GetBagName", seam, 5), ["Маленький мешочек"]);
  assert.deepEqual(call("GetContainerNumSlots", seam, 6), [0]);
  assert.deepEqual(call("GetInventoryItemTexture", seam, "player", 40), ["icon-2770"], "BankButtonIDToInvSlotID(1)");
  assert.deepEqual(call("GetInventoryItemCount", seam, "player", 40), [20]);
  assert.deepEqual(call("GetInventoryItemTexture", seam, "player", 68), ["icon-4496"], "the bank bag itself");
  assert.deepEqual(call("GetInventoryItemTexture", seam, "player", 69), []);
  seam.detach();
});

test("right-click: used without a banker, moved across the bank with one; a readable item is read", () => {
  const { world, seam, sent } = fixture();
  call("UseContainerItem", seam, 0, 1);
  assert.deepEqual(sent.at(-1), ["use", 255, 23, 2n]);
  world.bankerGuid = 9n;
  call("UseContainerItem", seam, 0, 1);
  call("UseContainerItem", seam, -1, 1);
  assert.deepEqual(sent.slice(-2), [["deposit", 255, 23], ["withdraw", 255, 39]], "CMSG_AUTOBANK_ITEM / CMSG_AUTOSTORE_BANK_ITEM");
  world.bankerGuid = undefined;
  call("UseContainerItem", seam, 0, 2);
  assert.deepEqual(sent.at(-1), ["use", 255, 24, 5n], "unpublished reader: the ordinary use");
  seam.itemText.owned = true;
  call("UseContainerItem", seam, 0, 2);
  assert.deepEqual(sent.at(-1), ["read", 255, 24], "CMSG_READ_ITEM");
  seam.detach();
});

test("the seam's inventory edge raises PLAYERBANKSLOTS_CHANGED; UnitName('npc') names who is being talked to", () => {
  const { world, player, seam, fired, emit, inventoryEdge } = fixture();
  world.bankerGuid = 9n;
  emit("BANK_OPENED", { bankerGuid: 9n });
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_BANK_SLOT_1.offset + 2 * 5, 2n);
  inventoryEdge();
  assert.ok(fired.some(([event, slot]) => event === "PLAYERBANKSLOTS_CHANGED" && slot === 6));
  world.bankerGuid = undefined;
  emit("BANK_OPENED", { bankerGuid: undefined });
  assert.deepEqual(call("UnitName", seam, "npc"), []);
  assert.deepEqual(call("UnitExists", seam, "npc"), [false]);
  world.gossip = { guid: 77n, menuId: 1, textId: 1, options: [], quests: [] };
  assert.deepEqual(call("UnitName", seam, "npc"), ["Трактирщик Фарли"]);
  assert.deepEqual(call("UnitExists", seam, "npc"), [true], "GossipFrameUpdate then asks SetPortraitTexture for the NPC");
  world.gossip = undefined;
  world.taxiMenu = { guid: 77n, currentNode: 2, knownNodes: [] };
  assert.deepEqual(call("UnitName", seam, "npc"), ["Трактирщик Фарли"]);
  world.taxiMenu = undefined;
  world.gossip = { guid: 88n, menuId: 2, textId: 1, options: [], quests: [] };
  assert.deepEqual(call("UnitName", seam, "npc"), ["Кафедра"], "a game object's gossip is titled with its template name");
  assert.deepEqual(call("UnitExists", seam, "npc"), [false], "an object is no unit: GossipFrame shows its book");
  world.gossip = undefined;
  world.bankerGuid = 0xF130000123000077n;
  assert.deepEqual(call("UnitExists", seam, "npc"), [true], "a banker out of view is still a creature by its GUID");
  seam.detach();
});

test("without a banker the inventory edge does no bank work; a bank opened later starts from what it holds", () => {
  const { world, player, fired, emit, inventoryEdge } = fixture();
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_BANK_SLOT_1.offset + 2 * 5, 2n);
  inventoryEdge();
  assert.equal(fired.filter(([event]) => event === "PLAYERBANKSLOTS_CHANGED").length, 0,
    "no banker: nothing can move in the bank, BankFrame is closed");
  world.bankerGuid = 9n;
  emit("BANK_OPENED", { bankerGuid: 9n });
  inventoryEdge();
  assert.equal(fired.filter(([event]) => event === "PLAYERBANKSLOTS_CHANGED").length, 0,
    "what the bank held when it opened is what BankFrame_OnShow painted");
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_BANK_SLOT_1.offset + 2 * 6, 3n);
  inventoryEdge();
  assert.deepEqual(fired.filter(([event]) => event === "PLAYERBANKSLOTS_CHANGED"), [["PLAYERBANKSLOTS_CHANGED", 7]]);
});

test("an item query landing repaints the open bank: slot icons, the bank bag's slots and its name", () => {
  const fx = fixture();
  const { world, fired, emit } = fx;
  world.bankerGuid = 9n;
  emit("BANK_OPENED", { bankerGuid: 9n });
  fx.icons = (entry) => entry === 2770 ? "Interface\\Icons\\INV_Ore_Copper_01" : `icon-${entry}`;
  emit("QUERY_CACHE_CHANGED", { kind: "item", id: 2770 });
  assert.deepEqual(fired.filter(([event]) => event === "PLAYERBANKSLOTS_CHANGED"), [["PLAYERBANKSLOTS_CHANGED", 1]],
    "slot 1's ore got its icon");
  world.itemTemplates.set(4496, { ...world.itemTemplates.get(4496), name: "Маленький коричневый мешочек" });
  emit("QUERY_CACHE_CHANGED", { kind: "item", id: 4496 });
  assert.deepEqual(fired.filter(([event, id]) => event === "BAG_UPDATE" && id === 5), [["BAG_UPDATE", 5]],
    "bank bag 5's ContainerFrame title");
});
