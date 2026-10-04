import assert from "node:assert/strict";
import test from "node:test";

// Plan item 2.02, the behaviour half: browser/Repair.ts over a real WorldClient (what is walked, the
// reputation discount, the purse check, the cursor mode and its end), the stock C API in
// framexml/FrameXmlRepair.ts (1-or-nil shapes, UI_ERROR_MESSAGE, UPDATE_INVENTORY_DURABILITY), and
// the repair cursor's click through LiveWorldSeam's PickupContainerItem/PickupInventoryItem. The
// rules are read off Wow.exe.clean: 0x005849f0, 0x00585990, 0x00585c90, 0x00584a60, 0x00584390,
// 0x005843b0, 0x005cc200, 0x005d7ff0, 0x005e85d0, 0x00584600.
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { parseFixed } = await import("../dist/code/gateway/DbcFixed.js");
const { DURABILITY_COSTS_LAYOUT, DURABILITY_QUALITY_LAYOUT, durabilityCatalog } =
  await import("../dist/code/gateway/DurabilityMetadata.js");
const { DurabilityTables } = await import("../dist/code/world/DurabilityCost.js");
const { buildRepairItem } = await import("../dist/code/world/RepairProtocol.js");
const { RepairSession, reputationToRank, baseReputation, repair: pageRepair } = await import("../dist/code/browser/Repair.js");
const { createFrameXmlRepair, FRAMEXML_REPAIR_DURABILITY_EVENT } = await import("../dist/code/browser/framexml/FrameXmlRepair.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { game } = await import("../dist/code/browser/game/Context.js");

const offset = (name) => UPDATE_FIELDS[name].offset;
const PLAYER = 0x10n;
const VENDOR = 0xf130_0000_1a54_0001n;
const OTHER_VENDOR = 0xf130_0000_1a54_0002n;
const HEAD = 0x201n;
const SWORD = 0x202n;
const WRAPPED = 0x203n;
const WHOLE = 0x204n;
const BAG = 0x205n;
const ROBE = 0x206n;
const BANKED = 0x207n;
const FACTION_TEMPLATE = 11;
const FACTION = 72;
const LIST_ID = 5;

/** A WDBC image of integer rows, with float columns where named. */
function dbc(rows, fields, floatColumns = []) {
  const recordSize = fields * 4;
  const data = Buffer.alloc(20 + rows.length * recordSize + 1);
  data.write("WDBC", 0, "latin1");
  data.writeUInt32LE(rows.length, 4);
  data.writeUInt32LE(fields, 8);
  data.writeUInt32LE(recordSize, 12);
  data.writeUInt32LE(1, 16);
  rows.forEach((row, index) => row.forEach((value, field) => {
    const at = 20 + index * recordSize + field * 4;
    if (floatColumns.includes(field)) data.writeFloatLE(value, at);
    else data.writeInt32LE(value, at);
  }));
  return data;
}

function tables() {
  const row10 = [10, ...Array.from({ length: 21 }, (_, index) => 100 + index), ...Array.from({ length: 8 }, (_, index) => 200 + index)];
  const quality = [[1, 1], [2, 0.6], [3, 1], [4, 0.8], [5, 1], [6, 1], [7, 1.2], [8, 1.25], [9, 1.44], [10, 2.5],
    [11, 1.728], [12, 3], [13, 0], [14, 0], [15, 1.2], [16, 1.25]];
  return new DurabilityTables(durabilityCatalog(
    parseFixed("DurabilityCosts", dbc([row10], 30), DURABILITY_COSTS_LAYOUT),
    parseFixed("DurabilityQuality", dbc(quality, 2, [1]), DURABILITY_QUALITY_LAYOUT),
  ));
}

function template(entry, itemClass, subClass) {
  return {
    entry, found: true, name: `Предмет ${entry}`, quality: 1, itemClass, subClass, flags: 0, inventoryType: 1,
    bonding: 0, stackable: 1, bagFamily: 0, spells: [], itemLevel: 10, requiredLevel: 1, containerSlots: 0,
    maxDurability: 100, pageText: 0, startQuest: 0,
  };
}

function setGuid(fields, at, guid) {
  fields.set(at, Number(guid & 0xffff_ffffn));
  fields.set(at + 1, Number(guid >> 32n));
}

/**
 * A player (human warrior) wearing a worn plate helm (lost 10), a worn sword in backpack slot 1 (lost 5),
 * a wrapped worn item in slot 2, an unworn one in slot 3, a bag in slot 19 holding a worn robe (lost 2)
 * and a worn item in the bank; a repair merchant in front of them.
 * Common quality, item level 10: 10·0.8·204 = 1632, 5·0.8·107 = 428, 2·0.8·201 = 321.6 → 322; 2382 in all.
 */
function fixture({ money = 1_000_000, npcFlags = 0x1000 | 0x80 } = {}) {
  const sent = [];
  const world = new WorldClient({
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload: [...payload] }); },
    close() {},
  });
  const state = new WorldState();
  world.state = state;
  const fields = new Map([
    [offset("UNIT_FIELD_BYTES_0"), 1 | (1 << 8)],
    [offset("PLAYER_FIELD_COINAGE"), money],
  ]);
  setGuid(fields, offset("PLAYER_FIELD_INV_SLOT_HEAD"), HEAD);
  setGuid(fields, offset("PLAYER_FIELD_INV_SLOT_HEAD") + 19 * 2, BAG);
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1"), SWORD);
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1") + 2, WRAPPED);
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1") + 4, WHOLE);
  setGuid(fields, offset("PLAYER_FIELD_BANK_SLOT_1"), BANKED);
  const object = (guid, typeId, entries) => ({
    guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined, fields: new Map(entries),
  });
  state.objects.set(PLAYER, { ...object(PLAYER, 4, []), fields });
  const worn = (guid, entry, lost, extra = []) => state.objects.set(guid, object(guid, 1, [
    [offset("OBJECT_FIELD_ENTRY"), entry], [offset("ITEM_FIELD_DURABILITY"), 100 - lost],
    [offset("ITEM_FIELD_MAXDURABILITY"), 100], ...extra,
  ]));
  worn(HEAD, 1001, 10);
  worn(SWORD, 1002, 5);
  worn(WRAPPED, 1001, 50, [[offset("ITEM_FIELD_FLAGS"), 0x8]]);
  worn(WHOLE, 1001, 0);
  worn(ROBE, 1003, 2);
  worn(BANKED, 1001, 40);
  const bag = object(BAG, 2, [[offset("CONTAINER_FIELD_NUM_SLOTS"), 4]]);
  setGuid(bag.fields, offset("CONTAINER_FIELD_SLOT_1"), ROBE);
  state.objects.set(BAG, bag);
  state.objects.set(VENDOR, object(VENDOR, 3, [
    [offset("UNIT_NPC_FLAGS"), npcFlags], [offset("UNIT_FIELD_FACTIONTEMPLATE"), FACTION_TEMPLATE],
  ]));
  state.objects.set(OTHER_VENDOR, object(OTHER_VENDOR, 3, [[offset("UNIT_NPC_FLAGS"), 0x1000 | 0x80]]));
  state.selfGuid = PLAYER;
  world.itemTemplates.set(1001, template(1001, 4, 4));
  world.itemTemplates.set(1002, template(1002, 2, 7));
  world.itemTemplates.set(1003, template(1003, 4, 1));
  world.vendor = { guid: VENDOR, items: [] };
  const reputation = {
    version: 1,
    factions: { [LIST_ID]: { factionId: FACTION, raceMasks: [1, 0, 0, 0], classMasks: [0, 0, 0, 0], bases: [3000, 0, 0, 0], flags: [0, 0, 0, 0] } },
  };
  let targeting = false;
  const session = new RepairSession({
    world: () => world,
    tables: () => tables(),
    factionOf: (id) => (id === FACTION_TEMPLATE ? FACTION : undefined),
    reputation: () => reputation,
    targeting: () => targeting,
  });
  const repairs = () => sent.filter((packet) => packet.opcode === OPCODES.CMSG_REPAIR_ITEM).map((packet) => packet.payload);
  return { world, state, fields, session, sent, repairs, setTargeting: (value) => { targeting = value; } };
}

test("2.02 CanMerchantRepair and GetRepairAllCost: the flag, the walked slots, the worn flag without a price", () => {
  const { world, state, session } = fixture();
  assert.equal(session.canMerchantRepair(), true);
  assert.deepEqual(session.allCost(), { cost: 2382, canRepair: true },
    "helm + backpack sword + the bag's robe; not the wrapped item, not the bank");
  // A merchant without UNIT_NPC_FLAG_REPAIR: no answer at all (nil), as 0x00585990.
  state.objects.get(VENDOR).fields.set(offset("UNIT_NPC_FLAGS"), 0x80);
  assert.equal(session.canMerchantRepair(), false);
  assert.equal(session.allCost(), undefined);
  state.objects.get(VENDOR).fields.set(offset("UNIT_NPC_FLAGS"), 0x1080);
  // Templates missing: nothing priced, still worn.
  world.itemTemplates.clear();
  assert.deepEqual(session.allCost(), { cost: 0, canRepair: true });
  // Everything whole: nothing to repair.
  for (const guid of [HEAD, SWORD, ROBE]) state.objects.get(guid).fields.set(offset("ITEM_FIELD_DURABILITY"), 100);
  assert.deepEqual(session.allCost(), { cost: 0, canRepair: false });
  world.vendor = undefined;
  assert.equal(session.allCost(), undefined, "no merchant open");
});

test("2.02 the reputation discount: base reputation + wire standing → rank → the client's factor", () => {
  const { world, fields, session } = fixture();
  assert.equal(reputationToRank(41_999), 6);
  assert.equal(reputationToRank(42_000), 7);
  assert.equal(reputationToRank(2_999), 3);
  assert.equal(reputationToRank(-42_000), 0);
  assert.equal(baseReputation({ raceMasks: [1, 0, 0, 0], classMasks: [0, 0, 0, 0], bases: [3000, 0, 0, 0] }, 1, 1), 3000);
  assert.equal(baseReputation({ raceMasks: [0, 0, 0, 0], classMasks: [2, 0, 0, 0], bases: [-500, 0, 0, 0] }, 1, 2), -500,
    "no race mask with a class mask: the class decides");
  assert.equal(session.priceFactor(), 1, "no standing for the faction: neutral");
  // Human (base 3000) + 18100 on the wire = 21100, revered: ×0.85 → 1387 + 364 + 274.
  world.factions.set(LIST_ID, { listId: LIST_ID, flags: 1, standing: 18_100 });
  assert.equal(session.priceFactor(), Math.fround(1 - Math.fround(0.15)));
  assert.equal(session.allCost().cost, 2025);
  // An orc does not get the human base: 18100 is honored, ×0.9 → 1469 + 385 + 290.
  fields.set(offset("UNIT_FIELD_BYTES_0"), 2 | (1 << 8));
  assert.equal(session.allCost().cost, 2144);
  assert.equal(session.itemCost(world.state.objects.get(HEAD)), 1469);
});

test("2.02 RepairAllItems: one packet; short of money nothing; the guild bank is not checked", () => {
  const { world, fields, session, repairs } = fixture({ money: 2382 });
  assert.equal(session.repairAll(false), "sent");
  assert.deepEqual(repairs(), [[...buildRepairItem(VENDOR, 0n, false)]]);
  fields.set(offset("PLAYER_FIELD_COINAGE"), 2381);
  assert.equal(session.repairAll(false), "unaffordable");
  assert.equal(repairs().length, 1, "the client refuses by itself (ERR_NOT_ENOUGH_MONEY) and sends nothing");
  assert.equal(session.repairAll(true), "sent", "the guild's allowance is the realm's to check");
  assert.deepEqual(repairs()[1], [...buildRepairItem(VENDOR, 0n, true)]);
  world.vendor = undefined;
  assert.equal(session.repairAll(false), "unavailable");
  assert.equal(repairs().length, 2);
});

test("2.02 a merchant who repairs: the tables are fetched and a worn item's missing template asked for, once per list", () => {
  const { world, session, sent } = fixture();
  let loads = 0;
  const probe = new RepairSession({ ...session.host, tables: () => undefined, loadTables: () => { loads++; } });
  world.itemTemplates.delete(1002);
  world.itemTemplates.delete(1001);
  const queries = () => sent.filter((packet) => packet.opcode === OPCODES.CMSG_ITEM_QUERY_SINGLE).length;
  probe.sync();
  assert.equal(loads, 1);
  assert.equal(queries(), 2, "the sword (1002) and the helm (1001); the wrapped and the banked items are not walked");
  probe.sync();
  assert.equal(loads, 1, "the same list: nothing again");
  world.vendor = { guid: VENDOR, items: [] };
  probe.sync();
  assert.equal(loads, 2, "a new list asks again while the tables are missing");
  assert.equal(queries(), 2, "a template already asked for is not asked twice (WorldClient.itemTemplate)");
});

test("2.02 CanGuildBankRepair: a guild and GR_RIGHT_WITHDRAW_REPAIR in the rank's rights", () => {
  const { world, fields, session } = fixture();
  assert.equal(session.canGuildBankRepair(), false, "no guild");
  fields.set(offset("PLAYER_GUILDID"), 7);
  fields.set(offset("PLAYER_GUILDRANK"), 2);
  assert.equal(session.canGuildBankRepair(), false, "no roster yet: no rights known");
  world.guildRoster = { welcomeText: "", infoText: "", members: [], ranks: [
    { flags: 0x1df1ff, withdrawGoldLimit: 0, tabs: [] }, { flags: 0x40000, withdrawGoldLimit: 0, tabs: [] },
    { flags: 0x3, withdrawGoldLimit: 0, tabs: [] },
  ] };
  assert.equal(session.canGuildBankRepair(), false, "rank 2 without the right");
  fields.set(offset("PLAYER_GUILDRANK"), 1);
  assert.equal(session.canGuildBankRepair(), true);
  fields.set(offset("PLAYER_GUILDRANK"), 0);
  assert.equal(session.canGuildBankRepair(), true, "the guild master's GR_RIGHT_ALL carries it");
});

test("2.02 the repair cursor: shown at a repairing merchant, ended by Hide, by closing or changing the merchant", () => {
  const { world, state, session, repairs, fields, setTargeting } = fixture({ money: 1000 });
  const changes = [];
  session.onActiveChange((active) => changes.push(active));
  assert.equal(session.repairItem(state.objects.get(HEAD), HEAD), "unavailable", "the mode is off");
  setTargeting(true);
  assert.equal(session.show(), false, "a spell awaiting its target keeps the cursor");
  setTargeting(false);
  assert.equal(session.show(), true);
  assert.equal(session.active, true);
  // 1632 for the helm with 1000 in the purse: refused by the client.
  assert.equal(session.repairItem(state.objects.get(HEAD), HEAD), "unaffordable");
  assert.equal(session.repairItem(state.objects.get(SWORD), SWORD), "sent");
  assert.equal(session.repairItem(state.objects.get(WHOLE), WHOLE), "sent", "an unworn item is sent too, as the client does");
  assert.deepEqual(repairs(), [[...buildRepairItem(VENDOR, SWORD, false)], [...buildRepairItem(VENDOR, WHOLE, false)]]);
  fields.set(offset("PLAYER_FIELD_COINAGE"), 1_000_000);
  session.hide();
  assert.equal(session.active, false);
  assert.equal(session.show(), true);
  world.closeVendor();
  assert.equal(session.active, false, "CloseMerchant ends the mode");
  session.sync();
  world.vendor = { guid: VENDOR, items: [] };
  assert.equal(session.active, false, "and it does not come back with the next list");
  assert.equal(session.show(), true);
  world.vendor = { guid: OTHER_VENDOR, items: [] };
  assert.equal(session.active, false, "another merchant");
  session.sync();
  world.vendor = { guid: VENDOR, items: [] };
  state.objects.get(VENDOR).fields.set(offset("UNIT_NPC_FLAGS"), 0x80);
  assert.equal(session.show(), false, "a merchant who does not repair");
  assert.deepEqual(changes, [true, false, true, false, true, false]);
  assert.equal(repairs().length, 2);
});

function pumpAt() {
  const events = [];
  let now = 100;
  return { events, advance: (seconds) => { now += seconds; }, now: () => now, fire(event, ...args) { events.push([event, ...args]); return 1; } };
}

test("2.02 stock C API: 1-or-nil answers, RepairAllItems(1), the refusal line, UPDATE_INVENTORY_DURABILITY", () => {
  const { world, state, session, repairs, fields } = fixture({ money: 100 });
  const model = createFrameXmlRepair(session);
  let cleared = 0;
  const seam = { repair: model, cursor: { clear() { cleared++; } } };
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  const pump = pumpAt();
  model.attach(pump);
  assert.deepEqual(call("CanMerchantRepair"), [1]);
  assert.deepEqual(call("GetRepairAllCost"), [2382, 1]);
  assert.deepEqual(call("CanGuildBankRepair"), []);
  assert.deepEqual(call("InRepairMode"), []);
  call("RepairAllItems");
  assert.equal(repairs().length, 0);
  assert.deepEqual(pump.events, [["UI_ERROR_MESSAGE", pump.events[0]?.[1]]]);
  assert.equal(typeof pump.events[0][1], "string");
  call("RepairAllItems", 1);
  assert.deepEqual(repairs(), [[...buildRepairItem(VENDOR, 0n, true)]]);
  call("ShowRepairCursor");
  assert.deepEqual(call("InRepairMode"), [1]);
  assert.equal(cleared, 1, "the cursor lets go as the mode starts");
  call("HideRepairCursor");
  assert.deepEqual(call("InRepairMode"), []);
  // Wear changes raise UPDATE_INVENTORY_DURABILITY once, on the next poll.
  pump.events.length = 0;
  model.tick();
  assert.deepEqual(pump.events, []);
  state.objects.get(HEAD).fields.set(offset("ITEM_FIELD_DURABILITY"), 100);
  model.tick();
  assert.deepEqual(pump.events, [], "polled at most every 250 ms");
  pump.advance(0.3);
  model.tick();
  assert.deepEqual(pump.events, [[FRAMEXML_REPAIR_DURABILITY_EVENT]]);
  pump.advance(0.3);
  model.tick();
  assert.equal(pump.events.length, 1, "no change, no second edge");
  // All whole: the second value is nil, as MerchantRepairAllButton's OnEvent reads it.
  for (const guid of [SWORD, ROBE]) state.objects.get(guid).fields.set(offset("ITEM_FIELD_DURABILITY"), 100);
  assert.deepEqual(call("GetRepairAllCost"), [0]);
  world.vendor = undefined;
  assert.deepEqual(call("GetRepairAllCost"), [], "no merchant: a lone nil");
  assert.deepEqual(call("CanMerchantRepair"), []);
  fields.set(offset("PLAYER_FIELD_COINAGE"), 0);
  model.detach();
});

test("2.02 the repair cursor through LiveWorldSeam: PickupContainerItem/PickupInventoryItem repair instead of lifting", () => {
  const { world, repairs, sent } = fixture();
  const previousWorld = game.world;
  game.world = world;
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => new WorldStore(world.state),
    spell: () => undefined,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  try {
    seam.attach(pumpAt());
    assert.deepEqual(call("CanMerchantRepair"), [1]);
    call("ShowRepairCursor");
    assert.deepEqual(call("InRepairMode"), [1]);
    call("PickupContainerItem", 0, 1);
    assert.equal(seam.cursorHasItem(), false, "repaired, not picked up");
    call("PickupInventoryItem", 1);
    assert.equal(seam.cursorHasItem(), false);
    call("PickupContainerItem", 0, 5);
    assert.deepEqual(repairs(), [[...buildRepairItem(VENDOR, SWORD, false)], [...buildRepairItem(VENDOR, HEAD, false)]],
      "an empty slot under the repair cursor does nothing");
    // A right click at the merchant repairs rather than sells while the mode is on (UseContainerItem 0x005d8650).
    call("UseContainerItem", 0, 1);
    assert.equal(repairs().length, 3);
    assert.deepEqual(repairs()[2], [...buildRepairItem(VENDOR, SWORD, false)]);
    assert.equal(sent.filter((packet) => packet.opcode === OPCODES.CMSG_SELL_ITEM).length, 0, "not sold");
    call("HideRepairCursor");
    call("PickupContainerItem", 0, 1);
    assert.equal(seam.cursorHasItem(), true, "out of the mode the click lifts the item again");
    assert.equal(repairs().length, 3);
    call("ClearCursor");
    call("ShowRepairCursor");
    call("CloseMerchant");
    assert.deepEqual(call("InRepairMode"), [], "closing the merchant ends the mode");
    seam.detach();
  } finally {
    game.world = previousWorld;
    pageRepair.sync();
  }
});

test("2.02 review: ShowRepairCursor waits out the stock spell cursor (an enchant or a glyph awaiting its item)", () => {
  // 0x00584a60 does nothing while SpellIsTargeting (0x007fd620); the stock UI's spell cursor is the
  // trade skill's and the glyph's (FrameXmlTradeSkill/FrameXmlGlyph SpellIsTargeting), not only the ground target.
  const { session } = fixture();
  const model = createFrameXmlRepair(session);
  const seam = { repair: model, cursor: { clear() {} }, tradeSkill: { targeting: 7753 }, glyphs: { targeting: undefined } };
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  call("ShowRepairCursor");
  assert.deepEqual(call("InRepairMode"), [], "an enchant waiting for its item");
  seam.tradeSkill.targeting = undefined;
  seam.glyphs.targeting = { guid: 1n, bag: 255, slot: 23, spellId: 1 };
  call("ShowRepairCursor");
  assert.deepEqual(call("InRepairMode"), [], "a glyph waiting for its socket");
  seam.glyphs.targeting = undefined;
  call("ShowRepairCursor");
  assert.deepEqual(call("InRepairMode"), [1]);
  call("HideRepairCursor");
});

test("2.02 review: with anything on the cursor a click is not a repair (PickupContainerItem/PickupInventoryItem)", () => {
  // 0x005d7ff0 and 0x005e85d0 repair only with an empty hand: a held spell, action or equipment set
  // takes the click's other branches. CursorHasItem is not enough — those are not items.
  const { world, repairs } = fixture();
  const previousWorld = game.world;
  game.world = world;
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => new WorldStore(world.state),
    spell: () => undefined,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  try {
    seam.attach(pumpAt());
    call("ShowRepairCursor");
    assert.deepEqual(call("InRepairMode"), [1]);
    seam.cursor.pickupEquipmentSet(1);
    assert.equal(seam.cursor.occupied(), true);
    call("PickupInventoryItem", 1);
    assert.equal(seam.cursor.occupied(), true, "the paper doll's click leaves the set held");
    call("PickupContainerItem", 0, 1);
    assert.equal(repairs().length, 0, "the held set is not a repair");
    assert.equal(seam.cursor.occupied(), false, "a bag slot's click lets go of it");
    assert.equal(seam.cursorHasItem(), false, "and lifts nothing");
    call("PickupContainerItem", 0, 1);
    assert.deepEqual(repairs(), [[...buildRepairItem(VENDOR, SWORD, false)]], "an empty hand repairs again");
    // The seam's own check, for holders the cursor binding does not let go of (a macro, vault money).
    seam.cursor.pickupEquipmentSet(2);
    seam.pickupContainerItem(0, 1);
    seam.pickupInventoryItem("player", 1);
    assert.equal(repairs().length, 1, "LiveWorldSeam asks whether anything at all is held, not only an item");
    call("ClearCursor");
    call("HideRepairCursor");
    seam.detach();
  } finally {
    game.world = previousWorld;
    pageRepair.sync();
  }
});

test("2.02 review: the tooltip's repair price — SetInventoryItem's third value, SetBagItem's second", async () => {
  // Wow.exe 0x0062e050 and 0x0062f420 answer 0x00584b20 for the item, merchant or not; the stock
  // PaperDollFrame.lua:1346 and ContainerFrame.lua:775 add it as REPAIR_COST while InRepairMode.
  const { world, state, session } = fixture();
  const model = createFrameXmlRepair(session);
  assert.equal(model.itemRepairCost(state.objects.get(HEAD)), 1632);
  assert.equal(model.itemRepairCost(state.objects.get(WHOLE)), 0);
  world.factions.set(LIST_ID, { listId: LIST_ID, flags: 1, standing: 18_100 });
  assert.equal(model.itemRepairCost(state.objects.get(HEAD)), 1387, "revered at this merchant: the discounted price");
  world.vendor = undefined;
  assert.equal(model.itemRepairCost(state.objects.get(HEAD)), 1632, "no merchant: still the price, undiscounted");
  assert.equal(model.itemRepairCost(undefined), 0);

  // Through LiveWorldSeam and the page's tables, as the stock tooltip reads them.
  world.vendor = { guid: VENDOR, items: [] };
  const previousWorld = game.world;
  const previousOrigin = game.gatewayOrigin;
  const previousFetch = globalThis.fetch;
  const catalog = { version: 1, costs: [[10, ...Array.from({ length: 21 }, (_, index) => 100 + index), ...Array.from({ length: 8 }, (_, index) => 200 + index)]],
    quality: [[1, 1], [2, 0.6], [3, 1], [4, 0.8], [5, 1], [6, 1], [7, 1.2], [8, 1.25], [9, 1.44], [10, 2.5], [11, 1.728], [12, 3], [13, 0], [14, 0], [15, 1.2], [16, 1.25]] };
  globalThis.fetch = async () => new Response(JSON.stringify(catalog), { status: 200, headers: { "content-type": "application/json" } });
  game.world = world;
  game.gatewayOrigin = "http://repair-tooltip.test";
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => new WorldStore(world.state),
    spell: () => undefined,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  try {
    const { durabilityClient } = await import("../dist/code/browser/DurabilityClient.js");
    durabilityClient(game.gatewayOrigin).load();
    for (let tries = 0; tries < 50 && !durabilityClient(game.gatewayOrigin).tables; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(durabilityClient(game.gatewayOrigin).tables, "the tables landed");
    assert.equal(seam.inventoryItemRepairCost("player", 1), 1632, "the worn helm");
    assert.equal(seam.containerItemRepairCost(0, 1), 428, "the worn sword in the backpack");
    assert.equal(seam.containerItemRepairCost(0, 3), 0, "an unworn item");
    assert.equal(seam.containerItemRepairCost(1, 1), 322, "the robe in the first bag");
    assert.equal(seam.inventoryItemRepairCost("target", 1), 0, "not the player's: nothing");
    assert.equal(seam.inventoryItemRepairCost("player", 2), 0, "an empty slot");
    const { createFrameXmlCharacterTooltipAdapter } = await import("../dist/code/browser/framexml/FrameXmlCharacterTooltip.js");
    const adapter = createFrameXmlCharacterTooltipAdapter(seam);
    assert.equal(adapter.inventoryItemRepairCost("player", 1), 1632, "the GameTooltip adapter hands the seam's price on");
    assert.equal(adapter.containerItemRepairCost(1, 1), 322);
  } finally {
    globalThis.fetch = previousFetch;
    game.world = previousWorld;
    game.gatewayOrigin = previousOrigin;
    pageRepair.sync();
  }
});
